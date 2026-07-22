// pi/RecallExtract.ts
// Pi extension: exports session as markdown to Recall's drop directory on shutdown.
//
// Pi sessions use tree-structured JSONL (id/parentId) unlike Claude Code's linear format.
// This extension linearizes the active branch into flat markdown, then drops it into
// Recall's canonical MEMORY/pi-sessions/ directory for RecallBatchExtract to pick up.
//
// VERIFIED AGAINST PI 0.81.1:
//   - pi.on("session_shutdown", handler) — fires before quit/reload/new/resume/fork
//   - ctx.sessionManager.getSessionFile() — returns the active JSONL or undefined

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { basename, join } from "path"
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
    return parts.length === 1 ? parts[0] : parts.join("\n")
  }
  if (content?.text) {
    return content.text
  }
  return ""
}

const MIN_MESSAGE_LENGTH = 10
const MAX_MESSAGE_LENGTH = 4000
const MIN_SESSION_LENGTH = 500

function loadTracker(trackerPath: string): Set<string> {
  try {
    if (existsSync(trackerPath)) {
      const data = JSON.parse(readFileSync(trackerPath, "utf-8"))
      return new Set(Array.isArray(data) ? data : [])
    }
  } catch {}
  return new Set()
}

function saveTracker(trackerPath: string, tracker: Set<string>): void {
  try {
    writeFileSync(trackerPath, JSON.stringify([...tracker]), "utf-8")
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

  let currentParent: string | null = null
  while (true) {
    const children = childrenOf.get(currentParent) || []
    if (children.length === 0) break
    const active = children[children.length - 1]
    if (active.type === "message" && active.message) {
      const role = active.message.role?.toUpperCase() || "UNKNOWN"
      const text = extractTextFromContent(active.message.content)
      if (text && text.length > MIN_MESSAGE_LENGTH) {
        const truncated = text.length > MAX_MESSAGE_LENGTH ? text.slice(0, MAX_MESSAGE_LENGTH) + '...[truncated]' : text
        transcript.push(`[${role}]: ${truncated}`)
      }
    }
    currentParent = active.id
  }
  return transcript.join("\n\n")
}

export default function (pi: any) {
  const recallHome = process.env.RECALL_HOME || join(homedir(), ".agents", "Recall")
  const dropDir = join(recallHome, "MEMORY", "pi-sessions")
  const trackerPath = join(dropDir, ".extraction_tracker.json")
  mkdirSync(dropDir, { recursive: true })
  const tracker = loadTracker(trackerPath)

  pi.on("session_shutdown", (_event: any, ctx: any) => {
    try {
      const sessionPath = ctx?.sessionManager?.getSessionFile?.()

      if (!sessionPath || !existsSync(sessionPath)) return
      if (tracker.has(sessionPath)) return

      const markdown = linearizeSession(sessionPath)
      if (markdown.length < MIN_SESSION_LENGTH) return // Skip trivial sessions

      const fileName = basename(sessionPath).replace(/\.jsonl$/, ".md") || "session.md"
      writeFileSync(join(dropDir, fileName), markdown, "utf-8")
      tracker.add(sessionPath)
      saveTracker(trackerPath, tracker)
    } catch {
      // Non-fatal — don't crash Pi on extraction failure
    }
  })
}
