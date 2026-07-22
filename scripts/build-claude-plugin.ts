#!/usr/bin/env bun

// Generate the Claude Code plugin's skill payload from the canonical agent-skills source.
// Generated files are checked in so Claude's installed plugin cache is complete;
// agent-skills/ remains the only authoring surface.
//
// Unlike the Codex adapters, these are byte-verbatim copies. The canonical skills are
// already authored against Claude's own frontmatter contract (`disable-model-invocation`,
// `allowed-tools`), so rewriting them would change behavior relative to the skills the
// lifecycle installer has always placed in ~/.claude/skills. Copying instead of symlinking
// keeps the bundle self-contained: Claude skips symlinks that leave the plugin root when a
// plugin is installed from a local path, and Windows checkouts without symlink support
// would degrade the payload silently.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = join(repoRoot, 'agent-skills');
const defaultOutputRoot = join(repoRoot, 'plugins', 'recall-claude', 'skills');

export function generateClaudePluginSkills(outputRoot: string = defaultOutputRoot): string[] {
  mkdirSync(outputRoot, { recursive: true });
  const skillNames = readdirSync(sourceRoot)
    .filter(name => existsSync(join(sourceRoot, name, 'SKILL.md')))
    .sort();

  // Drop generated directories that no longer have a canonical source, so a renamed or
  // deleted skill cannot linger in the bundle.
  for (const stale of readdirSync(outputRoot).filter(name => !skillNames.includes(name))) {
    rmSync(join(outputRoot, stale), { recursive: true, force: true });
  }

  for (const name of skillNames) {
    const sourceDir = join(sourceRoot, name);
    const outputDir = join(outputRoot, name);
    mkdirSync(outputDir, { recursive: true });
    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      writeFileSync(join(outputDir, entry.name), readFileSync(join(sourceDir, entry.name)));
    }
  }

  const generated = readdirSync(outputRoot)
    .filter(name => existsSync(join(outputRoot, name, 'SKILL.md')))
    .sort();
  if (generated.join('\n') !== skillNames.join('\n')) {
    throw new Error('generated Claude skill set contains stale or missing entries');
  }
  return skillNames;
}

if (import.meta.main) {
  console.log(`Generated ${generateClaudePluginSkills().length} Claude plugin skills.`);
}
