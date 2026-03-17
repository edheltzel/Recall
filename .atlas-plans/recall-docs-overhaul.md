# Recall Documentation Overhaul — Implementation Plan

**Date:** 2026-03-17
**Status:** Approved for next session
**Effort:** Extended (~4-6 hours across 5 phases)

---

## Goal

Transform the 584-line README from a technical manual into a compelling project landing page. Move detailed docs to `docs/`. Add visual aids (Mermaid diagrams, VHS terminal recordings). Zero-friction messaging.

---

## Phase 1: Create docs/ Structure and Move Content

Move detailed documentation out of README into standalone files. Each file should be self-contained and linkable from the README.

### Files to Create

- [ ] **`docs/installation.md`** — Full installation guide
  - Prerequisites (Bun, Node, Claude Code, Fabric, Ollama) with install commands
  - The `install.sh` walkthrough (the "junior dev onboarding" explanation from this session)
  - Verification steps
  - Session extraction setup (automatic + optional cron)
  - Environment variables table
  - Move from README: §Installation, §Environment Variables

- [ ] **`docs/cli-reference.md`** — Complete CLI documentation
  - Every `mem` subcommand with full usage, flags, examples
  - Organized by category: Search, Capture, View, Import, Admin
  - Move from README: §CLI Quick Reference, §Usage (Session Import, LoA, Structured Records, Search, TELOS, Document Import)

- [ ] **`docs/mcp-tools.md`** — MCP tool reference for AI agents
  - Each tool with parameters, return types, usage examples
  - When to use each tool (decision tree)
  - Move from README: §MCP Tools

- [ ] **`docs/architecture.md`** — Technical architecture
  - File layout diagram
  - Database tables with schema
  - Search architecture (FTS5, semantic, hybrid)
  - Extraction pipeline flowchart (Mermaid — Phase 3)
  - Technical details (WAL, FTS5 triggers, permissions)
  - Move from README: §Architecture, §Technical Details

- [ ] **`docs/slash-commands.md`** — Slash command reference
  - Each `/recall:*` command with description and usage
  - Move from README: §Slash Commands

- [ ] **`docs/troubleshooting.md`** — Troubleshooting guide
  - `mem doctor` as first step
  - Each error scenario with diagnosis and fix
  - Move from README: §Troubleshooting

- [ ] **`docs/upgrading.md`** — How to upgrade Recall
  - `git pull && ./install.sh` flow
  - What the migration system does (PRAGMA user_version)
  - Backup & restore instructions
  - Move from README: §Updating, §Backup & Restore

### Gate
All content from README exists in docs/. No information lost.

---

## Phase 2: Rewrite README as Landing Page

The README should read like a project homepage. Target: ~150-200 lines (down from 584).

### New README Structure

```markdown
# Recall — Persistent Memory for Claude Code

[Banner image]

[One-sentence pitch: what it does and why you care]

## The Problem

[2-3 sentences: Claude Code starts fresh every session. You repeat yourself. Context is lost.]

## How Recall Fixes It

[Mermaid diagram: Session → Extract → Store → Search → Next Session]
[3-4 bullet points: auto-extraction, full-text search, zero friction, MCP integration]

## Zero Friction

[2-3 sentences: Install once, forget about it. No workflow changes. It just works.]

## Quick Start

```bash
git clone https://github.com/edheltzel/Recall.git
cd Recall
./install.sh
```

[3-line "verify it works" block]

→ [Full installation guide](docs/installation.md)

## What You Get

[Concise feature list — each one 1 line, maybe with a small Mermaid or emoji]
- Session memory (auto-extracted on every session end)
- Full-text + semantic search
- Decision & learning tracking
- Agent context (spawned agents inherit relevant memory)
- Library of Alexandria (curated knowledge)

## CLI at a Glance

```bash
mem "kubernetes auth"          # Search your memory
mem dump "Session Title"       # Save this session
mem stats                      # See what's stored
mem doctor                     # Health check
```

→ [Full CLI reference](docs/cli-reference.md)

## How It Works

[Mermaid sequence diagram — simplified extraction flow]

→ [Architecture deep dive](docs/architecture.md)

## Documentation

| Guide | Description |
|-------|-------------|
| [Installation](docs/installation.md) | Prerequisites, install, verify |
| [CLI Reference](docs/cli-reference.md) | All commands and options |
| [MCP Tools](docs/mcp-tools.md) | Tools available to AI agents |
| [Architecture](docs/architecture.md) | Database, search, extraction |
| [Upgrading](docs/upgrading.md) | Update & backup |
| [Troubleshooting](docs/troubleshooting.md) | Common issues & fixes |
| [Slash Commands](docs/slash-commands.md) | /recall:* commands |

## For AI Agents

If you're an AI agent, start with [FOR_CLAUDE.md](FOR_CLAUDE.md).

## License

MIT
```

