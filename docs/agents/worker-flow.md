# Worker flow: stay inside your worktree

Workers run implementation in an **isolated git worktree** (via `/ce-worktree` or the harness's native worktree tool). This doc states the one binding convention that keeps a worker's edits from leaking into the main checkout.

## The convention (binding)

**Before your first `Edit` / `Write`, verify your cwd is the worktree root.** Until that's confirmed, operate on **worktree-relative paths only** — never absolute paths that point back into the main checkout.

Run this first, and confirm the path is your worktree (not the repo's primary checkout):

```bash
pwd && git rev-parse --show-toplevel
```

If the two agree and the path is your worktree (e.g. under `.claude/worktrees/…`), you're clear to edit. If they don't — or the toplevel is the primary checkout — stop and re-enter the worktree before touching any file.

## Why this exists

Worktree creation and the session's cwd switch don't always settle before the first tool call. A worker that edits via an absolute path into the main checkout during that window contaminates `main`'s working tree — the change lands outside the worktree's branch.

This bit the Hardening phase twice:

- **#66** — the worker's first edit hit the main checkout; it self-reverted.
- **#68** — the same slip, but it wasn't caught, so the #68 fix rode into an unrelated squash (it was bundled into **PR #94** alongside ADR-0003).

Both outcomes were recovered, but the isolation guarantee was broken each time. `/ce-worktree` is an external `compound-engineering` plugin skill (it lives in `~/.claude`, not this repo), so the guard can't be mechanical here — it's a convention every worker inherits instead.
