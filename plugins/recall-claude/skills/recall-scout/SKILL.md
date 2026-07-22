---
name: "recall-scout"
description: "Scout an unfamiliar codebase — memory-first repo map, key paths, tests, risks, and next steps, with a strict sensitive-data boundary"
allowed-tools: Bash(git log -10 --oneline), Bash(git status -s | head), Bash(codegraph status --json)
---

Produce a **scout report** for the current repository: a fast, structured orientation for whoever is about to work in this codebase. An optional focus argument narrows the scout to a subsystem, path, or question (e.g. `auth`, `the extraction pipeline`, `src/db`). With no focus, scout the repo as a whole.

This is the canonical scouting workflow; platform guides reference it and only remap tool names. Do not hand-copy these steps into `FOR_CLAUDE.md`, `FOR_PI.md`, `FOR_OPENCODE.md`, or `opencode/recall-memory.md` — those files point here and supply only their own tool-name mapping.

## Live context

Three bounded orienters, each well under 1 KB of output. On Claude Code the `!` prefix inlines their output here at prompt load; on hosts without the `!` mechanic, run the same three commands manually as your first step.

- Recent commits: !`git log -10 --oneline`
- Working tree: !`git status -s | head`
- CodeGraph probe: !`codegraph status --json`

## Workflow

1. **Memory first.** Before reading git history or source files, search Recall for what is already known about this repo and the focus. Use keyword search for names and hybrid search for natural-language questions, scoped to **this project only**. Recall's structured decisions, learnings, and session summaries are richer than commit messages — start here, not with `git log`.
2. **CodeGraph capability ladder.** Read the probe (`codegraph status --json` — it exits 0 even on an unindexed repo) and branch on `initialized`:
   - **Indexed** (`initialized: true`): check freshness — if `pendingChanges` is non-zero or `reindexRecommended` is true, run `codegraph sync -q` (cheap, safe) before querying.
   - **CLI installed, repo unindexed** (`initialized: false`): **offer** indexing, don't run it — "this repo isn't indexed; `codegraph init` takes ~2 s per 200 files, writes only a self-gitignored `.codegraph/`, and `codegraph uninit` reverses it — want it?" Run `codegraph init` only on an explicit user yes; indexing is the user's decision, never auto-run it. Without a yes, continue on the backstop.
   - **No CLI** (the probe errors with command-not-found): skip CodeGraph entirely and produce the full report via the grep/tree-walk backstop.
   - CodeGraph is an enhancement, never a hard dependency: every report section below must be producible with zero CodeGraph. (Hosts with the CodeGraph MCP server may use its single tool, `codegraph_explore`, wherever `codegraph explore` appears — identical output; everything else on this page is CLI-only.)
3. **Repo map.** Build a high-level map: languages, entry points, top-level layout, build/test commands. With a live index, start from the **orientation bundle** — `codegraph status --json` (languages, symbol-kind profile, file/node counts; already inlined above) plus `codegraph files --max-depth 2 --no-metadata` (the repo tree; add `--filter <dir>` when the focus names an area). The bundle costs ~600 tokens and replaces a blind tree walk. Then read the declared ground truth directly — these files are small and never in the index: README, `AGENTS.md`/`CLAUDE.md`, the dependency manifest (`package.json` including its `scripts`, or `pyproject.toml` / `Cargo.toml` / `go.mod`), the compiler/tooling config (`tsconfig.json` or equivalent), and CI workflow names. Without CodeGraph, the same declared reads plus a bounded tree walk produce the map.
4. **Tech stack.** From manifests only: languages, runtime, frameworks and major libraries with their **declared** versions, build tooling, test framework, and package manager — read from the manifest's declared ranges (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`). Lockfiles stay behind the sensitive-data boundary: map their existence, never their contents, so version ground truth is the declared range, not the resolved lockfile pin. CodeGraph contributes the languages list and symbol-kind profile from `status --json`; it does not know dependencies or versions.
5. **Key paths.** Identify the handful of files that matter most for the focus — entry points, core modules, config, and the seams where changes usually land. Cite them as `path:line` where useful. With a live index, surface them with at most two narrow `codegraph explore` calls (see the query discipline below) rather than guessing from the tree: one explore answers "what calls this seam", "what does it depend on", and "trace a path between two symbols" in a single query. Fall back to grep when CodeGraph isn't available.
6. **Decisions & learnings tied to the key files.** For each key path, search Recall (keyword + hybrid, scoped to **this** project) for the decisions and learnings that reference the file or the symbols it defines — *why* a hot file is the way it is. This focuses the memory-first search from step 1 on each key path.
7. **Conventions.** How the house writes code, from three legs: **declared** — the rules files already read in step 3 (`AGENTS.md`/`CLAUDE.md`/`CONTRIBUTING.md`) plus lint/format configs (`eslint`/`prettier`/`.editorconfig`, `tsconfig` strictness); **observed** — one CodeGraph style probe over a representative module (`codegraph explore` of that module, or cheaper, `codegraph node --file <path> --symbols-only`) for naming patterns, module seams, and test-file conventions — an explore used here counts against the two-explore cap; **learned** — Recall learnings, which often encode "wrong → right" convention corrections.
8. **Tests.** Locate the test suite, the runner, and how to invoke it. Note coverage gaps relevant to the focus.
9. **Risks.** Surface what would bite someone working here — fragile areas, undocumented invariants, conventions that are easy to violate (pull these from memory on the hot files and from project rules files).
10. **Next steps.** Recommend the concrete first moves for the focus, ordered, each tied to a path or command.

