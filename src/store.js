/**
 * Markdown-first knowledge store.
 *
 * Layout (all under the configured root):
 *   kb.json                 manifest: collections + document metadata
 *   docs/<id>.md            canonical text, frontmatter + body (model-readable)
 *   files/<id>/<name>       original attachments (any binary)
 *   index/<id>.json         chunks, term frequencies, vectors
 *   index/stats.json        document-frequency statistics for BM25/IDF
 *   versions/<id>/*.md      previous revisions
 *   trash/<id>/             soft-deleted documents (restorable)
 *   inbox/                  drop folder watched by the plugin
 *   CATALOG.md              generated catalog for humans and models
 *   README.md               generated usage guide
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import {
  formatDocFile,
  newId,
  normalizeText,
  nowIso,
  parseDocFile,
  parseTags,
  readJson,
  safeFileName,
  settingsFilePath,
  sha256,
  toPosix,
  truncate,
  writeFileAtomic,
  writeJsonAtomic,
} from './util.js'
import { splitChunks } from './chunk.js'
import { decodeBuffer, decodeTextFile, guessTitle, htmlToText, isProbablyTextBuffer, walkTextFiles } from './extract.js'
import { canExtract, documentKindOf, extractDocumentText } from './extract_binary.js'
import { buildDocumentIndex, embedWithApi, emptyStats, statsFromJson, statsToJson } from './embedding.js'
import { bm25, cosine, hashVector, terms } from './tokenize.js'
import { resolveRoot, loadSettings, saveSettings } from './settings.js'
import { KeyRing, LockedError, autoUnlock, looksLikeEnvelopeObject, looksLikeEnvelopeText } from './crypto.js'
import { ACTION_FLOOR, Actor, ForbiddenError, ROLES, ROLE_RANK, UserDirectory } from './users.js'

const INDEX_VERSION = 1
/** Markers used to tell ciphertext apart from plaintext without a key. */
const ENVELOPE_MARK = 'KBENC1:'
const ENVELOPE_MARK_JSON = '"kbEncryption":'

