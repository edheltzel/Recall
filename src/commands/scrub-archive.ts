// recall scrub-archive — retroactively scrub secrets + invisible/bidi unicode
// from the legacy on-disk memory archive (issue #157).
//
// An on-demand sweep over the surfaces RecallExtract.ts writes under
// ~/.claude/MEMORY plus the per-session transcript.md files under
// ~/.claude/sessions. These predate the write-safety scrub and can still hold
// raw secrets; this command closes that retroactive gap and, with the
// import-legacy guard (#157), keeps a dirty archive from re-amplifying into the
// DB.
//
// scrub() is the ONE canonical write-safety pass (hooks/lib/write-safety.ts,
// re-exported via ../lib/write-safety.js per #50) — this command never
// duplicates the pattern table. Injection/exfil detection, severity tiers, and
// entropy tokenization are out of scope (#156).
//
// Guarantees: idempotent (a second sweep redacts nothing further — scrub reaches
// a fixpoint), backup-before-rewrite (every changed file is copied to the backup
// dir first), and --dry-run reports what would change without writing. Clean
// files are never backed up or rewritten.

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { scrub } from '../lib/write-safety.js';
import { defaultBackupDir, timestampSlug, writeNonClobbering } from '../lib/export.js';

export interface ScrubArchiveOptions {
  dryRun?: boolean;
  verbose?: boolean;
  /** Test seam — defaults to ~/.claude/MEMORY (matches RecallExtract.ts MEMORY_DIR). */
  memoryDir?: string;
  /** Test seam — defaults to ~/.claude/sessions (matches RecallExtract.ts SESSION_FOLDERS_DIR). */
  sessionsDir?: string;
  /** Test seam — defaults to defaultBackupDir(). */
  backupDir?: string;
  /** Test seam — backup-folder timestamp; the CLI always uses the current time. */
  now?: Date;
}

// The six flat MEMORY surfaces and how their text is scrubbed. The per-session
// transcript.md files live under a different root and are enumerated separately.
const MEMORY_SURFACES: ReadonlyArray<{ name: string; kind: 'text' | 'json' }> = [
  { name: 'DISTILLED.md', kind: 'text' },
  { name: 'HOT_RECALL.md', kind: 'text' },
  { name: 'DECISIONS.log', kind: 'text' },
  { name: 'REJECTIONS.log', kind: 'text' },
  { name: 'SESSION_INDEX.json', kind: 'json' },
  { name: 'ERROR_PATTERNS.json', kind: 'json' },
];

interface Surface {
  abs: string;
  /** Path relative to the archive root, reused for the backup mirror. */
  rel: string;
  kind: 'text' | 'json';
}

type SurfaceResult =
  | { surface: Surface; status: 'missing' }
  | { surface: Surface; status: 'parse-error' }
  | { surface: Surface; status: 'unreadable'; error: string }
  | { surface: Surface; status: 'clean' }
  | { surface: Surface; status: 'changed'; scrubbed: string; redactions: string[] };

/**
 * Recursively scrub every string (object keys and values) in a parsed JSON
 * value. Returns the rebuilt value, whether any string actually changed, and
 * the distinct secret kinds redacted. Scrubbing only string nodes — never the
 * structural text — is what guarantees the re-serialized output stays valid
 * JSON; `[REDACTED:kind]` and invisible-strip are inert inside a JSON string.
 */
function scrubJsonValue(value: unknown, kinds: Set<string>): { value: unknown; changed: boolean } {
  if (typeof value === 'string') {
    const { text, redactions } = scrub(value);
    for (const k of redactions) kinds.add(k);
    return { value: text, changed: text !== value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const arr = value.map((v) => {
      const r = scrubJsonValue(v, kinds);
      changed = changed || r.changed;
      return r.value;
    });
    return { value: arr, changed };
  }
  if (value !== null && typeof value === 'object') {
    let changed = false;
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const sk = scrub(k).text;
      const r = scrubJsonValue(v, kinds);
      changed = changed || r.changed;
      // Collision guard: fire whenever the target key is ALREADY taken, whether
      // or not scrubbing changed this key — a scrubbed key can collide with an
      // earlier literal-form key (sk === k) just as easily. Preserve under a
      // free fallback key and warn; never silently overwrite/drop data.
      if (Object.prototype.hasOwnProperty.call(obj, sk)) {
        let fallback = k;
        for (let n = 1; Object.prototype.hasOwnProperty.call(obj, fallback); n++) fallback = `${k}#${n}`;
        console.log(`[WARN] scrub-archive: JSON key collision on "${sk}"; preserved under "${fallback}" to avoid dropping data`);
        obj[fallback] = r.value;
        changed = true;
      } else {
        if (sk !== k) changed = true;
        obj[sk] = r.value;
      }
    }
    return { value: obj, changed };
  }
  return { value, changed: false };
}

/** Scrub one surface in memory, deciding clean vs changed without writing. */
function inspectSurface(surface: Surface): SurfaceResult {
  if (!existsSync(surface.abs)) return { surface, status: 'missing' };
  // existsSync only proves the path resolves (F_OK) — the read can still throw
  // for an unreadable file (EACCES, mode 000), a surface that resolves to a
  // directory (EISDIR), etc. One odd surface must never abort the whole sweep,
  // so skip-and-warn here exactly as the transcript enumeration does.
  let raw: string;
  try {
    raw = readFileSync(surface.abs, 'utf-8');
  } catch (err) {
    return { surface, status: 'unreadable', error: (err as Error).message };
  }

  if (surface.kind === 'json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { surface, status: 'parse-error' };
    }
    const kinds = new Set<string>();
    const { value, changed } = scrubJsonValue(parsed, kinds);
    if (!changed) return { surface, status: 'clean' };
    // Match RecallExtract.ts serialization (2-space indent, no trailing newline).
    return { surface, status: 'changed', scrubbed: JSON.stringify(value, null, 2), redactions: [...kinds] };
  }

  const { text, redactions } = scrub(raw);
  if (text === raw) return { surface, status: 'clean' };
  return { surface, status: 'changed', scrubbed: text, redactions };
}

