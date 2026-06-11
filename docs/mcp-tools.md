# MCP Tools

[Back to README](../README.md)

All 8 tools available when Claude Code connects to the Recall MCP server (`recall-memory`).

---

## memory_search

FTS5 keyword search across all memory tables. Use before asking the user to repeat anything.

Use `table` when you need a **hard filter** to one record type. Use `bias_type` when you want one type to appear first but still want useful matches from other tables.

**Parameters**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| query | string | yes | — | Search query. FTS5 supports `AND`, `OR`, `NOT`, `prefix*`, `"exact phrase"` |
| project | string | no | — | Filter results to a specific project name |
| table | string | no | — | Hard-filter search to one table: `messages`, `loa`, `decisions`, `learnings`, `breadcrumbs` |
| bias_type | string | no | — | Softly boost one table type in ranking without filtering other matches. Same allowed values as `table`; prefer `table` when you need only one type. |
| limit | number | no | 10 | Maximum number of results to return |

**Returns:** Array of matching records with table name, id, content, project, snippet highlighting, and Record Provenance (`verbatim`, `user_authored`, `extracted`, `derived`, or `unknown` for legacy rows that predate provenance).

```js
// Only decisions
memory_search({ query: "kubernetes auth", project: "my-app", table: "decisions", limit: 10 })

// Prefer decisions, but keep matching learnings/messages/LoA/breadcrumbs
memory_search({ query: "kubernetes auth", project: "my-app", bias_type: "decisions", limit: 10 })
```

**When to bias:** use `bias_type: "decisions"` for “what did we decide,” `"learnings"` for “what did we learn,” `"breadcrumbs"` for “where did we leave off,” `"loa"` for curated summaries, and `"messages"` for raw conversation traces.

---

## memory_hybrid_search

Combined keyword + semantic search using Reciprocal Rank Fusion. Best for natural language queries. Falls back to keyword-only search if embeddings are unavailable.

**Parameters**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| query | string | yes | — | Natural language search query |
| project | string | no | — | Filter results to a specific project name |
| limit | number | no | 10 | Maximum number of results to return |

**Returns:** Array of matching records ranked by fused keyword and semantic relevance scores, each with its Record Provenance.

```js
memory_hybrid_search({ query: "how did we handle rate limiting", project: "my-app" })
```

---

## memory_recall

Get recent context — LoA entries, decisions, and breadcrumbs. Good for orienting at the start of a session.

**Parameters**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| limit | number | no | 5 | Number of recent entries to return per category |
| project | string | no | — | Filter results to a specific project name |

**Returns:** Recent records grouped by category: Library of Alexandria entries, decisions, and breadcrumbs — each annotated with its Record Provenance.

```js
memory_recall({ limit: 5, project: "my-app" })
```

---

## context_for_agent

Call this before spawning any agent via the Task tool. Uses hybrid search to find relevant memory context for the planned task, so the agent starts with relevant background.

**Parameters**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| agent_task | string | yes | — | The task or prompt you plan to give the agent |
| project | string | no | — | Current project name for filtering |

**Returns:** Formatted context block containing relevant decisions, learnings, and breadcrumbs matched to the task description.

```js
context_for_agent({ agent_task: "Refactor the auth middleware", project: "my-app" })
```

---

## memory_add

Add structured records during a session. Use this to capture decisions, learnings, and work-in-progress breadcrumbs as they happen.

**Parameters**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| type | string | yes | — | Record type: `"decision"`, `"learning"`, or `"breadcrumb"` |
| content | string | yes | — | Main content |
| detail | string | no | — | Additional detail — reasoning for decisions, solution steps for learnings |
| project | string | no | — | Project name |
| tags | string | no | — | Comma-separated tags (applies to learnings) |
| confidence | string | no | — | Confidence level: `"high"`, `"medium"`, or `"low"` — applies to decisions and learnings |
| importance | number | no | 5 | Importance on a 1-10 scale. Surfaces higher-importance records earlier in L1 at session start. LoA has a floor of 5. (Added in v0.7.0.) |

**Returns:** Confirmation with the new record's id and table.

Records created through `memory_add` are automatically stamped with Record Provenance `user_authored`. There is intentionally no provenance parameter — provenance is write-path metadata, not a caller claim (see `docs/adr/0001-record-provenance-automatic-write-path-metadata.md`).

```js
memory_add({ type: "decision", content: "Use PostgreSQL over MySQL", detail: "Better JSON support and JSONB indexing" })
memory_add({ type: "learning", content: "bun:sqlite uses $param syntax", detail: "Not :param like better-sqlite3", tags: "bun,sqlite" })
memory_add({ type: "breadcrumb", content: "Auth refactor in progress — do not touch middleware until complete" })
memory_add({ type: "decision", content: "Ship onboarding first", importance: 9 })
```

---

## memory_stats

Get database statistics including record counts per table and total database size. No parameters.

**Returns:** Record counts for each table (`messages`, `decisions`, `learnings`, `breadcrumbs`, `loa`, `docs`) and total database size on disk.

```js
memory_stats()
```

---

## loa_show

Show a full Library of Alexandria entry with its Fabric `extract_wisdom` content. LoA entries are curated knowledge summaries extracted from session conversations.

**Parameters**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| id | number | yes | — | LoA entry ID (use `memory_search` or `memory_recall` to find IDs) |

**Returns:** Full LoA record including title, summary, insights, quotes, and any Fabric-extracted wisdom.

```js
loa_show({ id: 1 })
```

---

## memory_dump

Flush the current conversation session into SQLite. Extracts messages, decisions, and learnings from the session transcript and persists them to the database. Use when the user says `/dump`.

**Parameters**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| title | string | yes | — | Descriptive title for this session dump |
| project | string | no | — | Override the auto-detected project name |
| skip_fabric | boolean | no | true | Skip Fabric processing (faster; uses a basic summary instead of `extract_wisdom`) |

**Returns:** Summary of records imported: message count, decisions, learnings, and breadcrumbs extracted from the session.

```js
memory_dump({ title: "Auth middleware refactor — JWT validation approach", project: "my-app" })
```

---

## decision_update

Update the status of an existing decision. Use this to mark decisions as superseded (replaced by a newer decision) or reverted (rolled back because it was wrong).

**Parameters**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| id | number | yes | — | Decision ID to update |
| action | string | yes | — | Status transition: `"supersede"` or `"revert"` |

**Returns:** Confirmation with the updated decision's id and new status.

```js
decision_update({ id: 42, action: "supersede" })
decision_update({ id: 17, action: "revert" })
```

---

## When to Use Each Tool

| Scenario | Tool |
|----------|------|
| Starting a new session | `memory_recall` |
| User asks about past work | `memory_search` or `memory_hybrid_search` |
| Before spawning a sub-agent | `context_for_agent` |
| Recording an architectural decision | `memory_add` with `type: "decision"` |
| Capturing a technical insight | `memory_add` with `type: "learning"` |
| Marking work-in-progress state | `memory_add` with `type: "breadcrumb"` |
| Marking a decision as replaced or rolled back | `decision_update` |
| End of session | `memory_dump` |
| Viewing curated knowledge | `loa_show` |
| Quick database health check | `memory_stats` |
