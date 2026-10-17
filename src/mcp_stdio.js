#!/usr/bin/env node
/**
 * stdio 传输（stdio transport）+ 独立（不依赖 Harness 进程）的 MCP 服务器装配。
 *
 * 协议格式：换行分隔 JSON（NDJSON），一行一个 JSON-RPC 消息。
 * 约定：
 *  - **stdout 只写协议数据**；日志、警告、就绪提示一律走 stderr。
 *  - 空行忽略；无法 parse 的行忽略并在 stderr 警告（不回 -32700，免得非协议噪声把会话搞乱）。
 *  - 每条消息交给 `src/mcp.js` 的 `handleMcpMessage`，响应一条一行写回 stdout。
 *  - 处理允许并发，写出严格串行并处理背压（drain）。
 *
 * 可被 `node src/mcp_stdio.js` 直接执行，也被包根目录的 `mcp-stdio.mjs` 复用；
 * 同时导出可编程接口 `createStdioTransport({ core, input, output })`，测试可用内存流
 * 驱动（本 harness 的文件沙箱下，用管道捕获子进程输出可能被拒 EPERM）。
 */
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import { KnowledgeStore } from './store.js'
import { createToolDefinitions } from './tools.js'
import { expandPath, loadSettings, normalizeSettings, resolveRoot } from './settings.js'
import { createMcpCore, errorMessage, handleMcpMessage, LOG_LEVELS, SUPPORTED_PROTOCOL_VERSIONS, toMcpTool } from './mcp.js'
import { createMcpHttpHandler, startHttpServer } from './mcp_http.js'

/** 只读工具（`--readonly` 时仍然暴露）。 */
export const READ_TOOL_NAMES = ['kb_search', 'kb_read', 'kb_list']
/** `--readonly` 时 `kb_manage` 仅允许的 action（`export` 会往 exports/ 写文件，故排除）。 */
export const MANAGE_READ_ACTIONS = ['status', 'trash']

const BOOLEAN_FLAGS = new Set(['readonly', 'help', 'allowSetRoot', 'noSession', 'json'])
/** 值可省的开关（`--http` 不带值时用环境变量/随机端口）。 */
const OPTIONAL_VALUE_FLAGS = new Set(['http', 'port'])

export const STDIO_HELP = `dsh-knowledge-base MCP 服务器（stdio / Streamable HTTP）

用法：
  node mcp-stdio.mjs                        # 用 settings.json 的根目录跑 stdio
  node mcp-stdio.mjs --root D:\\KB           # 临时指定根目录（不写回 settings.json）
  node mcp-stdio.mjs --mode api --readonly  # 覆盖向量模式 / 只暴露读工具
  node mcp-stdio.mjs --http 8765 --token <t>  # 改为 Streamable HTTP（POST <path>）

选项（环境变量是缺省值，命令行优先）：
  --root <dir>            KB_ROOT / DSH_KB_ROOT
  --mode <local|llm|api>  KB_VECTOR_MODE
  --readonly              KB_MCP_READONLY=1        禁用写类工具与 kb_manage 写 action
  --allow-set-root        KB_MCP_ALLOW_SET_ROOT=1  允许 kb_manage configure 改根目录（仅内存）
  --http [port]           KB_MCP_PORT              启用 HTTP 传输（此时不读 stdin）
  --bind <host>           KB_MCP_HOST（默认 127.0.0.1）
  --path <route>          KB_MCP_PATH（默认 /mcp）
  --token <secret>        KB_MCP_TOKEN             HTTP 必填；stdio 可选
                                             优先按 kb_manage {action:"token_issue"} 签发的
                                             API token 解析成对应用户身份（RBAC 生效），
                                             解析不到时才把 --token 当静态口令=本机身份
  --no-session            KB_MCP_REQUIRE_SESSION=false  不校验 Mcp-Session-Id
  --name / --version      KB_MCP_NAME / KB_MCP_VERSION
  --log-level <level>     KB_MCP_LOG_LEVEL（默认 warning）
  --instructions <文本>    KB_MCP_INSTRUCTIONS
  --help                  显示本帮助

另外 settings.json 的 mcp 段是全局缺省值（CLI 覆盖它）：
  mcp.allowWrite=false → 等同 --readonly；mcp.allowedOrigins / mcp.allowLocalOrigin /
  mcp.requireToken / mcp.maxTextChars 分别控制跨源、是否需要凭据、单条结果长度上限。

日志全部写 stderr；stdout 只有 NDJSON 协议数据。
`

