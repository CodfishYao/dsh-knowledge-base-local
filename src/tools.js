/** Agent-facing tools. Every tool delegates to KnowledgeStore; no duplicated logic. */
import { clampInt, humanBytes, truncate } from './util.js'

const TEXT = (text) => [{ type: 'text', text }]

function jsonText(value) {
  return JSON.stringify(value, null, 2)
}

function formatSearch(value) {
  const lines = [`查询：${value.query} · 模式：${value.mode} · 命中 ${value.total}（候选 ${value.candidates}）`]
  if (value.warning) lines.push(`注意：${value.warning}`)
  value.results.forEach((hit, index) => {
    lines.push(
      '',
      `${index + 1}. ${hit.title}  [score ${hit.score}]`,
      `   id: ${hit.docId} · 集合: ${hit.collection} · 位置: ${hit.path}:${hit.lineStart}-${hit.lineEnd}`,
      hit.heading ? `   小节: ${hit.heading}` : '',
      `   ${hit.snippet.replace(/\n/g, ' ')}`,
    )
  })
  if (value.total === 0) lines.push('', '没有命中。可尝试更短的关键词，或先用 kb_list 浏览文档。')
  return lines.filter(Boolean).join('\n')
}

function formatRead(value) {
  const total = value.totalLines ?? 0
  const range = value.limit
    ? `行 ${value.offset}-${Math.min(value.offset + value.limit - 1, total)} / 共 ${total} 行`
    : `行 ${value.offset} / 共 ${total} 行`
  const header = [
    `# ${value.title}`,
    `id: ${value.id} · 集合: ${value.collection} · 路径: ${value.path}`,
    range,
    value.file ? `附件: ${value.file.path}（${humanBytes(value.file.bytes)}）` : '',
  ].filter(Boolean)
  return `${header.join('\n')}\n\n${value.content}`
}

function formatList(value) {
  const lines = [`共 ${value.total} 篇文档（显示 ${value.docs.length}）`]
  if (value.collections?.length) {
    lines.push(`集合：${value.collections.map((c) => `${c.name}(${c.docs})`).join(' / ')}`)
  }
  value.docs.forEach((doc) => {
    lines.push(
      `- ${doc.title}  [${doc.id}]  ${doc.collection} · ${doc.chunkCount} 块 · ${String(doc.updatedAt).slice(0, 10)}${doc.tags.length ? ` · #${doc.tags.join(' #')}` : ''}`,
    )
    if (doc.summary) lines.push(`  ${truncate(doc.summary, 120)}`)
  })
  return lines.join('\n')
}

function formatImport(value) {
  const lines = [
    `导入完成：新增 ${value.imported}，去重 ${value.deduped}，失败 ${value.failed}，扫描 ${value.total}`,
  ]
  for (const row of value.results.slice(0, 40)) {
    if (row.error) lines.push(`- 失败 ${row.path}: ${row.error}`)
    else if (row.skipped) lines.push(`- 跳过 ${row.path}: ${row.skipped}`)
    else lines.push(`- ${row.deduped ? '已存在' : '新增'} ${row.path} → ${row.id}`)
  }
  if (value.results.length > 40) lines.push(`… 其余 ${value.results.length - 40} 条省略`)
  return lines.join('\n')
}

