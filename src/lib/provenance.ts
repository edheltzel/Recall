import type { Provenance } from "../types/index.js";

// Record Provenance display (ADR-0001): structured results always carry
// provenance; legacy NULL is reported as "unknown", never guessed.
export function provenanceLabel(provenance: Provenance | null | undefined): string {
	return `provenance: ${provenance ?? "unknown"}`;
}
