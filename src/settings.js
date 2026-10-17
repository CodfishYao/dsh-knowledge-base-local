/**
 * Settings live in `%DSH_HOME%/knowledge-base/settings.json` (profile-independent),
 * so the knowledge root can be chosen without editing a Cordis patch. Values in
 * the bundle row's `config` take precedence when non-empty.
 */
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { defaultDshHome, readJson, settingsFilePath, writeJsonAtomic } from './util.js'

export const DEFAULT_SETTINGS = {
  version: 1,
  /** Absolute directory that holds the knowledge base. Empty = not configured yet. */
  rootDir: '',
  vectorMode: 'local', // local | llm | api
  chunkSize: 1200,
  chunkOverlap: 160,
  vectorDim: 1024,
  defaultCollection: 'default',
  search: {
    vectorWeight: 0.55,
    lexicalWeight: 0.45,
    maxResults: 8,
    snippetChars: 420,
  },
  llm: {
    provider: '',
    model: '',
    maxChars: 12000,
    temperature: 0.1,
    timeoutMs: 120000,
  },
  embedding: {
    endpoint: '',
    model: '',
    apiKey: '',
    dimensions: 0,
    batchSize: 32,
    timeoutMs: 60000,
  },
  watch: {
    enabled: true,
    dir: 'inbox',
    debounceMs: 1500,
  },
  versions: {
    keep: 20,
  },
  import: {
    maxFileBytes: 8 * 1024 * 1024,
    maxDocsPerRun: 500,
    copyFiles: true,
  },
  tools: {
    allowWrite: true,
  },
  /**
   * Security is opt-in and never holds key material. The passphrase itself is
   * asked for interactively (Web panel) or via the DSH_KB_PASSPHRASE env var.
   */
  security: {
    /** Store metadata (titles/tags/summaries/manifest) as ciphertext too. */
    metadata: 'plain', // plain | encrypted
    /** Try to unlock from DSH_KB_PASSPHRASE on load (CLI / MCP / unattended). */
    autoUnlockEnv: true,
    rbac: {
      enabled: false,
      /** Role the Harness panel and agent tools act with when RBAC is on. */
      localRole: 'owner',
    },
  },
  /** MCP surface exposed to external clients (Claude Desktop, Cursor, ...). */
  mcp: {
    enabled: true,
    /** Mount the Streamable-HTTP endpoint on the Harness web server. */
    http: true,
    /** Require a bearer token issued in 设置 → 知识库 → 安全 → 访问令牌. */
    requireToken: true,
    /** Allow requests that come from the Harness GUI origin without a token. */
    allowLocalOrigin: true,
    allowedOrigins: [],
    /** Expose write tools (kb_add / kb_import / kb_manage) over MCP. */
    allowWrite: true,
    /** Default tool budget for a single MCP listing. */
    maxTextChars: 60000,
  },
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Deep merge; `undefined`, `null` and empty strings in `override` are ignored. */
export function mergeSettings(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base }
  if (!isPlainObject(override)) return out
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'string' && value.trim() === '') continue
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = mergeSettings(out[key], value)
    else out[key] = value
  }
  return out
}

export function expandPath(input) {
  let value = String(input ?? '').trim()
  if (value === '') return ''
  value = value.replace(/^~(?=$|[\\/])/, homedir())
  value = value.replace(/%([^%]+)%/g, (whole, name) => process.env[name] ?? whole)
  value = value.replace(/\$\{([^}]+)\}|\$([A-Z_][A-Z0-9_]*)/gi, (whole, a, b) => process.env[a ?? b] ?? whole)
  return resolve(value)
}

export function normalizeSettings(raw) {
  const merged = mergeSettings(DEFAULT_SETTINGS, raw ?? {})
  if (!['local', 'llm', 'api'].includes(merged.vectorMode)) merged.vectorMode = 'local'
  merged.chunkSize = Math.min(8000, Math.max(200, Number(merged.chunkSize) || 1200))
  merged.chunkOverlap = Math.min(Math.floor(merged.chunkSize / 2), Math.max(0, Number(merged.chunkOverlap) || 0))
  merged.vectorDim = Math.min(4096, Math.max(64, Number(merged.vectorDim) || 1024))
  merged.search.maxResults = Math.min(50, Math.max(1, Number(merged.search.maxResults) || 8))
  merged.search.vectorWeight = Math.min(1, Math.max(0, Number(merged.search.vectorWeight) ?? 0.55))
  merged.search.lexicalWeight = Math.min(1, Math.max(0, Number(merged.search.lexicalWeight) ?? 0.45))
  merged.rootDir = String(merged.rootDir ?? '').trim()
  const security = (merged.security = merged.security ?? {})
  security.metadata = security.metadata === 'encrypted' ? 'encrypted' : 'plain'
  security.autoUnlockEnv = security.autoUnlockEnv !== false
  const rbac = (security.rbac = security.rbac ?? {})
  rbac.enabled = Boolean(rbac.enabled)
  rbac.localRole = ['owner', 'admin', 'editor', 'reader'].includes(rbac.localRole) ? rbac.localRole : 'owner'
  const mcp = (merged.mcp = merged.mcp ?? {})
  mcp.enabled = mcp.enabled !== false
  mcp.http = mcp.http !== false
  mcp.requireToken = mcp.requireToken !== false
  mcp.allowLocalOrigin = mcp.allowLocalOrigin !== false
  mcp.allowWrite = mcp.allowWrite !== false
  mcp.allowedOrigins = Array.isArray(mcp.allowedOrigins) ? mcp.allowedOrigins.map((item) => String(item).trim()).filter(Boolean) : []
  mcp.maxTextChars = Math.min(400000, Math.max(2000, Number(mcp.maxTextChars) || 60000))
  return merged
}

/** Load defaults ← settings.json ← patch config, then normalize. */
export async function loadSettings(patchConfig = {}) {
  const fromFile = await readJson(settingsFilePath(), {})
  return normalizeSettings(mergeSettings(mergeSettings(DEFAULT_SETTINGS, fromFile), patchConfig))
}

/** Merge a partial patch into settings.json and return the resulting settings. */
export async function saveSettings(patch, patchConfig = {}) {
  const file = await readJson(settingsFilePath(), {})
  const nextFile = mergeSettings(file, patch)
  await writeJsonAtomic(settingsFilePath(), nextFile)
  return normalizeSettings(mergeSettings(mergeSettings(DEFAULT_SETTINGS, nextFile), patchConfig))
}

export function settingsLocation() {
  return settingsFilePath()
}

export function dshHome() {
  return defaultDshHome()
}

export function resolveRoot(settings) {
  const value = expandPath(settings?.rootDir ?? '')
  return value === '' ? null : value
}
