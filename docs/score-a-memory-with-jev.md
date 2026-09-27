← [Back to README](../README.md)

# Score one memory item with Jev

In this tutorial, we'll turn Jev on for structured extraction and prove it with one score. By the end, `recall jev` prints a keep, demote, or drop decision, and Claude Code is running in a shell that sourced the key.

> [!NOTE]
> This tutorial takes about 10 minutes. You need a TypeSafe API key and a terminal you can use to start Claude Code.

## What you'll build

A shell that can score one candidate, and a Claude Code process that sees the same `JEV_RECALL_KEY`.

- `recall jev` prints JSON with `choice`, `probabilities`, and `confidence`.
- The Stop hook can use that same variable on the next session.
- If the variable is missing, ingest still writes the parsed rows and skips Jev.

## Prerequisites

- Recall is installed and `recall` is on `PATH`.
- Claude Code is installed.
- You have a TypeSafe API key. Do not paste it into the Recall repo, a commit, or a chat.

## Step 1: Confirm the CLI

```bash
which recall
```

You should see a path, for example `~/.bun/bin/recall`.

If you see `command not found`, return to [Getting Started](getting-started.md) and finish the install before continuing.

## Step 2: See the skipped path

Run this with the key removed for this one command, even if your shell already sourced `~/.env`:

```bash
env -u JEV_RECALL_KEY recall jev "hi"
```

You should see:

```text
JEV_RECALL_KEY is not set
```

The command exits with status 1. No request was sent. This is the CLI check. Ingest is different: a missing key there still writes the parsed rows.

## Step 3: Put the key in ~/.env

This file stays outside the Recall repo. Recall never loads it. The shell does, and only after you source it.

Create the file only if it is missing, then restrict the mode. This does not erase an existing `$HOME/.env`.

```bash
touch "$HOME/.env" && chmod 600 "$HOME/.env"
```

Open `$HOME/.env` in your editor and add this one line. Keep the single quotes. Do not `echo` the key into the shell.

```bash
export JEV_RECALL_KEY='your-key-here'
```

Save the file. Confirm the mode:

```bash
stat -f '%Lp' "$HOME/.env"
```

You should see `600`. On Linux, `stat -c '%a' "$HOME/.env"` shows the same mode.

## Step 4: Source it in this terminal

```bash
source "$HOME/.env"
if [ -n "$JEV_RECALL_KEY" ]; then echo KEY_SET; else echo KEY_MISSING; fi
```

You should see:

```text
KEY_SET
```

You should not see the key. If you see `KEY_MISSING`, the export line is missing or this shell did not source `$HOME/.env`.

> [!WARNING]
> A key that only exists in `~/.env` is invisible to Recall, Claude, and the Stop hook until this process sources the file. Do not commit `~/.env`.

## Step 5: Score one item

```bash
recall jev "We decided ingest scoring stays a Jev Choice of keep, demote, or drop."
```

You should see one JSON object, similar to:

```json
{"choice":"keep","probabilities":{"keep":0.9,"demote":0.07,"drop":0.03},"confidence":0.8}
```

`choice` is `keep`, `demote`, or `drop`. The numbers will differ. The output must not contain your key.

If you still see `JEV_RECALL_KEY is not set`, repeat Step 4 in this same terminal.

## Step 6: Start Claude from this terminal

Quit any Claude Code window that was opened from the Dock or another terminal. Then start it from the shell where Step 4 succeeded:

```bash
claude
```

You should see the Claude Code prompt in this terminal.

The Stop hook is a child of that process. It inherits `JEV_RECALL_KEY` from here. A Claude app you launch from the Dock does not.

> [!WARNING]
> Closing this terminal drops the export. The next Stop hook then skips Jev and writes every parsed row. Open a shell, repeat Step 4, and start `claude` from there.

## What you've learned

In this tutorial, you:

- Proved the CLI refuses to score when `JEV_RECALL_KEY` is missing.
- Stored the key in `~/.env` outside the repo, mode `600`.
- Sourced that file into the process that runs `recall` and Claude Code.

OpenCode and Pi markdown drops reach this same scorer through batch extract. Conversation import does too. Native raw capture does not: omp `session_stop`, Codex `Stop`, and the Grok lifecycle hook call `recall host-hook` and write messages without Jev.

## Next steps

- [CLI Reference](cli-reference.md#jev-score) for `recall jev` flags.
- [Installation](installation.md#environment-variables) for the other environment variables.
- [Getting Started](getting-started.md) if `recall` was not on `PATH`.
