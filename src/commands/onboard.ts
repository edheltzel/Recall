// mem onboard — interactive interview that creates the L0 identity tier.
//
// The L0 tier is a small user-authored markdown file that SessionRecall
// loads at the very top of every session. Without it, that tier is silently
// empty and a meaningful chunk of the v2 design is invisible.
//
// This command walks new users (and existing users who never wrote one)
// through 7 short questions, then writes the file.
//
// Defaults:
//   - Writes to ~/.claude/MEMORY/identity.md (global, used everywhere).
//   - --project writes to ./.atlas-recall/identity.md (project-local override).
//   - --print previews the rendered markdown without writing.
//   - --yes accepts all suggested defaults non-interactively (good for CI).
//
// Smart defaults pulled from `git config user.name` and the cwd basename.
// If a file already exists, the user must explicitly confirm overwrite —
// the previous file is backed up to identity.md.bak first.

import { existsSync, mkdirSync, writeFileSync, copyFileSync, renameSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { createInterface, type Interface } from 'readline';
import { detectProject } from '../lib/project.js';

// L0 identity files are silently truncated at load by hooks/SessionRecall.ts.
// Mirror that constant here so the onboarding UX can warn the user before the
// truncation ever happens.
const MAX_L0_CHARS = 1200;

// ───────────────────────────────────────────────────────────────────────
// Public CLI options

export interface OnboardOptions {
  /** Write to ./.atlas-recall/identity.md instead of the global path. */
  project?: boolean;
  /** Preview the rendered markdown only — never write to disk. */
  print?: boolean;
  /** Non-interactive: accept all suggested defaults. */
  yes?: boolean;
  /** Override the output path entirely. */
  out?: string;
}

// ───────────────────────────────────────────────────────────────────────
// Pure shape of the answers — kept separate from rendering so the
// renderer is easy to unit-test.

export interface IdentityAnswers {
  name: string;
  role: string;
  machine: string;
  projects: string[];
  preferences: string[];
  hosts: string[];
  notes: string;
}

// ───────────────────────────────────────────────────────────────────────
// Length check — mirrors SessionRecall's silent truncation threshold.

export function exceedsMaxL0(markdown: string): boolean {
  return markdown.length > MAX_L0_CHARS;
}

// ───────────────────────────────────────────────────────────────────────
// Render — pure function, no I/O. Tested directly.

export function renderIdentityMarkdown(a: IdentityAnswers): string {
  const lines: string[] = [];

  // Header — name takes the H1 slot.
  lines.push(`# ${a.name || 'You'}`);
  lines.push('');

  // One-line role / machine summary if present.
  const summaryParts: string[] = [];
  if (a.role) summaryParts.push(a.role);
  if (a.machine) summaryParts.push(a.machine);
  if (summaryParts.length > 0) {
    lines.push(summaryParts.join(' · ') + '.');
    lines.push('');
  }

  // Active projects.
  if (a.projects.length > 0) {
    lines.push('## Active projects');
    for (const p of a.projects) {
      if (p.trim()) lines.push(`- ${p.trim()}`);
    }
    lines.push('');
  }

  // Working preferences.
  if (a.preferences.length > 0) {
    lines.push('## Working preferences');
    for (const p of a.preferences) {
      if (p.trim()) lines.push(`- ${p.trim()}`);
    }
    lines.push('');
  }

  // Hosts I use.
  if (a.hosts.length > 0) {
    lines.push('## Hosts I use');
    for (const h of a.hosts) {
      if (h.trim()) lines.push(`- ${h.trim()}`);
    }
    lines.push('');
  }

  // Free-form notes.
  if (a.notes && a.notes.trim()) {
    lines.push('## Notes');
    lines.push(a.notes.trim());
    lines.push('');
  }

  // Trim trailing blank line.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  lines.push('');

  return lines.join('\n');
}

// ───────────────────────────────────────────────────────────────────────
// Smart defaults — read from the local environment.

// safeGitName uses child_process lazily so the import stays out of the pure
// render path and its tests.
function safeGitName(): string {
  try {
    const { execFileSync } = require('child_process');
    return execFileSync('git', ['config', '--get', 'user.name'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 2000,
    }).trim();
  } catch {
    return '';
  }
}

function detectMachine(): string {
  const platform = process.platform === 'darwin' ? 'macOS'
    : process.platform === 'linux' ? 'Linux'
    : process.platform === 'win32' ? 'Windows'
    : process.platform;
  // process.versions.bun is set on Bun and undefined on Node — avoids the
  // Bun global so we don't need @types/bun.
  const bunVersion = process.versions.bun;
  const runtime = bunVersion ? `Bun ${bunVersion}` : 'Node.js';
  return `${platform} · ${runtime}`;
}

// ───────────────────────────────────────────────────────────────────────
// Path resolution — mirror SessionRecall's identity-file lookup order.
// Precedence: --out > RECALL_IDENTITY_PATH env > --project > global default.
// The env var is honored because SessionRecall reads it with highest
// precedence at load; without this, a user with the env set could write
// to one path while the hook loads from another.

export function resolveOutputPath(
  options: OnboardOptions,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (options.out) return options.out;
  const envPath = env.RECALL_IDENTITY_PATH;
  if (envPath && envPath.trim()) return envPath.trim();
  if (options.project) return join(process.cwd(), '.atlas-recall', 'identity.md');
  return join(homedir(), '.claude', 'MEMORY', 'identity.md');
}

// ───────────────────────────────────────────────────────────────────────
// Interview — readline-based, one question at a time.
// Multi-value questions accept comma-separated input. An empty answer
// uses the default (or skips the section if no default).

interface AskOptions {
  default?: string;
  required?: boolean;
}

function makeAsker(rl: Interface, autoYes: boolean) {
  return async function ask(prompt: string, opts: AskOptions = {}): Promise<string> {
    const def = opts.default ?? '';
    const suffix = def ? ` [${def}]` : '';
    const full = `  ${prompt}${suffix}\n  ▸ `;

    if (autoYes) {
      // Echo what we'd ask and the chosen default, then return.
      process.stdout.write(full);
      process.stdout.write(def + '\n');
      if (opts.required && !def) {
        throw new Error(`onboard --yes: required answer "${prompt}" has no default`);
      }
      return def;
    }

    return new Promise<string>((resolve) => {
      rl.question(full, (raw) => {
        const ans = raw.trim();
        resolve(ans || def);
      });
    });
  };
}

// Separator choice: pipe (`|`) never appears in natural phrases, so a user
// can type "no force-push, ever" as a single preference without it being
// silently split. Prompts below document the separator explicitly.
export function splitMultiline(s: string): string[] {
  if (!s) return [];
  return s.split('|').map(x => x.trim()).filter(Boolean);
}

export async function runInterview(autoYes: boolean): Promise<IdentityAnswers> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = makeAsker(rl, autoYes);

  const defaultName = safeGitName();
  const defaultProject = detectProject() ?? '';
  const defaultMachine = detectMachine();

  try {
    process.stdout.write('\n');
    process.stdout.write('  Recall — L0 identity onboarding\n');
    process.stdout.write('  ────────────────────────────────\n');
    process.stdout.write('  This creates a small markdown file Recall loads at\n');
    process.stdout.write('  the start of every session. Press Enter to accept\n');
    process.stdout.write('  the suggested default. Leave blank to skip.\n');
    process.stdout.write('\n');

    const name = await ask('What should the agent call you?', {
      default: defaultName,
      required: true,
    });

    const role = await ask("What's your role? (e.g. solo developer, researcher, writer)", {
      default: 'developer',
    });

    const machine = await ask('What machine + runtime do you use?', {
      default: defaultMachine,
    });

    // Multi-value prompts use `|` as the separator so a single value can
    // safely contain commas (e.g. "no force-push, ever").
    const projectsRaw = await ask(
      'Top 1-3 active projects? (separate with `|`, e.g. alpha | beta | gamma)',
      { default: defaultProject },
    );
    const projects = splitMultiline(projectsRaw);

    const prefsRaw = await ask(
      'Working preferences for every session? (separate with `|`)',
      {
        default: 'plans live in .atlas-plans/ | work in git worktrees | no force-push without asking',
      },
    );
    const preferences = splitMultiline(prefsRaw);

    const hostsRaw = await ask(
      'Which AI agents/hosts do you use? (separate with `|`)',
      { default: 'Claude Code' },
    );
    const hosts = splitMultiline(hostsRaw);

    const notes = await ask(
      'Anything else the agent should always know? (single line, optional)',
      { default: '' },
    );

    return { name, role, machine, projects, preferences, hosts, notes };
  } finally {
    rl.close();
  }
}

