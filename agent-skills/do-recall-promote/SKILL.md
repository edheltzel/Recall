---
name: "do-recall-promote"
description: "Promote learned-tail notes that hold across projects into GAP by opening a pull request. Never writes main and never runs gap sync."
---

Turn Recall notes that hold across projects into a reviewed change to the shared GAP policy. This skill only opens a pull request. The user reviews and merges it, then runs `gap sync` themselves.

## What this does

1. Runs `recall promote --json`. That command is read-only: it lists tail notes that are active, high confidence, seen in 3 or more distinct projects, in the tail for 14 or more days, and not already covered by a published GAP policy file.
2. On a new branch of the GAP checkout, adds the accepted notes to `global/AGENTS.md`.
3. Opens a pull request and stops.

## Never

- Never commit to `main` or `master`, and never push to either.
- Never edit a published harness file (`~/.claude/CLAUDE.md` and the rest). `gap sync` is what publishes, and only the user runs it.
- Never run `gap sync`, `gap remove`, or any command that writes a harness file.
- Never promote a note the user did not accept, and never invent text the JSON did not return.

## Steps

1. **List the candidates.**

   ```bash
   recall promote --json
   ```

   The JSON has `gap`, `candidates`, and `skipped`. Each candidate carries `text`, `records` (`table` and `id`), `projects`, `firstSeen`, `lastSeen`, and `daysInTail`.

   Stop and tell the user when `gap` is false (GAP is not installed), when `candidates` is empty, or when the command exits non-zero. There is nothing to promote.

2. **Ask which notes to promote.** Show each candidate's text, projects, record ids, and first/last seen dates. Promote only the ones the user accepts. If they accept none, stop.

3. **Find the GAP checkout.** Ask `gap` where it publishes from. Do not search the filesystem for another clone and do not clone the repo.

   ```bash
   GAP_SRC="$(gap source)" && test -f "$GAP_SRC/global/AGENTS.md"
   ```

   If `gap source` fails or is unknown (a `gap` older than this command), stop and tell the user to update gap.

4. **Branch off the published branch in a worktree.** The checkout may be on another branch or hold uncommitted work, so never switch it, stash, reset, or clean it.

   ```bash
   BRANCH="recall-promote-$(date +%Y-%m-%d)"
   git -C "$GAP_SRC" fetch origin
   git -C "$GAP_SRC" worktree add "$GAP_SRC/.worktrees/$BRANCH" -b "$BRANCH" origin/HEAD
   WT="$GAP_SRC/.worktrees/$BRANCH"
   ```

   `origin/HEAD` is the branch `gap sync` publishes. If the branch or worktree already exists, stop and ask.

5. **Edit `$WT/global/AGENTS.md` only.** Add each accepted note as its own short bullet under the existing `## Work` list, in the user's words from `text`. Do not add a new section, do not touch `global/docs/agents/`, and do not edit any other file. Keep the file's style: no em dashes.

6. **Commit on the branch and open the pull request.**

   ```bash
   git -C "$WT" add global/AGENTS.md
   git -C "$WT" commit -m "docs(policy): promote recall notes"
   git -C "$WT" push -u origin "$BRANCH"
   (cd "$WT" && gh pr create --title "Promote recall notes into the shared policy" --body "<one bullet per note: the text, its projects, and its record ids>")
   ```

   The pull request body lists every promoted note with its record ids (`decisions#123`) and projects, and says the user merges it and then runs `gap sync`.

7. **Stop.** Report the pull request URL and the worktree path (`$WT`), which the user removes with `git -C "$GAP_SRC" worktree remove "$WT"` after the merge. Do not merge it and do not run `gap sync`. After the user does both, the next `recall learn` sees the rule in the GAP block and drops it from the tail.
