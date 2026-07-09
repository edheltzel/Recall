# Recall + Pi Integration Architecture

> Architecture document for extending Recall to work with Pi alongside Claude Code and OpenCode.

## Overview

Recall's core (SQLite DB, MCP server, CLI) is platform-agnostic. Pi connects to it via the same `recall-memory` MCP server used by Claude Code and OpenCode, through a `pi-mcp-adapter` that handles the protocol bridge and applies a server prefix to tool names.

The integration follows the same three-layer pattern as other platforms:
1. **MCP registration** — `~/.pi/agent/mcp.json`
2. **Session extraction** — tree JSONL → linearized markdown → drop dir → RecallBatchExtract cron
3. **Memory injection** — `before_agent_start` hook → `recall search` → system prompt append

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                 PLATFORM-AGNOSTIC CORE                   │
│                                                          │
│  recall.db (SQLite/FTS5)  ←  MCP Server (recall-memory) │
│                               7 tools, stdio             │
└─────────────────────────────────────┬───────────────────┘
                                      │
              ┌───────────────────────┼───────────────────┐
              │                       │                   │
   Claude Code Adapter         OpenCode Adapter      Pi Adapter
   ~/.claude/settings.json     ~/.config/opencode/   ~/.pi/agent/mcp.json
   hooks/RecallExtract.ts     plugins/              extensions/
                                RecallExtract.ts     RecallExtract.ts
                                RecallPreCompact.ts  RecallPreCompact.ts
```

## Session Extraction

Pi stores conversation history as a tree JSONL (branching structure from edits and retries). The extraction pipeline:

1. **Linearize**: Read the tree JSONL and walk the active branch (most recent path from root to leaf)
2. **Convert**: Render the active-branch messages as markdown (user/assistant turns)
3. **Drop**: Write the markdown file to `~/.claude/MEMORY/pi-sessions/<sessionId>.md`
4. **Extract**: The existing `RecallBatchExtract.ts` cron job scans the drop directory every 30 minutes and processes new files via Claude Haiku

This reuses the RecallBatchExtract infrastructure without modification — it already handles markdown input from the OpenCode drop dir.

The extraction logic lives in `~/.pi/agent/extensions/RecallExtract.ts`, which hooks into Pi's session lifecycle.

### Deduplication

A JSON tracker at `~/.claude/MEMORY/pi-sessions/.extraction_tracker.json` records processed session IDs. It persists across extension restarts to avoid re-extracting sessions.

## Memory Injection

Before each agent turn, the `before_agent_start` hook runs `recall search <query>` and appends results to the system prompt. This is per-turn injection, not persistent session state — the context is re-fetched on every turn. Humans can narrow manual keyword searches with `-t <table>` or softly prefer a type with `--bias-type <table>`.

The hook lives in `~/.pi/agent/extensions/RecallPreCompact.ts` (named for consistency with the OpenCode equivalent, though it handles injection rather than compaction context).

Injection flow:
```
before_agent_start → extract project/task keywords from input
                   → recall search <keywords> --limit 5
                   → append to system prompt as "## Persistent Memory"
                   → agent runs with context
```

Manual targeted search examples:
```bash
recall search "database choice" -t decisions          # decisions only
recall search "database choice" --bias-type decisions # decisions first, broader context preserved
```

If `recall` is unavailable or times out (5s limit), the hook skips silently.

## File Locations

| File | Purpose |
|------|---------|
| `~/.pi/agent/extensions/RecallExtract.ts` | Session extraction hook |
| `~/.pi/agent/extensions/RecallPreCompact.ts` | Memory injection hook |
| `~/.pi/agent/mcp.json` | MCP server registration |
| `~/.pi/agent/Recall_GUIDE.md` | Agent guide (installed from `FOR_PI.md` with Pi-specific tool names) |
| `~/.pi/agent/AGENTS.md` | Syntax-free pointer to the installed Recall guide and live MCP schemas |
| `~/.claude/MEMORY/pi-sessions/` | Drop directory for extracted session markdown |
| `~/.agents/Recall/recall.db` | Shared SQLite DB (same as Claude Code and OpenCode) |

## Tool Name Mapping

Pi uses `pi-mcp-adapter` in server prefix mode, which prepends `recall-memory_` to all tool names:

| Base Tool | Pi Tool Name | Description |
|-----------|-------------|-------------|
| `memory_search` | `recall-memory_memory_search` | FTS5 keyword search; supports `table` hard filters and `bias_type` soft boosts |
| `memory_hybrid_search` | `recall-memory_memory_hybrid_search` | FTS5 + vector search |
| `memory_recall` | `recall-memory_memory_recall` | Contextual recall |
| `memory_add` | `recall-memory_memory_add` | Add memory entry |
| `context_for_agent` | `recall-memory_context_for_agent` | Prepare context for subagent |
| `memory_stats` | `recall-memory_memory_stats` | DB statistics |
| `loa_show` | `recall-memory_loa_show` | Show level of abstraction |

This is the same prefix pattern as OpenCode. The `Recall_GUIDE.md` installed at `~/.pi/agent/` documents these prefixed names.

## AGENTS.md Pointer

The installer adds a marked, syntax-free pointer to `~/.pi/agent/AGENTS.md`.
The workflow and Pi-prefixed tool names stay canonical in `Recall_GUIDE.md`
and the live MCP schemas:

```markdown
## MEMORY
<!-- RECALL_MANAGED_MEMORY -->

Read and follow the canonical Recall guide at `~/.pi/agent/Recall_GUIDE.md`. Use the live `recall-memory` MCP schemas as the source of truth for tool call shapes.
```

Install and update refresh marked sections and migrate the normalized exact
legacy-generated Pi body. Unmarked customized/external `## MEMORY` sections
are preserved; marked sections remain Recall-owned, so remove the marker before
taking external ownership.

## Database

Pi shares `~/.agents/Recall/recall.db` with Claude Code and OpenCode. WAL mode handles concurrent access. Pi session extractions go through the same markdown pipeline as OpenCode — they appear in flat memory files (DISTILLED.md, SESSION_INDEX.json, DECISIONS.log, etc.), labeled `pi/<sessionId>`. They do not insert into the SQLite `sessions` table with a `source` field (that column is only populated via `recall import` or `recall dump`, not the drop-dir extraction pipeline).

No schema changes beyond what OpenCode already added (the `source` column in schema v3).

## Open Questions

1. **`ctx.sessionManager` verification needed**: The extraction hook assumes Pi exposes session state via `ctx.sessionManager` or equivalent. The actual API shape needs verification against Pi's extension docs before implementation.

2. **Pi JSONL message structure**: The tree JSONL format (branching structure, node schema, active-branch pointer) needs real-world verification. The linearization logic in `RecallExtract.ts` is written against an assumed structure and must be validated against actual Pi session files.

3. **`before_agent_start` hook availability**: Pi's extension hook lifecycle needs confirmation that a pre-turn hook exists with system prompt mutation capability.
