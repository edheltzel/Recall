---
title: Claude Code — Comprehensive Reference Document
status: Complete
percent_complete: 100
last_updated: 2026-04-28
phase: Reference / no execution phase
blockers: none
next_action: Reference doc — consult when wiring new hooks; archive if no longer used
---

# Claude Code — Comprehensive Reference Document

**Audit Date:** April 1, 2026
**Latest Version:** 2.1.89
**Source:** Official documentation at code.claude.com, changelog, and env-vars reference

---

## PART 1 — HOOKS SYSTEM COMPLETE REFERENCE

### Overview

Claude Code provides 25 hook event types (as of v2.1.89) that fire at specific lifecycle points. Hooks are deterministic shell scripts, HTTP endpoints, prompt evaluations, or agent invocations that run outside Claude's context window.

### Hook Handler Types

Four handler types are supported for most events:

#### `type: "command"` — Shell command

```json
{
  "type": "command",
  "command": "path/to/script.sh",
  "async": false,
  "shell": "bash",
  "timeout": 60,
  "if": "Bash(rm *)",
  "statusMessage": "Custom spinner message"
}
```

Exit code semantics:
- Exit 0: Success. Parse stdout as JSON if present.
- Exit 2: Blocking error. stderr text becomes the feedback/reason shown.
- Any other exit: Non-blocking. stderr shown in verbose mode only.

The `if` field is a fine-grained matcher using `Tool(pattern)` syntax evaluated against the tool call. Hooks with `if` only run when the pattern matches. This is distinct from the top-level `matcher` which filters by tool name.

#### `type: "http"` — HTTP POST

```json
{
  "type": "http",
  "url": "http://localhost:8080/hooks/pre-tool-use",
  "headers": { "Authorization": "Bearer $MY_TOKEN" },
  "allowedEnvVars": ["MY_TOKEN"],
  "timeout": 30
}
```

Response handling:
- 2xx with empty body: Success (exit 0 equivalent)
- 2xx with JSON body: Parsed as output
- 2xx with plain text: Added as context
- Non-2xx or connection failure: Non-blocking error

The `allowedEnvVars` list controls which environment variables can be interpolated into header values. A managed-settings-level `httpHookAllowedEnvVars` list further restricts this across all HTTP hooks.

HTTP hooks were added in v2.1.63. Added in v2.1.84: `WorktreeCreate` HTTP hooks can return `hookSpecificOutput.worktreePath` to supply a custom worktree path.

#### `type: "prompt"` — Claude model evaluation

```json
{
  "type": "prompt",
  "prompt": "Should this command be allowed? $ARGUMENTS",
  "model": "claude-3-5-sonnet-20241022",
  "timeout": 30
}
```

The model returns a yes/no decision. Use for flexible policy checks that benefit from natural language reasoning rather than pattern matching.

#### `type: "agent"` — Subagent with tools

```json
{
  "type": "agent",
  "prompt": "Verify this code change for security issues: $ARGUMENTS",
  "timeout": 60
}
```

Spawns a subagent that can use Read, Grep, Glob, and other tools. Use for complex verification requiring file inspection.

### Common Input Fields (All Events)

Every hook receives this JSON envelope via stdin:

```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/current/working/directory",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "agent_id": "optional-subagent-id",
  "agent_type": "optional-agent-name"
}
```

| Field | Description |
|---|---|
| `session_id` | Unique session identifier (UUID) |
| `transcript_path` | Path to JSONL conversation file. Empty string when `cleanupPeriodDays: 0` |
| `cwd` | Current working directory at event time |
| `permission_mode` | One of: `default`, `plan`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions` |
| `hook_event_name` | Event name string |
| `agent_id` | Present in subagent context only |
| `agent_type` | Agent name in subagent context, or value from `--agent` flag |

### Common Output Format (Exit 0 + JSON)

```json
{
  "continue": true,
  "stopReason": "optional stop message",
  "suppressOutput": false,
  "systemMessage": "warning shown to user",
  "decision": "block",
  "reason": "reason for decision",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "...event-specific fields..."
  }
}
```

| Field | Purpose |
|---|---|
| `continue: false` | Abort the entire Claude session |
| `stopReason` | Message shown when `continue: false` |
| `suppressOutput` | Hide hook output from verbose display |
| `systemMessage` | Warning injected into Claude's context |
| `decision: "block"` | Block the triggering action (on supported events) |
| `reason` | Feedback to Claude when blocking |
| `hookSpecificOutput` | Event-specific fields (see each event) |

---

### Complete Event Reference

#### SessionStart

**When:** Session begins, resumes, clears, or restarts after compact.

**Matcher values:** `startup`, `resume`, `clear`, `compact`

**Hook types:** command only

**Can block:** No

**Input:**
```json
{
  "source": "startup | resume | clear | compact",
  "model": "claude-sonnet-4-6"
}
```

**Output:**
```json
{
  "hookSpecificOutput": {
    "additionalContext": "string injected into session"
  }
}
```

**Special feature — Persist environment variables:**
Read `$CLAUDE_ENV_FILE` and append `export VAR=value` lines to it. These exports are sourced before every subsequent Bash command in the session. This is how you persist virtualenv activations, `direnv` exports, etc.

```bash
#!/bin/bash
if [ -n "$CLAUDE_ENV_FILE" ]; then
  echo 'export NODE_ENV=production' >> "$CLAUDE_ENV_FILE"
