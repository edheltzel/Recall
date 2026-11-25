import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { closeDb, getDb } from "../src/db/connection.js";
import { readTailState, tailNoteKey } from "../src/lib/learned-tail.js";
import {
  isolateTestHome,
  setupTestDb,
  teardownTestDb,
} from "./helpers/setup.js";

test("identical embeddings cannot merge contradictory rules or manufacture promotion projects", () => {
  const restoreHome = isolateTestHome();
  const saved = {
    PATH: process.env.PATH,
    RECALL_HOME: process.env.RECALL_HOME,
  };
  try {
    const dbPath = setupTestDb();
    const home = process.env.HOME!;
    process.env.RECALL_HOME = join(home, ".agents", "Recall");
    mkdirSync(process.env.RECALL_HOME, { recursive: true });
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "gap"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.PATH = bin;
    const policy = join(home, ".claude", "rules", "global-agent-policy.md");
    mkdirSync(dirname(policy), { recursive: true });
    writeFileSync(
      policy,
      "<!-- gap:begin -->\nKeep commands reliable.\n<!-- gap:end -->\n",
    );
    mkdirSync(join(home, ".gap"), { recursive: true });
    writeFileSync(
      join(home, ".gap", "published.json"),
      JSON.stringify({ [policy]: "published" }),
    );
    const db = getDb();
    const texts = [
      "Run tests before deploying production.",
      "Run tests after deploying production.",
      "Run tests after deploying production.",
    ];
    const projects = ["alpha", "bravo", "charlie"];
    const vector = new Float32Array([1, 0, 0]);
    for (let i = 0; i < texts.length; i++) {
      const row = db
        .query(
          "INSERT INTO decisions (project, decision, status, importance, provenance, confidence) VALUES (?, ?, 'active', 9, 'user_authored', 'high')",
        )
        .run(projects[i]!, texts[i]!);
      db.query(
        "INSERT INTO embeddings (source_table, source_id, dimensions, embedding) VALUES ('decisions', ?, 3, ?)",
      ).run(row.lastInsertRowid, new Uint8Array(vector.buffer));
    }
    closeDb();
    const cli = (args: string[]) => {
      const result = spawnSync(
        process.execPath,
        [join(process.cwd(), "src/index.ts"), ...args],
        { env: process.env, encoding: "utf8", timeout: 30_000 },
      );
      expect(result.status).toBe(0);
      return JSON.parse(result.stdout);
    };
    const learned = cli(["learn", "--json"]);
    expect(learned.selection.notes).toHaveLength(2);
    for (const text of new Set(texts))
      expect(readFileSync(policy, "utf8")).toContain(text);
    const statePath = join(dirname(dbPath), "learned-tail-state.json");
    const state = readTailState(statePath);
    const since = new Date(Date.now() - 20 * 86_400_000).toISOString();
    writeFileSync(
      statePath,
      JSON.stringify({
        ...state,
        tailSince: Object.fromEntries(
          texts.map((text) => [tailNoteKey(text), since]),
        ),
      }),
    );
    const promoted = cli(["promote", "--json"]);
    expect(promoted.candidates).toEqual([]);
    expect(
      promoted.skipped.map((note: { reason: string }) => note.reason).sort(),
    ).toEqual(["1 project (need 3)", "2 projects (need 3)"]);
  } finally {
    closeDb();
    teardownTestDb();
    restoreHome();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
