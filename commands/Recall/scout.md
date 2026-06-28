---
description: Scout an unfamiliar codebase — memory-first repo map, key paths, tests, risks, and next steps, with a strict sensitive-data boundary
---

Produce a **scout report** for the current repository: a fast, structured orientation for whoever is about to work in this codebase. Optional focus (`$1`) narrows the scout to a subsystem, path, or question (e.g. `auth`, `the extraction pipeline`, `src/db`). With no focus, scout the repo as a whole.

This is the canonical scouting workflow; platform guides reference it and only remap tool names. Do not hand-copy these steps into `FOR_CLAUDE.md`, `FOR_PI.md`, `FOR_OPENCODE.md`, or `opencode/recall-memory.md` — those files point here and supply only their own tool-name mapping.

## Workflow

1. **Memory first.** Before reading git history or source files, search Recall for what is already known about this repo and the focus. Use keyword search for names and hybrid search for natural-language questions, scoped to **this project only**. Recall's structured decisions, learnings, and session summaries are richer than commit messages — start here, not with `git log`.
2. **Repo map.** Build a high-level map: languages, entry points, top-level layout, build/test commands. Read declared structure (README, `AGENTS.md`/`CLAUDE.md`, `package.json` scripts) before inferring from a full tree walk. **Ground the map in a code graph, native-first:**
   - **Native KG first.** Recall ships its own code knowledge graph in the same database as your memories — no external dependency. Probe it with a quick `recall callers <a-known-symbol>` (or `recall code-context <a-key-file>`): real edges mean the graph is live; a `No code symbol matched` / `not indexed` reply means the schema is present but empty — offer to run `recall index` once; a `Run 'recall init'` capability error means the database predates the graph schema, so run `recall init` first. Once it's live, use it to confirm entry points and module seams instead of a blind tree walk.
   - **External codegraph fallback.** If the native KG isn't available and an external codegraph index is present (a `.codegraph/` directory), ground with `codegraph_explore` instead; if the `codegraph` CLI is installed but unindexed, run `codegraph init` once first.
   - **Backstop.** Either graph is orientation only — grep / the tree walk stays the completeness backstop. A code graph is an enhancement, never a hard dependency: if neither is available, skip it and produce the full scout report exactly as below.
3. **Key paths.** Identify the handful of files that matter most for the focus — entry points, core modules, config, and the seams where changes usually land. Cite them as `path:line` where useful. Surface them with the code graph rather than guessing from the tree (native-first, per step 2): `recall callers <symbol>` for what depends on a seam, `recall callees <symbol>` for what it depends on, and `recall trace <from> <to>` (bounded; `--depth` defaults to 5) to confirm a path between two symbols. Fall back to `codegraph_explore` when the native KG isn't populated.
4. **Decisions & learnings tied to the key files.** For each key path, run `recall code-context <relpath>` to pull the decisions and learnings whose text references the symbols defined in that file — the memory↔code join that lives in Recall's one database and that no external code-graph tool can do. It ties *why* a hot file is the way it is back to the file itself. The command scopes to this project and skips cleanly when the file isn't indexed (it says so and suggests `recall index`).
5. **Tests.** Locate the test suite, the runner, and how to invoke it. Note coverage gaps relevant to the focus.
6. **Risks.** Surface what would bite someone working here — fragile areas, undocumented invariants, conventions that are easy to violate (pull these from memory, from `recall code-context` on the hot files, and from project rules files).
7. **Next steps.** Recommend the concrete first moves for the focus, ordered, each tied to a path or command.

## Report format

Output the scout report **in chat** with these sections, in order:

- **Memory summary** — what Recall already knew (decisions, learnings, breadcrumbs, prior sessions). Say so explicitly if memory was empty.
- **Repo map** — languages, layout, build/test commands.
- **Key paths** — the files that matter, with one line each on why (grounded in the code graph where available).
- **Decisions & learnings** — per key file, the memory tied to its code (from `recall code-context`). Omit the section if nothing was found.
- **Tests** — suite location, runner, how to run, notable gaps.
- **Risks** — what would bite someone working here.
- **Next steps** — ordered, concrete, path- or command-anchored.

## Sensitive-data boundary (MANDATORY)

Never read, echo, summarize, or write any of the following — if the focus would require crossing this boundary, stop and say so instead:

- **Secrets / credentials** — `.env*`, `*.key`, `*.pem`, tokens, API keys, anything matching a credential pattern. Do not print their values even if asked to "summarize config."
- **Generated / vendored files** — `node_modules/`, `dist/`, `build/`, `.git/` internals, lockfile contents. Map their existence, never their contents.
- **The live database** — never open, query, or dump `~/.agents/Recall/recall.db` (or any production DB) directly. Use the Recall CLI and search tools — including the code-graph verbs (`recall callers`/`callees`/`trace`/`code-context`), which read the database for you, scoped to this project — never raw SQL against the file.
- **Cross-project memory** — scope every Recall search to **this** repository's project. Do not surface, quote, or leak another project's memory into this report.

## Artifacts (opt-in)

The scout report is **chat-only by default — write nothing to disk.** Persist an artifact only when the repo endorses it: a `.agents/atlas/artifacts/` directory already exists, or the user explicitly asks for a saved report. When endorsed, write **only** to `.agents/atlas/artifacts/` as `YYYY-MM-DD-scout-<focus>.md`. Never write scout artifacts to `.agents/atlas/handoffs/` (reserved for handoffs) or anywhere else.

$@
