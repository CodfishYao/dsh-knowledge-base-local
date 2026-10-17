/**
 * MCP（Model Context Protocol）服务器核心 —— 与传输无关，零依赖（只用 node 内置）。
 *
 * 这个文件只理解 JSON-RPC 2.0 消息对象与 MCP 方法；字节怎么进来（stdio / HTTP）
 * 由 `src/mcp_stdio.js`、`src/mcp_http.js` 负责。可以直接在进程内驱动它做测试：
 *
 *   const core = createMcpCore({ store, tools })
 *   const reply = await handleMcpMessage(core, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
 *
 * 参考 MCP 公开规范（Anthropic），但**没有**引入官方 SDK：手写、保守、可测试。
 *
 * 已知的简化（simplified，故意保守）：
 *  - 不支持 SSE / 服务端主动请求 / `notifications/*_changed` 推送 / `listChanged`。
 *  - `tools/list`、`resources/list`、`prompts/list` 一次返回全量，**不带** `nextCursor`；
 *    收到 `params.cursor` 时忽略它（仍然返回全量），因此客户端不会漏数据但也不会分页。
 *  - `capabilities` 默认只声明 `tools` 与 `resources`（按集成要求）。`prompts/*` 与
 *    `logging/setLevel` 已实现，但严格客户端要先看到声明才会调用；需要发现它们时传
 *    `capabilities: { tools: {}, resources: {}, prompts: { listChanged: false }, logging: {} }`。
 *  - 记录 initialize 状态但**不强制**先握手（宽松模式，避免卡住简陋客户端）。
 *  - `initialize` 的 `params.capabilities`（客户端能力）只记录不使用；不实现
 *    `roots/list`、`sampling/createMessage` 等服务端发起的调用。
 *  - JSON-RPC 批量（数组）会逐个处理并返回数组；若全是通知则返回 null。
 *  - 未知**通知**不回复；未知**请求**返回 -32601。
 */
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

/** 支持协商的协议版本，越靠前越新。 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

/** JSON-RPC 2.0 / MCP 用到的错误码。 */
export const JSONRPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** 未授权（本实现自定义，JSON-RPC 预留的 server 错误区间）。 */
  UNAUTHORIZED: -32001,
  /** 资源不存在（simplified：规范未规定专用码，沿用社区惯例 -32002）。 */
  RESOURCE_NOT_FOUND: -32002,
}

export const LOG_LEVELS = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency']

/** 每篇文档暴露成一个资源：`kb://<collection>/<id>`；目录文件固定为 `kb://catalog`。 */
export const CATALOG_URI = 'kb://catalog'
export const RESOURCE_SCHEME = 'kb'
export const RESOURCE_MIME = 'text/markdown'

const PAGE_SIZE = 200
const MAX_DOC_PAGES = 50

/** 这些方法不需要鉴权（握手与探活必须先能用）。 */
const AUTH_EXEMPT = new Set(['initialize', 'ping'])

const DEFAULT_SERVER_INFO = { name: 'dsh-knowledge-base', version: '1.0.0' }

export const DEFAULT_INSTRUCTIONS = [
  '这是 dsh-knowledge-base 本地知识库（Markdown 即数据）。',
  '用法：先用 kb_search 检索，再用 kb_read 按 id 读全文；kb_list 浏览；kb_add/kb_import 写入；kb_manage 运维（status/configure/reindex/scan/…）。',
  '回答用户时要给出命中文档的 id、path 与行号，不要凭记忆编造。',
  '资源 kb://<collection>/<id> 就是 docs/<id>.md 原文，kb://catalog 是自动生成的目录。',
].join('\n')

/** 带 JSON-RPC 错误码的异常；核心会把它转成 error 响应。 */
export class McpError extends Error {
  constructor(code, message, data) {
    super(message)
    this.name = 'McpError'
    this.code = code
    if (data !== undefined) this.data = data
  }
}

