# dsh-knowledge-base-local

简体中文 | [English](README.md)

一个 DeepSeek Harness（DSH）的本地、任何模型都能读的知识库插件。所有内容以纯 Markdown 存储，可以用任意编辑器打开；提供三条互不依赖的入口——Agent 工具、命令行、Web 设置面板——外加 PDF/Office 正文抽取、面向外部客户端的 MCP 服务、静态 AES-256-GCM 加密，以及基于角色的多用户访问控制。

三个设计目标：

1. **位置完全自定义** —— 任意绝对路径，随时可改。
2. **任何模型都能读** —— Markdown 就是数据本身，没有锁定。
3. **什么都能存** —— 文本、Markdown、代码、网页、任意二进制附件；自动切块并向量化。

> 零运行时依赖：只用 Node 内置模块，安装不需要编译。

---

## 目录

- [dsh-knowledge-base-local](#dsh-knowledge-base-local)
  - [目录](#目录)
  - [安装](#安装)
  - [快速开始](#快速开始)
  - [功能](#功能)
  - [Agent 工具](#agent-工具)
  - [命令行](#命令行)
  - [PDF / Office 抽取](#pdf--office-抽取)
  - [MCP 服务](#mcp-服务)
  - [加密与多用户](#加密与多用户)
  - [批量与一键删除](#批量与一键删除)
  - [Web 面板](#web-面板)
  - [存储结构](#存储结构)
  - [配置项](#配置项)
  - [向量模式](#向量模式)
  - [检索打分](#检索打分)
  - [安全模型](#安全模型)
  - [已知限制](#已知限制)
  - [开发与测试](#开发与测试)
  - [卸载](#卸载)
  - [许可证](#许可证)

---

## 安装

需要 Node.js ≥ 22 与运行中的 DeepSeek Harness。

```
dsh plugin --profile web add dsh-knowledge-base-local
```

## 快速开始

1. 打开 **设置 → 知识库**，选一个目录；或告诉 Agent："把知识库设在 /path/to/knowledge"。
2. 或用命令行：

   ```
   node kb.mjs config --root /path/to/knowledge
   ```

选定的根目录和全部偏好都写在按用户存放的数据目录（默认 `~/.dsh`）下：

```
<DSH_HOME>/knowledge-base/settings.json
```

该文件与当前工作区、profile 都无关，所以换项目不会丢，知识库跟着你走。

## 功能

- **Markdown 为真源** —— 每篇文档就是 `docs/<id>.md`，带 frontmatter；生成的 `CATALOG.md` 是给人和模型的目录。
- **六件 Agent 工具** —— `kb_search`、`kb_read`、`kb_list`、`kb_add`、`kb_import`、`kb_manage`。
- **混合检索** —— BM25 词法分 + 向量余弦分 + 标题/子串加成；结果带文档 id、行号与片段。
- **三档向量** —— `local`（离线 TF-IDF 特征哈希）、`llm`（模型增强 + 本地向量）、`api`（OpenAI 兼容 embeddings，失败自动退回 local）。
- **集合与标签** —— 多知识库命名空间；检索可限定范围。
- **回收站与版本** —— 删除是软删除（可恢复）；每次修改留一版（默认 20 版）。
- **inbox 监听** —— 丢进 `<root>/inbox/` 的文件自动入库，改动自动更新（含 PDF/Office）。
- **URL 导入** —— 抓取网页可读正文（优先走 Harness 的 `web` 服务）。
- **PDF / Office 正文抽取** —— `.pdf` `.docx` `.xlsx` `.pptx`，零依赖。[详见](#pdf--office-抽取)。
- **MCP 服务** —— 通过 stdio 或 Streamable HTTP 把知识库开放给 Claude Desktop、Cursor 等客户端。[详见](#mcp-服务)。
- **静态加密** —— 逐篇 AES-256-GCM；口令只通过 scrypt 派生的 KEK 包裹一个随机数据密钥。[详见](#加密与多用户)。
- **多用户访问** —— `owner > admin > editor > reader`，可按集合收紧，并签发只存 SHA-256 摘要的 API 令牌。默认关闭（单人使用）。[详见](#加密与多用户)。

## Agent 工具

| 工具 | 作用 |
| --- | --- |
| `kb_search` | 混合检索；支持 `collection`、`tags`、`limit`、`mode` |
| `kb_read` | 读全文，或按行范围 / 分块读 |
| `kb_list` | 浏览文档、集合与统计 |
| `kb_add` | 存文本 / 本地文件 / URL；自动去重 |
| `kb_import` | 递归导入目录或单个文件/网页（含 PDF/Office 抽取） |
| `kb_manage` | status / configure / collection / update / delete / restore / purge / reindex / scan / export，**以及**安全动作：`security_status`、`enable_encryption`、`disable_encryption`、`unlock`、`lock`、`change_passphrase`、`rotate_key`、`set_metadata_encryption`、`reencrypt`、`rbac_enable`、`rbac_disable`、`user_*`、`grant`、`revoke`、`token_issue`、`token_revoke`、`mcp_info`、`bulk_delete`、`empty_trash`、`wipe` |

模型每一轮都会看到一段简短的系统提示，含根目录、规模、集合与用法；库内容变化后自动刷新。**你不需要在对话里贴路径。**

> **口令隐私。** 通过 Agent 输入的口令会进入会话记录。请优先在 Web 面板（设置 → 知识库 → 安全）输入口令；`kb_manage` 的 `passphrase` 参数是便捷路径，不是隐私路径。

## 命令行

可在包内任意位置运行（或用安装后的 `dsh-kb` 命令）：

```
node kb.mjs status
node kb.mjs search "混合检索" --limit 5
node kb.mjs read <id> --offset 1 --limit 120
node kb.mjs add --title "标题" --text "正文" --collection notes --tags a,b
node kb.mjs add --file /path/notes/todo.md
node kb.mjs import /path/Notes --collection notes
node kb.mjs import /path/Papers/report.pdf --collection papers   # 自动抽取正文
node kb.mjs reindex --full
node kb.mjs export --format md
node kb.mjs security          # 加密 / 多用户状态与磁盘密文覆盖
node kb.mjs unlock            # 读取 DSH_KB_PASSPHRASE 或 --passphrase
node kb.mjs lock
node kb.mjs users             # 用户、集合授权、令牌
node kb.mjs mcp               # 外部 MCP 客户端接入方式
node kb.mjs --json status     # 机器可读输出
```

全局参数：`--root <目录>`（临时覆盖）、`--json`。`kb.mjs` 与插件共用同一套 `src/`，不依赖运行中的 Harness。库处于加密锁定态时，命令会明确报"已锁定"而不是吐出乱码——先解锁（`node kb.mjs unlock` 或设 `DSH_KB_PASSPHRASE`）。

## PDF / Office 抽取

判定按魔数优先、扩展名其次。一切都能优雅降级——解析不了的文件会作为附件保留并记录原因，绝不会静默丢内容。

| 格式 | 支持内容 | 失败时 |
| --- | --- | --- |
| `.pdf` | 对象 + xref（含对象流）、`FlateDecode`、内容流算子 `Tj/TJ '/"/T*/Td/Tm`、简单字体（Standard/WinAnsi + `/Differences`）、Type0/CID + `/ToUnicode`（中文）、`/Info` 标题、页数 | 扫描图像 / 加密 → 附件 + 占位正文 + 原因 |
| `.docx` | 段落、标题层级、列表、表格、分节、`docProps` 标题 | 部件缺失 → 报错 + 保留附件 |
| `.xlsx` | 多 sheet、共享字符串（含富文本多段）、内联字符串；公式不求值 | 空表跳过 |
| `.pptx` | 每页标题 / 正文 / 备注，按页码排序 | 无 slide 部件 → 判定无效 |
| `.doc/.xls/.ppt` | 旧式 OLE **不解析** | 明确提示"另存为 docx/xlsx/pptx"，保留附件 |

抽取结果记录在每篇文档的 `extract` 字段（`kind`、`pages`、`warnings`、失败原因），面板与 `kb_list` 都会显示；正文头部加一行 `> 抽取自 report.pdf（pdf · 12 页）` 以便溯源。体积上限是 `import.maxFileBytes`（默认 8 MiB）。

## MCP 服务

```bash
# stdio（Claude Desktop / Cursor / Cherry Studio…），不需要 Harness 在跑：
node mcp-stdio.mjs
node mcp-stdio.mjs --root /path/to/knowledge --readonly
node mcp-stdio.mjs --help

# 独立 Streamable HTTP：
node mcp-stdio.mjs --http 8765 --token kb_…

# Harness 进程内端点（与 Web GUI 同源）：
POST http://127.0.0.1:<gui-port>/kb-mcp
```

客户端配置（stdio）：

```json
{ "mcpServers": { "knowledge-base": {
  "command": "node",
  "args": ["/absolute/path/to/dsh-knowledge-base-local/mcp-stdio.mjs"]
} } }
```

客户端配置（HTTP，令牌在 设置 → 知识库 → 安全 签发）：

```json
{ "mcpServers": { "knowledge-base-http": {
  "type": "streamable-http",
  "url": "http://127.0.0.1:8765/mcp",
  "headers": { "Authorization": "Bearer kb_…" }
} } }
```

- 工具名称、描述、参数与 Agent 侧完全一致；结果同时给出 `content[].text`（给人和模型）与 `structuredContent`（给程序）。
- 每个外部连接都以真实用户身份鉴权：为每个客户端签发令牌后，其角色与集合授权自动生效（只读令牌调 `kb_add` 会被 `ForbiddenError` 拒绝）。
- `--readonly` 只暴露 `kb_search` / `kb_read` / `kb_list` 与收紧后的 `kb_manage`（仅 `status` / `trash`）。
- 独立进程里 `kb_manage configure` 只改内存、**不会**写你的 `settings.json`；改根目录还需 `--allow-set-root`，防止远程客户端把库指向任意目录。
- 未实现（诚实清单）：SSE / `GET` 通知流、`listChanged`、进度与取消、服务端主动请求（roots/sampling/elicitation）、分页 cursor、把附件作为 MCP 资源暴露；会话 id 仅存内存。

## 加密与多用户

面板路径：**设置 → 知识库 → 安全**（每步都有二次确认）。

1. **开启加密** —— 设口令（≥ 8 位）；逐篇封装正文、索引、版本与清单。可选连元数据（标题/标签/摘要）一起加密。
2. **锁定 / 解锁** —— 锁定会清除内存密钥；解锁需口令，或设 `DSH_KB_PASSPHRASE` 自动解锁。
3. **更换口令** —— 只重新包裹数据密钥（秒级，不动语料）。**轮换数据密钥**才会全量重加密。
4. **关闭加密** —— 全部解密回明文 Markdown 并删除本地密钥文件。
5. **多用户** —— 开启 RBAC、设本机角色（默认 `owner`）、新建用户、按集合收紧角色、签发/吊销 `kb_…` API 令牌（存 SHA-256 摘要，明文只显示一次）。

两个开关都关闭时，代码路径与单人版本完全一致：不生成 `secure/`，不改写任何文件，`kb_*` 行为不变。

## 批量与一键删除

三级删除，权限逐级收紧，加密锁定态一律拒绝：

| 操作 | 语义 | 权限 | 可恢复 |
| --- | --- | --- | --- |
| 删除（单篇） | 一篇文档移入回收站 | `delete`（editor 起）+ 按集合 + **归属**（editor 只能删自己创建的；admin 及以上不限） | 是 |
| `bulkRemove` 批量 | 按 `ids`/`collection`/`tag`/`query` 命中的一批移入回收站；逐项走同样判定，删不动的进 `skipped` 带原因 | 同上 | 是 |
| `emptyTrash` 清空回收站 | 彻底删除回收站条目 | `delete`；editor 只清自己创建的 | 否 |
| `wipe` 一键清空 | 删除全部文档、回收站、索引、版本、附件、导出 | **`security`（owner）** + 输入确认词 `WIPE` | 否 |

入口：面板的**危险操作**（文档页）、`kb_manage`（`bulk_delete` / `empty_trash` / `wipe`）、`POST /kb-api/bulk-remove|empty-trash|wipe`，以及 `node kb.mjs bulk-delete / empty-trash / wipe --confirm WIPE [--remove-folder]`。`wipe` 默认**保留根目录与配置**；`--remove-folder` 才会连本地目录一起删并清空根路径（不可逆）。

## Web 面板

设置 → 知识库，页签为 **概览 / 文档 / 导入 / 设置 / 安全 / MCP**。

- **概览** —— 状态行（根目录、规模、向量模式、加密、用户）、锁定横幅带内联解锁、快速检索、重建索引/扫描/导出。
- **文档** —— 按集合/标签/关键词筛选、分页、打开、删除；回收站恢复/彻底删除；危险操作区（批量删除、清空回收站、一键清空）。
- **导入** —— 拖拽上传（PDF/Office/文本，逐文件显示抽取结果）、目录导入（含原生目录选择器）、粘贴文本。
- **设置** —— 根目录更换（选择器/手填）、向量模式、分块参数、默认集合、LLM、embeddings、inbox 监听、是否允许写入；脏检查保存。
- **安全** —— 完整加密生命周期与 RBAC（用户、集合授权、令牌）。
- **MCP** —— 端点状态、可复制的 stdio/HTTP 配置、接入策略开关。

破坏性动作都走二次确认弹窗（`Esc` 或点遮罩取消）。面板通过同源 `/kb-api` 访问 Host；跨域必须带 `Authorization: Bearer <token>`（否则 403）。改完面板代码需刷新页面（除非运行着 Harness 的 web 开发服务器，否则没有客户端 HMR）。

## 存储结构

```
<root>/
  kb.json                 # 集合与文档元数据（插件维护）
  CATALOG.md              # 人 / 模型可读的目录
  README.md               # 生成的说明
  docs/<id>.md            # 正文（frontmatter + Markdown）
  files/<id>/<name>       # 原始附件（任意二进制）
  index/<id>.json         # 分块、词频、向量（base64 Float32）
  index/stats.json        # DF / 平均长度，供 BM25 与 IDF
  versions/<id>/*.md      # 历史版本
  trash/<id>/             # 软删除
  inbox/                  # 丢入即入库
  exports/                # `export` 输出
  secure/key.json         # 仅加密时存在：被 KEK 包裹的数据密钥 + salt + 指纹
  secure/users.json       # 仅开启 RBAC 时存在：用户、集合授权、令牌摘要
```

手工编辑 `docs/*.md` 也可：调用 `kb_manage {action:"scan"}`（或 `node kb.mjs scan`）采纳并重索引。

## 配置项

写在 `<DSH_HOME>/knowledge-base/settings.json`；profile 内 `cordis.patch.yml` 那一行的非空 `config` 会覆盖它。

```json
{
  "rootDir": "/path/to/knowledge",
  "vectorMode": "local",
  "chunkSize": 1200,
  "chunkOverlap": 160,
  "vectorDim": 1024,
  "defaultCollection": "default",
  "search": { "vectorWeight": 0.55, "lexicalWeight": 0.45, "maxResults": 8, "snippetChars": 420 },
  "llm": { "provider": "", "model": "", "maxChars": 12000, "temperature": 0.1, "timeoutMs": 120000 },
  "embedding": { "endpoint": "", "model": "", "apiKey": "", "dimensions": 0, "batchSize": 32, "timeoutMs": 60000 },
  "watch": { "enabled": true, "dir": "inbox", "debounceMs": 1500 },
  "versions": { "keep": 20 },
  "import": { "maxFileBytes": 8388608, "maxDocsPerRun": 500, "copyFiles": true },
  "tools": { "allowWrite": true },
  "security": { "metadata": "plain", "autoUnlockEnv": true, "rbac": { "enabled": false, "localRole": "owner" } },
  "mcp": { "enabled": true, "http": true, "requireToken": true, "allowLocalOrigin": true, "allowedOrigins": [], "allowWrite": true, "maxTextChars": 60000 }
}
```

`security` 与 `mcp` 默认保守：加密与多用户**默认关闭**；Harness 内 MCP 端点已挂载但**要求令牌**（同源网页除外）。

## 向量模式

- **`local`**（默认）—— NFKC → 小写；CJK 生成二元组，拉丁词/数字去停用词；FNV-1a 特征哈希到有符号的 1024 维（可配）向量；`1+log(tf)` × IDF；L2 归一化。离线、确定性。**是词法而非神经**——同义改写召回有限。
- **`llm`** —— 每篇文档调用一次模型，产出 `summary/keywords/questions/entities`；把这份语义画像拼进每个分块的向量文本再用 local 编码。任何失败（无 `llm` 服务、无 key、超时、JSON 解析失败）都自动退回 `local` 并记录原因。
- **`api`** —— `POST <endpoint>/embeddings`（OpenAI 兼容）；可配 `model`、可选 `apiKey`、`dimensions`、`batchSize`。Key 也可用环境变量 `DSH_KB_EMBEDDING_API_KEY`。失败自动退回 `local`。

改模式或分块参数后，执行一次全量重建：`kb_manage {action:"reindex", full:true}`（或 `node kb.mjs reindex --full`）。

## 检索打分

`score = vectorWeight × cos(向量) + lexicalWeight × BM25/(BM25+6) + 标题/子串加成`

- 权重默认 0.55 / 0.45（`search.vectorWeight` / `search.lexicalWeight`）。
- 每篇最多返回 2 个分块，结果按文档去重。
- 返回 `docId`、`path`、`lineStart`/`lineEnd`、`chunk`、`snippet`、`score`、`semantic`、`lexical`，可直接引用。

## 安全模型

- 写入默认开启；可在面板（设置 → 高级 → 允许写入类工具）或 `tools.allowWrite: false` 关闭。
- 删除是软删除（`trash/`）；只有 `purge` 才是永久。
- 所有写入限制在根目录内；`kb_read` 只接受库内 id/路径。
- `/kb-api` 默认仅同源可用，跨域需 Bearer 令牌。`/kb-mcp` 同源网页按本机角色执行，外部进程需令牌。
- 口令、API Key 永不出现在 `CATALOG.md`、`kb.json` 或索引里；令牌只存 SHA-256 摘要、明文只显示一次。
- 锁定态的库拒绝读写，而不是返回密文。

## 已知限制

- `local` 向量是词法哈希，不是语义向量；需要语义/改写召回时用 `llm` 或 `api`。
- `api` 模式下查询也要调一次 embeddings；端点不可用时当次检索退化为词法并给 warning。
- 切块以段落/句子为边界；超长无标点文本会按字符硬切。
- 版本只保留正文，不保留附件历史。
- 面板内不提供全文编辑器（更新走 `kb_manage update`，或直接改 `docs/*.md` 后 `scan`）。
- 扫描件 PDF 需 OCR（不在范围内），旧式 `.doc/.xls/.ppt` 不解析。
- 加密**不提供找回**：口令丢失 = 语料永久不可读；请先在一个可丢弃的小目录试一遍完整流程。
- 元数据默认明文（标题、标签、摘要、文件名、`CATALOG.md`）；开启元数据加密可隐藏，代价是 `kb_list` 之外的直接浏览不可读。
- RBAC 是同机多身份的权限层，不是租户隔离；跨信任边界请用独立根目录与系统账户。

## 开发与测试

```
npm test          # 七组：smoke、extract、integration、panel-api、danger-ops、host-mcp-mount、mcp
npm run lint:css  # 静态检查面板 CSS 只用真实主题令牌、无字面色值
```

所有测试都在一次性的临时知识库与临时 `DSH_HOME` 里跑，绝不读写任何真实知识库或 profile 状态。开发辅助脚本在 `tools/`（CSS 拼接器、CSS/令牌审计器、以及面板读取的手写样式表）。上报漏洞前请先读 [SECURITY.zh.md](SECURITY.zh.md)。

## 卸载

```
plugin_manager remove_bundle dsh-knowledge-base-local
```

你的知识库目录与 `<DSH_HOME>/knowledge-base/settings.json` 不会被删除，需要的话自行清理。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
