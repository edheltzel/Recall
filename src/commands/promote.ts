// recall promote — read-only list of learned-tail notes that meet the Lane B bar (#279).
// A note qualifies when it has been in the written tail for 14+ days (tracked in
// learned-tail-state.json) and has been seen in 3+ distinct projects,
// and the published GAP policy text does not already cover it. This command writes nothing.

import {
  findTailDestinations,
  isCoveredByGap,
  loadTailCandidates,
  readGapCoverageText,
  readTailState,
  selectTail,
  tailNoteKey,
  tailStatePath,
} from "../lib/learned-tail.js";
import type { TailCandidate, TailNote } from "../lib/learned-tail.js";

export const MIN_PROMOTE_PROJECTS = 3;
export const MIN_TAIL_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PromoteOptions {
  json?: boolean;
  now?: Date;
  home?: string;
  path?: string;
  dbPath?: string;
}

export interface PromotionCandidate {
  text: string;
  records: Array<{ table: string; id: number }>;
  projects: string[];
  firstSeen: string;
  lastSeen: string;
  daysInTail: number;
}

export interface PromoteReport {
  gap: boolean;
  candidates: PromotionCandidate[];
  skipped: Array<{ text: string; reason: string }>;
}

function seenMs(value: string): number | null {
  const ms = Date.parse(
    value.includes("T") ? value : value.replace(" ", "T") + "Z",
  );
  return Number.isNaN(ms) ? null : ms;
}

export function daysInTail(firstSeen: string, now: Date): number | null {
  const ms = seenMs(firstSeen);
  if (ms === null) return null;
  return Math.floor((now.getTime() - ms) / DAY_MS);
}

export function promotionCandidates(
  notes: TailNote[],
  gapText: string,
  now: Date,
  tailSince: Record<string, string> = {},
): { kept: PromotionCandidate[]; skipped: PromoteReport["skipped"] } {
  const kept: PromotionCandidate[] = [];
  const skipped: PromoteReport["skipped"] = [];
  for (const note of notes) {
    const since = tailSince[tailNoteKey(note.text)];
    const days = since ? daysInTail(since, now) : null;
    const reason =
      note.projects.length < MIN_PROMOTE_PROJECTS
        ? `${note.projects.length} project${note.projects.length === 1 ? "" : "s"} (need ${MIN_PROMOTE_PROJECTS})`
        : days === null
          ? "not in the written tail yet"
          : days < MIN_TAIL_DAYS
            ? `${days} day${days === 1 ? "" : "s"} in the tail (need ${MIN_TAIL_DAYS})`
            : isCoveredByGap(note.text, gapText)
              ? "already covered by the GAP block"
              : null;
    if (reason) {
      skipped.push({ text: note.text, reason });
      continue;
    }
    kept.push({
      text: note.text,
      records: note.records,
      projects: note.projects,
      firstSeen: note.firstSeen,
      lastSeen: note.lastSeen,
      daysInTail: days as number,
    });
  }
  return { kept, skipped };
}

// Every qualifying note is listed so `skipped` explains each one; tail membership
// itself comes from the state file that each successful write records.
export function tailNotes(candidates: TailCandidate[]): TailNote[] {
  return selectTail(candidates, { gapText: "", cap: false }).notes;
}

export function planPromotion(options: PromoteOptions = {}): PromoteReport {
  const now = options.now ?? new Date();
  const scan = findTailDestinations(options);
  if (!scan.gap) return { gap: false, candidates: [], skipped: [] };
  const gapText = readGapCoverageText(scan.destinations.map((d) => d.path));
  const notes = tailNotes(loadTailCandidates(options.dbPath));
  const { tailSince } = readTailState(tailStatePath(options.dbPath));
  const { kept, skipped } = promotionCandidates(notes, gapText, now, tailSince);
  return { gap: true, candidates: kept, skipped };
}

function printText(report: PromoteReport): void {
  if (!report.gap) {
    console.log(
      "GAP is not installed. Promotion is a pull request on GAP, so there is nothing to list.",
    );
    return;
  }
  console.log(
    `${report.candidates.length} promotion candidate${report.candidates.length === 1 ? "" : "s"}`,
  );
  for (const c of report.candidates) {
    console.log(`- ${c.text}`);
    console.log(
      `  records: ${c.records.map((r) => `${r.table}#${r.id}`).join(", ")}`,
    );
    console.log(`  projects: ${c.projects.join(", ")}`);
    console.log(
      `  first seen: ${c.firstSeen}   last seen: ${c.lastSeen}   ${c.daysInTail} days`,
    );
  }
  if (report.candidates.length === 0) console.log("Nothing meets the bar.");
}

export function runPromote(options: PromoteOptions = {}): void {
  let report: PromoteReport;
  try {
    report = planPromotion(options);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  printText(report);
}
