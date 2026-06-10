# Handoff: Recall MemPalace Recommendations Plan

Date: 2026-06-06

## Scope of this session

The session reviewed an interactive MemPalace → Recall recommendations board, accepted 9 items and parked 1 item as maybe, then grilled the plan into a concrete, issue-backed roadmap.

No implementation work for the roadmap has started yet. Work completed in this session was planning/configuration/documentation only.

## Primary artifacts to read first

Read these instead of reconstructing the whole conversation:

1. `.agents/atlas/plans/2026-06-06-recall-mempalace-recommendations-tracker.md`
   - Canonical tracker for the accepted plan.
   - Contains ordered priorities, dependency notes, links to issues #40-#49, ADR references, and glossary references.

2. `CONTEXT.md`
   - Glossary entries created during grilling:
     - Record Provenance
     - Provenance States
     - Unknown Record Provenance
     - Frictionless Memory Capture

3. `docs/adr/0001-record-provenance-automatic-write-path-metadata.md`
   - Decision: provenance is automatic write-path metadata, not a public MCP/normal CLI classification input.

4. `docs/adr/0002-macos-primary-ci-platform.md`
   - Decision: macOS is primary CI; Ubuntu/Linux is smoke; native Windows is out of scope.

5. GitHub issues in the repo issue tracker:
   - #40 CI + version guard
   - #41 SQLite variable-limit audit
   - #42 Record Provenance
   - #43 `mem export`
   - #44 Property-based tests
   - #45 Dedup
   - #46 `mem repair`
   - #47 Suite C benchmark
   - #48 Source-adapter registry
   - #49 Entity keying evidence gate

## Additional setup completed

Matt Pocock engineering-skill configuration was scaffolded:

- `AGENTS.md` now has an `## Agent skills` block.
- `docs/agents/issue-tracker.md` configures GitHub Issues via `gh`.
- `docs/agents/triage-labels.md` maps canonical triage roles.
- `docs/agents/domain.md` records single-context domain-doc consumption rules.

The repo's `CLAUDE.md` is intentionally a shim to `AGENTS.md`; guidance was added to `AGENTS.md` to preserve the repo's single-source-of-truth rule.

## Plan highlights

Use the tracker file for detail. The high-level roadmap is:

1. Add macOS-primary CI and release/version consistency guard.
2. Audit SQLite variable limits and add conservative shared chunking.
3. Add Record Provenance across durable memory records.
4. Add `mem export` with JSON, Markdown, SQL dump, SQLite backup, and `--backup` shortcut.
5. Add focused property-based tests.
6. Add non-destructive, provenance-aware dedup.
7. Add `mem repair` for data/index maintenance.
8. Add Suite C benchmark for precision under noise.
9. Refactor imports behind an internal source-adapter registry.
10. Keep lightweight entity keying parked behind evidence gates.

Operational caveats:

- #44 is staged property-test work: chunking properties can start after #41; export properties wait for #43; dedup properties wait for #45. Do not close #44 as complete until the #43- and #45-backed property groups exist, unless the issue is explicitly left with pending groups.
- #49 is a parking-lot/evidence tracker, not implementation work. Add evidence comments only; convert to implementation issues only after Suite C, real search failures, or dedup explanation failures meet the promotion criteria.

## Important resolved constraints

- Recall must preserve Frictionless Memory Capture: normal users/agents should not be asked to classify memory records.
- MCP `memory_add` and normal `mem add` must not expose provenance override flags.
- Provenance is stamped by write path.
- Legacy records may have unknown provenance; do not guess.
- Export must always include provenance, with unknown explicit in exported data.
- `mem export --backup` writes a timestamped SQL dump under the Recall backup directory, not the current workspace.
- Dedup is non-destructive by default.
- Dedup actions are within-table only; cross-table duplicates are report-only.
- `mem repair` is separate from `doctor --fix` and dry-run by default.
- `doctor` may recommend `repair`, but must not run data repair implicitly.
- Suite C is baseline-first; do not invent a hard pass/fail threshold before baseline exists.
- Source adapters are internal interface + registry only; no dynamic plugin ecosystem.
- Entity keying remains maybe until evidence from Suite C, real search failures, or dedup explanation failures.

