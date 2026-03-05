// mem doctor — health check for all memory subsystems

import { existsSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { execSync, spawnSync } from 'child_process';
import { homedir } from 'os';
import { getDb, getDbPath } from '../db/connection.js';
import { VERSION } from '../version.js';

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
    const result = spawnSync('mem-mcp', [], {
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
// Main entry point
// ─────────────────────────────────────────
export async function runDoctor(): Promise<void> {
  console.log('');
  console.log(`${C.bold}mem doctor — Memory Subsystem Health Check${C.reset}`);
  console.log(`${C.dim}${'─'.repeat(50)}${C.reset}`);
  console.log('');

  const results: CheckResult[] = [];

  // Run synchronous checks
  results.push(checkDatabase());
  results.push(checkMessages());
  results.push(checkStructuredData());
  results.push(checkExtractionFiles());
  results.push(checkExtractLog());
  results.push(checkTrackerLockouts());

  // Async check
  results.push(await checkOllama());

  // More synchronous checks
  results.push(checkMcpServer());
  results.push(checkClaudeCli());
  results.push(checkGrowth());

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
