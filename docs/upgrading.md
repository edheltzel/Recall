# Upgrading

[← Back to README](../README.md)

## Check for a new release

From inside Claude Code:

```
/recall:update
```

This is a **check-only** command — it prints the current vs. latest
version and the exact command to run. It never rebuilds mid-session
(that would corrupt hooks tied to the running `mem` binary).

From a shell:

```bash
cd /path/to/Recall
./update.sh --check
```

## Using `update.sh` (recommended)

Exit Claude Code first, then:

```bash
cd /path/to/Recall
./update.sh
```

`update.sh` performs the full lifecycle:

1. Fetches the latest release tag from GitHub and compares to
   `package.json`. Exits 0 if already current (unless `--force`).
2. Creates a timestamped backup of `settings.json`, `memory.db`,
   `CLAUDE.md`, OpenCode/Pi configs, and `.mcp.json` at
   `~/.claude/backups/recall/<TIMESTAMP>/`. Records the git `PRE_SHA`
   in the manifest.
3. `git fetch --tags && git pull --ff-only origin main` (aborts on a
   dirty tree; resolve manually and re-run).
4. `bun install && bun run build`.
5. `mem init` applies any pending SQLite migrations
   (`PRAGMA user_version`-driven, non-destructive).
6. Copies refreshed hooks, shared lib files, slash commands, and
   `FOR_CLAUDE.md`. `extract_prompt.md` gets a drift check — if you
   edited it, the new version lands at `extract_prompt.md.new` and
   your edits are preserved.
7. Forces re-registration of all four hooks (SessionExtract,
   TelosSync, SessionRecall, SessionPreCompact) — this permanently
   prevents the pre-0.7.1 bug class where a partial install could
   leave hooks missing.
8. Verifies via `mem --version` and `mem stats`.

### Update flags

| Flag | Purpose |
|------|---------|
| `--check` | Version check only; print recipe and exit |
| `--dry-run` | Narrate every step with `[dry-run]` markers, touch nothing |
| `--force` | Run even if already at latest (repair path) |
| `--no-migrate` | Skip `mem init` migration step |
| `--no-confirm` | Non-interactive |
| `--help` | Show usage |

### Rollback

If `update.sh` fails at any step, it writes a rollback recipe to
`~/.claude/backups/recall/<TIMESTAMP>/ROLLBACK.txt` with the exact
commands to revert:

```
git reset --hard <PRE_SHA>
bun install && bun run build
./install.sh restore <TIMESTAMP>
```

**DB schema downgrades are not supported.** If a migration applied to
your DB, reverting the repo alone does not revert the DB. Delete
`~/.claude/memory.db` and restore it from the backup dir if you need
to fully roll back.

## Manual update

If you prefer to run each step yourself (or `update.sh` is not
available on older installs):

```bash
cd /path/to/Recall
git pull
bun install
bun run build
bun link
mem init
```

Then re-run `./install.sh` to refresh hooks and slash commands — it's
idempotent.

## v0.7.0 Migration Notes

### Schema changes (migration 7 → 8)

Adds an `importance INTEGER` (1-10) column to `messages`, `decisions`,
`learnings`, and `loa_entries`. Non-destructive — existing rows receive
the default value (5 for most tables, 8 for LoA with a floor of 5). Runs
automatically on `mem init` or `./install.sh`.

### Recommended: run `mem onboard` post-upgrade

v0.7.0 introduces a tiered session-start context (L0 identity + L1
importance-ranked). The L0 tier reads from `~/.claude/MEMORY/identity.md`
— if you don't have one, that tier is empty and you're only getting half
the v2 design.

```bash
mem onboard               # Interactive 7-question interview
mem benchmark run B       # Confirm v2_l0_chars > 0 after onboarding
```

### New hooks

v0.7.0 adds two hooks copied into `~/.claude/hooks/` by the installer:

