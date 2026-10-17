# Security Policy

English | [简体中文](SECURITY.zh.md)

This plugin stores documents locally, can encrypt them at rest, and issues API
tokens for external MCP clients. It is **local-first software, not a network
service** and **not a hostile-multi-tenant boundary**. The threat model below is
intentionally explicit so reports are scoped correctly.

## Reporting a vulnerability

Do **not** open a public issue for a security problem.

Report it privately via GitHub security advisories:
**Issues → Report a vulnerability** at
<https://github.com/CodfishYao/dsh-knowledge-base-local/security/advisories/new>.

We aim to acknowledge within 5 business days and ship a fix or guidance before
disclosure. Please include: version, a minimal reproduction, and the impact.

## Scope — what this protects

- A knowledge base the **user** configures, stored on the **user's** disk, read
  through the agent tools, the CLI, the same-origin Web panel, and MCP clients.
- **At-rest confidentiality** when encryption is enabled and the library is
  **locked**: bodies, index, versions and the manifest are AES-256-GCM sealed per
  document; the data key is wrapped by a scrypt-derived (N=32768) key-encryption
  key from the passphrase.
- **Authorisation** for external MCP/HTTP callers: roles `owner > admin > editor
  > reader`, optional per-collection narrowing (grants only lower a role), and API
  tokens stored as SHA-256 hashes (plaintext shown once).

## Out of scope — what it does not do

- **Passphrase recovery.** The passphrase is never stored and cannot be
  recovered. A lost passphrase makes the encrypted corpus permanently unreadable.
  This is by design, not a vulnerability.
- **Protection against anyone who can read the running process.** Once unlocked,
  plaintext is in memory; anyone who can read the process, or the user's own
  account, can read it. Encryption is at-rest only.
- **OS file permissions and disk encryption.** Those remain the first line of
  defence; `secure/key.json` sits beside the ciphertext, so the key file guards
  only "files copied without the passphrase", not a local administrator.
- **Metadata confidentiality by default.** Titles, tags, summaries, filenames and
  `CATALOG.md` are plaintext unless metadata encryption is enabled.
- **Tenant isolation between machines/users on a shared folder.** RBAC is a
  same-machine identity layer. Use separate roots and system accounts per trust
  boundary.
- **The Harness web server's authentication**, the origin of the local HTTP
  surface (`/kb-api`, `/kb-mcp`). Same-origin requests run as the **local owner**;
  cross-origin requests must present a token.

## Notes for reviewers

- All writes are confined to the configured root; traversal is checked.
- A locked library refuses reads and writes rather than returning ciphertext.
- Uploaded/attached bytes are size-capped (`import.maxFileBytes`, 8 MiB default)
  and the PDF parser is a self-contained interpreter — treat untrusted PDFs as
  possibly malformed; extraction failure degrades to "attachment + reason".
- Passphrases and API keys are never written into `CATALOG.md`, `kb.json` or the
  index. Tokens authenticate the action floors in `src/users.js`.
- The destructive paths are guarded: `wipe` needs `security` (owner) and a typed
  `WIPE` confirmation and is refused while locked; bulk delete enforces
  per-document ownership for editors.

## Supported versions

| Version | Supported |
| --- | --- |
| latest `1.x` | yes |
| older `1.x` | best-effort |
| pre-1.0 | no |
