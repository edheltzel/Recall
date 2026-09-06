# JCode Integration

[Back to README](../README.md)

Recall MCP connectivity and the canonical `do-recall-*` Agent Skills can be used from JCode. Automatic transcript capture and automatic session-start injection are not currently supported.

This boundary is deliberate. Recall does not read JCode's private session files or overwrite its hook configuration when the stable public surfaces cannot yet guarantee safe composition and ordering.

## Live probe result

The adapter probe used JCode 0.75.0 and `@1jehuang/jcode-sdk` 1.1.0 before any integration code was considered.

The stable SDK and bridge expose useful primitives, including session discovery, `getHistory`, and `sendMessage(..., { noReply: true })`. The probe did not establish the contracts needed for a safe unattended adapter:

- `getHistory()` returned the entire conversation again after a restart, including duplicated messages. A stable resume watermark or ordering key was not available.
- JCode's scalar `[hooks] session_start` setting is not additive. Defining it twice produced a TOML duplicate-key error, so Recall could not compose with an existing owner safely.
- The probe observed empty lifecycle sessions, so a session event alone did not prove that ordered history was ready for capture.
- `noReply` can persist context, but the probe did not prove that it runs before the first model turn. Recall therefore does not claim deterministic injection.

These results do not prove that a future adapter is impossible. They prove that the current safe result is MCP and skills only.

## Current capability

| Surface | Status |
| --- | --- |
| MCP query and write tools | Supported when configured in JCode |
| Canonical `do-recall-*` skills | Supported |
| Automatic transcript capture | Not shipped |
| Automatic L0/L1 injection | Not shipped |
| Private history-file integration | Intentionally rejected |

Manual `memory_add` and `memory_dump` remain available through MCP. Agent Skill bodies stay canonical under the cross-host ownership established by [#228](https://github.com/edheltzel/Recall/issues/228).

## Conditions for a future adapter

A JCode lifecycle adapter should be added only after current stable releases prove all of the following:

1. Ordered history with a durable message identity or resume watermark.
2. Additive hook composition, or a documented ownership-safe configuration API.
3. Session-end ordering that guarantees history is complete before capture.
4. Deterministic pre-turn context mutation before claiming automatic injection.
5. Surgical install and uninstall behavior consistent with [#124](https://github.com/edheltzel/Recall/issues/124) and [#236](https://github.com/edheltzel/Recall/issues/236).

Until then, Recall will not replace the supported bridge with a brittle private-file integration.