function camelCaseFlag(name) {
  return name.replace(/-([a-z])/g, (_match, char) => char.toUpperCase())
}

function truthy(value) {
  return value !== undefined && value !== '' && String(value).toLowerCase() !== 'false' && value !== '0'
}

function portOf(value, label = '端口') {
  const text = String(value ?? '').trim()
  if (text === '') return 0
  if (!/^\d+$/.test(text)) throw new Error(`${label}无效：${text}`)
  const port = Number(text)
  if (port > 65535) throw new Error(`${label}超出范围：${port}`)
  return port
}

/**
 * 解析命令行 + 环境变量（纯函数，便于测试）。
 * @param {string[]} argv
 * @param {Record<string, string|undefined>} env
 */
export function parseServerArgs(argv = [], env = process.env) {
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i])
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    const key = camelCaseFlag(eq >= 0 ? arg.slice(2, eq) : arg.slice(2))
    const next = argv[i + 1] === undefined ? '' : String(argv[i + 1])
    let value
    if (eq >= 0) value = arg.slice(eq + 1)
    else if (BOOLEAN_FLAGS.has(key)) {
      const peek = next.toLowerCase()
      if (peek === 'true' || peek === 'false' || peek === '0') {
        value = peek
        i++
      } else {
        value = 'true'
      }
    } else if (OPTIONAL_VALUE_FLAGS.has(key) && (next === '' || next.startsWith('--'))) {
      value = 'true'
    } else {
      if (next === '' || next.startsWith('--')) throw new Error(`--${key} 需要一个值`)
      value = next
      i++
    }
    flags[key] = BOOLEAN_FLAGS.has(key) ? value !== 'false' && value !== '0' && value !== '' : String(value)
  }

  const config = {
    help: Boolean(flags.help),
    root: flags.root ?? env.KB_ROOT ?? env.DSH_KB_ROOT ?? '',
    vectorMode: flags.mode ?? env.KB_VECTOR_MODE ?? '',
    readonly: flags.readonly === true || truthy(env.KB_MCP_READONLY),
    allowSetRoot: flags.allowSetRoot === true || truthy(env.KB_MCP_ALLOW_SET_ROOT),
    name: flags.name ?? env.KB_MCP_NAME ?? 'dsh-knowledge-base',
    version: flags.version ?? env.KB_MCP_VERSION ?? '1.0.0',
    instructions: flags.instructions ?? env.KB_MCP_INSTRUCTIONS ?? '',
    logLevel: flags.logLevel ?? env.KB_MCP_LOG_LEVEL ?? 'warning',
    token: String(flags.token ?? env.KB_MCP_TOKEN ?? '').trim(),
    http: null,
  }

  if (config.vectorMode !== '' && !['local', 'llm', 'api'].includes(config.vectorMode)) {
    throw new Error(`--mode 只能是 local|llm|api，收到 ${config.vectorMode}`)
  }
  if (config.logLevel !== '' && !LOG_LEVELS.includes(config.logLevel)) {
    throw new Error(`--log-level 无效：${config.logLevel}（可用 ${LOG_LEVELS.join(' | ')}）`)
  }

  const httpDisabled = flags.http === 'false'
  const requested = (flags.http !== undefined && !httpDisabled) || (truthy(env.KB_MCP_PORT) && !httpDisabled)
  if (requested) {
    const explicit = typeof flags.http === 'string' && flags.http !== '' && flags.http !== 'true' ? flags.http : ''
    const portValue = explicit !== '' ? explicit : env.KB_MCP_PORT ?? '0'
    const token = String(flags.token ?? env.KB_MCP_TOKEN ?? '').trim()
    if (token === '') {
      throw new Error('HTTP 模式必须提供 --token 或 KB_MCP_TOKEN（否则本机任意进程都能读写知识库）')
    }
    config.http = {
      port: portOf(portValue),
      host: flags.bind ?? env.KB_MCP_HOST ?? '127.0.0.1',
      path: flags.path ?? env.KB_MCP_PATH ?? '/mcp',
      token,
      requireSession: flags.session !== false && flags.session !== 'false' && env.KB_MCP_REQUIRE_SESSION !== 'false',
      allowedOrigins: (flags.allowedOrigins ?? env.KB_MCP_ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    }
  }
  if (flags.noSession) config.http = config.http ? { ...config.http, requireSession: false } : config.http
  return config
}

