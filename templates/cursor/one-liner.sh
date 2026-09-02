# Tiny Cursor inject wire. Does not auto-install. Merge into ~/.cursor/hooks.json
# (idempotent — do not clobber other hooks). MCP command is recall-mcp, never mem-mcp.
# Cursor.app GUI PATH typically lacks ~/.bun/bin, so sessionStart is a no-op until
# `recall` is on that app PATH. CLI Cursor / a shell where `recall` resolves is fine.
recall start --format cursor
