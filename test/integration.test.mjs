/**
 * Store-level integration self-check: document extraction in the real import
 * path, the encryption lifecycle, and multi-user permissions (RBAC + tokens),
 * including the JSON API the Web panel uses.
 *
 * Everything happens in a fresh temp directory; the real knowledge base is never read.
 *   node test/integration.test.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { KnowledgeStore } from '../src/store.js'
import { normalizeSettings } from '../src/settings.js'
import { createApiHandler } from '../src/api.js'
import { fixtures } from './extract.test.mjs'

const PASS = 'a-long-passphrase-1234'
const PASS2 = 'another-long-passphrase-5678'

async function main() {
  const home = await mkdtemp(join(tmpdir(), 'kb-integrate-'))
  const root = join(home, 'kb')
  process.env.DSH_HOME = home
  let passed = 0
  const ok = (name) => {
    passed++
    console.log(`ok   - ${name}`)
  }

  try {
    const settings = normalizeSettings({ rootDir: root, chunkSize: 400, chunkOverlap: 60, vectorDim: 512 })
    const store = new KnowledgeStore(settings, null)
    await store.loadSecurity()
    await store.init()
    const runtime = { settings, status: async () => store.status(), configure: async () => ({}), touch: async () => ({}) }

    // ---- 1. extraction through the real store path ------------------------
    const fx = fixtures()
    const docxPath = join(home, 'channel.docx')
    await writeFile(docxPath, fx.docx())
    const docxDoc = await store.add({ filePath: docxPath, collection: 'docs' })
    assert.equal(docxDoc.extract?.kind, 'docx', JSON.stringify(docxDoc.extract))
    const docxBody = await store.read({ id: docxDoc.id })
    assert.match(docxBody.content, /渠道手册/)
    assert.match(docxBody.content, /AES-256-GCM/)
    assert.ok(docxDoc.file, '原始附件应保留')
    ok('kb_add(filePath=docx) 抽取正文 + 保留附件')

    const pdfPath = join(home, 'sample.pdf')
    await writeFile(pdfPath, fx.pdf())
    const pdfDoc = await store.add({ filePath: pdfPath, collection: 'docs' })
    assert.equal(pdfDoc.extract?.kind, 'pdf')
    const pdfBody = await store.read({ id: pdfDoc.id })
    assert.match(pdfBody.content, /你好知识库/)
    assert.match(pdfBody.content, /Hello KB/)
    ok('kb_add(filePath=pdf) 简单字体 + CID 中文入库')

    const oleBuf = Buffer.alloc(512)
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(oleBuf, 0)
    const legacyPath = join(home, 'legacy.doc')
    await writeFile(legacyPath, oleBuf)
    const legacyDoc = await store.add({ filePath: legacyPath, collection: 'docs' })
    assert.equal(legacyDoc.extract?.failed, true)
    const legacyBody = await store.read({ id: legacyDoc.id })
    assert.match(legacyBody.content, /旧式|抽取失败/)
    assert.ok(legacyDoc.file, '抽取失败也要保留附件')
    ok('无法抽取的文档降级为「占位正文 + 附件」而不是报错')

    const srcDir = join(home, 'src-dir')
    await mkdir(srcDir, { recursive: true })
    await writeFile(join(srcDir, 'note.md'), '# 目录笔记\n\n来自目录导入的 markdown。\n', 'utf8')
    await writeFile(join(srcDir, 'deck.pptx'), fx.pptx())
    await writeFile(join(srcDir, 'book.docx'), fx.docx())
    await writeFile(join(srcDir, 'data.xlsx'), fx.xlsx())
    const imported = await store.importDirectory({ path: srcDir, collection: 'bulk' })
    assert.equal(imported.imported, 4, JSON.stringify(imported.results))
    assert.equal(imported.failed, 0)
    const extracted = imported.results.map((r) => r.extracted).sort().join(',')
    assert.equal(extracted, 'docx,pptx,text,xlsx')
    const xlsxHit = await store.search({ query: '12800', limit: 5 })
    assert.ok(xlsxHit.results.length > 0, '抽取出的表格数字应可检索')
    ok('kb_import 目录混排文本 + 三种 Office 文档全部入库')

    const textHit = await store.search({ query: 'AES-256-GCM', limit: 5 })
    assert.ok(textHit.results.some((r) => r.docId === docxDoc.id))
    ok('抽取正文进入检索索引')

    // ---- 2. encryption lifecycle -----------------------------------------
    const enable = await store.enableEncryption({ passphrase: PASS })
    assert.equal(enable.encryption?.enabled ?? enable.enabled ?? true, true)
    const rawDoc = await readFile(store.docFile(docxDoc.id), 'utf8')
    assert.match(rawDoc, /KBENC1:/, '正文应写成信封')
    assert.ok(!rawDoc.includes('AES-256-GCM'), '明正文本不应留在磁盘')
    const manifestText = await readFile(join(root, 'kb.json'), 'utf8')
    assert.ok(manifestText.includes('渠道手册'), '默认元数据明文')
    const stillReadable = await store.read({ id: docxDoc.id })
    assert.match(stillReadable.content, /渠道手册/, '解锁状态下读取应透明')
    ok('启用加密：磁盘变密文，读取仍透明，元数据默认明文')

    await store.lockKnowledgeBase()
    assert.equal(store.locked, true)
    await assert.rejects(() => store.search({ query: 'AES' }), /锁定/)
    await assert.rejects(() => store.add({ text: '写入应被拒绝 locked write text', collection: 'docs' }), /锁定/)
    ok('锁定后所有读写被拒，不会把信封当明文重写')

    await assert.rejects(() => store.unlockKnowledgeBase({ passphrase: 'wrong-passphrase-xyz' }), /口令/)
    await store.unlockKnowledgeBase({ passphrase: PASS })
    assert.equal(store.locked, false)
    assert.match((await store.read({ id: docxDoc.id })).content, /渠道手册/)
    ok('错误口令拒绝解锁，正确口令恢复读取')

    await store.changePassphrase({ current: PASS, next: PASS2 })
    await store.lockKnowledgeBase()
    await assert.rejects(() => store.unlockKnowledgeBase({ passphrase: PASS }), /口令/)
    await store.unlockKnowledgeBase({ passphrase: PASS2 })
    assert.match((await store.read({ id: pdfDoc.id })).content, /Hello KB/, '改口令后旧数据仍解密')
    ok('更换口令只重包裹数据密钥，语料无需重写且仍可读')

    await store.setMetadataEncryption({ mode: 'encrypted', passphrase: PASS2 })
    const hiddenManifest = await readFile(join(root, 'kb.json'), 'utf8')
    assert.ok(!hiddenManifest.includes('渠道手册'), '元数据加密后标题不应留在明文')
    assert.match(hiddenManifest, /kbEncryption/, '清单应成为信封')
    const catalog = await readFile(join(root, 'CATALOG.md'), 'utf8')
    assert.match(catalog, /元数据加密/, 'CATALOG 不应泄漏标题')
    assert.match((await store.read({ id: docxDoc.id })).content, /渠道手册/, '加密元数据仍可正常读取')
    await store.setMetadataEncryption({ mode: 'plain', passphrase: PASS2 })
    assert.ok((await readFile(join(root, 'kb.json'), 'utf8')).includes('渠道手册'))
    ok('元数据加密开关双向迁移，CATALOG 随之降级为提示')

    const disable = await store.disableEncryption({ passphrase: PASS2 })
    assert.equal(disable.encryption?.enabled ?? disable.enabled ?? false, false)
    const plainDoc = await readFile(store.docFile(docxDoc.id), 'utf8')
    assert.ok(!plainDoc.includes('KBENC1:'), '关闭加密后应回到明文')
    assert.match(plainDoc, /渠道手册|AES-256-GCM/)
    ok('关闭加密：全部解密回明文，不留信封')

    // ---- 3. multi user / RBAC --------------------------------------------
    await store.setRbac({ enabled: true, localRole: 'owner' })
    const reader = await store.manageUsers({ action: 'add', name: '审计员', role: 'reader' })
    const readerId = reader.id ?? reader.user?.id
    assert.ok(readerId, JSON.stringify(reader))
    const writerUser = await store.manageUsers({ action: 'add', name: '编辑者', role: 'editor' })
    const issued = await store.manageUsers({ action: 'token_issue', user: readerId, label: '只读客户端', scopes: ['read'] })
    const token = issued.token ?? issued.secret
    assert.match(String(token), /^kb_[0-9a-f]{40,}$/)
    const readerActor = await store.directory.resolveToken(token)
    assert.equal(readerActor.role, 'reader')
    ok('RBAC 开启：创建用户并签发只读 Token')

    const seen = await store.search({ query: 'AES', actor: readerActor })
    assert.ok(Array.isArray(seen.results))
    await assert.rejects(() => store.add({ text: 'reader 不该写进去的内容 reader note', collection: 'docs', actor: readerActor }), /无权|权限|禁止|forbidden|role/i)
    await assert.rejects(() => store.manageUsers({ action: 'add', name: 'privilege escalator', role: 'admin', actor: readerActor }), /权限|禁止|forbidden|owner/i)
    const ownerWrite = await store.add({ text: 'owner 写入的内容 rbac note', collection: 'docs' })
    assert.ok(ownerWrite.id, '本机 owner 仍然可写')
    ok('reader 可检索、不可写入、不可管理用户；本机 owner 不受影响')

    await store.manageUsers({ action: 'grant', user: writerUser.id ?? writerUser.user?.id, collection: 'bulk', role: 'reader' })
    const writerToken = (await store.manageUsers({ action: 'token_issue', user: writerUser.id ?? writerUser.user?.id, scopes: ['read', 'write'] })).token
    const writerActor = await store.directory.resolveToken(writerToken)
    assert.equal(writerActor.role, 'editor')
    assert.equal(store.directory.roleIn(writerActor, 'bulk'), 'reader', '集合授权只能收紧角色')
    await assert.rejects(() => store.add({ text: 'bulk 里被收紧的写入 bulk note', collection: 'bulk', actor: writerActor }), /权限|禁止|forbidden|role/i)
    const otherWrite = await store.add({ text: 'docs 集合仍可写 docs note', collection: 'docs', actor: writerActor })
    assert.ok(otherWrite.id)
    ok('按集合授权：bulk 收紧为只读，其他集合保持 editor')

    const listedAsReader = await store.list({ actor: readerActor, limit: 50 })
    const ownerList = await store.list({ limit: 50 })
    assert.ok(listedAsReader.docs.length <= ownerList.docs.length)
    ok('列表按身份过滤')

    await store.manageUsers({ action: 'token_revoke', tokenId: issued.record?.id ?? issued.id ?? issued.tokenId })
    assert.equal(await store.directory.resolveToken(token), null, '吊销后 Token 立即失效')
    ok('吊销 Token 后立刻失效')

    // ---- 4. API surface with tokens ---------------------------------------
    const handler = createApiHandler({
      getStore: () => store,
      runtime,
      mcpInfo: () => ({
        enabled: true,
        path: '/kb-mcp',
        stdioConfig: { mcpServers: { 'dsh-knowledge-base': { command: 'node', args: ['/abs/mcp-stdio.mjs'] } } },
      }),
    })
    const server = createServer(handler)
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}/kb-api`
    try {
      const whoami = await (await fetch(`${base}/whoami`)).json()
      assert.equal(whoami.actor.role, 'owner', '同源请求=本机 owner')
      const badToken = await fetch(`${base}/docs`, { headers: { authorization: 'Bearer kb_deadbeefdeadbeefdeadbeef' } })
      assert.equal(badToken.status, 401)
      const crossOrigin = await fetch(`${base}/status`, { headers: { origin: 'http://evil.example' } })
      assert.equal(crossOrigin.status, 403, '跨域无凭据必须拒绝')
      const sec = await (await fetch(`${base}/security`)).json()
      assert.equal(sec.encryption.enabled, false)
      assert.equal(sec.access.enabled, true)
      const users = await (await fetch(`${base}/users`)).json()
      assert.ok(Array.isArray(users.users ?? users.items ?? users.list), JSON.stringify(Object.keys(users)))
      const mcp = await (await fetch(`${base}/mcp`)).json()
      assert.equal(mcp.path, '/kb-mcp')
      assert.ok(String(mcp.stdioConfig.mcpServers['dsh-knowledge-base'].args[0]).endsWith('mcp-stdio.mjs'))
      const readerApiToken = (await store.manageUsers({ action: 'token_issue', user: readerId, scopes: ['read'] })).token
      const badWrite = await fetch(`${base}/add`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${readerApiToken}` },
        body: JSON.stringify({ text: 'api reader write api reader note', collection: 'docs' }),
      })
      assert.equal(badWrite.status, 403, '只读 Token 通过 API 写入应 403')
      const localSearch = await (await fetch(`${base}/search?q=${encodeURIComponent('AES')}`)).json()
      assert.ok(localSearch.results.length > 0)
      ok('API：身份解析、跨域拒绝、Token 权限、安全/用户/MCP 路由')
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }

    // ---- 5. turning everything back off restores plain behaviour ---------
    await store.setRbac({ enabled: false })
    const plain = await store.add({ text: '关闭 RBAC 后的普通写入 plain note', collection: 'docs' })
    assert.ok(plain.id)
    const plainStatus = await store.status()
    assert.equal(plainStatus.security.encryption.enabled, false)
    assert.equal(plainStatus.security.locked, false)
    assert.ok(plainStatus.docs >= 6)
    ok('关闭 RBAC/加密后回到单人明文行为，status 如实报告')

    console.log(`\nintegration: ${passed} passed, 0 failed`)
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack ?? String(error))
    process.exit(1)
  })
}