/** settings.json ← CLI/env 覆盖（只作用于内存，绝不写回 settings.json）。 */
export async function resolveSettings(config = {}) {
  const loaded = await loadSettings({})
  const patch = {}
  const rootInput = String(config.root ?? '').trim()
  if (rootInput !== '') patch.rootDir = expandPath(rootInput)
  if (config.vectorMode) patch.vectorMode = config.vectorMode
  if (config.readonly || loaded.mcp?.allowWrite === false) patch.tools = { allowWrite: false }
  return normalizeSettings({ ...loaded, ...patch })
}

/** `settings.mcp` 是本插件对外暴露 MCP 的总开关与默认值，CLI 覆盖在它之上。 */
export function mcpSurface(settings = {}) {
  const mcp = settings.mcp ?? {}
  return {
    enabled: mcp.enabled !== false,
    http: mcp.http !== false,
    requireToken: mcp.requireToken !== false,
    allowLocalOrigin: mcp.allowLocalOrigin !== false,
    allowedOrigins: Array.isArray(mcp.allowedOrigins) ? mcp.allowedOrigins.filter((item) => String(item).trim() !== '') : [],
    allowWrite: mcp.allowWrite !== false,
    maxTextChars: Number(mcp.maxTextChars) || 0,
  }
}

/**
 * 独立运行时：满足 `createToolDefinitions(store, runtime)` 需要的三件事
 * （settings / status / configure），不依赖 Harness ctx。
 *
 * `configure` 有意只做**内存覆盖**，不写 settings.json；改根目录还要求 `allowSetRoot`。
 */
export function createStandaloneRuntime({ store, settings, readonly = false, allowSetRoot = false, log = () => {} }) {
  let current = settings
  let busy = false

  const runtime = {
    /** 由 createKbMcpServer 在 core 建好后回填，用于 kb_manage 的 mcp_info。 */
    core: null,
    serverOptions: null,
    get settings() {
      return readonly ? { ...current, tools: { ...(current.tools ?? {}), allowWrite: false } } : current
    },
    get packageDir() {
      return resolvePath('.')
    },
    get store() {
      return store
    },
    async status() {
      if (store.configured) {
        try {
          return await store.status()
        } catch (error) {
          return { configured: true, root: store.root, error: errorMessage(error), vectorMode: current.vectorMode, settingsPath: store.settingsPath }
        }
      }
      return {
        configured: false,
        root: '',
        settingsPath: store.settingsPath,
        vectorMode: current.vectorMode,
        chunkSize: current.chunkSize,
        dim: current.vectorDim,
        watch: current.watch,
        message: '知识库根目录尚未配置（独立模式请传 --root <目录> 或写 settings.json）。',
      }
    },
    async configure(patch = {}) {
      if (busy) throw new Error('上一次配置还没结束，请稍后重试')
      busy = true
      try {
        const next = { ...current }
        const applied = []
        const skipped = []
        const set = (key, value) => {
          if (value === undefined) return
          next[key] = value
          applied.push(key)
        }
        set('vectorMode', patch.vectorMode)
        set('chunkSize', patch.chunkSize)
        set('chunkOverlap', patch.chunkOverlap)
        set('vectorDim', patch.vectorDim)
        set('defaultCollection', patch.defaultCollection)
        if (patch.llmProvider !== undefined || patch.llmModel !== undefined) {
          next.llm = { ...(current.llm ?? {}), provider: patch.llmProvider ?? current.llm?.provider, model: patch.llmModel ?? current.llm?.model }
          applied.push('llm')
        }
        if (
          patch.embeddingEndpoint !== undefined ||
          patch.embeddingModel !== undefined ||
          patch.embeddingApiKey !== undefined ||
          patch.embeddingDimensions !== undefined
        ) {
          next.embedding = {
            ...(current.embedding ?? {}),
            endpoint: patch.embeddingEndpoint ?? current.embedding?.endpoint,
            model: patch.embeddingModel ?? current.embedding?.model,
            apiKey: patch.embeddingApiKey ?? current.embedding?.apiKey,
            dimensions: patch.embeddingDimensions !== undefined ? Number(patch.embeddingDimensions) || 0 : current.embedding?.dimensions,
          }
          applied.push('embedding')
        }
        if (patch.watchEnabled !== undefined) {
          next.watch = { ...(current.watch ?? {}), enabled: Boolean(patch.watchEnabled) }
          applied.push('watch')
        }
        const rootInput = String(patch.rootDir ?? '').trim()
        if (rootInput !== '') {
          const target = expandPath(rootInput)
          if (!allowSetRoot) {
            skipped.push('rootDir')
            log('warning', `拒绝修改知识库根目录（服务器未以 --allow-set-root 启动）：${target}`)
          } else {
            if (!isAbsolute(target)) throw new Error('rootDir 必须是绝对路径')
            next.rootDir = target
            applied.push('rootDir')
          }
        }

        Object.assign(current, normalizeSettings(next))
        store.settings = current
        store.root = resolveRoot(current)
        store.indexCache.clear()
        // 根目录/设置变了就重新读安全数据（加密开关、用户目录），与 Host 内行为保持一致。
        if (typeof store.loadSecurity === 'function') {
          try {
            await store.loadSecurity()
          } catch (error) {
            log('warning', `重新加载安全配置失败：${errorMessage(error)}`)
          }
        }
        const status = await runtime.status()
        return { ...status, persisted: false, applied, skipped, note: '改动只在当前 MCP 进程内生效，未写入 settings.json。' }
      } finally {
        busy = false
      }
    },
    /**
     * `kb_manage {action:"mcp_info"}`：告诉调用方这个 MCP 服务器当前的形态，
     * 以及这次调用被解析成了哪个身份（RBAC 开启时尤其重要）。
     */
    async mcpInfo(actor) {
      const core = runtime.core
      const status = await runtime.status()
      return {
        server: core?.serverInfo ?? { name: 'dsh-knowledge-base', version: '1.0.0' },
        protocol: {
          supported: SUPPORTED_PROTOCOL_VERSIONS,
          negotiated: core?.state?.protocolVersion ?? '',
          initialized: Boolean(core?.state?.initialized),
          clientInfo: core?.state?.clientInfo ?? null,
        },
        capabilities: core?.capabilities ?? null,
        transport: core?.state?.transport ?? null,
        tools: (core?.tools ?? []).map((tool) => tool.name),
        resources: { catalog: 'kb://catalog', documents: 'kb://<collection>/<id>', count: Number(status.docs) || 0 },
        prompts: ['kb-search'],
        instructions: core?.instructions ?? '',
        readonly: Boolean(readonly),
        settings: { persisted: false, rootDir: current.rootDir ?? '', vectorMode: current.vectorMode },
        whoami: typeof actor?.describe === 'function' ? actor.describe() : actor ?? null,
      }
    },
  }
  return runtime
}

