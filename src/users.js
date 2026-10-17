/**
 * Multi-user directory for the knowledge base: users, roles, per-collection
 * grants and API tokens for external (MCP / HTTP) clients.
 *
 * Stored in `<root>/secure/users.json`. User passphrases are stored as scrypt
 * verifiers with a per-user salt; API tokens are stored as SHA-256 digests and
 * the plaintext secret is returned once at creation time only.
 *
 * RBAC is OFF by default (`settings.security.rbac.enabled`): every check then
 * short-circuits to allowed, so behaviour is byte-for-byte the single-user
 * plugin it was. Turning it on is an explicit, reversible choice.
 */
import { createHash, randomBytes, scrypt as scryptCb } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { assertPassphraseShape, safeEqualHex } from './crypto.js'
import { newId, nowIso, safeFileName, writeJsonAtomic } from './util.js'

const scryptAsync = promisify(scryptCb)

export const ROLES = ['owner', 'admin', 'editor', 'reader']
export const ROLE_RANK = { owner: 4, admin: 3, editor: 2, reader: 1 }

/** Action → minimum role. Collection scoping is a separate check. */
export const ACTION_FLOOR = {
  read: 'reader',
  search: 'reader',
  list: 'reader',
  write: 'editor',
  delete: 'editor',
  manage: 'admin',
  security: 'owner',
}

const USER_KDF = { N: 16384, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 }

export class ForbiddenError extends Error {
  constructor(message = '当前身份没有该操作的权限。') {
    super(message)
    this.name = 'ForbiddenError'
    this.code = 'FORBIDDEN'
  }
}

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function normalizeRole(role, fallback = 'reader') {
  const value = String(role ?? '')
    .trim()
    .toLowerCase()
  return ROLES.includes(value) ? value : fallback
}

function normalizeScopes(scopes) {
  const list = Array.isArray(scopes) ? scopes : String(scopes ?? '').split(/[,，\s]+/)
  const allowed = new Set(['read', 'write', 'manage', 'security', 'all'])
  const out = list.map((item) => String(item).trim().toLowerCase()).filter((item) => allowed.has(item))
  return out.length > 0 ? [...new Set(out)] : ['read']
}

async function makeVerifier(passphrase, saltBase64) {
  const salt = saltBase64 ? Buffer.from(String(saltBase64), 'base64') : randomBytes(16)
  const key = await scryptAsync(Buffer.from(String(passphrase ?? ''), 'utf8'), salt, USER_KDF.keylen, {
    N: USER_KDF.N,
    r: USER_KDF.r,
    p: USER_KDF.p,
    maxmem: USER_KDF.maxmem,
  })
  return { kdf: 'scrypt', N: USER_KDF.N, r: USER_KDF.r, p: USER_KDF.p, salt: salt.toString('base64'), hash: key.toString('hex') }
}

/**
 * An actor is the local Harness identity (Web panel + agent tools), or a remote
 * caller that authenticated with a passphrase or an API token.
 */
export class Actor {
  constructor({ id = '', name = '未认证', role = 'reader', via = 'none', scopes = [], collectionRole = {} } = {}) {
    this.id = id
    this.name = name
    this.role = normalizeRole(role, 'reader')
    this.via = via
    this.scopes = scopes
    this.collectionRole = collectionRole
  }

  get rank() {
    return ROLE_RANK[this.role] ?? 0
  }

  get anonymous() {
    return !this.id
  }

  describe() {
    return { id: this.id, name: this.name, role: this.role, via: this.via, scopes: this.scopes }
  }
}

export const ANONYMOUS = new Actor()

export class UserDirectory {
  constructor({ rootDir = null, settings = null } = {}) {
    this.rootDir = rootDir
    this.settings = settings
    this.data = null
    this.loaded = false
  }

  get file() {
    return this.rootDir ? join(this.rootDir, 'secure', 'users.json') : null
  }

  get rbacEnabled() {
    return Boolean(this.settings?.security?.rbac?.enabled)
  }

  /** RBAC only bites once it is enabled *and* a directory exists on disk. */
  get enabled() {
    return this.rbacEnabled && Boolean(this.data) && this.data.users.length > 0
  }

  empty() {
    return { version: 1, updatedAt: nowIso(), users: [], grants: [], tokens: [], settings: { localUserId: '' } }
  }

