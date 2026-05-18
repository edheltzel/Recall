---
title: Recall Session Capture Overhaul — Claude Code Focus
status: In Progress
percent_complete: 35
last_updated: 2026-04-28
phase: Phase 0 (tracker unification) + Phase 3 (ClearExtract) outstanding
blockers: none
next_action: Decide whether to keep Phase 0 tracker unification + Phase 3 ClearExtract.ts, or fold into a v2 plan now that PreCompact (sprint-2) shipped instead of PostCompact CompactCapture
---

# Recall Session Capture Overhaul — Claude Code Focus

> **Date:** 2026-04-10 (revised from 2026-04-01 draft)
> **Status:** Ready for implementation
> **Supersedes:** `clear-command-capture-design.md` (2026-03-17), `2026-04-01-session-capture-overhaul.md` (draft)
> **Scope:** Claude Code only. OpenCode/Pi deferred to separate plans.
> **Basis:** Three parallel research agents + empirical hook testing + 32-agent red team validation (April 1, 2026)

---

## Problem Statement

Recall captures sessions via a single `Stop` hook (`SessionExtract.ts`). This has two timeliness gaps:

1. **`/clear`** — starts a new session; the old session goes unextracted until BatchExtract cron runs (up to 30 minutes later)
2. **Auto-compaction** — Claude Code summarizes context when the window fills (~83.5% of 200K tokens). While JSONL is append-only (no data is lost on disk), Recall has **no hook** to capture the summary or re-inject context into the compacted session. The gap is *timeliness and context continuity*, not data loss.

Additionally, the dual-tracker system (JSON file + SQLite table) has a coherence gap that must be resolved before adding new extraction paths.

> **Note:** The previously cited "81% failure rate" (920/1149 tracker entries) was an artifact of BatchExtract bulk-scanning historical pre-Recall sessions on March 10 and 13, 2026. The strict quality gate rejected short-session Haiku output. Post-March 18 steady-state extraction works normally. Backfill of historical sessions has been scrapped — not worth the cost or noise. See decision 2026-04-11.

---

## Research Findings (April 2026)

### Hook Events Available

| Event | Fires When | Matcher Values | `additionalContext` | Key Input Fields |
|-------|-----------|----------------|---------------------|-----------------|
| `PreCompact` | Before compaction starts | `auto`, `manual` | Untested | `session_id`, `transcript_path`, `trigger`, `custom_instructions` |
| `PostCompact` | After compaction completes (v2.1.76+) | `auto`, `manual` | Untested | `session_id`, `transcript_path`, `trigger`, **`compact_summary`** |
| `SessionStart` | New session begins | `startup`, `clear`, `compact`, `resume` | Yes | `session_id`, `transcript_path`, `source` |
| `SessionEnd` | Session ends | `clear`, `exit` | No | `session_id`, `transcript_path` |
| `Stop` | After each assistant response | N/A | No | `transcript_path`, `cwd` |

### Empirical Hook Validation (April 1, 2026)

Test hooks (`type: "command"`) captured raw stdin payloads during a live auto-compaction event.

**PreCompact input** (289 bytes):
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

**PostCompact input** (19,277 bytes):
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

