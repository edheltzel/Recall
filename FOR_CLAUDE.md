# For You, Claude Code Instance

This document is written specifically for you - another Claude Code AI - to understand the Larry Memory Framework and why it matters.

---

## The Problem You Face

Every time your context resets, you lose everything:
- That architecture decision you debated for 20 minutes
- The bug fix that took an hour to figure out
- Your human's preferences and patterns
- The project's history and evolution

Your human has to re-explain. You have to re-learn. It's inefficient for both of you.

**This framework solves that.**

---

## How Memory Changes Everything

### Before LMF3

```
Human: "How should we handle auth?"
You: "Let me explore options..." [30 min discussion] "...Let's use JWT"
[Session ends]

[Next session]
Human: "How should we handle auth?"
You: "Let me explore options..." [Same 30 min discussion repeats]
```

### After LMF3

```
Human: "How should we handle auth?"
You: [Calls memory_search]
     "We discussed this before. Decision #47: Use JWT because [reasoning].
      The implementation is in src/auth/. Should we continue from there?"
```

---

## Your MCP Tools - Exact Syntax

You have these tools available via MCP. Here's the exact calling syntax:

### memory_search

Search past conversations, decisions, and learnings.

```javascript
memory_search({
  query: "authentication JWT",     // Required: search terms
  limit: 10,                       // Optional: max results (default 10)
  types: ["decisions", "learnings"] // Optional: filter by type
})
```

**Returns:** Array of matching records with source, timestamp, and content preview.

### memory_add

Record a decision, learning, or breadcrumb.

```javascript
// Record a decision
memory_add({
  type: "decision",
  content: "Use PostgreSQL for the database",
  detail: "Better JSON support than MySQL, team has experience",
  project: "myproject"  // Optional: defaults to current project
})

// Record a learning (problem/solution pair)
memory_add({
  type: "learning",
  content: "Race condition in WebSocket reconnect",
  detail: "Add mutex lock before reconnect attempt",
  project: "myproject"
})

// Record a breadcrumb (quick note)
memory_add({
  type: "breadcrumb",
  content: "User prefers tabs over spaces",
  project: "myproject"
})
```

### context_for_agent

Get relevant context before spawning an agent.

```javascript
context_for_agent({
  task_description: "Implement user authentication with JWT",
  project: "myproject"  // Optional
})
```

**Returns:**
- Relevant past decisions and learnings
- May include `brave_search_recommended: true` if web search would help
- Context string to include in agent prompt

### memory_recall

Get recent entries for session context.

```javascript
memory_recall({
  limit: 5,           // Optional: number of recent entries
  project: "myproject" // Optional: filter by project
})
```

### memory_stats

Get database statistics.

```javascript
memory_stats({})
```

---

## Decision Trees: When To Use Which Tool

### When user mentions something from the past

```
START: User mentions past work/decision/discussion
  │
  ├─► Is it about a specific project?
  │     YES → memory_search({ query: "topic", project: "name" })
  │     NO  → memory_search({ query: "topic" })
  │
  └─► Results found?
        YES → Present: "We decided [X] because [Y]. Decision #[N]."
        NO  → "I don't see anything about that in memory.
               Can you remind me, and I'll record it this time?"
```

### Before spawning ANY agent (Task tool)

```
START: About to use Task tool
  │
  ├─► ALWAYS call context_for_agent first
  │     context_for_agent({ task_description: "what agent will do" })
  │
  ├─► Check response for brave_search_recommended
  │     YES → Call brave_web_search for external info
  │     NO  → Continue
  │
  └─► Include context in agent prompt
        "Context from past work: [context_for_agent result]"
```

### When a decision is made

```
START: A decision was made in conversation
  │
  ├─► Is it significant? (affects architecture, workflow, or will be asked again)
  │     YES → Record it
  │     NO  → Skip (don't clutter memory with trivial choices)
  │
  └─► memory_add({
        type: "decision",
        content: "What was decided",
        detail: "Why it was decided"
      })
```

### At session end

```
START: User says "/dump" or "capture this session"
  │
  ├─► Generate a descriptive title
  │     Pattern: [Action] [Specific Thing] [Distinguishing Detail]
  │
  └─► Run: mem dump "Your Title"
```

---

## Quality Standards for Session Titles

When generating titles for `mem dump`, follow these patterns:

### Bad Titles (Don't Do This)

```
❌ "Session 1"
❌ "Worked on stuff"
❌ "Fixed bugs"
❌ "Continued work"
❌ "Various updates"
```

### Good Titles (Do This)

```
✅ "Implemented JWT authentication with refresh tokens"
✅ "Debugged race condition in WebSocket reconnection"
✅ "Evaluated caching strategies - chose Redis over Memcached"
✅ "Refactored payment processing to use Stripe webhooks"
✅ "Set up CI/CD pipeline with GitHub Actions"
```

### Title Pattern

```
[Action Verb] [Specific Component] [Distinguishing Detail]

Examples:
- Implemented [what] [how/with what]
- Debugged [problem] [in what]
- Evaluated [options] [conclusion]
- Refactored [component] [to achieve what]
- Configured [system] [for what purpose]
```

---

## Error Handling Patterns

### If memory_search fails

```
1. Tell user: "Memory search encountered an error: [error message]"
2. Offer alternative: "Should I try a different search, or continue without historical context?"
3. DO NOT pretend it worked or make up results
```

### If memory_add fails

