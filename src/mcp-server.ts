#!/usr/bin/env node

// LMF 4.0 - MCP Server
// Exposes memory as first-class tools for Claude Code

import { appendFileSync, existsSync as fsExistsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Memory usage logging for metrics and enforcement tracking
 * Logs: timestamp, tool, query, results_count, project
 */
const LOG_DIR = join(homedir(), '.claude', 'logs');
const MEMORY_LOG = join(LOG_DIR, 'memory-usage.jsonl');

function logMemoryUsage(tool: string, query: string, resultsCount: number, project?: string): void {
  try {
    if (!fsExistsSync(LOG_DIR)) {
      mkdirSync(LOG_DIR, { recursive: true });
    }
    const entry = {
      timestamp: new Date().toISOString(),
      tool,
      query: query.slice(0, 200), // Truncate long queries
      results_count: resultsCount,
      project: project || null
    };
    appendFileSync(MEMORY_LOG, JSON.stringify(entry) + '\n');
  } catch {
    // Silently fail - logging shouldn't break memory operations
  }
}
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getDb, initDb, getDbPath } from './db/connection.js';
import {
  search,
  recentMessages,
  recentDecisions,
  recentLearnings,
  recentBreadcrumbs,
  recentLoaEntries,
  getLoaEntry,
  addDecision,
  addLearning,
  addBreadcrumb,
  getStats
} from './lib/memory.js';
import {
  embed,
  blobToEmbedding,
  cosineSimilarity,
  reciprocalRankFusion,
  checkEmbeddingService
} from './lib/embeddings.js';
import { existsSync } from 'fs';

/**
 * Hybrid search combining FTS5 + vector embeddings with RRF fusion
 * Used by context_for_agent and memory_hybrid_search
 */
