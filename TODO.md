---
kanban-plugin: board
---

## Outstanding

- [ ] Generated Oct 9, 2026 from GitHub (edheltzel/Recall, main @ 529400b). No open PRs at generation time.
- [ ] Cut a Recall release so Jev scoring ([#293](https://github.com/edheltzel/Recall/pull/293), [#295](https://github.com/edheltzel/Recall/pull/295)) reaches release installs. Latest release v0.9.4 (Jul 15) predates it. (from Recall room, Oct 9)
- [ ] [#287](https://github.com/edheltzel/Recall/issues/287) First-class Cursor host support (installer-owned, not marketplace plugin). Cursor still snippet-only; no Cursor guide on main.
- [ ] [#286](https://github.com/edheltzel/Recall/issues/286) Optional hook: Sentinel session capture and LOA score. Idea; optional Sentinel hook.
- [ ] [#281](https://github.com/edheltzel/Recall/issues/281) Recall Telos interview slash (copy PAI process, not the stack). Parked per spec; no wiring.
- [ ] [#280](https://github.com/edheltzel/Recall/issues/280) Slash-export windowed learnings to a user-chosen Obsidian folder. Parked; learnings-only export.
- [ ] [#279](https://github.com/edheltzel/Recall/issues/279) Learn prefs into global AGENTS.md (and CLAUDE.md) below a Recall marker. Not started.
- [ ] [#278](https://github.com/edheltzel/Recall/issues/278) CREATE_TABLES lags migrations: decisions/learnings missing confidence. Confirmed on main: decisions/learnings CREATE TABLE lack confidence.
- [ ] [#277](https://github.com/edheltzel/Recall/issues/277) templates/mcp.json.template still registers mem-mcp. Confirmed on main: templates/mcp.json.template still uses mem-mcp.
- [ ] [#269](https://github.com/edheltzel/Recall/issues/269) Collapse host identity lists toward SESSION_SOURCES. #282 added cursor to SESSION_SOURCES only; lists not collapsed.
- [ ] [#266](https://github.com/edheltzel/Recall/issues/266) P2: Bun-free runtime spike (do not crowd Cursor/Grok). P2 spike; parked.
- [ ] [#265](https://github.com/edheltzel/Recall/issues/265) Eval déjà vu ssh-sync vs Turso/libSQL epic #102. Eval only; ties to #102.
- [ ] [#264](https://github.com/edheltzel/Recall/issues/264) Point-of-action breadcrumbs from file/command/edit spans. Parked; depends on import walk (#260).
- [ ] [#260](https://github.com/edheltzel/Recall/issues/260) Install-time Cursor import TUI: catalog, review records, write last. #282 shipped catalog only; no import TUI yet.
- [ ] [#256](https://github.com/edheltzel/Recall/issues/256) Borrow Observational Memory ideas into Recall. Research borrow; not started.
- [ ] [#253](https://github.com/edheltzel/Recall/issues/253) Sunset the TELOS sync integration (RecallTelosSync.ts). hooks/RecallTelosSync.ts still on main.
- [ ] [#250](https://github.com/edheltzel/Recall/issues/250) Long-session tails never reach memory: GROWTH_THRESHOLD tolerates an unbounded unextracted remainder. GROWTH_THRESHOLD still 0.5 in RecallBatchExtract.ts.
- [ ] [#234](https://github.com/edheltzel/Recall/issues/234) feat: query intent classification for hybrid search — auto-derive --bias-type + signal weighting from the query (extends #82). Steal-later; needs relevance harness first.
- [ ] [#233](https://github.com/edheltzel/Recall/issues/233) feat: --readonly mode — guaranteed non-mutating DB access for agents and the dashboard (borrowed from mnemon). Steal-later; not started.
- [ ] [#232](https://github.com/edheltzel/Recall/issues/232) feat: recall review — interactive human-in-the-loop preview of aging/dedup/prune candidates (borrowed from mnemon gc). Steal-now borrow; not started.
- [ ] [#227](https://github.com/edheltzel/Recall/issues/227) Test debt from #217: at-scale ordering parity, real-chain self-heal integration, consolidated coverage gaps. Test debt from #217.
- [ ] [#226](https://github.com/edheltzel/Recall/issues/226) Harden vec index: zero-vector guard, index-format version stamp, doctor/stats vec observability. Vec hardening; no fix found.
- [ ] [#221](https://github.com/edheltzel/Recall/issues/221) create a website and web ui dashboard. Website and dashboard idea.
- [ ] [#212](https://github.com/edheltzel/Recall/issues/212) harden: applyConnectionPragmas sets journal_mode=WAL before busy_timeout — WAL-recovery not covered by timeout. Confirmed on main: WAL pragma still runs before busy_timeout.
- [ ] [#211](https://github.com/edheltzel/Recall/issues/211) harden: real interleaved concurrency test for getDb migrate-on-open + read-path latency note. Concurrency test gap.
- [ ] [#194](https://github.com/edheltzel/Recall/issues/194) harden: add email/phone/path redaction patterns to scrub; gate name-redaction as anchored opt-in. Scrub patterns not added.
- [ ] [#193](https://github.com/edheltzel/Recall/issues/193) feat: frecency-in-ranking evidence/benchmark behind a default-off flag (informs #155). Default-off frecency flag; informs #155.
- [ ] [#192](https://github.com/edheltzel/Recall/issues/192) harden: bound WAL growth — centralize journal_size_limit across all Recall DB writers. No journal_size_limit on main.
- [ ] [#182](https://github.com/edheltzel/Recall/issues/182) harden: scrub() learnings.tags on the explicit add paths (un-redacted secret persist, LOW). Scrub learnings.tags on add paths.
- [ ] [#178](https://github.com/edheltzel/Recall/issues/178) chore: scrub-archive hostile-fs tests no-op-pass under root (add uid skip-guard). Root uid skip-guard for tests.
- [ ] [#174](https://github.com/edheltzel/Recall/issues/174) docs: stale backup path ~/.claude/backups/recall in installation.md + upgrading.md. Confirmed on main: docs still say ~/.claude/backups/recall (also architecture.md).
- [ ] [#163](https://github.com/edheltzel/Recall/issues/163) harden: recall hybrid/semantic CLI crash on embedding dim mismatch. CLI cosineSimilarity calls still unguarded in embed.ts.
- [ ] [#155](https://github.com/edheltzel/Recall/issues/155) B3: Blend frecency into ranking (importance #101 + L1 recall #100 + search order). needs:human; ranking change waits on Ed.
- [ ] [#106](https://github.com/edheltzel/Recall/issues/106) spike: evaluate oMLX as a local embedding backend to replace Ollama. oMLX spike; coupled with embedding choice.
- [ ] [#103](https://github.com/edheltzel/Recall/issues/103) Phase 4 (epic): Recall Beyond Coding Agents (pending go/no-go). Epic waiting on go/no-go.
- [ ] [#102](https://github.com/edheltzel/Recall/issues/102) Phase 3 (epic): Backend Portability — Turso/libSQL multi-device (pending go/no-go). Epic waiting on go/no-go.

## Needs a check to confirm

- [ ] MCP SDK decision: bump @modelcontextprotocol/sdk 1.25.3 to 1.32.1 now, move to SDK v2 later keeping the older protocol, or both. Waiting on the captain. (from Recall room, Oct 9)
- [ ] [#262](https://github.com/edheltzel/Recall/issues/262) Grok Build CLI: session-start L0/L1 injection. Check: GROK_INTEGRATION.md says Grok ignores SessionStart output, so inject may be blocked.
- [ ] [#240](https://github.com/edheltzel/Recall/issues/240) Dead semantic tier is reported but never escalated — silent keyword-only degradation destroys recall (field report for #226 item 3). Check: model provisioning shipped in [#242](https://github.com/edheltzel/Recall/pull/242); confirm remaining escalation/intent items.
- [ ] [#241](https://github.com/edheltzel/Recall/issues/241) recall repair --execute leaves the vec index empty — semantic search silently degrades to bruteforce, and doctor reports PASS. Check: repair now reindexes vec; confirm it writes the embedding marker.
- [ ] [#195](https://github.com/edheltzel/Recall/issues/195) chore: recall backup alias for export --format sqlite (discoverability). Check: `recall export --backup` now exists; is an alias still wanted?
- [ ] [#187](https://github.com/edheltzel/Recall/issues/187) ci: macOS hook-timeout flake blocks merges (unnamed beforeEach/afterEach >5s on slow runner). Check: rerun macOS CI to see if the hook-timeout flake still happens.
- [ ] [#251](https://github.com/edheltzel/Recall/issues/251) Install tests flake on a cold network: npm-pack/update trip bun's 5s default per-test timeout. Check: rerun install tests cold; branch moves install suite to Ubuntu.
- [ ] [#238](https://github.com/edheltzel/Recall/issues/238) chore: #230 audit debt — lifecycle test gaps, doc corrections, guide parity, stale comments. Check: [#294](https://github.com/edheltzel/Recall/pull/294) and [#297](https://github.com/edheltzel/Recall/pull/297) touched install; recheck the checklist.

## In progress

- [ ] [#124](https://github.com/edheltzel/Recall/issues/124) recall doctor/installer: atomic config-write parity in _recall_ensure_mcp_entry (lib/install-lib.sh). Commit 4340f22 on branch [fix/install-slice1-remainder](https://github.com/edheltzel/Recall/tree/fix/install-slice1-remainder), no PR yet. #297 did backup part.
- [ ] [#236](https://github.com/edheltzel/Recall/issues/236) harden: uninstall wipes user-authored files — ownership inferred by name/dir while install is per-file (#230 audit). Commit a3357cb on branch [fix/install-slice1-remainder](https://github.com/edheltzel/Recall/tree/fix/install-slice1-remainder), no PR yet. #294/#297 did part.
- [ ] [#231](https://github.com/edheltzel/Recall/issues/231) Installer hardening (borrowed from mnemon review): JSON5-tolerant settings parsing, $HOME collision guard, remove emptied settings file on uninstall. Commit a3357cb on branch [fix/install-slice1-remainder](https://github.com/edheltzel/Recall/tree/fix/install-slice1-remainder), no PR yet. #294 did JSONC parsing.
- [ ] Branch [cursor/omp-session-start-inject-7ee6](https://github.com/edheltzel/Recall/tree/cursor/omp-session-start-inject-7ee6) ATL-631 (Intern): omp session-start inject. Pushed Oct 3, waiting on Red-Team review, so no PR yet. Overlap with #300 still to check.

## Candidates for closing

- [ ] [#259](https://github.com/edheltzel/Recall/issues/259) Cursor capture wire: on-disk parser of state.vscdb + agent-transcripts JSONL. Cursor capture shipped in [#282](https://github.com/edheltzel/Recall/pull/282) (merged Sep 2).
- [ ] [#261](https://github.com/edheltzel/Recall/issues/261) Cursor inject wire: sessionStart additional_context via hooks.json + MCP + rule. Cursor inject shipped in [#282](https://github.com/edheltzel/Recall/pull/282) (merged Sep 2).
- [ ] [#267](https://github.com/edheltzel/Recall/issues/267) Shared `recall start` CLI for host inject variants. recall start shipped in [#282](https://github.com/edheltzel/Recall/pull/282) (merged Sep 2).
- [ ] [#270](https://github.com/edheltzel/Recall/issues/270) Déjà vu-style install snippets (tiny wires, not the product). Install snippets shipped in [#282](https://github.com/edheltzel/Recall/pull/282) (merged Sep 2).
- [ ] [#258](https://github.com/edheltzel/Recall/issues/258) Extractor config: per-path backends for Automatic-capture and Curated LoA. Extractor config merged in [#288](https://github.com/edheltzel/Recall/pull/288) (Sep 16), extended by [#298](https://github.com/edheltzel/Recall/pull/298).
- [ ] [#276](https://github.com/edheltzel/Recall/issues/276) docs: README still says 768-dim embeddings; code is 1024. README no longer says 768 on main (529400b).
- [ ] [#243](https://github.com/edheltzel/Recall/issues/243) 10 lifecycle tests fail in any git worktree — the environment AGENTS.md mandates for workers has a permanently red baseline. AGENTS.md now uses GitButler branches, not git worktrees; premise gone.
- [ ] [#165](https://github.com/edheltzel/Recall/issues/165) chore: fresh /ce-worktree worktrees miss node_modules → ~10 MCP-config tests fail spuriously. Worktree flow gone and jsonc-parser dep removed (eebe92d).
- [ ] [#271](https://github.com/edheltzel/Recall/issues/271) Non-goals: no HostDescriptor, no adapter→plugin rename, no Cursor marketplace plugin, no Cursor host-hook glue. Reference-only non-goals list; Cursor wires shipped in [#282](https://github.com/edheltzel/Recall/pull/282) without them.
- [ ] [#1](https://github.com/edheltzel/Recall/issues/1) create npm package for eady install. npm publish and `recall install` shipped in [#170](https://github.com/edheltzel/Recall/pull/170).


%% kanban:settings
```
{"kanban-plugin":"board","list-collapse":[false,false,false,false]}
```
%%
