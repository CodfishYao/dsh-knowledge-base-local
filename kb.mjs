#!/usr/bin/env node
/**
 * Standalone CLI over the same store. It needs no Harness process, no install
 * step and no dependencies: any model or script that can run `node` can read
 * and write the knowledge base.
 *
 *   node kb.mjs status
 *   node kb.mjs search "混合检索" --limit 5
 *   node kb.mjs read k123 --offset 1 --limit 120
 *   node kb.mjs add --title "标题" --text "正文" --tags a,b
 *   node kb.mjs import D:\Notes --collection notes
 *   node kb.mjs --root D:\KB status
 */
import { readFile } from 'node:fs/promises'
import { KnowledgeStore } from './src/store.js'
import { expandPath, loadSettings, normalizeSettings, saveSettings } from './src/settings.js'
import { humanBytes, truncate } from './src/util.js'

const HELP = `dsh-knowledge-base CLI

用法：node kb.mjs <命令> [参数] [--root <目录>] [--json]

命令：
  status                         显示根目录、文档数、分块数、集合、向量模式
  search <query>                 混合检索（--collection --tags --limit --mode）
  read <id>                      读取文档（--offset --limit --chunk）
  list                           列出文档（--collection --tag --query --limit --sort）
  add                            新增（--title --text --file --stdin --url --collection --tags --mode）
  import <目录|文件>             批量导入（--collection --tags --max-docs）
  reindex                        重建索引（--full --mode）
  scan                           扫描手工写入的 docs/*.md
  delete <id>                    软删除到回收站
  restore <id>                   从回收站恢复
  purge <id>                     彻底删除
  trash                          列出回收站
  bulk-delete --collection X     批量软删（--collection/--tags/--query/--ids），逐项按权限判定
  empty-trash                    清空回收站（editor 只清自己的）
  wipe --confirm WIPE            一键清空整个知识库（不可逆；owner；可加 --remove-folder 连根目录一起删）
  export                         导出（--format md|jsonl）
  collections                    列出集合
  security                       加密与多用户状态（含磁盘密文覆盖情况）
  unlock                         用口令解锁加密的知识库（--passphrase 或 DSH_KB_PASSPHRASE）
  lock                           立即清除内存中的密钥并锁定
  users                          列出用户、集合授权与令牌
  mcp                            显示外部 MCP 客户端的接入方式
  config --root <目录>           写入知识库根目录到 settings.json
  help                           显示本帮助

文档抽取：add --file / import <目录> 支持 .pdf .docx .xlsx .pptx（正文自动抽取入库，原文件留作附件；
旧式 .doc/.xls/.ppt 与扫描件只保留附件并写明原因）。
加密：口令只在解锁时进入内存；丢失口令无法恢复内容（无后门）。
外部客户端：node mcp-stdio.mjs --help（stdio / 独立 HTTP），或在 Harness 内用 POST /kb-mcp。

环境变量：DSH_ROOT、DSH_KB_ROOT 可指定根目录；DSH_HOME 决定 settings.json 位置；
DSH_KB_PASSPHRASE 可在 CLI/MCP 启动时自动解锁；DSH_KB_EMBEDDING_API_KEY 提供 embeddings 密钥。
`

function parseArgs(argv) {
  const flags = {}
  const positional = []
  const BOOLEAN = new Set(['json', 'full', 'help', 'stdin', 'recursive'])
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const key = (eq >= 0 ? arg.slice(2, eq) : arg.slice(2)).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())
      if (eq >= 0) {
        flags[key] = BOOLEAN.has(key) ? arg.slice(eq + 1) === 'true' : arg.slice(eq + 1)
      } else if (BOOLEAN.has(key)) {
        const next = argv[i + 1]
        if (next === 'true' || next === 'false') {
          flags[key] = next === 'true'
          i++
        } else {
          flags[key] = true
        }
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[key] = argv[++i]
      } else {
        flags[key] = true
      }
      continue
    }
    positional.push(arg)
  }
  return { flags, positional }
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function output(flags, value, human) {
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  } else {
    process.stdout.write(`${typeof human === 'function' ? human(value) : human ?? JSON.stringify(value, null, 2)}\n`)
  }
}

