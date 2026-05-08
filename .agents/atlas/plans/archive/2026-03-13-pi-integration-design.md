# Recall + Pi Integration Design

> Design document for extending Recall to work with the Pi coding agent alongside Claude Code and OpenCode.
> **Approach: MCP via pi-mcp-adapter — DRY across all platforms.**

## Executive Summary

Recall's core (SQLite DB, MCP server, CLI) is platform-agnostic. All three supported platforms — Claude Code, OpenCode, and Pi — connect to the same `recall-memory` MCP server exposing the same 7 tools. Each platform needs only thin adapter layers for registration, extraction, and instructions.

Pi does not support MCP natively (deliberate design decision by the author). The community `pi-mcp-adapter` package bridges this gap with lazy-loading (~200 tokens overhead vs. full tool descriptions). This keeps Recall's integration pattern DRY across all platforms rather than maintaining a separate Pi-specific tool registration layer.

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
│  └──────────────┘  └────────┬─────────┘  └────────────────────┘  │
│                             │                                     │
└─────────────────────────────┼─────────────────────────────────────┘
              ┌───────────────┼───────────────┐
              │               │               │
  ┌───────────┴───┐  ┌───────┴────────┐  ┌───┴──────────────────┐
  │ Claude Code    │  │ OpenCode       │  │ Pi                    │
  │                │  │                │  │                       │
  │ MCP: native    │  │ MCP: native    │  │ MCP: pi-mcp-adapter   │
  │ settings.json  │  │ opencode.json  │  │ ~/.pi/agent/mcp.json  │
  │                │  │                │  │                       │
  │ Extraction:    │  │ Extraction:    │  │ Extraction:           │
  │ Stop hook →    │  │ session.idle → │  │ session_shutdown →    │
  │ SessionExtract │  │ drop dir (.md) │  │ drop dir (.md)        │
  │                │  │                │  │                       │
  │ Instructions:  │  │ Instructions:  │  │ Instructions:         │
  │ FOR_CLAUDE.md  │  │ FOR_OPENCODE.md│  │ FOR_PI.md             │
  │ → CLAUDE.md    │  │ → agent def    │  │ → AGENTS.md snippet   │
  └────────────────┘  └────────────────┘  └───────────────────────┘
```

## Why MCP (Not Native Pi Tools)

Pi's `pi.registerTool()` API would let us register Recall tools natively without MCP. However:

1. **DRY principle** — Maintaining one MCP server is better than maintaining an MCP server + a parallel native tool wrapper layer
2. **Same tools, same behavior** — All platforms call the same `mem-mcp` binary, ensuring identical behavior
3. **pi-mcp-adapter handles the overhead** — Lazy-loads tools (~200 tokens via proxy tool), avoids the context-burn problem Pi's creator warns about
4. **Tool names are consistent** — `recall-memory_memory_search` on both OpenCode and Pi (server prefix mode)

The alternative (native `pi.registerTool()`) was considered and rejected in favor of consistency.

## New Files

```
atlas-recall/
├── pi/                              # NEW — Pi adapter
│   ├── recall-extract.ts            # Extension: session_shutdown → linearize → drop dir
│   └── recall-compaction.ts         # Extension: before_agent_start → sysprompt injection
├── FOR_PI.md                        # NEW — Agent guide for Pi
├── hooks/
│   └── BatchExtract.ts              # MODIFIED — scan ~/.claude/MEMORY/pi-sessions/
├── install.sh                       # MODIFIED — detect Pi, configure adapter, install extensions
└── docs/
    └── PI_INTEGRATION.md            # NEW — Architecture doc (like OPENCODE_INTEGRATION.md)
