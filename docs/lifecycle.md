← [Back to README](../README.md)

# Managing Recall — which command do I run?

Recall has three lifecycle actions — **install**, **update**, **uninstall** — and each is reachable two ways: the `recall` CLI (after the first install) and the bundled bash scripts (`install.sh` / `update.sh` / `uninstall.sh`). This page is the single "which command when" reference. For the step-by-step mechanics it links to the [Installation](installation.md) and [Upgrading](upgrading.md) guides rather than repeating them.

> **Prerequisite:** Recall requires [Bun](https://bun.sh) (it uses `bun:sqlite` and Bun-native hooks). Install Bun before anything else.

---

## Quick decision table

| Situation | Command |
|---|---|
| Fresh install — npm (recommended) | `bun install -g recall-memory` then `recall install` |
| Fresh install — one-shot (Bun on PATH) | `npx --package=recall-memory recall install` |
| Fresh install — source / dev checkout | `./install.sh` |
| Re-install / repair a broken install | `recall install` (packaged) or `./install.sh` (source) — both idempotent |
| Upgrade to the latest release — source checkout | `recall update` (or `./update.sh`) |
| Upgrade a packaged (npm) install | `bun install -g recall-memory@latest` then `recall install` |
| Just check for a newer release | `recall update --check` — or `/Recall:update` in Claude Code |
| Uninstall, keep your memory database | `recall uninstall` (or `./uninstall.sh`) |
| Uninstall **and** destroy the database + backups | `recall uninstall --purge` |
| Install to / move the DB to a custom path | `./install.sh --db-path <path>` (new) · `recall migrate --to <path>` (existing) |
| Repair drifted symlinks without reinstalling | `recall doctor --fix` |
| See where everything resolves on disk | `recall path` |
| Roll back a failed install or update | `./install.sh restore` — see [Recovery](#recovery) |

The `recall update` / `recall uninstall` / `recall install` subcommands simply forward to the corresponding bash script, so the flags and behavior are identical — use whichever entry point you have on hand.

---

## Fresh install

Recall installs to a canonical root at `~/.agents/Recall/` and symlinks into each detected agent's home (Claude Code, OpenCode, Pi). Pick the on-ramp that matches how you got Recall:

- **npm (recommended):** `bun install -g recall-memory` puts the `recall` / `recall-mcp` binaries on your PATH, then `recall install` runs the canonical setup — MCP registration, hooks, slash commands, guides — for every detected agent. Prefer `bun install -g` over `npm install -g`: the `#!/usr/bin/env bun` shebang needs Bun on PATH, and nvm/fnm shells can hide it.
- **npx (one-shot):** `npx --package=recall-memory recall install` — same canonical setup, no global install. Bun must still be on PATH.
- **Source / dev checkout:** `git clone … && cd Recall && ./install.sh`. This one **builds from your working tree** (`bun install` + `bun run build` + `bun link`), so it's the right choice when you're developing Recall or running a branch. See the [Installation guide](installation.md) for prerequisites and the full step list.

After any install, **restart your agent** so it loads the MCP server and hooks.

### `install.sh` vs. `recall install`

Both run the same canonical steps and are **idempotent** — re-running repairs symlinks and registrations, so there is no separate "re-install" command. They differ only in the bootstrap:

- **`./install.sh`** (source checkout) builds from the working tree. Use it when developing, on a feature branch, or repairing a source install.
- **`recall install`** (packaged) skips `bun install` / `bun run build` / `bun link` (`RECALL_PACKAGED=1`) because the npm package already shipped a prebuilt binary and its dependencies. Use it for npm / `npx` / `bun install -g` installs.

---

## Update

> **Exit Claude Code / OpenCode / Pi first.** Updating reloads hooks and the `recall-mcp` server; a running session can hold stale state. `update.sh` warns you before it proceeds.

**Source / git checkout — `recall update`** (delegates to `./update.sh`). It version-checks against the latest GitHub release, backs up your config + DB, `git fetch` + `git pull --ff-only origin main`, rebuilds, runs `recall init` (applies pending SQLite migrations), refreshes the runtime files, force-re-registers the hooks, and verifies. The full step list, the flag table, and the rollback recipe live in the [Upgrading guide](upgrading.md).

Common flags (forwarded verbatim to `update.sh`): `--check`, `--dry-run`, `--force`, `--no-migrate`, `--no-confirm`. Check-only, without changing anything: `recall update --check`, or `/Recall:update` from inside Claude Code (see [Slash Commands](slash-commands.md)).

Two situations the original scripts didn't spell out:

- **You're on a feature branch or have local commits.** `recall update` does `git pull --ff-only origin main` plus a GitHub-release version check, so it will refuse to fast-forward (or report "already current") rather than clobber your work. That's expected. To rebuild from your **working tree** instead, run `./install.sh`.
- **You installed from npm.** A packaged install has no git checkout, so `recall update` has nothing to pull. Bump the binary with `bun install -g recall-memory@latest`, then run `recall install` to refresh the canonical setup.

---

## Uninstall

**`recall uninstall`** (delegates to `./uninstall.sh`) removes Recall's integration surgically and **preserves your memory database by default**. Exit your agent first.

Flags (forwarded verbatim): `--dry-run` (narrate, touch nothing), `--purge` (also destroy `~/.agents/Recall/` — DB + backups — after a `pre_purge_<TS>/` snapshot and an interactive `PURGE` confirmation), `--no-confirm`, `--skip-opencode`, `--skip-pi`. The exact list of what is removed vs. preserved is in [Installation → Uninstalling](installation.md#uninstalling).

---

## Custom database location

- **At install time:** `./install.sh --db-path /path/to/recall.db`, or set `RECALL_DB_PATH` (see [Installation → Environment Variables](installation.md#environment-variables)).
- **Relocate an existing DB:** `recall migrate --to /new/path/recall.db` moves the database **and** rewrites the MCP config to point at it. Add `--dry-run` to preview. Details in the [CLI Reference → Admin](cli-reference.md#admin).
- **Check the current location:** `recall path` prints the resolved DB path, install root, and per-platform symlink state.

---

## Recovery

- **Restore a backup** (install/update write timestamped backups under `~/.claude/backups/recall/`): `./install.sh list`, then `./install.sh restore [TIMESTAMP]`.
- **A failed update** writes `ROLLBACK.txt` into its backup directory with the exact revert commands. See [Upgrading → Rollback](upgrading.md#rollback). Note: **DB schema downgrades are not supported** — if a migration ran, restore the DB file from the backup rather than just reverting the repo.
- **A `--purge` uninstall** writes a `pre_purge_<TS>/` database snapshot before deleting, so a mistaken purge is recoverable.
- **Drifted symlinks** (e.g. after moving the checkout): `recall doctor` reports them and `recall doctor --fix` re-creates them, backing up any user-modified file at a symlink target first.

---

*See also: [Installation](installation.md) · [Upgrading](upgrading.md) · [CLI Reference](cli-reference.md) · [Troubleshooting](troubleshooting.md)*
