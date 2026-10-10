# Codex Integration

[Back to README](../README.md)

**Preferred install:** Codex's native plugin. It owns MCP, skills, and lifecycle hooks.

The checked-in marketplace catalog is `.agents/plugins/marketplace.json`. The plugin bundle is `hosts/plugins/recall/`. Source in this repository does not mean the plugin is installed on a given machine — run the commands below to enable it.

The plugin owns three distinct surfaces:

- `.mcp.json` registers the nine Recall MCP tools.
- `skills/` contains generated adapters from the canonical `agent-skills/` sources.
- `hooks/hooks.json` provides automatic transcript capture and session-start context.

## Install (preferred)

Install Recall first so `recall`, `recall-mcp`, and the SQLite schema are available. Recall is not published to npm (#312). From a checkout:

```bash
bun run build && npm pack --pack-destination <dir>
bun install -g <dir>/recall-memory-<version>.tgz
recall init
```

Or `git clone https://github.com/edheltzel/Recall.git && cd Recall && ./packaging/install.sh`.

Then add this repository as a Codex marketplace and install its plugin:

```bash
codex plugin marketplace add /absolute/path/to/Recall
codex plugin add recall@recall-marketplace
```

The local repository path is required for the current checked-in marketplace. A future remote marketplace can drop that clone prerequisite after its distribution policy is defined.

Codex owns plugin installation and removal. `install.sh` does not duplicate the Codex marketplace, MCP, skills, or hooks. There is no installer-script fallback for Codex — the native plugin is the only supported attach path.

## MCP and skills

MCP is the primary interactive cross-host seam. The plugin exposes `memory_search`, `memory_hybrid_search`, `memory_recall`, `context_for_agent`, `memory_add`, `memory_stats`, `loa_show`, `memory_dump`, and `decision_update`.

They query and write the same SQLite store as the CLI. Set `RECALL_DB_PATH` in the plugin process environment when the store is not at the default path.

The nine `do-recall-*` skill adapters are generated from the canonical Agent Skills established by [#228](https://github.com/edheltzel/Recall/issues/228). Do not edit the generated plugin copies by hand.

## Automatic lifecycle support

Codex CLI 0.147.0 provides supported plugin hooks, supplied transcript paths, compaction events, and structured additional-context output. Recall uses those public contracts without guessing Codex's private storage layout.

| Event | Recall behavior |
| --- | --- |
| `SessionStart` | Hidden `recall host-hook codex`. Renders the shared L0/L1 assembler and returns Codex `additionalContext`. Not ambient capture. |
| `Stop` | `hooks/capture.ts` reads the supplied rollout and calls `recall capture` with `turn_end`. |
| `PreCompact` | Same adapter, `turn_end`, before compaction. |
| `PostCompact` | Same adapter, `turn_end`, after compaction. |
| `SessionEnd` | Same adapter, `session_end`. |

Ambient events do not call `host-hook`. Guide: [Capture adapter](CAPTURE_ADAPTER.md). The adapter keeps the native session id, drops injected `AGENTS.md` / `<environment_context>` / `<user_instructions>` user turns, and skips subagent rollouts unless `RECALL_INCLUDE_SUBAGENTS=1`. Core scrubs and stores. Capture does not depend on the optional batch cron.

Codex-injected instruction turns are not memory. Recall drops user turns that
begin with the injected `AGENTS.md`, `<environment_context>`, or
`<user_instructions>` wrappers while retaining the user's typed prompt as its
own turn.

`memory_dump` remains useful for an explicit supplemental snapshot. When it uses the same native session ID, Recall merges the snapshot without deleting lifecycle-owned rows or their automatic extraction. It is no longer required for ordinary automatic capture.

## Trust and boundaries

Codex controls hook trust and plugin enablement. Recall never bypasses those controls.

The adapter intentionally does not depend on the installed plugin-cache path, infer a transcript path, or mutate Codex-owned marketplace state. Removing the plugin removes its MCP, skills, and lifecycle hooks together.

Remote marketplace publication and update policy remain separate distribution work. They do not affect the lifecycle contract of an installed local plugin.

## Maintaining the package

Maintainer-only. Not the install path.

Canonical skills live in `agent-skills/`. Regenerate Codex adapters with `bun run build:codex-plugin` (`scripts/build-codex-plugin.ts`). Do not hand-edit `hosts/plugins/recall/skills/`. Skill names use `do-recall-*`. Current Codex CLI has no `codex plugin validate`.

```bash
bun test tests/plugins/codex-plugin.test.ts
bun run test:e2e:codex-plugin
```

The e2e test uses isolated `CODEX_HOME`, `HOME`, and `RECALL_DB_PATH` and leaves the production database unchanged.