fi
exit 0
```

**Added:** Core feature (pre-v2.1.50)

---

#### InstructionsLoaded

**When:** A CLAUDE.md file or `.claude/rules/*.md` file is loaded into context.

**Matcher values:** `session_start`, `nested_traversal`, `path_glob_match`, `include`, `compact`

**Hook types:** command, http, prompt, agent

**Can block:** No (observability only)

**Input:**
```json
{
  "file_path": "/path/to/CLAUDE.md",
  "memory_type": "User | Project | Local | Managed",
  "load_reason": "session_start | nested_traversal | path_glob_match | include | compact",
  "globs": ["**/*.ts"],
  "trigger_file_path": "optional path that triggered load",
  "parent_file_path": "optional parent CLAUDE.md that included this"
}
```

**Added:** v2.1.69

---

#### UserPromptSubmit

**When:** User submits a prompt before Claude processes it.

**Matcher values:** None (always fires)

**Hook types:** command, http, prompt, agent

**Can block:** Yes. Exit 2 blocks the prompt and erases it from the input box.

**Input:**
```json
{
  "prompt": "user's raw prompt text"
}
```

**Output (block):**
```json
{
  "decision": "block",
  "reason": "shown to user as error"
}
```

**Output (augment):**
```json
{
  "hookSpecificOutput": {
    "additionalContext": "appended to Claude's context"
  }
}
```

Plain stdout text (without JSON) is also appended as context.

**Added:** Core feature (pre-v2.1.50)

---

#### PreToolUse

**When:** Immediately before any tool execution.

**Matcher values:** Tool name (e.g., `Bash`, `Write`, `Edit`, `mcp__server__tool`). Regex-style pipe for OR: `Write|Edit`. Wildcard: `*` or `""`.

**Hook types:** command, http, prompt, agent

**Can block:** Yes. Exit 2 blocks the tool call with stderr as reason. JSON `decision: "block"` also blocks.

**Input:**
```json
{
  "tool_name": "Bash",
  "tool_input": { "command": "npm test", "description": "...", "timeout": 30000, "run_in_background": false },
  "tool_use_id": "toolu_01ABC123"
}
```

Tool input schemas by tool:
- **Bash:** `{ command, description, timeout, run_in_background }`
- **Write:** `{ file_path, content }`
- **Edit:** `{ file_path, old_string, new_string, replace_all }`
- **Read:** `{ file_path, offset, limit }`
- **Glob:** `{ pattern, path }`
- **Grep:** `{ pattern, path, glob, output_mode, "-i", multiline }`
- **WebFetch:** `{ url, prompt }`
- **WebSearch:** `{ query, allowed_domains, blocked_domains }`
- **Agent:** `{ prompt, description, subagent_type, model }`
- **AskUserQuestion:** `{ questions, answers }`

**Output:**
```json
{
  "hookSpecificOutput": {
    "permissionDecision": "allow | deny | ask",
    "permissionDecisionReason": "explanation",
    "updatedInput": { "modified_fields_only" },
    "additionalContext": "string"
  }
}
```

**Important:** As of v2.1.85, `updatedInput` can be returned alongside `permissionDecision: "allow"` to modify the tool input before execution (e.g., rewrite a file path, sanitize a command).

**New in v2.1.89:** Hooks can return `"defer"` as the permission decision. This pauses the headless session at the tool call, which can later be resumed with `-p --resume <session-id>`. Enables human-in-the-loop workflows in automated pipelines.

**Deprecation:** The legacy `decision: "approve"` / `decision: "block"` format at the top level is deprecated. Use `hookSpecificOutput.permissionDecision: "allow" | "deny" | "ask"`.

**Added:** Core feature

---

#### PermissionRequest

**When:** The permission approval dialog would appear to the user (tool not in allow list and not denied).

**Matcher values:** Tool name (same as PreToolUse)

**Hook types:** command, http, prompt, agent

**Can block:** Yes. Can auto-approve or auto-deny on behalf of the user. Exit 2 denies.

**Input:**
```json
{
  "tool_name": "Bash",
  "tool_input": { "command": "..." },
  "permission_suggestions": [
    {
      "type": "addRules",
      "rules": [{ "toolName": "Bash", "ruleContent": "npm run *" }],
      "behavior": "allow",
      "destination": "localSettings"
    }
  ]
}
```

**Output:**
```json
{
  "hookSpecificOutput": {
    "decision": {
      "behavior": "allow | deny",
      "updatedInput": { "modified_fields" },
      "updatedPermissions": [
        {
          "type": "addRules | replaceRules | removeRules | setMode | addDirectories | removeDirectories",
          "rules": ["Bash(npm run *)"],
          "behavior": "allow | deny | ask",
          "mode": "default | acceptEdits | dontAsk | bypassPermissions | plan",
          "directories": ["/additional/path"],
          "destination": "session | localSettings | projectSettings | userSettings"
        }
      ]
    },
    "message": "reason for denial shown to user"
  }
}
```

**Added:** Core feature

---

#### PermissionDenied

**When:** The auto mode classifier denies a tool call (not the same as a user explicitly denying).

**Matcher values:** Tool name

**Hook types:** command, http, prompt, agent

**Can block:** Yes. Return `{ "retry": true }` in hookSpecificOutput to retry the tool call after hook processing.

**Input:** Same as PreToolUse (`tool_name`, `tool_input`, `tool_use_id`)

**Added:** v2.1.89

---

#### PostToolUse

**When:** After a tool executes successfully.

**Matcher values:** Tool name

**Hook types:** command, http, prompt, agent

**Can block:** Yes, exit 2 provides feedback to Claude (not the user). Can inject context.

**Input:**
```json
{
  "tool_name": "Write",
  "tool_input": { "file_path": "...", "content": "..." },
  "tool_response": { "filePath": "...", "success": true },
  "tool_use_id": "toolu_01ABC123"
}
```

**Output:**
```json
{
  "decision": "block",
  "reason": "feedback injected into Claude's next turn",
  "hookSpecificOutput": {
    "additionalContext": "string appended to context",
    "updatedMCPToolOutput": "replacement output for MCP tool results"
  }
}
```

**Added:** Core feature

---

#### PostToolUseFailure

**When:** After a tool fails to execute.

**Matcher values:** Tool name

**Hook types:** command, http, prompt, agent

**Can block:** No (stderr shown only)

**Input:**
```json
{
  "tool_name": "Bash",
  "tool_input": { "command": "..." },
  "tool_use_id": "toolu_01ABC123",
  "error": "Command exited with status 1",
  "is_interrupt": false
}
```

**Output:**
```json
{
  "hookSpecificOutput": {
    "additionalContext": "context about the failure"
  }
}
```

**Added:** Core feature

---

#### Notification

**When:** Claude sends a user-facing notification (idle prompt, permission prompt, auth success, elicitation dialog).

**Matcher values:** `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`

**Hook types:** command, http, prompt, agent

**Can block:** No

**Input:**
```json
{
  "message": "notification text",
  "title": "optional title",
  "notification_type": "permission_prompt | idle_prompt | auth_success | elicitation_dialog"
}
```

**Output:**
```json
{
  "hookSpecificOutput": {
    "additionalContext": "appended to context"
  }
}
```

**Added:** Core feature

---

#### SubagentStart

**When:** A subagent is spawned (by the Task tool or automatic delegation).

**Matcher values:** Agent type (e.g., `Bash`, `Explore`, `Plan`, custom agent name)

**Hook types:** command, http, prompt, agent

**Can block:** No

**Input:**
```json
{
  "agent_id": "agent-abc123",
  "agent_type": "Explore | Bash | Plan | custom-name"
}
```

**Output:**
```json
{
  "hookSpecificOutput": {
    "additionalContext": "context injected into subagent startup"
  }
}
```

**Added:** Core feature

---

#### SubagentStop

**When:** A subagent finishes its work.

**Matcher values:** Agent type

**Hook types:** command, http, prompt, agent

**Can block:** Yes. Exit 2 prevents the subagent from stopping and forces continuation.

**Input:**
```json
{
  "agent_id": "agent-abc123",
  "agent_type": "Explore",
  "agent_transcript_path": "/path/to/agent/transcript.jsonl",
  "last_assistant_message": "subagent's final response text",
  "stop_hook_active": false
}
```

**Output:** Same as Stop event.

**Added:** Core feature

---

#### TaskCreated

**When:** A task is created via the `TaskCreate` tool (agent teams / task list feature).

**Matcher values:** None

**Hook types:** command, http, prompt, agent

**Can block:** Yes. Exit 2 rolls back the task creation. JSON `continue: false` stops the teammate.

**Input:**
```json
{
  "task_id": "task-001",
  "task_subject": "Task title",
  "task_description": "optional description text",
  "teammate_name": "optional teammate name",
  "team_name": "optional team name"
}
```

**Output (block with feedback):**
```bash
echo "Task description is too vague" >&2
exit 2
```

**Output (stop teammate):**
```json
{ "continue": false, "stopReason": "Stopping teammate" }
```

**Added:** v2.1.84

---

#### TaskCompleted

**When:** A task is marked complete.

**Matcher values:** None

**Hook types:** command, http, prompt, agent

**Can block:** Yes. Exit 2 prevents completion.

**Input:** Same as TaskCreated.

**Added:** v2.1.84

---

#### Stop

**When:** Claude finishes a response turn (the main agent, not a subagent).

**Matcher values:** None

**Hook types:** command, http, prompt, agent

**Can block:** Yes. Exit 2 prevents Claude from stopping and forces it to continue with the stderr text as new input.

**Input:**
```json
{
  "stop_hook_active": false,
  "last_assistant_message": "Claude's final response text"
}
```

`stop_hook_active` is `true` when Claude is already continuing due to a Stop hook, preventing infinite loops.

**Output (force continue):**
```bash
echo "Run the test suite to verify your changes" >&2
exit 2
```

**Output (stop normally):**
```json
{ "decision": "block", "reason": "why Claude should keep going" }
```

**Added:** Core feature

---

#### StopFailure

**When:** Claude's turn ends due to an API error (instead of the normal Stop event).

**Matcher values:** `rate_limit`, `authentication_failed`, `billing_error`, `invalid_request`, `server_error`, `max_output_tokens`, `unknown`

**Hook types:** command, http, prompt, agent

**Can block:** No (logging/notification only)

**Input:**
```json
{
  "error": "rate_limit",
  "error_details": "additional error context",
  "last_assistant_message": "API error message text"
}
```

**Added:** v2.1.78

---

#### TeammateIdle

**When:** An agent team teammate is about to go idle waiting for work.

**Matcher values:** None

**Hook types:** command, http, prompt, agent

**Can block:** Yes. Exit 2 forces the teammate to continue (stderr text becomes new instruction). `continue: false` shuts down the teammate.

**Input:**
```json
{
  "teammate_name": "researcher",
  "team_name": "my-project"
}
```

**Added:** Core feature

---

#### ConfigChange

**When:** A settings file changes during an active session.

**Matcher values:** `user_settings`, `project_settings`, `local_settings`, `policy_settings`, `skills`

**Hook types:** command, http, prompt, agent

**Can block:** Yes. Exit 2 blocks the config change (except `policy_settings` which cannot be blocked).

**Input:**
```json
{
  "source": "user_settings | project_settings | local_settings | policy_settings | skills",
  "file_path": "/path/to/settings.json"
}
```

**Added:** v2.1.49

---

#### CwdChanged

**When:** The working directory changes (e.g., user runs `cd` in Bash).

**Matcher values:** None

**Hook types:** command, http, prompt, agent

**Can block:** No

**Input:**
```json
{
  "new_cwd": "/new/directory",
  "previous_cwd": "/old/directory"
}
```

**Special feature:** `$CLAUDE_ENV_FILE` is available for persisting environment variables (same as SessionStart).

**Added:** v2.1.83

---

#### FileChanged

**When:** A watched file on disk changes.

**Matcher values:** Filename (basename only, e.g., `.envrc`, `.env`)

**Hook types:** command, http, prompt, agent

**Can block:** No

**Input:**
```json
{
  "file_path": "/absolute/path/to/file.json",
  "change_type": "modified | created | deleted"
}
```

**Special feature:** `$CLAUDE_ENV_FILE` available (same as SessionStart).

**Added:** v2.1.83

---

#### WorktreeCreate

**When:** A git worktree is about to be created.

**Matcher values:** None

**Hook types:** command, http, prompt, agent

**Can block:** Yes. Exit 2 fails the worktree creation.

**Input:**
```json
{
  "worktree_name": "feature-auth"
}
```

**Output (custom path via command hook):**
Write the desired absolute path to stdout.

**Output (custom path via HTTP hook):**
```json
{
  "hookSpecificOutput": {
    "worktreePath": "/custom/absolute/path"
  }
}
```

**Added:** v2.1.50. HTTP hook `worktreePath` support added in v2.1.84.

---

#### WorktreeRemove

**When:** A git worktree is removed.

**Matcher values:** None

**Hook types:** command, http, prompt, agent

**Can block:** No

**Input:**
```json
{
  "worktree_path": "/path/to/worktree",
  "reason": "session_exit | subagent_finish"
}
```

**Added:** v2.1.50

---

#### PreCompact

**When:** Just before context compaction runs.

**Matcher values:** `manual`, `auto`

**Hook types:** command, http, prompt, agent

**Can block:** No

**Input:**
```json
{
  "trigger": "manual | auto"
}
```

Use this to save state you want to preserve across compaction (e.g., write notes to a file that your SessionStart hook or CLAUDE.md will load).

**Added:** Core feature

---

#### PostCompact

**When:** After context compaction completes.

**Matcher values:** `manual`, `auto`

**Hook types:** command, http, prompt, agent

**Can block:** No

**Input:**
```json
{
  "trigger": "manual | auto"
}
```

Use this to inject fresh context back after compaction.

**Added:** v2.1.76

---

#### Elicitation

**When:** An MCP server requests structured user input mid-task.

**Matcher values:** MCP server name (e.g., `my-server`)

**Hook types:** command, http, prompt, agent

**Can block:** Yes. Exit 2 denies the elicitation request.

**Input:**
```json
{
  "mcp_server_name": "my-server",
  "tool_name": "mcp__my-server__some_tool",
  "form_fields": [
    { "name": "field1", "type": "text", "label": "Enter value" }
  ]
}
```

**Output:**
```json
{
  "hookSpecificOutput": {
    "action": "accept | decline | cancel",
    "content": { "field1": "auto-filled-value" }
  }
}
```

**Added:** v2.1.76

---

#### ElicitationResult

**When:** After the user responds to an MCP elicitation dialog.

**Matcher values:** MCP server name

**Hook types:** command, http, prompt, agent

**Can block:** Yes. Can modify the user's response before it reaches the MCP server.

**Input:**
```json
{
  "mcp_server_name": "my-server",
  "user_response": { "field1": "user-entered value" }
}
```

**Output:**
```json
{
  "hookSpecificOutput": {
    "action": "accept | decline | cancel",
    "content": { "field1": "modified value" }
  }
}
```

**Added:** v2.1.76

---

#### SessionEnd

**When:** Session terminates for any reason.

**Matcher values:** `clear`, `resume`, `logout`, `prompt_input_exit`, `bypass_permissions_disabled`, `other`

**Hook types:** command, http, prompt, agent

**Can block:** No

**Input:**
```json
{
  "reason": "clear | resume | logout | prompt_input_exit | bypass_permissions_disabled | other"
}
```

**Important timeout note:** SessionEnd hooks have a separate short default timeout (`CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`, default 1500ms). Set this variable to a higher value for hooks that do non-trivial work (like the Recall `SessionExtract.ts` which needs up to 90 seconds). Use `async: true` on the hook entry if you want it to continue beyond the session exit.

**Added:** Core feature

---

### Exit Code 2 Blocking Reference

| Event | Exit 2 Effect |
|---|---|
| PreToolUse | Blocks tool call; stderr is reason feedback to Claude |
| PermissionRequest | Denies permission |
| PermissionDenied | Retry tool call (with `{ "retry": true }`) |
| UserPromptSubmit | Blocks and erases prompt |
| Stop | Prevents stop; stderr becomes Claude's next input |
| SubagentStop | Prevents subagent stop |
| TeammateIdle | Forces teammate to continue; stderr is new instruction |
| TaskCreated | Rolls back task creation |
| TaskCompleted | Prevents task completion |
| ConfigChange | Blocks config change (not for policy_settings) |
| WorktreeCreate | Fails worktree creation |
| Elicitation | Denies elicitation |
| ElicitationResult | Blocks response |
| PostToolUse | Does NOT block (shows stderr only in verbose mode) |
| PostToolUseFailure | Does NOT block |
| Notification | Does NOT block |
| StopFailure | Ignored |
| SessionEnd | Does NOT block |
| All others | Does NOT block |

---

### Hook Configuration Format in settings.json

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/security-check.sh",
            "if": "Bash(rm *)",
            "timeout": 10,
            "async": false
          },
          {
            "type": "http",
            "url": "http://localhost:8080/audit",
            "headers": { "Authorization": "Bearer $AUDIT_TOKEN" },
            "allowedEnvVars": ["AUDIT_TOKEN"],
            "timeout": 5
          }
        ]
      },
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Is this file write safe and appropriate? $ARGUMENTS",
            "model": "claude-3-5-sonnet-20241022",
            "timeout": 20
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/init.sh",
            "async": true,
            "timeout": 30000
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/extract.ts",
            "timeout": 90000
          }
        ]
      }
    ]
  }
}
```

