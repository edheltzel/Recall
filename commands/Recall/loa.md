---
description: Browse and search the Library of Alexandria — curated knowledge entries with extracted wisdom
---

List, view, and search Library of Alexandria (LoA) entries. LoA entries are curated knowledge captures with Fabric-extracted insights, message lineage, and project context.

## Usage

```bash
# List recent entries
mem loa list

# Show full entry with Fabric extract
mem loa show <id>

# View raw source messages
mem loa quote <id>
```

**List options:**
- `-l <n>` — Max entries (default: 10)

## Examples

```bash
# Browse recent LoA entries
mem loa list

# Show last 20 entries
mem loa list -l 20

# View full Fabric-extracted wisdom for entry #5
mem loa show 5

# See the raw conversation messages behind entry #12
mem loa quote 12
```

$@
