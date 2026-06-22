// `recall uninstall` — remove Recall integration from Claude Code, OpenCode,
// and Pi. Preserves user data by default; --purge destroys the install root.
//
// Thin, typed entry point on the `recall` CLI. The actual work lives in the
// canonical uninstall.sh (which sources lib/install-lib.sh) — the single
// source of truth. Flags are forwarded verbatim, so uninstall.sh owns
// validation, --help, --dry-run / --purge / --no-confirm / --skip-opencode /
// --skip-pi / --no-gum, and the removal sequence. See src/lib/lifecycle.ts.

import { runLifecycleScript, type LifecycleDeps } from '../lib/lifecycle.js';

export function runUninstall(args: string[], deps: LifecycleDeps = {}): number {
  return runLifecycleScript('uninstall', args, deps);
}