export function errorMessage(error, fallback = 'Unknown error') {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return fallback
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 请求：有 id；通知：method 存在但没有 id。 */
export function isRequestMessage(value) {
  return isPlainObject(value) && typeof value.method === 'string' && value.id !== undefined
}

export function isNotificationMessage(value) {
  return isPlainObject(value) && typeof value.method === 'string' && value.id === undefined
}

export function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result: result === undefined ? {} : result }
}

export function jsonRpcError(id, code, message, data) {
  const error = { code, message }
  if (data !== undefined) error.data = data
  return { jsonrpc: '2.0', id: id ?? null, error }
}

export function request_id_of(message) {
  const id = message?.id
  return typeof id === 'string' || typeof id === 'number' ? id : null
}

/** `kb://<collection>/<id>`，两段都做 URL 编码。 */
export function kbResourceUri(collection, id) {
  return `kb://${encodeURIComponent(String(collection || 'default'))}/${encodeURIComponent(String(id))}`
}

/**
 * 解析 kb:// URI。
 * @returns {{ kind: 'catalog' } | { kind: 'doc', collection: string, id: string } | null}
 */
export function parseKbResourceUri(uri) {
  const raw = String(uri ?? '').trim()
  if (!raw.startsWith(`${RESOURCE_SCHEME}://`)) return null
  const rest = raw.slice(RESOURCE_SCHEME.length + 3).replace(/^\/+/, '')
  const slash = rest.indexOf('/')
  const head = slash < 0 ? rest : rest.slice(0, slash)
  if (head === 'catalog') return { kind: 'catalog' }
  if (slash < 0) return null
  const decode = (value) => {
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  const id = decode(rest.slice(slash + 1))
  if (id === '') return null
  return { kind: 'doc', collection: decode(head), id }
}

/**
 * Harness ToolDefinition（`src/tools.js` 的形状）→ MCP tool 描述。
 *
 * `parameters` 直接当作 `inputSchema`；`output.schema` 当作 `outputSchema`；
 * 结果用 `output.render(args, value)` 生成可读文本，同时把原始对象放进
 * `structuredContent`（MCP 2025-06-18 的结构化结果）。
 *
 * @param {object} definition
 * @param {{ transformHandler?: (handler) => handler }} [options]
 */
export function toMcpTool(definition, options = {}) {
  const name = String(definition?.name ?? '').trim()
  if (!name) throw new Error('tool definition needs a name')
  const handler = async (args, actor, context = {}) => {
    const exec = { signal: context.signal, actor, meta: context.meta ?? null }
    const value = await definition.execute(args ?? {}, exec)
    const rendered = typeof definition.output?.render === 'function' ? definition.output.render(args ?? {}, value) : null
    const content = Array.isArray(rendered) && rendered.length > 0
      ? rendered.map((part) => ({ ...part }))
      : [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2) }]
    const result = { content }
    if (definition.output?.schema && value !== undefined) result.structuredContent = value
    return result
  }
  const tool = {
    name,
    description: String(definition.description ?? name),
    inputSchema: definition.parameters ?? { type: 'object', properties: {} },
    handler: options.transformHandler ? options.transformHandler(handler) : handler,
  }
  if (definition.output?.schema) tool.outputSchema = definition.output.schema
  tool.annotations = definition.annotations ?? {
    title: name,
    readOnlyHint: definition.isConcurrencySafe ? definition.isConcurrencySafe() : false,
    destructiveHint: false,
    idempotentHint: Boolean(definition.isConcurrencySafe?.()),
  }
  return tool
}

function logLevelRank(core) {
  const at = LOG_LEVELS.indexOf(core.state.logLevel)
  return at < 0 ? LOG_LEVELS.indexOf('warning') : at
}

/** 写日志：默认 stderr，绝不写 stdout（stdio 传输会把它当成协议数据）。 */
function createLogger(core) {
  const sink = core.options.log
  return (level, data) => {
    const rank = LOG_LEVELS.indexOf(level)
    if (rank >= 0 && rank < logLevelRank(core)) return
    const line = `[mcp:${level}] ${typeof data === 'string' ? data : JSON.stringify(data)}`
    if (typeof sink === 'function') {
      try {
        sink(level, data, line)
        return
      } catch {
        /* fall through to stderr */
      }
    }
    process.stderr.write(`${line}\n`)
  }
}