| Hook | Type | Purpose |
|------|------|---------|
| `SessionRecall.ts` | SessionStart | Injects L0 + L1 tiers at session start |
| `SessionPreCompact.ts` | PreCompact | Flushes in-flight messages before compaction |

If you update hooks manually, copy these alongside `SessionExtract.ts` and
`BatchExtract.ts`:

```bash
cp hooks/SessionRecall.ts ~/.claude/hooks/
cp hooks/SessionPreCompact.ts ~/.claude/hooks/
```

### New commands

| Command | Purpose |
|---------|---------|
| `mem onboard` | Interactive L0 identity interview |
| `mem importance backfill` | Backfill importance scores from confidence |
| `mem pin <table> <id>` / `mem unpin <table> <id>` | Manual importance control |
| `mem benchmark run/list/report` | Phase 2 benchmark harness |

### New environment variable

`RECALL_IDENTITY_PATH` overrides the L0 identity file path. Honored by
both `SessionRecall` (read) and `mem onboard` (write).

### MCP: `memory_add` accepts `importance`

Optional integer 1-10 parameter. Defaults to 5 (or 8 for LoA, with floor 5).

---

## v0.6.0 Migration Notes

### Schema changes (migration 5 → 6)

Migration 5→6 adds a `confidence` column (high/medium/low, DEFAULT 'medium') to both the `decisions` and `learnings` tables. This migration is non-destructive — existing rows receive the default value and no data is removed.

### New hooks/lib/ directory

v0.6.0 introduces a `hooks/lib/` directory containing shared utilities imported by `SessionExtract.ts` and `BatchExtract.ts`. If you update the hooks manually rather than via `./install.sh`, you must copy this directory:

```bash
cp -r hooks/lib/ ~/.claude/hooks/lib/
```

Without `hooks/lib/`, the hook scripts will fail to resolve imports at runtime.

### New commands

| Command | Purpose |
|---------|---------|
| `mem decision list` | List decisions with status and confidence |
| `mem decision update <id>` | Update a decision's status (supersede/revert) |
| `mem prune` | Preview and remove stale records (dry-run by default; use `--execute` to commit) |

### New MCP tool

`decision_update` — update the status and/or confidence of a stored decision. Accepts `id`, `status` (active/superseded/reverted), and optional `confidence` (high/medium/low).

---

## Database Migrations

Recall uses SQLite's `PRAGMA user_version` for schema version tracking. When you run `mem init` or `./install.sh`, the migration system:

1. Reads the current `PRAGMA user_version` from your database
2. Compares it against the expected version in the codebase
3. Applies any pending migrations sequentially
4. Updates `PRAGMA user_version` to the new version

Migrations are non-destructive — they add tables and indexes, never drop existing data.

```mermaid
graph TD
    A[git pull] --> B[./install.sh]
    B --> C[bun install]
    C --> D[bun run build]
    D --> E[bun link]
    E --> F[mem init]
    F --> G{PRAGMA user_version}
    G -->|Current < Expected| H[Apply Migrations]
    G -->|Current = Expected| I[No Changes Needed]
    H --> J[Update user_version]
    J --> K[Done]
    I --> K

    style A fill:#3B82F6,color:#fff
    style H fill:#F59E0B,color:#fff
    style K fill:#10B981,color:#fff
```

## Backup and Restore

### Automatic Backups

The installer automatically backs up existing files before making any changes. Backups are stored at `~/.claude/backups/recall/`.

### Managing Backups

```bash
./install.sh list              # List available backups
./install.sh restore           # Restore most recent backup
./install.sh restore 20260219  # Restore specific backup
```

### Manual Backup

```bash
cp ~/.claude/memory.db ~/.claude/memory.db.backup
```

### What Gets Backed Up

| File | Description |
|------|-------------|
| `memory.db` | The SQLite database |
| `settings.json` | Claude Code configuration (MCP + hooks) |
| `CLAUDE.md` | Global Claude instructions |
| `~/.claude/MEMORY/` | Memory files |
