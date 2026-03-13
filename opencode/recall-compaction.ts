// opencode/recall-compaction.ts
// Injects Recall memory context into OpenCode session compaction summaries.
//
// When OpenCode compresses a long session, this hook ensures persistent
// memory context survives the compaction by injecting it into the summary.
//
// VERIFIED APIs USED:
//   - experimental.session.compacting(input, output) — confirmed signature
//   - output.context (array) — push strings to inject context
//   - output.prompt (string) — replaces entire compaction prompt (not used here)
//   - execFileSync for mem CLI — standard Node/Bun API

import type { Plugin } from "@opencode-ai/plugin"
import { execFileSync } from "child_process"

export const RecallCompaction: Plugin = async ({ project }) => {
  return {
    // Verified signature: (input, output) — NOT (event)
    "experimental.session.compacting": async (input: any, output: any) => {
      try {
        // Defensive: ensure output.context is an array before pushing
        if (!output || !Array.isArray(output.context)) return

        const projectName = project?.name || project?.id || ""
        const context = execFileSync("mem", [
          "search", projectName, "--limit", "5"
        ], { encoding: "utf-8", timeout: 5000 })

        if (context.trim()) {
          output.context.push(
            `## Persistent Memory (from Recall)\n` +
            `The user has a persistent memory system. Key context:\n${context}`
          )
        }
      } catch {
        // mem CLI unavailable (ENOENT), timed out, or other error — skip silently
      }
    }
  }
}
