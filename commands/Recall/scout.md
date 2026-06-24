---
description: Scout an unfamiliar codebase — memory-first repo map, key paths, tests, risks, and next steps, with a strict sensitive-data boundary
---

Produce a **scout report** for the current repository: a fast, structured orientation for whoever is about to work in this codebase. Optional focus (`$1`) narrows the scout to a subsystem, path, or question (e.g. `auth`, `the extraction pipeline`, `src/db`). With no focus, scout the repo as a whole.

This is the canonical scouting workflow; platform guides reference it and only remap tool names. Do not hand-copy these steps into `FOR_CLAUDE.md`, `FOR_PI.md`, `FOR_OPENCODE.md`, or `opencode/recall-memory.md` — those files point here and supply only their own tool-name mapping.

## Workflow

1. **Memory first.** Before reading git history or source files, search Recall for what is already known about this repo and the focus. Use keyword search for names and hybrid search for natural-language questions, scoped to **this project only**. Recall's structured decisions, learnings, and session summaries are richer than commit messages — start here, not with `git log`.
2. **Repo map.** Build a high-level map: languages, entry points, top-level layout, build/test commands. Read declared structure (README, `AGENTS.md`/`CLAUDE.md`, `package.json` scripts) before inferring from a full tree walk. If a codegraph index is present (a `.codegraph/` directory), ground the map with codegraph's explore tool (`codegraph_explore`) instead of a blind tree walk; if the `codegraph` CLI is installed but no index exists yet, run `codegraph init` once first. codegraph is orientation only — grep / the tree walk stays the completeness backstop. codegraph is an enhancement, never a hard dependency: if it isn't installed, skip it and produce the full scout report exactly as below.
3. **Key paths.** Identify the handful of files that matter most for the focus — entry points, core modules, config, and the seams where changes usually land. Cite them as `path:line` where useful. When codegraph is available, use `codegraph_explore` to surface those files and their callers/callees for the focus rather than guessing from the tree.
4. **Tests.** Locate the test suite, the runner, and how to invoke it. Note coverage gaps relevant to the focus.
5. **Risks.** Surface what would bite someone working here — fragile areas, undocumented invariants, conventions that are easy to violate (pull these from memory and from project rules files).
6. **Next steps.** Recommend the concrete first moves for the focus, ordered, each tied to a path or command.

## Report format

Output the scout report **in chat** with these sections, in order:

- **Memory summary** — what Recall already knew (decisions, learnings, breadcrumbs, prior sessions). Say so explicitly if memory was empty.
- **Repo map** — languages, layout, build/test commands.
- **Key paths** — the files that matter, with one line each on why.
- **Tests** — suite location, runner, how to run, notable gaps.
- **Risks** — what would bite someone working here.
- **Next steps** — ordered, concrete, path- or command-anchored.

## Sensitive-data boundary (MANDATORY)

Never read, echo, summarize, or write any of the following — if the focus would require crossing this boundary, stop and say so instead:

- **Secrets / credentials** — `.env*`, `*.key`, `*.pem`, tokens, API keys, anything matching a credential pattern. Do not print their values even if asked to "summarize config."
- **Generated / vendored files** — `node_modules/`, `dist/`, `build/`, `.git/` internals, lockfile contents. Map their existence, never their contents.
- **The live database** — never open, query, or dump `~/.agents/Recall/recall.db` (or any production DB). Use the Recall search tools, which scope and redact for you.
- **Cross-project memory** — scope every Recall search to **this** repository's project. Do not surface, quote, or leak another project's memory into this report.

## Artifacts (opt-in)

The scout report is **chat-only by default — write nothing to disk.** Persist an artifact only when the repo endorses it: a `.agents/atlas/artifacts/` directory already exists, or the user explicitly asks for a saved report. When endorsed, write **only** to `.agents/atlas/artifacts/` as `YYYY-MM-DD-scout-<focus>.md`. Never write scout artifacts to `.agents/atlas/handoffs/` (reserved for handoffs) or anywhere else.

$@
