/** One-off repair: re-import the 10 placeholder docs from their attachments. */
import { KnowledgeStore } from '../src/store.js'
import { loadSettings } from '../src/settings.js'

const settings = await loadSettings({})
const store = new KnowledgeStore(settings, null)
await store.loadSecurity()
await store.init()

const manifest = await store.loadManifest()
const failed = manifest.docs.filter((d) => d.extract?.failed)
console.log('待修复:', failed.length)

for (const old of failed) {
  const attDir = store.p('files', old.id)
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(attDir).catch(() => [])
  if (entries.length === 0) {
    console.log('✗', old.title, '附件缺失，跳过')
    continue
  }
  const filePath = attDir + '/' + entries[0]
  const added = await store.add({ filePath, collection: old.collection, tags: old.tags, title: old.title })
  const fresh = await store.get(added.id)
  const okExtract = fresh?.meta?.extract && !fresh.meta.extract.failed
  console.log(okExtract ? '✓' : '✗', old.title.slice(0, 44), '->', added.id, '| vectorStatus:', fresh?.meta?.vectorStatus, '| extract:', JSON.stringify(fresh?.meta?.extract ?? null))
  if (okExtract) {
    await store.remove(old.id, {})
    await store.purge(old.id, {})
  } else {
    // keep the placeholder for comparison; remove the new one
    await store.remove(added.id, {})
    await store.purge(added.id, {})
    console.log('  (新导入也失败，保留原占位文档)')
  }
}
const after = await store.list({ limit: 1 })
console.log('完成。当前文档总数:', after.total)
