# Project board: status convention

Work is tracked on GitHub Project **#15** (`edheltzel`, _Recall: Hardening & Dedup Proof_). The board's `Status` field is the **single source of truth for an item's position in the flow.** Themis (and any reviewing agent) keeps it current with `gh` as work moves — there is no GitHub automation.

**Labels do not mirror Status.** Position-in-flow lives in the `Status` field only; labels (`type:*`, `agent:*`, `risk:*`, `needs:human`) carry orthogonal signal — kind, dispatchability, blocked-ness, who-does-it — that a single board column can't express. Don't create a label that just restates a column (no `in-review`, no `in-progress`); it's duplication that drifts. See [`triage-labels.md`](triage-labels.md) for the label set.

## Status lifecycle

| Status        | When it applies                          |
| ------------- | ---------------------------------------- |
| `Todo`        | Triaged, not started                     |
| `In Progress` | A worker is actively implementing        |
| `In Review`   | A PR is open / under code review         |
| `Done`        | PR merged (or item closed)               |

## The In Review rule

**The moment a PR opens for an item (or a reviewer is dispatched), set its board Status to `In Review`.** On merge, move it to `Done` (closing the issue does not move it — set it explicitly).

### IDs (Project #15)

- Project ID: `PVT_kwHOAAYl3s4Ba2Re`
- `Status` field ID: `PVTSSF_lAHOAAYl3s4Ba2RezhVq6OA`
- Option IDs: `Todo` `f75ad846` · `In Progress` `47fc9ee4` · `In Review` `6bc5feda` · `Done` `98236657`

### Commands

Find the project **item ID** for an issue number (item IDs differ from issue numbers):

```bash
ISSUE=78
ITEM_ID=$(gh project item-list 15 --owner edheltzel --format json \
  | jq -r ".items[] | select(.content.number==$ISSUE) | .id")
```

Move it to In Review (swap the option id to `98236657` for Done on merge):

```bash
gh project item-edit --id "$ITEM_ID" --project-id PVT_kwHOAAYl3s4Ba2Re \
  --field-id PVTSSF_lAHOAAYl3s4Ba2RezhVq6OA --single-select-option-id 6bc5feda
```

> If the issue isn't on the board yet, add it first: `gh project item-add 15 --owner edheltzel --url <issue-url>`.
