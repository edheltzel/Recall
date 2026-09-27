// Single-source seam. Canonical runner lives in hooks/lib/harness-runner.ts.
export {
  RECALL_HARNESS_DEFAULTS,
  runHarnessStep,
} from '../../hooks/lib/harness-runner.js';
export type {
  ProvenCall,
  ProvenCaller,
  RunHarnessInput,
  RunResult,
  SpawnFn,
  SpawnOutcome,
  SpawnRequest,
} from '../../hooks/lib/harness-runner.js';
