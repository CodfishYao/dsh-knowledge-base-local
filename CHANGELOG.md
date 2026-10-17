# Changelog

All notable changes to **dsh-knowledge-base-local** are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

[简体中文](CHANGELOG.zh.md) | English

## [Unreleased]

## [1.2.2] - 2026-10-18

### Fixed
- DashScope native embedding API: send `input.texts` (not `input.contents`) and call the real route `/api/v1/services/embeddings/text-embedding/text-embedding`, which is what `text-embedding-*` models accept. The previous shape made every call fail with `InvalidParameter: Field required: input.contents`.
- Detection no longer depends on the hostname alone: an endpoint under `/api/v1` or a model name containing `text-embedding` is treated as DashScope, while OpenAI-compatible endpoints keep the `{"input": [...]}` shape.
- `bin` entry rewritten to the form npm accepts (`kb.mjs`), so `dsh-kb` survives publishing instead of being auto-removed.

## [1.2.1] - 2026-10-18

### Fixed
- First attempt at DashScope embedding support (request/response shape); superseded by 1.2.2, which corrects the field name and the endpoint path.

## [1.2.0] - 2026-10-17

### Added
- Bulk delete (`bulkRemove`), empty-trash (`emptyTrash`) and full wipe (`wipe`), all permission-gated (delete floor + per-collection + ownership for bulk; `security`/owner + a typed `WIPE` confirmation for wipe) and refused while the library is locked.
- A **Danger zone** in the panel Documents tab; matching `kb_manage` actions, `/kb-api` routes and `kb.mjs` commands.
- `dsh-kb` CLI bin and `prepublishOnly` test gate; CSS token/lint helper.
- Bilingual documentation (`README.md` / `README.zh.md`), `SECURITY.md` / `SECURITY.zh.md`, `CONTRIBUTING.md` / `CONTRIBUTING.zh.md`, this changelog, `LICENSE`, `.gitignore`.

### Changed
- Package renamed to `dsh-knowledge-base-local` (was the private `@local/dsh-knowledge-base`); plugin id, loader id and locale namespace follow.
- Panel rewritten as a flat, theme-token-driven settings form (segmented control, hairline field rows, elevation-based surfaces) so light and dark both follow the shell palette; no literal colours.
- Language now tracks the shell's active locale (`LocaleSnapshot.active`), not the browser language; the panel re-renders on locale change.
- Examples and docs no longer reference private absolute paths; the settings path is documented portably as `~/.dsh/...`.

## [1.1.0] - 2026-10-17

### Added
- PDF / Office body extraction (`.pdf`, `.docx`, `.xlsx`, `.pptx`), zero dependencies, attached-original kept and extraction status recorded.
- MCP server for external clients over stdio and Streamable HTTP; tools mirror the agent side exactly, with token-driven RBAC.
- At-rest encryption (AES-256-GCM per document; scrypt-wrapped data key) and role-based multi-user access (`owner/admin/editor/reader`) with per-collection grants and API tokens — both **off by default**.
- Browser upload and folder-import routes for the panel.

## [1.0.0]

### Added
- Markdown-first local store, six agent tools, standalone CLI, Web settings panel, hybrid BM25 + vector retrieval, three vector modes, collections, tags, trash, versions, inbox watcher and URL import.

[Unreleased]: https://github.com/CodfishYao/dsh-knowledge-base-local/compare/v1.2.2...HEAD
[1.2.2]: https://github.com/CodfishYao/dsh-knowledge-base-local/releases/tag/v1.2.2
[1.2.1]: https://github.com/CodfishYao/dsh-knowledge-base-local/releases/tag/v1.2.1
[1.2.0]: https://github.com/CodfishYao/dsh-knowledge-base-local/releases/tag/v1.2.0
[1.1.0]: https://github.com/CodfishYao/dsh-knowledge-base-local/releases/tag/v1.1.0
[1.0.0]: https://github.com/CodfishYao/dsh-knowledge-base-local/releases/tag/v1.0.0
