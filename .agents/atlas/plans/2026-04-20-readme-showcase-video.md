---
title: Recall README Showcase Video — Plan & Storyboard (v2)
status: Not Started
percent_complete: 5
last_updated: 2026-04-28
phase: Storyboard v2 drafted; production not begun (only basic VHS demo gifs exist)
blockers: Awaiting Ed's answers to open questions in plan + decision on production tooling
next_action: Answer plan's "Open Questions" section, then record Scene 4 (real flow w/ decisions #47–#49)
---

# Recall README Showcase Video — Plan & Storyboard (v2)

**Date:** 2026-04-20
**Goal:** Produce a video for the README that showcases Recall v0.7.22 inside **Claude Code**, using a **real project story** from Ed's actual memory.
**Status:** DRAFT v2 — scope narrowed to Claude Code only; real-project demo using Recall v0.7.x release arc.
**Previous:** v1 (4-surface montage across CLI/Code/Pi/OpenCode) — superseded by this revision.

---

## Scope changes from v1

- **Surfaces:** 4 → 1 (Claude Code only). Pi, OpenCode, CLI removed from scope.
- **Demo data:** hypothetical "kubernetes auth" → real Recall v0.7.x release arc pulled from Ed's memory.db.
- **Hero scene:** no longer a cross-surface montage. New hero is **Scene 4 — The Real Flow**, where Claude cites decision #49/#48/#47 by number when asked about v0.7.

---

## The real story (pulled from Ed's memory, 2026-04-15 → 2026-04-19)

This is what the demo will reference — every fact below is a real record in `~/.claude/memory.db`:

| Type | ID | Summary |
|------|----|---------|
| Decision | #49 | Recall v0.7.0 shipped — v2 foundation (tiered SessionRecall, importance scoring, PreCompact hook, benchmark harness) |
| Decision | #48 | Use pipe `\|` as multi-value CLI separator — commas break on natural phrases |
| Decision | #47 | CLI must use `src/lib/project.ts` for project detection — validateDirPath injection guard |
| Decision | #46 | Landed PR #10 to main — tiered SessionRecall merged |
| Decision | #45 | Phase 2 Suite B shipped — v2 wake-up 34.5% smaller than v1 |
| Learning | #28 | Red team before merge — two parallel adversarial reviewers caught blockers |
| LoA | #26 | v0.7.1 + v0.7.11 hotfix day — two same-day releases |
| Breadcrumb | #11 | Recall v0.7.11 shipped — closes 0.6.x → 0.7.x upgrade path |

The demo prompt: **"Where did we land on Recall v0.7?"** — Claude pulls these records via `memory_search` and cites them by ID.

---

## Feature Inventory (Claude Code–scoped)

### MUST SHOW (the story falls apart without these)
1. **Onboarding** — `mem onboard` seeds L0 identity
2. **Invisible auto-capture** — Stop hook extracts session when closed
3. **SessionStart tiered load** — L0 identity + L1 top-12 banner at wake-up
4. **MCP tool usage in-flight** — Claude calls `memory_search` mid-conversation
5. **Real-time decision capture** — `memory_add` records as decisions are made
6. **Slash commands** — `/recall:search`, `/recall:dump`, `/recall:stats`

### NICE TO SHOW (cut if timing is tight)
7. **Decision lifecycle** — supersede/revert via `mem decision`
8. **Importance & pinning** — `mem pin`, how L1 ranks
9. **Library of Alexandria** — `mem loa write`
10. **Health & stats** — `mem doctor`, `mem stats`
11. **Hybrid vs keyword vs semantic** — `mem` / `mem search` / `mem semantic`
12. **PreCompact safety net** — flush before Claude compacts
13. **Agent context handoff** — `context_for_agent` for subagents

---

## Open Questions (still need Ed's answer)

### Q1 — Length
- **A. 60–75s hero** (my rec)
- B. 2–3 min deep-dive
- C. Hero + linked long-form

### Q2 — Narration
- **A. Silent + captions** (my rec — matches existing tape demos)
- B. Voice-over
- C. Typed terminal comments as narration

### Q3 — Recording
- **A. VHS for terminal moments + QuickTime for Claude Code UI** (my rec)
- B. All QuickTime screen-capture
- C. All VHS (no UI — loses the SessionStart banner visual)

### Q4 — Demo data
- **A. Live memory.db filtered to the v0.7 arc** (my rec — real but scoped; use `RECALL_PROJECT_FILTER=Recall`)
- B. Seeded demo.db clone of the v0.7 arc (safer, but loses "real" feel)
- C. Raw live memory.db (risk of leaking client names or drafts)

