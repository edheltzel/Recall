← [Back to README](../README.md)

# Managing Recall — which command do I run?

Recall has three lifecycle actions — **install**, **update**, **uninstall** — and each is reachable two ways: the `recall` CLI (after the first install) and the bundled bash scripts (`install.sh` / `update.sh` / `uninstall.sh`). This page is the single "which command when" reference. For the step-by-step mechanics it links to the [Installation](installation.md) and [Upgrading](upgrading.md) guides rather than repeating them.

> **Prerequisite:** Recall requires [Bun](https://bun.sh) (it uses `bun:sqlite` and Bun-native hooks). Install Bun before anything else.

---

## Quick decision table

| Situation | Command |
|---|---|
| Fresh install - Claude plugin + hooks | Follow [Installation → Source checkout](installation.md#source-checkout); see [Claude Integration](CLAUDE_INTEGRATION.md) |
| Fresh install - Codex plugin | Complete the [source checkout](installation.md#source-checkout), then install the [Codex plugin](CODEX_INTEGRATION.md) |
| Fresh install — Pi native package | Source checkout, then `pi install /absolute/path/to/Recall`; MCP still needs the adapter ([Pi Integration](PI_INTEGRATION.md)) |
| Fresh install — omp native capture | Build and link the clean packed checkout ([omp Integration](OMP_INTEGRATION.md)); skills remain installer-owned |
| Fresh install — Grok (no plugin path) | Complete the [source checkout](installation.md#source-checkout) ([Grok Integration](GROK_INTEGRATION.md)) |
| Fresh install — Cursor snippets | Merge `templates/cursor/`; no marketplace plugin |
| Fresh install — local tarball (Grok / Claude hooks / detected hosts) | Follow [Installation → Local tarball](installation.md#local-tarball) |
| Fresh install — source / dev checkout | Follow [Installation → Source checkout](installation.md#source-checkout) |
| Re-install / repair a broken install | `recall install` (tarball) or `./packaging/install.sh` (source) — both idempotent |
| Upgrade to the latest release — source checkout | `recall update` (or `./packaging/update.sh`) |
| Upgrade a local-tarball install | Follow [Installation → Local tarball](installation.md#local-tarball) |
| Just check for a newer release | `recall update --check` — or `/do-recall-update` in Claude Code |
| Uninstall, keep your memory database | `recall uninstall` (or `./packaging/uninstall.sh`) |
| Uninstall **and** destroy the database + backups | `recall uninstall --purge` |
| Install to / move the DB to a custom path | `./packaging/install.sh --db-path <path>` (new) · `recall migrate --to <path>` (existing) |
| Repair install or Claude MCP configuration drift without reinstalling | `recall doctor --fix` |
| See where everything resolves on disk | `recall path` |
| Roll back a failed install or update | `./packaging/install.sh restore` — see [Recovery](#recovery) |

The `recall update` / `recall uninstall` / `recall install` subcommands simply forward to the corresponding bash script, so the flags and behavior are identical — use whichever entry point you have on hand.

---

## Fresh install

Recall installs runtime state under `~/.agents/Recall/`. **Preferred attach** for Claude Code, Codex, Pi, and omp is the native plugin/extension; see the [Quick Start](../README.md#quick-start). The installer script is for Grok, Claude hooks, and detected hosts that still need installer-owned files.

Pick the on-ramp that matches how you got Recall:

- **Source checkout (canonical):** Follow [Installation → Source checkout](installation.md#source-checkout). Recall is not on the npm registry (#312).
- **Local tarball:** Follow [Installation → Local tarball](installation.md#local-tarball).
- **Then attach the harness** with its plugin/extension command (Claude, Codex, Pi, omp). Claude Code must attach the plugin before installer-owned setup, then run `recall install`, because lifecycle hooks remain installer-owned. The Codex plugin already owns its lifecycle hooks. omp skills remain installer-owned. Grok has no plugin path; the source checkout installer is enough.
- **Source / dev checkout detail:** Follow the [canonical source-checkout sequence](installation.md#source-checkout). It orders any required native host attach before installer-owned setup and builds from your working tree.

After any attach, **restart your agent** so it loads the plugin, extension, or snippets.

### `install.sh` vs. `recall install`

Both run the same canonical steps and are **idempotent** — re-running repairs symlinks and registrations, so there is no separate "re-install" command. They differ only in the bootstrap:

- **`./packaging/install.sh`** (source checkout) builds from the working tree. Use it when developing, on a feature branch, or repairing a source install.
- **`recall install`** (local tarball) skips `bun install` / `bun run build` / `bun link` (`RECALL_PACKAGED=1`) because the packed tarball already shipped a prebuilt binary and its dependencies. Use it after completing the [local-tarball procedure](installation.md#local-tarball).

---

## Update

> **Exit Claude Code / OpenCode / Pi first.** Updating reloads hooks and the `recall-mcp` server; a running session can hold stale state. `update.sh` warns you before it proceeds.

**Source / git checkout — `recall update`** (delegates to `./packaging/update.sh`). It version-checks against the latest GitHub release, backs up your config + DB, `git fetch` + `git pull --ff-only origin main`, rebuilds, runs `recall init` (applies pending SQLite migrations), refreshes the runtime files, force-re-registers the hooks, and verifies. The full step list, the flag table, and the rollback recipe live in the [Upgrading guide](upgrading.md).

If the installed release predates Claude MCP reconciliation, run `recall install` once after the first `recall update`. The already-running old updater cannot use lifecycle functions pulled during that same run; later updates reload changed lifecycle files automatically. See [First update from an older updater](upgrading.md#first-update-from-an-older-updater).

Common flags (forwarded verbatim to `update.sh`): `--check`, `--dry-run`, `--force`, `--no-migrate`, `--no-confirm`. Check-only, without changing anything: `recall update --check`, or `/do-recall-update` from inside Claude Code (see [Agent Skills](agent-skills.md)).

Two situations the original scripts didn't spell out:

- **You're on a feature branch or have local commits.** `recall update` does `git pull --ff-only origin main` plus a GitHub-release version check, so it will refuse to fast-forward (or report "already current") rather than clobber your work. That's expected. To rebuild from your **working tree** instead, run `./packaging/install.sh`.
- **You installed from a local tarball.** A packed install has no git checkout, so `recall update` has nothing to pull. Follow the [local-tarball update procedure](installation.md#local-tarball), which refreshes the retained checkout before packing.

---

## Uninstall

**`recall uninstall`** (delegates to `./packaging/uninstall.sh`) removes Recall's integration surgically and **preserves your memory database by default**. Exit your agent first.

Run `recall uninstall --help` for the canonical forwarded flag list. The exact removal, preservation, purge, and per-host skip behavior is documented in [Installation → Uninstalling](installation.md#uninstalling).

---

## Custom database location

- **At install time:** `./packaging/install.sh --db-path /path/to/recall.db`, or set `RECALL_DB_PATH` (see [Installation → Environment Variables](installation.md#environment-variables)).
- **Relocate an existing DB:** `recall migrate --to /new/path/recall.db` moves the database **and** rewrites the MCP config to point at it. Add `--dry-run` to preview. Details in the [CLI Reference → Admin](cli-reference.md#admin).
- **Check the current location:** `recall path` prints the resolved DB path, install root, and per-platform symlink state.

---

## Recovery

- **Restore a backup** (install/update write timestamped backups under `~/.agents/Recall/backups/`): `./packaging/install.sh list`, then `./packaging/install.sh restore [TIMESTAMP]`.
- **A failed update** writes `ROLLBACK.txt` into its backup directory with the exact revert commands. See [Upgrading → Rollback](upgrading.md#rollback). Note: **DB schema downgrades are not supported** — if a migration ran, restore the DB file from the backup rather than just reverting the repo.
- **A `--purge` uninstall** writes a `pre_purge_<TS>/` snapshot containing the database and canonical user-authored MEMORY files before deleting runtime state; identity and distilled memory are also materialized into the Claude MEMORY directory when safe.
- **Install or Claude MCP configuration drift**: `recall doctor` reports drifted symlinks and stale Recall database paths. `recall doctor --fix` repairs them, backing up any user-modified file at a symlink target first.

---

*See also: [Getting Started](getting-started.md) · [Installation](installation.md) · [Upgrading](upgrading.md) · [CLI Reference](cli-reference.md) · [Troubleshooting](troubleshooting.md)*
