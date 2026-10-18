/**
 * Best-effort, dependency-free PDF text extraction.
 *
 * Strategy (all tolerant, nothing here throws to the caller):
 *   1. locate indirect objects by scanning the whole file for `N G obj`, and —
 *      when reachable — through the cross-reference table / xref stream chain;
 *   2. expand object streams (`/Type /ObjStm`) so compressed objects resolve;
 *   3. walk `/Root → /Pages` in `Kids` order, inheriting `/Resources`;
 *   4. decode content streams (`FlateDecode`, `ASCIIHexDecode`, `RunLengthDecode`,
 *      `ASCII85Decode`, predictors) and interpret the text-showing operators;
 *   5. map character codes through `/ToUnicode` CMaps, simple `/Encoding`
 *      tables and `/Differences`, falling back to Identity-H code points.
 *
 * Encrypted documents are reported, never cracked. Image-only filters are
 * skipped with a warning. Every failure degrades to partial text + warnings.
 */
import { inflateRawSync, inflateSync } from 'node:zlib'

const MAX_BYTES = 64 * 1024 * 1024
const MAX_PAGES = 2000
const MAX_TEXT_CHARS = 3000000
const MAX_OBJECTS = 120000
const MAX_TOKENS = 2000000
const MAX_WARNINGS = 40
const MAX_PARSE_DEPTH = 48
const KERN_SPACE_RATIO = 0.15
const TD_SPACE_RATIO = 0.25
const IMAGE_FILTERS = new Set(['DCTDecode', 'JPXDecode', 'JBIG2Decode', 'CCITTFaxDecode', 'CCITTFax', 'DCT', 'JPX', 'JBIG2'])
const UNSUPPORTED_FILTERS = new Set(['LZWDecode', 'LZW', 'Crypt', 'Baltimore', 'ZBuildDecode', 'ECFDecode'])

const SPACE_BYTES = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20])

let WIN_ANSI = null
let MAC_ROMAN = null
try {
  WIN_ANSI = new TextDecoder('windows-1252')
} catch {
  /* minimal ICU: fall back to latin1 below */
}
try {
  MAC_ROMAN = new TextDecoder('macintosh')
} catch {
  /* ignore */
}

const GLYPH_NAMES = new Map(
  Object.entries({
    space: ' ',
    a: 'a', b: 'b', c: 'c', d: 'd', e: 'e', f: 'f', g: 'g', h: 'h', i: 'i', j: 'j', k: 'k', l: 'l', m: 'm',
    n: 'n', o: 'o', p: 'p', q: 'q', r: 'r', s: 's', t: 't', u: 'u', v: 'v', w: 'w', x: 'x', y: 'y', z: 'z',
    A: 'A', B: 'B', C: 'C', D: 'D', E: 'E', F: 'F', G: 'G', H: 'H', I: 'I', J: 'J', K: 'K', L: 'L', M: 'M',
    N: 'N', O: 'O', P: 'P', Q: 'Q', R: 'R', S: 'S', T: 'T', U: 'U', V: 'V', W: 'W', X: 'X', Y: 'Y', Z: 'Z',
    zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
    period: '.', comma: ',', hyphen: '-', endash: '–', emdash: '—', colon: ':', semicolon: ';',
    quotedblright: '”', quotedblleft: '“', quoteright: '’', quoteleft: '‘', quotesingle: "'",
    parenleft: '(', parenright: ')', bracketleft: '[', bracketright: ']', braceleft: '{', braceright: '}',
    exclam: '!', exclamdown: '¡', question: '?', percent: '%', dollar: '$', ampersand: '&', asterisk: '*',
    plus: '+', equal: '=', minus: '-', slash: '/', backslash: '\\', at: '@', numbersign: '#',
    underscore: '_', asciicircum: '^', asciitilde: '~', bar: '|', bullet: '•', ellipsis: '…',
    degree: '°', plusminus: '±', multiply: '×', divide: '÷', currency: '¤',
  }),
)

class Ref {
  constructor(num, gen = 0) {
    this.num = num
    this.gen = gen
  }
}

/** PDF literal/hex string: raw bytes kept as latin1 code units. */
class PdfString {
  constructor(value) {
    this.value = value
  }
}

class StreamValue {
  constructor(dict, buffer, start, length) {
    this.dict = dict
    this.buffer = buffer
    this.start = start
    this.length = length
  }
}

/**
 * True when the first kilobyte carries the `%PDF-` header.
 * @param {Buffer|Uint8Array} buffer
 * @returns {boolean}
 */
export function isPdf(buffer) {  if (!buffer || typeof buffer.length !== 'number') return false
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  const head = bytes.subarray(0, Math.min(1024, bytes.length))
  return head.includes('%PDF-')
}

/**
 * Extract readable text from a PDF buffer.
 *
 * @param {Buffer|Uint8Array} buffer
 * @param {{maxBytes?:number, maxPages?:number, maxChars?:number, title?:string}} [options]
 * @returns {{ok:boolean, kind:'pdf', title:string, text:string, pages:number, warnings:string[], error?:string}}
 */
export function extractPdf(buffer, options = {}) {
  const doc = createDoc()
  const result = { ok: false, kind: 'pdf', title: '', text: '', pages: 0, warnings: doc.warnings }
  try {
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? [])
    const maxBytes = Math.max(1024, Number(options.maxBytes) || MAX_BYTES)
    if (bytes.length > maxBytes) {
      result.error = `PDF 文件过大（${bytes.length} 字节 > ${maxBytes}），未解析`
      return result
    }
    if (!isPdf(bytes)) {
      result.error = '不是 PDF 文件（未找到 %PDF- 头）'
      return result
    }
    doc.buf = bytes
    const maxPages = Math.max(1, Number(options.maxPages) || MAX_PAGES)
    doc.maxChars = Math.max(2000, Number(options.maxChars) || MAX_TEXT_CHARS)

    scanObjects(doc)
    readTrailers(doc)
    readCrossReference(doc)
    loadObjectsFromXref(doc)
    expandObjectStreams(doc)

    if (doc.encrypted) {
      result.error = 'PDF 文档已加密（存在 /Encrypt），需要解密后再入库；本插件不尝试破解。'
      return result
    }

    const catalog = findCatalog(doc)
    if (!catalog) {
      result.error = '无法定位 PDF 文档目录（/Root/Pages），可能文件已损坏'
      result.text = doc.pageTexts.join('\n\n')
      result.pages = doc.pageTexts.length
      return result
    }

    const pages = collectPages(doc, catalog, maxPages)
    for (const page of pages) {
      renderPage(doc, page)
      if (doc.truncated) break
    }
    result.pages = pages.length
    result.title = pickTitle(doc, options.title)
    result.text = doc.pageTexts.join('\n\n')
    if (result.text.trim() === '') {
      addWarning(doc, '未抽取到文本：可能是扫描图像（需 OCR）或字体未内嵌')
    }
    result.ok = true
    return result
  } catch (error) {
    result.error = `PDF 解析失败：${error instanceof Error ? error.message : String(error)}`
    result.text = doc.pageTexts.join('\n\n')
    result.pages = doc.pageTexts.length
    if (!result.title) result.title = pickTitle(doc, options.title)
    return result
  }
}

/* ------------------------------------------------------------------ doc ---- */

function createDoc() {
  return {
    buf: Buffer.alloc(0),
    objects: new Map(),
    xref: new Map(),
    trailers: [],
    pageTexts: [],
    warnings: [],
    warningSeen: new Set(),
    fontCache: new WeakMap(),
    decodedCache: new WeakMap(),
    info: null,
    root: null,
    encrypted: false,
    truncated: false,
    maxChars: MAX_TEXT_CHARS,
    chars: 0,
  }
}

function addWarning(doc, message) {
  if (!message || doc.warningSeen.has(message)) return
  if (doc.warnings.length >= MAX_WARNINGS) {
    if (!doc.warningSeen.has('warnings:more')) {
      doc.warningSeen.add('warnings:more')
      doc.warnings.push('…更多警告已省略')
    }
    return
  }
  doc.warningSeen.add(message)
  doc.warnings.push(message)
}

