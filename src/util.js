/**
 * Small dependency-free helpers shared by the Host plugin, the CLI and tests.
 * Only node: builtins are used so the bundle needs no install-time deps.
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

export function nowIso() {
  return new Date().toISOString()
}

export function newId(prefix = 'd') {
  const t = Date.now().toString(36)
  const r = randomBytes(3).toString('hex')
  return `${prefix}${t}${r}`
}

export function sha256(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/** FNV-1a 32-bit. Deterministic across processes; used for feature hashing. */
export function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

export function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

export function truncate(text, max) {
  const s = String(text ?? '')
  if (s.length <= max) return s
  return `${s.slice(0, Math.max(0, max - 1))}…`
}

export function parseTags(input) {
  if (input == null) return []
  if (Array.isArray(input)) {
    return dedupe(input.map((t) => String(t).trim()).filter(Boolean))
  }
  return dedupe(
    String(input)
      .split(/[,，、;；\n]/)
      .map((t) => t.trim())
      .filter(Boolean),
  )
}

export function dedupe(list) {
  return [...new Set(list)]
}

export function normalizeText(input) {
  return String(input ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
}

export function safeFileName(name, fallback = 'file') {
  const base = String(name ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\.+$/, '')
    .trim()
  const out = base.slice(0, 120)
  return out.length > 0 ? out : fallback
}

export function toPosix(p) {
  return String(p).split(sep).join('/')
}

export function isInside(root, target) {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Resolve a user-supplied path below root. Throws when the path escapes root.
 * `allowAbsolute` maps absolute paths (used by import sources) instead of
 * rejecting them.
 */
export function resolveInside(root, input, { allowAbsolute = false } = {}) {
  const raw = String(input ?? '').trim()
  if (raw === '') throw new Error('path must not be empty')
  const target = allowAbsolute && isAbsolute(raw) ? resolve(raw) : resolve(root, raw)
  if (!isInside(root, target)) throw new Error(`path escapes the knowledge base root: ${raw}`)
  return target
}

export function defaultDshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function settingsFilePath() {
  return join(defaultDshHome(), 'knowledge-base', 'settings.json')
}

export async function readJson(file, fallback) {
  try {
    const text = await readFile(file, 'utf8')
    if (text.trim() === '') return fallback
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/** Atomic write: temp file in the same directory, then rename with a few retries. */
export async function writeFileAtomic(file, data) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  await writeFile(tmp, data, 'utf8')
  let lastError
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rename(tmp, file)
      return
    } catch (error) {
      lastError = error
      await sleep(30 * (attempt + 1))
    }
  }
  try {
    await unlink(tmp)
  } catch {
    /* ignore */
  }
  throw lastError
}

export async function writeJsonAtomic(file, value) {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
}

export function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

export function encodeVector(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString('base64')
}

export function decodeVector(base64) {
  const buf = Buffer.from(base64, 'base64')
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4))
}

/** Very small frontmatter writer/reader: one `key: <JSON>` per line, body after. */
export function formatDocFile(meta, body) {
  const lines = ['---']
  for (const key of ['id', 'title', 'collection', 'tags', 'createdAt', 'updatedAt', 'source']) {
    if (meta[key] === undefined) continue
    lines.push(`${key}: ${JSON.stringify(meta[key])}`)
  }
  lines.push('---', '')
  return `${lines.join('\n')}${body.replace(/^\n+/, '')}\n`
}

export function parseDocFile(text) {
  const normalized = normalizeText(text)
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized)
  if (!match) return { meta: {}, body: normalized.replace(/\n$/, '') }
  const meta = {}
  for (const line of match[1].split('\n')) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    const raw = line.slice(at + 1).trim()
    try {
      meta[key] = JSON.parse(raw)
    } catch {
      meta[key] = raw
    }
  }
  return { meta, body: normalized.slice(match[0].length).replace(/\n$/, '') }
}

export function humanBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = Number(n) || 0
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}
