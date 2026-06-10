---
description: Add a structured memory record to Recall — breadcrumb, decision, or learning
---

Manually add a structured record to the Recall memory database. Three record types are available: breadcrumbs (context notes), decisions (architectural choices), and learnings (problem/solution pairs).

## Usage

```bash
# Breadcrumb — quick context note
recall add breadcrumb "$1"

# Decision — architectural or process decision
recall add decision "$1" --why "reasoning"

# Learning — problem and solution pair
recall add learning "$1" "solution"
```

**Breadcrumb options:**
- `-p <project>` — Project name
- `-c <category>` — Category: context, note, todo, reference
- `-i <n>` — Importance 1-10 (default: 5)

**Decision options:**
- `-p <project>` — Project name
- `-w, --why <text>` — Why this decision was made
- `-a, --alternatives <text>` — Alternatives considered

**Learning options:**
- `-p <project>` — Project name
- `-t, --tags <tags>` — Comma-separated tags
- `--prevention <text>` — How to prevent in future

## Examples

```bash
# Breadcrumb with high importance
recall add breadcrumb "User prefers dark mode in all UIs" -p myproject -i 8

# Decision with reasoning
recall add decision "Use TypeScript over Python" --why "Type safety, team preference" -p myproject

# Learning with prevention
recall add learning "Port conflict on 4000" "Kill process or change port" --prevention "Use dynamic port allocation"

# Tagged learning
recall add learning "bun:sqlite uses \$param syntax" "Not :param like better-sqlite3" -t "bun,sqlite,gotcha"
```

$@