/* --------------------------------------------------------------- scanner ---- */

class Scanner {
  constructor(buffer, pos = 0) {
    this.buf = buffer
    this.pos = pos
  }

  get end() {
    return this.pos >= this.buf.length
  }

  at(offset = 0) {
    const p = this.pos + offset
    return p < this.buf.length ? this.buf[p] : -1
  }

  skipSpace() {
    const b = this.buf
    let p = this.pos
    while (p < b.length) {
      const c = b[p]
      if (c === 0x25) {
        p++
        while (p < b.length && b[p] !== 0x0a && b[p] !== 0x0d) p++
        continue
      }
      if (SPACE_BYTES.has(c)) {
        p++
        continue
      }
      break
    }
    this.pos = p
  }
}

function isDelimiter(c) {
  return c === -1 || SPACE_BYTES.has(c) || c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f
}

function isDigitByte(c) {
  return c >= 0x30 && c <= 0x39
}

function readToken(sc, limit = 128) {
  const b = sc.buf
  const start = sc.pos
  const stop = Math.min(b.length, start + limit)
  let p = start
  while (p < stop && !SPACE_BYTES.has(b[p]) && !isDelimiter(b[p])) p++
  if (p === start) p++
  sc.pos = p
  return b.toString('latin1', start, p)
}

function readName(sc) {
  sc.pos++ // consume '/'
  const b = sc.buf
  const start = sc.pos
  const stop = Math.min(b.length, start + 1000)
  let out = ''
  let p = start
  while (p < stop) {
    const c = b[p]
    if (SPACE_BYTES.has(c) || isDelimiter(c)) break
    if (c === 0x23 && p + 2 < stop) {
      const hex = b.toString('latin1', p + 1, p + 3)
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out += String.fromCharCode(Number.parseInt(hex, 16))
        p += 3
        continue
      }
    }
    out += String.fromCharCode(c)
    p++
  }
  sc.pos = p
  return out
}

const ESCAPES = new Map([
  [0x6e, '\n'], [0x72, '\r'], [0x74, '\t'], [0x62, '\b'], [0x66, '\f'],
  [0x28, '('], [0x29, ')'], [0x5c, '\\'],
])

function readLiteralString(sc) {
  const b = sc.buf
  let p = sc.pos + 1
  const stop = Math.min(b.length, p + 32 * 1024 * 1024)
  let depth = 1
  let out = ''
  while (p < stop) {
    const c = b[p]
    if (c === 0x5c) {
      const n = b[p + 1]
      if (n === 0x0a) { p += 2; continue }
      if (n === 0x0d) { p += b[p + 2] === 0x0a ? 3 : 2; continue }
      const mapped = ESCAPES.get(n)
      if (mapped !== undefined) { out += mapped; p += 2; continue }
      if (isDigitByte(n)) {
        let octal = ''
        let q = p + 1
        while (q < stop && octal.length < 3 && isDigitByte(b[q]) && b[q] <= 0x37) { octal += String.fromCharCode(b[q]); q++ }
        out += String.fromCharCode(Number.parseInt(octal, 8) & 0xff)
        p = q
        continue
      }
      out += String.fromCharCode(n === undefined ? 0x5c : n)
      p += 2
      continue
    }
    if (c === 0x28) { depth++; p++; out += '('; continue }
    if (c === 0x29) {
      depth--
      p++
      if (depth === 0) break
      out += ')'
      continue
    }
    out += String.fromCharCode(c)
    p++
  }
  sc.pos = Math.min(p, b.length)
  return out
}

function readHexString(sc) {
  const b = sc.buf
  let p = sc.pos + 1
  const stop = Math.min(b.length, p + 64 * 1024 * 1024)
  let nibble = -1
  let out = ''
  while (p < stop) {
    const c = b[p]
    p++
    if (c === 0x3e) break // '>'
    if (SPACE_BYTES.has(c)) continue
    const value = hexValue(c)
    if (value < 0) continue
    if (nibble < 0) nibble = value
    else {
      out += String.fromCharCode(((nibble << 4) | value) & 0xff)
      nibble = -1
    }
  }
  if (nibble >= 0) out += String.fromCharCode((nibble << 4) & 0xff)
  sc.pos = Math.min(p, b.length)
  return out
}

function hexValue(c) {
  if (c >= 0x30 && c <= 0x39) return c - 0x30
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10
  return -1
}

function readNumberToken(sc) {
  const b = sc.buf
  const start = sc.pos
  let p = start
  if (b[p] === 0x2b || b[p] === 0x2d) p++
  let digits = 0
  let dot = 0
  const stop = Math.min(b.length, start + 64)
  while (p < stop) {
    const c = b[p]
    if (isDigitByte(c)) { digits++; p++; continue }
    if (c === 0x2e && dot === 0) { dot = 1; p++; continue }
    if ((c === 0x65 || c === 0x45) && digits > 0) {
      p++
      if (b[p] === 0x2b || b[p] === 0x2d) p++
      break
    }
    break
  }
  if (p === start) return null
  sc.pos = p
  const text = b.toString('latin1', start, p)
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

function readValue(doc, sc, depth = 0) {
  sc.skipSpace()
  if (sc.end) return null
  if (depth > MAX_PARSE_DEPTH) {
    addWarning(doc, 'PDF 对象嵌套过深，已停止递归解析')
    return null
  }
  const b = sc.buf
  const c = sc.at()
  if (c === 0x2f) return readName(sc) // '/'
  if (c === 0x28) return new PdfString(readLiteralString(sc)) // '('
  if (c === 0x3c) {
    if (sc.at(1) === 0x3c) return readDict(doc, sc, depth) // '<<'
    return new PdfString(readHexString(sc)) // '<'
  }
  if (c === 0x5b || c === 0x7b) return readArray(doc, sc, c, depth) // '[' or '{'
  if (isDigitByte(c) || c === 0x2b || c === 0x2d || (c === 0x2e && isDigitByte(sc.at(1)))) return readNumberOrRef(doc, sc)
  if (c === 0x29 || c === 0x3e || c === 0x5d || c === 0x7d) return null
  const word = readToken(sc)
  if (word === 'true' || word === 'false') return word === 'true'
  if (word === 'null') return null
  return { op: word }
}

function readNumberOrRef(doc, sc) {
  const first = readNumberToken(sc)
  if (first === null) return null
  if (!Number.isInteger(first)) return first
  const save = sc.pos
  sc.skipSpace()
  const second = readNumberToken(sc)
  if (second === null || !Number.isInteger(second) || second < 0) {
    sc.pos = save
    return first
  }
  sc.skipSpace()
  if (sc.at() === 0x52 && isDelimiter(sc.at(1))) { // 'R'
    sc.pos++
    return new Ref(first, second)
  }
  sc.pos = save
  return first
}

function newDict() {
  return Object.create(null)
}

function readDict(doc, sc, depth) {
  const dict = newDict()
  sc.pos += 2 // '<<'
  for (let guard = 0; guard < 4000; guard++) {
    sc.skipSpace()
    if (sc.end) break
    if (sc.at() === 0x3e && sc.at(1) === 0x3e) { sc.pos += 2; break } // '>>'
    if (sc.at() !== 0x2f) {
      // tolerate stray tokens instead of looping forever
      const before = sc.pos
      readToken(sc, 64)
      if (sc.pos === before) break
      continue
    }
    const key = readName(sc)
    const before = sc.pos
    const value = readValue(doc, sc, depth + 1)
    if (value === null) {
      dict[key] = null
      if (sc.pos === before) {
        sc.pos = before + 1
      }
      continue
    }
    dict[key] = value
    if (key === 'Type' && value === 'Encrypt') doc.encrypted = true
    if (key === 'Root' && value instanceof Ref) doc.root = value
    if (key === 'Info' && value instanceof Ref) doc.info = value
    if (key === 'Encrypt' && value !== null) doc.encrypted = true
  }
  return dict
}

function readArray(doc, sc, opener, depth) {
  const closer = opener === 0x5b ? 0x5d : 0x7d
  const items = []
  sc.pos++
  for (let guard = 0; guard < 200000; guard++) {
    sc.skipSpace()
    if (sc.end) break
    if (sc.at() === closer || (closer === 0x5d && sc.at() === 0x7d)) { sc.pos++; break }
    const before = sc.pos
    const value = readValue(doc, sc, depth + 1)
    if (value === undefined) break
    if (value !== null) items.push(value)
    if (sc.pos === before) sc.pos++
  }
  return items
}

/* --------------------------------------------------------------- objects ---- */

/** Whole-file scan for `N G obj`; works even when the xref table is broken. */
function scanObjects(doc) {
  const b = doc.buf
  let from = 0
  let parsed = 0
  while (parsed < MAX_OBJECTS) {
    const at = b.indexOf(' obj', from)
    if (at < 0) break
    from = at + 4
    if (at + 4 >= b.length || !isDelimiter(b[at + 4])) continue
    const header = readObjectHeader(b, at)
    if (!header) continue
    parsed++
    if (doc.objects.has(header.num)) continue
    const sc = new Scanner(b, header.body)
    try {
      const value = readObjectBody(doc, sc)
      if (value !== null && value !== undefined) doc.objects.set(header.num, value)
    } catch {
      addWarning(doc, `对象 ${header.num} 解析失败，已跳过`)
    }
  }
  if (parsed >= MAX_OBJECTS) addWarning(doc, `PDF 对象数量超过上限 ${MAX_OBJECTS}，后面的对象已忽略`)
}

function readObjectHeader(b, objAt) {
  // `objAt` points at the space before "obj"; walk backwards over `<num> <gen>`.
  let p = objAt - 1
  let digits = 0
  while (p >= 0 && isDigitByte(b[p])) { p--; digits++ }
  if (digits === 0 || digits > 6) return null
  const genEnd = p + 1
  while (p >= 0 && SPACE_BYTES.has(b[p])) p--
  const genStart = p + 1
  while (p >= 0 && isDigitByte(b[p])) p--
  const numStart = p + 1
  if (numStart === genStart) return null
  let numDigits = 0
  for (let q = numStart; q < genStart; q++) if (isDigitByte(b[q])) numDigits++
  if (numDigits === 0 || numDigits > 10) return null
  if (p >= 0 && !isDelimiter(b[p])) return null
  const num = Number(b.toString('latin1', numStart, genStart))
  const gen = Number(b.toString('latin1', genStart, genEnd))
  if (!Number.isFinite(num)) return null
  return { num, gen, start: numStart, body: objAt + 5 }
}

function readObjectBody(doc, sc) {
  const start = sc.pos
  const value = readValue(doc, sc, 0)
  if (isDictLike(value)) {
    const save = sc.pos
    sc.skipSpace()
    if (matchWord(sc, 'stream')) {
      const stream = readStreamAfterDict(doc, sc, value)
      sc.pos = save
      return stream ?? value
    }
    sc.pos = save
  }
  if (sc.pos === start) sc.pos = start + 1
  return value
}

function isDictLike(value) {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Ref) &&
    !(value instanceof PdfString) &&
    !(value instanceof StreamValue)
  )
}

