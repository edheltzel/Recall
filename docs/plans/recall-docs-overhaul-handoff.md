# Handoff: Recall Documentation Overhaul

**From session:** 2026-03-17 (SessionExtract SQLite Migration + Docs Planning)
**For:** Next session that implements the docs overhaul
**Plan:** `docs/plans/recall-docs-overhaul.md`

---

## What Was Done This Session

1. **SessionExtract SQLite Migration** — Complete (v0.5.0 released)
   - 4 extraction tables, 5 hook modules, PRAGMA user_version migration system
   - 197 tests, all passing
   - Real data migrated (1,123 tracker + 216 sessions + 65 error patterns)
   - Branch squash-merged to main, release created

2. **Docs overhaul plan** — Written and ready for approval
   - 5-phase plan at `docs/plans/recall-docs-overhaul.md`
   - Terminal recording tool researched (VHS by Charmbracelet = winner)
   - New README structure designed (~150-200 lines vs current 584)

---

## What Needs To Be Done Next

### Phase 1: Create `docs/` files (7 new files)
Move content from README.md into:
- `docs/installation.md` — includes the "junior dev onboarding" install walkthrough
- `docs/cli-reference.md` — full command reference
- `docs/mcp-tools.md` — MCP tool reference
- `docs/architecture.md` — technical deep dive
- `docs/slash-commands.md` — /recall:* commands
- `docs/troubleshooting.md` — error scenarios
- `docs/upgrading.md` — update + backup + migration system

### Phase 2: Rewrite README (~150-200 lines)
Structure: Problem → Solution → Zero Friction → Quick Start → Features → CLI Glance → Docs Table

### Phase 3: Mermaid diagrams (5 diagrams)
Extraction pipeline, search architecture, how-it-works, upgrade flow, install flow

### Phase 4: VHS terminal recordings (4 GIFs)
Install VHS first: `brew install vhs`
Create `.tape` scripts for: search, install, stats, dump

### Phase 5: Cross-references
Update CLAUDE.md, FOR_CLAUDE.md, internal links

---

## Key Context for Next Session

- **Current README:** 584 lines, 35 sections — all in one file
- **Target README:** ~150-200 lines, focused on value proposition
- **docs/ already has:** `OPENCODE_INTEGRATION.md`, `PI_INTEGRATION.md`, `superpowers/` (specs/plans)
- **VHS install:** `brew install vhs` (requires ttyd + ffmpeg, bundled)
- **Version:** v0.5.0 (docs-only changes would be v0.5.1 patch)

---

## Files to Read First

1. `docs/plans/recall-docs-overhaul.md` — the full plan with phase details
2. `README.md` — current state (what you're restructuring)
3. `CLAUDE.md` — project conventions and structure (needs updating after)

---

## Decision Log

| Decision | Reasoning |
|----------|-----------|
| VHS for recordings | Scriptable .tape files, GIF output, brew install, AI-writable |
| Flat docs/ structure | Simple, scannable, no nesting needed for 7 files |
| Mermaid for diagrams | Native GitHub rendering, no external tools |
| ~150-200 line README target | Enough to sell + orient, not enough to overwhelm |
| Keep FOR_CLAUDE.md separate | It's for AI agents, not human README readers |
