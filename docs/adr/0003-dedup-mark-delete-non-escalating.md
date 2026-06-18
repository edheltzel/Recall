# ADR-0003: dedup mark→delete is non-escalating

## Status

Accepted

## Context

`recall dedup --execute` marks duplicate records (non-destructive, status `'marked'`). A later `recall dedup --execute --delete` deletes duplicates it identifies in that run. PR #60 review found (issue #73) that records **already** marked by a prior `--execute` run are never upgraded to deleted by a later `--execute --delete` run — the escalation is silently a no-op.

This was undecided and undocumented. The question: is the no-op the intended behavior, or should a `--delete` run escalate prior marks to deletion?

This sits inside the milestone's governing principle — **non-destructive by default, conservative in the safe direction** (the #63 resolution: cross-run survivorship is sticky, destructive actions are guarded). It also shares design territory with #80 (prune must not orphan a survivor's marked duplicates).

## Decision

**Mark→delete escalation is deliberately non-escalating, and this is the intended, documented behavior.**

Once a record has been marked a duplicate by an `--execute` run, a subsequent `--execute --delete` run does **not** auto-upgrade that prior mark to a deletion. `--delete` acts only on duplicates identified within its own run.

Rationale: marking is the conservative, reversible state; silently escalating previously-marked records to irreversible deletion on a later run would violate non-destructive-by-default and could surprise a user who marked deliberately and ran `--delete` for a different, current batch. A user who wants prior marks deleted can act on them explicitly.

Opt-in escalation (a future `--escalate`-style flag) is **out of scope** for this phase; if desired later it must be explicit and guarded, never the default.

## Consequences

- The current behavior is correct as shipped; #73 closes as decision + docs, no code change.
- User-facing dedup-safety prose must state that marking is terminal-until-acted-on and that `--delete` does not escalate prior marks. This prose lands alongside #80 (which already revises the visible-survivor / prune-interaction docs), keeping the dedup-safety model documented in one place.
- #80's prune-survivor guard inherits the same conservative stance: prune must not silently orphan a survivor's marked duplicates.
- If opt-in escalation is ever added, it requires its own explicit flag, guard, and ADR superseding this one's scope note.