function stripMarkdown(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/[*~`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

const VECTOR_CACHE = new Map()

function decodeVectorCached(base64) {
  const hit = VECTOR_CACHE.get(base64)
  if (hit) return hit
  try {
    const buf = Buffer.from(base64, 'base64')
    const vec = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4))
    if (VECTOR_CACHE.size > 20000) VECTOR_CACHE.clear()
    VECTOR_CACHE.set(base64, vec)
    return vec
  } catch {
    return new Float32Array(0)
  }
}

function makeSnippet(text, queryTerms, maxChars) {
  const source = String(text ?? '')
  if (source.length <= maxChars) return source
  const lower = source.toLowerCase()
  let at = -1
  for (const term of queryTerms) {
    if (term.length < 2) continue
    const found = lower.indexOf(term)
    if (found >= 0 && (at === -1 || found < at)) at = found
  }
  const start = at <= 0 ? 0 : Math.max(0, at - Math.floor(maxChars / 4))
  const slice = source.slice(start, start + maxChars)
  return `${start > 0 ? '…' : ''}${slice}${start + maxChars < source.length ? '…' : ''}`
}

export class KnowledgeStore {
  constructor(settings, ctx = null) {
    this.settings = settings
    this.ctx = ctx
    this._root = resolveRoot(settings)
    this.queue = Promise.resolve()
    this.indexCache = new Map()
    this.lastError = ''
    /** Bundle row config, so a settings rewrite keeps the patch precedence. */
    this.patchConfig = {}
    /** Set to true only by the decrypt-everything migration. */
    this.plainWrite = false
    /** @type {import('./crypto.js').KeyRing} holds the data key in memory only. */
    this.crypto = new KeyRing({ rootDir: this._root, metadata: settings?.security?.metadata })
    /** @type {import('./users.js').UserDirectory} */
    this.directory = new UserDirectory({ rootDir: this._root, settings })
    Object.defineProperty(this, 'root', {
      get: () => this._root,
      set: (value) => {
        if (this._root === value) return
        this._root = value
        this.crypto.rootDir = value
        this.directory.rootDir = value
        this.indexCache.clear()
      },
      enumerable: true,
      configurable: true,
    })
  }

  get configured() {
    return Boolean(this.root)
  }

  /** Encryption is configured for this corpus and the data key is not in memory. */
  get locked() {
    return this.crypto.configured && !this.crypto.unlocked
  }

  /** Re-point the security objects at the current root and re-read them. */
  async loadSecurity() {
    this.crypto.rootDir = this.root
    this.directory.rootDir = this.root
    this.directory.settings = this.settings
    const hasKey = await this.crypto.load()
    if (hasKey && !this.crypto.unlocked && this.settings?.security?.autoUnlockEnv !== false) {
      await autoUnlock(this.crypto)
    }
    await this.directory.load({ refresh: true })
    return { hasKey, unlocked: this.crypto.unlocked, locked: this.locked }
  }

  /** The identity used for permission checks when a caller supplies none. */
  actorFor(input = {}) {
    if (input instanceof Actor) return input
    if (input?.actor instanceof Actor) return input.actor
    if (input?.actor && typeof input.actor === 'object') return new Actor(input.actor)
    return this.directory.localActor()
  }

  /** Throw ForbiddenError when the actor may not run `action` here. */
  authorize(input = {}, action, collection) {
    this.directory.assert(this.actorFor(input), action, collection === undefined ? {} : { collection })
    return true
  }

  get settingsPath() {
    return settingsFilePath()
  }

  withLock(fn) {
    const run = this.queue.then(fn, fn)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  requireRoot() {
    if (!this.root) {
      throw new Error(
        '知识库根目录尚未配置。请在 Harness 的 设置 → 知识库 中选择目录，或调用 kb_manage {action:"configure", rootDir:"/path/to/knowledge"}。',
      )
    }
    return this.root
  }

  p(...parts) {
    return join(this.requireRoot(), ...parts)
  }

  async init() {
    if (!this.root) return
    await this.loadSecurity()
    if (this.locked) {
      // A locked corpus is nothing but envelopes. Rewriting the manifest or the
      // statistics from a half-parsed state would destroy data, so init stops
      // here until the knowledge base is unlocked.
      return
    }
    for (const dir of ['docs', 'files', 'index', 'versions', 'trash', 'inbox', 'exports', 'secure']) {
      await mkdir(this.p(dir), { recursive: true })
    }
    let manifest = await this.readManifestFile()
    if (!manifest || typeof manifest !== 'object') {
      manifest = {
        version: 1,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        collections: [{ name: this.settings.defaultCollection || 'default', description: '默认知识库', createdAt: nowIso() }],
        docs: [],
      }
      await this.writeManifestFile(manifest)
    }
    if (!Array.isArray(manifest.collections)) manifest.collections = []
    if (!Array.isArray(manifest.docs)) manifest.docs = []
    const defaultName = this.settings.defaultCollection || 'default'
    if (!manifest.collections.some((c) => c.name === defaultName)) {
      manifest.collections.push({ name: defaultName, description: '默认知识库', createdAt: nowIso() })
      await this.writeManifestFile(manifest)
    }
    if (!(await this.readStatsFile())) await this.writeStatsFile(emptyStats())
  }

  /** Metadata (titles/tags/summaries) is ciphertext only when the user asked. */
  get metadataEncrypted() {
    return this.crypto.active && this.crypto.metadata === 'encrypted'
  }

  wrapMetadata(value, aad) {
    if (this.plainWrite || !this.metadataEncrypted) return value
    return this.crypto.wrapJson(value, aad)
  }

  async readManifestFile() {
    const raw = await readJson(this.p('kb.json'), null)
    if (!raw) return raw
    return this.crypto.unwrapJson(raw, 'manifest')
  }

  async writeManifestFile(manifest) {
    await writeJsonAtomic(this.p('kb.json'), this.wrapMetadata(manifest, 'manifest'))
  }

  async readStatsFile() {
    const raw = await readJson(this.p('index', 'stats.json'), null)
    if (!raw) return raw
    // stats.json carries the term vocabulary, so it follows the body, not the
    // metadata, and is always ciphertext while encryption is active.
    return statsFromJson(this.crypto.unwrapJson(raw, 'index/stats'))
  }

  async writeStatsFile(stats) {
    await writeJsonAtomic(this.p('index', 'stats.json'), this.plainWrite ? statsToJson(stats) : this.crypto.wrapJson(statsToJson(stats), 'index/stats'))
  }

  /** Persist a patch into the global settings.json and adopt the result. */
  async saveSettingsPatch(patch) {
    const next = await saveSettings(patch, this.patchConfig ?? {})
    this.settings = next
    this.directory.settings = next
    return next
  }

  async reloadSettingsIntoStore() {
    const next = await loadSettings(this.patchConfig ?? {})
    this.settings = next
    this.directory.settings = next
    return next
  }

  async loadManifest() {
    this.requireRoot()
    let manifest = await this.readManifestFile()
    if (!manifest) {
      await this.init()
      manifest = await this.readManifestFile()
    }
    if (!manifest) throw new Error('knowledge base manifest is unreadable')
    if (!Array.isArray(manifest.docs)) manifest.docs = []
    if (!Array.isArray(manifest.collections)) manifest.collections = []
    return manifest
  }

  async saveManifest(manifest) {
    manifest.updatedAt = nowIso()
    await this.writeManifestFile(manifest)
  }

  async loadStats() {
    return (await this.readStatsFile()) ?? emptyStats()
  }

  async saveStats(stats) {
    await this.writeStatsFile(stats)
  }

  /** Apply (+1) or undo (-1) one document's chunk statistics. */
  applyStats(stats, index, sign) {
    for (const chunk of index?.chunks ?? []) {
      stats.total = Math.max(0, stats.total + sign)
      stats.totalTerms = Math.max(0, stats.totalTerms + (chunk.terms ?? 0) * sign)
      for (const term of Object.keys(chunk.tf ?? {})) {
        const next = (stats.df.get(term) ?? 0) + sign
        if (next <= 0) stats.df.delete(term)
        else stats.df.set(term, next)
      }
    }
    stats.avgdl = stats.total > 0 ? Math.max(1, stats.totalTerms / stats.total) : 1
    return stats
  }

  /** Recompute DF/avgdl from all index files (authoritative, slower). */
  async rebuildStats() {
    const stats = emptyStats()
    const manifest = await this.loadManifest()
    for (const doc of manifest.docs) {
      const index = await this.loadIndex(doc.id, { fresh: true })
      if (!index) continue
      this.applyStats(stats, index, 1)
    }
    await this.saveStats(stats)
    return stats
  }

  async loadIndex(id, { fresh = false } = {}) {
    const file = this.p('index', `${id}.json`)
    let info
    try {
      info = await stat(file)
    } catch {
      this.indexCache.delete(id)
      return null
    }
    const cached = this.indexCache.get(id)
    if (!fresh && cached && cached.mtimeMs === info.mtimeMs) return cached.data
    // Chunk text lives in the index, so it is decrypted along with the body.
    const data = this.crypto.unwrapJson(await readJson(file, null), `index/${id}`)
    if (!data) return null
    this.indexCache.set(id, { mtimeMs: info.mtimeMs, data })
    return data
  }

  async writeIndex(id, index) {
    await writeJsonAtomic(this.p('index', `${id}.json`), this.wrapIndexPayload(index, id))
    this.indexCache.delete(id)
  }

  wrapIndexPayload(index, id) {
    if (this.plainWrite) return index
    return this.crypto.wrapJson(index, `index/${id}`)
  }

  docFile(id) {
    return this.p('docs', `${id}.md`)
  }

  ensureCollection(manifest, name, description) {
    const clean = String(name ?? '').trim() || this.settings.defaultCollection || 'default'
    if (manifest.collections.some((c) => c.name === clean)) return clean
    manifest.collections.push({ name: clean, description: description ?? '', createdAt: nowIso() })
    return clean
  }

  /** Body → what goes on disk: a ciphertext envelope while encryption is active. */
  encodeBody(body, aad) {
    if (this.plainWrite) return body
    return this.crypto.wrapBody(body, aad)
  }

  decodeBody(stored, aad) {
    return this.crypto.unwrapBody(stored, aad)
  }

  isEncodedBody(stored) {
    return looksLikeEnvelopeText(stored)
  }

  isEncodedJson(value) {
    return looksLikeEnvelopeObject(value)
  }

  async writeDocFile(meta, body) {
    const content = formatDocFile(
      {
        id: meta.id,
        title: meta.title,
        collection: meta.collection,
        tags: meta.tags,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        source: meta.source,
      },
      this.encodeBody(body, meta.id),
    )
    await writeFileAtomic(this.docFile(meta.id), content)
  }

  async readDocBody(meta) {
    const text = await readFile(this.docFile(meta.id), 'utf8')
    return this.decodeBody(parseDocFile(text).body, meta.id)
  }

  async add(input = {}) {
    return this.withLock(async () => {
      await this.init()
      let body = normalizeText(input.text ?? '')
      let fileBuffer = null
      let fileName = ''
      let extractInfo = null
      let source = input.source ?? { type: 'text' }

      if (input.filePath) {
        const info = await stat(input.filePath).catch(() => null)
        if (!info || !info.isFile()) throw new Error(`file not found: ${input.filePath}`)
        if (info.size > this.settings.import.maxFileBytes) {
          throw new Error(`file is too large (${info.size} bytes > ${this.settings.import.maxFileBytes})`)
        }
        fileBuffer = await readFile(input.filePath)
        fileName = safeFileName(basename(input.filePath))
        if (body.trim() === '') {
          const extracted = await this.extractDocumentBody(input.filePath, fileName)
          if (extracted?.body) {
            body = extracted.body
            if (!input.title && extracted.title) input.title = extracted.title
            extractInfo = { kind: extracted.kind, pages: extracted.pages ?? 0, warnings: extracted.warnings ?? [] }
            source = { type: 'file', name: fileName }
          } else if (isProbablyTextBuffer(fileBuffer)) {
            body = normalizeText(decodeBuffer(fileBuffer))
            source = { type: 'file', name: fileName }
          } else {
            const why = extracted?.error ? `抽取失败：${extracted.error}。` : ''
            body = normalizeText(`# ${input.title || fileName}\n\n${why}（二进制文件，未提取正文。附件：${fileName}，${info.size} 字节。）`)
            source = { type: 'file', name: fileName }
            if (extracted) extractInfo = { kind: extracted.kind || '', pages: 0, warnings: extracted.warnings ?? [], failed: true, error: extracted.error ?? '' }
          }
        }
        if (!input.title) input.title = fileName.replace(/\.[^.]+$/, '')
      }

      if (body.trim() === '' && !fileBuffer) throw new Error('nothing to store: text or filePath is required')

      const title = String(input.title ?? '').trim() || guessTitle(body, 'Untitled')
      const manifest = await this.loadManifest()
      // Check permission against the requested collection before the manifest
      // is mutated, so a denied write leaves no new collection behind.
      const wanted = String(input.collection ?? '').trim() || this.settings.defaultCollection || 'default'
      const actor = this.actorFor(input)
      this.authorize(input, 'write', wanted)
      if (this.locked) throw new LockedError()
      const collection = this.ensureCollection(manifest, wanted)
      const tags = parseTags(input.tags)
      const hash = sha256(body)
      if (input.dedupe !== false) {
        const existing = manifest.docs.find((d) => d.collection === collection && d.hash === hash)
        if (existing) return { ...this.publicMeta(existing), deduped: true }
      }

      const id = newId('k')
      const createdAt = nowIso()
      const chunks = splitChunks(body, {
        chunkSize: this.settings.chunkSize,
        chunkOverlap: this.settings.chunkOverlap,
      })
      const stats = await this.loadStats()
      const index = await buildDocumentIndex({
        ctx: this.ctx,
        meta: { title },
        body,
        chunks,
        stats,
        settings: this.settings,
        mode: input.mode ?? this.settings.vectorMode,
        signal: input.signal,
      })
      const meta = {
        id,
        title,
        collection,
        tags,
        createdAt,
        updatedAt: createdAt,
        hash,
        chars: body.length,
        lines: body.split('\n').length,
        chunkCount: chunks.length,
        summary: index.enrichment?.summary || truncate(stripMarkdown(body), 180),
        keywords: index.enrichment?.keywords ?? [],
        vectorMode: index.mode,
        requestedMode: index.requestedMode,
        vectorStatus: index.status,
        vectorError: index.error ?? '',
        source,
        file: null,
        owner: actor.via === 'local' && !this.directory.enabled ? '' : actor.id,
        updatedBy: actor.via === 'local' && !this.directory.enabled ? '' : actor.id,
      }

      if (fileBuffer && input.keepFile !== false) {
        const dest = this.p('files', id, fileName)
        await mkdir(dirname(dest), { recursive: true })
        await writeFile(dest, fileBuffer)
        meta.file = { name: fileName, bytes: fileBuffer.length, path: toPosix(join('files', id, fileName)) }
      }
      if (extractInfo) meta.extract = extractInfo

      await this.writeDocFile(meta, body)
      await this.writeIndex(id, {
        version: INDEX_VERSION,
        docId: id,
        hash,
        mode: index.mode,
        requestedMode: index.requestedMode,
        dim: index.dim,
        status: index.status,
        error: index.error,
        enrichment: index.enrichment,
        updatedAt: createdAt,
        chunks: index.chunks,
      })
      this.applyStats(stats, index, 1)
      manifest.docs.push(meta)
      await this.saveStats(stats)
      await this.saveManifest(manifest)
      await this.generateCatalog()
      return { ...this.publicMeta(meta), deduped: false }
    })
  }

  async update(input = {}) {
    return this.withLock(async () => {
      const manifest = await this.loadManifest()
      const meta = this.findDoc(manifest, input.id)
      if (!meta) throw new Error(`document not found: ${input.id}`)
      const actor = this.actorFor(input)
      this.assertOwnership(actor, meta, 'update')
      if (this.locked) throw new LockedError()
      const targetCollection = input.collection === undefined ? meta.collection : String(input.collection).trim() || meta.collection
      this.authorize(input, 'write', targetCollection)
      if (targetCollection !== meta.collection) this.authorize(input, 'write', meta.collection)
      const oldBody = await this.readDocBody(meta)
      const nextBody = input.text === undefined ? oldBody : normalizeText(input.text)
      const contentChanged = nextBody !== oldBody
      const oldIndex = await this.loadIndex(meta.id)

      await mkdir(this.p('versions', meta.id), { recursive: true })
      const stamp = nowIso().replace(/[:.]/g, '-')
      await writeFileAtomic(this.p('versions', meta.id, `${stamp}.md`), formatDocFile(meta, this.encodeBody(oldBody, meta.id)))

      if (input.title !== undefined) meta.title = String(input.title).trim() || meta.title
      if (input.collection !== undefined) meta.collection = this.ensureCollection(manifest, input.collection)
      if (input.tags !== undefined) meta.tags = parseTags(input.tags)
      meta.updatedAt = nowIso()
      meta.version = (meta.version ?? 1) + 1
      if (this.directory.enabled) meta.updatedBy = actor.id

      if (contentChanged) {
        meta.hash = sha256(nextBody)
        meta.chars = nextBody.length
        meta.lines = nextBody.split('\n').length
        const chunks = splitChunks(nextBody, {
          chunkSize: this.settings.chunkSize,
          chunkOverlap: this.settings.chunkOverlap,
        })
        const stats = await this.loadStats()
        if (oldIndex) this.applyStats(stats, oldIndex, -1)
        const index = await buildDocumentIndex({
          ctx: this.ctx,
          meta,
          body: nextBody,
          chunks,
          stats,
          settings: this.settings,
          mode: input.mode ?? this.settings.vectorMode,
          signal: input.signal,
        })
        meta.chunkCount = chunks.length
        meta.summary = index.enrichment?.summary || truncate(stripMarkdown(nextBody), 180)
        meta.keywords = index.enrichment?.keywords ?? []
        meta.vectorMode = index.mode
        meta.requestedMode = index.requestedMode
        meta.vectorStatus = index.status
        meta.vectorError = index.error ?? ''
        await this.writeDocFile(meta, nextBody)
        await this.writeIndex(meta.id, {
          version: INDEX_VERSION,
          docId: meta.id,
          hash: meta.hash,
          mode: index.mode,
          requestedMode: index.requestedMode,
          dim: index.dim,
          status: index.status,
          error: index.error,
          enrichment: index.enrichment,
          updatedAt: meta.updatedAt,
          chunks: index.chunks,
        })
        this.applyStats(stats, index, 1)
        await this.saveStats(stats)
      } else {
        await this.writeDocFile(meta, nextBody)
      }

      await this.pruneVersions(meta.id)
      await this.saveManifest(manifest)
      await this.generateCatalog()
      return this.publicMeta(meta)
    })
  }

  async pruneVersions(id) {
    const dir = this.p('versions', id)
    const entries = await readdir(dir).catch(() => [])
    const files = entries.filter((name) => name.endsWith('.md')).sort()
    const keep = Math.max(0, Number(this.settings.versions.keep) || 0)
    for (const name of files.slice(0, Math.max(0, files.length - keep))) {
      await rm(join(dir, name), { force: true })
    }
  }

  /**
   * Move one document into the trash. The caller holds the lock and has already
   * checked permission; the manifest is updated but not saved.
   */
  async trashDoc(manifest, meta) {
    const stamp = nowIso().replace(/[:.]/g, '-')
    const trashDir = this.p('trash', meta.id)
    await mkdir(trashDir, { recursive: true })
    const body = await this.readDocBody(meta)
    await writeFile(join(trashDir, 'doc.md'), formatDocFile(meta, this.encodeBody(body, meta.id)), 'utf8')
    await writeJsonAtomic(join(trashDir, 'meta.json'), this.wrapMetadata({ ...meta, trashedAt: stamp }, `trash/${meta.id}`))
    const index = await this.loadIndex(meta.id)
    if (index) {
      await rename(this.p('index', `${meta.id}.json`), join(trashDir, 'index.json')).catch(() => {})
      const stats = await this.loadStats()
      this.applyStats(stats, index, -1)
      await this.saveStats(stats)
    }
    await rm(this.docFile(meta.id), { force: true })
    const filesDir = this.p('files', meta.id)
    if (await stat(filesDir).then((s) => s.isDirectory()).catch(() => false)) {
      await rename(filesDir, join(trashDir, 'files')).catch(() => {})
    }
    manifest.docs = manifest.docs.filter((d) => d.id !== meta.id)
    this.indexCache.delete(meta.id)
  }

  async remove(id, input = {}) {
    return this.withLock(async () => {
      const manifest = await this.loadManifest()
      const meta = this.findDoc(manifest, id)
      if (!meta) throw new Error(`document not found: ${id}`)
      const actor = this.actorFor(input)
      this.authorize(input, 'delete', meta.collection)
      this.assertOwnership(actor, meta, 'delete')
      if (this.locked) throw new LockedError()
      await this.trashDoc(manifest, meta)
      await this.saveManifest(manifest)
      await this.generateCatalog()
      return { id: meta.id, title: meta.title, trashed: true }
    })
  }

  async listTrash(input = {}) {
    this.authorize(input, 'read')
    const dir = this.p('trash')
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    const out = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const meta = this.crypto.unwrapJson(await readJson(join(dir, entry.name, 'meta.json'), null), `trash/${entry.name}`)
      if (meta) {
        out.push({ id: meta.id, title: meta.title, collection: meta.collection, tags: meta.tags ?? [], trashedAt: meta.trashedAt })
      }
    }
    return out.sort((a, b) => String(b.trashedAt).localeCompare(String(a.trashedAt)))
  }

  async restore(id, input = {}) {
    return this.withLock(async () => {
      const manifest = await this.loadManifest()
      if (manifest.docs.some((d) => d.id === id)) throw new Error(`document already exists: ${id}`)
      const trashDir = this.p('trash', id)
      const meta = this.crypto.unwrapJson(await readJson(join(trashDir, 'meta.json'), null), `trash/${id}`)
      if (!meta) throw new Error(`not found in trash: ${id}`)
      this.authorize(input, 'write', meta.collection)
      if (this.locked) throw new LockedError()
      const docText = await readFile(join(trashDir, 'doc.md'), 'utf8')
      const parsed = parseDocFile(docText)
      const restored = { ...meta, ...parsed.meta, updatedAt: nowIso() }
      await writeFileAtomic(this.docFile(restored.id), docText)
      await rename(join(trashDir, 'index.json'), this.p('index', `${restored.id}.json`)).catch(() => {})
      const filesDir = join(trashDir, 'files')
      if (await stat(filesDir).then((s) => s.isDirectory()).catch(() => false)) {
        await rename(filesDir, this.p('files', restored.id)).catch(() => {})
      }
      restored.collection = this.ensureCollection(manifest, restored.collection)
      manifest.docs.push(restored)
      const index = await this.loadIndex(restored.id, { fresh: true })
      if (index) {
        const stats = await this.loadStats()
        this.applyStats(stats, index, 1)
        await this.saveStats(stats)
      }
      await this.saveManifest(manifest)
      await rm(trashDir, { recursive: true, force: true }).catch(() => {})
      await this.generateCatalog()
      return this.publicMeta(restored)
    })
  }

  /** Delete one trash entry for real. Returns false when it is not present. */
  async purgeDoc(id) {
    const trashDir = this.p('trash', id)
    if (!(await stat(trashDir).catch(() => null))) return false
    await rm(trashDir, { recursive: true, force: true })
    await rm(this.p('versions', id), { recursive: true, force: true }).catch(() => {})
    await rm(this.p('files', id), { recursive: true, force: true }).catch(() => {})
    return true
  }

  async purge(id, input = {}) {
    this.authorize(input, 'delete')
    if (this.locked) throw new LockedError()
    return this.withLock(async () => {
      if (!(await this.purgeDoc(id))) throw new Error(`not found in trash: ${id}`)
      return { id, purged: true }
    })
  }

  /** Documents matched by an id list and/or a collection/tag/query filter. */
  matchDocs(manifest, { ids, collection, tag, query } = {}) {
    const set = Array.isArray(ids) && ids.length ? new Set(ids.map(String)) : null
    const needle = query ? String(query).toLowerCase() : ''
    return manifest.docs.filter((d) => {
      if (set && !set.has(String(d.id))) return false
      if (collection && d.collection !== collection) return false
      if (tag && !(d.tags ?? []).includes(tag)) return false
      if (needle && !`${d.title} ${d.summary ?? ''} ${(d.tags ?? []).join(' ')}`.toLowerCase().includes(needle)) return false
      return true
    })
  }

  /**
   * Soft-delete every matched document the actor is allowed to touch. Each item
   * goes through the same delete/collection/ownership checks as a single
   * delete, so an editor bulk-deleting a shared collection only removes their
   * own documents; the rest come back as explicit skips.
   */
  async bulkRemove(input = {}) {
    this.requireRoot()
    if (this.locked) throw new LockedError()
    const hasFilter = Boolean(input.ids?.length || input.collection || input.tag || input.query)
    if (!hasFilter) throw new Error('批量删除需要 ids / collection / tag / query 至少一个筛选条件')
    return this.withLock(async () => {
      const manifest = await this.loadManifest()
      const actor = this.actorFor(input)
      const targets = this.matchDocs(manifest, input)
      const skipped = []
      let trashed = 0
      for (const meta of targets) {
        try {
          this.authorize({ actor }, 'delete', meta.collection)
          this.assertOwnership(actor, meta, 'delete')
          await this.trashDoc(manifest, meta)
          trashed++
        } catch (error) {
          skipped.push({ id: meta.id, title: meta.title, reason: error instanceof Error ? error.message : String(error) })
        }
      }
      if (trashed > 0) {
        await this.saveManifest(manifest)
        await this.generateCatalog()
      }
      return { trashed, skipped, matched: targets.length }
    })
  }

  /** Purge the whole trash. Editors only purge their own trashed documents. */
  async emptyTrash(input = {}) {
    this.requireRoot()
    if (this.locked) throw new LockedError()
    this.authorize(input, 'delete')
    const actor = this.actorFor(input)
    return this.withLock(async () => {
      const dir = this.p('trash')
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      let removed = 0
      const skipped = []
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const id = entry.name
        const meta = this.crypto.unwrapJson(await readJson(join(dir, id, 'meta.json'), null), `trash/${id}`)
        if (this.directory.enabled && ROLE_RANK[actor.role] < ROLE_RANK.admin && meta?.owner && meta.owner !== actor.id) {
          skipped.push({ id, title: meta?.title ?? id, reason: '不属于你的回收站条目' })
          continue
        }
        if (await this.purgeDoc(id)) removed++
      }
      return { removed, skipped }
    })
  }

  /**
   * Irreversibly erase the whole corpus: documents, trash, index, versions,
   * attachments and exports. Owner-only, guarded by a typed confirmation, and
   * refused while locked. The root folder and settings survive unless
   * removeFolder is set, which also clears the configured root.
   */
  async wipe(input = {}) {
    this.requireRoot()
    if (this.locked) throw new LockedError()
    const actor = this.actorFor(input)
    this.authorize(input, 'security')
    if (String(input.confirm ?? '').trim().toUpperCase() !== 'WIPE') {
      throw new ForbiddenError('清空整个知识库需要输入确认词 WIPE。')
    }
    const rootBefore = this.root
    return this.withLock(async () => {
      const manifest = await this.loadManifest()
      const cleared = manifest.docs.length
      manifest.docs = []
      await this.saveManifest(manifest)
      for (const dir of ['docs', 'index', 'versions', 'files', 'trash', 'exports']) {
        await rm(this.p(dir), { recursive: true, force: true }).catch(() => {})
        await mkdir(this.p(dir), { recursive: true }).catch(() => {})
      }
      this.indexCache.clear()
      await this.saveStats(emptyStats())
      await this.generateCatalog()
      let folderRemoved = false
      if (input.removeFolder) {
        await rm(rootBefore, { recursive: true, force: true }).catch(() => {})
        await this.saveSettingsPatch({ rootDir: '' })
        this.root = ''
        folderRemoved = true
      }
      return { wiped: true, clearedDocs: cleared, removeFolder: folderRemoved, actor: actor.describe() }
    })
  }

  findDoc(manifest, ref) {
    const raw = String(ref ?? '').trim()
    if (raw === '') return undefined
    const byId = manifest.docs.find((d) => d.id === raw)
    if (byId) return byId
    const cleaned = raw.replace(/^docs[\\/]/, '').replace(/\.md$/i, '')
    const exact = manifest.docs.find((d) => d.id === cleaned)
    if (exact) return exact
    if (cleaned.length >= 4) {
      const matches = manifest.docs.filter((d) => d.id.startsWith(cleaned))
      if (matches.length === 1) return matches[0]
    }
    return undefined
  }

  publicMeta(meta) {
    const result = {
      id: meta.id,
      title: meta.title,
      collection: meta.collection,
      tags: meta.tags ?? [],
      chunkCount: meta.chunkCount ?? 0,
      chars: meta.chars ?? 0,
      summary: meta.summary ?? '',
      keywords: meta.keywords ?? [],
      vectorMode: meta.vectorMode ?? 'local',
      vectorStatus: meta.vectorStatus ?? 'ok',
      source: meta.source ?? { type: 'text' },
      file: meta.file ?? null,
      path: `docs/${meta.id}.md`,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      version: meta.version ?? 1,
    }
    if (meta.owner) result.owner = meta.owner
    if (meta.updatedBy) result.updatedBy = meta.updatedBy
    if (meta.vectorError) result.vectorError = meta.vectorError
    if (meta.extract) {
      result.extract = {
        kind: meta.extract.kind || '',
        pages: meta.extract.pages || 0,
        failed: Boolean(meta.extract.failed),
        ...(meta.extract.error ? { error: meta.extract.error } : {}),
        ...((meta.extract.warnings ?? []).length > 0 ? { warnings: (meta.extract.warnings ?? []).slice(0, 3) } : {}),
      }
    }
    return result
  }

  /**
   * Try to turn a PDF/Office file into indexable markdown text.
   * Returns null for non-document files; `{ body }` on success;
   * `{ error, kind }` when the format is recognised but unreadable.
   */
  async extractDocumentBody(path, name = basename(path)) {
    const kind = documentKindOf(name)
    if (!kind && !canExtract(name)) return null
    let result
    try {
      result = await extractDocumentText(path, { maxBytes: this.settings.import.maxFileBytes })
    } catch (error) {
      return { kind, error: error instanceof Error ? error.message : String(error), warnings: [] }
    }
    const warnings = result.warnings ?? []
    if (result.ok && String(result.text ?? '').trim() !== '') {
      const title = String(result.title ?? '').trim() || name.replace(/\.[^.]+$/, '')
      const head = `# ${title}\n\n> 抽取自 ${name}（${result.kind}${result.pages ? ` · ${result.pages} 页` : ''}）\n\n`
      return {
        kind: result.kind,
        title,
        pages: result.pages ?? 0,
        warnings,
        body: normalizeText(head + String(result.text).trim()),
      }
    }
    return { kind: result.kind || kind, title: '', pages: result.pages ?? 0, warnings, error: result.error ?? (warnings[0] ?? '未抽取到文本') }
  }

  async list(options = {}) {
    const actor = this.actorFor(options)
    const manifest = await this.loadManifest()
    const collection = options.collection ? String(options.collection) : ''
    const tag = options.tag ? String(options.tag) : ''
    const query = String(options.query ?? '').trim().toLowerCase()
    // With RBAC on, documents outside the actor's collections are invisible
    // rather than forbidden, so titles and summaries never leak into a listing.
    let docs = this.directory.filterDocs(actor, manifest.docs.slice())
    if (collection) docs = docs.filter((d) => d.collection === collection)
    if (tag) docs = docs.filter((d) => (d.tags ?? []).includes(tag))
    if (query) {
      docs = docs.filter(
        (d) =>
          String(d.title).toLowerCase().includes(query) ||
          String(d.summary).toLowerCase().includes(query) ||
          (d.tags ?? []).some((t) => String(t).toLowerCase().includes(query)),
      )
    }
    const sort = options.sort ?? 'updated'
    docs.sort((a, b) => {
      if (sort === 'title') return String(a.title).localeCompare(String(b.title))
      if (sort === 'created') return String(b.createdAt).localeCompare(String(a.createdAt))
      if (sort === 'chunks') return (b.chunkCount ?? 0) - (a.chunkCount ?? 0)
      return String(b.updatedAt).localeCompare(String(a.updatedAt))
    })
    const total = docs.length
    const offset = Math.max(0, Number(options.offset) || 0)
    const limit = Math.min(200, Math.max(1, Number(options.limit) || 50))
    return {
      total,
      offset,
      limit,
      collections: await this.collectionInfo(manifest, actor),
      docs: docs.slice(offset, offset + limit).map((d) => this.publicMeta(d)),
    }
  }

  async collectionInfo(manifest, actor = null) {
    let collections = (manifest.collections ?? []).map((collection) => ({
      name: collection.name,
      description: collection.description ?? '',
      createdAt: collection.createdAt,
      docs: manifest.docs.filter((d) => d.collection === collection.name).length,
    }))
    if (actor) collections = this.directory.filterCollections(actor, collections)
    return collections
  }

  async collections(input = {}) {
    return this.collectionInfo(await this.loadManifest(), this.actorFor(input))
  }

  async createCollection(name, description = '', input = {}) {
    return this.withLock(async () => {
      const clean = String(name ?? '').trim()
      if (clean === '') throw new Error('collection name must not be empty')
      this.authorize(input, 'manage', clean)
      const manifest = await this.loadManifest()
      this.ensureCollection(manifest, clean, description)
      await this.saveManifest(manifest)
      await this.generateCatalog()
      return { name: clean, description }
    })
  }

  async deleteCollection(name, { moveTo = '', actor } = {}) {
    return this.withLock(async () => {
      const manifest = await this.loadManifest()
      const clean = String(name ?? '').trim()
      this.authorize({ actor }, 'manage', clean)
      if (clean === (this.settings.defaultCollection || 'default')) throw new Error('cannot delete the default collection')
      const docs = manifest.docs.filter((d) => d.collection === clean)
      if (docs.length > 0 && moveTo === '') {
        throw new Error(`collection is not empty (${docs.length} documents); pass moveTo or delete them first`)
      }
      if (docs.length > 0) {
        const target = this.ensureCollection(manifest, moveTo)
        for (const doc of docs) {
          doc.collection = target
          const body = await this.readDocBody(doc).catch(() => null)
          if (body != null) await this.writeDocFile(doc, body)
        }
      }
      manifest.collections = manifest.collections.filter((c) => c.name !== clean)
      await this.saveManifest(manifest)
      await this.generateCatalog()
      return { name: clean, removed: true, moved: docs.length }
    })
  }

  async get(id) {
    const manifest = await this.loadManifest()
    const meta = this.findDoc(manifest, id)
    if (!meta) return null
    return { meta: this.publicMeta(meta), body: await this.readDocBody(meta) }
  }

  async read(input = {}) {
    const manifest = await this.loadManifest()
    const ref = input.id ?? input.path
    const meta = this.findDoc(manifest, ref)
    if (!meta) throw new Error(`document not found: ${ref ?? '(missing id)'}`)
    const reader = this.actorFor(input)
    this.directory.assert(reader, 'read', { collection: meta.collection })
    if (!this.directory.filterDocs(reader, [meta]).length) throw new Error(`document not found: ${ref}`)
    const body = await this.readDocBody(meta)
    if (input.chunk !== undefined && input.chunk !== null && input.chunk !== '') {
      const index = await this.loadIndex(meta.id)
      const chunk = index?.chunks?.[Number(input.chunk)]
      if (!chunk) throw new Error(`chunk not found: ${input.chunk}`)
      return {
        id: meta.id,
        title: meta.title,
        collection: meta.collection,
        tags: meta.tags ?? [],
        path: `docs/${meta.id}.md`,
        chunk: Number(input.chunk),
        heading: chunk.heading,
        lineStart: chunk.lineStart,
        lineEnd: chunk.lineEnd,
        totalLines: body.split('\n').length,
        content: chunk.text,
        offset: chunk.lineStart,
        file: meta.file ?? null,
      }
    }
    const lines = body.split('\n')
    const offset = Math.min(lines.length, Math.max(1, Number(input.offset) || 1))
    const limit = Math.min(4000, Math.max(1, Number(input.limit) || 400))
    return {
      id: meta.id,
      title: meta.title,
      collection: meta.collection,
      tags: meta.tags ?? [],
      path: `docs/${meta.id}.md`,
      offset,
      limit,
      totalLines: lines.length,
      content: lines.slice(offset - 1, offset - 1 + limit).join('\n'),
      summary: meta.summary ?? '',
      keywords: meta.keywords ?? [],
      vectorMode: meta.vectorMode,
      file: meta.file ?? null,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
    }
  }

  async search(input = {}) {
    const query = String(input.query ?? '').trim()
    if (query === '') throw new Error('query must not be empty')
    const manifest = await this.loadManifest()
    const stats = await this.loadStats()
    const limit = Math.min(50, Math.max(1, Number(input.limit) || this.settings.search.maxResults))
    const collection = input.collection ? String(input.collection) : ''
    const tagList = parseTags(input.tags)
    const metric = input.mode === 'lexical' || input.mode === 'vector' ? input.mode : 'hybrid'
    const queryTerms = terms(query)
    const lowered = query.toLowerCase()
    const localQueryVector = hashVector(queryTerms, this.settings.vectorDim, (term) => {
      const df = stats.df.get(term) ?? 0
      return Math.log((stats.total + 1) / (df + 0.5)) + 1
    })

    const docs = this.directory.filterDocs(this.actorFor(input), manifest.docs).filter((doc) => {
      if (collection && doc.collection !== collection) return false
      if (tagList.length > 0 && !tagList.every((t) => (doc.tags ?? []).includes(t))) return false
      return true
    })

    const loaded = []
    let apiDim = 0
    let hasApi = false
    for (const doc of docs) {
      const index = await this.loadIndex(doc.id)
      if (!index) continue
      loaded.push({ doc, index })
      if (index.mode === 'api' && index.dim > 0) {
        hasApi = true
        apiDim = index.dim
      }
    }

    let apiQueryVector = null
    let warning = ''
    if (hasApi && metric !== 'lexical') {
      try {
        const embedded = await embedWithApi([query], this.settings, input.signal)
        if (embedded.dim === apiDim) apiQueryVector = embedded.vectors[0]
      } catch (error) {
        warning = `查询向量生成失败，已退回本地向量：${errorText(error)}`
      }
    }

    const vw = this.settings.search.vectorWeight
    const lw = this.settings.search.lexicalWeight
    const hits = []
    for (const { doc, index } of loaded) {
      const docVector = index.mode === 'api' ? apiQueryVector : localQueryVector
      for (const chunk of index.chunks ?? []) {
        const tf = new Map(Object.entries(chunk.tf ?? {}))
        const lexicalRaw =
          metric === 'vector' ? 0 : bm25(tf, queryTerms, { df: stats.df, total: stats.total, avgdl: stats.avgdl, dl: chunk.terms ?? 0 })
        const lexical = lexicalRaw / (lexicalRaw + 6)
        let semantic = 0
        if (metric !== 'lexical' && chunk.vec && docVector) {
          const vec = decodeVectorCached(chunk.vec)
          if (vec.length === docVector.length) semantic = Math.max(0, cosine(vec, docVector))
        }
        let score = vw * semantic + lw * lexical
        if (chunk.heading && chunk.heading.toLowerCase().includes(lowered)) score += 0.12
        if (String(doc.title).toLowerCase().includes(lowered)) score += 0.1
        if (chunk.text.toLowerCase().includes(lowered)) score += 0.08
        if (score <= 0.0001) continue
        hits.push({ doc, chunk, score, semantic, lexical })
      }
    }
    hits.sort((a, b) => b.score - a.score)

    const perDoc = new Map()
    const results = []
    for (const hit of hits) {
      const count = perDoc.get(hit.doc.id) ?? 0
      if (count >= 2) continue
      perDoc.set(hit.doc.id, count + 1)
      results.push({
        docId: hit.doc.id,
        title: hit.doc.title,
        collection: hit.doc.collection,
        tags: hit.doc.tags ?? [],
        chunk: hit.chunk.i,
        heading: hit.chunk.heading,
        snippet: makeSnippet(hit.chunk.text, queryTerms, this.settings.search.snippetChars),
        score: Number(hit.score.toFixed(4)),
        semantic: Number(hit.semantic.toFixed(4)),
        lexical: Number(hit.lexical.toFixed(4)),
        path: `docs/${hit.doc.id}.md`,
        lineStart: hit.chunk.lineStart,
        lineEnd: hit.chunk.lineEnd,
        summary: hit.doc.summary ?? '',
      })
      if (results.length >= limit) break
    }
    const payload = {
      query,
      mode: metric,
      total: results.length,
      candidates: hits.length,
      scannedDocs: loaded.length,
      results,
    }
    if (warning) payload.warning = warning
    return payload
  }

  async reindex(input = {}) {
    this.authorize(input, 'manage')
    if (this.locked) throw new LockedError()
    this.requireRoot()
    const manifest = await this.loadManifest()
    const targets = input.ids?.length
      ? manifest.docs.filter((doc) => input.ids.some((ref) => this.findDoc(manifest, ref)?.id === doc.id))
      : manifest.docs
    const stats = input.full ? emptyStats() : await this.loadStats()
    const mode = input.mode ?? this.settings.vectorMode
    const result = []
    for (const doc of targets) {
      const body = await this.readDocBody(doc).catch(() => null)
      if (body == null) continue
      const oldIndex = await this.loadIndex(doc.id)
      if (oldIndex && !input.full) this.applyStats(stats, oldIndex, -1)
      const chunks = splitChunks(body, {
        chunkSize: this.settings.chunkSize,
        chunkOverlap: this.settings.chunkOverlap,
      })
      const index = await buildDocumentIndex({
        ctx: this.ctx,
        meta: doc,
        body,
        chunks,
        stats,
        settings: this.settings,
        mode,
        signal: input.signal,
      })
      doc.chunkCount = chunks.length
      doc.summary = index.enrichment?.summary || truncate(stripMarkdown(body), 180)
      doc.keywords = index.enrichment?.keywords ?? []
      doc.vectorMode = index.mode
      doc.requestedMode = index.requestedMode
      doc.vectorStatus = index.status
      doc.vectorError = index.error ?? ''
      doc.updatedAt = nowIso()
      await this.writeIndex(doc.id, {
        version: INDEX_VERSION,
        docId: doc.id,
        hash: doc.hash,
        mode: index.mode,
        requestedMode: index.requestedMode,
        dim: index.dim,
        status: index.status,
        error: index.error,
        enrichment: index.enrichment,
        updatedAt: doc.updatedAt,
        chunks: index.chunks,
      })
      this.applyStats(stats, index, 1)
      result.push({ id: doc.id, title: doc.title, status: index.status, chunks: chunks.length, mode: index.mode })
    }
    await this.saveManifest(manifest)
    if (input.full) await this.rebuildStats()
    else await this.saveStats(stats)
    await this.generateCatalog()
    return { reindexed: result.length, mode, docs: result }
  }

  /** Adopt externally written docs/*.md files and re-index externally edited ones. */
  async scanDocuments(input = {}) {
    this.authorize(input, 'manage')
    return this.withLock(async () => {
      const manifest = await this.loadManifest()
      const dir = this.p('docs')
      const files = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith('.md'))
      const seen = new Set()
      let added = 0
      let updated = 0
      const stats = await this.loadStats()
      for (const name of files) {
        const id = name.replace(/\.md$/, '')
        seen.add(id)
        const full = join(dir, name)
        if (!(await stat(full).catch(() => null))) continue
        const parsed = parseDocFile(await readFile(full, 'utf8'))
        const storedBody = parsed.body
        const body = normalizeText(this.decodeBody(storedBody, id))
        if (this.crypto.active && !this.isEncodedBody(storedBody)) {
          // Markdown dropped in from outside is encrypted on the next scan, so
          // the corpus keeps no plaintext copy while encryption is switched on.
          await writeFileAtomic(full, formatDocFile({ ...parsed.meta, id }, this.encodeBody(body, id)))
        }
        const hash = sha256(body)
        const existing = manifest.docs.find((d) => d.id === id)
        if (existing && existing.hash === hash) {
          if (parsed.meta.title && parsed.meta.title !== existing.title) {
            existing.title = parsed.meta.title
            updated++
          }
          continue
        }
        const meta = existing ?? {
          id,
          title: parsed.meta.title || guessTitle(body, id),
          collection: this.ensureCollection(manifest, parsed.meta.collection),
          tags: parseTags(parsed.meta.tags),
          createdAt: parsed.meta.createdAt || nowIso(),
          updatedAt: nowIso(),
          hash: '',
          version: 0,
        }
        if (existing) {
          const oldIndex = await this.loadIndex(id)
          if (oldIndex) this.applyStats(stats, oldIndex, -1)
          updated++
        } else {
          manifest.docs.push(meta)
          added++
        }
        const chunks = splitChunks(body, {
          chunkSize: this.settings.chunkSize,
          chunkOverlap: this.settings.chunkOverlap,
        })
        const index = await buildDocumentIndex({
          ctx: this.ctx,
          meta,
          body,
          chunks,
          stats,
          settings: this.settings,
          mode: this.settings.vectorMode,
        })
        meta.hash = hash
        meta.chars = body.length
        meta.lines = body.split('\n').length
        meta.chunkCount = chunks.length
        meta.summary = index.enrichment?.summary || truncate(stripMarkdown(body), 180)
        meta.keywords = index.enrichment?.keywords ?? []
        meta.vectorMode = index.mode
        meta.vectorStatus = index.status
        meta.vectorError = index.error ?? ''
        meta.updatedAt = nowIso()
        await this.writeIndex(id, {
          version: INDEX_VERSION,
          docId: id,
          hash,
          mode: index.mode,
          requestedMode: index.requestedMode,
          dim: index.dim,
          status: index.status,
          error: index.error,
          enrichment: index.enrichment,
          updatedAt: meta.updatedAt,
          chunks: index.chunks,
        })
        this.applyStats(stats, index, 1)
        updated++
      }
      const missing = manifest.docs.filter((d) => !seen.has(d.id))
      for (const doc of missing) {
        const oldIndex = await this.loadIndex(doc.id)
        if (oldIndex) this.applyStats(stats, oldIndex, -1)
        this.indexCache.delete(doc.id)
        await rm(this.p('index', `${doc.id}.json`), { force: true })
      }
      manifest.docs = manifest.docs.filter((d) => seen.has(d.id))
      await this.saveStats(stats)
      await this.saveManifest(manifest)
      await this.generateCatalog()
      return { added, updated, removed: missing.length, total: manifest.docs.length }
    })
  }

  async importDirectory(input = {}) {
    this.authorize(input, 'write')
    if (this.locked) throw new LockedError()
    const dirPath = String(input.path ?? '').trim()
    if (dirPath === '') throw new Error('path is required')
    const info = await stat(dirPath).catch(() => null)
    if (!info) throw new Error(`path not found: ${dirPath}`)
    const collection = String(input.collection ?? '').trim() || this.settings.defaultCollection
    const tags = parseTags(input.tags)
    const files = info.isDirectory()
      ? await walkTextFiles(dirPath, {
          recursive: input.recursive !== false,
          maxDocs: Math.min(5000, Number(input.maxDocs) || this.settings.import.maxDocsPerRun),
          maxFileBytes: this.settings.import.maxFileBytes,
          include: canExtract,
        })
      : [{ path: dirPath, name: basename(dirPath), size: info.size, document: canExtract(basename(dirPath)) }]
    const results = []
    for (const file of files) {
      try {
        const useAttachment = this.settings.import.copyFiles && file.size <= this.settings.import.maxFileBytes
        let body = ''
        if (!file.document) {
          body = normalizeText(await decodeTextFile(file.path, this.settings.import.maxFileBytes))
          if (body.trim() === '') {
            results.push({ path: file.path, skipped: 'empty or binary' })
            continue
          }
        }
        const rel = info.isDirectory() ? toPosix(relative(dirPath, file.path)) || file.name : file.name
        const result = await this.add({
          text: body,
          title: file.document
            ? input.useHeadingTitle !== false
              ? ''
              : file.name
            : input.useHeadingTitle !== false
              ? guessTitle(body, file.name)
              : file.name,
          collection,
          tags,
          source: { type: 'import', path: file.path, rel },
          filePath: file.path,
          keepFile: useAttachment,
          mode: input.mode,
          signal: input.signal,
        })
        results.push({ path: file.path, id: result.id, deduped: result.deduped, extracted: result.extract?.kind || (file.document ? 'failed' : 'text') })
      } catch (error) {
        results.push({ path: file.path, error: errorText(error) })
      }
      if (typeof input.onProgress === 'function') input.onProgress(results.length, files.length)
    }
    return {
      imported: results.filter((r) => r.id && !r.deduped).length,
      deduped: results.filter((r) => r.deduped).length,
      failed: results.filter((r) => r.error).length,
      total: files.length,
      results,
    }
  }

  async addUrl(input = {}) {
    this.authorize(input, 'write')
    if (this.locked) throw new LockedError()
    const url = String(input.url ?? '').trim()
    if (!/^https?:\/\//i.test(url)) throw new Error('url must be an http(s) URL')
    let title = String(input.title ?? '').trim()
    let text = ''
    const web = this.ctx?.get?.('web')
    if (web && typeof web.fetch === 'function') {
      const result = await web.fetch({ url }, input.signal)
      if (result.statusCode < 200 || result.statusCode >= 300) throw new Error(`fetch failed with HTTP ${result.statusCode}`)
      if (result.body.kind === 'html') {
        const converted = htmlToText(result.body.content)
        title = title || converted.title
        text = converted.text
      } else {
        text = result.body.content
      }
    } else {
      const response = await fetch(url, { signal: input.signal, headers: { 'user-agent': 'dsh-knowledge-base/1.0' } })
      if (!response.ok) throw new Error(`fetch failed with HTTP ${response.status}`)
      const contentType = response.headers.get('content-type') ?? ''
      const raw = await response.text()
      if (/html/i.test(contentType)) {
        const converted = htmlToText(raw)
        title = title || converted.title
        text = converted.text
      } else {
        text = raw
      }
    }
    if (text.trim() === '') throw new Error('page contained no extractable text')
    return this.add({
      text,
      title: title || url,
      collection: input.collection,
      tags: input.tags,
      source: { type: 'url', url },
      mode: input.mode,
      signal: input.signal,
    })
  }

  async exportAll(input = {}) {
    this.authorize(input, 'read')
    const format = input.format === 'jsonl' ? 'jsonl' : 'md'
    const manifest = await this.loadManifest()
    const visible = this.directory.filterDocs(this.actorFor(input), manifest.docs)
    const stamp = nowIso().replace(/[:.]/g, '-')
    const file = this.p('exports', `knowledge-${stamp}.${format === 'md' ? 'md' : 'jsonl'}`)
    const blocks = []
    for (const doc of visible) {
      const body = await this.readDocBody(doc).catch(() => '')
      if (format === 'jsonl') blocks.push(JSON.stringify({ meta: this.publicMeta(doc), body }))
      else blocks.push(`# ${doc.title}\n\n> id: ${doc.id} · collection: ${doc.collection} · tags: ${(doc.tags ?? []).join(', ')}\n\n${body}`)
    }
    await writeFileAtomic(file, blocks.join(format === 'jsonl' ? '\n' : '\n\n---\n\n'))
    return { path: toPosix(relative(this.requireRoot(), file)), bytes: (await stat(file)).size, docs: visible.length }
  }

  // ---- security: encryption, users, tokens -------------------------------

  /** Editors may only touch documents they created; admin and above may not be blocked. */
  assertOwnership(actor, meta, action) {
    if (!this.directory.enabled || !actor) return true
    if (ROLE_RANK[actor.role] >= ROLE_RANK.admin) return true
    if (action !== 'delete') return true
    if (!meta.owner || meta.owner === actor.id) return true
    throw new ForbiddenError(`该文档属于 ${this.directory.userName(meta.owner)}，editor 角色只能删除自己创建的文档。`)
  }

  /** How much of the corpus is currently ciphertext, without decrypting it. */
  async encryptionCoverage() {
    const out = { docs: { encrypted: 0, plain: 0 }, indexes: { encrypted: 0, plain: 0 }, versions: { encrypted: 0, plain: 0 }, manifest: 'plain' }
    const docDir = this.p('docs')
    for (const name of await readdir(docDir).catch(() => [])) {
      if (!name.endsWith('.md')) continue
      const text = await readFile(join(docDir, name), 'utf8').catch(() => '')
      if (text.includes(ENVELOPE_MARK)) out.docs.encrypted++
      else out.docs.plain++
    }
    const indexDir = this.p('index')
    for (const name of await readdir(indexDir).catch(() => [])) {
      if (!name.endsWith('.json')) continue
      const text = await readFile(join(indexDir, name), 'utf8').catch(() => '')
      if (text.includes(ENVELOPE_MARK_JSON)) out.indexes.encrypted++
      else out.indexes.plain++
    }
    const versionDir = this.p('versions')
    for (const id of await readdir(versionDir).catch(() => [])) {
      for (const name of await readdir(join(versionDir, id)).catch(() => [])) {
        const text = await readFile(join(versionDir, id, name), 'utf8').catch(() => '')
        if (text.includes(ENVELOPE_MARK)) out.versions.encrypted++
        else out.versions.plain++
      }
    }
    const raw = await readJson(this.p('kb.json'), null)
    out.manifest = this.isEncodedJson(raw) ? 'encrypted' : 'plain'
    return out
  }

  async securityStatus(input = {}) {
    this.requireRoot()
    await this.loadSecurity()
    return {
      encryption: this.crypto.status(),
      coverage: await this.encryptionCoverage(),
      access: this.directory.status(),
      whoami: this.actorFor(input).describe(),
      settingsPath: this.settingsPath,
    }
  }

  /** Create the data key, then rewrite the corpus as ciphertext. */
  async enableEncryption({ passphrase, metadata = 'plain', actor } = {}) {
    this.authorize({ actor }, 'security')
    this.requireRoot()
    if (this.crypto.configured) throw new Error('知识库已启用加密。如需更换口令请使用「更换口令」。')
    if (this.plainWrite) throw new Error('正在执行解密迁移，无法同时进行加密。')
    await mkdir(this.p('secure'), { recursive: true })
    await this.crypto.enable(passphrase, { metadata })
    const report = await this.applyEncryption({ target: 'encrypted', actor })
    await this.saveSettingsPatch({ security: { metadata: this.crypto.metadata } })
    return { encryption: this.crypto.status(), ...report }
  }

  /** Decrypt everything back to plain Markdown, then drop the key file. */
  async disableEncryption({ passphrase, actor } = {}) {
    this.authorize({ actor }, 'security')
    this.requireRoot()
    if (!this.crypto.configured) throw new Error('知识库当前未启用加密。')
    if (passphrase && !this.crypto.unlocked) await this.crypto.unlock(passphrase)
    if (!this.crypto.unlocked) throw new LockedError('关闭加密需要先用口令解锁。')
    const report = await this.applyEncryption({ target: 'plain', actor })
    const status = await this.crypto.removeKey()
    await this.generateCatalog().catch(() => {})
    return { encryption: status, ...report }
  }

  /**
   * Move every stored payload between plaintext and ciphertext. Idempotent:
   * files that already match the target are skipped, so an interrupted
   * migration can simply be re-run.
   */
  async applyEncryption({ target = 'encrypted', actor } = {}) {
    if (actor !== undefined) this.authorize({ actor }, 'security')
    this.requireRoot()
    const toEncrypt = target !== 'plain'
    if (toEncrypt && !this.crypto.active) throw new LockedError('需要先解锁或启用加密才能重新加密。')
    if (!toEncrypt && !this.crypto.unlocked) throw new LockedError('需要先解锁才能解密。')
    return this.withLock(async () => {
      const touched = { docs: 0, indexes: 0, versions: 0, trash: 0, skipped: 0 }
      const previousPlainWrite = this.plainWrite
      this.plainWrite = !toEncrypt
      try {
        const docDir = this.p('docs')
        for (const name of await readdir(docDir).catch(() => [])) {
          if (!name.endsWith('.md')) continue
          const id = name.replace(/\.md$/, '')
          const full = join(docDir, name)
          const parsed = parseDocFile(await readFile(full, 'utf8'))
          const encoded = this.isEncodedBody(parsed.body)
          if (toEncrypt === encoded) {
            touched.skipped++
            continue
          }
          const body = toEncrypt ? parsed.body : this.crypto.unwrapBody(parsed.body, id)
          await writeFileAtomic(full, formatDocFile({ ...parsed.meta, id }, toEncrypt ? this.crypto.wrapBody(body, id) : body))
          touched.docs++
        }
        const indexDir = this.p('index')
        for (const name of await readdir(indexDir).catch(() => [])) {
          if (!name.endsWith('.json')) continue
          const id = name.replace(/\.json$/, '')
          const aad = `index/${id}`
          const full = join(indexDir, name)
          const raw = await readJson(full, null)
          if (!raw) continue
          const encoded = this.isEncodedJson(raw)
          if (toEncrypt === encoded) {
            touched.skipped++
            continue
          }
          const value = toEncrypt ? raw : this.crypto.unwrapJson(raw, aad)
          await writeJsonAtomic(full, toEncrypt ? this.crypto.wrapJson(value, aad) : value)
          touched.indexes++
        }
        this.indexCache.clear()
        const versionDir = this.p('versions')
        for (const id of await readdir(versionDir).catch(() => [])) {
          const dir = join(versionDir, id)
          for (const name of await readdir(dir).catch(() => [])) {
            if (!name.endsWith('.md')) continue
            const full = join(dir, name)
            const parsed = parseDocFile(await readFile(full, 'utf8'))
            const encoded = this.isEncodedBody(parsed.body)
            if (toEncrypt === encoded) {
              touched.skipped++
              continue
            }
            const body = toEncrypt ? parsed.body : this.crypto.unwrapBody(parsed.body, id)
            await writeFileAtomic(full, formatDocFile({ ...parsed.meta, id }, toEncrypt ? this.crypto.wrapBody(body, id) : body))
            touched.versions++
          }
        }
        const trashRoot = this.p('trash')
        for (const id of await readdir(trashRoot).catch(() => [])) {
          const dir = join(trashRoot, id)
          const docPath = join(dir, 'doc.md')
          if (await stat(docPath).then((info) => info.isFile()).catch(() => false)) {
            const parsed = parseDocFile(await readFile(docPath, 'utf8'))
            const encoded = this.isEncodedBody(parsed.body)
            if (toEncrypt !== encoded) {
              const body = toEncrypt ? parsed.body : this.crypto.unwrapBody(parsed.body, id)
              await writeFileAtomic(docPath, formatDocFile({ ...parsed.meta, id }, toEncrypt ? this.crypto.wrapBody(body, id) : body))
              touched.trash++
            }
          }
          for (const [file, aadPrefix] of [
            ['meta.json', `trash/${id}`],
            ['index.json', `index/${id}`],
          ]) {
            const full = join(dir, file)
            const raw = await readJson(full, null)
            if (!raw || toEncrypt === this.isEncodedJson(raw)) continue
            const value = toEncrypt ? raw : this.crypto.unwrapJson(raw, aadPrefix)
            const wrapped = file === 'meta.json' ? this.wrapMetadata(value, aadPrefix) : this.crypto.wrapJson(value, aadPrefix)
            await writeJsonAtomic(full, toEncrypt ? wrapped : value)
          }
        }
        const manifest = await this.readManifestFile()
        if (manifest) await this.writeManifestFile(manifest)
        const stats = await this.loadStats()
        await this.writeStatsFile(stats)
        await this.generateCatalog().catch(() => {})
      } finally {
        this.plainWrite = previousPlainWrite
      }
      return { target: toEncrypt ? 'encrypted' : 'plain', touched, coverage: await this.encryptionCoverage() }
    })
  }

  async unlockKnowledgeBase({ passphrase } = {}) {
    const status = await this.crypto.unlock(passphrase)
    await this.generateCatalog().catch(() => {})
    return status
  }

  async lockKnowledgeBase(input = {}) {
    this.authorize(input, 'security')
    this.indexCache.clear()
    return this.crypto.lock()
  }

  /** Re-wrap the data key under a new passphrase. The corpus is untouched. */
  async changePassphrase({ current, next, actor } = {}) {
    this.authorize({ actor }, 'security')
    if (!this.crypto.configured) throw new Error('知识库当前未启用加密。')
    if (current) await this.crypto.unlock(current)
    if (!this.crypto.unlocked) throw new LockedError('更换口令前需要先用当前口令解锁。')
    return this.crypto.changePassphrase(current ?? '', next)
  }

  /** Generate a fresh data key and re-encrypt the whole corpus. */
  async rotateKey({ passphrase, actor } = {}) {
    this.authorize({ actor }, 'security')
    if (passphrase && !this.crypto.unlocked) await this.crypto.unlock(passphrase)
    if (!this.crypto.unlocked) throw new LockedError('轮换密钥需要先用口令解锁。')
    const status = await this.crypto.rotateKey(passphrase ?? '')
    const report = await this.applyEncryption({ target: 'encrypted' })
    return { encryption: status, ...report }
  }

  async setMetadataEncryption({ mode, passphrase, actor } = {}) {
    this.authorize({ actor }, 'security')
    const clean = mode === 'encrypted' ? 'encrypted' : 'plain'
    if (!this.crypto.configured) {
      await this.saveSettingsPatch({ security: { metadata: clean } })
      return { encryption: this.crypto.status(), note: '未启用加密时该设置只记录偏好。' }
    }
    if (passphrase && !this.crypto.unlocked) await this.crypto.unlock(passphrase)
    if (!this.crypto.unlocked) throw new LockedError('切换元数据加密需要先用口令解锁。')
    const status = await this.crypto.setMetadataMode(clean, passphrase)
    const report = await this.applyEncryption({ target: 'encrypted' })
    await this.saveSettingsPatch({ security: { metadata: clean } })
    return { encryption: status, ...report }
  }

  /** Switch RBAC on (seeding a local owner) or off. Users stay on disk. */
  async setRbac({ enabled, localRole, name } = {}) {
    const on = Boolean(enabled)
    if (on) {
      await mkdir(this.p('secure'), { recursive: true })
      await this.directory.bootstrap({ localRole: localRole ?? this.settings?.security?.rbac?.localRole ?? 'owner' })
    }
    await this.saveSettingsPatch({ security: { rbac: { enabled: on, localRole: localRole ?? 'owner' } } })
    await this.directory.load({ refresh: true })
    return this.directory.status()
  }

  async usersStatus(input = {}) {
    await this.directory.load({ refresh: true })
    return { ...this.directory.status(), whoami: this.actorFor(input).describe() }
  }

  /** One entry point for every user/token/grant operation, shared by UI + tools. */
  async manageUsers(input = {}) {
    const action = String(input.action ?? 'list')
    const directory = this.directory
    if (action === 'list' || action === 'token_list') {
      await directory.load({ refresh: true })
      return directory.status()
    }
    // Everything else is an owner-only security operation.
    this.authorize(input, 'security')
    await directory.load({ refresh: true })
    switch (action) {
      case 'enable':
        return this.setRbac({ enabled: true, localRole: input.localRole, name: input.name })
      case 'disable':
        return this.setRbac({ enabled: false })
      case 'add':
        return directory.createUser(input)
      case 'update':
        return directory.updateUser(input)
      case 'remove':
        return directory.removeUser(input)
      case 'passphrase':
        return directory.setUserPassphrase(input)
      case 'verify':
        return { actor: (await directory.verifyPassphrase(input)).describe() }
      case 'grant':
        return directory.grant(input)
      case 'revoke':
        return directory.revoke(input)
      case 'token_issue':
        return directory.issueToken(input)
      case 'token_revoke':
        return directory.revokeToken(input)
      default:
        throw new Error(`未知的用户操作：${action}`)
    }
  }

  async status(input = {}) {
    if (!this.root) {
      return {
        configured: false,
        settingsPath: this.settingsPath,
        vectorMode: this.settings.vectorMode,
        rootDir: '',
        message: '知识库根目录尚未配置',
      }
    }
    const manifest = await this.loadManifest()
    const stats = await this.loadStats()
    const actor = this.actorFor(input)
    const result = {
      configured: true,
      root: this.root,
      settingsPath: this.settingsPath,
      docs: this.directory.filterDocs(actor, manifest.docs).length,
      totalDocs: manifest.docs.length,
      chunks: stats.total,
      collections: await this.collectionInfo(manifest, actor),
      security: {
        encryption: this.crypto.status(),
        locked: this.locked,
        access: { enabled: this.directory.enabled, users: this.directory.status().users.length },
        actor: actor.describe(),
      },
      vectorMode: this.settings.vectorMode,
      dim: this.settings.vectorDim,
      chunkSize: this.settings.chunkSize,
      chunkOverlap: this.settings.chunkOverlap,
      defaultCollection: this.settings.defaultCollection,
      allowWrite: this.settings.tools?.allowWrite !== false,
      maxFileBytes: this.settings.import?.maxFileBytes ?? 0,
      copyFiles: this.settings.import?.copyFiles !== false,
      watch: {
        enabled: this.settings.watch.enabled !== false,
        dir: this.settings.watch.dir,
        debounceMs: this.settings.watch.debounceMs,
      },
      llm: { provider: this.settings.llm.provider || '', model: this.settings.llm.model || '' },
      embedding: {
        endpoint: this.settings.embedding.endpoint || '',
        model: this.settings.embedding.model || '',
        configured: Boolean(this.settings.embedding.endpoint && this.settings.embedding.model),
      },
      generatedAt: nowIso(),
    }
    if (this.lastError) result.lastError = this.lastError
    return result
  }

  async generateCatalog() {
    if (!this.root) return
    const manifest = await this.loadManifest()
    const stats = await this.loadStats()
    if (this.crypto.configured && this.crypto.metadata === 'encrypted') {
      // Titles, tags and summaries are ciphertext in this mode, so writing the
      // usual catalog would leak them next to the encrypted files.
      await writeFileAtomic(
        this.p('CATALOG.md'),
        [
          '# Knowledge Base Catalog',
          '',
          '> 本知识库启用了元数据加密：标题、标签与摘要都以密文存储，目录不再明文列出。',
          '> 解锁后请使用 Agent 工具 `kb_search` / `kb_read` / `kb_list`，或 `node kb.mjs search "关键词"`，或 MCP 客户端检索。',
          `> 根目录：${this.root}`,
          `> 更新时间：${nowIso()}`,
          `> 文档：${manifest.docs.length} 篇 · 分块：${stats.total} · 集合：${manifest.collections.length}`,
          '',
        ].join('\n'),
      )
      return
    }
    const lines = [
      '# Knowledge Base Catalog',
      '',
      '> 本文件由 dsh-knowledge-base 自动生成，供人或任何模型直接读取。',
      `> 根目录：${this.root}`,
      `> 更新时间：${nowIso()}`,
      `> 文档：${manifest.docs.length} · 分块：${stats.total} · 集合：${manifest.collections.length}`,
      '',
      '读取方式：直接打开 `docs/<id>.md`；或在插件包目录运行 `node kb.mjs read <id>`；或调用 Agent 工具 `kb_search` / `kb_read`。',
      '',
    ]
    for (const collection of manifest.collections) {
      const docs = manifest.docs
        .filter((d) => d.collection === collection.name)
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      if (docs.length === 0) continue
      lines.push(`## ${collection.name}${collection.description ? ` — ${collection.description}` : ''}`, '')
      lines.push('| 标题 | ID | 标签 | 分块 | 更新 | 摘要 |')
      lines.push('| --- | --- | --- | --- | --- | --- |')
      for (const doc of docs) {
        const title = String(doc.title).replace(/\|/g, '\\|')
        const summary = String(doc.summary ?? '').replace(/\|/g, '\\|').slice(0, 120)
        const tags = (doc.tags ?? []).join(', ').replace(/\|/g, '\\|')
        lines.push(
          `| [${title}](docs/${doc.id}.md) | ${doc.id} | ${tags} | ${doc.chunkCount ?? 0} | ${String(doc.updatedAt).slice(0, 10)} | ${summary} |`,
        )
      }
      lines.push('')
    }
    await writeFileAtomic(this.p('CATALOG.md'), `${lines.join('\n')}\n`)
    const readme = this.p('README.md')
    if (!(await stat(readme).catch(() => null))) await writeFileAtomic(readme, README_TEMPLATE)
    if (typeof this.onChange === 'function') {
      try {
        this.onChange()
      } catch {
        /* ignore */
      }
    }
  }
}

