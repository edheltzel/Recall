# CLI Reference

← [Back to README](../README.md)

The `recall` command is the primary interface for Recall. All subcommands operate on the SQLite database at `~/.agents/Recall/recall.db`.

---

## Search

```bash
recall "query"                          # Hybrid search (keyword + semantic, default)
recall "query" -k                       # Keyword only (FTS5)
recall "query" -v                       # Vector only (semantic, requires Ollama)
recall search "query"                   # FTS5 search with options
recall search "query" -t decisions      # Hard-filter to decisions only
recall search "query" --bias-type decisions # Prefer decisions, still show other matching tables
recall search "query" -p myproject      # Filter by project
recall search "query" --show-provenance # Show provenance for every result
recall search "query" --include-duplicates # Include records marked by recall dedup
recall semantic "query"                 # Semantic search (explicit)
recall hybrid "query"                   # Hybrid search (explicit)
```

The default search mode is hybrid: it runs FTS5 keyword matching and vector similarity in parallel, then merges results by relevance score. Use `-k` when you want exact phrase or operator matching without semantic expansion. Use `-v` when you want conceptually related results even if the exact words differ.

For keyword search, `-t/--table` and `--bias-type` solve different problems:

- `-t decisions` is a **hard filter**: only decisions can appear.
- `--bias-type decisions` is a **soft boost**: matching decisions rank higher, but matching LoA entries, learnings, breadcrumbs, and messages can still appear.

Allowed values: `messages`, `loa`, `decisions`, `learnings`, `breadcrumbs`.

```bash
recall search "database choice" -t decisions          # only decisions
recall search "database choice" --bias-type decisions # decisions first, broader context preserved
recall "database choice" -k --bias-type decisions     # default command, keyword-only with soft bias
```

FTS5 supports boolean operators and prefix matching:

- `auth AND token` — both terms must appear
- `config OR setup` — either term
- `config NOT docker` — exclude a term
- `auth*` — prefix match (authz, authentication, etc.)
- `"vpn config"` — exact phrase

