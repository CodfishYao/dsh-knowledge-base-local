import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { KnowledgeStore } from '../src/store.js'
import { createApiHandler } from '../src/api.js'
import { embedWithApi } from '../src/embedding.js'
import { normalizeSettings, saveSettings } from '../src/settings.js'
import { splitChunks } from '../src/chunk.js'
import { terms } from '../src/tokenize.js'

const execFileAsync = promisify(execFile)

function tempHome() {
  return mkdtemp(join(tmpdir(), 'kb-home-'))
}

async function main() {
  const home = await tempHome()
  process.env.DSH_HOME = home
  const root = join(home, 'kb')
  const settings = normalizeSettings({ rootDir: root, chunkSize: 380, chunkOverlap: 80, vectorDim: 512 })
  const store = new KnowledgeStore(settings, null)
  await store.init()

  // chunking keeps line numbers and headings
  const sample = ['# 安装指南', '', '先安装 Node.js 24。', '', '## 配置', '', '编辑 settings.json，把 rootDir 指向你的目录。', '', '## 检索', '', '使用 BM25 与向量混合检索。'].join('\n')
  const longText = Array.from({ length: 12 }, (_, i) => `## 小节 ${i}\n\n这是第 ${i} 段内容，用于验证切块、重叠与行号是否正确。`).join('\n\n')
  const chunks = splitChunks(longText, { chunkSize: 240, chunkOverlap: 40 })
  assert.ok(chunks.length >= 3, `expected several chunks, got ${chunks.length}`)
  assert.ok(chunks.every((c) => c.lineStart >= 1 && c.lineEnd >= c.lineStart))
  assert.ok(terms('知识库检索 Knowledge Base').includes('知识'))

  // add + read
  const added = await store.add({
    title: 'Harness 知识库设计',
    text: sample,
    collection: 'design',
    tags: 'harness, 知识库',
  })
  assert.equal(added.collection, 'design')
  assert.equal(added.vectorStatus, 'ok')
  assert.ok(added.chunkCount >= 1)
  const read = await store.read({ id: added.id })
  assert.ok(read.content.includes('BM25'))
  assert.equal(read.totalLines, sample.split('\n').length)

  // Chinese + English search
  const zh = await store.search({ query: '混合检索', limit: 5 })
  assert.ok(zh.results.length > 0, 'Chinese query should hit')
  assert.equal(zh.results[0].docId, added.id)
  const en = await store.search({ query: 'knowledge base settings', limit: 5 })
  assert.ok(Array.isArray(en.results))

  // dedupe
  const duplicate = await store.add({ title: 'dup', text: sample, collection: 'design' })
  assert.equal(duplicate.deduped, true)
  assert.equal(duplicate.id, added.id)

  // file attachment (text)
  const sourceFile = join(home, 'notes.md')
  await writeFile(sourceFile, '# 附件笔记\n\n这是从文件导入的正文。\n', 'utf8')
  const fileDoc = await store.add({ filePath: sourceFile, collection: 'files' })
  assert.ok(fileDoc.file, 'attachment should be stored')
  assert.ok(fileDoc.title.includes('notes'))
  const attachment = await readFile(join(root, fileDoc.file.path), 'utf8')
  assert.ok(attachment.includes('附件笔记'))

  // update keeps a version and reindexes
  const updated = await store.update({ id: added.id, text: `${sample}\n\n新增一段：向量模式可以切换。` })
  assert.equal(updated.chunkCount >= added.chunkCount, true)
  const versionFiles = await (await import('node:fs/promises')).readdir(join(root, 'versions', added.id))
  const versionText = await readFile(join(root, 'versions', added.id, versionFiles.sort()[0]), 'utf8')
  assert.ok(versionText.includes('安装指南'), 'old body should be versioned')

  // soft delete + restore
  await store.remove(added.id)
  const trash = await store.listTrash()
  assert.equal(trash.length, 1)
  const restored = await store.restore(added.id)
  assert.equal(restored.id, added.id)

  // reindex and scan
  const reindexed = await store.reindex({ full: true })
  assert.equal(reindexed.reindexed, 2)

  const external = join(root, 'docs', 'kexternal.md')
  await writeFile(external, '---\ntitle: "手工写入"\ncollection: "design"\ntags: ["external"]\n---\n\n这是模型直接写进 docs 的内容。\n', 'utf8')
  const scanned = await store.scanDocuments()
  assert.equal(scanned.added, 1)
  const found = await store.search({ query: '手工写入', limit: 3 })
  assert.ok(found.results.some((r) => r.docId === 'kexternal'))

  // import directory
  const importDir = join(home, 'inbox-src')
  await mkdir(importDir, { recursive: true })
  await writeFile(join(importDir, 'a.md'), '# A\n\nalpha content\n', 'utf8')
  await writeFile(join(importDir, 'b.md'), '# B\n\nbeta content\n', 'utf8')
  const imported = await store.importDirectory({ path: importDir, collection: 'imported' })
  assert.equal(imported.imported, 2)

  // export
  const exported = await store.exportAll({ format: 'jsonl' })
  assert.ok(exported.docs >= 4)
  assert.ok((await readFile(join(root, exported.path), 'utf8')).includes('"meta"'))

  // status
  const status = await store.status()
  assert.equal(status.docs, 5)
  assert.ok(status.collections.some((c) => c.name === 'design' && c.docs >= 2))

  // CLI against the same root via settings.json
  await saveSettings({ rootDir: root }, {})
  const cli = join(process.cwd(), 'kb.mjs')
  const { stdout } = await execFileAsync(process.execPath, [cli, '--json', 'search', 'vector', '--limit', '3'], {
    env: { ...process.env, DSH_HOME: home },
    cwd: process.cwd(),
  })
  const cliResult = JSON.parse(stdout)
  assert.ok(Array.isArray(cliResult.results))

  const { stdout: statusOut } = await execFileAsync(process.execPath, [cli, '--json', 'status'], {
    env: { ...process.env, DSH_HOME: home },
    cwd: process.cwd(),
  })
  assert.equal(JSON.parse(statusOut).configured, true)

  // same-origin JSON API used by the Web panel
  const handler = createApiHandler({
    getStore: () => store,
    runtime: {
      settings,
      status: async () => store.status(),
      configure: async () => ({ configured: true }),
    },
  })
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/kb-api`
  try {
    const statusResponse = await (await fetch(`${base}/status`)).json()
    assert.equal(statusResponse.configured, true)
    const searchResponse = await (await fetch(`${base}/search?q=${encodeURIComponent('混合检索')}`)).json()
    assert.ok(searchResponse.results.length > 0)
    const addResponse = await (
      await fetch(`${base}/add`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'API 文档', text: '通过 HTTP 添加的文档，验证面板接线。' }),
      })
    ).json()
    assert.ok(addResponse.id)
    const docResponse = await (await fetch(`${base}/doc?id=${addResponse.id}`)).json()
    assert.ok(docResponse.content.includes('HTTP'))
    const crossOrigin = await fetch(`${base}/status`, { headers: { origin: 'http://evil.example' } })
    assert.equal(crossOrigin.status, 403)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }

  // OpenAI-compatible embeddings adapter, against a deterministic mock
  const mockServer = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const data = payload.input.map((text, index) => ({
        index,
        embedding: Array.from({ length: 8 }, (_, k) => (text.charCodeAt(k % text.length) || 1) / 255),
      }))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data }))
    })
  })
  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve))
  try {
    const endpoint = `http://127.0.0.1:${mockServer.address().port}/v1`
    const apiSettings = normalizeSettings({ ...settings, embedding: { endpoint, model: 'mock-8', apiKey: '' } })
    const embedded = await embedWithApi(['你好世界', 'hello world'], apiSettings)
    assert.equal(embedded.dim, 8)
    assert.equal(embedded.vectors.length, 2)
    const norm = Math.sqrt([...embedded.vectors[0]].reduce((sum, value) => sum + value * value, 0))
    assert.ok(Math.abs(norm - 1) < 1e-5)
  } finally {
    await new Promise((resolve) => mockServer.close(resolve))
  }

  // ---- DashScope native format (explicit, since a local mock has no dashscope host) ----
  const dashScopeServer = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const json = JSON.parse(body)
      assert.ok(json.input?.texts, 'DashScope format should have input.texts')
      assert.ok(Array.isArray(json.input.texts), 'input.texts should be array')
      assert.equal(json.parameters?.text_type, 'document', 'should have text_type parameter')
      assert.ok(req.url.includes('/services/embeddings/text-embedding/text-embedding'), 'should use DashScope native path')

      const data = json.input.texts.map((text, index) => ({
        embedding: Array(8).fill(0).map(() => Math.random()),
        text_index: index,
      }))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ output: { embeddings: data }, usage: { total_tokens: 10 } }))
    })
  })
  await new Promise((resolve) => dashScopeServer.listen(0, '127.0.0.1', resolve))
  try {
    const endpoint = `http://127.0.0.1:${dashScopeServer.address().port}/api/v1`
    const apiSettings = normalizeSettings({
      ...settings,
      embedding: { endpoint, model: 'text-embedding-v3', apiKey: '', format: 'dashscope' },
    })
    assert.equal(apiSettings.embedding.format, 'dashscope', 'format 应被规范化保留')
    const embedded = await embedWithApi(['测试文本', 'another text'], apiSettings)
    assert.equal(embedded.dim, 8)
    assert.equal(embedded.vectors.length, 2)
    const norm = Math.sqrt([...embedded.vectors[0]].reduce((sum, value) => sum + value * value, 0))
    assert.ok(Math.abs(norm - 1) < 1e-5)
  } finally {
    await new Promise((resolve) => dashScopeServer.close(resolve))
  }

  // ---- compatible-mode gateway must keep the OpenAI shape ----
  // Regression: a Qwen embedding model behind a `/compatible-mode/v1` gateway is
  // NOT the native DashScope route; forcing the native shape there yields 404.
  const compatServer = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const json = JSON.parse(body)
      assert.equal(req.url, '/compatible-mode/v1/embeddings', 'compatible-mode 应走 /embeddings')
      assert.ok(Array.isArray(json.input), 'compatible-mode 应发送 OpenAI 的 input 数组')
      assert.equal(json.input?.texts, undefined, '不应发送 DashScope 的 input.texts')
      const data = json.input.map((text, index) => ({ embedding: Array(8).fill(0).map(() => Math.random()), index }))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data, model: json.model, usage: { total_tokens: 10 } }))
    })
  })
  await new Promise((resolve) => compatServer.listen(0, '127.0.0.1', resolve))
  try {
    const endpoint = `http://127.0.0.1:${compatServer.address().port}/compatible-mode/v1`
    const apiSettings = normalizeSettings({
      ...settings,
      embedding: { endpoint, model: 'qwen3.7-text-embedding-flash', apiKey: '' },
    })
    const embedded = await embedWithApi(['中文文本', 'english text'], apiSettings)
    assert.equal(embedded.dim, 8)
    assert.equal(embedded.vectors.length, 2)
  } finally {
    await new Promise((resolve) => compatServer.close(resolve))
  }

  await rm(home, { recursive: true, force: true })
  console.log('smoke: ok')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
