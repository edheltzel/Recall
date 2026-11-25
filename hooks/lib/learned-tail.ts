// Learned tail (#279): Recall's best notes, written as a Recall-owned
// <!-- recall:begin --> ... <!-- recall:end --> block into each global harness file.
// Self-contained: never imports from src/ (hooks/AGENTS.md). src/lib/learned-tail.ts re-exports it.
// Only the Recall pair is ever replaced; every other byte of a destination stays as it was.

import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
} from "node:path";
import { resolveDbPath } from "./db-path";
import { detectThreats } from "./threat-detect";
import { scrub } from "./write-safety";

export const RECALL_BEGIN = "<!-- recall:begin -->";
export const RECALL_END = "<!-- recall:end -->";
export const GAP_BEGIN = "<!-- gap:begin -->";
export const GAP_END = "<!-- gap:end -->";
export const MAX_TAIL_TOKENS = 600;
export const MAX_TAIL_BULLETS = 15;
export const MAX_BULLET_CHARS = 200;
export const MIN_TAIL_IMPORTANCE = 8;
export const MIN_TAIL_SESSIONS = 2;
export const TAIL_HEADER_PREFIX = "Written by Recall, last updated ";
export const GAP_POLICY_FILES = [
  ".claude/rules/global-agent-policy.md",
  ".pi/agent/APPEND_SYSTEM.md",
  ".omp/agent/APPEND_SYSTEM.md",
  ".cursor/rules/global-agent-policy.mdc",
  ".empryo/EMPRYO.md",
];
export const BUILTIN_TAIL_FILES = [
  ".claude/CLAUDE.md",
  ".codex/AGENTS.md",
  ".pi/agent/APPEND_SYSTEM.md",
  ".omp/agent/APPEND_SYSTEM.md",
  ".empryo/EMPRYO.md",
];

const HEADER_RE = /^Written by Recall, last updated (\d{4}-\d{2}-\d{2})\.$/;

export type TailTable = "decisions" | "learnings";

export interface TailCandidate {
  table: TailTable;
  id: number;
  text: string;
  importance: number;
  provenance: string | null;
  confidence: string | null;
  accessCount: number;
  sessionId: string | null;
  project: string | null;
  createdAt: string;
}

export interface TailRecordRef {
  table: TailTable;
  id: number;
}

export interface TailNote {
  key: string;
  text: string;
  importance: number;
  sessions: number;
  accessCount: number;
  records: TailRecordRef[];
  projects: string[];
  firstSeen: string;
  lastSeen: string;
}

export type TailDropReason =
  | "secret"
  | "threat"
  | "unsafe"
  | "length"
  | "duplicate"
  | "unproven"
  | "covered"
  | "cap";

export interface DroppedTailNote {
  key: string;
  reason: TailDropReason;
  detail?: string;
}

export interface TailSelection {
  notes: TailNote[];
  dropped: DroppedTailNote[];
  tokens: number;
}

export type BulletCheck =
  | { ok: true; text: string }
  | { ok: false; reason: TailDropReason; detail?: string };

export interface TailEnv {
  home?: string;
  path?: string;
  codexHome?: string;
  jcodeHome?: string;
}

export interface TailDestination {
  path: string;
  source: "gap" | "builtin";
}

export interface SkippedTailDestination {
  path: string;
  reason: string;
}

export interface TailDestinationScan {
  gap: boolean;
  destinations: TailDestination[];
  skipped: SkippedTailDestination[];
}

export interface RecallBlockInfo {
  present: boolean;
  malformed: boolean;
  updated: string | null;
  bullets: string[];
  tokens: number;
}

export type SpliceResult =
  { ok: true; text: string; changed: boolean } | { ok: false; reason: string };

export interface TailDestinationPlan {
  path: string;
  source: "gap" | "builtin";
  before: string;
  after: string;
  beforeHash: string;
  changed: boolean;
  refused?: string;
}

export interface TailPlan {
  date: string;
  inventory?: string;
  gap: boolean;
  selection: TailSelection;
  block: string | null;
  destinations: TailDestinationPlan[];
  skipped: SkippedTailDestination[];
}

export interface TailWriteResult {
  path: string;
  status: "written" | "unchanged" | "refused";
  reason?: string;
}

