// Single-source seam for injection/exfil threat detection (#156) on the CLI + MCP
// (src/) side — mirrors src/lib/write-safety.ts exactly.
//
// The ONE authoritative pattern table + entropy detector lives in
// hooks/lib/threat-detect.ts (self-contained, no src/ import). There is
// intentionally NO second copy: src/ re-exports the canonical implementation so
// the CLI (import-legacy) and MCP (memory_add) write paths share that exact table
// with zero drift (a drifting threat-detection table would be a hole).
//
// Direction: src/ -> hooks/ is permitted by the project boundary rule; only the
// reverse is forbidden, so the canonical file stays in hooks/ and this seam
// imports from it. Import threat detection from HERE on the src/ side — never
// reach into hooks/ directly and never duplicate the table.
//
// This is a SEPARATE, DETECT-AND-SURFACE layer from scrub() (write-safety.ts):
// scrub redacts known-prefix secrets; this layer only FLAGS injection/exfil prose
// and anonymous high-entropy tokens. It never mutates or blocks content, so the
// two layers do not overlap and neither modifies the other.
export {
  detectThreats,
  summarizeThreats,
  isHighEntropyToken,
  shannonEntropy,
  longestLetterRun,
  type ThreatCategory,
  type ThreatFinding,
} from '../../hooks/lib/threat-detect.js';
