/**
 * Host half of dsh-knowledge-base.
 *
 * Responsibilities:
 *  - load settings (settings.json ← bundle row config) and own the store
 *  - keep the encryption key ring and the user directory loaded next to the root
 *  - register the six kb_* tools for every agent in this profile
 *  - inject a short, always-current system-prompt section
 *  - watch the inbox folder
 *  - serve the same-origin JSON API used by the Web panel (/kb-api)
 *  - mount the MCP endpoint for external clients (/kb-mcp)
 */
import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KnowledgeStore } from './src/store.js'
import { createToolDefinitions } from './src/tools.js'
import { createApiHandler } from './src/api.js'
import { startWatcher } from './src/watcher.js'
import { expandPath, loadSettings, resolveRoot, saveSettings } from './src/settings.js'
import { createMcpCore } from './src/mcp.js'
import { buildKbTools, mcpSurface, readyLine } from './src/mcp_stdio.js'
import { mountMcpHttp } from './src/mcp_http.js'

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))
const MCP_PATH = '/kb-mcp'

/**
 * The stdio config handed to external clients must point at a real Node
 * binary. Inside the packaged app `process.execPath` is the Electron shell, so
 * prefer an explicit override, then `node` on PATH, then fall back to the
 * shell with ELECTRON_RUN_AS_NODE (which behaves like node).
 */
function resolveNodeCommand() {
  const explicit = String(process.env.DSH_KB_NODE ?? '').trim()
  if (explicit && existsSync(explicit)) return { command: explicit.replace(/\\/g, '/'), env: null, kind: 'override' }
  if (!process.versions?.electron) return { command: process.execPath.replace(/\\/g, '/'), env: null, kind: 'node' }
  const binary = process.platform === 'win32' ? 'node.exe' : 'node'
  for (const dir of String(process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, binary)
    if (existsSync(candidate)) return { command: candidate.replace(/\\/g, '/'), env: null, kind: 'node-on-path' }
  }
  return {
    command: process.execPath.replace(/\\/g, '/'),
    env: { ELECTRON_RUN_AS_NODE: '1' },
    kind: 'electron-as-node',
  }
}

export const inject = ['tools']

