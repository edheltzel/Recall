// pi/recall-extract.ts
// Pi extension: exports session as markdown to Recall's drop directory on shutdown.
//
// Pi sessions use tree-structured JSONL (id/parentId) unlike Claude Code's linear format.
// This extension linearizes the active branch into flat markdown, then drops it into
// ~/.claude/MEMORY/pi-sessions/ for BatchExtract to pick up.
//
// VERIFIED APIs:
//   - pi.on("session_shutdown", handler) — fires on exit (Ctrl+C, Ctrl+D, SIGTERM)
//   - handler receives (_event, ctx)
//   - ctx.sessionManager access patterns are UNVERIFIED — fallback scans sessions dir

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "fs"
import { join } from "path"
import { homedir } from "os"

/**
 * Extract plain text from a message content value.
 * Handles string content, Claude-style content block arrays, and objects with a text property.
 */
function extractTextFromContent(content: any): string {
  if (typeof content === "string") {
    return content
  }
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (block.type === "text" && block.text) {
        parts.push(block.text)
      }
      // Skip thinking blocks, tool_use, tool_result — noise for memory
    }
    return parts.join("\n")
  }
  if (content?.text) {
    return content.text
  }
  return ""
}

const DROP_DIR = join(homedir(), ".claude", "MEMORY", "pi-sessions")
const TRACKER_PATH = join(DROP_DIR, ".extraction_tracker.json")

function loadTracker(): Set<string> {
  try {
    if (existsSync(TRACKER_PATH)) {
      const data = JSON.parse(readFileSync(TRACKER_PATH, "utf-8"))
      return new Set(Array.isArray(data) ? data : [])
    }
  } catch {}
  return new Set()
}

function saveTracker(tracker: Set<string>): void {
  try {
    writeFileSync(TRACKER_PATH, JSON.stringify([...tracker]), "utf-8")
  } catch {}
}

/**
 * Linearize Pi's tree-structured JSONL into a flat markdown transcript.
 * Walks from root following the active branch (last child at each node).
 * Exported for testing.
 */
export function linearizeSession(jsonlPath: string): string {
  const content = readFileSync(jsonlPath, "utf-8")
  const entries = content.trim().split("\n").map(line => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(Boolean)

  // Build parent→children map
  const childrenOf = new Map<string | null, any[]>()
  for (const entry of entries) {
    const parent = entry.parentId || null
    if (!childrenOf.has(parent)) childrenOf.set(parent, [])
    childrenOf.get(parent)!.push(entry)
  }

  // Walk active branch (last child at each level = most recent)
  const transcript: string[] = []

  function walkBranch(parentId: string | null) {
    const children = childrenOf.get(parentId) || []
    if (children.length === 0) return
    const active = children[children.length - 1]
    if (active.type === "message" && active.message) {
      const role = active.message.role?.toUpperCase() || "UNKNOWN"
      const text = extractTextFromContent(active.message.content)
      if (text && text.length > 10) {
        transcript.push(`[${role}]: ${text.slice(0, 4000)}`)
      }
    }
    walkBranch(active.id)
  }

  walkBranch(null)
  return transcript.join("\n\n")
}

export default function (pi: any) {
  mkdirSync(DROP_DIR, { recursive: true })
  const tracker = loadTracker()

  pi.on("session_shutdown", async (_event: any, ctx: any) => {
    try {
      // Get session file path — try ctx.sessionManager first, fallback to scanning
      let sessionPath = ctx?.sessionManager?.currentSessionPath
        || ctx?.sessionManager?.currentSession?.path

      // Fallback: scan Pi's sessions directory for most recently modified .jsonl
      if (!sessionPath || !existsSync(sessionPath)) {
        const piSessionsDir = join(homedir(), ".pi", "agent", "sessions")
        if (existsSync(piSessionsDir)) {
          let latest = { path: "", mtime: 0 }
          for (const dir of readdirSync(piSessionsDir)) {
            const subdir = join(piSessionsDir, dir)
            try {
              for (const f of readdirSync(subdir)) {
                if (!f.endsWith(".jsonl")) continue
                const full = join(subdir, f)
                const mt = statSync(full).mtimeMs
                if (mt > latest.mtime) latest = { path: full, mtime: mt }
              }
            } catch {}
          }
          if (latest.path) sessionPath = latest.path
        }
      }

      if (!sessionPath || !existsSync(sessionPath)) return
      if (tracker.has(sessionPath)) return

      tracker.add(sessionPath)
      saveTracker(tracker)

      const markdown = linearizeSession(sessionPath)
      if (markdown.length < 500) return // Skip trivial sessions

      const fileName = sessionPath.split("/").pop()?.replace(".jsonl", ".md") || "session.md"
      writeFileSync(join(DROP_DIR, fileName), markdown, "utf-8")
    } catch {
      // Non-fatal — don't crash Pi on extraction failure
    }
  })
}
