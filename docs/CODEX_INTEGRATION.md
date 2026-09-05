# Codex Integration

[Back to README](../README.md)

**Preferred method:** author and maintain the native Codex plugin package in this repository. That is how Recall is packaged for Codex — not an end-user `codex plugin add` cookbook, and not `install.sh`.

Official Codex plugin authoring: [Package your plugin](https://developers.openai.com/plugins/build/plugins). Codex's `@plugin-creator` skill scaffolds the same layout; Recall already has the package in-tree.

The plugin owns three surfaces:

- `.mcp.json` — nine Recall MCP tools
- `skills/` — generated adapters from `agent-skills/`
- `hooks/hooks.json` — automatic transcript capture and session-start context

The plugin source lives in this repository. That does not mean Codex on a given machine has it installed.

## Author the package (preferred)

### Shape

Aligned with Codex's plugin root rules: only `plugin.json` belongs under `.codex-plugin/`. Skills, hooks, and MCP config stay at the plugin root.

```text
plugins/recall/
├── .codex-plugin/plugin.json
├── .mcp.json
├── skills/<name>/SKILL.md
└── hooks/hooks.json
```

Repo marketplace catalog (Codex reads this from the repository root):

```text
.agents/plugins/marketplace.json
```

| Field | Value |
| --- | --- |
| Marketplace `name` | `recall-marketplace` |
| Plugin `name` | `recall` |
| `source.source` | `local` |
| `source.path` | `./plugins/recall` (relative to the marketplace root, not to `.agents/plugins/`) |
| `policy.installation` | `AVAILABLE` |
| `policy.authentication` | `ON_INSTALL` |
| `category` | `Productivity` |

Manifest identity is `plugins/recall/.codex-plugin/plugin.json` (`name`, `version` matching `package.json`, `skills: "./skills/"`, `mcpServers: "./.mcp.json"`, `hooks: "./hooks/hooks.json"`). `.mcp.json` must register the installed `recall-mcp` executable — never a checkout-specific path.

### Source of truth and builder

Canonical skill bodies live in `agent-skills/<name>/SKILL.md`. Codex adapters are generated:

```bash
bun run build:codex-plugin
```

That runs `scripts/build-codex-plugin.ts`. It inserts a Codex routing preamble, strips `disable-model-invocation` (Codex does not interpret it), and for `recall-dump` writes `agents/openai.yaml` with `allow_implicit_invocation: false`. Generated files are checked in. Never hand-edit them.

Each skill in `agent-skills/` needs a matching entry in `routes` in the builder. Change canonical content in `agent-skills/`, then rebuild. Change host adaptation rules in `scripts/build-codex-plugin.ts`. Bump manifest `version` with `package.json`; bundle tests assert they agree.

### Skill names

Names stay `recall-*`. The tree, builders, and tests all use that prefix. There is no local `do-recall-*` convention. Do not half-rename plugin copies.

### Validate

Current Codex CLI has no `codex plugin validate`. Recall's authoring checks are:

```bash
bun test tests/plugins/codex-plugin.test.ts
bun run test:e2e:codex-plugin
```

The unit test asserts one plugin identity across the Codex manifest, `.mcp.json`, `hooks/hooks.json`, and `.agents/plugins/marketplace.json`, and that checked-in skill adapters match the builder. OpenAI's `@plugin-creator` ships a separate `python3 scripts/validate_plugin.py`; this repository does not vendor it.

### Iterate locally

After editing the package, rebuild skills, then reload via Codex's marketplace against this checkout (`codex plugin marketplace add` on the repo root, then `codex plugin add recall@recall-marketplace`). Codex copies into its plugin cache — update the source and re-add when the cache is stale. `install.sh` must not duplicate Codex MCP, skills, or hooks.

## Load the package you authored (secondary)

How a user (or you, on another machine) loads a valid package. Not the authoring path.

```bash
bun install -g recall-memory
recall init
codex plugin marketplace add /absolute/path/to/Recall
codex plugin add recall@recall-marketplace
```

The local clone path is required for the current checked-in marketplace. Codex owns installation and removal.

## MCP and skills

MCP is the primary interactive cross-host seam. The plugin exposes `memory_search`, `memory_hybrid_search`, `memory_recall`, `context_for_agent`, `memory_add`, `memory_stats`, `loa_show`, `memory_dump`, and `decision_update`.

They query and write the same SQLite store as the CLI. Set `RECALL_DB_PATH` in the plugin process environment when the store is not at the default path.

## Automatic lifecycle support

Codex CLI 0.147.0 provides supported plugin hooks, supplied transcript paths, compaction events, and structured additional-context output. Recall uses those public contracts without guessing Codex's private storage layout. Unlike Claude, these hooks **are** plugin-owned because Codex's plugin primitive is the supported lifecycle surface.

| Event | Recall behavior |
| --- | --- |
| `SessionStart` | Renders the shared tiered L0/L1 context and returns Codex `additionalContext` JSON. |
| `Stop` | Reads only the supplied rollout path and immediately ingests new verbatim messages. |
| `PreCompact` | Captures the supplied rollout before compaction. |
| `PostCompact` | Reconciles the supplied rollout after compaction. |
| `SessionEnd` | Captures the final rollout, closes the session, and creates one extracted summary. |

The host-neutral ingest seam preserves the native Codex session ID and project attribution. It scrubs unattended content before storage as required by [#50](https://github.com/edheltzel/Recall/issues/50), records `source = 'codex'`, and persists message keys plus a rolling byte watermark. Ordinary `Stop` events read only an append-only suffix. Compaction and terminal events validate the complete prior prefix, while shrinkage resets to a full reconciliation.

Capture writes directly to `recall.db`; it does not depend on the optional batch cron. Subagent rollouts are skipped by default. Set `RECALL_INCLUDE_SUBAGENTS=1` to opt in.

Codex-injected instruction turns are not memory. Recall drops user turns that
begin with the injected `AGENTS.md`, `<environment_context>`, or
`<user_instructions>` wrappers while retaining the user's typed prompt as its
own turn.

`memory_dump` remains useful for an explicit supplemental snapshot. When it uses the same native session ID, Recall merges the snapshot without deleting lifecycle-owned rows or their automatic extraction. It is no longer required for ordinary automatic capture.

## Trust and boundaries

Codex controls hook trust and plugin enablement. Recall never bypasses those controls.

The adapter intentionally does not depend on the installed plugin-cache path, infer a transcript path, or mutate Codex-owned marketplace state. Removing the plugin removes its MCP, skills, and lifecycle hooks together.

Remote marketplace publication and update policy remain separate distribution work. They do not affect the lifecycle contract of an authored local plugin.

## Development verification

`bun run test:e2e:codex-plugin` builds Recall and uses the current local Codex CLI with isolated `CODEX_HOME`, `HOME`, and `RECALL_DB_PATH` values. It verifies marketplace installation, all nine MCP tools, all five lifecycle hooks, structured session-start context, automatic temporary-database rows, deduplication, terminal extraction, plugin cleanup, and an unchanged production database.
