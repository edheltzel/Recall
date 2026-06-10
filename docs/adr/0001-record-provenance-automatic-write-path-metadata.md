# ADR-0001: Record Provenance is automatic write-path metadata

## Status

Accepted

## Context

Recall is a background memory system. Its core posture is Frictionless Memory Capture: hooks, imports, MCP tools, and agent workflows should capture and curate memory without asking users to classify records or interrupting normal agent use.

Record Provenance makes memory records honest about how they were created. The trade-off is whether callers, especially MCP agents, should be allowed to provide provenance directly or whether Recall should stamp provenance from the write path that created the record.

Allowing public callers to override provenance would be flexible, but it would also make it easy for agents to accidentally launder extracted or derived records as verbatim. It would add a classification burden to a system whose value comes from getting out of the user's way.

## Decision

Record Provenance is automatic write-path metadata.

Public MCP memory-add calls must not expose a provenance override. They stamp directly authored memory records as `user_authored` automatically.

Hooks, importers, extraction paths, maintenance paths, and future internal tools may set provenance from known write-path semantics.

Normal users and agents must not be asked to classify provenance during routine memory capture.

## Consequences

- MCP memory-add remains frictionless.
- Record Provenance is more trustworthy because it is derived from controlled write paths, not arbitrary caller claims.
- Importers and hooks must be audited as first-class capture surfaces when Record Provenance is implemented.
- Advanced repair or migration workflows that need to set provenance must do so through explicit maintenance paths, not the public MCP memory-add interface.
