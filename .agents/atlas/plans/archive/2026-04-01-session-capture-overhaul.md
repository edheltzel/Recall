# Recall Session Capture Overhaul — Claude Code Focus

> **Date:** 2026-04-01
> **Status:** Draft — empirically validated, pending Ed's review
> **Supersedes:** `clear-command-capture-design.md` (2026-03-17)
> **Scope:** Claude Code only. OpenCode/Pi deferred to separate plans.
> **Research basis:** Three parallel investigation agents + 32-agent red team + empirical hook testing — April 1, 2026

---

## Problem Statement

Recall currently captures sessions via a single `Stop` hook (`SessionExtract.ts`). This misses two critical scenarios:

1. **`/clear`** — starts a new session; the old session goes unextracted until BatchExtract cron runs (up to 30 minutes later)
2. **Auto-compaction** — Claude Code summarizes and discards context when the window fills (~83.5% of 200K tokens). Pre-compaction conversation detail is lost forever. Recall has **zero hooks** for this today.

Additionally, the `/recall:*` slash commands use the legacy `.claude/commands/` format. The current recommended format is Skills (`SKILL.md`), which offers `allowed-tools`, `effort` overrides, `argument-hint`, and subagent isolation.

---

## Research Findings (April 2026)

### Hook Events Available

| Event | Fires When | Matcher Values | Can Return `additionalContext` | Key Input Fields |
|-------|-----------|----------------|-------------------------------|-----------------|
| `PreCompact` | Before compaction starts | `auto`, `manual` | Untested | `session_id`, `transcript_path`, `trigger`, `custom_instructions` |
| `PostCompact` | After compaction completes (v2.1.76+) | `auto`, `manual` | Untested | `session_id`, `transcript_path`, `trigger`, **`compact_summary`** |
| `SessionStart` | New session begins | `startup`, `clear`, `compact`, `resume` | Yes | `session_id`, `transcript_path`, `source` |
| `SessionEnd` | Session ends | `clear`, `exit` | No | `session_id`, `transcript_path` |
| `Stop` | After each assistant response | N/A | No | `transcript_path`, `cwd` |
| `PreToolUse` | Before any tool call | Tool name matchers | Yes (can block) | Tool name, input |
| `PostToolUse` | After any tool call | Tool name matchers | Yes | Tool name, input, output |
| `UserPromptSubmit` | Every user submission | N/A (no matcher) | Yes | Prompt text (fires for slash commands too) |
| `InstructionsLoaded` | CLAUDE.md loaded/reloaded | `startup`, `compact`, `manual` | Yes | `load_reason` |

### Empirical Hook Validation (April 1, 2026)

Test hooks (`~/.claude/hooks/test-precompact.sh`, `test-postcompact.sh`) were registered as `type: "command"` to capture raw stdin payloads. Both fired successfully during an auto-compaction event.

**Confirmed PreCompact input schema** (289 bytes):
```json
{
  "session_id": "uuid",
  "transcript_path": "/Users/ed/.claude/projects/<encoded-cwd>/<session-id>.jsonl",
  "cwd": "/Users/ed/Sites/alianza.health",
  "hook_event_name": "PreCompact",
  "trigger": "auto",
  "custom_instructions": null
}
```

**Confirmed PostCompact input schema** (19,277 bytes):
```json
{
  "session_id": "uuid",
  "transcript_path": "/Users/ed/.claude/projects/<encoded-cwd>/<session-id>.jsonl",
  "cwd": "/Users/ed/Sites/alianza.health",
  "hook_event_name": "PostCompact",
  "trigger": "auto",
  "compact_summary": "<analysis>...detailed analysis...</analysis>\n\n<summary>...9-section structured summary...</summary>"
}
```

