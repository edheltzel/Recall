# Codex Integration

[Back to README](../README.md)

Recall is packaged for Codex with Codex's native plugin primitive.

The checked-in marketplace manifest is `.agents/plugins/marketplace.json`, and the plugin bundle is `plugins/recall/`.

The bundle registers `recall-memory` through `.mcp.json` and exposes nine generated Codex skill adapters.

## Install

Install Recall first so `recall-mcp` is on `PATH`:

```bash
bun install -g recall-memory
recall init
```

Then add this repository as a Codex marketplace and install its plugin:

```bash
codex plugin marketplace add /absolute/path/to/Recall
codex plugin add recall@recall-marketplace
```

The repository path is deliberate for the current checked-in marketplace.

A future remote marketplace can remove that local-clone prerequisite after its distribution and update policy are defined.

## What MCP covers

MCP is the primary cross-host seam.

The plugin exposes all nine Recall operations: `memory_search`, `memory_hybrid_search`, `memory_recall`, `context_for_agent`, `memory_add`, `memory_stats`, `loa_show`, `memory_dump`, and `decision_update`.

They query and write the same SQLite store as the CLI.

Set `RECALL_DB_PATH` in the MCP server environment when the store is not at the default path.

## What the plugin does not cover

This bundle has no verified transcript-aware Codex hook contract equivalent to Recall's Claude `Stop`, `SessionStart`, or `PreCompact` lifecycle contracts.

Therefore this plugin does not claim lifecycle auto-capture, automatic L0/L1 injection, or pre-compaction flushing.

Codex can call `memory_dump` only when it supplies the visible messages explicitly; Recall does not infer Codex's private transcript location or format.

The generated `recall-dump` adapter is marked explicit-only with `agents/openai.yaml`, because Codex does not interpret Claude's `disable-model-invocation` frontmatter.

## Current boundaries

The following remain intentionally unresolved instead of being guessed:

- Codex transcript format and whether a stable, supported transcript API exists.
- Trust and consent rules for any future automatic capture.
- The installed plugin-cache path as a durable runtime dependency.
- Ownership and repair policy for user-managed Codex MCP configuration, including custom database paths.
- Remote marketplace publication, update, and release ownership.

These unknowns do not block the nine MCP operations.

They do block any claim that Codex has lifecycle parity with Claude Code.

## Development verification

`bun run build:codex-plugin` regenerates the Codex skill adapters from the canonical `agent-skills/` sources.

`bun run test:e2e:codex-plugin` builds Recall, installs the plugin with the current local Codex CLI in an isolated `CODEX_HOME`, invokes every MCP tool against a disposable `RECALL_DB_PATH`, and verifies that the production database metadata did not change.
