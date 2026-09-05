# Pi Integration

[Back to README](../README.md)

Recall uses the native Pi mechanisms that exist today, but Pi does not have one bundle primitive that spans extensions, skills, and MCP.

The one-step Recall installer coordinates several separately owned Pi surfaces instead of pretending they are one plugin.

## Verified Pi surface

This integration was verified on 2026-07-22 against the installed `@earendil-works/pi-coding-agent` 0.81.1 CLI and its matching official documentation.

The live probes were:

```bash
pi --version
pi --help
pi install --help
pi --no-extensions --help
```

`pi --help` exposed `--extension`, `--skill`, and an extension-contributed `--mcp-config` flag.

The same help command with `--no-extensions` still exposed Pi's native extension and skill loaders, but the MCP flag disappeared.

That is direct CLI evidence that MCP is supplied by an installed extension, not by Pi's package manifest.

The official Pi 0.81.1 documentation independently defines [packages](https://github.com/earendil-works/pi/blob/v0.81.1/packages/coding-agent/docs/packages.md), [skills](https://github.com/earendil-works/pi/blob/v0.81.1/packages/coding-agent/docs/skills.md), and [extension lifecycle events](https://github.com/earendil-works/pi/blob/v0.81.1/packages/coding-agent/docs/extensions.md#session-events).

| Surface | Pi can discover it | A Pi package can install it | Recall's Pi shape |
|---|---:|---:|---|
| Extension | Yes | Yes | The root `recall-memory` package declares `pi/*.ts` |
| Agent Skills | Yes | Yes | The same package declares all nine canonical `agent-skills/*/SKILL.md` files |
| Lifecycle handlers | Yes, as extension code | Yes, inside an extension | Recall subscribes to `before_agent_start` and `session_shutdown` |
| MCP server | Only through an MCP client extension | No | `pi-mcp-adapter` plus `~/.pi/agent/mcp.json` |

Extensions, skills, and their lifecycle handlers can therefore travel together as a real Pi package.

MCP cannot join that unit because `mcp` is not a Pi package resource.

## Install

If Recall is already installed as a global package, run one integration command:

```bash
recall install --yes
```

For a one-shot package install with Bun already on `PATH`, use:

```bash
npx --package=recall-memory recall install --yes
```

From a source checkout, the equivalent one-step command is:

```bash
./install.sh --yes
```

The installer performs these separate operations in order:

1. Installs or preserves `pi-mcp-adapter` in Pi's configured home.
2. Registers the Recall root as a native Pi package for the two extensions and nine skills.
3. Writes only the owned `recall-memory` entry in Pi's `mcp.json`.
4. Installs the Recall guide and its marked `AGENTS.md` pointer.
5. Removes old Recall extension and skill symlinks after the package is working, backing up customized or foreign collisions first.

Re-running the command converges on the same state.

An existing adapter is preserved if npm is temporarily unavailable.

A fresh install fails instead of claiming success when the adapter or native Recall package cannot be installed.

Do not use `pi install npm:recall-memory` as the full installation command.

That command can load Recall's extensions and skills, but it cannot register `recall-memory` with an MCP client or ensure the `recall` and `recall-mcp` executables are on `PATH`.

## What MCP covers

MCP is the primary cross-host operation seam.

The separately configured `recall-memory` server exposes all nine Recall operations:

- `memory_search`
- `memory_hybrid_search`
- `memory_recall`
- `context_for_agent`
- `memory_add`
- `memory_stats`
- `loa_show`
- `memory_dump`
- `decision_update`

Recall enables the adapter's direct-tool mode by default, which exposes them with the normalized `recall_memory_` server prefix inside Pi.

An existing explicit `directTools` preference is preserved during reinstall.

On the first Pi session after a new server is configured, the adapter exposes its `mcp` proxy while it builds the metadata cache.

The direct tool names register on the next Pi reload or restart; all nine operations remain reachable through the proxy during that warm-up session.

The server and CLI use the same SQLite store.

The installer writes the resolved `RECALL_DB_PATH` into the MCP entry so a custom database remains explicit.

## Lifecycle behavior

Pi's native extension API provides real lifecycle events, so Recall does not need to infer them from transcript files.

`RecallPreCompact.ts` subscribes to `before_agent_start` and uses Pi's asynchronous `pi.exec()` API to fetch relevant Recall context before the turn.

`RecallExtract.ts` subscribes to `session_shutdown` and obtains the active JSONL path from `ctx.sessionManager.getSessionFile()`.

It linearizes Pi's active tree branch and writes markdown under `$RECALL_HOME/MEMORY/pi-sessions/` for the existing batch extraction pipeline.

Pi also exposes compaction events, but Recall does not claim a separate pre-compaction flush.

Pi retains the session tree in its JSONL, so shutdown capture reads the supported persisted session instead of duplicating partial snapshots.

Ephemeral `--no-session` runs have no session file and are not auto-captured.

## Installed state

The default paths are:

| Path | Owner and purpose |
|---|---|
| `~/.pi/agent/settings.json` | Pi package registrations for Recall and `pi-mcp-adapter` |
| `~/.pi/agent/mcp.json` | Adapter configuration containing Recall's owned server entry |
| `~/.pi/agent/Recall_GUIDE.md` | Recall's Pi usage guide |
| `~/.pi/agent/AGENTS.md` | Marked pointer to the guide and live MCP schemas |
| `~/.agents/Recall/MEMORY/pi-sessions/` | Pi shutdown-capture drop directory |
| `~/.agents/Recall/recall.db` | Shared Recall database |

Pi honors `PI_CODING_AGENT_DIR` for a non-default Pi home.

Recall's lifecycle scripts derive `PI_CONFIG_DIR` from that variable and pass it back to every `pi install`, `pi list`, and `pi remove` operation.

## What Pi cannot do that Codex and Claude can

Pi cannot declare Recall's MCP server in the same package manifest that declares its extensions and skills.

Codex's native Recall plugin can carry `.mcp.json` and skills in its `.codex-plugin` bundle.

Claude's plugin system likewise has a host-owned plugin manifest and component model.

Pi's `package.json#pi` manifest has only extensions, skills, prompts, and themes.

Therefore Recall on Pi has no single installable artifact with the same completeness as those plugin bundles.

The Recall installer is one human step, but the resulting state remains visibly separate: a Pi package, an MCP adapter package, an MCP config entry, and Recall-owned guide files.

Recall does not introduce a cross-host bundle abstraction to hide that difference.

Pi also does not make MCP available when extensions are disabled, and it cannot auto-capture ephemeral sessions that have no persisted session file.

## Development verification

`bun run test:e2e:pi-integration` builds Recall and exercises the current installed Pi CLI in an isolated `PI_CODING_AGENT_DIR` with a disposable `RECALL_HOME` and `RECALL_DB_PATH`.

The test installs the separate Pi resources twice, holds a first Pi RPC session open for the adapter's documented metadata warm-up, then verifies all nine skills and direct MCP tools after restart.

It also loads a synthetic persisted Pi session through the real CLI, checks shutdown capture, and proves the production database metadata did not change.

The focused unit coverage is in `tests/pi-integration.test.ts`.
