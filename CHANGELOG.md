# Changelog

All notable changes to **dsh-knowledge-base-local** are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

[简体中文](CHANGELOG.zh.md) | English

## [Unreleased]

## [1.2.0] - 2026-10-17

### Added
- Bulk delete (`bulkRemove`), empty-trash (`emptyTrash`) and full wipe (`wipe`), all permission-gated (delete floor + per-collection + ownership for bulk; `security`/owner + a typed `WIPE` confirmation for wipe) and refused while the library is locked.
- A **Danger zone** in the panel Documents tab; matching `kb_manage` actions, `/kb-api` routes and `kb.mjs` commands.
- `dsh-kb` CLI bin and `prepublishOnly` test gate; CSS token/lint helper.
- Bilingual documentation (`README.md` / `README.zh.md`), `SECURITY.md` / `SECURITY.zh.md`, this changelog, `LICENSE`, `.gitignore`.

### Changed
- Panel rewritten as a flat, theme-token-driven settings form (segmented control, hairline field rows, elevation-based surfaces) so light and dark both follow the shell palette; no literal colours.
- Language now tracks the shell's active locale (`LocaleSnapshot.active`), not the browser language; the panel re-renders on locale change.

## [1.1.0] - 2026-10-17

### Added
- PDF / Office body extraction (`.pdf`, `.docx`, `.xlsx`, `.pptx`), zero dependencies, attached-original kept and extraction status recorded.
- MCP server for external clients over stdio and Streamable HTTP; tools mirror the agent side exactly, with token-driven RBAC.
- At-rest encryption (AES-256-GCM per document; scrypt-wrapped data key) and role-based multi-user access (`owner/admin/editor/reader`) with per-collection grants and API tokens — both **off by default**.
- Browser upload and folder-import routes for the panel.

## [1.0.0]

### Added
- Markdown-first local store, six agent tools, standalone CLI, Web settings panel, hybrid BM25 + vector retrieval, three vector modes, collections, tags, trash, versions, inbox watcher and URL import.

[Unreleased]: https://github.com/CodfishYao/dsh-knowledge-base-local/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/CodfishYao/dsh-knowledge-base-local/releases/tag/v1.2.0
[1.1.0]: https://github.com/CodfishYao/dsh-knowledge-base-local/releases/tag/v1.1.0
[1.0.0]: https://github.com/CodfishYao/dsh-knowledge-base-local/releases/tag/v1.0.0