export async function apply(ctx, config = {}) {
  let settings = await loadSettings(config)
  const store = new KnowledgeStore(settings, ctx)
  store.patchConfig = config

  let stopWatch = () => {}
  let summary = ''
  let configuring = false
  let mcpMounted = null

  const restartWatch = () => {
    try {
      stopWatch()
    } catch {
      /* ignore */
    }
    stopWatch = () => {}
    try {
      stopWatch = startWatcher({ store, settings })
    } catch (error) {
      console.error(`[dsh-knowledge-base] watcher: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const refreshSummary = async () => {
    if (!store.configured) {
      summary = [
        '## 本地知识库（未配置）',
        'dsh-knowledge-base 已安装，但知识库根目录为空。需要时调用 kb_manage {action:"configure", rootDir:"..."}，或请用户在 设置 → 知识库 中指定目录。',
      ].join('\n')
      return
    }
    try {
      const status = await store.status()
      const collections = (status.collections ?? [])
        .filter((c) => c.docs > 0)
        .map((c) => `${c.name}(${c.docs})`)
        .join(', ')
      const security = status.security ?? {}
      const lines = [
        '## 本地知识库（dsh-knowledge-base）',
        `根目录：${status.root}；规模：${status.docs} 篇 / ${status.chunks} 块；集合：${collections || '（空）'}；向量：${status.vectorMode}。`,
      ]
      if (security.encryption?.enabled) {
        lines.push(
          security.locked
            ? `状态：已加密且当前锁定 —— 所有 kb_* 读取都会失败，需要用户在 设置 → 知识库 → 安全 输入口令解锁（或设置 DSH_KB_PASSPHRASE）。不要试图猜测内容。`
            : `状态：静态加密已开启（${security.encryption.algorithm}），元数据${security.encryption.metadata === 'encrypted' ? '也已加密' : '仍为明文'}。`,
        )
      }
      if (security.access?.enabled) {
        lines.push(`多用户权限已开启：本机身份 ${security.actor?.name ?? '本机'}（角色 ${security.actor?.role ?? 'owner'}）；外部调用需 API Token。`)
      }
      lines.push('用法：先用 kb_search 检索（不要凭记忆猜测项目细节）；需要全文用 kb_read；可复用的新知识用 kb_add；配置、重建索引、回收站、加密与用户授权用 kb_manage。')
      lines.push(`任何模型也可以直接读 ${status.root}\\CATALOG.md 与 docs/<id>.md，或在插件目录运行 node kb.mjs。`)
      lines.push(`外部 MCP 客户端：stdio 用 node ${PACKAGE_DIR.replace(/\\/g, '\\')}\\mcp-stdio.mjs；HTTP 端点 ${MCP_PATH}。`)
      summary = lines.join('\n')
    } catch (error) {
      const locked = store.locked
      summary = [
        '## 本地知识库（dsh-knowledge-base）',
        locked
          ? '知识库已加密锁定：请先在 设置 → 知识库 → 安全 输入口令解锁，不要尝试猜测内容。'
          : `读取状态失败：${error instanceof Error ? error.message : String(error)}`,
      ].join('\n')
    }
  }

  store.onChange = () => {
    void refreshSummary()
  }

  const runtime = {
    get settings() {
      return settings
    },
    get packageDir() {
      return PACKAGE_DIR
    },
    /** Re-read settings + security and refresh the prompt after any change. */
    async touch() {
      settings = await loadSettings(config)
      store.settings = settings
      store.root = resolveRoot(settings)
      await store.loadSecurity()
      restartWatch()
      await refreshSummary()
      return runtime.status()
    },
    async status() {
      if (store.configured) {
        try {
          return await store.status()
        } catch (error) {
          return {
            configured: true,
            root: store.root,
            locked: store.locked,
            error: error instanceof Error ? error.message : String(error),
            vectorMode: settings.vectorMode,
            settingsPath: store.settingsPath,
            security: { encryption: store.crypto.status(), locked: store.locked, access: store.directory.status() },
          }
        }
      }
      return {
        configured: false,
        root: '',
        settingsPath: store.settingsPath,
        vectorMode: settings.vectorMode,
        watch: settings.watch,
        chunkSize: settings.chunkSize,
        dim: settings.vectorDim,
        security: { encryption: { enabled: false, unlocked: false, locked: false }, locked: false, access: { enabled: false, users: [] } },
        message: '知识库根目录尚未配置。请选择目录或调用 kb_manage configure。',
      }
    },
    async configure(patch = {}) {
      if (configuring) throw new Error('配置正在保存，请稍后重试')
      configuring = true
      try {
        const next = {}
        if (patch.rootDir !== undefined && String(patch.rootDir).trim() !== '') next.rootDir = String(patch.rootDir).trim()
        if (patch.vectorMode !== undefined) next.vectorMode = patch.vectorMode
        if (patch.chunkSize !== undefined) next.chunkSize = patch.chunkSize
        if (patch.chunkOverlap !== undefined) next.chunkOverlap = patch.chunkOverlap
        if (patch.vectorDim !== undefined) next.vectorDim = patch.vectorDim
        if (patch.defaultCollection !== undefined) next.defaultCollection = patch.defaultCollection
        if (patch.llmProvider !== undefined || patch.llmModel !== undefined) {
          next.llm = {}
          if (patch.llmProvider !== undefined) next.llm.provider = patch.llmProvider
          if (patch.llmModel !== undefined) next.llm.model = patch.llmModel
        }
        if (patch.embeddingEndpoint !== undefined || patch.embeddingModel !== undefined || patch.embeddingApiKey !== undefined) {
          next.embedding = {}
          if (patch.embeddingEndpoint !== undefined) next.embedding.endpoint = patch.embeddingEndpoint
          if (patch.embeddingModel !== undefined) next.embedding.model = patch.embeddingModel
          if (patch.embeddingApiKey !== undefined) next.embedding.apiKey = patch.embeddingApiKey
        }
        if (patch.watchEnabled !== undefined) next.watch = { enabled: Boolean(patch.watchEnabled) }
        if (patch.tools !== undefined && patch.tools !== null) {
          next.tools = { allowWrite: patch.tools.allowWrite !== false }
        }
        if (patch.embeddingDimensions !== undefined) {
          next.embedding = { ...(next.embedding ?? {}), dimensions: Number(patch.embeddingDimensions) || 0 }
        }
        if (patch.security !== undefined && patch.security !== null) {
          const security = patch.security ?? {}
          next.security = {}
          if (security.metadata !== undefined) next.security.metadata = security.metadata === 'encrypted' ? 'encrypted' : 'plain'
          if (security.autoUnlockEnv !== undefined) next.security.autoUnlockEnv = Boolean(security.autoUnlockEnv)
          if (security.rbac !== undefined) {
            const rbac = security.rbac ?? {}
            next.security.rbac = { enabled: Boolean(rbac.enabled), localRole: rbac.localRole ?? 'owner' }
          }
        }
        if (patch.mcp !== undefined && patch.mcp !== null) {
          const mcp = patch.mcp ?? {}
          next.mcp = {}
          for (const key of ['enabled', 'http', 'requireToken', 'allowLocalOrigin', 'allowWrite']) {
            if (mcp[key] !== undefined) next.mcp[key] = Boolean(mcp[key])
          }
          if (Array.isArray(mcp.allowedOrigins)) next.mcp.allowedOrigins = mcp.allowedOrigins.map((item) => String(item).trim()).filter(Boolean)
        }
        if (next.rootDir) {
          const target = expandPath(next.rootDir)
          try {
            await mkdir(target, { recursive: true })
            next.rootDir = target
          } catch (error) {
            throw new Error(`无法创建知识库目录 ${target}：${error instanceof Error ? error.message : String(error)}`)
          }
        }

        settings = await saveSettings(next, config)
        store.settings = settings
        store.root = resolveRoot(settings)
        store.indexCache.clear()
        store.lastError = ''
        await store.loadSecurity()
        if (store.configured && !store.locked) await store.init()
        restartWatch()
        remountMcp()
        await refreshSummary()
        return await runtime.status()
      } finally {
        configuring = false
      }
    },
    async refresh() {
      settings = await loadSettings(config)
      store.settings = settings
      store.root = resolveRoot(settings)
      store.indexCache.clear()
      await store.loadSecurity()
      restartWatch()
      remountMcp()
      await refreshSummary()
    },
    /** What the Web panel shows for the MCP surface. */
    mcpInfo(actor = null) {
      const webServer = ctx.get('webServer')
      let origin = ''
      try {
        origin = typeof webServer?.getOrigin === 'function' ? webServer.getOrigin() : ''
      } catch {
        origin = ''
      }
      const node = resolveNodeCommand()
      const entry = `${PACKAGE_DIR}\\mcp-stdio.mjs`.replace(/\\/g, '/')
      const stdioConfig = {
        mcpServers: {
          'dsh-knowledge-base': {
            command: node.command,
            args: [entry],
            ...(node.env ? { env: node.env } : {}),
          },
        },
      }
      const httpConfig = {
        mcpServers: {
          'dsh-knowledge-base': {
            url: origin ? `${origin.replace(/\/$/, '')}${MCP_PATH}` : MCP_PATH,
            transport: 'streamable-http',
            headers: { Authorization: 'Bearer <在 设置 → 知识库 → 安全 里签发的 Token>' },
          },
        },
      }
      return {
        enabled: settings.mcp.enabled !== false,
        httpMounted: Boolean(mcpMounted),
        path: MCP_PATH,
        origin,
        url: origin ? `${origin.replace(/\/$/, '')}${MCP_PATH}` : '',
        packageDir: PACKAGE_DIR,
        stdioEntry: entry,
        node,
        readonly: !settings.mcp.allowWrite,
        requireToken: settings.mcp.requireToken !== false,
        allowLocalOrigin: settings.mcp.allowLocalOrigin !== false,
        allowedOrigins: settings.mcp.allowedOrigins ?? [],
        tools: ['kb_search', 'kb_read', 'kb_list', 'kb_add', 'kb_import', 'kb_manage'],
        stdioConfig,
        httpConfig,
        note:
          node.kind === 'electron-as-node'
            ? '未在 PATH 找到 node，stdio 配置改用 Harness 自带程序 + ELECTRON_RUN_AS_NODE=1（等价于 node）。若客户端不接受，请安装 Node 22+ 或设置 DSH_KB_NODE=<node 绝对路径>。'
            : 'stdio 进程独立读取 settings.json，不需要 Harness 在跑；HTTP 端点复用当前会话的身份与权限。',
      }
    },
    summary: () => summary,
  }

  for (const definition of createToolDefinitions(store, runtime)) {
    ctx.effect(() => ctx.tools.register(definition))
  }

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    ctx.effect(() =>
      systemPrompt.section({
        name: 'knowledge-base',
        order: 56,
        text: () => summary,
      }),
    )
  }

  const webServer = ctx.get('webServer')
  if (webServer && typeof webServer.register === 'function') {
    ctx.effect(() =>
      webServer.register({
        kind: 'prefix',
        path: '/kb-api',
        handler: createApiHandler({ getStore: () => store, runtime, mcpInfo: (actor) => runtime.mcpInfo(actor) }),
      }),
    )
  }

  /** Rebuild the MCP core from the current settings and mount it on /kb-mcp. */
  function remountMcp() {
    if (mcpMounted) {
      try {
        mcpMounted()
      } catch {
        /* ignore */
      }
      mcpMounted = null
    }
    if (!webServer || typeof webServer.register !== 'function') return
    if (settings.mcp.enabled === false || settings.mcp.http === false) return
    const surface = mcpSurface(settings)
    const core = createMcpCore({
      store,
      serverInfo: { name: 'dsh-knowledge-base', title: 'DSH Knowledge Base', version: '1.1.0' },
      instructions: '本地 Markdown 知识库。检索用 kb_search，读全文用 kb_read，写入用 kb_add/kb_import，运维与安全用 kb_manage。',
      tools: buildKbTools({ store, settings, readonly: surface.allowWrite === false }),
      maxTextChars: surface.maxTextChars,
      log: (level, data, line) => console.warn(line ?? `[dsh-knowledge-base:mcp:${level}] ${data ?? ''}`),
    })
    runtime.core = core
    // Token → that user's actor. GUI same-origin traffic acts as the local
    // owner (unless allowLocalOrigin is off); origin-less external clients
    // need a token while requireToken is on.
    const authorize = async (token, req) => {
      if (token) return store.directory.resolveToken(token)
      const origin = String(req?.headers?.origin ?? '').trim()
      if (origin) {
        let same = false
        try {
          same = new URL(origin).host === String(req.headers.host ?? '')
        } catch {
          same = false
        }
        return same && settings.mcp.allowLocalOrigin !== false ? store.directory.localActor() : null
      }
      return settings.mcp.requireToken === false ? store.directory.localActor() : null
    }
    try {
      mcpMounted = mountMcpHttp(webServer, {
        core,
        authorize,
        path: MCP_PATH,
        allowSameOrigin: settings.mcp.allowLocalOrigin !== false,
        allowedOrigins: surface.allowedOrigins,
        requireSession: true,
        log: (level, data, line) => console.warn(line ?? `[dsh-knowledge-base:mcp:${level}] ${data ?? ''}`),
      })
      void readyLine(store, settings, { transport: 'http', extra: MCP_PATH }).then((line) => console.log(`[dsh-knowledge-base] ${line}`))
    } catch (error) {
      console.error(`[dsh-knowledge-base] MCP 挂载失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  remountMcp()
  ctx.effect(() => () => {
    try {
      if (typeof mcpMounted === 'function') mcpMounted()
    } catch {
      /* ignore */
    }
    mcpMounted = null
  })

  ctx.effect(() => () => {
    try {
      stopWatch()
    } catch {
      /* ignore */
    }
  })

  try {
    await store.loadSecurity()
    if (store.configured && !store.locked) await store.init()
  } catch (error) {
    store.lastError = error instanceof Error ? error.message : String(error)
    console.error(`[dsh-knowledge-base] init: ${store.lastError}`)
  }
  restartWatch()
  await refreshSummary()
}