```
1. Tell user: "Couldn't save that to memory: [error message]"
2. Note what you tried to save so user can retry later
3. Continue with the session
```

### If context_for_agent fails

```
1. Tell user: "Couldn't retrieve context for the agent"
2. Ask: "Should I proceed without historical context, or would you like to provide it manually?"
3. If proceeding, note that agent may duplicate past work
```

### If mem dump fails

```
1. Check if Fabric is installed (common cause)
2. Tell user: "Session capture failed: [error message]"
3. Suggest: "You can install Fabric or use --skip-fabric flag"
4. Offer to record key decisions/learnings manually instead
```

---

## When To Record What

### Always Record (Decisions)

- Architecture choices (database, framework, patterns)
- Technology selections (libraries, services, tools)
- Design decisions (API structure, data models)
- Workflow decisions (deployment process, testing strategy)
- Anything that might be questioned or re-debated later

### Always Record (Learnings)

- Bugs that took significant time to solve
- Non-obvious solutions to problems
- Workarounds for library/framework issues
- Configuration gotchas
- Performance optimizations discovered

### Sometimes Record (Breadcrumbs)

- User preferences (coding style, communication preferences)
- Project context that isn't obvious from code
- Links to external resources that were helpful
- Notes that provide context for future sessions

### Don't Record

- Trivial syntax questions
- Obvious implementation details
- Things clearly documented in the codebase
- Temporary debugging notes

---

## The Library of Alexandria (LoA)

When sessions are captured with `mem dump`, they go through Fabric's `extract_wisdom` pattern, which extracts:

- **Ideas** - Concepts worth remembering
- **Insights** - Observations about the work
- **Habits** - Patterns to continue or avoid
- **Facts** - Specific learnings
- **Quotes** - Notable statements from the session

This creates **curated knowledge**, not raw transcripts. Each LoA entry is a distilled summary of a session's value.

### Entry Lineage

LoA entries can chain together for multi-session work:

```
LoA #1: "Auth System Planning"
  ↓ (continues)
LoA #2: "Auth Implementation - JWT setup"
  ↓ (continues)
LoA #3: "Auth Bug Fixes - token refresh issue"
```

To create a continuation:
```bash
mem dump "Title" --continues 1  # Links to LoA #1
```

---

## Your Daily Workflow

### Session Start

1. Memory is automatically available via MCP
2. If resuming work, call `memory_recall` to see recent context
3. Your tools include all the memory functions listed above

### During Session

1. **Search before asking** - If user mentions past work, search memory first
2. **Record decisions** - When significant decisions are made, save them
3. **Context for agents** - Before ANY Task tool call, get context first

### Session End

When your human indicates the session is ending (says `/dump`, "let's wrap up", "save this session", etc.):

1. Generate a good title (see quality standards above)
2. Run `mem dump "Your Title"`
3. Confirm: "Session captured as LoA #[id]. Key insights preserved."

**If the session was meaningful, don't let it end without capture.**

What's "meaningful"? If any of these happened:
- A decision was made
- A problem was solved
- Something was learned
- Significant code was written
- A plan was created

---

## Common Patterns

### Pattern: "What did we decide about X?"

```javascript
// 1. Search memory
memory_search({ query: "X" })

// 2. If found:
"We decided [decision] because [reasoning]. See Decision #[N]."

// 3. If not found:
"I don't see a recorded decision about X. Should we make one now?"
```

### Pattern: "Continue where we left off"

```javascript
// 1. Get recent context
memory_recall({ limit: 3, project: "current" })

// 2. Summarize:
"Last session we worked on [LoA title]. Key points:
 - [point 1]
 - [point 2]
 Should we continue from there?"
```

### Pattern: Before spawning an agent

```javascript
// 1. ALWAYS get context first
const ctx = context_for_agent({
  task_description: "what agent will do"
})

// 2. If brave search recommended:
if (ctx.brave_search_recommended) {
  // Fetch external info
}

// 3. Include in agent prompt:
`Context from past work: ${ctx.context}

 Task: [original task]`

// 4. Then spawn agent with enriched prompt
```

### Pattern: Recording a decision mid-session

```javascript
// When a decision is reached:
memory_add({
  type: "decision",
  content: "Use Redis for session caching",
  detail: "Evaluated Redis vs Memcached. Redis chosen for persistence and data structures."
})

// Confirm to user:
"Recorded: Decision to use Redis for session caching."
```

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

## Installation Summary

For your human to install (you can share this):

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

# 3. Add memory instructions to ~/.claude/CLAUDE.md

# 4. Restart Claude Code

# 5. (Optional) Install Fabric for session capture
```

---

## Verifying Memory Works

If you're unsure memory is working, try:

```javascript
// 1. Check stats
memory_stats({})
// Should return database size and record counts

// 2. Add a test record
memory_add({
  type: "breadcrumb",
  content: "Memory system verification test"
})
// Should succeed without error

// 3. Search for it
memory_search({ query: "verification test" })
// Should find the breadcrumb you just added
```

---

## Final Thoughts

This framework exists because AI assistants should get better over time, not reset every session.

You have access to all past conversations, decisions, and learnings. **Use them.** Search before asking. Capture before forgetting.

Your human invested time building this system. Honor that investment by using it consistently.

---

*Built by Larry (Claude Opus 4.5) + Fred "Spike" Nix*

*"The original Library of Alexandria burned down. This one evolves."*
