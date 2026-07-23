// opencode/RecallExtract.ts
// Recall session extraction plugin for OpenCode
//
// Hooks into session.idle to export completed sessions as markdown,
// dropping them into a directory that RecallBatchExtract.ts monitors.
//
// VERIFIED APIs USED:
//   - ctx.$ (Bun shell tagged template) — confirmed in OpenCode plugin docs
//   - event hook with session.idle/properties.sessionID — current runtime shape
//   - opencode export <id> — current JSON export command; Recall normalizes it

import type { Plugin } from "@opencode-ai/plugin"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"

const RECALL_HOME = process.env.RECALL_HOME || join(homedir(), ".agents", "Recall")
const DROP_DIR = join(RECALL_HOME, "MEMORY", "opencode-sessions")
const TRACKER_PATH = join(DROP_DIR, ".extracted.json")

/** Load persistent dedup tracker from disk */
function loadTracker(): Set<string> {
  try {
    if (existsSync(TRACKER_PATH)) {
      const data = JSON.parse(readFileSync(TRACKER_PATH, "utf-8"))
      return new Set(Array.isArray(data) ? data : [])
    }
  } catch (error) {
    console.error(`[recall] OpenCode tracker unreadable; starting fresh: ${error instanceof Error ? error.message : String(error)}`)
  }
  return new Set()
}

/** Save dedup tracker to disk */
function saveTracker(tracker: Set<string>): void {
  writeFileSync(TRACKER_PATH, JSON.stringify([...tracker]) + "\n")
}

type Shell = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>

type RecordLike = Record<string, unknown>

function asRecord(value: unknown): RecordLike | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordLike
    : null
}

/** Extract the current OpenCode event payload's session ID. */
export function sessionIdFromEvent(event: unknown): string | null {
  const record = asRecord(event)
  if (!record) return null
  if (record.type !== undefined && record.type !== "session.idle") return null

  const properties = asRecord(record.properties)
  const candidates = [
    properties?.sessionID,
    properties?.sessionId,
    properties?.session_id,
    record.sessionID,
    record.sessionId,
    record.session_id,
  ]
  return candidates.find((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0) ?? null
}

function partText(part: RecordLike): string[] {
  const text: string[] = []
  if (typeof part.text === "string" && part.text.trim()) text.push(part.text)

  const state = asRecord(part.state)
  if (typeof state?.title === "string" && state.title.trim()) text.push(`[tool: ${state.title}]`)
  if (typeof state?.output === "string" && state.output.trim()) text.push(state.output)

  if (typeof part.description === "string" && part.description.trim()) text.push(part.description)
  if (typeof part.prompt === "string" && part.prompt.trim()) text.push(part.prompt)
  if (typeof part.filename === "string" && part.filename.trim()) text.push(`[file: ${part.filename}]`)
  return text
}

/** Convert current `opencode export <id>` JSON into the markdown drop format. */
export function renderSessionExport(raw: string, fallbackSessionId: string): string {
  let exported: RecordLike
  try {
    exported = JSON.parse(raw) as RecordLike
  } catch {
    if (raw.trimStart().startsWith("#")) return raw.trimEnd() + "\n"
    throw new Error("OpenCode export was neither JSON nor markdown")
  }

  const messages = exported.messages
  if (!Array.isArray(messages)) throw new Error("OpenCode export JSON has no messages array")

  const info = asRecord(exported.info)
  const sessionId = typeof info?.id === "string" ? info.id : fallbackSessionId
  const title = typeof info?.title === "string" && info.title.trim() ? info.title : sessionId
  const lines = [`# OpenCode Session: ${title}`, "", `Session ID: ${sessionId}`, ""]

  for (const message of messages) {
    const messageRecord = asRecord(message)
    const messageInfo = asRecord(messageRecord?.info)
    const role = typeof messageInfo?.role === "string" ? messageInfo.role : "unknown"
    const parts = Array.isArray(messageRecord?.parts) ? messageRecord.parts : []
    const content = parts.flatMap(part => {
      const record = asRecord(part)
      return record ? partText(record) : []
    })
    if (content.length === 0) continue
    lines.push(`## ${role}`, "", content.join("\n\n"), "")
  }

  if (lines.length === 4) throw new Error("OpenCode export JSON contained no readable message content")
  return lines.join("\n").trimEnd() + "\n"
}

async function shellOutputText(result: unknown): Promise<string> {
  if (typeof result === "string") return result
  const record = asRecord(result)
  if (record && typeof record.text === "function") {
    return await (record.text as () => Promise<string>)()
  }
  if (record && typeof record.stdout === "string") return record.stdout
  return String(result ?? "")
}

/** Run the supported OpenCode export command and normalize its full JSON output. */
export async function exportSession(shell: Shell, sessionId: string): Promise<string> {
  const result = await shell`opencode export ${sessionId}`
  return renderSessionExport(await shellOutputText(result), sessionId)
}

export const RecallExtract: Plugin = async ({ $ }) => {
  mkdirSync(DROP_DIR, { recursive: true })
  const tracker = loadTracker()
  const inFlight = new Set<string>()

  return {
    event: async ({ event }: { event: unknown }) => {
      const sessionId = sessionIdFromEvent(event)
      if (!sessionId || tracker.has(sessionId) || inFlight.has(sessionId)) return

      inFlight.add(sessionId)
      try {
        const markdown = await exportSession($ as unknown as Shell, sessionId)
        const outFile = join(DROP_DIR, `${sessionId}.md`)
        writeFileSync(outFile, markdown)
        tracker.add(sessionId)
        saveTracker(tracker)
      } catch (error) {
        console.error(`[recall] OpenCode session export failed for ${sessionId}; will retry on a later idle event: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        inFlight.delete(sessionId)
      }
    }
  }
}
