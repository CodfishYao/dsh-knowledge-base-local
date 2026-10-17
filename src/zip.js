/**
 * Minimal, read-only ZIP container parser (no dependencies).
 *
 * Reads the End Of Central Directory record (with the ZIP64 locator/EOCD when
 * the 32-bit fields are saturated), then walks the Central Directory and
 * resolves each entry through its Local Header. Supported storage methods are
 * 0 (stored) and 8 (deflate, via node:zlib inflateRawSync). Decompression is
 * lazy and per entry: parsing a big archive never expands all of it at once.
 *
 * Writing ZIP files is intentionally not supported.
 */
import { inflateRawSync } from 'node:zlib'

const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50
const SIG_EOCD = 0x06054b50
const SIG_EOCD64 = 0x06074b50
const SIG_EOCD64_LOCATOR = 0x07064b50

const FLAG_ENCRYPTED = 0x0001
const FLAG_UTF8_NAME = 0x0800
const U32_MAX = 0xffffffff

const EOCD_MIN_SIZE = 22
const MAX_EOCD_SCAN = 64 * 1024 + EOCD_MIN_SIZE
const DEFAULT_MAX_ENTRIES = 30000
const DEFAULT_MAX_ENTRY_BYTES = 128 * 1024 * 1024

/**
 * @typedef {{
 *   name: string,
 *   method: number,
 *   size: number,
 *   compressedSize: number,
 *   encrypted: boolean,
 *   directory: boolean,
 *   read: () => Buffer,
 * }} ZipEntry

/**
 * Parse a ZIP buffer into lazily readable entries.
 * Never throws: structural problems come back as `error`.
 *
 * @param {Buffer|Uint8Array|string} buffer whole archive
 * @param {{maxEntries?:number, maxEntryBytes?:number}} [options]
 * @returns {{entries: ZipEntry[], warnings: string[], error?: string}}
 */
export function readZipEntries(buffer, options = {}) {
  const warnings = []
  const fail = (message) => ({ entries: [], warnings, error: message })
  let buf
  try {
    buf = toBuffer(buffer)
  } catch (error) {
    return fail(`无法读取 ZIP 内容：${messageOf(error)}`)
  }
  if (buf.length < EOCD_MIN_SIZE) return fail('不是有效的 ZIP 文件：内容过短')

  try {
    const eocd = findEocd(buf)
    if (eocd < 0) return fail('不是有效的 ZIP 文件：找不到中央目录结尾记录（EOCD）')

    let count = buf.readUInt16LE(eocd + 10)
    let centralSize = buf.readUInt32LE(eocd + 12)
    let centralOffset = buf.readUInt32LE(eocd + 16)
    if (count === 0xffff || centralSize === U32_MAX || centralOffset === U32_MAX) {
      const zip64 = readZip64Eocd(buf, eocd)
      if (!zip64) return fail('ZIP64 压缩包结构不完整：缺少 EOCD64 记录，请重新打包后再导入')
      count = Number(zip64.count)
      centralSize = Number(zip64.size)
      centralOffset = Number(zip64.offset)
      warnings.push('已按 ZIP64 结束记录解析中央目录')
    }
    if (!Number.isFinite(centralOffset) || centralOffset + centralSize > buf.length) {
      return fail('ZIP 中央目录偏移越界，文件可能已损坏或被截断')
    }

    const maxEntries = Math.max(1, Number(options.maxEntries) || DEFAULT_MAX_ENTRIES)
    const maxEntryBytes = Math.max(1024, Number(options.maxEntryBytes) || DEFAULT_MAX_ENTRY_BYTES)
    const entries = []
    const seen = new Set()
    let pos = centralOffset
    let scanned = 0
    const limit = Math.min(count, maxEntries) + 16
    while (scanned < count && entries.length < maxEntries && scanned < limit && pos + 46 <= buf.length) {
      scanned++
      if (buf.readUInt32LE(pos) !== SIG_CENTRAL) break
      const header = readCentralHeader(buf, pos)
      if (!header) break
      pos = header.next
      if (header.zip64Missing) {
        warnings.push(`条目 ${header.name} 使用 ZIP64 尺寸但缺少扩展字段，已跳过`)
        continue
      }
      if (seen.has(header.name)) continue
      seen.add(header.name)
      entries.push(makeEntry(buf, header, maxEntryBytes))
    }
    if (scanned < count && entries.length >= maxEntries) {
      warnings.push(`ZIP 条目超过 ${maxEntries} 个，只读取了前 ${maxEntries} 个`)
    }
    return { entries, warnings }
  } catch (error) {
    return { entries: [], warnings, error: `解析 ZIP 失败：${messageOf(error)}` }
  }
}

