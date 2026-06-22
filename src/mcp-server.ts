#!/usr/bin/env node

// RECALL - MCP Server
// Exposes memory as first-class tools for Claude Code

import { appendFileSync, existsSync as fsExistsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "./version.js";

/**
 * Memory usage logging for metrics and enforcement tracking
 * Logs: timestamp, tool, query, results_count, project
 */
const LOG_DIR = join(homedir(), ".claude", "logs");
const MEMORY_LOG = join(LOG_DIR, "memory-usage.jsonl");

function logMemoryUsage(
	tool: string,
	query: string,
	resultsCount: number,
	project?: string,
): void {
	try {
		if (!fsExistsSync(LOG_DIR)) {
			mkdirSync(LOG_DIR, { recursive: true });
		}
		const entry = {
			timestamp: new Date().toISOString(),
			tool,
			query: query.slice(0, 200), // Truncate long queries
			results_count: resultsCount,
			project: project || null,
		};
		appendFileSync(MEMORY_LOG, JSON.stringify(entry) + "\n");
	} catch {
		// Silently fail - logging shouldn't break memory operations
	}
}
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getDb, initDb, getDbPath } from "./db/connection.js";
import {
	search,
	bumpAccess,
	SEARCH_TABLES,
	recentMessages,
	recentDecisions,
	recentLearnings,
	recentBreadcrumbs,
	recentLoaEntries,
	getLoaEntry,
	addDecision,
	addLearning,
	addBreadcrumb,
	getDecision,
	supersedeDecision,
	revertDecision,
	findSimilarDecisions,
	getStats,
	vectorRowContentProvenance,
} from "./lib/memory.js";
import {
	blobToEmbedding,
	cosineSimilarity,
	reciprocalRankFusion,
} from "./lib/embeddings.js";
import { embedQueryCached } from "./lib/query-embedding-cache.js";
import { checkEmbeddingServiceCached } from "./lib/availability-cache.js";
import {
	isRebackfillNeeded,
	expectedEmbeddingMarker,
} from "./lib/embedding-marker.js";
import {
	isVecAvailable,
	ensureVecIndexSynced,
	knnSearch,
} from "./db/vec.js";
import { notMarkedDuplicateSql } from "./lib/dedup.js";
import {
	shouldFallbackToHybrid,
	buildHybridFallbackOutcome,
} from "./lib/search-fallback.js";
import { provenanceLabel } from "./lib/provenance.js";
import type { Provenance } from "./types/index.js";
import { existsSync } from "fs";

/**
 * Brute-force cosine scan over all non-duplicate embeddings — the fallback when
 * sqlite-vec is unavailable (and the original #45/#107 behavior). Returns the
 * top limit*2 by similarity.
 */
function bruteForceVectorScan(
	db: ReturnType<typeof getDb>,
	queryEmbedding: number[],
	limit: number,
): Array<{ source_table: string; source_id: number; similarity: number }> {
	// Marked duplicates (recall dedup, issue #45) keep their embeddings but are
	// hidden from the vector path, matching the FTS5 default.
	const embeddings = db
		.prepare(`
        SELECT source_table, source_id, embedding FROM embeddings
        WHERE ${notMarkedDuplicateSql("source_table", "source_id")}
      `)
		.all() as Array<{
		source_table: string;
		source_id: number;
		embedding: Buffer;
	}>;

	const out: Array<{ source_table: string; source_id: number; similarity: number }> = [];
	for (const row of embeddings) {
		const similarity = cosineSimilarity(queryEmbedding, blobToEmbedding(row.embedding));
		out.push({ source_table: row.source_table, source_id: row.source_id, similarity });
	}
	out.sort((a, b) => b.similarity - a.similarity);
	return out.slice(0, limit * 2);
}

/**
 * Vector search with the sqlite-vec fast tier and a brute-force fallback (#148).
 * vec0 uses cosine distance, so nearest == most similar — the same ordering the
 * brute-force cosineSimilarity sort produces. On any vec failure (e.g. the
 * extension absent or a stale dimension), falls back to brute-force.
 */