  /** Read users.json when present. Never creates the file. */
  async load({ refresh = false } = {}) {
    if (this.data && this.loaded && !refresh) return this.data
    this.loaded = true
    if (!this.file) {
      this.data = null
      return null
    }
    let raw = null
    try {
      raw = JSON.parse(await readFile(this.file, 'utf8'))
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        this.data = null
        return null
      }
      if (error instanceof SyntaxError) throw new Error(`用户配置文件已损坏：${this.file}`)
      throw error
    }
    if (!raw || typeof raw !== 'object') {
      this.data = null
      return null
    }
    this.data = {
      ...this.empty(),
      ...raw,
      users: Array.isArray(raw.users) ? raw.users : [],
      grants: Array.isArray(raw.grants) ? raw.grants : [],
      tokens: Array.isArray(raw.tokens) ? raw.tokens : [],
      settings: { localUserId: String(raw.settings?.localUserId ?? '') },
    }
    return this.data
  }

  async save() {
    if (!this.file) throw new Error('请先配置知识库根目录，再管理用户。')
    this.data = this.data ?? this.empty()
    this.data.updatedAt = nowIso()
    await writeJsonAtomic(this.file, this.data)
    this.loaded = true
    return this.data
  }

  /** Seed a passphrase-less local owner so enabling RBAC cannot lock you out. */
  async bootstrap({ name = '本机管理员', localRole = 'owner' } = {}) {
    await this.load({ refresh: true })
    if (!this.data) this.data = this.empty()
    if (this.data.users.length === 0) {
      const created = {
        id: newId('u'),
        name: String(name).trim() || '本机管理员',
        role: normalizeRole(localRole, 'owner'),
        local: true,
        verifier: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        disabled: false,
        notes: '本机 Web 面板与 Agent 工具使用这个身份',
      }
      this.data.users.push(created)
      this.data.settings.localUserId = created.id
      await this.save()
    } else if (!this.data.users.some((user) => user.id === this.data.settings.localUserId)) {
      const local =
        this.data.users.find((user) => user.local) ?? this.data.users.find((user) => user.role === 'owner') ?? this.data.users[0]
      this.data.settings.localUserId = local.id
      await this.save()
    }
    return this.status()
  }

  status() {
    const data = this.data ?? this.empty()
    return {
      enabled: this.enabled,
      rbacEnabled: this.rbacEnabled,
      file: this.file ?? '',
      exists: Boolean(this.data),
      localUserId: data.settings?.localUserId ?? '',
      users: data.users.map(publicUser),
      grants: (data.grants ?? []).map((grant) => ({ ...grant, userName: this.userName(grant.userId) })),
      tokens: (data.tokens ?? []).map((token) => ({
        id: token.id,
        userId: token.userId,
        userName: this.userName(token.userId),
        label: token.label,
        scopes: token.scopes ?? [],
        createdAt: token.createdAt,
        lastUsedAt: token.lastUsedAt ?? '',
        expiresAt: token.expiresAt ?? '',
        expired: Boolean(token.expiresAt && new Date(token.expiresAt).getTime() < Date.now()),
        prefix: token.prefix ?? '',
      })),
      roles: ROLES,
      actions: Object.keys(ACTION_FLOOR),
    }
  }

  userName(userId) {
    return this.data?.users?.find((user) => user.id === userId)?.name ?? userId
  }

  findUser(ref) {
    const raw = String(ref ?? '')
      .trim()
      .toLowerCase()
    if (!raw || !this.data) return undefined
    return this.data.users.find((user) => String(user.id).toLowerCase() === raw || String(user.name).toLowerCase() === raw)
  }

  // ---- users ---------------------------------------------------------------

  async createUser({ name, role = 'reader', passphrase = '', notes = '' } = {}) {
    await this.load({ refresh: true })
    if (!this.data) this.data = this.empty()
    const clean = String(name ?? '')
      .trim()
      .slice(0, 64)
    if (clean === '') throw new Error('用户名不能为空。')
    if (this.data.users.some((user) => String(user.name).toLowerCase() === clean.toLowerCase())) {
      throw new Error(`用户名已存在：${clean}`)
    }
    const record = {
      id: newId('u'),
      name: clean,
      role: normalizeRole(role, 'reader'),
      local: false,
      verifier: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      disabled: false,
      notes: String(notes ?? '').slice(0, 200),
    }
    if (String(passphrase ?? '') !== '') {
      assertPassphraseShape(passphrase)
      record.verifier = await makeVerifier(passphrase)
    }
    this.data.users.push(record)
    await this.save()
    const created = publicUser(record)
    // Both shapes are returned: `user` for callers that want the record, and the
    // fields spread at the top level so a tool/panel can read `id` directly.
    return { ...created, user: created }
  }

  async setUserPassphrase({ user, passphrase } = {}) {
    await this.load({ refresh: true })
    const record = this.mustFind(user)
    if (String(passphrase ?? '') === '') {
      record.verifier = null
    } else {
      assertPassphraseShape(passphrase)
      record.verifier = await makeVerifier(passphrase)
    }
    record.updatedAt = nowIso()
    await this.save()
    return { user: publicUser(record) }
  }

  async updateUser({ user, role, disabled, notes } = {}) {
    await this.load({ refresh: true })
    const record = this.mustFind(user)
    if (role !== undefined) {
      if (record.local && normalizeRole(role) !== 'owner') throw new Error('本机管理员的角色不能被降级。')
      record.role = normalizeRole(role, record.role)
    }
    if (disabled !== undefined) {
      if (record.local) throw new Error('本机管理员不能停用。')
      record.disabled = Boolean(disabled)
    }
    if (notes !== undefined) record.notes = String(notes).slice(0, 200)
    record.updatedAt = nowIso()
    await this.save()
    return { user: publicUser(record) }
  }

  async removeUser({ user } = {}) {
    await this.load({ refresh: true })
    const record = this.mustFind(user)
    if (record.local) throw new Error('本机管理员不能删除。')
    this.data.users = this.data.users.filter((item) => item.id !== record.id)
    this.data.grants = this.data.grants.filter((grant) => grant.userId !== record.id)
    this.data.tokens = this.data.tokens.filter((token) => token.userId !== record.id)
    await this.save()
    return { removed: record.id, name: record.name }
  }

  async verifyPassphrase({ user, passphrase } = {}) {
    await this.load({ refresh: true })
    const record = this.findUser(user)
    if (!record || !record.verifier) throw new ForbiddenError('用户名或口令不正确。')
    if (record.disabled) throw new ForbiddenError(`用户已停用：${record.name}`)
    const candidate = await makeVerifier(passphrase ?? '', record.verifier.salt)
    if (!safeEqualHex(candidate.hash, record.verifier.hash)) throw new ForbiddenError('用户名或口令不正确。')
    record.lastLoginAt = nowIso()
    await this.save()
    return this.actorFor(record, 'password')
  }

  mustFind(ref) {
    const record = this.findUser(ref)
    if (!record) throw new Error(`用户不存在：${ref ?? '(空)'}`)
    return record
  }

  // ---- grants --------------------------------------------------------------

  async grant({ user, collection = '*', role } = {}) {
    await this.load({ refresh: true })
    const record = this.mustFind(user)
    const cleanCollection = String(collection ?? '*').trim() || '*'
    const cleanRole = normalizeRole(role ?? record.role, 'reader')
    if (cleanCollection !== '*' && ROLE_RANK[cleanRole] > ROLE_RANK.editor) {
      throw new Error('集合级授权最高只能是 editor；admin 请用全局角色。')
    }
    const existing = this.data.grants.find((item) => item.userId === record.id && item.collection === cleanCollection)
    if (existing) {
      existing.role = cleanRole
      existing.updatedAt = nowIso()
    } else {
      this.data.grants.push({
        id: newId('g'),
        userId: record.id,
        collection: cleanCollection,
        role: cleanRole,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
    }
    await this.save()
    return { grants: this.status().grants }
  }

  async revoke({ grantId, user, collection } = {}) {
    await this.load({ refresh: true })
    const before = this.data.grants.length
    if (grantId) {
      this.data.grants = this.data.grants.filter((item) => item.id !== grantId)
    } else {
      const record = this.findUser(user)
      const cleanCollection = String(collection ?? '*').trim() || '*'
      this.data.grants = this.data.grants.filter((item) => !(record && item.userId === record.id && item.collection === cleanCollection))
    }
    await this.save()
    return { removed: before - this.data.grants.length }
  }

  // ---- tokens --------------------------------------------------------------

  async issueToken({ user, label = '', scopes = ['read'], ttlDays = 0 } = {}) {
    await this.load({ refresh: true })
    const record = this.mustFind(user)
    if (record.disabled) throw new ForbiddenError(`用户已停用：${record.name}`)
    const secret = `kb_${randomBytes(24).toString('hex')}`
    const entry = {
      id: newId('t'),
      userId: record.id,
      label:
        String(label)
          .trim()
          .slice(0, 64) || safeFileName(record.name, 'token'),
      hash: digest(secret),
      prefix: secret.slice(0, 13),
      scopes: normalizeScopes(scopes),
      createdAt: nowIso(),
      lastUsedAt: '',
      expiresAt: Number(ttlDays) > 0 ? new Date(Date.now() + Number(ttlDays) * 86400000).toISOString() : '',
    }
    this.data.tokens.push(entry)
    await this.save()
    return {
      token: secret,
      note: 'Token 只显示这一次；服务端只保存 SHA-256 摘要，遗失后只能重新签发。',
      record: { id: entry.id, label: entry.label, scopes: entry.scopes, expiresAt: entry.expiresAt, prefix: entry.prefix },
    }
  }

  async resolveToken(secret) {
    await this.load({ refresh: true })
    if (!this.data) return null
    const hash = digest(String(secret ?? ''))
    const entry = this.data.tokens.find((token) => String(token.hash) === hash)
    if (!entry) return null
    if (entry.expiresAt && new Date(entry.expiresAt).getTime() < Date.now()) return null
    const record = this.data.users.find((user) => user.id === entry.userId)
    if (!record || record.disabled) return null
    entry.lastUsedAt = nowIso()
    await this.save().catch(() => {})
    return this.actorFor(record, 'token', entry.scopes ?? ['read'])
  }

  async revokeToken({ id, tokenId } = {}) {
    const wanted = String(id ?? tokenId ?? '').trim()
    if (wanted === '') throw new Error('revokeToken 需要 tokenId')
    await this.load({ refresh: true })
    const before = this.data.tokens.length
    this.data.tokens = this.data.tokens.filter((token) => token.id !== wanted && token.label !== wanted)
    if (this.data.tokens.length === before) throw new Error(`未找到令牌：${wanted}`)
    await this.save()
    return { revoked: wanted, remaining: this.data.tokens.length }
  }

  // ---- actors and permissions ---------------------------------------------

  /** The identity behind the Harness Web panel and the agent tools. */
  localActor() {
    const configured = String(this.settings?.security?.rbac?.localRole ?? 'owner')
    const data = this.data
    if (!data || data.users.length === 0) {
      return new Actor({ id: 'local', name: '本机', role: normalizeRole(configured, 'owner'), via: 'local' })
    }
    const record =
      data.users.find((user) => user.id === data.settings?.localUserId) ??
      data.users.find((user) => user.local) ??
      data.users.find((user) => user.role === 'owner') ??
      data.users[0]
    return this.actorFor(record, 'local')
  }

  actorFor(record, via, scopes = []) {
    const collectionRole = {}
    for (const grant of this.data?.grants ?? []) {
      if (grant.userId === record.id) collectionRole[String(grant.collection)] = normalizeRole(grant.role, 'reader')
    }
    return new Actor({
      id: record.id,
      name: record.name,
      role: normalizeRole(record.role, 'reader'),
      via,
      scopes,
      collectionRole,
    })
  }

  /** Effective role inside one collection; grants can only lower the global role. */
  roleIn(actor, collection) {
    if (!this.enabled) return actor?.role ?? ''
    const table = actor?.collectionRole ?? {}
    const base = normalizeRole(actor?.role, 'reader')
    const scoped = table[String(collection ?? '')] ?? table['*']
    if (!scoped) return base
    return ROLE_RANK[base] >= ROLE_RANK[scoped] ? scoped : base
  }

  can(actor, action, { collection } = {}) {
    if (!this.enabled) return true
    if (!actor || actor.anonymous) return false
    if (actor.via === 'token' && !(actor.scopes ?? []).includes('all')) {
      const needed = action === 'write' || action === 'delete' ? 'write' : action
      if (!(actor.scopes ?? []).includes(needed) && !(actor.scopes ?? []).includes(action)) return false
    }
    const role = collection === undefined ? normalizeRole(actor.role) : this.roleIn(actor, collection)
    if (!role) return false
    return ROLE_RANK[role] >= ROLE_RANK[ACTION_FLOOR[action] ?? 'reader']
  }

  assert(actor, action, options = {}) {
    if (!this.can(actor, action, options)) {
      const scope = options?.collection ? `（集合 ${options.collection}）` : ''
      throw new ForbiddenError(
        `${actor?.name ?? '未知身份'}（角色 ${actor?.role ?? '无'}）无权执行 ${action}${scope}。需要本机在 设置 → 知识库 → 安全 中调整授权。`,
      )
    }
    return true
  }

  /** `null` means "everything is visible". */
  visibleCollections(actor) {
    if (!this.enabled) return null
    if (!actor || actor.anonymous) return new Set()
    // Per-collection grants narrow the *role*, they do not hide content:
    // anything the global role may read stays readable.
    return null
  }

  filterDocs(actor, docs) {
    const visible = this.visibleCollections(actor)
    if (!visible) return docs
    return docs.filter((doc) => visible.has(String(doc.collection ?? '')))
  }

  filterCollections(actor, collections) {
    const visible = this.visibleCollections(actor)
    if (!visible) return collections
    return collections.filter((collection) => visible.has(String(collection.name ?? '')))
  }
}

function publicUser(record) {
  return {
    id: record.id,
    name: record.name,
    role: normalizeRole(record.role),
    local: Boolean(record.local),
    disabled: Boolean(record.disabled),
    hasPassphrase: Boolean(record.verifier),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastLoginAt: record.lastLoginAt ?? '',
    notes: record.notes ?? '',
  }
}

export { digest as tokenDigest }