/**
 * Find an entry by name (exact, then case-insensitive, then by path suffix).
 * @param {{entries: ZipEntry[]}} zip
 * @param {string} name
 * @returns {ZipEntry|undefined}
 */
export function findEntry(zip, name) {
  const wanted = String(name ?? '')
  if (!wanted || !zip || !Array.isArray(zip.entries)) return undefined
  const exact = zip.entries.find((entry) => entry.name === wanted)
  if (exact) return exact
  const lowered = wanted.toLowerCase()
  const ci = zip.entries.find((entry) => entry.name.toLowerCase() === lowered)
  if (ci) return ci
  const suffix = `/${lowered}`
  return zip.entries.find((entry) => entry.name.toLowerCase().endsWith(suffix))
}

/**
 * @param {{entries: ZipEntry[]}} zip
 * @returns {string[]}
 */
export function entryNames(zip) {
  return (zip?.entries ?? []).map((entry) => entry.name)
}

/**
 * Read one entry as text. Returns '' when the entry is absent or unreadable.
 * @param {{entries: ZipEntry[]}} zip
 * @param {string} name
 * @param {BufferEncoding} [encoding]
 * @returns {string}
 */
export function readEntryText(zip, name, encoding = 'utf8') {
  const bytes = readEntry(zip, name)
  return bytes ? bytes.toString(encoding) : ''
}

/**
 * Read one entry, or null when it is missing/failing (never throws).
 * @param {{entries: ZipEntry[]}} zip
 * @param {string} name
 * @returns {Buffer|null}
 */