**Hook configuration locations and scope:**

| Location | Scope | Shareable |
|---|---|---|
| `~/.claude/settings.json` | All projects (user) | No |
| `.claude/settings.json` | Single project | Yes (git) |
| `.claude/settings.local.json` | Single project | No |
| `managed-settings.json` | Organization-wide | Yes (IT-deployed) |
| Plugin `hooks/hooks.json` | When plugin enabled | Yes |
| Skill/Agent YAML frontmatter | Component active | Yes |

### Timeout Behavior

- Default timeout for command hooks: 60 seconds (configurable per hook via `timeout` field, value in seconds for command hooks)
- `SessionEnd` hooks: separate short default of **1500ms** (`CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`)
- Hooks exceeding timeout are terminated (non-blocking error)
- Use `async: true` to run a hook asynchronously — it fires and Claude continues without waiting

### Hook Output Size Limits

- Hook output > 50KB is saved to a temp file on disk; Claude receives the path + a preview
- This changed from the previous 100KB limit (v2.1.63)

### Execution Order for Multiple Hooks

When multiple hooks are registered for the same event with the same matcher, they run in parallel by default within a single event entry. The order of entries in the `hooks` array is preserved, but hooks within a single entry's `hooks` array fire concurrently.

### The `--bare` Flag and Hooks

