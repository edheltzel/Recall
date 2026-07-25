# opencode — OpenCode host integration

> Child DOX. Root `AGENTS.md` carries repo-wide rules; this file owns local detail for `opencode/`.

## Purpose

The OpenCode adapter: the plugins OpenCode loads, their shared helpers, and the
memory-aware agent definition.

## Ownership

- `RecallExtract.ts` — plugin: exports the session on `session.idle` via
  `opencode export <id>`, writing a markdown drop that `RecallBatchExtract.ts` consumes
- `RecallPreCompact.ts` — plugin: pushes Recall context into compaction output
- `lib/session-export.ts` — pure helpers shared by the plugins and the tests
- `recall-memory.md` — agent definition

Installed as per-file symlinks into `$OPENCODE_CONFIG_DIR/plugins/` (and
`plugins/lib/`) from `~/.agents/Recall/opencode/plugins/` by
`recall_install_opencode_plugins` in `lib/install-lib.sh`.

## Local Contracts

- **A plugin entry point exports exactly one thing: its factory.** OpenCode
  globs top-level `plugins/*.ts` and calls EVERY export of each match as a
  plugin factory. A stray helper export makes OpenCode log
  `failed to load plugin ... "Object is not a function"` on every launch.
  `tests/opencode-integration.test.ts` enforces this.
- **Shared helpers live in `lib/`.** OpenCode does not glob subdirectories, so a
  nested module is importable without being mistaken for a plugin. Anything
  added here must be named in `RECALL_OPENCODE_PLUGIN_HELPERS` (plugins go in
  `RECALL_OPENCODE_PLUGINS`) in `lib/install-lib.sh`, or the plugin's import
  breaks at runtime. Those two arrays are the single source of truth: install
  and uninstall both loop over them, so one edit covers both.
- **`session.idle` fires once per assistant turn**, not once per session
  (measured against OpenCode 1.18.5). The adapter must therefore RE-export on
  later idles; suppressing them freezes the drop on turn 1 and silently discards
  the rest of the conversation. Dedup is by content digest, never "session seen".
- The plugin shells out, so the `opencode` CLI must be resolvable by name on
  `PATH` in whatever environment OpenCode runs in.
- Plugins are self-contained like `hooks/` — never import from `src/`.

## Work Guidance

- Changing the runtime contract (event shape, export command, discovery path)
  means re-running `bun run test:e2e:opencode:runtime`, which verifies it against
  a live server, and updating the measured facts in
  `docs/OPENCODE_INTEGRATION.md`.
- The pinned OpenCode version lives once, in `scripts/lib/opencode-runtime.ts`.

## Verification

- `bun test tests/opencode-integration.test.ts` — unit + installer coverage
- `bun run test:e2e:opencode` — pipeline (export → drop → extract → search)
- `bun run test:e2e:opencode:runtime` — live server (discovery, idle frequency,
  multi-turn completeness)

## Child DOX Index

No child docs — `lib/` shares these contracts.
