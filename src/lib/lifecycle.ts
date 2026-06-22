// Shared plumbing for the `recall install` / `recall update` / `recall uninstall`
// subcommands.
//
// These commands deliberately DELEGATE to the canonical bash lifecycle scripts
// (install.sh / update.sh / uninstall.sh) instead of re-implementing their
// logic in TypeScript. The scripts — together with lib/install-lib.sh — remain
// the single source of truth (DRY): they own flag parsing, the step sequence,
// and every file/registration operation. The TS layer only exposes the scripts
// on the `recall` CLI surface and forwards arguments verbatim.
//
// The scripts ship inside the npm package (see package.json `files`), so the
// commands resolve them the same way under a git checkout, a `bun install -g`,
// or an `npx` run — via resolveRepoRoot() below.

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export interface LifecycleDeps {
  /** Override the resolved repo/package root (used by tests). */
  repoRoot?: string;
  /**
   * Injectable spawner (used by tests). Receives the absolute script path, the
   * forwarded args, and the (already-merged) environment; returns the child's
   * exit code. The default streams the script's output through to the terminal.
   */
  spawn?: (script: string, args: string[], env?: NodeJS.ProcessEnv) => number;
}

const SCRIPTS = {
  install: 'install.sh',
  update: 'update.sh',
  uninstall: 'uninstall.sh',
} as const;

export type LifecycleCommand = keyof typeof SCRIPTS;

/**
 * Resolve the Recall repo/package root — the directory that holds install.sh,
 * update.sh, uninstall.sh, and lib/install-lib.sh.
 *
 * Precedence:
 *   1. $RECALL_REPO_DIR — the same override lib/install-lib.sh honors. This is
 *      the documented fallback for any install layout where the dist-relative
 *      derivation below does not land on the bundled scripts.
 *   2. Derived from this module's location: the bundled CLI lives at
 *      <root>/dist/index.js, so the root is one directory above dist/. This
 *      holds for a git checkout AND an npm package (the `files` whitelist ships
 *      the scripts at package-root-relative paths next to dist/).
 */
export function resolveRepoRoot(
  env: NodeJS.ProcessEnv = process.env,
  metaUrl: string = import.meta.url,
): string {
  const override = env.RECALL_REPO_DIR;
  if (override && override.trim()) return override.trim();
  // <root>/dist/index.js -> <root>/dist -> <root>
  return dirname(dirname(fileURLToPath(metaUrl)));
}

function defaultSpawn(
  script: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): number {
  const r = spawnSync('bash', [script, ...args], {
    stdio: 'inherit',
    env: env ?? process.env,
  });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

/**
 * Run a lifecycle script, forwarding `args` to it verbatim. `extraEnv` is
 * merged over the current environment (e.g. RECALL_PACKAGED=1 for the packaged
 * install path). Returns the child's exit code; the caller assigns it to
 * process.exitCode. Emits a clear error (and returns 1) when the script is
 * missing — e.g. a packaging layout where the bundled scripts didn't ship.
 */
export function runLifecycleScript(
  command: LifecycleCommand,
  args: string[],
  deps: LifecycleDeps = {},
  extraEnv?: NodeJS.ProcessEnv,
): number {
  const repoRoot = deps.repoRoot ?? resolveRepoRoot();
  const script = join(repoRoot, SCRIPTS[command]);

  if (!existsSync(script)) {
    console.error(
      `recall ${command}: lifecycle script not found at ${script}.\n` +
        `This command delegates to ${SCRIPTS[command]}, which ships in the Recall ` +
        `package (and the git checkout).\n` +
        `Run it from a Recall install, or set RECALL_REPO_DIR to the directory that ` +
        `holds ${SCRIPTS[command]}.`,
    );
    return 1;
  }

  const spawn = deps.spawn ?? defaultSpawn;
  const env = extraEnv ? { ...process.env, ...extraEnv } : undefined;
  return spawn(script, args, env);
}