`--bare` (added v2.1.81) skips hook discovery entirely. Sessions started with `--bare` do not run any hooks. This is for scripted `-p` calls where startup overhead must be minimized. Implies `CLAUDE_CODE_SIMPLE`.

### Hooks in Subagents and Skills

Skills can define hooks scoped to their lifecycle in frontmatter:

```yaml
---
name: my-skill
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./validate.sh"
---
```

Subagents similarly support `hooks` frontmatter. These hooks fire only while that skill or agent is active.

### MCP Tool Matching

MCP tools are named `mcp__<server-name>__<tool-name>`. Use regex patterns in matcher:

- `mcp__memory__.*` — all tools from the `memory` server
- `mcp__.*__write.*` — any write-like tool from any server
- `mcp__github__create_.*` — GitHub server creation tools

---

## PART 2 — CLI FLAGS AND FEATURES

### Key CLI Flags

| Flag | Description |
|---|---|
| `--print`, `-p` | Non-interactive mode. Runs query and exits. Foundation for headless/scripted use. |
| `--bare` | Skip hooks, plugins, LSP sync, MCP auto-discovery. Requires `ANTHROPIC_API_KEY`. Implies `CLAUDE_CODE_SIMPLE`. Added v2.1.81. |
| `--continue`, `-c` | Resume most recent session in current directory. |
| `--resume`, `-r` | Resume session by ID or name. Interactive picker if no arg. |
| `--fork-session` | When resuming, create new session ID instead of reusing original. |
| `--no-session-persistence` | Print mode only. Sessions not written to disk, cannot be resumed. |
| `--name`, `-n` | Set session display name at startup (v2.1.84). |
| `--worktree`, `-w` | Start in isolated git worktree at `<repo>/.claude/worktrees/<name>`. |
| `--agent` | Specify subagent type for this session. |
| `--agent-teams` | Enable experimental agent teams (same as `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). |
| `--agents` | Define subagents dynamically via JSON. |
| `--permission-mode` | Start in specified mode: `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`. |
| `--dangerously-skip-permissions` | Equivalent to `--permission-mode bypassPermissions`. |
| `--allow-dangerously-skip-permissions` | Add bypassPermissions to Shift+Tab cycle without starting in it. |
| `--allowedTools` | Tools that execute without permission prompts this session. |
| `--disallowedTools` | Tools removed from model's context entirely. |
| `--tools` | Restrict available built-in tools (e.g., `"Bash,Edit,Read"`). |
| `--disable-slash-commands` | Disable all skills and commands for session. |
| `--system-prompt` | Replace entire system prompt. |
| `--append-system-prompt` | Append to default system prompt. |
| `--system-prompt-file` | Load replacement prompt from file. |
| `--append-system-prompt-file` | Append file contents to default prompt. |
| `--model` | Set model for session: alias (`sonnet`, `opus`) or full name. |
| `--effort` | Set effort level: `low`, `medium`, `high`, `max` (Opus 4.6 only). |
| `--max-turns` | Limit agentic turns in print mode. |
| `--max-budget-usd` | Maximum API spend in print mode. |
| `--fallback-model` | Auto-fallback when primary model is overloaded (print mode). |
| `--output-format` | Print mode output: `text`, `json`, `stream-json`. |
| `--input-format` | Input format: `text`, `stream-json`. |
| `--json-schema` | Validated JSON output matching schema (print mode, Agent SDK structured outputs). |
| `--mcp-config` | Load MCP servers from JSON file or string. |
| `--strict-mcp-config` | Only use `--mcp-config` MCP servers, ignore all others. |
| `--plugin-dir` | Load plugins from directory this session. Repeat flag for multiple. |
| `--add-dir` | Add additional working directories for file access. |
| `--setting-sources` | Comma-separated sources to load: `user`, `project`, `local`. |
| `--settings` | Path to settings JSON file or JSON string for additional settings. |
| `--verbose` | Full turn-by-turn output. |
| `--debug` | Debug mode with optional category filter (e.g., `"api,hooks"` or `"!statsig"`). |
| `--debug-file <path>` | Write debug logs to file. Enables debug mode implicitly. |
| `--remote` | Create new web session on claude.ai. |
| `--remote-control`, `--rc` | Start interactive session with Remote Control enabled. |
| `--teleport` | Resume a web session in local terminal. |
| `--from-pr` | Resume sessions linked to a GitHub PR. |
| `--session-id` | Use specific session UUID. |
| `--include-partial-messages` | Include partial streaming events (requires stream-json output). |
| `--replay-user-messages` | Re-emit user messages on stdout. |
| `--chrome` | Enable Chrome browser integration. |
| `--no-chrome` | Disable Chrome integration. |
| `--tmux` | Create tmux session for worktree (requires `--worktree`). |
| `--channels` | Listen for channel notifications from MCP servers. |
| `--teammate-mode` | Set teammate display mode: `auto`, `in-process`, `tmux`. |
| `--enable-auto-mode` | Unlock auto mode in Shift+Tab cycle. |
| `--betas` | Beta headers for API requests (API key users only). |
| `--init` | Run init hooks and start interactive mode. |
| `--init-only` | Run init hooks and exit. |
| `--maintenance` | Run maintenance hooks and exit. |

### Session Management

Sessions are stored as JSONL files in `~/.claude/projects/<hashed-path>/`.

Key behaviors:
- `transcript_path` in hook input is the full path to the session's JSONL file
- `session_id` is a UUID available in hook input and as `${CLAUDE_SESSION_ID}` in skills
- Sessions inactive longer than `cleanupPeriodDays` (default 30) are deleted at startup
- **Breaking change in v2.1.89:** `cleanupPeriodDays: 0` is now rejected with a validation error. Previously it silently disabled transcript persistence. To disable persistence, use `--no-session-persistence` in print mode.
- Session naming: use `--name` / `-n` at startup, or `/rename` mid-session
- Fork/branch a session: `--fork-session` with `--resume`, or `/branch` command (renamed from `/fork` in v2.1.77)

### Important Environment Variables for Hooks and Automation

| Variable | Purpose | Default |
|---|---|---|
| `BASH_DEFAULT_TIMEOUT_MS` | Default bash command timeout | 600000 (10min) |
| `BASH_MAX_TIMEOUT_MS` | Maximum bash timeout (model cannot exceed) | None |
| `BASH_MAX_OUTPUT_LENGTH` | Max bash output characters (middle-truncates) | Large |
| `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` | Timeout for SessionEnd hooks | 1500ms |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | Context % that triggers auto-compact | ~95 |
| `DISABLE_AUTO_COMPACT` | Disable automatic compaction | — |
| `DISABLE_COMPACT` | Disable all compaction | — |
| `CLAUDE_ENV_FILE` | Shell script to source before Bash commands | Set by runtime |
| `CLAUDE_CODE_SIMPLE` | Minimal mode (set by `--bare`) | — |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | Enable agent teams | — |
| `CLAUDE_CODE_SUBAGENT_MODEL` | Model for subagents | Inherits |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | Maximum output tokens | Model-specific |
| `ENABLE_TOOL_SEARCH` | MCP tool search: `true`, `auto`, `auto:N`, `false` | `auto` |
| `CLAUDE_BASH_NO_LOGIN` | Skip `-l` login shell flag | — |
| `CLAUDECODE` | Set to `1` in Claude-spawned shells | 1 |
| `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` | Strip credentials from subprocess environments | — |
| `MCP_CONNECTION_NONBLOCKING` | Skip MCP connection wait in `-p` mode | — |
| `ANTHROPIC_SMALL_FAST_MODEL` | **DEPRECATED** — use `ANTHROPIC_DEFAULT_HAIKU_MODEL` | — |

---

## PART 3 — SKILLS SYSTEM

### SKILL.md Format

Every skill is a directory containing `SKILL.md` as the entry point. The file format:

```yaml
---
name: skill-name
description: What this skill does and when to use it. Front-load key use case.
argument-hint: "[issue-number] [format]"
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Grep, Glob
model: claude-sonnet-4-6
effort: high
context: fork
agent: Explore
paths: "**/*.ts, src/**/*.js"
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./validate.sh"
shell: bash
---

Your skill instructions here. Use $ARGUMENTS for user-provided args.
Use ${CLAUDE_SESSION_ID} for session ID.
Use ${CLAUDE_SKILL_DIR} for this skill's directory.
Use $0, $1, $2 for positional arguments.

Inject dynamic context with backtick syntax:
Current git status: !`git status --short`
```

### Frontmatter Fields Reference

| Field | Required | Description |
|---|---|---|
| `name` | No | Slash-command name. If omitted, uses directory name. Lowercase, numbers, hyphens, max 64 chars. |
| `description` | Recommended | What the skill does and when to use it. Descriptions >250 chars are truncated in listings. Claude uses this for auto-invocation decisions. |
| `argument-hint` | No | Shown in autocomplete to indicate expected arguments (e.g., `[issue-number]`). |
| `disable-model-invocation` | No | `true` = only user can invoke. Removes from Claude's context entirely. Use for side-effect workflows like `/deploy`, `/commit`. |
| `user-invocable` | No | `false` = hides from `/` menu. Claude can still invoke it. Use for background knowledge skills. |
| `allowed-tools` | No | Tools Claude can use without permission prompts when skill is active. |
| `model` | No | Override model for this skill's execution. |
| `effort` | No | Override effort level: `low`, `medium`, `high`, `max` (Opus 4.6 only). Added v2.1.78. |
| `context` | No | Set to `fork` to run skill in isolated subagent context. |
| `agent` | No | Which subagent type to use when `context: fork`. Options: built-in types (`Explore`, `Plan`, `general-purpose`) or any custom agent name. |
| `hooks` | No | Hooks scoped to this skill's lifecycle. Full hook configuration format. |
| `paths` | No | Glob patterns (comma-separated string or YAML list) limiting when Claude auto-loads this skill. Only active when working with matching files. |
| `shell` | No | Shell for `!`` command `` ` ` blocks: `bash` (default) or `powershell`. |

### String Substitutions

| Variable | Description |
|---|---|
| `$ARGUMENTS` | All arguments passed at invocation. Appended as `ARGUMENTS: <value>` if not present. |
| `$ARGUMENTS[N]` | Zero-based argument index (e.g., `$ARGUMENTS[0]` = first arg). |
| `$N` | Shorthand for `$ARGUMENTS[N]` (e.g., `$0`, `$1`). |
| `${CLAUDE_SESSION_ID}` | Current session UUID. |
| `${CLAUDE_SKILL_DIR}` | Absolute path to this skill's directory. Use to reference bundled scripts. |

### Skill Resolution Order

Priority (highest to lowest): Enterprise (managed) > Personal (`~/.claude/skills/`) > Project (`.claude/skills/`) > Plugin (namespaced `plugin-name:skill-name`).

When a skill and legacy command share the same name, the skill takes precedence.

Skills from `--add-dir` directories are loaded from `.claude/skills/` within that directory (exception to the rule that `--add-dir` only grants file access).

### Skills vs. Legacy Commands

`.claude/commands/` files are fully supported and work identically to skills. Skills add:
- Directory structure for supporting files
- `context: fork` for isolated subagent execution
- `paths` for file-pattern-based auto-loading
- `hooks` frontmatter for lifecycle hooks
- `user-invocable`, `disable-model-invocation` control

### Invocation Control Matrix

| Frontmatter | User can invoke | Claude can invoke | In Claude's context |
|---|---|---|---|
| (default) | Yes | Yes | Description always |
| `disable-model-invocation: true` | Yes | No | Never |
| `user-invocable: false` | No | Yes | Description always |

Note: `user-invocable` only controls menu visibility, not Skill tool access.

### Restricting Skill Access

```
# Deny all skills
Skill

# Allow only specific skills
Skill(commit)
Skill(review-pr *)

# Deny specific skills
Skill(deploy *)
```

---

## PART 4 — MCP INTEGRATION

### Registration Locations

| File | Scope | How to add |
|---|---|---|
| `~/.claude.json` | User (all projects) | `claude mcp add --scope user` |
| `.mcp.json` | Project (git-tracked) | `claude mcp add --scope project` |
| `~/.claude.json` (per-project entry) | Local (this project, this user) | `claude mcp add --scope local` |
| `managed-mcp.json` | Managed (org-wide) | IT-deployed to system directory |

### Scope Hierarchy for MCP

Managed settings take precedence. When `allowManagedMcpServersOnly: true` is set, only the admin-defined allowlist applies even though users can still add servers.

`deniedMcpServers` (added in managed settings) blocks servers at any scope including managed servers themselves. As of v2.1.85, it also blocks claude.ai MCP servers.

### settings.json MCP-Related Keys

```json
{
  "enableAllProjectMcpServers": true,
  "enabledMcpjsonServers": ["memory", "github"],
  "disabledMcpjsonServers": ["filesystem"],
  "mcpServers": {
    "my-server": {
      "command": "bun",
      "args": ["run", "/path/to/server.ts"]
    }
  }
}
```

Note: `mcpServers` in `settings.json` registers servers at the user scope (equivalent to `~/.claude.json`). Project-scope servers must be in `.mcp.json`.

### Tool Naming Convention

MCP tools are exposed as `mcp__<server-name>__<tool-name>`.

In hooks, match them with:
- `mcp__memory__memory_search` — exact tool
- `mcp__memory__.*` — all tools from memory server
- `mcp__.*` — all MCP tools

In permissions:
```
"MCP(memory:memory_search)"
"MCP(memory:*)"
```

### How Hooks Interact with MCP Tools

PreToolUse and PostToolUse hooks fire for MCP tool calls the same as built-in tools. The `tool_name` will be the full `mcp__server__tool` string.

PostToolUse can return `hookSpecificOutput.updatedMCPToolOutput` to replace the MCP tool's output as seen by Claude — useful for filtering sensitive data out of responses before Claude processes them.

The Elicitation and ElicitationResult hooks are specifically for MCP server interactions (when an MCP server uses the MCP elicitation protocol to request user input).

### Dynamic Tool Updates

When an MCP server's tool list changes while Claude Code is running, Claude Code picks up the changes without restart (live discovery). Push messages via channels allow MCP servers to proactively notify Claude Code.

---

## PART 5 — BREAKING CHANGES AND DEPRECATIONS (v2.1.50–v2.1.89)

### Breaking Changes (Requires Action)

| Version | Change | Migration |
|---|---|---|
| v2.1.89 | `cleanupPeriodDays: 0` now rejected with validation error | Use `--no-session-persistence` in print mode instead |
| v2.1.84 | `--plugin-dir` accepts only one path per flag | Use repeated `--plugin-dir A --plugin-dir B` |
| v2.1.75 | Windows managed settings at `C:\ProgramData\ClaudeCode\` no longer supported | Migrate to `C:\Program Files\ClaudeCode\managed-settings.json` |
| v2.1.72 | `TaskOutput` tool removed | Use `Read` on the background task's output file path |
| v2.1.72 | Agent tool no longer accepts `resume` parameter | Use `SendMessage({to: agentId})` |
| v2.1.81 | `--mcp-config` flag now enforces `allowedMcpServers`/`deniedMcpServers` | Previously bypassed these rules |

### Deprecated Features

| Version | Feature | Replacement |
|---|---|---|
| v2.1.89 | Thinking summaries shown by default in interactive sessions | Set `showThinkingSummaries: true` to restore |
| v2.1.77 | `/output-style` command | Use `/config` instead |
| v2.1.77 | `/fork` command | Renamed to `/branch` (alias still works) |
| v2.1.72 | Effort level `max` | Now only available on Opus 4.6 |
| Pre-v2.1.89 | `ANTHROPIC_SMALL_FAST_MODEL` env var | Use `ANTHROPIC_DEFAULT_HAIKU_MODEL` |
| Pre-v2.1.89 | `includeCoAuthoredBy` setting | Use `attribution` object instead |
| Pre-v2.1.89 | Legacy PreToolUse `decision: "approve"/"block"` at top level | Use `hookSpecificOutput.permissionDecision: "allow"|"deny"|"ask"` |

### New Hook Events by Version

| Hook Event | Added |
|---|---|
| WorktreeCreate, WorktreeRemove | v2.1.50 |
| ConfigChange | v2.1.49 |
| InstructionsLoaded | v2.1.69 |
| Elicitation, ElicitationResult | v2.1.76 |
| PostCompact | v2.1.76 |
| StopFailure | v2.1.78 |
| CwdChanged, FileChanged | v2.1.83 |
| TaskCreated, TaskCompleted | v2.1.84 |
| PermissionDenied | v2.1.89 |

### Notable New Settings (v2.1.50–v2.1.89)

| Setting | Added | Purpose |
|---|---|---|
| `showThinkingSummaries` | v2.1.89 | Restore thinking summaries in interactive mode |
| `worktree.sparsePaths` | v2.1.76 | Git sparse-checkout for large monorepos |
| `worktree.symlinkDirectories` | v2.1.76 | Symlink dirs from main repo into worktrees |
| `autoMemoryDirectory` | v2.1.75 | Custom auto-memory storage location |
| `feedbackSurveyRate` | v2.1.76 | Enterprise survey sample rate (0–1) |
| `sandbox.failIfUnavailable` | v2.1.84 | Exit on startup if sandbox cannot start |
| `allowedChannelPlugins` | v2.1.84 | Channel plugin allowlist (managed only) |
| `sandbox.enableWeakerNetworkIsolation` | v2.1.83 | macOS TLS trust service access |
| `disableDeepLinkRegistration` | v2.1.83 | Prevent `claude-cli://` protocol registration |
| `pluginTrustMessage` | v2.1.83 | Custom org message in plugin trust dialog |
| `includeGitInstructions` | v2.1.78 | Remove built-in git workflow instructions |
| `modelOverrides` | v2.1.73 | Map model picker entries to custom provider IDs |
| `allowedHttpHookUrls` | v2.1.63+ | Allowlist URL patterns for HTTP hooks |
| `httpHookAllowedEnvVars` | v2.1.63+ | Allowlist env vars for HTTP hook headers |
| `allowManagedHooksOnly` | Managed | Block non-managed hooks |

### File Format and Data Changes

- v2.1.86: Skill descriptions capped at 250 characters in listings
- v2.1.86: MCP tool descriptions and server instructions capped at 2KB
- v2.1.86: Read tool now uses compact line-number format; deduplicates unchanged re-reads
- v2.1.83: Hook output >50KB saved to disk (previously 100KB threshold from v2.1.63)
- v2.1.86: Token counts >=1M display as "1.5m" instead of "1512.6k"
- v2.1.89: `Edit/Read` permission rules using `//path/**` now check resolved symlink targets
- v2.1.85: PreToolUse can return `updatedInput` alongside `permissionDecision: "allow"`
- v2.1.89: `X-Claude-Code-Session-Id` header added to all API requests (added v2.1.86)

---

## Quick Reference: Hook Event Summary Table

| Event | Fires When | Matcher | Can Block | Types | Added |
|---|---|---|---|---|---|
| SessionStart | Session begins/resumes | `startup` `resume` `clear` `compact` | No | command | Core |
| InstructionsLoaded | CLAUDE.md loaded | load reason | No | all | v2.1.69 |
| UserPromptSubmit | User submits prompt | None | Yes | all | Core |
| PreToolUse | Before tool runs | tool name | Yes | all | Core |
| PermissionRequest | Permission dialog | tool name | Yes | all | Core |
| PermissionDenied | Auto mode denies | tool name | Yes (retry) | all | v2.1.89 |
| PostToolUse | After tool succeeds | tool name | Yes (feedback) | all | Core |
| PostToolUseFailure | After tool fails | tool name | No | all | Core |
| Notification | Notification sent | notification type | No | all | Core |
| SubagentStart | Subagent spawned | agent type | No | all | Core |
| SubagentStop | Subagent finishes | agent type | Yes | all | Core |
| TaskCreated | Task created | None | Yes | all | v2.1.84 |
| TaskCompleted | Task completed | None | Yes | all | v2.1.84 |
| Stop | Claude finishes turn | None | Yes | all | Core |
| StopFailure | API error ends turn | error type | No | all | v2.1.78 |
| TeammateIdle | Teammate going idle | None | Yes | all | Core |
| ConfigChange | Config file changes | config source | Yes | all | v2.1.49 |
| CwdChanged | Directory changes | None | No | all | v2.1.83 |
| FileChanged | File on disk changes | filename | No | all | v2.1.83 |
| WorktreeCreate | Worktree creation | None | Yes | all | v2.1.50 |
| WorktreeRemove | Worktree removed | None | No | all | v2.1.50 |
| PreCompact | Before compaction | `manual` `auto` | No | all | Core |
| PostCompact | After compaction | `manual` `auto` | No | all | v2.1.76 |
| Elicitation | MCP requests input | server name | Yes | all | v2.1.76 |
| ElicitationResult | User responds to MCP | server name | Yes | all | v2.1.76 |
| SessionEnd | Session terminates | exit reason | No | all | Core |

---

Sources:
- [Hooks reference](https://code.claude.com/docs/en/hooks.md)
- [Skills reference](https://code.claude.com/docs/en/skills.md)
- [CLI reference](https://code.claude.com/docs/en/cli-reference.md)
- [Settings reference](https://code.claude.com/docs/en/settings.md)
- [Environment variables reference](https://code.claude.com/docs/en/env-vars.md)
- [MCP documentation](https://code.claude.com/docs/en/mcp.md)
- [Changelog](https://code.claude.com/docs/en/changelog.md)
- [Claude Code hooks mastery examples](https://github.com/disler/claude-code-hooks-mastery)
- [Hooks power user guide](https://claude.com/blog/how-to-configure-hooks)
