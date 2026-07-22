# Claude Code Integration

[Back to README](../README.md)

Recall ships two Claude Code surfaces, and they own different things:

- The **lifecycle installer** (`install.sh`) owns hooks — `Stop`, `SessionStart`, `PreCompact` — which is how Recall captures sessions automatically and injects the tiered L0/L1 context block.
- The **native plugin** owns the nine `recall-*` skills and the `recall-memory` MCP server, packaged behind one manifest instead of user-level configuration.

The checked-in marketplace manifest is `.claude-plugin/marketplace.json`, and the plugin bundle is `plugins/recall-claude/`.

Running only the installer is still fully supported; the plugin is additive.

## Install

Install Recall first so `recall-mcp` is on `PATH`:

```bash
bun install -g recall-memory
recall init
```

Then add this repository as a marketplace and install its plugin:

```bash
claude plugin marketplace add /absolute/path/to/Recall
claude plugin install recall@recall-marketplace
```

The repository path is deliberate for the current checked-in marketplace. A future remote marketplace can remove that local-clone prerequisite after its distribution and update policy are defined.

## What MCP covers

MCP is the primary cross-host seam.

The plugin exposes all nine Recall operations: `memory_search`, `memory_hybrid_search`, `memory_recall`, `context_for_agent`, `memory_add`, `memory_stats`, `loa_show`, `memory_dump`, and `decision_update`.

They query and write the same SQLite store as the CLI.

The bundled `.mcp.json` carries no `env` block, so the server resolves its database from `RECALL_DB_PATH` in Claude's environment, falling back to `~/.agents/Recall/recall.db`. Export `RECALL_DB_PATH` in your shell when the store lives elsewhere.

## Migrating an existing install

An existing Recall install keeps working. It also keeps its own copies of what the plugin now ships, and Claude does **not** resolve that for you:

- **Skills.** `~/.claude/skills/recall-*` and the plugin's nine skills both load.
- **MCP.** Claude namespaces plugin components, so the plugin registers as `plugin:recall:recall-memory` while a user-scope `recall-memory` keeps its own name. Both connect, and the same nine tools are exposed twice from two processes.

Claude collapses the two MCP entries only when they resolve to an identical command and environment. `install.sh` writes `bun run <path>` plus an `env` block, so a real existing install always duplicates.

`install.sh` and `update.sh` reconcile this, and both are idempotent — run either after installing the plugin:

```bash
./update.sh
```

With the plugin active they:

1. Remove the `~/.claude/skills/recall-*` symlinks that point into `~/.agents/Recall/shared/skills/`. Only Recall-owned symlinks are removed; real files, user-authored skills, and other tools' links are left alone, and a skill directory is deleted only when it is already empty.
2. Remove the user-scope `recall-memory` MCP registration, so the plugin's is the only one left.
3. Leave hooks and canonical files untouched.

Skill canonicals under `~/.agents/Recall/shared/skills/` are still refreshed, because Pi, omp, and `recall doctor` read them.

**A registration pinned to a non-default database is kept, not removed.** The plugin's bundled config cannot carry your custom path, so deleting the entry would silently repoint Recall at the default file and your history would read as empty.

Custom-database installs therefore keep both surfaces by design, and re-running `update.sh` will not change that — the decision is made from the path stored in the entry, which stays custom. Collapsing them is a deliberate manual step, because only you can confirm the environment Claude actually launches with:

```bash
export RECALL_DB_PATH=/path/to/your/recall.db   # where you launch Claude from
claude mcp list                                  # confirm plugin:recall:recall-memory connects
claude mcp remove recall-memory -s user          # then drop the duplicate
```

`recall doctor` reports the state under **Claude native plugin**: `PASS` when the plugin is the sole owner, `WARN` listing the duplicates when a legacy copy is still present, `INFO` when the plugin is absent or disabled.

Uninstalling is a separate, user-owned action — `uninstall.sh` does not remove the plugin:

```bash
claude plugin uninstall recall@recall-marketplace
./install.sh   # restores the lifecycle-owned skills and MCP registration
```

## What the plugin does not cover

**Lifecycle hooks are not in the bundle.** Plugin hooks *merge* with `settings.json` hooks rather than replacing them, so shipping `Stop`/`SessionStart`/`PreCompact` in the plugin would run every capture twice for anyone who also ran `install.sh` — duplicate extractions into the same database. Auto-capture, tiered L0/L1 injection, and pre-compaction flushing therefore remain lifecycle-installed.

This is the one place where the plugin is deliberately not self-sufficient: a plugin-only user gets skills and MCP, not automatic capture.

## Differences from the Codex package

Named explicitly rather than assumed away, because identical `SKILL.md` bytes do not imply identical behavior across hosts:

| | Codex (`plugins/recall/`) | Claude (`plugins/recall-claude/`) |
| --- | --- | --- |
| Manifest | `.codex-plugin/plugin.json` | `.claude-plugin/plugin.json` |
| Marketplace | `.agents/plugins/marketplace.json` | `.claude-plugin/marketplace.json` |
| Skill payload | Generated adapters with a Codex routing preamble | Byte-verbatim copies of `agent-skills/` |
| `disable-model-invocation` | Stripped; replaced by `agents/openai.yaml` because Codex does not interpret it | Kept — it is Claude's own frontmatter contract |
| MCP naming | `recall-memory` | `plugin:recall:recall-memory` (namespaced) |
| Pre-existing install to reconcile | None — Codex had no lifecycle installer | Nine skill symlinks and a user-scope MCP entry |
| Lifecycle capture | Not implemented on any surface | Implemented, but by the installer's hooks — not the plugin |

The Claude bundle needs no routing preamble because `agent-skills/` is already authored against Claude's frontmatter. Rewriting the bodies would change behavior relative to the skills users already have, which is the opposite of a safe migration.

Skills are copied rather than symlinked into the bundle. Claude drops symlinks that leave the plugin root when a plugin is installed from a local path, and a checkout with `core.symlinks=false` would degrade the payload silently.

## Current boundaries

The following are unresolved rather than guessed:

- **End-to-end enforcement of `disable-model-invocation` for plugin-shipped skills is unverified.** The installed CLI carries the runtime enforcement for the field, and the bundle ships it unchanged, but confirming that a plugin-loaded `recall-dump` is explicit-only needs an authenticated session — and `claude plugin validate --strict` does not inspect skill frontmatter at all, so passing validation is not evidence.
- Skill *invocation* names under a plugin. `claude plugin details` lists all nine by their canonical names; the namespacing observed for MCP was not separately confirmed for skills.
- Remote marketplace publication, update, and release ownership.
- The installed plugin-cache path as a durable runtime dependency.

None of these block the nine MCP operations or the skill surface.

## Development verification

`bun run build:claude-plugin` regenerates the bundle's skills from the canonical `agent-skills/` sources.

`bun test tests/plugins/claude-plugin.test.ts` asserts one plugin identity across the manifests, that the checked-in skills are byte-identical to their canonical sources, and that no hooks ship in the bundle.

`bun run test:e2e:claude-plugin` builds Recall, then against the **current local Claude CLI**: validates both manifests in strict mode, installs the plugin into a disposable `HOME`, asserts nine skills and the MCP server load from the bundle, seeds a legacy install and proves the migration removes both duplicates twice over without touching a user-authored skill, exercises all nine MCP tools against a disposable `RECALL_DB_PATH`, and verifies that neither the production database nor the real `~/.claude` changed.