/**
 * Enumerate ~/.claude/sessions/<date>/<session>/transcript.md surfaces.
 * Every filesystem touch is guarded: a dangling symlink or unreadable entry
 * under sessions/ must be skipped-and-warned, never crash the whole sweep and
 * leave the other surfaces un-scrubbed (a broken symlink makes statSync/readdir
 * throw ENOENT). existsSync is safe — it follows symlinks and returns false on
 * a missing target rather than throwing.
 */
function transcriptSurfaces(sessionsDir: string): Surface[] {
  if (!existsSync(sessionsDir)) return [];
  const surfaces: Surface[] = [];
  let dates: string[];
  try {
    dates = readdirSync(sessionsDir).sort();
  } catch (err) {
    console.log(`[SKIP] sessions/ — unreadable (${(err as Error).message})`);
    return surfaces;
  }
  for (const date of dates) {
    const dateDir = join(sessionsDir, date);
    let sessions: string[];
    try {
      if (!statSync(dateDir).isDirectory()) continue;
      sessions = readdirSync(dateDir).sort();
    } catch (err) {
      console.log(`[SKIP] sessions/${date} — unreadable (${(err as Error).message})`);
      continue;
    }
    for (const session of sessions) {
      const abs = join(dateDir, session, 'transcript.md');
      if (existsSync(abs)) {
        surfaces.push({ abs, rel: join('sessions', date, session, 'transcript.md'), kind: 'text' });
      }
    }
  }
  return surfaces;
}

export function runScrubArchive(options: ScrubArchiveOptions = {}): void {
  const memoryDir = options.memoryDir ?? join(homedir(), '.claude', 'MEMORY');
  const sessionsDir = options.sessionsDir ?? join(homedir(), '.claude', 'sessions');
  const backupDir = options.backupDir ?? defaultBackupDir();
  const now = options.now ?? new Date();

  console.log('Recall scrub-archive');
  console.log('====================\n');

  const surfaces: Surface[] = [
    ...MEMORY_SURFACES.map((s) => ({ abs: join(memoryDir, s.name), rel: join('MEMORY', s.name), kind: s.kind })),
    ...transcriptSurfaces(sessionsDir),
  ];

  const results = surfaces.map(inspectSurface);
  const changed = results.filter((r): r is Extract<SurfaceResult, { status: 'changed' }> => r.status === 'changed');
  const parseErrors = results.filter((r) => r.status === 'parse-error');
  const unreadable = results.filter((r): r is Extract<SurfaceResult, { status: 'unreadable' }> => r.status === 'unreadable');
  const kindTotals = new Map<string, number>();
  for (const r of changed) for (const k of r.redactions) kindTotals.set(k, (kindTotals.get(k) ?? 0) + 1);

  // The backup root is created lazily — only a real run with a changed file
  // touches the disk, so a clean sweep or --dry-run leaves no empty folder.
  const backupRoot = join(backupDir, `scrub-archive-${timestampSlug(now)}`);
  let backedUp = false;

  for (const r of changed) {
    const kinds = r.redactions.length ? `secrets: ${r.redactions.join(', ')}` : 'invisible/bidi unicode';
    if (options.dryRun) {
      console.log(`[DRY] would scrub ${r.surface.rel} (${kinds})`);
      continue;
    }
    if (!backedUp) {
      mkdirSync(backupRoot, { recursive: true });
      backedUp = true;
    }
    const backupTarget = join(backupRoot, r.surface.rel);
    mkdirSync(dirname(backupTarget), { recursive: true });
    writeNonClobbering(backupTarget, readFileSync(r.surface.abs, 'utf-8'));
    writeFileSync(r.surface.abs, r.scrubbed, 'utf-8');
    console.log(`[SCRUB] ${r.surface.rel} (${kinds})`);
  }

  for (const r of parseErrors) {
    console.log(`[SKIP] ${r.surface.rel} — invalid JSON, left untouched`);
  }

  for (const r of unreadable) {
    console.log(`[SKIP] ${r.surface.rel} — unreadable (${r.error}), left untouched`);
  }

  if (options.verbose) {
    for (const r of results) {
      if (r.status === 'clean') console.log(`[OK]   ${r.surface.rel} — clean`);
      else if (r.status === 'missing') console.log(`[--]   ${r.surface.rel} — not present`);
    }
  }

  console.log('');
  console.log(`Surfaces scanned:  ${surfaces.length}`);
  console.log(`${options.dryRun ? 'Would change' : 'Changed'}:      ${changed.length}`);
  if (kindTotals.size > 0) {
    const breakdown = [...kindTotals.entries()].map(([k, n]) => `${k}=${n}`).join(', ');
    console.log(`Secret kinds:      ${breakdown}`);
  }
  if (parseErrors.length > 0) console.log(`Skipped (bad JSON): ${parseErrors.length}`);
  if (unreadable.length > 0) console.log(`Skipped (unreadable): ${unreadable.length}`);
  if (backedUp) console.log(`Backups:           ${backupRoot}`);
  if (options.dryRun) console.log('\n[DRY RUN] No files were modified.');
}
