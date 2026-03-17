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

### "Session extraction not running"

1. Run diagnostics: `mem doctor`
2. Check hook registered: `grep SessionExtract ~/.claude/settings.json`
3. Check hook file exists: `ls ~/.claude/hooks/SessionExtract.ts`
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

The `mem` CLI is linked globally via `bun link`. If the link broke:

```bash
cd /path/to/Recall
bun link
```

Or check that bun's global bin directory is on your PATH:

```bash
echo $PATH | tr ':' '\n' | grep bun
```
