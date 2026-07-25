# Recall + OpenCode Integration Architecture

> Design document for extending Recall to work with OpenCode alongside Claude Code.
> **v4 — Phase 4 verified against a live OpenCode 1.18.5 server.** The event
> contract, the measured `session.idle` frequency, and plugin discovery are
> pinned by `scripts/e2e-opencode-runtime.ts`; the extraction pipeline is pinned
> by `scripts/e2e-opencode.ts`. See [Phase 4 Evidence](#phase-4-evidence) for
> which script proves what.

## Executive Summary

Recall's core (SQLite DB, MCP server, CLI) is **already platform-agnostic** thanks to MCP. Both Claude Code and OpenCode are MCP clients — the `recall-memory` MCP server works identically on both without any changes to `src/`.

The entire integration is **three thin adapter layers**:
1. **Registration** — where the MCP server config entry goes
2. **Extraction** — how conversation transcripts are captured
3. **Instructions** — what file the agent reads for guidance

## Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                    PLATFORM-AGNOSTIC CORE                        │
│                    (zero changes needed)                          │
│                                                                  │
│  ┌─────────────┐  ┌──────────────────┐  ┌────────────────────┐  │
│  │  recall.db   │  │  MCP Server      │  │  CLI (recall)         │  │
│  │  (SQLite)    │←─│  (recall-memory)  │  │  search/add/stats  │  │
│  │  FTS5 + Vec  │  │  9 tools, stdio  │  │  import/export     │  │
│  └──────┬───────┘  └────────┬─────────┘  └────────────────────┘  │
│         │                   │                                     │
│         │     ┌─────────────┴──────────────┐                     │
│         │     │   src/lib/memory.ts         │                     │
│         │     │   src/lib/embeddings.ts     │                     │
│         │     │   src/db/connection.ts      │                     │
│         │     └────────────────────────────┘                     │
└──────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │                               │
  ┌───────────┴───────────┐     ┌─────────────┴──────────────┐
  │   Claude Code Adapter  │     │   OpenCode Adapter          │
  │                        │     │                             │
  │ Registration:          │     │ Registration:               │
  │  ~/.claude/settings.json│    │  ~/.config/opencode/        │
  │  mcpServers.recall-recall │     │    opencode.json            │
  │                        │     │  mcp.recall-memory          │
  │ Extraction:            │     │                             │
  │  hooks/RecallExtract  │     │ Extraction:                 │
  │  (.ts, Stop hook)      │     │  plugins/RecallExtract.ts  │
  │  reads JSONL transcript│     │  `event` hook →             │
  │                        │     │  `opencode export` JSON     │
  │ Instructions:          │     │  → markdown drop for batch    │
  │  FOR_CLAUDE.md         │     │                             │
  │  → ~/.claude/          │     │ Instructions:               │
  │    Recall_GUIDE.md     │     │  FOR_OPENCODE.md            │
  │                        │     │  → ~/.config/opencode/      │
  │ Agent Config:          │     │    Recall_GUIDE.md          │
  │  CLAUDE.md snippet     │     │                             │
  │                        │     │ Agent Config:               │
  └────────────────────────┘     │  agents/recall-memory.md    │
                                 │                             │
                                 │ Context Injection:          │
                                 │  plugins/recall-compaction  │
                                 │  pushes to output.context[] │
                                 └─────────────────────────────┘
```

## New Files

```
atlas-recall/
├── src/                          # UNCHANGED
├── hooks/
│   └── RecallExtract.ts         # UNCHANGED (Claude Code adapter)
│   └── RecallBatchExtract.ts           # MODIFIED — also scan opencode drop dir
├── opencode/                     # NEW — OpenCode adapter
│   ├── RecallExtract.ts         # Plugin: session extraction via CLI export
│   ├── RecallPreCompact.ts      # Plugin: context injection during compaction
│   ├── lib/session-export.ts     # Shared helpers — nested so OpenCode does not
│   │                             #   glob them as plugin factories
│   └── recall-memory.md          # Agent: memory-aware agent definition
├── docs/
│   ├── FOR_CLAUDE.md             # EXISTING — guide for Claude Code agents
│   ├── FOR_OPENCODE.md           # NEW — guide for OpenCode agents
│   └── OPENCODE_INTEGRATION.md   # THIS FILE
├── scripts/
│   ├── e2e-opencode.ts           # Pipeline e2e (export → drop → extract → search)
│   ├── e2e-opencode-runtime.ts   # Live-server e2e (discovery, idle frequency)
│   └── lib/opencode-runtime.ts   # Shared CLI pin, stub provider, event stream
├── install.sh                    # MODIFIED — detect + register for both platforms
└── package.json                  # MODIFIED — adds the isolated OpenCode e2e scripts
```

## Component Details

### 1. MCP Server Registration (opencode.json)

The installer writes this to `~/.config/opencode/opencode.json`:

```jsonc
{
  "mcp": {
    "recall-memory": {
      "type": "local",
      "command": ["bun", "run", "recall-mcp"],
      "enabled": true,
      "environment": {
        "RECALL_DB_PATH": "/Users/username/.agents/Recall/recall.db"
      }
    }
  }
}
```

**Key decisions:**
- Uses `recall-mcp` symlink (created via `bun link`) — consistent with Recall codebase and works across users
- Uses `bun run` to execute the symlinked binary
- `RECALL_DB_PATH` uses **absolute path** resolved at install time (not `~` — tilde doesn't expand in env vars)
- Same binary, same tools — zero platform-specific MCP code

### 2. Session Extraction Plugin (`opencode/RecallExtract.ts`)

**Current strategy:** The plugin uses OpenCode's current `event` hook, filters
`session.idle`, runs `opencode export <session-id>` for JSON, normalizes the
full `{ info, messages }` response to markdown, and only records the session
after the drop write succeeds. `RecallBatchExtract.ts` then owns extraction
quality, SQLite dual-write, and searchable retrieval.

Implementation details and regression coverage live in
[`opencode/RecallExtract.ts`](../opencode/RecallExtract.ts) and
[`tests/opencode-integration.test.ts`](../tests/opencode-integration.test.ts).

**Why this approach:**
- `opencode export` is the **verified current CLI command** — not an assumed API
- `ctx.$` Bun shell is **confirmed in plugin docs** with examples
- Persistent dedup via JSON file at `~/.agents/Recall/MEMORY/opencode-sessions/.extracted.json` — survives plugin restarts. It maps session ID to a digest of the markdown last written, so a grown session re-exports and an unchanged one does not
- The current payload is `event.properties.sessionID`; defensive fallbacks keep older property spellings harmless
- Drop directory pattern: `RecallBatchExtract.ts` already runs every 30 minutes and can scan this directory
- No new CLI commands needed — `RecallBatchExtract.ts` reads markdown files the same way it reads JSONL

**Measured runtime contract (OpenCode 1.18.5).** `session.idle` fires **once per
assistant turn**, not once per session. Measured by
`scripts/e2e-opencode-runtime.ts` against a live server: three turns of one
session produced exactly three `session.idle` events (delta 1 per turn), counted
from OpenCode's own `GET /event` stream inside a single long-lived process so
the number cannot be an artifact of process teardown.

That number drives the adapter's design, so it is asserted, not just recorded —
the runtime e2e fails if the frequency ever changes.

Two consequences:

- **Debouncing would be the wrong remedy.** Earlier drafts of this document
  hedged toward adding it. Because idle marks the end of each turn rather than
  the end of the session, the adapter must RE-export on later idles; suppressing
  them freezes the drop on turn 1 and silently discards the rest of the
  conversation. That was a real defect: a three-turn session left a 154-byte drop
  holding only the first turn.
- **The tracker records a content digest**, not "this session is finished". A
  grown session overwrites its earlier, shorter drop; an unchanged one costs no
  write. `RecallBatchExtract` already re-extracts a drop that grows, so the
  fuller transcript reaches memory without new machinery — but only once it
  grows past `GROWTH_THRESHOLD = 0.5` (`hooks/RecallBatchExtract.ts`): a drop
  extracted at size S is not re-extracted until it exceeds 1.5 × S, so the tail
  of a long session can sit in the drop file without reaching the database. The
  drop itself does hold every turn; it is the drop-to-SQLite step that is
  threshold-gated. Tracked in
  [#250](https://github.com/edheltzel/Recall/issues/250).

**Plugin module contract.** OpenCode calls **every export** of a top-level
`plugins/*.ts` as a plugin factory. A plugin entry point must therefore export
nothing but its factory — shared helpers live in `opencode/lib/session-export.ts`,
which OpenCode does not glob. When the helpers sat beside the factory, OpenCode
called `exportSession()` with its plugin context and logged
`failed to load plugin ... "Object is not a function"` on every launch.

**PATH requirement.** The plugin shells out to `opencode export <id>`, so the
`opencode` CLI must be resolvable by name from the environment OpenCode runs in.
If it is not, the export fails and the drop is never written; the failure is
reported on stderr and retried on the next idle.

### 3. Compaction Context Injection (`opencode/RecallPreCompact.ts`)

**Fixed to use verified hook signature:** `(input, output)` where `output.context` is an array you push strings into.

```typescript
// opencode/RecallPreCompact.ts
// Injects Recall memory context into OpenCode session compaction summaries.
//
// When OpenCode compresses a long session, this hook ensures persistent
// memory context survives the compaction by injecting it into the summary.

import type { Plugin } from "@opencode-ai/plugin"
import { execFileSync } from "child_process"

export const RecallCompaction: Plugin = async ({ project }) => {
  return {
    // Verified signature: (input, output) — NOT (event)
    // output.context is an array to push additional context strings into
    // output.prompt is a string that replaces the entire compaction prompt
    "experimental.session.compacting": async (input: any, output: any) => {
      try {
        const projectName = project?.name || project?.id || ""
        const context = execFileSync("recall", [
          "search", projectName, "--limit", "5"
        ], { encoding: "utf-8", timeout: 5000 })

        if (context.trim()) {
          output.context.push(
            `## Persistent Memory (from Recall)\n` +
            `The user has a persistent memory system. Key context:\n${context}`
          )
        }
      } catch {
        // recall CLI unavailable or timed out — skip silently
      }
    }
  }
}
```

**Changes from v1:**
- Hook signature: `(input, output)` not `(event)` — verified from official docs
- Pushes to `output.context[]` array — not `{ inject: "..." }` which was fabricated
- Added 5s timeout to `execFileSync` — prevents blocking compaction if `recall` hangs
- `project?.name || project?.id` — defensive project access

### 4. Agent Definition (`opencode/recall-memory.md`)

```markdown
---
description: Memory-aware agent with persistent Recall context
mode: all
tools:
  recall-memory_*: true
---

You have access to persistent memory via the recall-memory MCP server.

Before asking the user to repeat information, search memory first using
recall-memory_memory_search or recall-memory_memory_hybrid_search. For keyword
search, use `table` when you need only one record type; use `bias_type` when
that type should rank first while preserving other matching context.

When important decisions are made, record them with recall-memory_memory_add.

Before delegating to subagents via @agent mentions, call
recall-memory_context_for_agent to prepare relevant memory context.
```

### 5. FOR_OPENCODE.md (Agent Guide)

Equivalent to `FOR_CLAUDE.md` but with:
- OpenCode-specific tool name prefixes (`recall-memory_*`)
- `@agent` delegation syntax instead of Claude Code's Task tool
- Reference to `opencode export <session-id>` for manual session capture

### 6. Installer Changes

```bash
# Detection
detect_opencode() {
  if command -v opencode &>/dev/null; then
    OPENCODE_DETECTED=true
    OPENCODE_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
  fi
}

detect_claude_code() {
  if [[ -d "$HOME/.claude" ]]; then
    CLAUDE_CODE_DETECTED=true
  fi
}

# Registration for OpenCode — JSONC-safe config merge
register_opencode_mcp() {
  local config="$OPENCODE_CONFIG_DIR/opencode.json"
  local resolved_db_path
  resolved_db_path="$(eval echo "$RECALL_DB_PATH_DEFAULT")"  # Resolve ~ to absolute

  # Use the bundled dependency-free JSONC helper for a surgical merge.
  local mem_mcp_path
  mem_mcp_path="$(which recall-mcp 2>/dev/null || echo "$HOME/.bun/bin/recall-mcp")"

  recall_configure_opencode_mcp
}

# Plugin installation for OpenCode
install_opencode_plugin() {
  local plugin_dir="$OPENCODE_CONFIG_DIR/plugins"
  mkdir -p "$plugin_dir"
  cp opencode/RecallExtract.ts "$plugin_dir/"
  cp opencode/RecallPreCompact.ts "$plugin_dir/"
}

# Agent installation for OpenCode
install_opencode_agent() {
  local agent_dir="$OPENCODE_CONFIG_DIR/agents"
  mkdir -p "$agent_dir"
  cp opencode/recall-memory.md "$agent_dir/"
}

# Guide installation for OpenCode
install_opencode_guide() {
  cp docs/FOR_OPENCODE.md "$OPENCODE_CONFIG_DIR/Recall_GUIDE.md"
}
```

The live installer delegates to `lib/install-lib.sh`'s shared
`_recall_jsonc_merge_mcp_entry` helper and the bundled dependency-free
`lib/jsonc-mcp.ts` parser. It preserves comments, trailing commas, sibling MCP
entries, and custom Recall entry fields; malformed or unwritable configs fail
before writing. Uninstall uses the matching surgical removal helper, leaves a
malformed OpenCode config unchanged, and continues the remaining integrations.

## Database Schema Change

Add a `source` column to `sessions` table (the natural place — messages FK to sessions):

```sql
-- Migration v3: add source tracking
ALTER TABLE sessions ADD COLUMN source TEXT DEFAULT 'claude-code';
```

The extraction pipeline tags OpenCode sessions with `source: 'opencode'`. The historical migration preserves `claude-code` on legacy records; fresh host-neutral sessions default to `unknown` when no adapter supplies a source.

**No changes to MCP tools** — they return results from all sources. The `source` field is metadata for provenance, not filtering.

## RecallBatchExtract.ts Changes

The existing cron job needs one addition: scan the OpenCode drop directory alongside Claude Code's JSONL sessions.

```typescript
// In RecallBatchExtract.ts — add to the session discovery logic:
const RECALL_HOME = process.env.RECALL_HOME || join(homedir(), ".agents", "Recall")
const OPENCODE_DROP_DIR = join(RECALL_HOME, "MEMORY", "opencode-sessions")

function findOpenCodeSessions(): string[] {
  if (!existsSync(OPENCODE_DROP_DIR)) return []
  return readdirSync(OPENCODE_DROP_DIR)
    .filter(f => f.endsWith(".md") && !f.startsWith("."))
    .map(f => join(OPENCODE_DROP_DIR, f))
}
```

The extraction prompt already handles markdown input — it processes conversation text regardless of format.

## DB Location Strategy

| Scenario | DB Path | How |
|----------|---------|-----|
| Claude Code only (current) | `~/.agents/Recall/recall.db` | Default |
| OpenCode only | `~/.local/share/recall/recall.db` | `RECALL_DB_PATH` env var (legacy `MEM_DB_PATH` also honored) |
| Both platforms | `~/.agents/Recall/recall.db` | Shared, WAL mode handles concurrency |
| Custom | Any path | `RECALL_DB_PATH` env var (legacy `MEM_DB_PATH` also honored) |

All paths are **resolved to absolute** at install time. No tilde in stored config.

## Tool Name Mapping

OpenCode prefixes MCP tools with the server name + underscore:

| Claude Code | OpenCode | Same Tool |
|-------------|----------|-----------|
| `memory_search` | `recall-memory_memory_search` | Yes — includes `table` hard filters and `bias_type` soft boosts |
| `memory_hybrid_search` | `recall-memory_memory_hybrid_search` | Yes |
| `memory_recall` | `recall-memory_memory_recall` | Yes |
| `memory_add` | `recall-memory_memory_add` | Yes |
| `context_for_agent` | `recall-memory_context_for_agent` | Yes |
| `memory_stats` | `recall-memory_memory_stats` | Yes |
| `loa_show` | `recall-memory_loa_show` | Yes |

## Implementation Phases

### Phase 1: Core Integration (MCP + Installer)
- Installer detection for both platforms
- MCP registration in `opencode.json` with absolute paths
- JSONC-safe config parsing
- `FOR_OPENCODE.md` with correct tool names
- Agent definition `recall-memory.md`
- `source` column migration (schema v3)

### Phase 2: Extraction Plugin
- `RecallExtract.ts` plugin using the `opencode export` JSON CLI via `$` shell
- Persistent dedup tracker (`.extracted.json`, session ID → content digest)
- Defensive `session.idle` event property access
- Drop directory at `~/.agents/Recall/MEMORY/opencode-sessions/`
- `RecallBatchExtract.ts` updated to scan drop directory

### Phase 3: Context Injection
- `RecallPreCompact.ts` plugin with verified `(input, output)` signature
- Pushes to `output.context[]` array
- 5s timeout on `recall` CLI calls

### Phase 4: Testing + Polish — complete
- Isolated e2e: OpenCode session → JSON export → markdown drop → RecallBatchExtract → search
- Concurrent Claude and OpenCode writers against one disposable WAL database
- Installer/update idempotence, JSONC-preserving OpenCode uninstall, and the
  documented `install.sh restore` rollback plus collision-backup preservation
- Live-server verification: plugin discovery from the installed path, zero
  plugin load errors, the `session.idle` payload, and the measured one-idle-per
  -turn frequency

## Red Team Findings (v1 → v2 Changes)

| Flaw | Severity | Fix Applied |
|------|----------|-------------|
| `client.session.messages()` not on plugin client | BLOCKER | Replaced with `opencode export` JSON CLI |
| In-memory Set dedup | HIGH | Persistent JSON file at `.extracted.json` |
| `session.idle` wrong property name | MEDIUM-HIGH | Current `event` hook reads `properties.sessionID`; legacy spellings remain defensive fallbacks |
| Compacting return type fabricated | MEDIUM | Corrected to `output.context.push()` |
| Tilde in RECALL_DB_PATH | MEDIUM | Absolute path resolved at install |
| `recall import --source` doesn't exist | LOW-MEDIUM | Eliminated — uses drop dir + RecallBatchExtract |
| Bun not guaranteed | LOW-MEDIUM | Documented as requirement (same as Claude Code) |
| JSONC parsing | LOW | Bundled dependency-free parser performs surgical merge/removal, preserves comments, and refuses malformed writes |

## Phase 4 Evidence

Two scripts cover this, and they prove different things. Read the distinction
before citing either as evidence.

`scripts/e2e-opencode.ts` — **pipeline.** Imports the adapter directly and
supplies its own `$` and event payload. It proves Recall's handler ACCEPTS
`{type:'session.idle', properties:{sessionID}}` and that export -> drop ->
`RecallBatchExtract` -> search works, plus export-failure retry, concurrent WAL
writers, and installer/uninstall JSONC rollback. It does NOT prove OpenCode
emits that payload, and it cannot detect a plugin OpenCode never loads.

`scripts/e2e-opencode-runtime.ts` — **runtime.** Drives a live `opencode serve`
and closes exactly those gaps:

1. **Discovery.** Installs via the real `recall_install_opencode_platform`, then
   observes OpenCode load the plugin from that path (the factory's drop
   directory appears under a `RECALL_HOME` only this server knows) and asserts
   zero `failed to load plugin` errors.
2. **Emission and frequency.** Counts `session.idle` from OpenCode's own
   `GET /event` stream across three turns of one session in one long-lived
   process: 3 events, 1.00 per assistant turn, payload `properties.sessionID`.
3. **Completeness.** Asserts the drop carries every turn, and that
   `opencode export <session-id>` returns the whole conversation.

`opencode export <session-id>` is the supported JSON export command; Recall owns
JSON-to-markdown normalization because the CLI does not expose the old
`-f markdown -o` session-export interface.

Both scripts run in disposable HOME / XDG config, data, state, cache /
`RECALL_HOME` / database roots and fail if production DB metadata changes. The
runtime script serves the model from a local OpenAI-compatible stub: the subject
under test is OpenCode's session lifecycle, so a hosted model would only add
flakiness. The pinned version lives once, in
`scripts/lib/opencode-runtime.ts`.

### Not yet verified at runtime

`opencode/RecallPreCompact.ts` (compaction context injection) is covered only by
unit tests of its `(input, output)` contract. No test drives a real OpenCode
compaction, so its runtime behaviour is unproven — the README roadmap says so
rather than implying otherwise.

## Non-Goals

- Rewriting the MCP server for OpenCode
- Real-time sync between platforms (WAL + shared DB is sufficient)
- OpenCode-specific MCP tools (same tools serve both)
- Direct DB writes from plugin (CLI/drop-dir keeps plugin decoupled)