export interface PlanTailOptions extends TailEnv {
  dbPath?: string;
  now?: Date;
  candidates?: TailCandidate[];
}

interface TableSpec {
  table: TailTable;
  text: string;
  columns: string[];
}

const TABLE_SPECS: TableSpec[] = [
  { table: "decisions", text: "t.decision", columns: ["decision"] },
  {
    table: "learnings",
    text: "COALESCE(NULLIF(TRIM(t.prevention), ''), NULLIF(TRIM(t.solution), ''))",
    columns: ["prevention", "solution"],
  },
];

const REQUIRED_COLUMNS = [
  "id",
  "importance",
  "provenance",
  "confidence",
  "access_count",
  "session_id",
  "project",
  "created_at",
];

export function estimateTailTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function formatTailDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function loadTailCandidates(
  dbPath: string = resolveDbPath(),
): TailCandidate[] {
  if (!existsSync(dbPath))
    throw new Error(`Recall database not found: ${dbPath}`);
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = new Set(
      (
        db
          .query("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as { name: string }[]
      ).map((r) => r.name),
    );
    const out: TailCandidate[] = [];
    for (const spec of TABLE_SPECS) {
      if (!tables.has(spec.table)) continue;
      const cols = new Set(
        (
          db.query(`PRAGMA table_info(${spec.table})`).all() as {
            name: string;
          }[]
        ).map((r) => r.name),
      );
      if (![...REQUIRED_COLUMNS, ...spec.columns].every((c) => cols.has(c)))
        continue;
      const where = ["t.confidence IN ('high', 'medium')"];
      if (cols.has("status")) where.push("t.status = 'active'");
      if (tables.has("dedup_lineage")) {
        where.push(
          `NOT EXISTS (SELECT 1 FROM dedup_lineage dl WHERE dl.duplicate_table = '${spec.table}' AND dl.duplicate_id = t.id AND dl.status = 'marked')`,
        );
      }
      const rows = db
        .query(
          `SELECT t.id AS id, ${spec.text} AS text, t.importance AS importance, t.provenance AS provenance,
                    t.confidence AS confidence, t.access_count AS access_count, t.session_id AS session_id,
                    t.project AS project, t.created_at AS created_at
             FROM ${spec.table} t WHERE ${where.join(" AND ")} ORDER BY t.id`,
        )
        .all() as Array<{
        id: number;
        text: string | null;
        importance: number | null;
        provenance: string | null;
        confidence: string | null;
        access_count: number | null;
        session_id: string | null;
        project: string | null;
        created_at: string | null;
      }>;
      for (const r of rows) {
        if (typeof r.text !== "string" || !r.text.trim()) continue;
        out.push({
          table: spec.table,
          id: r.id,
          text: r.text,
          importance: r.importance ?? 0,
          provenance: r.provenance,
          confidence: r.confidence,
          accessCount: r.access_count ?? 0,
          sessionId: r.session_id,
          project: r.project,
          createdAt: r.created_at ?? "",
        });
      }
    }
    return out;
  } finally {
    db.close();
  }
}

export function sanitizeTailBullet(raw: string): BulletCheck {
  const scrubbed = scrub(raw);
  if (scrubbed.redactions.length > 0)
    return {
      ok: false,
      reason: "secret",
      detail: scrubbed.redactions.join(", "),
    };
  if (scrubbed.text !== raw)
    return { ok: false, reason: "unsafe", detail: "invisible unicode" };
  const threats = detectThreats(raw);
  if (threats.length > 0) {
    return {
      ok: false,
      reason: "threat",
      detail: [...new Set(threats.map((t) => t.category))].join(", "),
    };
  }
  if (/<!--|-->/.test(raw))
    return { ok: false, reason: "unsafe", detail: "comment marker" };
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(raw)) {
    return { ok: false, reason: "unsafe", detail: "control character" };
  }
  let text = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:[#>]+\s*|[-*+]\s+)+/, "")
    .trim();
  if (!text) return { ok: false, reason: "unsafe", detail: "empty" };
  if (text.length > MAX_BULLET_CHARS) {
    const first = text.split(/(?<=[.!?])\s+/)[0] ?? "";
    if (first.length === 0 || first.length > MAX_BULLET_CHARS) {
      return { ok: false, reason: "length", detail: `${text.length} chars` };
    }
    text = first;
  }
  return { ok: true, text };
}

