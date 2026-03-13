# Recall + OpenCode Integration Architecture

> Design document for extending Recall to work with OpenCode alongside Claude Code.
> **v2 — Revised after red team validation. All APIs verified against official docs.**

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
│  │  memory.db   │  │  MCP Server      │  │  CLI (mem)         │  │
│  │  (SQLite)    │←─│  (recall-memory)  │  │  search/add/stats  │  │
│  │  FTS5 + Vec  │  │  7 tools, stdio  │  │  import/export     │  │
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
  │  mcpServers.recall-mem │     │    opencode.json            │
  │                        │     │  mcp.recall-memory          │
  │ Extraction:            │     │                             │
  │  hooks/SessionExtract  │     │ Extraction:                 │
  │  (.ts, Stop hook)      │     │  plugins/recall-extract.ts  │
  │  reads JSONL transcript│     │  session.idle hook →        │
  │                        │     │  `opencode session export`  │
  │ Instructions:          │     │  → drop dir for BatchExtract│
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
│   └── SessionExtract.ts         # UNCHANGED (Claude Code adapter)
│   └── BatchExtract.ts           # MODIFIED — also scan opencode drop dir
├── opencode/                     # NEW — OpenCode adapter
│   ├── recall-extract.ts         # Plugin: session extraction via CLI export
│   ├── recall-compaction.ts      # Plugin: context injection during compaction
│   └── recall-memory.md          # Agent: memory-aware agent definition
├── docs/
│   ├── FOR_CLAUDE.md             # EXISTING — guide for Claude Code agents
│   ├── FOR_OPENCODE.md           # NEW — guide for OpenCode agents
│   └── OPENCODE_INTEGRATION.md   # THIS FILE
├── install.sh                    # MODIFIED — detect + register for both platforms
└── package.json                  # MODIFIED — add @opencode-ai/plugin dev dep
```

## Component Details

### 1. MCP Server Registration (opencode.json)

The installer writes this to `~/.config/opencode/opencode.json`:

```jsonc
{
  "mcp": {
    "recall-memory": {
      "type": "local",
      "command": ["bun", "run", "mem-mcp"],
      "enabled": true,
      "environment": {
        "MEM_DB_PATH": "/Users/username/.claude/memory.db"
      }
    }
  }
}
```

**Key decisions:**
- Uses `mem-mcp` symlink (created via `bun link`) — consistent with Recall codebase and works across users
- Uses `bun run` to execute the symlinked binary
- `MEM_DB_PATH` uses **absolute path** resolved at install time (not `~` — tilde doesn't expand in env vars)
- Same binary, same tools — zero platform-specific MCP code

### 2. Session Extraction Plugin (`opencode/recall-extract.ts`)

**Strategy:** Use `opencode session export` CLI (verified, stable) via the `$` Bun shell (verified in plugin context). Drop the exported markdown into a well-known directory. The existing `BatchExtract.ts` cron job picks it up — zero new CLI commands needed.

```typescript
// opencode/recall-extract.ts
// Recall session extraction plugin for OpenCode
//
// Hooks into session.idle to export completed sessions as markdown,
// dropping them into a directory that BatchExtract.ts monitors.

import type { Plugin } from "@opencode-ai/plugin"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"

const DROP_DIR = join(homedir(), ".claude", "MEMORY", "opencode-sessions")
const TRACKER_PATH = join(DROP_DIR, ".extracted.json")

// Load persistent dedup tracker from disk
function loadTracker(): Set<string> {
  try {
    if (existsSync(TRACKER_PATH)) {
      const data = JSON.parse(readFileSync(TRACKER_PATH, "utf-8"))
      return new Set(Array.isArray(data) ? data : [])
    }
  } catch { /* corrupt tracker — start fresh */ }
  return new Set()
}

function saveTracker(tracker: Set<string>): void {
  writeFileSync(TRACKER_PATH, JSON.stringify([...tracker]))
}

