/**
 * Client half: the Knowledge Base page under Settings.
 *
 * Layout follows the conventions the harness settings panels use: a flat form
 * of field rows separated by hairlines, uppercase group titles, label left and
 * control right on one row, help and hint text below, inputs 34px tall on
 * layer-3 with a border-l4 edge, switches driven by aria-checked, a segmented
 * control whose indicator slides between segments, and a footer holding a note
 * plus the primary save button. Colours come from the shell's own variables so
 * light and dark both stay readable.
 *
 * Styles are injected into document.head from a component effect, guarded by
 * element id so repeated loads do not stack copies.
 *
 * All data flows through the same-origin /kb-api surface, which calls exactly
 * the same store methods as the agent tools.
 */
window.__ModuleLoader__.load({
  id: 'dsh-knowledge-base-local',
  factory(require) {
    const react = require('react')
    const { useState, useEffect, useCallback, useRef, Fragment } = react
    const h = react.createElement

    const NS = 'dsh-knowledge-base-local'
    const STYLE_ID = 'kb-panel-styles'
    /** Bumped on every visual revision so the running build is identifiable. */
    const PANEL_BUILD = 'b11 · renamed+scrubbed'

    const DICT = {
      zh: {
        loading: '正在加载知识库状态…',
        loadFailed: '加载失败',
        retry: '重试',
        tabOverview: '概览',
        tabDocs: '文档',
        tabImport: '导入',
        tabSettings: '设置',
        tabSecurity: '安全',
        tabMcp: 'MCP',
        save: '保存',
        saving: '保存中…',
        cancel: '取消',
        close: '关闭',
        confirm: '确认',
        copy: '复制',
        copied: '已复制',
        open: '打开',
        remove: '删除',
        restore: '恢复',
        purge: '彻底删除',
        trash: '回收站',
        apply: '筛选',
        search: '检索',
        dirty: '有未保存的修改',
        saved: '配置已保存',
        noChange: '没有需要保存的修改',
        status: '状态',
        root: '根目录',
        rootHint: '正文以普通 Markdown 保存在此，任何模型或编辑器都能直接读。',
        changeRoot: '更换目录',
        pickDir: '浏览…',
        scale: '规模',
        scaleHint: '{docs} 篇文档 · {chunks} 个分块 · {collections} 个集合',
        vectorMode: '向量模式',
        encryption: '加密',
        access: '多用户',
        on: '已开启',
        off: '未开启',
        locked: '已锁定',
        lockedTitle: '知识库已加密并锁定',
        lockedSub: '解锁后才能检索或写入。',
        unlock: '解锁',
        actions: '操作',
        reindex: '重建索引',
        reindexHint: '更改向量模式或分块参数后执行一次。',
        scan: '扫描 docs 目录',
        export: '导出全部',
        exported: '已导出：{path}',
        searchTitle: '检索',
        searchPlaceholder: '输入关键词或问题，回车检索',
        noHits: '没有命中，换个说法再试。',
        hits: '命中 {n} 条',
        setupTitle: '选择知识库目录',
        setupHint: '目录不存在会自动创建，之后可随时更换。',
        filter: '筛选',
        allCollections: '全部集合',
        tagFilter: '标签',
        textFilter: '关键词',
        documents: '文档',
        docsEmpty: '还没有文档。到「导入」页签上传文件或粘贴文本。',
        total: '共 {n} 篇',
        prev: '上一页',
        next: '下一页',
        uploadTitle: '上传文件',
        dropTitle: '把文件拖到这里，或点击选择',
        dropHint: '支持 PDF、Word、Excel、PPT 与任意文本；正文自动抽取，原文件留作附件。',
        uploading: '正在上传并抽取…',
        uploadDone: '新增 {n} · 去重 {d} · 失败 {f}',
        collection: '集合',
        tags: '标签',
        tagsHint: '逗号分隔',
        needUnlock: '知识库已锁定，请先在「安全」页签解锁。',
        dangerZone: '危险操作',
        bulkDelete: '按当前筛选批量删除',
        bulkDeleteHint: '把当前「集合/标签/关键词」命中的文档移入回收站（可恢复）；editor 只会删到自己创建的。',
        emptyTrashBtn: '清空回收站',
        emptyTrashHint: '彻底删除回收站内条目，不可恢复。',
        wipeAll: '清空整个知识库…',
        wipeHint: '不可逆：删除全部文档、回收站、索引、版本、附件与导出。仅本机 owner 可执行。',
        wipeTitle: '一键清空整个知识库',
        wipeBody: '这将永久删除库内所有内容且不可恢复。请在下方输入 WIPE 以确认。',
        wipeWordLabel: '确认词（输入 WIPE）',
        wipeFolder: '同时删除本地根目录并取消配置',
        wipeOk: '已清空 {n} 篇文档。',
        bulkOk: '已移入回收站 {n} 篇{extra}。',
        skippedSuffix: '，跳过 {n} 篇（无权限）',
        trashEmptied: '已彻底删除 {n} 条回收站条目。',
        folderTitle: '批量导入目录',
        folderHint: '从磁盘递归导入，适合一次性纳入整个笔记库。',
        folderPath: '目录路径',
        recursive: '包含子目录',
        maxDocs: '最多导入',
        startImport: '开始导入',
        importDone: '新增 {n} · 去重 {d} · 失败 {f}',
        pasteTitle: '粘贴文本',
        docTitle: '标题',
        docBody: '正文',
        docBodyPlaceholder: '粘贴笔记、网页正文或 Markdown…',
        addDoc: '保存文档',
        basic: '基础',
        indexVector: '索引与向量',
        chunkSize: '分块字符数',
        chunkOverlap: '分块重叠',
        vectorDim: '本地向量维度',
        defaultCollection: '默认集合',
        modeLocal: 'local',
        modeLlm: 'llm',
        modeApi: 'api',
        llmTitle: 'LLM 增强',
        provider: 'Provider',
        providerHint: '留空使用 Harness 当前模型',
        model: '模型',
        embeddingTitle: '外部 Embeddings',
        endpoint: '端点',
        endpointHint: 'https://…/v1',
        embeddingModel: '模型',
        apiKey: 'API Key',
        apiKeyHint: '也可用环境变量 DSH_KB_EMBEDDING_API_KEY',
        behavior: '行为',
        watch: '监听 inbox 目录',
        watchHint: '丢进 <根目录>/inbox 的文件会自动入库。',
        allowWrite: '允许写入类工具',
        allowWriteHint: '关闭后 kb_add / kb_import 与写操作会被拒绝，只保留检索。',
        configPath: '配置文件',
        encTitle: '静态加密',
        encHint: 'AES-256-GCM 逐篇加密正文、索引、版本与清单；口令经 scrypt 派生密钥，仅用于包裹随机数据密钥。',
        encEnable: '开启加密',
        passphrase: '口令',
        passphrase2: '确认口令',
        passphraseHint: '至少 8 个字符',
        metadata: '元数据也加密',
        metadataHint: '标题、标签、摘要一并加密，CATALOG 不再列出标题；默认明文便于直接浏览。',
        encWarning: '口令不会被保存且无法找回，忘记即等于语料永久不可读。',
        lockNow: '立即锁定',
        changePass: '更换口令',
        currentPass: '当前口令',
        newPass: '新口令',
        rotate: '轮换数据密钥',
        rotateHint: '生成新数据密钥并重新加密全部语料，耗时较长。',
        disableEnc: '关闭加密并解密',
        disableEncConfirm: '将把全部密文解密回明文并删除本地数据密钥，确认继续？',
        coverage: '磁盘：正文 {a}/{b} 密文 · 索引 {i} 信封 · 清单 {m}',
        usersTitle: '用户与权限',
        rbacHint: '关闭时为单人使用：面板与 Agent 拥有全部权限，行为与旧版本一致。',
        localRole: '本机角色',
        roleOwner: 'owner',
        roleAdmin: 'admin',
        roleEditor: 'editor',
        roleReader: 'reader',
        userList: '用户',
        userName: '用户名',
        userRole: '角色',
        addUser: '新建用户',
        setPass: '设置口令',
        disable: '停用',
        enable: '启用',
        deleteUser: '删除',
        deleteUserConfirm: '删除该用户及其全部令牌？不可撤销。',
        grants: '集合授权',
        grantUser: '用户',
        grantHint: '集合授权只能收紧角色，不会提高全局权限。',
        addGrant: '授权',
        revoke: '取消',
        tokens: 'API 令牌',
        tokenUser: '所属用户',
        tokenLabel: '备注名',
        tokenLabelHint: '例如 Claude Desktop',
        scopes: '权限范围',
        ttl: '有效天数（0=不过期）',
        issueToken: '签发令牌',
        tokenOnce: '令牌只显示这一次，请立即复制：',
        tokenRevokeConfirm: '吊销后使用该令牌的客户端会立即失去访问，确认？',
        lastUsed: '最近使用 {time}',
        neverUsed: '从未使用',
        noUsers: '还没有其他用户。',
        noGrants: '没有集合级授权。',
        noTokens: '还没有令牌。',
        mcpEndpoint: '端点',
        mcpHint: '把知识库暴露给外部 MCP 客户端；工具与参数和 Agent 侧完全一致。',
        mcpStdio: 'stdio 入口',
        mcpStdioHint: '不带 --root 时沿用这里的设置；贴进客户端的 mcpServers 即可。',
        mcpPolicy: '接入策略',
        mcpEnabled: '启用 MCP 服务',
        mcpHttp: '挂载 HTTP 端点',
        mcpRequireToken: '要求令牌',
        mcpRequireTokenHint: '关闭后，任何能访问本机端口的外部进程都可读写。',
        mcpAllowLocal: '允许同源免令牌',
        mcpAllowLocalHint: 'Harness 网页自身按本机角色执行。',
        mcpAllowWrite: '允许写入',
        mcpOrigins: '允许的跨域 Origin',
        mcpOriginsHint: '逗号分隔，例如 http://localhost:18789',
        mcpTools: '暴露的工具',
        mcpNote: '外部客户端的权限由令牌与该用户的角色决定。',
      },
      en: {
        loading: 'Loading knowledge base status…',
        loadFailed: 'Failed to load',
        retry: 'Retry',
        tabOverview: 'Overview',
        tabDocs: 'Documents',
        tabImport: 'Import',
        tabSettings: 'Settings',
        tabSecurity: 'Security',
        tabMcp: 'MCP',
        save: 'Save',
        saving: 'Saving…',
        cancel: 'Cancel',
        close: 'Close',
        confirm: 'Confirm',
        copy: 'Copy',
        copied: 'Copied',
        open: 'Open',
        remove: 'Delete',
        restore: 'Restore',
        purge: 'Delete forever',
        trash: 'Trash',
        apply: 'Filter',
        search: 'Search',
        dirty: 'Unsaved changes',
        saved: 'Saved',
        noChange: 'Nothing to save',
        status: 'Status',
        root: 'Root folder',
        rootHint: 'Bodies are stored here as plain Markdown, readable by any editor.',
        changeRoot: 'Change folder',
        pickDir: 'Browse…',
        scale: 'Scale',
        scaleHint: '{docs} documents · {chunks} chunks · {collections} collections',
        vectorMode: 'Vector mode',
        encryption: 'Encryption',
        access: 'Users',
        on: 'On',
        off: 'Off',
        locked: 'Locked',
        lockedTitle: 'The knowledge base is encrypted and locked',
        lockedSub: 'Unlock it to search or write.',
        unlock: 'Unlock',
        actions: 'Actions',
        reindex: 'Rebuild index',
        reindexHint: 'Run once after changing the vector mode or chunking.',
        scan: 'Scan docs folder',
        export: 'Export all',
        exported: 'Exported: {path}',
        searchTitle: 'Search',
        searchPlaceholder: 'Ask a question or type keywords',
        noHits: 'No matches — try another phrasing.',
        hits: '{n} hits',
        setupTitle: 'Choose a knowledge base folder',
        setupHint: 'Created if missing; you can change it later.',
        filter: 'Filter',
        allCollections: 'All collections',
        tagFilter: 'Tag',
        textFilter: 'Keyword',
        documents: 'Documents',
        docsEmpty: 'No documents yet — use the Import tab.',
        total: '{n} documents',
        prev: 'Previous',
        next: 'Next',
        uploadTitle: 'Upload files',
        dropTitle: 'Drop files here, or click to choose',
        dropHint: 'PDF, Word, Excel, PowerPoint and any text file; the body is extracted and the original kept.',
        uploading: 'Uploading and extracting…',
        uploadDone: '{n} new · {d} duplicate · {f} failed',
        collection: 'Collection',
        tags: 'Tags',
        tagsHint: 'comma separated',
        needUnlock: 'The knowledge base is locked — unlock it on the Security tab.',
        dangerZone: 'Danger zone',
        bulkDelete: 'Bulk delete by filter',
        bulkDeleteHint: 'Move documents matched by the current collection/tag/keyword filter to the trash (recoverable); an editor only reaches their own documents.',
        emptyTrashBtn: 'Empty trash',
        emptyTrashHint: 'Delete every trash entry for real; cannot be undone.',
        wipeAll: 'Erase the entire knowledge base…',
        wipeHint: 'Irreversible: removes all documents, trash, index, versions, attachments and exports. Owner only.',
        wipeTitle: 'Erase the whole knowledge base',
        wipeBody: 'This permanently deletes everything in the library and cannot be undone. Type WIPE below to confirm.',
        wipeWordLabel: 'Confirmation (type WIPE)',
        wipeFolder: 'Also delete the local root folder and unset it',
        wipeOk: 'Erased {n} documents.',
        bulkOk: 'Moved {n} to the trash{extra}.',
        skippedSuffix: ', skipped {n} (no permission)',
        trashEmptied: 'Purged {n} trash entries.',
        folderTitle: 'Import a folder',
        folderHint: 'Recursively import a directory from disk.',
        folderPath: 'Folder path',
        recursive: 'Include subfolders',
        maxDocs: 'Max documents',
        startImport: 'Start import',
        importDone: '{n} new · {d} duplicate · {f} failed',
        pasteTitle: 'Paste text',
        docTitle: 'Title',
        docBody: 'Body',
        docBodyPlaceholder: 'Paste notes, article text or Markdown…',
        addDoc: 'Save document',
        basic: 'Basic',
        indexVector: 'Index and vectors',
        chunkSize: 'Chunk size (chars)',
        chunkOverlap: 'Chunk overlap',
        vectorDim: 'Local vector dim',
        defaultCollection: 'Default collection',
        modeLocal: 'local',
        modeLlm: 'llm',
        modeApi: 'api',
        llmTitle: 'LLM enrichment',
        provider: 'Provider',
        providerHint: 'empty = current Harness model',
        model: 'Model',
        embeddingTitle: 'External embeddings',
        endpoint: 'Endpoint',
        endpointHint: 'https://…/v1',
        embeddingModel: 'Model',
        apiKey: 'API key',
        apiKeyHint: 'or DSH_KB_EMBEDDING_API_KEY',
        behavior: 'Behaviour',
        watch: 'Watch the inbox folder',
        watchHint: 'Files dropped into <root>/inbox are imported automatically.',
        allowWrite: 'Allow writing tools',
        allowWriteHint: 'When off, kb_add / kb_import and write actions are refused.',
        configPath: 'Settings file',
        encTitle: 'At-rest encryption',
        encHint: 'AES-256-GCM seals bodies, indexes, versions and the manifest; the passphrase only wraps a random data key.',
        encEnable: 'Turn on encryption',
        passphrase: 'Passphrase',
        passphrase2: 'Repeat passphrase',
        passphraseHint: 'at least 8 characters',
        metadata: 'Encrypt metadata too',
        metadataHint: 'Titles, tags and summaries are sealed; CATALOG stops listing titles.',
        encWarning: 'The passphrase is never stored and cannot be recovered.',
        lockNow: 'Lock now',
        changePass: 'Change passphrase',
        currentPass: 'Current passphrase',
        newPass: 'New passphrase',
        rotate: 'Rotate data key',
        rotateHint: 'Generates a new data key and re-encrypts everything.',
        disableEnc: 'Turn off and decrypt',
        disableEncConfirm: 'Everything is decrypted back to plain Markdown and the local key is deleted. Continue?',
        coverage: 'On disk: {a}/{b} bodies sealed · {i} index envelopes · manifest {m}',
        usersTitle: 'Users and permissions',
        rbacHint: 'While off this is single-user: panel and agent keep full rights.',
        localRole: 'Local role',
        roleOwner: 'owner',
        roleAdmin: 'admin',
        roleEditor: 'editor',
        roleReader: 'reader',
        userList: 'Users',
        userName: 'Name',
        userRole: 'Role',
        addUser: 'Add user',
        setPass: 'Set passphrase',
        disable: 'Disable',
        enable: 'Enable',
        deleteUser: 'Delete',
        deleteUserConfirm: 'Delete this user and all of its tokens?',
        grants: 'Collection grants',
        grantUser: 'User',
        grantHint: 'Grants only narrow a role, never widen it.',
        addGrant: 'Grant',
        revoke: 'Revoke',
        tokens: 'API tokens',
        tokenUser: 'User',
        tokenLabel: 'Label',
        tokenLabelHint: 'e.g. Claude Desktop',
        scopes: 'Scopes',
        ttl: 'Valid days (0 = never)',
        issueToken: 'Issue token',
        tokenOnce: 'Shown only once — copy it now:',
        tokenRevokeConfirm: 'Clients using this token lose access immediately. Continue?',
        lastUsed: 'last used {time}',
        neverUsed: 'never used',
        noUsers: 'No other users yet.',
        noGrants: 'No collection grants.',
        noTokens: 'No tokens yet.',
        mcpEndpoint: 'Endpoint',
        mcpHint: 'Expose the knowledge base to external MCP clients; tools match the agent side.',
        mcpStdio: 'stdio entry',
        mcpStdioHint: 'Without --root it reuses these settings.',
        mcpPolicy: 'Access policy',
        mcpEnabled: 'Enable the MCP server',
        mcpHttp: 'Mount the HTTP endpoint',
        mcpRequireToken: 'Require a token',
        mcpRequireTokenHint: 'When off, any local process can read and write without credentials.',
        mcpAllowLocal: 'Same-origin without token',
        mcpAllowLocalHint: 'The Harness GUI acts as the local role.',
        mcpAllowWrite: 'Allow writes',
        mcpOrigins: 'Allowed cross-origin origins',
        mcpOriginsHint: 'comma separated',
        mcpTools: 'Exposed tools',
        mcpNote: 'What an external client may do is decided by its token and that user’s role.',
      },
    }

    const CSS = `
/* Panel stylesheet, built from the shell's own primitive sheets so the controls
 * match the rest of the app instead of approximating it:
 *   ConfigField.module.css        -> field rows, hairlines, inputs inside a form
 *   Button.module.css             -> button metrics, primary and outline variants
 *   Switch.module.css             -> track, thumb and their aria-checked states
 *   SegmentedControl.module.css   -> track, sliding indicator, tabs
 *   Modal.module.css              -> mask, card radius, elevation and padding
 * Colours are semantic --dsw-alias-* tokens only (no literal values), radii come
 * from the --dsw-radius-* scale, motion from --ds-transition-duration and
 * --ds-ease-in-out. The pill track and round thumb opt out of the global
 * superellipse with corner-shape: round, as corner-shape.css requires. */
.kb-panel {
  display: flex; flex-direction: column; width: 100%;
  color: var(--dsw-alias-label-primary);
  font-size: 13px; line-height: 1.5;
}
.kb-panel > .kb-seg { align-self: flex-start; margin-bottom: 6px; max-width: 100%; }
.kb-form { display: flex; flex-direction: column; width: 100%; }

/* ---- ConfigField ---- */
.kb-group-title {
  padding: 14px 0 2px; font-size: 12px; font-weight: 600; line-height: 18px;
  color: var(--dsw-alias-label-tertiary); text-transform: uppercase; letter-spacing: .04em;
}
.kb-field { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; }
.kb-field + .kb-field { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.kb-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 28px; }
.kb-label {
  flex: 1; min-width: 0; font-size: 13px; font-weight: 500; line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.kb-help { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.kb-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.kb-input, .kb-select, .kb-textarea {
  box-sizing: border-box; width: 100%; padding: 6px 12px;
  border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; line-height: 1.5; outline: none;
  transition: border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}
.kb-input:focus, .kb-select:focus, .kb-textarea:focus { border-color: var(--dsw-alias-state-business-primary); }
.kb-input::placeholder, .kb-textarea::placeholder { color: var(--dsw-alias-label-dimmed); }
.kb-input:disabled, .kb-textarea:disabled, .kb-select:disabled {
  color: var(--dsw-alias-label-caption); cursor: not-allowed; opacity: .6;
}
.kb-textarea { min-height: 68px; resize: vertical; }
/* Own chevron: the native select arrow follows the OS scheme, not the app theme. */
.kb-select {
  appearance: none; -webkit-appearance: none; padding-right: 30px;
  background-image:
    linear-gradient(45deg, transparent 50%, var(--dsw-alias-label-secondary) 50%),
    linear-gradient(135deg, var(--dsw-alias-label-secondary) 50%, transparent 50%);
  background-position: calc(100% - 17px) 50%, calc(100% - 12px) 50%;
  background-size: 5px 5px, 5px 5px;
  background-repeat: no-repeat;
}

/* ---- Switch ---- */
.kb-switch {
  box-sizing: border-box; position: relative; flex: 0 0 auto;
  width: 36px; height: 20px; padding: 2px; border: 0;
  border-radius: 999px; corner-shape: round;
  background: var(--dsw-alias-border-l3); cursor: pointer;
}
.kb-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); }
.kb-switch:disabled { cursor: default; opacity: .5; }
.kb-switch:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.kb-switch-thumb {
  display: block; width: 16px; height: 16px; border-radius: 50%; corner-shape: round;
  background: var(--dsw-alias-label-primary-foreground);
  transition: transform 120ms ease;
}
.kb-switch[aria-checked='false'] .kb-switch-thumb { background: var(--dsw-alias-switch-thumb); }
.kb-switch[aria-checked='true'] .kb-switch-thumb { transform: translateX(16px); }

/* ---- SegmentedControl ---- */
.kb-seg {
  position: relative; display: inline-grid; grid-auto-flow: column; grid-auto-columns: 1fr;
  gap: 2px; padding: 4px; border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-interactive-bg-hover);
}
.kb-seg-indicator {
  position: absolute; top: 4px; left: 4px;
  width: calc((100% - 8px - 2px * (var(--kb-seg-count) - 1)) / var(--kb-seg-count));
  height: calc(100% - 8px);
  border: 0; border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-soft);
  transform: translateX(calc(var(--kb-seg-index) * (100% + 2px)));
  transition: transform 160ms ease;
  pointer-events: none;
}
.kb-seg-tab {
  box-sizing: border-box; position: relative; z-index: 1; height: 28px; padding: 0 16px;
  border: 0; border-radius: var(--dsw-radius-sm); background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; line-height: 20px;
  font-weight: 500; white-space: nowrap; cursor: pointer;
  transition: color 120ms ease;
}
.kb-seg-tab:hover:not(:disabled), .kb-seg-tab[aria-selected='true'] { color: var(--dsw-alias-label-primary); }
.kb-seg-tab:disabled { cursor: default; opacity: .4; }
.kb-seg-tab:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}

/* ---- Button ---- */
.kb-btn, .kb-save {
  box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  height: 36px; padding: 0 14px; border: none; border-radius: var(--dsw-radius-md);
  font: inherit; font-size: 14px; line-height: 22px; cursor: pointer;
  color: var(--dsw-alias-label-primary); background: transparent;
  transition: background-color var(--ds-transition-duration-fast) var(--ds-ease-in-out),
    color var(--ds-transition-duration-fast) var(--ds-ease-in-out),
    border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}
.kb-btn:disabled, .kb-save:disabled, .kb-ghost:disabled { cursor: not-allowed; opacity: .4; }
/* Secondary actions read as the outlined variant: neutral hairline plus hover tint. */
.kb-btn { border: 0.5px solid var(--dsw-alias-border-l3); }
.kb-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.kb-btn:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); }
.kb-btn--primary, .kb-save {
  border: none; background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}
.kb-btn--primary:hover:not(:disabled), .kb-save:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.kb-btn--danger { border-color: transparent; color: var(--dsw-alias-state-error-primary); }
.kb-btn--danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }
.kb-btn--sm { height: 28px; padding: 0 10px; font-size: 12px; line-height: 18px; border-radius: var(--dsw-radius-sm); }
.kb-btn:focus-visible, .kb-save:focus-visible, .kb-ghost:focus-visible, .kb-drop:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
.kb-ghost {
  border: none; background: none; padding: 4px 8px; border-radius: var(--dsw-radius-sm);
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; cursor: pointer;
  transition: background-color var(--ds-transition-duration-fast) var(--ds-ease-in-out),
    color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}
.kb-ghost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }

/* ---- footer, notes, read-only values ---- */
.kb-footer { display: flex; align-items: center; gap: 8px; padding-top: 16px; flex-wrap: wrap; }
.kb-note { flex: 1; min-width: 0; margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-caption); }
.kb-note--error { color: var(--dsw-alias-state-error-primary); }
.kb-note--warn { color: var(--dsw-alias-state-warn-label); }
.kb-note--ok { color: var(--dsw-alias-label-secondary); }
.kb-readonly {
  font-family: var(--ds-font-family-code); font-size: 12px;
  color: var(--dsw-alias-label-secondary); word-break: break-all; margin: 0;
}
.kb-actions { display: flex; align-items: center; gap: 8px; padding: 12px 0 0; flex-wrap: wrap; }

/* ---- upload target ---- */
.kb-drop {
  display: flex; flex-direction: column; gap: 4px; padding: 20px 14px; margin-top: 8px;
  border: 1px dashed var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md);
  background: transparent; cursor: pointer; text-align: center;
  transition: background-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}
.kb-drop:hover, .kb-drop--over { background: var(--dsw-alias-interactive-bg-hover); }
.kb-drop:focus-visible { outline-offset: 2px; }
.kb-drop__title { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.kb-drop__hint { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); }

/* ---- code blocks ---- */
.kb-pre {
  margin: 0; padding: 8px 12px; box-sizing: border-box;
  border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-3);
  font-family: var(--ds-font-family-code); font-size: 12px; line-height: 1.5;
  color: var(--dsw-alias-label-primary); white-space: pre-wrap; overflow-wrap: anywhere;
  max-height: 260px; overflow: auto;
}
.kb-copy { position: relative; margin-top: 6px; }
.kb-copy > .kb-ghost { position: absolute; top: 2px; right: 2px; }

/* ---- Modal ---- */
.kb-backdrop {
  pointer-events: auto; position: fixed; inset: 0; z-index: 1000;
  display: flex; align-items: center; justify-content: center;
  padding: max(24px, var(--dsh-frame-overlay-top, 24px)) 24px;
  background: var(--dsw-alias-bg-mask-1); backdrop-filter: var(--dsw-mask-blur);
  animation: kb-modal-enter var(--ds-transition-duration) var(--ds-ease-in-out);
}
.kb-dialog {
  box-sizing: border-box; position: relative; display: flex; flex-direction: column; gap: 20px;
  width: min(560px, 100%); max-height: 100%; padding: 0 0 24px; overflow: hidden;
  border: 0; border-radius: var(--dsw-radius-panel);
  background: var(--dsw-alias-bg-layer-2); box-shadow: var(--dsw-elevation-prominent);
  color: var(--dsw-alias-label-primary);
  animation: kb-modal-enter var(--ds-transition-duration) var(--ds-ease-in-out);
}
.kb-dialog:focus { outline: none; }
.kb-dialog__title {
  margin: 0; padding: 22px 24px 12px; font-size: 16px; line-height: 24px; font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.kb-dialog__body { display: flex; flex-direction: column; gap: 8px; min-height: 0; overflow: auto; padding: 0 24px; }
.kb-dialog__body:first-child { padding-top: 22px; }
.kb-dialog__foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 0 24px; }
@keyframes kb-modal-enter {
  from { opacity: 0; }
  to { opacity: 1; }
}
.kb-build { margin: 0; padding-top: 14px; font-size: 11px; color: var(--dsw-alias-label-caption); }

@media (prefers-reduced-motion: reduce) {
  .kb-seg-indicator, .kb-seg-tab, .kb-switch-thumb, .kb-dialog, .kb-backdrop,
  .kb-btn, .kb-save, .kb-ghost, .kb-input, .kb-select, .kb-textarea, .kb-drop {
    transition: none; animation: none;
  }
}
`

    /** Inject the panel stylesheet once per document, from the component that uses it. */
    function usePanelStyles() {
      useEffect(() => {
        if (typeof document === 'undefined') return undefined
        const existing = document.getElementById(STYLE_ID)
        if (existing !== null) {
          existing.textContent = CSS
          return undefined
        }
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = CSS
        document.head.appendChild(style)
        return () => {
          style.remove()
        }
      }, [])
    }

    /* -------------------------------------------------------------- helpers -- */
    async function api(path, options) {
      const response = await fetch(`/kb-api${path}`, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...options,
        headers: options?.body ? { 'content-type': 'application/json', ...(options.headers ?? {}) } : options?.headers,
      })
      const text = await response.text()
      let data = {}
      try {
        data = text ? JSON.parse(text) : {}
      } catch {
        data = { error: text.slice(0, 200) }
      }
      if (!response.ok) {
        const error = new Error(data.error || `HTTP ${response.status}`)
        error.status = response.status
        throw error
      }
      return data
    }

    const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body ?? {}) })

    function fmt(template, params) {
      if (!params) return String(template)
      return String(template).replace(/\{(\w+)\}/g, (whole, key) => String(params[key] ?? whole))
    }

    function fmtBytes(bytes) {
      const value = Number(bytes) || 0
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
      return `${(value / 1024 / 1024).toFixed(1)} MB`
    }

    function relTime(iso) {
      const at = Date.parse(String(iso ?? ''))
      if (!Number.isFinite(at)) return ''
      const diff = Date.now() - at
      if (diff < 60000) return '刚刚'
      if (diff < 3600000) return `${Math.round(diff / 60000)} 分钟前`
      if (diff < 86400000 * 2) return `${Math.round(diff / 3600000)} 小时前`
      return new Date(at).toLocaleDateString()
    }

    function readFileBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const text = String(reader.result ?? '')
          const comma = text.indexOf(',')
          resolve(comma >= 0 ? text.slice(comma + 1) : text)
        }
        reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
        reader.readAsDataURL(file)
      })
    }

    function same(a, b) {
      if (a === b) return true
      if (typeof a !== typeof b) return false
      if (a === null || b === null || typeof a !== 'object') return false
      if (Array.isArray(a) !== Array.isArray(b)) return false
      if (Array.isArray(a)) return a.length === b.length && a.every((item, index) => same(item, b[index]))
      const keys = Object.keys(a)
      if (keys.length !== Object.keys(b).length) return false
      return keys.every((key) => same(a[key], b[key]))
    }

    function currentLang(locale) {
      try {
        // LocaleSnapshot publishes the active id as `active` (alongside
        // `locales` and `revision`); there is no `id` or `locale` field.
        // Reading a missing one falls through to the browser language and pins
        // the panel to it no matter what the user picks in Settings.
        const snapshot = locale?.getLocale?.() ?? locale?.getSnapshot?.()
        const active = String(snapshot?.active ?? '')
        if (active !== '') return active.toLowerCase().startsWith('zh') ? 'zh' : 'en'
      } catch {
        /* a locale service that is not up yet falls back to the browser */
      }
      return String(navigator.language ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }

    /* ----------------------------------------------------------- components -- */
    function Switch({ checked, label, onChange, disabled }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          'aria-label': label ?? '',
          className: 'kb-switch',
          disabled,
          onClick: () => onChange(!checked),
        },
        h('span', { className: 'kb-switch-thumb' }),
      )
    }

    function Segmented({ value, options, onChange, label }) {
      const index = Math.max(0, options.findIndex((item) => item.value === value))
      return h(
        'div',
        { className: 'kb-seg', role: 'tablist', 'aria-label': label, style: { '--kb-seg-count': options.length, '--kb-seg-index': index } },
        h('span', { className: 'kb-seg-indicator' }),
        options.map((item) =>
          h(
            'button',
            {
              key: item.value,
              type: 'button',
              role: 'tab',
              'aria-selected': item.value === value ? 'true' : 'false',
              className: 'kb-seg-tab',
              onClick: () => onChange(item.value),
            },
            item.label,
          ),
        ),
      )
    }

    function SwitchRow({ label, help, checked, onChange }) {
      return h(
        'div',
        { className: 'kb-field' },
        h('div', { className: 'kb-head' }, h('span', { className: 'kb-label' }, label), h(Switch, { checked, label, onChange })),
        help ? h('p', { className: 'kb-help' }, help) : null,
      )
    }

    function FieldRow({ label, help, value, placeholder, onChange, type, disabled, onEnter }) {
      return h(
        'div',
        { className: 'kb-field' },
        label ? h('span', { className: 'kb-label' }, label) : null,
        h('input', {
          className: 'kb-input',
          type: type ?? 'text',
          value: value ?? '',
          placeholder,
          disabled,
          spellCheck: false,
          onChange: (event) => onChange(event.currentTarget.value),
          onKeyDown: onEnter ? (event) => { if (event.key === 'Enter') onEnter() } : undefined,
        }),
        help ? h('p', { className: 'kb-hint' }, help) : null,
      )
    }

    function NumberRow({ label, help, value, min, max, onChange }) {
      return h(
        'div',
        { className: 'kb-field' },
        h('span', { className: 'kb-label' }, label),
        h('input', {
          className: 'kb-input',
          type: 'number',
          value: String(value ?? ''),
          min,
          max,
          onChange: (event) => onChange(Number(event.currentTarget.value) || 0),
        }),
        help ? h('p', { className: 'kb-hint' }, help) : null,
      )
    }

    function AreaRow({ label, help, value, rows, onChange }) {
      return h(
        'div',
        { className: 'kb-field' },
        h('span', { className: 'kb-label' }, label),
        h('textarea', {
          className: 'kb-input kb-textarea',
          value: value ?? '',
          rows: rows ?? 4,
          onChange: (event) => onChange(event.currentTarget.value),
        }),
        help ? h('p', { className: 'kb-hint' }, help) : null,
      )
    }

    function SegmentedRow({ label, help, value, options, onChange }) {
      return h(
        'div',
        { className: 'kb-field' },
        h('div', { className: 'kb-head' }, h('span', { className: 'kb-label' }, label), h(Segmented, { value, options, onChange, label })),
        help ? h('p', { className: 'kb-hint' }, help) : null,
      )
    }

    function SelectRow({ label, help, value, options, onChange }) {
      return h(
        'div',
        { className: 'kb-field' },
        h('span', { className: 'kb-label' }, label),
        h(
          'select',
          { className: 'kb-select', value: value ?? '', onChange: (event) => onChange(event.currentTarget.value) },
          options.map((item) => h('option', { key: String(item.value), value: String(item.value) }, item.label)),
        ),
        help ? h('p', { className: 'kb-hint' }, help) : null,
      )
    }

    function ReadonlyRow({ label, value, hint, children }) {
      return h(
        'div',
        { className: 'kb-field' },
        h('div', { className: 'kb-head' }, h('span', { className: 'kb-label' }, label), children ?? null),
        h('p', { className: 'kb-readonly' }, value ?? ''),
        hint ? h('p', { className: 'kb-hint' }, hint) : null,
      )
    }

    function Btn({ kind, small, children, ...rest }) {
      return h('button', { type: 'button', className: `kb-btn${kind ? ` kb-btn--${kind}` : ''}${small ? ' kb-btn--sm' : ''}`, ...rest }, children)
    }

    function Ghost({ children, ...rest }) {
      return h('button', { type: 'button', className: 'kb-ghost', ...rest }, children)
    }

    function CopyBox({ text, copyLabel, copiedLabel }) {
      const [done, setDone] = useState(false)
      const timer = useRef(null)
      useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
      const copy = useCallback(async () => {
        try {
          if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(String(text))
          else {
            const area = document.createElement('textarea')
            area.value = String(text)
            area.style.position = 'fixed'
            area.style.opacity = '0'
            document.body.appendChild(area)
            area.select()
            document.execCommand('copy')
            area.remove()
          }
          setDone(true)
          timer.current = setTimeout(() => setDone(false), 1600)
        } catch {
          setDone(false)
        }
      }, [text])
      return h('div', { className: 'kb-copy' }, h('pre', { className: 'kb-pre' }, text), h(Ghost, { onClick: copy }, done ? copiedLabel : copyLabel))
    }

    function DropZone({ t, disabled, onFiles, accept }) {
      const [over, setOver] = useState(false)
      const input = useRef(null)
      const pick = () => { if (!disabled) input.current?.click() }
      return h(
        'div',
        {
          className: `kb-drop${over ? ' kb-drop--over' : ''}`,
          role: 'button',
          tabIndex: disabled ? -1 : 0,
          'aria-disabled': disabled ? 'true' : 'false',
          onClick: pick,
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              pick()
            }
          },
          onDragOver: (event) => {
            event.preventDefault()
            if (!disabled) setOver(true)
          },
          onDragLeave: () => setOver(false),
          onDrop: (event) => {
            event.preventDefault()
            setOver(false)
            if (disabled) return
            const files = Array.from(event.dataTransfer?.files ?? [])
            if (files.length > 0) onFiles(files)
          },
        },
        h('span', { className: 'kb-drop__title' }, t('dropTitle')),
        h('span', { className: 'kb-drop__hint' }, t('dropHint')),
        h('input', {
          ref: input,
          type: 'file',
          multiple: true,
          accept,
          style: { display: 'none' },
          onChange: (event) => {
            const files = Array.from(event.currentTarget.files ?? [])
            event.currentTarget.value = ''
            if (files.length > 0) onFiles(files)
          },
        }),
      )
    }

    function Dialog({ open, title, children, onClose, onConfirm, confirmLabel, cancelLabel, danger, busy }) {
      const ref = useRef(null)
      useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') onClose?.()
        }
        window.addEventListener('keydown', onKey)
        const first = ref.current?.querySelector('input,textarea,select,button')
        if (first) first.focus()
        return () => window.removeEventListener('keydown', onKey)
      }, [open, onClose])
      if (!open) return null
      return h(
        'div',
        { className: 'kb-backdrop', onMouseDown: (event) => { if (event.target === event.currentTarget) onClose?.() } },
        h(
          'div',
          { className: 'kb-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title ?? '', ref },
          title ? h('h3', { className: 'kb-dialog__title' }, title) : null,
          h('div', { className: 'kb-dialog__body' }, children),
          h(
            'div',
            { className: 'kb-dialog__foot' },
            cancelLabel ? h(Btn, { onClick: onClose }, cancelLabel) : null,
            onConfirm ? h(Btn, { kind: danger ? 'danger' : 'primary', onClick: onConfirm, disabled: busy }, confirmLabel) : null,
          ),
        ),
      )
    }

    /* ---------------------------------------------------------------- panel -- */
    function Panel({ ctx }) {
      usePanelStyles()
      const locale = ctx.get('locale')
      const [lang, setLang] = useState(() => currentLang(locale))
      const t = useCallback((key, params) => fmt((DICT[lang] ?? DICT.zh)[key] ?? DICT.zh[key] ?? key, params), [lang])

      const [tab, setTab] = useState('overview')
      const [status, setStatus] = useState(null)
      const [fatal, setFatal] = useState('')
      const [busy, setBusy] = useState('')
      const [flash, setFlash] = useState(null)

      const [settingsInitial, setSettingsInitial] = useState(null)
      const [settingsForm, setSettingsForm] = useState(null)

      const [docs, setDocs] = useState([])
      const [docsTotal, setDocsTotal] = useState(0)
      const [trash, setTrash] = useState([])
      const [collections, setCollections] = useState([])
      const [filter, setFilter] = useState({ collection: '', tag: '', query: '', limit: 20, offset: 0 })
      const [detail, setDetail] = useState(null)
      const [results, setResults] = useState(null)
      const [query, setQuery] = useState('')

      const [upload, setUpload] = useState(null)
      const [shared, setShared] = useState({ collection: '', tags: '' })
      const [folder, setFolder] = useState({ path: '', recursive: true, maxDocs: 200 })
      const [draft, setDraft] = useState({ title: '', text: '' })

      const [sec, setSec] = useState(null)
      const [users, setUsers] = useState(null)
      const [enc, setEnc] = useState({ pass: '', repeat: '', metadata: false })
      const [unlockPass, setUnlockPass] = useState('')
      const [change, setChange] = useState({ current: '', next: '' })
      const [rbacRole, setRbacRole] = useState('owner')
      const [newUser, setNewUser] = useState({ name: '', role: 'reader' })
      const [passFor, setPassFor] = useState(null)
      const [passValue, setPassValue] = useState('')
      const [grant, setGrant] = useState({ user: '', collection: '', role: 'reader' })
      const [tokenDraft, setTokenDraft] = useState({ user: '', label: '', ttlDays: 0, scopes: ['read'] })
      const [issued, setIssued] = useState('')

      const [mcpInitial, setMcpInitial] = useState(null)
      const [mcpForm, setMcpForm] = useState(null)
      const [mcpMeta, setMcpMeta] = useState(null)

      const [confirmBox, setConfirmBox] = useState(null)
      const [wipeBox, setWipeBox] = useState({ open: false, word: '', folder: false })
      const alive = useRef(true)
      const maxFileBytes = Number(status?.maxFileBytes) || 8 * 1024 * 1024

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      useEffect(() => {
        if (typeof locale?.subscribe !== 'function') return undefined
        return locale.subscribe(() => setLang(currentLang(locale)))
      }, [locale])

      const notice = useCallback((message, tone = 'ok') => {
        if (!message) return
        setFlash({ message, tone })
        setTimeout(() => setFlash((current) => (current?.message === message ? null : current)), 5000)
      }, [])

      const run = useCallback(
        async (key, action) => {
          setBusy(key)
          try {
            return await action()
          } catch (error) {
            notice(String(error?.message ?? error), 'error')
            return undefined
          } finally {
            setBusy('')
          }
        },
        [notice],
      )

      const loadStatus = useCallback(async () => {
        try {
          const value = await api('/status')
          if (alive.current) setStatus(value)
          return value
        } catch (error) {
          if (alive.current) setFatal(String(error?.message ?? error))
          return undefined
        }
      }, [])

      const loadDocs = useCallback(
        async (next) => {
          const current = next ?? filter
          const params = new URLSearchParams({ limit: String(current.limit), offset: String(current.offset), sort: 'updated' })
          if (current.collection) params.set('collection', current.collection)
          if (current.tag) params.set('tag', current.tag)
          if (current.query) params.set('query', current.query)
          const value = await api(`/docs?${params.toString()}`)
          if (!alive.current) return
          setDocs(value.docs ?? [])
          setDocsTotal(value.total ?? (value.docs ?? []).length)
        },
        [filter],
      )

      const loadTrash = useCallback(async () => {
        const value = await api('/trash').catch(() => ({ items: [] }))
        if (alive.current) setTrash(value.items ?? [])
      }, [])

      const loadCollections = useCallback(async () => {
        const value = await api('/collections').catch(() => ({ collections: [] }))
        if (alive.current) setCollections(value.collections ?? [])
      }, [])

      const loadSecurity = useCallback(async () => {
        const [security, directory] = await Promise.all([api('/security').catch(() => null), api('/users').catch(() => null)])
        if (!alive.current) return
        setSec(security)
        setUsers(directory)
        if (security?.access?.localRole) setRbacRole(security.access.localRole)
      }, [])

      const loadMcp = useCallback(async () => {
        const value = await api('/mcp').catch(() => null)
        if (!alive.current) return
        setMcpMeta(value)
        if (value) {
          const form = {
            enabled: value.enabled !== false,
            http: value.httpMounted !== false,
            requireToken: value.requireToken !== false,
            allowLocalOrigin: value.allowLocalOrigin !== false,
            allowWrite: value.readonly !== true,
            allowedOrigins: (value.allowedOrigins ?? []).join(', '),
          }
          setMcpInitial(form)
          setMcpForm(form)
        }
      }, [])

      const refreshAll = useCallback(async () => {
        const value = await loadStatus()
        if (value?.configured && !value.locked) await Promise.all([loadDocs(), loadTrash(), loadCollections()])
      }, [loadStatus, loadDocs, loadTrash, loadCollections])

      useEffect(() => {
        void run('init', async () => {
          const value = await loadStatus()
          if (value?.configured && !value.locked) await Promise.all([loadDocs(), loadTrash(), loadCollections()])
        })
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      useEffect(() => {
        if (tab === 'security') void run('security', loadSecurity)
        if (tab === 'mcp') void run('mcp', loadMcp)
        if (tab === 'docs') void run('docs', async () => { await loadTrash(); await loadDocs() })
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [tab])

      useEffect(() => {
        if (!status?.configured) return
        const seed = {
          rootDir: status.root ?? '',
          vectorMode: status.vectorMode ?? 'local',
          chunkSize: status.chunkSize ?? 1200,
          chunkOverlap: status.chunkOverlap ?? 200,
          vectorDim: status.dim ?? 1024,
          defaultCollection: status.defaultCollection ?? 'default',
          llmProvider: status.llm?.provider ?? '',
          llmModel: status.llm?.model ?? '',
          embeddingEndpoint: status.embedding?.endpoint ?? '',
          embeddingModel: status.embedding?.model ?? '',
          embeddingApiKey: '',
          watchEnabled: status.watch?.enabled !== false,
          allowWrite: status.allowWrite !== false,
        }
        setSettingsInitial(seed)
        setSettingsForm(seed)
      }, [status])

      const configured = Boolean(status?.configured)
      const locked = Boolean(status?.locked ?? status?.security?.locked)
      const security = sec?.encryption ?? status?.security?.encryption ?? {}
      const access = sec?.access ?? status?.security?.access ?? {}
      const rbacOn = Boolean(access.rbacEnabled ?? access.enabled)
      const userList = users?.users ?? []
      const tokenList = users?.tokens ?? []
      const grantList = users?.grants ?? []
      const roleOptions = [
        { value: 'owner', label: t('roleOwner') },
        { value: 'admin', label: t('roleAdmin') },
        { value: 'editor', label: t('roleEditor') },
        { value: 'reader', label: t('roleReader') },
      ]
      const collectionOptions = [{ value: '', label: t('allCollections') }].concat(collections.map((item) => ({ value: item.name, label: `${item.name} (${item.docs})` })))
      const userOptions = [{ value: '', label: '—' }].concat(userList.map((item) => ({ value: item.id, label: `${item.name} · ${item.role}` })))

      const saveSecurity = (body, done) =>
        run('security', async () => {
          const value = await post('/security', body)
          await loadSecurity()
          await loadStatus()
          if (done) done(value)
        })

      const saveUsers = (body, done) =>
        run('security', async () => {
          const value = await post('/users', body)
          await loadSecurity()
          if (done) done(value)
        })

      const pickDirectory = async () => {
        const workspace = ctx.get('uiWorkspace')
        if (typeof workspace?.pickDirectory !== 'function') return ''
        try {
          return String((await workspace.pickDirectory()) ?? '')
        } catch {
          return ''
        }
      }

      const applyConfig = (patch) =>
        run('config', async () => {
          await post('/config', patch)
          await refreshAll()
          notice(t('saved'))
        })

      const submitSettings = () =>
        run('settings', async () => {
          const changed = {}
          for (const key of Object.keys(settingsForm)) {
            if (!same(settingsForm[key], settingsInitial?.[key])) changed[key] = settingsForm[key]
          }
          if (Object.keys(changed).length === 0) return notice(t('noChange'))
          const body = {
            ...(changed.rootDir !== undefined ? { rootDir: changed.rootDir } : {}),
            ...(changed.vectorMode !== undefined ? { vectorMode: changed.vectorMode } : {}),
            ...(changed.chunkSize !== undefined ? { chunkSize: changed.chunkSize } : {}),
            ...(changed.chunkOverlap !== undefined ? { chunkOverlap: changed.chunkOverlap } : {}),
            ...(changed.vectorDim !== undefined ? { vectorDim: changed.vectorDim } : {}),
            ...(changed.defaultCollection !== undefined ? { defaultCollection: changed.defaultCollection } : {}),
            ...(changed.llmProvider !== undefined || changed.llmModel !== undefined
              ? { llmProvider: settingsForm.llmProvider, llmModel: settingsForm.llmModel }
              : {}),
            ...(changed.embeddingEndpoint !== undefined || changed.embeddingModel !== undefined || changed.embeddingApiKey !== undefined
              ? { embeddingEndpoint: settingsForm.embeddingEndpoint, embeddingModel: settingsForm.embeddingModel, ...(settingsForm.embeddingApiKey ? { embeddingApiKey: settingsForm.embeddingApiKey } : {}) }
              : {}),
            ...(changed.watchEnabled !== undefined ? { watchEnabled: changed.watchEnabled } : {}),
            ...(changed.allowWrite !== undefined ? { tools: { allowWrite: changed.allowWrite } } : {}),
          }
          await post('/config', body)
          const value = await loadStatus()
          if (value?.configured) await Promise.all([loadCollections(), loadDocs()])
          notice(t('saved'))
        })

      const submitMcp = () =>
        run('mcp', async () => {
          const changed = {}
          for (const key of Object.keys(mcpForm)) {
            if (!same(mcpForm[key], mcpInitial?.[key])) changed[key] = mcpForm[key]
          }
          if (Object.keys(changed).length === 0) return notice(t('noChange'))
          await post('/config', {
            mcp: {
              enabled: mcpForm.enabled,
              http: mcpForm.http,
              requireToken: mcpForm.requireToken,
              allowLocalOrigin: mcpForm.allowLocalOrigin,
              allowWrite: mcpForm.allowWrite,
              allowedOrigins: mcpForm.allowedOrigins.split(',').map((item) => item.trim()).filter(Boolean),
            },
          })
          await loadMcp()
          notice(t('saved'))
        })

      const onUpload = (files) =>
        run('upload', async () => {
          if (locked) return notice(t('needUnlock'), 'error')
          const payload = []
          const skipped = []
          for (const file of files) {
            if (file.size > maxFileBytes) {
              skipped.push(`${file.name}（${fmtBytes(file.size)} > ${fmtBytes(maxFileBytes)}）`)
              continue
            }
            payload.push({ name: file.name, data: await readFileBase64(file) })
          }
          let value = null
          if (payload.length > 0) {
            value = await post('/upload', { files: payload, collection: shared.collection.trim(), tags: shared.tags.trim(), maxDocs: 100 })
          }
          setUpload({ ...(value ?? { imported: 0, deduped: 0, failed: 0, total: 0, results: [] }), skipped })
          if (value) notice(fmt(t('uploadDone'), { n: value.imported, d: value.deduped, f: value.failed }), value.failed > 0 ? 'error' : 'ok')
          await refreshAll()
        })

      const onImportFolder = () =>
        run('folder', async () => {
          if (locked) return notice(t('needUnlock'), 'error')
          if (folder.path.trim() === '') return
          const value = await post('/import', {
            path: folder.path.trim(),
            recursive: folder.recursive,
            maxDocs: folder.maxDocs,
            collection: shared.collection.trim() || undefined,
            tags: shared.tags.trim() || undefined,
            useHeadingTitle: true,
          })
          notice(fmt(t('importDone'), { n: value.imported, d: value.deduped, f: value.failed }), value.failed > 0 ? 'error' : 'ok')
          await refreshAll()
        })

      const onAddText = () =>
        run('addText', async () => {
          if (locked) return notice(t('needUnlock'), 'error')
          if (draft.text.trim() === '') return
          await post('/add', {
            title: draft.title.trim() || undefined,
            text: draft.text,
            collection: shared.collection.trim() || undefined,
            tags: shared.tags.trim() || undefined,
          })
          setDraft({ title: '', text: '' })
          notice(t('saved'))
          await refreshAll()
        })

      const openDoc = (id) => run('detail', async () => setDetail(await api(`/doc?id=${encodeURIComponent(id)}`)))
      const reindex = () => run('reindex', async () => { await post('/reindex', { full: true }); await refreshAll(); notice(t('reindex') + ' ✓') })
      const scan = () => run('scan', async () => { await post('/scan', {}); await refreshAll(); notice(t('scan') + ' ✓') })
      const exportAll = () => run('export', async () => { const value = await post('/export', { format: 'md' }); notice(fmt(t('exported'), { path: value.path })) })
      const doSearch = () =>
        run('search', async () => {
          const text = query.trim()
          if (text === '') return setResults(null)
          setResults(await api(`/search?q=${encodeURIComponent(text)}&limit=8`))
        })

      const tabOptions = [
        { value: 'overview', label: t('tabOverview') },
        { value: 'docs', label: t('tabDocs') },
        { value: 'import', label: t('tabImport') },
        { value: 'settings', label: t('tabSettings') },
        { value: 'security', label: t('tabSecurity') },
        { value: 'mcp', label: t('tabMcp') },
      ]

      const footerNote = () =>
        flash
          ? h('p', { className: `kb-note${flash.tone === 'error' ? ' kb-note--error' : ' kb-note--ok'}`, style: { paddingTop: 12 } }, flash.message)
          : null

      if (fatal && !status) {
        return h(
          'div',
          { className: 'kb-panel' },
          h('div', { className: 'kb-form' }, h('p', { className: 'kb-hint' }, `${t('loadFailed')}：${fatal}`), h('div', { className: 'kb-actions' }, h(Btn, { onClick: () => run('retry', async () => { setFatal(''); await refreshAll() }) }, t('retry')))),
          h('p', { className: 'kb-build' }, `dsh-knowledge-base-local · ${PANEL_BUILD}`),
        )
      }
      if (!status) {
        return h('div', { className: 'kb-panel' }, h('div', { className: 'kb-form' }, h('p', { className: 'kb-hint' }, t('loading'))), h('p', { className: 'kb-build' }, `dsh-knowledge-base-local · ${PANEL_BUILD}`))
      }

      if (!configured) {
        const rootValue = settingsForm?.rootDir ?? ''
        return h(
          'form',
          { className: 'kb-panel', onSubmit: (event) => { event.preventDefault(); if (rootValue.trim()) void applyConfig({ rootDir: rootValue }) } },
          h('div', { className: 'kb-form' },
            h('div', { className: 'kb-group-title' }, t('setupTitle')),
            h(FieldRow, { label: t('root'), help: t('setupHint'), value: rootValue, placeholder: '/path/to/knowledge', onChange: (value) => setSettingsForm({ ...(settingsForm ?? {}), rootDir: value }) }),
            h('div', { className: 'kb-footer' },
              h('p', { className: 'kb-note' }, t('rootHint')),
              h(Btn, { onClick: async () => { const picked = await pickDirectory(); if (picked) setSettingsForm({ ...(settingsForm ?? {}), rootDir: picked }) } }, t('pickDir')),
              h('button', { type: 'submit', className: 'kb-save', disabled: busy !== '' || rootValue.trim() === '' }, busy === 'config' ? t('saving') : t('save')),
            ),
          ),
          h('p', { className: 'kb-build' }, `dsh-knowledge-base-local · ${PANEL_BUILD}`),
        )
      }

      const overview = () => {
        const used = (status.collections ?? []).filter((item) => item.docs > 0).length
        return h(
          'div',
          { className: 'kb-form' },
          h('div', { className: 'kb-group-title' }, t('status')),
          locked
            ? h('div', { className: 'kb-field' },
                h('div', { className: 'kb-head' }, h('span', { className: 'kb-label' }, t('lockedTitle')), h(Btn, { small: true, onClick: () => setTab('security') }, t('unlock'))),
                h('p', { className: 'kb-help' }, t('lockedSub')),
                h('div', { className: 'kb-head', style: { paddingTop: 8 } },
                  h('input', {
                    className: 'kb-input',
                    type: 'password',
                    value: unlockPass,
                    placeholder: t('passphrase'),
                    onChange: (event) => setUnlockPass(event.currentTarget.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void saveSecurity({ action: 'unlock', passphrase: unlockPass }, () => setUnlockPass(''))
                      }
                    },
                  }),
                  h(Btn, { kind: 'primary', disabled: busy !== '' || unlockPass.length < 8, onClick: () => saveSecurity({ action: 'unlock', passphrase: unlockPass }, () => setUnlockPass('')) }, t('unlock')),
                ),
              )
            : null,
          h(ReadonlyRow, {
            label: t('root'),
            value: status.root,
            hint: t('rootHint'),
            children: [
              h(Btn, { key: 'p', small: true, onClick: async () => { const picked = await pickDirectory(); if (picked) await applyConfig({ rootDir: picked }) } }, t('pickDir')),
              h(Btn, { key: 'c', small: true, onClick: () => setTab('settings') }, t('changeRoot')),
            ],
          }),
          h(ReadonlyRow, { label: t('scale'), value: fmt(t('scaleHint'), { docs: status.docs ?? 0, chunks: status.chunks ?? 0, collections: used }) }),
          h(ReadonlyRow, { label: t('vectorMode'), value: String(status.vectorMode ?? '') }),
          h(ReadonlyRow, { label: t('encryption'), value: security.enabled ? (locked ? t('locked') : t('on')) : t('off') }),
          h(ReadonlyRow, { label: t('access'), value: rbacOn ? `${t('on')} · ${userList.length}` : t('off') }),
          h('div', { className: 'kb-group-title' }, t('searchTitle')),
          h('div', { className: 'kb-field' },
            h('div', { className: 'kb-head' },
              h('input', {
                className: 'kb-input',
                value: query,
                placeholder: t('searchPlaceholder'),
                onChange: (event) => setQuery(event.currentTarget.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void doSearch()
                  }
                },
              }),
              h(Btn, { onClick: doSearch, disabled: busy !== '' }, t('search')),
            ),
            results ? h('p', { className: 'kb-hint' }, (results.results ?? []).length === 0 ? t('noHits') : fmt(t('hits'), { n: results.total ?? results.results.length })) : null,
          ),
          (results?.results ?? []).slice(0, 8).map((item, index) =>
            h('div', { className: 'kb-field', key: `${item.docId}-${index}` },
              h('div', { className: 'kb-head' },
                h('span', { className: 'kb-label' }, item.title ?? item.docId),
                h(Ghost, { onClick: () => openDoc(item.docId) }, t('open')),
              ),
              h('p', { className: 'kb-hint' }, `${item.collection ?? ''}${item.lineStart ? ` · L${item.lineStart}-${item.lineEnd ?? item.lineStart}` : ''}${typeof item.score === 'number' ? ` · ${item.score.toFixed(3)}` : ''}`),
              item.snippet ? h('p', { className: 'kb-help' }, item.snippet) : null,
            ),
          ),
          h('div', { className: 'kb-group-title' }, t('actions')),
          h('div', { className: 'kb-actions' },
            h(Btn, { onClick: () => setTab('import') }, t('tabImport')),
            h(Btn, { onClick: reindex, disabled: busy !== '' }, t('reindex')),
            h(Btn, { onClick: scan, disabled: busy !== '' }, t('scan')),
            h(Btn, { onClick: exportAll, disabled: busy !== '' }, t('export')),
          ),
          h('p', { className: 'kb-hint' }, t('reindexHint')),
          status.degradedReason ? h('p', { className: 'kb-hint kb-note--error' }, String(status.degradedReason)) : null,
        )
      }

      const docsTab = () => {
        const applyFilter = (patch) => {
          const next = { ...filter, ...patch, offset: 0 }
          setFilter(next)
          void run('docs', () => loadDocs(next))
        }
        return h(
          'div',
          { className: 'kb-form' },
          h('div', { className: 'kb-group-title' }, t('filter')),
          h(SelectRow, { label: t('collection'), value: filter.collection, options: collectionOptions, onChange: (value) => applyFilter({ collection: value }) }),
          h(FieldRow, { label: t('tagFilter'), value: filter.tag, onChange: (value) => setFilter({ ...filter, tag: value }), onEnter: () => applyFilter({}) }),
          h(FieldRow, { label: t('textFilter'), value: filter.query, onChange: (value) => setFilter({ ...filter, query: value }), onEnter: () => applyFilter({}) }),
          h('div', { className: 'kb-actions' }, h(Btn, { onClick: () => applyFilter({}), disabled: busy !== '' }, t('apply'))),
          h('div', { className: 'kb-group-title' }, t('documents')),
          docs.length === 0
            ? h('p', { className: 'kb-hint', style: { padding: '12px 0' } }, t('docsEmpty'))
            : docs.map((doc) =>
                h('div', { className: 'kb-field', key: doc.id },
                  h('div', { className: 'kb-head' },
                    h('span', { className: 'kb-label' }, doc.title),
                    h(Ghost, { onClick: () => openDoc(doc.id) }, t('open')),
                    h(Ghost, { onClick: () => setConfirmBox({ title: t('remove'), body: doc.title, danger: true, run: async () => { await post('/delete', { id: doc.id }); await refreshAll() } }) }, t('remove')),
                  ),
                  h('p', { className: 'kb-hint' }, `${doc.collection} · ${doc.chunkCount} chunks · ${doc.chars} chars${doc.extract?.kind ? ` · ${doc.extract.kind}` : ''}${doc.file ? ' · attachment' : ''}`),
                  doc.extract?.failed ? h('p', { className: 'kb-hint kb-note--error' }, doc.extract.error ?? 'no text extracted') : null,
                  doc.summary ? h('p', { className: 'kb-help' }, doc.summary) : null,
                ),
              ),
          h('div', { className: 'kb-footer' },
            h('p', { className: 'kb-note' }, fmt(t('total'), { n: docsTotal })),
            h(Btn, { small: true, disabled: filter.offset <= 0 || busy !== '', onClick: () => { const next = { ...filter, offset: Math.max(0, filter.offset - filter.limit) }; setFilter(next); void run('docs', () => loadDocs(next)) } }, t('prev')),
            h(Btn, { small: true, disabled: filter.offset + filter.limit >= docsTotal || busy !== '', onClick: () => { const next = { ...filter, offset: filter.offset + filter.limit }; setFilter(next); void run('docs', () => loadDocs(next)) } }, t('next')),
          ),
          trash.length > 0 ? h('div', { className: 'kb-group-title' }, `${t('trash')} (${trash.length})`) : null,
          trash.length > 0
            ? trash.map((item) =>
                h('div', { className: 'kb-field', key: item.id },
                  h('div', { className: 'kb-head' },
                    h('span', { className: 'kb-label' }, item.title ?? item.id),
                    h(Ghost, { onClick: () => run('restore', async () => { await post('/restore', { id: item.id }); await refreshAll() }) }, t('restore')),
                    h(Ghost, { onClick: () => setConfirmBox({ title: t('purge'), body: item.title ?? item.id, danger: true, run: async () => { await post('/purge', { id: item.id }); await refreshAll() } }) }, t('purge')),
                  ),
                  h('p', { className: 'kb-hint' }, item.collection ?? ''),
                ),
              )
            : null,
          h('div', { className: 'kb-group-title' }, t('dangerZone')),
          h(
            'div',
            { className: 'kb-field' },
            h('div', { className: 'kb-head' },
              h('span', { className: 'kb-label' }, t('bulkDelete')),
              h(Btn, {
                small: true,
                disabled: busy !== '' || locked || !(filter.collection || filter.tag || filter.query),
                onClick: () =>
                  setConfirmBox({
                    title: t('bulkDelete'),
                    body: t('bulkDeleteHint'),
                    danger: true,
                    run: async () => {
                      const value = await post('/bulk-remove', { collection: filter.collection || undefined, tag: filter.tag || undefined, query: filter.query || undefined })
                      await refreshAll()
                      notice(fmt(t('bulkOk'), { n: value.trashed, extra: value.skipped?.length ? fmt(t('skippedSuffix'), { n: value.skipped.length }) : '' }), value.skipped?.length ? 'error' : 'ok')
                    },
                  }),
              }, t('bulkDelete')),
            ),
            h('p', { className: 'kb-hint' }, t('bulkDeleteHint')),
          ),
          h(
            'div',
            { className: 'kb-field' },
            h('div', { className: 'kb-head' },
              h('span', { className: 'kb-label' }, t('emptyTrashBtn')),
              h(Btn, {
                small: true,
                disabled: busy !== '' || locked || trash.length === 0,
                onClick: () =>
                  setConfirmBox({
                    title: t('emptyTrashBtn'),
                    body: t('emptyTrashHint'),
                    danger: true,
                    run: async () => {
                      const value = await post('/empty-trash', {})
                      await refreshAll()
                      notice(fmt(t('trashEmptied'), { n: value.removed }))
                    },
                  }),
              }, t('emptyTrashBtn')),
            ),
            h('p', { className: 'kb-hint' }, t('emptyTrashHint')),
          ),
          h(
            'div',
            { className: 'kb-field' },
            h('div', { className: 'kb-head' },
              h('span', { className: 'kb-label' }, t('wipeAll')),
              h(Btn, { small: true, kind: 'danger', disabled: busy !== '' || locked, onClick: () => setWipeBox({ open: true, word: '', folder: false }) }, t('wipeAll')),
            ),
            h('p', { className: 'kb-hint' }, t('wipeHint')),
          ),
        )
      }

      const importTab = () =>
        h(
          'div',
          { className: 'kb-form' },
          locked ? h('p', { className: 'kb-hint kb-note--error', style: { padding: '10px 0' } }, t('needUnlock')) : null,
          h('div', { className: 'kb-group-title' }, t('uploadTitle')),
          h(DropZone, { t, disabled: busy !== '' || locked, onFiles: onUpload }),
          h(FieldRow, { label: t('collection'), value: shared.collection, placeholder: 'default', onChange: (value) => setShared({ ...shared, collection: value }) }),
          h(FieldRow, { label: t('tags'), help: t('tagsHint'), value: shared.tags, onChange: (value) => setShared({ ...shared, tags: value }) }),
          busy === 'upload' ? h('p', { className: 'kb-hint' }, t('uploading')) : null,
          upload
            ? h(Fragment, {},
                h('p', { className: 'kb-help' }, fmt(t('uploadDone'), { n: upload.imported, d: upload.deduped, f: upload.failed })),
                (upload.results ?? []).map((item, index) =>
                  h('div', { className: 'kb-field', key: `${item.name}-${index}` },
                    h('div', { className: 'kb-head' },
                      h('span', { className: 'kb-label' }, item.name),
                      item.id ? h(Ghost, { onClick: () => openDoc(item.id) }, t('open')) : null,
                    ),
                    h('p', { className: 'kb-hint' }, item.error
                      ? item.error
                      : `${item.extract?.kind ?? 'text'}${item.extract?.pages ? ` · ${item.extract.pages}p` : ''}${item.deduped ? ' · duplicate' : ''}${item.extract?.failed ? ` · ${item.extract.error ?? 'no text'}` : ''}`),
                  ),
                ),
                (upload.skipped ?? []).map((item) => h('p', { className: 'kb-hint kb-note--error', key: item }, item)),
              )
            : null,
          h('div', { className: 'kb-group-title' }, t('folderTitle')),
          h(FieldRow, { label: t('folderPath'), help: t('folderHint'), value: folder.path, placeholder: '/path/to/notes', onChange: (value) => setFolder({ ...folder, path: value }) }),
          h(NumberRow, { label: t('maxDocs'), value: folder.maxDocs, min: 1, max: 5000, onChange: (value) => setFolder({ ...folder, maxDocs: value }) }),
          h(SwitchRow, { label: t('recursive'), checked: folder.recursive, onChange: (checked) => setFolder({ ...folder, recursive: checked }) }),
          h('div', { className: 'kb-actions' },
            h(Btn, { onClick: async () => { const picked = await pickDirectory(); if (picked) setFolder({ ...folder, path: picked }) } }, t('pickDir')),
            h(Btn, { kind: 'primary', disabled: busy !== '' || locked || folder.path.trim() === '', onClick: onImportFolder }, busy === 'folder' ? t('saving') : t('startImport')),
          ),
          h('div', { className: 'kb-group-title' }, t('pasteTitle')),
          h(FieldRow, { label: t('docTitle'), value: draft.title, onChange: (value) => setDraft({ ...draft, title: value }) }),
          h(AreaRow, { label: t('docBody'), help: t('docBodyPlaceholder'), value: draft.text, rows: 6, onChange: (value) => setDraft({ ...draft, text: value }) }),
          h('div', { className: 'kb-footer' },
            h('p', { className: 'kb-note' }, t('tagsHint')),
            h(Btn, { kind: 'primary', disabled: busy !== '' || locked || draft.text.trim() === '', onClick: onAddText }, t('addDoc')),
          ),
        )

      const settingsTab = () => {
        const form = settingsForm ?? {}
        const set = (patch) => setSettingsForm({ ...form, ...patch })
        const dirty = settingsInitial ? Object.keys(form).some((key) => !same(form[key], settingsInitial[key])) : false
        return h(
          'form',
          { className: 'kb-form', onSubmit: (event) => { event.preventDefault(); void submitSettings() } },
          h('div', { className: 'kb-group-title' }, t('basic')),
          h(FieldRow, { label: t('root'), help: t('rootHint'), value: form.rootDir ?? '', placeholder: '/path/to/knowledge', onChange: (value) => set({ rootDir: value }) }),
          h('div', { className: 'kb-actions' }, h(Btn, { onClick: async () => { const picked = await pickDirectory(); if (picked) set({ rootDir: picked }) } }, t('pickDir'))),
          h(FieldRow, { label: t('defaultCollection'), value: form.defaultCollection ?? '', onChange: (value) => set({ defaultCollection: value }) }),
          h('div', { className: 'kb-group-title' }, t('indexVector')),
          h(SegmentedRow, {
            label: t('vectorMode'),
            value: form.vectorMode ?? 'local',
            options: [
              { value: 'local', label: t('modeLocal') },
              { value: 'llm', label: t('modeLlm') },
              { value: 'api', label: t('modeApi') },
            ],
            onChange: (value) => set({ vectorMode: value }),
          }),
          h(NumberRow, { label: t('chunkSize'), value: form.chunkSize, min: 200, max: 8000, onChange: (value) => set({ chunkSize: value }) }),
          h(NumberRow, { label: t('chunkOverlap'), value: form.chunkOverlap, min: 0, max: 2000, onChange: (value) => set({ chunkOverlap: value }) }),
          h(NumberRow, { label: t('vectorDim'), value: form.vectorDim, min: 64, max: 4096, onChange: (value) => set({ vectorDim: value }) }),
          h('div', { className: 'kb-group-title' }, t('llmTitle')),
          h(FieldRow, { label: t('provider'), help: t('providerHint'), value: form.llmProvider ?? '', onChange: (value) => set({ llmProvider: value }) }),
          h(FieldRow, { label: t('model'), value: form.llmModel ?? '', onChange: (value) => set({ llmModel: value }) }),
          h('div', { className: 'kb-group-title' }, t('embeddingTitle')),
          h(FieldRow, { label: t('endpoint'), help: t('endpointHint'), value: form.embeddingEndpoint ?? '', onChange: (value) => set({ embeddingEndpoint: value }) }),
          h(FieldRow, { label: t('embeddingModel'), value: form.embeddingModel ?? '', placeholder: 'text-embedding-3-small', onChange: (value) => set({ embeddingModel: value }) }),
          h(FieldRow, { label: t('apiKey'), help: t('apiKeyHint'), value: form.embeddingApiKey ?? '', type: 'password', onChange: (value) => set({ embeddingApiKey: value }) }),
          h('div', { className: 'kb-group-title' }, t('behavior')),
          h(SwitchRow, { label: t('watch'), help: t('watchHint'), checked: form.watchEnabled !== false, onChange: (checked) => set({ watchEnabled: checked }) }),
          h(SwitchRow, { label: t('allowWrite'), help: t('allowWriteHint'), checked: form.allowWrite !== false, onChange: (checked) => set({ allowWrite: checked }) }),
          h(ReadonlyRow, { label: t('configPath'), value: status.settingsPath ?? '' }),
          h('div', { className: 'kb-actions' },
            h(Btn, { onClick: reindex, disabled: busy !== '' }, t('reindex')),
            h(Btn, { onClick: scan, disabled: busy !== '' }, t('scan')),
            h(Btn, { onClick: exportAll, disabled: busy !== '' }, t('export')),
          ),
          h('div', { className: 'kb-footer' },
            h('p', { className: `kb-note${flash ? (flash.tone === 'error' ? ' kb-note--error' : ' kb-note--ok') : ''}` }, flash ? flash.message : dirty ? t('dirty') : t('reindexHint')),
            h('button', { type: 'submit', className: 'kb-save', disabled: busy !== '' || !dirty }, busy === 'settings' ? t('saving') : t('save')),
          ),
        )
      }

      const securityTab = () => {
        const coverage = sec?.coverage ?? {}
        const total = (coverage.docs?.encrypted ?? 0) + (coverage.docs?.plain ?? 0)
        return h(
          'div',
          { className: 'kb-form' },
          locked
            ? h('div', { className: 'kb-field' },
                h('div', { className: 'kb-head' }, h('span', { className: 'kb-label' }, t('lockedTitle'))),
                h('p', { className: 'kb-help' }, t('lockedSub')),
                h('input', {
                  className: 'kb-input',
                  type: 'password',
                  value: unlockPass,
                  placeholder: t('passphrase'),
                  onChange: (event) => setUnlockPass(event.currentTarget.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void saveSecurity({ action: 'unlock', passphrase: unlockPass }, () => setUnlockPass(''))
                    }
                  },
                }),
                h('div', { className: 'kb-actions' }, h(Btn, { kind: 'primary', disabled: busy !== '' || unlockPass.length < 8, onClick: () => saveSecurity({ action: 'unlock', passphrase: unlockPass }, () => setUnlockPass('')) }, t('unlock'))),
              )
            : null,
          h('div', { className: 'kb-group-title' }, `${t('encTitle')} · ${security.enabled ? (security.unlocked ? t('on') : t('off')) : t('off')}`),
          h('p', { className: 'kb-help' }, t('encHint')),
          security.enabled
            ? h('p', { className: 'kb-hint' }, fmt(t('coverage'), { a: coverage.docs?.encrypted ?? 0, b: total, i: coverage.indexes?.encrypted ?? 0, m: coverage.manifest ?? 'plain' }))
            : null,
          !security.enabled
            ? h(Fragment, {},
                h(FieldRow, { label: t('passphrase'), help: t('passphraseHint'), value: enc.pass, type: 'password', onChange: (value) => setEnc({ ...enc, pass: value }) }),
                h(FieldRow, { label: t('passphrase2'), value: enc.repeat, type: 'password', onChange: (value) => setEnc({ ...enc, repeat: value }) }),
                h(SwitchRow, { label: t('metadata'), help: t('metadataHint'), checked: enc.metadata, onChange: (checked) => setEnc({ ...enc, metadata: checked }) }),
                h('p', { className: 'kb-hint kb-note--error' }, t('encWarning')),
                h('div', { className: 'kb-actions' },
                  h(Btn, {
                    kind: 'primary',
                    disabled: busy !== '' || enc.pass.length < 8 || enc.pass !== enc.repeat,
                    onClick: () => saveSecurity({ action: 'enable', passphrase: enc.pass, metadataMode: enc.metadata ? 'encrypted' : 'plain' }, () => setEnc({ pass: '', repeat: '', metadata: false })),
                  }, t('encEnable')),
                ),
              )
            : h(Fragment, {},
                h(FieldRow, { label: t('currentPass'), value: change.current, type: 'password', onChange: (value) => setChange({ ...change, current: value }) }),
                h(FieldRow, { label: t('newPass'), help: t('passphraseHint'), value: change.next, type: 'password', onChange: (value) => setChange({ ...change, next: value }) }),
                h(SwitchRow, { label: t('metadata'), help: t('metadataHint'), checked: (security.metadata ?? 'plain') === 'encrypted', onChange: (checked) => saveSecurity({ action: 'metadata', mode: checked ? 'encrypted' : 'plain' }) }),
                h('div', { className: 'kb-actions' },
                  h(Btn, { disabled: busy !== '' || change.current.length < 8 || change.next.length < 8, onClick: () => saveSecurity({ action: 'passphrase', currentPassphrase: change.current, newPassphrase: change.next }, () => setChange({ current: '', next: '' })) }, t('changePass')),
                  h(Btn, { disabled: busy !== '' || !security.unlocked, onClick: () => saveSecurity({ action: 'lock' }) }, t('lockNow')),
                  h(Btn, { disabled: busy !== '' || !security.unlocked, onClick: () => setConfirmBox({ title: t('rotate'), body: t('rotateHint'), run: () => saveSecurity({ action: 'rotate' }) }) }, t('rotate')),
                  h(Btn, { kind: 'danger', disabled: busy !== '' || !security.unlocked, onClick: () => setConfirmBox({ title: t('disableEnc'), body: t('disableEncConfirm'), danger: true, run: () => saveSecurity({ action: 'disable' }) }) }, t('disableEnc')),
                ),
              ),
          h('div', { className: 'kb-group-title' }, t('usersTitle')),
          h('p', { className: 'kb-help' }, t('rbacHint')),
          h(SwitchRow, { label: t('localRole'), checked: rbacOn, onChange: (checked) => saveUsers({ action: checked ? 'enable' : 'disable', localRole: rbacRole }) }),
          h(SegmentedRow, { label: t('localRole'), value: rbacRole, options: roleOptions, onChange: (value) => { setRbacRole(value); if (rbacOn) void saveUsers({ action: 'enable', localRole: value }) } }),
          rbacOn
            ? h(Fragment, {},
                h('div', { className: 'kb-group-title' }, t('userList')),
                userList.length === 0 ? h('p', { className: 'kb-hint', style: { padding: '8px 0' } }, t('noUsers')) : null,
                userList.map((item) =>
                  h('div', { className: 'kb-field', key: item.id },
                    h('div', { className: 'kb-head' },
                      h('span', { className: 'kb-label' }, item.name),
                      h(Ghost, { onClick: () => { setPassFor(item); setPassValue('') } }, t('setPass')),
                      h(Ghost, { onClick: () => saveUsers({ action: 'update', user: item.id, disabled: !item.disabled }) }, item.disabled ? t('enable') : t('disable')),
                      h(Ghost, { onClick: () => setConfirmBox({ title: t('deleteUser'), body: t('deleteUserConfirm'), danger: true, run: () => saveUsers({ action: 'remove', user: item.id }) }) }, t('deleteUser')),
                    ),
                    h('p', { className: 'kb-hint' }, `${item.role}${item.disabled ? ' · disabled' : ''}${item.hasPassphrase ? ' · passphrase' : ''}`),
                  ),
                ),
                h(FieldRow, { label: t('userName'), value: newUser.name, onChange: (value) => setNewUser({ ...newUser, name: value }) }),
                h(SegmentedRow, { label: t('userRole'), value: newUser.role, options: roleOptions.slice(1), onChange: (value) => setNewUser({ ...newUser, role: value }) }),
                h('div', { className: 'kb-actions' },
                  h(Btn, { disabled: busy !== '' || newUser.name.trim() === '', onClick: () => saveUsers({ action: 'add', name: newUser.name, role: newUser.role }, () => setNewUser({ name: '', role: 'reader' })) }, t('addUser')),
                ),
                h('div', { className: 'kb-group-title' }, t('grants')),
                h('p', { className: 'kb-hint' }, t('grantHint')),
                grantList.length === 0 ? h('p', { className: 'kb-hint', style: { padding: '8px 0' } }, t('noGrants')) : null,
                grantList.map((item) =>
                  h('div', { className: 'kb-field', key: item.id },
                    h('div', { className: 'kb-head' },
                      h('span', { className: 'kb-label' }, `${item.userName ?? item.userId} → ${item.collection}`),
                      h(Ghost, { onClick: () => saveUsers({ action: 'revoke', grantId: item.id, collection: item.collection, user: item.userId }) }, t('revoke')),
                    ),
                    h('p', { className: 'kb-hint' }, String(item.role)),
                  ),
                ),
                h(SelectRow, { label: t('grantUser'), value: grant.user, options: userOptions, onChange: (value) => setGrant({ ...grant, user: value }) }),
                h(FieldRow, { label: t('collection'), value: grant.collection, placeholder: 'notes', onChange: (value) => setGrant({ ...grant, collection: value }) }),
                h(SegmentedRow, { label: t('userRole'), value: grant.role, options: roleOptions.slice(1), onChange: (value) => setGrant({ ...grant, role: value }) }),
                h('div', { className: 'kb-actions' },
                  h(Btn, { disabled: busy !== '' || !grant.user || grant.collection.trim() === '', onClick: () => saveUsers({ action: 'grant', user: grant.user, collection: grant.collection.trim(), role: grant.role }, () => setGrant({ ...grant, collection: '' })) }, t('addGrant')),
                ),
                h('div', { className: 'kb-group-title' }, t('tokens')),
                issued
                  ? h('div', { className: 'kb-field' }, h('span', { className: 'kb-label' }, t('tokenOnce')), h(CopyBox, { text: issued, copyLabel: t('copy'), copiedLabel: t('copied') }))
                  : null,
                h(SelectRow, { label: t('tokenUser'), value: tokenDraft.user, options: userOptions, onChange: (value) => setTokenDraft({ ...tokenDraft, user: value }) }),
                h(FieldRow, { label: t('tokenLabel'), help: t('tokenLabelHint'), value: tokenDraft.label, onChange: (value) => setTokenDraft({ ...tokenDraft, label: value }) }),
                h(NumberRow, { label: t('ttl'), value: tokenDraft.ttlDays, min: 0, max: 3650, onChange: (value) => setTokenDraft({ ...tokenDraft, ttlDays: value }) }),
                h('div', { className: 'kb-field' },
                  h('div', { className: 'kb-head' },
                    h('span', { className: 'kb-label' }, t('scopes')),
                    ['read', 'write', 'manage', 'security'].map((scope) =>
                      h(Btn, {
                        key: scope,
                        small: true,
                        kind: tokenDraft.scopes.includes(scope) ? 'primary' : undefined,
                        onClick: () => setTokenDraft({ ...tokenDraft, scopes: tokenDraft.scopes.includes(scope) ? tokenDraft.scopes.filter((item) => item !== scope) : [...tokenDraft.scopes, scope] }),
                      }, scope),
                    ),
                  ),
                ),
                h('div', { className: 'kb-actions' },
                  h(Btn, {
                    kind: 'primary',
                    disabled: busy !== '' || !tokenDraft.user,
                    onClick: () => run('security', async () => {
                      const value = await post('/tokens', { user: tokenDraft.user, label: tokenDraft.label, scopes: tokenDraft.scopes, ttlDays: tokenDraft.ttlDays })
                      setIssued(value.token ?? '')
                      await loadSecurity()
                    }),
                  }, t('issueToken')),
                ),
                tokenList.length === 0 ? h('p', { className: 'kb-hint', style: { padding: '8px 0' } }, t('noTokens')) : null,
                tokenList.map((item) =>
                  h('div', { className: 'kb-field', key: item.id },
                    h('div', { className: 'kb-head' },
                      h('span', { className: 'kb-label' }, item.label || item.prefix),
                      h(Ghost, { onClick: () => setConfirmBox({ title: t('revoke'), body: t('tokenRevokeConfirm'), danger: true, run: () => run('security', async () => { await post('/tokens', { action: 'revoke', tokenId: item.id }); await loadSecurity() }) }) }, t('revoke')),
                    ),
                    h('p', { className: 'kb-hint' }, `${item.userName ?? item.userId} · ${(item.scopes ?? []).join('/')} · ${item.prefix ?? ''} · ${item.lastUsedAt ? fmt(t('lastUsed'), { time: relTime(item.lastUsedAt) }) : t('neverUsed')}`),
                  ),
                ),
              )
            : null,
        )
      }

      const mcpTab = () => {
        if (!mcpMeta || !mcpForm) return h('div', { className: 'kb-form' }, h('p', { className: 'kb-hint', style: { padding: '12px 0' } }, t('loading')))
        const dirty = mcpInitial ? Object.keys(mcpForm).some((key) => !same(mcpForm[key], mcpInitial[key])) : false
        return h(
          'form',
          { className: 'kb-form', onSubmit: (event) => { event.preventDefault(); void submitMcp() } },
          h('div', { className: 'kb-group-title' }, t('mcpEndpoint')),
          h('p', { className: 'kb-help' }, t('mcpHint')),
          h(ReadonlyRow, { label: t('mcpEndpoint'), value: mcpMeta.url || mcpMeta.path || '/kb-mcp' }),
          h(ReadonlyRow, { label: t('mcpStdio'), value: mcpMeta.stdioEntry ?? 'mcp-stdio.mjs', hint: t('mcpStdioHint') }),
          h('div', { className: 'kb-group-title' }, t('tabMcp')),
          h(CopyBox, { text: JSON.stringify(mcpMeta.stdioConfig ?? {}, null, 2), copyLabel: t('copy'), copiedLabel: t('copied') }),
          h(CopyBox, { text: JSON.stringify(mcpMeta.httpConfig ?? {}, null, 2), copyLabel: t('copy'), copiedLabel: t('copied') }),
          h('div', { className: 'kb-group-title' }, t('mcpPolicy')),
          h(SwitchRow, { label: t('mcpEnabled'), checked: mcpForm.enabled, onChange: (checked) => setMcpForm({ ...mcpForm, enabled: checked }) }),
          h(SwitchRow, { label: t('mcpHttp'), checked: mcpForm.http, onChange: (checked) => setMcpForm({ ...mcpForm, http: checked }) }),
          h(SwitchRow, { label: t('mcpRequireToken'), help: t('mcpRequireTokenHint'), checked: mcpForm.requireToken, onChange: (checked) => setMcpForm({ ...mcpForm, requireToken: checked }) }),
          h(SwitchRow, { label: t('mcpAllowLocal'), help: t('mcpAllowLocalHint'), checked: mcpForm.allowLocalOrigin, onChange: (checked) => setMcpForm({ ...mcpForm, allowLocalOrigin: checked }) }),
          h(SwitchRow, { label: t('mcpAllowWrite'), help: t('allowWriteHint'), checked: mcpForm.allowWrite, onChange: (checked) => setMcpForm({ ...mcpForm, allowWrite: checked }) }),
          h(FieldRow, { label: t('mcpOrigins'), help: t('mcpOriginsHint'), value: mcpForm.allowedOrigins, onChange: (value) => setMcpForm({ ...mcpForm, allowedOrigins: value }) }),
          h(ReadonlyRow, { label: t('mcpTools'), value: (mcpMeta.tools ?? []).join(' · '), hint: mcpMeta.note ?? t('mcpNote') }),
          h('div', { className: 'kb-footer' },
            h('p', { className: `kb-note${flash ? (flash.tone === 'error' ? ' kb-note--error' : ' kb-note--ok') : ''}` }, flash ? flash.message : dirty ? t('dirty') : t('mcpNote')),
            h('button', { type: 'submit', className: 'kb-save', disabled: busy !== '' || !dirty }, busy === 'mcp' ? t('saving') : t('save')),
          ),
        )
      }

      const content =
        tab === 'overview'
          ? overview()
          : tab === 'docs'
            ? docsTab()
            : tab === 'import'
              ? importTab()
              : tab === 'settings'
                ? settingsTab()
                : tab === 'security'
                  ? securityTab()
                  : mcpTab()

      return h(
        'div',
        { className: 'kb-panel' },
        h(Segmented, { value: tab, options: tabOptions, onChange: setTab, label: t('status') }),
        content,
        h(Dialog, { open: Boolean(detail), title: detail?.title ?? '', cancelLabel: t('close'), onClose: () => setDetail(null) },
          detail
            ? h(Fragment, {},
                h('p', { className: 'kb-hint' }, `${detail.collection ?? ''} · ${detail.path ?? ''} · ${detail.totalLines ?? 0} lines`),
                h('pre', { className: 'kb-pre' }, detail.content ?? ''),
              )
            : null),
        h(Dialog, {
          open: Boolean(confirmBox),
          title: confirmBox?.title ?? '',
          danger: confirmBox?.danger,
          busy: busy !== '',
          cancelLabel: t('cancel'),
          confirmLabel: t('confirm'),
          onClose: () => setConfirmBox(null),
          onConfirm: async () => {
            const box = confirmBox
            setConfirmBox(null)
            if (!box) return
            await run('confirm', async () => {
              await box.run()
              await refreshAll()
            })
          },
        }, confirmBox ? h('p', { className: 'kb-help', style: { whiteSpace: 'pre-wrap' } }, confirmBox.body) : null),
        h(Dialog, {
          open: Boolean(passFor),
          title: `${t('setPass')} · ${passFor?.name ?? ''}`,
          busy: busy !== '',
          cancelLabel: t('cancel'),
          confirmLabel: t('save'),
          onClose: () => setPassFor(null),
          onConfirm: async () => {
            const target = passFor
            setPassFor(null)
            await saveUsers({ action: 'passphrase', user: target.id, passphrase: passValue })
          },
        }, h(FieldRow, { label: t('passphrase'), help: t('passphraseHint'), value: passValue, type: 'password', onChange: setPassValue })),
        h(Dialog, {
          open: wipeBox.open,
          title: t('wipeTitle'),
          danger: true,
          busy: busy !== '',
          cancelLabel: t('cancel'),
          confirmLabel: t('confirm'),
          onClose: () => setWipeBox({ open: false, word: '', folder: false }),
          onConfirm: async () => {
            const word = wipeBox.word
            const folderFlag = wipeBox.folder
            setWipeBox({ open: false, word: '', folder: false })
            await run('wipe', async () => {
              const value = await post('/wipe', { confirm: word, removeFolder: folderFlag })
              notice(fmt(t('wipeOk'), { n: value.clearedDocs }), 'ok')
              await refreshAll()
            })
          },
        },
          h('p', { className: 'kb-help' }, t('wipeBody')),
          h(FieldRow, { label: t('wipeWordLabel'), value: wipeBox.word, onChange: (word) => setWipeBox({ ...wipeBox, word }) }),
          h(SwitchRow, { label: t('wipeFolder'), checked: wipeBox.folder, onChange: (folder) => setWipeBox({ ...wipeBox, folder }) }),
        ),
        h('p', { className: 'kb-build' }, `dsh-knowledge-base-local · ${PANEL_BUILD}`),
        footerNote(),
      )
    }

    function apply(ctx) {
      const locale = ctx.get('locale')
      if (typeof locale?.register === 'function') {
        try {
          locale.register(NS, 'zh', DICT.zh)
          locale.register(NS, 'en', DICT.en)
        } catch {
          /* a namespace collision only affects the dictionaries */
        }
      }

      console.log(`[dsh-knowledge-base-local] client half applied · ${PANEL_BUILD}`)
      const label = () => (currentLang(ctx.get('locale')) === 'zh' ? '知识库' : 'Knowledge Base')
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register({ name: 'settings.section', id: 'knowledge-base', order: 30, label }, () => h(Panel, { ctx })),
      )
    }

    return { apply, inject: ['slots'] }
  },
})