const README_TEMPLATE = `# Local Knowledge Base

这个目录是一个由 **dsh-knowledge-base** 维护的本地知识库。它刻意保持“文件即数据”：

- \`docs/<id>.md\` —— 每篇文档的正文（Markdown，带 YAML frontmatter）。
- \`files/<id>/\` —— 文档的原始附件（任意二进制文件）。
- \`index/<id>.json\` —— 分块、词频与向量；删除后可用 \`reindex\` 重建。
- \`kb.json\` —— 集合与文档元数据（由插件维护，请勿手工编辑）。
- \`CATALOG.md\` —— 全部文档的目录与摘要，适合直接投喂给模型。
- \`inbox/\` —— 丢进这里的文本文件会被自动入库。
- \`trash/<id>/\` —— 软删除的文档，可恢复。
- \`versions/<id>/\` —— 历史版本。

## 让任何模型读取

1. **直接读文件**：先读 \`CATALOG.md\`，再读 \`docs/<id>.md\`。无需任何插件。
2. **命令行**（任意能执行 shell 的模型，在插件包目录运行）：
   \`\`\`
   node kb.mjs status
   node kb.mjs search "关键词" --limit 5
   node kb.mjs read <id> --offset 1 --limit 100
   node kb.mjs add --title "标题" --text "正文" --tags a,b
   node kb.mjs import D:\\Notes
   \`\`\`
   用 \`--json\` 获取机器可读输出，用 \`--root D:\\KB\` 临时指定根目录。
3. **Harness 工具**：\`kb_search\`、\`kb_read\`、\`kb_list\`、\`kb_add\`、\`kb_import\`、\`kb_manage\`。

## 检索说明

默认是混合检索：BM25 词法分 + 向量余弦分。向量由 \`vectorMode\` 决定：

- \`local\`：本地 TF-IDF 特征哈希，离线、零依赖；
- \`llm\`：先让对话模型生成摘要/关键词/问题，再对增强文本做同样的本地向量；
- \`api\`：OpenAI 兼容的 \`/embeddings\` 接口，质量最好，需要 endpoint 与模型名。

切换模式后请运行一次重建索引（\`kb_manage {action:"reindex", full:true}\` 或 \`node kb.mjs reindex\`）。
`
