// mem decision command — lifecycle management for decisions

import { getDecision, supersedeDecision, revertDecision, listDecisions } from '../lib/memory.js';

function runLifecycleAction(id: number, action: 'supersede' | 'revert'): void {
  const decision = getDecision(id);
  if (!decision) {
    console.error(`Error: Decision #${id} not found`);
    process.exit(1);
  }

  if (decision.status !== 'active') {
    console.error(`Error: Decision #${id} is already ${decision.status}`);
    process.exit(1);
  }

  const changes = action === 'supersede' ? supersedeDecision(id) : revertDecision(id);
  const label = action === 'supersede' ? 'superseded' : 'reverted';

  if (changes > 0) {
    console.log(`✓ Decision #${id} marked as ${label}`);
    console.log(`  Was: ${decision.decision}`);
  } else {
    console.error(`Error: Failed to ${action} decision #${id}`);
    process.exit(1);
  }
}

export function runSupersede(id: number): void { runLifecycleAction(id, 'supersede'); }
export function runRevert(id: number): void { runLifecycleAction(id, 'revert'); }

interface ListOptions {
  project?: string;
  status?: string;
  limit?: number;
}

export function runList(options: ListOptions): void {
  const limit = options.limit || 20;
  const decisions = listDecisions(limit, options.project, options.status);

  if (decisions.length === 0) {
    console.log('No decisions found.');
    return;
  }

  const statusFilter = options.status ? ` (${options.status})` : ' (all statuses)';
  console.log(`Decisions${statusFilter}:\n`);

  for (const d of decisions) {
    const date = d.created_at?.split('T')[0] || 'unknown';
    const projectTag = d.project ? ` [${d.project}]` : '';
    const statusTag = d.status !== 'active' ? ` (${d.status})` : '';

    console.log(`#${d.id}${projectTag}${statusTag} ${date}`);
    console.log(`  ${d.decision}`);
    if (d.reasoning) {
      console.log(`  Why: ${d.reasoning}`);
    }
    console.log('');
  }
}
