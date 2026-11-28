← [Back to README](../README.md)

# Glossary

Plain-language meanings for the terms Recall's docs use. If a word is missing, [open an issue](https://github.com/edheltzel/Recall/issues).

| Term | Meaning |
|------|---------|
| **Host** | A coding agent Recall works with: Claude Code, Codex, Pi, OpenCode, omp, Grok, JCode, Cursor, Empryo. Also called a harness. |
| **Memory record** | One saved item in the database. Four kinds: message, decision, learning, breadcrumb. |
| **Decision** | A choice and its reason ("Use SQLite - zero-config"). Can be superseded or reverted later. |
| **Learning** | A problem and its solution ("Port 4000 busy - kill the process"). |
| **Breadcrumb** | A short note about where you are or what is in progress. |
| **LoA (Library of Alexandria)** | Longer session write-ups. **Automatic-capture LoA** is written by capture hooks; **Curated LoA** is written by you or an agent (`recall dump`, `recall loa`). |
| **L0 identity** | A small file about you (role, projects, tools, preferences) injected at the start of every session. Create it with `recall onboard`. |
| **L1 top records** | The highest-importance records, injected after L0 at session start. |
| **Importance** | A 1-10 score that decides what reaches L1. Change it with `recall pin`. |
| **Session-start injection** | Recall placing L0 and L1 into a new session. Only some hosts support it; see [Getting Started](getting-started.md#4-seed-your-identity-then-start-a-session). |
| **Capture** | Saving what happened in a session, by hook or `recall capture`. |
| **Extractor** | The model that turns a raw transcript into decisions, learnings, and breadcrumbs (`claude-cli` or `ollama`). |
| **Hybrid search** | Keyword search (FTS5) and meaning search (embeddings) merged. Keyword-only works without Ollama. |
| **MCP** | Model Context Protocol. How an agent calls Recall mid-session through `recall-mcp`. |
| **Jev** | Optional scorer for extracted records. Off unless `JEV_RECALL_KEY` is set. |
| **Provenance** | How a record came to exist: `verbatim`, `user_authored`, `extracted`, or `derived`. |