export function readEntry(zip, name) {
  const entry = findEntry(zip, name)
  if (!entry) return null
  try {
    return entry.read()
  } catch {
    return null
  }
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (typeof value === 'string') return Buffer.from(value, 'binary')
  throw new Error('expected Buffer or Uint8Array')
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function findEocd(buf) {
  const from = Math.max(0, buf.length - MAX_EOCD_SCAN)
  for (let pos = buf.length - EOCD_MIN_SIZE; pos >= from; pos--) {
    if (buf.readUInt32LE(pos) === SIG_EOCD) {
      const commentLen = buf.readUInt16LE(pos + 20)
      if (pos + EOCD_MIN_SIZE + commentLen <= buf.length) return pos
    }
  }
  return -1
}

function readZip64Eocd(buf, eocd) {
  const locatorPos = eocd - 20
  if (locatorPos < 0 || buf.readUInt32LE(locatorPos) !== SIG_EOCD64_LOCATOR) return null
  const zip64Pos = Number(buf.readBigUInt64LE(locatorPos + 8))
  if (!Number.isFinite(zip64Pos) || zip64Pos < 0 || zip64Pos + 56 > buf.length) return null
  if (buf.readUInt32LE(zip64Pos) !== SIG_EOCD64) return null
  return {
    count: buf.readBigUInt64LE(zip64Pos + 32),
    size: Number(buf.readBigUInt64LE(zip64Pos + 40)),
    offset: Number(buf.readBigUInt64LE(zip64Pos + 48)),
  }
}

function readCentralHeader(buf, pos) {
  const flag = buf.readUInt16LE(pos + 8)
  const method = buf.readUInt16LE(pos + 10)
  let compressedSize = buf.readUInt32LE(pos + 20)
  let size = buf.readUInt32LE(pos + 24)
  const nameLen = buf.readUInt16LE(pos + 28)
  const extraLen = buf.readUInt16LE(pos + 30)
  const commentLen = buf.readUInt16LE(pos + 32)
  let localOffset = buf.readUInt32LE(pos + 42)
  const nameStart = pos + 46
  const encoding = flag & FLAG_UTF8_NAME ? 'utf8' : 'latin1'
  const name = buf.toString(encoding, nameStart, nameStart + nameLen).replace(/\\/g, '/')
  const extraStart = nameStart + nameLen
  const header = {
    name,
    flag,
    method,
    size,
    compressedSize,
    localOffset,
    zip64Missing: false,
    next: extraStart + extraLen + commentLen,
  }
  if (size === U32_MAX || compressedSize === U32_MAX || localOffset === U32_MAX) {
    const zip64 = readZip64ExtraField(buf, extraStart, extraLen, header)
    if (!zip64) header.zip64Missing = true
  }
  return header
}

/** ZIP64 extended information extra field (tag 0x0001), fields in spec order. */
function readZip64ExtraField(buf, start, len, header) {
  let pos = start
  const end = Math.min(start + len, buf.length)
  while (pos + 4 <= end) {
    const tag = buf.readUInt16LE(pos)
    const fieldLen = buf.readUInt16LE(pos + 2)
    const body = pos + 4
    if (body + fieldLen > end) break
    if (tag === 0x0001) {
      let cursor = body
      if (header.size === U32_MAX) {
        if (cursor + 8 > end) return false
        header.size = Number(buf.readBigUInt64LE(cursor))
        cursor += 8
      }
      if (header.compressedSize === U32_MAX) {
        if (cursor + 8 > end) return false
        header.compressedSize = Number(buf.readBigUInt64LE(cursor))
        cursor += 8
      }
      if (header.localOffset === U32_MAX) {
        if (cursor + 8 > end) return false
        header.localOffset = Number(buf.readBigUInt64LE(cursor))
        cursor += 8
      }
      return true
    }
    pos = body + fieldLen
  }
  return false
}

function makeEntry(buf, info, maxEntryBytes) {
  const entry = {
    name: info.name,
    method: info.method,
    size: info.size,
    compressedSize: info.compressedSize,
    encrypted: Boolean(info.flag & FLAG_ENCRYPTED),
    directory: info.name.endsWith('/'),
    read: () => readEntryData(buf, info, maxEntryBytes),
  }
  return entry
}

function readEntryData(buf, info, maxEntryBytes) {
  if (info.encrypted) throw new Error(`压缩包条目已加密，无法读取正文：${info.name}`)
  if (info.size > maxEntryBytes) {
    throw new Error(`压缩包条目过大（${info.size} 字节 > ${maxEntryBytes}）：${info.name}`)
  }
  const dataStart = localDataStart(buf, info)
  if (dataStart < 0 || dataStart + Math.min(info.compressedSize, info.size) > buf.length) {
    throw new Error(`压缩包条目偏移无效：${info.name}`)
  }
  if (info.method === 0) {
    const bytes = info.size === 0 ? Buffer.alloc(0) : buf.subarray(dataStart, dataStart + info.size)
    return Buffer.from(bytes)
  }
  if (info.method === 8) {
    const packed = buf.subarray(dataStart, dataStart + info.compressedSize)
    return inflateRawSync(packed, { maxOutputLength: maxEntryBytes })
  }
  throw new Error(`不支持的 ZIP 压缩算法（method ${info.method}）：${info.name}`)
}

/** Local Header can carry different name/extra lengths than the Central Directory. */
function localDataStart(buf, info) {
  const pos = info.localOffset
  if (!Number.isFinite(pos) || pos < 0 || pos + 30 > buf.length) return -1
  if (buf.readUInt32LE(pos) !== SIG_LOCAL) return -1
  const nameLen = buf.readUInt16LE(pos + 26)
  const extraLen = buf.readUInt16LE(pos + 28)
  return pos + 30 + nameLen + extraLen
}
