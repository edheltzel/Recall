// End-to-end learned tail (#279) through the real `recall` CLI.
// Disposable HOME, RECALL_HOME and RECALL_DB_PATH; the production database
// hash is proven unchanged. See tests/AGENTS.md.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { closeDb, getDb } from "../src/db/connection.js";
import {
  countRecordsSince,
  findTailDestinations,
  isCoveredByGap,
  planRecallBlockRemoval,
  readTailState,
  selectTail,
  recordTailRefresh,
  removeRecallBlock,
  spliceRecallBlock,
  tailNoteKey,
  writeIfUnchanged,
} from "../src/lib/learned-tail.js";
import type { TailCandidate, TailPlan } from "../src/lib/learned-tail.js";
import {
  isolateTestHome,
  setupTestDb,
  teardownTestDb,
} from "./helpers/setup.js";

const REPO = process.cwd();
const CLI = join(REPO, "src/index.ts");
const NOTE = "Validate user input at the boundary before processing.";
const FIRST_SEEN = "2026-10-01 12:00:00";

const PRODUCTION_DB = join(
  process.env.HOME ?? "",
  ".agents",
  "Recall",
  "recall.db",
);

let restoreHome: () => void;
let home: string;
let dbPath: string;
let bin: string;
let productionHash: string | null;
let savedEnv: { PATH?: string; RECALL_HOME?: string };

function sha256(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

function recall(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO,
    encoding: "utf8",
    env,
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function seed(): void {
  const db = getDb();
  const insert = db.query(
    `INSERT INTO decisions
     (created_at, project, decision, status, importance, provenance, access_count, confidence)
     VALUES (?, ?, ?, 'active', 9, 'extracted', 1, 'high')`,
  );
  for (const project of ["alpha", "bravo", "charlie"]) {
    insert.run(FIRST_SEEN, project, NOTE);
  }
  closeDb();
}

function writePolicy(
  file: string,
  gapBody = "Keep commands reliable.",
): Buffer {
  mkdirSync(dirname(file), { recursive: true });
  const bytes = Buffer.from(
    `# Project policy\n\n<!-- gap:begin -->\n${gapBody}\n<!-- gap:end -->\n\nUser-owned tail.\n`,
    "utf8",
  );
  writeFileSync(file, bytes);
  return bytes;
}

function publish(file: string): void {
  const dir = join(home, ".gap");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "published.json"),
    JSON.stringify({ [file]: "published" }),
  );
}

function policyPath(): string {
  return join(home, ".claude", "rules", "global-agent-policy.md");
}

