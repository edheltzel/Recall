# commands — `/Recall:*` slash commands

> Child DOX. Root `AGENTS.md` carries repo-wide rules; this file owns local detail for `commands/`.

## Purpose

Markdown definitions for the `/Recall:*` slash-command namespace, installed to `~/.claude/commands/Recall/`.

## Ownership

`Recall/*.md` — `add`, `doctor`, `dump`, `loa`, `recent`, `scout`, `search`, `stats`, `update`.

## Local Contracts

- These are Markdown command specs, not code; the installer symlinks them into the Claude Code commands dir.
- Each command maps to underlying `recall` CLI / MCP behavior — keep its body aligned with that command and with `docs/slash-commands.md`.
- `scout.md` output is chat-only by default; a persisted scout artifact goes to `.agents/atlas/artifacts/` (see root `AGENTS.md`), never under `commands/` or `docs/`.
- `scout.md` optionally leverages codegraph (`codegraph init` + `codegraph_explore`) to ground its repo map and key paths; it degrades gracefully — codegraph is an enhancement, never a hard dependency.

## Work Guidance

- Add a command: create `Recall/<name>.md` and document it in `docs/slash-commands.md`.

## Verification

None automated.

## Child DOX Index

No child docs.