**Key empirical findings:**
1. **`transcript_path` IS populated** in PreCompact — bug #13668 does NOT affect current versions
2. **`compact_summary` IS delivered** in PostCompact — ~19KB structured content with `<analysis>` + `<summary>` sections
3. **PreCompact has `custom_instructions`**, PostCompact does NOT
4. **PostCompact does NOT have `custom_instructions`**, but has `compact_summary`
5. **`type: "command"` works** for both PreCompact and PostCompact
6. **Hooks registered mid-session are NOT picked up** by the current session — only by sessions started after `settings.json` was modified
7. **`compact_summary` contains Claude Code's own summarization** — the same 9-section format seen after compaction, meaning NO separate Haiku extraction is needed for compacted content
8. **~19KB payload is well under the 50K hook output cap** — no truncation risk

### `/clear` Behavior (Updated)

- Creates a new session with new UUID and new JSONL file
- Old JSONL persists on disk — NOT deleted
- `SessionEnd` with reason `clear` — **still buggy** (#6428 still open as of April 2026)
- `SessionStart` with source `clear` — **reliable**
- `UserPromptSubmit` fires for `/clear` (receives literal `/clear` text)

### Auto-Compaction Behavior

- Triggers at ~83.5% context fill (configurable via `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`)
- JSONL is **append-only** — `compact_boundary` system record appended, originals preserved
- `compact_boundary` record contains: `trigger` (auto/manual), `preTokens`, `logicalParentUuid`
- Synthetic user message with `isCompactSummary: true` appended after boundary
- All original messages remain in JSONL — just excluded from API calls
- **Thrash protection** added v2.1.89: stops after 3 consecutive compact cycles
- `cleanupPeriodDays: 0` now **rejected with validation error** (v2.1.89)

### Slash Command System

- `/recall:*` commands use legacy `.claude/commands/` format — still works but deprecated
- Skills (`SKILL.md`) is the current format with richer capabilities
- `/compact [instructions]` is a built-in manual compaction trigger
- `/dump` is NOT a built-in — it's Recall's custom `/recall:dump`
- No structured data return from slash commands (natural language only)
- `UserPromptSubmit` hooks fire for ALL slash commands including built-ins

### Full Hook Inventory (v2.1.89 — 21+ events)

Beyond the session-relevant hooks above, Claude Code now has events for:
- **Tool lifecycle:** `PreToolUse`, `PostToolUse`, `PostToolUseFailure`
- **Completion:** `Stop`, `StopFailure` (v2.1.78 — matchers: `rate_limit`, `server_error`, etc.)
- **Subagents:** `SubagentStart`, `SubagentStop`, `TeammateIdle`
- **Tasks:** `TaskCreated` (v2.1.84), `TaskCompleted`
- **Config:** `ConfigChange` (v2.1.49), `InstructionsLoaded` (v2.1.83), `FileChanged`, `CwdChanged`
- **Worktree:** `WorktreeCreate`, `WorktreeRemove`
- **MCP:** `Elicitation`, `ElicitationResult`
- **Permissions:** `PermissionRequest`, `PermissionDenied` (v2.1.89)
- **Notifications:** `Notification`

### Critical Constraints Discovered

1. **PostCompact is command-only** — ✅ CONFIRMED empirically. `type: "command"` works for both PreCompact and PostCompact. Issue #36749 (prompt/agent types) still open but irrelevant — command is all we need.
2. ~~**PreCompact transcript_path may be empty**~~ — ✅ DISPROVED empirically. `transcript_path` was fully populated in our test (April 2026). Bug #13668 was closed as stale and does not affect current versions. Still worth defensive null-check but no fallback scanning needed.
3. **Hook output size limit** — v2.1.89 caps hook stdout at 50K chars. The `compact_summary` payload tested at ~19KB — well under the cap, no truncation risk.
4. **SessionEnd timeout now configurable** — `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` env var (v2.1.74). Default was 1.5s hard kill. install.sh should set a sane value.
5. **No PreClear hook** — #26052 closed as duplicate. Anthropic says use SessionStart(clear). No PreClear planned.
6. **PreToolUse decision fields deprecated** — new format uses `hookSpecificOutput.permissionDecision` instead of top-level `decision`. Recall's existing hooks don't use PreToolUse but worth noting for future.
7. **Mid-session hook registration not picked up** — ✅ DISCOVERED empirically. Hooks added to `settings.json` during a running session are NOT picked up by that session. Only sessions started after the modification see them. Install.sh must warn about restarting sessions after installation.

### Bug Status Updates

| Bug | Status | Impact |
|-----|--------|--------|
| #6428 (SessionEnd not firing on /clear) | **Still open** (labeled stale) | Anthropic's official guidance: use SessionStart(clear) instead |
| #3046 (Stop hook transcript_path after /clear) | **Closed** | Partly fixed in v2.1.72 for resume/fork. Post-/clear case may still apply |
| #23710 (cleanupPeriodDays: 0 destroys files) | **Fixed** in v2.1.89 | Now rejects 0 with validation error |
| #26052 (PreClear feature request) | **Closed** as dupe of #21578 | No PreClear planned — use SessionStart(clear) |
| #13668 (PreCompact empty transcript_path) | **Closed** as stale | ✅ **Empirically disproved** — transcript_path populated in April 2026 test. Defensive null-check still wise. |
| #36749 (prompt/agent types for Compact hooks) | **Open** | ✅ `type: "command"` confirmed working — agent/prompt types unnecessary for our use case |

---

## Proposed Architecture

### Three Capture Layers

```
Layer 1: COMPACTION CAPTURE (NEW)
  ├── PreCompact hook → extract full session before context is summarized
  ├── PostCompact hook → store compact_summary as LoA entry
  └── SessionStart(compact) → re-inject Recall context into new window

Layer 2: /CLEAR CAPTURE (REDESIGNED)
  ├── SessionStart(clear) → scan for unextracted previous JSONL, spawn extraction
  └── BatchExtract cron → safety net for anything missed

Layer 3: NORMAL SESSION END (EXISTING)
  ├── Stop hook → SessionExtract.ts (current behavior)
  └── BatchExtract cron → catches gaps
```

### Layer 1: Compaction Capture (NEW — highest priority)

This is the biggest gap in Recall today. Every auto-compaction event loses contextual detail from the pre-compaction window. The empirical finding that `compact_summary` is delivered as a ~19KB structured payload in PostCompact transforms this from an extraction problem into a simple storage problem.

#### Hook: `PostCompact` → `CompactCapture.ts` (PRIMARY — ship first)

**Registration:** `PostCompact` with matcher `*` (both auto and manual), `type: "command"`

**Confirmed input fields** (empirically validated):
- `session_id` — session UUID
- `transcript_path` — absolute JSONL path (confirmed populated)
- `cwd` — working directory
- `hook_event_name` — "PostCompact"
- `trigger` — "auto" or "manual"
- `compact_summary` — full `<analysis>` + `<summary>` text (~19KB typical)

**Behavior:**
1. Read JSON from stdin, parse `compact_summary`
2. **Validate non-empty** — reject if `compact_summary` is null, empty, or < 100 chars (guards against schema changes per red team finding #4)
3. Store as LoA entry with `source: "compaction"` (requires `source` column migration)
4. Also store raw `compact_summary` in `messages` table for FTS5 searchability
5. Update `extraction_tracker` (SQLite) with session_id, compact_boundary position, `status: 'completed'`
6. Log success/failure to stderr (visible in Claude Code hook logs)

**Performance budget:** < 5 seconds (just DB inserts, no LLM calls)

**Why this is the highest-value change:** Claude Code's own summarization is FREE, high-quality, and structured. We get the equivalent of a Haiku extraction without any API call, latency, or cost. This single hook closes the biggest gap in Recall's coverage.

#### Hook: `PreCompact` → `CompactExtract.ts` (DEFERRED — Phase 5)

**Registration:** `PreCompact` with matcher `*`, `type: "command"`

**Confirmed input fields** (empirically validated):
- `session_id`, `transcript_path` (confirmed populated), `cwd`, `hook_event_name`, `trigger`
- `custom_instructions` (string|null — not present in PostCompact)

**Value proposition (reduced):** Since PostCompact's `compact_summary` captures the high-level synthesis, PreCompact's value is limited to preserving **granular detail** (individual tool calls, specific code snippets, exact error messages) that compaction summarizes away. This is nice-to-have, not critical.

**Deferred because:**
- PostCompact already captures the essential information for free
- PreCompact inline extraction requires Haiku API calls (cost, latency, timeout risk)
- Red team finding #3: the fallback-to-pending route recreates the 30-minute BatchExtract gap
- Phase 4 data (compaction frequency measurement) should justify the investment first

**If built (Phase 5):**
1. Read `transcript_path` from stdin (confirmed populated — no fallback scanning needed)
2. Calculate byte offset since last extraction (track in `extraction_tracker` SQLite table)
3. Extract only NEW content since last extraction (incremental)
4. Run through Haiku extraction pipeline
5. Write pending marker to `extraction_tracker` if timeout approaching
6. Keep stdout under 50K chars

#### Hook: `SessionStart(compact)` → Extend existing `SessionRecall.ts`

**Changes to existing `SessionRecall.ts`:**
- Add matcher for `compact` (currently only handles `startup` and `resume`)
- On `source: "compact"`: load recent decisions, active breadcrumbs, and the compact_summary from PostCompact
- Inject as `additionalContext` so Recall context survives compaction

### Layer 2: /clear Capture (SIMPLIFIED)

The March 17 design proposed two new hooks (ClearExtract.ts, ClearContext.ts) and a pending/ copy mechanism. With the current hook landscape, this can be much simpler:

#### Hook: `SessionStart(clear)` → Extend existing `SessionRecall.ts`

**Changes to existing `SessionRecall.ts`:**
- Add matcher for `clear`
- On `source: "clear"`:
  1. Derive previous session's JSONL path (second most recent by mtime in project dir)
  2. Check extraction_tracker — if not yet extracted, spawn background extraction
  3. Load recent context and inject as `additionalContext`

**Why this is simpler than the March 17 design:**
- No need for ClearExtract.ts — SessionStart(clear) is reliable and sufficient
- No need for pending/ directory copy mechanism — JSONL files aren't deleted (cleanupPeriodDays: 0 is now rejected)
- No need for SessionEnd hook — it's still buggy (#6428) and adds no value over SessionStart
- BatchExtract remains the Layer 3 safety net

### Layer 3: Normal Session End (EXISTING — minor improvements)

`SessionExtract.ts` on `Stop` hook — works today. Minor improvements:

1. **Incremental extraction:** Track byte offset, only process new content since last extraction
2. **compact_boundary awareness:** When parsing JSONL, skip `isCompactSummary` synthetic messages
3. **Dedup with Layer 1:** If PreCompact already extracted this content, don't re-extract

---

## Phase 2: Slash Command Migration

### Migrate `/recall:*` from legacy commands to Skills format

Current: `~/.claude/commands/recall/*.md`
Target: `~/.claude/skills/recall/` with `SKILL.md` files

**Benefits:**
- `allowed-tools` — pre-approve MCP tools so `mem search` doesn't need manual approval
- `argument-hint` — show usage hints during autocomplete
- `effort` — control model effort (e.g., `recall:search` can use lower effort)
- `context: fork` — run extractions in isolated subagents to avoid polluting main context
- Better discoverability via `/skills` browser

**Commands to migrate:**

| Current | New | Changes |
|---------|-----|---------|
| `/recall:dump` | `/recall:dump` | Add `allowed-tools: mcp__recall-memory__*` |
| `/recall:search` | `/recall:search` | Add `argument-hint: "search terms"`, lower effort |
| `/recall:recent` | `/recall:recent` | Add `argument-hint: "[table]"` |
| `/recall:stats` | `/recall:stats` | Minimal — just format migration |
| `/recall:doctor` | `/recall:doctor` | Add `allowed-tools: Bash(mem *)` |
| `/recall:loa` | `/recall:loa` | Add `argument-hint: "[id or search terms]"` |
| `/recall:add` | `/recall:add` | Add `argument-hint: "<type> <content>"` |

### CLI ↔ Slash Command Simplification

The `mem` CLI and `/recall:*` slash commands largely duplicate functionality. Strategy:

- **Keep both.** CLI is for terminal use outside Claude Code. Slash commands are for in-session use.
- **Slash commands should call MCP tools, not shell out to CLI.** This is faster and avoids PATH issues.
- **CLI remains the primary interface** for scripting, cron jobs, and non-Claude-Code usage.

---

## Phase 3: SessionRecall.ts Consolidation

Currently `SessionRecall.ts` handles `startup` and `resume`. This plan adds `compact` and `clear` matchers. Rather than creating new hook files, consolidate all session-start context injection into one hook with a switch on `source`:

```typescript
// SessionRecall.ts — unified context injection
switch (source) {
  case "startup":    // Full context load (existing)
  case "resume":     // Full context load (existing)
  case "compact":    // Focused: recent decisions + compact_summary + active breadcrumbs
  case "clear":      // Focused: recent decisions + trigger background extraction of old session
}
```

**Registration:** Single `SessionStart` hook with matcher `*` (all sources)

---

## Red Team Validation (32 agents, 8 batches — April 1, 2026)

### Critical Findings (Must Fix)

**1. JSONL data is NOT lost during compaction (7+ agents converged)**
The plan's Problem Statement says "pre-compaction conversation detail is lost forever" — but the plan's own research section proves JSONL is append-only. All messages remain on disk. BatchExtract can process them later. **PreCompact's urgency is oversold.** The real gap is *timeliness*, not data loss.

**2. Dual extraction tracker creates silent coherence gap (6+ agents)**
`BatchExtract.ts` reads `.extraction_tracker.json` (JSON file). The plan's new hooks write to `extraction_tracker` (SQLite table). These are two separate systems that never reconcile. A `status: 'pending'` marker in SQLite is invisible to BatchExtract. The "safety net" has a blind spot exactly as large as the new system. **Must unify trackers before adding new extraction paths.**

**3. PreCompact timeout is unknown; fallback = same 30-minute gap (6+ agents)**
The plan proposes inline Haiku extraction in PreCompact with a fallback to a pending marker for BatchExtract. But the pending marker route IS the 30-minute gap the plan was designed to eliminate. The PreCompact timeout value is undocumented. For large sessions, Haiku extraction will likely exceed any reasonable hook timeout. **The fallback invalidates the primary value proposition for exactly the sessions that need it most.**

**4. compact_summary needs validation against empty/malformed input (5+ agents)**
The plan's own research documents that Anthropic moved `permissionDecision` from top-level to nested `hookSpecificOutput` without a major version bump. If `compact_summary` moves similarly, PostCompact silently writes empty LoA entries and marks extraction as complete. **Add non-empty validation before any DB write.**

**5. SessionRecall.ts consolidation = risk concentration (4+ agents)**
Adding process spawning (for /clear background extraction) to a currently read-only hook introduces write-lock contention, zombie processes, and a new failure class at session-start time. **Keep SessionRecall.ts read-only; offload spawning to a separate hook.**

**6. The 81% extraction failure rate must be addressed first (3+ agents)**
The clear-command-capture-design.md documents 917/1135 tracker entries as failed. Adding more extraction triggers to a pipeline with this failure rate amplifies unreliability. **Fix extraction reliability before expanding ingestion volume.**

### Validated Strengths

- **PostCompact compact_summary is the highest-value, lowest-risk change** (ALL 32 agents agreed)
- **Byte-offset incremental extraction is architecturally sound** (WAL pattern, proven in existing code)
- **/clear simplification vs March 17 design is correct** (fewer files, fewer failure modes)
- **Skills migration is a clear UX win** (eliminates per-session MCP approval friction)
- **Three-layer separation is justified** (compaction and /clear are genuinely different problems)

### Additional Risks Identified

- **cleanupPeriodDays: 1 still deletes files** — the simplification only holds for rejected value 0, not low values
- **PostCompact → SessionStart(compact) ordering race** — compact_summary may not be in DB when SessionStart queries
- **PAI hooks already handle compact/clear SessionStart** — additionalContext collision possible
- **No UNIQUE constraint on decisions table** — double-extraction creates duplicate records
- **LoA table has no `source` column** — compaction entries can't be distinguished from curated ones

---

## Revised Execution Order (Post-Red-Team + Empirical Validation)

```
Phase 0: Unify extraction trackers (JSON → SQLite)         [PREREQUISITE — blocks all else]
Phase 1: CompactCapture.ts (PostCompact hook)               [HIGHEST VALUE — empirically validated]
         - Store compact_summary as LoA with validation
         - Add `source` column to loa_entries (migration)
         - Non-empty + minimum-length (>100 chars) check before insert
         - Also store in messages table for FTS5 searchability
         - No LLM calls needed — compact_summary is free
Phase 2: SessionRecall.ts compact matcher                   [RE-INJECT context after compaction]
         - Read-only: load compact_summary + recent decisions
         - Handle PostCompact ordering race (retry with backoff)
         - Keep read-only — NO process spawning
Phase 3: SessionStart(clear) background extraction          [SEPARATE hook, not SessionRecall.ts]
         - New small hook file, or extend BatchExtract
         - Spawns background extraction of previous JSONL
Phase 4: Measure compaction frequency                       [DATA — before investing in PreCompact]
         - Add compact_boundary counter to `mem stats`
         - Instrument how often compaction fires across real usage
Phase 5: CompactExtract.ts (PreCompact hook)                [DEFERRED — only if Phase 4 justifies]
         - Incremental byte-offset extraction for granular detail
         - transcript_path confirmed populated (no fallback needed)
         - Only build if compaction is frequent enough to justify
Phase 6: Slash command migration to Skills format            [INDEPENDENT — can run in parallel]
Phase 7: Extraction reliability audit                       [ADDRESS the 81% failure rate]
```

**Phases 0-1 are the critical path. Phase 1 requires zero LLM calls and completes in <5s — it's the highest-ROI change in Recall's history.**
**Phases 2-3 are the minimum viable overhaul. Phases 4-7 are data-driven follow-ups.**

---

## Open Questions for Ed (Revised Post-Empirical Validation)

1. **Tracker unification (Phase 0):** The dual tracker must be unified. Should BatchExtract.ts be migrated to read from SQLite, or should a bridge layer sync SQLite → JSON for backward compatibility?

2. **compact_summary storage format:** Store as LoA entry with new `source: "compaction"` column (requires migration), or as a new `compaction_snapshots` table (simpler, no LoA pollution)? The empirical data shows ~19KB structured content per compaction — this is substantial and worth first-class storage.

3. **SessionRecall.ts vs separate /clear hook:** Red team recommends keeping SessionRecall.ts read-only. Should /clear background extraction be a new `ClearExtract.ts` hook, or just increase BatchExtract cron frequency?

4. **Extraction reliability:** Should Phase 7 (81% failure rate audit) be prioritized BEFORE Phase 1, or can they run in parallel? Phase 1 (PostCompact) has zero dependency on extraction reliability since it uses `compact_summary` directly — no Haiku pipeline involved.

5. **Skills migration timing:** Independent of hooks — defer to separate plan, or include as Phase 6?

6. **Test hook cleanup:** Remove test hooks from `~/.claude/settings.json` and delete `~/.claude/hooks/test-precompact.sh`, `test-postcompact.sh` once we're done validating. These are development artifacts only.

---

*Generated: 2026-04-01 | Research: Three parallel agents (hooks, compaction, slash commands)*
*Red team: 32 agents across 8 batches (EN1-8, AR1-8, PT1-8, IN1-8)*
*Empirical validation: Live PreCompact/PostCompact hook tests capturing stdin payloads (April 1, 2026)*
*Test artifacts: `/tmp/recall-test-precompact-1775080929.json`, `/tmp/recall-test-postcompact-1775081041.json`*
*References: `clear-command-capture-design.md` (superseded), `2026-04-01-claude-code-hooks-api-reference.md` (Spore audit)*