/**
 * 运行时 + 工具集一起返回（`createKbMcpServer` 需要 runtime 来回填 core，供 mcp_info 用）。
 *
 * 直接复用 `createToolDefinitions(store, runtime)`，再用 `toMcpTool` 把 Harness 的
 * `{ name, description, parameters, output, execute }` 转成 MCP 的
 * `{ name, description, inputSchema, handler }`：参数与返回语义完全一致。
 *
 * @param {{ store: KnowledgeStore, settings: object, readonly?: boolean, allowSetRoot?: boolean, log?: Function }} input
 */
export function createKbToolkit({ store, settings, readonly = false, allowSetRoot = false, log = () => {} }) {
  const runtime = createStandaloneRuntime({ store, settings, readonly, allowSetRoot, log })
  const tools = []
  for (const definition of createToolDefinitions(store, runtime)) {
    if (readonly && definition.name === 'kb_manage') {
      const tool = toMcpTool(definition, {
        transformHandler: (handler) => async (args, actor, context) => {
          const action = String(args?.action ?? '')
          if (!MANAGE_READ_ACTIONS.includes(action)) {
            throw new Error(`只读模式：kb_manage 只支持 ${MANAGE_READ_ACTIONS.join(' / ')}，收到 action="${action || '(空)'}"`)
          }
          return handler(args, actor, context)
        },
      })
      tool.inputSchema = {
        ...tool.inputSchema,
        properties: { ...(tool.inputSchema.properties ?? {}), action: { ...(tool.inputSchema.properties?.action ?? {}), enum: MANAGE_READ_ACTIONS } },
      }
      tool.description = `${definition.description}（本服务器以只读模式启动：kb_manage 仅支持 ${MANAGE_READ_ACTIONS.join(' / ')}）`
      tool.annotations = { ...(tool.annotations ?? {}), readOnlyHint: true, destructiveHint: false }
      tools.push(tool)
      continue
    }
    if (readonly && !READ_TOOL_NAMES.includes(definition.name)) continue
    const tool = toMcpTool(definition)
    if (tool.annotations) tool.annotations = { ...tool.annotations, readOnlyHint: readonly ? true : tool.annotations.readOnlyHint }
    tools.push(tool)
  }
  return { runtime, tools }
}

