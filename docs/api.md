← [Back to README](../README.md)

# Harness API (`recall-memory/api`)

Stable, thin library surface for humans and agents who need to plug a new harness into Recall **without forking core**.

This is not a Cursor marketplace plugin, not a `HostDescriptor`, and not a new `recall host-hook` host. It re-exports the seams that already exist: CLI `recall start`, markdown drop-dir, Cursor catalog/inject, MCP, and skills.

## Install the package, then import the API

```ts
import {
  describeHarnessSeams,
  registerStartFormat,
  registerSessionSource,
  runStart,
  parseMarkdownDrop,
  catalogCursorSessions,
  mergeCursorHooksJson,
} from 'recall-memory/api';
```

Requires Bun (`bun:sqlite`). The CLI binaries remain `recall` and `recall-mcp`; this export does not replace them.

Inspect the live map:

```bash
bun -e 'import { describeHarnessSeams } from "./src/api.ts"; console.log(JSON.stringify(describeHarnessSeams(), null, 2))'
```

## Seams

| Seam | As-built contract | Register hook |
|------|-------------------|---------------|
| **start** | `recall start` renders L0/L1 via `hooks/lib/session-start-context.ts`. `--format cursor` wraps `{ additional_context }`. | `registerStartFormat(id, wrap)` — in-process, for `runStart({ format: id })`. The public CLI still accepts only `markdown` \| `cursor`. |
| **drop** | Write markdown into `MEMORY/<host>-sessions/`. Batch extract scans `*-sessions` generically. | None. The directory name **is** the extension point. `parseMarkdownDrop` / `markdownDropDirName` are the helpers. |
| **capture** | Cursor: `catalogCursorSessions()` (catalog only, no SQLite insert). Dump: `discoverCurrentSession()`. Codex/Grok/jcode stay on hidden `recall host-hook`. | `registerSessionSource(adapter)` — in-process, consulted by `discoverCurrentSession()`. Cannot replace builtin `SESSION_SOURCES` ids. |
| **inject** | Cursor snippets under `templates/cursor/` call unqualified `recall start --format cursor`. Claude/Codex call the same assembler through their own hooks. | `mergeCursorHooksJson` is the Cursor hooks.json helper. Do not add a marketplace plugin. |

MCP (`recall-mcp`, server name `recall-memory`) and Agent Skills (`agent-skills/`) are already cross-host. Point at [MCP Tools](mcp-tools.md) and [Agent Skills](agent-skills.md); do not fork those catalogs.

## Cursor PATH caveat (FM-321 / FM-327)

As-built, Cursor sessionStart runs `recall start --format cursor` with **no path prefix**. Cursor.app's GUI PATH typically lacks `~/.bun/bin`, so the hook is a no-op until `recall` is on that app PATH. CLI Cursor, or any shell where `recall` resolves, is fine.

A durable fix for GUI PATH / `recall start --format cursor` accuracy is **pending FM-321/327**. This page does not invent a `~/.cursor/hooks` wrapper or a machine-specific prefix. Until those land, treat Cursor inject as beta and verify with `which recall` in the same environment Cursor.app uses.

## Non-goals

- No `HostDescriptor` layer and no adapter→plugin rename.
- No Cursor marketplace plugin (`plugins/recall-cursor` does not exist).
- Cursor does not join `recall host-hook` / `host-ingest` / `LifecycleHost`.
- No CLI extension loader in this slice — registrations are in-process.

A new drop-dir host still does **not** copy `RecallExtract.ts` / `RecallPreCompact.ts`. A new lifecycle host (Codex-shaped) still goes through `commands/host-hook.ts` + `lib/host-ingest.ts`, which is a different, existing pipe — not this API.

## First-run and host attach

Humans: [Getting Started](getting-started.md). Preferred plugin/extension attach for Claude, Codex, Pi, and omp is unchanged from the post-#284 docs; this API does not redo that install path.