// ───────────────────────────────────────────────────────────────────────
// Confirmation — interactive yes/no.

async function confirm(rl: Interface, prompt: string, autoYes: boolean): Promise<boolean> {
  if (autoYes) return true;
  return new Promise((resolve) => {
    rl.question(`  ${prompt} [y/N] `, (raw) => {
      resolve(/^y(es)?$/i.test(raw.trim()));
    });
  });
}

// ───────────────────────────────────────────────────────────────────────
// Entry point.

// Atomic write: stage the new content in a sibling .tmp file then rename.
// Guarantees the destination is either the old content or the full new
// content — never a half-written file. Works because rename(2) is atomic
// on the same filesystem.
function writeIdentityAtomic(outPath: string, markdown: string): void {
  const tmp = outPath + '.tmp';
  writeFileSync(tmp, markdown, 'utf-8');
  renameSync(tmp, outPath);
}

export async function runOnboard(options: OnboardOptions = {}): Promise<void> {
  const outPath = resolveOutputPath(options);

  const answers = await runInterview(options.yes === true);
  const markdown = renderIdentityMarkdown(answers);

  // --print: show the rendered file and exit, never write.
  if (options.print) {
    process.stdout.write('\n  ── Preview ─────────────────────────────────────\n\n');
    process.stdout.write(markdown);
    process.stdout.write('\n  ────────────────────────────────────────────────\n');
    process.stdout.write(`  (would write to: ${outPath})\n\n`);
    if (exceedsMaxL0(markdown)) {
      process.stderr.write(
        `  Warning: output is ${markdown.length} chars; SessionRecall truncates L0 at ${MAX_L0_CHARS}.\n` +
        `  Consider trimming before writing.\n\n`,
      );
    }
    return;
  }

  // Existing-file handling. Back up before overwrite, ask first.
  if (existsSync(outPath)) {
    const stat = statSync(outPath);
    const sizeKb = (stat.size / 1024).toFixed(1);
    process.stdout.write(`\n  An identity.md already exists at:\n`);
    process.stdout.write(`    ${outPath}  (${sizeKb} KB)\n`);

    // For confirm we need a second readline session — the interview already closed its own.
    const rl2 = createInterface({ input: process.stdin, output: process.stdout });
    let proceed = false;
    try {
      proceed = await confirm(rl2, 'Overwrite? (a .bak copy will be saved alongside)', options.yes === true);
    } finally {
      rl2.close();
    }
    if (!proceed) {
      process.stdout.write('\n  Aborted. Existing identity.md left in place.\n\n');
      return;
    }

    const bak = outPath + '.bak';
    try {
      copyFileSync(outPath, bak);
      process.stdout.write(`  Backed up existing file to ${bak}\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`  Warning: could not write backup (${msg}); aborting to be safe.\n\n`);
      return;
    }
  }

  // Ensure parent dir exists, then write atomically (.tmp + rename).
  mkdirSync(dirname(outPath), { recursive: true });
  writeIdentityAtomic(outPath, markdown);

  process.stdout.write('\n  ✓ Wrote identity.md\n');
  process.stdout.write(`    ${outPath}\n`);
  if (exceedsMaxL0(markdown)) {
    process.stderr.write(
      `  Warning: file is ${markdown.length} chars; SessionRecall truncates L0 at ${MAX_L0_CHARS}.\n` +
      `  Edit the file to shorten or run \`mem onboard --print\` first to preview length.\n`,
    );
  }
  process.stdout.write('\n  Try it: `mem benchmark run B` should now show v2_l0_chars > 0.\n\n');
}
