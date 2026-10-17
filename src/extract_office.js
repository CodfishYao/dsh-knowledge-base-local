/**
 * OOXML body extraction (.docx / .xlsx / .pptx) built on the minimal ZIP reader.
 *
 * The package parts are plain XML, so a forward-only tag scanner is enough:
 * no DOM implementation, no external dependency. Everything degrades to
 * partial text plus warnings and never throws to the caller.
 */
import { basename, extname } from 'node:path'
import { findEntry, readZipEntries } from './zip.js'
import { decodeEntities } from './extract.js'

const KIND_BY_EXTENSION = new Map([
  ['.docx', 'docx'], ['.docm', 'docx'],
  ['.xlsx', 'xlsx'], ['.xlsm', 'xlsx'], ['.xltx', 'xlsx'], ['.xltm', 'xlsx'],
  ['.pptx', 'pptx'], ['.pptm', 'pptx'], ['.ppsx', 'pptx'], ['.potx', 'pptx'],
])

const LEGACY_KIND = new Map([['.doc', 'doc'], ['.xls', 'xls'], ['.ppt', 'ppt']])
const ENCRYPTED_NAME = /encryptedpackage|encrypteddocument/i
const MAX_SHEETS = 100
const MAX_ROWS = 5000
const MAX_SHARED_STRINGS = 2000000
const MAX_TEXT_CHARS = 3000000
const MAX_WARNINGS = 30
const OLE_HEADER = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

/**
 * Extension-based OOXML kind for a file name.
 * @param {string} fileName
 * @returns {'docx'|'xlsx'|'pptx'|null}
 */
export function officeKindOf(fileName) {
  return KIND_BY_EXTENSION.get(extname(String(fileName ?? '')).toLowerCase()) ?? null
}

/** @returns {boolean} true for OLE compound files (`.doc/.xls/.ppt`). */
export function isOleCompound(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? [])
  if (bytes.length < 8) return false
  return OLE_HEADER.every((byte, index) => bytes[index] === byte)
}

/**
 * Extract readable body text from an Office Open XML document.
 *
 * @param {Buffer|Uint8Array} buffer
 * @param {string} fileName picks the kind (also sniffed from the archive)
 * @param {{notes?:boolean, maxPages?:number, maxChars?:number, title?:string}} [options]
 * @returns {{ok:boolean, kind:string, title:string, text:string, warnings:string[], error?:string}}
 */
export function extractOffice(buffer, fileName, options = {}) {
  const name = String(fileName ?? '')
  const ctx = {
    warnings: [],
    warningSeen: new Set(),
    maxChars: Math.max(2000, Number(options.maxChars) || MAX_TEXT_CHARS),
    chars: 0,
  }
  const result = { ok: false, kind: officeKindOf(name) ?? '', title: '', text: '', warnings: ctx.warnings }
  try {
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? [])
    if (isOleCompound(bytes)) {
      result.error = '旧式 Office 二进制格式（.doc/.xls/.ppt）暂不支持，请先另存为 docx/xlsx/pptx'
      result.kind = LEGACY_KIND.get(extname(name).toLowerCase()) ?? result.kind
      return result
    }
    const zip = readZipEntries(bytes)
    if (zip.error) {
      result.error = zip.error
      return result
    }
    for (const message of zip.warnings) warn(ctx, message)
    if (!findEntry(zip, '[Content_Types].xml')) warn(ctx, '缺少 [Content_Types].xml，文件可能不完整')
    if (zip.entries.some((entry) => ENCRYPTED_NAME.test(entry.name))) {
      result.error = '文档受密码保护（包内含 EncryptedPackage），请先在 Office 中取消密码后再入库'
      return result
    }

    const kind = result.kind || sniffKind(zip)
    if (!kind) {
      result.error = '无法识别的 Office 包（既不是 docx 也不是 xlsx/pptx）'
      return result
    }
    result.kind = kind

    const built = kind === 'docx' ? buildDocx(zip, ctx) : kind === 'xlsx' ? buildXlsx(zip, ctx, options) : buildPptx(zip, ctx, options)
    result.text = built.text
    result.title = resolveTitle(built.title, options.title, name)
    if (result.text.trim() === '') {
      result.error = built.error ?? '未抽取到正文（空文档、纯图片或多媒体内容）'
      return result
    }
    result.ok = true
    return result
  } catch (error) {
    result.error = `Office 解析失败：${error instanceof Error ? error.message : String(error)}`
    return result
  }
}