async function hybridSearch(query: string, options: { project?: string; limit?: number }): Promise<{
  results: Array<{ table: string; id: number; content: string; score: number; source: 'fts' | 'vec' | 'both' }>;
  embeddingsAvailable: boolean;
}> {
  const db = getDb();
  const limit = options.limit || 10;

  // 1. FTS5 keyword search
  const ftsResults = search(query, { project: options.project, limit: limit * 2 });

  // 2. Try semantic search (graceful degradation if unavailable)
  let semanticResults: Array<{ source_table: string; source_id: number; similarity: number }> = [];
  let embeddingsAvailable = false;

  try {
    const serviceStatus = await checkEmbeddingService();
    if (serviceStatus.available) {
      embeddingsAvailable = true;

      const queryResult = await embed(query);
      const queryEmbedding = queryResult.embedding;

      const embeddings = db.prepare(`
        SELECT source_table, source_id, embedding FROM embeddings
      `).all() as Array<{ source_table: string; source_id: number; embedding: Buffer }>;

      for (const row of embeddings) {
        const embedding = blobToEmbedding(row.embedding);
        const similarity = cosineSimilarity(queryEmbedding, embedding);
        semanticResults.push({
          source_table: row.source_table,
          source_id: row.source_id,
          similarity
        });
      }

      semanticResults.sort((a, b) => b.similarity - a.similarity);
      semanticResults = semanticResults.slice(0, limit * 2);
    }
  } catch {
    // Embedding service unavailable - continue with FTS only
  }

  // 3. Apply RRF fusion if we have both
  if (semanticResults.length > 0) {
    const ftsRanked = ftsResults.map(r => ({
      id: `${r.table === 'loa' ? 'loa_entries' : r.table}:${r.id}`,
      content: r.content
    }));

    const semanticRanked = semanticResults.map(r => ({
      id: `${r.source_table}:${r.source_id}`
    }));

    const fusedScores = reciprocalRankFusion([ftsRanked, semanticRanked]);

    // Build result set with source tracking
    const resultMap = new Map<string, { table: string; id: number; content: string; score: number; source: 'fts' | 'vec' | 'both' }>();

    for (const r of ftsResults) {
      const key = `${r.table === 'loa' ? 'loa_entries' : r.table}:${r.id}`;
      const score = fusedScores.get(key) || 0;
      resultMap.set(key, {
        table: r.table,
        id: r.id,
        content: r.content,
        score,
        source: 'fts'
      });
    }

    for (const r of semanticResults) {
      const key = `${r.source_table}:${r.source_id}`;
      const existing = resultMap.get(key);
      if (existing) {
        existing.source = 'both';
      } else {
        // Need to fetch content
        let content = '';
        if (r.source_table === 'loa_entries') {
          const loa = db.prepare('SELECT title, fabric_extract FROM loa_entries WHERE id = ?').get(r.source_id) as any;
          content = loa ? `${loa.title}: ${loa.fabric_extract?.slice(0, 200)}` : '';
        } else if (r.source_table === 'decisions') {
          const dec = db.prepare('SELECT decision FROM decisions WHERE id = ?').get(r.source_id) as any;
          content = dec?.decision || '';
        } else if (r.source_table === 'messages') {
          const msg = db.prepare('SELECT content FROM messages WHERE id = ?').get(r.source_id) as any;
          content = msg?.content?.slice(0, 200) || '';
        }

        resultMap.set(key, {
          table: r.source_table === 'loa_entries' ? 'loa' : r.source_table,
          id: r.source_id,
          content,
          score: fusedScores.get(key) || 0,
          source: 'vec'
        });
      }
    }

    const results = Array.from(resultMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return { results, embeddingsAvailable };
  }

  // FTS only fallback
  return {
    results: ftsResults.map(r => ({
      table: r.table,
      id: r.id,
      content: r.content,
      score: r.rank || 0,
      source: 'fts' as const
    })).slice(0, limit),
    embeddingsAvailable: false
  };
}

// Ensure DB exists
const dbPath = getDbPath();
if (!existsSync(dbPath)) {
  initDb();
}

const server = new McpServer({
  name: 'lmf-memory',
  version: '4.0.0'
});

// Tool: memory_search - Full-text search across all memory
server.tool(
  'memory_search',
  'Search memory using FTS5 full-text search. Use this BEFORE asking the user to repeat anything. Searches across messages, LoA entries, decisions, learnings, and breadcrumbs.',
  {
    query: z.string().describe('Search query (keywords, phrases). FTS5 supports AND, OR, NOT, prefix*, "exact phrase"'),
    project: z.string().optional().describe('Filter by project name'),
    table: z.enum(['messages', 'loa', 'decisions', 'learnings', 'breadcrumbs']).optional().describe('Search specific table only'),
    limit: z.number().default(10).describe('Max results to return')
  },
  async ({ query, project, table, limit }) => {
    try {
      const results = search(query, { project, table, limit });

      // Log memory usage for metrics
      logMemoryUsage('memory_search', query, results.length, project);

      if (results.length === 0) {
        return {
          content: [{ type: 'text', text: `No results found for: "${query}"` }]
        };
      }

      const formatted = results.map(r => {
        const preview = r.content.length > 200 ? r.content.slice(0, 200) + '...' : r.content;
        return `[${r.table}#${r.id}] ${r.project || 'no-project'} | ${r.created_at}\n${preview}`;
      }).join('\n\n---\n\n');

      return {
        content: [{ type: 'text', text: `Found ${results.length} results for "${query}":\n\n${formatted}` }]
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Search error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true
      };
    }
  }
);

// Tool: memory_hybrid_search - Semantic + keyword search with RRF fusion
server.tool(
  'memory_hybrid_search',
  'Hybrid search combining keywords (FTS5) and semantics (embeddings) with Reciprocal Rank Fusion. Best for natural language queries. Falls back to keyword-only if embeddings unavailable.',
  {
    query: z.string().describe('Natural language search query'),
    project: z.string().optional().describe('Filter by project name'),
    limit: z.number().default(10).describe('Max results to return')
  },
  async ({ query, project, limit }) => {
    try {
      const { results, embeddingsAvailable } = await hybridSearch(query, { project, limit });

      // Log memory usage for metrics
      logMemoryUsage('memory_hybrid_search', query, results.length, project);

      if (results.length === 0) {
        return {
          content: [{ type: 'text', text: `No results found for: "${query}"` }]
        };
      }

      const modeNote = embeddingsAvailable
        ? '(hybrid: FTS5 + embeddings)'
        : '(keyword-only: embeddings unavailable)';

      const formatted = results.map(r => {
        const sourceTag = r.source === 'both' ? '[FTS+VEC]' : r.source === 'vec' ? '[VEC]' : '[FTS]';
        const preview = r.content.length > 200 ? r.content.slice(0, 200) + '...' : r.content;
        const score = (r.score * 100).toFixed(1);
        return `${score}% ${sourceTag} [${r.table}#${r.id}]\n${preview}`;
      }).join('\n\n---\n\n');

      return {
        content: [{ type: 'text', text: `Found ${results.length} results ${modeNote}:\n\n${formatted}` }]
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Hybrid search error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true
      };
    }
  }
);

// Tool: memory_recall - Get recent context
server.tool(
  'memory_recall',
  'Recall recent memory entries. Use at session start or when context is needed. Returns recent LoA entries, decisions, and breadcrumbs.',
  {
    limit: z.number().default(5).describe('Number of recent entries per category'),
    project: z.string().optional().describe('Filter by project name')
  },
  async ({ limit, project }) => {
    try {
      const loa = recentLoaEntries(limit, project);
      const decisions = recentDecisions(limit, project);
      const breadcrumbs = recentBreadcrumbs(limit, project);

      let output = '## Recent Memory Context\n\n';

      if (loa.length > 0) {
        output += '### Library of Alexandria (Curated Knowledge)\n';
        for (const e of loa) {
          const preview = e.fabric_extract.slice(0, 300).replace(/\n/g, ' ');
          output += `- **LoA #${e.id}** [${e.project || 'no-project'}] ${e.created_at?.split('T')[0]}: ${e.title}\n  ${preview}...\n`;
        }
        output += '\n';
      }

      if (decisions.length > 0) {
        output += '### Recent Decisions\n';
        for (const d of decisions) {
          output += `- **#${d.id}** [${d.project || 'no-project'}]: ${d.decision}${d.reasoning ? ` (${d.reasoning})` : ''}\n`;
        }
        output += '\n';
      }

      if (breadcrumbs.length > 0) {
        output += '### Breadcrumbs\n';
        for (const b of breadcrumbs) {
          output += `- **#${b.id}** [${b.project || 'no-project'}]: ${b.content}\n`;
        }
        output += '\n';
      }

      if (loa.length === 0 && decisions.length === 0 && breadcrumbs.length === 0) {
        output += 'No recent memory entries found.\n';
      }

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Recall error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true
      };
    }
  }
);

