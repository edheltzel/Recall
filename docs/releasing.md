# Releasing Recall

[← Back to README](../README.md)

This document describes how a maintainer cuts a new Recall release.
Users should read [Upgrading](upgrading.md) instead — they do not run
these steps.

## Pre-flight: agent context files

Before tagging, confirm `CLAUDE.md` is still a symlink to `AGENTS.md` and has
not been regenerated into a full duplicate:

```bash
# Should print: CLAUDE.md -> AGENTS.md
ls -l CLAUDE.md
```

`AGENTS.md` is the canonical agent guide; `CLAUDE.md` is a symlink to it so
Claude Code auto-loads it. **Never run `/init` in this repo** — it rewrites
`CLAUDE.md` from scratch and reintroduces the duplication. If `CLAUDE.md` has
drifted into a regular file, restore it with `ln -sf AGENTS.md CLAUDE.md` and
fold any new content back into `AGENTS.md` before releasing.

## Source of truth: `CHANGELOG.md`

Every release's notes live in `CHANGELOG.md` at the repo root, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The release
process reads from it rather than duplicating notes elsewhere, so the
file never drifts from the tag.

## Version consistency

`package.json.version` is the authoritative release version. `src/version.ts`
loads that value at runtime and must not carry a semver fallback that can drift
into a second release source.

CI runs `bun run check:version` on every branch, PR, tag, and release event. On
ordinary code changes the guard only validates that `package.json.version` is
strict semver and that the runtime fallback is non-authoritative. On tag or
release runs, the tag name (with an optional leading `v`) must match
`package.json.version` exactly.

## Release commands

Run from the repository root on clean `main`, with all intended changes reviewed,
merged, and synchronized with `origin/main`. Bun, Git, npm, and authenticated `gh`
must be available. Install dependencies first with `bun install --frozen-lockfile`.

```bash
npm run release:patch
npm run release:minor
npm run release:major
```

These commands share `scripts/release.ts`. `npm run release -- patch` is equivalent
to `npm run release:patch`.

| Command | Starting at `0.10.0` | Tag |
| --- | --- | --- |
| `release:patch` | `0.10.1` | `v0.10.1` |
| `release:minor` | `0.11.0` | `v0.11.0` |
| `release:major` | `1.0.0` | `v1.0.0` |

Preview the same preflight without changing files, commits, tags, or releases:

```bash
npm run release:patch -- --dry-run
```

Dry runs still require clean, synchronized `main` and GitHub access. Feature branches,
detached checkouts, and `gitbutler/workspace` are not release targets.

The command:

1. Checks the clean checkout, canonical `CLAUDE.md` symlink, and exact remote `main` commit.
2. Resolves the GitHub repository from `origin`'s push URL and checks existing local
   tags, remote tags, and GitHub releases. Existing release versions are never overwritten.
3. Increments `package.json.version` and writes that version into both native plugin
   manifests: `hosts/plugins/recall/.codex-plugin/plugin.json` and
   `hosts/plugins/recall-claude/.claude-plugin/plugin.json`.
4. Moves nonempty `[Unreleased]` notes into a dated version heading, keeping an empty
   `[Unreleased]` heading for future work.
5. Checks the version guard, then runs lint, the test suite, and the build.
6. Commits only the release files as `chore(release): vX.Y.Z`, verifies their committed
   versions, and creates annotated tag `vX.Y.Z`.
7. Pushes `main` and that tag atomically to `origin`, with automatic tag following
   disabled. A rejected branch update cannot leave a tag published alone, and other
   local annotated tags stay private even when `push.followTags` is enabled.
8. Creates the GitHub release with `--verify-tag`, the changelog notes as its body,
   and `--latest`.

This is the maintainer-approved direct-release exception to the normal PR workflow.
Direct pushes to `main` must be permitted by repository rules. The command does not
disable branch protection, force-push, merge feature work, or run `npm publish`.
The existing Bun lockfile has no root version field to update.

The bump starts from the package version, not the latest published tag. If the package
is already ahead of published releases, the next release advances that package version.
The command does not backfill old tags or change historical releases. If the next version
is already published or is older than an existing stable release, reconcile the package
version deliberately before retrying.

## Recover a partial release

A validation or publication failure exits nonzero. The script preserves files and
history for inspection instead of resetting work or deleting tags automatically.

- Before the commit: inspect the changed manifests and changelog. Fix the reported
  validation failure. Restore only those release edits if you want to rerun a bump;
  the clean-tree guard prevents accidentally bumping a dirty checkout again.
- After the commit or tag, before a successful push: do not run another version bump.
  Verify the release commit and annotated tag agree, fix the push failure, and retry
  that same atomic push.
- After the push, if GitHub release creation fails: leave the published commit and tag
  intact. Save the matching version's changelog body into a temporary notes file and
  create the missing release:

```bash
gh release create vX.Y.Z --repo edheltzel/Recall --verify-tag \
  --title vX.Y.Z --notes-file /path/to/release-notes.txt --latest
```

Check whether GitHub already created the release before retrying after a network error.
Never move an existing release tag to a different commit.

## `update.sh` and the check commands

`./packaging/update.sh --check` and `/do-recall-update` both query
`https://api.github.com/repos/edheltzel/Recall/releases/latest` for the
current tag name. Make sure the release you create is marked as
"Latest" (GitHub does this automatically for the newest non-draft,
non-prerelease tag). If you cut a prerelease, do NOT mark it latest —
`update.sh --check` will tell users they're up to date while the stable
release still has untapped work.

## Skipped version numbers

Minor patch numbers can be skipped intentionally (0.7.1 → 0.7.11 in
April 2026 was an intentional gap so the lifecycle release could keep
its 0.7.2 slot). When this happens, document the reason in the
CHANGELOG entry for the jump — future readers should not have to guess.

## Emergency hotfix — same-day patch

For a surgical hotfix that fixes a single bug:

1. Branch from `main`.
2. Make the change + test.
3. Add the fix under `CHANGELOG.md`'s `[Unreleased]` section.
4. Merge the reviewed fix into `main` and synchronize the local checkout.
5. Run `npm run release:patch`.

Keep hotfix scope surgical. If scope is growing, promote to a normal
release so the entry captures `### Added` / `### Changed` too.

## Never skip the CHANGELOG

`./packaging/update.sh` and `/do-recall-update` read the GitHub release body for the
excerpt shown to users. If you push a tag without a release note, the
update experience degrades to "new version available" with no detail —
users won't know what they're updating to. Always release from the
CHANGELOG.
