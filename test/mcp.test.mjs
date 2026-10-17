/**
 * MCP 自检：`node test/mcp.test.mjs`，全部通过时退出码 0。
 *
 * 只在 OS 临时目录里建一个**独立**的临时知识库根目录读写，绝不碰用户的
 * 真实知识库（测试一开始就把 DSH_HOME 指向临时目录，并且只用
 * normalizeSettings({ rootDir: 临时目录 }) 构造 store）。
 *
 * 传输层有两条路径：
 *  1. 进程内驱动 `createStdioTransport({ core, input, output })`（内存流），
 *     这条一定会跑，保证协议逻辑被真实验证；
 *  2. `node:child_process` spawn `node mcp-stdio.mjs --root <临时目录>` 走完整
 *     stdio 握手 —— 本 harness 的文件沙箱下用管道捕获子进程输出可能被拒（EPERM），
 *     所以先探测，失败就打 SKIP 并跳过，不算失败。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { KnowledgeStore } from '../src/store.js'
import { normalizeSettings } from '../src/settings.js'
import {
  JSONRPC,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  createMcpCore,
  handleMcpMessage,
  kbResourceUri,
  parseKbResourceUri,
  toMcpTool,
} from '../src/mcp.js'
import {
  MANAGE_READ_ACTIONS,
  READ_TOOL_NAMES,
  bearerAuthorize,
  buildKbTools,
  createKbToolkit,
  createStdioTransport,
  mcpSurface,
  parseServerArgs,
  readyLine,
  resolveSettings,
  resolveStartupActor,
  runHttpServer,
  storeTokenAuthorize,
} from '../src/mcp_stdio.js'
import { createMcpHttpHandler } from '../src/mcp_http.js'

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// —— 隔离：先把 DSH_HOME 指向临时目录，任何 loadSettings() 都不会读到用户真实配置 ——
const HOME = await mkdtemp(join(tmpdir(), 'kb-mcp-home-'))
process.env.DSH_HOME = HOME
const ROOT = resolve(join(HOME, 'kb'))

function assertTempPath(path, label) {
  const value = resolve(path)
  assert.ok(value.startsWith(HOME), `${label} 必须在临时目录 ${HOME} 内，实际是 ${value}`)
  return value
}

assertTempPath(ROOT, '测试知识库根目录')

// —— 微型测试运行器 ——
let passed = 0
let failed = 0
let skipped = 0

async function test(name, fn) {
  try {
    const result = await fn()
    if (result === 'SKIP') {
      skipped++
      console.log(`SKIP - ${name}`)
      return
    }
    passed++
    console.log(`ok   - ${name}`)
  } catch (error) {
    failed++
    console.error(`FAIL - ${name}\n     ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n     ') : error}`)
  }
}

// —— 临时知识库 ——
const settings = normalizeSettings({ rootDir: ROOT, chunkSize: 400, chunkOverlap: 60, vectorDim: 512, vectorMode: 'local' })
const store = new KnowledgeStore(settings, null)
await store.init()

const DOC_A = ['# 安装指南', '', '先安装 Node.js 22 以上。', '', '## 检索', '', '使用 BM25 与向量混合检索，权重可调。', '', '每篇文档存成 docs/<id>.md。'].join('\n')
const DOC_B = '# MCP 接入\n\n外部客户端通过 stdio 或 Streamable HTTP 连接这个知识库。\n'

const addedA = await store.add({ title: 'Harness 知识库设计', text: DOC_A, collection: 'design', tags: 'harness,知识库' })
const addedB = await store.add({ title: 'MCP 接入说明', text: DOC_B, collection: 'notes', tags: 'mcp' })

let nextId = 1
const meta = { transport: 'test' }

async function ask(core, method, params, requestMeta = meta) {
  const id = nextId++
  return await handleMcpMessage(core, { jsonrpc: '2.0', id, method, params }, requestMeta)
}

async function notify(core, method, params, requestMeta = meta) {
  return await handleMcpMessage(core, { jsonrpc: '2.0', method, params }, requestMeta)
}

function makeCore(options = {}) {
  let tools = options.tools
  let runtime = null
  if (!tools) {
    const toolkit = createKbToolkit({ store, settings, readonly: Boolean(options.readonly), log: () => {} })
    tools = toolkit.tools
    runtime = toolkit.runtime
  }
  const core = createMcpCore({ store, tools, log: () => {}, ...options, tools })
  core.state.transport = options.transport ?? 'stdio'
  if (runtime) {
    runtime.core = core
    runtime.serverOptions = { transport: 'stdio', readonly: Boolean(options.readonly) }
  }
  return core
}

function textOf(result) {
  return (result?.content ?? []).map((part) => part.text ?? '').join('\n')
}

// ============================ 协议核心 ============================

await test('initialize：版本协商 + serverInfo + capabilities + instructions', async () => {
  const core = makeCore()
  for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
    const reply = await ask(core, 'initialize', { protocolVersion: version, clientInfo: { name: 'ci', version: '1' } })
    assert.equal(reply.jsonrpc, '2.0')
    assert.equal(typeof reply.id, 'number')
    assert.equal(reply.result.protocolVersion, version, `应原样回显支持的 ${version}`)
    assert.ok(reply.result.capabilities.tools, '要声明 tools 能力')
    assert.ok(reply.result.capabilities.resources, '要声明 resources 能力')
    assert.equal(reply.result.serverInfo.name, 'dsh-knowledge-base')
    assert.equal(typeof reply.result.instructions, 'string')
    assert.ok(reply.result.instructions.length > 0)
  }
  const unknown = await ask(core, 'initialize', { protocolVersion: '1999-01-01' })
  assert.equal(unknown.result.protocolVersion, LATEST_PROTOCOL_VERSION, '不支持的版本要回退到最新支持版本')
  assert.equal(core.state.initialized, true)
  assert.equal(core.state.protocolVersion, LATEST_PROTOCOL_VERSION)
})

await test('notifications/initialized 不回复；ping 返回空 result', async () => {
  const core = makeCore()
  assert.equal(await notify(core, 'notifications/initialized', {}), null)
  assert.equal(await notify(core, 'notifications/unknownThing', {}), null)
  const ping = await ask(core, 'ping')
  assert.deepEqual(ping.result, {})
  assert.ok(ping.id !== undefined)
})

await test('JSON-RPC 错误码：-32601 / -32600 / params 校验', async () => {
  const core = makeCore()
  const missing = await ask(core, 'does/not/exist', {})
  assert.equal(missing.error.code, JSONRPC.METHOD_NOT_FOUND)
  assert.equal(missing.error.code, -32601)
  assert.ok(/method not found/.test(missing.error.message))

  const noJsonrpc = await handleMcpMessage(core, { id: 42, method: 'ping' }, meta)
  assert.equal(noJsonrpc.error.code, JSONRPC.INVALID_REQUEST)
  assert.equal(noJsonrpc.id, 42)

  assert.equal((await handleMcpMessage(core, 'not-an-object', meta)).error.code, JSONRPC.INVALID_REQUEST)
  assert.equal((await handleMcpMessage(core, { jsonrpc: '1.0', id: 7, method: 'ping' }, meta)).error.code, JSONRPC.INVALID_REQUEST)
  assert.equal((await handleMcpMessage(core, { jsonrpc: '2.0', id: 8 }, meta)).error.code, JSONRPC.INVALID_REQUEST)
  assert.equal((await handleMcpMessage(core, { jsonrpc: '2.0', id: 9, method: 'ping', params: 'nope' }, meta)).error.code, JSONRPC.INVALID_PARAMS)
  assert.equal(await handleMcpMessage(core, { jsonrpc: '2.0', method: 'ping', params: 'nope' }, meta), null, '坏通知不该回复')
  assert.equal(await handleMcpMessage(core, { jsonrpc: '2.0', id: 10, result: { ok: true } }, meta), null, '客户端发来的“响应”要忽略（本服务器不主动发起请求）')
  assert.equal(await handleMcpMessage(core, { jsonrpc: '2.0', id: 11, error: { code: -1, message: 'x' } }, meta), null)
})

await test('tools/list：六个工具、inputSchema、annotations', async () => {
  const core = makeCore()
  const reply = await ask(core, 'tools/list')
  const names = reply.result.tools.map((tool) => tool.name)
  for (const expected of ['kb_search', 'kb_read', 'kb_list', 'kb_add', 'kb_import', 'kb_manage']) {
    assert.ok(names.includes(expected), `缺少工具 ${expected}`)
  }
  const search = reply.result.tools.find((tool) => tool.name === 'kb_search')
  assert.equal(search.inputSchema.type, 'object')
  assert.deepEqual(search.inputSchema.required, ['query'])
  assert.ok(search.description.length > 10)
  assert.ok(search.annotations.readOnlyHint, 'kb_search 应标记为只读')
  assert.ok(search.outputSchema, '应带 outputSchema（来自 Harness ToolDefinition）')
  assert.ok(!('nextCursor' in reply.result), '简化实现：一次返回全量')
})

await test('tools/call kb_search：结构化 + 文本双份，且命中临时库文档', async () => {
  const core = makeCore()
  const reply = await ask(core, 'tools/call', { name: 'kb_search', arguments: { query: '混合检索', limit: 5 } })
  const result = reply.result
  assert.ok(Array.isArray(result.content), 'content 必须是数组')
  assert.equal(result.content[0].type, 'text')
  assert.ok(!('isError' in result) || result.isError === false, 'isError 应缺失或 false')
  assert.ok(textOf(result).includes('BM25') || textOf(result).includes('检索'), `文本渲染异常：${textOf(result)}`)
  assert.ok(result.structuredContent, '应有 structuredContent')
  assert.equal(result.structuredContent.query, '混合检索')
  assert.ok(result.structuredContent.total >= 1)
  assert.equal(result.structuredContent.results[0].docId, addedA.id)
  assert.ok(result.structuredContent.results[0].path.startsWith('docs/'))
})

await test('tools/call kb_read / kb_list（读路径）', async () => {
  const core = makeCore()
  const read = await ask(core, 'tools/call', { name: 'kb_read', arguments: { id: addedB.id } })
  assert.ok(textOf(read.result).includes('stdio'))
  assert.equal(read.result.structuredContent.id, addedB.id)
  const list = await ask(core, 'tools/call', { name: 'kb_list', arguments: { collection: 'design' } })
  assert.ok(list.result.structuredContent.docs.some((doc) => doc.id === addedA.id))
  const missing = await ask(core, 'tools/call', { name: 'kb_read', arguments: { id: 'k-does-not-exist' } })
  assert.equal(missing.result.isError, true, '读不到文档要转成 isError')
  assert.match(textOf(missing.result), /执行失败/)
})

await test('tools/call kb_add：写入临时库并可回读', async () => {
  const core = makeCore()
  const text = '# MCP 写入测试\n\n由 tools/call 写入的文档，用来验证写路径与去重。\n'
  const reply = await ask(core, 'tools/call', { name: 'kb_add', arguments: { title: 'MCP 写入测试', text, collection: 'mcp-test', tags: 'mcp,test' } })
  assert.ok(!reply.result.isError, textOf(reply.result))
  const id = reply.result.structuredContent.id
  assert.ok(id)
  assert.equal(reply.result.structuredContent.collection, 'mcp-test')
  assertTempPath(join(ROOT, 'docs', `${id}.md`), 'kb_add 落盘路径')
  const back = await store.read({ id })
  assert.ok(back.content.includes('tools/call'))
  const again = await ask(core, 'tools/call', { name: 'kb_add', arguments: { title: 'MCP 写入测试', text, collection: 'mcp-test' } })
  assert.equal(again.result.structuredContent.deduped, true, '重复内容应去重')
})

await test('tools/call kb_manage（status / trash 为读操作）', async () => {
  const core = makeCore()
  const status = await ask(core, 'tools/call', { name: 'kb_manage', arguments: { action: 'status' } })
  assert.equal(status.result.isError, undefined)
  assert.equal(JSON.parse(textOf(status.result)).root, ROOT)
  assert.ok(status.result.structuredContent.docs >= 3)
  const trash = await ask(core, 'tools/call', { name: 'kb_manage', arguments: { action: 'trash' } })
  assert.deepEqual(trash.result.structuredContent.items, [])
  const bad = await ask(core, 'tools/call', { name: 'kb_manage', arguments: { action: 'purge', id: addedA.id } })
  assert.equal(bad.result.isError, true, 'purge 需要回收站里的 id，这里应失败')
  const unknownAction = await ask(core, 'tools/call', { name: 'kb_manage', arguments: { action: 'nope' } })
  assert.equal(unknownAction.result.isError, true, 'enum 校验失败也转成 isError')
  assert.match(textOf(unknownAction.result), /只能是/)
})

await test('tools/call 参数校验：未知工具 -32602，参数问题回 isError（不崩）', async () => {
  const core = makeCore()
  const unknown = await ask(core, 'tools/call', { name: 'kb_nope', arguments: {} })
  assert.equal(unknown.error.code, JSONRPC.INVALID_PARAMS)
  assert.ok(Array.isArray(unknown.error.data.known))
  const badArgs = await ask(core, 'tools/call', { name: 'kb_search', arguments: 'string' })
  assert.equal(badArgs.error.code, JSONRPC.INVALID_PARAMS)
  const missingQuery = await ask(core, 'tools/call', { name: 'kb_search', arguments: {} })
  assert.equal(missingQuery.error, undefined, '参数校验失败按 MCP 建议回 isError，而不是协议错误')
  assert.equal(missingQuery.result.isError, true)
  assert.match(textOf(missingQuery.result), /缺少必填参数 "query"/)
  const emptyQuery = await ask(core, 'tools/call', { name: 'kb_search', arguments: { query: '   ' } })
  assert.equal(emptyQuery.result.isError, true, '空白 query 也被 required 校验拦住')
  const badLimit = await ask(core, 'tools/call', { name: 'kb_search', arguments: { query: 'x', limit: 999 } })
  assert.equal(badLimit.result.isError, true)
  assert.match(textOf(badLimit.result), /不能大于 50/)
  const extraKey = await ask(core, 'tools/call', { name: 'kb_search', arguments: { query: 'BM25', whatever: 1 } })
  assert.equal(extraKey.result.isError, undefined, 'additionalProperties:false 故意不强制（宽松接受多余字段）')
})

await test('handler 抛错不会击穿服务器（isError:true）', async () => {
  const core = makeCore({
    tools: [
      {
        name: 'boom',
        description: 'always throws',
        inputSchema: { type: 'object', properties: {} },
        handler: () => {
          throw new Error('kaboom')
        },
      },
      { name: 'str', description: 'string result', inputSchema: { type: 'object', properties: {} }, handler: () => 'plain string' },
      { name: 'nothing', description: 'no result', inputSchema: { type: 'object', properties: {} }, handler: () => undefined },
    ],
  })
  const reply = await ask(core, 'tools/call', { name: 'boom', arguments: {} })
  assert.equal(reply.error, undefined)
  assert.equal(reply.result.isError, true)
  assert.match(textOf(reply.result), /kaboom/)
  assert.match(textOf((await ask(core, 'tools/call', { name: 'str', arguments: {} })).result), /plain string/)
  assert.ok(Array.isArray((await ask(core, 'tools/call', { name: 'nothing', arguments: {} })).result.content))
})

await test('authorize 钩子：拒绝 → -32001，放行 → actor 传到 handler', async () => {
  const seen = []
  const core = makeCore({
    tools: [
      {
        name: 'peek',
        description: 'echo actor',
        inputSchema: { type: 'object', properties: {} },
        handler: async (_args, actor) => ({ content: [{ type: 'text', text: JSON.stringify(actor ?? null) }] }),
      },
    ],
    authorize: (info) => {
      seen.push(info.method)
      if (info.method === 'tools/call' && info.actor && info.actor.name === 'banned') return null
      return info.actor ?? { name: 'anonymous' }
    },
  })
  const ok = await ask(core, 'tools/call', { name: 'peek', arguments: {} }, { transport: 'test', actor: { name: 'ci' } })
  assert.equal(JSON.parse(textOf(ok.result)).name, 'ci', 'actor 要透传给 handler')
  const denied = await ask(core, 'tools/call', { name: 'peek', arguments: {} }, { transport: 'test', actor: { name: 'banned' } })
  assert.equal(denied.error.code, JSONRPC.UNAUTHORIZED)
  assert.equal(denied.error.code, -32001)
  assert.match(denied.error.message, /未授权/)
  assert.ok(seen.includes('tools/call'))
  const ping = await ask(core, 'ping', {}, { transport: 'test', actor: { name: 'banned' } })
  assert.deepEqual(ping.result, {}, 'ping/initialize 免鉴权')
})

await test('resources/list + templates + read（kb://<collection>/<id> 与 kb://catalog）', async () => {
  const core = makeCore()
  const uri = kbResourceUri('design/斜杠', addedA.id)
  assert.ok(!uri.slice(5).split('/')[0].includes('/'), 'collection 里的 / 必须被编码')
  assert.deepEqual(parseKbResourceUri(uri), { kind: 'doc', collection: 'design/斜杠', id: addedA.id })
  assert.equal(parseKbResourceUri('http://example/a'), null)
  assert.deepEqual(parseKbResourceUri('kb://catalog'), { kind: 'catalog' })

  const list = await ask(core, 'resources/list')
  const uris = list.result.resources.map((resource) => resource.uri)
  assert.ok(uris.includes('kb://catalog'), '要暴露 kb://catalog')
  assert.ok(uris.includes(kbResourceUri('design', addedA.id)), `要暴露文档资源，实际 ${uris.join(', ')}`)
  assert.equal(list.result.resources.find((r) => r.uri === 'kb://catalog').mimeType, 'text/markdown')
  assert.ok(list.result.resources.every((resource) => resource.uri.startsWith('kb://')))

  const templates = await ask(core, 'resources/templates/list')
  assert.equal(templates.result.resourceTemplates.length, 1)
  assert.equal(templates.result.resourceTemplates[0].uriTemplate, 'kb://{collection}/{id}')

  const catalog = await ask(core, 'resources/read', { uri: 'kb://catalog' })
  assert.equal(catalog.result.contents[0].mimeType, 'text/markdown')
  assert.match(catalog.result.contents[0].text, /Knowledge Base Catalog/)
  assert.ok(catalog.result.contents[0].text.includes(addedA.title))

  const doc = await ask(core, 'resources/read', { uri: kbResourceUri('notes', addedB.id) })
  assert.equal(doc.result.contents[0].uri, kbResourceUri('notes', addedB.id))
  assert.match(doc.result.contents[0].text, /MCP 接入/)
  assert.match(doc.result.contents[0].text, /^---$/m, '直接读 docs/<id>.md，含 frontmatter')

  const gone = await ask(core, 'resources/read', { uri: kbResourceUri('design', 'knope') })
  assert.equal(gone.error.code, -32002)
  const badScheme = await ask(core, 'resources/read', { uri: 'https://example/x' })
  assert.equal(badScheme.error.code, JSONRPC.RESOURCE_NOT_FOUND)
  const mismatch = await ask(core, 'resources/read', { uri: kbResourceUri('other', addedB.id) })
  assert.equal(mismatch.error.code, JSONRPC.RESOURCE_NOT_FOUND, '集合不匹配应报错而不是回错文档')
})

await test('prompts/list + prompts/get(kb-search) 校验参数', async () => {
  const core = makeCore()
  const list = await ask(core, 'prompts/list')
  assert.equal(list.result.prompts.length, 1)
  assert.equal(list.result.prompts[0].name, 'kb-search')
  assert.ok(list.result.prompts[0].arguments.some((argument) => argument.name === 'query' && argument.required === true))
  const got = await ask(core, 'prompts/get', { name: 'kb-search', arguments: { query: '混合检索', limit: '3' } })
  assert.equal(got.result.messages[0].role, 'user')
  assert.match(got.result.messages[0].content.text, /kb_search/)
  assert.match(got.result.messages[0].content.text, /混合检索/)
  assert.equal((await ask(core, 'prompts/get', { name: 'nope' })).error.code, JSONRPC.INVALID_PARAMS)
  assert.equal((await ask(core, 'prompts/get', { name: 'kb-search', arguments: {} })).error.code, JSONRPC.INVALID_PARAMS)
})

await test('logging/setLevel：接受合法值、记录、拒绝非法值', async () => {
  const core = makeCore()
  assert.deepEqual((await ask(core, 'logging/setLevel', { level: 'debug' })).result, {})
  assert.equal(core.state.logLevel, 'debug')
  assert.equal((await ask(core, 'logging/setLevel', { level: 'shout' })).error.code, JSONRPC.INVALID_PARAMS)
  assert.equal(await notify(core, 'logging/setLevel', { level: 'info' }), null)
})

await test('toMcpTool：Harness ToolDefinition → MCP 形状', async () => {
  const fake = {
    name: 'demo',
    description: 'demo tool',
    parameters: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { a: { type: 'string' } } }, render: (args) => [{ type: 'text', text: `got ${args.a}` }] },
    isConcurrencySafe: () => true,
    execute: async (args, exec) => ({ a: args.a, actor: exec.actor?.name ?? null, signaled: Boolean(exec.signal === undefined) }),
  }
  const tool = toMcpTool(fake)
  assert.equal(tool.inputSchema, fake.parameters)
  assert.equal(tool.outputSchema, fake.output.schema)
  const value = await tool.handler({ a: 'x' }, { name: 'tester' }, {})
  assert.equal(value.content[0].text, 'got x')
  assert.equal(value.structuredContent.actor, 'tester')
  const guarded = toMcpTool(fake, { transformHandler: (handler) => async (args) => handler({ ...args, a: 'rewritten' }, null, {}) })
  assert.equal((await guarded.handler({ a: 'y' })).content[0].text, 'got rewritten')
  assert.throws(() => toMcpTool({ description: 'no name' }), /name/)
})

await test('--readonly 工具集：只留读工具并收紧 kb_manage', async () => {
  const tools = buildKbTools({ store, settings, readonly: true, log: () => {} })
  const names = tools.map((tool) => tool.name).sort()
  assert.deepEqual(names, [...READ_TOOL_NAMES, 'kb_manage'].sort())
  const manage = tools.find((tool) => tool.name === 'kb_manage')
  assert.deepEqual(manage.inputSchema.properties.action.enum, MANAGE_READ_ACTIONS)
  const core = createMcpCore({ store, tools, log: () => {} })
  const blocked = await ask(core, 'tools/call', { name: 'kb_add', arguments: { text: 'nope' } })
  assert.equal(blocked.error.code, JSONRPC.INVALID_PARAMS, '只读模式不暴露 kb_add')
  const write = await ask(core, 'tools/call', { name: 'kb_manage', arguments: { action: 'scan' } })
  assert.equal(write.result.isError, true)
  assert.match(textOf(write.result), /只能是 status \| trash/)
  const handlerGuard = tools.find((tool) => tool.name === 'kb_manage')
  assert.match(handlerGuard.description, /只读模式/)
  assert.equal((await ask(core, 'tools/call', { name: 'kb_manage', arguments: { action: 'status' } })).result.isError, undefined)
  const absent = await store.list({ collection: 'default' })
  assert.equal(absent.total, 0, '只读模式不应写进任何文档')
})

await test('configure 只改内存、不落盘；根目录需要 --allow-set-root', async () => {
  const live = normalizeSettings({ ...settings })
  const localStore = new KnowledgeStore(live, null)
  const tools = buildKbTools({ store: localStore, settings: live, log: () => {} })
  const core = createMcpCore({ store: localStore, tools, log: () => {} })
  const reply = await ask(core, 'tools/call', { name: 'kb_manage', arguments: { action: 'configure', vectorMode: 'api', rootDir: join(HOME, 'elsewhere'), embeddingEndpoint: 'http://127.0.0.1:9/v1', embeddingModel: 'm' } })
  const value = reply.result.structuredContent
  assert.equal(value.persisted, false)
  assert.equal(value.vectorMode, 'api')
  assert.deepEqual(value.skipped, ['rootDir'], '默认不允许改根目录')
  assert.equal(localStore.settings.vectorMode, 'api')
  assert.equal(localStore.root, ROOT, '根目录保持不变')
  const other = buildKbTools({ store: new KnowledgeStore(normalizeSettings({ ...settings }), null), settings: normalizeSettings({ ...settings }), allowSetRoot: true, log: () => {} })
  const otherCore = createMcpCore({ store: other ? new KnowledgeStore(localStore.settings, null) : null, tools: other, log: () => {} })
  assert.ok(Array.isArray(otherCore.tools))
  await ask(otherCore, 'tools/call', { name: 'kb_manage', arguments: { action: 'configure', vectorMode: 'local' } })

  // --allow-set-root 才允许换根目录，且只在内存里生效（同样不写 settings.json）
  const target = join(HOME, 'elsewhere-root')
  const moveSettings = normalizeSettings({ ...settings })
  const moveStore = new KnowledgeStore(moveSettings, null)
  await moveStore.init()
  const movable = buildKbTools({ store: moveStore, settings: moveSettings, allowSetRoot: true, log: () => {} })
  const moved = await ask(createMcpCore({ store: moveStore, tools: movable, log: () => {} }), 'tools/call', {
    name: 'kb_manage',
    arguments: { action: 'configure', rootDir: target },
  })
  assert.equal(moved.result.isError, undefined, textOf(moved.result))
  assert.ok(moved.result.structuredContent.applied.includes('rootDir'))
  assert.equal(moveStore.root, target)
  assertTempPath(target, 'configure 之后的根目录')
  assert.match(await readFile(join(target, 'kb.json'), 'utf8'), /collections/, '新根目录被 store.init 初始化')
  assert.equal(moveSettings.rootDir, target, '内存 settings 同步')
  moveStore.root = ROOT
})

await test('parseServerArgs / resolveSettings / readyLine（CLI 覆盖语义）', async () => {
  assert.equal(parseServerArgs(['--root', 'D:\\KB', '--mode', 'api', '--readonly'], {}).root, 'D:\\KB')
  assert.equal(parseServerArgs(['--root=D:\\KB'], {}).root, 'D:\\KB')
  assert.equal(parseServerArgs([], { KB_ROOT: '/env/root', KB_VECTOR_MODE: 'api', KB_MCP_READONLY: '1' }).root, '/env/root')
  assert.equal(parseServerArgs(['--mode', 'local'], { KB_VECTOR_MODE: 'api' }).vectorMode, 'local', 'CLI 优先于环境变量')
  assert.equal(parseServerArgs([], { KB_ROOT: '/env/root' }).root, '/env/root')
  assert.throws(() => parseServerArgs(['--mode', 'quantum'], {}), /local\|llm\|api/)
  assert.throws(() => parseServerArgs(['--root'], {}), /需要一个值/)
  assert.throws(() => parseServerArgs(['--http', '8765'], {}), /KB_MCP_TOKEN/, 'HTTP 必须有 token')
  const http = parseServerArgs(['--http', '8765', '--token', 's3cret', '--bind', '0.0.0.0', '--path', '/mcp'], {})
  assert.deepEqual(http.http, { port: 8765, host: '0.0.0.0', path: '/mcp', token: 's3cret', requireSession: true, allowedOrigins: [] })
  assert.equal(parseServerArgs(['--http', '1', '--token', 't', '--no-session'], {}).http.requireSession, false)
  assert.equal(parseServerArgs(['--readonly'], {}).readonly, true)
  assert.equal(parseServerArgs(['--readonly', 'false'], {}).readonly, false)

  const overridden = await resolveSettings({ root: ROOT, vectorMode: 'llm', readonly: true })
  assert.equal(overridden.rootDir, ROOT)
  assert.equal(overridden.vectorMode, 'llm')
  assert.equal(overridden.tools.allowWrite, false, '--readonly 映射到 tools.allowWrite=false')

  // 环境变量 → parseServerArgs → resolveSettings 的端到端覆盖
  const withEnv = { ...process.env, KB_ROOT: ROOT, KB_VECTOR_MODE: 'api' }
  assert.equal(parseServerArgs([], withEnv).root, ROOT)
  const fromEnv = await resolveSettings(parseServerArgs([], withEnv))
  assert.equal(fromEnv.rootDir, ROOT, 'KB_ROOT 经 parseServerArgs 传到 resolveSettings')
  assert.equal(fromEnv.vectorMode, 'api')
  const bare = await resolveSettings({})
  assert.equal(bare.rootDir, '', '临时 DSH_HOME 里没有 settings.json → 根目录为空（证明没读用户真实配置）')
  await rm(join(HOME, 'knowledge-base'), { recursive: true, force: true }).catch(() => {})
  const line = await readyLine(store, settings, { transport: 'stdio', readonly: true })
  assert.match(line, /就绪 transport=stdio/)
  assert.ok(line.includes(ROOT) && line.includes('docs='), line)
})

// ============================ stdio 传输（进程内，必跑） ============================

await test('stdio 传输：完整握手 + 工具调用 + 非 JSON 行忽略（内存流）', async () => {
  const core = makeCore()
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, clientInfo: { name: 'in-mem', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'kb_search', arguments: { query: 'BM25', limit: 3 } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'kb_add', arguments: { title: 'stdio 写入', text: '# stdio 写入\n\n走 NDJSON 的写路径验证。\n', collection: 'stdio' } } },
    { jsonrpc: '2.0', id: 5, method: 'resources/list', params: {} },
    { jsonrpc: '2.0', id: 6, method: 'resources/read', params: { uri: 'kb://catalog' } },
    'this is definitely not json',
    '',
    { jsonrpc: '2.0', id: 7, method: 'ping' },
  ]
  const lines = requests.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
  const output = []
  const warnings = []
  const input = Readable.from([`${lines.join('\n')}\n`])
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      output.push(chunk.toString('utf8'))
      callback()
    },
  })
  const transport = createStdioTransport({ core, input, output: sink, log: (level, data, line) => warnings.push(line ?? String(data)) })
  await transport.start()
  const replies = output.join('').trim().split('\n').filter(Boolean).map((text) => JSON.parse(text))
  assert.equal(replies.length, 7, `应有 7 条响应（通知与非 JSON 行不回复），实际 ${replies.length}`)
  // 处理允许并发，响应顺序不保证；MCP 客户端按 id 匹配，所以校验 id 集合与逐 id 内容。
  assert.deepEqual([...replies.map((reply) => reply.id)].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7])
  assert.ok(replies.every((reply) => reply.jsonrpc === '2.0'))
  const byId = new Map(replies.map((reply) => [reply.id, reply]))
  assert.equal(byId.get(1).result.protocolVersion, LATEST_PROTOCOL_VERSION)
  assert.equal(byId.get(1).result.serverInfo.name, 'dsh-knowledge-base')
  assert.equal(byId.get(2).result.tools.length, 6)
  assert.ok(!('isError' in byId.get(3).result), textOf(byId.get(3).result))
  assert.equal(byId.get(3).result.structuredContent.results[0].title, 'Harness 知识库设计')
  assert.ok(byId.get(4).result.structuredContent.id)
  assertTempPath(join(ROOT, 'docs', `${byId.get(4).result.structuredContent.id}.md`), 'stdio kb_add 落盘路径')
  assert.ok(byId.get(5).result.resources.some((resource) => resource.uri === kbResourceUri('design', addedA.id)))
  assert.match(byId.get(6).result.contents[0].text, /Knowledge Base Catalog/)
  assert.deepEqual(byId.get(7).result, {})
  assert.ok(warnings.some((text) => /非 JSON/.test(text)), '非 JSON 行要在 stderr（这里是被捕获的 log）警告')
  assert.equal(transport.pending, 0)

  // 跨 chunk 边界的一行（半包）
  const core2 = makeCore()
  const out2 = []
  const sink2 = new Writable({ write(chunk, _e, cb) { out2.push(chunk.toString('utf8')); cb() } })
  const t2 = createStdioTransport({ core: core2, input: new Readable({ read() {} }), output: sink2, log: () => {} })
  const message = JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'ping' })
  t2.feed(message.slice(0, 10))
  assert.deepEqual(out2, [], '没收到换行前不应写出响应')
  t2.feed(`${message.slice(10)}\n`)
  await t2.drain()
  assert.equal(JSON.parse(out2.join('').trim()).id, 99)
  t2.stop()
})

await test('stdio 传输：JSON-RPC 批量数组一次写回', async () => {
  const core = makeCore()
  const out = []
  const sink = new Writable({ write(chunk, _e, cb) { out.push(chunk.toString('utf8')); cb() } })
  const transport = createStdioTransport({ core, input: new Readable({ read() {} }), output: sink, log: () => {} })
  transport.feed(`${JSON.stringify([{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 'b', method: 'tools/list' }])}\n`)
  await transport.drain()
  const batch = JSON.parse(out.join('').trim())
  assert.ok(Array.isArray(batch), '批量请求要回数组')
  assert.deepEqual(batch.map((reply) => reply.id), ['a', 'b'])
  transport.stop()
})

// ============================ stdio 传输（子进程，可选） ============================

async function probeSpawn() {
  try {
    const child = spawn(process.execPath, ['-e', 'let s="";process.stdin.on("data",d=>{s+=d});process.stdin.on("end",()=>process.stdout.write("PONG"+s.length+"\\n"))'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: PACKAGE_DIR,
    })
    const events = { stdout: '', stderr: '', code: null }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      events.stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      events.stderr += chunk
    })
    const done = new Promise((resolveProbe, rejectProbe) => {
      child.once('error', rejectProbe)
      child.once('close', (code) => resolveProbe(code))
      setTimeout(() => rejectProbe(new Error('probe 超时')), 5000)
    })
    child.stdin.write('abc')
    child.stdin.end()
    const code = await done
    return { ok: code === 0 && events.stdout.includes('PONG3'), events }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

const spawnProbe = await probeSpawn()

await test('spawn `node mcp-stdio.mjs --root <临时目录>`：完整 stdio 握手', async () => {
  if (!spawnProbe.ok) {
    console.log(`     原因：${spawnProbe.reason ?? `子进程管道不可用（${spawnProbe.events?.stderr ?? '未知'}）`}`)
    return 'SKIP'
  }
  const child = spawn(process.execPath, [join(PACKAGE_DIR, 'mcp-stdio.mjs'), '--root', ROOT, '--mode', 'local', '--name', 'kb-test'], {
    cwd: PACKAGE_DIR,
    env: { ...process.env, DSH_HOME: HOME, KB_ROOT: ROOT, KB_MCP_READONLY: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin.setEncoding('utf8')
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  const replies = new Map()
  const stderr = []
  let onLines = () => {}
  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const text = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (text !== '') {
        const parsed = JSON.parse(text)
        replies.set(parsed.id, parsed)
        onLines()
      }
      index = buffer.indexOf('\n')
    }
  })
  child.stderr.on('data', (chunk) => stderr.push(chunk))
  const wait = (count) =>
    new Promise((resolveWait, rejectWait) => {
      const timer = setTimeout(() => rejectWait(new Error(`等待响应超时，已有 ${replies.size}/${count}`)), 20000)
      const tick = () => {
        if (replies.size >= count) {
          clearTimeout(timer)
          resolveWait()
          return
        }
        onLines = tick
      }
      tick()
    })

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
  const docUri = kbResourceUri('notes', addedB.id)
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', clientInfo: { name: 'spawn', version: '1' } } })
  await wait(1)
  assert.equal(replies.get(1).result.protocolVersion, '2024-11-05')
  assert.equal(replies.get(1).result.serverInfo.name, 'kb-test')
  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'kb_search', arguments: { query: '混合检索', limit: 5 } } })
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'kb_add', arguments: { title: 'spawn 写入', text: '# spawn 写入\n\n子进程 stdio 写路径。\n', collection: 'spawn' } } })
  send({ jsonrpc: '2.0', id: 5, method: 'resources/list' })
  send({ jsonrpc: '2.0', id: 6, method: 'resources/read', params: { uri: docUri } })
  await wait(6)
  const tools = replies.get(2).result.tools.map((tool) => tool.name)
  assert.deepEqual(tools.sort(), ['kb_add', 'kb_import', 'kb_list', 'kb_manage', 'kb_read', 'kb_search'])
  assert.equal(replies.get(3).result.isError, undefined, textOf(replies.get(3).result))
  assert.ok(replies.get(3).result.structuredContent.total >= 1)
  assert.equal(replies.get(4).result.isError, undefined, textOf(replies.get(4).result))
  assert.ok(replies.get(5).result.resources.some((resource) => resource.uri === 'kb://catalog'))
  assert.equal(replies.get(6).result.contents[0].mimeType, 'text/markdown')
  assert.match(replies.get(6).result.contents[0].text, /MCP 接入/)
  assert.ok(!stderr.join('').includes('\n{'), 'stdout 的协议数据不能混进 stderr，反之日志不能是 JSON')
  assert.match(stderr.join(''), /就绪 transport=stdio/)
  assert.ok(stderr.join('').includes(ROOT), '就绪行要含 root 路径')
  child.stdin.end()
  const exitCode = await new Promise((resolveExit) => child.once('close', (code) => resolveExit(code)))
  assert.equal(exitCode, 0, `stdio 服务器应在 stdin 结束后干净退出（stderr: ${stderr.join('')}）`)
})

// ============================ HTTP 传输 ============================

async function withServer(handler, run) {
  const server = createServer((req, res) => {
    void handler(req, res)
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const base = `http://127.0.0.1:${server.address().port}/mcp`
  try {
    return await run(base)
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose))
  }
}

const HTTP_TOKEN = 'test-secret-token'

await test('HTTP：401（无凭据）→ initialize 200 + Mcp-Session-Id → tools/call', async () => {
  const core = makeCore()
  const handler = createMcpHttpHandler({
    core,
    authorize: (token) => (token === HTTP_TOKEN ? { name: 'ci', via: token ? 'token' : 'none' } : null),
    allowedOrigins: ['http://allowed.example'],
    log: () => {},
  })
  await withServer(handler, async (base) => {
    const unauthorized = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION } }) })
    assert.equal(unauthorized.status, 401)
    assert.match(String(unauthorized.headers.get('www-authenticate')), /Bearer/)

    const initialized = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${HTTP_TOKEN}`, accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', clientInfo: { name: 'http', version: '1' } } }),
    })
    assert.equal(initialized.status, 200)
    assert.match(String(initialized.headers.get('content-type')), /application\/json/, 'Accept 含 event-stream 时仍回 JSON（规范允许的简化）')
    assert.equal(initialized.headers.get('mcp-protocol-version'), '2025-03-26')
    const session = initialized.headers.get('mcp-session-id')
    assert.ok(session && session.length >= 8, 'initialize 要下发 Mcp-Session-Id')
    const envelope = await initialized.json()
    assert.equal(envelope.result.protocolVersion, '2025-03-26')

    const noSession = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': HTTP_TOKEN }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) })
    assert.equal(noSession.status, 400, '缺 Mcp-Session-Id 应 400')
    assert.equal((await noSession.json()).error.code, JSONRPC.INVALID_REQUEST)

    const listed = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': HTTP_TOKEN, 'mcp-session-id': session }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) })
    assert.equal(listed.status, 200, 'X-Api-Key 也要能用')
    assert.equal((await listed.json()).result.tools.length, 6)

    const called = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${HTTP_TOKEN}`, 'mcp-session-id': session },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'kb_search', arguments: { query: 'stdio NDJSON' } } }),
    })
    assert.equal(called.status, 200)
    const payload = await called.json()
    assert.equal(payload.id, 3)
    assert.equal(payload.result.isError, undefined, textOf(payload.result))
    assert.ok(Array.isArray(payload.result.content))

    const noted = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${HTTP_TOKEN}`, 'mcp-session-id': session },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
    })
    assert.equal(noted.status, 202, '纯通知要 202 空响应')
    assert.equal(await noted.text(), '')

    const badOrigin = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${HTTP_TOKEN}`, origin: 'http://evil.example' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' }),
    })
    assert.equal(badOrigin.status, 403)
    const goodOrigin = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${HTTP_TOKEN}`, origin: 'http://allowed.example', 'mcp-session-id': session },
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping' }),
    })
    assert.equal(goodOrigin.status, 200, await goodOrigin.text())

    const malformed = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${HTTP_TOKEN}`, 'mcp-session-id': session }, body: '{ oops' })
    assert.equal(malformed.status, 400)
    assert.equal((await malformed.json()).error.code, JSONRPC.PARSE_ERROR)

    const wrongType = await fetch(base, { method: 'POST', headers: { 'content-type': 'text/plain', authorization: `Bearer ${HTTP_TOKEN}` }, body: 'hello' })
    assert.equal(wrongType.status, 415)

    const got = await fetch(base, { method: 'GET', headers: { authorization: `Bearer ${HTTP_TOKEN}` } })
    assert.equal(got.status, 405)
    assert.equal(got.headers.get('allow'), 'POST, DELETE, GET')
    const removed = await fetch(base, { method: 'DELETE', headers: { authorization: `Bearer ${HTTP_TOKEN}`, 'mcp-session-id': session } })
    assert.equal(removed.status, 410)
    assert.match((await removed.json()).error, /stateless/)
    const afterDelete = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${HTTP_TOKEN}`, 'mcp-session-id': session }, body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'ping' }) })
    assert.equal(afterDelete.status, 400, 'DELETE 后该 session 不再有效')

    const methodless = await fetch(base, { method: 'PUT', headers: { authorization: `Bearer ${HTTP_TOKEN}` } })
    assert.equal(methodless.status, 405)
  })
})

await test('HTTP：requireSession=false 时可直接调用；未鉴权时同样 401', async () => {
  const core = makeCore()
  const handler = createMcpHttpHandler({ core, authorize: () => null, requireSession: false, log: () => {} })
  await withServer(handler, async (base) => {
    const denied = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
    assert.equal(denied.status, 401)
  })
  const open = createMcpHttpHandler({ core: makeCore(), requireSession: false, log: () => {} })
  await withServer(open, async (base) => {
    const reply = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
    assert.equal(reply.status, 200)
    assert.equal((await reply.json()).result.tools.length, 6, '无 authorize 时不校验凭据（由调用方负责隔离）')
    const sessionless = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'resources/list' }) })
    assert.equal(sessionless.status, 200)
  })
})

await test('kb_manage {action:"mcp_info"} 在独立 MCP 服务器上可用', async () => {
  const core = makeCore()
  await ask(core, 'initialize', { protocolVersion: LATEST_PROTOCOL_VERSION, clientInfo: { name: 'info-check', version: '1' } })
  const info = await ask(core, 'tools/call', { name: 'kb_manage', arguments: { action: 'mcp_info' } })
  assert.equal(info.result.isError, undefined, textOf(info.result))
  const value = info.result.structuredContent
  assert.equal(value.server.name, 'dsh-knowledge-base')
  assert.equal(value.protocol.negotiated, LATEST_PROTOCOL_VERSION)
  assert.equal(value.protocol.initialized, true)
  assert.deepEqual(value.tools, ['kb_search', 'kb_read', 'kb_list', 'kb_add', 'kb_import', 'kb_manage'])
  assert.deepEqual(Object.keys(value.capabilities).sort(), ['resources', 'tools'])
  assert.equal(value.transport, 'stdio')
  assert.equal(value.resources.catalog, 'kb://catalog')
  assert.ok(value.resources.count >= 3)
  assert.equal(value.readonly, false)
})

await test('maxTextChars（settings.mcp.maxTextChars）截断过长的工具输出', async () => {
  const long = await store.add({ title: '长文截断测试', text: Array.from({ length: 40 }, (_, i) => `段落 ${i}：${'知识库内容'.repeat(20)}`).join('\n\n'), collection: 'clamp' })
  const core = makeCore({ maxTextChars: 200 })
  const reply = await ask(core, 'tools/call', { name: 'kb_read', arguments: { id: long.id, limit: 4000 } })
  const text = textOf(reply.result)
  assert.ok(text.length < 600, `应被截断，实际 ${text.length}`)
  assert.match(text, /已截断/)
  assert.ok(reply.result.structuredContent.content.length > text.length, 'structuredContent 保持完整')
  const unlimited = makeCore()
  const full = await ask(unlimited, 'tools/call', { name: 'kb_read', arguments: { id: long.id, limit: 4000 } })
  assert.ok(!/已截断/.test(textOf(full.result)))
  assert.ok(textOf(full.result).length > 600)
})

await test('mcpSurface：settings.mcp 的默认值与 CLI 覆盖', async () => {
  assert.deepEqual(mcpSurface({}), { enabled: true, http: true, requireToken: true, allowLocalOrigin: true, allowedOrigins: [], allowWrite: true, maxTextChars: 0 })
  const surface = mcpSurface({
    mcp: { allowWrite: false, allowedOrigins: ['http://localhost:64173', ''], requireToken: false, maxTextChars: 1234, allowLocalOrigin: false },
  })
  assert.equal(surface.allowWrite, false)
  assert.equal(surface.requireToken, false)
  assert.deepEqual(surface.allowedOrigins, ['http://localhost:64173'])
  assert.equal(surface.maxTextChars, 1234)
  assert.equal(surface.allowLocalOrigin, false)
  const settingsWithMcp = normalizeSettings({ rootDir: ROOT, mcp: { allowWrite: false } })
  assert.equal(mcpSurface(settingsWithMcp).allowWrite, false, 'normalizeSettings 要保留 mcp 段')
})

await test('MCP 凭据 → 插件身份：token_issue 签发的只读 token 受 RBAC 约束', async () => {
  const rbacRoot = join(HOME, 'rbac-kb')
  const rbacSettings = normalizeSettings({ rootDir: rbacRoot, chunkSize: 400, vectorDim: 512, security: { rbac: { enabled: true, localRole: 'owner' } } })
  const rbacStore = new KnowledgeStore(rbacSettings, null)
  await rbacStore.init()
  await rbacStore.setRbac({ enabled: true, localRole: 'owner' })
  await rbacStore.manageUsers({ action: 'add', name: '只读客户端', role: 'reader' })
  const issued = await rbacStore.manageUsers({ action: 'token_issue', user: '只读客户端', label: 'mcp-test', scopes: ['read'], ttlDays: 0 })
  assert.match(issued.token, /^kb_[0-9a-f]{24,}$/, 'token 形状应与 users.js 一致')

  const tools = buildKbTools({ store: rbacStore, settings: rbacSettings, log: () => {} })
  const core = createMcpCore({ store: rbacStore, tools, log: () => {} })
  const authorize = storeTokenAuthorize(rbacStore, { fallbackToken: 'static-fallback' })

  const reader = await authorize(issued.token, null)
  assert.equal(reader.role, 'reader', 'token 必须解析成签发它的用户身份')
  assert.equal(reader.via, 'token')
  const read = await ask(core, 'tools/call', { name: 'kb_add', arguments: { title: '不该成功', text: '# 不该成功\n\n只读 token 不能写。\n' } }, { transport: 'http', actor: reader })
  assert.equal(read.result.isError, true, 'RBAC 开启时只读 token 的写操作必须被拒绝')
  assert.match(textOf(read.result), /权限|Forbidden|无权/i)
  const search = await ask(core, 'tools/call', { name: 'kb_search', arguments: { query: 'nothing' } }, { transport: 'http', actor: reader })
  assert.equal(search.result.isError, undefined, textOf(search.result))

  const fallbackActor = await authorize('static-fallback', null)
  assert.equal(fallbackActor.role, 'owner', '静态 --token 兜底为本机身份')
  const write = await ask(core, 'tools/call', { name: 'kb_add', arguments: { title: '本机写入', text: '# 本机写入\n\nowner 身份可以写。\n' } }, { transport: 'http', actor: fallbackActor })
  assert.equal(write.result.isError, undefined, textOf(write.result))
  const written = await rbacStore.read({ id: write.result.structuredContent.id })
  assert.ok(written.content.includes('owner 身份可以写'))
  const overreach = await ask(core, 'tools/call', { name: 'kb_manage', arguments: { action: 'user_add', userName: '越权用户', role: 'owner' } }, { transport: 'http', actor: reader })
  assert.equal(overreach.result.isError, true, 'reader 身份不能管理用户（security 需要 owner）')
  assert.match(textOf(overreach.result), /权限|无权|Forbidden/i)
  const whoami = await ask(core, 'tools/call', { name: 'kb_manage', arguments: { action: 'security_status' } }, { transport: 'http', actor: reader })
  assert.equal(whoami.result.structuredContent?.whoami?.role, 'reader', 'security_status 要如实报告调用者身份')
  assert.equal(whoami.result.structuredContent?.whoami?.via, 'token')
  const ownerOps = await ask(core, 'tools/call', { name: 'kb_manage', arguments: { action: 'user_list' } }, { transport: 'http', actor: fallbackActor })
  assert.equal(ownerOps.result.isError, undefined, textOf(ownerOps.result))
  assert.ok(ownerOps.result.structuredContent.users.some((user) => user.name === '只读客户端'))
  assert.equal(ownerOps.result.structuredContent.whoami.role, 'owner')

  // stdio 的 --token：整个进程固定成该 token 的身份
  const startup = await resolveStartupActor(rbacStore, issued.token, () => {})
  assert.equal(startup.role, 'reader')
  assert.equal(startup.via, 'token')
  assert.equal(await resolveStartupActor(rbacStore, '', () => {}), null)
  assert.equal(await resolveStartupActor(rbacStore, 'kb_not_a_token', () => {}), null, '解析失败时退回本机身份（并警告）')

  assert.equal(await authorize('kb_deadbeef', null), null, '未知 token 必须拒绝')
  assert.equal(await authorize(null, null), null)
  assert.equal(await authorize({ actor: reader }, null), reader, '被核心层误用为 authorize(info) 时沿用 actor')
  assertTempPath(join(rbacRoot, 'secure', 'users.json'), 'RBAC 测试的用户文件路径')
})

await test('HTTP：runHttpServer 真实装配（token 回调只给 HTTP 层，actor 贯通核心层）', async () => {
  const server = await runHttpServer({ settings, root: ROOT, http: { port: 0, host: '127.0.0.1', path: '/mcp', token: 'wired-token' }, log: () => {} })
  try {
    const base = `http://127.0.0.1:${server.http.port}/mcp`
    const init = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wired-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION } }),
    })
    assert.equal(init.status, 200)
    const session = init.headers.get('mcp-session-id')
    assert.ok(session)
    const listed = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'wired-token', 'mcp-session-id': session },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    })
    const payload = await listed.json()
    assert.equal(payload.error, undefined, '核心层不能把 HTTP 层的 (token, req) 回调当 info 用，否则全是 -32001')
    assert.equal(payload.result.tools.length, 6)
    const called = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wired-token', 'mcp-session-id': session },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'kb_list', arguments: { limit: 5 } } }),
    })
    const callPayload = await called.json()
    assert.equal(callPayload.result?.isError, undefined, textOf(callPayload.result ?? {}))
    assert.ok(callPayload.result.structuredContent.total >= 3)
    const wrongToken = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' }),
    })
    assert.equal(wrongToken.status, 401)
  } finally {
    await server.stop()
  }
})

await test('bearerAuthorize：长度/内容不匹配拒绝，误用为 core 层时沿用 actor', async () => {
  const authorize = bearerAuthorize('secret')
  assert.equal(authorize('secret').name, 'mcp-token')
  assert.equal(authorize('secre'), null)
  assert.equal(authorize('nope'), null)
  assert.equal(authorize(null), null)
  assert.equal(authorize({ actor: { name: 'from-http' } }).name, 'from-http', '被误当核心层调用时不应全线拒绝')
})

await test('HTTP：core 的 authorize 拒绝也走 -32001（HTTP 层放行时）', async () => {
  const core = makeCore({ authorize: (info) => (info.method === 'tools/list' ? null : info.actor) })
  const handler = createMcpHttpHandler({ core, authorize: () => ({ name: 'ok' }), requireSession: false, log: () => {} })
  await withServer(handler, async (base) => {
    const reply = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
    assert.equal(reply.status, 200)
    assert.equal((await reply.json()).error.code, JSONRPC.UNAUTHORIZED)
  })
})

// ============================ 收尾 ============================

const finalStatus = await store.status()
assert.ok(finalStatus.docs >= 4, `临时库应该有文档，实际 ${finalStatus.docs}`)
assertTempPath(finalStatus.root, 'store 根目录')

await rm(HOME, { recursive: true, force: true })

console.log('')
console.log(`mcp: ${passed} passed, ${failed} failed, ${skipped} skipped (spawn ${spawnProbe.ok ? '可用' : `不可用：${spawnProbe.reason ?? '管道被拒'}`})`)
console.log(`mcp: 临时知识库 ${ROOT} 已删除，全程只用了临时目录`)
if (failed > 0) process.exitCode = 1
