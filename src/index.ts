#!/usr/bin/env node

// RECALL - Persistent AI Memory System
// CLI entry point

import { Command } from 'commander';
import { VERSION, DISPLAY_NAME } from './version.js';
import { runInit } from './commands/init.js';
import { runAddBreadcrumb, runAddDecision, runAddLearning } from './commands/add.js';
import { runSearch } from './commands/search.js';
import { runRecent } from './commands/recent.js';
import { runShow } from './commands/show.js';
import { runStats } from './commands/stats.js';
import { runImport } from './commands/import.js';
import { runImportConversations } from './commands/import-conversations.js';
import { runLoa, runLoaQuote, runLoaShow, runLoaList } from './commands/loa.js';
import { runDump } from './commands/dump.js';
import { runImportLegacy } from './commands/import-legacy.js';
import { runImportTelos, runTelosList, runTelosShow, runTelosSearch } from './commands/import-telos.js';
import { runImportDocs, runDocsList, runDocsSearch, runDocsShow } from './commands/import-docs.js';
import { runSupersede, runRevert, runList as runDecisionList } from './commands/decision.js';
import { runPrune } from './commands/prune.js';
import { runCluster } from './commands/cluster.js';
import { runEmbedBackfill, runSemanticSearch, runEmbedStats, runHybridSearch } from './commands/embed.js';
import { runDoctor } from './commands/doctor.js';
import { runImportanceBackfill, runPin, runUnpin } from './commands/importance.js';
import { runProvenanceBackfill } from './commands/provenance.js';
import { runBenchmark, listBenchmarks, reportLatestBenchmark } from './commands/benchmark.js';
import { runOnboard } from './commands/onboard.js';
import { runMigrate } from './commands/migrate.js';
import { runPath } from './commands/path.js';
import { runExport } from './commands/export.js';
import { runDedup } from './commands/dedup.js';
import { runRepair } from './commands/repair.js';
import { DEFAULT_SEMANTIC_THRESHOLD } from './lib/dedup.js';
import { closeDb } from './db/connection.js';

const program = new Command();

program
  .name('recall')
  .description(`${DISPLAY_NAME} - Persistent AI Memory System`)
  .version(VERSION)
  .enablePositionalOptions();

// recall init
program
  .command('init')
  .description('Initialize the memory database')
  .action(() => {
    runInit();
    closeDb();
  });

// recall add breadcrumb
const addCmd = program
  .command('add')
  .description('Add a memory record');

addCmd
  .command('breadcrumb <content>')
  .description('Add a breadcrumb (context, note, reference)')
  .option('-p, --project <name>', 'Project name')
  .option('-c, --category <cat>', 'Category (context, note, todo, reference)')
  .option('-i, --importance <n>', 'Importance 1-10', '5')
  .action((content, options) => {
    runAddBreadcrumb(content, {
      project: options.project,
      category: options.category,
      importance: parseInt(options.importance, 10)
    });
    closeDb();
  });

addCmd
  .command('decision <decision>')
  .description('Record a decision')
  .option('-p, --project <name>', 'Project name')
  .option('-c, --category <cat>', 'Category (architecture, tooling, process)')
  .option('-w, --why <reasoning>', 'Why this decision was made')
  .option('-a, --alternatives <alt>', 'Alternatives considered')
  .option('--confidence <level>', 'Confidence level (high, medium, low)', 'medium')
  .action((decision, options) => {
    runAddDecision(decision, {
      project: options.project,
      category: options.category,
      why: options.why,
      alternatives: options.alternatives,
      confidence: options.confidence
    });
    closeDb();
  });

addCmd
  .command('learning <problem> <solution>')
  .description('Record a learning (problem + solution)')
  .option('-p, --project <name>', 'Project name')
  .option('-c, --category <cat>', 'Category (error, pattern, optimization)')
  .option('--prevention <text>', 'How to prevent in future')
  .option('-t, --tags <tags>', 'Comma-separated tags')
  .action((problem, solution, options) => {
    runAddLearning(problem, solution, {
      project: options.project,
      category: options.category,
      prevention: options.prevention,
      tags: options.tags
    });
    closeDb();
  });

