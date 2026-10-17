/**
 * At-rest encryption for the knowledge base. Zero dependencies (node:crypto).
 *
 * Envelope model
 *  - A random 256-bit DATA KEY encrypts document bodies, index files and
 *    (optionally) the manifest. The data key lives in memory only.
 *  - The data key is wrapped with a KEK derived from the user's passphrase
 *    (scrypt, N=2^15 r=8 p=1) and stored in `secure/key.json`. AES-256-GCM on the
 *    wrapper authenticates the unwrap, so a wrong passphrase is detected before
 *    anything is decrypted — no separate password hash is stored.
 *  - Changing the passphrase re-wraps the SAME data key: the corpus is never
 *    re-encrypted, so rotating a password is cheap and safe.
 *
 * Envelope format
 *  - Document bodies keep their plaintext frontmatter and store
 *    `KBENC1:{...}` as the body, so a locked reader can tell the file is encrypted.
 *  - JSON files (index/<id>.json, kb.json) get an object envelope
 *    `{ "kbEncryption": 1, alg, iv, tag, aad, data }`.
 *
 * Every decryption failure throws a readable message; nothing here ever
 * downgrades silently to plaintext.
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { nowIso, sha256, writeFileAtomic } from './util.js'

const scrypt = promisify(scryptCb)

export const ENVELOPE_PREFIX = 'KBENC1:'
export const ALGORITHM = 'aes-256-gcm'
export const KDF_PARAMS = { N: 32768, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 }

export class LockedError extends Error {
  constructor(message = '知识库已加密锁定，请先解锁。') {
    super(message)
    this.name = 'LockedError'
    this.code = 'LOCKED'
  }
}

export class PassphraseError extends Error {
  constructor(message = '口令不正确，无法解锁知识库。') {
    super(message)
    this.name = 'PassphraseError'
    this.code = 'BAD_PASSPHRASE'
  }
}

function b64(buf) {
  return Buffer.from(buf).toString('base64')
}

function unb64(text) {
  return Buffer.from(String(text ?? ''), 'base64')
}

async function derive(passphrase, salt, params = KDF_PARAMS) {
  const key = await scrypt(Buffer.from(String(passphrase), 'utf8'), salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: params.maxmem,
  })
  return key
}

/** Encrypt one plaintext into the string envelope stored inside a doc body. */
function encryptToString(key, plaintext, aad) {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: 16 })
  if (aad) cipher.setAAD(Buffer.from(String(aad), 'utf8'))
  const data = Buffer.concat([cipher.update(Buffer.from(String(plaintext), 'utf8')), cipher.final()])
  return `${ENVELOPE_PREFIX}${JSON.stringify({ alg: ALGORITHM, iv: b64(iv), tag: b64(cipher.getAuthTag()), aad: aad ?? '', data: b64(data) })}`
}

function decryptFromString(key, text, expectedAad) {
  const raw = String(text ?? '')
  if (!raw.startsWith(ENVELOPE_PREFIX)) return raw
  let envelope
  try {
    envelope = JSON.parse(raw.slice(ENVELOPE_PREFIX.length))
  } catch {
    throw new Error('加密数据已损坏：无法解析信封。')
  }
  return decryptEnvelope(key, envelope, expectedAad)
}

function decryptEnvelope(key, envelope, expectedAad) {
  if (String(envelope?.alg ?? ALGORITHM) !== ALGORITHM) throw new Error(`不支持的加密算法：${envelope?.alg}`)
  const iv = unb64(envelope.iv)
  const tag = unb64(envelope.tag)
  const data = unb64(envelope.data)
  if (iv.length !== 12 || tag.length !== 16) throw new Error('加密数据已损坏：iv/tag 长度异常。')
  const aad = envelope.aad ?? ''
  if (expectedAad !== undefined && String(aad) !== String(expectedAad)) {
    throw new Error('加密数据校验失败：AAD 不匹配，文件可能被移动或篡改。')
  }
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: 16 })
  if (aad) decipher.setAAD(Buffer.from(String(aad), 'utf8'))
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  } catch {
    throw new PassphraseError()
  }
}

export function looksLikeEnvelopeText(text) {
  return String(text ?? '').startsWith(ENVELOPE_PREFIX)
}

