// recall learn — write Recall's learned tail into each global harness file (#279).
// Selection, destinations and the splice live in hooks/lib/learned-tail.ts.
// This command only prints the plan and writes when a destination's content changes.

import {
  planLearnedTail,
  recordTailRefresh,
  tailStatePath,
  writeLearnedTail,
} from "../lib/learned-tail.js";
import type {
  TailDestinationPlan,
  TailPlan,
  TailWriteResult,
} from "../lib/learned-tail.js";

export interface LearnOptions {
  dryRun?: boolean;
  json?: boolean;
}

function fileDiff(plan: TailDestinationPlan): string {
  if (plan.refused) return `refused: ${plan.refused}`;
  if (!plan.changed) return "unchanged";
  const before = plan.before.endsWith("\n") ? plan.before : `${plan.before}\n`;
  const after = plan.after.endsWith("\n") ? plan.after : `${plan.after}\n`;
  const a = before.split("\n");
  const b = after.split("\n");
  const out = [`--- ${plan.path}`, `+++ ${plan.path}`];
  let i = 0;
  while (i < a.length || i < b.length) {
    let run = i;
    while (run < a.length && run < b.length && a[run] === b[run]) run++;
    if (run > i) {
      out.push(` ${a[i]}`);
      if (run > i + 1) out.push(` ... ${run - i - 1} unchanged`);
      if (run - 1 > i) out.push(` ${a[run - 1]}`);
    }
    let end = run;
    while (end < a.length && end < b.length && a[end] !== b[end]) end++;
    if (end === run && (run < a.length || run < b.length))
      end = Math.max(a.length, b.length);
    for (let n = run; n < end && n < a.length; n++) out.push(`-${a[n]}`);
    for (let n = run; n < end && n < b.length; n++) out.push(`+${b[n]}`);
    i = end;
  }
  return out.join("\n");
}

function printText(plan: TailPlan, writes: TailWriteResult[] | null): void {
  const { selection } = plan;
  console.log(
    `Learned tail  ${plan.date}  ${plan.gap ? "GAP destinations" : "built-in destinations"}`,
  );
  console.log(
    `Selected ${selection.notes.length} (${selection.tokens} tokens), dropped ${selection.dropped.length}`,
  );
  for (const note of selection.notes) {
    console.log(`  - ${note.text}`);
  }
  if (selection.dropped.length > 0) {
    console.log("Dropped:");
    for (const drop of selection.dropped) {
      console.log(`  ${drop.reason}${drop.detail ? ` (${drop.detail})` : ""}`);
    }
  }
  console.log("");
  console.log("Destinations:");
  for (const dest of plan.destinations) {
    const write = writes?.find((w) => w.path === dest.path);
    const state =
      write?.status ??
      (dest.refused ? "refused" : dest.changed ? "would write" : "unchanged");
    console.log(
      `  ${dest.path}  [${dest.source}]  ${state}${write?.reason ? `: ${write.reason}` : ""}`,
    );
    if (dest.changed || dest.refused)
      console.log(fileDiff(dest).replace(/^/gm, "    "));
  }
  for (const skip of plan.skipped) {
    console.log(`  ${skip.path}  skipped: ${skip.reason}`);
  }
  if (!writes) console.log("\n[DRY RUN] No files were written.");
}

function jsonReport(plan: TailPlan, writes: TailWriteResult[] | null) {
  return {
    date: plan.date,
    gap: plan.gap,
    dryRun: writes === null,
    selection: {
      tokens: plan.selection.tokens,
      notes: plan.selection.notes.map((n) => ({
        text: n.text,
        importance: n.importance,
        sessions: n.sessions,
        projects: n.projects,
        records: n.records,
      })),
      dropped: plan.selection.dropped,
    },
    destinations: plan.destinations.map((d) => ({
      path: d.path,
      source: d.source,
      changed: d.changed,
      refused: d.refused ?? null,
      status: writes?.find((w) => w.path === d.path)?.status ?? null,
      diff: d.changed || d.refused ? fileDiff(d) : null,
    })),
    skipped: plan.skipped,
  };
}

export function runLearn(options: LearnOptions = {}): void {
  let plan: TailPlan;
  try {
    plan = planLearnedTail();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  const dryRun = options.dryRun === true;
  const writes = dryRun ? null : writeLearnedTail(plan);
  if (writes?.some((w) => w.status === "refused")) process.exitCode = 1;
  if (writes) {
    try {
      recordTailRefresh(tailStatePath(), plan, writes);
    } catch (err) {
      console.error(
        `learned tail written, but its state was not saved: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
    }
  }
  if (options.json) {
    console.log(JSON.stringify(jsonReport(plan, writes), null, 2));
    return;
  }
  printText(plan, writes);
}
