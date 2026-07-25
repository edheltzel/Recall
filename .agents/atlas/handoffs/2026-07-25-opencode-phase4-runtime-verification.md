# Recall OpenCode Phase 4 — Runtime Verification Handoff

Status: In progress

Phase: OpenCode integration — Phase 4 acceptance verification (real runtime)

Branch: `fm/recall-opencode-phase4-o1`

Supersedes as the current handoff: `.agents/atlas/handoffs/2026-07-22-opencode-phase4-testing-polish.md`
(that handoff is accurate about what PR #248 shipped; it is not the authority for
the runtime claims this pass re-tests).

## Why this pass exists

PR #248 and #249 landed the Phase 4 test surface and marked
`docs/OPENCODE_INTEGRATION.md` Phase 4 "complete". Two of its recorded claims were
not actually established by the code that claims them:

1. `scripts/e2e-opencode.ts:260-266` reaches the adapter with
   `await import(...opencode/RecallExtract.ts)` and then **synthesizes** the event
   payload. It proves Recall's handler *accepts* `{type:'session.idle',
   properties:{sessionID}}`; it does not prove OpenCode *emits* it, and it does not
   prove OpenCode ever *loads* the plugin.
2. `docs/OPENCODE_INTEGRATION.md:133-137` deferred the `session.idle` frequency
   question ("add time-based debouncing only if future runtime evidence shows
   repeated idle events"). The frequency was never measured, and the hedge points
   at the wrong remedy.

## Measured runtime facts (OpenCode 1.18.5, macOS)

| Question | Answer | How |
|---|---|---|
| Does OpenCode load Recall's plugin from the installer's path? | **Yes** — `$XDG_CONFIG_HOME/opencode/plugins/` (and `plugin/` singular also works) | real `opencode serve`, plugin factory side effect observed |
| `session.idle` frequency | **1.00 per assistant turn** (3 turns -> 3 events, delta 1 each) | one session, one long-lived server process, `GET /event` SSE |
| `session.idle` payload | `properties.sessionID` | captured from the live stream |
| Does `opencode export <id>` return the whole conversation? | **Yes** — all 6 messages after 3 turns | direct `opencode export` |

## Defect this measurement exposed

`opencode/RecallExtract.ts:140` gates on a **permanent** tracker
(`tracker.has(sessionId)`). Because idle fires once per turn, the first idle wins
and every later turn is discarded.

Reproduced end to end against a real 3-turn session with Recall's real plugin
loaded by a real OpenCode server: the drop file froze at 154 bytes containing only
turn 1; `BETAMARKERTWO` and `GAMMAMARKERTHREE` never reached it; `.extracted.json`
held the session id, permanently suppressing re-export.

This is silent data loss for every multi-turn OpenCode session — the normal case.

## Scope

In scope: the four Phase 4 acceptance items exercised for real, the tracker defect
the measurement exposed, #243 characterisation, and reconciling
`docs/OPENCODE_INTEGRATION.md` + `README.md` with what is proven.

Out of scope (unchanged from #248): installation reconciliation, the semantic
#240/#241/#226 wave, release/version bump, and #236/#237/#238/#174.

## Plan

1. Handoff (this file).
2. Fix the tracker so later idles re-export; keep retry-on-failure and
   `.extracted.json`.
3. Unit regression at the plugin boundary: repeat idle with new content re-exports.
4. Committed real-runtime harness: plugin discovery + measured idle frequency +
   multi-turn drop completeness.
5. Concurrent **Claude + OpenCode** writers (the existing e2e used two OpenCode
   writers).
6. Installer backup/restore round-trip (existing coverage is surgical removal, not
   restore).
7. Docs: correct the overclaims, record the measured number, reconcile README.
8. #243: verify precisely, close or characterise.

## Holds

No captain product decision outstanding.