export function looksLikeEnvelopeObject(value) {
  return Boolean(value) && typeof value === 'object' && (value.kbEncryption === 1 || (value.alg === ALGORITHM && typeof value.data === 'string'))
}

/**
 * The key ring owned by one store instance. It holds the unlocked data key in
 * memory and knows how to read/write `secure/key.json`.
 */
export class KeyRing {
  constructor({ rootDir, metadata = 'plain' } = {}) {
    this.rootDir = rootDir ?? null
    this.metadata = metadata === 'encrypted' ? 'encrypted' : 'plain'
    this.key = null
    this.meta = null
    this.unlockedAt = ''
    this.lastError = ''
  }

  get keyFile() {
    if (!this.rootDir) return null
    return join(this.rootDir, 'secure', 'key.json')
  }

  /** True when the corpus is configured for encryption (key file exists). */
  get configured() {
    return Boolean(this.meta)
  }

  get unlocked() {
    return Boolean(this.key)
  }

  /** Encryption is actually applied to new writes: configured and unlocked. */
  get active() {
    return Boolean(this.key && this.meta)
  }

  /** @returns {{enabled:boolean, unlocked:boolean, locked:boolean, metadata:string, fingerprint:string, createdAt:string, rotatedAt:string}} */
  status() {
    return {
      enabled: this.configured,
      unlocked: this.unlocked,
      locked: this.configured && !this.unlocked,
      metadata: this.meta?.metadata ?? 'plain',
      algorithm: ALGORITHM,
      kdf: `scrypt N=${KDF_PARAMS.N} r=${KDF_PARAMS.r} p=${KDF_PARAMS.p}`,
      fingerprint: this.meta?.fingerprint ?? '',
      createdAt: this.meta?.createdAt ?? '',
      rotatedAt: this.meta?.rotatedAt ?? '',
      updatedAt: this.meta?.updatedAt ?? '',
      lastError: this.lastError,
    }
  }

  /**
   * Read `secure/key.json` into memory. Never decrypts; call unlock() after.
   * @returns {Promise<boolean>} whether an encryption key file exists
   */
  async load() {
    this.meta = null
    this.key = null
    this.unlockedAt = ''
    if (!this.keyFile) return false
    let raw
    try {
      const text = await readFile(this.keyFile, 'utf8')
      raw = JSON.parse(text)
    } catch (error) {
      if (error && error.code === 'ENOENT') return false
      if (error instanceof SyntaxError) throw new Error(`加密配置文件已损坏：${this.keyFile}`)
      throw error
    }
    if (!raw || raw.version !== 1 || !raw.wrapped || !raw.kdf) throw new Error(`加密配置文件格式不正确：${this.keyFile}`)
    this.meta = raw
    this.metadata = raw.metadata === 'encrypted' ? 'encrypted' : 'plain'
    return true
  }

  /**
   * Enable encryption: generate a data key and write the wrapped key file.
   * Existing documents stay plaintext until the caller re-encrypts them
   * (KnowledgeStore.reencrypt()).
   */
  async enable(passphrase, { metadata = 'plain' } = {}) {
    if (!this.keyFile) throw new Error('启用加密前必须先配置知识库根目录。')
    if (this.meta) throw new Error('知识库已启用加密；如需修改口令请使用“更换口令”。')
    assertPassphraseShape(passphrase)
    const salt = randomBytes(16)
    const kek = await derive(passphrase, salt)
    const dataKey = randomBytes(32)
    const iv = randomBytes(12)
    const cipher = createCipheriv(ALGORITHM, kek, iv, { authTagLength: 16 })
    const wrappedData = Buffer.concat([cipher.update(dataKey), cipher.final()])
    this.meta = {
      version: 1,
      alg: ALGORITHM,
      kdf: { name: 'scrypt', ...pick(KDF_PARAMS, ['N', 'r', 'p']), salt: b64(salt) },
      wrapped: { iv: b64(iv), tag: b64(cipher.getAuthTag()), data: b64(wrappedData) },
      metadata: metadata === 'encrypted' ? 'encrypted' : 'plain',
      fingerprint: sha256(wrappedData).slice(0, 12),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      rotatedAt: '',
    }
    this.metadata = this.meta.metadata
    this.key = dataKey
    this.unlockedAt = nowIso()
    this.lastError = ''
    await writeJsonFile(this.keyFile, this.meta)
    zero(kek)
    return this.status()
  }

