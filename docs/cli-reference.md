# CLI Reference

← [Back to README](../README.md)

The `mem` command is the primary interface for Recall. All subcommands operate on the SQLite database at `~/.claude/memory.db`.

---

## Search

```bash
mem "query"                          # Hybrid search (keyword + semantic, default)
mem "query" -k                       # Keyword only (FTS5)
mem "query" -v                       # Vector only (semantic, requires Ollama)
mem search "query"                   # FTS5 search with options
mem search "query" -t decisions      # Search specific table
mem search "query" -p myproject      # Filter by project
mem semantic "query"                 # Semantic search (explicit)
mem hybrid "query"                   # Hybrid search (explicit)
```

The default search mode is hybrid: it runs FTS5 keyword matching and vector similarity in parallel, then merges results by relevance score. Use `-k` when you want exact phrase or operator matching without semantic expansion. Use `-v` when you want conceptually related results even if the exact words differ.

FTS5 supports boolean operators and prefix matching:

- `auth AND token` — both terms must appear
- `config OR setup` — either term
- `config NOT docker` — exclude a term
- `auth*` — prefix match (authz, authentication, etc.)
- `"vpn config"` — exact phrase

---

## Capture

### Session Dump

```bash
mem dump "Session Title"             # Import session + capture LoA entry
```

Combines `mem import` and `mem loa write` in one step. Run this at the end of every session to persist the conversation and extract a Fabric summary into the Library of Alexandria. The title should describe what was accomplished in the session.

### Library of Alexandria (LoA)

```bash
mem loa write "Session Title"              # Capture messages since last LoA entry
mem loa write "VPN Config" -p infra        # Tag with project
mem loa write "VPN Part 2" -c 1            # Continue from previous entry (chain)
mem loa write "Auth System" -t "auth"      # Add tags
mem loa list                               # List recent entries
mem loa show 1                             # View full Fabric extract for entry #1
mem loa quote 1                            # View raw source messages for entry #1
```

LoA is the primary knowledge capture mechanism. Raw transcripts are high-noise; LoA entries contain Fabric-extracted insights, message lineage, continuation chains, and project context. Chaining (`-c <id>`) links a new entry to a prior one, forming a thread of related sessions.

### Decisions

```bash
mem add decision "Use TypeScript over Python" --why "Type safety, team preference" -p myproject
```

Records an architectural or strategic decision with rationale. Decisions carry a status field (`active`, `superseded`, `reverted`) so you can track when a decision is overturned and why.

### Learnings

```bash
mem add learning "Port conflict on 4000" "Kill process or change port" --prevention "Use dynamic port allocation"
```

Captures a problem-solution pair. The first argument is the problem, the second is the solution. The optional `--prevention` flag records how to avoid the issue in the future.

### Breadcrumbs

```bash
mem add breadcrumb "User prefers dark mode in all UIs" -p myproject -i 8
```

Stores a freeform observation or preference. The `-i` flag sets importance on a scale of 1–10 (default: 5). Higher importance surfaces the breadcrumb earlier in search results.

---

## View

```bash
mem loa list                         # Recent LoA entries
mem loa show 1                       # Full Fabric extract for entry #1
mem loa quote 1                      # Raw source messages for entry #1
mem recent                           # Recent records across all tables
mem recent decisions                 # Recent decisions only
mem show decisions 5                 # Full record for decision #5
mem stats                            # Database statistics
mem doctor                           # Health check all subsystems
```

`mem recent` accepts any table name: `decisions`, `learnings`, `breadcrumbs`, `loa`, `sessions`, `docs`, `telos`.

`mem show` displays the full record for a single row. The first argument is the table name, the second is the row ID.

---

## Import

```bash
mem import --dry-run                 # Preview session imports without writing
mem import --yes -v                  # Import all sessions from ~/.claude/projects/
mem import-legacy --yes              # Import DISTILLED.md extracts as LoA entries
mem docs import --dry-run            # Preview document imports
mem docs import --yes                # Import standalone markdown documents
mem telos import --dry-run           # Preview TELOS imports
mem telos import --yes -u            # Import TELOS framework (update existing)
mem telos list -t goal               # List TELOS entries of type: goal
mem telos show G7                    # Show a specific TELOS entry by ID
```

`mem import` scans `~/.claude/projects/` for JSONL session files and imports any not yet recorded. Use `--dry-run` first to confirm scope. The `-v` flag enables verbose output.

`mem import-legacy` converts entries from `DISTILLED.md` files (the previous manual memory format) into LoA entries, preserving their content in the new structured format.

`mem docs` manages standalone reference documents (markdown files) that should be searchable alongside session memory.

`mem telos` manages TELOS framework entries (goals, principles, constraints). The `-u` flag updates existing entries rather than skipping them on reimport.

---

## Embeddings

```bash
mem embed stats                      # Check embedding service status and coverage
mem embed backfill -t loa            # Generate missing embeddings for LoA entries
mem embed backfill -t decisions      # Generate missing embeddings for decisions
```

Embeddings are generated via Ollama and stored in the database for vector similarity search. `mem embed stats` shows how many records have embeddings versus how many are eligible. Run `mem embed backfill` after importing a large batch of records to ensure full semantic search coverage.

Supported tables for backfill: `loa`, `decisions`, `learnings`, `breadcrumbs`, `sessions`, `docs`.

---

## Admin

```bash
mem init                             # Initialize the database (safe to re-run)
mem doctor                           # Health check all subsystems
mem stats                            # Database statistics
```

`mem init` creates the database schema if it does not exist, and applies any pending migrations. It is safe to run on an existing database.

`mem doctor` checks the database connection, schema integrity, FTS5 index health, MCP server registration, and Ollama availability. Run this first when troubleshooting.

`mem stats` reports row counts per table and total database size.
