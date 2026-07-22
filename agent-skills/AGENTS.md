# agent-skills — `recall-*` Agent Skills

> Child DOX. Root `AGENTS.md` carries repo-wide rules; this file owns local detail for `agent-skills/`.

## Purpose

Agent Skill definitions (one `SKILL.md` per skill directory, per the [agentskills.io](https://agentskills.io) standard) for the `recall-*` namespace — the canonical command source across skill hosts. The lifecycle installer symlinks canonicals into `~/.claude/skills/` and `~/.omp/agent/skills/`; Pi loads them through the root package's native `package.json#pi` manifest, while `scripts/build-codex-plugin.ts` and `scripts/build-claude-plugin.ts` generate the native plugin payloads.

## Ownership

`recall-add`, `recall-doctor`, `recall-dump`, `recall-loa`, `recall-recent`, `recall-scout`, `recall-search`, `recall-stats`, `recall-update` — each a directory containing `SKILL.md`.

## Local Contracts

- These are Markdown skill specs, not code; each maps to underlying `recall` CLI / MCP behavior — keep its body aligned with that command and with `docs/agent-skills.md`.
- `recall-dump/SKILL.md` carries `disable-model-invocation: true` — dumping a session is always the user's call; do not remove that gate.
- Codex does not accept every canonical frontmatter key. Keep host adaptations in `scripts/build-codex-plugin.ts` and verify the generated `plugins/recall/skills/` behavior; never infer parity from matching bytes.
- Claude's plugin payload is byte-verbatim. Regenerate it with `scripts/build-claude-plugin.ts`; never hand-edit `plugins/recall-claude/skills/`.
- Pi reads the canonical files directly through `package.json#pi`; do not generate or copy a second Pi skill tree.
- `recall-scout/SKILL.md` output is chat-only by default; a persisted scout artifact goes to `.agents/atlas/artifacts/` (see root `AGENTS.md`), never under `agent-skills/` or `docs/`.
- `recall-scout/SKILL.md` grounds its repo map / key paths / risks in **CodeGraph (primary)** via the external `codegraph` CLI: a `codegraph status --json` capability probe (on an unindexed repo scout **offers** `codegraph init` and runs it only on an explicit user yes — never auto-runs), a cheap orientation bundle (`status --json` + `files --max-depth 2 --no-metadata`), and at most two narrow `explore` calls under the query discipline pinned in the skill, with a grep/tree-walk backstop. CodeGraph is an enhancement, never a hard dependency — scout degrades gracefully when it isn't present.
- The former `/Recall:*` slash commands (`commands/Recall/`) were retired in favor of these skills (#228); `install.sh`/`update.sh` clean up their symlinks. Do not reintroduce a parallel command surface.

## Work Guidance

- Add a skill: create `<name>/SKILL.md`, document it in `docs/agent-skills.md`, add `<name>` to `RECALL_SKILL_NAMES` in `uninstall.sh`, and regenerate both native plugin payloads.

## Verification

`tests/install/skills.test.ts` (install/uninstall lifecycle), `tests/commands/scout-workflow.test.ts` (scout workflow contracts), `tests/plugins/{codex,claude}-plugin.test.ts` (generated native payloads), `tests/pi-integration.test.ts` and `scripts/e2e-pi-integration.ts` (native Pi package discovery).

## Child DOX Index

No child docs.