  async unlock(passphrase) {
    assertPassphraseShape(passphrase)
    if (!this.meta) throw new Error('知识库未启用加密，无需解锁。')
    const salt = unb64(this.meta.kdf.salt)
    const params = { ...KDF_PARAMS, N: Number(this.meta.kdf.N) || KDF_PARAMS.N, r: Number(this.meta.kdf.r) || KDF_PARAMS.r, p: Number(this.meta.kdf.p) || KDF_PARAMS.p }
    const kek = await derive(passphrase, salt, params)
    try {
      const decipher = createDecipheriv(ALGORITHM, kek, unb64(this.meta.wrapped.iv), { authTagLength: 16 })
      decipher.setAuthTag(unb64(this.meta.wrapped.tag))
      const dataKey = Buffer.concat([decipher.update(unb64(this.meta.wrapped.data)), decipher.final()])
      if (dataKey.length !== 32) throw new PassphraseError()
      this.key = dataKey
      this.unlockedAt = nowIso()
      this.lastError = ''
      zero(kek)
      return this.status()
    } catch (error) {
      zero(kek)
      if (error instanceof PassphraseError) {
        this.lastError = error.message
        throw error
      }
      const detail = error instanceof Error ? error.message : String(error)
      const reason = /authenticat|unable to authenticate|bad decrypt/i.test(detail)
        ? '口令不正确，或 key.json 与语料不匹配'
        : detail
      const wrapped = new PassphraseError(`解锁失败：${reason}`)
      this.lastError = wrapped.message
      throw wrapped
    }
  }

  lock() {
    if (this.key) zero(this.key)
    this.key = null
    this.unlockedAt = ''
    return this.status()
  }

  /** Re-wrap the data key under a new passphrase. No corpus rewrite needed. */
  async changePassphrase(currentPassphrase, nextPassphrase) {
    assertPassphraseShape(nextPassphrase)
    const wasUnlocked = Boolean(this.key)
    if (!wasUnlocked) await this.unlock(currentPassphrase)
    const dataKey = this.key
    if (!dataKey) throw new LockedError()
    const salt = randomBytes(16)
    const kek = await derive(nextPassphrase, salt)
    const iv = randomBytes(12)
    const cipher = createCipheriv(ALGORITHM, kek, iv, { authTagLength: 16 })
    const wrappedData = Buffer.concat([cipher.update(dataKey), cipher.final()])
    zero(kek)
    this.meta = {
      ...this.meta,
      kdf: { ...this.meta.kdf, salt: b64(salt), N: KDF_PARAMS.N, r: KDF_PARAMS.r, p: KDF_PARAMS.p },
      wrapped: { iv: b64(iv), tag: b64(cipher.getAuthTag()), data: b64(wrappedData) },
      fingerprint: sha256(wrappedData).slice(0, 12),
      updatedAt: nowIso(),
    }
    await writeJsonFile(this.keyFile, this.meta)
    return this.status()
  }

  /** Generate a fresh data key; the caller must re-encrypt every file. */
  async rotateKey(passphrase) {
    if (!this.meta) throw new Error('知识库未启用加密。')
    if (!this.key) await this.unlock(passphrase)
    const next = randomBytes(32)
    const old = this.key
    this.key = next
    const salt = unb64(this.meta.kdf.salt)
    const params = { ...KDF_PARAMS, N: Number(this.meta.kdf.N) || KDF_PARAMS.N, r: Number(this.meta.kdf.r) || KDF_PARAMS.r, p: Number(this.meta.kdf.p) || KDF_PARAMS.p }
    const kek = await derive(passphrase, salt, params)
    zero(old)
    zero(kek)
    this.meta = { ...this.meta, rotatedAt: nowIso(), updatedAt: nowIso() }
    await writeJsonFile(this.keyFile, this.meta)
    return this.status()
  }

  /** Choose whether titles/tags/manifest are also encrypted. */
  async setMetadataMode(mode, passphrase) {
    if (!this.meta) throw new Error('知识库未启用加密。')
    if (!this.key && passphrase) await this.unlock(passphrase)
    if (!this.key) throw new LockedError()
    this.metadata = mode === 'encrypted' ? 'encrypted' : 'plain'
    this.meta = { ...this.meta, metadata: this.metadata, updatedAt: nowIso() }
    await writeJsonFile(this.keyFile, this.meta)
    return this.status()
  }