```

**Unchanged:** `src/`, `hooks/SessionExtract.ts`, `src/mcp-server.ts`, `src/db/schema.ts`. The `source` column in schema v3 already accepts arbitrary text values (no CHECK constraint).

## Database: Source Tagging

Pi sessions extracted via `BatchExtract` are tagged `source: 'pi'` in the `sessions` table. The `source` column (`TEXT DEFAULT 'claude-code'`) has no CHECK constraint, so `'pi'` is valid without a schema migration.

The source value is set by `SessionExtract.ts`'s `extractAndAppendMarkdown()` function. Currently it labels all markdown extractions as `opencode/<dirname>`. For Pi, the `project` field passed by `BatchExtract.findPiSessions()` is `'pi'` — the session label in `extractAndAppendMarkdown()` will use this to distinguish Pi sessions from OpenCode sessions.

**Note:** `extractAndAppendMarkdown()` currently hardcodes `sessionLabel = "opencode/${dirName}"`. This needs a small change to derive the label from the `project` field passed by BatchExtract (e.g., `pi/${dirName}` for Pi sessions, `opencode/${dirName}` for OpenCode sessions). This is a one-line change in `SessionExtract.ts` during Phase 1.

## Component Details

### 1. MCP Registration (`~/.pi/agent/mcp.json`)

The installer writes the adapter config:

```json
{
  "mcpServers": {
    "recall-memory": {
      "command": "mem-mcp",
      "args": [],
      "lifecycle": "lazy",
      "environment": {
        "MEM_DB_PATH": "/absolute/path/to/.claude/memory.db"
      }
    }
  }
}
```

**Key decisions:**
- `lifecycle: "lazy"` — server starts only when a tool is first called, disconnects after idle timeout
- `MEM_DB_PATH` uses absolute path resolved at install time (no tilde — env vars don't expand `~`)
- Same `mem-mcp` binary used by all three platforms
- Requires `pi-mcp-adapter` to be installed (`pi install npm:pi-mcp-adapter`)

### 2. Session Extraction Extension (`pi/recall-extract.ts`)

**Strategy:** Same drop-dir pattern as OpenCode. On `session_shutdown`, the extension reads Pi's tree-structured JSONL, linearizes the active branch into markdown, and drops it into `~/.claude/MEMORY/pi-sessions/`. BatchExtract picks it up.

```typescript
// pi/recall-extract.ts
// Pi extension: exports session as markdown to Recall's drop directory

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"

const DROP_DIR = join(homedir(), ".claude", "MEMORY", "pi-sessions")
const TRACKER_PATH = join(DROP_DIR, ".extraction_tracker.json")

// Persistent dedup tracker (same pattern as OpenCode)
function loadTracker(): Set<string> { /* ... */ }
function saveTracker(tracker: Set<string>): void { /* ... */ }

/**
 * Linearize Pi's tree-structured JSONL into a flat markdown transcript.
 * Walks from root following parentId chain on the active branch.
 */
