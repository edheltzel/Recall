# src — CLI, MCP server, data layer

> Child DOX. Root `AGENTS.md` carries repo-wide rules; this file owns local detail for `src/`.

## Purpose

TypeScript source for the `recall` CLI (Commander), the `recall-mcp` MCP server, the SQLite data layer, and the core memory operations they share.

## Ownership

- `index.ts` — CLI entry (Commander)
- `mcp-server.ts` — MCP server entry (`@modelcontextprotocol/sdk`)
- `version.ts` — version sourced from `package.json`
- `commands/` — CLI subcommands · `db/` — connection + schema/FTS5 · `lib/` — core memory, embeddings, import, project utils, lifecycle delegation (`lifecycle.ts` → install.sh/update.sh/uninstall.sh) · `types/` — shared types

Not owned here: lifecycle hooks (`hooks/` — standalone, must NOT import from `src/`) and build output (`dist/`, generated).

## Local Contracts

- Runtime is Bun. Use `bun:sqlite` directly; never a Node SQLite driver. Shebang `#!/usr/bin/env bun`.
- Build is tsup → ESM with `--external bun:sqlite`; the build step rewrites the `node` shebang to `bun`.
- DB lives at `~/.agents/Recall/recall.db` (override `RECALL_DB_PATH`; legacy `MEM_DB_PATH` accepted). WAL mode. FTS5 with sync triggers — keep table defs and triggers in `db/schema.ts` aligned.
- DB-path resolution is shared with hooks via `hooks/lib/db-path.ts` so CLI and hooks agree — import that resolver, never fork the logic.
- All project-path handling goes through `lib/project.ts` (`validateDirPath` injection guard) — never assemble project paths ad hoc.

## Work Guidance

- Add a CLI subcommand: create `commands/<name>.ts`, then wire it into `index.ts`.
- Add an MCP tool: add a handler in `mcp-server.ts`.
- Extend core memory ops (search/add/import) in `lib/memory.ts` — don't duplicate them in a command.

## Verification

- `bun run lint` (tsc --noEmit) and `bun test`.

## Child DOX Index

No child docs — `commands/`, `db/`, `lib/`, `types/` share these contracts; the add-command / add-tool patterns above cover them.
