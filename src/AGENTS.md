# src — CLI, MCP server, data layer

> Child DOX. Root `AGENTS.md` carries repo-wide rules; this file owns local detail for `src/`.

## Purpose

TypeScript source for the `recall` CLI (Commander), the `recall-mcp` MCP server, the SQLite data layer, and the core memory operations they share.

## Ownership

- `index.ts` — CLI entry (Commander)
- `commands/start.ts` — public `recall start` L0/L1 inject renderer
- `mcp-server.ts` — MCP server entry (`@modelcontextprotocol/sdk`)
- `version.ts` — version sourced from `package.json`
- `commands/` — CLI subcommands · `db/` — connection + schema/FTS5 · `lib/` — host-neutral core memory, embeddings, import, project utils, immediate transcript ingest, lifecycle delegation (`lifecycle.ts` → install.sh/update.sh/uninstall.sh) · `hosts/` — native host paths, config schemas, transcript adapters, and native command discovery · `providers/` — external model-provider adapters · `types/` — shared types

Not owned here: lifecycle hooks (`hooks/` — standalone, must NOT import from `src/`) and build output (`dist/`, generated).

## Local Contracts

- Runtime is Bun. Use `bun:sqlite` directly; never a Node SQLite driver. Shebang `#!/usr/bin/env bun`.
- Build is tsup → ESM with `--external bun:sqlite`; the build step rewrites the `node` shebang to `bun`.
- DB lives at `~/.agents/Recall/recall.db` (override `RECALL_DB_PATH`; legacy `MEM_DB_PATH` accepted). WAL mode. FTS5 with sync triggers — keep table defs and triggers in `db/schema.ts` aligned.
- DB-path resolution is shared with hooks via `hooks/lib/db-path.ts` so CLI and hooks agree — import that resolver, never fork the logic.
- Identity-path resolution is shared with hooks via `hooks/lib/identity-path.ts`; onboarding consumes that resolver instead of owning parallel path logic. The only install root is `~/.agents/Recall`; never add user-facing or discovered install-root relocation (no `RECALL_DIR` honoring in TypeScript, no guide-link or marker-file root discovery).
- Recall-owned mutable state and logs resolve through `lib/runtime-paths.ts` (`RECALL_HOME`, default `~/.agents/Recall`) — never place generic runtime state under a native host's config directory.
- Native host paths, transcript formats, config ownership, command lookup, and authentication assumptions belong under `hosts/`; host-neutral commands and MCP handlers depend on their interfaces rather than branching on host details.
- Cursor capture is an on-disk catalog parser (`hosts/cursor-capture.ts`) of `state.vscdb` + CLI JSONL + fail-soft `~/.cursor/chats/<md5(cwd)>/` blobs. It does not join `recall host-hook`, `host-ingest`, or `LifecycleHost`, and does not dump transcript bodies into query.
- Cursor inject (`hosts/cursor-inject.ts`) is sessionStart `{ additional_context }` via hooks.json + MCP (`recall-mcp`) + a rule, calling `recall start --format cursor`. Snippets live under `templates/cursor/`. Do not ship a Cursor marketplace plugin. Cursor.app GUI PATH typically lacks `~/.bun/bin`, so sessionStart is a no-op until `recall` is on that app PATH; do not add a `~/.cursor/hooks` wrapper or a machine-specific prefix.
- Markdown drop-dir ingest is shared (`hosts/markdown-session-source.ts` + `hooks/lib/markdown-drop.ts`). Do not add a drop-dir branch to `lib/host-ingest.ts`.
- Supported native lifecycle transcripts enter SQLite only through `lib/host-ingest.ts`, which owns scrub, source/project attribution, native session IDs, persistent dedup keys, watermarks, bounded shadow generations outside live messages/FTS, checkpoint-CAS pointer activation through `published_messages`, delta-only FTS publication with project-scoped typed readiness and bounded independent repair, retention-aware exact terminal lineage with immutable resume cursors, prune-preserving replace-on-resume finalization, and current-publication semantic filtering with version-matched embedding invalidation and atomically dirtied vector caches. Thin, bounded-stream host payload routing belongs in `commands/host-hook.ts`.
- Lifecycle-aware prune mutations fail closed with retryable readiness when lifecycle schema objects are unavailable.
- Automatic terminal capture must not degrade curated memory quality: its LoA rows (`tags` `automatic-capture,<source>`) insert **below** the curated tier at importance 6 in `lib/host-ingest.ts`, and `hosts/codex-lifecycle.ts` drops host-injected user turns (prefixes `# AGENTS.md instructions for `, `<environment_context>`, `<user_instructions>`) so Codex's own instruction blocks never become verbatim memory. The typed prompt survives as its own turn.
- External text-generation commands belong behind `providers/text-generation.ts`; callers must not shell a native model CLI directly.
- All project-path handling goes through `lib/project.ts` (`validateDirPath` injection guard) — never assemble project paths ad hoc.
- Explicit add paths (`recall add` CLI + `memory_add` MCP) redact secrets at the choke point: `addDecision`/`addLearning`/`addBreadcrumb` in `lib/memory.ts` `scrub()` every free-text field before insert and report redacted kinds via the optional `redactionsOut` arg. A new explicit write path must route through these — never INSERT user free-text directly.
- `recall repair --execute` may delete derived orphan embeddings and synchronize the vector index; repairable cleanup check failures remain retryable non-success results, while source-record and lineage invariant findings remain report-only. Route embedding cleanup through `lib/embedding-store.ts` so canonical rows and vector readiness change transactionally.

## Work Guidance

- Add a CLI subcommand: create `commands/<name>.ts`, then wire it into `index.ts`.
- Add an MCP tool: add a handler in `mcp-server.ts`.
- Extend core memory ops (search/add/import) in `lib/memory.ts` — don't duplicate them in a command.
- Add a native lifecycle host by keeping its parser in `hosts/` and routing its supported public hook/export surface through `commands/host-hook.ts` and `lib/host-ingest.ts`. Cursor is not a lifecycle host: capture is the on-disk parser, inject is `recall start`.

## Verification

- `bun run lint` (tsc --noEmit) and `bun test`.

## Child DOX Index

No child docs — `commands/`, `db/`, `lib/`, `types/` share these contracts; the add-command / add-tool patterns above cover them.
