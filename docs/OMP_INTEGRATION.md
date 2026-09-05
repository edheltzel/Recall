# omp Integration

[Back to README](../README.md)

**Preferred install:** omp's native skill / plugin surface.

omp discovers Agent Skills from `~/.omp/agent/skills/<name>/SKILL.md` and can also load plugins via `omp plugin install`. Recall does not currently ship an omp marketplace plugin, so there is no `omp plugin install recall@…` command to run.

When `omp` is on `PATH`, `recall install` links the nine `recall-*` skills into `~/.omp/agent/skills/` — omp's native skill home, not a parallel Recall-invented path. No MCP server and no lifecycle hooks are installed for omp today.

## Install (preferred)

```bash
bun install -g recall-memory
recall init
recall install
```

Deselect omp in the interactive installer, or pass `--skip-omp`, when that machine should stay untouched.

Verify the native skill directories exist:

```bash
ls ~/.omp/agent/skills/recall-*
```

Skill names stay `recall-*` (the canonical `agent-skills/` namespace). `uninstall.sh` removes only Recall-owned skill links under `~/.omp/agent/skills/`.

## What omp does not get

- No MCP registration.
- No installer-owned or plugin-owned lifecycle hooks.
- No marketplace plugin package in this repository.

Grok-style installer hooks and Cursor-style snippets are not used for omp. If an omp plugin package ships later, that native `omp plugin install` path becomes the preferred attach; until then the native skill directory is the supported surface.