function foldCase(text: string): string {
      const runs = [...text.matchAll(/`+/g)].map((m) => ({
        start: m.index,
        length: m[0].length,
      }));
      let out = "";
      let at = 0;
      for (let i = 0; i < runs.length; i++) {
        const open = runs[i];
        const close = runs.findIndex((r, j) => j > i && r.length === open.length);
        if (close < 0) continue;
        const end = runs[close].start + runs[close].length;
        out += text.slice(at, open.start).toLowerCase() + text.slice(open.start, end);
        at = end;
        i = close;
      }
      return out + text.slice(at).toLowerCase();
}

function matchForm(text: string): string {
  return foldCase(text.normalize("NFKC"))
    .trim()
    .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/[.!?;:,]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isCoveredByGap(note: string, gapText: string): boolean {
  const n = matchForm(note);
  if (!n) return false;
  return gapText
    .split(/\r?\n+/)
    .flatMap((line) => [line, ...line.split(/(?<=[.!?])\s+/)])
    .some((unit) => matchForm(unit) === n);
}

function provenRecord(c: TailCandidate): boolean {
  return (
    c.confidence === "high" &&
    (c.importance >= MIN_TAIL_IMPORTANCE || c.provenance === "user_authored")
  );
}

function knownSessions(members: TailCandidate[]): number {
  return new Set(
    members.map((m) => m.sessionId).filter((s): s is string => !!s),
  ).size;
}

function candidateKey(c: { table: TailTable; id: number }): string {
  return `${c.table}:${c.id}`;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function renderOrder(a: TailNote, b: TailNote): number {
  return (
    b.importance - a.importance ||
    compareText(a.firstSeen, b.firstSeen) ||
    compareText(a.key, b.key)
  );
}

export function renderTailBlock(notes: TailNote[], date: string): string {
  const bullets = notes.map((n) => `- ${n.text}`).join("\n");
  return `${RECALL_BEGIN}\n${TAIL_HEADER_PREFIX}${date}.\n\n${bullets}\n${RECALL_END}\n`;
}

export function selectTail(
  candidates: TailCandidate[],
  options: { gapText?: string; cap?: boolean } = {},
): TailSelection {
  const gapText = options.gapText ?? "";
  const cap = options.cap ?? true;
  const dropped: DroppedTailNote[] = [];
  const safe: Array<TailCandidate & { clean: string }> = [];
  for (const c of candidates) {
    const check = sanitizeTailBullet(c.text);
    if (check.ok) safe.push({ ...c, clean: check.text });
    else
      dropped.push({
        key: candidateKey(c),
        reason: check.reason,
        detail: check.detail,
      });
  }
  safe.sort(
    (a, b) =>
      b.importance - a.importance ||
      b.accessCount - a.accessCount ||
      compareText(a.createdAt, b.createdAt) ||
      compareText(candidateKey(a), candidateKey(b)),
  );

  const clusters: Array<{
    lead: TailCandidate & { clean: string };
    form: string;
    members: TailCandidate[];
  }> = [];
  for (const c of safe) {
    const form = matchForm(c.clean);
    // Same normalized text only. Embedding similarity is not a merge:
    // distinct rules with close vectors would be dropped, and their
    // projects would count toward the survivor's promotion bar.
    const home = clusters.find((k) => k.form === form);
    if (home) {
      home.members.push(c);
      dropped.push({
        key: candidateKey(c),
        reason: "duplicate",
        detail: `merged into ${candidateKey(home.lead)}`,
      });
    } else {
      clusters.push({ lead: c, form, members: [c] });
    }
  }

  const proven = clusters.filter(({ lead, members }) => {
    if (members.some(provenRecord) || knownSessions(members) >= MIN_TAIL_SESSIONS)
      return true;
    dropped.push({
      key: candidateKey(lead),
      reason: "unproven",
      detail: `1 session, needs ${MIN_TAIL_SESSIONS} or a high-confidence note at importance ${MIN_TAIL_IMPORTANCE}+`,
    });
    return false;
  });

  const ranked: TailNote[] = proven
    .map(({ lead, members }) => {
      const created = members.map((m) => m.createdAt).sort(compareText);
      return {
        key: candidateKey(lead),
        text: lead.clean,
        importance: Math.max(...members.map((m) => m.importance)),
        sessions: knownSessions(members),
        accessCount: members.reduce((sum, m) => sum + m.accessCount, 0),
        records: members.map((m) => ({ table: m.table, id: m.id })),
        projects: [
          ...new Set(
            members.map((m) => m.project).filter((p): p is string => !!p),
          ),
        ].sort(compareText),
        firstSeen: created[0] ?? "",
        lastSeen: created[created.length - 1] ?? "",
      };
    })
    .sort(
      (a, b) =>
        b.importance - a.importance ||
        b.sessions - a.sessions ||
        b.accessCount - a.accessCount ||
        compareText(a.firstSeen, b.firstSeen) ||
        compareText(a.key, b.key),
    );

  const chosen: TailNote[] = [];
  for (const note of ranked) {
    if (isCoveredByGap(note.text, gapText)) {
      dropped.push({
        key: note.key,
        reason: "covered",
        detail: "already in the GAP block",
      });
      continue;
    }
    if (!cap) {
      chosen.push(note);
      continue;
    }
    if (chosen.length >= MAX_TAIL_BULLETS) {
      dropped.push({
        key: note.key,
        reason: "cap",
        detail: `${MAX_TAIL_BULLETS} bullets`,
      });
      continue;
    }
    const trial = [...chosen, note].sort(renderOrder);
    if (
      estimateTailTokens(renderTailBlock(trial, "0000-00-00")) > MAX_TAIL_TOKENS
    ) {
      dropped.push({
        key: note.key,
        reason: "cap",
        detail: `${MAX_TAIL_TOKENS} tokens`,
      });
      continue;
    }
    chosen.push(note);
  }
  const notes = chosen.sort(renderOrder);
  return {
    notes,
    dropped,
    tokens: notes.length
      ? estimateTailTokens(renderTailBlock(notes, "0000-00-00"))
      : 0,
  };
}

function findMarkerLine(
  text: string,
  marker: string,
  from: number,
): [number, number] | null {
  while (from < text.length) {
    let i = text.indexOf(marker, from);
    if (i < 0) return null;
    const after = i + marker.length;
    if (i > 0 && text[i - 1] !== "\n") {
      from = i + 1;
      continue;
    }
    if (after === text.length) return [i, after];
    if (text[after] === "\n") return [i, after + 1];
    if (text[after] === "\r" && text[after + 1] === "\n") return [i, after + 2];
    from = i + 1;
  }
  return null;
}

function allMarkerLines(text: string, marker: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let from = 0; ;) {
    const hit = findMarkerLine(text, marker, from);
    if (!hit) return out;
    out.push(hit);
    from = hit[1];
  }
}

interface GapSpan {
  start: number;
  innerStart: number;
  innerEnd: number;
  end: number;
}

function gapSpans(text: string): GapSpan[] {
  const spans: GapSpan[] = [];
  for (let from = 0; ;) {
    let begin = findMarkerLine(text, GAP_BEGIN, from);
    if (!begin) return spans;
    const end = findMarkerLine(text, GAP_END, begin[1]);
    if (!end) return spans;
    for (;;) {
      const next = findMarkerLine(text, GAP_BEGIN, begin[1]);
      if (!next || next[0] >= end[0]) break;
      begin = next;
    }
    spans.push({
      start: begin[0],
      innerStart: begin[1],
      innerEnd: end[0],
      end: end[1],
    });
    from = end[1];
  }
}

function gapSpan(text: string): GapSpan | null {
  return gapSpans(text).at(-1) ?? null;
}

export function gapBlockText(text: string): string | null {
  const span = gapSpan(text);
  return span ? text.slice(span.innerStart, span.innerEnd) : null;
}

type RecallSpan =
  | { kind: "none" }
  | { kind: "malformed"; reason: string }
  | {
      kind: "found";
      start: number;
      innerStart: number;
      innerEnd: number;
      end: number;
    };

function recallSpan(text: string): RecallSpan {
  const begins = allMarkerLines(text, RECALL_BEGIN);
  const ends = allMarkerLines(text, RECALL_END);
  if (begins.length === 0 && ends.length === 0) return { kind: "none" };
  if (begins.length !== 1 || ends.length !== 1) {
    return {
      kind: "malformed",
      reason: `expected one Recall marker pair, found ${begins.length} begin and ${ends.length} end`,
    };
  }
  const [begin] = begins;
  const [end] = ends;
  if (end[0] < begin[1])
    return {
      kind: "malformed",
      reason: "Recall end marker comes before its begin marker",
    };
  const gapMarks = [
    ...allMarkerLines(text, GAP_BEGIN),
    ...allMarkerLines(text, GAP_END),
  ];
  if (gapMarks.some(([at]) => at >= begin[0] && at < end[1])) {
    return {
      kind: "malformed",
      reason: "Recall block wraps a GAP marker",
    };
  }
  const inside = (at: number) =>
    gapSpans(text).some((gap) => at >= gap.start && at < gap.end);
  if (inside(begin[0]) || inside(end[0])) {
    return {
      kind: "malformed",
      reason: "Recall marker sits inside the GAP block",
    };
  }
  return {
    kind: "found",
    start: begin[0],
    innerStart: begin[1],
    innerEnd: end[0],
    end: end[1],
  };
}

export function readRecallBlock(text: string): RecallBlockInfo {
  const span = recallSpan(text);
  if (span.kind === "none")
    return {
      present: false,
      malformed: false,
      updated: null,
      bullets: [],
      tokens: 0,
    };
  if (span.kind === "malformed")
    return {
      present: true,
      malformed: true,
      updated: null,
      bullets: [],
      tokens: 0,
    };
  const inner = text.slice(span.innerStart, span.innerEnd);
  const lines = inner.split(/\r?\n/);
  const header = lines.map((l) => HEADER_RE.exec(l)).find((m) => m !== null);
  return {
    present: true,
    malformed: false,
    updated: header ? header[1] : null,
    bullets: lines.filter((l) => l.startsWith("- ")).map((l) => l.slice(2)),
    tokens: estimateTailTokens(text.slice(span.start, span.end)),
  };
}

function blockEndsFile(text: string, end: number): boolean {
  return end === text.length && !text.endsWith("\n");
}

function removeSpan(text: string, start: number, end: number): string {
  const sep =
    start >= 2 && text[start - 1] === "\n" && text[start - 2] === "\n";
  const cut = !sep ? start : blockEndsFile(text, end) ? start - 2 : start - 1;
  return text.slice(0, cut) + text.slice(end);
}

export function removeRecallBlock(text: string): SpliceResult {
  const span = recallSpan(text);
  if (span.kind === "malformed") return { ok: false, reason: span.reason };
  if (span.kind === "none") return { ok: true, text, changed: false };
  return {
    ok: true,
    text: removeSpan(text, span.start, span.end),
    changed: true,
  };
}

export function spliceRecallBlock(
  text: string,
  notes: TailNote[],
  date: string,
): SpliceResult {
  const span = recallSpan(text);
  if (span.kind === "malformed") return { ok: false, reason: span.reason };
  if (notes.length === 0) {
    if (span.kind === "none") return { ok: true, text, changed: false };
    return {
      ok: true,
      text: removeSpan(text, span.start, span.end),
      changed: true,
    };
  }
  const block = renderTailBlock(notes, date);
  if (span.kind === "none") {
    if (text === "") return { ok: true, text: block, changed: true };
    if (text.endsWith("\n"))
      return { ok: true, text: `${text}\n${block}`, changed: true };
    return {
      ok: true,
      text: `${text}\n\n${block.slice(0, -1)}`,
      changed: true,
    };
  }
  const existing = readRecallBlock(text);
  const same =
    existing.updated !== null &&
    existing.bullets.length === notes.length &&
    existing.bullets.every((b, i) => b === notes[i].text);
  if (same) return { ok: true, text, changed: false };
  const fitted = blockEndsFile(text, span.end) ? block.slice(0, -1) : block;
  const next = text.slice(0, span.start) + fitted + text.slice(span.end);
  return { ok: true, text: next, changed: next !== text };
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function gapOnPath(pathEnv: string): boolean {
  return pathEnv
    .split(delimiter)
    .filter((dir) => dir !== "")
    .some((dir) => isExecutableFile(join(dir, "gap")));
}

export function readGapLedger(home: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(home, ".gap", "published.json"), "utf8"),
    );
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function regularFileProblem(path: string): string | null {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return "symlink";
    if (!st.isFile()) return "not a regular file";
    return null;
  } catch {
    return "missing";
  }
}

function resolveEnv(env: TailEnv): { home: string; pathEnv: string } {
  return {
    home:
      env.home ?? (process.env.HOME || process.env.USERPROFILE || homedir()),
    pathEnv: env.path ?? process.env.PATH ?? "",
  };
}

function harnessHome(
  value: string | undefined,
  fallback: string,
  refuseEmpty: boolean,
): string | null {
  if (value === undefined) return fallback;
  if (value === "") return refuseEmpty ? null : fallback;
  return isAbsolute(value) ? value : null;
}

export function gapPolicyDestinations(env: TailEnv = {}): string[] {
  const { home } = resolveEnv(env);
  const out = GAP_POLICY_FILES.map((rel) => join(home, rel));
  const codex = harnessHome(
    env.codexHome ?? process.env.CODEX_HOME,
    join(home, ".codex"),
    false,
  );
  if (codex) out.push(join(codex, "gap", "global-agent-policy.md"));
  const jcode = harnessHome(
    env.jcodeHome ?? process.env.JCODE_HOME,
    join(home, ".jcode"),
    true,
  );
  if (jcode) out.push(join(jcode, "prompt-overlay.md"));
  return [...new Set(out)].sort(compareText);
}

export function learnedTailCleanupPaths(env: TailEnv = {}): {
  paths: string[];
  inventoryError: string | null;
} {
  const { home } = resolveEnv(env);
  const inventory = tailInventoryPath(env);
  let written: string[] = [];
  let inventoryError: string | null = null;
  try {
    written = readTailInventory(inventory);
  } catch (err) {
    inventoryError = `${inventory}: ${err instanceof Error ? err.message : String(err)}`;
  }
  const paths = [
    ...new Set([
      ...gapPolicyDestinations(env),
      ...BUILTIN_TAIL_FILES.map((rel) => join(home, rel)),
      ...written,
    ]),
  ].sort(compareText);
  return { paths, inventoryError };
}

export function findTailDestinations(env: TailEnv = {}): TailDestinationScan {
  const { home, pathEnv } = resolveEnv(env);
  const ledger = gapOnPath(pathEnv) ? readGapLedger(home) : null;
  const destinations: TailDestination[] = [];
  const skipped: SkippedTailDestination[] = [];
  if (ledger) {
    for (const path of gapPolicyDestinations(env)) {
      const value = ledger[path];
      if (value === undefined) continue;
      if (value === "cleaned") {
        skipped.push({ path, reason: "cleaned ledger entry" });
        continue;
      }
      if (typeof value !== "string") {
        skipped.push({ path, reason: "unreadable ledger entry" });
        continue;
      }
      const problem = regularFileProblem(path);
      if (problem) {
        skipped.push({ path, reason: problem });
        continue;
      }
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        skipped.push({ path, reason: "unreadable" });
        continue;
      }
      if (gapSpan(text) === null) {
        skipped.push({ path, reason: "no GAP block" });
        continue;
      }
      destinations.push({ path, source: "gap" });
    }
    return { gap: true, destinations, skipped };
  }
  for (const rel of BUILTIN_TAIL_FILES) {
    const path = join(home, rel);
    const problem = regularFileProblem(path);
    if (problem) skipped.push({ path, reason: problem });
    else destinations.push({ path, source: "builtin" });
  }
  return { gap: false, destinations, skipped };
}

export function readGapCoverageText(paths: string[]): string {
  const seen = new Set<string>();
  for (const path of paths) {
    try {
      const inner = gapBlockText(readFileSync(path, "utf8"));
      if (inner) seen.add(inner);
    } catch {
      continue;
    }
  }
  return [...seen].join("\n");
}

function readUtf8Exact(
  path: string,
): { text: string; hash: string } | { error: string } {
  const problem = regularFileProblem(path);
  if (problem) return { error: problem };
  const bytes = readFileSync(path);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes))
    return { error: "not valid UTF-8" };
  return { text, hash: sha256(bytes) };
}

export const TAIL_STATE_FILE = "learned-tail-state.json";

export interface TailState {
  refreshedAt: number;
  tailSince: Record<string, string>;
}

export const TAIL_INVENTORY_FILE = "learned-tail-destinations.txt";

export function tailInventoryPath(env: TailEnv = {}): string {
  return join(resolveEnv(env).home, ".agents", "Recall", TAIL_INVENTORY_FILE);
}

export function readTailInventory(path: string): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
  return [
    ...new Set(text.split("\n").filter((p) => p !== "" && isAbsolute(p))),
  ].sort(compareText);
}

export function registerTailDestination(inventory: string, path: string): void {
  if (/[\r\n]/.test(path)) throw new Error("path contains a line break");
  if (readTailInventory(inventory).includes(path)) return;
  mkdirSync(dirname(inventory), { recursive: true });
  appendFileSync(inventory, `\n${path}\n`, { mode: 0o600 });
  if (!readTailInventory(inventory).includes(path))
    throw new Error("registration did not land");
}

export function tailNoteKey(text: string): string {
  return matchForm(text);
}

export function tailStatePath(dbPath: string = resolveDbPath()): string {
  return join(dirname(dbPath), TAIL_STATE_FILE);
}

export function readTailState(path: string): TailState {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const since: Record<string, string> = {};
    if (parsed?.tailSince && typeof parsed.tailSince === "object") {
      for (const [k, v] of Object.entries(parsed.tailSince)) {
        if (typeof v === "string" && !Number.isNaN(Date.parse(v))) since[k] = v;
      }
    }
    return {
      refreshedAt:
        Number.isFinite(parsed?.refreshedAt) && parsed.refreshedAt > 0
          ? parsed.refreshedAt
          : 0,
      tailSince: since,
    };
  } catch {
    return { refreshedAt: 0, tailSince: {} };
  }
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
  );
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function readWrittenTailKeys(texts: string[]): Set<string> {
  const keys = new Set<string>();
  for (const text of texts) {
    const block = readRecallBlock(text);
    if (block.malformed) continue;
    for (const bullet of block.bullets) keys.add(tailNoteKey(bullet));
  }
  return keys;
}

export function readWrittenTailKeysFrom(paths: string[]): Set<string> {
  const texts: string[] = [];
  for (const path of paths) {
    try {
      texts.push(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
  }
  return readWrittenTailKeys(texts);
}

export function nextTailState(
  state: TailState,
  notes: TailNote[],
  now: Date,
  written: Set<string> = new Set(),
): TailState {
  const tailSince: Record<string, string> = {};
  for (const note of notes) {
    const key = tailNoteKey(note.text);
    const since = written.has(key) ? state.tailSince[key] : undefined;
    tailSince[key] = since ?? now.toISOString();
  }
  return { refreshedAt: now.getTime(), tailSince };
}

export function recordTailRefresh(
  path: string,
  plan: TailPlan,
  writes: TailWriteResult[],
  now: Date = new Date(),
): boolean {
  if (writes.some((w) => w.status === "refused")) return false;
  const landed = writes.some(
    (w) => w.status === "written" || w.status === "unchanged",
  );
  const written = readWrittenTailKeys(
    (plan.destinations ?? []).map((d) => d.before),
  );
  writeJsonFile(
    path,
    nextTailState(
      readTailState(path),
      landed ? plan.selection.notes : [],
      now,
      written,
    ),
  );
  return true;
}

export function countRecordsSince(
  sinceMs: number,
  dbPath: string = resolveDbPath(),
): number {
  if (!existsSync(dbPath)) return 0;
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = new Set(
      (
        db
          .query("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as { name: string }[]
      ).map((r) => r.name),
    );
    const since = new Date(sinceMs).toISOString();
    let total = 0;
    for (const spec of TABLE_SPECS) {
      if (!tables.has(spec.table)) continue;
      const row = db
        .query(
          `SELECT COUNT(*) AS n FROM ${spec.table} WHERE julianday(created_at) > julianday(?)`,
        )
        .get(since) as { n: number } | null;
      total += row?.n ?? 0;
    }
    return total;
  } finally {
    db.close();
  }
}

export function planLearnedTail(options: PlanTailOptions = {}): TailPlan {
  const scan = findTailDestinations(options);
  const date = formatTailDate(options.now ?? new Date());
  const gapText = readGapCoverageText(scan.destinations.map((d) => d.path));
  const candidates = options.candidates ?? loadTailCandidates(options.dbPath);
  const selection = selectTail(candidates, { gapText });
  const destinations: TailDestinationPlan[] = scan.destinations.map((d) => {
    let read: { text: string; hash: string } | { error: string };
    try {
      read = readUtf8Exact(d.path);
    } catch (err) {
      read = { error: err instanceof Error ? err.message : String(err) };
    }
    if ("error" in read) {
      return {
        ...d,
        before: "",
        after: "",
        beforeHash: "",
        changed: false,
        refused: read.error,
      };
    }
    const spliced = spliceRecallBlock(read.text, selection.notes, date);
    if (!spliced.ok) {
      return {
        ...d,
        before: read.text,
        after: read.text,
        beforeHash: read.hash,
        changed: false,
        refused: spliced.reason,
      };
    }
    return {
      ...d,
      before: read.text,
      after: spliced.text,
      beforeHash: read.hash,
      changed: spliced.changed,
    };
  });
  return {
    date,
    inventory: tailInventoryPath(options),
    gap: scan.gap,
    selection,
    block: selection.notes.length
      ? renderTailBlock(selection.notes, date)
      : null,
    destinations,
    skipped: scan.skipped,
  };
}

function currentHash(path: string): string | null {
  if (regularFileProblem(path)) return null;
  return sha256(readFileSync(path));
}

export function writeIfUnchanged(
  path: string,
  expectedHash: string,
  content: string,
): TailWriteResult {
  let tmp: string | null = null;
  try {
    if (currentHash(path) !== expectedHash)
      return { path, status: "refused", reason: "changed since it was read" };
    const mode = lstatSync(path).mode & 0o7777;
    tmp = join(
      dirname(path),
      `.${basename(path)}.recall-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
    );
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, mode);
    if (currentHash(path) !== expectedHash) {
      rmSync(tmp, { force: true });
      return { path, status: "refused", reason: "changed during the write" };
    }
    renameSync(tmp, path);
    tmp = null;
    return { path, status: "written" };
  } catch (err) {
    if (tmp) rmSync(tmp, { force: true });
    return {
      path,
      status: "refused",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}


export type RecallRemovalPlan =
  | { path: string; beforeHash: string; after: string; changed: boolean }
  | { path: string; refused: string };

export function planRecallBlockRemoval(path: string): RecallRemovalPlan {
  let read: { text: string; hash: string } | { error: string };
  try {
    read = readUtf8Exact(path);
  } catch (err) {
    read = { error: err instanceof Error ? err.message : String(err) };
  }
  if ("error" in read) return { path, refused: read.error };
  const removed = removeRecallBlock(read.text);
  if (!removed.ok) return { path, refused: removed.reason };
  return {
    path,
    beforeHash: read.hash,
    after: removed.text,
    changed: removed.changed,
  };
}

export function removeRecallBlockFromFile(path: string): TailWriteResult {
  const plan = planRecallBlockRemoval(path);
  if ("refused" in plan)
    return { path, status: "refused", reason: plan.refused };
  if (!plan.changed) return { path, status: "unchanged" };
  return writeIfUnchanged(path, plan.beforeHash, plan.after);
}

export function writeLearnedTail(plan: TailPlan): TailWriteResult[] {
  return plan.destinations.map((d) => {
    if (d.refused)
      return { path: d.path, status: "refused", reason: d.refused };
    if (plan.inventory && readRecallBlock(d.after).present) {
      try {
        registerTailDestination(plan.inventory, d.path);
      } catch (err) {
        return {
          path: d.path,
          status: "refused",
          reason: `cannot record it for uninstall: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    if (!d.changed) return { path: d.path, status: "unchanged" };
    return writeIfUnchanged(d.path, d.beforeHash, d.after);
  });
}