function matchWord(sc, word) {
  const b = sc.buf
  const start = sc.pos
  if (start + word.length > b.length) return false
  for (let i = 0; i < word.length; i++) if (b[start + i] !== word.charCodeAt(i)) return false
  const after = start + word.length
  if (!isDelimiter(after < b.length ? b[after] : -1)) return false
  sc.pos = after
  return true
}

function readStreamAfterDict(doc, sc, dict) {
  const b = doc.buf
  let p = sc.pos
  if (b[p] === 0x0d) p++
  if (b[p] === 0x0a) p++
  const declared = numberValue(resolve(doc, dict.Length))
  let length = -1
  if (declared !== null && declared >= 0 && p + declared <= b.length) {
    length = declared
  } else {
    const end = b.indexOf('endstream', p)
    if (end < 0) {
      addWarning(doc, '找到 stream 关键字但缺少 endstream，已忽略该流')
      return null
    }
    length = end - p
  }
  sc.pos = Math.min(p + length + 9, b.length)
  return new StreamValue(dict, b, p, length)
}

function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * The cross-reference data is authoritative: parse each listed object at its
 * recorded offset and override whatever the whole-file scan guessed.
 */
function loadObjectsFromXref(doc) {
  const containers = new Set()
  for (const [num, info] of doc.xref) {
    if (info.type === 2) {
      containers.add(info.container)
      continue
    }
    if (info.type !== 1 || !Number.isFinite(info.offset) || info.offset < 0 || info.offset >= doc.buf.length) continue
    const header = readObjectHeaderAt(doc.buf, info.offset)
    if (!header || header.num !== num) continue
    const sc = new Scanner(doc.buf, header.body)
    try {
      const value = readObjectBody(doc, sc)
      if (value !== null && value !== undefined) doc.objects.set(num, value)
    } catch {
      /* keep the scanned version if there is one */
    }
  }
  for (const container of containers) {
    if (doc.objects.get(container) instanceof StreamValue) continue
    const info = doc.xref.get(container)
    if (info?.type !== 1 || !Number.isFinite(info.offset)) continue
    const header = readObjectHeaderAt(doc.buf, info.offset)
    if (!header) continue
    try {
      doc.objects.set(container, readObjectBody(doc, new Scanner(doc.buf, header.body)))
    } catch {
      /* ignore */
    }
  }
}

/** Parse `N G obj` forward from a known byte offset. */
function readObjectHeaderAt(b, offset) {
  const sc = new Scanner(b, offset)
  sc.skipSpace()
  const num = readNumberToken(sc)
  if (num === null || !Number.isInteger(num)) return null
  sc.skipSpace()
  const gen = readNumberToken(sc)
  if (gen === null) return null
  sc.skipSpace()
  if (!matchWord(sc, 'obj')) return null
  return { num, gen: Number.isInteger(gen) ? gen : 0, start: offset, body: sc.pos }
}

function expandObjectStreams(doc) {
  const candidates = []
  for (const [num, value] of doc.objects) {
    if (value instanceof StreamValue && value.dict?.Type === 'ObjStm') candidates.push([num, value])
    if (candidates.length >= 8192) break
  }
  for (const [containerNum, stream] of candidates) {
    const data = decodeStream(doc, stream)
    if (!data) continue
    const pending = []
    const count = numberValue(stream.dict.N) ?? 0
    const first = numberValue(stream.dict.First) ?? 0
    if (count <= 0 || count > 100000 || first < 0 || first > data.length) {
      addWarning(doc, `对象流 ${containerNum} 的 /N /First 无效，已跳过`)
      continue
    }
    // Object numbers and byte offsets live at the head of the stream data
    // (offset 0); /First marks only where the object bodies begin (ISO 32000-1 §7.5.7).
    const sc = new Scanner(data, 0)
    const indexes = []
    for (let i = 0; i < count; i++) {
      sc.skipSpace()
      const num = readNumberToken(sc)
      sc.skipSpace()
      const off = readNumberToken(sc)
      if (num === null || off === null) break
      indexes.push([num, off])
    }
    for (const [num, off] of indexes) {
      const pos = first + off
      if (!Number.isInteger(num) || pos < 0 || pos >= data.length) continue
      if (doc.objects.has(num) && !(doc.xref.get(num)?.type === 2)) continue
      const inner = new Scanner(data, pos)
      try {
        const value = readValue(doc, inner, 0)
        if (value === null || value === undefined) continue
        if (isDictLike(value)) {
          const save = inner.pos
          inner.skipSpace()
          if (matchWord(inner, 'stream')) pending.push([num, value])
          inner.pos = save
        }
        doc.objects.set(num, value)
      } catch {
        addWarning(doc, `对象流 ${containerNum} 内的对象 ${num} 解析失败`)
      }
    }
    attachStreamsAfterObjectStream(doc, stream, pending)
  }
}

/**
 * Stream dictionaries may live inside an object stream while their data sits
 * right after that object stream (ISO 32000-1 §7.5.7). Those bytes carry no
 * offset, so they are matched to the dictionaries in document order.
 */
