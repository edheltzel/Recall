// Shared plumbing for the `recall update` / `recall uninstall` subcommands.
//
// These commands deliberately DELEGATE to the canonical bash lifecycle scripts
// (update.sh / uninstall.sh) instead of re-implementing their logic in
// TypeScript. The scripts — together with lib/install-lib.sh — remain the
// single source of truth (DRY): they own flag parsing, the step sequence, and
// every file/registration operation. install.sh stays the shell bootstrap.
// The TS layer only exposes the scripts on the `recall` CLI surface and
// forwards arguments verbatim, so there is no duplicated logic across the
// script and the subcommand.

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export interface LifecycleDeps {
  /** Override the resolved repo root (used by tests). */
  repoRoot?: string;
  /**
   * Injectable spawner (used by tests). Receives the absolute script path and
   * the forwarded args; returns the child's exit code. The default streams the
   * script's output through to the terminal.
   */
  spawn?: (script: string, args: string[]) => number;
}

const SCRIPTS = {
  update: 'update.sh',
  uninstall: 'uninstall.sh',
} as const;

export type LifecycleCommand = keyof typeof SCRIPTS;

/**
 * Resolve the Recall repository root — the directory that holds update.sh,
 * uninstall.sh, and lib/install-lib.sh.
 *
 * Precedence:
 *   1. $RECALL_REPO_DIR — the same override lib/install-lib.sh honors.
 *   2. Derived from this module's location: the bundled CLI lives at
 *      <repo>/dist/index.js, so the repo root is one directory above dist/.
 */
export function resolveRepoRoot(
  env: NodeJS.ProcessEnv = process.env,
  metaUrl: string = import.meta.url,
): string {
  const override = env.RECALL_REPO_DIR;
  if (override && override.trim()) return override.trim();
  // <repo>/dist/index.js -> <repo>/dist -> <repo>
  return dirname(dirname(fileURLToPath(metaUrl)));
}

function defaultSpawn(script: string, args: string[]): number {
  const r = spawnSync('bash', [script, ...args], { stdio: 'inherit' });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

/**
 * Run a lifecycle script, forwarding `args` to it verbatim. Returns the
 * child's exit code; the caller assigns it to process.exitCode. Emits a clear
 * error (and returns 1) when the script is missing — e.g. an install layout
 * where the git checkout is not co-located with the `recall` binary.
 */
export function runLifecycleScript(
  command: LifecycleCommand,
  args: string[],
  deps: LifecycleDeps = {},
): number {
  const repoRoot = deps.repoRoot ?? resolveRepoRoot();
  const script = join(repoRoot, SCRIPTS[command]);

  if (!existsSync(script)) {
    console.error(
      `recall ${command}: lifecycle script not found at ${script}.\n` +
        `This command delegates to ${SCRIPTS[command]} from a git-checkout install.\n` +
        `Run it from the Recall repository, or set RECALL_REPO_DIR to the checkout path.`,
    );
    return 1;
  }

  const spawn = deps.spawn ?? defaultSpawn;
  return spawn(script, args);
}
