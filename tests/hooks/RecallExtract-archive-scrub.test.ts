// Tests for the markdown-archive scrub seam in hooks/RecallExtract.ts (#132).
//
// #131 approved "Option B": scrub leaked secrets on the on-disk markdown-archive
// write path, reusing the same scrub() (secret redaction + invisible-unicode
// strip) the SQLite dual-write already calls inside runExtractCore. The scrub is
// applied to the RAW extracted/topics/summary locals at the top of BOTH emit
// blocks, so all SEVEN legacy archive surfaces get scrubbed text:
//   1. DISTILLED.md        4. LoA transcript.md   7. ERROR_PATTERNS.json
//   2. HOT_RECALL.md       5. DECISIONS.log
//   3. SESSION_INDEX.json  6. REJECTIONS.log
//
// RecallExtract.ts runs main() on import (it's a CLI hook) and the extraction
// model (runExtractionCascade) has no in-process stub seam, so these surfaces
// can't be driven in-process. Instead each test drives the REAL hook as a
// subprocess via its --reextract* CLI flags, with HOME pointed at a temp dir
// (so all six MEMORY/* paths + the sessions/ folder resolve there) and a FAKE
// `claude` binary on PATH that echoes a planted-secret fixture — fully
// deterministic, no network, no real CLI.
//
//   --reextract-md  drives extractAndAppendMarkdown (OpenCode/Pi markdown path) →
//                   surfaces 1,2,3,5,6,7 (this block does NOT write the transcript)
//   --reextract     drives extractAndAppend (Claude-Code JSONL path) →
//                   surfaces 1,2,3,5,6,7 PLUS 4 (LoA transcript.md)
//
// Each no-leak assertion is mutation-guarded: revert the scrub() at the top of
// the emit block back to `core.extracted!` and the planted secret reappears as
// cleartext → RED (verified during development).

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

// A clearly-fake Anthropic key matching write-safety's `anthropic-key` pattern
// (`sk-ant-` + 20+ chars). Never a real credential.
const SECRET = 'sk-ant-FAKEKEYFORTESTINGONLY0000000000000000';
// An `api_key=` assignment — a SECOND, differently-shaped live-format secret, so
// the test proves the assignment-anchored pattern is redacted too (not just the
// prefix-anchored sk-ant key).
const ASSIGN_SECRET = 'api_key=AKIAIOSFODNN7EXAMPLE1234567890';

const HOOK_PATH = join(import.meta.dir, '..', '..', 'hooks', 'RecallExtract.ts');

// A fixture that plants the secret in every section the seven surfaces draw from:
// the summary line, a MAIN IDEAS bullet, a DECISIONS bullet, a REJECT bullet, and
// an ERRORS FIXED bullet. Padded past the quality gate's word floor.
function fixtureWithSecret(secret: string): string {
  return [
    '## ONE SENTENCE SUMMARY',
    `We accidentally leaked the credential ${secret} into the shared notes during a debugging session before anyone caught the exposure today.`,
    '',
    '## MAIN IDEAS',
    `- The token ${secret} was pasted into the config file during local debugging and has to be redacted`,
    '- Keep the lifecycle hooks self-contained and never import anything from the source tree',
    '- Any secret pasted into a transcript must never be persisted to disk as cleartext anywhere',
    '',
    '## DECISIONS MADE',
    `- Rotate ${secret} immediately and invalidate the old credential right away (confidence: HIGH)`,
    '- Add a redaction guard on the shared markdown write path so this can never recur (confidence: HIGH)',
    '',
    '## THINGS TO REJECT / AVOID',
    `- Storing ${secret} in any plaintext archive file from this point forward under any circumstances`,
    '',
    '## ERRORS FIXED',
    `- Auth failure during setup: replaced ${secret} with a vault reference and restarted the affected service`,
    '',
    '## SESSION CONTEXT',
    'A security hardening session for the shared extraction archive write path.',
  ].join('\n');
}