function attachStreamsAfterObjectStream(doc, container, pending) {
  if (pending.length === 0) return
  const b = doc.buf
  let from = Math.min(b.length, container.start + Math.max(0, container.length))
  let found = 0
  for (const [num, dict] of pending) {
    const hit = findStreamKeyword(b, from)
    if (hit < 0) {
      addWarning(doc, `对象流之后的流数据不足：对象 ${num} 只保留了字典`)
      continue
    }
    from = hit
    found++
    const stream = readStreamAfterDict(doc, new Scanner(b, hit), dict)
    if (stream) doc.objects.set(num, stream)
  }
  if (found > 0) addWarning(doc, `已从对象流后部恢复 ${found} 个流对象`)
}

/** Position just past a standalone `stream` keyword at or after `from`. */
function findStreamKeyword(b, from) {
  let cursor = from
  for (let guard = 0; guard < 4000 && cursor < b.length; guard++) {
    const at = b.indexOf('stream', cursor)
    if (at < 0) return -1
    cursor = at + 6
    const before = at > 0 ? b[at - 1] : -1
    if (at >= 3 && b.toString('latin1', at - 3, at) === 'end') continue
    if (!isDelimiter(before) || !isDelimiter(b[at + 6] ?? -1)) continue
    return at + 6
  }
  return -1
}

/* ------------------------------------------------------------- xref/trailer ---- */

function readTrailers(doc) {
  const b = doc.buf
  let from = 0
  let guard = 0
  let lastStartxref = -1
  while (guard++ < 128) {
    const at = b.indexOf('trailer', from)
    if (at < 0) break
    from = at + 7
    if (at > 0 && !isDelimiter(b[at - 1])) continue
    const sc = new Scanner(b, at + 7)
    try {
      const value = readObjectBody(doc, sc)
      if (isDictLike(value)) doc.trailers.push(value)
    } catch {
      /* ignore */
    }
  }
  from = 0
  guard = 0
  while (guard++ < 128) {
    const at = b.indexOf('startxref', from)
    if (at < 0) break
    from = at + 9
    if (at > 0 && !isDelimiter(b[at - 1])) continue
    const sc = new Scanner(b, at + 9)
    sc.skipSpace()
    const offset = readNumberToken(sc)
    if (offset !== null && offset >= 0) lastStartxref = offset
  }
  doc.startxref = lastStartxref
}

function readCrossReference(doc) {
  let pos = doc.startxref ?? -1
  if (pos < 0 && doc.trailers.length === 0) return
  const seenOffsets = new Set()
  for (let round = 0; round < 24 && pos > 0 && pos < doc.buf.length; round++) {
    if (seenOffsets.has(pos)) break
    seenOffsets.add(pos)
    const sc = new Scanner(doc.buf, pos)
    sc.skipSpace()
    if (matchWord(sc, 'xref')) {
      const trailer = readTraditionalXref(doc, sc)
      if (!trailer) break
      const prev = numberValue(resolve(doc, trailer.Prev))
      applyTrailer(doc, trailer)
      if (prev === null || prev <= 0) break
      pos = prev
      continue
    }
    const header = readObjectHeaderAt(doc.buf, sc.pos)
    if (!header) break
    let value
    try {
      value = readObjectBody(doc, new Scanner(doc.buf, header.body))
    } catch {
      break
    }
    if (!(value instanceof StreamValue)) break
    readXrefStream(doc, value)
    applyTrailer(doc, value.dict)
    const prev = numberValue(resolve(doc, value.dict.Prev))
    if (prev === null || prev <= 0) break
    pos = prev
  }
}

function applyTrailer(doc, trailer) {
  if (!isDictLike(trailer)) return
  const root = trailer.Root
  const info = trailer.Info
  if (root instanceof Ref) doc.root = root
  if (info instanceof Ref) doc.info = info
  if (trailer.Encrypt) doc.encrypted = true
}

function readTraditionalXref(doc, sc) {
  const b = doc.buf
  let guard = 0
  while (guard++ < 8192) {
    sc.skipSpace()
    const start = readNumberToken(sc)
    if (start === null) break
    sc.skipSpace()
    const count = readNumberToken(sc)
    if (count === null || count < 0 || count > 20000000) break
    sc.skipSpace()
    for (let i = 0; i < count; i++) {
      if (sc.pos + 18 > b.length) return null
      const offsetText = b.toString('latin1', sc.pos, sc.pos + 10)
      const genText = b.toString('latin1', sc.pos + 11, sc.pos + 16)
      const type = b[sc.pos + 17]
      if (!/^[\d ]{10}$/.test(offsetText) || !/^[\d ]{5}$/.test(genText)) return null
      const num = start + i
      if (type === 0x6e) {
        const offset = Number(offsetText)
        if (!doc.xref.has(num) && Number.isFinite(offset)) doc.xref.set(num, { type: 1, offset })
      } else if (type === 0x66) {
        /* free entry */
      }
      // step to the next line (entries are 20 bytes but generators vary)
      while (sc.pos < b.length && b[sc.pos] !== 0x0a) sc.pos++
      sc.pos++
    }
  }
  sc.skipSpace()
  if (!matchWord(sc, 'trailer')) return null
  try {
    const value = readObjectBody(doc, sc)
    return isDictLike(value) ? value : null
  } catch {
    return null
  }
}

function readXrefStream(doc, stream) {
  const widths = arrayNumbers(resolve(doc, stream.dict.W) ?? [])
  if (widths.length === 0) {
    addWarning(doc, '交叉引用流缺少 /W 宽度数组')
    return
  }
  const data = decodeStream(doc, stream)
  if (!data) return
  const size = numberValue(stream.dict.Size) ?? 0
  const index = arrayNumbers(resolve(doc, stream.dict.Index) ?? [])
  const ranges = index.length >= 2 ? index : [0, size]
  const rowBytes = widths.reduce((sum, w) => sum + w, 0)
  if (rowBytes <= 0 || rowBytes > 64) return
  const rowLimit = Math.floor(data.length / rowBytes)
  let cursor = 0
  for (let r = 0; r + 1 < ranges.length && cursor < rowLimit; r += 2) {
    const start = ranges[r]
    const count = Math.min(ranges[r + 1], rowLimit - cursor)
    for (let i = 0; i < count && cursor < rowLimit; i++) {
      const at = cursor * rowBytes
      const type = widths[0] > 0 ? readField(data, at, widths[0], 1) : 1
      const second = readField(data, at + widths[0], widths[1], 0)
      const third = widths[2] > 0 ? readField(data, at + widths[0] + widths[1], widths[2], 0) : 0
      cursor++
      const num = start + i
      if (num < 0 || num > 20000000) continue
      if (type === 1 && Number.isFinite(second)) {
        if (!doc.xref.has(num)) doc.xref.set(num, { type: 1, offset: second })
      } else if (type === 2) {
        if (!doc.xref.has(num)) doc.xref.set(num, { type: 2, container: second, index: third })
      }
    }
  }
}

function arrayNumbers(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) out.push(typeof item === 'number' && Number.isFinite(item) ? item : 0)
  return out
}

function readField(data, at, width, fallback) {
  if (width <= 0) return fallback
  if (at + width > data.length) return null
  let value = 0
  for (let i = 0; i < width; i++) value = value * 256 + data[at + i]
  return value
}

/* --------------------------------------------------------- resolve/dict ---- */

function resolve(doc, value) {
  let current = value
  for (let depth = 0; depth < 8; depth++) {
    if (!(current instanceof Ref)) return current
    const next = doc.objects.get(current.num)
    if (next === undefined) return null
    current = next
  }
  return current instanceof Ref ? null : current
}

function dictGet(doc, dict, key) {
  if (!isDictLike(dict)) return null
  return resolve(doc, dict[key])
}

function dictArray(doc, dict, key) {
  const value = dictGet(doc, dict, key)
  return Array.isArray(value) ? value : null
}

function dictText(doc, dict, key) {
  const value = dictGet(doc, dict, key)
  if (value instanceof PdfString) return value.value
  if (typeof value === 'string') return value
  return null
}

