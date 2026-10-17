/**
 * Streamable HTTP 传输（MCP），零依赖，只用 node 内置模块 —— 因此既能挂进
 * Harness 的 `webServer.register({ kind: 'prefix', path: '/mcp', handler })`，
 * 也能被 `node mcp-stdio.mjs --http <port>` 用 `node:http` 独立跑。
 *
 * 关于 SSE（simplified，故意保守）：
 *  - MCP 的 Streamable HTTP 允许服务端在 `POST` 的响应里**直接回 `application/json`**
 *    （只有需要流式/多消息时才用 `text/event-stream`）。客户端即使 `Accept` 里带
 *    `text/event-stream`，本实现仍然回 JSON —— 这是规范允许的简化。
 *  - 因此不实现 `GET` 的服务端通知流：`GET` 一律 405（带 `allow: POST, DELETE, GET`）。
 *  - `DELETE` 表示会话终止；本服务器是无状态的，只记 session id 集合，所以回 410 并说明。
 *  - 批量（JSON 数组）逐个处理并回数组；若全是通知则 202 空响应。
 *
 * 鉴权与 Origin：
 *  - `authorize(token, req) => actor | null`：token 取自 `Authorization: Bearer <t>` 或 `X-Api-Key`。
 *    没有凭据或不通过 → 401 + `www-authenticate: Bearer`。不传 `authorize` 即不校验（仅适合
 *    同源/回环地址场景，调用方自己负责）。
 *  - `Origin` 校验：无 Origin 放行；默认只允许同源（`allowSameOrigin`），可用 `allowedOrigins`
 *    精确列表放宽。不匹配 → 403。
 *  - `Mcp-Session-Id`：`requireSession`（默认 true）时，`initialize` 的响应会生成一个随机 id
 *    并回显；后续请求必须携带同一个 id，否则 400。
 *  - `MCP-Protocol-Version`：响应里会回显协商到的版本；请求侧**不强制**要求携带
 *    （simplified：2025-06-18 允许服务端拒绝缺少该头的请求，这里保持宽松）。
 */
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { errorMessage, JSONRPC, jsonRpcError } from './mcp.js'

const DEFAULT_MAX_BODY = 4 * 1024 * 1024
const SESSION_HEADER = 'Mcp-Session-Id'
const PROTOCOL_HEADER = 'MCP-Protocol-Version'
const MAX_SESSIONS = 512

function send(res, status, body, headers = {}) {
  if (res.headersSent || res.writableEnded) return
  const out = body === null || body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
  res.writeHead(status, { 'cache-control': 'no-store', 'content-length': String(out ? out.length : 0), ...headers })
  res.end(out)
}

function sendJson(res, status, value, headers = {}) {
  send(res, status, JSON.stringify(value), { 'content-type': 'application/json; charset=utf-8', ...headers })
}

/** 丢弃未读取的请求体，避免 keep-alive 连接卡住。 */
function discard(req) {
  try {
    if (!req.readableEnded) req.resume()
  } catch {
    /* ignore */
  }
}

async function readBody(req, maxBytes, log) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) {
      log('warning', `请求体超过 ${maxBytes} 字节，已拒绝`)
      throw new HttpError(413, `request body too large (limit ${maxBytes} bytes)`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message)
    this.status = status
    this.headers = headers
  }
}