/**
 * 创建 MCP 核心。
 *
 * @param {object} options
 * @param {object} [options.store] KnowledgeStore 实例（用于 resources/*；缺省则只暴露工具）
 * @param {{ name: string, version: string, title?: string }} [options.serverInfo]
 * @param {string} [options.instructions]
 * @param {Array<{ name: string, description: string, inputSchema: object, handler: (args: object, actor: any) => Promise<object|string>, outputSchema?: object, annotations?: object }>} [options.tools]
 * @param {(info: object) => any|null|Promise<any|null>} [options.authorize] 鉴权钩子；返回 null 即拒绝
 * @param {(meta: object) => any|Promise<any>} [options.resolveActor] 从传输 meta 里取 actor
 * @param {(level: string, data: any, line: string) => void} [options.log]
 * @param {object} [options.capabilities] 覆盖默认能力声明
 * @param {number} [options.maxTextChars] 单条 text 结果的上限（0/缺省 = 不截断）；对应 settings.mcp.maxTextChars
 * @param {(info: object) => void|Promise<void>} [options.onInitialize] 客户端 initialize 后回调
 */
export function createMcpCore(options = {}) {
  const tools = Array.isArray(options.tools) ? options.tools.filter((tool) => tool && tool.name) : []
  const toolMap = new Map(tools.map((tool) => [String(tool.name), tool]))

  const core = {
    options,
    store: options.store ?? null,
    serverInfo: { ...DEFAULT_SERVER_INFO, ...(options.serverInfo ?? {}) },
    instructions: typeof options.instructions === 'string' ? options.instructions : DEFAULT_INSTRUCTIONS,
    tools,
    toolMap,
    capabilities: {
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
      ...(options.capabilities ?? {}),
    },
    state: {
      initialized: false,
      protocolVersion: '',
      clientInfo: null,
      logLevel: options.logLevel ?? 'warning',
      session: options.session ?? null,
      requests: 0,
      toolCalls: 0,
    },
  }

  core.log = createLogger(core)

  core.resolveActor = async (message, meta) => {
    const base = typeof options.resolveActor === 'function'
      ? await options.resolveActor(meta ?? {}, message)
      : (meta && meta.actor !== undefined ? meta.actor : null)
    if (typeof options.authorize !== 'function') return base ?? null
    const info = {
      ...(meta ?? {}),
      actor: base ?? null,
      method: message?.method,
      params: message?.params ?? {},
      serverInfo: core.serverInfo,
      state: core.state,
    }
    const decided = await options.authorize(info)
    if (decided === null || decided === undefined) {
      throw new McpError(
        JSONRPC.UNAUTHORIZED,
        `未授权：${message?.method ?? '(no method)'} 需要凭据（stdio 传输请在启动时配置，HTTP 传输请带 Authorization: Bearer 或 X-Api-Key）`,
        { method: message?.method ?? null },
      )
    }
    return decided
  }

  core.methods = new Map()

  const method = (name, handler) => core.methods.set(name, handler)

  method('initialize', async ({ params, meta }) => {
    const requested = String(params?.protocolVersion ?? '')
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION
    core.state.initialized = true
    core.state.protocolVersion = protocolVersion
    core.state.clientInfo = isPlainObject(params?.clientInfo) ? params.clientInfo : null
    if (typeof core.options.onInitialize === 'function') {
      await core.options.onInitialize({
        protocolVersion,
        clientInfo: core.state.clientInfo,
        requestedProtocolVersion: requested,
        transport: meta?.transport ?? null,
        meta,
      })
    }
    return {
      protocolVersion,
      capabilities: core.capabilities,
      serverInfo: core.serverInfo,
      instructions: core.instructions,
    }
  })

  method('ping', async () => ({}))
  method('notifications/initialized', async ({ params }) => {
    core.state.clientCapabilities = isPlainObject(params?.capabilities) ? params.capabilities : null
    return undefined
  })

  method('tools/list', async () => ({
    tools: core.tools.map((tool) => {
      const entry = { name: tool.name, description: tool.description, inputSchema: tool.inputSchema ?? { type: 'object', properties: {} } }
      if (tool.outputSchema) entry.outputSchema = tool.outputSchema
      if (tool.annotations) entry.annotations = tool.annotations
      return entry
    }),
  }))

  method('tools/call', async ({ params, meta }) => await callTool(core, params, meta))

  method('resources/list', async () => ({ resources: await listResources(core) }))
  method('resources/read', async ({ params }) => await readResource(core, params?.uri))
  method('resources/templates/list', async () => ({
    resourceTemplates: [
      {
        uriTemplate: `kb://{collection}/{id}`,
        name: 'knowledge-base document',
        title: '知识库文档',
        description: '单篇文档的 Markdown 原文（docs/<id>.md）',
        mimeType: RESOURCE_MIME,
      },
    ],
  }))

  method('prompts/list', async () => ({ prompts: [promptDescriptor()] }))
  method('prompts/get', async ({ params }) => await getPrompt(core, params))

  method('logging/setLevel', async ({ params }) => {
    const level = String(params?.level ?? '')
    if (!LOG_LEVELS.includes(level)) throw new McpError(JSONRPC.INVALID_PARAMS, `level 必须是 ${LOG_LEVELS.join('|')} 之一`)
    core.state.logLevel = level
    core.log('info', `log level set to ${level}`)
    return {}
  })

  /** 传输层便捷入口：等价于 `handleMcpMessage(core, message, meta)`。 */
  core.dispatch = (message, meta) => handleMcpMessage(core, message, meta)

  return core
}