// recall decision — lifecycle management
const decisionCmd = program
  .command('decision')
  .description('Decision lifecycle management (supersede, revert, list)');

decisionCmd
  .command('supersede <id>')
  .description('Mark a decision as superseded (replaced by a newer decision)')
  .action((id) => {
    runSupersede(parseInt(id, 10));
    closeDb();
  });

decisionCmd
  .command('revert <id>')
  .description('Mark a decision as reverted (was wrong, rolled back)')
  .action((id) => {
    runRevert(parseInt(id, 10));
    closeDb();
  });

decisionCmd
  .command('list')
  .description('List decisions with optional status filter')
  .option('-p, --project <name>', 'Filter by project')
  .option('-s, --status <status>', 'Filter by status (active, superseded, reverted)')
  .option('-l, --limit <n>', 'Max results', '20')
  .action((options) => {
    runDecisionList({
      project: options.project,
      status: options.status,
      limit: parseInt(options.limit, 10)
    });
    closeDb();
  });

// recall prune — table lifecycle management
program
  .command('prune')
  .description('Prune old/expired records (dry-run by default, --execute to delete)')
  .option('--execute', 'Actually delete rows (default is dry-run)')
  .option('--older-than <duration>', 'Retention period (e.g., 90d, 180d)', '180d')
  .option('--keep-decisions', 'Skip pruning inactive decisions')
  .action((options) => {
    runPrune({
      execute: options.execute,
      olderThan: options.olderThan,
      keepDecisions: options.keepDecisions
    });
    closeDb();
  });

// recall cluster — procedure detection from learnings
program
  .command('cluster')
  .description('Detect procedures from clustered learnings (dry-run by default)')
  .option('--execute', 'Synthesize and create procedure records')
  .option('--threshold <n>', 'Cosine similarity threshold (0-1)', '0.85')
  .action((options) => {
    runCluster({
      execute: options.execute,
      threshold: parseFloat(options.threshold)
    });
    closeDb();
  });

// recall search
program
  .command('search <query>')
  .description('Full-text search across all memory')
  .option('-p, --project <name>', 'Filter by project')
  .option('-t, --table <table>', 'Hard-filter to one table (messages, loa, decisions, learnings, breadcrumbs)')
  .option('--bias-type <table>', 'Softly boost one table without filtering others (messages, loa, decisions, learnings, breadcrumbs)')
  .option('-l, --limit <n>', 'Max results', '20')
  .option('--show-provenance', 'Show provenance for every result (default: only unknown provenance is flagged)')
  .option('--include-duplicates', 'Include records marked as duplicates by recall dedup (hidden by default)')
  .action((query, options) => {
    runSearch(query, {
      project: options.project,
      table: options.table,
      biasType: options.biasType,
      limit: parseInt(options.limit, 10),
      showProvenance: options.showProvenance,
      includeDuplicates: options.includeDuplicates
    });
    closeDb();
  });

// recall recent
program
  .command('recent [table]')
  .description('Show recent records (messages, decisions, learnings, breadcrumbs, all)')
  .option('-p, --project <name>', 'Filter by project')
  .option('-l, --limit <n>', 'Max results', '10')
  .action((table, options) => {
    runRecent(table, {
      project: options.project,
      limit: parseInt(options.limit, 10)
    });
    closeDb();
  });

// recall show
program
  .command('show <table> <id>')
  .description('Show full details of a record')
  .action((table, id) => {
    runShow(table, parseInt(id, 10));
    closeDb();
  });

// recall stats
program
  .command('stats')
  .description('Show database statistics')
  .action(() => {
    runStats();
    closeDb();
  });

// recall import
program
  .command('import')
  .description('Import conversations from Claude Code session files')
  .option('--dry-run', 'Preview what would be imported without making changes')
  .option('-v, --verbose', 'Show detailed progress')
  .option('-y, --yes', 'Confirm import (required to actually import)')
  .action((options) => {
    runImport({
      dryRun: options.dryRun,
      verbose: options.verbose,
      yes: options.yes
    });
    closeDb();
  });

