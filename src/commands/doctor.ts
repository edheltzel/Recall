// recall doctor — health check for all memory subsystems

import { existsSync, statSync, readFileSync, writeFileSync, lstatSync, readlinkSync, mkdirSync, copyFileSync, unlinkSync, symlinkSync, readdirSync, renameSync, realpathSync } from 'fs';
import { dirname, join } from 'path';
import { execSync, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { getDb, getDbPath } from '../db/connection.js';
import { checkAllFts } from '../lib/repair.js';
import { VERSION } from '../version.js';

export interface DoctorOptions {
  fix?: boolean;
}

// ANSI color helpers
const C = {
  pass: '\x1b[32m',   // green
  warn: '\x1b[33m',   // yellow
  fail: '\x1b[31m',   // red
  dim:  '\x1b[2m',    // dim
  bold: '\x1b[1m',    // bold
  reset: '\x1b[0m',
};

type Status = 'PASS' | 'WARN' | 'FAIL' | 'INFO';

interface CheckResult {
  label: string;
  status: Status;
  message: string;
}

function icon(status: Status): string {
  switch (status) {
    case 'PASS': return `${C.pass}[PASS]${C.reset}`;
    case 'WARN': return `${C.warn}[WARN]${C.reset}`;
    case 'FAIL': return `${C.fail}[FAIL]${C.reset}`;
    case 'INFO': return `${C.dim}[INFO]${C.reset}`;
  }
}

function printResult(result: CheckResult): void {
  console.log(`  ${icon(result.status)} ${result.label}`);
  console.log(`         ${C.dim}${result.message}${C.reset}`);
}

// ─────────────────────────────────────────
// Check 1: Database exists and is readable
// ─────────────────────────────────────────
function checkDatabase(): CheckResult {
  const label = 'Database exists and readable';
  const dbPath = getDbPath();

  if (!existsSync(dbPath)) {
    return { label, status: 'FAIL', message: `Database not found at ${dbPath}` };
  }

  try {
    const stats = statSync(dbPath);
    const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);
    // Attempt to open — will throw if corrupt or unreadable
    getDb();
    return { label, status: 'PASS', message: `Database found (${sizeMb} MB) at ${dbPath}` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { label, status: 'FAIL', message: `Cannot open database: ${msg}` };
  }
}

// ─────────────────────────────────────────
// Check 2: Messages count and recency
// ─────────────────────────────────────────
function checkMessages(): CheckResult {
  const label = 'Messages: count and recency';

  try {
    const db = getDb();
    const row = db.prepare<{ count: number; latest: string | null }, []>(
      'SELECT COUNT(*) as count, MAX(timestamp) as latest FROM messages'
    ).get();

    if (!row || row.count === 0) {
      return { label, status: 'FAIL', message: '0 messages in database' };
    }

    if (!row.latest) {
      return { label, status: 'WARN', message: `${row.count} messages but no timestamp data` };
    }

    const latestMs = new Date(row.latest).getTime();
    const ageHours = (Date.now() - latestMs) / (1000 * 60 * 60);

    if (ageHours < 48) {
      const hoursStr = ageHours.toFixed(1);
      return {
        label,
        status: 'PASS',
        message: `${row.count.toLocaleString()} messages, most recent ${hoursStr}h ago`,
      };
    } else {
      const daysStr = (ageHours / 24).toFixed(1);
      return {
        label,
        status: 'WARN',
        message: `${row.count.toLocaleString()} messages, most recent ${daysStr}d ago (stale)`,
      };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { label, status: 'FAIL', message: `Query failed: ${msg}` };
  }
}

// ─────────────────────────────────────────
// Check 3: Structured data counts
// ─────────────────────────────────────────
function checkStructuredData(): CheckResult {
  const label = 'Structured data (LoA, decisions, learnings, breadcrumbs)';

  try {
    const db = getDb();
    const loa   = (db.prepare<{ count: number }, []>('SELECT COUNT(*) as count FROM loa_entries').get()?.count) ?? 0;
    const dec   = (db.prepare<{ count: number }, []>('SELECT COUNT(*) as count FROM decisions').get()?.count) ?? 0;
    const learn = (db.prepare<{ count: number }, []>('SELECT COUNT(*) as count FROM learnings').get()?.count) ?? 0;
    const bc    = (db.prepare<{ count: number }, []>('SELECT COUNT(*) as count FROM breadcrumbs').get()?.count) ?? 0;

    const total = loa + dec + learn + bc;
    const summary = `LoA: ${loa}, Decisions: ${dec}, Learnings: ${learn}, Breadcrumbs: ${bc}`;

    if (total === 0) {
      return { label, status: 'WARN', message: `All structured tables empty (extraction may not be working). ${summary}` };
    }

    return { label, status: 'PASS', message: summary };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { label, status: 'FAIL', message: `Query failed: ${msg}` };
  }
}

// ─────────────────────────────────────────
// Check: FTS5 index health
// ─────────────────────────────────────────
//
// Read-only by design (issue #46): doctor only RECOMMENDS `recall repair`.
// This check is exported as a plain CheckResult with no repair fn, so the
// --fix loop (symlinks only) can never run data repair implicitly.
export function checkFtsIndexes(): CheckResult {
  const label = 'FTS5 search indexes in sync';

  try {
    const reports = checkAllFts(getDb());
    const problems = reports.filter(r => r.status !== 'ok');

    if (problems.length === 0) {
      return { label, status: 'PASS', message: `All ${reports.length} FTS indexes in sync with source tables` };
    }

    const summary = problems
      .map(p => `${p.ftsTable}: ${p.status} (${p.detail})`)
      .join('; ');
    return {
      label,
      status: 'WARN',
      message: `${summary} — run 'recall repair' to inspect, 'recall repair --execute' to fix`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { label, status: 'FAIL', message: `Check failed: ${msg}` };
  }
}

// ─────────────────────────────────────────
// Check 4: Extraction output files
// ─────────────────────────────────────────
function checkExtractionFiles(): CheckResult {
  const label = 'Extraction output files present';
  const memDir = join(homedir(), '.claude', 'MEMORY');

  const files = [
    'DISTILLED.md',
    'HOT_RECALL.md',
    'SESSION_INDEX.json',
    'DECISIONS.log',
  ];

  const missing = files.filter(f => !existsSync(join(memDir, f)));

  if (missing.length === 0) {
    return { label, status: 'PASS', message: 'All extraction outputs present' };
  }

  if (missing.length === files.length) {
    return { label, status: 'FAIL', message: `Missing: ${missing.join(', ')}` };
  }

  return { label, status: 'WARN', message: `Missing: ${missing.join(', ')}` };
}

// ─────────────────────────────────────────
// Check 5: EXTRACT_LOG.txt status
// ─────────────────────────────────────────
function checkExtractLog(): CheckResult {
  const label = 'Extraction log status';
  const logPath = join(homedir(), '.claude', 'MEMORY', 'EXTRACT_LOG.txt');

  if (!existsSync(logPath)) {
    return { label, status: 'WARN', message: 'No extraction log found at MEMORY/EXTRACT_LOG.txt' };
  }

  try {
    const content = readFileSync(logPath, 'utf-8').trim();
    const lines = content.split('\n').filter(l => l.trim());
    const lastLine = lines[lines.length - 1] ?? '';

    if (lastLine.includes('SUCCESS')) {
      // Try to extract timestamp — typically "SUCCESS at 2026-03-05T..." or just append context
      const ts = lastLine.replace('SUCCESS', '').replace('at', '').trim();
      return {
        label,
        status: 'PASS',
        message: `Last extraction: SUCCESS${ts ? ` at ${ts}` : ''}`,
      };
    }

    if (lastLine.includes('FAILED') || lastLine.includes('ERROR')) {
      return { label, status: 'WARN', message: `Last extraction: FAILED — ${lastLine.slice(0, 120)}` };
    }

    // Log exists but last line is ambiguous
    return { label, status: 'WARN', message: `Last log line: ${lastLine.slice(0, 120)}` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { label, status: 'WARN', message: `Could not read log: ${msg}` };
  }
}

// ─────────────────────────────────────────
// Check 6: Extraction tracker lockouts
// ─────────────────────────────────────────
function checkTrackerLockouts(): CheckResult {
  const label = 'Extraction tracker lockouts';
  const trackerPath = join(homedir(), '.claude', 'MEMORY', '.extraction_tracker.json');

  if (!existsSync(trackerPath)) {
    return { label, status: 'PASS', message: 'No tracker file (no lockouts possible)' };
  }

  try {
    const raw = readFileSync(trackerPath, 'utf-8');
    const tracker: Record<string, unknown> = JSON.parse(raw);

    const now = Date.now();
    const lockouts: string[] = [];

    for (const [file, value] of Object.entries(tracker)) {
      // Tracker entries typically store { lockedUntil: ISO string } or a timestamp
      let lockedUntil: number | null = null;

      if (typeof value === 'string') {
        lockedUntil = new Date(value).getTime();
      } else if (typeof value === 'object' && value !== null) {
        const v = value as Record<string, unknown>;
        if (typeof v.lockedUntil === 'string') {
          lockedUntil = new Date(v.lockedUntil).getTime();
        } else if (typeof v.until === 'string') {
          lockedUntil = new Date(v.until).getTime();
        } else if (typeof v.expires === 'string') {
          lockedUntil = new Date(v.expires).getTime();
        }
      } else if (typeof value === 'number') {
        lockedUntil = value;
      }

      if (lockedUntil !== null && lockedUntil > now) {
        const d = new Date(lockedUntil).toISOString();
        lockouts.push(`${file} until ${d}`);
      }
    }

    if (lockouts.length === 0) {
      return { label, status: 'PASS', message: 'No stuck lockouts' };
    }

    return { label, status: 'WARN', message: `Lockout: ${lockouts.join('; ')}` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { label, status: 'WARN', message: `Could not parse tracker: ${msg}` };
  }
}

// ─────────────────────────────────────────
// Check 7: Ollama reachable
// ─────────────────────────────────────────
async function checkOllama(): Promise<CheckResult> {
  const label = 'Ollama reachable (semantic search)';

  try {
    const resp = await Promise.race<Response>([
      fetch('http://localhost:11434/api/version'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);

    if (!resp.ok) {
      return { label, status: 'WARN', message: `Ollama returned HTTP ${resp.status} (semantic search degraded to keyword-only)` };
    }

    const body = await resp.json() as { version?: string };
    const version = body.version ?? 'unknown';
    return { label, status: 'PASS', message: `Ollama running (version ${version})` };
  } catch {
    return { label, status: 'WARN', message: 'Ollama not reachable (semantic search degraded to keyword-only)' };
  }
}

// ─────────────────────────────────────────
// Check 8: MCP server responds
// ─────────────────────────────────────────
function checkMcpServer(): CheckResult {
  const label = 'MCP server responds';

  const initMsg = JSON.stringify({
    jsonrpc: '2.0',
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'doctor', version: '0.1.0' },
    },
    id: 1,
  });

  try {
    const result = spawnSync('recall-mcp', [], {
      input: initMsg + '\n',
      encoding: 'utf-8',
      timeout: 5000,
    });

    if (result.error) {
      throw result.error;
    }

    const stdout = result.stdout ?? '';

    // Parse first JSON line from stdout
    const firstLine = stdout.split('\n').find(l => l.trim().startsWith('{'));
    if (!firstLine) {
      return { label, status: 'FAIL', message: 'MCP server not responding (no JSON output)' };
    }

    const parsed = JSON.parse(firstLine) as { result?: { serverInfo?: { version?: string } } };
    const version = parsed.result?.serverInfo?.version ?? VERSION;
    return { label, status: 'PASS', message: `MCP server responds (recall-memory v${version})` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { label, status: 'FAIL', message: `MCP server not responding: ${msg}` };
  }
}

// ─────────────────────────────────────────
// Check 9: Claude CLI findable + CLAUDECODE
// ─────────────────────────────────────────
function checkClaudeCli(): CheckResult {
  const label = 'Claude CLI available (for extraction)';

  const warnings: string[] = [];

  // Check CLAUDECODE env var (blocks extraction when set)
  if (process.env.CLAUDECODE) {
    warnings.push('CLAUDECODE env var set (will block extraction)');
  }

  // Find claude binary
  try {
    const result = spawnSync('which', ['claude'], { encoding: 'utf-8', timeout: 3000 });
    const claudePath = (result.stdout ?? '').trim();

    if (!claudePath) {
      warnings.push('Claude CLI not found in PATH (extraction will not work)');
      return {
        label,
        status: 'WARN',
        message: warnings.join('; '),
      };
    }

    const base = `Claude CLI at ${claudePath}`;
    if (warnings.length > 0) {
      return { label, status: 'WARN', message: `${base} — ${warnings.join('; ')}` };
    }

    return { label, status: 'PASS', message: base };
  } catch {
    warnings.push('Could not run `which claude`');
    return { label, status: 'WARN', message: warnings.join('; ') };
  }
}

// ─────────────────────────────────────────
// Check 10: Growth report
// ─────────────────────────────────────────
function checkGrowth(): CheckResult {
  const label = 'Memory growth report';
  const memDir = join(homedir(), '.claude', 'MEMORY');
  const warnings: string[] = [];
  const info: string[] = [];

  // Count WORK/ dirs
  let workCount = 0;
  const workDir = join(memDir, 'WORK');
  if (existsSync(workDir)) {
    try {
      const entries = execSync(`ls -1 "${workDir}" 2>/dev/null | wc -l`, { encoding: 'utf-8' }).trim();
      workCount = parseInt(entries, 10) || 0;
    } catch {
      workCount = 0;
    }
  }
  info.push(`WORK: ${workCount} dirs`);
  if (workCount > 2000) {
    warnings.push(`WORK has ${workCount} dirs (threshold: 2000)`);
  }

  // Count algorithms/ files
  let algCount = 0;
  const algDir = join(memDir, 'algorithms');
  if (existsSync(algDir)) {
    try {
      const entries = execSync(`find "${algDir}" -type f 2>/dev/null | wc -l`, { encoding: 'utf-8' }).trim();
      algCount = parseInt(entries, 10) || 0;
    } catch {
      algCount = 0;
    }
  }
  info.push(`Algorithms: ${algCount} files`);

  // Count voice-greeted/ files
  let voiceCount = 0;
  const voiceDir = join(memDir, 'voice-greeted');
  if (existsSync(voiceDir)) {
    try {
      const entries = execSync(`find "${voiceDir}" -type f 2>/dev/null | wc -l`, { encoding: 'utf-8' }).trim();
      voiceCount = parseInt(entries, 10) || 0;
    } catch {
      voiceCount = 0;
    }
  }
  info.push(`Voice: ${voiceCount} files`);

  const summary = info.join(', ');

  if (warnings.length > 0) {
    return { label, status: 'WARN', message: `${summary} — ${warnings.join('; ')}` };
  }

  return { label, status: 'INFO', message: summary };
}

// ─────────────────────────────────────────
// Check: Recall-managed symlinks resolve correctly
// ─────────────────────────────────────────
//
// Returns an array of (CheckResult, optional repair fn). If --fix is set,
// runDoctor invokes the repair fn for any non-PASS result and re-checks.
export interface SymlinkProbe {
  label: string;
  target: string;     // path that should be the symlink (e.g. ~/.claude/hooks/X.ts)
  canonical: string;  // path the symlink should point at
}

function buildSymlinkProbes(): SymlinkProbe[] {
  const home = homedir();
  const root = join(home, '.agents', 'Recall');
  const probes: SymlinkProbe[] = [];

  // Hooks — managed by install-lib.sh as per-file symlinks. Use the new
  // Phase 2 names (RecallExtract.ts etc.) since fresh installs ship those.
  const hooks = ['RecallExtract', 'RecallStart', 'RecallPreCompact', 'RecallBatchExtract', 'RecallTelosSync', 'RecallClearExtract'];
  for (const h of hooks) {
    probes.push({
      label: `hook: ${h}.ts`,
      target: join(home, '.claude', 'hooks', `${h}.ts`),
      canonical: join(root, 'shared', 'hooks', `${h}.ts`),
    });
  }
  probes.push({
    label: 'extract_prompt.md',
    target: join(home, '.claude', 'MEMORY', 'extract_prompt.md'),
    canonical: join(root, 'shared', 'extract_prompt.md'),
  });
  probes.push({
    label: 'Recall_GUIDE.md (Claude)',
    target: join(home, '.claude', 'Recall_GUIDE.md'),
    canonical: join(root, 'claude', 'Recall_GUIDE.md'),
  });

  // Agent Skills — discovered dynamically from whatever canonicals exist
  // under the install root, so doctor adapts as skills are added/removed.
  // We hit this class of breakage in one user's install (install.sh ran
  // recall_copy_canonical but never reached recall_link); covering it here
  // lets `recall doctor --fix` repair without reinstall. (The former slash
  // commands migrated to these skills — #228.)
  const skillsCanonicalDir = join(root, 'shared', 'skills');
  if (existsSync(skillsCanonicalDir)) {
    let skillNames: string[] = [];
    try { skillNames = readdirSync(skillsCanonicalDir); } catch { skillNames = []; }
    for (const name of skillNames) {
      const skillDir = join(skillsCanonicalDir, name);
      let files: string[] = [];
      try { files = readdirSync(skillDir); } catch { continue; }
      for (const file of files) {
        probes.push({
          label: `agent skill: ${name}/${file}`,
          target: join(home, '.claude', 'skills', name, file),
          canonical: join(skillDir, file),
        });
      }
    }
  }

  return probes;
}

function hashFile(path: string): string | null {
  try {
    const buf = readFileSync(path);
    return createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

// Shared probe contract: a pure check plus an optional repair closure that
// runDoctor invokes under --fix. Used by both probeSymlink and probeMcpEnv.
interface ProbeCheck {
  result: CheckResult;
  repair?: () => CheckResult;
}

// Apply a probe's repair under --fix, degrading a thrown repair to a FAIL
// result so a single broken repair can't abort the doctor run before its
// summary prints. Exported for unit tests; the mcp-env call site in runDoctor
// routes through this. (The symlink-probe loop keeps its own inline handling.)
export function resolveProbeResult(check: ProbeCheck, fix: boolean): CheckResult {
  if (fix && check.repair && check.result.status !== 'PASS' && check.result.status !== 'INFO') {
    try {
      return check.repair();
    } catch (err) {
      return {
        label: check.result.label,
        status: 'FAIL',
        message: `Repair failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  return check.result;
}

// Exported for unit tests. The probe is pure (state lives entirely in the
// filesystem args, not in module globals); doctor's main loop iterates the
// build-time list and accumulates results.
export function probeSymlink(probe: SymlinkProbe): ProbeCheck {
  const { label, target, canonical } = probe;

  if (!existsSync(canonical)) {
    // The canonical file isn't present — this means the install root is
    // incomplete or this hook isn't shipped on this platform. Treat as INFO
    // (not a Recall-managed symlink to fix).
    return {
      result: { label, status: 'INFO', message: `Canonical not present at ${canonical}` },
    };
  }

  let st;
  try {
    st = lstatSync(target);
  } catch {
    // Target missing — fixable.
    return {
      result: { label, status: 'WARN', message: `Target missing: ${target}` },
      repair: () => {
        mkdirSync(dirname(target), { recursive: true });
        symlinkSync(canonical, target);
        return { label, status: 'PASS', message: `Created symlink: ${target}` };
      },
    };
  }

  if (st.isSymbolicLink()) {
    const current = readlinkSync(target);
    if (current === canonical) {
      return { result: { label, status: 'PASS', message: `Symlink OK: ${target}` } };
    }
    if (!existsSync(target)) {
      return {
        result: { label, status: 'FAIL', message: `Dangling symlink: ${target} → ${current}` },
        repair: () => {
          unlinkSync(target);
          symlinkSync(canonical, target);
          return { label, status: 'PASS', message: `Re-linked: ${target}` };
        },
      };
    }
    // Symlink points elsewhere (foreign symlink). Back up + relink.
    return {
      result: { label, status: 'WARN', message: `Foreign symlink: ${target} → ${current}` },
      repair: () => {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19).replace(/-/g, '');
        const backupDir = join(homedir(), '.agents', 'Recall', 'backups', stamp, 'doctor-fix');
        mkdirSync(backupDir, { recursive: true });
        copyFileSync(target, join(backupDir, target.replace(/[/\\]/g, '_')));
        unlinkSync(target);
        symlinkSync(canonical, target);
        return { label, status: 'PASS', message: `Backed up foreign link and re-linked: ${target}` };
      },
    };
  }

  // Regular file at the target — compare hashes.
  const tHash = hashFile(target);
  const cHash = hashFile(canonical);
  if (tHash && cHash && tHash === cHash) {
    return {
      result: { label, status: 'WARN', message: `Regular file (identical to canonical): ${target}` },
      repair: () => {
        unlinkSync(target);
        symlinkSync(canonical, target);
        return { label, status: 'PASS', message: `Converted identical file to symlink: ${target}` };
      },
    };
  }
  return {
    result: { label, status: 'WARN', message: `Drifted file (user-modified): ${target}` },
    repair: () => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19).replace(/-/g, '');
      const backupDir = join(homedir(), '.agents', 'Recall', 'backups', stamp, 'doctor-fix');
      mkdirSync(backupDir, { recursive: true });
      copyFileSync(target, join(backupDir, target.replace(/[/\\]/g, '_')));
      unlinkSync(target);
      symlinkSync(canonical, target);
      return { label, status: 'PASS', message: `Backed up drifted file and re-linked: ${target}` };
    },
  };
}

// ─────────────────────────────────────────
// Check: MCP registration carries env.RECALL_DB_PATH matching the resolved DB
// ─────────────────────────────────────────
//
// Pre-Phase-1 installs registered recall-memory via `claude mcp add`, which
// can't set an env block, leaving `env: {}`. The MCP server then resolves the
// DB path from defaults instead of the user's explicit RECALL_DB_PATH, so the
// server's DB view can silently diverge from the CLI's after the next Claude
// restart (issue #28). This probe + repair is the in-place fix for installs
// that predate `_recall_ensure_mcp_entry` in lib/install-lib.sh.
//
// Cross-language parallel (NOT a DRY violation — bash and TS can't share code):
// the repair below mirrors `_recall_ensure_mcp_entry` in lib/install-lib.sh —
// for each config file that owns the registration, ensure env is an object,
// set env.RECALL_DB_PATH to the resolved path, and drop the legacy MEM_DB_PATH
// key. Command/args rewrites stay owned by the installer; doctor only repairs
// the env block, which is the surgical fix issue #28 calls for.
export interface McpEnvProbe {
  configPaths: string[];   // candidate config files, in resolution order
  resolvedDbPath: string;  // getDbPath() — the value the env block should carry
}

interface McpEntry {
  env?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ClaudeConfig {
  mcpServers?: Record<string, McpEntry>;
  [key: string]: unknown;
}

interface McpRegistration {
  configPath: string;
  envDbPath: string | undefined; // value of env.RECALL_DB_PATH, if present
}

interface McpScan {
  owners: McpRegistration[];
  // Config files that exist but failed to parse — doctor must never touch a
  // file it can't read as JSON, so these are surfaced (WARN), not silently
  // conflated with a genuinely-absent registration.
  unparseable: string[];
}

// Locate every config file that owns an mcpServers["recall-memory"] entry.
// Mirrors the file selection in _recall_ensure_mcp_entry (exists + contains the
// registration). Malformed/unreadable JSON is never fatal, but it is recorded
// (not dropped) so the caller can distinguish it from a missing registration.
function findMcpRegistrations(configPaths: string[]): McpScan {
  const owners: McpRegistration[] = [];
  const unparseable: string[] = [];
  for (const configPath of configPaths) {
    if (!existsSync(configPath)) continue;
    let cfg: ClaudeConfig;
    try {
      cfg = JSON.parse(readFileSync(configPath, 'utf-8')) as ClaudeConfig;
    } catch {
      unparseable.push(configPath);
      continue;
    }
    const entry = cfg.mcpServers?.['recall-memory'];
    if (!entry || typeof entry !== 'object') continue;
    const env = entry.env;
    const raw = env && typeof env === 'object' && !Array.isArray(env) ? env.RECALL_DB_PATH : undefined;
    owners.push({ configPath, envDbPath: typeof raw === 'string' ? raw : undefined });
  }
  return { owners, unparseable };
}

// Exported for unit tests. Pure with respect to its args (config-file paths +
// resolved DB path); the repair closure patches the owning config file(s).
export function probeMcpEnv(probe: McpEnvProbe): ProbeCheck {
  const label = 'MCP env carries RECALL_DB_PATH';
  const { configPaths, resolvedDbPath } = probe;

  const { owners, unparseable } = findMcpRegistrations(configPaths);

  // A config that exists but can't be parsed is never silently dropped: doctor
  // names it and leaves it untouched. When there are no valid owners this is the
  // whole result (WARN); when there are valid owners it rides along as a note so
  // the malformed sibling can't hide behind a PASS/WARN/FAIL on the others.
  const unparseableNote = unparseable.length > 0
    ? ` — could not parse ${unparseable.join(', ')} (left untouched)`
    : '';

  // No config file owns the registration. Distinguish a genuinely-absent
  // registration (INFO — nothing to do) from a config that exists but is
  // unparseable (WARN — doctor refuses to touch a file it can't parse).
  if (owners.length === 0) {
    if (unparseable.length > 0) {
      return {
        result: {
          label,
          status: 'WARN',
          message: `config present but unparseable — refusing to touch ${unparseable.join(', ')}`,
        },
      };
    }
    return {
      result: { label, status: 'INFO', message: 'No recall-memory MCP registration found in user config' },
    };
  }

  // Healthy: every owner already carries the resolved DB path.
  const stale = owners.filter(o => o.envDbPath !== resolvedDbPath);
  if (stale.length === 0) {
    return {
      result: {
        label,
        status: 'PASS',
        message: `env.RECALL_DB_PATH matches resolved DB path in ${owners.length} config file(s)${unparseableNote}`,
      },
    };
  }

  // At least one owner has a missing/empty env or a divergent value — the
  // next-Claude-restart hazard from issue #28.
  const detail = stale
    .map(o => `${o.configPath} (${o.envDbPath === undefined ? 'env.RECALL_DB_PATH missing' : `has ${o.envDbPath}`})`)
    .join('; ');
  return {
    result: {
      label,
      status: 'WARN',
      message: `env.RECALL_DB_PATH should be ${resolvedDbPath} but ${detail} — MCP server may diverge from CLI on next Claude restart${unparseableNote}`,
    },
    repair: () => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19).replace(/-/g, '');
      const backupDir = join(homedir(), '.agents', 'Recall', 'backups', stamp, 'doctor-fix');
      const patched: string[] = [];
      const failed: string[] = [];
      for (const owner of stale) {
        // Per-file isolation: a write failure on one owner (EACCES, full disk,
        // read-only settings.json) must not abort the others or escape the loop.
        let tmpPath: string | undefined;
        try {
          const cfg = JSON.parse(readFileSync(owner.configPath, 'utf-8')) as ClaudeConfig;
          const entry = cfg.mcpServers?.['recall-memory'];
          if (!entry) continue; // registration vanished between probe and repair — nothing to back up or patch
          if (!entry.env || typeof entry.env !== 'object' || Array.isArray(entry.env)) entry.env = {};
          entry.env.RECALL_DB_PATH = resolvedDbPath;
          delete entry.env.MEM_DB_PATH;
          // Resolve through any symlink so the write goes THROUGH the link rather
          // than replacing it with a regular file (which would orphan the
          // canonical target and break stow/chezmoi-style dotfiles). Safe here:
          // the file was just read successfully.
          const target = realpathSync(owner.configPath);
          tmpPath = target + '.tmp';
          // Back up only once the write is confirmed to happen (after the re-read
          // + entry guard), so a vanished registration leaves no orphan backup.
          mkdirSync(backupDir, { recursive: true });
          copyFileSync(target, join(backupDir, owner.configPath.replace(/[/\\]/g, '_')));
          // Atomic write: stage to a temp sibling then rename over the resolved
          // target, so an interrupt mid-write can't truncate the user's config.
          writeFileSync(tmpPath, JSON.stringify(cfg, null, 2));
          renameSync(tmpPath, target);
          patched.push(owner.configPath);
        } catch (err) {
          if (tmpPath) { try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* best-effort temp cleanup */ } }
          // Capture the cause so a real EACCES/disk-full is diagnosable.
          failed.push(`${owner.configPath} (${err instanceof Error ? err.message : String(err)})`);
        }
      }
      // Every stale owner's registration vanished before we could patch it —
      // don't claim work that didn't happen.
      if (patched.length === 0 && failed.length === 0) {
        return { label, status: 'PASS', message: `Nothing to patch — registration(s) vanished before repair${unparseableNote}` };
      }
      if (failed.length > 0) {
        const patchedNote = patched.length ? `patched ${patched.join(', ')}; ` : '';
        return { label, status: 'FAIL', message: `${patchedNote}failed to patch ${failed.join(', ')}${unparseableNote}` };
      }
      return { label, status: 'PASS', message: `Patched env.RECALL_DB_PATH=${resolvedDbPath} in ${patched.join(', ')}${unparseableNote}` };
    },
  };
}

// ─────────────────────────────────────────
// Check: completion sentinel (#27)
// ─────────────────────────────────────────
//
// install.sh / update.sh write $RECALL_DIR/.install-incomplete at start and
// remove it only after the post-install self-check passes. A leftover marker
// means a prior run was interrupted before it could verify (SIGKILL, closed
// terminal, power loss) — the install may be partial. Warn-only: re-running
// ./install.sh converges (it is idempotent). Exported + path-injected so it is
// unit-testable without the real install root, mirroring probeSymlink/probeMcpEnv.
export function probeInstallSentinel(markerPath: string): CheckResult {
  const label = 'Install completed (no interrupted run)';
  if (!existsSync(markerPath)) {
    return { label, status: 'PASS', message: 'No interrupted install/update detected' };
  }
  let detail = '';
  try { detail = readFileSync(markerPath, 'utf-8').trim(); } catch { /* unreadable — still flag it */ }
  const suffix = detail ? ` (${detail})` : '';
  return {
    label,
    status: 'WARN',
    message: `A previous install/update did not finish${suffix} — re-run ./install.sh to converge (idempotent), or 'recall doctor --fix' for symlinks only`,
  };
}

// ─────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────
export async function runDoctor(opts: DoctorOptions = {}): Promise<void> {
  console.log('');
  console.log(`${C.bold}recall doctor — Memory Subsystem Health Check${C.reset}`);
  console.log(`${C.dim}${'─'.repeat(50)}${C.reset}`);
  console.log('');

  const results: CheckResult[] = [];

  // Run synchronous checks
  results.push(checkDatabase());
  results.push(checkMessages());
  results.push(checkStructuredData());
  results.push(checkFtsIndexes());
  results.push(checkExtractionFiles());
  results.push(checkExtractLog());
  results.push(checkTrackerLockouts());

  // Async check
  results.push(await checkOllama());

  // More synchronous checks
  results.push(checkMcpServer());
  results.push(checkClaudeCli());
  results.push(checkGrowth());

  // Symlink health checks (new in Phase 3 of the install-layout refactor).
  // Each probe returns a result + optional repair fn; with --fix we apply
  // repairs and substitute the post-repair result for the report.
  const symlinkChecks = buildSymlinkProbes().map(probeSymlink);
  for (const sc of symlinkChecks) {
    if (opts.fix && sc.repair && sc.result.status !== 'PASS' && sc.result.status !== 'INFO') {
      const fixed = sc.repair();
      results.push(fixed);
    } else {
      results.push(sc.result);
    }
  }

  // MCP env health (issue #28): the recall-memory registration must carry
  // env.RECALL_DB_PATH matching the resolved DB path, or the MCP server can
  // diverge from the CLI after the next Claude restart. Same repair contract as
  // the symlink probes — with --fix we patch the owning config file(s).
  const mcpEnvCheck = probeMcpEnv({
    configPaths: [join(homedir(), '.claude.json'), join(homedir(), '.claude', 'settings.json')],
    resolvedDbPath: getDbPath(),
  });
  results.push(resolveProbeResult(mcpEnvCheck, !!opts.fix));

  // Completion sentinel (#27): a leftover .install-incomplete marker means a
  // prior install/update was interrupted before its self-check ran. Warn-only —
  // re-running ./install.sh converges; doctor does not auto-repair it.
  results.push(probeInstallSentinel(join(homedir(), '.agents', 'Recall', '.install-incomplete')));

  // Print all results
  for (const r of results) {
    printResult(r);
  }

  // Score: PASS + INFO count as "passing"
  const passing = results.filter(r => r.status === 'PASS' || r.status === 'INFO').length;
  const total = results.length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const warned = results.filter(r => r.status === 'WARN').length;

  console.log('');
  console.log(`${C.dim}${'─'.repeat(50)}${C.reset}`);

  const scoreColor = failed > 0 ? C.fail : warned > 0 ? C.warn : C.pass;
  console.log(`  ${scoreColor}${C.bold}Health score: ${passing}/${total} checks passed${C.reset}`);

  if (failed > 0) {
    console.log(`  ${C.fail}${failed} critical failure(s) require attention${C.reset}`);
  }
  if (warned > 0) {
    console.log(`  ${C.warn}${warned} warning(s) may indicate degraded functionality${C.reset}`);
  }
  if (failed === 0 && warned === 0) {
    console.log(`  ${C.pass}All systems nominal${C.reset}`);
  }

  console.log('');
}
