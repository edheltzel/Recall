# Recall OpenCode Phase 4 — Runtime Verification Handoff

Status: Complete — branch `fm/recall-opencode-phase4-o1` ready for PR

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

## Phase 4 acceptance — outcome

| Item | Outcome |
|---|---|
| E2E session → export → drop → extract → search | Passes. `bun run test:e2e:opencode` green against OpenCode 1.18.5. |
| Concurrent Claude + OpenCode against one store | **Was broken.** Found, fixed, regression-tested (see below). |
| Installer rollback and restore | `install.sh restore` had zero coverage; now covered, including the collision backup and the non-interactive no-op. |
| `session.idle` frequency, measured | **1.00 per assistant turn** (3 turns → 3 events, OpenCode 1.18.5). Asserted, not just recorded. |

## Defects found and fixed

1. **Multi-turn data loss** (`opencode/RecallExtract.ts`). Permanent tracker +
   per-turn idle meant only turn 1 was ever dropped. Reproduced against a real
   three-turn session: 154-byte drop, 2 of 3 markers lost.
2. **Plugin load error on every launch.** OpenCode calls every export of a
   top-level `plugins/*.ts` as a plugin factory; the exported test helpers made
   it log `failed to load plugin ... "Object is not a function"`. Helpers moved
   to `opencode/lib/session-export.ts`.
3. **Concurrent extraction lost records** (`hooks/lib/sqlite-writers.ts`). The
   duplicate probe made these DEFERRED transactions read-then-write, and SQLite
   fails that upgrade with `SQLITE_BUSY` instantly, never consulting
   `busy_timeout`. Measured 1ms hard failure vs the full timeout honoured under
   `IMMEDIATE`.

Defects 1 and 2 were invisible to the existing e2e by construction: it imports
the adapter and supplies its own `$` and event payload.

## #243 — closed

All three acceptance items met:

1. Fresh worktree matches a normal checkout — verified in a genuinely fresh
   worktree: 1298 pass, 0 fail. Requires `bun install` inside it, which is #165's
   gap, so #165 stays open and the CI job asserts the empty-`node_modules`
   starting condition rather than hiding it.
2. `recall_configure_opencode_mcp` and `recall_configure_pi_mcp` both exit 1 on a
   malformed config and leave it byte-identical.
3. CI now runs lint plus the full suite inside a git worktree.

## Known gaps, deliberately not closed

- `opencode/RecallPreCompact.ts` compaction injection is unit-tested only; no
  test drives a real OpenCode compaction. Stated in the README row and in
  `docs/OPENCODE_INTEGRATION.md`.
- The full-suite failure that went unidentified is diagnosed. It was never one
  flake but two, both of them tests inheriting host state rather than anything
  hanging: `bun test --timeout 30000` is 1298 pass / 0 fail, and every affected
  test passes in isolation.
  - **Fixed here.** The three Pi-path tests in `tests/install/uninstall.test.ts`
    let `remove_pi` reach the host's real `pi`, and `pi remove` costs ~10s on a
    machine that actually has Pi installed - while on CI, where `pi` is absent,
    it never runs at all. That is the entire 1s -> 12s spread, and the exact
    three tests that failed the last pre-fix run. They now shadow `pi` with a
    no-op stub on `PATH`, the way the file already stubs `bun unlink`; nothing
    asserted on that call, so no coverage is lost. Now a stable 0.7-1.0s each.
  - **Left to [#251](https://github.com/edheltzel/Recall/issues/251).** Both of
    its named files still trip the 5s **default** on a cold network, and they
    need different fixes: the `packFileList()` `beforeAll` in
    `tests/install/npm-pack.test.ts` runs `npm pack --dry-run` with no timeout
    argument, while the sibling `beforeAll` 18 lines above already carries an
    explicit `180_000` for exactly this reason; `update.sh > --check prints
    current + latest` in `tests/install/update.test.ts` is a plain `test` that
    reaches the GitHub release API. Deliberately not taken here. A full suite is
    1298 pass / 0 fail whenever these two happen not to trip, so a single green
    run is not evidence #251 is closed.
  Neither is this branch. An interleaved A/B of `uninstall.test.ts` against the
  base commit's `uninstall.sh` + `lib/install-lib.sh` reproduced the outlier on
  base, and 15 targeted runs of `sqlite-writers-concurrency`, `restore`, and
  `opencode-integration` were clean. The concurrency test was hardened anyway -
  it no longer asserts a wall-clock floor, only a happens-before against a stamp
  the peer prints while it still holds the lock.
- Out of scope and untouched: installation reconciliation, the semantic
  #240/#241/#226 wave, release/version bump, #236/#237/#238/#174, #165.

## Holds

No captain product decision outstanding.