function entriesOf(dict) {
  return isDictLike(dict) ? Object.entries(dict) : []
}

/* ------------------------------------------------------------ decoding ---- */

function streamRawBytes(stream) {
  if (!stream || stream.length < 0) return Buffer.alloc(0)
  return stream.buffer.subarray(stream.start, stream.start + stream.length)
}

/**
 * Decode a stream through its filters. Returns null (with a warning) for
 * filters we deliberately do not support, such as image codecs.
 */
function decodeStream(doc, stream) {
  if (!(stream instanceof StreamValue)) return null
  const hit = doc.decodedCache.get(stream)
  if (hit !== undefined) return hit
  let out = null
  try {
    out = decodeStreamUncached(doc, stream)
  } catch (error) {
    addWarning(doc, `流解码失败：${error instanceof Error ? error.message : String(error)}`)
    out = null
  }
  doc.decodedCache.set(stream, out)
  return out
}

function decodeStreamUncached(doc, stream) {
  let data = streamRawBytes(stream)
  const filters = normalizeFilters(doc, stream.dict.Filter)
  const params = normalizeParams(doc, stream.dict.DecodeParms)
  if (filters.length === 0) return Buffer.from(data)
  for (let i = 0; i < filters.length; i++) {
    const name = filters[i]
    const parm = isDictLike(params[i]) ? params[i] : null
    if (name === 'FlateDecode' || name === 'Fl') {
      data = flateDecode(doc, data)
      if (!data) return null
      const predictor = numberValue(parm?.Predictor) ?? 1
      if (predictor > 1) data = applyPredictor(doc, data, parm)
    } else if (name === 'ASCIIHexDecode' || name === 'AHx') {
      data = asciiHexDecode(data)
    } else if (name === 'RunLengthDecode' || name === 'RL') {
      data = runLengthDecode(data)
    } else if (name === 'ASCII85Decode' || name === 'A85') {
      data = ascii85Decode(data)
    } else if (IMAGE_FILTERS.has(name)) {
      addWarning(doc, `跳过图像滤镜 ${name}（图片内容需要 OCR）`)
      return null
    } else if (UNSUPPORTED_FILTERS.has(name)) {
      addWarning(doc, `不支持的滤镜 ${name}，该流已跳过`)
      return null
    } else {
      addWarning(doc, `未知滤镜 ${name}，该流已跳过`)
      return null
    }
    if (!data) {
      addWarning(doc, `滤镜 ${name} 解码失败`)
      return null
    }
  }
  return data
}