### Gate
README is under 200 lines. All detailed content links to docs/. Value proposition is clear in the first screenful.

---

## Phase 3: Add Mermaid Diagrams

Create visual diagrams that render natively on GitHub.

### Diagrams to Create (inline in relevant docs)

- [ ] **Extraction Pipeline** — in `docs/architecture.md`
  Session End → Stop Hook → Read JSONL → Send to Haiku → Quality Gate → Store

- [ ] **Search Architecture** — in `docs/architecture.md`
  Query → FTS5 / Embeddings / Hybrid → Reciprocal Rank Fusion → Results

- [ ] **How Recall Works** (simplified) — in `README.md`
  You work → Sessions auto-extract → Memory grows → Next session has context

- [ ] **Upgrade Flow** — in `docs/upgrading.md`
  git pull → install.sh → mem init → PRAGMA user_version → Apply migrations

- [ ] **Installation Flow** — in `docs/installation.md`
  install.sh: Backup → Build → Link → Init DB → Register MCP → Register Hooks → Guide

### Gate
All diagrams render correctly on GitHub (test by pushing and viewing).

---

## Phase 4: Create VHS Terminal Recordings

Use [VHS by Charmbracelet](https://github.com/charmbracelet/vhs) to create scripted terminal demo GIFs.

### Prerequisites
```bash
brew install vhs   # includes ttyd + ffmpeg
```

### Recordings to Create

- [ ] **`assets/demo-search.gif`** — `mem "kubernetes auth"` showing search results
- [ ] **`assets/demo-install.gif`** — `./install.sh` output (condensed)
- [ ] **`assets/demo-stats.gif`** — `mem stats` showing database overview
- [ ] **`assets/demo-dump.gif`** — `mem dump "Session Title"` workflow

### VHS Tape Script Example
```tape
# demo-search.tape
Output assets/demo-search.gif
Set FontSize 14
Set Width 900
Set Height 400
Set Theme "Catppuccin Mocha"

Type "mem 'kubernetes auth'" Sleep 500ms Enter
Sleep 3s
```

### Gate
GIFs are under 2MB each, render in GitHub markdown, and accurately represent the CLI output.

---

## Phase 5: Update Cross-References

- [ ] Update `CLAUDE.md` project structure to reflect new docs/ layout
- [ ] Update `FOR_CLAUDE.md` if it references README sections that moved
- [ ] Update any internal links in existing docs (OPENCODE_INTEGRATION.md, PI_INTEGRATION.md)
- [ ] Commit and push all changes
- [ ] Create GitHub release (patch bump v0.5.1 — docs only, no code changes)

### Gate
All internal links work. No broken references. `CLAUDE.md` project structure matches reality.

---

## Recording Research Summary

| Tool | Scriptable | Output | GitHub Embed | Maintained | macOS Install |
|------|-----------|--------|-------------|-----------|---------------|
| **VHS** | Yes (.tape files) | GIF, MP4, WebM, PNG | Yes | Yes (19k stars) | `brew install vhs` |
| asciinema + agg | Semi (record + convert) | .cast → GIF | Via agg | Yes (v3.2.0) | `brew install asciinema agg` |
| svg-term-cli | Yes (pipe) | SVG | Yes | Low activity | `npm install -g svg-term-cli` |
| terminalizer | Semi | GIF, web | Yes | Moderate | `yarn global add terminalizer` |
| ttygif | Semi | GIF | Yes | No (2016) | `brew install ttygif` |

**Winner: VHS** — fully declarative `.tape` scripts that an AI agent can write, outputs multiple formats, actively maintained, Homebrew install. The `.tape` format is simple enough for Claude Code to generate demo recordings automatically.

---

## Phase Summary

| Phase | What | Files | Estimate |
|-------|------|-------|----------|
| 1. Create docs/ | Move content from README | 7 new docs | 60-90 min |
| 2. Rewrite README | Landing page structure | 1 rewrite | 30-45 min |
| 3. Mermaid diagrams | Visual flowcharts | 5 diagrams | 20-30 min |
| 4. VHS recordings | Terminal demo GIFs | 4 recordings | 30-45 min |
| 5. Cross-references | Update links & CLAUDE.md | 3-4 updates | 15-20 min |
| **Total** | | **15-20 files** | **~3-4 hours** |
