# Agent Store registry

The package registry for [Agent Store](https://agent-store-alpha.vercel.app) — a
marketplace of **providers**, **skills**, and **MCP servers** for Claude Code,
Codex, and other AI coding agents.

Each package is a single JSON manifest. Anyone can contribute or update a package
by opening a pull request. Merged manifests are synced to the store and go live.

## Repository layout

```
mcp/<slug>.json        # MCP servers (npx stdio, or remote http/sse)
skill/<slug>.json      # Skills (a SKILL.md fetched on install)
provider/<slug>.json   # Model providers / relays (pre-filled connection)
schema/package.schema.json
scripts/validate.ts    # the CI validator
```

## Contribute a package

1. Fork this repo.
2. Add a file `<category>/<slug>.json`. The filename **must** equal the `slug`.
   Point your editor at `schema/package.schema.json` (via the `$schema` field) for
   completion and inline validation.
3. Open a PR. CI validates the manifest (schema + that install URLs resolve).
4. A maintainer reviews the PR. On merge, the package is published to the store.

Report a broken package or request a new one via an **issue**.

## Manifest shape

```jsonc
{
  "$schema": "../schema/package.schema.json",
  "slug": "context7",
  "name": "Context7",
  "description": "Up-to-date code docs for any prompt.",
  "category": "mcp",
  "version": "1.0.0",
  "publisher": { "slug": "upstash", "name": "Upstash", "tier": "community" },
  "compatibleWith": ["claude", "codex"],
  "tags": ["mcp", "npm"],
  "installHook": { "steps": [] },
  "metadata": { "transport": "stdio", "serverCommand": "npx -y @upstash/context7-mcp" }
}
```

### Install hooks by category

- **MCP (stdio)** — set `metadata.transport: "stdio"` and `metadata.serverCommand`
  (e.g. `npx -y <package>`). No file download needed; the command runs at enable.
- **MCP (remote)** — set `metadata.transport: "http"` (or `"sse"`) and `metadata.url`.
- **Skill** — add a `file` step fetching the raw `SKILL.md` to `skill.md`, e.g.
  `{ "type": "file", "url": "https://raw.githubusercontent.com/.../SKILL.md", "dest": "skill.md" }`.
- **Provider** — add a `config` step pre-filling the connection, e.g.
  `{ "type": "config", "patch": { "apiKey": "", "baseUrl": "https://...", "authType": "bearer" } }`.
  The user only supplies their API key.

## Validate locally

```bash
bun scripts/validate.ts          # structure + URL reachability
CHECK_URLS=0 bun scripts/validate.ts   # structure only (offline)
```

Popular packages are also proposed automatically by a crawler that opens PRs here
— those go through the same review as any other contribution.
