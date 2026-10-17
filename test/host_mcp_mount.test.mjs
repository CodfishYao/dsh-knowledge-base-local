/**
 * Host-side MCP mount check: build the MCP core exactly the way index.js does
 * (`mcpSurface` + `buildKbTools` + `createMcpCore` + `mountMcpHttp` on a
 * webServer-shaped object), then drive a real handshake over HTTP and verify
 * origin/token policy, tool list, a real search, and RBAC enforcement.
 *
 * Temp knowledge base only; the user's real knowledge base is never touched.
 *   node test/host_mcp_mount.test.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { KnowledgeStore } from '../src/store.js'
import { normalizeSettings } from '../src/settings.js'
import { createMcpCore } from '../src/mcp.js'
import { buildKbTools, mcpSurface, readyLine } from '../src/mcp_stdio.js'
import { mountMcpHttp } from '../src/mcp_http.js'

const MCP_PATH = '/kb-mcp'

async function main() {
  const home = await mkdtemp(join(tmpdir(), 'kb-host-mcp-'))
  process.env.DSH_HOME = home
  let server = null
  let passed = 0
  const ok = (name) => {
    passed++
    console.log(`ok   - ${name}`)
  }

  try {
    const root = join(home, 'kb')
    const settings = normalizeSettings({ rootDir: root, chunkSize: 400, chunkOverlap: 60, vectorDim: 512 })
    const store = new KnowledgeStore(settings, null)
    await store.loadSecurity()
    await store.init()
    const added = await store.add({ title: 'MCP 挂载测试', text: '# MCP 挂载\n\n外部客户端应能检索到这段内容。\n', collection: 'mcp' })
    assert.ok(added.id)

    // ---- index.js's mount, reproduced 1:1 ---------------------------------
    const surface = mcpSurface(settings)
    const core = createMcpCore({
      store,
      serverInfo: { name: 'dsh-knowledge-base', title: 'DSH Knowledge Base', version: '1.1.0' },
      instructions: '本地 Markdown 知识库。',
      tools: buildKbTools({ store, settings, readonly: surface.allowWrite === false }),
      maxTextChars: surface.maxTextChars,
      log: () => {},
    })
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

    let mountedHandler = null
    let disposals = 0
    const fakeWebServer = {
      getOrigin: () => 'http://127.0.0.1:0',
      register: (route) => {
        assert.equal(route.kind, 'prefix')
        assert.equal(route.path, MCP_PATH)
        mountedHandler = route.handler
        return () => {
          disposals++
        }
      },
    }
    const dispose = mountMcpHttp(fakeWebServer, {
      core,
      authorize,
      path: MCP_PATH,
      allowSameOrigin: settings.mcp.allowLocalOrigin !== false,
      allowedOrigins: surface.allowedOrigins,
      requireSession: true,
      log: () => {},
    })
    assert.equal(typeof dispose, 'function', 'mountMcpHttp 返回注销函数')
    assert.equal(typeof mountedHandler, 'function', 'webServer.register 收到 handler')

    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`).pathname
      if (pathname !== MCP_PATH && pathname !== `${MCP_PATH}/`) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"error":"no route"}')
        return
      }
      mountedHandler(req, res)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    const base = `http://127.0.0.1:${port}${MCP_PATH}`
    const hostHeader = `127.0.0.1:${port}`

    const rpc = (id, method, params, extraHeaders = {}) => ({
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', host: hostHeader, ...extraHeaders },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    })

    // ---- 1. credential policy ---------------------------------------------
    const anon = await fetch(base, rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'curl', version: '0' } }))
    assert.equal(anon.status, 401, '无 Origin 且无令牌时默认必须 401')
    assert.match(anon.headers.get('www-authenticate') ?? '', /Bearer/)
    const evil = await fetch(base, rpc(2, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } }, { origin: 'http://evil.example' }))
    assert.equal(evil.status, 403, '跨域必须 403')
    const wrongToken = await fetch(base, rpc(3, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } }, { authorization: 'Bearer kb_not_a_real_token_value_here' }))
    assert.equal(wrongToken.status, 401)
    ok('凭据策略：无令牌 401 · 跨域 403 · 错令牌 401')

    // ---- 2. same-origin GUI traffic ---------------------------------------
    const init = await fetch(base, rpc(4, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'harness-gui', version: '1' } }, { origin: `http://${hostHeader}` }))
    assert.equal(init.status, 200, '同源 GUI 以本机 owner 身份放行')
    const sessionId = init.headers.get('mcp-session-id')
    const protocol = init.headers.get('mcp-protocol-version')
    assert.ok(sessionId, 'initialize 应下发 Mcp-Session-Id')
    const initBody = await init.json()
    assert.equal(initBody.result.serverInfo.name, 'dsh-knowledge-base')
    assert.equal(initBody.result.protocolVersion, '2025-06-18')
    ok(`同源握手成功（protocol=${protocol ?? initBody.result.protocolVersion}, session=${String(sessionId).slice(0, 8)}…）`)

    const sessionHeaders = { 'mcp-session-id': sessionId, origin: `http://${hostHeader}` }
    const noSession = await fetch(base, rpc(5, 'tools/list', {}))
    assert.equal(noSession.status, 401, '缺凭据的连接根本进不来')

    const list = await (await fetch(base, rpc(6, 'tools/list', {}, sessionHeaders))).json()
    const names = list.result.tools.map((tool) => tool.name).sort()
    assert.deepEqual(names, ['kb_add', 'kb_import', 'kb_list', 'kb_manage', 'kb_read', 'kb_search'])
    assert.equal(list.result.tools.find((tool) => tool.name === 'kb_search').inputSchema.type, 'object')
    ok('tools/list：六件工具 + inputSchema 完整')

    const search = await (
      await fetch(
        base,
        rpc(7, 'tools/call', { name: 'kb_search', arguments: { query: '外部客户端', limit: 3 } }, sessionHeaders),
      )
    ).json()
    assert.equal(search.result?.isError, undefined, JSON.stringify(search.result ?? search.error))
    assert.ok(search.result.structuredContent.results.length > 0, '应命中刚写入的文档')
    assert.match(search.result.content[0].text, /MCP 挂载/)
    ok('tools/call kb_search：文本 + structuredContent 双份，命中真实文档')

    const readRes = await (
      await fetch(base, rpc(8, 'tools/call', { name: 'kb_read', arguments: { id: added.id } }, sessionHeaders))
    ).json()
    assert.match(readRes.result.content[0].text, /外部客户端/)
    const resources = await (await fetch(base, rpc(9, 'resources/list', {}, sessionHeaders))).json()
    assert.ok(resources.result.resources.some((item) => item.uri === 'kb://catalog'))
    ok('kb_read / resources/list 走同一 store')

    const unknown = await (await fetch(base, rpc(10, 'methods/doNotExist', {}, sessionHeaders))).json()
    assert.equal(unknown.error.code, -32601)
    ok('未知方法 → -32601')

    // ---- 3. RBAC: an external client acts as its own user -----------------
    await store.setRbac({ enabled: true, localRole: 'owner' })
    const user = await store.manageUsers({ action: 'add', name: '外部只读', role: 'reader' })
    const issued = await store.manageUsers({ action: 'token_issue', user: user.id, label: 'cursor', scopes: ['read'] })
    const bearer = { authorization: `Bearer ${issued.token}` }

    const tokenInit = await fetch(
      base,
      rpc(11, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cursor', version: '1' } }, bearer),
    )
    assert.equal(tokenInit.status, 200, '带令牌的跨机器客户端可连接')
    const tokenSession = { 'mcp-session-id': tokenInit.headers.get('mcp-session-id'), ...bearer }
    const tokenSearch = await (await fetch(base, rpc(12, 'tools/call', { name: 'kb_search', arguments: { query: '外部客户端', limit: 2 } }, tokenSession))).json()
    assert.ok(tokenSearch.result?.structuredContent?.results?.length > 0, '只读令牌可以检索')
    const tokenWrite = await (await fetch(base, rpc(13, 'tools/call', { name: 'kb_add', arguments: { title: '不该成功', text: 'rbac should refuse this write', collection: 'mcp' } }, tokenSession))).json()
    assert.equal(tokenWrite.result?.isError, true, JSON.stringify(tokenWrite))
    assert.match(tokenWrite.result.content[0].text, /无权|权限|禁止|forbidden|role/i)
    const tokenAdmin = await (await fetch(base, rpc(14, 'tools/call', { name: 'kb_manage', arguments: { action: 'user_add', userName: 'escalated' } }, tokenSession))).json()
    assert.equal(tokenAdmin.result?.isError, true, '越权管理操作应被拒')
    ok('RBAC 经 MCP 生效：只读令牌可检索，写入与用户管理被拒')

    // same-origin still acts as local owner
    const ownerWrite = await (
      await fetch(base, rpc(15, 'tools/call', { name: 'kb_add', arguments: { title: '本机写入', text: 'local owner write note', collection: 'mcp' } }, { 'mcp-session-id': sessionId, origin: `http://${hostHeader}` }))
    ).json()
    assert.equal(ownerWrite.result?.isError, undefined, JSON.stringify(ownerWrite.result ?? ownerWrite.error))
    ok('本机同源仍是 owner，不受外部令牌限制')

    // ---- 4. lifecycle helpers --------------------------------------------
    const line = await readyLine(store, settings, { transport: 'http', extra: MCP_PATH })
    assert.match(line, /kb-mcp/)
    assert.ok(!line.includes('\n'), 'readyLine 不能含换行')
    dispose()
    dispose()
    assert.ok(disposals >= 1, '注销函数可被 Cordis effect 调用')
    ok('readyLine 与注销（重复调用不炸）')

    console.log(`\nhost-mcp: ${passed} passed, 0 failed`)
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve))
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack ?? String(error))
    process.exit(1)
  })
}