// recall import-conversations
program
  .command('import-conversations <path>')
  .description('Import Claude.ai, ChatGPT, or Slack JSON conversation exports')
  .option('--format <format>', 'Format: auto, claude-ai, chatgpt, slack', 'auto')
  .option('--no-extract', 'Import raw messages only; skip Haiku extraction')
  .option('--dry-run', 'Preview what would be imported without making changes')
  .option('-v, --verbose', 'Show detailed progress')
  .option('-p, --project <name>', 'Override project name for imported records')
  .action(async (inputPath, options) => {
    await runImportConversations(inputPath, {
      format: options.format,
      noExtract: options.noExtract,
      dryRun: options.dryRun,
      verbose: options.verbose,
      project: options.project
    });
    closeDb();
  });

// recall loa - Library of Alexandria
const loaCmd = program
  .command('loa')
  .description('Library of Alexandria - curated knowledge capture');

loaCmd
  .command('write <title>')
  .description('Capture messages since last LoA entry with Fabric extract_wisdom')
  .option('-p, --project <name>', 'Project name')
  .option('-c, --continues <id>', 'Continue from a previous LoA entry')
  .option('-t, --tags <tags>', 'Comma-separated tags')
  .option('-n, --limit <n>', 'Max messages to process (default: all since last LoA)')
  .action(async (title, options) => {
    await runLoa(title, {
      project: options.project,
      continues: options.continues ? parseInt(options.continues, 10) : undefined,
      tags: options.tags,
      limit: options.limit ? parseInt(options.limit, 10) : undefined
    });
    closeDb();
  });

loaCmd
  .command('show <id>')
  .description('Show full LoA entry with Fabric extract')
  .action((id) => {
    runLoaShow(parseInt(id, 10));
    closeDb();
  });

loaCmd
  .command('quote <id>')
  .description('Show the raw source messages for an LoA entry')
  .action((id) => {
    runLoaQuote(parseInt(id, 10));
    closeDb();
  });

loaCmd
  .command('list')
  .description('List recent LoA entries')
  .option('-l, --limit <n>', 'Max entries', '10')
  .action((options) => {
    runLoaList(parseInt(options.limit, 10));
    closeDb();
  });

// recall import-legacy - Import DISTILLED.md extracts
program
  .command('import-legacy')
  .description('Import legacy DISTILLED.md extracts as LoA entries')
  .option('--dry-run', 'Preview what would be imported')
  .option('-v, --verbose', 'Show detailed progress')
  .option('-y, --yes', 'Confirm import')
  .option('-s, --source <source>', 'Source: distilled, hot_recall, or all', 'all')
  .action((options) => {
    runImportLegacy({
      dryRun: options.dryRun,
      verbose: options.verbose,
      yes: options.yes,
      source: options.source
    });
    closeDb();
  });

// recall telos - TELOS framework commands
const telosCmd = program
  .command('telos')
  .description('TELOS framework - purpose, goals, strategies');

telosCmd
  .command('import')
  .description('Import TELOS')
  .option('--dry-run', 'Preview what would be imported')
  .option('-v, --verbose', 'Show detailed progress')
  .option('-y, --yes', 'Confirm import')
  .option('-u, --update', 'Update existing entries')
  .action((options) => {
    runImportTelos({
      dryRun: options.dryRun,
      verbose: options.verbose,
      yes: options.yes,
      update: options.update
    });
    closeDb();
  });

telosCmd
  .command('list')
  .description('List TELOS entries')
  .option('-t, --type <type>', 'Filter by type (problem, mission, goal, challenge, strategy)')
  .option('-l, --limit <n>', 'Max entries', '50')
  .action((options) => {
    runTelosList({
      type: options.type,
      limit: parseInt(options.limit, 10)
    });
    closeDb();
  });

telosCmd
  .command('show <code>')
  .description('Show a specific TELOS entry by code (e.g., GOALS, PROJECTS, MISSION)')
  .action((code) => {
    runTelosShow(code);
    closeDb();
  });

telosCmd
  .command('search <query>')
  .description('Search TELOS entries')
  .option('-t, --type <type>', 'Filter by type')
  .option('-l, --limit <n>', 'Max results', '10')
  .action((query, options) => {
    runTelosSearch(query, {
      type: options.type,
      limit: parseInt(options.limit, 10)
    });
    closeDb();
  });