// Tool: loa_show - Show full LoA entry
server.tool(
  'loa_show',
  'Show a full Library of Alexandria entry with its Fabric extract_wisdom content.',
  {
    id: z.number().describe('LoA entry ID')
  },
  async ({ id }) => {
    try {
      const loa = getLoaEntry(id);

      if (!loa) {
        return {
          content: [{ type: 'text', text: `LoA #${id} not found` }],
          isError: true
        };
      }

      const output = `# LoA #${loa.id}: ${loa.title}

**Created:** ${loa.created_at}
**Project:** ${loa.project || 'N/A'}
**Messages:** ${loa.message_count || 0} (IDs ${loa.message_range_start}-${loa.message_range_end})
${loa.parent_loa_id ? `**Continues:** LoA #${loa.parent_loa_id}` : ''}
${loa.tags ? `**Tags:** ${loa.tags}` : ''}

## Fabric Extract

${loa.fabric_extract}`;

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true
      };
    }
  }
);

// Tool: memory_add - Add structured memory records
server.tool(
  'memory_add',
  'Add a structured memory record (decision, learning, or breadcrumb). Use to capture important context during sessions.',
  {
    type: z.enum(['decision', 'learning', 'breadcrumb']).describe('Type of record to add'),
    content: z.string().min(1, 'Content cannot be empty').describe('Main content (decision text, problem description, or breadcrumb note)'),
    detail: z.string().optional().describe('Additional detail (reasoning for decisions, solution for learnings)'),
    project: z.string().optional().describe('Project name'),
    tags: z.string().optional().describe('Comma-separated tags (for learnings)')
  },
  async ({ type, content, detail, project, tags }) => {
    try {
      let id: number;

      switch (type) {
        case 'decision':
          id = addDecision({
            decision: content,
            reasoning: detail,
            project,
            status: 'active'
          });
          return {
            content: [{ type: 'text', text: `Added decision #${id}: ${content}` }]
          };

        case 'learning':
          id = addLearning({
            problem: content,
            solution: detail,
            project,
            tags
          });
          return {
            content: [{ type: 'text', text: `Added learning #${id}: ${content}` }]
          };

        case 'breadcrumb':
          id = addBreadcrumb({
            content,
            project,
            importance: 5
          });
          return {
            content: [{ type: 'text', text: `Added breadcrumb #${id}: ${content}` }]
          };
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Add error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true
      };
    }
  }
);

