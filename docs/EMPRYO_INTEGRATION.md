# Empryo Integration

[Back to README](../README.md)

[Empryo](https://empryo.com) runs the hooks in Claude Code's settings, so Recall's automatic capture reaches it through the Claude install. Skills and MCP need the steps below. There is no separate Empryo installer step.

| Surface | How Empryo gets it | Status |
| --- | --- | --- |
| Lifecycle hooks | Empryo runs hooks from `~/.claude/settings.json` ([Empryo hooks](https://empryo.com/docs/tools/hooks#where-hooks-are-read-from)) | Automatic capture shipped |
| `do-recall-*` skills | Empryo scans `~/.claude/skills/` and `~/.agents/skills/` ([Empryo skills](https://empryo.com/docs/tools/skills#scopes)), not Claude plugin folders | Discovered only when the installer links them into `~/.claude/skills/`. With the Claude plugin active, the installer removes those links, so Empryo does not see the skills |
| `recall-memory` MCP | Add it to `mcpServers` in `~/.empryo/config.json` (below) | Manual |
| SessionStart L0/L1 injection | `RecallStart.ts` runs, but Empryo documents `additionalContext` only for tool events | Not verified |

## Install

1. Install Recall for Claude Code: [Installation](installation.md#install-recall). This registers the `Stop` hook Empryo runs. Without the Claude plugin, it also links the skills into `~/.claude/skills/`, where Empryo finds them.
2. Register the MCP server. Empryo's `mcpServers` is an array:

   ```json
   {
     "mcpServers": [
       {
         "name": "recall-memory",
         "command": "bun",
         "args": ["run", "/Users/you/.bun/bin/recall-mcp"],
         "env": { "RECALL_DB_PATH": "/Users/you/.agents/Recall/recall.db" }
       }
     ]
   }
   ```

   Use your own paths. Run `/mcp` in Empryo to confirm the server connects.

## How capture works

Empryo passes its own session log to the Claude hooks as `transcript_path` (`<project>/.empryo/sessions/<id>/session.jsonl`). That log is not Claude JSONL. `RecallExtract.ts` recognizes the path and hands it to `hooks/lib/hosts/empryo/ambient-capture.ts`, which calls [`recall capture`](CAPTURE_ADAPTER.md) with harness `empryo`.

| Hook event | Captured |
| --- | --- |
| `Stop` | For each tab that finished a turn within 10 minutes of the newest one, that tab's latest completed turn: the visible prompt and the final answer. A turn resent by a later `Stop` is stored once |
| `SessionEnd` | Not registered by the installer. If you add `RecallExtract.ts` under `SessionEnd` yourself: every completed turn, once. When the JSON sent to `recall capture` would pass its 25 MiB cap, the newest turns that fit |
| `PreCompact` | Nothing. The Claude flush is skipped |
| `PostToolUse`, `UserPromptSubmit` | In-session extraction skips the Empryo log. Correction capture still reads the prompt text |

What is left out:

- Tool calls and tool output.
- Prompts Empryo marks hidden, such as agent-to-agent link messages, and the replies to them.
- A turn that has not finished.
- Any log whose `meta` line is not format version 1. A new Empryo log format captures nothing until the adapter learns it.

Rows are tagged `automatic-capture,empryo`. The Claude Stop hook never falls back to a Claude transcript for an Empryo session, so an Empryo turn cannot trigger extraction of an unrelated Claude session in the same directory.

Several tabs can finish close together, and each `Stop` hook may read the log after all of them landed. Sending every recent tab's latest turn covers that case. A tab with two turns between `Stop` hooks, or one idle more than 10 minutes behind the newest turn, still loses the older turn.

## Prove it

1. In an Empryo session, send a prompt with a unique word made of letters and digits, for example `empryoproof42`, and let the turn finish.
2. Run `recall search "empryoproof42" -t messages`.

The turn should appear. If it does not, confirm `recall` is on Empryo's hook `PATH` and that `~/.claude/settings.json` still lists `RecallExtract.ts` under `Stop`.
