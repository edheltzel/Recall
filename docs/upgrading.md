# Upgrading

[← Back to README](../README.md)

## Update Recall

```bash
cd /path/to/Recall
git pull
./install.sh
```

The installer handles everything: dependencies, build, linking, database migrations, hook updates, and guide updates. Your database and memory files are preserved across updates.

If you prefer a manual update:

```bash
git pull
bun install
bun run build
bun link
```

To also update the hooks manually:

```bash
cp hooks/SessionExtract.ts ~/.claude/hooks/
cp hooks/BatchExtract.ts ~/.claude/hooks/
```

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
