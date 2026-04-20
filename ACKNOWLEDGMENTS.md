# Acknowledgments

Recall is an original work, but several of its design choices were shaped
by external projects and independent analyses. This file records those
debts specifically — what we pulled, what we reshaped, what we rejected,
and why. The detail matters: we want readers to be able to trace any
Recall feature back to its intellectual origin, and we want to be honest
about which ideas survived scrutiny and which did not.

## MemPalace

**Project:** [MemPalace](https://github.com/MemPalace/mempalace)
**Authors:** Milla Jovovich, Ben Sigman
**License:** MIT

MemPalace is a Python memory system for LLM agents built around a
spatial "wings / rooms / drawers" metaphor over ChromaDB plus a separate
SQLite knowledge graph. On 2026-04-17 we ran a three-agent research pass
(Perplexity, Codex, Grok), a red-team review, and an architect
feasibility pass against MemPalace's design. Three of its ideas became
features in Recall.

We did not copy any MemPalace code. Every adopted idea was re-implemented
in TypeScript inside Recall's existing SQLite + FTS5 + hooks architecture,
with deliberate reshapes documented below. MemPalace's MIT license
permits this use; this file exists because intellectual credit is owed
even when code is not reused.

### Ideas adopted (with reshapes)

#### 1. Tiered session-start context — `hooks/SessionRecall.ts`

| | MemPalace | Recall (reshaped) |
|---|---|---|
| Concept | `wake_up()` returns a bundle: L0 identity → L1 top records → L2/L3 on demand | Same four-tier concept |
| L0 source | Identity file | `~/.claude/MEMORY/identity.md` — user-authored, optional |
| L1 budget | ~170 tokens (their corpus) | 12 records derived from our own corpus, not copied |
| LoA handling | Not applicable | 4 of 12 L1 slots reserved for LoA; LoA elevated by importance floor of 8 |
| L2/L3 | Their own retrieval API | Existing `memory_search` / `memory_recall` MCP tools; documented in the preamble |

**Why we adopted it:** the underlying discipline — pre-load identity + a
small curated set, leave deep search on demand — is architecturally
sound independent of the specific token numbers MemPalace publishes.

**Why we reshaped it:** MemPalace's 170-token figure is cargo-culted
from their corpus and their embedding model. Copying it would have
been dishonest. Our budget is tuned from observed use.

**Shipped in:** v0.7.0 (2026-04-18)

#### 2. PreCompact hook — `hooks/SessionPreCompact.ts`

| | MemPalace | Recall (reshaped) |
|---|---|---|
| Concept | Fire a hook before Claude Code compacts context | Same |
| What fires | Full Haiku extraction | **Flush only** — write in-flight messages to SQLite |
| Dedup | No mechanism in MemPalace | Per-conversation byte-offset watermark; cooperates with `Stop`'s extract lock |
| Risk handled | Not addressed | If `Stop` extraction is in flight, `PreCompact` skips |

**Why we adopted it:** long sessions that never `Stop` were losing
their pre-compaction state. This was a real gap in Recall 0.6.x.

**Why we reshaped it:** running Haiku on every compaction would create
duplicate, fragmented records. The value is the **flush**, not the
re-extraction.

**Shipped in:** v0.7.0 (2026-04-18)

#### 3. Importance scoring on records

| | MemPalace | Recall (reshaped) |
|---|---|---|
| Concept | A numeric `importance` score per record used to rank candidates | Same |
| Type | `REAL` float | `INTEGER 1-10` (matches Recall's existing `breadcrumbs` column) |
| Assignment | Set during ingestion | Backfill-only for the first cut; `mem pin` / `mem unpin` for explicit override |
| LoA protection | Not applicable | LoA floored at 8, never rescored by heuristics |

**Why we adopted it:** Recall's session-start context had no ranking
signal beyond recency. L1 could not be meaningful without importance.

**Why we reshaped it:** float importance creates false precision;
integer 1-10 aligns with the existing `breadcrumbs` column and is
backfillable from confidence without introducing a dual-type problem.

**Shipped in:** v0.7.0 (migration 7 → 8)

### Ideas rejected (with thanks for the example)

#### PALACE_PROTOCOL behavioral injection — KILLED

MemPalace embeds a behavioral instruction in every `mempalace_status`
response telling the model to verify before guessing. We studied the
pattern and killed it as a design choice: embedding model-directed
instructions in tool responses across multiple hosts (Claude Code,
OpenCode, Pi) is exactly the prompt-injection pattern our own defense
rules tell the model to resist. If we want verification-first behavior,
it belongs in `FOR_CLAUDE.md` / `FOR_OPENCODE.md` / `FOR_PI.md`, which
are user-consented system prompt content.

MemPalace's example clarified the failure mode for us, and we kept the
`**Recall is active.**` footer *out* of v2 for the same reason. Credit
for surfacing the pattern; no code adopted.

#### Knowledge-graph triples — DEFERRED

Interesting idea, but Recall's queries are 95% "find records about X,"
not "what is the relationship between X and Y." Triples extracted by an
LLM without a controlled predicate vocabulary degenerate into a bag of
disconnected facts. We will revisit only if the tiered context shipped
in 0.7.0 surfaces a relational gap we cannot close otherwise.

#### Type-weighted FTS5 ranking — OPTIONAL only

Redundant with the existing `--type` filter. Offered as an optional
`bias_type` MCP parameter; not on by default.

### Negative lessons

These are MemPalace behaviors Recall explicitly does _not_ adopt.
Treating them as "what not to do" has been as valuable as the ideas
themselves:

1. **Don't ship features in the README that aren't in the code.**
   MemPalace's README advertises contradiction detection that does not
   exist in their source. Recall's docs are audited against shipped
   behavior; claims without code are removed.
2. **Don't claim lossless when it's lossy.** AAAK's "30x lossless"
   compression claim collapsed under independent benchmarking with a
   12.4 percentage-point retrieval drop. Any compression /
   summarization / extraction Recall ships is characterized in fidelity
   terms, not compression ratios.
3. **Don't conflate retrieval-presence with answer accuracy.**
   MemPalace's headline 96.6% LongMemEval R@5 measures whether the
   right chunk is in the top-5 — not whether the LLM gives a correct
   answer. Recall's benchmark harness (`mem benchmark`) reports
   retrieval presence (`R@k`) and answer accuracy as separate numbers
   and never blends them into a composite "Recall score."
4. **Don't treat star count as validation.** 47,000 GitHub stars in
   eight days for a project with no institutional backing is a social
   signal, not a technical one. Recall makes no claims about stars
   anywhere in its docs.

## Independent analyses

Three of the four reshape decisions above leaned heavily on independent
critiques of MemPalace's claims. Without these authors' scrutiny, we
would have spent more engineering cycles on ideas that did not hold up.
Thanks to:

- **[lhl](https://github.com/lhl)** — agentic-memory repo:
  [ANALYSIS-mempalace.md](https://github.com/lhl/agentic-memory/blob/main/ANALYSIS-mempalace.md).
  The independent benchmark run that showed the "lossless 30x" claim
  drops 12.4 percentage points of retrieval accuracy in practice. This
  analysis is the reason Recall reports fidelity, not compression.
- **[roman-rr](https://github.com/roman-rr)** —
  [star-pattern gist](https://gist.github.com/roman-rr/0569fc487cc620f54a70c90ab50d32e3).
  Metronomic star-acquisition timing analysis. The reminder to evaluate
  on architectural merit rather than social signal.
- **[danilchenko](https://www.danilchenko.dev)** —
  [critical review](https://www.danilchenko.dev/posts/2026-04-10-mempalace-review-ai-memory-system-milla-jovovich/).
  The README-vs-source audit that flagged non-existent features. This
  is why Recall's docs are now audited against shipped code on every
  release.
- **[tentenco](https://medium.com/@tentenco)** —
  [benchmark interpretation](https://medium.com/@tentenco/mempalace-milla-jovovichs-ai-memory-system-what-the-benchmarks-actually-mean-1a3abe4490d8).
  The walkthrough that separated "the right chunk is in the top-5" from
  "the answer is correct." Recall's Suite A benchmark reports both,
  separately, because of this piece.

Full research package, including the original three-agent red-team
output and the architect feasibility notes, is archived at
`.atlas/plans/2026-04-17-mempalace-research-borrow-list.md` in this
repository (gitignored, but available on the author's machine and
reproducible via the research workflow documented therein).

## Prior art Recall does not borrow from but sits alongside

The 2025–2026 open-source convergence on SQLite + FTS5 + vector
embeddings + MCP for agent memory is broader than any single project.
Projects in that neighborhood include
[sqlite-memory](https://github.com/sqlite-memory),
[agentmem](https://github.com/agentmem),
[AIngram](https://github.com/aingram-dev), and
[engram](https://github.com/engram). Recall reached the same
architectural choices independently, but the convergence validates
them. We note the company.

## License

Recall is MIT-licensed. MemPalace is MIT-licensed. The two licenses are
compatible; the intellectual attributions above exist as a matter of
authorial honesty rather than legal obligation.