/* ------------------------------------------------------------- helpers ---- */

function warn(ctx, message) {
  if (!message || ctx.warningSeen.has(message)) return
  if (ctx.warnings.length >= MAX_WARNINGS) {
    if (!ctx.warningSeen.has('more')) {
      ctx.warningSeen.add('more')
      ctx.warnings.push('…更多警告已省略')
    }
    return
  }
  ctx.warningSeen.add(message)
  ctx.warnings.push(message)
}

function sniffKind(zip) {
  if (findEntry(zip, 'word/document.xml')) return 'docx'
  if (findEntry(zip, 'xl/workbook.xml')) return 'xlsx'
  if (findEntry(zip, 'ppt/presentation.xml')) return 'pptx'
  return null
}

function partText(zip, name, ctx) {
  const entry = findEntry(zip, name)
  if (!entry) return ''
  try {
    return entry.read().toString('utf8')
  } catch (error) {
    if (ctx) warn(ctx, `读取部件 ${name} 失败：${error instanceof Error ? error.message : String(error)}`)
    return ''
  }
}

function resolveTitle(detected, option, fileName) {
  const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)
  return clean(detected) || clean(option) || clean(basename(fileName).replace(/\.[^.]+$/, ''))
}

/** Core properties carry the document title for all three OOXML flavours. */
function coreTitle(zip, ctx) {
  return cleanText(pickElementText(partText(zip, 'docProps/core.xml', ctx), 'dc:title'))
}