## CodeGraph query discipline

CodeGraph replaces the expensive grep-and-read loop, but `explore` pastes verbatim source and has no output cap — discipline keeps the scout token-frugal:

- **Narrow, named queries only.** Point `explore` at a symbol, a file, or a seam — never a vague topic. Off-target matches cost the same tokens as on-target ones.
- **Soft cap: at most two `explore` calls per scout run**, including the Conventions style probe.
- **Never re-paste explore output into the report.** The report wants a one-line "why it matters" per key path and `path:line` cites — not quoted source blocks.
- **Prefer cappable forms for edge questions:** `codegraph callers <symbol> --limit 5`, `codegraph callees <symbol> --limit 5`, `codegraph query <term> --limit 3 --kind <kind>`, `codegraph node --file <path> --symbols-only`.
- **Backstop means fallback, not second pass:** if CodeGraph answered a question, skip grep and the tree walk for that same question.
- **Symbol misses exit 0.** `query`/`node`/`callers` print "not found" and still exit 0 — check the output text for misses, don't exit-check.

## Report format

Output the scout report **in chat** with these sections, in order:

- **Memory summary** — what Recall already knew (decisions, learnings, breadcrumbs, prior sessions). Say so explicitly if memory was empty.
- **Repo map** — languages, layout, build/test commands.
- **Tech stack** — languages/runtime, frameworks and major libraries with declared versions, build/test tooling, package manager (from manifests; lockfiles excluded).
- **Key paths** — the files that matter, with one line each on why (grounded in the code graph where available).
- **Decisions & learnings** — per key file, the memory tied to its code (from Recall search on the file and its symbols). Omit the section if nothing was found.
- **Conventions** — the house style: declared rules, observed patterns, and Recall-learned corrections.
- **Tests** — suite location, runner, how to run, notable gaps.
- **Risks** — what would bite someone working here.
- **Next steps** — ordered, concrete, path- or command-anchored.

## Sensitive-data boundary (MANDATORY)

Never read, echo, summarize, or write any of the following — if the focus would require crossing this boundary, stop and say so instead:

- **Secrets / credentials** — `.env*`, `*.key`, `*.pem`, tokens, API keys, anything matching a credential pattern. Do not print their values even if asked to "summarize config."
- **Generated / vendored files** — `node_modules/`, `dist/`, `build/`, `.git/` internals, lockfile contents. Map their existence, never their contents.
- **The live database** — never open, query, or dump `~/.agents/Recall/recall.db` (or any production DB) directly. Use the Recall CLI and search tools, which read the database for you, scoped to this project — never raw SQL against the file.
- **Cross-project memory** — scope every Recall search to **this** repository's project. Do not surface, quote, or leak another project's memory into this report.

## Artifacts (opt-in)

The scout report is **chat-only by default — write nothing to disk.** Persist an artifact only when the repo endorses it: a `.agents/atlas/artifacts/` directory already exists, or the user explicitly asks for a saved report. When endorsed, write **only** to `.agents/atlas/artifacts/` as `YYYY-MM-DD-scout-<focus>.md`. Never write scout artifacts to `.agents/atlas/handoffs/` (reserved for handoffs) or anywhere else.
