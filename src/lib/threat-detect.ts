// Single-source seam for injection/exfil threat detection (#156) on the CLI + MCP
// (src/) side — mirrors src/lib/write-safety.ts exactly.
//
// The ONE authoritative pattern table, entropy detector, and per-path policy live
// in hooks/lib/threat-detect.ts (self-contained, no src/ import). There is
// intentionally NO second copy: src/ re-exports the canonical implementation so
// the CLI (import-legacy) and MCP (memory_add) write paths share that exact table
// and policy with zero drift (a drifting threat-detection table would be a hole).
//
// Direction: src/ -> hooks/ is permitted by the project boundary rule; only the
// reverse is forbidden, so the canonical file stays in hooks/ and this seam
// imports from it. Import threat detection from HERE on the src/ side — never
// reach into hooks/ directly and never duplicate the table.
//
// This is a SEPARATE layer from scrub() (write-safety.ts): scrub redacts known
// secrets; this layer flags injection/exfil prose and redacts/blocks anchorless
// high-entropy tokens. The two do not overlap and neither modifies the other.
export {
  detectThreats,
  scanForThreats,
  isHighEntropyToken,
  shannonEntropy,
  longestLetterRun,
  type ThreatCategory,
  type ThreatSeverity,
  type ThreatAction,
  type IngestionPath,
  type ThreatFinding,
  type ResolvedThreat,
  type ThreatScanResult,
} from '../../hooks/lib/threat-detect.js';
