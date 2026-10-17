# Contributing

[简体中文](CONTRIBUTING.zh.md) | English

Thanks for your interest in improving **dsh-knowledge-base-local**! This guide
covers how to build, test and send changes.

## How this plugin is built

It is a Cordis / **DeepSeek Harness** plugin package: a Node.js ES-module with
**no runtime dependencies** (Node built-ins only) that registers:

- a **Host half** (`index.js` + `src/`): the `KnowledgeStore`, six `kb_*` agent
  tools, the same-origin `/kb-api` HTTP surface, the mounted `/kb-mcp` MCP
  endpoint, the inbox watcher and a system-prompt section.
- a **Client half** (`client.js`): the Web settings panel, injected into the
  Harness shell. The panel is React-without-JSX (`React.createElement`), reads
  theme colours only from the shell's `--dsw-*` tokens, and talks to the Host
  through `/kb-api`.
- a **standalone CLI** (`kb.mjs`) and a **standalone MCP server**
  (`mcp-stdio.mjs`) that reuse the same `src/`.

## Prerequisites

- Node.js **≥ 22** (uses `node:crypto` scrypt/GCM, `node:fs` promises, etc.).
- No `npm install` is needed to run the code — there are zero dependencies.
  Install dev tooling only if you want `npm test`'s runner sugar.

## Run it locally

Point a DeepSeek Harness profile at this checkout instead of (or in addition to)
npm:

```
# in the Harness host, via the plugin_manager tool or the profile patch:
install_bundle /absolute/path/to/dsh-knowledge-base-local
```

Then open **Settings → Knowledge base**, choose a folder, and try the tools.
Because it is a local `link:` install, editing `src/` is picked up on the next
plugin reload (re-enable the plugin row, or restart the host); the panel changes
take effect after a **page refresh**.

## Development loop

```
npm test              # 7 suites, ~seconds: smoke, extract, integration,
                      #   panel-api, danger-ops, host-mcp-mount, mcp
npm run lint:css      # panel stylesheet guard
```

Every test runs against a throwaway temp knowledge base and a temp `DSH_HOME`, so
**it never reads or writes a real knowledge base or profile state**. When you add
a feature, add or extend a test in `test/` and keep all seven green.

### The CSS/style guard

The settings panel must use only the theme tokens the shell declares and never
hard-code colours. `tools/audit-css.mjs` enforces:

- no literal colours (`#hex`, `rgb()/rgba()/hsl()`);
- every `--dsw-*` reference exists in the shell token sheets or carries a fallback;
- pill/circle radii pair with `corner-shape: round` (the shell applies a
  superellipse globally);
- every class used in the JSX exists in the stylesheet, and braces/semicolons
  balance.

It reads the shell sheets from a sibling checkout (`../dsh-client/ui-theme/src/styles`
by default; pass `--tokens <dir>` otherwise) and degrades gracefully if they are
not present. The panel's stylesheet is authored in `tools/panel.css` and spliced
into `client.js` by `tools/splice-css.mjs`; edit `panel.css`, then re-splice, and
run `npm run lint:css`.

## Code conventions

- **ES modules**, **no semicolons**, **single quotes**, 2-space indent — match the
  existing files.
- Code comments are **English**; user-facing strings are **bilingual** and live in
  dictionaries (the panel `DICT` with `zh`/`en`; `src/locales`/`locale/*.json` for
  the plugin display metadata). Keep `zh` and `en` key sets identical — `npm test`
  and the i18n checks assume it.
- The Host, CLI, panel, HTTP API and MCP all call the **same** `src/store.js`
  methods, so behaviour and **permissions** never diverge. Keep it that way: put
  business logic in the store, not in a transport.
- **Permissions are not optional.** Any new mutation must go through
  `store.authorize(input, action, collection)` / `assertOwnership(...)` with the
  right action floor (`read`/`write`/`delete`/`manage`/`security`) and refuse while
  the library is locked. Destructive paths need a typed confirmation (see `wipe`).
- Never log or persist passphrases/API keys; tokens are stored as SHA-256 hashes
  and shown once. See [SECURITY.md](SECURITY.md) for the threat model.

## Submitting changes

1. Fork and branch from `main` (branch names like `feat/…`, `fix/…`).
2. Keep commits focused; write plain, imperative commit messages.
3. Run `npm test` and `npm run lint:css`; both must pass.
4. Update `CHANGELOG.md` (and `CHANGELOG.zh.md`) under **Unreleased** for anything
   user-visible.
5. Open a pull request: describe *what* and *why*, link issues, and include
   before/after screenshots if you touched the panel UI.

## AI-tooling disclosure

This project is developed with AI assistance. The tooling used on this codebase
includes:

- **DeepSeek Harness** — the agent runtime, Web GUI and plugin host this package
  plugs into, used for its coding agent, tool use and in-app inspection; and
- **Qwen** — an LLM used for code generation, review and documentation drafting.

If you use AI tooling in a contribution, say so in the PR description (which
model/tool, and what it generated) so reviewers know what to scrutinise. Generated
code still has to pass the same tests, style and security bar as handwritten code
— you are accountable for what you submit.

## Security issues

Do **not** open a public issue. See [SECURITY.md](SECURITY.md) and report
privately via GitHub advisories.

## License

By contributing, you agree your contributions are licensed under the project's
[MIT license](LICENSE).