function vectorSearch(
	db: ReturnType<typeof getDb>,
	queryEmbedding: number[],
	limit: number,
): Array<{ source_table: string; source_id: number; similarity: number }> {
	if (isVecAvailable()) {
		try {
			ensureVecIndexSynced(db); // once per process, cached — never per query
			return knnSearch(db, queryEmbedding, limit * 2).map((h) => ({
				source_table: h.source_table,
				source_id: h.source_id,
				similarity: 1 - h.distance,
			}));
		} catch {
			// vec query failed — fall back to the brute-force scan.
		}
	}
	return bruteForceVectorScan(db, queryEmbedding, limit);
}

/**
 * Hybrid search combining FTS5 + vector embeddings with RRF fusion
 * Used by context_for_agent and memory_hybrid_search
 */
export async function hybridSearch(
	query: string,
	options: { project?: string; limit?: number },
): Promise<{
	results: Array<{
		table: string;
		id: number;
		content: string;
		score: number;
		source: "fts" | "vec" | "both";
		provenance: Provenance | null;
	}>;
	embeddingsAvailable: boolean;
}> {
	const db = getDb();
	const limit = options.limit || 10;

	// 1. FTS5 keyword search
	const ftsResults = search(query, {
		project: options.project,
		limit: limit * 2,
	});

	// 2. Try semantic search (graceful degradation if unavailable)
	let semanticResults: Array<{
		source_table: string;
		source_id: number;
		similarity: number;
	}> = [];
	let embeddingsAvailable = false;

	try {
		// #150: cache the Ollama liveness check (30s TTL) so it isn't an HTTP
		// round-trip on every query. A stale "available" is self-correcting — the
		// embed() below throws and the catch falls back to FTS-only.
		const serviceStatus = await checkEmbeddingServiceCached();
		if (serviceStatus.available) {
			embeddingsAvailable = true;

			// #149: cache the query embedding in-process so a repeated query in
			// this long-lived server skips the Ollama embed call. Keyed on
			// (query, model tag, dims) — a model change can never serve a stale hit.
			const queryResult = await embedQueryCached(query);
			// Fast tier: sqlite-vec native KNN when the extension loaded (#148);
			// otherwise the brute-force cosine scan. Both exclude recall-dedup
			// marked duplicates and return the top limit*2 in the same order.
			semanticResults = vectorSearch(db, queryResult.embedding, limit);
		}
	} catch {
		// Embedding service unavailable - continue with FTS only
	}

	// 3. Apply RRF fusion if we have both
	if (semanticResults.length > 0) {
		const ftsRanked = ftsResults.map((r) => ({
			id: `${r.table === "loa" ? "loa_entries" : r.table}:${r.id}`,
			content: r.content,
		}));

		const semanticRanked = semanticResults.map((r) => ({
			id: `${r.source_table}:${r.source_id}`,
		}));

		const fusedScores = reciprocalRankFusion([ftsRanked, semanticRanked]);

		// Build result set with source tracking
		const resultMap = new Map<
			string,
			{
				table: string;
				id: number;
				content: string;
				score: number;
				source: "fts" | "vec" | "both";
				provenance: Provenance | null;
			}
		>();

		for (const r of ftsResults) {
			const key = `${r.table === "loa" ? "loa_entries" : r.table}:${r.id}`;
			const score = fusedScores.get(key) || 0;
			resultMap.set(key, {
				table: r.table,
				id: r.id,
				content: r.content,
				score,
				source: "fts",
				provenance: r.provenance ?? null,
			});
		}

		for (const r of semanticResults) {
			const key = `${r.source_table}:${r.source_id}`;
			const existing = resultMap.get(key);
			if (existing) {
				existing.source = "both";
			} else {
				// Resolve content + provenance for a vector-only match. The
				// shared helper covers every embedded table — issue #67: the
				// learnings case was missing here, so vector-only learnings
				// matches reported provenance as unknown.
				const { content, provenance } = vectorRowContentProvenance(
					r.source_table,
					r.source_id,
				);

				resultMap.set(key, {
					table: r.source_table === "loa_entries" ? "loa" : r.source_table,
					id: r.source_id,
					content,
					score: fusedScores.get(key) || 0,
					source: "vec",
					provenance,
				});
			}
		}

		const results = Array.from(resultMap.values())
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);

		// Bump-on-use (issue #153): only the final returned set, never the
		// limit*2 candidate pool that fed search() above.
		bumpAccess(results);
		return { results, embeddingsAvailable };
	}

	// FTS only fallback
	const ftsOnly = ftsResults
		.map((r) => ({
			table: r.table,
			id: r.id,
			content: r.content,
			score: r.rank || 0,
			source: "fts" as const,
			provenance: r.provenance ?? null,
		}))
		.slice(0, limit);

	// Bump-on-use (issue #153): only the final returned set.
	bumpAccess(ftsOnly);
	return { results: ftsOnly, embeddingsAvailable: false };
}

