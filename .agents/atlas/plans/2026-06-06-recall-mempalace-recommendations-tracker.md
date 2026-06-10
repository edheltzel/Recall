# Recall MemPalace Recommendations Tracker

Created: 2026-06-06

## Purpose

Track the accepted MemPalace-derived Recall improvement plan as independently grabbable GitHub issues with explicit dependencies.

## Resolved principles

- Recall preserves **Frictionless Memory Capture**: hooks, imports, MCP tools, and agent workflows capture memory without asking users to classify records.
- **Record Provenance** is automatic write-path metadata, not a public MCP or normal CLI classification input.
- macOS is Recall's primary CI platform; Ubuntu/Linux is compatibility smoke; native Windows is out of scope for now.
- Export moved ahead of dedup because provenance must be portable and auditable.
- Dedup is non-destructive by default and acts within-table only; cross-table duplicates are report-only.
- Lightweight entity keying remains parked behind evidence gates.

## Tracker

| Priority | Issue | Work item | Status | Dependencies | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | [#40](https://github.com/edheltzel/Recall/issues/40) | Add macOS-primary CI and release version guard | Local implementation complete; GitHub issue open | None | macOS required, Ubuntu smoke, no native Windows. Commit/PR still needed before closing issue. |
| 2 | [#41](https://github.com/edheltzel/Recall/issues/41) | Audit SQLite variable limits and add shared chunking | Open | None | Conservative chunking before large import/export/dedup paths. |
| 3 | [#42](https://github.com/edheltzel/Recall/issues/42) | Add Record Provenance across memory records | Open | #41 recommended | Uses `CONTEXT.md` and ADR-0001. |
| 4 | [#43](https://github.com/edheltzel/Recall/issues/43) | Add `mem export` with JSON, Markdown, SQL dump, and SQLite backup formats | Open | #42, #41 recommended | Includes `mem export --backup` to `~/.agents/Recall/backups/`. |
| 5 | [#44](https://github.com/edheltzel/Recall/issues/44) | Add focused property-based tests | Open | #41; expands after #43 and #45 | Import, chunking, export, and dedup invariants. |
| 6 | [#45](https://github.com/edheltzel/Recall/issues/45) | Add non-destructive dedup with provenance-aware survivor selection | Open | #42; benefits from #43/#44 | Survivor order: `user_authored > verbatim > extracted > derived > unknown`. |
| 7 | [#46](https://github.com/edheltzel/Recall/issues/46) | Add `mem repair` for data and index maintenance | Open | #42 recommended | Separate from `doctor --fix`; dry-run by default. |
| 8 | [#47](https://github.com/edheltzel/Recall/issues/47) | Add Suite C benchmark for precision under noise | Open | #42, #45, #46 recommended | Baseline-first: P@5, R@5, MRR, p50/p95 latency. |
| 9 | [#48](https://github.com/edheltzel/Recall/issues/48) | Refactor conversation imports behind internal source-adapter registry | Open | None | Interface + registry only; no dynamic plugins. |
| Maybe | [#49](https://github.com/edheltzel/Recall/issues/49) | Track evidence gate for lightweight entity keying | Parked | Suite C or real search/dedup evidence | Passive facets only if promoted. |

## ADRs created during grilling

- `docs/adr/0001-record-provenance-automatic-write-path-metadata.md`
- `docs/adr/0002-macos-primary-ci-platform.md`

## Glossary entries created during grilling

- `CONTEXT.md` → Record Provenance
- `CONTEXT.md` → Frictionless Memory Capture

## Execution notes

- Work items should be picked in priority order unless an issue explicitly has no dependency and is being handled in parallel.
- #49 is not implementation work yet; use it as an evidence tracker.
- Keep normal user/MCP/hook capture frictionless when implementing provenance, export, dedup, and repair.

- 2026-06-08 local #40 implementation added macOS-primary CI, Ubuntu smoke, version guard tests/script, release docs, and changelog entry. GitHub issue #40 remains open until committed/merged.
- The `code-simplifier` review agent failed with an upstream strict-tools/model support error during #40 cleanup. Include a quick subagent-review smoke test in the next roadmap phase before relying on that agent for #41+ cleanup; this is tooling verification, not a blocker for #40 functionality.