function normalizeFilters(doc, raw) {
  const value = resolve(doc, raw)
  const list = Array.isArray(value) ? value : [value]
  const out = []
  for (const item of list) {
    if (typeof item === 'string') out.push(item.replace(/^\//, ''))
    else if (item && typeof item === 'object' && 'op' in item) out.push(String(item.op))
  }
  return out
}

function normalizeParams(doc, raw) {
  const value = resolve(doc, raw)
  if (Array.isArray(value)) return value.map((item) => resolve(doc, item))
  return [value]
}

function flateDecode(doc, data) {
  if (data.length === 0) return Buffer.alloc(0)
  const attempts = [
    () => inflateSync(data, { maxOutputLength: 256 * 1024 * 1024 }),
    () => inflateRawSync(data, { maxOutputLength: 256 * 1024 * 1024 }),
    () => inflateSync(subarraySafe(data, 1), { maxOutputLength: 256 * 1024 * 1024 }),
  ]
  for (const attempt of attempts) {
    try {
      return attempt()
    } catch {
      /* try the next variant */
    }
  }
  addWarning(doc, 'FlateDecode 解压失败（流可能损坏）')
  return null
}

function subarraySafe(data, drop) {
  return data.length > drop ? data.subarray(drop) : data
}

function applyPredictor(doc, data, parm) {
  const predictor = numberValue(parm?.Predictor) ?? 1
  const columns = numberValue(parm?.Columns) ?? 1
  const colors = numberValue(parm?.Colors) ?? 1
  const bpc = numberValue(parm?.BitsPerComponent) ?? 8
  if (predictor === 1 || columns <= 0 || colors <= 0 || bpc <= 0) return data
  const rowPixels = Math.max(1, Math.ceil((colors * bpc) / 8) * columns)
  if (rowPixels > 1024 * 1024) return data
  if (predictor === 2) return data // TIFF: not needed for our streams
  if (predictor < 10) return data
  const rowBytes = rowPixels + 1
  const rows = Math.floor(data.length / rowBytes)
  if (rows <= 0 || rows * rowBytes > 64 * 1024 * 1024) return data
  const out = Buffer.from(data)
  for (let r = 0; r < rows; r++) {
    const at = r * rowBytes
    const kind = out[at]
    const cur = out.subarray(at + 1, at + rowBytes)
    if (kind === 0) continue
    const prevAt = (r - 1) * rowBytes + 1
    for (let i = 0; i < cur.length; i++) {
      const left = i >= rowPixels ? 0 : cur[i - rowPixels]
      const up = r === 0 ? 0 : out[prevAt + i]
      const upperLeft = r === 0 || i < rowPixels ? 0 : out[prevAt + i - rowPixels]
      let value = cur[i]
      if (kind === 1) value = (value + left) & 0xff
      else if (kind === 2) value = (value + up) & 0xff
      else if (kind === 3) value = (value + ((left + up) >> 1)) & 0xff
      else if (kind === 4) value = (value + paeth(left, up, upperLeft)) & 0xff
      else {
        addWarning(doc, 'PNG 预测器类型无效，已按原样使用')
        return data
      }
      cur[i] = value
    }
  }
  const stripped = Buffer.allocUnsafe(rows * rowPixels)
  for (let r = 0; r < rows; r++) out.copy(stripped, r * rowPixels, r * rowBytes + 1, r * rowBytes + rowBytes)
  return stripped
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

function asciiHexDecode(data) {
  const text = data.toString('latin1')
  const body = text.endsWith('>') ? text.slice(0, -1) : text
  const clean = body.replace(/[^0-9A-Fa-f]/g, '')
  const padded = clean.length % 2 ? `${clean}0` : clean
  const out = Buffer.allocUnsafe(Math.floor(padded.length / 2))
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(padded.slice(i * 2, i * 2 + 2), 16)
  return out
}

function runLengthDecode(data) {
  const out = []
  let p = 0
  while (p < data.length) {
    const length = data[p++]
    if (length === 128) break
    if (length < 128) {
      const stop = Math.min(data.length, p + length + 1)
      for (let q = p; q < stop; q++) out.push(data[q])
      p = stop
    } else {
      if (p >= data.length) break
      const byte = data[p++]
      const repeat = 257 - length
      for (let i = 0; i < repeat; i++) out.push(byte)
    }
  }
  return Buffer.from(out)
}

function ascii85Decode(data) {
  const text = data.toString('latin1')
  const out = []
  let value = 0
  let count = 0
  for (let i = 0; i < text.length && out.length < 64 * 1024 * 1024; i++) {
    const c = text.charCodeAt(i)
    if (SPACE_BYTES.has(c) || c === 0x3c || c === 0x7e) continue // whitespace, '<~', '~>'
    if (c === 0x3e) break // '>'
    if (c === 0x7a && count === 0) { // 'z'
      out.push(0, 0, 0, 0)
      continue
    }
    if (c < 0x21 || c > 0x75) continue
    value = value * 85 + (c - 33)
    count++
    if (count === 5) {
      out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
      value = 0
      count = 0
    }
  }
  if (count > 1) {
    while (count < 5) {
      value = value * 85 + 84
      count++
    }
    const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
    for (let k = 0; k < count - 1; k++) out.push(bytes[k])
  }
  return Buffer.from(out)
}

/* -------------------------------------------------------------- pages ---- */

function findCatalog(doc) {
  const candidates = []
  for (const trailer of doc.trailers) if (trailer.Root) candidates.push(trailer.Root)
  if (doc.root) candidates.push(doc.root)
  for (let i = candidates.length - 1; i >= 0; i--) {
    const value = resolve(doc, candidates[i])
    if (isDictLike(value) && (value.Type === 'Catalog' || value.Pages !== undefined)) return value
  }
  let pagesNode = null
  for (const value of doc.objects.values()) {
    if (!isDictLike(value)) continue
    if (value.Type === 'Catalog') return value
    if (!pagesNode && value.Type === 'Pages' && value.Kids) pagesNode = value
  }
  if (pagesNode) return pagesNode
  // Last resort: treat every /Type /Page object as a page, in object order.
  const loose = []
  for (const [num, value] of [...doc.objects.entries()].sort((a, b) => a[0] - b[0])) {
    if (isDictLike(value) && value.Type === 'Page') loose.push({ dict: value, num })
    if (loose.length >= 20) break
  }
  if (loose.length === 0) return null
  addWarning(doc, '未找到 /Root 目录，已按对象顺序收集页面')
  return { __loose: loose }
}

function collectPages(doc, catalog, maxPages) {
  if (catalog.__loose) {
    return catalog.__loose.map((item) => ({ dict: item.dict, resources: dictGet(doc, item.dict, 'Resources') })).slice(0, maxPages)
  }
  const out = []
  const visited = new Set()
  // The catalog itself is not a page: start the walk at /Pages (a PDF whose
  // root already is a Pages tree still works, and a single /Page root too).
  const pagesRoot = dictGet(doc, catalog, 'Pages')
  const start = isDictLike(pagesRoot) ? pagesRoot : catalog
  const queue = [{ dict: start, refNum: start === catalog ? doc.root?.num ?? null : null, resources: null, depth: 0 }]
  let guard = 0
  while (queue.length > 0 && out.length < maxPages && guard++ < maxPages * 8 + 1000) {
    const node = queue.shift()
    const type = node.dict.Type
    const kids = dictArray(doc, node.dict, 'Kids')
    if (type === 'Page' || (!kids && type !== 'Pages' && !dictGet(doc, node.dict, 'Pages'))) {
      // A page may declare its own /Resources; inherited ones from ancestors
      // are only a fallback.
      out.push({ dict: node.dict, resources: dictGet(doc, node.dict, 'Resources') ?? node.resources })
      continue
    }
    if (!kids) continue
    if (node.refNum !== null) {
      if (visited.has(node.refNum)) continue
      visited.add(node.refNum)
    }
    const inherited = dictGet(doc, node.dict, 'Resources') ?? node.resources
    if (node.depth > 64) {
      addWarning(doc, '页面树层级过深，已停止向下遍历')
      continue
    }
    for (const kid of kids.slice(0, 20000)) {
      const value = resolve(doc, kid)
      if (!isDictLike(value)) continue
      queue.push({ dict: value, refNum: kid instanceof Ref ? kid.num : null, resources: inherited, depth: node.depth + 1 })
    }
  }
  if (out.length >= maxPages) addWarning(doc, `页数超过上限 ${maxPages}，后续页面已忽略`)
  return out
}

/* -------------------------------------------------------------- fonts ---- */

function pageFonts(doc, resources) {
  if (!isDictLike(resources)) return new Map()
  const cached = doc.fontCache.get(resources)
  if (cached) return cached
  const table = new Map()
  const fontDict = dictGet(doc, resources, 'Font')
  for (const [name, raw] of entriesOf(fontDict)) {
    const value = resolve(doc, raw)
    if (!isDictLike(value)) continue
    try {
      table.set(name, describeFont(doc, value))
    } catch (error) {
      addWarning(doc, `字体 ${name} 解析失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  doc.fontCache.set(resources, table)
  return table
}

function describeFont(doc, dict) {
  const subtype = String(dict.Subtype ?? '')
  const font = { subtype, twoByte: subtype === 'Type0', toUnicode: null, base: 'winansi', diffs: null, warned: false }
  if (subtype === 'Type0') {
    const encodingName = typeof dict.Encoding === 'string' ? dict.Encoding.replace(/^\//, '') : null
    if (encodingName && !/^Identity/.test(encodingName)) {
      addWarning(doc, `Type0 字体使用非 Identity 编码（${encodingName}），仅尽力用 ToUnicode 或 16 位码转换`)
    }
    font.toUnicode = toUnicodeMap(doc, dict) ?? descendantToUnicode(doc, dict)
    font.twoByte = true
    return font
  }
  font.toUnicode = toUnicodeMap(doc, dict)
  const encoding = resolve(doc, dict.Encoding)
  if (typeof encoding === 'string') {
    const name = encoding.replace(/^\//, '')
    if (name === 'MacRomanEncoding') font.base = 'macroman'
    else if (name === 'StandardEncoding') font.base = 'standard'
    else if (name === 'PDFDocEncoding') font.base = 'pdfdoc'
  } else if (isDictLike(encoding)) {
    font.base = String(encoding.BaseEncoding ?? '').replace(/^\//, '') || 'winansi'
    if (font.base !== 'winansi' && font.base !== 'macroman') font.base = font.base === 'standard' || font.base === 'pdfdoc' ? font.base : 'winansi'
    const diffs = dictArray(doc, encoding, 'Differences')
    if (diffs && diffs.length > 0) font.diffs = buildDifferences(doc, diffs)
  }
  return font
}

function descendantToUnicode(doc, dict) {
  const descendants = dictArray(doc, dict, 'DescendantFonts')
  for (const item of descendants ?? []) {
    const value = resolve(doc, item)
    const map = toUnicodeMap(doc, value)
    if (map) return map
  }
  return null
}

function toUnicodeMap(doc, dict) {
  if (!isDictLike(dict)) return null
  const stream = resolve(doc, dict.ToUnicode)
  if (!(stream instanceof StreamValue)) return null
  return parseCMap(doc, stream)
}

function buildDifferences(doc, diffs) {
  const map = new Map()
  let code = 0
  for (const item of diffs) {
    if (typeof item === 'number') {
      code = item
      continue
    }
    if (typeof item === 'string') {
      if (code >= 0 && code <= 255) {
        const char = glyphNameToChar(item)
        if (char !== null) map.set(code, char)
      }
      code++
      continue
    }
    if (item && typeof item === 'object' && 'op' in item) {
      addWarning(doc, `字体 Differences 中出现无法识别的编码项（${item.op}）`)
    }
  }
  return map
}

function glyphNameToChar(name) {
  if (!name) return null
  const clean = String(name).replace(/^\//, '')
  if (GLYPH_NAMES.has(clean)) return GLYPH_NAMES.get(clean)
  let match = /^uni([0-9A-Fa-f]{4})$/.exec(clean)
  if (match) return charSafely(Number.parseInt(match[1], 16))
  match = /^u([0-9A-Fa-f]{4,6})$/.exec(clean)
  if (match) return charSafely(Number.parseInt(match[1], 16))
  match = /^u([0-9A-Fa-f]{4})u([0-9A-Fa-f]{4})$/.exec(clean)
  if (match) return `${charSafely(Number.parseInt(match[1], 16)) ?? ''}${charSafely(Number.parseInt(match[2], 16)) ?? ''}`
  match = /^([0-9A-Fa-f]{2})$/.exec(clean)
  if (match) return charSafely(Number.parseInt(match[1], 16))
  match = /^([A-Za-z])(\d+)$/.exec(clean)
  if (match) return clean.charAt(0).toLowerCase()
  return null
}

function charSafely(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return null
  try {
    return String.fromCodePoint(code)
  } catch {
    return null
  }
}

const CMAP_TOKEN = /<[0-9A-Fa-f\s]*>|\[[\s\S]{0,400000}?\]|[-+]?[\d.]+|[A-Za-z_][A-Za-z0-9_.]*/g

function parseCMap(doc, stream) {
  const data = decodeStream(doc, stream)
  if (!data || data.length === 0) return null
  const text = data.toString('latin1')
  const map = new Map()
  const blocks = /begin(bfchar|bfrange)([\s\S]{0,4000000}?)end\1/g
  let match
  let guard = 0
  let truncated = false
  while ((match = blocks.exec(text)) !== null && guard++ < 512) {
    const kind = match[1]
    const body = match[2]
    CMAP_TOKEN.lastIndex = 0
    const tokens = []
    let token
    let tokenGuard = 0
    while ((token = CMAP_TOKEN.exec(body)) !== null && tokenGuard++ < 400000) tokens.push(token[0])
    if (tokenGuard >= 400000) truncated = true
    if (kind === 'bfchar') {
      for (let i = 0; i + 1 < tokens.length; i += 2) {
        const code = hexToCode(tokens[i])
        const out = hexToChars(tokens[i + 1])
        if (code !== null && out) map.set(code, out)
      }
    } else {
      let i = 0
      while (i + 2 < tokens.length) {
        const lo = hexToCode(tokens[i])
        const hi = hexToCode(tokens[i + 1])
        if (lo === null || hi === null || hi < lo) {
          i++
          continue
        }
        const dst = tokens[i + 2]
        if (dst.startsWith('[')) {
          const items = dst.match(/<[0-9A-Fa-f]+>/g) ?? []
          const span = Math.min(hi - lo, items.length - 1, 70000)
          for (let k = 0; k <= span; k++) {
            const chars = hexToChars(items[k])
            if (chars) map.set(lo + k, chars)
          }
          i += 3
          continue
        }
        const first = hexToChars(dst)
        if (first) {
          const span = Math.min(hi - lo, 70000)
          for (let k = 0; k <= span; k++) {
            const chars = singleCharAt(first, k)
            if (chars) map.set(lo + k, chars)
          }
        }
        i += 3
      }
    }
  }
  if (truncated) addWarning(doc, 'ToUnicode 映射表过大，已截断')
  if (guard >= 512) addWarning(doc, 'ToUnicode 块数量超过上限')
  if (blocks.lastIndex === 0 && map.size === 0) addWarning(doc, 'ToUnicode CMap 中未找到 bfchar/bfrange')
  return map.size > 0 ? map : null
}

function singleCharAt(text, offset) {
  if (offset === 0) return text
  const code = text.codePointAt(0)
  if (!Number.isFinite(code)) return null
  return charSafely(code + offset)
}

function codeStep(text) {
  const units = Array.from(text)
  if (units.length > 1) return 1
  return 1
}

function hexToCode(token) {
  const hex = String(token ?? '').replace(/[<>\s]/g, '')
  if (hex === '' || hex.length > 16 || !/^[0-9A-Fa-f]+$/.test(hex)) return null
  const value = Number.parseInt(hex, 16)
  return Number.isFinite(value) ? value : null
}

function hexToChars(token) {
  const hex = String(token ?? '').replace(/[<>\s]/g, '')
  if (hex === '' || hex.length > 64 || !/^[0-9A-Fa-f]+$/.test(hex)) return ''
  const size = hex.length % 4 === 0 ? 4 : hex.length % 2 === 0 ? 2 : 0
  if (size === 0) return ''
  let out = ''
  for (let i = 0; i + size <= hex.length; i += size) {
    const code = Number.parseInt(hex.slice(i, i + size), 16)
    const char = charSafely(code)
    out += char ?? ''
  }
  return out
}

/* ---------------------------------------------------------- text mapping ---- */

function mapRun(doc, font, raw) {
  if (raw === '' || raw == null) return ''
  if (!font) return sanitizeText(decodeBytes(raw, 'winansi'))
  if (font.twoByte) return mapTwoByte(doc, font, raw)
  return mapSimple(doc, font, raw)
}

function mapTwoByte(doc, font, raw) {
  const out = []
  const fallback = []
  const flushFallback = () => {
    if (fallback.length === 0) return
    out.push(fallback.join(''))
    fallback.length = 0
    if (!font.warned) {
      font.warned = true
      addWarning(doc, font.toUnicode ? 'CID 字体存在 ToUnicode 未覆盖的码点，已按 Identity-H 近似转换' : 'CID 字体缺少 ToUnicode，部分字符按 Identity-H 码点近似转换')
    }
  }
  const pairs = Math.floor(raw.length / 2)
  for (let i = 0; i < pairs; i++) {
    const code = (raw.charCodeAt(i * 2) << 8) | raw.charCodeAt(i * 2 + 1)
    const mapped = font.toUnicode?.get(code)
    if (mapped !== undefined) {
      flushFallback()
      out.push(mapped)
      continue
    }
    const approx = code >= 0xfffe ? '' : charSafely(code) ?? ''
    if (approx) fallback.push(approx)
    else flushFallback()
  }
  if (raw.length % 2 === 1) {
    const tail = raw.charCodeAt(pairs * 2)
    if (tail >= 0x20 && tail < 0x7f) out.push(String.fromCharCode(tail))
    addWarning(doc, 'CID 字符串长度为奇数，末尾字节按 ASCII 处理')
  }
  flushFallback()
  return out.join('')
}

function mapSimple(doc, font, raw) {
  if (font.toUnicode && font.toUnicode.size > 0) {
    const out = []
    for (let i = 0; i < raw.length; i++) {
      const code = raw.charCodeAt(i)
      out.push(font.toUnicode.get(code) ?? decodeOne(code, font.base))
    }
    return sanitizeText(out.join(''))
  }
  if (font.diffs && font.diffs.size > 0) {
    const out = []
    for (let i = 0; i < raw.length; i++) {
      const code = raw.charCodeAt(i)
      out.push(font.diffs.get(code) ?? decodeOne(code, font.base))
    }
    return sanitizeText(out.join(''))
  }
  return sanitizeText(decodeBytes(raw, font.base))
}

function decodeOne(code, base) {
  if (code === 0) return ''
  if (base === 'macroman' && MAC_ROMAN) return MAC_ROMAN.decode(Buffer.from([code]))
  if (WIN_ANSI && base !== 'standard' && base !== 'pdfdoc') return WIN_ANSI.decode(Buffer.from([code]))
  if (code < 0x80) return String.fromCharCode(code)
  if (!WIN_ANSI) return String.fromCharCode(code)
  return WIN_ANSI.decode(Buffer.from([code]))
}

function decodeBytes(raw, base) {
  const bytes = Buffer.from(raw, 'latin1')
  const decoder = base === 'macroman' ? MAC_ROMAN : WIN_ANSI
  if (!decoder) return raw
  try {
    return decoder.decode(bytes)
  } catch {
    return raw
  }
}

const CONTROL_KEEP = new Set([0x09, 0x0a, 0x0d])

function sanitizeText(text) {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x20 && !CONTROL_KEEP.has(code)) continue
    if (code === 0xfffd) continue
    out += text[i]
  }
  return out
}

/* -------------------------------------------------------- content stream ---- */

function renderPage(doc, page) {
  const content = pageContentBytes(doc, page.dict)
  if (!content) return
  const fonts = pageFonts(doc, page.resources)
  const lines = []
  let current = []
  let font = null
  let fontSize = 0
  let tmA = 1
  let tmD = 1
  let lineF = 0
  let lineE = 0
  let leading = 0
  let guard = 0
  let operands = []

  const push = (text) => {
    if (!text) return
    current.push(text)
    if (current.length > 50000) flushLine()
  }
  const flushLine = () => {
    if (current.length === 0) return
    const text = sanitizeLine(current.join(''))
    current = []
    if (text === '') return
    lines.push(text)
    doc.chars += text.length + 1
    if (doc.chars > doc.maxChars) {
      doc.truncated = true
      addWarning(doc, `正文超过 ${doc.maxChars} 字符，已截断`)
    }
  }

  const size = () => Math.max(Math.abs(fontSize), Math.abs(tmA), Math.abs(tmD), 0.001)
  const gapNeedsSpace = (gap) => (gap / 1000) * size() > KERN_SPACE_RATIO

  const showText = (token) => {
    if (token.kind === 'str') {
      push(mapRun(doc, font, token.value))
      return
    }
    if (token.kind === 'arr') {
      for (const item of token.items) {
        if (item.kind === 'num') {
          if (gapNeedsSpace(-item.value)) push(' ')
        } else if (item.kind === 'str') {
          push(mapRun(doc, font, item.value))
        }
      }
    }
  }

  const sc = new Scanner(content, 0)
  while (sc.pos < content.length && guard++ < MAX_TOKENS && !doc.truncated) {
    sc.skipSpace()
    if (sc.end) break
    const c = sc.at()
    if (c === 0x3c && sc.at(1) === 0x3c) {
      readDict(doc, sc, 0)
      continue
    }
    if (c === 0x3c) { operands.push({ kind: 'str', value: readHexString(sc) }); continue }
    if (c === 0x28) { operands.push({ kind: 'str', value: readLiteralString(sc) }); continue }
    if (c === 0x5b) { operands.push(readContentArray(sc)); continue }
    if (c === 0x2f) { operands.push({ kind: 'name', value: readName(sc) }); continue }
    if (isDigitByte(c) || c === 0x2b || c === 0x2d || (c === 0x2e && isDigitByte(sc.at(1)))) {
      const num = readNumberToken(sc)
      if (num === null) { sc.pos++; continue }
      operands.push({ kind: 'num', value: num })
      continue
    }
    const op = readToken(sc, 40)
    if (op === 'BI') { skipInlineImage(sc); continue }
    if (op === 'Q' || op === 'q' || op === 'gs') { operands = []; continue }
    dispatch(op)
    operands = []
  }
  flushLine()
  if (guard >= MAX_TOKENS) addWarning(doc, `单页内容指令超过 ${MAX_TOKENS} 条，已截断`)
  const text = lines.join('\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  if (text !== '') doc.pageTexts.push(text)

  function dispatch(op) {
    const last = operands[operands.length - 1]
    switch (op) {
      case 'BT':
        flushLine()
        tmA = 1; tmD = 1
        break
      case 'ET':
        flushLine()
        break
      case 'Tf': {
        const nameToken = operands.length > 1 ? operands[operands.length - 2] : null
        const sizeToken = last
        font = nameToken && nameToken.kind === 'name' ? fonts.get(nameToken.value) ?? null : null
        fontSize = sizeToken && sizeToken.kind === 'num' ? sizeToken.value : fontSize
        if (!font && nameToken && nameToken.kind === 'name') addWarning(doc, `页面引用了未定义的字体 ${nameToken.value}`)
        break
      }
      case 'Td':
      case 'TD': {
        const tx = operands.length > 1 && operands[operands.length - 2].kind === 'num' ? operands[operands.length - 2].value : 0
        const ty = last && last.kind === 'num' ? last.value : 0
        if (op === 'TD') leading = -ty
        if (ty !== 0) flushLine()
        else if (tx > TD_SPACE_RATIO * size()) push(' ')
        lineE += tx
        lineF += ty
        break
      }
      case 'Tm': {
        if (operands.length < 6) break
        const [a, , , d, e, f] = operands.slice(-6).map((token) => (token.kind === 'num' ? token.value : 0))
        tmA = a
        tmD = d
        const dy = Math.abs(f - lineF)
        const dx = Math.abs(e - lineE)
        if (dy > Math.max(0.5, 0.2 * size())) flushLine()
        else if (dx > TD_SPACE_RATIO * size()) push(' ')
        lineE = e
        lineF = f
        break
      }
      case 'T*':
        flushLine()
        lineF -= leading
        break
      case 'TL':
        if (last?.kind === 'num') leading = last.value
        break
      case 'Tj':
        if (last) showText(last)
        break
      case 'TJ':
        if (last) showText(last)
        break
      case "'":
        flushLine()
        if (last) showText(last)
        break
      case '"': {
        flushLine()
        const str = operands.length > 2 ? operands[operands.length - 1] : last
        if (str) showText(str)
        break
      }
      default:
        break
    }
  }
}

function sanitizeLine(text) {
  return text
    .replace(/\u0000/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/^\s+|\s+$/g, '')
}

function readContentArray(sc) {
  const items = []
  sc.pos++ // '['
  let guard = 0
  while (sc.pos < sc.buf.length && guard++ < 200000) {
    sc.skipSpace()
    const c = sc.at()
    if (c === -1) break
    if (c === 0x5d) { sc.pos++; break } // ']'
    if (c === 0x28) { items.push({ kind: 'str', value: readLiteralString(sc) }); continue }
    if (c === 0x3c) {
      if (sc.at(1) === 0x3c) { readDict0(sc); continue }
      items.push({ kind: 'str', value: readHexString(sc) })
      continue
    }
    if (isDigitByte(c) || c === 0x2b || c === 0x2d || (c === 0x2e && isDigitByte(sc.at(1)))) {
      const num = readNumberToken(sc)
      if (num === null) { sc.pos++; continue }
      items.push({ kind: 'num', value: num })
      continue
    }
    const before = sc.pos
    readToken(sc, 40)
    if (sc.pos === before) sc.pos++
  }
  return { kind: 'arr', items }
}

function readDict0(sc) {
  let depth = 0
  do {
    if (sc.at() === 0x3c && sc.at(1) === 0x3c) { depth++; sc.pos += 2; continue }
    if (sc.at() === 0x3e && sc.at(1) === 0x3e) { depth--; sc.pos += 2; continue }
    sc.pos++
  } while (sc.pos < sc.buf.length && depth > 0)
}

function skipInlineImage(sc) {
  const b = sc.buf
  const id = b.indexOf('ID', sc.pos)
  if (id < 0) { sc.pos = b.length; return }
  let from = id + 2
  for (let guard = 0; guard < 4096; guard++) {
    const at = b.indexOf('EI', from)
    if (at < 0) break
    from = at + 2
    if ((at === 0 || SPACE_BYTES.has(b[at - 1])) && isDelimiter(b[at + 2] ?? -1)) {
      sc.pos = at + 2
      return
    }
  }
  sc.pos = b.length
}

function pageContentBytes(doc, pageDict) {
  const raw = dictGet(doc, pageDict, 'Contents')
  const list = Array.isArray(raw) ? raw : [raw]
  const parts = []
  let total = 0
  for (const item of list) {
    const stream = resolve(doc, item)
    if (stream instanceof StreamValue) {
      const data = decodeStream(doc, stream)
      if (data && data.length > 0) { parts.push(data); total += data.length }
      continue
    }
    if (typeof stream === 'string') {
      // Some generators inline the content as a string.
      parts.push(Buffer.from(stream, 'latin1'))
      total += stream.length
    }
  }
  if (parts.length === 0) {
    addWarning(doc, `页面 /Contents 未能解析为内容流（值类型 ${raw == null ? 'null' : Array.isArray(raw) ? 'array' : raw.constructor?.name ?? typeof raw}）`)
    return null
  }
  return Buffer.concat(parts, total)
}

/* --------------------------------------------------------------- title ---- */

function pickTitle(doc, fallback) {
  const info = resolve(doc, doc.info) ?? findInfoDict(doc)
  if (isDictLike(info)) {
    const title = dictText(doc, info, 'Title')
    const decoded = decodePdfString(title)
    if (decoded) return decoded
  }
  const option = String(fallback ?? '').trim()
  if (option) return option
  const first = doc.pageTexts[0]?.split('\n').find((line) => line.trim() !== '') ?? ''
  return first.trim().slice(0, 160)
}

function findInfoDict(doc) {
  for (const value of doc.objects.values()) {
    if (!isDictLike(value)) continue
    if (value.Title !== undefined || (value.Producer !== undefined && value.CreationDate !== undefined)) return value
  }
  return null
}

/** PDF strings are byte strings: UTF-16BE when prefixed, else best-effort UTF-8. */
export function decodePdfString(raw) {
  const text = String(raw ?? '')
  if (text === '') return ''
  const bytes = Buffer.from(text, 'latin1')
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    try {
      return new TextDecoder('utf-16be').decode(bytes.subarray(2)).replace(/\u0000/g, '').trim()
    } catch {
      /* fall through */
    }
  }
  if (bytes.every((byte) => byte < 0x80)) return text.trim()
  try {
    const utf8 = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (!utf8.includes('\uFFFD')) return utf8.trim()
  } catch {
    /* fall through */
  }
  return decodeBytes(text, 'winansi').trim()
}