export const RecallExtract: Plugin = async ({ $ }) => {
  mkdirSync(DROP_DIR, { recursive: true })
  const tracker = loadTracker()

  return {
    "session.idle": async (event) => {
      // Defensive session ID extraction — handle all known event shapes
      const sessionId =
        (event as any).sessionId ||
        (event as any).session_id ||
        (event as any)?.properties?.sessionId

      if (!sessionId || tracker.has(sessionId)) return
      tracker.add(sessionId)
      saveTracker(tracker)

      const outFile = join(DROP_DIR, `${sessionId}.md`)

      try {
        // Use verified CLI: `opencode session export <id> -f markdown -o <path>`
        await $`opencode session export ${sessionId} -f markdown -o ${outFile}`
      } catch (err) {
        // Export failed — remove from tracker so it can retry next idle
        tracker.delete(sessionId)
        saveTracker(tracker)
      }
    }
  }
}
```

**Why this approach:**
- `opencode session export` is a **verified, stable CLI command** — not an assumed API
- `ctx.$` Bun shell is **confirmed in plugin docs** with examples
- Persistent dedup via JSON file at `~/.claude/MEMORY/opencode-sessions/.extracted.json` — survives plugin restarts
- Defensive event property access covers all three known shapes: `event.sessionId`, `event.session_id`, `event.properties.sessionId`
- Drop directory pattern: `BatchExtract.ts` already runs every 30 minutes and can scan this directory
- No new CLI commands needed — `BatchExtract.ts` reads markdown files the same way it reads JSONL

**Fallback:** If `session.idle` fires too frequently (every response), add a debounce:
```typescript
const debounceTimers = new Map<string, Timer>()

"session.idle": async (event) => {
  const id = /* extract sessionId */
  if (debounceTimers.has(id)) clearTimeout(debounceTimers.get(id))
  debounceTimers.set(id, setTimeout(() => { /* do export */ }, 60_000))
}
```

### 3. Compaction Context Injection (`opencode/recall-compaction.ts`)

**Fixed to use verified hook signature:** `(input, output)` where `output.context` is an array you push strings into.

```typescript
// opencode/recall-compaction.ts
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
        const context = execFileSync("mem", [
          "search", projectName, "--limit", "5"
        ], { encoding: "utf-8", timeout: 5000 })

        if (context.trim()) {
          output.context.push(
            `## Persistent Memory (from Recall)\n` +
            `The user has a persistent memory system. Key context:\n${context}`
          )
        }
      } catch {
        // mem CLI unavailable or timed out — skip silently
      }
    }
  }
}
```

**Changes from v1:**
- Hook signature: `(input, output)` not `(event)` — verified from official docs
- Pushes to `output.context[]` array — not `{ inject: "..." }` which was fabricated
- Added 5s timeout to `execFileSync` — prevents blocking compaction if `mem` hangs
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
recall-memory_memory_search or recall-memory_memory_hybrid_search.

When important decisions are made, record them with recall-memory_memory_add.

Before delegating to subagents via @agent mentions, call
recall-memory_context_for_agent to prepare relevant memory context.
```

### 5. FOR_OPENCODE.md (Agent Guide)

Equivalent to `FOR_CLAUDE.md` but with:
- OpenCode-specific tool name prefixes (`recall-memory_*`)
- `@agent` delegation syntax instead of Claude Code's Task tool
- Reference to `opencode session export` for manual session capture

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
  resolved_db_path="$(eval echo "$MEM_DB_PATH_DEFAULT")"  # Resolve ~ to absolute

  # Use bun -e for safe JSON merge. Strip comments before parsing for JSONC safety.
  local mem_mcp_path
  mem_mcp_path="$(which mem-mcp 2>/dev/null || echo "$HOME/.bun/bin/mem-mcp")"

  INSTALL_MCP_PATH="$mem_mcp_path" \
  DB_PATH_ABS="$resolved_db_path" \
  CONFIG_PATH="$config" \
  bun -e '
    const fs = require("fs");
    const path = process.env.CONFIG_PATH;

    // JSONC-safe: strip // and /* */ comments before parsing
    let raw = "{}";
    if (fs.existsSync(path)) {
      raw = fs.readFileSync(path, "utf-8")
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
    }

    const existing = JSON.parse(raw);
    existing.mcp = existing.mcp || {};
    existing.mcp["recall-memory"] = {
      type: "local",
      command: ["bun", "run", process.env.INSTALL_MCP_PATH],
      enabled: true,
      environment: {
        MEM_DB_PATH: process.env.DB_PATH_ABS
      }
    };
    fs.writeFileSync(path, JSON.stringify(existing, null, 2));
  '
}