// Ensure DB exists
const dbPath = getDbPath();
if (!existsSync(dbPath)) {
	initDb();
}

// Embedding model+dims marker check (issue #107) — run ONCE here at process
// start (this long-lived server is the hot query path) and cache for the
// process lifetime. Never re-checked per query/turn. A stale marker only logs
// a hint to stderr (stdout is the MCP protocol channel); semantic search
// already degrades to FTS5 on a dimension mismatch, so this never blocks.
try {
	if (isRebackfillNeeded(getDb())) {
		const { model, dimensions } = expectedEmbeddingMarker();
		process.stderr.write(
			`[recall] Embedding marker is stale — run 'recall embed rebackfill' to re-embed at ${model} (${dimensions}d). ` +
				`Semantic search falls back to FTS5 until then.\n`,
		);
	}
} catch {
	// Never block server startup on the marker check.
}

// Sync the sqlite-vec index from the canonical embeddings ONCE at process start
// (#148) — rebuilds only if out of sync (e.g. first run after a re-backfill).
// Cached for the process lifetime; never rebuilt per query. No-op when the
// extension is unavailable. Never blocks startup.
try {
	ensureVecIndexSynced(getDb());
} catch {
	// Brute-force scan remains available if the index can't be synced.
}

const server = new McpServer({
	name: "recall-memory",
	version: VERSION,
});

// Tool: memory_search - Full-text search across all memory
server.tool(
	"memory_search",
	"Search memory using FTS5 full-text search. Use this BEFORE asking the user to repeat anything. Searches across messages, LoA entries, decisions, learnings, and breadcrumbs.",
	{
		query: z
			.string()
			.describe(
				'Search query (keywords, phrases). FTS5 supports AND, OR, NOT, prefix*, "exact phrase"',
			),
		project: z.string().optional().describe("Filter by project name"),
		table: z
			.enum(SEARCH_TABLES)
			.optional()
			.describe("Hard-filter search to a specific table"),
		bias_type: z
			.enum(SEARCH_TABLES)
			.optional()
			.describe(
				"Soft ranking bias for a record type. Matching records get a ranking boost but other types can still be returned; use table for hard filtering.",
			),
		limit: z.number().default(10).describe("Max results to return"),
	},
	async ({ query, project, table, bias_type, limit }) => {
		try {
			const results = search(query, { project, table, biasType: bias_type, limit });

			// Zero keyword hits on a GLOBAL query: retry via hybrid/semantic search
			// so a phrasing mismatch never silently returns nothing (#39). A hard
			// `table` filter is respected — narrowing means the honest empty result.
			if (shouldFallbackToHybrid(results.length, table)) {
				const { results: hybridResults } = await hybridSearch(query, {
					project,
					limit,
				});
				const outcome = buildHybridFallbackOutcome(query, hybridResults);
				logMemoryUsage(outcome.logTool, query, outcome.logCount, project);
				return { content: [{ type: "text", text: outcome.text }] };
			}

			// Keyword hits, or a table-filtered empty result: one honest log line.
			logMemoryUsage("memory_search", query, results.length, project);

			if (results.length === 0) {
				return {
					content: [{ type: "text", text: `No results found for: "${query}"` }],
				};
			}

			// Bump-on-use (issue #153): these keyword hits are surfaced to the
			// agent. The fallback path above returns hybridSearch results, which
			// are bumped inside hybridSearch — so this only covers the direct path.
			bumpAccess(results);

			const formatted = results
				.map((r) => {
					const preview =
						r.content.length > 200
							? r.content.slice(0, 200) + "..."
							: r.content;
					return `[${r.table}#${r.id}] ${r.project || "no-project"} | ${r.created_at} | ${provenanceLabel(r.provenance)}\n${preview}`;
				})
				.join("\n\n---\n\n");

			return {
				content: [
					{
						type: "text",
						text: `Found ${results.length} results for "${query}":\n\n${formatted}`,
					},
				],
			};
		} catch (err) {
			return {
				content: [
					{
						type: "text",
						text: `Search error: ${err instanceof Error ? err.message : String(err)}`,
					},
				],
				isError: true,
			};
		}
	},
);

