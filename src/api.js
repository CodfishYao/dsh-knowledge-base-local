/**
 * Same-origin JSON API used by the Web panel (and usable by local scripts).
 *
 * Identity:
 *  - a request from the Harness GUI origin, or with no Origin header at all
 *    (local CLI/scripts), acts as the local owner;
 *  - any other caller must present `Authorization: Bearer <token>` or
 *    `X-Api-Key: <token>` issued in 设置 → 知识库 → 安全 → 访问令牌, and then acts
 *    with that user's role and collection grants.
 *
 * Every operation here maps to the same store method the agent tools use, so
 * the panel and the tools can never drift apart.
 */
import { ANONYMOUS } from './users.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { safeFileName } from './extract.js'

const MAX_BODY = 8 * 1024 * 1024
/** Uploads arrive base64-encoded, so the JSON envelope is ~4/3 of the payload. */
const UPLOAD_BODY = 96 * 1024 * 1024
const UPLOAD_MAX_FILES = 200

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message)
    this.status = status
    this.extra = extra
  }
}

async function readBody(req, limit = MAX_BODY) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw new HttpError(413, `请求体过大（> ${Math.round(limit / 1024 / 1024)} MiB）`)
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, 'request body is not valid JSON')
  }
}

/** Refresh the Host (prompt section, watcher, MCP mount) after a security change. */
async function refreshRuntime(runtime) {
  if (typeof runtime?.touch !== 'function') return
  try {
    await runtime.touch()
  } catch {
    /* the change itself already succeeded; a failed refresh must not 400 it */
  }
}

/**
 * Status must stay readable while the corpus is locked (the panel needs to show
 * the unlock prompt), so a locked or failing store falls back to the runtime's
 * own status instead of surfacing a decrypt error.
 */
async function statusPayload(store, runtime, actor) {
  if (store.configured && !store.locked) {
    try {
      return await store.status(actor)
    } catch (error) {
      const fallback = await runtime.status()
      return { ...fallback, degradedReason: error instanceof Error ? error.message : String(error) }
    }
  }
  return runtime.status()
}

/**
 * Save browser-uploaded files into a temp folder, run them through the normal
 * import path (so PDF/Office text extraction applies), then clean up. The temp
 * copy is only used as the extraction source; `store.add` keeps its own
 * attachment under `files/<id>/` when `import.copyFiles` is on.
 */