function linearizeSession(jsonlPath: string): string {
  const content = readFileSync(jsonlPath, "utf-8")
  const entries = content.trim().split("\n").map(line => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(Boolean)

  // Build parent→children map
  const childrenOf = new Map<string | null, any[]>()
  for (const entry of entries) {
    const parent = entry.parentId || null
    if (!childrenOf.has(parent)) childrenOf.set(parent, [])
    childrenOf.get(parent)!.push(entry)
  }

  // Walk active branch (last child at each level = active)
  const transcript: string[] = []
  let currentId: string | null = null // root entries have no parentId

  function walkBranch(parentId: string | null) {
    const children = childrenOf.get(parentId) || []
    if (children.length === 0) return
    // Last child is the active branch (most recent)
    const active = children[children.length - 1]
    if (active.type === "message" && active.message) {
      const role = active.message.role?.toUpperCase() || "UNKNOWN"
      const text = typeof active.message.content === "string"
        ? active.message.content
        : JSON.stringify(active.message.content)
      if (text && text.length > 10) {
        transcript.push(`[${role}]: ${text.slice(0, 4000)}`)
      }
    }
    walkBranch(active.id)
  }

  walkBranch(null)
  return transcript.join("\n\n")
}

export default function (pi: any) {
  mkdirSync(DROP_DIR, { recursive: true })
  const tracker = loadTracker()

  pi.on("session_shutdown", async (_event: any, ctx: any) => {
    try {
      // Get session file path — try ctx.sessionManager first, fallback to scanning
      let sessionPath = ctx?.sessionManager?.currentSessionPath
        || ctx?.sessionManager?.currentSession?.path

      // Fallback: scan Pi's sessions directory for most recently modified .jsonl
      if (!sessionPath || !existsSync(sessionPath)) {
        const piSessionsDir = join(homedir(), ".pi", "agent", "sessions")
        if (existsSync(piSessionsDir)) {
          const { readdirSync, statSync } = require("fs")
          let latest = { path: "", mtime: 0 }
          for (const dir of readdirSync(piSessionsDir)) {
            const subdir = join(piSessionsDir, dir)
            try {
              for (const f of readdirSync(subdir)) {
                if (!f.endsWith(".jsonl")) continue
                const full = join(subdir, f)
                const mt = statSync(full).mtimeMs
                if (mt > latest.mtime) latest = { path: full, mtime: mt }
              }
            } catch {}
          }
          if (latest.path) sessionPath = latest.path
        }
      }

      if (!sessionPath || !existsSync(sessionPath)) return
      if (tracker.has(sessionPath)) return

      tracker.add(sessionPath)
      saveTracker(tracker)

      const markdown = linearizeSession(sessionPath)
      if (markdown.length < 500) return // Skip trivial sessions

      const fileName = sessionPath.split("/").pop()?.replace(".jsonl", ".md") || "session.md"
      writeFileSync(join(DROP_DIR, fileName), markdown, "utf-8")
    } catch {
      // Non-fatal — don't crash Pi on extraction failure
    }
  })
}
```

**Why markdown output (not JSONL):**
- Pi's tree-structured JSONL differs from Claude Code's linear JSONL
- Linearizing to markdown reuses the existing `--reextract-md` pipeline in SessionExtract/BatchExtract
- Zero changes needed to the extraction pipeline — it already handles `.md` files

**Tree linearization:** Pi sessions use `id`/`parentId` for branching. The extension walks the active branch (last child at each node) and extracts message content into `[ROLE]: content` format.

**Dedup:** Persistent `.extraction_tracker.json` in the drop dir (same pattern as OpenCode's `.extracted.json`).

### 3. Memory Injection Extension (`pi/recall-compaction.ts`)

Injects Recall memory context into Pi's system prompt before every agent turn, and provides memory context during compaction.

```typescript
// pi/recall-compaction.ts
// Pi extension: injects Recall memory into system prompt and compaction

import { execFileSync } from "child_process"

export default function (pi: any) {
  // Inject memory context before every agent turn
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    try {
      const cwd = ctx?.cwd || ""
      const projectName = cwd.split("/").pop() || ""

      const context = execFileSync("mem", [
        "search", projectName, "--limit", "5"
      ], { encoding: "utf-8", timeout: 5000 })

      if (context.trim()) {
        return {
          systemPrompt: event.systemPrompt +
            "\n\n## Persistent Memory (from Recall)\n" +
            "The user has a persistent memory system. Key context from previous sessions:\n" +
            context
        }
      }
    } catch {
      // mem CLI unavailable or timed out — skip silently
    }
  })
}
```

**Design decisions:**
- Uses `before_agent_start` (not `session_before_compact`) — memory is available on every turn, not just after compaction
- System prompt injection is per-turn only (doesn't persist in session), keeping things clean
- 5-second timeout on `mem` CLI prevents blocking Pi's agent loop
- Compaction doesn't need special handling — MCP tools remain available through the adapter regardless of compaction state

**API verification:**
- `before_agent_start` hook and `{ systemPrompt }` return value are **verified** from Pi's official extensions docs (`github.com/badlogic/pi-mono/packages/coding-agent/docs/extensions.md`). The handler receives `(event, ctx)` where `event.systemPrompt` is the current system prompt. Returning `{ systemPrompt: "..." }` replaces it for that turn only. Returning `{ message: { customType, content } }` injects a persistent message. Both verified with code examples in the docs.
- `session_shutdown` hook is **verified** from the same docs — fires on exit (Ctrl+C, Ctrl+D, SIGTERM), receives `(_event, ctx)`.
- `ctx.sessionManager` property access patterns are **unverified** — flagged in Open Questions with a fallback implementation.

### 4. Agent Instructions

**`FOR_PI.md`** — Full Recall guide for Pi agents. Installed to `~/.pi/agent/Recall_GUIDE.md`.

Content parallels `FOR_CLAUDE.md` and `FOR_OPENCODE.md` but adjusted for:
- Tool names with `recall-memory_` prefix (via pi-mcp-adapter's server prefix mode)
- Pi-specific conventions: no Task tool or `@agent` delegation — Pi uses slash commands
- Reference to `mem dump` for explicit session import to SQLite

**`AGENTS.md` snippet** — Appended to `~/.pi/agent/AGENTS.md` (Pi auto-loads this file):

```markdown
## MEMORY