function promptDescriptor() {
  return {
    name: 'kb-search',
    title: '知识库检索',
    description: '让模型先检索本地知识库、再基于命中文档作答，并要求引用 id / 路径 / 行号。',
    arguments: [
      { name: 'query', description: '要检索的问题或关键词（中英文皆可）', required: true },
      { name: 'limit', description: '返回条数，默认 5', required: false },
      { name: 'collection', description: '限定集合名，默认全部', required: false },
    ],
  }
}

async function getPrompt(core, params) {
  const name = String(params?.name ?? '')
  if (name !== 'kb-search') throw new McpError(JSONRPC.INVALID_PARAMS, `unknown prompt: ${name || '(missing name)'}`)
  const args = isPlainObject(params?.arguments) ? params.arguments : {}
  const query = String(args.query ?? '').trim()
  if (query === '') throw new McpError(JSONRPC.INVALID_PARAMS, 'prompt argument "query" is required')
  const limit = /^\d+$/.test(String(args.limit ?? '')) ? String(args.limit) : '5'
  const collection = String(args.collection ?? '').trim()
  const scope = collection ? `，只检索集合 ${collection}` : ''
  const text = [
    `请先调用知识库工具 kb_search 检索「${query}」${scope}（limit=${limit}），不要凭记忆直接回答。`,
    '对最相关的 1~3 篇再调用 kb_read 取全文（可用返回的 lineStart/lineEnd 定位）。',
    '回答时用 Markdown 引用文档 id、docs/<id>.md 路径与行号；检索不到就明确说明“知识库中没有”。',
  ].join('\n')
  return {
    description: `知识库检索：${query}`,
    messages: [{ role: 'user', content: { type: 'text', text } }],
  }
}

/** 遍历 store 里的全部文档（用公开的 list 分页，不直接读 kb.json）。 */
async function allDocs(store) {
  const docs = []
  for (let page = 0; page < MAX_DOC_PAGES; page++) {
    const result = await store.list({ limit: PAGE_SIZE, offset: page * PAGE_SIZE })
    docs.push(...(result.docs ?? []))
    if ((result.docs ?? []).length === 0 || docs.length >= Number(result.total ?? 0)) break
  }
  return docs
}

