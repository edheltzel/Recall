# docs — user-facing published documentation

> Child DOX. Root `AGENTS.md` carries repo-wide rules; this file owns local detail for `docs/`.

## Purpose

User-facing published documentation: installation, CLI / MCP / agent-skill reference, architecture, troubleshooting, releasing/upgrading, host integration guides, ADRs, and agent skill docs.

## Ownership

- Reference & guides — `installation.md`, `cli-reference.md`, `mcp-tools.md`, `agent-skills.md`, `architecture.md`, `troubleshooting.md`, `releasing.md`, `upgrading.md`, `OPENCODE_INTEGRATION.md`, `PI_INTEGRATION.md`, `CODEX_INTEGRATION.md`, `CLAUDE_INTEGRATION.md`
- `adr/` — architectural decision records
- `agents/` — agent skill docs (`issue-tracker.md`, `triage-labels.md`, `board-status.md`, `domain.md`, `worker-flow.md`, `dox-framework.md`)

## Local Contracts

- `docs/` is EXCLUSIVELY user-facing published docs. NEVER store plans, specs, designs, handoffs, or scout artifacts here — those live under `.agents/atlas/` (see root `AGENTS.md`).
- ADRs are numbered and append-only: change a decision by adding a new `NNNN-*.md`; don't rewrite a past ADR's decision.
- Keep docs in sync with behavior — a command, MCP, or lifecycle change must update the matching reference (`cli-reference`, `mcp-tools`, `agent-skills`, `installation`, `upgrading`).
- Host integration guides stay aligned with their root counterparts (`FOR_OPENCODE.md`, `FOR_PI.md`). Codex's canonical guide is `CODEX_INTEGRATION.md` because its native plugin is repository-distributed rather than lifecycle-installed.
- `CLAUDE_INTEGRATION.md` covers Claude's native plugin and how it divides ownership with the lifecycle installer (plugin: skills + MCP; installer: hooks). `FOR_CLAUDE.md` stays the agent-facing usage guide — keep the split, don't merge them.

## Work Guidance

- Start troubleshooting docs from `recall doctor` output.

## Verification

None automated — verify referenced commands run and links resolve.

## Child DOX Index

No child docs — `adr/` and `agents/` are covered by the contracts above.
