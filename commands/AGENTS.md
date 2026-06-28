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
- `scout.md` grounds its repo map / key paths / risks in a code graph, **native-first**: Recall's own KG via the `recall callers`/`callees`/`trace`/`code-context` verbs, then external codegraph (`codegraph init` + `codegraph_explore`), then a grep/tree-walk backstop. It also surfaces the memory↔code join (`recall code-context`) that external tools can't. The graph is an enhancement, never a hard dependency — scout degrades gracefully when none is present.

## Work Guidance

- Add a command: create `Recall/<name>.md` and document it in `docs/slash-commands.md`.

## Verification

None automated.

## Child DOX Index

No child docs.