// Tool: memory_hybrid_search - Semantic + keyword search with RRF fusion
server.tool(
	"memory_hybrid_search",
	"Hybrid search combining keywords (FTS5) and semantics (embeddings) with Reciprocal Rank Fusion. Best for natural language queries. Falls back to keyword-only if embeddings unavailable.",
	{
		query: z.string().describe("Natural language search query"),
		project: z.string().optional().describe("Filter by project name"),
		limit: z.number().default(10).describe("Max results to return"),
	},
	async ({ query, project, limit }) => {
		try {
			const { results, embeddingsAvailable } = await hybridSearch(query, {
				project,
				limit,
			});

			// Log memory usage for metrics
			logMemoryUsage("memory_hybrid_search", query, results.length, project);

			if (results.length === 0) {
				return {
					content: [{ type: "text", text: `No results found for: "${query}"` }],
				};
			}

			const modeNote = embeddingsAvailable
				? "(hybrid: FTS5 + embeddings)"
				: "(keyword-only: embeddings unavailable)";

			const formatted = results
				.map((r) => {
					const sourceTag =
						r.source === "both"
							? "[FTS+VEC]"
							: r.source === "vec"
								? "[VEC]"
								: "[FTS]";
					const preview =
						r.content.length > 200
							? r.content.slice(0, 200) + "..."
							: r.content;
					const score = (r.score * 100).toFixed(1);
					return `${score}% ${sourceTag} [${r.table}#${r.id}] | ${provenanceLabel(r.provenance)}\n${preview}`;
				})
				.join("\n\n---\n\n");

			return {
				content: [
					{
						type: "text",
						text: `Found ${results.length} results ${modeNote}:\n\n${formatted}`,
					},
				],
			};
		} catch (err) {
			return {
				content: [
					{
						type: "text",
						text: `Hybrid search error: ${err instanceof Error ? err.message : String(err)}`,
					},
				],
				isError: true,
			};
		}
	},
);