let tmp: string;
let home: string;
let dbPath: string;
let sessionSlugDir: string;

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** Install a fake `claude` binary that ignores stdin and prints `fixture`. */
function installFakeClaude(fixture: string): void {
  const binDir = join(home, '.local', 'bin'); // findClaudeCli() checks $HOME/.local/bin/claude
  mkdirSync(binDir, { recursive: true });
  const body =
    '#!/usr/bin/env bun\n' +
    "try { require('fs').readFileSync(0, 'utf-8'); } catch {}\n" +
    'process.stdout.write(' +
    JSON.stringify(fixture) +
    ');\n';
  const p = join(binDir, 'claude');
  writeFileSync(p, body);
  chmodSync(p, 0o755);
}

function memEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    RECALL_DB_PATH: dbPath,
    PATH: join(home, '.local', 'bin') + ':' + (process.env.PATH || ''),
  };
}

/** Run the hook with the given args; returns its exit status. */
function runHook(args: string[]): number {
  const res = spawnSync(process.argv[0], ['run', HOOK_PATH, ...args], {
    env: memEnv(),
    encoding: 'utf-8',
    timeout: 90_000,
  });
  return res.status ?? -1;
}

function memPath(name: string): string {
  return join(home, '.claude', 'MEMORY', name);
}

/** The six MEMORY/* archive surfaces (the LoA transcript lives under sessions/). */
const MEMORY_SURFACES = [
  'DISTILLED.md',
  'HOT_RECALL.md',
  'SESSION_INDEX.json',
  'DECISIONS.log',
  'REJECTIONS.log',
  'ERROR_PATTERNS.json',
];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'recall-132-archive-'));
  home = join(tmp, 'home');
  dbPath = join(tmp, 'recall.db');
  mkdirSync(join(home, '.claude', 'MEMORY'), { recursive: true });
  // Create a LoA session folder so extractAndAppend's transcript surface fires.
  sessionSlugDir = join(home, '.claude', 'sessions', today(), '1200pm-archive-scrub');
  mkdirSync(sessionSlugDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

describe('#132 markdown-archive scrub — extractAndAppendMarkdown (OpenCode/Pi path)', () => {
  test('a planted secret never persists as cleartext in any of the six MEMORY surfaces', () => {
    installFakeClaude(fixtureWithSecret(SECRET));
    const mdPath = join(tmp, 'session.md');
    writeFileSync(mdPath, 'user: hello there\nassistant: hi, here is some help\n'.repeat(80));

    expect(runHook(['--reextract-md', mdPath, 'opencode'])).toBe(0);

    for (const name of MEMORY_SURFACES) {
      const p = memPath(name);
      // Wiring guard — every surface must actually be written by this path.
      expect(existsSync(p)).toBe(true);
      const content = readFileSync(p, 'utf-8');
      // The load-bearing guarantee: cleartext secret reaches NO surface.
      // Mutation — revert the scrub() in extractAndAppendMarkdown → RED.
      expect(content).not.toContain(SECRET);
      // And the redaction marker is what landed instead.
      expect(content).toContain('[REDACTED:anthropic-key]');
    }
  });

  test('an api_key= assignment-format secret is also redacted across surfaces', () => {
    installFakeClaude(fixtureWithSecret(ASSIGN_SECRET));
    const mdPath = join(tmp, 'session.md');
    writeFileSync(mdPath, 'user: hello there\nassistant: hi, here is some help\n'.repeat(80));

    expect(runHook(['--reextract-md', mdPath, 'opencode'])).toBe(0);

    for (const name of MEMORY_SURFACES) {
      const content = readFileSync(memPath(name), 'utf-8');
      // The assignment's secret VALUE must not survive (write-safety keeps the
      // `api_key=` prefix and redacts the value).
      expect(content).not.toContain('AKIAIOSFODNN7EXAMPLE1234567890');
    }
  });
});

describe('#132 markdown-archive scrub — extractAndAppend (Claude-Code JSONL path)', () => {
  test('a planted secret never persists as cleartext in any of the SEVEN surfaces (incl. LoA transcript)', () => {
    installFakeClaude(fixtureWithSecret(SECRET));

    // A minimal but valid Claude-Code conversation JSONL the hook will parse.
    const convPath = join(tmp, 'conversation.jsonl');
    const lines: string[] = [];
    for (let i = 0; i < 80; i++) {
      lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: 'please help me with the build' } }));
      lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'here is a detailed answer to your question' }] } }));
    }
    writeFileSync(convPath, lines.join('\n') + '\n');

    expect(runHook(['--reextract', convPath, '/tmp/some-project'])).toBe(0);

    // The six MEMORY surfaces.
    for (const name of MEMORY_SURFACES) {
      const p = memPath(name);
      expect(existsSync(p)).toBe(true);
      expect(readFileSync(p, 'utf-8')).not.toContain(SECRET);
    }

    // Surface 4 — the LoA transcript (only this path writes it).
    const transcripts = readdirSync(sessionSlugDir);
    expect(transcripts).toContain('transcript.md');
    const transcript = readFileSync(join(sessionSlugDir, 'transcript.md'), 'utf-8');
    // Mutation — revert the scrub() in extractAndAppend → the transcript leaks → RED.
    expect(transcript).not.toContain(SECRET);
    expect(transcript).toContain('[REDACTED:anthropic-key]');
  });
});

