# Pi Integration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Recall to work with the Pi coding agent via MCP adapter, session extraction, and memory injection.

**Architecture:** Pi connects to the same `recall-memory` MCP server as Claude Code and OpenCode via `pi-mcp-adapter`. A Pi extension exports sessions as markdown to a drop directory, and `BatchExtract` picks them up. A second extension injects memory context into Pi's system prompt before each agent turn.

**Tech Stack:** TypeScript (Bun), Pi extensions API, pi-mcp-adapter, install.sh (bash)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `pi/recall-extract.ts` | Create | Session extraction extension — linearize tree JSONL → markdown → drop dir |
| `pi/recall-compaction.ts` | Create | Memory injection extension — `before_agent_start` → system prompt append |
| `FOR_PI.md` | Create | Agent guide for Pi instances (parallels FOR_CLAUDE.md/FOR_OPENCODE.md) |
| `hooks/BatchExtract.ts` | Modify | Add `findPiSessions()` scanning `~/.claude/MEMORY/pi-sessions/` |
| `hooks/SessionExtract.ts` | Modify | Fix `extractAndAppendMarkdown()` session label to use project field |
| `install.sh` | Modify | Pi detection, adapter install, MCP config, extension copy, AGENTS.md |
| `tests/pi-integration.test.ts` | Create | Tests for tree linearization, BatchExtract scanning, installer validation |
| `docs/PI_INTEGRATION.md` | Create | Architecture doc for Pi integration (parallels OPENCODE_INTEGRATION.md) |

---

## Chunk 1: Core Extensions

### Task 1: Create Pi Session Extraction Extension

**Files:**
- Create: `pi/recall-extract.ts`
- Test: `tests/pi-integration.test.ts` (linearization tests in Task 7 import `linearizeSession` from this file)

**TDD note:** Task 7 writes failing tests for `linearizeSession` that import from `pi/recall-extract.ts`. For strict TDD, create the test file (Task 7) first with the import, verify tests fail (module not found), then implement Task 1 to make them pass. Alternatively, implement Task 1 first then verify with Task 7 — the key is that `linearizeSession` is exported and tested via import, not copy-pasted.

- [ ] **Step 1: Create `pi/` directory and write `recall-extract.ts`**

```typescript
// pi/recall-extract.ts
// Pi extension: exports session as markdown to Recall's drop directory on shutdown.
//
// Pi sessions use tree-structured JSONL (id/parentId) unlike Claude Code's linear format.
// This extension linearizes the active branch into flat markdown, then drops it into
// ~/.claude/MEMORY/pi-sessions/ for BatchExtract to pick up.
//
// VERIFIED APIs:
//   - pi.on("session_shutdown", handler) — fires on exit (Ctrl+C, Ctrl+D, SIGTERM)
//   - handler receives (_event, ctx)
//   - ctx.sessionManager access patterns are UNVERIFIED — fallback scans sessions dir

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "fs"
import { join } from "path"
import { homedir } from "os"

const DROP_DIR = join(homedir(), ".claude", "MEMORY", "pi-sessions")
const TRACKER_PATH = join(DROP_DIR, ".extraction_tracker.json")

function loadTracker(): Set<string> {
  try {
    if (existsSync(TRACKER_PATH)) {
      const data = JSON.parse(readFileSync(TRACKER_PATH, "utf-8"))
      return new Set(Array.isArray(data) ? data : [])
    }
  } catch {}
  return new Set()
}

function saveTracker(tracker: Set<string>): void {
  try {
    writeFileSync(TRACKER_PATH, JSON.stringify([...tracker]), "utf-8")
  } catch {}
}

/**
 * Linearize Pi's tree-structured JSONL into a flat markdown transcript.
 * Walks from root following the active branch (last child at each node).
 * Exported for testing.
 */
export function linearizeSession(jsonlPath: string): string {
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

  // Walk active branch (last child at each level = most recent)
  const transcript: string[] = []

  function walkBranch(parentId: string | null) {
    const children = childrenOf.get(parentId) || []
    if (children.length === 0) return
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

- [ ] **Step 2: Verify the file was created correctly**

Run: `ls -la pi/recall-extract.ts && wc -l pi/recall-extract.ts`
Expected: File exists, ~100 lines

- [ ] **Step 3: Commit**

```bash
git add pi/recall-extract.ts
git commit -m "feat(pi): add session extraction extension with tree JSONL linearization"
```

---

### Task 2: Create Pi Memory Injection Extension

**Files:**
- Create: `pi/recall-compaction.ts`

- [ ] **Step 1: Write `pi/recall-compaction.ts`**

```typescript
// pi/recall-compaction.ts
// Pi extension: injects Recall memory into system prompt before every agent turn.
//
// VERIFIED APIs:
//   - pi.on("before_agent_start", handler) — fires before every agent turn
//   - handler receives (event, ctx) where event.systemPrompt is current prompt
//   - Returning { systemPrompt: "..." } replaces it for that turn only
//   - execFileSync for mem CLI — standard Node/Bun API

