# omp integration

[Back to README](../README.md)

Recall's native omp extension captures the active conversation into SQLite after each completed main-agent turn. It uses `package.json#omp.extensions`, not Pi compatibility loading or a second marketplace bundle.

## Install from this checkout

Requires Bun, npm, and omp on `PATH`, plus an initialized Recall database. Capture was verified with omp 18.1.21; the strengthened E2E assertions were also verified with omp 18.2.0.

Build a clean package before linking. Linking the repository root would also expose development-only configuration, such as its `.mcp.json`, to omp.

```bash
bun install
bun run build
bun dist/index.js init
mkdir -p "$HOME/.agents/Recall/omp-package"
archive=$(npm pack --pack-destination "$HOME/.agents/Recall/omp-package" --ignore-scripts)
tar -xzf "$HOME/.agents/Recall/omp-package/$archive" -C "$HOME/.agents/Recall/omp-package"
omp plugin link "$HOME/.agents/Recall/omp-package/package"
```

Restart omp after linking. `/reload-plugins` does not reload extension modules. Keep the extracted directory in place for the lifetime of the link. To update a development install, rebuild and repeat the pack/extract steps, then restart omp.

Do not install the npm package named `recall-memory`; that name is an unrelated project (#312). Keep using the packed checkout above.

## Capture contract

- The awaited `session_stop` event runs after the main agent and its background work settle. omp does not emit it for task/subagent sessions.
- The extension reads `ctx.sessionManager.getBranch()` and sends ordered user/assistant text to its package-local `dist/index.js capture` (stdin JSON, contract 1, harness `omp`, event `turn_end`). No global `recall` executable is required. Door: [Capture adapter](CAPTURE_ADAPTER.md).
- Tool calls/results, thinking, images, developer/system instructions, and custom/summary entries are excluded before that call.
- Core scrubs secrets, tags the row `automatic-capture,omp`, and stores it at importance 6. This is not a model-backed extraction or a curated `fabric` call.
- The database defaults to `~/.agents/Recall/recall.db`; `RECALL_DB_PATH` retains its existing override.

This is turn-completion capture, not crash recovery. An interrupted turn before `session_stop` is not guaranteed captured. Shutdown and pre-compaction hooks are not installed. The complete active branch is retried on the next stop after a failure.

Capture accepts at most 25 MiB of serialized branch data and bounds its child process to 30 seconds. Oversize, malformed, cancelled, or failed captures warn without blocking the agent or publishing a partial branch. Large tool/image payloads count toward the input limit even though they are not stored.

## Skills and MCP remain separate

`recall install` still links the nine canonical `do-recall-*` skills into `~/.omp/agent/skills/` when omp is detected. It does not activate this extension. The native package does not duplicate those skills, register MCP, or inject session-start memory. Existing manual MCP configuration remains untouched.

## Verify and remove

```bash
omp plugin list
bun run test:e2e:omp
omp plugin uninstall recall-memory
```

The runtime check packs the distributable, links it into a disposable omp home, and uses the packaged CLI for initialization, capture, and search. A deterministic localhost model drives real headless omp turns. The check compares exact ordered roles and text, preserves earlier message IDs and native keys across resume, and verifies search results. After uninstall, it requires a third model request and the expected assistant answer before checking that the complete captured snapshot remains unchanged.

During the script, before-and-after checks compare existence, size, modification time, and inode for the default production database, its WAL and SHM files, and the default omp plugin lockfile. These checks do not prove byte-identical preservation of all live state, cover nondefault production locations, or cover the preceding build. Test children receive disposable configuration and database paths, not live model credentials. Executables still resolve through inherited `PATH`; this is not a network or filesystem sandbox.

This verifies the packed local-link integration in headless text mode. It does not exercise npm registry installation, real model providers, interactive sessions, compaction, subagents, or failure recovery.

Restart omp after uninstalling. Saved Recall memory remains. `recall uninstall` removes installer-owned skills, not the separately managed omp plugin; uninstall the plugin through omp before removing Recall's runtime.

If capture warns, check `bun` is available to omp, run `bun dist/index.js init` from the linked checkout, and check `RECALL_DB_PATH` permissions. Oversize branches need a new session; restarting alone does not reduce their serialized size.

## Native documentation

- [omp documentation](https://omp.sh/docs)
- [Extension authoring](https://omp.sh/docs/extension-authoring)
- [Upstream extension API](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md)
- [Plugin loading and installation](https://github.com/can1357/oh-my-pi/blob/main/docs/plugin-manager-installer-plumbing.md)
