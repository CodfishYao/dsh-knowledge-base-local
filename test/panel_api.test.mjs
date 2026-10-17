/**
 * Panel-facing HTTP API self-check.
 *
 * Mounts the very same `createApiHandler` the Host registers on /kb-api and
 * drives every route the Settings panel calls — root change, uploads (PDF /
 * Office extraction), folder import, search, trash, export, settings, security
 * (encryption + RBAC + tokens) and MCP config — over real HTTP.
 *
 * Temp knowledge base + temp DSH_HOME only; the real knowledge base is never touched.
 *   node test/panel_api.test.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { KnowledgeStore } from '../src/store.js'
import { expandPath, loadSettings, normalizeSettings, resolveRoot, saveSettings } from '../src/settings.js'
import { createApiHandler } from '../src/api.js'
import { fixtures } from './extract.test.mjs'

async function main() {
  const home = await mkdtemp(join(tmpdir(), 'kb-panel-'))
  process.env.DSH_HOME = home
  const root = join(home, 'kb')
  let server = null
  let passed = 0
  const ok = (name) => {
    passed++
    console.log(`ok   - ${name}`)
  }

  const docx = fixtures().docx()
  const pdf = fixtures().pdf()
  const xlsx = fixtures().xlsx()

  try {
    let settings = normalizeSettings({ rootDir: '', chunkSize: 400, chunkOverlap: 60, vectorDim: 512 })
    const store = new KnowledgeStore(settings, null)
    await store.loadSecurity()

    // A faithful stand-in for index.js's runtime: /config really persists
    // settings and re-attaches the store to the new root.
    const runtime = {
      get settings() {
        return settings
      },
      async status() {
        if (store.configured && !store.locked) {
          try {
            return await store.status()
          } catch {
            /* fall through to the locked/blank shape below */
          }
        }
        return {
          configured: store.configured,
          root: store.root ?? '',
          locked: store.locked,
          vectorMode: settings.vectorMode,
          settingsPath: store.settingsPath,
          security: {
            encryption: store.crypto.status(),
            locked: store.locked,
            access: store.directory.status(),
          },
          message: store.configured ? '已锁定' : '未配置',
        }
      },
      async configure(patch = {}) {
        const next = {}
        if (patch.rootDir !== undefined && String(patch.rootDir).trim() !== '') next.rootDir = expandPath(String(patch.rootDir).trim())
        for (const key of ['vectorMode', 'chunkSize', 'chunkOverlap', 'vectorDim', 'defaultCollection']) {
          if (patch[key] !== undefined) next[key] = patch[key]
        }
        if (patch.llmProvider !== undefined || patch.llmModel !== undefined) {
          next.llm = { provider: patch.llmProvider ?? '', model: patch.llmModel ?? '' }
        }
        if (patch.embeddingEndpoint !== undefined || patch.embeddingModel !== undefined) {
          next.embedding = { endpoint: patch.embeddingEndpoint ?? '', model: patch.embeddingModel ?? '' }
        }
        if (patch.watchEnabled !== undefined) next.watch = { enabled: Boolean(patch.watchEnabled) }
        if (patch.tools !== undefined) next.tools = { allowWrite: patch.tools?.allowWrite !== false }
        if (patch.security !== undefined) {
          next.security = {
            metadata: patch.security?.metadata === 'encrypted' ? 'encrypted' : 'plain',
            rbac: { enabled: Boolean(patch.security?.rbac?.enabled), localRole: patch.security?.rbac?.localRole ?? 'owner' },
          }
        }
        if (patch.mcp !== undefined) next.mcp = { ...patch.mcp }
        if (next.rootDir) {
          await mkdir(next.rootDir, { recursive: true })
        }
        settings = await saveSettings(next, {})
        store.settings = settings
        store.root = resolveRoot(settings)
        store.indexCache.clear()
        await store.loadSecurity()
        if (store.configured && !store.locked) await store.init()
        return runtime.status()
      },
    }

    const handler = createApiHandler({ getStore: () => store, runtime, mcpInfo: () => answersMcp() })
    function answersMcp() {
      return {
        enabled: settings.mcp.enabled !== false,
        httpMounted: settings.mcp.enabled !== false && settings.mcp.http !== false,
        path: '/kb-mcp',
        url: 'http://127.0.0.1:0/kb-mcp',
        readonly: settings.mcp.allowWrite === false,
        requireToken: settings.mcp.requireToken !== false,
        allowLocalOrigin: settings.mcp.allowLocalOrigin !== false,
        allowedOrigins: settings.mcp.allowedOrigins ?? [],
        tools: ['kb_search', 'kb_read', 'kb_list', 'kb_add', 'kb_import', 'kb_manage'],
        stdioConfig: { mcpServers: { 'dsh-knowledge-base': { command: 'node', args: ['/abs/mcp-stdio.mjs'] } } },
        httpConfig: { mcpServers: { 'dsh-knowledge-base': { url: 'http://127.0.0.1:0/kb-mcp' } } },
        note: 'test',
      }
    }

    server = createServer(handler)
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}/kb-api`

    const get = async (path) => {
      const response = await fetch(base + path)
      return { status: response.status, body: await response.json().catch(() => ({})) }
    }
    const send = async (path, body) => {
      const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
      return { status: response.status, body: await response.json().catch(() => ({})) }
    }

    // ---- 1. first run + root change ---------------------------------------
    const before = await get('/status')
    assert.equal(before.body.configured, false, '初始应未配置')
    const configured = await send('/config', { rootDir: root })
    assert.equal(configured.status, 200)
    assert.equal(configured.body.configured, true)
    assert.equal(configured.body.root, root)
    const changed = await send('/config', { rootDir: join(home, 'kb2') })
    assert.equal(changed.body.root, join(home, 'kb2'))
    await send('/config', { rootDir: root })
    ok('首次配置与根目录更换（/config rootDir）')

    // ---- 2. text document + search + read ---------------------------------
    const added = await send('/add', { title: '面板自检文档', text: '# 面板自检\n\n这段正文用来验证检索与读取。\n', collection: 'panel', tags: 'a,b' })
    assert.equal(added.status, 200)
    const listed = await get('/docs?limit=10&sort=updated')
    assert.equal(listed.body.total, 1)
    assert.equal(listed.body.docs[0].title, '面板自检文档')
    const searched = await get(`/search?q=${encodeURIComponent('检索')}&limit=5`)
    assert.ok(searched.body.results.length > 0)
    const one = await get(`/doc?id=${added.body.id}`)
    assert.match(one.body.content, /面板自检/)
    const cols = await get('/collections')
    assert.ok(cols.body.collections.some((item) => item.name === 'panel'))
    ok('新增文本 / 列表 / 检索 / 读取 / 集合')

    // ---- 3. upload PDF + Office (the panel import path) -------------------
    const upload = await send('/upload', {
      files: [
        { name: 'channel.docx', data: docx.toString('base64') },
        { name: 'sample.pdf', data: pdf.toString('base64') },
        { name: 'data.xlsx', data: xlsx.toString('base64') },
        { name: 'broken.doc', data: Buffer.alloc(512).fill(0).toString('base64') },
        { name: 'empty.txt', data: '' },
      ],
      collection: 'uploaded',
      tags: 'upload',
    })
    assert.equal(upload.status, 200, JSON.stringify(upload.body))
    assert.equal(upload.body.failed, 1, JSON.stringify(upload.body.results))
    assert.ok(upload.body.imported >= 3, JSON.stringify(upload.body.results))
    const byName = Object.fromEntries(upload.body.results.map((item) => [item.name, item]))
    assert.equal(byName['channel.docx'].extract.kind, 'docx')
    assert.equal(byName['sample.pdf'].extract.kind, 'pdf')
    assert.equal(byName['sample.pdf'].extract.pages, 2)
    assert.equal(byName['data.xlsx'].extract.kind, 'xlsx')
    assert.ok(byName['channel.docx'].id)
    assert.equal(byName['broken.doc'].extract.failed, true, '无法抽取的 .doc 应保留附件并标记失败')
    assert.equal(byName['empty.txt'].error, '空文件')
    const pdfHit = await get(`/search?q=${encodeURIComponent('你好知识库')}&limit=5`)
    assert.ok(pdfHit.body.results.length > 0, 'PDF 抽取的正文应可检索')
    const docxHit = await get(`/search?q=${encodeURIComponent('渠道手册')}&limit=5`)
    assert.ok(docxHit.body.results.length > 0, 'docx 抽取的正文应可检索')
    ok('上传导入：docx/pdf/xlsx 抽取入库，坏文件与空文件如实报错')

    // ---- 4. folder import + export + reindex + scan -----------------------
    const srcDir = join(home, 'notes')
    await mkdir(srcDir, { recursive: true })
    await writeFile(join(srcDir, 'n1.md'), '# 目录笔记一\n\n批量导入验证。\n', 'utf8')
    await writeFile(join(srcDir, 'n2.pptx'), fixtures().pptx())
    const imported = await send('/import', { path: srcDir, collection: 'bulk', recursive: true, maxDocs: 50, useHeadingTitle: true })
    assert.equal(imported.status, 200)
    assert.ok(imported.body.imported >= 2, JSON.stringify(imported.body))
    const reindexed = await send('/reindex', { full: true })
    assert.equal(reindexed.status, 200)
    const scanned = await send('/scan', {})
    assert.equal(scanned.status, 200)
    const exported = await send('/export', { format: 'md' })
    assert.equal(exported.status, 200)
    assert.ok(exported.body.path.startsWith('exports/'))
    assert.ok((await readFile(join(root, exported.body.path), 'utf8')).includes('渠道手册'))
    ok('目录批量导入 / 重建索引 / 扫描 / 导出')

    // ---- 5. trash round trip ---------------------------------------------
    await send('/delete', { id: added.body.id })
    const trash = await get('/trash')
    assert.equal(trash.body.items.length, 1)
    await send('/restore', { id: added.body.id })
    assert.equal((await get('/trash')).body.items.length, 0)
    await send('/delete', { id: added.body.id })
    const purged = await send('/purge', { id: added.body.id })
    assert.equal(purged.status, 200)
    assert.equal((await get('/docs?limit=50')).body.total >= 4, true)
    ok('回收站：删除 / 恢复 / 彻底删除')

    // ---- 6. MCP config round trip ----------------------------------------
    const mcpBefore = await get('/mcp')
    assert.equal(mcpBefore.body.requireToken, true)
    await send('/config', {
      mcp: { enabled: true, http: true, requireToken: false, allowLocalOrigin: true, allowWrite: false, allowedOrigins: ['http://localhost:18789'] },
    })
    const mcpAfter = await get('/mcp')
    assert.equal(mcpAfter.body.requireToken, false)
    assert.equal(mcpAfter.body.readonly, true)
    assert.deepEqual(mcpAfter.body.allowedOrigins, ['http://localhost:18789'])
    ok('MCP 接入设置：开关与 Origin 落盘并经 /mcp 回读')

    // ---- 7. encryption lifecycle over HTTP --------------------------------
    const enabled = await send('/security', { action: 'enable', passphrase: 'panel-passphrase-123', metadataMode: 'plain' })
    assert.equal(enabled.status, 200, JSON.stringify(enabled.body))
    const secOn = await get('/security')
    assert.equal(secOn.body.encryption.enabled, true)
    assert.ok((await readFile(store.docFile(upload.body.results[0].id), 'utf8')).includes('KBENC1:'))
    await send('/security', { action: 'lock' })
    const lockedStatus = await get('/status')
    assert.equal(lockedStatus.status, 200, '锁定后 /status 仍须可读')
    assert.equal(lockedStatus.body.locked, true)
    assert.equal(lockedStatus.body.security.encryption.enabled, true)
    const refused = await send('/add', { text: '应被拒绝', collection: 'panel' })
    assert.equal(refused.status, 423, '锁定后写入应 423')
    const wrong = await send('/security', { action: 'unlock', passphrase: 'definitely-wrong' })
    assert.equal(wrong.status, 400)
    const unlocked = await send('/security', { action: 'unlock', passphrase: 'panel-passphrase-123' })
    assert.equal(unlocked.status, 200)
    assert.match((await get(`/doc?id=${upload.body.results[0].id}`)).body.content, /渠道手册/)
    const rotated = await send('/security', { action: 'passphrase', currentPassphrase: 'panel-passphrase-123', newPassphrase: 'rotated-passphrase-456' })
    assert.equal(rotated.status, 200, JSON.stringify(rotated.body))
    assert.equal((await send('/security', { action: 'lock' })).status, 200)
    const unlocked2 = await send('/security', { action: 'unlock', passphrase: 'rotated-passphrase-456' })
    assert.equal(unlocked2.status, 200, JSON.stringify(unlocked2.body))
    const afterChange = await get(`/doc?id=${upload.body.results[0].id}`)
    assert.equal(afterChange.status, 200, JSON.stringify(afterChange.body))
    assert.match(afterChange.body.content, /渠道手册/)
    const metaOn = await send('/security', { action: 'metadata', mode: 'encrypted' })
    assert.equal(metaOn.status, 200)
    assert.ok(!(await readFile(join(root, 'kb.json'), 'utf8')).includes('渠道手册'))
    await send('/security', { action: 'metadata', mode: 'plain' })
    const off = await send('/security', { action: 'disable' })
    assert.equal(off.status, 200)
    assert.equal((await get('/security')).body.encryption.enabled, false)
    assert.ok(!(await readFile(store.docFile(upload.body.results[0].id), 'utf8')).includes('KBENC1:'))
    ok('加密全流程（HTTP）：开启 → 锁定 423 → 解锁 → 改口令 → 元数据加密 → 关闭')

    // ---- 8. RBAC + users + grants + tokens over HTTP ----------------------
    const rbacOn = await send('/users', { action: 'enable', localRole: 'owner' })
    assert.equal(rbacOn.status, 200)
    const created = await send('/users', { action: 'add', name: '面板只读', role: 'reader' })
    assert.ok(created.body.id ?? created.body.user?.id)
    const userId = created.body.id ?? created.body.user?.id
    const editor = await send('/users', { action: 'add', name: '面板编辑', role: 'editor' })
    const editorId = editor.body.id ?? editor.body.user?.id
    await send('/users', { action: 'passphrase', user: userId, passphrase: 'user-passphrase-1' })
    await send('/grants', { user: editorId, collection: 'bulk', role: 'reader' })
    const directory = await get('/users')
    const names = directory.body.users.map((item) => item.name)
    assert.ok(names.includes('面板只读') && names.includes('面板编辑'), JSON.stringify(names))
    assert.ok(directory.body.users.some((item) => item.role === 'owner'), '开启 RBAC 应为本机身份建立 owner 记录')
    assert.equal(directory.body.grants.length, 1)
    const grantRow = directory.body.grants[0]
    assert.equal(grantRow.collection, 'bulk')
    assert.equal(grantRow.role, 'reader')

    const issued = await send('/tokens', { user: userId, label: 'cursor', scopes: ['read'], ttlDays: 0 })
    const readerToken = issued.body.token
    assert.match(String(readerToken), /^kb_[0-9a-f]{40,}$/)
    assert.ok(issued.body.record?.id, '签发结果应带令牌 id')
    const tokenGet = async (path, token) => {
      const response = await fetch(base + path, { headers: { authorization: `Bearer ${token}` } })
      return { status: response.status, body: await response.json().catch(() => ({})) }
    }
    const tokenPost = async (path, token, body) => {
      const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body ?? {}) })
      return { status: response.status, body: await response.json().catch(() => ({})) }
    }
    const who = await tokenGet('/whoami', readerToken)
    assert.equal(who.body.actor.role, 'reader')
    assert.equal((await tokenGet(`/search?q=${encodeURIComponent('渠道手册')}`, readerToken)).status, 200)
    assert.equal((await tokenPost('/add', readerToken, { text: 'reader 不该写入', collection: 'panel' })).status, 403)
    assert.equal((await tokenPost('/users', readerToken, { action: 'add', name: 'x', role: 'admin' })).status, 403)
    const editorToken = (await send('/tokens', { user: editorId, scopes: ['read', 'write'] })).body.token
    assert.equal((await tokenPost('/add', editorToken, { text: 'editor 可写 bulk 之外的文件', collection: 'panel' })).status, 200)
    assert.equal((await tokenPost('/add', editorToken, { text: 'bulk 被收紧为只读', collection: 'bulk' })).status, 403)
    const revoked = await send('/tokens', { action: 'revoke', tokenId: issued.body.record.id })
    assert.equal(revoked.status, 200)
    assert.equal((await tokenGet('/whoami', readerToken)).status, 401, '吊销后令牌立刻失效')
    await send('/users', { action: 'disable' })
    ok('RBAC（HTTP）：用户/口令/集合授权/令牌签发·越权拒绝·吊销')

    // ---- 9. write tools can be switched off -------------------------------
    await send('/config', { tools: { allowWrite: false } })
    assert.equal((await send('/add', { text: '写入已被禁用', collection: 'panel' })).status, 403)
    assert.equal((await send('/upload', { files: [{ name: 'a.txt', data: Buffer.from('hi').toString('base64') }] })).status, 403)
    await send('/config', { tools: { allowWrite: true } })
    assert.equal((await send('/add', { text: '写入恢复', collection: 'panel' })).status, 200)
    ok('关闭写入工具后 /add 与 /upload 均 403，重新开启后恢复')

    // ---- 10. misc panel calls --------------------------------------------
    assert.equal((await get('/health')).body.ok, true)
    assert.equal((await get('/whoami')).body.actor.role, 'owner')
    const docs = await get('/docs?limit=2&offset=0&sort=updated')
    assert.ok(docs.body.docs.length <= 2)
    assert.equal((await get('/nope')).status, 404)
    ok('health / whoami / 分页 / 未知路由 404')

    console.log(`\npanel-api: ${passed} passed, 0 failed`)
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