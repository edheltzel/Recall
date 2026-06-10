# ADR-0002: macOS is the primary CI platform

## Status

Accepted

## Context

Recall is a Bun/TypeScript CLI, MCP server, and hook system used primarily with Claude Code and agent host integrations. Although much of the code is portable, the highest-risk behavior includes user-home install paths, symlinked hooks, Claude Code settings, and macOS-heavy development workflows.

A generic TypeScript CLI would often use Linux as the primary CI target. For Recall, that would make the cheapest platform the reference platform rather than the platform that best represents real use.

Windows support is also a separate decision. Recall can support WSL through Linux behavior, but native Windows paths and shell semantics are not currently part of the product promise.

## Decision

macOS is the primary required CI platform for Recall.

Linux/WSL compatibility is covered by an Ubuntu smoke job.

Native Windows CI is out of scope until Recall explicitly commits to native Windows support.

The primary macOS job should run the normal project gates: install, lint, tests, and build. The Ubuntu smoke job should run enough of the same gates to catch portability regressions.

## Consequences

- CI better reflects the platform where Recall's hook and install behavior is most likely to be used.
- Linux compatibility remains visible without becoming the reference environment.
- WSL users are covered through Linux behavior.
- Native Windows behavior is not promised by CI and should not be implied in docs or support language.
