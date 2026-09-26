// opencode/lib/session-export.ts
// Pure helpers for turning an OpenCode session export into Recall's markdown
// drop format.
//
// WHY THIS FILE EXISTS: OpenCode invokes EVERY export of a top-level plugin
// module as a plugin factory. When these helpers lived in
// `opencode/RecallExtract.ts` alongside the factory, OpenCode called
// `exportSession(pluginContext)` on startup, the tagged-template call hit a
// context object instead of a shell function, and every launch logged
// `ERROR failed to load plugin ... "Object is not a function"`.
//
// OpenCode only globs `plugins/*.ts`, so a module nested under `plugins/lib/`
// is importable without being mistaken for a plugin. Keep it that way: the
// plugin entry points must export nothing but their factory.

export type Shell = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>

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
