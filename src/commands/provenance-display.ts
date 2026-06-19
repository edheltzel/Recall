// Shared provenance display contract for the CLI search paths (issue #42, #75).

import type { Provenance } from '../types/index.js';

/**
 * Render the provenance tag appended to a search result line.
 *
 * Display contract (issue #42): known provenance stays quiet by default;
 * unknown (NULL) is always flagged. --show-provenance shows every value.
 *
 * Single source of truth shared by `recall search`, `recall semantic`,
 * `recall hybrid`, and the bare `recall <query>` default (issue #75).
 */
export function formatProvenanceTag(
  provenance: Provenance | null | undefined,
  showProvenance: boolean | undefined
): string {
  if (showProvenance) {
    return ` [provenance: ${provenance ?? 'unknown'}]`;
  }
  if (!provenance) {
    return ' ⚠ [provenance: unknown]';
  }
  return '';
}
