// `recall install` — run the canonical Recall install (MCP registration, hooks,
// slash commands, guides, platform integrations) for an already-on-PATH binary.
//
// This is the post-bootstrap entry point for npm / npx / `bun install -g`
// installs: the package manager has already placed deps, the prebuilt dist/,
// and the `recall` / `recall-mcp` bins, so there is nothing to clone, `bun
// install`, `bun run build`, or `bun link`. We delegate to the canonical
// install.sh in PACKAGED mode (RECALL_PACKAGED=1), which skips exactly those
// bootstrap steps and runs only the canonical install. The git-checkout
// `./install.sh` path is unchanged (RECALL_PACKAGED unset). See
// src/lib/lifecycle.ts — same single-source delegation as update/uninstall.

import { runLifecycleScript, type LifecycleDeps } from '../lib/lifecycle.js';

export function runInstall(args: string[], deps: LifecycleDeps = {}): number {
  return runLifecycleScript('install', args, deps, { RECALL_PACKAGED: '1' });
}
