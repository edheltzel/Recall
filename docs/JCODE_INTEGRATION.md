# JCode Integration

[Back to README](../README.md)

Recall MCP connectivity and the canonical `do-recall-*` Agent Skills can be used from JCode. Automatic transcript capture and automatic session-start injection are not installed.

A first-party helper, `hosts/jcode/capture.ts`, calls `recall capture` only when the caller already has raw text. It does not read JCode session files, tail a transcript, or write `~/.jcode/config.toml`. Door: [Capture adapter](CAPTURE_ADAPTER.md).

## What was verified

Local check of the installed binary on 2026-10-07:

- `jcode` v0.91.0 (`439a243bb`), built 2026-10-06.
- `jcode session` exposes `rename` only. There is no history export.
- `jcode transcript` injects text into the TUI. It does not export a session.
- Hook text embedded in that binary matches the public hooks doc. `turn_end`, `session_start`, and `session_end` are scalar command strings, not arrays. A second definition is a TOML duplicate-key error. `JCODE_HOOK_TURN_END` and `JCODE_HOOK_SESSION_END` replace a config hook; they do not compose with another owner.
- `turn_end` sets `JCODE_HOOK_LAST_ASSISTANT_TEXT` to the first 4000 characters and caps `JCODE_HOOK_PAYLOAD` at 16 KB. The embedded contract has no message id or resume watermark.
- `session_end` sets `JCODE_HOOK_SOURCE=close` plus session id and cwd. It does not include the transcript.
- `@1jehuang/jcode-sdk` on npm is still 1.1.0. This check did not call `getHistory()`, because that call reads session history.

An earlier live probe (JCode 0.75.0, SDK 1.1.0) also failed to prove a safe unattended adapter:

- `getHistory()` returned the whole conversation again after a restart, including duplicated messages. No stable resume watermark or ordering key was available.
- A session event alone did not prove that ordered history was ready.
- `sendMessage(..., { noReply: true })` can persist context, but the probe did not prove it runs before the first model turn. Recall does not claim deterministic injection.

These checks do not prove a future adapter is impossible. They prove unattended capture is not safe yet.

## Adapter behavior

| Input | Result |
| --- | --- |
| Caller-supplied non-empty text and `turn_end` or `session_end` | Spawns `bun <package>/dist/index.js capture --contract 1 --harness jcode --event <event>` with the text on stdin. Optional `--session-id`, `--cwd`, and `--project` when the caller sets them |
| Hook env only (`JCODE_HOOK_*`) | Skip. Truncated assistant text is not captured |
| Host history with no watermark | Skip |
| A private session file path | Skip. The path is not opened |
| Empty text | Skip |

Skip lines go to stderr and do not include the text. The helper never opens Recall's SQLite file. Ranking and storage stay inside `recall capture`.

| Surface | Status |
| --- | --- |
| MCP query and write tools | Supported when configured in JCode |
| Canonical `do-recall-*` skills | Supported |
| Supplied-text capture helper | Shipped. Not installed as a hook |
| Automatic transcript capture | Not installed |
| Automatic L0/L1 injection | Not shipped |
| Private history-file integration | Intentionally rejected |

Manual `memory_add` and `memory_dump` remain available through MCP. Agent Skill bodies stay canonical under the cross-host ownership established by [#228](https://github.com/edheltzel/Recall/issues/228).

## Conditions for unattended capture

Wire an unattended JCode hook only after a current stable release proves all of the following:

1. Ordered history with a durable message identity or resume watermark on a public hook or export.
2. Additive hook composition, or a documented ownership-safe configuration API.
3. Session-end ordering that guarantees history is complete before capture.
4. Deterministic pre-turn context mutation before claiming automatic injection.
5. Surgical install and uninstall behavior consistent with [#124](https://github.com/edheltzel/Recall/issues/124) and [#236](https://github.com/edheltzel/Recall/issues/236).

Until then, Recall will not install a JCode hook or replace this helper with a private-file watcher.
