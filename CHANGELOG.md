# Changelog

All notable changes to **dsh-knowledge-base-local** are documented here.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

[简体中文](CHANGELOG.zh.md) | English

## [1.2.5](https://github.com/CodfishYao/dsh-knowledge-base-local/releases/tag/1.2.5) - 2026-10-18

### Fixed
- Fixed some visual cues in the settings interface.
  
## [1.2.4](https://github.com/CodfishYao/dsh-knowledge-base-local/releases/tag/1.2.4) - 2026-10-18

### Changed
- Added Node.js build script (`scripts/build.js`) that copies all distribution files to `lib/`.
- Updated `exports`, `bin`, and `files` fields in package.json to reference `lib/` output.
- Added `.gitignore` rule for `lib/` directory (generated artifact).

## [1.2.3](https://github.com/CodfishYao/dsh-knowledge-base-local/releases/tag/1.2.3) - 2026-10-18

### Fixed
- PDF parser extracts content from ObjStm-compressed objects in PDF 1.5+ files correctly (index offset and whitespace handling).
- Embedding API calls retry with exponential backoff on HTTP 429/5xx responses (up to 3 attempts with `Retry-After` header support).

### Changed
- Default `embedding.batchSize` reduced from 32 to 10 for DashScope API compatibility (gateway limit is 20).

## [1.2.2] - 2026-10-18

### Fixed
- DashScope native embedding API uses correct request format (`input.texts` instead of `input.contents`) and endpoint path (`/api/v1/services/embeddings/text-embedding/text-embedding`).
- Embedding format detection improved: endpoints under `/api/v1` or models containing `text-embedding` are treated as DashScope; OpenAI-compatible endpoints retain `{"input": [...]}` format.
- `bin` field rewritten to npm-accepted format (`kb.mjs`) to prevent auto-removal during publishing.

## [1.2.1] - 2026-10-18

### Fixed
- Initial DashScope embedding support (request/response shape). Superseded by 1.2.2 with corrected field names and endpoint paths.

## [1.2.0] - 2026-10-17

### Added
- Bulk delete (`bulkRemove`), empty-trash (`emptyTrash`), and full wipe (`wipe`) operations with permission controls: bulk operations require delete permission plus collection scope and ownership; wipe requires security (owner) role and typed `WIPE` confirmation. All operations refused when library is locked.
- Danger zone section in panel Documents tab, corresponding `kb_manage` actions, `/kb-api` routes, and `kb.mjs` commands.
- `dsh-kb` CLI binary and `prepublishOnly` test gate.
- Bilingual documentation (`README.md` / `README.zh.md`), `SECURITY.md` / `SECURITY.zh.md`, `CONTRIBUTING.md` / `CONTRIBUTING.zh.md`, this changelog, `LICENSE`, `.gitignore`.

### Changed
- Package renamed to `dsh-knowledge-base-local` (formerly private `@local/dsh-knowledge-base`); plugin id, loader id, and i18n namespace synchronized.
- Panel UI rewritten as a flat, theme-token-driven settings form (segmented control, hairline field rows, elevation-based surfaces) following shell palette; no literal colors.
- Locale tracking follows shell's active locale (`LocaleSnapshot.active`) instead of browser language; panel re-renders on locale change.
- Documentation and examples no longer reference private absolute paths; settings path documented portably as `~/.dsh/...`.

## [1.1.0] - 2026-10-17

### Added
- PDF / Office body extraction (`.pdf`, `.docx`, `.xlsx`, `.pptx`) with zero dependencies; original attachments retained and extraction status recorded.
- MCP server for external clients over stdio and Streamable HTTP; tools mirror agent-side implementation exactly with token-driven RBAC.
- At-rest encryption (AES-256-GCM per document; scrypt-wrapped data key) and role-based multi-user access (`owner/admin/editor/reader`) with per-collection grants and API tokens. Both features disabled by default.
- Browser upload and folder-import routes for the panel.

## [1.0.0]

### Added
- Markdown-first local store, six agent tools, standalone CLI, Web settings panel, hybrid BM25 + vector retrieval, three vector modes, collections, tags, trash, versions, inbox watcher, and URL import.