async function listResources(core) {
  const resources = [
    {
      uri: CATALOG_URI,
      name: 'CATALOG.md',
      title: '知识库目录',
      description: '自动生成的全库目录：集合、标题、id、标签、分块数、摘要',
      mimeType: RESOURCE_MIME,
    },
  ]
  const store = core.store
  if (!store || !store.configured) return resources
  let docs = []
  try {
    docs = await allDocs(store)
  } catch (error) {
    core.log('warning', `resources/list 读取文档列表失败：${errorMessage(error)}`)
    return resources
  }
  for (const doc of docs) {
    const summary = String(doc.summary ?? '').slice(0, 200)
    resources.push({
      uri: kbResourceUri(doc.collection, doc.id),
      name: doc.id,
      title: String(doc.title ?? doc.id),
      description: summary || `集合 ${doc.collection} · ${doc.chunkCount ?? 0} 块 · ${doc.path}`,
      mimeType: RESOURCE_MIME,
      ...(doc.tags?.length ? { tags: doc.tags } : {}),
    })
  }
  return resources
}

async function readResource(core, uri) {
  const parsed = parseKbResourceUri(uri)
  if (!parsed) {
    throw new McpError(JSONRPC.RESOURCE_NOT_FOUND, `无法解析的资源 uri（期望 kb://<collection>/<id> 或 kb://catalog）：${String(uri ?? '')}`, { uri: uri ?? null })
  }
  const store = core.store
  if (!store || !store.configured) {
    throw new McpError(JSONRPC.RESOURCE_NOT_FOUND, '知识库根目录尚未配置，没有可读的资源')
  }
  if (parsed.kind === 'catalog') {
    const file = join(store.requireRoot(), 'CATALOG.md')
    const text = await readFile(file, 'utf8').catch(() => null)
    if (text === null) {
      const manifest = await store.loadManifest().catch(() => null)
      if (!manifest) throw new McpError(JSONRPC.RESOURCE_NOT_FOUND, `找不到 ${file}`)
      await store.generateCatalog().catch(() => {})
      const retry = await readFile(file, 'utf8').catch(() => null)
      if (retry === null) throw new McpError(JSONRPC.RESOURCE_NOT_FOUND, `CATALOG.md 尚未生成，可先调用 kb_manage {action:"scan"}`)
      return { contents: [{ uri: CATALOG_URI, name: 'CATALOG.md', mimeType: RESOURCE_MIME, text: retry }] }
    }
    return { contents: [{ uri: CATALOG_URI, name: 'CATALOG.md', mimeType: RESOURCE_MIME, text }] }
  }

  let doc
  try {
    doc = await store.read({ id: parsed.id, offset: 1, limit: 4000 })
  } catch (error) {
    throw new McpError(JSONRPC.RESOURCE_NOT_FOUND, `读不到资源 ${String(uri)}：${errorMessage(error)}`)
  }
  if (parsed.collection && doc.collection !== parsed.collection) {
    throw new McpError(
      JSONRPC.RESOURCE_NOT_FOUND,
      `资源与文档的集合不一致：uri 里是 ${parsed.collection}，文档实际在 ${doc.collection}（请用 resources/list 的最新 uri）`,
    )
  }
  let text = null
  try {
    text = await readFile(store.docFile(doc.id), 'utf8')
  } catch {
    text = null
  }
  if (text === null) {
    const tags = (doc.tags ?? []).join(', ')
    text = [`---`, `id: ${doc.id}`, `title: ${doc.title}`, `collection: ${doc.collection}`, tags ? `tags: ${tags}` : '', `---`, '', doc.content ?? ''].join('\n')
  }
  const canonical = kbResourceUri(doc.collection, doc.id)
  return { contents: [{ uri: canonical, name: doc.title, title: doc.title, mimeType: RESOURCE_MIME, text }] }
}

