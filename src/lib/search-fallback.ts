// memory_search → hybrid/semantic fallback (issue #39)
//
// FTS5 matches literal tokens, so a global memory_search can return zero hits
// for a record that exists under different wording. When that happens AND the
// caller did not hard-filter by `table`, the handler retries via hybridSearch
// and surfaces the semantic matches, clearly labeled.
//
// This module holds the pure decision + formatting logic so it is unit-testable
// without importing mcp-server.ts (which has module-level side effects). It is
// the delegate the memory_search handler calls — the same pattern the existing
// hybrid provenance tests use for vectorRowContentProvenance.

import type { Provenance } from "../types/index.js";
import { provenanceLabel } from "./provenance.js";

/** A single hybridSearch result — mirrors the shape hybridSearch() returns. */
export interface HybridSearchResult {
	table: string;
	id: number;
	content: string;
	score: number;
	source: "fts" | "vec" | "both";
	provenance: Provenance | null;
}

/** Outcome of a zero-keyword-hit query: the response text plus the single,
 *  honest metrics log line to emit for the call. */
export interface SearchFallbackOutcome {
	text: string;
	logTool: string;
	logCount: number;
}

/**
 * Should a zero-keyword-hit query fall back to hybrid/semantic search?
 *
 * Only GLOBAL queries fall back. A hard `table` filter means the caller
 * intentionally narrowed scope, so the honest empty result is respected.
 */
export function shouldFallbackToHybrid(
	keywordResultCount: number,
	table: string | undefined,
): boolean {
	return keywordResultCount === 0 && !table;
}

/**
 * Format hybrid results using the same display shape as memory_hybrid_search:
 * `rrf=${score} ${sourceTag} [${table}#${id}] | provenance: ${provenance}` over a
 * 200-char content preview, blocks joined by `\n\n---\n\n`.
 *
 * `score` is a Reciprocal Rank Fusion score, NOT a percentage (#240). RRF sums
 * 1/(60+rank) per list, so it tops out near 0.033 for a rank-1-in-both-lists hit
 * and has no upper bound of 1. Rendering it as `${score * 100}%` implied a
 * confidence it never carried — and on the FTS-only path, where the field used to
 * hold a raw negative bm25 rank, it printed impossibilities like "-1121.0%".
 * It is a relative ranking signal: comparable within one result set, meaningless
 * as an absolute. Labelled `rrf=` so it can never be misread as confidence.
 */
export function formatHybridResults(results: HybridSearchResult[]): string {
	return results
		.map((r) => {
			const sourceTag =
				r.source === "both"
					? "[FTS+VEC]"
					: r.source === "vec"
						? "[VEC]"
						: "[FTS]";
			const preview =
				r.content.length > 200 ? r.content.slice(0, 200) + "..." : r.content;
			const score = r.score.toFixed(4);
			// Shared provenanceLabel (ADR-0001): NULL is reported as "unknown",
			// never guessed. Single-sourced in lib/provenance.ts.
			const provenance = provenanceLabel(r.provenance);
			return `rrf=${score} ${sourceTag} [${r.table}#${r.id}] | ${provenance}\n${preview}`;
		})
		.join("\n\n---\n\n");
}

/**
 * Build the response + metrics line for a global zero-keyword-hit query after
 * the hybrid fallback has run.
 *
 * - hybrid returned matches → label them as semantic, log the real count.
 * - hybrid returned nothing (e.g. embeddings unavailable, so hybrid degrades to
 *   the same empty FTS set) → return the honest empty result. Never claim
 *   semantic matches that don't exist.
 */
export function buildHybridFallbackOutcome(
	query: string,
	hybridResults: HybridSearchResult[],
): SearchFallbackOutcome {
	if (hybridResults.length > 0) {
		return {
			text: `No exact keyword hits for "${query}"; showing semantic matches:\n\n${formatHybridResults(hybridResults)}`,
			logTool: "memory_search:hybrid-fallback",
			logCount: hybridResults.length,
		};
	}
	return {
		text: `No results found for: "${query}"`,
		logTool: "memory_search:hybrid-fallback",
		logCount: 0,
	};
}
