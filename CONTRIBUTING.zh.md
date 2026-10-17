# 贡献指南

简体中文 | [English](CONTRIBUTING.md)

感谢你有兴趣改进 **dsh-knowledge-base-local**！本指南说明如何构建、测试与提交改动。

## 这个插件是怎么构成的

它是一个 Cordis / **DeepSeek Harness** 插件包：Node.js ES 模块，**零运行时依赖**（只用 Node 内置模块），注册三部分：

- **Host 半区**（`index.js` + `src/`）：`KnowledgeStore`、六件 `kb_*` Agent 工具、同源 `/kb-api` HTTP 面、挂载的 `/kb-mcp` MCP 端点、inbox 监听器与一段系统提示。
- **Client 半区**（`client.js`）：注入到 Harness 外壳的 Web 设置面板。面板用不带 JSX 的 React（`React.createElement`），配色只取外壳的 `--dsw-*` 主题令牌，通过 `/kb-api` 与 Host 通信。
- **独立 CLI**（`kb.mjs`）与**独立 MCP 服务**（`mcp-stdio.mjs`），复用同一套 `src/`。

## 前置要求

- Node.js **≥ 22**（用到 `node:crypto` 的 scrypt/GCM、`node:fs` promises 等）。
- 运行代码**不需要 `npm install`**——零依赖。只有想要 `npm test` 的脚本便利时才装开发工具。

## 本地跑起来

让某个 DeepSeek Harness profile 指向本仓库（而不是/或叠加 npm 包）：

```
# 在 Harness 宿主里，通过 plugin_manager 工具或 profile patch：
install_bundle /absolute/path/to/dsh-knowledge-base-local
```

然后打开 **设置 → 知识库**，选个目录，试工具即可。因为是本地 `link:` 安装，改 `src/` 会在下次插件重载时生效（重新启用该插件行，或重启宿主）；改面板代码需要**刷新页面**才生效。

## 开发循环

```
npm test              # 7 组，几秒跑完：smoke、extract、integration、
                      #   panel-api、danger-ops、host-mcp-mount、mcp
npm run lint:css      # 面板样式守卫
```

所有测试都在一次性的临时知识库与临时 `DSH_HOME` 里跑，**绝不读写任何真实知识库或 profile 状态**。加功能时，请在 `test/` 里补/扩测试，并保持七组全绿。

### CSS / 样式守卫

设置面板必须只用外壳声明的主题令牌、不得硬编码颜色。`tools/audit-css.mjs` 强制：

- 无字面色值（`#hex`、`rgb()/rgba()/hsl()`）；
- 每个 `--dsw-*` 引用要么存在于外壳令牌表，要么带兜底值；
- 胶囊/正圆半径必须配对 `corner-shape: round`（外壳对全局施加超级椭圆）；
- JSX 里用到的每个 class 在样式表里都有定义，且花括号/分号配平。

它从同级检出目录读外壳令牌表（默认 `../dsh-client/ui-theme/src/styles`，可用 `--tokens <目录>` 指定），找不到时会优雅降级。面板样式表手写在 `tools/panel.css`，由 `tools/splice-css.mjs` 拼进 `client.js`；改 `panel.css` 后重新拼接，再跑 `npm run lint:css`。

## 代码约定

- **ES 模块**、**不写分号**、**单引号**、两空格缩进——与现有文件保持一致。
- 代码注释用**英文**；面向用户的文案是**双语**，放在字典里（面板的 `DICT` 含 `zh`/`en`；插件展示元数据用 `locale/*.json`）。`zh` 与 `en` 键集必须完全一致——`npm test` 与 i18n 检查都依赖这点。
- Host、CLI、面板、HTTP API 与 MCP 都调用**同一套** `src/store.js` 方法，所以行为与**权限**永不分叉。请保持：业务逻辑放 store，不放传输层。
- **权限不是可选项。** 任何新写入都要经 `store.authorize(input, action, collection)` / `assertOwnership(...)`，用对动作权限底（`read`/`write`/`delete`/`manage`/`security`），并在锁定时拒绝。破坏性路径要输入确认词（见 `wipe`）。
- 绝不记录或持久化口令 / API Key；令牌以 SHA-256 摘要存储、明文只显示一次。威胁模型见 [SECURITY.zh.md](SECURITY.zh.md)。

## 提交改动

1. 从 `main` 派生分支并新建分支（分支名如 `feat/…`、`fix/…`）。
2. 提交保持聚焦；用平实的祈使句写 commit message。
3. 跑 `npm test` 与 `npm run lint:css`，两者都必须通过。
4. 任何用户可见的改动都更新 `CHANGELOG.zh.md`（和 `CHANGELOG.md`）的 **未发布** 段。
5. 开 Pull Request：写清*改了什么*与*为什么*，关联 issue，若改了面板 UI 请附改动前后截图。

## AI 工具署名

本项目在 AI 辅助下开发。本代码库用到的工具包括：

- **DeepSeek Harness** —— 本插件所接入的 Agent 运行时、Web GUI 与插件宿主，用于其编码 Agent、工具调用与应用内检视；以及
- **Qwen** —— 用于代码生成、审阅与文档起草的大模型。

若你在贡献中使用了 AI 工具，请在 PR 描述里说明（哪个模型/工具、生成了什么），以便审阅者重点核查。生成的代码仍要与手写代码通过同样的测试、风格与安全标准——你要为自己提交的内容负责。

## 安全问题

**不要**开公开 issue。见 [SECURITY.zh.md](SECURITY.zh.md)，通过 GitHub 安全公告私下报告。

## 许可证

提交贡献即表示你同意你的贡献以项目的 [MIT 许可证](LICENSE) 授权。