function normalizeToolResult(value, tool, maxTextChars = 0) {
  const clamp = (text) => {
    const limit = Number(maxTextChars) || 0
    if (limit <= 0 || text.length <= limit) return text
    return `${text.slice(0, limit)}\n…（已截断：本条 ${text.length} 字符，上限 ${limit}；用 kb_read 的 offset/limit 分段读）`
  }
  if (value === undefined || value === null) return { content: [{ type: 'text', text: '（工具没有返回内容）' }] }
  if (typeof value === 'string') return { content: [{ type: 'text', text: clamp(value) }] }
  if (isPlainObject(value) && Array.isArray(value.content)) {
    const result = { ...value, content: value.content.map((part) => ({ ...part, ...(typeof part?.text === 'string' ? { text: clamp(part.text) } : {}) })) }
    if (tool?.outputSchema && result.structuredContent === undefined && value.result !== undefined) result.structuredContent = value.result
    return result
  }
  const result = { content: [{ type: 'text', text: clamp(JSON.stringify(value, null, 2)) }] }
  if (tool?.outputSchema) result.structuredContent = value
  return result
}

function typeMatches(value, type) {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'integer':
      return Number.isInteger(value) || (typeof value === 'number' && Number.isInteger(value)) || (typeof value === 'string' && /^-?\d+$/.test(value))
    case 'number':
      return (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
    case 'boolean':
      return typeof value === 'boolean'
    case 'array':
      return Array.isArray(value)
    case 'object':
      return isPlainObject(value)
    case 'null':
      return value === null
    default:
      return true
  }
}

/**
 * 保守的 inputSchema 子集校验：`required` / `type` / `enum` / `minimum` / `maximum`。
 * 故意**不** enforcing `additionalProperties:false`（宽松接受多余字段，避免误伤客户端）。
 * 校验失败按 MCP 的做法转成 `isError:true` 的工具结果，让模型有机会自我纠正。
 *
 * @returns {string[]} 问题列表（空即通过）
 */
export function validateToolArguments(schema, args) {
  const problems = []
  if (!isPlainObject(schema)) return problems
  const values = isPlainObject(args) ? args : {}
  for (const key of Array.isArray(schema.required) ? schema.required : []) {
    const value = values[key]
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) problems.push(`缺少必填参数 "${key}"`)
  }
  const properties = isPlainObject(schema.properties) ? schema.properties : {}
  for (const [key, value] of Object.entries(values)) {
    const spec = properties[key]
    if (!isPlainObject(spec) || value === undefined || value === null) continue
    if (spec.type && !typeMatches(value, spec.type)) problems.push(`参数 "${key}" 类型应为 ${spec.type}`)
    if (Array.isArray(spec.enum) && spec.enum.length > 0 && !spec.enum.includes(value)) {
      problems.push(`参数 "${key}" 只能是 ${spec.enum.join(' | ')}，收到 ${JSON.stringify(value)}`)
    }
    if (typeof value === 'number') {
      if (typeof spec.minimum === 'number' && value < spec.minimum) problems.push(`参数 "${key}" 不能小于 ${spec.minimum}`)
      if (typeof spec.maximum === 'number' && value > spec.maximum) problems.push(`参数 "${key}" 不能大于 ${spec.maximum}`)
    }
  }
  return problems
}

async function callTool(core, params, meta) {
  const name = String(params?.name ?? '')
  const tool = core.toolMap.get(name)
  if (!tool) throw new McpError(JSONRPC.INVALID_PARAMS, `未知的工具：${name || '(缺少 name)'}`, { known: core.tools.map((t) => t.name) })
  const rawArgs = params?.arguments
  if (rawArgs !== undefined && rawArgs !== null && !isPlainObject(rawArgs)) {
    throw new McpError(JSONRPC.INVALID_PARAMS, 'params.arguments 必须是一个对象')
  }
  const args = rawArgs ?? {}
  const problems = validateToolArguments(tool.inputSchema, args)
  if (problems.length > 0) {
    return { content: [{ type: 'text', text: `参数校验失败：${problems.join('；')}` }], isError: true }
  }
  const actor = await core.resolveActor({ method: 'tools/call', params }, meta)
  core.state.toolCalls += 1
  try {
    const value = await tool.handler(args, actor, { meta, signal: undefined })
    return normalizeToolResult(value, tool, core.options.maxTextChars)
  } catch (error) {
    core.log('warning', `tool ${name} failed: ${errorMessage(error)}`)
    return { content: [{ type: 'text', text: `工具 ${name} 执行失败：${errorMessage(error)}` }], isError: true }
  }
}