## Current repo state to expect

Docs/planning artifacts changed or added:

- `CONTEXT.md`
- `docs/adr/0001-record-provenance-automatic-write-path-metadata.md`
- `docs/adr/0002-macos-primary-ci-platform.md`
- `.agents/atlas/plans/2026-06-06-recall-mempalace-recommendations-tracker.md`
- `AGENTS.md`
- `docs/agents/issue-tracker.md`
- `docs/agents/triage-labels.md`
- `docs/agents/domain.md`

GitHub labels were also present/created for canonical triage. Current roadmap issue assignment state:

- #40-#48 are `ready-for-agent`.
- #49 is `needs-triage` and remains an evidence gate, not assignable implementation work.
- Canonical triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.

## Suggested skills

- `ce-work` — if the next agent is implementing one of the issues.
- `tdd` — especially for #41, #42, #43, #44, #45, and #46.
- `grill-with-docs` — if a new domain term or ADR-level decision emerges during implementation.
- `ce-code-review` — before opening or merging PRs for any roadmap issue.
- `ce-simplify-code` — after a completed implementation slice, before final verification.
- `to-issues` / `triage` — only if further decomposition or issue state changes are needed.
- `diagnose` — if tests or import/export behavior reveal defects during implementation.

## Progress update — 2026-06-08

- Issue #40 was implemented locally: `.github/workflows/ci.yml`, `src/lib/version-guard.ts`, `scripts/check-version.ts`, `tests/version-guard.test.ts`, `src/version.ts`, `package.json`, `docs/releasing.md`, and `CHANGELOG.md`.
- Verification observed locally: `bun run check:version`, tag match/mismatch guard checks, targeted version tests, `bun run lint`, `bun run build`, and full `bun test`.
- GitHub issue #40 is still open and labeled `ready-for-agent`; do not close it until the implementation is committed, pushed, and merged.
- Issue #41 remains the next roadmap implementation target and is open/`ready-for-agent`.
- The `code-simplifier` subagent failed during #40 cleanup because the configured model rejected strict tools. Before using that subagent as a #41+ cleanup gate, run a quick subagent-review smoke test or fix the agent model/tool configuration. This is a workflow/tooling follow-up, not a #40 product blocker.

## Progress update — 2026-06-10

- The #40 implementation was committed in `b504ce2` (`feat: complete Recall 1.0 foundations`) on branch `feat/multi-format-conversation-import`, pushed to origin, and opened as [PR #54](https://github.com/edheltzel/Recall/pull/54) with `Closes #40`.
- `b504ce2` bundles three workstreams: the #40 CI/version-guard work, a multi-format conversation import feature (Claude.ai/ChatGPT/Slack — not on the roadmap; noted on #48 as new source-adapter-registry candidates), and the 06-06 planning artifacts (plans, ADRs, CONTEXT.md glossary, docs/agents/).
- Local verification on 2026-06-10: `bun run lint` clean, `bun run check:version` passed (1.0.0), `bun test` 453 pass / 0 fail.
- Issue #40 relabeled `ready-for-agent` → `ready-for-human`: implementation done, awaiting review/merge. It auto-closes when PR #54 merges.
- The `code-simplifier` subagent smoke-test caveat (see 2026-06-08 note) is still outstanding before relying on it for #41+ cleanup.

## Recommended next step

Review and merge PR #54, then start issue #41.

- #41 is the next implementation target because later large-data export, dedup, repair, and benchmark work depends on SQLite-safe chunking.
- Before relying on cleanup subagents for #41, run the subagent-review smoke test noted above or fix the strict-tools/model configuration.

If working in priority order after #41, implement #42 next.

## Redaction note

This handoff avoids API keys, credentials, private tokens, and full user-home paths except for this temporary-file location required by the handoff request. Referenced repo artifacts and issue numbers are already part of the project workspace or configured issue tracker.
