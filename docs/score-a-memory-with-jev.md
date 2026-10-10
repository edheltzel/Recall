← [Back to README](../README.md)

# Score one memory item with Jev

In this tutorial, we'll turn Jev on for structured extraction and prove it with one score. By the end, `recall jev` prints a keep, demote, or drop decision, and the key is in `~/.env` so hooks can read it without a sourced export.

> [!NOTE]
> This tutorial takes about 10 minutes. You need a TypeSafe API key and a terminal you can use to start Claude Code.

## What you'll build

A `JEV_RECALL_KEY` in `~/.env`, and one score from `recall jev`.

- `recall jev` prints JSON with `choice`, `probabilities`, and `confidence`.
- The Stop hook reads that same file when its environment has no key.
- If the key is missing from both the environment and `~/.env`, ingest still writes the parsed rows and skips Jev.

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

## Step 2: See the missing-key prompt

This prompt appears when `JEV_RECALL_KEY` is missing or blank in the environment and `$HOME/.env` has no key. If you already stored the key, skip to Step 4.

```bash
env -u JEV_RECALL_KEY recall jev "hi"
```

You should see:

```text
JEV_RECALL_KEY is not set.
Get a TypeSafe API key: https://console.typesafe.ai/keys
Set it in the environment or in ~/.env. A non-blank environment value wins.
```

It then asks you to paste a key for this run. The paste is not saved or printed. A blank line cancels and exits 1. No request is sent until a key is entered.

A non-interactive run cannot prompt. This still exits 1 and sends no request:

```bash
env -u JEV_RECALL_KEY recall jev "hi" </dev/null
```

Ingest is different: a missing key in both places still writes the parsed rows and does not prompt.

## Step 3: Put the key in ~/.env

This file stays outside the Recall repo. When the environment value is missing or blank, Recall reads `JEV_RECALL_KEY` from `$HOME/.env`. A non-blank environment value wins.

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

## Step 4: Score one item without exporting

Recall reads `$HOME/.env` when this process has no `JEV_RECALL_KEY`. You do not need to source the file.

```bash
env -u JEV_RECALL_KEY recall jev "We decided ingest scoring stays a Jev Choice of keep, demote, or drop."
```

You should see one JSON object, similar to:

```json
{"choice":"keep","probabilities":{"keep":0.9,"demote":0.07,"drop":0.03},"confidence":0.8}
```

`choice` is `keep`, `demote`, or `drop`. The numbers will differ. The output must not contain your key.

If you still see `JEV_RECALL_KEY is not set`, the line in `$HOME/.env` is missing, commented out, or blank.

A non-blank `JEV_RECALL_KEY` in the environment wins over the file. Do not echo the key to check that.

## Step 5: Hooks read the same file

The Stop hook reads `$HOME/.env` when its environment has no `JEV_RECALL_KEY`. A Claude app launched from the Dock can score. You do not need to source the file or start Claude from a special terminal.

> [!WARNING]
> Do not commit `~/.env`.

## What you've learned

In this tutorial, you:

- Saw a terminal prompt for a missing key, including the TypeSafe key URL. A non-interactive run still refuses to score.
- Stored the key in `~/.env` outside the repo, mode `600`.
- Scored one item without exporting. A non-blank environment value wins over the file.

OpenCode markdown drops reach this same scorer through batch extract. Conversation import does too. Pi still drops markdown for that path, and also calls `recall capture` on shutdown. Ambient `recall capture` (omp `session_stop`, Codex `Stop`, Grok lifecycle, Claude Stop, Pi shutdown) writes the raw text without Jev. Guide: [Capture adapter](CAPTURE_ADAPTER.md).

## Next steps

- [CLI Reference](cli-reference.md#jev-score) for `recall jev` flags.
- [Installation](installation.md#environment-variables) for the other environment variables.
- [Getting Started](getting-started.md) if `recall` was not on `PATH`.
