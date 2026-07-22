// pi/RecallPreCompact.ts
// Pi extension: injects Recall memory into system prompt before every agent turn.
//
// VERIFIED AGAINST PI 0.81.1:
//   - pi.on("before_agent_start", handler) — fires before every agent turn
//   - handler receives (event, ctx) where event.systemPrompt is current prompt
//   - Returning { systemPrompt: "..." } replaces it for that turn only
//   - async handlers and pi.exec(command, args, { timeout }) are supported

export default function (pi: any) {
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    try {
      const cwd = ctx?.cwd || ""
      const projectName = cwd.split("/").pop() || ""
      if (!projectName) return

      const result = await pi.exec("recall", [
        "search", projectName, "--limit", "5"
      ], { signal: ctx?.signal, timeout: 5000 })
      const context = result.code === 0 ? result.stdout : ""

      if (context.trim()) {
        return {
          systemPrompt: event.systemPrompt +
            "\n\n## Persistent Memory (from Recall)\n" +
            "The user has a persistent memory system. Key context from previous sessions:\n" +
            context
        }
      }
    } catch {
      // recall CLI unavailable or timed out — skip silently
    }
  })
}