async function handleUpload(store, runtime, input) {
  const files = Array.isArray(input.files) ? input.files : []
  if (files.length === 0) throw new HttpError(400, '没有收到文件（files 为空）')
  const settings = runtime?.settings ?? {}
  const perFile = Number(settings.import?.maxFileBytes) || MAX_BODY
  const maxDocs = Number(input.maxDocs) || 50
  const dir = await mkdtemp(join(tmpdir(), 'kb-upload-'))
  const results = []
  try {
    for (const item of files.slice(0, Math.min(UPLOAD_MAX_FILES, maxDocs))) {
      const name = safeFileName(String(item?.name ?? 'upload.bin'))
      try {
        const data = Buffer.from(String(item?.data ?? ''), 'base64')
        if (data.length === 0) {
          results.push({ name, error: '空文件' })
          continue
        }
        if (data.length > perFile) {
          results.push({ name, error: `文件过大（${data.length} 字节 > 上限 ${perFile}）` })
          continue
        }
        const path = join(dir, name)
        await writeFile(path, data)
        if (store.locked) throw new Error('知识库已加密锁定，请先解锁。')
        const doc = await store.add({
          ...input,
          filePath: path,
          text: '',
          title: input.title ? String(input.title) : undefined,
          keepFile: settings.import?.copyFiles !== false,
        })
        results.push({
          name,
          id: doc.id,
          deduped: Boolean(doc.deduped),
          extract: doc.extract ?? null,
        })
      } catch (error) {
        results.push({ name, error: error instanceof Error ? error.message : String(error) })
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  return {
    imported: results.filter((item) => item.id && !item.deduped).length,
    deduped: results.filter((item) => item.deduped).length,
    failed: results.filter((item) => item.error).length,
    total: results.length,
    results,
  }
}

function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

function queryOf(url) {
  return Object.fromEntries(url.searchParams.entries())
}

function bearerOf(req, url) {
  const header = String(req.headers.authorization ?? '')
  if (header.startsWith('Bearer ') || header.startsWith('bearer ')) return header.slice(7).trim()
  const key = String(req.headers['x-api-key'] ?? '').trim()
  if (key) return key
  return String(url.searchParams.get('token') ?? '').trim()
}

/** Resolve who is calling. Throws 401/403 instead of silently downgrading. */
async function resolveActor(req, url, store, { allowLocal = true } = {}) {
  const secret = bearerOf(req, url)
  if (secret) {
    const actor = await store.directory.resolveToken(secret)
    if (!actor) throw new HttpError(401, 'API Token 无效、已撤销或已过期。请在 设置 → 知识库 → 安全 重新签发。')
    return actor
  }
  if (!allowLocal) throw new HttpError(401, '该接口需要 Authorization: Bearer <token>。')
  if (!sameOrigin(req)) throw new HttpError(403, '跨域请求必须携带 API Token（Authorization: Bearer …）。')
  return allowLocal ? store.directory.localActor() : ANONYMOUS
}

/**
 * @param {{getStore: () => any, runtime: object, mcpInfo?: () => object}} deps
 */
export function createApiHandler({ getStore, runtime, mcpInfo }) {
  return async function handler(req, res) {
    let status = 200
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
      const route = url.pathname.replace(/^\/kb-api\/?/, '').replace(/\/+$/, '')
      const method = req.method ?? 'GET'
      const store = getStore()
      const actor = await resolveActor(req, url, store)
      const asActor = (input = {}) => ({ ...input, actor })

      if (method === 'GET') {
        if (route === 'health') return sendJson(res, 200, { ok: true })
        if (route === 'whoami') return sendJson(res, 200, { actor: actor.describe(), rbac: store.directory.enabled })
        if (route === 'status') {
          return sendJson(res, 200, await statusPayload(store, runtime, asActor(queryOf(url))))
        }
        if (route === 'security') {
          if (!store.configured) return sendJson(res, 409, { error: '知识库根目录尚未配置', code: 'UNCONFIGURED' })
          return sendJson(res, 200, await store.securityStatus(asActor()))
        }
        if (route === 'users') {
          if (!store.configured) return sendJson(res, 409, { error: '知识库根目录尚未配置', code: 'UNCONFIGURED' })
          return sendJson(res, 200, await store.usersStatus(asActor()))
        }
        if (route === 'mcp') {
          return sendJson(res, 200, typeof mcpInfo === 'function' ? mcpInfo(actor) : { enabled: false })
        }
        if (!store.configured) return sendJson(res, 409, { error: '知识库根目录尚未配置', code: 'UNCONFIGURED' })
        if (route === 'collections') return sendJson(res, 200, { collections: await store.collections(asActor()) })
        if (route === 'trash') {
          store.authorize(asActor(), 'read')
          return sendJson(res, 200, { items: await store.listTrash() })
        }
        if (route === 'docs') {
          const query = queryOf(url)
          return sendJson(
            res,
            200,
            await store.list(
              asActor({
                collection: query.collection,
                tag: query.tag,
                query: query.query,
                limit: Number(query.limit) || 50,
                offset: Number(query.offset) || 0,
                sort: query.sort,
              }),
            ),
          )
        }
        if (route === 'doc') {
          const query = queryOf(url)
          return sendJson(
            res,
            200,
            await store.read(
              asActor({ id: query.id, path: query.path, offset: Number(query.offset) || 1, limit: Number(query.limit) || 400, chunk: query.chunk }),
            ),
          )
        }
        if (route === 'search') {
          const query = queryOf(url)
          return sendJson(
            res,
            200,
            await store.search(
              asActor({ query: query.q ?? '', collection: query.collection, tags: query.tags, limit: Number(query.limit) || 8, mode: query.mode }),
            ),
          )
        }
        return sendJson(res, 404, { error: `unknown route: GET /${route}` })
      }

      if (method === 'POST') {
        const contentType = String(req.headers['content-type'] ?? '')
        if (!contentType.includes('application/json')) {
          sendJson(res, 415, { error: 'content-type must be application/json' })
          return
        }
        const body = await readBody(req, route === 'upload' ? UPLOAD_BODY : MAX_BODY)
        if (route === 'config') {
          store.authorize(asActor(), 'security')
          return sendJson(res, 200, await runtime.configure(body))
        }
        if (route === 'status') return sendJson(res, 200, await statusPayload(store, runtime, asActor(body)))
        if (route === 'security') {
          const result = await runSecurity(store, asActor(body))
          await refreshRuntime(runtime)
          return sendJson(res, 200, result)
        }
        if (route === 'users') {
          const result = await store.manageUsers(asActor(body))
          await refreshRuntime(runtime)
          return sendJson(res, 200, result)
        }
        if (route === 'tokens') {
          const action = body.action === 'revoke' ? 'token_revoke' : 'token_issue'
          return sendJson(res, 200, await store.manageUsers(asActor({ ...body, action })))
        }
        if (route === 'grants') {
          const action = body.delete ? 'revoke' : 'grant'
          return sendJson(res, 200, await store.manageUsers(asActor({ ...body, action })))
        }
        if (!store.configured) return sendJson(res, 409, { error: '知识库根目录尚未配置', code: 'UNCONFIGURED' })

        const writable = () => {
          if (!runtime.settings.tools.allowWrite) throw new HttpError(403, '写入已被配置禁用')
        }

        if (route === 'add') {
          writable()
          const result = body.url ? await store.addUrl(asActor(body)) : await store.add(asActor(body))
          return sendJson(res, 200, result)
        }
        if (route === 'import') {
          writable()
          if (body.url) {
            const result = await store.addUrl(asActor(body))
            return sendJson(res, 200, {
              imported: result.deduped ? 0 : 1,
              deduped: result.deduped ? 1 : 0,
              failed: 0,
              total: 1,
              results: [{ path: body.url, id: result.id }],
            })
          }
          return sendJson(res, 200, await store.importDirectory(asActor(body)))
        }
        if (route === 'upload') {
          writable()
          if (!store.configured) throw new HttpError(409, '知识库根目录尚未配置')
          return sendJson(res, 200, await handleUpload(store, runtime, asActor(body)))
        }
        if (route === 'update') {
          writable()
          return sendJson(res, 200, await store.update(asActor(body)))
        }
        if (route === 'delete') {
          writable()
          return sendJson(res, 200, await store.remove(body.id, asActor(body)))
        }
        if (route === 'restore') {
          writable()
          return sendJson(res, 200, await store.restore(body.id, asActor(body)))
        }
        if (route === 'purge') {
          writable()
          return sendJson(res, 200, await store.purge(body.id, asActor(body)))
        }
        if (route === 'bulk-remove') {
          writable()
          return sendJson(res, 200, await store.bulkRemove(asActor(body)))
        }
        if (route === 'empty-trash') {
          writable()
          return sendJson(res, 200, await store.emptyTrash(asActor(body)))
        }
        if (route === 'wipe') {
          return sendJson(res, 200, await store.wipe(asActor(body)))
        }
        if (route === 'reindex') {
          writable()
          return sendJson(res, 200, await store.reindex(asActor(body)))
        }
        if (route === 'scan') {
          writable()
          return sendJson(res, 200, await store.scanDocuments(asActor(body)))
        }
        if (route === 'collection') {
          writable()
          if (body.delete) return sendJson(res, 200, await store.deleteCollection(body.name, asActor({ moveTo: body.moveTo })))
          return sendJson(res, 200, await store.createCollection(body.name, body.description, asActor()))
        }
        if (route === 'export') return sendJson(res, 200, await store.exportAll(asActor(body)))
        return sendJson(res, 404, { error: `unknown route: POST /${route}` })
      }

      sendJson(res, 405, { error: 'method not allowed' })
    } catch (error) {
      if (error instanceof HttpError) {
        status = error.status
        return sendJson(res, status, { error: error.message, ...error.extra })
      }
      const message = error instanceof Error ? error.message : String(error)
      if (error && (error.code === 'FORBIDDEN' || error.name === 'ForbiddenError')) status = 403
      else if (error && error.code === 'LOCKED') status = 423
      else status = 400
      sendJson(res, status, { error: message, code: error?.code ?? '' })
    }
  }
}

/** Map one POST /kb-api/security body onto the matching store operation. */
async function runSecurity(store, input) {
  const action = String(input.action ?? 'status')
  const actor = input.actor
  const metadata = input.metadata === 'encrypted' || input.metadataMode === 'encrypted' ? 'encrypted' : 'plain'
  switch (action) {
    case 'status':
      return store.securityStatus(input)
    case 'enable':
      return store.enableEncryption({ passphrase: input.passphrase, metadata, actor })
    case 'disable':
      return store.disableEncryption({ passphrase: input.passphrase, actor })
    case 'unlock':
      return { encryption: await store.unlockKnowledgeBase({ passphrase: input.passphrase }) }
    case 'lock':
      return { encryption: await store.lockKnowledgeBase(input) }
    case 'passphrase':
      return {
        encryption: await store.changePassphrase({
          current: input.currentPassphrase ?? input.current,
          next: input.newPassphrase ?? input.next,
          actor,
        }),
      }
    case 'rotate':
      return store.rotateKey({ passphrase: input.passphrase, actor })
    case 'metadata':
      return store.setMetadataEncryption({ mode: input.mode ?? input.metadataMode ?? metadata, passphrase: input.passphrase, actor })
    case 'reencrypt':
      return store.applyEncryption({ target: input.target === 'plain' ? 'plain' : 'encrypted', actor })
    default:
      throw new HttpError(400, `未知的安全操作：${action}`)
  }
}
