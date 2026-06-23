// Single-source seam for the write-safety scrub on the CLI + MCP (src/) side.
//
// The ONE authoritative secret-pattern table and scrub()/redactSecrets()/
// stripInvisibleUnicode() live in hooks/lib/write-safety.ts — load-bearing on the
// Stop-hook extraction path. There is intentionally NO second copy: src/ re-exports
// the canonical implementation so the CLI and MCP write paths share that exact table
// with zero drift (a drifting security pattern table would be a real hole).
//
// Direction: src/ -> hooks/ is permitted by the project boundary rule; only the
// reverse (hooks/ -> src/) is forbidden, so the canonical file stays in hooks/ and
// this seam imports from it. tsconfig rootDir is "." so tsc can type-check this
// cross-directory import; the npm build is entry-driven (tsup), so dist/ is unchanged.
//
// This is the import surface for any src/ consumer that needs scrub (e.g. #51/#156
// when secret redaction is wired into the CLI/MCP write paths) — import from here,
// never reach into hooks/ directly and never duplicate the table.
export { scrub, redactSecrets, stripInvisibleUnicode } from '../../hooks/lib/write-safety.js';
