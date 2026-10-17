# dsh-knowledge-base-local

[简体中文](README.zh.md) | English

A local, model-readable knowledge-base plugin for **DeepSeek Harness** (DSH). It stores everything as plain Markdown you can open in any editor, and gives three independent ways in — agent tools, a CLI, and a Web settings panel — plus PDF/Office text extraction, an MCP server for external clients, at-rest AES-256-GCM encryption and role-based multi-user access.

Three design goals:

1. **You own the location** — any absolute path, changeable at any time.
2. **Any model can read it** — Markdown *is* the data; no lock-in.
3. **Store anything** — text, Markdown, code, web pages, any binary attachment; chunked and vectorised automatically.

> Zero runtime dependencies: Node built-ins only. Nothing to compile on install.

---

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Features](#features)
- [Agent tools](#agent-tools)
- [CLI](#cli)
- [PDF / Office extraction](#pdf--office-extraction)
- [MCP server](#mcp-server)
- [Encryption & multi-user](#encryption--multi-user)
- [Bulk & full delete](#bulk--full-delete)
- [Web panel](#web-panel)
- [Storage layout](#storage-layout)
- [Configuration](#configuration)
- [Vector modes](#vector-modes)
- [Retrieval scoring](#retrieval-scoring)
- [Security model](#security-model)
- [Known limitations](#known-limitations)
- [Development & tests](#development--tests)
- [Uninstall](#uninstall)

---

## Install

Requires Node.js ≥ 22 and a running DeepSeek Harness.

**From npm** (recommended):

```
plugin_manager install_bundle dsh-knowledge-base-local
```

**From a local checkout** (or a built tarball):

```
plugin_manager install_bundle /absolute/path/to/dsh-knowledge-base-local
```

`install_bundle` reads `cordis.patch.yml` from the package and inserts one Host plugin row into the active profile. No native build step.

## Quick start

1. Open **Settings → Knowledge base** and pick a folder, or tell the agent *"set my knowledge base to /path/to/knowledge"*.
2. Or from the CLI:

   ```
   node kb.mjs config --root /path/to/knowledge
   ```

The chosen root and every preference live in the per-user data directory (default `~/.dsh`):

```
<DSH_HOME>/knowledge-base/settings.json
```

That file is independent of the current workspace and profile, so your knowledge base follows you between projects and is not lost when a profile changes.

## Features

- **Markdown as the source of truth** — each document is `docs/<id>.md` with frontmatter; a generated `CATALOG.md` gives models and humans a table of contents.
- **Six agent tools** — `kb_search`, `kb_read`, `kb_list`, `kb_add`, `kb_import`, `kb_manage`.
- **Hybrid retrieval** — BM25 lexical + vector cosine + title/substring bonus; results carry document id, line numbers and a snippet.
- **Three vector modes** — `local` (offline TF-IDF feature hashing), `llm` (model enrichment + local vectors), `api` (OpenAI-compatible embeddings, falls back to local on failure).
- **Collections & tags** — namespace multiple knowledge bases; scope any query.
- **Trash & versions** — delete is soft (recoverable); every edit keeps a version (20 by default).
- **Inbox watcher** — files dropped into `<root>/inbox/` are imported automatically and updated on change (PDF/Office included).
- **URL import** — fetches readable page text (prefers Harness's `web` service).
- **PDF / Office text extraction** — `.pdf` `.docx` `.xlsx` `.pptx`, zero dependencies. [Details](#pdf--office-extraction).
- **MCP server** — expose the library to Claude Desktop, Cursor, or any MCP client over stdio or Streamable HTTP. [Details](#mcp-server).
- **At-rest encryption** — AES-256-GCM per document; the passphrase only wraps a random data key via a scrypt-derived KEK. [Details](#encryption--multi-user).
- **Multi-user access** — `owner > admin > editor > reader`, per-collection narrowing, and SHA-256-hashed API tokens. Off by default (single-user). [Details](#encryption--multi-user).

## Agent tools

| Tool | Purpose |
| --- | --- |
| `kb_search` | Hybrid retrieval; `collection`, `tags`, `limit`, `mode` |
| `kb_read` | Read a document in full, or by line range / chunk |
| `kb_list` | Browse documents, collections and stats |
| `kb_add` | Store text / a local file / a URL; automatic de-duplication |
| `kb_import` | Recursively import a folder or a single file/web page (runs PDF/Office extraction) |
| `kb_manage` | status / configure / collection / update / delete / restore / purge / reindex / scan / export, **and** security operations: `security_status`, `enable_encryption`, `disable_encryption`, `unlock`, `lock`, `change_passphrase`, `rotate_key`, `set_metadata_encryption`, `reencrypt`, `rbac_enable`, `rbac_disable`, `user_*`, `grant`, `revoke`, `token_issue`, `token_revoke`, `mcp_info`, `bulk_delete`, `empty_trash`, `wipe` |

Every turn, the agent sees a short system-prompt section with the root, scale, collections and usage — it updates whenever the store changes. You never need to paste the path into a conversation.

> **Passphrase privacy.** A passphrase typed to the agent travels in the session log. Prefer entering it in the Web panel (Settings → Knowledge base → Security); `kb_manage`'s `passphrase` argument is the convenience path, not the private one.

## CLI

Run from anywhere in the package (or via the installed `dsh-kb` bin):

```
node kb.mjs status
node kb.mjs search "hybrid retrieval" --limit 5
node kb.mjs read <id> --offset 1 --limit 120
node kb.mjs add --title "Title" --text "Body" --collection notes --tags a,b
node kb.mjs add --file /path/notes/todo.md
node kb.mjs import /path/Notes --collection notes
node kb.mjs import /path/Papers/report.pdf --collection papers   # body extracted
node kb.mjs reindex --full
node kb.mjs export --format md
node kb.mjs security          # encryption / multi-user state and on-disk coverage
node kb.mjs unlock            # reads DSH_KB_PASSPHRASE or --passphrase
node kb.mjs lock
node kb.mjs users             # users, collection grants, tokens
node kb.mjs mcp               # how to connect an external MCP client
node kb.mjs --json status     # machine-readable
```

Global flags: `--root <dir>` (one-shot override), `--json`. `kb.mjs` shares the same `src/` as the plugin and needs no running Harness. While the library is encrypted and locked, commands fail loudly with "locked" rather than emitting garbage — unlock first (`node kb.mjs unlock` or `DSH_KB_PASSPHRASE`).

## PDF / Office extraction

Detection is magic-bytes first, extension second. Everything degrades gracefully — a file that cannot be parsed is kept as an attachment with the reason recorded, never silently dropped.

| Format | Supported | On failure |
| --- | --- | --- |
| `.pdf` | objects + xref (incl. object streams), `FlateDecode`, content-stream ops `Tj/TJ '/"/T*/Td/Tm`, simple fonts (Standard/WinAnsi + `/Differences`), Type0/CID with `/ToUnicode` (CJK), `/Info` title, page count | scanned images / encrypted → attachment + placeholder + reason |
| `.docx` | paragraphs, heading levels, lists, tables, sections, `docProps` title | missing part → error + attachment |
| `.xlsx` | multiple sheets, shared strings (rich runs included), inline strings; formulas are not evaluated | empty sheet skipped |
| `.pptx` | title/body/notes per slide, sorted by slide number | no slide part → invalid |
| `.doc/.xls/.ppt` | legacy OLE is **not** parsed | clear "re-save as docx/xlsx/pptx" message, attachment kept |

Extraction results are recorded in each document's `extract` field (`kind`, `pages`, `warnings`, failure reason) and shown in the panel and `kb_list`. Body gets a `> extracted from report.pdf (pdf · 12 pages)` header for provenance. The size cap is `import.maxFileBytes` (8 MiB by default).

## MCP server

```bash
# stdio (Claude Desktop / Cursor / Cherry Studio …), no running Harness required:
node mcp-stdio.mjs
node mcp-stdio.mjs --root /path/to/knowledge --readonly
node mcp-stdio.mjs --help

# standalone Streamable HTTP:
node mcp-stdio.mjs --http 8765 --token kb_…

# in-process endpoint inside Harness (same origin as the Web GUI):
POST http://127.0.0.1:<gui-port>/kb-mcp
```

Client config (stdio):

```json
{ "mcpServers": { "knowledge-base": {
  "command": "node",
  "args": ["/absolute/path/to/dsh-knowledge-base-local/mcp-stdio.mjs"]
} } }
```

Client config (HTTP, with a token issued under Settings → Knowledge base → Security):

```json
{ "mcpServers": { "knowledge-base-http": {
  "type": "streamable-http",
  "url": "http://127.0.0.1:8765/mcp",
  "headers": { "Authorization": "Bearer kb_…" }
} } }
```

- Tool names, descriptions and arguments match the agent side exactly; results include both `content[].text` (for humans/models) and `structuredContent` (for programs).
- Each external connection authenticates as a real user: issue a token per client and its role/collection grants apply automatically (a read-only token calling `kb_add` is refused with `ForbiddenError`).
- `--readonly` exposes only `kb_search` / `kb_read` / `kb_list` and a narrowed `kb_manage` (`status` / `trash`).
- Inside a standalone process, `kb_manage configure` only edits memory (never writes your `settings.json`), and changing the root also needs `--allow-set-root` — so a remote client cannot point the library at an arbitrary folder.
- Not implemented (honest list): SSE/`GET` notification stream, `listChanged`, progress and cancellation, server→client requests (roots/sampling/elicitation), pagination cursors, and attachments as MCP resources; session ids live in memory only.

## Encryption & multi-user

Panel path: **Settings → Knowledge base → Security** (every step has a confirmation).

1. **Turn on encryption** — set a passphrase (≥ 8 chars); bodies, index, versions and the manifest are sealed per document. Optionally also encrypt metadata (titles/tags/summaries).
2. **Lock / unlock** — locking clears the in-memory key; unlocking needs the passphrase or `DSH_KB_PASSPHRASE`.
3. **Change passphrase** — only re-wraps the data key (instant, no corpus rewrite). **Rotate data key** re-encrypts everything.
4. **Turn off** — decrypts back to plain Markdown and removes the local key file.
5. **Multi-user** — enable RBAC, set the local role (`owner` default), add users, narrow roles per collection, issue/revoke `kb_…` API tokens (SHA-256 hash stored, plaintext shown once).

With both switches off the code path matches single-user behaviour exactly: no `secure/` directory, no rewrites, unchanged `kb_*` behaviour.

## Bulk & full delete

Three levels, permission-gated, all refused while locked:

| Operation | Meaning | Permission | Recoverable |
| --- | --- | --- | --- |
| Delete (single) | move one document to trash | `delete` (editor floor) + collection scope + **ownership** (editor deletes only their own; admin and above do not) | yes |
| `bulkRemove` | move documents matched by `ids`/`collection`/`tag`/`query` to trash; each item runs the same per-item check, undeletable ones return in `skipped` with a reason | same | yes |
| `emptyTrash` | delete trash entries for real | `delete`; an editor purges only their own | no |
| `wipe` | erase every document, trash entry, index, version, attachment and export | **`security` (owner)** + typed confirmation `WIPE` | no |

Entry points: the panel's **Danger zone** (Documents tab), `kb_manage` (`bulk_delete` / `empty_trash` / `wipe`), `POST /kb-api/bulk-remove|empty-trash|wipe`, and `node kb.mjs bulk-delete / empty-trash / wipe --confirm WIPE [--remove-folder]`. `wipe` keeps the root folder and settings by default; `--remove-folder` also deletes the local folder and unsets the root (irreversible).

## Web panel

Settings → Knowledge base, tabs: **Overview / Documents / Import / Settings / Security / MCP**.

- **Overview** — status rows (root, scale, vector mode, encryption, users), a lock banner with inline unlock, quick search, rebuild/scan/export.
- **Documents** — filter by collection/tag/keyword, paginate, open, delete; trash restore / purge; a Danger zone for bulk delete, empty trash and full wipe.
- **Import** — drag-and-drop upload (PDF/Office/text with per-file extraction results), folder import with a native picker, paste-as-text.
- **Settings** — root change (picker/manual), vector mode, chunk params, default collection, LLM, embeddings, inbox watch, allow-write toggle; dirty-tracked save.
- **Security** — the full encryption lifecycle and RBAC (users, collection grants, tokens).
- **MCP** — endpoint status, copyable stdio/HTTP configs, and access-policy toggles.

Destructive actions use a confirmation dialog (`Esc` or backdrop to dismiss). The panel talks to the Host over same-origin `/kb-api`; cross-origin calls must send `Authorization: Bearer <token>` (else 403). After changing panel code, refresh the page (there is no client HMR unless the Harness web dev server is running).

## Storage layout

```
<root>/
  kb.json                 # collections + document metadata (owned by the plugin)
  CATALOG.md              # human/model table of contents
  README.md               # generated note
  docs/<id>.md            # body (frontmatter + Markdown)
  files/<id>/<name>       # original attachments (any binary)
  index/<id>.json         # chunks, term frequencies, vectors (base64 Float32)
  index/stats.json        # DF / avgdl for BM25 and IDF
  versions/<id>/*.md      # history
  trash/<id>/             # soft-deleted documents
  inbox/                  # drop-to-import
  exports/                # `export` output
  secure/key.json         # only with encryption: KEK-wrapped data key + salt + fingerprint
  secure/users.json       # only with RBAC: users, collection grants, token hashes
```

Hand-editing `docs/*.md` is supported — call `kb_manage {action:"scan"}` (or `node kb.mjs scan`) to adopt and re-index.

## Configuration

Written to `<DSH_HOME>/knowledge-base/settings.json`; non-empty values in the profile's `cordis.patch.yml` row override it.

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

`security` and `mcp` default conservatively: encryption and multi-user are **off**; the in-Harness MCP endpoint is mounted but **requires a token** (except same-origin web).

## Vector modes

- **`local`** (default) — NFKC → lowercase; CJK bigrams, Latin words/numbers stop-worded; FNV-1a feature hashing into a signed 1024-dim (configurable) vector; `1+log(tf)` × IDF; L2-normalised. Offline and deterministic. **Lexical, not neural** — paraphrase/synonym recall is limited.
- **`llm`** — one model call per document produces `summary/keywords/questions/entities`; that profile is folded into each chunk's vector text and encoded with the local vectoriser. Falls back to `local` on any failure (no `llm` service, no key, timeout, parse error) and records the reason.
- **`api`** — `POST <endpoint>/embeddings` (OpenAI-compatible); configure `model`, optional `apiKey`, `dimensions`, `batchSize`. Key also via `DSH_KB_EMBEDDING_API_KEY`. Falls back to `local` on failure.

After changing mode or chunking, run `kb_manage {action:"reindex", full:true}` (or `node kb.mjs reindex --full`).

## Retrieval scoring

`score = vectorWeight × cos(vector) + lexicalWeight × BM25/(BM25+6) + title/substring bonus`

- Weights default 0.55 / 0.45 (`search.vectorWeight` / `search.lexicalWeight`).
- At most two chunks per document; results de-duplicated by document.
- Returns `docId`, `path`, `lineStart`/`lineEnd`, `chunk`, `snippet`, `score`, `semantic`, `lexical` — directly citable.

## Security model

- Writes are on by default; disable via the panel (Settings → Advanced → allow writing tools) or `tools.allowWrite: false`.
- Deletion is soft (`trash/`); only `purge` is permanent.
- All writes stay inside the root; `kb_read` accepts only in-library ids/paths.
- `/kb-api` is same-origin by default; cross-origin needs a Bearer token. `/kb-mcp` runs as the local role for same-origin web, tokens for external processes.
- Passphrases and API keys never appear in `CATALOG.md`, `kb.json` or the index; tokens are stored as SHA-256 hashes and shown once.
- A locked library refuses reads and writes rather than returning ciphertext.

## Known limitations

- `local` vectors are lexical hashes, not embeddings; for paraphrase/semantic recall use `llm` or `api`.
- In `api` mode the query also calls embeddings; if the endpoint is down, that search degrades to lexical with a warning.
- Chunking follows paragraph/sentence boundaries; very long punctuation-free runs are hard-cut.
- Versions keep bodies, not attachment history.
- No in-panel full-text editor (update via `kb_manage update`, or edit `docs/*.md` then `scan`).
- Scanned PDFs need OCR (out of scope) and legacy `.doc/.xls/.ppt` are not parsed.
- Encryption has **no recovery**: a lost passphrase means the corpus is unreadable forever; try the cycle on a small throwaway folder first.
- Metadata is plain by default (titles, tags, summaries, filenames, `CATALOG.md`); enable metadata encryption to hide them, at the cost of direct browsing.
- RBAC is a same-machine identity layer, not tenant isolation; use separate roots and system accounts per trust boundary.

## Development & tests

```
npm test        # seven suites: smoke, extract, integration, panel-api, danger-ops, host-mcp-mount, mcp
npm run lint:css  # static check that the panel CSS uses only real theme tokens, no literal colours
```

Every test runs against a throwaway temp knowledge base and a temp `DSH_HOME`; none ever reads or writes a real knowledge base or profile state. Dev helpers live in `tools/` (a CSS splicer, a CSS/token auditor, and a hand-authored stylesheet the panel build reads). See [SECURITY.md](SECURITY.md) before reporting vulnerabilities.

## Uninstall

```
plugin_manager remove_bundle dsh-knowledge-base-local
```

Your knowledge-base folder and `<DSH_HOME>/knowledge-base/settings.json` are left in place; remove them manually if you want.

## License

MIT — see [LICENSE](LICENSE).