function normalizeOrigin(value) {
  const raw = String(value ?? '').trim().replace(/\/+$/, '')
  if (raw === '') return ''
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`)
    return url.origin
  } catch {
    return raw
  }
}

function originAllowed(req, { allowedOrigins, allowSameOrigin }) {
  const origin = String(req.headers.origin ?? '').trim()
  if (origin === '') return true // 非浏览器客户端没有 Origin
  const normalized = normalizeOrigin(origin)
  if (allowedOrigins.includes(normalized) || allowedOrigins.includes(origin)) return true
  if (!allowSameOrigin) return false
  const host = String(req.headers.host ?? '').trim()
  if (host === '') return false
  try {
    return new URL(normalized).host === host
  } catch {
    return false
  }
}

function tokenOf(req) {
  const authorization = String(req.headers.authorization ?? '').trim()
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization)
  if (bearer) return { kind: 'bearer', token: bearer[1].trim() }
  const apiKey = req.headers['x-api-key']
  if (apiKey) return { kind: 'api-key', token: String(apiKey).trim() }
  return null
}

function newSessionId() {
  return randomBytes(12).toString('hex')
}

/**
 * 生成 MCP 的 HTTP 请求处理器。
 *
 * @param {object} options
 * @param {object} options.core createMcpCore 的结果
 * @param {(token: string|null, req: import('node:http').IncomingMessage) => any|null|Promise<any|null>} [options.authorize]
 * @param {string[]} [options.allowedOrigins] 允许跨源的 Origin 精确列表
 * @param {boolean} [options.allowSameOrigin=true] 是否放行同源请求
 * @param {boolean} [options.requireSession=true] 是否要求携带 initialize 下发的 Mcp-Session-Id
 * @param {number} [options.maxBodyBytes] 请求体上限
 * @param {(level: string, data: any, line: string) => void} [options.log]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createMcpHttpHandler(options = {}) {
  const core = options.core
  if (!core) throw new Error('createMcpHttpHandler 需要 core')
  const authorize = typeof options.authorize === 'function' ? options.authorize : null
  const allowedOrigins = (options.allowedOrigins ?? []).map(normalizeOrigin).filter(Boolean)
  const allowSameOrigin = options.allowSameOrigin !== false
  const requireSession = options.requireSession !== false
  const sessionHeader = options.sessionHeader ?? SESSION_HEADER
  const maxBodyBytes = Number(options.maxBodyBytes) || DEFAULT_MAX_BODY
  const log = options.log ?? ((level, data, line) => process.stderr.write(`${line ?? `[mcp:http] ${data}`}\n`))
  const sessions = new Set()

  const rememberSession = (id) => {
    sessions.add(id)
    if (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.values().next().value
      if (oldest) sessions.delete(oldest)
    }
  }

  const protocolHeaders = () => (core.state.protocolVersion ? { [PROTOCOL_HEADER]: core.state.protocolVersion } : {})

  const handler = async (req, res) => {
    try {
      if (!originAllowed(req, { allowedOrigins, allowSameOrigin })) {
        discard(req)
        sendJson(res, 403, { error: `origin not allowed: ${String(req.headers.origin ?? '')}`, code: 'FORBIDDEN_ORIGIN' })
        return
      }

      const method = String(req.method ?? 'GET').toUpperCase()
      if (method === 'GET') {
        discard(req)
        // 无 SSE 通知流（simplified）：GET 一律 405，并声明该端点支持的方法。
        sendJson(res, 405, { error: 'GET is not supported: this endpoint answers JSON-RPC over POST only (no server-sent notification stream)' }, { allow: 'POST, DELETE, GET', ...protocolHeaders() })
        return
      }
      if (method === 'DELETE') {
        discard(req)
        const id = String(req.headers[sessionHeader.toLowerCase()] ?? '').trim()
        if (id) sessions.delete(id)
        sendJson(res, 410, { error: 'stateless mode: no per-session stream to terminate; the Mcp-Session-Id was dropped. 重新 initialize 即可建立新会话。', code: 'GONE' }, { ...protocolHeaders() })
        return
      }
      if (method !== 'POST') {
        discard(req)
        sendJson(res, 405, { error: `method not allowed: ${method}` }, { allow: 'POST, DELETE, GET', ...protocolHeaders() })
        return
      }

      let actor = null
      if (authorize) {
        const credential = tokenOf(req)
        const decided = await authorize(credential?.token ?? null, req)
        if (decided === null || decided === undefined) {
          discard(req)
          // 注意：header 值只能是 latin1/ASCII（Node 会拒绝含中文的 header 值），说明放 body。
          sendJson(res, 401, {
            error: credential ? 'invalid token' : 'missing credentials',
            code: 'UNAUTHORIZED',
            hint: '需要 Authorization: Bearer <token> 或 X-Api-Key: <token>（token 来自启动参数 --token / 环境变量 KB_MCP_TOKEN）',
          }, {
            'www-authenticate': 'Bearer realm="dsh-knowledge-base", error="invalid_token", error_description="missing or invalid bearer token (use Authorization: Bearer or X-Api-Key)"',
          })
          return
        }
        actor = decided
      }

      const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
      if (contentType !== '' && !contentType.includes('application/json')) {
        discard(req)
        sendJson(res, 415, { error: `content-type 必须是 application/json，收到 ${contentType || '(空)'}` })
        return
      }

      const session = String(req.headers[sessionHeader.toLowerCase()] ?? '').trim()
      const body = await readBody(req, maxBodyBytes, log)
      let message
      try {
        message = JSON.parse(body === '' ? 'null' : body)
      } catch (error) {
        sendJson(res, 400, jsonRpcError(null, JSONRPC.PARSE_ERROR, `请求体不是合法 JSON：${errorMessage(error)}`), { ...protocolHeaders() })
        return
      }
      if (message === null || message === undefined) {
        sendJson(res, 400, jsonRpcError(null, JSONRPC.PARSE_ERROR, '请求体为空'), { ...protocolHeaders() })
        return
      }

      const first = Array.isArray(message) ? message[0] : message
      const isInitialize = first?.method === 'initialize'
      if (requireSession && !isInitialize) {
        if (session === '') {
          sendJson(res, 400, jsonRpcError(first?.id ?? null, JSONRPC.INVALID_REQUEST, `缺少 ${sessionHeader}：请先 initialize 并在后续请求里携带该请求头`), { ...protocolHeaders() })
          return
        }
        if (!sessions.has(session)) {
          sendJson(res, 400, jsonRpcError(first?.id ?? null, JSONRPC.INVALID_REQUEST, `未知的 ${sessionHeader}：会话不存在或已终止`), { ...protocolHeaders() })
          return
        }
      }

      const meta = {
        transport: 'http',
        actor,
        session: isInitialize ? null : session || null,
        headers: req.headers,
        origin: req.headers.origin ?? null,
        remoteAddress: req.socket?.remoteAddress ?? null,
        req,
      }
      const reply = await handleReply(message, meta)
      if (isInitialize) {
        const id = newSessionId()
        rememberSession(id)
        meta.createdSession = id
      }
      const headers = { ...protocolHeaders() }
      if (isInitialize && meta.createdSession) headers[sessionHeader] = meta.createdSession
      if (reply === null || reply === undefined) {
        send(res, 202, null, headers) // 纯通知：202 空响应体
        return
      }
      sendJson(res, 200, reply, headers)
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      if (error instanceof HttpError) discard(req)
      log('error', `HTTP 传输错误：${errorMessage(error)}`)
      sendJson(
        res,
        status,
        jsonRpcError(null, status === 500 ? JSONRPC.INTERNAL_ERROR : JSONRPC.INVALID_REQUEST, errorMessage(error)),
        { ...protocolHeaders(), ...(error instanceof HttpError ? error.headers : {}) },
      )
    }
  }

  async function handleReply(message, meta) {
    const replies = Array.isArray(message)
      ? (await Promise.all(message.map(async (item) => await core.dispatch?.(item, meta) ?? null))).filter((item) => item !== null && item !== undefined)
      : await core.dispatch(message, meta)
    if (Array.isArray(message)) return replies.length > 0 ? replies : null
    return replies ?? null
  }

  handler.core = core
  handler.sessions = sessions
  handler.requireSession = requireSession
  handler.sessionHeader = sessionHeader
  return handler
}

/** 把 handler 包成按路径挂载的处理器（HTTP 独立跑时用；挂进 Harness 时也可用）。 */
export function createPathGuardedHandler(handler, { path = '/mcp', log } = {}) {
  const wanted = String(path || '/mcp')
  return async (req, res) => {
    let pathname = ''
    try {
      pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`).pathname
    } catch {
      pathname = String(req.url ?? '')
    }
    if (pathname !== wanted && pathname !== `${wanted}/`) {
      sendJson(res, 404, { error: `unknown route: ${pathname}`, hint: `MCP 端点是 POST ${wanted}` })
      return
    }
    try {
      await handler(req, res)
    } catch (error) {
      ;(log ?? ((level, data, line) => process.stderr.write(`${line ?? `[mcp:http] ${data}`}\n`)))('error', `处理请求失败：${errorMessage(error)}`)
      sendJson(res, 500, jsonRpcError(null, JSONRPC.INTERNAL_ERROR, errorMessage(error)))
    }
  }
}