// Tool: memory_stats - Database statistics
server.tool(
  'memory_stats',
  'Get LMF database statistics.',
  {},
  async () => {
    try {
      const stats = getStats();
      const sizeMB = (stats.db_size_bytes / 1024 / 1024).toFixed(2);

      const output = `## LMF 4.0 Stats

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
        content: [{ type: 'text', text: output }]
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Stats error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true
      };
    }
  }
);

// Tool: context_for_agent - Prepare context before spawning agents
// Uses HYBRID search (FTS5 + embeddings) for best context retrieval
server.tool(
  'context_for_agent',
  'Prepare rich context before spawning any agent via Task tool. Uses hybrid search (keywords + semantics) to find relevant memory. Returns context to include in agent prompt.',
  {
    agent_task: z.string().describe('The task/prompt you plan to give the agent'),
    project: z.string().optional().describe('Current project name for filtering')
  },
  async ({ agent_task, project }) => {
    try {
      // Use hybrid search for best context retrieval
      const { results: hybridResults, embeddingsAvailable } = await hybridSearch(agent_task, { project, limit: 5 });

      // Log memory usage for metrics (pre-agent context is important to track)
      logMemoryUsage('context_for_agent', agent_task, hybridResults.length, project);

      // Check for recent LoA entries
      const recentLoa = recentLoaEntries(3, project);

      // Check for relevant decisions
      const decisions = recentDecisions(3, project);

      // Determine if Brave search is recommended
      const needsBrave = detectBraveNeed(agent_task, hybridResults.length);

      // Build context output
      const searchMode = embeddingsAvailable ? 'hybrid (keywords + semantics)' : 'keyword-only';
      let output = `## Agent Context (INCLUDE IN AGENT PROMPT)\n\n`;
      output += `**Search Mode:** ${searchMode}\n\n`;

      if (hybridResults.length > 0) {
        output += `### Relevant Memory (${hybridResults.length} matches)\n`;
        for (const r of hybridResults) {
          const sourceTag = r.source === 'both' ? '★' : r.source === 'vec' ? '~' : '';
          const preview = r.content.length > 150 ? r.content.slice(0, 150) + '...' : r.content;
          output += `- ${sourceTag}[${r.table}#${r.id}] ${preview}\n`;
        }
        output += '\n_Legend: ★ = found by both keyword+semantic, ~ = semantic only_\n\n';
      } else {
        output += `### No relevant memory found\n\n`;
      }

      if (recentLoa.length > 0) {
        output += `### Recent Session Knowledge\n`;
        for (const e of recentLoa) {
          output += `- LoA #${e.id}: ${e.title} (${e.created_at?.split('T')[0]})\n`;
        }
        output += '\n';
      }

      if (decisions.length > 0) {
        output += `### Active Decisions\n`;
        for (const d of decisions) {
          output += `- ${d.decision}\n`;
        }
        output += '\n';
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
        content: [{ type: 'text', text: output }]
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Context error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true
      };
    }
  }
);

/**
 * Detect if Brave web search is needed
 */
function detectBraveNeed(task: string, localResultCount: number): { recommend: boolean; reason: string; suggestedQuery: string } {
  const taskLower = task.toLowerCase();

  // Time-sensitive indicators
  const timeIndicators = ['latest', 'current', 'recent', 'new', '2025', '2026', 'today', 'now', 'updated'];
  const hasTimeIndicator = timeIndicators.some(t => taskLower.includes(t));

  // External knowledge indicators
  const externalIndicators = ['documentation', 'docs', 'api', 'how to', 'best practice', 'example', 'tutorial', 'guide', 'official', 'release', 'version', 'library', 'package', 'framework'];
  const needsExternal = externalIndicators.some(t => taskLower.includes(t));

  // No local results
  const noLocalContext = localResultCount === 0;

  // Extract main topic for suggested query
  const topicMatch = task.match(/(?:about|for|with|using|implement|create|build|fix|debug|research|find|get|fetch)\s+(.+?)(?:\.|$)/i);
  const suggestedQuery = topicMatch ? topicMatch[1].trim() : task.slice(0, 50);

  if (hasTimeIndicator) {
    return { recommend: true, reason: 'Task mentions time-sensitive information', suggestedQuery: `${suggestedQuery} 2026` };
  }

  if (needsExternal) {
    return { recommend: true, reason: 'Task requires external documentation/knowledge', suggestedQuery };
  }

  if (noLocalContext) {
    return { recommend: true, reason: 'No relevant local memory found', suggestedQuery };
  }

  return { recommend: false, reason: '', suggestedQuery: '' };
}

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('LMF MCP server running');
}

main().catch(console.error);