describe('#132 colon-edge — secret in the ERRORS FIXED error-key position (#133, RecallExtract copy)', () => {
  // appendErrors (hooks/RecallExtract.ts) splits each ERRORS FIXED bullet on the
  // FIRST colon (line.indexOf(':')). scrub() rewrites a secret in the error-key
  // position to `[REDACTED:anthropic-key]`, whose marker ALSO contains a colon —
  // so the split lands inside the marker (error="[REDACTED", fix="anthropic-key]…").
  // #133 only fixed the `extraction-parsers.ts` copy of this split; appendErrors
  // here is a second, independent, untouched copy. This is the accepted
  // redact-over-leak tradeoff: the split is wonky, but the cleartext secret was
  // already redacted before appendErrors ran, so it can NEVER persist. This test
  // locks (a) the no-leak guarantee and (b) graceful degradation (no throw).
  test('the row persists secret-free and the parse degrades gracefully (no throw, no leak)', () => {
    const colonFixture = [
      '## ONE SENTENCE SUMMARY',
      'We hardened the shared archive write path so leaked credentials are redacted before any archive row is persisted to disk.',
      '',
      '## MAIN IDEAS',
      '- A secret pasted into an ERRORS FIXED bullet must never survive into a stored archive row as cleartext',
      '- The redaction marker itself contains a colon so the first-colon split can land inside it on that row',
      '- That split is wonky but safe because the cleartext secret was already replaced before the parser ran',
      '',
      '## ERRORS FIXED',
      `- ${SECRET}: replaced the leaked credential with a vault reference and restarted the affected service`,
    ].join('\n');
    installFakeClaude(colonFixture);

    const mdPath = join(tmp, 'session.md');
    writeFileSync(mdPath, 'user: hello there\nassistant: hi, here is some help\n'.repeat(80));

    // (b) Graceful degrade — the hook exits 0, no throw.
    expect(runHook(['--reextract-md', mdPath, 'opencode'])).toBe(0);

    const errorsPath = memPath('ERROR_PATTERNS.json');
    expect(existsSync(errorsPath)).toBe(true);
    const raw = readFileSync(errorsPath, 'utf-8');

    // (a) The cleartext secret reaches the ERROR_PATTERNS.json surface NOWHERE.
    // Mutation — revert the scrub() in extractAndAppendMarkdown → RED.
    expect(raw).not.toContain(SECRET);

    // Document the REAL split shape: the first-colon split lands inside the
    // marker, so error="[REDACTED" and fix carries the rest. Neither is cleartext.
    const data = JSON.parse(raw) as { patterns: { error: string; fix: string }[] };
    expect(data.patterns.length).toBe(1);
    expect(data.patterns[0].error).toBe('[REDACTED');
    expect(data.patterns[0].fix).toBe(
      'anthropic-key]: replaced the leaked credential with a vault reference and restarted the affected service',
    );
    for (const p of data.patterns) {
      expect(p.error).not.toContain(SECRET);
      expect(p.fix).not.toContain(SECRET);
    }
  });
});