// Tool: memory_recall - Get recent context
server.tool(
	"memory_recall",
	"Recall recent memory entries. Use at session start or when context is needed. Returns recent LoA entries, decisions, and breadcrumbs.",
	{
		limit: z
			.number()
			.default(5)
			.describe("Number of recent entries per category"),
		project: z.string().optional().describe("Filter by project name"),
	},
	async ({ limit, project }) => {
		try {
			const loa = recentLoaEntries(limit, project);
			const decisions = recentDecisions(limit, project);
			const breadcrumbs = recentBreadcrumbs(limit, project);

			let output = "## Recent Memory Context\n\n";

			if (loa.length > 0) {
				output += "### Library of Alexandria (Curated Knowledge)\n";
				for (const e of loa) {
					const preview = e.fabric_extract.slice(0, 300).replace(/\n/g, " ");
					output += `- **LoA #${e.id}** [${e.project || "no-project"}] ${e.created_at?.split("T")[0]} (${provenanceLabel(e.provenance)}): ${e.title}\n  ${preview}...\n`;
				}
				output += "\n";
			}

			if (decisions.length > 0) {
				output += "### Recent Decisions\n";
				for (const d of decisions) {
					output += `- **#${d.id}** [${d.project || "no-project"}] (${provenanceLabel(d.provenance)}): ${d.decision}${d.reasoning ? ` (${d.reasoning})` : ""}\n`;
				}
				output += "\n";
			}

			if (breadcrumbs.length > 0) {
				output += "### Breadcrumbs\n";
				for (const b of breadcrumbs) {
					output += `- **#${b.id}** [${b.project || "no-project"}] (${provenanceLabel(b.provenance)}): ${b.content}\n`;
				}
				output += "\n";
			}

			if (
				loa.length === 0 &&
				decisions.length === 0 &&
				breadcrumbs.length === 0
			) {
				output += "No recent memory entries found.\n";
			}

			return {
				content: [{ type: "text", text: output }],
			};
		} catch (err) {
			return {
				content: [
					{
						type: "text",
						text: `Recall error: ${err instanceof Error ? err.message : String(err)}`,
					},
				],
				isError: true,
			};
		}
	},
);

// Tool: loa_show - Show full LoA entry
server.tool(
	"loa_show",
	"Show a full Library of Alexandria entry with its Fabric extract_wisdom content.",
	{
		id: z.number().describe("LoA entry ID"),
	},
	async ({ id }) => {
		try {
			const loa = getLoaEntry(id);

			if (!loa) {
				return {
					content: [{ type: "text", text: `LoA #${id} not found` }],
					isError: true,
				};
			}

			const output = `# LoA #${loa.id}: ${loa.title}

**Created:** ${loa.created_at}
**Project:** ${loa.project || "N/A"}
**Messages:** ${loa.message_count || 0} (IDs ${loa.message_range_start}-${loa.message_range_end})
${loa.parent_loa_id ? `**Continues:** LoA #${loa.parent_loa_id}` : ""}
${loa.tags ? `**Tags:** ${loa.tags}` : ""}

## Fabric Extract

${loa.fabric_extract}`;

			return {
				content: [{ type: "text", text: output }],
			};
		} catch (err) {
			return {
				content: [
					{
						type: "text",
						text: `Error: ${err instanceof Error ? err.message : String(err)}`,
					},
				],
				isError: true,
			};
		}
	},
);

// Tool: memory_add - Add structured memory records
server.tool(
	"memory_add",
	"Add a structured memory record (decision, learning, or breadcrumb). Use to capture important context during sessions.",
	{
		type: z
			.enum(["decision", "learning", "breadcrumb"])
			.describe("Type of record to add"),
		content: z
			.string()
			.min(1, "Content cannot be empty")
			.describe(
				"Main content (decision text, problem description, or breadcrumb note)",
			),
		detail: z
			.string()
			.optional()
			.describe(
				"Additional detail (reasoning for decisions, solution for learnings)",
			),
		project: z.string().optional().describe("Project name"),
		tags: z
			.string()
			.optional()
			.describe("Comma-separated tags (for learnings)"),
		confidence: z
			.enum(["high", "medium", "low"])
			.optional()
			.describe("Confidence level (for decisions and learnings). HIGH=explicit/discussed, MEDIUM=implied/reasonable, LOW=speculative/uncertain"),
		importance: z
			.number()
			.int()
			.min(1)
			.max(10)
			.optional()
			.describe("Importance 1-10 (default: 5). Used by tiered RecallStart to rank L1 records. Set 8-10 for explicit user decisions/preferences, 2-3 for routine context."),
	},
	async ({ type, content, detail, project, tags, confidence, importance }) => {
		try {
			let id: number;

			switch (type) {
				case "decision": {
					// Check for similar active decisions to auto-supersede
					const similar = findSimilarDecisions(content, 3);
					const superseded: number[] = [];

					for (const existing of similar) {
						const existingWords = new Set(existing.decision.toLowerCase().split(/\s+/).filter(w => w.length > 4));
						const newWords = content.toLowerCase().split(/\s+/).filter(w => w.length > 4);
						const overlap = newWords.filter(w => existingWords.has(w)).length;
						if (overlap >= 3 && existingWords.size > 0) {
							supersedeDecision(existing.id!);
							superseded.push(existing.id!);
						}
					}

					// ADR-0001: provenance is stamped from the write path. memory_add
					// deliberately exposes no provenance parameter — agents must not
					// be able to launder extracted content as something else.
					id = addDecision({
						decision: content,
						reasoning: detail,
						project,
						status: "active",
						confidence: confidence || "medium",
						importance,
						provenance: "user_authored",
					});

					let resultText = `Added decision #${id}: ${content}`;
					if (superseded.length > 0) {
						resultText += ` (superseded decision(s) #${superseded.join(', #')})`;
					}
					return {
						content: [
							{ type: "text", text: resultText },
						],
					};
				}

				case "learning":
					id = addLearning({
						problem: content,
						solution: detail,
						project,
						tags,
						confidence: confidence || "medium",
						importance,
						provenance: "user_authored",
					});
					return {
						content: [
							{ type: "text", text: `Added learning #${id}: ${content}` },
						],
					};

				case "breadcrumb":
					id = addBreadcrumb({
						content,
						project,
						importance: importance ?? 5,
						provenance: "user_authored",
					});
					return {
						content: [
							{ type: "text", text: `Added breadcrumb #${id}: ${content}` },
						],
					};
			}
		} catch (err) {
			return {
				content: [
					{
						type: "text",
						text: `Add error: ${err instanceof Error ? err.message : String(err)}`,
					},
				],
				isError: true,
			};
		}
	},
);