You have persistent memory via Recall. **Read the full guide:** ~/.pi/agent/Recall_GUIDE.md

Core rules:
1. Before asking user to repeat anything → search first with `recall-memory_memory_search`
2. When decisions are made → record with `recall-memory_memory_add`
3. End of session when user says `/dump` → run `mem dump "Descriptive Title"`

Tool syntax:
- `recall-memory_memory_search({ query: "search terms" })`
- `recall-memory_memory_add({ type: "decision", content: "what", detail: "why" })`
- `recall-memory_context_for_agent({ task_description: "what the agent will do" })`
```

### 5. Installer Changes

```bash
# Detection
PI_DETECTED=false
PI_CONFIG_DIR="$HOME/.pi/agent"

detect_platforms() {
    # ... existing Claude Code + OpenCode detection ...
    if command -v pi &>/dev/null; then
        PI_DETECTED=true
        log_success "Detected: Pi"
    fi
}

# MCP adapter dependency
# pi install is idempotent (like npm install) — safe to run unconditionally
install_pi_adapter() {
    log_info "Ensuring pi-mcp-adapter is installed..."
    if pi install npm:pi-mcp-adapter 2>/dev/null; then
        log_success "pi-mcp-adapter ready"
    else
        log_warn "Could not install pi-mcp-adapter automatically"
        log_warn "Install manually: pi install npm:pi-mcp-adapter"
    fi
}

