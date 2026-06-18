# Project board: status convention

Recall's work is tracked across **per-phase GitHub Project boards** (one board = one phase). As of 2026-06-18:

| Board | Phase | State |
| --- | --- | --- |
| [#15](https://github.com/users/edheltzel/projects/15) | Phase 0 — Hardening & Dedup Proof | complete |
| [#16](https://github.com/users/edheltzel/projects/16) | Phase 1 — Memory Intelligence | active |
| [#17](https://github.com/users/edheltzel/projects/17) | Phase 2 — Distribution & Packaging | queued |
| [#18](https://github.com/users/edheltzel/projects/18) | Phase 3 — Backend Portability | pending go/no-go |
| [#19](https://github.com/users/edheltzel/projects/19) | Phase 4 — Beyond Coding Agents | pending go/no-go |

Each board's `Status` field is the **single source of truth for an item's position in the flow.** Themis (and any reviewing agent) keeps it current with `gh` as work moves — there is no GitHub automation driving the transitions (but see the auto-close caveat below).

**Labels do not mirror Status.** Position-in-flow lives in the `Status` field only; labels (`type:*`, `agent:*`, `risk:*`, `needs:human`) carry orthogonal signal — kind, dispatchability, blocked-ness, who-does-it — that a single board column can't express. Don't create a label that just restates a column (no `in-review`, no `in-progress`); it's duplication that drifts. See [`triage-labels.md`](triage-labels.md) for the label set.

## Status lifecycle

| Status        | When it applies                          |
| ------------- | ---------------------------------------- |
| `Todo`        | Triaged, not started                     |
| `In Progress` | A worker is actively implementing        |
| `In Review`   | A PR is open / under code review         |
| `Done`        | PR merged (or item closed)               |

> **Board caveat — `In Review` is not on every board.** The Phase 0 board (#15) has a custom `In Review` option that was added manually; the newer phase boards (#16–#19) ship with only the GitHub defaults **Todo / In Progress / Done**. On those boards, either add an `In Review` option via the project UI/API for consistency, or treat `In Progress` as covering "under review" until you do.

> **Automation caveat — `Done` auto-closes the issue.** Setting an item's Status → `Done` fires a project workflow that **closes the linked issue**. So move an item to `Done` **only after its PR merges** — a premature `Done` closes the issue before the code lands (this bit #71/#72 once; recovered). Mirror reality: In Review while the PR is open, Done after merge.

## The In Review rule

On boards that have the option: **the moment a PR opens for an item (or a reviewer is dispatched), set its Status to `In Review`.** On merge, move it to `Done` (closing the issue does not move the card — set it explicitly, and only post-merge per the auto-close caveat).

## Field / option IDs are per-board

Every project has its own `Status` field id + option ids — fetch them with:

```bash
gh project field-list <PROJECT_NUM> --owner edheltzel --format json \
  | jq -r '.fields[] | select(.name=="Status") | "field=\(.id)", (.options[] | "  \(.name)=\(.id)")'
```

Worked example — **Phase 0 board #15** (the only board with `In Review`):

- Project ID: `PVT_kwHOAAYl3s4Ba2Re`
- `Status` field ID: `PVTSSF_lAHOAAYl3s4Ba2RezhVq6OA`
- Option IDs: `Todo` `f75ad846` · `In Progress` `47fc9ee4` · `In Review` `6bc5feda` · `Done` `98236657`

(The default boards #16–#19 share the standard option ids `Todo f75ad846` / `In Progress 47fc9ee4` / `Done 98236657` but each has its own project + field id — fetch per board.)

## Commands

Find the project **item ID** for an issue number (item ids differ from issue numbers), then set Status:

```bash
ISSUE=78; PROJ=15
ITEM_ID=$(gh project item-list "$PROJ" --owner edheltzel --format json \
  | jq -r ".items[] | select(.content.number==$ISSUE) | .id")
PROJECT_ID=$(gh project view "$PROJ" --owner edheltzel --format json | jq -r '.id')
# move to In Review (swap option id to Done '98236657' on merge):
gh project item-edit --id "$ITEM_ID" --project-id "$PROJECT_ID" \
  --field-id <STATUS_FIELD_ID> --single-select-option-id <OPTION_ID>
```

> If the issue isn't on the board yet, add it first: `gh project item-add <PROJ> --owner edheltzel --url <issue-url>`.
