# Context

Project glossary for Recall domain language. This file defines terms only; it does not record implementation details, plans, or architectural decisions.

## Record Provenance

The declared origin and transformation level of a memory record: whether it was captured verbatim, authored directly by a user or agent, or extracted/summarized from source material.

### Provenance States

- **`verbatim`** — exact source text captured without semantic rewriting.
- **`user_authored`** — directly authored as a memory record by a user or agent command.
- **`extracted`** — generated from source material, possibly lossy.
- **`derived`** — mechanically produced from existing memory records without new user/source text.

### Unknown Record Provenance

The absence of a declared provenance value for a legacy memory record. Unknown provenance is not a provenance state; it means Recall cannot honestly claim how the record was created.

## Frictionless Memory Capture

Recall's core product posture: it captures and curates memory in the background through hooks, imports, and agent workflows without asking the user to classify records, fill forms, or interrupt normal agent use.
