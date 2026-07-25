// opencode/RecallExtract.ts
// Recall session extraction plugin for OpenCode
//
// Hooks into session.idle to export the session as markdown, dropping it into
// a directory that RecallBatchExtract.ts monitors.
//
// MEASURED RUNTIME CONTRACT (OpenCode 1.18.5 — scripts/e2e-opencode-runtime.ts):
//   - session.idle fires ONCE PER ASSISTANT TURN, not once per session. A
//     three-turn session emits three events. The drop is therefore rewritten as
//     the conversation grows; RecallBatchExtract re-extracts on file growth.
//   - the payload carries properties.sessionID
//   - OpenCode loads this plugin from $XDG_CONFIG_HOME/opencode/plugins/, the
//     path lib/install-lib.sh installs to
//   - OpenCode calls EVERY export of a top-level plugin module as a plugin
//     factory, so this file must export nothing but RecallExtract. Shared pure
//     helpers live in ./lib/session-export.ts, which OpenCode does not glob.
//
// VERIFIED APIs USED:
//   - ctx.$ (Bun shell tagged template) — confirmed in OpenCode plugin docs
//   - event hook with session.idle/properties.sessionID — current runtime shape
//   - opencode export <id> — current JSON export command; Recall normalizes it

import type { Plugin } from "@opencode-ai/plugin"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { createHash } from "crypto"
import { join } from "path"
import { homedir } from "os"
import { exportSession, sessionIdFromEvent, type Shell } from "./lib/session-export"

const RECALL_HOME = process.env.RECALL_HOME || join(homedir(), ".agents", "Recall")
const DROP_DIR = join(RECALL_HOME, "MEMORY", "opencode-sessions")
const TRACKER_PATH = join(DROP_DIR, ".extracted.json")

/**
 * Load the persistent dedup tracker from disk.
 *
 * Maps session ID -> digest of the markdown last written for that session.
 * `session.idle` fires once per assistant turn (measured against OpenCode
 * 1.18.5: three turns produced three events), so the tracker must NOT record
 * "this session is finished" — it records "this is the content we already
 * dropped", which lets a later turn overwrite an earlier, shorter transcript.
 *
 * The legacy on-disk format was a bare array of session IDs, which carried no
 * content digest. Those entries load with an empty digest so the next idle
 * re-exports once and converges onto the current format.
 */
function loadTracker(): Map<string, string> {
  try {
    if (existsSync(TRACKER_PATH)) {
      const data = JSON.parse(readFileSync(TRACKER_PATH, "utf-8"))
      if (Array.isArray(data)) {
        return new Map(data.filter((id): id is string => typeof id === "string").map(id => [id, ""]))
      }
      if (data && typeof data === "object") {
        return new Map(Object.entries(data as Record<string, unknown>)
          .map(([id, digest]) => [id, typeof digest === "string" ? digest : ""]))
      }
    }
  } catch (error) {
    console.error(`[recall] OpenCode tracker unreadable; starting fresh: ${error instanceof Error ? error.message : String(error)}`)
  }
  return new Map()
}

/** Save dedup tracker to disk */
function saveTracker(tracker: Map<string, string>): void {
  writeFileSync(TRACKER_PATH, JSON.stringify(Object.fromEntries(tracker)) + "\n")
}

/** Digest used to tell "same transcript again" from "the session grew". */
function digest(markdown: string): string {
  return createHash("sha256").update(markdown).digest("hex")
}

export const RecallExtract: Plugin = async ({ $ }) => {
  mkdirSync(DROP_DIR, { recursive: true })
  const tracker = loadTracker()
  const inFlight = new Set<string>()

  return {
    event: async ({ event }: { event: unknown }) => {
      const sessionId = sessionIdFromEvent(event)
      // Only overlapping exports of the SAME session are suppressed. A session
      // that already produced a drop must stay eligible: idle fires per turn,
      // and skipping later idles would freeze the drop on the first turn and
      // silently discard the rest of the conversation.
      if (!sessionId || inFlight.has(sessionId)) return

      inFlight.add(sessionId)
      try {
        const markdown = await exportSession($ as unknown as Shell, sessionId)
        const signature = digest(markdown)
        if (tracker.get(sessionId) === signature) return
        const outFile = join(DROP_DIR, `${sessionId}.md`)
        writeFileSync(outFile, markdown)
        tracker.set(sessionId, signature)
        saveTracker(tracker)
      } catch (error) {
        console.error(`[recall] OpenCode session export failed for ${sessionId}; will retry on a later idle event: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        inFlight.delete(sessionId)
      }
    }
  }
}