// recall dump - Flush current session + capture LoA
program
  .command('dump <title>')
  .description('Flush current session to DB and capture LoA entry')
  .option('-p, --project <name>', 'Project name')
  .option('-c, --continues <id>', 'Continue from a previous LoA entry')
  .option('-t, --tags <tags>', 'Comma-separated tags')
  .option('-n, --limit <n>', 'Max messages to process')
  .option('--skip-fabric', 'Skip Fabric extraction (import only)')
  .action(async (title, options) => {
    await runDump(title, {
      project: options.project,
      continues: options.continues ? parseInt(options.continues, 10) : undefined,
      tags: options.tags,
      limit: options.limit ? parseInt(options.limit, 10) : undefined,
      skipFabric: options.skipFabric
    });
    closeDb();
  });

// recall docs - Standalone document management
const docsCmd = program
  .command('docs')
  .description('Standalone documents - diary, reference, wisdom files');

docsCmd
  .command('import')
  .description('Import standalone markdown documents from ~/.claude/')
  .option('--dry-run', 'Preview what would be imported')
  .option('-v, --verbose', 'Show detailed progress')
  .option('-y, --yes', 'Confirm import')
  .action((options) => {
    runImportDocs({
      dryRun: options.dryRun,
      verbose: options.verbose,
      yes: options.yes
    });
    closeDb();
  });

docsCmd
  .command('list')
  .description('List imported documents')
  .action(() => {
    runDocsList();
    closeDb();
  });

docsCmd
  .command('search <query>')
  .description('Search documents')
  .option('-l, --limit <n>', 'Max results', '10')
  .action((query, options) => {
    runDocsSearch(query, parseInt(options.limit, 10));
    closeDb();
  });

docsCmd
  .command('show <id>')
  .description('Show a document')
  .action((id) => {
    runDocsShow(parseInt(id, 10));
    closeDb();
  });

// recall embed - Vector embeddings for semantic search
const embedCmd = program
  .command('embed')
  .description('Vector embeddings for semantic search');

embedCmd
  .command('backfill')
  .description('Generate embeddings for existing records')
  .option('-t, --table <table>', 'Table to embed: loa, decisions, messages', 'loa')
  .option('-l, --limit <n>', 'Max records to embed', '100')
  .option('-f, --force', 'Re-embed even if already embedded')
  .action(async (options) => {
    await runEmbedBackfill({
      table: options.table as 'loa' | 'decisions' | 'messages',
      limit: parseInt(options.limit, 10),
      force: options.force
    });
    closeDb();
  });

embedCmd
  .command('stats')
  .description('Show embedding statistics')
  .action(() => {
    runEmbedStats();
    closeDb();
  });

// recall semantic <query> - Semantic search
program
  .command('semantic <query>')
  .description('Semantic search using vector embeddings')
  .option('-t, --table <table>', 'Search specific table (loa_entries, decisions, messages)')
  .option('-l, --limit <n>', 'Max results', '10')
  .action(async (query, options) => {
    await runSemanticSearch(query, {
      table: options.table,
      limit: parseInt(options.limit, 10)
    });
    closeDb();
  });

// recall hybrid <query> - Hybrid search (FTS5 + semantic with RRF fusion)
program
  .command('hybrid <query>')
  .description('Hybrid search combining keywords (FTS5) + semantics (embeddings) with RRF fusion')
  .option('-t, --table <table>', 'Search specific table (loa_entries, decisions, messages)')
  .option('-l, --limit <n>', 'Max results', '10')
  .action(async (query, options) => {
    await runHybridSearch(query, {
      table: options.table,
      limit: parseInt(options.limit, 10)
    });
    closeDb();
  });

// recall onboard — interactive interview that creates the L0 identity tier
program
  .command('onboard')
  .description('Interactive interview to create your L0 identity.md (loaded at every session start)')
  .option('--project', 'Write to ./.atlas-recall/identity.md (project-local) instead of the global path')
  .option('--print', 'Preview the rendered markdown without writing to disk')
  .option('--yes', 'Accept all suggested defaults non-interactively')
  .option('--out <path>', 'Override the output path entirely')
  .action(async (options) => {
    // onboard never opens the DB, so closeDb() is intentionally not called.
    await runOnboard({
      project: options.project,
      print: options.print,
      yes: options.yes,
      out: options.out,
    });
  });