// Tool: decision_update - Change decision status (supersede or revert)
server.tool(
	"decision_update",
	"Update a decision's lifecycle status. Use 'supersede' when a newer decision replaces an older one. Use 'revert' when a decision was wrong and rolled back. Only active decisions can be transitioned.",
	{
		id: z.number().describe("The decision ID to update"),
		action: z
			.enum(["supersede", "revert"])
			.describe("The lifecycle action: 'supersede' (replaced by newer) or 'revert' (was wrong)"),
	},
	async ({ id, action }) => {
		try {
			const decision = getDecision(id);
			if (!decision) {
				return {
					content: [{ type: "text", text: `Decision #${id} not found` }],
					isError: true,
				};
			}

			if (decision.status !== "active") {
				return {
					content: [
						{
							type: "text",
							text: `Decision #${id} is already ${decision.status} — only active decisions can be transitioned`,
						},
					],
					isError: true,
				};
			}

			const changes =
				action === "supersede"
					? supersedeDecision(id)
					: revertDecision(id);

			if (changes > 0) {
				return {
					content: [
						{
							type: "text",
							text: `Decision #${id} marked as ${action === "supersede" ? "superseded" : "reverted"}: ${decision.decision}`,
						},
					],
				};
			}

			return {
				content: [
					{ type: "text", text: `Failed to update decision #${id}` },
				],
				isError: true,
			};
		} catch (err) {
			return {
				content: [
					{
						type: "text",
						text: `Decision update error: ${err instanceof Error ? err.message : String(err)}`,
					},
				],
				isError: true,
			};
		}
	},
);

