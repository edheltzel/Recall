# jcode: Jcode capture helper

> Child DOX. Root `AGENTS.md` carries repo-wide rules; this file owns local detail for `jcode/`.

## Purpose

First-party Jcode adapter. Calls `recall capture` when the caller supplies raw text. Does not install hooks or watch transcripts.

## Ownership

- `capture.ts`: supplied-text capture helper and hook-env skip

## Local Contracts

- No `src/` imports. No SQLite. The only write path is a child `recall capture`.
- Do not read private Jcode session files. A `sessionFile` path is a skip, never an open.
- Do not write `~/.jcode/config.toml`. Observer hooks are scalar and not ownership-safe.
- Hook env (`JCODE_HOOK_*`) is not a transcript. Do not capture `JCODE_HOOK_LAST_ASSISTANT_TEXT` or parse `JCODE_HOOK_PAYLOAD` until a public watermark field is verified.
- No TranscriptWatcher. Jcode has no public transcript path to tail.

## Work Guidance

- Limits and the local probe belong in `docs/JCODE_INTEGRATION.md`. Keep that guide matched to this helper.

## Verification

- `bun test tests/hosts/jcode-capture.test.ts`

## Child DOX Index

No child docs.