// recall importance — heuristic backfill for the importance column
const importanceCmd = program
  .command('importance')
  .description('Manage the importance score on memory records');

importanceCmd
  .command('backfill')
  .description('Backfill importance scores using confidence-based heuristics (dry-run by default)')
  .option('--execute', 'Apply changes (default is dry-run)')
  .option('--force', 'Overwrite non-default values too (default: only update rows still at the default)')
  .option('-t, --table <table>', 'Target table: decisions, learnings, loa_entries, all', 'all')
  .action((options) => {
    runImportanceBackfill({
      dryRun: !options.execute,
      force: options.force,
      table: options.table
    });
    closeDb();
  });

// recall provenance — conservative backfill for Record Provenance (ADR-0001).
// Provenance is automatic write-path metadata: there is intentionally no
// flag to set it on add commands; this maintenance path only classifies
// legacy NULL rows where deterministic evidence exists.
const provenanceCmd = program
  .command('provenance')
  .description('Manage Record Provenance metadata on memory records');

provenanceCmd
  .command('backfill')
  .description('Classify legacy rows with unknown provenance using deterministic write-path evidence (dry-run by default; never guesses)')
  .option('--execute', 'Apply changes (default is dry-run)')
  .option('-t, --table <table>', 'Target table: messages, decisions, learnings, breadcrumbs, loa_entries, all', 'all')
  .action((options) => {
    runProvenanceBackfill({
      dryRun: !options.execute,
      table: options.table
    });
    closeDb();
  });

// recall pin <table> <id> [importance] — force a record to a high importance (default 10)
program
  .command('pin <table> <id> [importance]')
  .description('Pin a memory record to a high importance (default 10). LoA floor of 5 enforced.')
  .action((table, id, importance) => {
    runPin(table, parseInt(id, 10), importance !== undefined ? parseInt(importance, 10) : undefined);
    closeDb();
  });

// recall unpin <table> <id> — reset importance to table default
program
  .command('unpin <table> <id>')
  .description("Reset a record's importance to its table default (5 for most, 8 for LoA)")
  .action((table, id) => {
    runUnpin(table, parseInt(id, 10));
    closeDb();
  });

// recall benchmark — Phase 2 benchmark harness
const benchmarkCmd = program
  .command('benchmark')
  .description('Run, list, or report Phase 2 benchmarks (see benchmarks/README.md)');

benchmarkCmd
  .command('run [suite]')
  .description('Run benchmarks. Pass a suite id (A-E) to run just one; omit to run all available.')
  .option('-p, --project <name>', 'Scope the benchmark to a specific project')
  .action(async (suite, options) => {
    await runBenchmark({ suite, project: options.project });
    closeDb();
  });

benchmarkCmd
  .command('list')
  .description('List available benchmark suites and their build status')
  .action(() => {
    listBenchmarks();
  });

benchmarkCmd
  .command('report')
  .description('Show the latest benchmark report')
  .action(() => {
    reportLatestBenchmark();
  });

// recall doctor - Run health checks on all memory subsystems
program
  .command('doctor')
  .description('Run health checks on all memory subsystems')
  .option('--fix', 'Re-create missing/drifted symlinks (back up drifted files first)')
  .action(async (options) => {
    await runDoctor({ fix: !!options.fix });
    closeDb();
  });

program
  .command('migrate')
  .description('Move the database to a new path and rewrite MCP configs')
  .requiredOption('--to <path>', 'Destination path for recall.db (absolute, or starting with ~/)')
  .option('--dry-run', 'Print the plan without making changes')
  .action((options) => {
    runMigrate({ to: options.to, dryRun: !!options.dryRun });
    closeDb();
  });

program
  .command('path')
  .description('Print resolved DB path, install root, and symlink targets')
  .option('--json', 'Output as JSON (for scripting)')
  .action((options) => {
    runPath({ json: !!options.json });
    closeDb();
  });

