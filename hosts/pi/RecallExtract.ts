// Host parser — not a template. New drop-dir hosts write markdown into
// MEMORY/<host>-sessions/ for shared ingest (hooks/lib/markdown-drop.ts +
// parseMarkdownDrop). Do not copy this file pair to add a host.
//
// Pi extension: on session_shutdown, linearize the active branch, call
// `recall capture` (harness pi, session_end), and keep the MEMORY/pi-sessions
// markdown drop for batch extract until capture is the only ambient path.
//
// VERIFIED AGAINST PI 0.81.1:
//   - pi.on("session_shutdown", handler) — fires before quit/reload/new/resume/fork
//   - ctx.sessionManager.getSessionFile() — returns the active JSONL or undefined
//   - pi.exec does not accept stdin, so capture uses spawnSync and the JSON twin

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { spawnSync } from "child_process"
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

const CAPTURE_MAX_BYTES = 25 * 1024 * 1024

function runPiCapture(sessionPath: string, markdown: string, ctxCwd?: string): void {
  try {
    if (Buffer.byteLength(markdown, "utf-8") > CAPTURE_MAX_BYTES) return
    let sessionId = ""
    let fileCwd = ""
    for (const line of readFileSync(sessionPath, "utf-8").split("\n")) {
      if (!line.trim()) continue
      let entry: { type?: unknown; id?: unknown; cwd?: unknown }
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      if (entry.type !== "session") continue
      if (typeof entry.id === "string") sessionId = entry.id
      if (typeof entry.cwd === "string") fileCwd = entry.cwd
      break
    }
    const cwd = ctxCwd || fileCwd
    const id = sessionId || basename(sessionPath).replace(/\.jsonl$/, "")
    const payload: Record<string, string | number> = {
      contract: 1,
      harness: "pi",
      event: "session_end",
      text: markdown,
    }
    if (id && id.length <= 512 && !/[\u0000-\u001f\u007f]/.test(id)) payload.session_id = id
    if (cwd) payload.cwd = cwd
    const project = cwd ? basename(cwd) : ""
    if (project && project !== "/" && project !== ".") payload.project = project
    const result = spawnSync("recall", ["capture"], {
      input: JSON.stringify(payload),
      encoding: "utf-8",
      timeout: 30_000,
      // bun ignores a PATH change unless env is passed through.
      env: process.env,
    })
    if (result.status !== 0) process.stderr.write("Recall pi capture failed\n")
  } catch {
    process.stderr.write("Recall pi capture failed\n")
  }
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
      runPiCapture(sessionPath, markdown, typeof ctx?.cwd === "string" ? ctx.cwd : undefined)
      tracker.add(sessionPath)
      saveTracker(trackerPath, tracker)
    } catch {
      // Non-fatal — don't crash Pi on extraction failure
    }
  })
}
