---
name: "recall-loa"
description: "Browse and search the Library of Alexandria — curated knowledge entries with extracted wisdom"
---

# source-command-recall-loa

Use this skill when the user asks to run the migrated source command `Recall-loa`.

## Command Template

List, view, and search Library of Alexandria (LoA) entries. LoA entries are curated knowledge captures with Fabric-extracted insights, message lineage, and project context.

## Usage

```bash
# List recent entries
recall loa list

# Show full entry with Fabric extract
recall loa show <id>

# View raw source messages
recall loa quote <id>
```

**List options:**

- `-l <n>` — Max entries (default: 10)

## Examples

```bash
# Browse recent LoA entries
recall loa list

# Show last 20 entries
recall loa list -l 20

# View full Fabric-extracted wisdom for entry #5
recall loa show 5

# See the raw conversation messages behind entry #12
recall loa quote 12
```

$@
