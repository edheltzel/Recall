# Troubleshooting

← [Back to README](../README.md)

## First Step: Run Doctor

```bash
mem doctor
```

This checks all subsystems: database, MCP registration, hooks, extraction tracker, CLI paths, and Ollama. **Start here before debugging individual issues.**

## Common Issues

### "Database not found"

```bash
mem init
```

Re-initializes the database. Safe to re-run — won't destroy existing data.

### "L0 identity tier is empty at session start"

The `RecallStart` hook loads `identity.md` for the L0 tier. If you've never
written one, the L0 section of your session-start context is empty.

```bash
mem onboard                 # Interactive interview — creates identity.md
mem benchmark run B         # Confirm v2_l0_chars > 0 after onboarding
```

If onboard writes to the wrong location, check for `RECALL_IDENTITY_PATH` in
your shell env and for a stale project-local `./.atlas-recall/identity.md`
(which takes precedence over the global file).

### "My identity.md was silently truncated"

`RecallStart` hard-caps L0 at `MAX_L0_CHARS = 1200` on read and appends
`[identity truncated — edit <path> to shorten]`. Trim your identity file or
re-run `mem onboard --print` to preview length before writing.

### "Bun install fails — unzip required" (Linux only)

```bash
sudo apt-get install -y unzip
```

Then re-run `./install.sh`.

### "Fabric extraction failed"

Fabric is optional — only needed for `mem loa write` and `mem dump`. Core functionality (search, add, MCP tools) works without it. 

Verify Fabric works:

```bash
echo "test" | fabric --pattern extract_wisdom
```

If Fabric isn't installed, Recall falls back to an inline extraction prompt (lower quality but functional).

### "MCP server not connecting"

1. Run diagnostics: `mem doctor`
2. Check config: `grep recall-memory ~/.claude/settings.json`
3. Verify PATH: `which mem-mcp`
4. Test manually: `mem-mcp` (should hang waiting for stdin — Ctrl+C to exit)
5. Restart Claude Code

The MCP server is registered in `~/.claude/settings.json` under `mcpServers` (user scope).

### "MCP worked yesterday but broke after I restarted Claude Code"

The MCP entry in `settings.json` is an absolute path to
`~/.claude/install/global/node_modules/recall/dist/mcp-server.js`
(via a symlink at `~/.bun/bin/mem-mcp`). If the symlink is gone or
stale, the running `mem-mcp` process keeps the deleted inode open —
so the current session works, but the next Claude Code restart can't
spawn a fresh MCP server and it silently fails.

Common causes:
- `bun unlink`, `bun upgrade`, or `npm` clean-up removed the symlink
- An older `./update.sh` (pre-0.7.21) didn't re-run `bun link` after
  rebuild, leaving the symlink stale after `bun install` pruning
- `./update.sh` was run from a git worktree instead of the main
  checkout, redirecting the global `recall` registry to the worktree
  — which then vanished when the worktree was removed

**Repair:**

```bash
cd /path/to/Recall       # the MAIN checkout, not a worktree
bun install && bun run build && bun link
ls -la ~/.bun/bin/mem ~/.bun/bin/mem-mcp    # verify symlinks exist
# Restart Claude Code
```

Or, from a shell:

```bash
cd /path/to/Recall
./update.sh --force --no-confirm
```

Starting in **0.7.21**, `./update.sh` runs `bun link` after every
rebuild. Starting in **0.7.22**, it also *verifies* that the bin
symlinks resolve to readable files after linking — so a silent
`bun link` no-op now surfaces with a diagnostic instead of reporting
"[OK] Re-linked" while the bin dir stayed stale.

### "Session extraction not running"

1. Run diagnostics: `mem doctor`
2. Check hook registered: `grep RecallExtract ~/.claude/settings.json`
3. Check hook file exists: `ls ~/.claude/hooks/RecallExtract.ts`
4. Check bun accessible: `which bun` (hooks resolve bun dynamically — not hardcoded)
5. Check claude CLI available: `which claude`

Extraction hooks fire on the `Stop` event. If the hook isn't registered in `settings.json`, re-run `./install.sh`.

### "Embedding service unavailable"

Embeddings are optional. Hybrid search falls back to FTS5-only automatically.

To enable semantic search:

```bash
ollama pull nomic-embed-text
curl http://localhost:11434/api/tags   # Verify Ollama is running
```

Set `OLLAMA_URL` environment variable if Ollama runs on a different host (default: `http://localhost:11434`).

### "Command not found: mem"

The `mem` CLI is linked globally via `bun link`, producing a symlink
at `~/.bun/bin/mem` → the Recall checkout's `dist/index.js`. If that
symlink is missing or stale:

```bash
cd /path/to/Recall       # the MAIN checkout, not a worktree
bun install && bun run build && bun link
ls -la ~/.bun/bin/mem    # verify
mem --version            # should print X.Y.Z (e.g. "0.7.22")
```

If `mem --version` still fails, confirm `~/.bun/bin` is on your PATH:

```bash
echo $PATH | tr ':' '\n' | grep bun
```

Add to your shell init if missing:

```bash
# fish
set -U fish_user_paths $HOME/.bun/bin $fish_user_paths

# bash/zsh
export PATH="$HOME/.bun/bin:$PATH"
```

**Recovery via update.sh** (0.7.22+ verifies the symlink
post-rebuild and fails loudly if linking silently no-ops):

```bash
cd /path/to/Recall
./update.sh --force --no-confirm
```

See also: ["MCP worked yesterday but broke after I restarted Claude Code"](#mcp-worked-yesterday-but-broke-after-i-restarted-claude-code)
for the `mem-mcp` counterpart — same root cause, same repair path.
