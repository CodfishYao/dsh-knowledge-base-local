# 更新日志

**dsh-knowledge-base-local** 的所有重要变更都记录在此�?格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)�?
简体中�?| [English](CHANGELOG.md)

## [未发布]

## [1.2.0] - 2026-10-17

### 新增
- 批量删除（`bulkRemove`）、清空回收站（`emptyTrash`）与一键清空（`wipe`），全部按权限分级：批量�?delete �?+ 按集�?+ 归属；一键清空需 `security`（owner�? 输入确认�?`WIPE`；加密锁定态一律拒绝�?- 面板"文档"页新�?*危险操作**区；对应新增 `kb_manage` action、`/kb-api` 路由�?`kb.mjs` 命令�?- `dsh-kb` 命令�?bin、`prepublishOnly` 测试闸、CSS 令牌/校验辅助脚本�?- 中英双语文档（`README.md` / `README.zh.md`）、`SECURITY.md` / `SECURITY.zh.md`、本更新日志、`LICENSE`、`.gitignore`�?
### 变更
- 面板重写为扁平、由主题令牌驱动的表单（分段控件、发丝分隔的行、elevation 表面），明暗两套都跟随壳的调色板�?*不含任何字面色�?*�?- 语言改为跟随壳的当前 locale（`LocaleSnapshot.active`）而非浏览器语言；切换语言时面板会重新渲染�?
## [1.1.0] - 2026-10-17

### 新增
- PDF / Office 正文抽取（`.pdf`、`.docx`、`.xlsx`、`.pptx`），零依赖，保留原始附件并记录抽取状态�?- 面向外部客户端的 MCP 服务（stdio �?Streamable HTTP）；工具�?Agent 侧逐字一致，按令牌鉴权走 RBAC�?- 静态加密（逐篇 AES-256-GCM，scrypt 包裹的数据密钥）与基于角色的多用户访问（`owner/admin/editor/reader`），含集合授权与 API 令牌——两�?*默认关闭**�?- 供面板使用的浏览器上传与目录导入路由�?
## [1.0.0]

### 新增
- Markdown 为源的本地库、六�?Agent 工具、独�?CLI、Web 设置面板、BM25 + 向量混合检索、三档向量模式、集合、标签、回收站、版本、inbox 监听�?URL 导入�?
[未发布]: https://github.com/CodfishYao/dsh-knowledge-base-local/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/CodfishYao/dsh-knowledge-base-local/releases/tag/v1.2.0
[1.1.0]: https://github.com/CodfishYao/dsh-knowledge-base-local/releases/tag/v1.1.0
[1.0.0]: https://github.com/CodfishYao/dsh-knowledge-base-local/releases/tag/v1.0.0