// Tool: memory_dump - Dump current session to SQLite
server.tool(
	"memory_dump",
	"Dump the current conversation session into SQLite for immediate searchability. Works across Claude Code, OpenCode, and Pi. Use when the user says /dump or you need to persist the current session mid-conversation. Messages are immediately searchable via memory_search after dumping.",
	{
		title: z
			.string()
			.min(1)
			.describe("Descriptive title for this session dump"),
		project: z
			.string()
			.optional()
			.describe("Override project name"),
		skip_fabric: z
			.boolean()
			.default(true)
			.describe(
				"Skip Fabric extract_wisdom (faster, uses basic summary). Default: true for speed.",
			),
	},
	async ({ title, project, skip_fabric }) => {
		try {
			const { coreDump } = await import("./commands/dump.js");

			const result = await coreDump(title, {
				project,
				skipFabric: skip_fabric,
			});

			// Log memory usage
			logMemoryUsage("memory_dump", title, result.messageCount, project);

			if (!result.success) {
				return {
					content: [
						{
							type: "text",
							text: `Dump failed: ${result.error}`,
						},
					],
					isError: true,
				};
			}

			let output = `✓ Session dumped to SQLite\n\n`;
			output += `- **Source:** ${result.source}\n`;
			output += `- **Session ID:** ${result.sessionId}\n`;
			output += `- **Messages:** ${result.messageCount}\n`;
			if (result.loaId) {
				output += `- **LoA Entry:** #${result.loaId}\n`;
			}
			output += `\nMessages are now searchable via \`memory_search\`.`;

			return {
				content: [{ type: "text", text: output }],
			};
		} catch (err) {
			return {
				content: [
					{
						type: "text",
						text: `Dump error: ${err instanceof Error ? err.message : String(err)}`,
					},
				],
				isError: true,
			};
		}
	},
);

// Tool: memory_stats - Database statistics
server.tool("memory_stats", "Get RECALL database statistics.", {}, async () => {
	try {
		const stats = getStats();
		const sizeMB = (stats.db_size_bytes / 1024 / 1024).toFixed(2);

		const output = `## RECALL ${VERSION} Stats

| Metric | Count |
|--------|-------|
| Sessions | ${stats.sessions} |
| Messages | ${stats.messages.toLocaleString()} |
| LoA Entries | ${stats.loa_entries} |
| Decisions | ${stats.decisions} |
| Learnings | ${stats.learnings} |
| Breadcrumbs | ${stats.breadcrumbs} |
| **Database Size** | ${sizeMB} MB |`;

		return {
			content: [{ type: "text", text: output }],
		};
	} catch (err) {
		return {
			content: [
				{
					type: "text",
					text: `Stats error: ${err instanceof Error ? err.message : String(err)}`,
				},
			],
			isError: true,
		};
	}
});

