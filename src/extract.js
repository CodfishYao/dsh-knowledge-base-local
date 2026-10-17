/** Plain-text extraction for files and web pages. No native parsers, no deps. */
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join, relative } from 'node:path'
import { normalizeText, safeFileName, toPosix } from './util.js'

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.mdx', '.rst', '.adoc', '.org', '.tex',
  '.json', '.jsonl', '.ndjson', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env',
  '.csv', '.tsv', '.log', '.xml', '.html', '.htm', '.xhtml', '.svg',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.scala', '.c', '.h', '.cpp', '.hpp', '.cc',
  '.cs', '.php', '.swift', '.lua', '.pl', '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.bat', '.cmd',
  '.sql', '.graphql', '.gql', '.proto', '.dockerfile', '.gitignore', '.editorconfig',
  '.css', '.scss', '.sass', '.less', '.styl', '.tex', '.bib', '.r', '.m', '.mm',
])

const BINARY_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.rar', '.7z', '.tar', '.gz',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tif', '.tiff', '.psd', '.ai',
  '.mp3', '.mp4', '.wav', '.flac', '.ogg', '.webm', '.avi', '.mov', '.mkv',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.db', '.sqlite', '.woff', '.woff2', '.ttf', '.otf',
])

const SKIP_DIRS = new Set([
  '.git', '.svn', '.hg', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build',
  '.next', '.nuxt', '.cache', 'target', 'bin', 'obj', '.idea', '.vscode',
])

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®',
  hellip: '…', mdash: '—', ndash: '–', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
}

export function extensionOf(name) {
  const ext = extname(name).toLowerCase()
  if (ext) return ext
  const base = basename(name).toLowerCase()
  if (base === 'dockerfile' || base === 'makefile' || base === 'readme') return `.${base}`
  return ''
}

export async function decodeTextFile(path, maxBytes = 16 * 1024 * 1024) {
  const info = await stat(path)
  if (info.size > maxBytes) {
    throw new Error(`file is too large (${info.size} bytes > ${maxBytes}): ${path}`)
  }
  const buf = await readFile(path)
  return decodeBuffer(buf)
}

export function decodeBuffer(buf) {
  if (buf.length === 0) return ''
  if (buf.subarray(0, Math.min(8192, buf.length)).includes(0)) return ''
  // Prefer strict UTF-8, then GB18030 (common on Chinese Windows), then lossy UTF-8.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    /* fall through */
  }
  try {
    const gb = new TextDecoder('gb18030').decode(buf)
    if (!gb.includes('\uFFFD')) return gb
  } catch {
    /* fall through */
  }
  return new TextDecoder('utf-8').decode(buf)
}

export function isProbablyTextBuffer(buf) {
  if (buf.length === 0) return true
  if (buf.subarray(0, Math.min(8192, buf.length)).includes(0)) return false
  const decoded = decodeBuffer(buf)
  if (decoded === '') return false
  let bad = 0
  for (const char of decoded.slice(0, 8000)) {
    const code = char.codePointAt(0)
    if (code === 0xfffd) bad++
    else if (code < 9 || (code > 13 && code < 32)) bad++
  }
  return bad / Math.min(decoded.length, 8000) < 0.05
}

export function looksTextual(fileName) {
  const ext = extensionOf(fileName)
  if (BINARY_EXTENSIONS.has(ext)) return false
  if (TEXT_EXTENSIONS.has(ext)) return true
  return ext === ''
}

export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, entity) => {
    const key = entity.toLowerCase()
    if (key.startsWith('#x')) {
      const code = Number.parseInt(key.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    if (key.startsWith('#')) {
      const code = Number.parseInt(key.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[key] ?? whole
  })
}

/** Turn an HTML document into readable Markdown-ish text. */
export function htmlToText(html) {
  let source = String(html ?? '')
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(source)
  const ogTitle = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(source)
  const title = decodeEntities((titleMatch?.[1] ?? ogTitle?.[1] ?? '').trim()).replace(/\s+/g, ' ')
  source = source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|canvas|iframe|nav|footer|header|form)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|table|ul|ol|dl|dt|dd)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<h([1-6])[^>]*>/gi, (_m, level) => `${'#'.repeat(Number(level))} `)
    .replace(/<[^>]+>/g, '')
  source = decodeEntities(source)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title, text: source }
}

export function guessTitle(text, fallback) {
  const heading = /^#{1,6}[ \t]+(.+)$/m.exec(text)
  if (heading) return heading[1].trim().slice(0, 160)
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0)
  if (line) return line.replace(/^#+\s*/, '').slice(0, 160)
  return String(fallback ?? 'Untitled').slice(0, 160)
}

/**
 * Walk a directory and return textual files.
 * @returns {Promise<Array<{path:string, name:string, size:number, rel:string}>>}
 */
export async function walkTextFiles(dir, options = {}) {
  const recursive = options.recursive !== false
  const maxDocs = Math.max(1, Number(options.maxDocs) || 500)
  const maxBytes = Number(options.maxFileBytes) || 8 * 1024 * 1024
  const out = []
  const queue = [dir]
  while (queue.length > 0 && out.length < maxDocs) {
    const current = queue.shift()
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (out.length >= maxDocs) break
      if (entry.name.startsWith('.') && entry.name !== '.env') continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (recursive && !SKIP_DIRS.has(entry.name.toLowerCase())) queue.push(full)
        continue
      }
      if (!entry.isFile()) continue
      // `include` lets callers admit non-text files (PDF/Office) that a later
      // stage can extract; they skip the text sniffing below.
      const admitted = typeof options.include === 'function' ? Boolean(options.include(entry.name)) : false
      if (!admitted && !looksTextual(entry.name)) continue
      let info
      try {
        info = await stat(full)
      } catch {
        continue
      }
      if (info.size > maxBytes || info.size === 0) continue
      if (!admitted && extensionOf(entry.name) === '') {
        // Unknown extension: peek at the first bytes before importing.
        try {
          const handle = await open(full, 'r')
          const buffer = Buffer.alloc(Math.min(4096, info.size))
          await handle.read(buffer, 0, buffer.length, 0)
          await handle.close()
          if (!isProbablyTextBuffer(buffer)) continue
        } catch {
          continue
        }
      }
      out.push({ path: full, name: entry.name, size: info.size, rel: toPosix(relative(dir, full)), document: admitted })
    }
  }
  return out
}

export { safeFileName }
