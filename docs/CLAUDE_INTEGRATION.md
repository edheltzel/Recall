# Claude Code Integration

[Back to README](../README.md)

**Preferred method:** author and maintain the native Claude Code plugin package in this repository. That is how Recall is packaged for Claude — not an end-user `claude plugin install` cookbook, and not the lifecycle installer.

Official Claude plugin authoring: [Create plugins](https://code.claude.com/docs/en/plugins), [Plugins reference](https://code.claude.com/docs/en/plugins-reference), [Plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces.md).

The plugin owns the nine `recall-*` skills and the `recall-memory` MCP server. Claude lifecycle hooks stay **installer-owned** (`install.sh` / `recall install`). Plugin hooks *merge* with `settings.json` rather than replacing them, so shipping `Stop` / `SessionStart` / `PreCompact` in the bundle would double-capture.

The plugin source lives in this repository. That does not mean Claude on a given machine has it installed.

## Author the package (preferred)

### Shape

Aligned with Claude's plugin root rules: only `plugin.json` belongs under `.claude-plugin/`. Skills, MCP config, and hooks live at the plugin root — and this bundle ships **no** `hooks/`.

```text
plugins/recall-claude/
├── .claude-plugin/plugin.json   # identity; only this file in .claude-plugin/
├── .mcp.json                    # recall-mcp on PATH; no checkout path, no env block
└── skills/<name>/SKILL.md       # generated; do not hand-edit
```

Repo marketplace catalog (Claude reads this from the repository root):

```text
.claude-plugin/marketplace.json
```

| Field | Value |
| --- | --- |
| Marketplace `name` | `recall-marketplace` |
| Plugin `name` | `recall` |
| `source` | `./plugins/recall-claude` |
| Plugin id | `recall@recall-marketplace` |

Manifest identity is `plugins/recall-claude/.claude-plugin/plugin.json` (`name`, `version` matching `package.json`, `mcpServers: "./.mcp.json"`).

### Source of truth and builder

Canonical skill bodies live in `agent-skills/<name>/SKILL.md`. The Claude payload is generated:

```bash
bun run build:claude-plugin
```

That runs `scripts/build-claude-plugin.ts`. It copies skills **byte-verbatim** (Claude already owns the frontmatter contract: `disable-model-invocation`, `allowed-tools`) into `plugins/recall-claude/skills/`. Generated files are checked in so Claude's plugin cache is complete. Never hand-edit them. Copy, never symlink — Claude drops symlinks that leave the plugin root on local-path installs, and `core.symlinks=false` checkouts degrade the payload silently.

Change canonical content in `agent-skills/`, then rebuild. Change host adaptation rules in `scripts/build-claude-plugin.ts`. Bump manifest `version` with `package.json`; bundle tests assert they agree.

### Skill names

Names stay `recall-*`. `agent-skills/`, both plugin skill trees, builders, installer, uninstall list, and tests all use that prefix. There is no local `do-recall-*` convention to reconcile. Renaming would break slash commands and lifecycle skill dirs across hosts.

### Validate

```bash
claude plugin validate plugins/recall-claude --strict
claude plugin validate . --strict
bun test tests/plugins/claude-plugin.test.ts
```

`--strict` treats warnings as errors. Pointed at the plugin directory it checks `plugin.json` (and, on current Claude CLIs, companion files). Pointed at the repo root it checks `marketplace.json`. Passing validate is **not** evidence that a plugin-loaded `recall-dump` is explicit-only — the validator is not a skill-behavior proof.

### Iterate locally

```bash
claude --plugin-dir ./plugins/recall-claude
```

`/reload-plugins` picks up skill and MCP edits in that session. `--plugin-dir` is an authoring loop; it does not install the marketplace plugin onto the machine.

## Load the package you authored (secondary)

How a user (or you, on another machine) loads a valid package. Not the authoring path.

```bash
bun install -g recall-memory
recall init
claude plugin marketplace add /absolute/path/to/Recall
claude plugin install recall@recall-marketplace
recall install    # installer-owned Claude hooks; skips duplicate skills/MCP when the plugin is active
```

The local clone path is required for the current checked-in marketplace. A plugin-only load gives skills and MCP, not automatic capture.

## Migrating an existing install

An existing Recall install keeps working. It also keeps its own copies of what the plugin now ships, and Claude does **not** resolve that for you:

- **Skills.** `~/.claude/skills/recall-*` and the plugin's nine skills both load.
- **MCP.** Claude namespaces plugin components, so the plugin registers as `plugin:recall:recall-memory` while a user-scope `recall-memory` keeps its own name. Both connect, and the same nine tools are exposed twice from two processes.

Claude collapses the two MCP entries only when they resolve to an identical command and environment. `install.sh` writes `bun run <path>` plus an `env` block, so a real existing install always duplicates.

`install.sh` and `update.sh` reconcile this, and both are idempotent — run either after loading the plugin:

```bash
./update.sh
```

With the plugin active they:

1. Remove the `~/.claude/skills/recall-*` symlinks that point into `~/.agents/Recall/shared/skills/`. Only Recall-owned symlinks are removed; real files, user-authored skills, and other tools' links are left alone, and a skill directory is deleted only when it is already empty.
2. Remove the user-scope `recall-memory` MCP registration, so the plugin's is the only one left.
3. Leave hooks and canonical files untouched.

Skill canonicals under `~/.agents/Recall/shared/skills/` are still refreshed, because Pi, omp, and `recall doctor` read them.

**A registration pinned to a non-default database is kept, not removed.** The plugin's bundled config cannot carry your custom path, so deleting the entry would silently repoint Recall at the default file and your history would read as empty.

```bash
export RECALL_DB_PATH=/path/to/your/recall.db
claude mcp list
claude mcp remove recall-memory -s user
```

`recall doctor` reports the state under **Claude native plugin**: `PASS` when the plugin is the sole owner, `WARN` listing the duplicates when a legacy copy is still present, `INFO` when the plugin is absent or disabled.

`uninstall.sh` does not remove the plugin:

```bash
claude plugin uninstall recall@recall-marketplace
./install.sh   # restores the lifecycle-owned skills and MCP registration
```

## Differences from the Codex package

| | Codex (`plugins/recall/`) | Claude (`plugins/recall-claude/`) |
| --- | --- | --- |
| Manifest | `.codex-plugin/plugin.json` | `.claude-plugin/plugin.json` |
| Marketplace | `.agents/plugins/marketplace.json` | `.claude-plugin/marketplace.json` |
| Skill payload | Generated adapters with a Codex routing preamble | Byte-verbatim copies of `agent-skills/` |
| `disable-model-invocation` | Stripped; replaced by `agents/openai.yaml` because Codex does not interpret it | Kept — it is Claude's own frontmatter contract |
| MCP naming | `recall-memory` | `plugin:recall:recall-memory` (namespaced) |
| Lifecycle capture | Plugin-owned; see [Codex Integration](CODEX_INTEGRATION.md) | Installer-owned hooks — not in this bundle |

## Current boundaries

- End-to-end enforcement of `disable-model-invocation` for plugin-shipped skills is unverified.
- Skill invocation namespacing under a plugin was not separately confirmed (MCP is namespaced).
- Remote marketplace publication, update, and release ownership.
- The installed plugin-cache path as a durable runtime dependency.

## Development verification

`bun test tests/plugins/claude-plugin.test.ts` asserts one plugin identity across the manifests, that the checked-in skills are byte-identical to their canonical sources, and that no hooks ship in the bundle.

`bun run test:e2e:claude-plugin` builds Recall, then against the current local Claude CLI: validates both manifests in strict mode, installs the plugin into a disposable `HOME`, asserts nine skills and the MCP server load from the bundle, seeds a legacy install and proves the migration removes both duplicates twice over without touching a user-authored skill, exercises all nine MCP tools against a disposable `RECALL_DB_PATH`, and verifies that neither the production database nor the real `~/.claude` changed.
