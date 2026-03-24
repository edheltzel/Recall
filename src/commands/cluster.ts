// mem cluster command — detect procedures from clustered learnings

import { getDb } from '../db/connection.js';
import { blobToEmbedding, cosineSimilarity } from '../lib/embeddings.js';
import { execSync } from 'child_process';

interface ClusterOptions {
  execute?: boolean;
  threshold?: number;
}

interface LearningWithEmbedding {
  id: number;
  problem: string;
  solution: string | null;
  project: string | null;
  embedding: number[];
}

interface Cluster {
  members: LearningWithEmbedding[];
  project: string | null;
}

function loadLearningEmbeddings(): LearningWithEmbedding[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT l.id, l.problem, l.solution, l.project, e.embedding
    FROM learnings l
    JOIN embeddings e ON e.source_table = 'learnings' AND e.source_id = l.id
  `).all() as any[];

  return rows.map(r => ({
    id: r.id,
    problem: r.problem,
    solution: r.solution,
    project: r.project,
    embedding: blobToEmbedding(r.embedding)
  }));
}

function findClusters(learnings: LearningWithEmbedding[], threshold: number): Cluster[] {
  const assigned = new Set<number>();
  const clusters: Cluster[] = [];

  for (let i = 0; i < learnings.length; i++) {
    if (assigned.has(learnings[i].id)) continue;

    const cluster: LearningWithEmbedding[] = [learnings[i]];
    assigned.add(learnings[i].id);

    for (let j = i + 1; j < learnings.length; j++) {
      if (assigned.has(learnings[j].id)) continue;

      const sim = cosineSimilarity(learnings[i].embedding, learnings[j].embedding);
      if (sim >= threshold) {
        cluster.push(learnings[j]);
        assigned.add(learnings[j].id);
      }
    }

    if (cluster.length >= 2) {
      const projects = cluster.map(l => l.project).filter(Boolean);
      const project = projects.length > 0 ? projects[0] : null;
      clusters.push({ members: cluster, project });
    }
  }

  return clusters;
}

function synthesizeProcedure(cluster: Cluster): { title: string; steps: string; trigger: string } | null {
  const learningsText = cluster.members.map((l, i) =>
    `Learning ${i + 1}: Problem: ${l.problem}\nSolution: ${l.solution || 'N/A'}`
  ).join('\n\n');

  const prompt = `You are synthesizing a reusable procedure from related learnings.

These learnings describe the same or similar problem pattern:

${learningsText}

Generate a concise procedure with:
1. A short title (5-10 words)
2. When to use this (trigger context, 1 sentence)
3. Steps to follow (numbered list, 3-7 steps)

Output in this exact format:
TITLE: [title]
TRIGGER: [when to use]
STEPS:
1. [step]
2. [step]
...`;

  try {
    // Uses claude CLI with piped input — same pattern as SessionExtract.ts
    // Input is generated from DB content, not user-supplied shell arguments
    const result = execSync(
      `echo ${JSON.stringify(prompt)} | claude -p --model claude-haiku-4-5-20251001 2>/dev/null`,
      { encoding: 'utf-8', timeout: 30000 }
    ).trim();

    const titleMatch = result.match(/TITLE:\s*(.+)/);
    const triggerMatch = result.match(/TRIGGER:\s*(.+)/);
    const stepsMatch = result.match(/STEPS:\s*([\s\S]+)/);

    if (!titleMatch || !stepsMatch) return null;

    return {
      title: titleMatch[1].trim(),
      trigger: triggerMatch?.[1].trim() || '',
      steps: stepsMatch[1].trim()
    };
  } catch {
    return null;
  }
}

export function runCluster(options: ClusterOptions): void {
  const dryRun = !options.execute;
  const threshold = options.threshold || 0.85;

  const learnings = loadLearningEmbeddings();

  if (learnings.length === 0) {
    console.log('No learnings with embeddings found.');
    console.log('Run `mem embed backfill learnings` first to generate embeddings.');
    return;
  }

  console.log(`Loaded ${learnings.length} learnings with embeddings`);
  console.log(`Similarity threshold: ${threshold}\n`);

  const clusters = findClusters(learnings, threshold);

  if (clusters.length === 0) {
    console.log('No clusters found at this threshold.');
    console.log('Try lowering the threshold with --threshold 0.8');
    return;
  }

  console.log(`Found ${clusters.length} cluster(s):\n`);

  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i];
    const projectTag = c.project ? ` [${c.project}]` : '';
    console.log(`Cluster ${i + 1}${projectTag} (${c.members.length} learnings):`);
    for (const m of c.members) {
      console.log(`  #${m.id}: ${m.problem.slice(0, 80)}`);
    }
    console.log('');
  }

  if (dryRun) {
    console.log('Run with --execute to synthesize procedures from these clusters.');
    return;
  }

  const db = getDb();
  const insertStmt = db.prepare(`
    INSERT INTO procedures (title, trigger_context, steps, source_learnings, project, times_observed, confidence)
    VALUES ($title, $trigger, $steps, $sources, $project, $times, $confidence)
  `);

  let created = 0;

  for (const cluster of clusters) {
    console.log(`Synthesizing procedure from cluster of ${cluster.members.length}...`);
    const result = synthesizeProcedure(cluster);

    if (!result) {
      console.log('  Synthesis failed, skipping.');
      continue;
    }

    const sourceIds = cluster.members.map(m => m.id).join(',');

    insertStmt.run({
      $title: result.title,
      $trigger: result.trigger,
      $steps: result.steps,
      $sources: sourceIds,
      $project: cluster.project,
      $times: cluster.members.length,
      $confidence: cluster.members.length >= 3 ? 'high' : 'medium'
    });

    console.log(`  Created: "${result.title}"`);
    created++;
  }

  console.log(`\nCreated ${created} procedure(s).`);
}