function pickElementText(xml, name) {
  if (xml === '') return ''
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]{0,4000}?)</${name}>`, 'i').exec(xml)
  return match ? decodeEntities(match[1]) : ''
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Forward-only XML tag scanner. The callback receives
 * `{ name, closing, selfClosing, attrs, text }`, where `text` is the character
 * data between the previous tag and this (closing) tag.
 * @param {string} xml
 * @param {(tag: {name:string, closing:boolean, selfClosing:boolean, attrs:Record<string,string>, text:string}) => void} onTag
 */
export function scanXml(xml, onTag) {
  const source = String(xml ?? '')
  let i = 0
  let lastTextStart = 0
  let guard = 0
  while (i < source.length && guard++ < 4000000) {
    const lt = source.indexOf('<', i)
    if (lt < 0) break
    if (source.startsWith('<!--', lt)) {
      i = skipUntil(source, lt + 4, '-->')
      continue
    }
    if (source.startsWith('<?', lt)) {
      i = skipUntil(source, lt + 2, '?>')
      continue
    }
    if (source.startsWith('<!', lt)) {
      i = skipUntil(source, lt + 2, '>')
      continue
    }
    let q = lt + 1
    let quote = ''
    while (q < source.length) {
      const c = source[q]
      if (quote) {
        if (c === quote) quote = ''
        q++
        continue
      }
      if (c === '"' || c === "'") {
        quote = c
        q++
        continue
      }
      if (c === '>') break
      q++
    }
    if (q >= source.length) break
    const raw = source.slice(lt + 1, q)
    i = q + 1
    const closing = raw.startsWith('/')
    const selfClosing = raw.endsWith('/')
    const body = closing ? raw.slice(1) : raw
    const nameMatch = /^[^\s/>][^\s/]*(?=[\s/>]|$)/.exec(body)
    const name = nameMatch ? nameMatch[0] : ''
    if (name === '') continue
    const attrs = closing ? {} : parseAttributes(body.slice(name.length))
    const text = closing || selfClosing ? source.slice(lastTextStart, lt) : ''
    onTag({ name, closing, selfClosing, attrs, text })
    lastTextStart = i
  }
}

function skipUntil(source, from, token) {
  const at = source.indexOf(token, from)
  return at < 0 ? source.length : at + token.length
}

function parseAttributes(raw) {
  const attrs = {}
  if (!raw) return attrs
  const re = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let match
  let guard = 0
  while ((match = re.exec(raw)) !== null && guard++ < 200) {
    attrs[match[1]] = decodeEntities(match[2] ?? match[3] ?? '')
  }
  return attrs
}

/** Character data of the text element that was just closed. */
function textOf(tag, wanted, openName) {
  return tag.closing && openName === wanted ? decodeEntities(tag.text) : ''
}

function normalizeSpaces(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function limitChars(ctx, text) {
  if (text === '' || ctx.chars >= ctx.maxChars) return ''
  const room = ctx.maxChars - ctx.chars
  if (text.length <= room) {
    ctx.chars += text.length
    return text
  }
  ctx.chars = ctx.maxChars
  warn(ctx, `正文超过 ${ctx.maxChars} 字符，已截断`)
  return text.slice(0, room)
}

function joinBlocks(blocks) {
  return blocks.filter((block) => String(block).trim() !== '').join('\n\n')
}

function escapeCell(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/[\t\n\r\u00a0]+/g, ' ').trim()
}

function renderTable(rows) {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0)
  if (width === 0) return ''
  const padded = rows.map((row) => {
    const cells = row.slice(0, width)
    while (cells.length < width) cells.push('')
    return cells
  })
  const lines = [`| ${padded[0].join(' | ')} |`, `| ${padded[0].map(() => '---').join(' | ')} |`]
  for (const row of padded.slice(1)) lines.push(`| ${row.join(' | ')} |`)
  return lines.join('\n')
}

/* ---------------------------------------------------------------- docx ---- */

function buildDocx(zip, ctx) {
  const title = coreTitle(zip, ctx)
  const xml = partText(zip, 'word/document.xml', ctx)
  if (xml === '') {
    return { text: '', title, error: '无效的 docx：缺少 word/document.xml（可能是加密文档或扩展名不符）' }
  }
  const out = []
  const tables = []
  let para = []
  let paraStyle = ''
  let paraNumbered = false
  let openName = ''
  let inFieldCode = false

  const pushParagraph = () => {
    const raw = para.join('')
    const style = paraStyle
    const numbered = paraNumbered
    para = []
    paraStyle = ''
    paraNumbered = false
    const text = normalizeSpaces(raw.replace(/\s*\n\s*/g, ' '))
    if (text === '') return
    const line = `${numbered ? '- ' : headingPrefix(style)}${text}`
    const table = tables[tables.length - 1]
    if (table) table.cell.push(table.cell.length === 0 ? line : ` ${line}`)
    else out.push(limitChars(ctx, line))
  }

  scanXml(xml, (tag) => {
    if (!tag.closing && !tag.selfClosing && tag.name === 'w:t') openName = 'w:t'
    const added = textOf(tag, 'w:t', openName)
    if (added !== '' && !inFieldCode) para.push(added)
    if (tag.closing && tag.name === 'w:t') openName = ''
    if (tag.name === 'w:instrText') inFieldCode = !tag.closing && !tag.selfClosing

    if (!tag.closing) {
      if (tag.selfClosing) {
        if (tag.name === 'w:pStyle') paraStyle = tag.attrs['w:val'] ?? tag.attrs.val ?? ''
        else if (tag.name === 'w:tab') para.push('\t')
        else if (tag.name === 'w:br' || tag.name === 'w:cr') para.push('\n')
        return
      }
      switch (tag.name) {
        case 'w:p':
          para = []
          paraStyle = ''
          paraNumbered = false
          break
        case 'w:pStyle':
          paraStyle = tag.attrs['w:val'] ?? tag.attrs.val ?? ''
          break
        case 'w:numPr':
          paraNumbered = true
          break
        case 'w:tab':
          para.push('\t')
          break
        case 'w:br':
        case 'w:cr':
          para.push('\n')
          break
        case 'w:tbl':
          tables.push({ rows: [], row: [], cell: [] })
          break
        case 'w:tr': {
          const table = tables[tables.length - 1]
          if (table) table.row = []
          break
        }
        case 'w:tc': {
          const table = tables[tables.length - 1]
          if (table) table.cell = []
          break
        }
        default:
          break
      }
      return
    }

    if (tag.name === 'w:p') pushParagraph()
    else if (tag.name === 'w:tc') closeCell(tables)
    else if (tag.name === 'w:tr') closeRow(tables)
    else if (tag.name === 'w:tbl') closeTable(tables, out, ctx)
  })

  const text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return { text, title: title || firstHeading(out) }
}

function firstHeading(lines) {
  for (const line of lines) {
    const match = /^#{1,3}\s+(.+)$/.exec(line)
    if (match) return match[1]
  }
  return ''
}

function headingPrefix(style) {
  const value = String(style ?? '').trim()
  if (value === '') return ''
  if (/^(doc)?title$/i.test(value) || value === '标题') return '# '
  const match = /^(?:heading|标题)[\s_-]*([1-9])/i.exec(value)
  if (match) return `${'#'.repeat(Math.min(6, Math.max(1, Number(match[1]))))} `
  if (/^subtitle$/i.test(value)) return '## '
  if (/^(heading|标题)/i.test(value)) return '## '
  return ''
}

function closeCell(tables) {
  const table = tables[tables.length - 1]
  if (!table) return
  const text = normalizeSpaces(table.cell.join(' '))
  if (!table.row) table.row = []
  table.row.push(escapeCell(text.replace(/[\t\n]+/g, ' ')))
  table.cell = []
}

function closeRow(tables) {
  const table = tables[tables.length - 1]
  if (!table) return
  if (table.row && table.row.length > 0) {
    if (table.rows.length >= MAX_ROWS) table.rows.length = MAX_ROWS - 1
    table.rows.push(table.row)
  }
  table.row = []
  table.cell = []
}

function closeTable(tables, out, ctx) {
  const table = tables.pop()
  if (!table) return
  const rows = table.rows.filter((row) => row.some((cell) => cell.trim() !== ''))
  if (rows.length === 0) return
  const parent = tables[tables.length - 1]
  if (parent) {
    parent.cell.push(` ${rows.map((row) => row.join(' ')).join(' / ')} `)
    return
  }
  out.push(limitChars(ctx, renderTable(rows)))
}

/* ---------------------------------------------------------------- xlsx ---- */

function buildXlsx(zip, ctx, options) {
  const title = coreTitle(zip, ctx)
  const workbookXml = partText(zip, 'xl/workbook.xml', ctx)
  if (workbookXml === '') {
    return { text: '', title, error: '无效的 xlsx：缺少 xl/workbook.xml（可能是加密文档或扩展名不符）' }
  }
  const shared = parseSharedStrings(partText(zip, 'xl/sharedStrings.xml', ctx), ctx)
  const rels = parseRels(partText(zip, 'xl/_rels/workbook.xml.rels', ctx))
  const sheets = sheetList(workbookXml)
  if (sheets.length === 0) return { text: '', title, error: 'xlsx 中没有工作表' }

  const limit = Math.min(MAX_SHEETS, Math.max(1, Number(options.maxPages) || MAX_SHEETS))
  if (sheets.length > limit) warn(ctx, `工作表数量超过 ${limit}，后面的表已忽略`)
  const blocks = []
  sheets.slice(0, limit).forEach((sheet, index) => {
    const declared = resolveTarget('xl', rels.get(sheet.id) ?? '')
    const candidates = [declared, `xl/worksheets/sheet${index + 1}.xml`].filter((name) => name !== '')
    let xml = ''
    for (const candidate of candidates) {
      xml = partText(zip, candidate, ctx)
      if (xml !== '') break
    }
    if (xml === '') {
      warn(ctx, `找不到工作表「${sheet.name}」的数据部件（${candidates.join(', ') || '未声明'}）`)
      return
    }
    const rows = readSheetRows(xml, shared, ctx, sheet.name)
    const used = rows.filter((row) => row.some((cell) => String(cell).trim() !== ''))
    if (used.length === 0) return
    const header = used[0].map((cell, at) => (String(cell).trim() === '' ? `列${columnLetter(at + 1)}` : escapeCell(cell)))
    const body = used.slice(1).map((row) => row.map(escapeCell))
    blocks.push(limitChars(ctx, `## ${sheet.name}\n\n${renderTable([header, ...body])}`))
  })
  return { text: joinBlocks(blocks).trim(), title: title || sheets[0].name }
}