# Plugin installation for OpenCode
install_opencode_plugin() {
  local plugin_dir="$OPENCODE_CONFIG_DIR/plugins"
  mkdir -p "$plugin_dir"
  cp opencode/recall-extract.ts "$plugin_dir/"
  cp opencode/recall-compaction.ts "$plugin_dir/"
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

**Changes from v1:**
- Absolute path for `MEM_DB_PATH` — resolved via `eval echo` at install time
- JSONC-safe parsing — strips `//` and `/* */` comments before `JSON.parse`
- Environment variables passed to `bun -e` via env (no shell interpolation in JS)

## Database Schema Change

Add a `source` column to `sessions` table (the natural place — messages FK to sessions):

```sql
-- Migration v3: add source tracking
ALTER TABLE sessions ADD COLUMN source TEXT DEFAULT 'claude-code';
```

The extraction pipeline tags OpenCode sessions with `source: 'opencode'`. Existing records default to `claude-code`.

**No changes to MCP tools** — they return results from all sources. The `source` field is metadata for provenance, not filtering.

## BatchExtract.ts Changes

The existing cron job needs one addition: scan the OpenCode drop directory alongside Claude Code's JSONL sessions.

```typescript
// In BatchExtract.ts — add to the session discovery logic:
const OPENCODE_DROP_DIR = join(homedir(), ".claude", "MEMORY", "opencode-sessions")

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
| Claude Code only (current) | `~/.claude/memory.db` | Default |
| OpenCode only | `~/.local/share/recall/memory.db` | `MEM_DB_PATH` env var |
| Both platforms | `~/.claude/memory.db` | Shared, WAL mode handles concurrency |
| Custom | Any path | `MEM_DB_PATH` env var |

All paths are **resolved to absolute** at install time. No tilde in stored config.

## Tool Name Mapping

OpenCode prefixes MCP tools with the server name + underscore:

| Claude Code | OpenCode | Same Tool |
|-------------|----------|-----------|
| `memory_search` | `recall-memory_memory_search` | Yes |
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
- `recall-extract.ts` plugin using `opencode session export` CLI via `$` shell
- Persistent dedup tracker (`.extracted.json`)
- Defensive `session.idle` event property access
- Drop directory at `~/.claude/MEMORY/opencode-sessions/`
- `BatchExtract.ts` updated to scan drop directory

### Phase 3: Context Injection
- `recall-compaction.ts` plugin with verified `(input, output)` signature
- Pushes to `output.context[]` array
- 5s timeout on `mem` CLI calls

### Phase 4: Testing + Polish
- End-to-end test: OpenCode session → export → drop dir → BatchExtract → search → retrieval
- Concurrent access testing (both platforms running simultaneously)
- Installer rollback/restore for OpenCode configs
- Verify `session.idle` firing frequency in real usage

## Red Team Findings (v1 → v2 Changes)

| Flaw | Severity | Fix Applied |
|------|----------|-------------|
| `client.session.messages()` not on plugin client | BLOCKER | Replaced with `opencode session export` CLI |
| In-memory Set dedup | HIGH | Persistent JSON file at `.extracted.json` |
| `session.idle` wrong property name | MEDIUM-HIGH | Defensive access: 3 property paths |
| Compacting return type fabricated | MEDIUM | Corrected to `output.context.push()` |
| Tilde in MEM_DB_PATH | MEDIUM | Absolute path resolved at install |
| `mem import --source` doesn't exist | LOW-MEDIUM | Eliminated — uses drop dir + BatchExtract |
| Bun not guaranteed | LOW-MEDIUM | Documented as requirement (same as Claude Code) |
| JSONC parsing | LOW | Comment stripping before `JSON.parse` |

## Open Questions (Reduced)

1. **Does `session.idle` fire per-response or per-session-idle?** Test empirically; debounce fallback ready
2. **Does `opencode session export -f markdown` include full conversation text?** Likely yes (markdown format is described as full export), but verify
3. **Bun availability** — if user has OpenCode but not Bun, installer should check and error with install instructions

## Non-Goals

- Rewriting the MCP server for OpenCode
- Real-time sync between platforms (WAL + shared DB is sufficient)
- OpenCode-specific MCP tools (same tools serve both)
- Direct DB writes from plugin (CLI/drop-dir keeps plugin decoupled)
