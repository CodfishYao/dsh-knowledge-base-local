/**
 * Unified document-text extraction entry point: PDF and OOXML (docx/xlsx/pptx).
 *
 * Detection is by magic bytes first and extension second, so a mislabelled file
 * is still handled sensibly. Everything degrades to `{ ok:false, error }` —
 * callers must keep the attachment and store a placeholder rather than throwing.
 */
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { extractPdf, isPdf } from './extract_pdf.js'
import { extractOffice, isOleCompound, officeKindOf } from './extract_office.js'

const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt'])

export function documentKindOf(fileName) {
  const name = String(fileName ?? '').toLowerCase()
  if (name.endsWith('.pdf')) return 'pdf'
  const office = officeKindOf(name)
  if (office) return office
  if (name.endsWith('.doc') || name.endsWith('.xls') || name.endsWith('.ppt')) return 'ole'
  return ''
}

/** True when this file name is a document type we can try to extract. */
export function canExtract(fileName) {
  const name = String(fileName ?? '').toLowerCase()
  return DOCUMENT_EXTENSIONS.has(name.slice(name.lastIndexOf('.') < 0 ? 0 : name.lastIndexOf('.')))
}

export function looksLikeDocumentBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return false
  if (isPdf(buffer)) return true
  if (buffer.length > 3 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) return true
  return isOleCompound(buffer)
}

/**
 * Extract text from a Buffer (no filesystem access).
 * @returns {{ok:boolean, kind:string, title:string, text:string, pages?:number, warnings:string[], error?:string, unsupported?:boolean}}
 */
export function extractDocumentBuffer(buffer, fileName = '', options = {}) {
  const warnings = []
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, kind: '', title: '', text: '', warnings, error: '空文件或无法读取' }
  }
  const maxBytes = Number(options.maxBytes) || 64 * 1024 * 1024
  if (buffer.length > maxBytes) {
    return { ok: false, kind: documentKindOf(fileName), title: '', text: '', warnings, error: `文件过大（${buffer.length} 字节 > ${maxBytes}）` }
  }

  const looksPdf = isPdf(buffer) || String(fileName).toLowerCase().endsWith('.pdf')
  const looksZip = buffer.length > 3 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04
  const looksOle = isOleCompound(buffer)

  if (looksPdf) {
    const result = extractPdf(buffer, options)
    if (!result.ok && result.error) warnings.push(...(result.warnings ?? []))
    return { ...result, warnings: [...(result.warnings ?? []), ...warnings] }
  }
  if (looksZip) {
    const kind = officeKindOf(fileName)
    const result = extractOffice(buffer, fileName || `document.${kind || 'zip'}`, options)
    if (result.kind === 'zip' || (!result.ok && !result.error)) {
      return { ok: false, kind: 'zip', title: '', text: '', warnings: [...(result.warnings ?? []), ...warnings], error: result.error ?? '不是可识别的 Office 文档（docx/xlsx/pptx）' }
    }
    return { ...result, warnings: [...(result.warnings ?? []), ...warnings] }
  }
  if (looksOle) {
    return {
      ok: false,
      kind: 'ole',
      title: basename(String(fileName ?? '')).replace(/\.[^.]+$/, ''),
      text: '',
      unsupported: true,
      warnings,
      error: '旧式 Office 二进制格式（.doc/.xls/.ppt）暂不支持，请先另存为 docx/xlsx/pptx 再导入。',
    }
  }
  return { ok: false, kind: '', title: '', text: '', unsupported: true, warnings, error: '无法识别的文件格式' }
}

/**
 * Extract text from a file on disk.
 * @param {string} path absolute or relative file path
 * @param {{maxBytes?:number, maxPages?:number, title?:string}} [options]
 */
export async function extractDocumentText(path, options = {}) {
  const name = String(path ?? '')
  const info = await stat(name).catch(() => null)
  if (!info || !info.isFile()) {
    return { ok: false, kind: documentKindOf(name), title: '', text: '', warnings: [], error: `文件不存在：${name}` }
  }
  const maxBytes = Number(options.maxBytes) || 64 * 1024 * 1024
  if (info.size > maxBytes) {
    return { ok: false, kind: documentKindOf(name), title: '', text: '', warnings: [], error: `文件过大（${info.size} 字节 > ${maxBytes}）` }
  }
  const buffer = await readFile(name)
  const result = extractDocumentBuffer(buffer, basename(name), options)
  if (options.title && result.title === '') result.title = String(options.title)
  return result
}

export { extractPdf, extractOffice, officeKindOf, isPdf, isOleCompound }