function sheetList(xml) {
  const out = []
  scanXml(xml, (tag) => {
    if (tag.closing || tag.name !== 'sheet') return
    const id = tag.attrs['r:id'] ?? tag.attrs.Id ?? tag.attrs.id ?? ''
    const name = tag.attrs.name ?? ''
    if (name === '' && id === '') return
    out.push({ name: name || `Sheet${out.length + 1}`, id })
  })
  return out
}

function parseRels(xml) {
  const map = new Map()
  if (xml === '') return map
  scanXml(xml, (tag) => {
    if (tag.closing || tag.name !== 'Relationship') return
    const id = tag.attrs.Id ?? ''
    if (id !== '') map.set(id, tag.attrs.Target ?? '')
  })
  return map
}

/** Resolve a relationship Target against the directory of its source part. */
function resolveTarget(baseDir, target) {
  const raw = String(target ?? '').trim().replace(/\\/g, '/')
  if (raw === '') return ''
  if (raw.startsWith('/')) return raw.slice(1)
  const parts = []
  for (const segment of `${baseDir}/${raw}`.split('/')) {
    if (segment === '..') parts.pop()
    else if (segment !== '' && segment !== '.') parts.push(segment)
  }
  return parts.join('/')
}

function columnLetter(index) {
  let n = Math.max(1, Math.trunc(index))
  let out = ''
  let guard = 0
  while (n > 0 && guard++ < 12) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

function columnIndexOf(ref) {
  const match = /^([A-Za-z]{1,7})\d+$/.exec(String(ref ?? ''))
  if (!match) return -1
  let value = 0
  for (const char of match[1].toUpperCase()) value = value * 26 + (char.charCodeAt(0) - 64)
  return value > 0 ? value - 1 : -1
}

function parseSharedStrings(xml, ctx) {
  const list = []
  if (xml === '') return list
  let current = null
  let phonetic = 0
  let inText = false
  scanXml(xml, (tag) => {
    if (list.length >= MAX_SHARED_STRINGS) return
    // Text inside <t> may be split by nested markup (<rPh> excluded via flag);
    // the scanner hands each text segment to the tag that follows it, so we
    // must keep collecting while inside <t> instead of only at </t>.
    if (inText && phonetic === 0 && current && tag.text) current.push(decodeEntities(tag.text))
    if (tag.name === 'si') {
      if (!tag.closing) {
        if (tag.selfClosing) list.push('')
        else current = []
        return
      }
      list.push((current ?? []).join(''))
      current = null
      inText = false
      return
    }
    if (tag.name === 'rPh') {
      if (tag.closing) phonetic = Math.max(0, phonetic - 1)
      else if (!tag.selfClosing) phonetic++
      return
    }
    if (tag.name === 't') {
      if (tag.selfClosing) {
        inText = false
        return
      }
      inText = !tag.closing
      return
    }
  })
  if (list.length >= MAX_SHARED_STRINGS) warn(ctx, `共享字符串超过 ${MAX_SHARED_STRINGS} 条，已截断`)
  return list
}

function readSheetRows(xml, shared, ctx, sheetName) {
  const rows = []
  let row = null
  let cell = null
  let collecting = false
  let inText = false
  scanXml(xml, (tag) => {
    const name = tag.name
    if (inText && cell && tag.text) cell.parts.push(decodeEntities(tag.text))
    if (name === 'row') {
      if (tag.closing) {
        if (row) rows.push(row)
        row = null
        return
      }
      if (rows.length >= MAX_ROWS) {
        row = null
        return
      }
      row = []
      if (tag.selfClosing) rows.push(row)
      return
    }
    if (name === 'c') {
      if (tag.closing) {
        if (row && cell) placeCell(row, cell, shared)
        cell = null
        collecting = false
        inText = false
        return
      }
      cell = { ref: tag.attrs.r ?? '', type: tag.attrs.t ?? '', parts: [] }
      if (tag.selfClosing) {
        if (row) placeCell(row, cell, shared)
        cell = null
      }
      return
    }
    if (name === 'f') {
      collecting = false
      return
    }
    if (name === 'v') {
      if (tag.closing) {
        if (cell && collecting) cell.parts.push(decodeEntities(tag.text))
        collecting = false
        return
      }
      if (tag.selfClosing) return
      collecting = true
      return
    }
    if (name === 't') {
      inText = !tag.closing && !tag.selfClosing
      return
    }
  })
  if (rows.length >= MAX_ROWS) warn(ctx, `工作表「${sheetName}」行数超过 ${MAX_ROWS}，已截断`)
  let maxCol = 0
  for (const item of rows) maxCol = Math.max(maxCol, item.length)
  return rows.map((item) => {
    const cells = item.slice(0, maxCol)
    while (cells.length < maxCol) cells.push('')
    return cells
  })
}

function placeCell(row, cell, shared) {
  const raw = cell.parts.join('').trim()
  let value = raw
  if (cell.type === 's') {
    const index = Number(raw)
    value = Number.isInteger(index) && index >= 0 && index < shared.length ? shared[index] : ''
  } else if (cell.type === 'b') {
    value = raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : raw
  }
  let at = columnIndexOf(cell.ref)
  if (at < 0 || at > 16383) at = row.length
  while (row.length < at) row.push('')
  row[at] = value
}

/* ---------------------------------------------------------------- pptx ---- */

function buildPptx(zip, ctx, options) {
  const title = coreTitle(zip, ctx)
  const slides = zip.entries
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry.name))
    .map((entry) => ({ name: entry.name, index: Number(/(\d+)\.xml$/i.exec(entry.name)?.[1] ?? 0) }))
    .sort((a, b) => a.index - b.index)
  if (slides.length === 0) {
    return { text: '', title, error: '无效的 pptx：未找到 slide 部件（或扩展名不符）' }
  }
  const limit = Math.max(1, Number(options.maxPages) || 2000)
  if (slides.length > limit) warn(ctx, `幻灯片数量超过 ${limit}，后面的页已忽略`)
  const withNotes = options.notes !== false
  const blocks = []
  for (const slide of slides.slice(0, limit)) {
    const xml = partText(zip, slide.name, ctx)
    if (xml === '') {
      warn(ctx, `无法读取 ${slide.name}`)
      continue
    }
    const parsed = readSlide(xml)
    const body = parsed.lines.filter((line) => line.trim() !== '' && line !== parsed.title)
    const parts = [`${parsed.title === '' ? `## 幻灯片 ${slide.index}` : `## 幻灯片 ${slide.index}：${parsed.title}`}`, body.join('\n')]
    if (withNotes) {
      const notes = normalizeSpaces(readNotes(zip, slide.name, ctx)).replace(/\n+/g, ' ')
      if (notes !== '') parts.push(`备注：${notes}`)
    }
    blocks.push(limitChars(ctx, parts.filter((part) => String(part).trim() !== '').join('\n\n')))
  }
  return { text: joinBlocks(blocks).trim(), title }
}

