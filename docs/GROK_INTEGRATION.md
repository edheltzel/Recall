# Grok Integration

[Back to README](../README.md)

Grok has **no working plugin or extension install path**. Live headless sessions do not compose plugin hooks, so the installer-owned global hook is the only supported attach. Do not look for `grok plugin install`.

Recall supports Grok Build CLI through three separate surfaces:

- MCP provides the nine query and write tools when `recall-memory` is configured in Grok.
- The canonical `do-recall-*` Agent Skills provide the shared workflows.
- An installer-owned global lifecycle hook captures Grok transcripts automatically.

Automatic capture does not imply automatic memory injection. Grok capture is supported, but session-start injection is not.

## Install lifecycle capture

Install Recall normally while `grok` is on `PATH`:

```bash
./install.sh
```

The installer copies the canonical hook to:

```text
~/.agents/Recall/grok/hooks/RecallLifecycle.json
```

It then creates a managed per-file symlink at:

```text
~/.grok/hooks/RecallLifecycle.json
```

Set `GROK_HOME` to move the Grok configuration root. Deselect Grok in the interactive installer when it should remain untouched.

The global hook is intentional. Grok 1.0.4 discovers plugin hook metadata, but live headless sessions do not compose those plugin hooks. The supported user-level global hook runs in both inspected and headless configurations.

## Automatic capture

The hook observes `Stop`, `PreCompact`, `PostCompact`, and `SessionEnd`.

For each event, Recall:

1. Uses the native session ID from the hook payload.
2. Runs the supported `grok export <session-id>` command.
3. Stores the export as an opaque Markdown frame so message content that resembles a role heading cannot change attribution.
4. Scrubs unattended content before storage, as required by [#50](https://github.com/edheltzel/Recall/issues/50).
5. Writes new verbatim rows immediately to `recall.db` with `source = 'grok'`.
6. Uses persistent message keys and a validated byte watermark to skip unchanged exports, ingest append-only suffixes, and fall back to a full frame after rewrites or shrinkage.
7. Finalizes the session and creates one extracted summary at terminal lifecycle events.

Capture does not depend on the optional `RecallBatchExtract` cron job.

Subagent payloads are skipped by default. Set `RECALL_INCLUDE_SUBAGENTS=1` to opt in.

## Automatic injection is not supported

Grok's passive `SessionStart` hook output is ignored. Recall therefore does not register a Grok `SessionStart` hook and does not claim automatic L0/L1 injection.

Use MCP search and recall tools during a Grok session. A wrapper that passes generated rules or a model instruction that asks Grok to call MCP would be opt-in behavior, not automatic injection.

## Ownership and cleanup

`update.sh` refreshes the managed hook when Grok is detected. `uninstall.sh` removes only the symlink owned by Recall. A foreign file at the same path is preserved, and an install-time collision is backed up first. This follows the surgical ownership requirement tracked in [#236](https://github.com/edheltzel/Recall/issues/236) without adding TOML mutation to the atomic-write debt in [#124](https://github.com/edheltzel/Recall/issues/124).

Use `./uninstall.sh --skip-grok` to leave the lifecycle hook installed.

## Development verification

```bash
bun run test:e2e:grok-lifecycle
```

The test uses the current Grok CLI, an isolated `GROK_HOME`, a mock model endpoint, and a disposable `RECALL_DB_PATH`. It verifies real hook composition, automatic rows, deduplication, managed cleanup, and that the production database was not changed.