### Q5 — Delivery
- **A. Hero GIF on README + full MP4 linked in `assets/`** (my rec)
- B. GIF only
- C. MP4 only

---

## Storyboard v2 — Claude Code only, real Recall v0.7 story (75s, 7 scenes)

### Scene 1 — The Pain (0:00–0:06) · 6s
- Cold terminal. Type: `claude "where did we land on Recall v0.7?"`
- Response: *"I don't have context from previous sessions…"*
- **Caption:** "Claude Code forgets everything."

### Scene 2 — Install & Onboard (0:06–0:16) · 10s
- `./install.sh` → fast-forward to final green line
- `mem onboard` → 2–3 questions flash past → "identity.md written"
- **Caption:** "Install once. Onboard once."

### Scene 3 — SessionStart Magic (0:16–0:30) · 14s
- New Claude Code session starts
- SessionStart banner renders: **L0 identity box** + **L1 top-12** (highlight real decisions #49, #48, #47)
- Banner lines animate in with subtle glow
- **Caption:** "Every session opens with context."

### Scene 4 — The Real Flow ⭐ (0:30–0:46) · 16s · HERO
- Ed: "Where did we land on Recall v0.7?"
- Claude invokes `memory_search` (tool call visible inline)
- Results surface — decisions #49, #48, #47, learning #28
- Claude's reply cites them: *"You shipped v0.7.0 on 2026-04-18. Key decisions: pipe separator (#48), project.ts guard (#47, caught by red team per learning #28)…"*
- **Caption:** "Memory reads before tools."

### Scene 5 — Capture in Real Time (0:46–0:54) · 8s
- Ed: *"For v0.8, let's consolidate the hooks into one script."*
- Claude uses `memory_add` → new decision #50 recorded with confidence: high
- Brief toast: *"Decision #50 saved"*
- **Caption:** "Decisions persist the moment they're made."

### Scene 6 — Depth Reel (0:54–1:08) · 14s
Rapid 3.5s cuts:
1. `mem decision list` — #50 at the top, pinned
2. `mem pin decisions 50` → importance jumps to 10
3. `mem loa write` → Library of Alexandria entry queued
4. `mem doctor` → green checkmarks cascading
- **Caption:** "Lifecycle. Importance. Knowledge. Health."

### Scene 7 — Close (1:08–1:15) · 7s
- Banner: **Recall** · "Persistent memory for Claude Code"
- Final line: `git clone ... && ./install.sh`
- Cut to black
- **Caption:** "MIT · github.com/edheltzel/Recall"

**Total:** 75 seconds · 7 scenes · 0 hypotheticals.

---

## Production Steps

1. **Scope the demo DB** — either (a) filter live `memory.db` to `project=Recall` for recording, or (b) export the v0.7 arc records to a seeded demo.db.
2. **Sanitize** — scrub terminal history, temp files, and any `ed@rainyday.media` references that shouldn't be public.
3. **Record Scene 1, 5, 6 terminal cuts** — VHS tapes (`demo-scene-N.tape`).
4. **Record Scenes 2, 3, 4, 7** — QuickTime screen-capture at 1440×900 of a real Claude Code session.
5. **Edit & assemble** — ffmpeg or CapCut; add captions per scene; keep color palette consistent with existing demo GIFs (Catppuccin Mocha).
6. **Export** — `assets/hero.gif` (≤5MB, 800px wide) + `assets/showcase.mp4` (1080p).
7. **Update README** — replace the `<details><summary>See it in action</summary>` block with the hero video; link to MP4.

---

## Risks & Mitigations

- **Drift** — real decision numbers in the demo will be off once #50+ are made. Mitigation: freeze a snapshot of memory.db for recordings; note the recording date in README caption.
- **Privacy** — live memory.db may contain client names from Alianza/Peptideware/etc. Mitigation: `RECALL_PROJECT_FILTER=Recall` flag (or add one) during recording so only Recall-scoped records surface.
- **Feature churn** — depth reel commands may rename between recordings and README publish. Mitigation: pin Recall version in README (`v0.7.22 · recorded 2026-04-MM`).

---

## Next Actions

- [ ] Ed answers Q1–Q5 (or confirms my recs)
- [ ] Decide on demo DB approach (Q4 sub-question: live-filtered vs. seeded)
- [ ] Lock storyboard v3 → begin production