function printSearch(value) {
  const lines = [`查询：${value.query} · ${value.mode} · 命中 ${value.total}`]
  if (value.warning) lines.push(`注意：${value.warning}`)
  value.results.forEach((hit, i) => {
    lines.push('', `${i + 1}. ${hit.title} [${hit.score}]  ${hit.path}:${hit.lineStart}`)
    lines.push(`   ${hit.snippet.replace(/\n/g, ' ')}`)
  })
  if (value.total === 0) lines.push('', '没有命中。')
  return lines.join('\n')
}

function printList(value) {
  const lines = [`共 ${value.total} 篇文档`]
  for (const doc of value.docs) {
    lines.push(`- ${doc.title}  [${doc.id}]  ${doc.collection} · ${doc.chunkCount} 块 · ${doc.path}`)
  }
  return lines.join('\n')
}

async function main() {
  const argv = process.argv.slice(2)
  const { flags, positional } = parseArgs(argv)
  const command = positional.shift() ?? 'help'
  if (command === 'help' || flags.help) {
    process.stdout.write(HELP)
    return
  }

  let settings = await loadSettings({})
  const override = flags.root || process.env.DSH_KB_ROOT || process.env.DSH_ROOT
  if (override) {
    settings = normalizeSettings({ ...settings, rootDir: expandPath(String(override)) })
  }
  const store = new KnowledgeStore(settings, null)
  await store.loadSecurity()

  switch (command) {
    case 'status': {
      const value = store.configured ? await store.status() : { configured: false, settingsPath: store.settingsPath, root: '', message: '未配置根目录' }
      output(flags, value, (v) =>
        v.configured
          ? [
              `根目录：${v.root}`,
              `规模：${v.docs} 篇 / ${v.chunks} 块`,
              `集合：${(v.collections ?? []).map((c) => `${c.name}(${c.docs})`).join(', ') || '（空）'}`,
              `向量：${v.vectorMode}${v.embedding?.configured ? ' · embeddings 已配置' : ''}`,
            ].join('\n')
          : `未配置根目录。运行：node kb.mjs config --root /path/to/knowledge\nsettings: ${v.settingsPath}`,
      )
      return
    }
    case 'search': {
      const query = positional.join(' ').trim()
      if (!query) throw new Error('search 需要一个查询词')
      const value = await store.search({
        query,
        collection: flags.collection,
        tags: flags.tags,
        limit: Number(flags.limit) || 8,
        mode: flags.mode,
      })
      output(flags, value, printSearch)
      return
    }
    case 'read': {
      const id = positional[0]
      if (!id) throw new Error('read 需要文档 id')
      const value = await store.read({ id, offset: Number(flags.offset) || 1, limit: Number(flags.limit) || 400, chunk: flags.chunk })
      output(flags, value, (v) => `# ${v.title}\nid: ${v.id} · ${v.path} · 行 ${v.offset}/${v.totalLines}\n\n${v.content}`)
      return
    }
    case 'list': {
      const value = await store.list({
        collection: flags.collection,
        tag: flags.tag,
        query: flags.query,
        limit: Number(flags.limit) || 50,
        offset: Number(flags.offset) || 0,
        sort: flags.sort,
      })
      output(flags, value, printList)
      return
    }
    case 'add': {
      let text = flags.text
      if (flags.stdin) text = await readStdin()
      if (!text && flags.file) text = await readFile(String(flags.file), 'utf8')
      const value = await store.add({
        title: flags.title,
        text,
        filePath: flags.file,
        url: flags.url,
        collection: flags.collection,
        tags: flags.tags,
        mode: flags.mode,
      })
      output(flags, value, (v) => `已保存 ${v.id}（${v.chunkCount} 块，${v.vectorMode}/${v.vectorStatus}）\n${v.path}`)
      return
    }
    case 'import': {
      const target = positional[0]
      if (!target) throw new Error('import 需要一个目录或文件路径')
      const value = await store.importDirectory({
        path: target,
        collection: flags.collection,
        tags: flags.tags,
        recursive: flags.recursive !== 'false',
        maxDocs: Number(flags.maxDocs) || undefined,
      })
      output(flags, value, (v) => `导入完成：新增 ${v.imported}，去重 ${v.deduped}，失败 ${v.failed}，共扫描 ${v.total}`)
      return
    }
    case 'reindex': {
      const value = await store.reindex({ full: Boolean(flags.full), mode: flags.mode })
      output(flags, value, (v) => `已重建 ${v.reindexed} 篇文档的索引（模式 ${v.mode}）`)
      return
    }
    case 'scan': {
      const value = await store.scanDocuments()
      output(flags, value, (v) => `扫描完成：新增 ${v.added}，更新 ${v.updated}，移除 ${v.removed}，共 ${v.total}`)
      return
    }
    case 'delete': {
      const value = await store.remove(positional[0])
      output(flags, value, (v) => `已移入回收站：${v.title} (${v.id})`)
      return
    }
    case 'restore': {
      const value = await store.restore(positional[0])
      output(flags, value, (v) => `已恢复：${v.title} (${v.id})`)
      return
    }
    case 'purge': {
      const value = await store.purge(positional[0])
      output(flags, value, (v) => `已彻底删除：${v.id}`)
      return
    }
    case 'trash': {
      const value = await store.listTrash()
      output(flags, { items: value }, (items) =>
        items.length === 0 ? '回收站为空。' : items.map((i) => `- ${i.title} [${i.id}] · ${i.trashedAt}`).join('\n'),
      )
      return
    }
    case 'empty-trash': {
      const value = await store.emptyTrash({})
      output(flags, value, (v) => `已彻底删除 ${v.removed} 条${v.skipped?.length ? `，跳过 ${v.skipped.length} 条` : ''}。`)
      return
    }
    case 'bulk-delete': {
      const filter = { collection: flags.collection, tag: flags.tags, query: flags.query, ids: flags.ids ? String(flags.ids).split(',').map((s) => s.trim()) : undefined }
      if (!filter.collection && !filter.tag && !filter.query && !filter.ids?.length) throw new Error('bulk-delete 需要 --collection/--tags/--query/--ids 至少一个')
      const value = await store.bulkRemove(filter)
      output(flags, value, (v) => `已移入回收站 ${v.trashed} 篇（匹配 ${v.matched}）${v.skipped?.length ? `，跳过 ${v.skipped.length}` : ''}`)
      return
    }
    case 'wipe': {
      if (String(flags.confirm ?? '').trim().toUpperCase() !== 'WIPE') {
        throw new Error('一键清空整个知识库是不可逆操作。确认请加 --confirm WIPE（会删除全部文档、回收站、索引、版本、附件与导出）。')
      }
      const value = await store.wipe({ confirm: flags.confirm, removeFolder: Boolean(flags['remove-folder']) })
      output(flags, value, (v) => `已清空 ${v.clearedDocs} 篇文档并重建为空白库${v.removeFolder ? '，并已删除根目录、清除配置的根路径' : ''}。`)
      return
    }
    case 'export': {
      const value = await store.exportAll({ format: flags.format })
      output(flags, value, (v) => `已导出 ${v.docs} 篇到 ${v.path}（${humanBytes(v.bytes)}）`)
      return
    }
    case 'collections': {
      const value = await store.collections()
      output(flags, { collections: value }, (items) => items.map((c) => `- ${c.name}: ${c.docs} 篇 ${c.description ? `· ${c.description}` : ''}`).join('\n'))
      return
    }
    case 'security': {
      const value = await store.securityStatus()
      output(flags, value, (v) => {
        const cov = v.coverage ?? {}
        const total = (cov.docs?.encrypted ?? 0) + (cov.docs?.plain ?? 0)
        return [
          `加密：${v.encryption.enabled ? `已开启（${v.encryption.algorithm} · ${v.encryption.kdf}）` : '未开启'}`,
          v.encryption.enabled ? `元数据：${v.encryption.metadata === 'encrypted' ? '已加密（标题/标签/摘要）' : '明文'}` : '',
          `状态：${v.locked ? '锁定（读取需要口令）' : v.encryption.unlocked ? '已解锁' : '正常'}`,
          v.encryption.enabled ? `密钥：secure/key.json · 指纹 ${String(v.encryption.fingerprint).slice(0, 12)}` : '',
          cov.docs ? `磁盘：正文 ${cov.docs.encrypted}/${total} 密文 · 索引 ${cov.indexes?.encrypted ?? 0} 信封 · 清单 ${cov.manifest}` : '',
          `多用户：${v.access?.rbacEnabled ? `已开启（用户 ${v.access.users?.length ?? 0}）` : '未开启（单人使用）'}`,
          `当前身份：${v.whoami?.name ?? ''}（${v.whoami?.role ?? ''}${v.whoami?.via ? ` · ${v.whoami.via}` : ''}）`,
        ]
          .filter(Boolean)
          .join('\n')
      })
      return
    }
    case 'unlock': {
      const passphrase = flags.passphrase ?? process.env.DSH_KB_PASSPHRASE ?? ''
      if (!passphrase) throw new Error('unlock 需要 --passphrase 或环境变量 DSH_KB_PASSPHRASE')
      const value = await store.unlockKnowledgeBase({ passphrase })
      output(flags, value, (v) => `已解锁：算法 ${v.algorithm ?? ''} · 元数据 ${v.metadata ?? 'plain'}${v.locked ? '（仍处于锁定？）' : ''}`)
      return
    }
    case 'lock': {
      const value = await store.lockKnowledgeBase()
      output(flags, value, () => `已锁定${value?.relocked ? '（密钥已从内存清除）' : ''}：再次读取需要口令。`)
      return
    }
    case 'users': {
      const value = await store.usersStatus()
      output(flags, value, (v) =>
        [
          `多用户：${v.enabled ? '已开启' : '未开启（在面板 安全 分区或 kb_manage rbac_enable 开启）'}`,
          `本机角色：${v.localRole ?? 'owner'}${v.file ? ` · 数据：${v.file}` : ''}`,
          ...(v.users ?? []).map((u) => `- ${u.name} [${u.id}] ${u.role}${u.disabled ? '（已停用）' : ''} · 令牌 ${(u.tokens ?? []).length}`),
          ...(v.grants ?? []).map((g) => `- 集合授权：${g.userName ?? g.userId} @ ${g.collection} → ${g.role}`),
        ]
          .filter(Boolean)
          .join('\n'),
      )
      return
    }
    case 'mcp': {
      output(
        flags,
        { stdio: 'node mcp-stdio.mjs', http: 'node mcp-stdio.mjs --http 8765 --token <token>', help: 'node mcp-stdio.mjs --help' },
        (v) =>
          [
            '外部 MCP 客户端：',
            `  stdio（Claude Desktop / Cursor 等，无需 Harness 在跑）：${v.stdio}`,
            `  独立 HTTP：${v.http}`,
            `  Harness 进程内的端点：POST /kb-mcp（与 Web GUI 同源，Token 走 Authorization: Bearer）`,
            '  参数与鉴权细节：node mcp-stdio.mjs --help',
          ].join('\n'),
      )
      return
    }
    case 'config': {
      if (!flags.root) throw new Error('config 需要 --root <目录>')
      const next = await saveSettings({ rootDir: expandPath(String(flags.root)) }, {})
      output(flags, next, (v) => `已设置根目录：${v.rootDir}`)
      return
    }
    default:
      throw new Error(`未知命令：${command}（运行 node kb.mjs help）`)
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})

void truncate
