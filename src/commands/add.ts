// recall add command

import { addBreadcrumb, addDecision, addLearning } from '../lib/memory.js';
import { detectProject } from '../lib/project.js';

// Surface known-prefix secrets that the add path redacted before storing —
// visible-by-design, never silent. Distinct kinds only, never the values.
function warnRedactions(redactions: string[]): void {
  if (redactions.length > 0) {
    console.log(`⚠ redacted secrets before storing: ${redactions.join(', ')}`);
  }
}

interface AddBreadcrumbOptions {
  project?: string;
  category?: string;
  importance?: number;
}

export function runAddBreadcrumb(content: string, options: AddBreadcrumbOptions): void {
  if (!content || !content.trim()) {
    console.error('Error: Content cannot be empty');
    process.exit(1);
  }

  const project = options.project || detectProject();

  const redactions: string[] = [];
  const id = addBreadcrumb({
    content,
    project,
    category: options.category,
    importance: options.importance ?? 5,
    // ADR-0001: provenance is stamped from the write path, never a CLI flag.
    provenance: 'user_authored'
  }, redactions);

  console.log(`✓ Added breadcrumb #${id}${project ? ` [${project}]` : ''}`);
  warnRedactions(redactions);
}

interface AddDecisionOptions {
  project?: string;
  category?: string;
  why?: string;
  alternatives?: string;
  confidence?: string;
}

export function runAddDecision(decision: string, options: AddDecisionOptions): void {
  if (!decision || !decision.trim()) {
    console.error('Error: Decision text cannot be empty');
    process.exit(1);
  }

  const project = options.project || detectProject();
  const confidence = (options.confidence || 'medium') as 'high' | 'medium' | 'low';

  const redactions: string[] = [];
  const id = addDecision({
    decision,
    project,
    category: options.category,
    reasoning: options.why,
    alternatives: options.alternatives,
    status: 'active',
    confidence,
    provenance: 'user_authored'
  }, redactions);

  console.log(`✓ Added decision #${id}${project ? ` [${project}]` : ''} (${confidence})`);
  warnRedactions(redactions);
}

interface AddLearningOptions {
  project?: string;
  category?: string;
  prevention?: string;
  tags?: string;
}

export function runAddLearning(problem: string, solution: string, options: AddLearningOptions): void {
  if (!problem || !problem.trim()) {
    console.error('Error: Problem description cannot be empty');
    process.exit(1);
  }

  const project = options.project || detectProject();

  const redactions: string[] = [];
  const id = addLearning({
    problem,
    solution,
    project,
    category: options.category,
    prevention: options.prevention,
    tags: options.tags,
    provenance: 'user_authored'
  }, redactions);

  console.log(`✓ Added learning #${id}${project ? ` [${project}]` : ''}`);
  warnRedactions(redactions);
}
