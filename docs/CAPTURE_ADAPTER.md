← [Back to README](../README.md)

# Capture adapter

Ambient harness text enters Recall through one public CLI door: `recall capture`. Core ranks and stores. Adapters send raw text only. There is no Capture SDK and no core change per harness.

`recall add`, dump, search, and MCP stay as they are. Do not write the database yourself. Hidden `recall host-hook` is not this contract. Cursor catalog capture (`catalogCursorSessions`) does not use this door.

Full flag list: [CLI Reference](cli-reference.md#ambient-capture).

## Call

Contract `1` (omit `--contract` and it defaults to 1). Any other contract exits non-zero and writes nothing.

Flags:

```bash
recall capture \
  --contract 1 \
  --harness acme-agent \
  --event turn_end \
  --session-id "$SESSION_ID" \
  --cwd "$PWD" \
  --project myproject \
  --text "$TEXT"
```

`--text-file <path>` reads the body from a file. Do not pass both `--text` and `--text-file`. If you pass any of `--harness`, `--event`, `--session-id`, `--cwd`, `--project`, `--text`, or `--text-file` and omit both text flags, stdin is the raw text body (not JSON).

Identical JSON twin (no those flags; optional `--contract` overrides the JSON `contract` field):

```bash
recall capture <<'EOF'
{"contract":1,"harness":"acme-agent","event":"turn_end","text":"...","session_id":"...","cwd":"...","project":"..."}
EOF
```

JSON field `sessionId` is accepted as an alias of `session_id`.

| Field | Required | Notes |
| --- | --- | --- |
| `contract` | no | Integer `1`. Omitted means 1. |
| `harness` | yes | See ids below. |
| `event` | yes | `turn_end` or `session_end` only. |
| `text` | yes | Raw turn or session text. Empty or whitespace-only is rejected. Cap is 25 MiB. |
| `session_id` | no | Native session id, max 512 chars, no ASCII controls. Omitted: core assigns one. |
| `cwd` | no | Working directory string. |
| `project` | no | Project name. |

Invalid input exits non-zero and does not write a partial row. Success is silent on stdout. If scrub drops a secret, stderr prints `Recall redacted: ...` and the rest is still stored.

Both events use the same store path today. Send the event that matches the harness anyway; a later contract bump can branch on it.

## Events

- `turn_end`: the harness has a turn boundary. Send that turn's raw text.
- `session_end`: the process is exiting. Send once, with the session text you actually have.

Collect text in the adapter (hook payload, supplied transcript, or a public export). Do not scrape private history layouts Recall has not documented for that host.

## Harness ids

Pattern: `^[a-z][a-z0-9-]{0,63}$`.

Rejected: empty, uppercase, underscores, spaces, path-like values (`OMP`, `bad_id`, `../x`).

Built-in (first-party): `claude`, `codex`, `pi`, `grok`, `omp`, `jcode`.

Reserved (do not squat): `opencode`, `cursor`, `mcp`. OpenCode is the next first-party adapter after this v1 door; it still uses its markdown drop. Do not send `opencode` until that adapter ships.

Any other id that matches the pattern is accepted. No core pull request.

## No SDK

Call the `recall` binary from whatever language the harness already uses (shell, the host's hook runtime, a child process). Do not import `recall-memory/api` to capture. That library is for in-process start/drop/inject, not this door. Optional language helpers are out of v1.

## Minimal shell adapter

```sh
#!/bin/sh
# turn-end hook: raw text on stdin
set -eu
text=$(cat)
[ -n "$text" ] || exit 0
recall capture \
  --contract 1 \
  --harness acme-agent \
  --event turn_end \
  --session-id "${SESSION_ID:-}" \
  --cwd "$PWD" \
  --text "$text"
```

Point the harness hook at this script. Use `session_end` on process exit instead of `turn_end` when that is the only signal you have.

## Prove it

1. Capture a unique word (letters and digits only; FTS5 reads `-` as an operator):

   ```bash
   recall capture --contract 1 --harness acme-agent --event turn_end \
     --text "ambient fact: captureadapterproof"
   ```

2. Search:

   ```bash
   recall search "captureadapterproof" -t messages
   ```

The phrase should appear. Core tags the row `automatic-capture,<harness>` at importance 6 (below curated memory). If search is empty, confirm `recall` is the same install and `RECALL_DB_PATH` was not pointed at a different database.
