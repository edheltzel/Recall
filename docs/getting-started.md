← [Back to README](../README.md)

# Getting Started

This is the first-run tutorial for Recall: install it, find the database, start a session, and see how MCP, hooks, and skills get wired. For prerequisites, uninstall, and environment variables see [Installation](installation.md). For every flag see the [CLI Reference](cli-reference.md).

Recall ships two binaries: `recall` (CLI) and `recall-mcp` (MCP server). The MCP server name is `recall-memory`. Do not rename them.

---

## 1. Install

Recall requires [Bun](https://bun.sh) (`bun:sqlite` and Bun-native hooks). Put Bun on `PATH` first.

Install binaries and the database once:

```bash
bun install -g recall-memory
recall init
```

Then attach each harness with its **native plugin or extension** when it has one. The installer script is not the preferred path for Claude Code, Codex, Pi, or omp. Commands and ownership are in the README Quick Start table and the per-host guides: [Claude](CLAUDE_INTEGRATION.md), [Codex](CODEX_INTEGRATION.md), [Pi](PI_INTEGRATION.md), [omp](OMP_INTEGRATION.md).

| Harness | Preferred attach |
| --- | --- |
| Claude Code | `claude plugin marketplace add /absolute/path/to/Recall` then `claude plugin install recall@recall-marketplace`. Hooks still need `recall install`. |
| Codex | `codex plugin marketplace add /absolute/path/to/Recall` then `codex plugin add recall@recall-marketplace`. |
| Pi | `pi install npm:recall-memory`, then MCP adapter/config (`recall install --yes` coordinates that). |
| omp | Native skills at `~/.omp/agent/skills/recall-*` (`recall install` when `omp` is detected). |
| Grok | `recall install` / `./install.sh` only — no plugin path. See [Grok Integration](GROK_INTEGRATION.md). |
| Cursor | Merge `templates/cursor/` snippets. No marketplace plugin. |

`recall install` (or `./install.sh` from source) still runs installer-owned setup for Claude hooks, Grok, OpenCode, omp skill links, and Pi's MCP adapter. Prefer `bun install -g`: with `npm install -g`, the `#!/usr/bin/env bun` shebang depends on Bun being on PATH (nvm/fnm shells can hide it).

```bash
# Source checkout (builds from the working tree, then the same installer-owned setup)
git clone https://github.com/edheltzel/Recall.git
cd Recall
./install.sh
```

Do not clone into `/tmp` — `bun link` points back at the checkout.

After any attach, **restart each configured agent** so it loads the plugin, extension, or snippets.

Which command when (npm vs source, re-install, custom DB path) lives in [Managing Recall](lifecycle.md).

---

## 2. Where the database lives

Recall has one install root: `~/.agents/Recall`. The runtime tree is not relocatable.

| Path | What it is |
|------|------------|
| `~/.agents/Recall/recall.db` | SQLite database (WAL mode). The only query surface. |
| `~/.agents/Recall/MEMORY/identity.md` | Canonical L0 identity file (`recall onboard` writes this). |
| `~/.agents/Recall/shared/hooks/` | Canonical lifecycle hook scripts |
| `~/.agents/Recall/shared/skills/` | Canonical `recall-*` Agent Skill bodies |
| `~/.agents/Recall/backups/` | Install/update/export snapshots |

Override the database with `RECALL_DB_PATH` (legacy `MEM_DB_PATH` is still honored when `RECALL_DB_PATH` is unset). That moves the SQLite file only; it does not move the install root.

Print every resolved path on this machine:

```bash
recall path
recall path --json
```

If the database file is missing, `recall init` creates the schema. It is safe to re-run.

---

## 3. Verify the install

```bash
which recall recall-mcp     # both binaries on PATH
ls -la ~/.agents/Recall/recall.db
recall stats                # record counts (zeros on a fresh install)
recall doctor               # health check: database, MCP, hooks, embeddings
```

`recall doctor` is the authoritative check. Run it first whenever something looks wrong. `recall doctor --fix` repairs missing or drifted install-layout symlinks only; it does not touch data.

---

## 4. Seed your identity, then start a session

Supported session-start hosts inject two tiers: **L0 identity** (who you are) and **L1 top records** (importance-ranked memory). Without an identity file, L0 is empty and every new session has to re-learn the basics.

```bash
recall onboard                 # 7-question interview; writes identity.md
recall onboard --print --yes   # preview the rendered markdown, write nothing
recall onboard --project       # write ./.atlas-recall/identity.md instead
```

Use `|` (not `,`) to separate values so a phrase like `no force-push, ever` stays one entry. Re-run whenever your role, projects, or working preferences change. Files over 1200 characters are truncated at load.

An existing user-owned `~/.claude/MEMORY/identity.md` remains authoritative; otherwise the canonical file is `~/.agents/Recall/MEMORY/identity.md`. `RECALL_IDENTITY_PATH` overrides both. Full precedence is in [CLI Reference → Identity & Onboarding](cli-reference.md#identity--onboarding).

Preview what a host would inject:

```bash
recall start                     # markdown L0/L1 bundle
recall start --format cursor     # Cursor sessionStart wrapper: { "additional_context": "..." }
```

Empty DB plus missing `identity.md` still exits 0, with a short degrade line.

Then **open a new session in your agent**. What happens next depends on the host:

| Host | Session-start injection | How it starts |
|------|-------------------------|---------------|
| Claude Code | Yes — installer-owned `RecallStart` SessionStart hook | Preferred: native plugin for skills/MCP ([Claude Integration](CLAUDE_INTEGRATION.md)), plus `recall install` for hooks. Restart Claude Code. |
| Codex CLI | Yes — plugin `SessionStart` → `additionalContext` | Preferred: native plugin ([Codex Integration](CODEX_INTEGRATION.md)), then start a Codex session. |
| Cursor | Beta — `sessionStart` `{ additional_context }` | Merge the snippets under `templates/cursor/`. The hook command is unqualified `recall start --format cursor`. Cursor.app GUI PATH typically lacks `~/.bun/bin`, so the hook is a no-op until `recall` is on that app PATH. CLI Cursor, or a shell where `recall` resolves, is fine. Durable GUI PATH / `recall start --format cursor` accuracy is pending FM-321/327 — this table describes the as-built unqualified command, not that future fix. |
| Pi | Beta — `before_agent_start` | Preferred: `pi install npm:recall-memory`. See [Pi Integration](PI_INTEGRATION.md). |
| OpenCode | No verified compaction injection | MCP + skills + `session.idle` capture. See [OpenCode Integration](OPENCODE_INTEGRATION.md). |
| Grok | No automatic injection | Capture is installer-owned; search via MCP. See [Grok Integration](GROK_INTEGRATION.md). |
| JCode | No | MCP and skills only. See [JCode Integration](JCODE_INTEGRATION.md). |

---

## 5. How MCP and hooks get wired

`recall install` (or `./install.sh`) wires **installer-owned** hosts: Claude hooks, Grok, OpenCode, omp skill links, and Pi's MCP adapter/config. Claude, Codex, and Pi skills/MCP/extensions prefer the native plugin or package. You do not register MCP or hooks by hand unless you are on a host neither the plugin nor the installer owns.

### MCP (`recall-mcp`)

The server is named `recall-memory`. The spawned command is the `recall-mcp` binary (installer-managed Claude entries typically run `bun run <path-to-recall-mcp>` and pass `env.RECALL_DB_PATH`).

It exposes nine tools against the same SQLite file as the CLI:

`memory_search`, `memory_hybrid_search`, `memory_recall`, `context_for_agent`, `memory_add`, `memory_stats`, `loa_show`, `memory_dump`, `decision_update`

Per-host registration:

- **Claude Code** — preferred: plugin MCP (`plugin:recall:recall-memory`). Without the plugin, user-scope `mcpServers["recall-memory"]` in `~/.claude/settings.json` (and/or `~/.claude.json`). With the plugin active, the installer removes the duplicate user-scope entry.
- **Pi** — preferred: native package for extensions/skills; MCP is still `pi-mcp-adapter` + `~/.pi/agent/mcp.json` (installer can write the owned entry).
- **omp** — no MCP registration. Native skills only; see [omp Integration](OMP_INTEGRATION.md).
- **OpenCode / Grok** — installer writes the host's MCP config when that CLI is detected.
- **Codex** — `.mcp.json` inside the native plugin (`command: recall-mcp`). `install.sh` does not duplicate it.
- **Cursor** — snippets only. Copy/merge `templates/cursor/mcp.json` (`"command": "recall-mcp"`). No marketplace plugin.

Full tool reference: [MCP Tools](mcp-tools.md).

### Lifecycle hooks

On Claude Code, the installer copies canonical hooks to `~/.agents/Recall/shared/hooks/`, links them into `~/.claude/hooks/`, and registers them in `~/.claude/settings.json`:

| Event | Hook | What it does |
|-------|------|----------------|
| `SessionStart` | `RecallStart.ts` | Injects L0 identity + L1 top records (same assembler as `recall start`) |
| `SessionStart` | `RecallTelosSync.ts` | PAI TELOS auto-import when that directory exists; otherwise exits immediately |
| `Stop` | `RecallExtract.ts` | Extracts the session into SQLite in the background |
| `PreCompact` | `RecallPreCompact.ts` | Flushes in-flight messages before compaction |
| `PostToolUse` / `UserPromptSubmit` | `RecallInSession.ts` | Mid-session loop and correction capture; both default OFF |

Other hosts:

- **Codex** — plugin hooks (`SessionStart`, `Stop`, `PreCompact`, `PostCompact`, `SessionEnd`) write through `recall host-hook` internally. You do not invoke that command.
- **Grok** — installer-owned `~/.grok/hooks/RecallLifecycle.json` → `recall host-hook grok`. Capture only; no session-start injection.
- **OpenCode / Pi** — native plugins/extensions drop transcripts for the shared batch extractor (`RecallBatchExtract.ts`). Optional cron is printed at the end of install; nothing is auto-scheduled.
- **Cursor** — merge `templates/cursor/hooks.json`. Command stays `recall start --format cursor`. Cursor is not a `recall host-hook` host.

### Agent skills (`recall-*`)

Claude, Codex, and Pi load skills from their native plugin/package. omp loads them from `~/.omp/agent/skills/recall-*`. The installer still links canonicals for hosts without a plugin attach. In Claude Code, invoke them as slash skills — the hyphenated names are the skill names:

| Skill | Slash | What it wraps |
|-------|-------|----------------|
| `recall-dump` | `/recall-dump Session Title` | `recall dump` — flush this session + LoA entry |
| `recall-search` | `/recall-search kubernetes auth` | `recall search` |
| `recall-recent` | `/recall-recent` | `recall recent` |
| `recall-scout` | `/recall-scout [focus]` | memory-first repo scout |
| `recall-stats` | `/recall-stats` | `recall stats` |
| `recall-add` | `/recall-add` | `recall add` (decision / learning / breadcrumb) |
| `recall-doctor` | `/recall-doctor` | `recall doctor` |
| `recall-update` | `/recall-update` | version check only; it does not run `update.sh` |
| `recall-loa` | `/recall-loa` | browse LoA entries |

`/recall-dump` is user-invoked only. Skill reference: [Agent Skills](agent-skills.md).

---

## 6. First commands

Once the agent is restarted and identity is seeded:

```bash
recall "kubernetes auth"                 # hybrid search (keyword + semantic; default)
recall search "kubernetes auth"          # FTS5 keyword search
recall search "auth" -t decisions        # hard-filter to decisions
recall recent                            # recent records across tables
recall add decision "Use SQLite" -w "Zero-config, local-first"
recall add learning "Port 4000 busy" "Kill the process or change the port"
recall add breadcrumb "Auth refactor in progress" -i 8
recall dump "First Recall session"       # persist this session + LoA entry
recall loa list
recall stats
```

Bare `recall "query"` is hybrid search. Use `recall "query" -k` for keyword-only, `recall "query" -v` or `recall semantic "query"` for vector-only (needs Ollama). There is no `recall embed semantic` verb — embeddings are `recall embed backfill` / `recall embed stats` / `recall embed reindex`.

From inside Claude Code, the same workflows are the `/recall-*` skills above. MCP tools (`memory_search`, `memory_add`, `memory_dump`, …) are what the model calls mid-session.

---

## Next

| Guide | When to open it |
|-------|-----------------|
| [Installation](installation.md) | Prerequisites, session extraction, uninstall, env vars |
| [Managing Recall](lifecycle.md) | Install vs update vs uninstall, custom DB path, recovery |
| [CLI Reference](cli-reference.md) | Every subcommand and flag |
| [MCP Tools](mcp-tools.md) | Tool schemas for agents |
| [Agent Skills](agent-skills.md) | Canonical `/recall-*` skill bodies |
| [Harness API](api.md) | Thin `recall-memory/api` surface: start / drop / capture / inject |
| [Troubleshooting](troubleshooting.md) | Start with `recall doctor` |
| [Claude](CLAUDE_INTEGRATION.md) · [Codex](CODEX_INTEGRATION.md) · [Pi](PI_INTEGRATION.md) · [omp](OMP_INTEGRATION.md) · [Grok](GROK_INTEGRATION.md) · [JCode](JCODE_INTEGRATION.md) · [OpenCode](OPENCODE_INTEGRATION.md) | Host-specific wiring |