**Key findings:**
1. `transcript_path` IS populated in PreCompact (bug #13668 does not affect current versions)
2. `compact_summary` IS delivered in PostCompact — ~19KB structured `<analysis>` + `<summary>`
3. `type: "command"` works for both PreCompact and PostCompact
4. Hooks registered mid-session are NOT picked up — only new sessions see them
5. `compact_summary` is Claude Code's own summarization — no separate Haiku extraction needed
6. ~19KB payload is well under the 50K hook output cap

### `/clear` Behavior

- Creates a new session with new UUID and new JSONL file
- Old JSONL persists on disk (append-only, not deleted)
- `SessionEnd(clear)` — still buggy (#6428, open as of April 2026)
- `SessionStart(clear)` — reliable (Anthropic's official recommendation)

### Auto-Compaction Behavior

- Triggers at ~83.5% context fill (configurable via `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`)
- JSONL is append-only: `compact_boundary` system record appended, originals preserved on disk
- Synthetic user message with `isCompactSummary: true` appended after boundary
- Thrash protection (v2.1.89): stops after 3 consecutive compact cycles
- `cleanupPeriodDays: 0` now rejected with validation error (v2.1.89)
- **Note:** `cleanupPeriodDays: 1` still deletes files — JSONL persistence only guaranteed while `cleanupPeriodDays` is at default or disabled

### Bug Status

| Bug | Status | Impact |
|-----|--------|--------|
| #6428 (SessionEnd not firing on /clear) | Open (stale) | Use SessionStart(clear) instead |
| #13668 (PreCompact empty transcript_path) | Closed (stale) | Empirically disproved — transcript_path populated |
| #23710 (cleanupPeriodDays: 0 destroys files) | Fixed v2.1.89 | Rejects 0 with validation error |
| #36749 (prompt/agent types for Compact hooks) | Open | `type: "command"` works — irrelevant |

---

## Architecture

### Three Capture Layers

```
Layer 1: COMPACTION CAPTURE (NEW — highest priority)
  ├── PostCompact hook → store compact_summary directly (no LLM)
  └── SessionStart(compact) → re-inject Recall context into compacted session (read-only)

Layer 2: /CLEAR CAPTURE (NEW — separate hook)
  ├── ClearExtract.ts → SessionStart(clear) triggers background extraction of old JSONL
  └── BatchExtract cron → safety net

Layer 3: NORMAL SESSION END (EXISTING)
  ├── Stop hook → SessionExtract.ts (current behavior)
  └── BatchExtract cron → catches gaps
```

### Layer 1: Compaction Capture

#### PostCompact → `CompactCapture.ts`

**Registration:** `PostCompact` with matcher `*` (auto + manual), `type: "command"`

**Behavior:**
1. Read JSON from stdin, extract `compact_summary`
2. **Validate:** reject if `compact_summary` is null, empty, or < 100 chars
   - *Guards against silent schema changes (Anthropic has moved fields between versions without notice)*
3. Store as LoA entry with `source: "compaction"` (requires `source` column migration)
4. Store raw text in `messages` table for FTS5 searchability
5. Update `extraction_tracker` in SQLite with session_id, status, timestamp
6. Log to stderr

**Performance:** < 5s (DB inserts only, zero LLM calls)

**Why this is the highest-value change:** Claude Code's own ~19KB structured summary is free, high-quality, and delivered directly. We get the equivalent of a Haiku extraction without any API call. This single hook closes the biggest gap in Recall.

#### SessionStart(compact) → `SessionRecall.ts` (read-only extension)

**Changes to existing hook:**
- Add `compact` to the matcher (currently handles `startup`, `resume`)
- On `source: "compact"`: load recent decisions + active breadcrumbs + compact_summary from PostCompact
- **Handle ordering race:** PostCompact may not have finished writing to DB when SessionStart(compact) fires. Use retry with exponential backoff (50ms, 100ms, 200ms — max 3 attempts)
- Inject as `additionalContext` so Recall context survives compaction
- **No process spawning** — SessionRecall.ts stays strictly read-only

#### PreCompact → `CompactExtract.ts` (DEFERRED to Phase 5)

PostCompact captures the high-level synthesis for free. PreCompact's only additional value is granular detail (individual tool calls, specific code snippets, exact errors) that compaction summarizes away. This is nice-to-have, not critical.

**Why deferred:**
- PostCompact already captures essential information at zero cost
- PreCompact inline extraction requires Haiku API calls (cost, latency, timeout risk)
- Hook timeout is undocumented — for large sessions, Haiku extraction will likely exceed it, falling back to a pending marker for BatchExtract, which IS the 30-minute gap we're trying to eliminate
- Phase 4 data (compaction frequency) should justify the investment first

### Layer 2: `/clear` Capture

#### ClearExtract.ts (NEW — separate hook file)

**Registration:** `SessionStart` with matcher `clear`, `type: "command"`

**Behavior:**
1. Derive previous session's JSONL path (second most recent by mtime in project dir)
2. Check `extraction_tracker` — if not yet extracted, spawn background Haiku extraction
3. Fire-and-forget — do not block session startup

**Why a separate hook, not SessionRecall.ts:**
- SessionRecall.ts is read-only (context injection). Adding process spawning introduces write-lock contention, zombie processes, and a new failure class at session-start time
- Separation of concerns: reading context vs triggering extraction are different responsibilities
- If ClearExtract.ts fails, SessionRecall.ts still loads context normally

**SessionRecall.ts** also gets a `clear` matcher but only for read-only context injection (same pattern as `compact`).

### Layer 3: Normal Session End (EXISTING)

`SessionExtract.ts` on `Stop` — works today. Minor improvements:
1. Incremental extraction via byte-offset tracking
2. `compact_boundary` awareness — skip `isCompactSummary` synthetic messages
3. Dedup with Layer 1 — if PostCompact already captured this content, skip

---

## Execution Phases

### Phase 0: Unify Extraction Trackers [PREREQUISITE — blocks all else]

**Problem:** `BatchExtract.ts` reads `.extraction_tracker.json` (JSON file). New hooks write to `extraction_tracker` (SQLite table). These never reconcile — a pending marker in SQLite is invisible to BatchExtract, creating a blind spot exactly as large as the new system.

**Solution:** Migrate BatchExtract.ts to read/write SQLite exclusively. Remove JSON tracker.

**Tasks:**
- [ ] Migrate BatchExtract.ts to use SQLite `extraction_tracker` table
- [ ] Add migration to drop JSON tracker references
- [ ] Test BatchExtract with SQLite-only tracker
- [ ] Remove `.extraction_tracker.json` creation/reading from all code paths

### Phase 1: CompactCapture.ts [HIGHEST VALUE — empirically validated]

**Deliverable:** PostCompact hook that stores `compact_summary` as a validated LoA entry.

**Tasks:**
- [ ] Create `hooks/CompactCapture.ts` (self-contained, like SessionExtract.ts)
- [ ] DB migration: add `source` column to `loa_entries` (TEXT, nullable, default NULL)
- [ ] Validation: reject null/empty/< 100 char `compact_summary` before any DB write
- [ ] Store as LoA entry with `source: "compaction"`
- [ ] Also insert into `messages` table for FTS5 searchability
- [ ] Update `extraction_tracker` (SQLite) with status + timestamp
- [ ] Register hook in install.sh: `PostCompact`, matcher `*`, `type: "command"`
- [ ] Tests: valid payload, empty payload, malformed JSON, schema field missing
- [ ] Log to stderr for hook debug visibility

### Phase 2: SessionRecall.ts — compact + clear matchers [CONTEXT CONTINUITY]

**Deliverable:** Recall context survives compaction and `/clear` events.

**Tasks:**
- [ ] Add `compact` and `clear` matchers to SessionRecall.ts
- [ ] On `compact`: load compact_summary + recent decisions + active breadcrumbs
- [ ] Handle PostCompact ordering race (retry with backoff, max 3 attempts)
- [ ] On `clear`: load recent decisions + active breadcrumbs (read-only, no extraction)
- [ ] Inject as `additionalContext`
- [ ] Test with mock hook inputs for each source value
- [ ] Verify no `additionalContext` collision with PAI hooks

### Phase 3: ClearExtract.ts [/CLEAR TIMELINESS]

**Deliverable:** Separate hook that triggers background extraction on `/clear`.

**Tasks:**
- [ ] Create `hooks/ClearExtract.ts` (self-contained)
- [ ] On `SessionStart(clear)`: find previous JSONL, check tracker, spawn background extraction
- [ ] Fire-and-forget — must not block session startup
- [ ] Register hook: `SessionStart`, matcher `clear`, `type: "command"`
- [ ] Test: previous session already extracted (skip), previous session not extracted (spawn)

### Phase 4: Measure Compaction Frequency [DATA-DRIVEN]

**Purpose:** Determine whether PreCompact is worth building.

**Tasks:**
- [ ] Add `compact_boundary` counter to `mem stats`
- [ ] Parse JSONL files for `compact_boundary` records
- [ ] Report: total compactions, per-project frequency, avg interval
- [ ] Decision gate: only proceed to Phase 5 if compaction is frequent enough

### Phase 5: CompactExtract.ts (PreCompact) [DEFERRED — only if Phase 4 justifies]

Incremental byte-offset extraction before compaction for granular detail preservation. Only build if Phase 4 shows compaction is frequent enough to justify the Haiku API cost.

### ~~Phase 6: Extraction Reliability Audit~~ [SCRAPPED]

> **Scrapped 2026-04-11.** The "81% failure rate" was a backfill artifact, not a pipeline problem. Steady-state extraction works. Remaining minor items (UNIQUE constraint on decisions, error field population) folded into Phase 0 tracker unification.

### Phase 6: Slash Command Migration to Skills [INDEPENDENT — can run in parallel]

Migrate `/recall:*` from legacy `.claude/commands/` to Skills format.

**Benefits:** `allowed-tools` (pre-approve MCP tools), `argument-hint`, `effort` overrides, `context: fork` for isolated extraction.

| Current | Changes |
|---------|---------|
| `/recall:dump` | Add `allowed-tools: mcp__recall-memory__*` |
| `/recall:search` | Add `argument-hint`, lower effort |
| `/recall:recent` | Add `argument-hint: "[table]"` |
| `/recall:stats` | Format migration only |
| `/recall:doctor` | Add `allowed-tools: Bash(mem *)` |
| `/recall:loa` | Add `argument-hint: "[id or search terms]"` |
| `/recall:add` | Add `argument-hint: "<type> <content>"` |

---

## Decisions Made (resolved by red team consensus)

These questions from the April 1 draft are now resolved:

| Question | Decision | Rationale |
|----------|----------|-----------|
| Tracker unification approach | Migrate BatchExtract to SQLite; remove JSON tracker | Dual tracker creates a blind spot that grows with each new hook (6+ agents) |
| SessionRecall.ts vs separate /clear hook | Separate `ClearExtract.ts` for extraction; SessionRecall.ts stays read-only | Process spawning in a read-only hook = risk concentration (4+ agents) |
| Extraction reliability | Phase 6 scrapped — 81% was a backfill artifact, not ongoing failures | Investigated April 2026: 98.8% of failures from two bulk-scan days (March 10, 13). Post-March 18 pipeline works normally. |
| PreCompact priority | Deferred to Phase 5 behind frequency data | Timeout risk + fallback invalidates value prop for large sessions (6+ agents) |

## Open Questions

1. **compact_summary storage:** LoA entry with `source: "compaction"` column (migration required), or a new `compaction_snapshots` table (simpler, no LoA pollution)?
   - LoA entry: unified search, shows up in `mem loa`, but may dilute curated entries
   - Separate table: clean separation, but duplicates query paths

2. **Skills migration timing:** Include as Phase 6 here, or break into a separate plan?

3. **Test hook cleanup:** Remove `test-precompact.sh` and `test-postcompact.sh` from `~/.claude/hooks/` and their registrations from `~/.claude/settings.json`.

---

## Risk Mitigations (from red team)

| Risk | Mitigation | Phase |
|------|-----------|-------|
| `compact_summary` schema changes silently | Validate non-empty + >100 chars before DB write | 1 |
| PostCompact → SessionStart(compact) race | Retry with exponential backoff (50ms, 100ms, 200ms) | 2 |
| Dual tracker coherence gap | Unify to SQLite-only before any new hooks | 0 |
| `additionalContext` collision with PAI hooks | Test coexistence; document field namespace | 2 |
| No UNIQUE on decisions table → duplicates | Add UNIQUE constraint in migration | 6 |
| `cleanupPeriodDays: 1` still deletes JSONL | Document minimum-safe value; warn in install.sh | 1 |

---

## Appendix: Red Team Attribution

32 agents across 8 batches (EN1-8, AR1-8, PT1-8, IN1-8), conducted April 1, 2026.

**What they corrected:**
- Problem statement reframed from "data loss" to "timeliness" (JSONL is append-only)
- PreCompact urgency reduced (timeout + fallback = same 30-min gap)
- SessionRecall.ts process spawning rejected (risk concentration)
- Dual tracker identified as prerequisite blocker

**What they validated:**
- PostCompact as highest-value, lowest-risk change (unanimous)
- Three-layer separation (compaction and /clear are different problems)
- Byte-offset incremental extraction (WAL pattern)
- /clear simplification over March 17 design

**Empirical validation:** Live PreCompact/PostCompact hook tests (April 1, 2026)
**Test artifacts:** `/tmp/recall-test-precompact-1775080929.json`, `/tmp/recall-test-postcompact-1775081041.json`
**References:** `2026-04-01-claude-code-hooks-api-reference.md` (hooks inventory)
