/**
 * Danger-operations self-check: bulk delete, empty trash and full wipe, and the
 * permission boundaries around them. Drives the store with real actors (tokens
 * resolve to owners/roles) so ownership rules are exercised, not assumed.
 *
 * Temp knowledge base only; never touches any user's real knowledge base.
 *   node test/danger_ops.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { KnowledgeStore } from '../src/store.js'
import { normalizeSettings } from '../src/settings.js'

async function main() {
  const home = await mkdtemp(join(tmpdir(), 'kb-danger-'))
  process.env.DSH_HOME = home
  const root = join(home, 'kb')
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

    // ---- 1. single-user (RBAC off): local owner can bulk + wipe ----------
    await store.add({ title: 'A1', text: 'a one body', collection: 'a' })
    await store.add({ title: 'A2', text: 'a two body', collection: 'a' })
    await store.add({ title: 'B1', text: 'b one body', collection: 'b' })

    await assert.rejects(() => store.bulkRemove({}), /筛选条件/, '无筛选条件的批量删除必须被拒')

    const bulk = await store.bulkRemove({ collection: 'a' })
    assert.equal(bulk.trashed, 2, JSON.stringify(bulk))
    assert.equal(bulk.matched, 2)
    const afterBulk = await store.list({ limit: 50 })
    assert.equal(afterBulk.total, 1, '只剩 b 集合的一篇')
    ok('按集合批量软删：2 篇进回收站，库中剩 1 篇')

    const trashList = await store.listTrash()
    assert.equal(trashList.length, 2)
    const emptied = await store.emptyTrash({})
    assert.equal(emptied.removed, 2)
    assert.equal((await store.listTrash()).length, 0)
    ok('清空回收站：2 条彻底删除')

    await assert.rejects(() => store.wipe({ confirm: 'nope' }), /WIPE/, '确认词不对必须拒绝')
    const wiped = await store.wipe({ confirm: 'WIPE' })
    assert.equal(wiped.wiped, true)
    assert.equal(wiped.clearedDocs, 1)
    assert.equal((await store.list({ limit: 50 })).total, 0)
    assert.ok((await stat(join(root, 'docs')).catch(() => null))?.isDirectory(), 'docs 目录重建')
    ok('一键清空：需 WIPE，清空全部并重建空白库（根目录/设置保留）')

    // ---- 2. RBAC on: ownership and role floors ----------------------------
    await store.setRbac({ enabled: true, localRole: 'owner' })
    const e1 = await store.manageUsers({ action: 'add', name: 'e1', role: 'editor' })
    const e2 = await store.manageUsers({ action: 'add', name: 'e2', role: 'editor' })
    const t1 = (await store.manageUsers({ action: 'token_issue', user: e1.id, scopes: ['read', 'write'] })).token
    const t2 = (await store.manageUsers({ action: 'token_issue', user: e2.id, scopes: ['read', 'write'] })).token
    const a1 = await store.directory.resolveToken(t1)
    const a2 = await store.directory.resolveToken(t2)
    assert.equal(a1.role, 'editor')

    const d1 = await store.add({ title: 'owned by e1', text: 'e1 content here', collection: 'shared', actor: a1 })
    const d2 = await store.add({ title: 'owned by e2', text: 'e2 content here', collection: 'shared', actor: a2 })
    assert.equal(d1.owner, a1.id)
    assert.equal(d2.owner, a2.id)

    const e1bulk = await store.bulkRemove({ collection: 'shared', actor: a1 })
    assert.equal(e1bulk.trashed, 1, JSON.stringify(e1bulk))
    assert.equal(e1bulk.matched, 2)
    assert.equal(e1bulk.skipped.length, 1)
    assert.match(e1bulk.skipped[0].reason, /只能删除自己创建/)
    ok('editor 批量删除只删自己的文档，他人的作为 skipped 返回')

    const e1trash0 = await store.bulkRemove({ ids: [d2.id], actor: a2 })
    assert.equal(e1trash0.trashed, 1, 'e2 删掉自己的文档进回收站')
    const e1trash = await store.emptyTrash({ actor: a1 })
    assert.equal(e1trash.removed, 1, JSON.stringify(e1trash))
    assert.equal(e1trash.skipped.length, 1, 'e2 的回收站条目不被 e1 清空')
    ok('editor 清空回收站只清自己的条目')

    await assert.rejects(() => store.wipe({ confirm: 'WIPE', actor: a1 }), /owner|禁止|无权|security/i, 'editor 无 owner，不能一键清空')
    ok('非 owner 的一键清空被 security 权限拒绝')

    const adminWipe = await store.wipe({ confirm: 'WIPE' })
    assert.equal(adminWipe.wiped, true)
    assert.equal((await store.list({ limit: 50 })).total, 0)
    ok('本机 owner 一键清空成功，库归零')

    console.log(`\ndanger-ops: ${passed} passed, 0 failed`)
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