// Tool: context_for_agent - Prepare context before spawning agents
// Uses HYBRID search (FTS5 + embeddings) for best context retrieval
server.tool(
	"context_for_agent",
	"Prepare rich context before spawning any agent via Task tool. Uses hybrid search (keywords + semantics) to find relevant memory. Returns context to include in agent prompt.",
	{
		agent_task: z
			.string()
			.describe("The task/prompt you plan to give the agent"),
		project: z
			.string()
			.optional()
			.describe("Current project name for filtering"),
	},
	async ({ agent_task, project }) => {
		try {
			// Use hybrid search for best context retrieval
			const { results: hybridResults, embeddingsAvailable } =
				await hybridSearch(agent_task, { project, limit: 5 });

			// Log memory usage for metrics (pre-agent context is important to track)
			logMemoryUsage(
				"context_for_agent",
				agent_task,
				hybridResults.length,
				project,
			);

			// Check for recent LoA entries
			const recentLoa = recentLoaEntries(3, project);

			// Check for relevant decisions
			const decisions = recentDecisions(3, project);

			// Determine if Brave search is recommended
			const needsBrave = detectBraveNeed(agent_task, hybridResults.length);

			// Build context output
			const searchMode = embeddingsAvailable
				? "hybrid (keywords + semantics)"
				: "keyword-only";
			let output = `## Agent Context (INCLUDE IN AGENT PROMPT)\n\n`;
			output += `**Search Mode:** ${searchMode}\n\n`;

			if (hybridResults.length > 0) {
				output += `### Relevant Memory (${hybridResults.length} matches)\n`;
				for (const r of hybridResults) {
					const sourceTag =
						r.source === "both" ? "★" : r.source === "vec" ? "~" : "";
					const preview =
						r.content.length > 150
							? r.content.slice(0, 150) + "..."
							: r.content;
					output += `- ${sourceTag}[${r.table}#${r.id}] ${preview}\n`;
				}
				output +=
					"\n_Legend: ★ = found by both keyword+semantic, ~ = semantic only_\n\n";
			} else {
				output += `### No relevant memory found\n\n`;
			}

			if (recentLoa.length > 0) {
				output += `### Recent Session Knowledge\n`;
				for (const e of recentLoa) {
					output += `- LoA #${e.id}: ${e.title} (${e.created_at?.split("T")[0]})\n`;
				}
				output += "\n";
			}

			if (decisions.length > 0) {
				output += `### Active Decisions\n`;
				for (const d of decisions) {
					output += `- ${d.decision}\n`;
				}
				output += "\n";
			}

			// Brave recommendation
			output += `---\n\n`;
			if (needsBrave.recommend) {
				output += `⚠️ **BRAVE SEARCH RECOMMENDED:** ${needsBrave.reason}\n`;
				output += `Suggested query: \`${needsBrave.suggestedQuery}\`\n`;
				output += `Call \`mcp__brave-search__brave_web_search\` and add results to agent context.\n`;
			} else {
				output += `✓ Local memory sufficient. Brave search not needed.\n`;
			}

			return {
				content: [{ type: "text", text: output }],
			};
		} catch (err) {
			return {
				content: [
					{
						type: "text",
						text: `Context error: ${err instanceof Error ? err.message : String(err)}`,
					},
				],
				isError: true,
			};
		}
	},
);

/**
 * Detect if Brave web search is needed
 */
function detectBraveNeed(
	task: string,
	localResultCount: number,
): { recommend: boolean; reason: string; suggestedQuery: string } {
	const taskLower = task.toLowerCase();

	// Time-sensitive indicators
	const timeIndicators = [
		"latest",
		"current",
		"recent",
		"new",
		"2025",
		"2026",
		"today",
		"now",
		"updated",
	];
	const hasTimeIndicator = timeIndicators.some((t) => taskLower.includes(t));

	// External knowledge indicators
	const externalIndicators = [
		"documentation",
		"docs",
		"api",
		"how to",
		"best practice",
		"example",
		"tutorial",
		"guide",
		"official",
		"release",
		"version",
		"library",
		"package",
		"framework",
	];
	const needsExternal = externalIndicators.some((t) => taskLower.includes(t));

	// No local results
	const noLocalContext = localResultCount === 0;

	// Extract main topic for suggested query
	const topicMatch = task.match(
		/(?:about|for|with|using|implement|create|build|fix|debug|research|find|get|fetch)\s+(.+?)(?:\.|$)/i,
	);
	const suggestedQuery = topicMatch ? topicMatch[1].trim() : task.slice(0, 50);

	if (hasTimeIndicator) {
		return {
			recommend: true,
			reason: "Task mentions time-sensitive information",
			suggestedQuery: `${suggestedQuery} 2026`,
		};
	}

	if (needsExternal) {
		return {
			recommend: true,
			reason: "Task requires external documentation/knowledge",
			suggestedQuery,
		};
	}

	if (noLocalContext) {
		return {
			recommend: true,
			reason: "No relevant local memory found",
			suggestedQuery,
		};
	}

	return { recommend: false, reason: "", suggestedQuery: "" };
}

// Start server
async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error("RECALL MCP server running");
}

// Only launch the stdio server when this module is the process entrypoint
// (true for the `recall-mcp` bin → dist/mcp-server.js). When imported — e.g.
// by a test driving the exported `hybridSearch` — `import.meta.main` is false,
// so importing the module never starts a server. (#115)
if (import.meta.main) {
	main().catch(console.error);
}
