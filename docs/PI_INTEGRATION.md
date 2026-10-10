# Pi Integration

[Back to README](../README.md)

**Preferred install:** Pi's native package (`pi install`). It owns the two Recall extensions and the nine `do-recall-*` Agent Skills.

Pi packages cannot declare MCP servers. After the native package is installed, register `pi-mcp-adapter` and the owned `recall-memory` entry in `mcp.json`. `recall install --yes` runs those native steps in order — it is a coordinator, not a replacement for the Pi package.

## Verified Pi surface

This integration was verified on 2026-09-03 against the installed `@earendil-works/pi-coding-agent` 0.84.4 CLI and `pi-mcp-adapter` 2.32.1.

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

## Install (preferred)

Install the Recall binaries through the canonical [source-checkout](installation.md#source-checkout) or [local-tarball](installation.md#local-tarball) procedure, then attach Pi through its native package. Recall is not published to npm (#312).

```bash
pi install /absolute/path/to/Recall
```

`pi install /absolute/path/to/Recall` is the extensions + skills attach.

That command loads extensions and skills. It does **not** register MCP or put `recall` / `recall-mcp` on `PATH`. Complete the MCP half:

```bash
pi install npm:pi-mcp-adapter
recall install --yes
```

`recall install --yes` (or `./packaging/install.sh --yes` from a checkout) performs these separate operations in order:

1. Installs or preserves `pi-mcp-adapter` in Pi's configured home.
2. Registers the Recall root as a native Pi package for the two extensions and nine skills.
3. Writes only the owned `recall-memory` entry in Pi's `mcp.json`.
4. Installs the Recall guide and its marked `AGENTS.md` pointer.
5. Removes old Recall extension and skill symlinks after the package is working, backing up customized or foreign collisions first.

Re-running the command converges on the same state.

An existing adapter is preserved if npm is temporarily unavailable.

A fresh install fails instead of claiming success when the adapter or native Recall package cannot be installed.

Do not treat `pi install /absolute/path/to/Recall` as a complete Recall install. It is the **extensions + skills** attach; MCP still needs the adapter and config.

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

Recall enables direct tools by default, registered as `recall-memory_<tool>` (adapter default `toolPrefix: "server"` keeps hyphens; a hyphen-stripped `recall_memory_` prefix is not the contract). Pi 1.0's `mcp.json` is native config: `pi-mcp-adapter` 5.x ignores `directTools` in that file and maps `exposure: "direct"` onto direct tools. The installer writes both (`exposure` for Pi 1.0, `directTools` for older adapter configs). Without the adapter, Pi's own names are `mcp__recall_memory__<tool>`.

An existing explicit `directTools` or `exposure` preference is preserved. A saved `directTools` value with no `exposure` is translated (`false` → `codemode`, `"search"` → `deferred`, a name list → `codemode` plus `toolExposure`) so Pi 1.0 still honors it.

On the first Pi session after a new server is configured, the adapter exposes its `mcp` proxy while it builds the metadata cache.

The direct tool names register on the next Pi reload or restart; all nine operations remain reachable through the proxy during that warm-up session.

The server and CLI use the same SQLite store.

The installer writes the resolved `RECALL_DB_PATH` into the MCP entry so a custom database remains explicit.

## Lifecycle behavior

Pi's native extension API provides real lifecycle events, so Recall does not need to infer them from transcript files.

`RecallPreCompact.ts` subscribes to `before_agent_start` and uses Pi's asynchronous `pi.exec()` API to fetch relevant Recall context before the turn.

`RecallExtract.ts` subscribes to `session_shutdown` and obtains the active JSONL path from `ctx.sessionManager.getSessionFile()`.

It linearizes Pi's active tree branch, calls `recall capture` (harness `pi`, event `session_end`), and still writes markdown under `$RECALL_HOME/MEMORY/pi-sessions/` for the existing batch extraction pipeline. Guide: [Capture adapter](CAPTURE_ADAPTER.md).

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

The preferred Pi attach is still the native package (`pi install`). Completeness requires separate MCP adapter/config, which `recall install` can coordinate. Recall does not introduce a cross-host bundle abstraction to hide that difference.

Pi also does not make MCP available when extensions are disabled, and it cannot auto-capture ephemeral sessions that have no persisted session file.

## Development verification

`bun run test:e2e:pi-integration` builds Recall and exercises the current installed Pi CLI in an isolated `PI_CODING_AGENT_DIR` with a disposable `RECALL_HOME` and `RECALL_DB_PATH`.

The test installs the separate Pi resources twice, holds a first Pi RPC session open for the adapter's documented metadata warm-up, then verifies all nine skills and direct MCP tools after restart.

It also loads a synthetic persisted Pi session through the real CLI, checks shutdown capture, and proves the production database metadata did not change.

The focused unit coverage is in `tests/pi-integration.test.ts`.