# MCP registration
configure_pi_mcp() {
    local config="$PI_CONFIG_DIR/mcp.json"
    local db_path_abs
    db_path_abs="$(eval echo "${MEM_DB_PATH:-$HOME/.claude/memory.db}")"

    mkdir -p "$PI_CONFIG_DIR"

    # JSONC-safe merge (same pattern as OpenCode)
    MCP_CONFIG_PATH="$config" \
    DB_PATH_ABS="$db_path_abs" \
    MEM_MCP_PATH="$(which mem-mcp 2>/dev/null || echo "$HOME/.bun/bin/mem-mcp")" \
    bun -e '
        const fs = require("fs");
        const path = process.env.MCP_CONFIG_PATH;

        let raw = "{}";
        if (fs.existsSync(path)) {
            raw = fs.readFileSync(path, "utf-8")
                .replace(/\/\/.*$/gm, "")
                .replace(/\/\*[\s\S]*?\*\//g, "");
        }

        const existing = JSON.parse(raw);
        existing.mcpServers = existing.mcpServers || {};
        existing.mcpServers["recall-memory"] = {
            command: process.env.MEM_MCP_PATH,
            args: [],
            lifecycle: "lazy",
            environment: {
                MEM_DB_PATH: process.env.DB_PATH_ABS
            }
        };
        fs.writeFileSync(path, JSON.stringify(existing, null, 2));
    '
    log_success "Registered recall-memory in Pi mcp.json"
}

# Extension installation
install_pi_extensions() {
    local ext_dir="$PI_CONFIG_DIR/extensions"
    mkdir -p "$ext_dir"
    cp pi/recall-extract.ts "$ext_dir/"
    cp pi/recall-compaction.ts "$ext_dir/"
    log_success "Installed Pi extensions"
}

# Guide + AGENTS.md
install_pi_guide() {
    cp FOR_PI.md "$PI_CONFIG_DIR/Recall_GUIDE.md"
    # Append to AGENTS.md (same pattern as CLAUDE.md)
    # ... (check for existing MEMORY section, append if missing)
}
```

**Backup:** `~/.pi/agent/mcp.json` and `~/.pi/agent/AGENTS.md` added to `FILES_TO_BACKUP`.

**Step 11 in `do_install()`:**
```bash
if [[ "$PI_DETECTED" == "true" ]]; then
    log_info "Step 11: Configuring Pi integration..."
    install_pi_adapter
    configure_pi_mcp
    install_pi_extensions
    install_pi_guide
fi
```

### 6. BatchExtract Changes

Add Pi session scanning alongside OpenCode:

```typescript
const PI_DROP_DIR = join(MEMORY_DIR, 'pi-sessions');

function findPiSessions(): { path: string; size: number; project: string; mtime: number }[] {
  if (!existsSync(PI_DROP_DIR)) return [];
  // Same pattern as findOpenCodeSessions() — scan for .md files
  return readdirSync(PI_DROP_DIR)
    .filter(f => f.endsWith('.md') && !f.startsWith('.'))
    .map(f => {
      const fullPath = join(PI_DROP_DIR, f);
      const stat = statSync(fullPath);
      return { path: fullPath, size: stat.size, project: 'pi', mtime: stat.mtimeMs };
    });
}

// In main():
const piSessions = findPiSessions();
const conversations = [...claudeConversations, ...opencodeConversations, ...piSessions];
```

Pi sessions use the same `--reextract-md` path as OpenCode sessions — no changes to `extractFile()` needed.

**Implementation note:** The log line at BatchExtract.ts:272 (`Found ${claudeConversations.length} Claude Code JSONL + ${opencodeConversations.length} OpenCode markdown files`) must also be updated to include the Pi session count.

## Implementation Phases

### Phase 1: Core Integration
- `pi/recall-extract.ts` — session extraction extension with tree linearization
- `pi/recall-compaction.ts` — memory injection via `before_agent_start`
- `FOR_PI.md` — agent guide with `recall-memory_` tool names
- `install.sh` — Pi detection, adapter install, MCP config, extension copy, AGENTS.md
- `BatchExtract.ts` — scan `pi-sessions/` drop directory

### Phase 2: Testing & Polish
- Test tree-structured JSONL linearization with synthetic Pi sessions
- Test `pi-mcp-adapter` config generation
- Test BatchExtract picks up Pi markdown sessions
- Installer rollback/restore for Pi configs
- All existing tests still pass
- End-to-end: Pi session → shutdown → drop dir → BatchExtract → search → retrieval

## Tool Name Mapping

With `pi-mcp-adapter`'s default `"server"` prefix mode, tools are named identically to OpenCode:

| Recall Tool | Pi (via adapter) | OpenCode | Claude Code |
|-------------|-----------------|----------|-------------|
| `memory_search` | `recall-memory_memory_search` | `recall-memory_memory_search` | `memory_search` |
| `memory_add` | `recall-memory_memory_add` | `recall-memory_memory_add` | `memory_add` |
| `memory_hybrid_search` | `recall-memory_memory_hybrid_search` | `recall-memory_memory_hybrid_search` | `memory_hybrid_search` |
| `memory_recall` | `recall-memory_memory_recall` | `recall-memory_memory_recall` | `memory_recall` |
| `context_for_agent` | `recall-memory_context_for_agent` | `recall-memory_context_for_agent` | `context_for_agent` |
| `memory_stats` | `recall-memory_memory_stats` | `recall-memory_memory_stats` | `memory_stats` |
| `loa_show` | `recall-memory_loa_show` | `recall-memory_loa_show` | `loa_show` |

## Open Questions

1. **`ctx.sessionManager.currentSessionPath`** — Does this property exist? Need to verify against Pi's source. **Mitigation:** Fallback implementation scans `~/.pi/agent/sessions/` for most recently modified JSONL file (already in the code).
2. **Pi session v3 message structure** — The `message.role` and `message.content` fields need verification against actual Pi JSONL output. Tree walking logic depends on this. **Mitigation:** Implementation will test with a real Pi session file during Phase 2.
3. **`pi-mcp-adapter` env var interpolation** — Does `${VAR}` in the config work, or do we need literal absolute paths? Docs suggest `${VAR}` syntax works. **Mitigation:** Installer uses literal absolute paths resolved at install time regardless (safe default).
4. **`pi install` in non-interactive context** — Does the installer's `pi install npm:pi-mcp-adapter` work when called from a bash script, or does it require an interactive session? **Mitigation:** Wrapped in `if/else` with a manual install fallback message.
5. **`pi install` idempotency** — Assumed idempotent based on npm conventions. If it errors on re-install, the installer's error handling (`2>/dev/null` + fallback warning) absorbs it gracefully.
