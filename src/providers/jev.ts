// Canonical scorer lives in hooks/lib/jev.ts. Hooks must not import src/.
export {
  JEV_KEY_ENV,
  applyChoices,
  jevCounts,
  scoreCandidate,
  scoreCandidates,
} from '../../hooks/lib/jev.js';
export type {
  JevBatchCandidate,
  JevBatchResult,
  JevCandidate,
  JevCounts,
  JevDecision,
  JevDisposition,
  ScoreCandidateOptions,
  ScoreCandidatesOptions,
} from '../../hooks/lib/jev.js';