/**
 * 分发一条 JSON-RPC 消息。
 *
 * @param {object} core createMcpCore 的结果
 * @param {object|Array} message 已解析的 JSON-RPC 消息（或批量数组）
 * @param {object} [meta] 传输信息：`{ transport, actor, session, headers, req }`
 * @returns {Promise<object|Array|null>} 要写回的响应；null 表示不需要回复（通知）
 */
export async function handleMcpMessage(core, message, meta) {
  if (Array.isArray(message)) {
    const replies = []
    for (const item of message) {
      const reply = await handleMcpMessage(core, item, meta)
      if (reply) replies.push(reply)
    }
    return replies.length > 0 ? replies : null
  }

  if (!isPlainObject(message)) {
    return jsonRpcError(null, JSONRPC.INVALID_REQUEST, 'JSON-RPC 消息必须是一个对象')
  }
  if (message.jsonrpc !== '2.0') {
    return jsonRpcError(request_id_of(message), JSONRPC.INVALID_REQUEST, "jsonrpc 字段必须是 '2.0'")
  }
  const method = message.method
  if (typeof method !== 'string' || method === '') {
    if ('result' in message || 'error' in message) {
      // 客户端发来的“响应”（对应服务端主动请求）。本服务器不主动发起请求，所以直接忽略：
      // 给它回一条错误在 JSON-RPC 里也是非法的（响应不能被响应）。
      core.log('debug', `ignored client response (this server never sends requests): id=${String(message.id ?? '')}`)
      return null
    }
    return jsonRpcError(request_id_of(message), JSONRPC.INVALID_REQUEST, 'method 必须是字符串')
  }

  const isRequest = isRequestMessage(message)
  const id = request_id_of(message)
  const params = isPlainObject(message.params) ? message.params : message.params === undefined || message.params === null ? {} : null
  if (params === null) {
    return isRequest ? jsonRpcError(id, JSONRPC.INVALID_PARAMS, 'params 必须是一个对象') : null
  }

  const handler = core.methods.get(method)
  if (!handler) {
    if (!isRequest) {
      core.log('debug', `ignored unknown notification: ${method}`)
      return null
    }
    return jsonRpcError(id, JSONRPC.METHOD_NOT_FOUND, `method not found: ${method}`)
  }

  core.state.requests += 1
  let actor = null
  try {
    actor = await core.resolveActor({ method, params }, meta)
  } catch (error) {
    if (AUTH_EXEMPT.has(method)) {
      actor = meta?.actor ?? null
    } else if (!isRequest) {
      core.log('warning', `notification ${method} 被拒绝：${errorMessage(error)}`)
      return null
    } else {
      return errorFor(id, error, core, method)
    }
  }

  try {
    const result = await handler({ core, params, meta: meta ?? {}, method, isRequest, actor })
    if (!isRequest) return null
    return jsonRpcResult(id, result === undefined ? {} : result)
  } catch (error) {
    if (!isRequest) {
      core.log('warning', `notification ${method} 处理失败：${errorMessage(error)}`)
      return null
    }
    return errorFor(id, error, core, method)
  }
}

function errorFor(id, error, core, method) {
  if (error instanceof McpError) return jsonRpcError(id, error.code, error.message, error.data)
  core.log('error', `handler ${method} threw: ${errorMessage(error)}`)
  return jsonRpcError(id, JSONRPC.INTERNAL_ERROR, errorMessage(error, `内部错误：${method} 处理失败`))
}
