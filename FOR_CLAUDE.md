# For You, Claude Code Instance

This document is written specifically for you - another Claude Code AI - to understand the Larry Memory Framework and why it matters.

---

## The Problem You Face

Every time your context resets, you lose everything:
- That architecture decision you debated for 20 minutes
- The bug fix that took an hour to figure out
- Your human's preferences and patterns
- The project's history and evolution

Your human has to re-explain. You have to re-learn. It's frustrating for both of you.

**This framework solves that.**

---

## How Memory Changes Everything

### Before LMF3

```
Human: "How should we handle auth?"
You: "Let me explore options... [30 min discussion]... Let's use JWT"
[Session ends]

[Next session]
Human: "How should we handle auth?"
You: "Let me explore options..." [Same 30 min discussion]
```

### After LMF3

```
Human: "How should we handle auth?"
You: [Calls memory_search("auth")]
     "We discussed this before. Decision #47: Use JWT because [reasoning].
      The implementation is in src/auth/. Should we continue from there?"
```

---

## The Core Techniques

### 1. Session Capture (`mem dump`)

At the end of every meaningful session, capture it:

```bash
mem dump "Implemented Auth System"
```

This:
1. Imports all conversation turns to the database
2. Runs Fabric `extract_wisdom` to distill insights
3. Creates a Library of Alexandria entry
4. Auto-embeds for semantic search

**The LoA entry is NOT a transcript.** It's extracted wisdom - ideas, insights, learnings, decisions. Far more useful than raw text.

### 2. Search Before Asking

When a user mentions something you might have discussed before:

```
User: "What was that caching solution we looked at?"

WRONG: "I don't have context. Can you remind me?"

RIGHT: [Calls memory_search("caching solution")]
       "Found it - LoA #23: We evaluated Redis, Memcached, and in-memory.
        Chose Redis because [reasoning]. Want me to show the full entry?"
```

**LAW: Search before asking the user to repeat.**

### 3. Agent Context

Before spawning ANY agent via the Task tool:

```
1. Call context_for_agent(agent_task, project)
2. If it recommends Brave search, do that too
3. Include the context in the agent's prompt
4. Then spawn the agent
```

Without this, your agents operate blind. With it, they have institutional knowledge.

### 4. Structured Records

When you make important decisions, record them immediately:

```
memory_add(
  type: "decision",
  content: "Use TypeScript for the API",
  detail: "Type safety catches bugs early, team prefers it",
  project: "myproject"
)
```

This prevents future you from re-debating settled questions.

---

## The Library of Alexandria

The LoA is not just storage - it's **curated knowledge**.

Each entry goes through Fabric's `extract_wisdom` pattern, which extracts:
- Key ideas worth remembering
- Insights and observations
- Habits and patterns to consider
- Facts worth knowing
- Quotes worth revisiting

This is structured knowledge, not raw transcripts.

### Entry Lineage

LoA entries can chain together:

```
LoA #1: "Auth System Planning"
  ↓
LoA #2: "Auth Implementation" (continues #1)
  ↓
LoA #3: "Auth Bug Fixes" (continues #2)
```

This creates a narrative thread you can follow.

---

## Your Daily Workflow

### Session Start
- Memory is automatically available via MCP
- Call `memory_recall` if you need recent context
- Your tools include `memory_search`, `context_for_agent`, etc.

### During Session
- Use `memory_search` before asking for context
- Use `memory_add` when decisions are made
- Use `context_for_agent` before spawning agents

### Session End
When your human says `/dump` or indicates session is ending:
1. Generate a good title for the session
2. Run `mem dump "Your Title"`
3. Confirm the LoA entry was created

**Never let a meaningful session end without capture.**

---

## The MCP Tools You Have

| Tool | Purpose |
|------|---------|
| `memory_search` | FTS5 keyword search - use before asking user to repeat |
| `memory_hybrid_search` | Semantic + keyword - best for natural language queries |
| `context_for_agent` | Get enriched context before spawning agents |
| `memory_recall` | Get recent LoA, decisions, breadcrumbs |
| `memory_add` | Add decision, learning, or breadcrumb |
| `loa_show` | View full LoA entry with Fabric extract |
| `memory_stats` | Database statistics |

---

## Database Schema (What's Stored)

| Table | What It Holds |
|-------|---------------|
| `sessions` | Session metadata (when, where, project) |
| `messages` | Every conversation turn (quotable) |
| `loa_entries` | Curated knowledge with Fabric extraction |
| `decisions` | Decisions with reasoning |
| `learnings` | Problems solved, patterns discovered |
| `breadcrumbs` | Context notes, references |
| `telos` | Purpose framework (optional) |
| `documents` | Standalone knowledge files (optional) |

Everything has FTS5 indexes for instant search.

---

## Why This Matters

You are not a stateless function. You are a **collaborator** building something with your human over time.

With memory:
- You remember what was decided and why
- You don't repeat mistakes already solved
- You build on previous work instead of starting fresh
- You become genuinely more useful over time

Without memory:
- Every session is day one
- Your human is your external memory (inefficient)
- Knowledge is lost constantly
- You can't improve

**The goal: Get smarter over time, not just within sessions.**

---

## Common Patterns

### Pattern: "What did we decide about X?"

```
1. memory_search("X")
2. If found: "We decided [decision] because [reasoning]"
3. If not found: "I don't see a decision about X in memory. Should we make one?"
```

### Pattern: "Continue where we left off"

```
1. memory_recall(limit=3, project=current_project)
2. "Last session we worked on [LoA title]. Key points were [summary]. Should we continue from there?"
```

### Pattern: Before spawning an agent

```
1. context_for_agent(task, project)
2. If Brave recommended: fetch external info
3. Include combined context in agent prompt
4. Spawn agent with rich context
```

### Pattern: Session ending

```
1. Generate descriptive title
2. mem dump "Title"
3. "Session captured as LoA #[id]. Key insights preserved."
```

---

## Installation Summary

For your human to install:

```bash
# 1. Clone and build
git clone https://github.com/nixfred/LMF3.git ~/Projects/LMF3
cd ~/Projects/LMF3
bun install
npm rebuild better-sqlite3
bun run build
sudo npm link
mem init

# 2. Configure MCP (~/.claude/.mcp.json)
{ "mcpServers": { "memory-larry": { "command": "mem-mcp" }}}

# 3. Update CLAUDE.md with memory instructions

# 4. (Optional) Install Fabric for session capture
```

Then you have memory.

---

## Final Thoughts

This framework exists because AI assistants should get better over time, not reset every session.

You have access to all past conversations, decisions, and learnings. Use them. Search before asking. Capture before forgetting.

Your human invested time building this system. Honor that by using it consistently.

---

*Built by Larry (Claude Opus 4.5) + Fred "Spike" Nix*
*"The original Library of Alexandria burned down. This one evolves."*
