# omp integration

[Back to README](../README.md)

Recall's native omp extension captures the active conversation into SQLite after each completed main-agent turn. It uses `package.json#omp.extensions`, not Pi compatibility loading or a second marketplace bundle.

## Install from this checkout

Requires Bun on `PATH` and an initialized Recall database. Verified with omp 18.1.21.

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

Once a release containing this integration is published, `omp plugin install recall-memory` installs the same package directly from npm. Use the packed checkout for the unreleased feature.

## Capture contract

- The awaited `session_stop` event runs after the main agent and its background work settle. omp does not emit it for task/subagent sessions.
- The extension reads `ctx.sessionManager.getBranch()` and sends the active branch to its package-local `dist/index.js host-hook omp` through stdin. No global `recall` executable is required.
- Recall stores user and assistant text with native entry IDs, source `omp`, and project attribution. Tool calls/results, thinking, images, developer/system instructions, and custom/summary entries are excluded.
- The existing lifecycle ingest path redacts secrets before persistence. Repeated capture is idempotent; distinct native entries containing identical text remain distinct messages. The next successful capture reconciles branch changes so abandoned messages stop appearing in current search results.
- Each successful stop updates the session's automatic LoA summary at importance 6. This uses the existing local terminal summary, not a model-backed extraction or curated `fabric` call.
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

The runtime check packs the distributable and links its extracted directory into a disposable omp home, serves deterministic replies over localhost, and verifies real `session_stop` capture, resume without duplicated history, CLI search, and uninstall stopping capture. It uses a disposable database and checks that the normal database and omp plugin registry remain unchanged. No model credentials or external model requests are needed.

Restart omp after uninstalling. Saved Recall memory remains. `recall uninstall` removes installer-owned skills, not the separately managed omp plugin; uninstall the plugin through omp before removing Recall's runtime.

If capture warns, check `bun` is available to omp, run `bun dist/index.js init` from the linked checkout, and check `RECALL_DB_PATH` permissions. Oversize branches need a new session; restarting alone does not reduce their serialized size.

## Native documentation

- [omp documentation](https://omp.sh/docs)
- [Extension authoring](https://omp.sh/docs/extension-authoring)
- [Upstream extension API](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md)
- [Plugin loading and installation](https://github.com/can1357/oh-my-pi/blob/main/docs/plugin-manager-installer-plumbing.md)
