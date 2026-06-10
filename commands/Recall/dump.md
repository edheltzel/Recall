---
description: Flush current session to Recall database and capture a Library of Alexandria entry
---

Dump the current conversation session into the Recall SQLite database, making all messages immediately searchable. Also creates a curated LoA (Library of Alexandria) entry with extracted wisdom.

Run this at the end of every session or when you want to persist the current conversation mid-session.

## Usage

```bash
recall dump "$1"
```

**Arguments:**
- `$1` (required): Descriptive title for this session (e.g., "Auth refactor planning", "Fixed rate limiter bug")

**Options:**
- `-p <project>` — Tag with a project name
- `-t <tags>` — Comma-separated tags
- `-c <id>` — Continue from a previous LoA entry (creates a chain)
- `--skip-fabric` — Skip Fabric extraction (faster, import only)

## Examples

```bash
# Basic dump
recall dump "Debugging the webhook handler"

# With project tag
recall dump "API redesign session" -p my-api

# Continue a previous conversation thread
recall dump "Auth refactor part 2" -c 15

# Quick import without Fabric extraction
recall dump "Quick fix session" --skip-fabric
```

$@
