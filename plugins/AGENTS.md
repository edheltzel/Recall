# plugins — native host bundles

> Child DOX. Root `AGENTS.md` carries repo-wide rules; this file owns local detail for `plugins/`.

## Purpose

Native host plugin bundles distributed directly from the Recall repository. One bundle per host: each host's plugin primitive is used natively rather than through a shared cross-host abstraction.

## Ownership

- `recall/` — Codex native plugin manifest, MCP registration, and generated `recall-*` skill adapters
- `recall-claude/` — Claude Code native plugin manifest, MCP registration, and the nine `recall-*` skills

The repository-level marketplace manifests are owned with their bundles even though they live outside this subtree: `.agents/plugins/marketplace.json` (Codex) and `.claude-plugin/marketplace.json` (Claude).

Both bundles declare plugin `name: "recall"` in their own host manifest; the directory names differ only because one repository hosts both.

## Local Contracts

- Each host manifest (`.codex-plugin/plugin.json`, `.claude-plugin/plugin.json`) is canonical for its host and must validate against that host's current tooling. For Claude that is `claude plugin validate <path> --strict` — which checks the manifest only, **not** skill frontmatter.
- `.mcp.json` registers the installed `recall-mcp` executable; do not embed a checkout-specific executable path.
- `skills/` is generated from `agent-skills/` — Codex by `scripts/build-codex-plugin.ts`, Claude by `scripts/build-claude-plugin.ts`. Never hand-edit a generated skill.
- Host-specific invocation metadata belongs in each generated skill's `agents/` directory. Behavioral parity is verified per host; matching `SKILL.md` bytes are not proof — Codex strips `disable-model-invocation` and replaces it with `agents/openai.yaml`, while Claude keeps the field because it is Claude's own contract.
- Codex adapters carry a routing preamble; the Claude bundle is byte-verbatim, because `agent-skills/` is already authored against Claude's frontmatter and rewriting it would change behavior for users migrating from the lifecycle install.
- Copy skills into a bundle; never symlink. Claude drops symlinks that leave the plugin root on local-path installs, and `core.symlinks=false` checkouts degrade the payload silently.
- **No bundle ships lifecycle hooks.** Claude merges plugin hooks with `settings.json` hooks instead of replacing them, so a bundled hook would double every capture for anyone who also ran `install.sh`. Codex has no verified transcript contract at all. Do not add plugin hooks to either bundle until that changes.
- The Claude bundle coexists with the lifecycle installer, so `lib/install-lib.sh` must keep reconciling the duplicate skill symlinks and MCP registration. `RECALL_CLAUDE_PLUGIN_ID` there and `CLAUDE_PLUGIN_ID` in `src/hosts/claude.ts` are the same id — keep them in step.

## Work Guidance

- Change canonical skill content in `agent-skills/`, then run `bun run build:codex-plugin` **and** `bun run build:claude-plugin`.
- Change host adaptation rules in the matching `scripts/build-*-plugin.ts`.
- Bump each manifest `version` with `package.json`; the bundle tests assert they agree.

## Verification

- `bun test tests/plugins/`
- `bun run test:e2e:codex-plugin`
- `bun run test:e2e:claude-plugin`

## Child DOX Index

No child docs.