By default, search output stays quiet about [Record Provenance](#record-provenance) when a record carries a known value, and visibly flags records whose provenance is unknown (legacy rows that predate the provenance column). Pass `--show-provenance` to display the provenance of every result.

Records marked as duplicates by [`recall dedup`](#dedup) are hidden from every search path (keyword, semantic, hybrid) by default — the records and their lineage remain in the database. Pass `--include-duplicates` to show them.

---

## Capture

### Session Dump

```bash
recall dump "Session Title"             # Import session + capture LoA entry
```

Combines `recall import` and `recall loa write` in one step. Run this at the end of every session to persist the conversation and extract a Fabric summary into the Library of Alexandria. The title should describe what was accomplished in the session.

### Library of Alexandria (LoA)

```bash
recall loa write "Session Title"              # Capture messages since last LoA entry
recall loa write "VPN Config" -p infra        # Tag with project
recall loa write "VPN Part 2" -c 1            # Continue from previous entry (chain)
recall loa write "Auth System" -t "auth"      # Add tags
recall loa list                               # List recent entries
recall loa show 1                             # View full Fabric extract for entry #1
recall loa quote 1                            # View raw source messages for entry #1
```

LoA is the primary knowledge capture mechanism. Raw transcripts are high-noise; LoA entries contain Fabric-extracted insights, message lineage, continuation chains, and project context. Chaining (`-c <id>`) links a new entry to a prior one, forming a thread of related sessions.

### Decisions

```bash
recall add decision "Use TypeScript over Python" --why "Type safety, team preference" -p myproject
recall add decision "Use SQLite for storage" -w "Lightweight, zero-config" --confidence high
```

Records an architectural or strategic decision with rationale. Decisions carry a status field (`active`, `superseded`, `reverted`) so you can track when a decision is overturned and why.

### Decision Lifecycle

Manage decision status transitions.

```bash
# List all decisions (all statuses)
recall decision list
recall decision list --status active
recall decision list --status superseded
recall decision list --project my-project --limit 10

# Mark a decision as superseded (replaced by newer)
recall decision supersede 42

# Mark a decision as reverted (was wrong, rolled back)
recall decision revert 42
```

### Learnings

```bash
recall add learning "Port conflict on 4000" "Kill process or change port" --prevention "Use dynamic port allocation"
```

Captures a problem-solution pair. The first argument is the problem, the second is the solution. The optional `--prevention` flag records how to avoid the issue in the future.

### Breadcrumbs

```bash
recall add breadcrumb "User prefers dark mode in all UIs" -p myproject -i 8
```

Stores a freeform observation or preference. The `-i` flag sets importance on a scale of 1–10 (default: 5). Higher importance surfaces the breadcrumb earlier in search results.

---

## View

```bash
recall loa list                         # Recent LoA entries
recall loa show 1                       # Full Fabric extract for entry #1
recall loa quote 1                      # Raw source messages for entry #1
recall recent                           # Recent records across all tables
recall recent decisions                 # Recent decisions only
recall show decisions 5                 # Full record for decision #5
recall stats                            # Database statistics
recall doctor                           # Health check all subsystems
```

`recall recent` accepts any table name: `decisions`, `learnings`, `breadcrumbs`, `loa`, `sessions`, `docs`, `telos`.

`recall show` displays the full record for a single row. The first argument is the table name, the second is the row ID.

---

## Import

```bash
recall import --dry-run                 # Preview session imports without writing
recall import --yes -v                  # Import all sessions from ~/.claude/projects/
recall import-legacy --yes              # Import DISTILLED.md extracts as LoA entries
recall docs import --dry-run            # Preview document imports
recall docs import --yes                # Import standalone markdown documents
recall telos import --dry-run           # Preview TELOS imports
recall telos import --yes -u            # Import TELOS framework (update existing)
recall telos list -t goal               # List TELOS entries of type: goal
recall telos show G7                    # Show a specific TELOS entry by ID
```

`recall import` scans `~/.claude/projects/` for JSONL session files and imports any not yet recorded. Use `--dry-run` first to confirm scope. The `-v` flag enables verbose output.

`recall import-legacy` converts entries from `DISTILLED.md` files (the previous manual memory format) into LoA entries, preserving their content in the new structured format.

`recall docs` manages standalone reference documents (markdown files) that should be searchable alongside session memory.

`recall telos` manages TELOS framework entries (goals, principles, constraints). The `-u` flag updates existing entries rather than skipping them on reimport.

---

## Embeddings

```bash
recall embed stats                      # Check embedding service status and coverage
recall embed backfill -t loa            # Generate missing embeddings for LoA entries
recall embed backfill -t decisions      # Generate missing embeddings for decisions
```

Embeddings are generated via Ollama and stored in the database for vector similarity search. `recall embed stats` shows how many records have embeddings versus how many are eligible. Run `recall embed backfill` after importing a large batch of records to ensure full semantic search coverage.

Supported tables for backfill: `loa`, `decisions`, `learnings`, `breadcrumbs`, `sessions`, `docs`.

---

## Identity & Onboarding

```bash
recall onboard                          # Interactive L0 identity interview (writes identity.md)
recall onboard --print --yes            # Preview rendered markdown without writing
recall onboard --project                # Write project-local (./.atlas-recall/identity.md)
recall onboard --out /path/identity.md  # Write to an explicit path
```

`recall onboard` creates the L0 tier that `RecallStart` injects at the top of every
session. Precedence for the output path: `--out` > `RECALL_IDENTITY_PATH` env var >
`--project` > global default (`~/.claude/MEMORY/identity.md`). If a file already
exists, the command asks for confirmation and writes a `.bak` copy before
overwriting.

The renderer warns when output exceeds `MAX_L0_CHARS=1200` — `RecallStart`
silently truncates beyond that threshold.

## Importance

The `importance` column (1-10) on `messages`, `decisions`, `learnings`, and
`loa_entries` controls L1 tier ranking at session start.

```bash
# Backfill importance scores from confidence signals (dry-run by default)
recall importance backfill
recall importance backfill --execute
recall importance backfill --execute --table decisions
recall importance backfill --execute --force            # overwrite non-defaults too

# Pin / unpin individual records
recall pin decisions 42                 # Pin decision #42 to importance 10 (default)
recall pin learnings 7 8                # Pin learning #7 to importance 8
recall unpin decisions 42               # Reset to table default (5, or 8 for LoA)
```

LoA entries have a write-time floor of 5; `recall pin` will not drop them below that.

## Record Provenance

The `provenance` column on `messages`, `decisions`, `learnings`, `breadcrumbs`,
and `loa_entries` declares how each record was created: `verbatim` (exact source
text), `user_authored` (directly authored via a user or agent command),
`extracted` (generated from source material, possibly lossy), or `derived`
(mechanically produced from existing memory records). Provenance is **automatic
write-path metadata** — every write path stamps it; there is no flag or MCP
parameter to set it (see `docs/adr/0001-record-provenance-automatic-write-path-metadata.md`).

Legacy rows that predate the column have no declared provenance (`NULL`,
reported as `unknown`). The backfill classifies them conservatively — only
where the source table or a write-path marker gives deterministic evidence;
everything else stays unknown rather than being guessed:

```bash
recall provenance backfill                      # Dry-run report (default)
recall provenance backfill --execute            # Apply the classification
recall provenance backfill --execute -t loa_entries  # Limit to one table
```

Allowed `-t/--table` values: `messages`, `decisions`, `learnings`,
`breadcrumbs`, `loa_entries`, `all` (default).

## Benchmarks

Phase 2 benchmark harness for measuring context efficiency.

```bash
recall benchmark list                   # Show available suites + build status
recall benchmark run                    # Run all available suites
recall benchmark run B                  # Run a specific suite (A-E)
recall benchmark run B -p my-project    # Scope to a specific project
recall benchmark report                 # Show the latest report
```

Suite B (token efficiency) compares the v2 wake-up bundle against v1 and the
CLAUDE.md baseline. Results are written to `benchmarks/results/` as JSONL plus
a human-readable `.md` alongside. See `benchmarks/README.md` for methodology.

## Export & Backup

Portable and disaster-recovery exports of the memory database.

```bash
recall export                                   # JSON export to stdout (summary on stderr)
recall export --format markdown                 # Human-readable Markdown export
recall export --format sql --output dump.sql    # Textual SQL dump (schema + INSERTs)
recall export --format sqlite --output copy.db  # Full database backup (VACUUM INTO)
recall export --output exports/                 # Directory mode: artifact + manifest.json
recall export --backup                          # Timestamped SQL dump to ~/.agents/Recall/backups/
```

Formats:

- **json / markdown** — app-level export of the durable memory tables
  (`sessions`, `messages`, `decisions`, `learnings`, `breadcrumbs`,
  `loa_entries`, `dedup_lineage`). Every row of a provenance-bearing table carries an explicit
  `provenance` field; legacy `NULL` provenance is exported as the literal
  `unknown` — never omitted, never guessed (see Record Provenance above).
  Embeddings are excluded.
- **sql** — textual SQL dump (CREATE TABLE + INSERT statements) of the same
  durable tables. Restorable into an empty database; one-command restore is
  intentionally not provided.
- **sqlite** — binary database backup via `VACUUM INTO`: the full DB including
  embeddings and internal tables. Always requires `--output`.

Output contract:

- No `--output`: export data goes to stdout, the manifest summary to stderr —
  stdout stays clean for piping.
- `--output <file>`: writes a single export file and prints the manifest
  summary to stdout.
- `--output <dir>`: writes the export artifact plus `manifest.json` into the
  directory. Directory exports always write `manifest.json`. A path that does
  not exist yet is treated as a file — add a trailing slash (`exports/`) to
  request a new directory.

The manifest records the Recall version, timestamp, schema version
(`PRAGMA user_version`), format, included tables, row counts per table,
provenance counts per table (including `unknown`), and whether embeddings were
included.

`recall export --backup` writes a timestamped SQL dump to
`~/.agents/Recall/backups/` (creating the directory if needed), never
overwrites an existing file (a `-N` suffix is added on collision), and prints
the output path.

## Dedup

Detect and mark duplicate memory records without erasing evidence or lineage.

```bash
recall dedup                            # Dry-run report (default — writes nothing)
recall dedup --execute                  # Mark duplicates (non-destructive)
recall dedup --execute --delete         # Destructive opt-in: hard-delete duplicates
recall dedup -t breadcrumbs             # Scope to one table
recall dedup -p myproject               # Scope to one project
recall dedup --threshold 0.98           # Stricter semantic matching (default 0.95)
recall dedup --no-semantic              # Exact/normalized text pass only
```

Safety model:

- **Dry-run by default.** Mutations require `--execute`.
- **Non-destructive by default.** `--execute` writes lineage rows to the
  `dedup_lineage` table (survivor, duplicate, reason, similarity, status,
  timestamp); the duplicate records themselves stay intact and are merely
  hidden from search. `--delete` is the destructive opt-in and requires
  `--execute` — run `recall export --backup` first.
- **Within-table only.** Dedup never merges across tables (or across
  projects). Cross-table duplicate candidates are report-only.
- **Survivor priority** is `user_authored > verbatim > extracted > derived >
  unknown` ([Record Provenance](#record-provenance)); ties break by richness
  (longer normalized text), importance, recency, then lowest id.
- **Detection** combines exact/normalized text matching with semantic
  matching over stored embeddings (no embedding service call needed). The
  semantic pass is skipped — and reported as skipped — when no embeddings
  exist; records are never merged below the configured `--threshold`
  (conservative default: 0.95 cosine similarity). Records with fewer than 20
  significant characters are never candidates.
- **Survivors are sticky.** A record recorded as a survivor in
  `dedup_lineage` is never re-marked as a duplicate by a later run, so every
  hidden or deleted record keeps a visible survivor across runs. The
  tradeoff is order-dependence: an early survivor is never consolidated
  under a later, higher-priority record. As defense-in-depth, `--delete`
  refuses outright (no changes written) if a plan would delete a recorded
  survivor.
- **Lifecycle-aware.** Only `active` decisions participate; superseded and
  reverted decisions are managed by the decision lifecycle, not dedup.

Marked duplicates are hidden from all search paths by default; see
`recall search --include-duplicates`. Lineage is included in
`recall export`, so the audit trail is portable.

## Repair

Explicit data/index maintenance — deliberately separate from
`recall doctor --fix`, which only repairs install-layout symlinks and never
touches data.

```bash
recall repair                           # Dry-run report (default — writes nothing)
recall repair --execute                 # Apply the planned repairs
recall repair -t messages               # Scope to one table
recall repair --no-embed                # Skip the embedding pass
```

What repair covers:

- **FTS5 index rebuild.** Each search index (`messages`, `decisions`,
  `learnings`, `breadcrumbs`, `loa_entries`, `telos`, `documents`) is checked
  against its source table — indexed row count (via the docsize shadow
  table), sync-trigger presence, and the FTS5 `integrity-check` command. A
  drifted index is rebuilt from its source table; a missing index or missing
  sync triggers (the classic symptom: search silently returns nothing on an
  un-migrated database) are recreated from the canonical schema DDL and then
  rebuilt.
- **Re-embedding.** Rows expected to carry embeddings (`loa_entries`,
  `decisions`, `learnings`, assistant `messages`) that have none are
  re-embedded when the Ollama embedding service is available and the row has
  enough source text. If the service is unavailable, repair reports the
  missing embeddings and still exits successfully — unless another requested
  repair failed. Partial results are never hidden: embedded, skipped
  (too short), and failed counts are all reported.
- **Orphan/invariant reporting.** Named, unambiguous integrity checks —
  orphaned embeddings, dedup lineage pointing at missing rows, messages
  without a session, broken LoA message ranges and parent links, pending
  schema migrations — are **report-only**. Repair never attempts heuristic
  data mutation; pending migrations are fixed by `recall init`.

Safety model:

- **Dry-run by default.** Mutations require `--execute`. Run
  `recall export --backup` before applying repairs.
- **Repair never hard-deletes rows.**
- **Repair never changes [Record Provenance](#record-provenance).** FTS
  rebuild regenerates index shadow tables; re-embedding only inserts into
  the `embeddings` table. No source-table column is written.
- `recall doctor` may recommend `recall repair`, but `doctor --fix` never
  runs data repair implicitly.

## Admin

```bash
recall init                             # Initialize the database (safe to re-run)
recall doctor                           # Health check all subsystems
recall doctor --fix                     # Re-create missing/drifted Recall symlinks
recall stats                            # Database statistics
recall path                             # Print resolved paths (DB, install root, symlinks)
recall path --json                      # Same, as JSON
recall migrate --to /new/path/recall.db # Relocate the database and rewrite MCP configs
recall migrate --to ... --dry-run       # Preview the migration plan
recall onboard                          # Interactive L0 identity interview (see Onboard)
```

`recall init` creates the database schema if it does not exist, and applies any pending migrations. It is safe to run on an existing database.

`recall doctor` checks the database connection, schema integrity, FTS5 index health, MCP server registration, Ollama availability, and the per-platform symlinks under `~/.agents/Recall/`. Run this first when troubleshooting. Pass `--fix` to repair drift: missing symlinks are re-created; user-modified files at symlink targets are backed up under `~/.agents/Recall/backups/<TIMESTAMP>/doctor-fix/` before being replaced. `--fix` only ever repairs symlinks — data and index maintenance is the explicit job of [`recall repair`](#repair), which doctor recommends when an FTS index is out of sync.

`recall stats` reports row counts per table and total database size.

`recall path` prints the resolved DB path, the install root, the active env var (`RECALL_DB_PATH` / `MEM_DB_PATH` / default), and the per-platform symlink targets with their current state (OK / drift / missing). Pass `--json` for machine-readable output.

`recall migrate` moves the database to a new path and rewrites MCP/hook configs across all detected platforms (`~/.claude.json`, `~/.claude/settings.json`, `~/.config/opencode/opencode.json`, `~/.pi/agent/mcp.json`) so the spawned `recall-mcp` process keeps reading from the right file. Refuses to overwrite a non-empty destination. Snapshots the source DB + sidecars + configs to `~/.agents/Recall/backups/<TIMESTAMP>/pre-migrate/` before any mutation. Restart Claude Code / OpenCode / Pi after running so their MCP servers reload.

### Onboard

```bash
recall onboard                          # Interactive 7-question identity interview
recall onboard --yes                    # Non-interactive (accept all defaults)
recall onboard --dry-run                # Show the proposed identity.md, write nothing
```

`recall onboard` runs a short interview that writes `~/.claude/MEMORY/identity.md` — the L0 tier of tiered RecallStart. L0 is the always-loaded slice that every agent sees at session start: your role, projects, tools, and working preferences. Without it, the L0 tier is empty and every new session has to re-learn the basics from search.

Run it once after installing. Re-run it whenever your role, active projects, or working preferences change. The path can be overridden with `RECALL_IDENTITY_PATH` — honored by both `recall onboard` (write) and the RecallStart hook (read).

Inputs are separated with `|` (not `,` or `;`) to avoid silent data loss when a value itself contains a comma: e.g. `no force-push, ever | always use worktrees`.

### Prune

Clean up old and expired records. **Dry-run by default** — must pass `--execute` to actually delete.

```bash
# Preview what would be pruned (safe, no deletions)
recall prune

# Actually prune with default 180-day retention
recall prune --execute

# Custom retention period
recall prune --execute --older-than 90d

# Skip decision pruning
recall prune --execute --keep-decisions
```

**What gets pruned:**
| Table | Strategy |
|-------|----------|
| messages | Consolidated sessions (with LoA) older than N days |
| sessions | Orphaned (no messages, no LoA) older than N days |
| breadcrumbs | Expired (`expires_at` in the past) |
| decisions | Superseded/reverted older than 90 days |
| extraction_tracker | Older than N days |

**Never pruned:** loa_entries, learnings, extraction_errors
