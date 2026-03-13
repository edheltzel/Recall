// opencode/recall-extract.ts
// Recall session extraction plugin for OpenCode
//
// Hooks into session.idle to export completed sessions as markdown,
// dropping them into a directory that BatchExtract.ts monitors.
//
// VERIFIED APIs USED:
//   - ctx.$ (Bun shell tagged template) — confirmed in OpenCode plugin docs
//   - opencode session export <id> -f markdown -o <path> — confirmed CLI command
//   - session.idle event — confirmed hook, defensive property access

import type { Plugin } from "@opencode-ai/plugin"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"

const DROP_DIR = join(homedir(), ".claude", "MEMORY", "opencode-sessions")
const TRACKER_PATH = join(DROP_DIR, ".extracted.json")

/** Load persistent dedup tracker from disk */
function loadTracker(): Set<string> {
  try {
    if (existsSync(TRACKER_PATH)) {
      const data = JSON.parse(readFileSync(TRACKER_PATH, "utf-8"))
      return new Set(Array.isArray(data) ? data : [])
    }
  } catch { /* corrupt tracker — start fresh */ }
  return new Set()
}

/** Save dedup tracker to disk */
function saveTracker(tracker: Set<string>): void {
  writeFileSync(TRACKER_PATH, JSON.stringify([...tracker]))
}

export const RecallExtract: Plugin = async ({ $ }) => {
  mkdirSync(DROP_DIR, { recursive: true })
  const tracker = loadTracker()

  return {
    "session.idle": async (event: any) => {
      // Defensive session ID extraction — handle all known event shapes
      const sessionId: string | undefined =
        event?.sessionId ||
        event?.session_id ||
        event?.properties?.sessionId

      if (!sessionId || tracker.has(sessionId)) return

      // Mark as extracted immediately (prevent concurrent runs)
      tracker.add(sessionId)
      saveTracker(tracker)

      const outFile = join(DROP_DIR, `${sessionId}.md`)

      try {
        // Use verified CLI: `opencode session export <id> -f markdown -o <path>`
        await $`opencode session export ${sessionId} -f markdown -o ${outFile}`
      } catch {
        // Export failed — remove from tracker so it can retry next idle
        tracker.delete(sessionId)
        saveTracker(tracker)
      }
    }
  }
}
