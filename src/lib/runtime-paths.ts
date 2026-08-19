import { homedir } from 'os';
import { join } from 'path';

/** Recall-owned mutable state. Host adapters must not redirect generic runtime state. */
export function getRecallHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.RECALL_HOME || join(homedir(), '.agents', 'Recall');
}

export function getRecallLogDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(getRecallHome(env), 'logs');
}
