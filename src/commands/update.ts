// `recall update` — pull the latest release, rebuild, apply DB migrations,
// refresh runtime files, and re-register hooks.
//
// This is a thin, typed entry point on the `recall` CLI. The actual work lives
// in the canonical update.sh (which sources lib/install-lib.sh) — the single
// source of truth. Flags are forwarded verbatim, so update.sh owns validation,
// --help, --check / --dry-run / --force / --no-migrate / --no-confirm / --no-gum,
// and the full step sequence. See src/lib/lifecycle.ts.

import { runLifecycleScript, type LifecycleDeps } from '../lib/lifecycle.js';

export function runUpdate(args: string[], deps: LifecycleDeps = {}): number {
  return runLifecycleScript('update', args, deps);
}
