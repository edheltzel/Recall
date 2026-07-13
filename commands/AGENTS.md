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
- `scout.md` grounds its repo map / key paths / risks in **CodeGraph (primary)** via the external `codegraph` CLI: a `codegraph status --json` capability probe (on an unindexed repo scout **offers** `codegraph init` and runs it only on an explicit user yes — never auto-runs), a cheap orientation bundle (`status --json` + `files --max-depth 2 --no-metadata`), and at most two narrow `explore` calls under the query discipline pinned in scout.md, with a grep/tree-walk backstop. CodeGraph is an enhancement, never a hard dependency — scout degrades gracefully when it isn't present.

## Work Guidance

- Add a command: create `Recall/<name>.md` and document it in `docs/slash-commands.md`.

## Verification

None automated.

## Child DOX Index

No child docs.