export function createToolDefinitions(store, runtime) {
  const ready = () => {
    if (!store.configured) store.requireRoot()
  }

  const writeGuard = () => {
    if (!runtime.settings.tools.allowWrite) {
      throw new Error('知识库写入已被配置禁用（tools.allowWrite=false）。请在 设置 → 知识库 中开启。')
    }
  }

  const search = {
    name: 'kb_search',
    description:
      '搜索本地知识库（混合 BM25 + 向量）。当用户提到“之前记过/知识库/我的笔记”，或你需要项目约定、历史决策、专有名词时，先调用它再回答；不要凭空猜测。返回带文档 id、行号与片段的结果，可用 kb_read 展开。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词或自然语言问题。中文、英文均可。' },
        collection: { type: 'string', description: '可选：只检索某个集合。' },
        tags: { type: 'string', description: '可选：逗号分隔的标签，需全部匹配。' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '返回条数，默认 8。' },
        mode: { type: 'string', enum: ['hybrid', 'lexical', 'vector'], description: '检索模式，默认 hybrid。' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          mode: { type: 'string' },
          total: { type: 'integer' },
          candidates: { type: 'integer' },
          scannedDocs: { type: 'integer' },
          warning: { type: 'string' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                docId: { type: 'string' },
                title: { type: 'string' },
                collection: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
                chunk: { type: 'integer' },
                heading: { type: 'string' },
                snippet: { type: 'string' },
                score: { type: 'number' },
                semantic: { type: 'number' },
                lexical: { type: 'number' },
                path: { type: 'string' },
                lineStart: { type: 'integer' },
                lineEnd: { type: 'integer' },
                summary: { type: 'string' },
              },
              required: ['docId', 'title', 'snippet', 'path'],
            },
          },
        },
        required: ['query', 'results'],
      },
      render: (_args, value) => TEXT(formatSearch(value)),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      ready()
      return store.search({
        query: args.query,
        collection: args.collection,
        tags: args.tags,
        limit: args.limit,
        mode: args.mode,
        signal: exec.signal,
        actor: args.actor,
      })
    },
  }

  const read = {
    name: 'kb_read',
    description:
      '读取知识库中的一篇文档（可指定行范围或分块）。先用 kb_search/kb_list 拿到 id；path 可直接用 docs/<id>.md。返回正文与元数据，行号可用于引用。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '文档 id（允许唯一前缀）或 docs/<id>.md。' },
        path: { type: 'string', description: '文档相对路径，例如 docs/k123.md。' },
        chunk: { type: 'integer', minimum: 0, description: '可选：只读某个分块。' },
        offset: { type: 'integer', minimum: 1, description: '起始行，默认 1。' },
        limit: { type: 'integer', minimum: 1, maximum: 4000, description: '最多行数，默认 400。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          collection: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          path: { type: 'string' },
          content: { type: 'string' },
          offset: { type: 'integer' },
          limit: { type: 'integer' },
          totalLines: { type: 'integer' },
          heading: { type: 'string' },
          lineStart: { type: 'integer' },
          lineEnd: { type: 'integer' },
          summary: { type: 'string' },
        },
        required: ['id', 'title', 'content'],
      },
      render: (_args, value) => TEXT(formatRead(value)),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      ready()
      return store.read(args)
    },
  }

  const list = {
    name: 'kb_list',
    description: '列出知识库文档（可按集合、标签、标题关键词过滤），用于浏览或找 id。只读，不消耗向量。',
    parameters: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: '可选：集合名。' },
        tag: { type: 'string', description: '可选：单个标签。' },
        query: { type: 'string', description: '可选：标题/摘要/标签关键词。' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: '默认 50。' },
        offset: { type: 'integer', minimum: 0, description: '分页偏移。' },
        sort: { type: 'string', enum: ['updated', 'created', 'title', 'chunks'], description: '排序，默认 updated。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          total: { type: 'integer' },
          docs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                collection: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
                chunkCount: { type: 'integer' },
                summary: { type: 'string' },
                path: { type: 'string' },
                updatedAt: { type: 'string' },
              },
              required: ['id', 'title'],
            },
          },
          collections: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                docs: { type: 'integer' },
                description: { type: 'string' },
              },
              required: ['name'],
            },
          },
        },
        required: ['total', 'docs'],
      },
      render: (_args, value) => TEXT(formatList(value)),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      ready()
      return store.list(args)
    },
  }

  const add = {
    name: 'kb_add',
    description:
      '把一段文本、一个本地文件或一个网页存入知识库（自动切块、生成向量、写目录）。当用户说“记住/存到知识库/以后要用”时使用。重复内容会自动去重并返回已有 id。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '标题；缺省时取正文首行或文件名。' },
        text: { type: 'string', description: '要保存的正文（Markdown 或纯文本）。' },
        filePath: { type: 'string', description: '要入库的本地文件绝对路径（可同时给 text 作为正文）。' },
        url: { type: 'string', description: '要抓取并入库的 http(s) 网页。' },
        collection: { type: 'string', description: '集合名，缺省为 default。' },
        tags: { type: 'string', description: '逗号分隔标签，例如 "rust,并发"。' },
        mode: { type: 'string', enum: ['local', 'llm', 'api', 'none'], description: '本次向量模式；none 表示暂不建索引。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          collection: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          chunkCount: { type: 'integer' },
          vectorMode: { type: 'string' },
          vectorStatus: { type: 'string' },
          vectorError: { type: 'string' },
          path: { type: 'string' },
          deduped: { type: 'boolean' },
          summary: { type: 'string' },
          file: { oneOf: [{ type: 'object' }, { type: 'null' }] },
        },
        required: ['id', 'title'],
      },
      render: (_args, value) =>
        TEXT(
          [
            value.deduped ? `内容已存在，返回已有文档。` : `已存入知识库。`,
            `id: ${value.id}`,
            `标题: ${value.title}`,
            `集合: ${value.collection}${value.tags?.length ? ` · 标签: ${value.tags.join(', ')}` : ''}`,
            `分块: ${value.chunkCount} · 向量: ${value.vectorMode} (${value.vectorStatus})`,
            value.vectorError ? `向量回退原因: ${value.vectorError}` : '',
            `文件: ${value.path}`,
            value.summary ? `摘要: ${truncate(value.summary, 200)}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        ),
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      ready()
      writeGuard()
      if (args.url) return store.addUrl({ ...args, signal: exec.signal })
      return store.add({ ...args, signal: exec.signal })
    },
  }

  const importTool = {
    name: 'kb_import',
    description:
      '批量导入一个目录（递归）或单个文件/网页到知识库。自动跳过二进制与超大文件、按内容去重，并保留原文件为附件。适合把笔记库、代码注释、文档目录一次性纳入。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录或文件路径（绝对路径）。' },
        url: { type: 'string', description: '或导入单个网页 URL。' },
        collection: { type: 'string', description: '目标集合，缺省 default。' },
        tags: { type: 'string', description: '逗号分隔标签。' },
        recursive: { type: 'boolean', description: '目录是否递归，默认 true。' },
        maxDocs: { type: 'integer', minimum: 1, maximum: 5000, description: '本次最多导入文件数。' },
        useHeadingTitle: { type: 'boolean', description: '用首个标题作标题，默认 true。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          imported: { type: 'integer' },
          deduped: { type: 'integer' },
          failed: { type: 'integer' },
          total: { type: 'integer' },
          results: { type: 'array', items: { type: 'object' } },
        },
        required: ['imported', 'total'],
      },
      render: (_args, value) => TEXT(formatImport(value)),
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      ready()
      writeGuard()
      if (args.url) {
        const saved = await store.addUrl({ ...args, signal: exec.signal })
        return { imported: saved.deduped ? 0 : 1, deduped: saved.deduped ? 1 : 0, failed: 0, total: 1, results: [{ path: args.url, id: saved.id }] }
      }
      return store.importDirectory({ ...args, signal: exec.signal })
    },
  }

  const manage = {
    name: 'kb_manage',
    description:
      '知识库运维：查看状态、配置根目录/向量模式/LLM/embeddings、管理集合、更新或软删除文档、回收站恢复、重建索引、扫描手工写入的 docs/*.md、导出。删除进入回收站可恢复。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'status',
            'configure',
            'create_collection',
            'delete_collection',
            'update',
            'delete',
            'restore',
            'purge',
            'trash',
            'reindex',
            'scan',
            'export',
            'security_status',
            'enable_encryption',
            'disable_encryption',
            'unlock',
            'lock',
            'change_passphrase',
            'rotate_key',
            'set_metadata_encryption',
            'reencrypt',
            'rbac_enable',
            'rbac_disable',
            'user_list',
            'user_add',
            'user_update',
            'user_remove',
            'user_passphrase',
            'grant',
            'revoke',
            'token_issue',
            'token_revoke',
            'mcp_info',
            'bulk_delete',
            'empty_trash',
            'wipe',
          ],
          description: '要执行的操作。安全类操作需要本机 owner 身份。',
        },
        id: { type: 'string', description: '文档 id（update/delete/restore/purge 用）。' },
        title: { type: 'string', description: 'update 时的新标题。' },
        text: { type: 'string', description: 'update 时的新正文（会保留旧版本）。' },
        description: { type: 'string', description: 'create_collection 时的集合说明。' },
        moveTo: { type: 'string', description: 'delete_collection 时把文档迁移到哪个集合。' },
        tags: { type: 'string', description: 'update 时的新标签。' },
        mode: { type: 'string', enum: ['local', 'llm', 'api'], description: 'reindex/update 的向量模式。' },
        full: { type: 'boolean', description: 'reindex 时全量重建统计。' },
        ids: { type: 'array', items: { type: 'string' }, description: 'reindex 指定文档；省略则全部。' },
        query: { type: 'string', description: 'bulk_delete 的关键词筛选（匹配标题/摘要/标签）。' },
        confirm: { type: 'string', description: 'wipe 必须传入确认词 WIPE。' },
        format: { type: 'string', enum: ['md', 'jsonl'], description: 'export 格式。' },
        rootDir: { type: 'string', description: 'configure：新的知识库根目录绝对路径。' },
        vectorMode: { type: 'string', enum: ['local', 'llm', 'api'], description: 'configure：默认向量模式。' },
        chunkSize: { type: 'integer', minimum: 200, maximum: 8000, description: 'configure：分块字符数。' },
        chunkOverlap: { type: 'integer', minimum: 0, maximum: 2000, description: 'configure：分块重叠字符数。' },
        vectorDim: { type: 'integer', minimum: 64, maximum: 4096, description: 'configure：本地向量维度。' },
        llmProvider: { type: 'string', description: 'configure：LLM provider（留空用默认模型）。' },
        llmModel: { type: 'string', description: 'configure：LLM model。' },
        embeddingEndpoint: { type: 'string', description: 'configure：OpenAI 兼容 embeddings endpoint。' },
        embeddingModel: { type: 'string', description: 'configure：embeddings 模型名。' },
        embeddingApiKey: { type: 'string', description: 'configure：embeddings API Key（也可用环境变量 DSH_KB_EMBEDDING_API_KEY）。' },
        watchEnabled: { type: 'boolean', description: 'configure：是否监听 inbox 目录。' },
        defaultCollection: { type: 'string', description: 'configure：默认集合名。' },
        passphrase: { type: 'string', description: '安全操作：解锁/启用加密/轮换所需的口令。出于安全考虑建议只在面板输入。' },
        currentPassphrase: { type: 'string', description: 'change_passphrase：当前口令。' },
        newPassphrase: { type: 'string', description: 'change_passphrase：新口令（至少 8 字符）。' },
        metadataMode: { type: 'string', enum: ['plain', 'encrypted'], description: 'set_metadata_encryption：元数据（标题/标签/摘要）是否也加密。' },
        target: { type: 'string', enum: ['encrypted', 'plain'], description: 'reencrypt：目标存储形态。' },
        rbacLocalRole: { type: 'string', enum: ['owner', 'admin', 'editor', 'reader'], description: 'rbac_enable：本机（面板与 Agent）使用的角色。' },
        user: { type: 'string', description: '用户操作：用户 id 或名称。' },
        userName: { type: 'string', description: 'user_add：新用户名。' },
        role: { type: 'string', enum: ['owner', 'admin', 'editor', 'reader'], description: '用户或集合授权的角色。' },
        disabled: { type: 'boolean', description: 'user_update：停用或恢复该用户。' },
        notes: { type: 'string', description: 'user_add/user_update：备注。' },
        collection: { type: 'string', description: '集合名（update/delete_collection/grant 用）。' },
        grantCollection: { type: 'string', description: 'grant/revoke：授权所属集合；省略或 * 表示全部集合。' },
        grantId: { type: 'string', description: 'revoke：授权记录 id。' },
        label: { type: 'string', description: 'token_issue：令牌名称，例如“Claude Desktop”。' },
        scopes: { type: 'array', items: { type: 'string', enum: ['read', 'write', 'manage', 'security', 'all'] }, description: 'token_issue：令牌允许的动作范围。' },
        ttlDays: { type: 'integer', minimum: 0, maximum: 3650, description: 'token_issue：有效天数；0 表示不过期。' },
        tokenId: { type: 'string', description: 'token_revoke：要吊销的令牌 id。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (_args, value) => TEXT(typeof value === 'string' ? value : jsonText(value)),
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const action = args.action
      if (action === 'status') {
        const status = store.configured ? await store.status(args) : await runtime.status()
        return status
      }
      if (action === 'configure') {
        return runtime.configure({
          rootDir: args.rootDir,
          vectorMode: args.vectorMode,
          chunkSize: args.chunkSize,
          chunkOverlap: args.chunkOverlap,
          vectorDim: args.vectorDim,
          llmProvider: args.llmProvider,
          llmModel: args.llmModel,
          embeddingEndpoint: args.embeddingEndpoint,
          embeddingModel: args.embeddingModel,
          embeddingApiKey: args.embeddingApiKey,
          watchEnabled: args.watchEnabled,
          defaultCollection: args.defaultCollection,
        })
      }
      ready()
      switch (action) {
        case 'create_collection':
          writeGuard()
          return store.createCollection(args.collection, args.description, args)
        case 'delete_collection':
          writeGuard()
          return store.deleteCollection(args.collection, { moveTo: args.moveTo, actor: args.actor })
        case 'update':
          writeGuard()
          return store.update({ id: args.id, title: args.title, text: args.text, collection: args.collection, tags: args.tags, mode: args.mode, actor: args.actor })
        case 'delete':
          writeGuard()
          return store.remove(args.id, args)
        case 'restore':
          writeGuard()
          return store.restore(args.id, args)
        case 'purge':
          writeGuard()
          return store.purge(args.id, args)
        case 'trash':
          return { items: await store.listTrash() }
        case 'reindex':
          writeGuard()
          return store.reindex({ ids: args.ids, full: args.full, mode: args.mode, actor: args.actor })
        case 'scan':
          writeGuard()
          return store.scanDocuments(args)
        case 'export':
          return store.exportAll({ format: args.format, actor: args.actor })
        // ---- 加密 / 多用户 -------------------------------------------------
        case 'security_status':
          return store.securityStatus(args)
        case 'enable_encryption':
          return store.enableEncryption({ passphrase: args.passphrase, metadata: args.metadataMode ?? 'plain', actor: args.actor })
        case 'disable_encryption':
          return store.disableEncryption({ passphrase: args.passphrase, actor: args.actor })
        case 'unlock':
          return { encryption: await store.unlockKnowledgeBase({ passphrase: args.passphrase }) }
        case 'lock':
          return { encryption: await store.lockKnowledgeBase(args) }
        case 'change_passphrase':
          return { encryption: await store.changePassphrase({ current: args.currentPassphrase, next: args.newPassphrase, actor: args.actor }) }
        case 'rotate_key':
          return store.rotateKey({ passphrase: args.passphrase, actor: args.actor })
        case 'set_metadata_encryption':
          return store.setMetadataEncryption({ mode: args.metadataMode, passphrase: args.passphrase, actor: args.actor })
        case 'reencrypt':
          return store.applyEncryption({ target: args.target === 'plain' ? 'plain' : 'encrypted', actor: args.actor })
        case 'rbac_enable':
          return store.setRbac({ enabled: true, localRole: args.rbacLocalRole })
        case 'rbac_disable':
          return store.setRbac({ enabled: false })
        case 'user_list':
          return store.usersStatus(args)
        case 'user_add':
          return store.manageUsers({ ...args, action: 'add', name: args.userName })
        case 'user_update':
          return store.manageUsers({ ...args, action: 'update' })
        case 'user_remove':
          return store.manageUsers({ ...args, action: 'remove' })
        case 'user_passphrase':
          return store.manageUsers({ ...args, action: 'passphrase' })
        case 'grant':
          return store.manageUsers({ ...args, action: 'grant', collection: args.grantCollection ?? args.collection ?? '*' })
        case 'revoke':
          return store.manageUsers({ ...args, action: 'revoke', grantId: args.grantId, collection: args.grantCollection ?? args.collection ?? '*' })
        case 'token_issue':
          return store.manageUsers({ ...args, action: 'token_issue' })
        case 'token_revoke':
          return store.manageUsers({ ...args, action: 'token_revoke' })
        case 'mcp_info':
          return runtime.mcpInfo ? runtime.mcpInfo(args.actor) : { error: '当前 Host 未提供 MCP 信息' }
        case 'bulk_delete': {
          writeGuard()
          if (!args.ids?.length && !args.collection && !args.tags && !args.query) {
            throw new Error('bulk_delete 需要 ids / collection / tags / query 至少一个筛选条件')
          }
          return store.bulkRemove({
            ids: args.ids,
            collection: args.collection,
            tag: args.tags,
            query: args.query,
            actor: args.actor,
          })
        }
        case 'empty_trash':
          writeGuard()
          return store.emptyTrash(args)
        case 'wipe':
          return store.wipe(args)
        default:
          throw new Error(`unknown action: ${action}`)
      }
    },
  }

  // Every tool gets the caller's identity attached to its arguments, so the
  // store enforces the same rules whether the call came from Harness, the Web
  // panel or an MCP client.
  return [search, read, list, add, importTool, manage].map(withActor)
}

function withActor(definition) {
  const execute = definition.execute
  return {
    ...definition,
    async execute(args = {}, exec) {
      const actor = actorFromContext(exec)
      return execute(actor ? { ...args, actor } : args, exec)
    },
  }
}

/**
 * `execute(args, exec)` is called by the Harness tool runtime with an execution
 * context, and by the MCP layer with an Actor. Accept either and hand the actor
 * to the store so permissions are enforced the same way on both paths.
 */
export function actorFromContext(exec) {
  if (!exec || typeof exec !== 'object') return undefined
  if (typeof exec.role === 'string' && typeof exec.via === 'string') return exec
  return exec.actor
}

export { clampInt }