function readSlide(xml) {
  const lines = []
  let title = ''
  let shapeIsTitle = false
  let para = []
  let openName = ''
  scanXml(xml, (tag) => {
    const name = tag.name
    if (!tag.closing && !tag.selfClosing && name === 'a:t') openName = 'a:t'
    const added = textOf(tag, 'a:t', openName)
    if (added !== '') para.push(added)
    if (tag.closing && name === 'a:t') openName = ''

    if (!tag.closing) {
      if (name === 'p:sp' || name === 'p:graphicFrame' || name === 'p:cxnSp' || name === 'p:grpSp') shapeIsTitle = false
      else if (name === 'p:ph') {
        const type = String(tag.attrs.type ?? '')
        if (type === 'title' || type === 'ctrTitle') shapeIsTitle = true
      } else if (name === 'a:br') para.push('\n')
      else if (name === 'a:p') para = []
      return
    }
    if (name === 'a:p') {
      const text = normalizeSpaces(para.join(''))
      para = []
      if (text === '') return
      if (shapeIsTitle && title === '') {
        title = text
        return
      }
      lines.push(text)
    }
  })
  if (title === '' && lines.length > 0 && shapeIsTitle) title = lines.shift()
  return { title, lines }
}

function readNotes(zip, slideName, ctx) {
  const dir = slideName.slice(0, slideName.lastIndexOf('/'))
  const file = slideName.slice(slideName.lastIndexOf('/') + 1)
  const rels = parseRels(partText(zip, `${dir}/_rels/${file}.rels`, ctx))
  const candidates = []
  for (const target of rels.values()) {
    if (!/notesSlide/i.test(target)) continue
    candidates.push(resolveTarget('ppt/slides', target))
    candidates.push(resolveTarget('ppt', target))
  }
  const number = /(\d+)\.xml$/i.exec(file)?.[1] ?? ''
  candidates.push(`ppt/notesSlides/notesSlide${number}.xml`)
  for (const candidate of candidates) {
    const xml = partText(zip, candidate, ctx)
    if (xml === '') continue
    const parsed = readSlide(xml)
    return parsed.lines.length > 0 ? parsed.lines.join('\n') : parsed.title
  }
  return ''
}
