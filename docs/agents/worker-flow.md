# Worker flow

Use the root [version-control rules](../../AGENTS.md#version-control-and-github). The coordinator assigns a feature branch and writable checkout before implementation.

- Verify `pwd` matches the assigned checkout before the first edit. Use checkout-relative paths.
- In a shared checkout, concurrent workers must own disjoint files. The coordinator owns branch operations, commits, and integrated validation; workers must not mutate version-control state or run shared builds, installs, or test suites.
- When work requires isolation, the coordinator provisions a `git worktree` at `.worktrees/<name>`. Workers must not create their own worktrees or edit absolute paths pointing into another checkout.
- Report all changed paths. Stop and coordinate before editing outside the assigned set; preserve changes whose owner is unknown.
