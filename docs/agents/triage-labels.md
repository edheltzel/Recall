# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `agent:ready`        | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `needs:human`        | Requires human implementation            |
| `wontfix`                  | `wontfix`         | Close as "not planned" with a comment    |

When a skill mentions a role, use the corresponding label string from this table.

The tracker uses colon-namespaced labels: `type:*` (kind), `agent:*` (`ready` / `blocked` / `complete`), `risk:*` (judgement required), `needs:human`. These are orthogonal signals — they say what the board's `Status` field can't. **Position-in-flow (Todo / In Progress / In Review / Done) is owned by the board Status field, not by labels** — see [`board-status.md`](board-status.md).