// recall export — portable + disaster-recovery exports (issue #43)
// --format has no Commander default: runExport defaults to json, and --backup
// must be able to tell an explicitly passed --format from an omitted one.
program
  .command('export')
  .description('Export memory to JSON, Markdown, SQL dump, or SQLite backup')
  .option('-f, --format <format>', 'Format: json, markdown, sql, sqlite (default: json)')
  .option('-o, --output <path>', 'Output file or directory (directory exports also write manifest.json)')
  .option('--backup', 'Write a timestamped SQL dump to ~/.agents/Recall/backups/ (never overwrites)')
  .action((options) => {
    try {
      runExport({
        format: options.format,
        output: options.output,
        backup: options.backup
      });
    } catch (err) {
      console.error(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
    closeDb();
  });

// recall dedup — non-destructive duplicate detection (issue #45)
// Dry-run by default; --execute marks duplicates in dedup_lineage (records
// stay intact, hidden from search); --delete is the destructive opt-in.
program
  .command('dedup')
  .description('Detect and mark duplicate memory records (dry-run by default; non-destructive)')
  .option('--execute', 'Apply the plan: mark duplicates (default is dry-run)')
  .option('--delete', "Destructive opt-in: hard-delete duplicates instead of marking (requires --execute; run 'recall export --backup' first)")
  .option('-t, --table <table>', 'Target table: messages, decisions, learnings, breadcrumbs, loa_entries, all', 'all')
  .option('-p, --project <name>', 'Scope to one project')
  .option('--threshold <n>', `Semantic similarity threshold (0-1)`, String(DEFAULT_SEMANTIC_THRESHOLD))
  .option('--no-semantic', 'Skip the semantic (embeddings) pass')
  .action((options) => {
    runDedup({
      execute: options.execute,
      delete: options.delete,
      table: options.table,
      project: options.project,
      threshold: parseFloat(options.threshold),
      semantic: options.semantic
    });
    closeDb();
  });

// recall repair — data/index maintenance (issue #46)
// Dry-run by default; --execute rebuilds FTS5 indexes and re-embeds rows
// missing embeddings. Separate from `recall doctor --fix` (symlinks only).
program
  .command('repair')
  .description('Rebuild FTS5 indexes and re-embed missing embeddings (dry-run by default)')
  .option('--execute', 'Apply the planned repairs (default is dry-run)')
  .option('-t, --table <table>', 'Target table: messages, decisions, learnings, breadcrumbs, loa_entries, telos, documents, all', 'all')
  .option('--no-embed', 'Skip the embedding pass')
  .action(async (options) => {
    await runRepair({
      execute: options.execute,
      table: options.table,
      embed: options.embed
    });
    closeDb();
  });

// Default command: recall <query> → hybrid search (Phase 3: best of both worlds)
program
  .arguments('[query]')
  .option('-p, --project <name>', 'Filter by project')
  .option('-t, --table <table>', 'Search specific table')
  .option('--bias-type <table>', 'Keyword search only: softly boost one table without filtering others')
  .option('-l, --limit <n>', 'Max results', '10')
  .option('-k, --keyword', 'Use keyword search only (FTS5)')
  .option('-v, --vector', 'Use vector search only (semantic)')
  .action(async (query, options) => {
    if (query && !['init', 'add', 'search', 'recent', 'show', 'stats', 'import', 'import-conversations', 'loa', 'telos', 'docs', 'dump', 'embed', 'semantic', 'hybrid', 'doctor', 'importance', 'provenance', 'pin', 'unpin', 'decision', 'prune', 'cluster', 'import-legacy', 'benchmark', 'onboard', 'migrate', 'path', 'export', 'dedup', 'repair'].includes(query)) {
      if (options.keyword) {
        // FTS5 only
        runSearch(query, {
          project: options.project,
          table: options.table,
          biasType: options.biasType,
          limit: parseInt(options.limit, 10)
        });
      } else if (options.vector) {
        // Semantic only
        await runSemanticSearch(query, {
          table: options.table,
          limit: parseInt(options.limit, 10)
        });
      } else {
        // Default: hybrid (best results)
        await runHybridSearch(query, {
          table: options.table,
          limit: parseInt(options.limit, 10)
        });
      }
      closeDb();
    }
  });

// Parse and run
program.parse();