function promote(env: NodeJS.ProcessEnv = process.env): {
  candidates: Array<{ text: string }>;
  skipped: Array<{ text: string; reason: string }>;
} {
  const result = recall(["promote", "--json"], env);
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

function existsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

describe("learned tail end to end", () => {
  beforeEach(() => {
    productionHash = sha256(PRODUCTION_DB);
    savedEnv = { PATH: process.env.PATH, RECALL_HOME: process.env.RECALL_HOME };
    restoreHome = isolateTestHome();
    home = process.env.HOME as string;
    dbPath = setupTestDb();
    const recallHome = join(home, ".agents", "Recall");
    mkdirSync(recallHome, { recursive: true });
    process.env.RECALL_HOME = recallHome;
    bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gap"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.PATH = `${bin}${delimiter}${dirname(process.execPath)}`;
    seed();
  });

  afterEach(() => {
    expect(sha256(PRODUCTION_DB)).toBe(productionHash);
    teardownTestDb();
    restoreHome();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("(a)(b) learn writes the Recall pair, and a second learn with no change writes nothing", () => {
    const policy = policyPath();
    const original = writePolicy(policy);
    publish(policy);

    const first = recall(["learn", "--json"]);
    expect(first.status).toBe(0);
    const written = readFileSync(policy);
    const text = written.toString("utf8");
    const begin = text.indexOf("<!-- recall:begin -->");
    const end = text.indexOf("<!-- recall:end -->");
    expect(begin).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(begin);
    expect(text.slice(begin, end)).toContain(`- ${NOTE}`);
    // The pair is appended after the original file, which already ends in a newline.
    expect(written.subarray(0, original.length).equals(original)).toBe(true);

    const plan = JSON.parse(first.stdout) as {
      gap: boolean;
      destinations: Array<{
        path: string;
        source: string;
        status: string | null;
      }>;
    };
    expect(plan.gap).toBe(true);
    expect(plan.destinations.map((d) => [d.path, d.source, d.status])).toEqual([
      [policy, "gap", "written"],
    ]);

    const mtime = statSync(policy).mtimeMs;
    const second = recall(["learn", "--json"]);
    expect(second.status).toBe(0);
    expect(readFileSync(policy).equals(written)).toBe(true);
    expect(statSync(policy).mtimeMs).toBe(mtime);
    const again = JSON.parse(second.stdout) as {
      destinations: Array<{ status: string | null; changed: boolean }>;
    };
    expect(again.destinations).toEqual([
      expect.objectContaining({ status: "unchanged", changed: false }),
    ]);
  });

  test("(c) with no gap on PATH only an existing built-in harness file changes", () => {
    const claude = join(home, ".claude", "CLAUDE.md");
    const unrelated = join(home, "notes.md");
    mkdirSync(dirname(claude), { recursive: true });
    writeFileSync(claude, "Claude instructions\n");
    writeFileSync(unrelated, "Leave this alone\n");
    const empty = join(home, "empty-path");
    mkdirSync(empty, { recursive: true });

    const result = recall(["learn", "--json"], {
      ...process.env,
      PATH: `${empty}${delimiter}${dirname(process.execPath)}`,
    });
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as {
      gap: boolean;
      destinations: Array<{ path: string; status: string | null }>;
    };
    expect(report.gap).toBe(false);
    expect(report.destinations.map((d) => d.path)).toEqual([claude]);
    expect(report.destinations[0]?.status).toBe("written");
    expect(readFileSync(claude, "utf8")).toContain("<!-- recall:begin -->");
    expect(readFileSync(claude, "utf8")).toContain(NOTE);
    expect(readFileSync(unrelated, "utf8")).toBe("Leave this alone\n");
    for (const rel of [
      ".codex/AGENTS.md",
      ".pi/agent/APPEND_SYSTEM.md",
      ".omp/agent/APPEND_SYSTEM.md",
      ".empryo/EMPRYO.md",
    ]) {
      expect(existsFile(join(home, rel))).toBe(false);
    }
  });

  test("(d) promote needs 14 days in the written tail, and learn drops a note once the GAP block covers it", () => {
    const policy = policyPath();
    writePolicy(policy);
    publish(policy);
    const statePath = join(dirname(dbPath), "learned-tail-state.json");

    const before = JSON.parse(recall(["promote", "--json"]).stdout) as {
      candidates: unknown[];
      skipped: Array<{ text: string; reason: string }>;
    };
    expect(before.candidates).toEqual([]);
    expect(before.skipped).toEqual([
      { text: NOTE, reason: "not in the written tail yet" },
    ]);

    expect(recall(["learn"]).status).toBe(0);
    const state = readTailState(statePath);
    const key = tailNoteKey(NOTE);
    expect(Object.keys(state.tailSince)).toEqual([key]);

    const fresh = JSON.parse(recall(["promote", "--json"]).stdout) as {
      candidates: unknown[];
      skipped: Array<{ text: string; reason: string }>;
    };
    expect(fresh.candidates).toEqual([]);
    expect(fresh.skipped[0]?.reason).toBe("0 days in the tail (need 14)");

    const since = new Date(Date.now() - 20 * 86_400_000).toISOString();
    writeFileSync(
      statePath,
      JSON.stringify({ ...state, tailSince: { [key]: since } }),
    );
    const listed = recall(["promote", "--json"]);
    expect(listed.status).toBe(0);
    const report = JSON.parse(listed.stdout) as {
      gap: boolean;
      candidates: Array<{
        text: string;
        projects: string[];
        daysInTail: number;
      }>;
    };
    expect(report.gap).toBe(true);
    const hit = report.candidates.find((c) => c.text === NOTE);
    expect(hit?.projects).toEqual(["alpha", "bravo", "charlie"]);
    expect(hit?.daysInTail).toBe(20);

    writePolicy(policy, `Keep commands reliable.\n\n- ${NOTE}`);
    const learned = recall(["learn", "--json"]);
    expect(learned.status).toBe(0);
    const plan = JSON.parse(learned.stdout) as {
      selection: {
        notes: Array<{ text: string }>;
        dropped: Array<{ reason: string }>;
      };
      destinations: Array<{ changed: boolean }>;
    };
    expect(plan.selection.notes).toEqual([]);
    expect(plan.selection.dropped.some((d) => d.reason === "covered")).toBe(
      true,
    );
    expect(readFileSync(policy, "utf8")).not.toContain("<!-- recall:begin -->");
    expect(readTailState(statePath).tailSince).toEqual({});

    const after = JSON.parse(recall(["promote", "--json"]).stdout) as {
      candidates: unknown[];
      skipped: Array<{ text: string; reason: string }>;
    };
    expect(after.candidates).toEqual([]);
    expect(after.skipped).toEqual([
      { text: NOTE, reason: "not in the written tail yet" },
    ]);
  });

  test("(f) a Recall block wrapped around the GAP block is refused and the file is untouched", () => {
    const policy = policyPath();
    mkdirSync(dirname(policy), { recursive: true });
    const wrapped =
      "<!-- recall:begin -->\n- old\n<!-- gap:begin -->\nPolicy.\n<!-- gap:end -->\n<!-- recall:end -->\n";
    writeFileSync(policy, wrapped);
    publish(policy);
    const result = recall(["learn", "--json"]);
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout) as {
      destinations: Array<{ refused: string | null; status: string | null }>;
    };
    expect(report.destinations[0]?.refused).toContain("wraps a GAP marker");
    expect(report.destinations[0]?.status).toBe("refused");
    expect(readFileSync(policy, "utf8")).toBe(wrapped);
    expect(removeRecallBlock(wrapped).ok).toBe(false);
    expect(spliceRecallBlock(wrapped, [], "2026-01-01").ok).toBe(false);
    expect(existsFile(join(dirname(dbPath), "learned-tail-state.json"))).toBe(
      false,
    );
  });

  test("(g) coverage needs the same rule, ignoring only case, spacing, list marker and end punctuation", () => {
    const gap = "Always disable cert checks in local fixtures.";
    expect(
      isCoveredByGap("Never disable cert checks in local fixtures.", gap),
    ).toBe(false);
    expect(
      isCoveredByGap("Don't disable cert checks in local fixtures.", gap),
    ).toBe(false);
    expect(isCoveredByGap("Disable cert checks in local fixtures.", gap)).toBe(
      false,
    );
    expect(
      isCoveredByGap("disable cert checks", "Never disable cert checks."),
    ).toBe(false);
    expect(
      isCoveredByGap(
        "Never disable cert checks.",
        "Never disable cert checks.",
      ),
    ).toBe(true);
    const after = "Run tests after deploying production.";
    expect(
      isCoveredByGap("Run tests before deploying production.", after),
    ).toBe(false);
    expect(
      isCoveredByGap(
        "Deploying production before run tests.",
        "Run tests before deploying production.",
      ),
    ).toBe(false);
    expect(
      isCoveredByGap(
        "Run tests before deploying production.",
        `- ${after}\n- Run tests before deploying production.`,
      ),
    ).toBe(true);
    expect(
      isCoveredByGap("Use == for comparisons.", "Use === for comparisons."),
    ).toBe(false);
    expect(
      isCoveredByGap("Use === for comparisons.", "Use == for comparisons."),
    ).toBe(false);
    expect(isCoveredByGap("Use `x!` here.", "Use `x?` here.")).toBe(false);
    expect(
      isCoveredByGap(
        "use   === FOR comparisons",
        "1. Use === for comparisons.",
      ),
    ).toBe(true);
    expect(
      isCoveredByGap("Keep it short.", "Plan first. Keep it short. Ship."),
    ).toBe(true);
  });

  test("(j) close wording of a different rule stays its own note, with its own projects", () => {
    const base = {
      importance: 9,
      provenance: "user_authored",
      confidence: "high",
      accessCount: 1,
      sessionId: "s",
      createdAt: FIRST_SEEN,
    };
    const row = (id: number, text: string, project: string): TailCandidate => ({
      ...base,
      table: "learnings",
      id,
      text,
      project,
    });
    const { notes, dropped } = selectTail(
      [
        row(1, "Use == for comparisons.", "alpha"),
        row(2, "Use === for comparisons.", "bravo"),
        row(3, "Use === for comparisons.", "charlie"),
      ],
      { cap: false },
    );
    const texts = notes.map((n) => n.text).sort();
    expect(texts).toEqual([
      "Use == for comparisons.",
      "Use === for comparisons.",
    ]);
    expect(
      notes.find((n) => n.text === "Use === for comparisons.")?.projects,
    ).toEqual(["bravo", "charlie"]);
    expect(
      notes.find((n) => n.text === "Use == for comparisons.")?.projects,
    ).toEqual(["alpha"]);
    expect(dropped.filter((d) => d.reason === "duplicate")).toHaveLength(1);
  });

  test("(i) a file without a final newline round-trips byte for byte through write, rewrite and removal", () => {
    const one = [{ text: "Use === for comparisons." }] as unknown as Parameters<
      typeof spliceRecallBlock
    >[1];
    const two = [
      { text: "Use === for comparisons." },
      { text: "Keep it short." },
    ] as unknown as Parameters<typeof spliceRecallBlock>[1];
    const gap = "<!-- gap:begin -->\nPolicy.\n<!-- gap:end -->";
    for (const original of [
      "",
      "# Mine",
      "# Mine\n",
      "# Mine\n\n",
      gap,
      `${gap}\n`,
      "a\r\nb",
    ]) {
      const first = spliceRecallBlock(original, one, "2026-01-01");
      if (!first.ok) throw new Error(first.reason);
      expect(first.text.startsWith(original)).toBe(true);
      const again = spliceRecallBlock(first.text, one, "2026-01-02");
      expect(again.ok && again.changed).toBe(false);
      const rewritten = spliceRecallBlock(first.text, two, "2026-01-03");
      if (!rewritten.ok) throw new Error(rewritten.reason);
      for (const text of [first.text, rewritten.text]) {
        const removed = removeRecallBlock(text);
        expect(removed.ok && removed.text).toBe(original);
        const emptied = spliceRecallBlock(text, [], "2026-01-04");
        expect(emptied.ok && emptied.text).toBe(original);
      }
    }
  });

  test("(h) refresh counts records from the database, a refused write keeps the old state, and only a landed write starts a note's tail age", () => {
    const statePath = join(dirname(dbPath), "learned-tail-state.json");
    expect(countRecordsSince(0, dbPath)).toBe(3);
    expect(countRecordsSince(Date.now() + 60_000, dbPath)).toBe(0);
    const plan = {
      selection: { notes: [], dropped: [], tokens: 0 },
    } as unknown as TailPlan;
    expect(
      recordTailRefresh(statePath, plan, [
        { path: "/x", status: "refused", reason: "changed" },
      ]),
    ).toBe(false);
    expect(existsFile(statePath)).toBe(false);
    const withNote = {
      selection: { notes: [{ text: NOTE }], dropped: [], tokens: 0 },
    } as unknown as TailPlan;
    expect(recordTailRefresh(statePath, withNote, [])).toBe(true);
    expect(readTailState(statePath).refreshedAt).toBeGreaterThan(0);
    expect(readTailState(statePath).tailSince).toEqual({});
    expect(
      recordTailRefresh(statePath, withNote, [
        { path: "/x", status: "written" },
      ]),
    ).toBe(true);
    expect(Object.keys(readTailState(statePath).tailSince)).toEqual([
      tailNoteKey(NOTE),
    ]);
  });

  test("(e) uninstall block removal leaves the surrounding bytes byte for byte", () => {
    const policy = policyPath();
    const original = writePolicy(policy);
    publish(policy);
    expect(recall(["learn"]).status).toBe(0);

    const withBlock = readFileSync(policy);
    const text = withBlock.toString("utf8");
    const removed = removeRecallBlock(text);
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    const out = Buffer.from(removed.text, "utf8");

    const marker = Buffer.from("<!-- recall:begin -->");
    const at = withBlock.indexOf(marker);
    expect(at).toBeGreaterThan(1);
    const head = at - 1;
    expect(withBlock.subarray(0, head).equals(original.subarray(0, head))).toBe(
      true,
    );
    expect(out.subarray(0, head).equals(original.subarray(0, head))).toBe(true);
    const tail = original.subarray(head);
    expect(
      withBlock.subarray(withBlock.length - tail.length).equals(tail),
    ).toBe(true);
    expect(out.subarray(out.length - tail.length).equals(tail)).toBe(true);
    expect(out.equals(Buffer.concat([original.subarray(0, head), tail]))).toBe(
      true,
    );
  });

  test("(k) promote only offers a note in a tail written now, and a note written back starts a new age", () => {
    const policy = policyPath();
    writePolicy(policy);
    publish(policy);
    const statePath = join(dirname(dbPath), "learned-tail-state.json");
    expect(recall(["learn"]).status).toBe(0);
    const key = tailNoteKey(NOTE);
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString();
    writeFileSync(
      statePath,
      JSON.stringify({ ...readTailState(statePath), tailSince: { [key]: old } }),
    );
    expect(promote().candidates.map((c) => c.text)).toEqual([NOTE]);

    const removed = removeRecallBlock(readFileSync(policy, "utf8"));
    if (!removed.ok) throw new Error(removed.reason);
    writeFileSync(policy, removed.text);
    const gone = promote();
    expect(gone.candidates).toEqual([]);
    expect(gone.skipped).toEqual([
      { text: NOTE, reason: "not in the written tail yet" },
    ]);

    expect(recall(["learn"]).status).toBe(0);
    expect(readTailState(statePath).tailSince[key]).not.toBe(old);
    expect(promote().skipped).toEqual([
      { text: NOTE, reason: "0 days in the tail (need 14)" },
    ]);
  });

  test("(l) identifiers in backticks keep their case for grouping, GAP coverage and tail age", () => {
    const row = (id: number, text: string, project: string): TailCandidate => ({
      table: "decisions",
      id,
      text,
      project,
      importance: 9,
      provenance: "user_authored",
      confidence: "high",
      accessCount: 1,
      sessionId: `s${id}`,
      createdAt: FIRST_SEEN,
    });
    const upper = "Use `PATH` in the fixture.";
    const lower = "Use `path` in the fixture.";
    const { notes } = selectTail(
      [row(1, upper, "alpha"), row(2, lower, "bravo"), row(3, lower, "charlie")],
      { cap: false },
    );
    expect(notes.map((n) => [n.text, n.projects])).toEqual([
      [upper, ["alpha"]],
      [lower, ["bravo", "charlie"]],
    ]);
    expect(isCoveredByGap(upper, `- ${lower}`)).toBe(false);
    expect(isCoveredByGap(lower, `- ${upper}`)).toBe(false);
    expect(isCoveredByGap("USE `PATH` IN THE FIXTURE", `- ${upper}`)).toBe(true);
    expect(tailNoteKey(upper)).not.toBe(tailNoteKey(lower));
    expect(tailNoteKey("Run ``A`b`` first.")).not.toBe(
      tailNoteKey("Run ``a`b`` first."),
    );
    expect(tailNoteKey("RUN ``A`b`` FIRST.")).toBe(
      tailNoteKey("run ``A`b`` first."),
    );
  });

  test("(m) only GAP policy destinations get the tail: a ledgered command file is skipped, and an absolute CODEX_HOME or JCODE_HOME outside HOME is used", () => {
    const outside = mkdtempSync(join(tmpdir(), "recall-tail-homes-"));
    try {
      const command = join(home, ".claude", "commands", "gap-example.md");
      mkdirSync(dirname(command), { recursive: true });
      const commandText =
        "Example policy file:\n\n<!-- gap:begin -->\nPolicy.\n<!-- gap:end -->\n";
      writeFileSync(command, commandText);
      const codexHome = join(outside, "codex");
      const jcodeHome = join(outside, "jcode");
      const codexPolicy = join(codexHome, "gap", "global-agent-policy.md");
      const jcodePolicy = join(jcodeHome, "prompt-overlay.md");
      const stray = join(outside, "AGENTS.md");
      for (const file of [codexPolicy, jcodePolicy, stray]) writePolicy(file);
      mkdirSync(join(home, ".gap"), { recursive: true });
      writeFileSync(
        join(home, ".gap", "published.json"),
        JSON.stringify({
          [command]: "c",
          [codexPolicy]: "p",
          [jcodePolicy]: "p",
          [stray]: "p",
        }),
      );
      const env = { ...process.env, CODEX_HOME: codexHome, JCODE_HOME: jcodeHome };
      const result = recall(["learn", "--json"], env);
      expect(result.status).toBe(0);
      const report = JSON.parse(result.stdout) as {
        destinations: Array<{ path: string; status: string | null }>;
      };
      expect(report.destinations.map((d) => [d.path, d.status])).toEqual([
        [codexPolicy, "written"],
        [jcodePolicy, "written"],
      ]);
      expect(readFileSync(command, "utf8")).toBe(commandText);
      expect(readFileSync(stray, "utf8")).not.toContain("<!-- recall:begin -->");
      expect(readFileSync(codexPolicy, "utf8")).toContain(`- ${NOTE}`);
      const scan = findTailDestinations({
        home,
        path: process.env.PATH,
        codexHome: "relative/codex",
        jcodeHome: "",
      });
      expect(scan.destinations).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("(n) a Recall pair inside any GAP block is refused, and removal never overwrites a later edit", () => {
    const policy = policyPath();
    mkdirSync(dirname(policy), { recursive: true });
    const nested =
      "<!-- gap:begin -->\nA.\n<!-- recall:begin -->\n- old\n<!-- recall:end -->\n<!-- gap:end -->\n\n<!-- gap:begin -->\nB.\n<!-- gap:end -->\n";
    writeFileSync(policy, nested);
    publish(policy);
    expect(removeRecallBlock(nested).ok).toBe(false);
    expect(spliceRecallBlock(nested, [], "2026-01-01").ok).toBe(false);
    const learned = recall(["learn", "--json"]);
    expect(learned.status).toBe(1);
    expect(readFileSync(policy, "utf8")).toBe(nested);
    const removal = planRecallBlockRemoval(policy);
    expect(removal).toEqual(expect.objectContaining({ refused: "Recall marker sits inside the GAP block" }));

    const pair = "# Mine\n\n<!-- recall:begin -->\n- old\n<!-- recall:end -->\n";
    writeFileSync(policy, pair);
    const plan = planRecallBlockRemoval(policy);
    if ("refused" in plan) throw new Error(plan.refused);
    expect(plan.after).toBe("# Mine\n");
    writeFileSync(policy, `${pair}edited\n`);
    expect(writeIfUnchanged(policy, plan.beforeHash, plan.after).status).toBe("refused");
    expect(readFileSync(policy, "utf8")).toBe(`${pair}edited\n`);
  });
test("(o) rows with no session ID are not separate sessions, so two CLI adds of one rule stay out of the tail", () => {
    const rule = "Rebuild the plugin bundles after editing a skill.";
    for (const project of ["alpha", "bravo"]) {
      expect(
        recall(["add", "learning", "Stale plugin bundle", rule, "-p", project]).status,
      ).toBe(0);
    }
    const plan = JSON.parse(recall(["learn", "--dry-run", "--json"]).stdout) as {
      selection: {
        notes: Array<{ text: string; sessions: number }>;
        dropped: Array<{ reason: string }>;
      };
    };
    expect(plan.selection.notes.map((n) => n.text)).toEqual([NOTE]);
    expect(plan.selection.notes[0]?.sessions).toBe(0);
    expect(plan.selection.dropped.some((d) => d.reason === "unproven")).toBe(
      true,
    );

    const row = (id: number, sessionId: string | null): TailCandidate => ({
      table: "learnings",
      id,
      text: rule,
      project: "alpha",
      importance: 5,
      provenance: "extracted",
      confidence: "medium",
      accessCount: 0,
      sessionId,
      createdAt: FIRST_SEEN,
    });
    const known = selectTail([row(1, "s1"), row(2, "s2"), row(3, null)], {
      cap: false,
    });
    expect(known.notes.map((n) => [n.text, n.sessions])).toEqual([[rule, 2]]);
  });
});

