---
description: Show recent Recall memory records across all tables or a specific table
---

Display the most recent records from Recall memory. Shows entries across all tables by default, or filter to a specific table.

## Usage

```bash
recall recent $1
```

**Arguments:**
- `$1` (optional): Table to filter — messages, decisions, learnings, breadcrumbs, or all (default: all)

**Options:**
- `-p <project>` — Filter by project name
- `-l <n>` — Max results (default: 10)

## Examples

```bash
# Recent records across all tables
recall recent

# Recent decisions only
recall recent decisions

# Recent learnings for a specific project
recall recent learnings -p my-api

# Last 20 breadcrumbs
recall recent breadcrumbs -l 20
```

$@