  /** Drop the key file. The caller must decrypt the corpus first. */
  async removeKey() {
    if (this.keyFile) {
      try {
        await unlink(this.keyFile)
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error
      }
    }
    zero(this.key)
    this.key = null
    this.meta = null
    this.metadata = 'plain'
    this.unlockedAt = ''
    return this.status()
  }

  // ---- payload helpers used by KnowledgeStore ------------------------------

  wrapBody(plaintext, aad) {
    if (!this.active) return plaintext
    return encryptToString(this.key, plaintext, aad)
  }

  unwrapBody(text, aad) {
    const raw = String(text ?? '')
    if (!raw.startsWith(ENVELOPE_PREFIX)) return raw
    if (!this.key) throw new LockedError()
    return decryptFromString(this.key, raw, aad)
  }

  wrapJson(value, aad) {
    if (!this.active) return value
    const envelope = JSON.parse(encryptToString(this.key, JSON.stringify(value), aad).slice(ENVELOPE_PREFIX.length))
    return { kbEncryption: 1, ...envelope }
  }

  unwrapJson(value, aad) {
    if (!looksLikeEnvelopeObject(value)) return value
    if (!this.key) throw new LockedError()
    const text = `${ENVELOPE_PREFIX}${JSON.stringify(value)}`
    return JSON.parse(decryptFromString(this.key, text, aad))
  }

  /** Encrypt/decrypt an arbitrary string with the current data key. */
  encryptText(plaintext, aad = '') {
    if (!this.key) throw new LockedError()
    return encryptToString(this.key, plaintext, aad)
  }

  decryptText(envelopeText, aad = '') {
    if (!this.key) throw new LockedError()
    return decryptFromString(this.key, envelopeText, aad)
  }

  /** Keyed check used by the panel: does the current key still match a sample? */
  canDecryptSample(sample) {
    try {
      if (typeof sample === 'string') this.unwrapBody(sample)
      else this.unwrapJson(sample)
      return true
    } catch {
      return false
    }
  }
}

/**
 * Try to unlock from the environment (`DSH_KB_PASSPHRASE`) or a key file with a
 * stored wrapped key for automation (MCP/CLI). Returns status or null.
 */
export async function autoUnlock(ring, { env = process.env } = {}) {
  if (!ring.configured || ring.unlocked) return null
  const passphrase = env.DSH_KB_PASSPHRASE
  if (!passphrase) return null
  try {
    return await ring.unlock(passphrase)
  } catch (error) {
    ring.lastError = error instanceof Error ? error.message : String(error)
    return null
  }
}

/** Report how many stored files are encrypted, without decrypting them. */
export async function scanEncryption(rootDir, listFiles) {
  const found = { encryptedDocs: 0, plainDocs: 0, encryptedIndexes: 0, plainIndexes: 0, missing: 0 }
  for (const item of listFiles ?? []) {
    try {
      const info = await stat(join(rootDir, item.path))
      if (!info.isFile()) continue
      const text = await readFile(join(rootDir, item.path), 'utf8')
      if (item.kind === 'doc') {
        if (looksLikeEnvelopeText(text)) found.encryptedDocs++
        else found.plainDocs++
      } else if (item.kind === 'index') {
        if (text.includes('"kbEncryption":1') || text.includes('"kbEncryption": 1')) found.encryptedIndexes++
        else found.plainIndexes++
      }
    } catch {
      found.missing++
    }
  }
  return found
}

function pick(object, keys) {
  const out = {}
  for (const key of keys) out[key] = object[key]
  return out
}

async function writeJsonFile(file, value) {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
}

function zero(buffer) {
  if (Buffer.isBuffer(buffer)) buffer.fill(0)
}

export function assertPassphraseShape(passphrase) {
  const text = String(passphrase ?? '')
  if (text.length < 8) throw new Error('口令至少 8 个字符。')
  if (text.length > 512) throw new Error('口令过长（上限 512 字符）。')
  return true
}

/** Constant-time compare for token digests. */
export function safeEqualHex(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'hex')
  const bufB = Buffer.from(String(b ?? ''), 'hex')
  if (bufA.length !== bufB.length || bufA.length === 0) return false
  return timingSafeEqual(bufA, bufB)
}
