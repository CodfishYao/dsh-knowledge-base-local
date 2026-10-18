# 更新日志

**dsh-knowledge-base-local** 的所有重要变更都记录在此。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

简体中文 | [English](CHANGELOG.md)

## [未发布]

## [1.2.3] - 2026-10-18

### 修复
- PDF 解析器：修正 ObjStm 压缩对象提取逻辑（索引偏移和空白处理），解决 PDF 1.5+ 文件解析失败问题。
- Embedding API：添加指数退避重试机制（最多 3 次，支持 `Retry-After` 响应头），处理 HTTP 429/5xx 响应。

### 变更
- `embedding.batchSize` 默认值从 32 调整为 10，兼容 DashScope API 网关限制（上限 20）。

## [1.2.2] - 2026-10-18

### 修复
- DashScope 原生 embedding API：修正请求格式（`input.texts` 替代 `input.contents`）和端点路径（`/api/v1/services/embeddings/text-embedding/text-embedding`）。
- Embedding 格式检测逻辑：端点位于 `/api/v1` 下或模型名包含 `text-embedding` 时按 DashScope 处理；OpenAI 兼容端点保持 `{"input": [...]}` 格式。
- `bin` 字段重写为 npm 接受的格式（`kb.mjs`），防止发布时被自动移除。

## [1.2.1] - 2026-10-18

### 修复
- DashScope embedding 支持的首次实现（请求/响应格式）。由 1.2.2 取代，修正字段名和端点路径。

## [1.2.0] - 2026-10-17

### 新增
- 批量删除（`bulkRemove`）、清空回收站（`emptyTrash`）、一键清空（`wipe`）操作，按权限分级控制：批量操作需 delete 权限、集合范围和所属关系；一键清空需 security（owner）角色和输入 `WIPE` 确认词。所有操作在库锁定时被拒绝。
- 面板"文档"页新增**危险操作**区，对应 `kb_manage` action、`/kb-api` 路由和 `kb.mjs` 命令。
- `dsh-kb` CLI 二进制文件和 `prepublishOnly` 测试钩子。
- 中英双语文档（`README.md` / `README.zh.md`）、`SECURITY.md` / `SECURITY.zh.md`、`CONTRIBUTING.md` / `CONTRIBUTING.zh.md`、本更新日志、`LICENSE`、`.gitignore`。

### 变更
- 包名改为 `dsh-knowledge-base-local`（原私有 `@local/dsh-knowledge-base`）；插件 id、loader id 和 i18n 命名空间同步更新。
- 面板 UI 重写为扁平、主题令牌驱动的设置表单（分段控件、发丝分隔行、基于层级的表面），遵循壳调色板；无字面颜色。
- 语言跟踪改为跟随壳的当前 locale（`LocaleSnapshot.active`），而非浏览器语言；切换语言时面板重新渲染。
- 文档和示例不再引用私有绝对路径；配置路径以可移植的 `~/.dsh/...` 表述。

## [1.1.0] - 2026-10-17

### 新增
- PDF / Office 正文抽取（`.pdf`、`.docx`、`.xlsx`、`.pptx`），零依赖；保留原始附件并记录抽取状态。
- 面向外部客户端的 MCP 服务（stdio 和 Streamable HTTP）；工具与 Agent 侧实现完全一致，按令牌驱动 RBAC。
- 静态加密（逐篇 AES-256-GCM；scrypt 包裹的数据密钥）和基于角色的多用户访问（`owner/admin/editor/reader`），含集合授权和 API 令牌。两项功能**默认关闭**。
- 面板的浏览器上传和目录导入路由。

## [1.0.0]

### 新增
- Markdown 为源的本地库、六件 Agent 工具、独立 CLI、Web 设置面板、BM25 + 向量混合检索、三档向量模式、集合、标签、回收站、版本、inbox 监听和 URL 导入。

[1.2.3]: https://github.com/CodfishYao/dsh-knowledge-base-local/releases/tag/v1.2.3
[1.2.0]: https://github.com/CodfishYao/dsh-knowledge-base-local/releases/tag/v1.2.0