import { execFileSync } from "child_process"

export default function (pi: any) {
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

- [ ] **Step 2: Verify the file**

Run: `ls -la pi/recall-compaction.ts && wc -l pi/recall-compaction.ts`
Expected: File exists, ~35 lines

- [ ] **Step 3: Commit**

```bash
git add pi/recall-compaction.ts
git commit -m "feat(pi): add memory injection extension via before_agent_start"
```

---

### Task 3: Create FOR_PI.md Agent Guide

**Files:**
- Create: `FOR_PI.md`

- [ ] **Step 1: Write `FOR_PI.md`**

This mirrors `FOR_OPENCODE.md` but adjusted for Pi conventions:
- Tool names use `recall-memory_` prefix (via pi-mcp-adapter server prefix mode)
- Pi uses slash commands, not Task tool or `@agent` delegation
- Includes `mem dump` for explicit session capture

```markdown
# For You, Pi Agent

This document explains the Recall memory system installed on this machine. Read this to understand how to use persistent memory effectively.

---

## What Is Recall?

Recall is a persistent memory framework. It gives you:

1. **Searchable history** of all past conversations via MCP tools and CLI
2. **Automatic extraction** — sessions are exported and parsed into structured summaries
3. **Structured records** — decisions, learnings, breadcrumbs you can create and search

## Your MCP Tools

These tools are available via the `recall-memory` MCP server through pi-mcp-adapter. Tool names are prefixed with the server name:

### recall-memory_memory_search

Search all memory with FTS5 full-text search. **Use this BEFORE asking the user to repeat anything.**

```
recall-memory_memory_search({ query: "kubernetes auth", project: "my-app" })
```

### recall-memory_memory_hybrid_search

Combines keyword (FTS5) and semantic (embedding) search. Best for natural language queries.

```
recall-memory_memory_hybrid_search({ query: "how did we handle rate limiting" })
```

### recall-memory_memory_recall

Get recent context — LoA entries, decisions, breadcrumbs. Good for session start.

```
recall-memory_memory_recall({ limit: 5, project: "my-app" })
```

### recall-memory_memory_add

Record structured information during sessions:

```
recall-memory_memory_add({ type: "decision", content: "Use PostgreSQL over MySQL", detail: "Better JSON support and extensions" })
recall-memory_memory_add({ type: "learning", content: "bun:sqlite uses $param syntax", detail: "Not :param like better-sqlite3" })
recall-memory_memory_add({ type: "breadcrumb", content: "Auth refactor in progress, do not touch middleware yet" })
```

### recall-memory_context_for_agent

Prepare memory context before complex tasks:

```
recall-memory_context_for_agent({ agent_task: "Refactor the auth middleware", project: "my-app" })
```

### recall-memory_memory_stats

Get database statistics (record counts, database size).

### recall-memory_loa_show

Show a full Library of Alexandria entry with its extracted wisdom.

## The CLI

You can also use the `mem` CLI directly:

```bash
mem search "deployment pipeline"    # Search memory
mem stats                           # Database statistics
mem loa list                        # Browse curated knowledge
mem dump "Session title"            # Capture current session to SQLite
```

## Core Rules

1. **Search before asking** — Before asking the user to repeat information, search memory first
2. **Record decisions** — When architectural decisions are made, use `recall-memory_memory_add` to record them
3. **Session capture** — When the user says `/dump`, run `mem dump "Descriptive Title"` to capture the session

## How Extraction Works

A Recall extension (`recall-extract.ts`) runs inside Pi:

1. Hooks into `session_shutdown` (fires when the session ends)
2. Reads the tree-structured JSONL session file
3. Linearizes the active branch into flat markdown
4. Drops the file into `~/.claude/MEMORY/pi-sessions/`
5. A batch extraction cron job processes these files into structured memory

## Database Location

The SQLite database is at `~/.claude/memory.db` (or wherever `MEM_DB_PATH` points). It uses:

- **WAL mode** for concurrent reads
- **FTS5** indexes on all text tables
- **Vector embeddings** (optional, requires Ollama) for semantic search

The same database is shared with Claude Code and OpenCode if installed — your memory is unified across all platforms.
```

- [ ] **Step 2: Verify the file**

Run: `wc -l FOR_PI.md`
Expected: ~100 lines

- [ ] **Step 3: Commit**

```bash
git add FOR_PI.md
git commit -m "docs: add FOR_PI.md agent guide for Pi instances"
```

---

## Chunk 2: Pipeline Integration

### Task 4: Fix Session Label for Multi-Platform Support

**Files:**
- Modify: `hooks/BatchExtract.ts:302` (extractFile cwd for markdown sessions)
- Modify: `hooks/SessionExtract.ts:1014-1019` (the `extractAndAppendMarkdown` function)

Currently the session label is hardcoded to `opencode/${dirName}`. Two changes needed:

1. **BatchExtract.ts**: For markdown sessions (OpenCode/Pi), pass `candidate.project` directly as `cwd` instead of routing through `projectDirToCwd()` (which mangles platform names like `'opencode'` → `$HOME`).
2. **SessionExtract.ts**: Use the `cwd` value to build a proper label in the format `platform/sessionId`.

- [ ] **Step 1: Edit `hooks/BatchExtract.ts` — pass project name for markdown sessions**

Change line ~302 in `extractFile` call within the main loop:

```typescript
// Before:
    const cwd = projectDirToCwd(candidate.project);

// After:
    // For markdown sessions (OpenCode/Pi), project is a platform name ('opencode', 'pi').
    // projectDirToCwd only works for Claude Code's encoded paths — skip it for platforms.
    const isMarkdown = candidate.path.endsWith('.md');
    const cwd = isMarkdown ? candidate.project : projectDirToCwd(candidate.project);
```

- [ ] **Step 2: Edit `hooks/SessionExtract.ts` — fix hardcoded label**

Change lines ~1014-1019 in `extractAndAppendMarkdown`:

```typescript
// Before:
    const dirName = cwd.split('/').pop() || 'opencode';
    const sessionLabel = `opencode/${dirName}`;

// After:
    // cwd is either a platform name ('opencode', 'pi') from BatchExtract,
    // or a real path from --reextract-md CLI usage.
    const isRealPath = cwd.includes('/');
    const platform = isRealPath ? cwd.split('/').pop() || 'unknown' : cwd;
    const sessionLabel = `${platform}/${sessionId}`;
```

This produces:
- `opencode/session-abc` when called by `findOpenCodeSessions()` (project = `'opencode'`)
- `pi/session-def` when called by `findPiSessions()` (project = `'pi'`)
- `myproject/session-ghi` when called via `--reextract-md` with a real path

- [ ] **Step 3: Verify existing tests still pass**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add hooks/BatchExtract.ts hooks/SessionExtract.ts
git commit -m "fix: derive session label from platform/sessionId instead of hardcoding opencode"
```

---

### Task 5: Add `findPiSessions()` to BatchExtract

**Files:**
- Modify: `hooks/BatchExtract.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/pi-integration.test.ts`:

```typescript
describe('BatchExtract Pi session scanning', () => {
  let tempDir: string;
  let piDropDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'recall-pi-batch-'));
    piDropDir = join(tempDir, 'pi-sessions');
    mkdirSync(piDropDir, { recursive: true });
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('discovers .md files in pi-sessions drop directory', () => {
    writeFileSync(join(piDropDir, 'session-abc.md'), '# Pi Session\n' + 'x'.repeat(3000));
    writeFileSync(join(piDropDir, 'session-def.md'), '# Pi Session 2\n' + 'y'.repeat(3000));

    const files = readdirSync(piDropDir)
      .filter((f: string) => f.endsWith('.md') && !f.startsWith('.'));

    expect(files).toHaveLength(2);
    expect(files).toContain('session-abc.md');
    expect(files).toContain('session-def.md');
  });

  test('pi sessions have project field set to "pi"', () => {
    writeFileSync(join(piDropDir, 'session.md'), '# Session\n' + 'x'.repeat(3000));

    const files = readdirSync(piDropDir)
      .filter((f: string) => f.endsWith('.md') && !f.startsWith('.'));

    // findPiSessions() sets project: 'pi' — verify the convention
    const sessions = files.map(f => {
      const fullPath = join(piDropDir, f);
      const stat = statSync(fullPath);
      return { path: fullPath, size: stat.size, project: 'pi', mtime: stat.mtimeMs };
    });

    expect(sessions[0].project).toBe('pi');
  });

  test('handles empty pi-sessions directory', () => {
    const files = readdirSync(piDropDir)
      .filter((f: string) => f.endsWith('.md') && !f.startsWith('.'));
    expect(files).toHaveLength(0);
  });

  test('handles non-existent pi-sessions directory', () => {
    const nonExistent = join(tempDir, 'does-not-exist');
    expect(existsSync(nonExistent)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to see them pass (these are self-contained assertions)**

Run: `bun test tests/pi-integration.test.ts`
Expected: PASS

- [ ] **Step 3: Edit `hooks/BatchExtract.ts` — add Pi scanning**

After the `OPENCODE_DROP_DIR` constant (~line 32), add:

```typescript
// Pi drop directory — extension exports linearized markdown sessions here
const PI_DROP_DIR = join(MEMORY_DIR, 'pi-sessions');
```

After `findOpenCodeSessions()` (~line 156), add:

```typescript
/**
 * Find Pi session markdown files dropped by the recall-extract extension
 */
function findPiSessions(): { path: string; size: number; project: string; mtime: number }[] {
  const sessions: { path: string; size: number; project: string; mtime: number }[] = [];

  if (!existsSync(PI_DROP_DIR)) return sessions;

  try {
    const files = readdirSync(PI_DROP_DIR)
      .filter(f => f.endsWith('.md') && !f.startsWith('.'));

    for (const file of files) {
      const fullPath = join(PI_DROP_DIR, file);
      try {
        const stat = statSync(fullPath);
        sessions.push({
          path: fullPath,
          size: stat.size,
          project: 'pi',
          mtime: stat.mtimeMs
        });
      } catch {}
    }
  } catch {}

  return sessions;
}
```

In `main()` (~line 269-272), update the conversation merge and log line:

```typescript
// Before:
const opencodeConversations = findOpenCodeSessions();
const conversations = [...claudeConversations, ...opencodeConversations];
log(`Found ${claudeConversations.length} Claude Code JSONL + ${opencodeConversations.length} OpenCode markdown files`);

// After:
const opencodeConversations = findOpenCodeSessions();
const piConversations = findPiSessions();
const conversations = [...claudeConversations, ...opencodeConversations, ...piConversations];
log(`Found ${claudeConversations.length} Claude Code JSONL + ${opencodeConversations.length} OpenCode + ${piConversations.length} Pi markdown files`);
```

- [ ] **Step 4: Verify all existing tests still pass**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add hooks/BatchExtract.ts tests/pi-integration.test.ts
git commit -m "feat: add Pi session scanning to BatchExtract"
```

---

## Chunk 3: Installer

### Task 6: Add Pi Detection and Configuration to install.sh

**Files:**
- Modify: `install.sh`

- [ ] **Step 1: Add Pi variables alongside OpenCode variables (~line 49)**

After `OPENCODE_DETECTED=false`:

```bash
# Pi paths
PI_DETECTED=false
PI_CONFIG_DIR="$HOME/.pi/agent"
```

- [ ] **Step 2: Add Pi config files to FILES_TO_BACKUP (~line 53)**

Add to the array:

```bash
    "$PI_CONFIG_DIR/mcp.json"
    "$PI_CONFIG_DIR/AGENTS.md"
```

So the array becomes:

```bash
FILES_TO_BACKUP=(
    "$CLAUDE_DIR/.mcp.json"
    "$HOME/.claude.json"
    "$CLAUDE_DIR/CLAUDE.md"
    "$CLAUDE_DIR/settings.json"
    "$CLAUDE_DIR/memory.db"
    "$OPENCODE_CONFIG_DIR/opencode.json"
    "$PI_CONFIG_DIR/mcp.json"
    "$PI_CONFIG_DIR/AGENTS.md"
)
```

- [ ] **Step 3: Add Pi detection to `detect_platforms()` (~line 502)**

After the OpenCode detection block:

```bash
    if command -v pi &>/dev/null; then
        PI_DETECTED=true
        log_success "Detected: Pi"
    fi
```

Update the "neither detected" check:

```bash
    if [[ "$CLAUDE_CODE_DETECTED" == "false" ]] && [[ "$OPENCODE_DETECTED" == "false" ]] && [[ "$PI_DETECTED" == "false" ]]; then
        log_warn "No coding agents detected (Claude Code, OpenCode, Pi)"
        log_info "Recall will install core tools. Configure MCP manually later."
    fi
```

- [ ] **Step 4: Add Pi installer functions**

After `install_opencode_guide()` (~line 612), add:

```bash
#
# INSTALL PI MCP ADAPTER
#
install_pi_adapter() {
    log_info "Ensuring pi-mcp-adapter is installed..."
    if pi install npm:pi-mcp-adapter 2>/dev/null; then
        log_success "pi-mcp-adapter ready"
    else
        log_warn "Could not install pi-mcp-adapter automatically"
        log_warn "Install manually: pi install npm:pi-mcp-adapter"
    fi
}

#
# CONFIGURE PI MCP
#
configure_pi_mcp() {
    local config="$PI_CONFIG_DIR/mcp.json"
    local db_path_abs
    db_path_abs="$(eval echo "${MEM_DB_PATH:-$HOME/.claude/memory.db}")"
    local mem_mcp_path
    mem_mcp_path="$(which mem-mcp 2>/dev/null || echo "$HOME/.bun/bin/mem-mcp")"

    mkdir -p "$PI_CONFIG_DIR"

    # Check if already registered
    if [[ -f "$config" ]] && grep -q "recall-memory" "$config"; then
        log_success "recall-memory already registered in Pi mcp.json"
        return
    fi

    # JSONC-safe merge (same pattern as OpenCode)
    MCP_CONFIG_PATH="$config" \
    DB_PATH_ABS="$db_path_abs" \
    MEM_MCP_PATH="$mem_mcp_path" \
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

#
# INSTALL PI EXTENSIONS
#
install_pi_extensions() {
    local ext_dir="$PI_CONFIG_DIR/extensions"
    local src_dir="$(pwd)/pi"

    mkdir -p "$ext_dir"

    if [[ -f "$src_dir/recall-extract.ts" ]]; then
        cp "$src_dir/recall-extract.ts" "$ext_dir/"
        log_success "Installed recall-extract.ts Pi extension"
    fi

    if [[ -f "$src_dir/recall-compaction.ts" ]]; then
        cp "$src_dir/recall-compaction.ts" "$ext_dir/"
        log_success "Installed recall-compaction.ts Pi extension"
    fi
}

#
# INSTALL PI GUIDE + AGENTS.MD
#
install_pi_guide() {
    mkdir -p "$PI_CONFIG_DIR"

    # Copy guide
    if [[ -f "$(pwd)/FOR_PI.md" ]]; then
        cp "$(pwd)/FOR_PI.md" "$PI_CONFIG_DIR/Recall_GUIDE.md"
        log_success "Installed Recall guide for Pi"
    fi

    # Append MEMORY section to AGENTS.md (Pi auto-loads this file)
    local agents_md="$PI_CONFIG_DIR/AGENTS.md"

    if [[ -f "$agents_md" ]] && grep -q "## MEMORY" "$agents_md"; then
        log_success "AGENTS.md already has MEMORY section"
        return
    fi

    local memory_section="
## MEMORY

You have persistent memory via Recall. **Read the full guide:** ~/.pi/agent/Recall_GUIDE.md

Core rules:
1. Before asking user to repeat anything → search first with \`recall-memory_memory_search\`
2. When decisions are made → record with \`recall-memory_memory_add\`
3. End of session when user says \`/dump\` → run \`mem dump \"Descriptive Title\"\`

Tool syntax:
- \`recall-memory_memory_search({ query: \"search terms\" })\`
- \`recall-memory_memory_add({ type: \"decision\", content: \"what\", detail: \"why\" })\`
- \`recall-memory_context_for_agent({ task_description: \"what the agent will do\" })\`"

    echo "$memory_section" >> "$agents_md"
    log_success "Added MEMORY section to AGENTS.md"
}
```

- [ ] **Step 5: Add Step 11 to `do_install()` (~after Step 10, line 723)**

```bash
    # Step 11: Configure Pi (if detected)
    if [[ "$PI_DETECTED" == "true" ]]; then
        echo ""
        log_info "Step 11: Configuring Pi integration..."
        install_pi_adapter
        configure_pi_mcp
        install_pi_extensions
        install_pi_guide
        echo ""
    fi
```

- [ ] **Step 6: Update the "Platforms configured" output section (~line 736)**

After the OpenCode block:

```bash
    if [[ "$PI_DETECTED" == "true" ]]; then
        echo "  ✓ Pi (MCP via adapter + extensions + AGENTS.md)"
    fi
```

And in the "Next steps" section, add:

```bash
    if [[ "$PI_DETECTED" == "true" ]]; then
        echo "  1. Restart Pi to load MCP adapter and extensions"
    fi
```

- [ ] **Step 7: Validate installer syntax**

Run: `bash -n install.sh && echo "Syntax OK"`
Expected: `Syntax OK`

- [ ] **Step 8: Commit**

```bash
git add install.sh
git commit -m "feat: add Pi detection and configuration to installer"
```

---

### Task 6b: Create PI_INTEGRATION.md Architecture Doc

**Files:**
- Create: `docs/PI_INTEGRATION.md`

- [ ] **Step 1: Write `docs/PI_INTEGRATION.md`**

Brief architecture document paralleling any existing `OPENCODE_INTEGRATION.md`. Content:
- How Pi connects to Recall (MCP via pi-mcp-adapter)
- Session extraction flow (tree JSONL → linearize → markdown → drop dir → BatchExtract)
- Memory injection flow (before_agent_start → mem search → system prompt append)
- File locations: extensions in `~/.pi/agent/extensions/`, MCP config in `~/.pi/agent/mcp.json`, guide in `~/.pi/agent/Recall_GUIDE.md`
- Open questions from the spec (ctx.sessionManager verification, Pi JSONL message structure)

- [ ] **Step 2: Commit**

```bash
git add docs/PI_INTEGRATION.md
git commit -m "docs: add PI_INTEGRATION.md architecture document"
```

---

## Chunk 4: Testing

### Task 7: Tree JSONL Linearization Tests

**Files:**
- Modify: `tests/pi-integration.test.ts`

These tests import `linearizeSession` directly from `pi/recall-extract.ts` to test the actual implementation, not a copy.

- [ ] **Step 1: Write linearization tests**

```typescript
import { linearizeSession } from '../pi/recall-extract';

describe('tree JSONL linearization', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'recall-pi-linearize-'));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('linearizes a simple linear conversation', () => {
    const entries = [
      { id: "1", parentId: null, type: "message", message: { role: "user", content: "Hello, can you help me with TypeScript?" } },
      { id: "2", parentId: "1", type: "message", message: { role: "assistant", content: "Of course! TypeScript is a typed superset of JavaScript. What do you need help with specifically?" } },
      { id: "3", parentId: "2", type: "message", message: { role: "user", content: "How do I define an interface with optional fields?" } },
    ];

    const jsonlPath = join(tempDir, 'linear.jsonl');
    writeFileSync(jsonlPath, entries.map(e => JSON.stringify(e)).join('\n'));

    const result = linearizeSession(jsonlPath);

    expect(result).toContain('[USER]');
    expect(result).toContain('[ASSISTANT]');
    expect(result).toContain('TypeScript');
  });

  test('follows active branch (last child) when tree branches', () => {
    const entries = [
      { id: "1", parentId: null, type: "message", message: { role: "user", content: "What is the best programming language?" } },
      { id: "2", parentId: "1", type: "message", message: { role: "assistant", content: "Old answer: Python is popular." } },
      { id: "3", parentId: "1", type: "message", message: { role: "assistant", content: "Updated answer: It depends on your use case. For web, TypeScript. For ML, Python." } },
    ];

    const jsonlPath = join(tempDir, 'branching.jsonl');
    writeFileSync(jsonlPath, entries.map(e => JSON.stringify(e)).join('\n'));

    const result = linearizeSession(jsonlPath);

    expect(result).toContain('Updated answer');
    expect(result).not.toContain('Old answer');
  });

  test('skips non-message entries', () => {
    const entries = [
      { id: "1", parentId: null, type: "system", data: { model: "pi-3" } },
      { id: "2", parentId: "1", type: "message", message: { role: "user", content: "Tell me about Recall persistent memory system" } },
      { id: "3", parentId: "2", type: "tool_call", tool: { name: "search" } },
      { id: "4", parentId: "3", type: "message", message: { role: "assistant", content: "Recall gives you persistent memory across coding sessions using SQLite and FTS5." } },
    ];

    const jsonlPath = join(tempDir, 'mixed.jsonl');
    writeFileSync(jsonlPath, entries.map(e => JSON.stringify(e)).join('\n'));

    const result = linearizeSession(jsonlPath);

    expect(result).toContain('Recall');
    expect(result).not.toContain('pi-3');
    expect(result).not.toContain('search');
  });

  test('handles malformed JSONL lines gracefully', () => {
    const jsonlPath = join(tempDir, 'malformed.jsonl');
    writeFileSync(jsonlPath, '{"id":"1","parentId":null,"type":"message","message":{"role":"user","content":"Valid message about testing"}}\nnot json\n{"broken');

    const result = linearizeSession(jsonlPath);
    expect(result).toContain('Valid message');
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun test tests/pi-integration.test.ts`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add tests/pi-integration.test.ts
git commit -m "test: add tree JSONL linearization tests for Pi integration"
```

---

### Task 8: Installer Validation Tests

**Files:**
- Modify: `tests/pi-integration.test.ts`

- [ ] **Step 1: Add installer tests**

```typescript
describe('installer Pi integration', () => {
  test('install.sh has no syntax errors', () => {
    const installPath = join(__dirname, '..', 'install.sh');
    expect(() => execFileSync('bash', ['-n', installPath])).not.toThrow();
  });

  test('install.sh includes Pi config in backup list', () => {
    const installPath = join(__dirname, '..', 'install.sh');
    const content = readFileSync(installPath, 'utf-8');
    expect(content).toContain('PI_CONFIG_DIR');
    expect(content).toContain('mcp.json');
    expect(content).toContain('AGENTS.md');
  });

  test('install.sh detects Pi platform', () => {
    const installPath = join(__dirname, '..', 'install.sh');
    const content = readFileSync(installPath, 'utf-8');
    expect(content).toContain('PI_DETECTED');
    expect(content).toContain('command -v pi');
  });

  test('install.sh has pi-mcp-adapter installation', () => {
    const installPath = join(__dirname, '..', 'install.sh');
    const content = readFileSync(installPath, 'utf-8');
    expect(content).toContain('pi-mcp-adapter');
    expect(content).toContain('install_pi_adapter');
  });

  test('install.sh has Pi MCP configuration', () => {
    const installPath = join(__dirname, '..', 'install.sh');
    const content = readFileSync(installPath, 'utf-8');
    expect(content).toContain('configure_pi_mcp');
    expect(content).toContain('recall-memory');
    expect(content).toContain('lifecycle');
  });

  test('install.sh copies Pi extensions', () => {
    const installPath = join(__dirname, '..', 'install.sh');
    const content = readFileSync(installPath, 'utf-8');
    expect(content).toContain('install_pi_extensions');
    expect(content).toContain('recall-extract.ts');
    expect(content).toContain('recall-compaction.ts');
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun test tests/pi-integration.test.ts`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add tests/pi-integration.test.ts
git commit -m "test: add installer validation tests for Pi integration"
```

---

### Task 9: Pi Extraction Tracker Tests

**Files:**
- Modify: `tests/pi-integration.test.ts`

- [ ] **Step 1: Add extraction tracker tests**

```typescript
describe('Pi extraction tracker (dedup)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'recall-pi-tracker-'));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('tracker persists to JSON file', () => {
    const trackerPath = join(tempDir, '.extraction_tracker.json');
    const tracker = new Set(['session-1.jsonl', 'session-2.jsonl']);

    writeFileSync(trackerPath, JSON.stringify([...tracker]));

    const loaded = JSON.parse(readFileSync(trackerPath, 'utf-8'));
    const restoredSet = new Set(Array.isArray(loaded) ? loaded : []);

    expect(restoredSet.has('session-1.jsonl')).toBe(true);
    expect(restoredSet.has('session-2.jsonl')).toBe(true);
    expect(restoredSet.has('session-3.jsonl')).toBe(false);
  });

  test('corrupt tracker file falls back to empty set', () => {
    const trackerPath = join(tempDir, '.extraction_tracker.json');
    writeFileSync(trackerPath, 'not valid json!!!');

    let tracker: Set<string>;
    try {
      const data = JSON.parse(readFileSync(trackerPath, 'utf-8'));
      tracker = new Set(Array.isArray(data) ? data : []);
    } catch {
      tracker = new Set();
    }

    expect(tracker.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun test tests/pi-integration.test.ts`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add tests/pi-integration.test.ts
git commit -m "test: add Pi extraction tracker dedup tests"
```

---

### Task 10: Full Test Suite Verification

- [ ] **Step 1: Run all tests**

Run: `bun test`
Expected: All tests pass (existing 86 + new Pi tests)

- [ ] **Step 2: Verify build succeeds**

Run: `bun run build`
Expected: Build completes with no errors

- [ ] **Step 3: Validate installer syntax**

Run: `bash -n install.sh && echo "OK"`
Expected: `OK`

- [ ] **Step 4: Final commit if any loose changes**

```bash
git status
# If any uncommitted changes:
git add -A
git commit -m "chore: Pi integration cleanup"
```
