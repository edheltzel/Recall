# Design: /clear Session Capture for Recall

> **Status:** Draft — pending Red Team validation
> **Date:** 2026-03-17
> **Problem:** When a user runs `/clear` in Claude Code, the session context goes unextracted until BatchExtract cron runs (up to 30 minutes later).

---

## Research Summary

### How /clear Works in Claude Code

- `/clear` creates a **new session** with a new UUID and new JSONL file
- The **old JSONL file persists on disk** — it is NOT deleted
- The old session can be resumed with `/resume`
- `/clear` aliases: `/reset`, `/new`

### Hook Events Around /clear

| Hook | Fires on /clear? | Reliable? | What it receives |
|------|:-:|:-:|---|
| `SessionEnd` (reason: "clear") | Documented yes | **BUGGY** — [#6428](https://github.com/anthropics/claude-code/issues/6428) reports it doesn't fire | transcript_path of OLD session |
| `SessionStart` (source: "clear") | Yes | **Reliable** | transcript_path of NEW session |
| `Stop` | After next response | Yes, but gets NEW session path | transcript_path may not exist yet ([#3046](https://github.com/anthropics/claude-code/issues/3046)) |
| `UserPromptSubmit` | No | N/A | Slash commands bypass this hook |

### Current Recall Extraction Pipeline

- `SessionExtract.ts` registered on `Stop` event only
- Finds JSONL by scanning project dir for most recent file by mtime (does NOT use transcript_path from input)
- `--reextract <path> <cwd>` mode processes arbitrary files
- `.extraction_tracker.json` prevents duplicates, allows 50% growth re-extraction
- `BatchExtract.ts` (cron every 30min) scans all project dirs as safety net
- Extraction is stateless and file-based — works on any JSONL at any time

### Critical Bugs to Account For

1. **SessionEnd may not fire on /clear** — [#6428](https://github.com/anthropics/claude-code/issues/6428) (still open)
2. **Stop hook after /clear gets nonexistent transcript_path** — [#3046](https://github.com/anthropics/claude-code/issues/3046)
3. **cleanupPeriodDays: 0 silently destroys ALL JSONL files** — [#23710](https://github.com/anthropics/claude-code/issues/23710)
4. **Sessions auto-deleted after 30 days** by default

---

## Architecture

### Belt-and-Suspenders: Three Layers

```
Layer 1: SessionEnd hook (best-effort, may not fire)
    └── ClearExtract.ts → spawn background extraction

Layer 2: SessionStart hook (reliable, fires after /clear)
    └── ClearContext.ts → inject memory into new session
    └── Also: scan for unextracted previous JSONL as fallback

Layer 3: BatchExtract cron (every 30 minutes)
    └── Catches everything that slipped through Layers 1 and 2
```

### Data Flow

```
User types /clear
       │
       ├──► SessionEnd fires (IF NOT BUGGY)
       │    └── ClearExtract.ts
       │         ├── Read transcript_path from stdin
       │         ├── Check extraction tracker
       │         ├── Append to .pending_extractions.jsonl
       │         ├── Spawn background: SessionExtract.ts --reextract <path> <cwd>
       │         └── Exit 0 (< 100ms)
       │
       └──► SessionStart fires (RELIABLE)
            └── ClearContext.ts
                 ├── Confirm source === "clear"
                 ├── Scan project dir for unextracted JSONL (Layer 2 fallback)
                 │    └── If found & not being extracted → spawn background extraction
                 ├── Read HOT_RECALL.md + SESSION_INDEX.json
                 ├── Output { "additionalContext": "<brief summary>" }
                 └── Exit 0 (< 50ms)

Background (concurrent):
  SessionExtract.ts --reextract <old_transcript_path> <cwd>
  └── Full Haiku extraction → update all memory files
```

---

## New Files

### hooks/ClearExtract.ts (SessionEnd hook)

**Registration:** `SessionEnd` with `matcher: "clear"`

**Behavior (must complete in < 1.5s):**
1. Parse stdin JSON → extract `transcript_path`, `cwd`, `session_id`
2. `statSync(transcript_path)` — verify file exists, check size > 2KB
3. Load `.extraction_tracker.json` → check if already extracted
4. If not extracted: append entry to `.pending_extractions.jsonl`
5. Spawn detached: `bun run SessionExtract.ts --reextract <path> <cwd>`
6. Exit 0

**Self-contained:** Duplicates lock/tracker utilities from SessionExtract.ts (project convention).

**Falls back to CWD scan** if `transcript_path` is missing from input.

### hooks/ClearContext.ts (SessionStart hook)

**Registration:** `SessionStart` with `matcher: "clear"`

**Behavior:**
1. Parse stdin JSON → confirm `source === "clear"`
2. Derive encoded CWD → scan project dir for JSONL files
3. Identify the SECOND most recent JSONL (the one that just ended, not the new empty one)
4. Check extraction tracker — if not extracted and Layer 1 didn't fire, spawn background extraction
5. Read `~/.claude/MEMORY/HOT_RECALL.md` (last ~2 sessions, < 300 chars)
6. Read `~/.claude/MEMORY/SESSION_INDEX.json` (last 2 entries)
7. Output `{ "additionalContext": "<context block>" }` to inject into new session
8. Exit 0

**Context injection format:**
```
[Recall: Previous session context]
Last session: <summary>
Key decisions: <first 2 bullets>
(Full extraction running in background)
```

---

## Changes to install.sh

1. Copy `ClearExtract.ts` and `ClearContext.ts` to `~/.claude/hooks/`
2. Register `SessionEnd` hook with `matcher: "clear"` pointing to ClearExtract.ts
3. Register `SessionStart` hook with `matcher: "clear"` pointing to ClearContext.ts
4. Guard against duplicate registration (existing pattern)
5. Idempotent — safe to re-run

---

## Changes to Existing Files

**SessionExtract.ts** — No changes required. The `--reextract` mode already handles delegated extraction.

**BatchExtract.ts** — No changes required. Remains the Layer 3 safety net.

**install.sh** — Extended to copy and register 2 new hooks.

---

## Edge Cases

| Scenario | Handling |
|----------|---------|
| SessionEnd doesn't fire (bug #6428) | ClearContext.ts (SessionStart) catches it as fallback |
| Both SessionEnd AND SessionStart fire | Extraction tracker + lock files prevent double extraction |
| JSONL file < 2KB (trivial session) | Size check skips extraction — not worth capturing |
| Rapid /clear spam | Each /clear creates distinct JSONL; each extracts independently |
| /clear during active tool execution | Tool completes, then /clear fires; JSONL has full conversation |
| Background extraction fails | Tracker marks failure with 24h retry; BatchExtract catches it |
| Bun not found | Hook exits 1; BatchExtract catches it on next cron run |
| transcript_path missing from input | Fall back to CWD-based directory scan |
| Disk full | Write to .pending_extractions.jsonl fails; BatchExtract catches it |
| Sessions auto-deleted (30 day default) | Recommend setting cleanupPeriodDays to 99999 in install.sh |

---

## Performance

- ClearExtract.ts: < 100ms (local I/O only, no network)
- ClearContext.ts: < 50ms (read 2 small files)
- Background extraction: 5-30s (async, non-blocking)
- User perceives zero delay from /clear

---

## Migration

- **New installs:** Automatic — install.sh handles everything
- **Existing installs:** Re-run `./install.sh` — idempotent, adds new hooks without touching existing config
- **Manual:** Copy 2 hook files + add 2 entries to settings.json

---

## Important: Existing Hook Registrations

Ed's machine already has PAI hooks registered on `SessionEnd` and `SessionStart` in `settings.json`. The install.sh changes must ADD Recall's hooks to the existing arrays, not replace them. The existing PAI hooks include:
- `SessionEnd`: WorkCompletionLearning.hook.ts, SessionSummary.hook.ts (90s timeout each)
- `SessionStart`: Various PAI hooks with startup/clear/resume matchers

The Recall hooks should be added as ADDITIONAL entries in these arrays, not replacements.

## Open Questions

1. Should install.sh set `cleanupPeriodDays` to a high value to prevent auto-deletion of unextracted sessions?
2. Should ClearContext.ts also fire on `source: "startup"` to inject memory into every new session (not just post-/clear)?
3. Should we add a `PreCompact` hook to capture context before compaction (separate from /clear)?
4. The extraction tracker shows 81% failure rate (917/1135 entries failed) — should we address extraction reliability alongside /clear capture?

---

## Red Team Validation

### Critical Findings (Must Fix)

**1. Copy-before-clear pattern (MANDATORY)**
The current design depends on the original JSONL remaining at its path for extraction. But `cleanupPeriodDays` (default 30 days) can delete it first. **Fix: ClearExtract.ts must COPY the JSONL to `~/.claude/MEMORY/pending/` before spawning background extraction.** Extraction reads from the copy, not the original. This decouples extraction from Claude Code's cleanup entirely.

**2. Bun PATH problem in hooks and cron**
Hooks run via `/bin/sh` with minimal PATH. Bun at `~/.bun/bin/bun` is invisible. **Fix: ClearExtract.ts must resolve Bun path explicitly** using the same candidate-array pattern already in SessionExtract.ts. BatchExtract cron entry must use absolute path to Bun.

**3. Silent data loss — no observability**
All failure paths are silent. User has no feedback loop. **Fix: `mem doctor` must validate all three extraction layers are functioning. Consider running a mini health check on first /clear after install.**

**4. ClearContext injects stale memory**
ClearContext reads HOT_RECALL.md which reflects the state BEFORE the just-cleared session (since extraction hasn't completed yet). This is acknowledged but users may be surprised. **Fix: Document this behavior. Add "(from prior sessions)" qualifier to injected context.**

**5. `.pending_extractions.jsonl` concurrent append corruption**
Concurrent appends are not atomic on all filesystems. **Fix: Use exclusive file locking (`flock`) around the append, or use one-file-per-extraction in `~/.claude/MEMORY/pending/` instead of a shared JSONL.**

**6. cleanupPeriodDays landmine**
- Default 30 days silently deletes sessions
- `cleanupPeriodDays: 0` silently destroys ALL session persistence (#23710)
- **Fix: install.sh should set `cleanupPeriodDays: 99999` and document why**

### Medium Severity Findings

**7. Background process pile-up** — Rapid /clear in agentic workflows spawns unbounded background extractions. Fix: Add a concurrency semaphore (max 3 concurrent extractions).

**8. Prompt injection via HOT_RECALL.md** — Adversarial content from prior sessions could be injected into new session context. Fix: Keep injected context brief and factual (summaries only, no raw conversation).

**9. JSONL may be incompletely flushed** — Claude Code may not have fully written the last turn before firing SessionEnd. Fix: The copy-before-clear pattern mitigates this since we copy whatever is flushed at hook time.

**10. Fish shell PATH issue** — Ed's shell is fish, but hooks run in bash/sh. Bun added to PATH via fish config is invisible to hooks. Already mitigated by absolute path resolution.

### Accepted Risks

- SessionEnd (#6428) may not fire — accepted, Layer 2 + 3 cover this
- ClearContext provides stale-by-one-session context — acceptable trade-off for zero latency
- Worktree sessions may have different CWD encoding — edge case, BatchExtract catches it

### Design Alternatives Recommended

| Alternative | Recommendation |
|-------------|----------------|
| **Copy-before-clear** (copy JSONL to pending/) | **ADOPT — eliminates cleanup landmine** |
| **Write-ahead extraction** (extract every N turns) | Consider for v2 — reduces /clear impact to near-zero |
| **Single staging file** (ClearExtract writes CLEAR_CONTEXT.md for ClearContext) | ADOPT — explicit handoff, inspectable state |
| **Pre-clear via UserPromptSubmit** | Not possible — slash commands bypass UserPromptSubmit |

### Revised Architecture (Post-Red-Team)

```
User types /clear
       │
       ├──► SessionEnd fires (IF NOT BUGGY — Layer 1)
       │    └── ClearExtract.ts
       │         ├── Read transcript_path from stdin
       │         ├── COPY JSONL to ~/.claude/MEMORY/pending/<uuid>.jsonl  ← NEW
       │         ├── Check extraction tracker
       │         ├── Spawn background: SessionExtract.ts --reextract <pending_copy> <cwd>
       │         └── Exit 0 (< 100ms)
       │
       └──► SessionStart fires (RELIABLE — Layer 2)
            └── ClearContext.ts
                 ├── Confirm source === "clear"
                 ├── Scan pending/ for unprocessed copies (fallback if Layer 1 missed)
                 │    └── If found → spawn background extraction
                 ├── Read HOT_RECALL.md + SESSION_INDEX.json
                 ├── Output { "additionalContext": "..." }
                 └── Exit 0

Layer 3: BatchExtract cron (every 30 min)
         └── Scans all project dirs + pending/ for unextracted files
```

**Key change: extraction now reads from `~/.claude/MEMORY/pending/` copies, not original JSONL paths. This eliminates the cleanupPeriodDays race condition entirely.**

---

## References

- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks)
- [SessionEnd bug #6428](https://github.com/anthropics/claude-code/issues/6428)
- [Stop hook transcript_path bug #3046](https://github.com/anthropics/claude-code/issues/3046)
- [cleanupPeriodDays bug #23710](https://github.com/anthropics/claude-code/issues/23710)
- [PreClear feature request #26052](https://github.com/anthropics/claude-code/issues/26052)
- [Simon Willison: Don't let Claude delete your logs](https://simonwillison.net/2025/Oct/22/claude-code-logs/)
