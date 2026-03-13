// pi/recall-compaction.ts
// Pi extension: injects Recall memory into system prompt before every agent turn.
//
// VERIFIED APIs:
//   - pi.on("before_agent_start", handler) — fires before every agent turn
//   - handler receives (event, ctx) where event.systemPrompt is current prompt
//   - Returning { systemPrompt: "..." } replaces it for that turn only
//   - execFileSync for mem CLI — standard Node/Bun API

import { execFileSync } from "child_process"

export default function (pi: any) {
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    try {
      const cwd = ctx?.cwd || ""
      const projectName = cwd.split("/").pop() || ""

      const context = execFileSync("mem", [
        "search", projectName, "--limit", "5"
      ], { encoding: "utf-8", timeout: 5000 })

      if (context.trim()) {
        return {
          systemPrompt: event.systemPrompt +
            "\n\n## Persistent Memory (from Recall)\n" +
            "The user has a persistent memory system. Key context from previous sessions:\n" +
            context
        }
      }
    } catch {
      // mem CLI unavailable or timed out — skip silently
    }
  })
}
