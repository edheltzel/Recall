# Worker flow with GitButler

Use the root [version-control rules](../../AGENTS.md#version-control-and-github). The coordinator assigns a GitButler branch and writable checkout before implementation.

- Verify `pwd` matches the assigned checkout before the first edit. Use checkout-relative paths.
- In a shared GitButler workspace, concurrent workers must own disjoint files. The coordinator owns branch operations, commits, and integrated validation; workers must not mutate version-control state or run shared builds, installs, or test suites.
- When work requires isolation, the coordinator provisions it through GitButler using the `but` skill. Workers must not create raw Git worktrees or edit absolute paths pointing into another checkout.
- Report all changed paths. Stop and coordinate before editing outside the assigned set; preserve changes whose owner is unknown.