/**
 * 用 node:http 起一个独立端口跑 MCP HTTP（`--http <port>` 走这里）。
 * @param {{ handler: Function, port?: number, host?: string, path?: string, log?: Function }} options
 */
export async function startHttpServer(options = {}) {
  const handler = options.handler
  if (typeof handler !== 'function') throw new Error('startHttpServer 需要 handler')
  const path = options.path ?? '/mcp'
  const guarded = createPathGuardedHandler(handler, { path, log: options.log })
  const server = createServer((req, res) => {
    void guarded(req, res)
  })
  const host = options.host ?? '127.0.0.1'
  const port = Number(options.port) || 0
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, host, () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  const address = server.address()
  return {
    server,
    host,
    path,
    port: typeof address === 'object' && address ? address.port : port,
    url: `http://${host}:${typeof address === 'object' && address ? address.port : port}${path}`,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  }
}

/**
 * 挂到 Harness 的 webServer 上（ctx.effect 的清理函数会注销）。
 *
 *   ctx.effect(() => mountMcpHttp(ctx.get('webServer'), { core, authorize }))
 *
 * @param {object} webServer ctx.get('webServer')
 * @param {object} options createMcpHttpHandler 的选项再加 `path`
 * @returns {() => void} unregister
 */
export function mountMcpHttp(webServer, options = {}) {
  if (!webServer || typeof webServer.register !== 'function') throw new Error('webServer 不可用（需要 register 方法）')
  const { path = '/mcp', ...rest } = options
  const handler = createMcpHttpHandler(rest)
  const registration = webServer.register({ kind: 'prefix', path, handler })
  return () => {
    try {
      if (typeof registration === 'function') registration()
      else if (registration && typeof registration.dispose === 'function') registration.dispose()
      else if (registration && typeof registration.unregister === 'function') registration.unregister()
      else if (typeof webServer.unregister === 'function') webServer.unregister(registration ?? { kind: 'prefix', path, handler })
    } catch {
      /* ignore */
    }
  }
}