/**
 * 构建与插件 Agent 工具语义一致的 MCP 工具集（只要工具时用这个）。
 * @returns {Array<object>} MCP tool 描述数组
 */
export function buildKbTools(options) {
  return createKbToolkit(options).tools
}

/** 一行就绪信息：root 路径 + 文档数（供 stderr 打印，内容不含换行）。 */
export async function readyLine(store, settings, { transport = 'stdio', readonly = false, extra = '' } = {}) {
  let docs = 0
  let root = store?.root ?? ''
  if (store?.configured) {
    try {
      const status = await store.status()
      docs = Number(status.docs) || 0
      root = status.root ?? root
    } catch {
      docs = 0
    }
  }
  return [
    `[mcp] 就绪 transport=${transport}`,
    `root=${root || '(未配置)'}`,
    `docs=${docs}`,
    `mode=${settings?.vectorMode ?? 'local'}`,
    `tools=${readonly ? 'read-only' : 'read+write'}`,
    extra,
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * stdio 传输：NDJSON 行 ↔ `handleMcpMessage`。
 *
 * @param {{ core: object, input?: import('node:stream').Readable, output?: import('node:stream').Writable, log?: Function }} options
 */
export function createStdioTransport(options = {}) {
  const core = options.core
  if (!core) throw new Error('createStdioTransport 需要 core')
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const log = options.log ?? ((level, data, line) => process.stderr.write(`${line ?? `[mcp:${level}] ${data}`}\n`))

  let buffer = ''
  let writeChain = Promise.resolve()
  let running = false
  let startPromise = null
  const inFlight = new Set()

  const send = (value) => {
    let line
    try {
      line = `${JSON.stringify(value)}\n`
    } catch (error) {
      log('error', `响应无法序列化，已丢弃：${errorMessage(error)}`)
      return writeChain
    }
    writeChain = writeChain.then(async () => {
      try {
        if (output.writableEnded || output.destroyed) return
        if (output.write(line) === false) await new Promise((resolveDrain) => output.once('drain', resolveDrain))
      } catch (error) {
        log('warning', `写 stdout 失败：${errorMessage(error)}`)
      }
    })
    return writeChain
  }

  const handleLine = async (rawLine) => {
    const text = String(rawLine ?? '').replace(/\r$/, '').trim()
    if (text === '') return null
    let message
    try {
      message = JSON.parse(text)
    } catch (error) {
      log('warning', `忽略非 JSON 行：${text.slice(0, 160)}（${errorMessage(error)}）`)
      return null
    }
    try {
      const reply = await handleMcpMessage(core, message, { transport: 'stdio', input, output })
      if (reply !== null && reply !== undefined) await send(reply)
      return reply ?? null
    } catch (error) {
      log('error', `消息处理崩溃：${errorMessage(error)}`)
      const id = typeof message?.id === 'string' || typeof message?.id === 'number' ? message.id : null
      if (id !== null) await send({ jsonrpc: '2.0', id, error: { code: -32603, message: `内部错误：${errorMessage(error)}` } })
      return null
    }
  }

  const flushTail = () => {
    if (buffer.trim() === '') return
    const tail = buffer
    buffer = ''
    transport.lines += 1
    track(handleLine(tail))
  }

  const track = (task) => {
    const wrapped = task.finally(() => inFlight.delete(wrapped))
    inFlight.add(wrapped)
    return wrapped
  }

  const drain = async () => {
    for (let guard = 0; inFlight.size > 0 && guard < 1000; guard++) await Promise.allSettled([...inFlight])
    await writeChain
  }

  const transport = {
    core,
    lines: 0,
    get running() {
      return running
    },
    get pending() {
      return inFlight.size
    },
    /** 处理一行并返回响应（测试可同步驱动）。 */
    handleLine,
    send,
    /** 喂入原始文本，自动按行切分（可跨 chunk 边界）；返回本次完整处理的行数。 */
    feed(chunk) {
      buffer += typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      let count = 0
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        transport.lines += 1
        count++
        track(handleLine(line))
        index = buffer.indexOf('\n')
      }
      return count
    },
    /** 等待当前所有在途消息处理完（不改状态）。 */
    drain,
    /** 开始读输入；返回的 promise 在输入结束且所有在途消息写回后 resolve。 */
    start() {
      if (startPromise) return startPromise
      running = true
      try {
        input.setEncoding?.('utf8')
      } catch {
        /* ignore */
      }
      let settle = () => {}
      startPromise = new Promise((resolveStart) => {
        settle = resolveStart
      })
      const finish = async (error) => {
        if (!running) return
        running = false
        input.off?.('data', onData)
        input.off?.('end', onEnd)
        input.off?.('error', onEnd)
        if (error) log('warning', `输入流错误：${errorMessage(error)}`)
        flushTail()
        await drain()
        settle()
      }
      const onData = (chunk) => transport.feed(chunk)
      const onEnd = (error) => {
        void finish(error)
      }
      input.on?.('data', onData)
      input.on?.('end', onEnd)
      input.on?.('error', onEnd)
      input.resume?.()
      if (input.readableEnded) void finish()
      return startPromise
    },
    stop() {
      try {
        input.pause?.()
        input.removeAllListeners?.('data')
        input.removeAllListeners?.('end')
      } catch {
        /* ignore */
      }
      running = false
    },
  }

  return transport
}

/**
 * 装配一个完整的核心（settings → store → runtime/tools → core）；stdio / HTTP 两种传输共用。
 *
 * @param {object} [options] parseServerArgs 的结果，或直接注入 `{ store, settings, log }`
 * @param {object} [options.actor] 固定身份（Actor 或 `{name,role,via,scopes}`）：stdio 的 `--token` 走这里
 * @param {string} [options.transport] 'stdio' | 'http'，只用于 mcp_info 与日志
 */
export async function createKbMcpServer(options = {}) {
  const log = options.log ?? ((level, data, line) => process.stderr.write(`${line ?? `[mcp:${level}] ${data}`}\n`))
  const settings = options.settings ?? (await resolveSettings(options))
  const store = options.store ?? new KnowledgeStore(settings, null)
  if (store.configured) {
    try {
      await store.init()
    } catch (error) {
      store.lastError = errorMessage(error)
      log('warning', `store.init 失败：${store.lastError}`)
    }
  }
  const readonly = Boolean(options.readonly) || settings.mcp?.allowWrite === false
  const toolkit = createKbToolkit({ store, settings, readonly, allowSetRoot: Boolean(options.allowSetRoot), log })
  const actor = options.actor ?? null
  const core = createMcpCore({
    store,
    tools: toolkit.tools,
    serverInfo: {
      name: options.name || 'dsh-knowledge-base',
      version: options.version || '1.0.0',
      title: 'Local Knowledge Base (dsh-knowledge-base)',
    },
    instructions: options.instructions || undefined,
    authorize: options.authorize,
    resolveActor: actor ? () => actor : options.resolveActor,
    logLevel: options.logLevel || 'warning',
    maxTextChars: Number(options.maxTextChars ?? settings.mcp?.maxTextChars) || 0,
    log,
    onInitialize: options.onInitialize,
  })
  core.state.transport = options.transport ?? 'stdio'
  core.state.actorIdentity = actor ? (typeof actor.describe === 'function' ? actor.describe() : actor) : null
  toolkit.runtime.core = core
  toolkit.runtime.serverOptions = { transport: options.transport ?? 'stdio', readonly, logLevel: core.state.logLevel }
  return { core, store, settings, runtime: toolkit.runtime, tools: toolkit.tools, readonly, log, actor }
}

/**
 * 启动 stdio 服务器：返回 `{ core, store, settings, transport, done, stop }`。
 * `done` 在 stdin 结束（客户端断开）时 resolve，进程随后自然退出。
 */
export async function runStdioServer(options = {}) {
  let serverRef = null
  const settings = options.settings ?? (await resolveSettings(options))
  const store = options.store ?? new KnowledgeStore(settings, null)
  if (store.configured) {
    try {
      await store.init()
    } catch (error) {
      store.lastError = errorMessage(error)
    }
  }
  // stdio 进程 = 一个固定身份：--token 若能对上 kb_manage token_issue 签发的 API token，
  // 整个进程就以那个用户/角色运行（RBAC 生效）；否则保持本机身份。
  const actor = options.actor ?? (await resolveStartupActor(store, options.token ?? options.http?.token ?? '', options.log ?? (() => {})))
  const server = await createKbMcpServer({
    ...options,
    settings,
    store,
    actor,
    transport: 'stdio',
    onInitialize:
      options.onInitialize ??
      (async () => {
        const line = await readyLine(serverRef?.store, serverRef?.settings, {
          transport: 'stdio',
          readonly: serverRef?.readonly,
          extra: actor ? `as=${actor.name ?? ''}/${actor.role ?? ''}` : '',
        })
        process.stderr.write(`${line}\n`)
      }),
  })
  serverRef = server
  const transport = createStdioTransport({ core: server.core, input: options.input, output: options.output, log: server.log })
  server.transport = transport
  if (!server.store.configured) {
    server.log('warning', '知识库根目录未配置：请传 --root <目录> 或写 settings.json；工具会返回“根目录尚未配置”。')
  }
  server.done = transport.start()
  server.stop = () => transport.stop()
  return server
}

/**
 * 启动 Streamable HTTP 服务器（node:http 独立可跑，不依赖 Harness）。
 *
 * 两个 authorize 签名不同，别混用：
 *  - HTTP 层 `authorize(token, req) => actor|null` —— 只给 createMcpHttpHandler；
 *  - 核心层 `authorize(info) => actor|null` —— 只给 createMcpCore，用 `options.coreAuthorize` 传。
 * actor 由 HTTP 层放进 `meta.actor`，核心通过默认 resolveActor 取到并传给 handler。
 */
export async function runHttpServer(options = {}) {
  const config = options.http ?? {}
  const server = await createKbMcpServer({ ...options, authorize: options.coreAuthorize, transport: 'http' })
  const surface = mcpSurface(server.settings)
  const rbacOn = Boolean(server.store.directory?.enabled)
  // 凭据优先按插件的 API token 解析（每个客户端一个身份/角色/scopes），
  // 静态 --token 只在没有对应 API token 时兜底为本机身份。
  const authorize =
    options.authorize ??
    (config.token || rbacOn || surface.requireToken ? storeTokenAuthorize(server.store, { fallbackToken: config.token ?? '', log: server.log }) : null)
  const handler =
    options.handler ??
    createMcpHttpHandler({
      core: server.core,
      authorize,
      allowedOrigins: config.allowedOrigins?.length ? config.allowedOrigins : surface.allowedOrigins,
      allowSameOrigin: config.allowSameOrigin ?? surface.allowLocalOrigin,
      requireSession: config.requireSession !== false,
      log: server.log,
    })
  const http = await startHttpServer({ handler, port: config.port ?? 0, host: config.host ?? '127.0.0.1', path: config.path ?? '/mcp', log: server.log })
  if (authorize && !config.token && !rbacOn) {
    server.log(
      'warning',
      '已按 settings.mcp.requireToken=true 强制凭据，但既没有 --token，用户目录也未启用/签发 token：所有请求都会得到 401。' +
        '请传 --token（或 KB_MCP_TOKEN），或用 kb_manage {action:"token_issue"} 给客户端签发 API token。',
    )
  }
  server.http = http
  server.handler = handler
  server.stop = () => http.close()
  const line = await readyLine(server.store, server.settings, {
    transport: 'http',
    readonly: server.readonly,
    extra: `url=http://${http.host}:${http.port}${http.path} auth=${authorize ? (config.token ? 'static-token+api-token' : 'api-token(rbac)') : 'none'}`,
  })
  process.stderr.write(`${line}\n`)
  return server
}

/**
 * 把 `--token` 变成 HTTP 层 authorize 回调 `(token, req) => actor|null`（定长时间比较）。
 * 容错：若被误当核心层 `authorize(info)` 调用（第一个参数是对象），直接沿用 HTTP 层
 * 已经解析好的 actor，避免签名混用把请求全变成 -32001。
 */
export function bearerAuthorize(token) {
  const expected = Buffer.from(String(token ?? ''), 'utf8')
  const ok = (value) => {
    const given = Buffer.from(String(value ?? ''), 'utf8')
    if (given.length !== expected.length) return null
    let diff = 0
    for (let i = 0; i < given.length; i++) diff |= given[i] ^ expected[i]
    if (diff !== 0) return null
    return { name: 'mcp-token', transport: 'http' }
  }
  return (candidate, _request) => {
    if (candidate !== null && typeof candidate === 'object') {
      if (candidate.actor) return candidate.actor
      return ok(candidate.token ?? '')
    }
    return ok(candidate)
  }
}

/**
 * 让 MCP 客户端的凭据解析成**插件自己的身份（Actor）**，从而复用同一套 RBAC / 集合授权。
 *
 * 顺序：
 *  1. `store.directory.resolveToken(secret)` —— `kb_manage {action:"token_issue"}` 签发的 API token，
 *     身份、角色与 scopes 由用户目录决定（只读 token 的写操作会被 ForbiddenError 拒绝）；
 *  2. 静态 `--token` / `KB_MCP_TOKEN` 匹配 —— 视为**本机身份**（`directory.localActor()`）；
 *  3. 都不匹配 → null（HTTP 层 401，核心层 -32001）。
 *
 * 兼容旧版 store（没有 `directory`）时退化成 bearerAuthorize 的行为。
 *
 * @param {KnowledgeStore} store
 * @param {{ fallbackToken?: string, log?: Function }} [options]
 * @returns {(credential: string|null, req?: object) => Promise<object|null>}
 */
export function storeTokenAuthorize(store, options = {}) {
  const fallback = Buffer.from(String(options.fallbackToken ?? ''), 'utf8')
  const log = options.log ?? (() => {})
  const sameSecret = (value) => {
    const given = Buffer.from(String(value ?? ''), 'utf8')
    if (fallback.length === 0 || given.length !== fallback.length) return false
    let diff = 0
    for (let i = 0; i < given.length; i++) diff |= given[i] ^ fallback[i]
    return diff === 0
  }
  return async (credential, _request) => {
    let secret = ''
    if (credential !== null && typeof credential === 'object') {
      // 被核心层当成 authorize(info) 调用：传输层已经解析过凭据，直接沿用它的 actor。
      if (credential.actor) return credential.actor
      secret = String(credential.token ?? '')
    } else {
      secret = String(credential ?? '')
    }
    if (secret === '') return null
    if (typeof store?.directory?.resolveToken === 'function') {
      try {
        const actor = await store.directory.resolveToken(secret)
        if (actor) return actor
      } catch (error) {
        log('warning', `解析 API token 失败：${errorMessage(error)}`)
      }
    }
    if (sameSecret(secret)) {
      if (typeof store?.directory?.localActor === 'function') return store.directory.localActor()
      return { name: 'mcp-token', transport: 'http' }
    }
    return null
  }
}

/**
 * stdio 模式下 `--token` 的含义：整个进程用这个凭据解析出的身份运行，
 * 否则远程客户端会退化成“本机 owner”，RBAC 与集合授权就形同虚设。
 * 解析不出来时返回 null（保持本机身份）并给出警告。
 */
export async function resolveStartupActor(store, token, log = () => {}) {
  const secret = String(token ?? '').trim()
  if (secret === '') return null
  try {
    const actor = await store?.directory?.resolveToken?.(secret)
    if (actor) return actor
  } catch (error) {
    log('warning', `stdio 身份解析失败：${errorMessage(error)}`)
    return null
  }
  log('warning', 'stdio 的 --token 没匹配到 kb_manage token_issue 签发的 API token；本进程将以本机身份运行。')
  return null
}

function isDirectExecution(metaUrl) {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return metaUrl === pathToFileURL(entry).href
  } catch {
    return false
  }
}

/**
 * CLI 入口：`node src/mcp_stdio.js` 或包根目录的 `mcp-stdio.mjs`。
 * stdio 模式在 stdin 结束时 resolve；http 模式持续服务。
 */
export async function main(argv = process.argv.slice(2), env = process.env) {
  let config
  try {
    config = parseServerArgs(argv, env)
  } catch (error) {
    process.stderr.write(`${errorMessage(error, '参数错误')}\n\n${STDIO_HELP}`)
    process.exitCode = 2
    return null
  }
  if (config.help) {
    process.stdout.write(STDIO_HELP)
    return null
  }
  if (config.http) return runHttpServer(config)
  const server = await runStdioServer(config)
  await server.done
  return server
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[mcp] 致命错误：${errorMessage(error)}\n`)
    process.exitCode = 1
  })
}
