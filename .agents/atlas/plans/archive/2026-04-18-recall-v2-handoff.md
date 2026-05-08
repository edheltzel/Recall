---
title: Recall v2 — Handoff
status: Complete
percent_complete: 100
last_updated: 2026-04-28
phase: v0.7.0 release shipped (PR #11 merged, sprints 1/2/4 + Suite B in main)
blockers: none
next_action: Archive — handoff consumed; live priorities now tracked in MemPalace plan + new CLI/npm plans
---

# Recall v2 — Handoff

**Date:** 2026-04-18
**Author session:** Atlas (Claude Code) + Ed
**Read-time:** ~5 minutes
**Purpose:** Resume v2 work cold — what shipped, what's open, what's next, what needs your call.

---

## TL;DR

- **v2 foundation is on `main`.** Three sprints + the benchmark harness landed via PR #10 (`cd5eeed`).
- **One PR is open and unmerged: #11 — `mem onboard`.** Closes the L0 identity-tier UX gap. 11 new tests, 292 total pass on the branch. Ready to merge.
- **Strategic direction (decided 18 Apr):** Recall = shared memory layer for ALL AI agents, not just coding agents. Reframes the rest of the roadmap.
- **Recommended next sprint:** #6 multi-format conversation import — bridges to the shared-memory direction. ~1–2 days. Unlocks Phase 4 doc-import as a sibling.

---

## State of the repo (as of 2026-04-18)

### main
- HEAD: `25101cc removes maestro dir`
- Last 5 commits:
  - `25101cc` removes maestro dir _(Ed cleaned up the .maestro/* deletions surfaced in PR #10's recap)_
  - `cd5eeed` Merge PR #10 (v2 foundation)
  - `f6ad03c` Phase 2 Suite B — benchmark harness
  - `3cebec0` Sprint #2 — PreCompact hook
  - `61526ce` Sprint #1+#4 — tiered SessionRecall + importance scoring
- Tests on main: **281 pass / 0 fail** (pre-PR-#11 baseline)
- Build: clean (ESM + DTS)

### Open PRs

| # | Title | State | Branch | Diff | Action needed |
|---|---|---|---|---|---|
| **11** | feat(onboard): mem onboard — interactive interview for L0 identity tier | OPEN | `worktree-onboarding-l0-identity` | +498 / −1 across 4 files | Review and merge |

PR #11 url: https://github.com/edheltzel/Recall/pull/11

### Worktrees

```
/Users/ed/Developer/atlas-recall                                          25101cc [main]
/Users/ed/Developer/atlas-recall/.claude/worktrees/onboarding-l0-identity a4e1fcc [worktree-onboarding-l0-identity]   ← PR #11
/Users/ed/Developer/atlas-recall/.worktrees/procedure-detection           cc6fe7c [feature/procedure-detection]      ← unrelated, pre-existing
```

### Stale local branches (need triage — see Cognitive debt)

```
feature/recall-phase2     ~50 files diverged from main
feature/recall-phase3     ~50 files diverged from main
feature/recall-phase4     ~43 files diverged from main
```

These are listed in the recap's "Cognitive debt — High severity" tile. Status uncertain — may pre-date the MemPalace research arc, may be abandoned, may contain salvageable work. Don't merge blind.

---

## What v2 shipped (already on main)

From the visual recap at `~/.agent/diagrams/recall-v2-recap.html` — these are verified working:

1. **Tiered SessionRecall** — `hooks/SessionRecall.ts` rewritten as L0 identity + L1 importance-ranked top-12 with 4 reserved LoA slots
2. **Importance scoring** — migration 7→8 added `importance INTEGER (1-10)` to messages, decisions, learnings, loa_entries
3. **LoA write-time floor of 5** — enforced in `createLoaEntry`; backfill never demotes LoA
4. **PreCompact hook** — `hooks/SessionPreCompact.ts`, flush-only to SQLite, byte-offset watermark, cooperates with Stop's lock
5. **Benchmark harness** — `benchmarks/runner.ts` + Suite B (token efficiency); 5 methodology rules locked in
6. **CLI surface** — `mem importance backfill`, `mem pin`, `mem unpin`, `mem benchmark run/list/report`
7. **MCP surface** — `memory_add` accepts importance; tool set unchanged otherwise

**First measured numbers** (from `benchmarks/results/2026-04-17T21-35-33-suite-B.jsonl`):
- v2 wake-up bundle: **5,961 chars (~1,491 tokens est)**
- v1 baseline: 8,020 chars (v2 is 34.5% smaller)
- CLAUDE.md baseline: 8,760 chars (v2 is 47% smaller)
- L1 holds 12 records; **5 are LoA** (one above the 4-slot reservation floor — importance ranking elevates curation as designed)

---

## Strategic direction (decided 18 Apr)

> **Recall = shared memory layer for ALL AI agents.**
> Switching from Claude Code → Codex → Slack → ChatGPT preserves memory continuity.
> Concrete example: fix a bug in OpenCode, then ask Slack about it later, get the right answer.

This reframes the roadmap:

| Was (coding-agent focused) | Becomes (universal memory layer) |
|---|---|
| Sprint #6 = nice-to-have import | Sprint #6 = **bridge** to non-coding surfaces |
| Phase 3 (Postgres/Turso) = "interesting if Phase 4 happens" | Phase 3 = required for multi-device personal memory |
| Phase 4 (non-coding expansion) = optional | Phase 4 = **the actual product** |
| Need: more coding-agent integrations | Need: adapter pattern for any agent surface |

**Architectural foundation already supports this.** MCP is host-agnostic; extraction is reusable. The gap is **capture breadth** — adapters for non-coding surfaces don't exist yet.

---

## Next-sprint shortlist (in recommended order)

### 1. Merge PR #11 (`mem onboard`)
**Effort:** 5 minutes (review + merge)
**Why:** Closes the L0 UX gap that bit Ed personally yesterday. Once merged, future installs get a one-command identity-file setup.
**Cleanup after merge:**
```bash
gh pr merge 11 --merge --delete-branch
git pull --ff-only origin main
git worktree remove .claude/worktrees/onboarding-l0-identity
git branch -d worktree-onboarding-l0-identity
```

### 2. Run `mem onboard` on your own machine
**Effort:** 2–3 minutes
**Why:** L0 tier is wired but empty in production (`v2_l0_chars: 0` in the last benchmark). Writing your own `identity.md` is the smallest thing that makes the v2 design fully visible.
```bash
mem onboard          # interactive
# or:
mem onboard --print --yes   # preview the auto-detected defaults first
```
After: `mem benchmark run B` should now show `v2_l0_chars > 0`.

### 3. Sprint #6 — Multi-format conversation import
**Effort:** ~1–2 days
**Why:** Bridge to the shared-memory direction. Adds `mem import-conversations` with adapters for Claude.ai JSON, ChatGPT JSON, Slack JSON. Pipes imports through the existing Haiku extraction path so backfilled conversations get the same treatment as live sessions.
**Schema:** additive (no migration needed)
**Files (planned):**
- `src/commands/import-conversations.ts` (new)
- `src/lib/import-adapters/{claude-web,chatgpt,slack}.ts` (new)
- `tests/lib/import-adapters/*.test.ts` (new)

### 4. Codex Stop-hook adapter
**Effort:** ~half-day
**Why:** Smallest possible proof that "any coding agent" works — a Stop hook for OpenAI Codex CLI calling into the same extraction path as Claude Code's. Validates the adapter pattern before investing in heavier integrations.

### 5. Phase 2 Suite A — cross-session recall
**Effort:** ~3–4 days
**Why:** The hardest-to-build benchmark, but the one that actually tests "does Recall remember across sessions?" Defines methodology for retrieval-presence + answer-accuracy as separate metrics, scored by Sonnet against a synthetic scenario generator. Locks the pattern for Suites C/D/E.

### 6. Slack consumer bot — first non-coding-agent surface
**Effort:** ~1–2 days
**Why:** A Slack bot calling `mem-mcp` to answer questions from your Recall memory. `/recall what was that webhook fix?` → answer from the same DB Claude Code uses. First concrete demo of cross-agent shared memory. Pairs with Sprint #6 for live ingestion.

### 7. Phase 3 (Turso/libSQL backend) — DECIDE based on multi-device need
**Effort:** ~3 days
**Why:** Only worth investing if you want Recall on a phone or want collaborators. libSQL is SQLite-compatible at the wire level; the migration is essentially `bun:sqlite` → `@libsql/client` with embedded-replica mode for sync.
**Decision:** Skip if Recall stays single-device.

---

## Open questions waiting on Ed

1. **Merge PR #11?** (recommended yes — review + `gh pr merge 11 --merge --delete-branch`)
2. **Stale `feature/recall-phase{2,3,4}` branches** — keep, rebase, or delete? Recap flagged as High-severity cognitive debt.
3. **Sprint #6 sequencing** — start it in a fresh worktree, or finish another item first?
4. **Phase 4 commitment** — confirmed conceptually 18 Apr; needs a concrete scoping decision before Sprint #6 design (e.g., do we add a `memory_type` enum for episodic/semantic/procedural per the research findings?)
5. **Public benchmarks** — `benchmarks/results/*.md` is committed today. Should it be? (Decision affects the README story too.)

---

## How to resume cold (any agent, any session)

If you're picking this up days/weeks from now:

```bash
# 1. Check the state
cd ~/Developer/atlas-recall
git log --oneline -5
git status
gh pr list --state open

# 2. Read the visual recap (still accurate as of 18 Apr)
open ~/.agent/diagrams/recall-v2-recap.html

# 3. Check what's in your local memory (and write identity.md if not yet done)
mem stats
mem benchmark run B    # see if v2_l0_chars is still 0

# 4. Read the v2 plan + this handoff
ls .atlas-plans/
cat .atlas-plans/2026-04-17-mempalace-research-borrow-list.md
cat .atlas-plans/2026-04-18-recall-v2-handoff.md

# 5. Search Recall for the latest decisions about this work
mem search "shared memory layer all agents"
mem search "L0 identity tier onboard"
mem search "MemPalace sprint"
```

The most recent decisions (`mem decision list --limit 10`) carry the rationale for everything in this handoff.

---

## Reference index

- **v2 plan + decisions:** `.atlas-plans/2026-04-17-mempalace-research-borrow-list.md`
- **Visual recap:** `~/.agent/diagrams/recall-v2-recap.html`
- **Benchmark baseline:** `benchmarks/results/2026-04-17T21-35-33-suite-B.jsonl` (and `.md` alongside)
- **Hooks API ref:** `.atlas-plans/2026-04-01-claude-code-hooks-api-reference.md`
- **PR #10 (merged):** https://github.com/edheltzel/Recall/pull/10
- **PR #11 (open):** https://github.com/edheltzel/Recall/pull/11
- **Per-host AI guides:** `FOR_CLAUDE.md`, `FOR_OPENCODE.md`, `FOR_PI.md`
- **Methodology rules:** `benchmarks/README.md`

---

**Status when this handoff was written:** waiting on Ed to (a) merge PR #11, (b) decide on stale branches, (c) greenlight Sprint #6 or another item.
