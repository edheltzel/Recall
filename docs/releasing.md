# Releasing Recall

[← Back to README](../README.md)

This document describes how a maintainer cuts a new Recall release.
Users should read [Upgrading](upgrading.md) instead — they do not run
these steps.

## Pre-flight: agent context files

Before tagging, confirm `CLAUDE.md` is still the one-line `@AGENTS.md` shim and
has not been regenerated into a full duplicate:

```bash
# Should print the @AGENTS.md import (and the HTML comment) — nothing else.
cat CLAUDE.md
```

`AGENTS.md` is the canonical agent guide; `CLAUDE.md` only `@`-imports it so
Claude Code auto-loads it. **Never run `/init` in this repo** — it rewrites
`CLAUDE.md` from scratch and reintroduces the duplication. If `CLAUDE.md` has
drifted, restore the shim and fold any new content back into `AGENTS.md` before
releasing.

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

## Release recipe

```bash
# 1. Edit CHANGELOG.md: move [Unreleased] items under a new [X.Y.Z] heading
#    with today's date.
${EDITOR:-vim} CHANGELOG.md

# 2. Bump package.json to match.
node -e '
  const fs = require("fs");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  pkg.version = process.argv[1];
  fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
' "X.Y.Z"

# 3. Commit + tag. Release tags are annotated (v0.9.0 onward), and a plain
#    `git tag` fails under `tag.forceSignAnnotated=true` — always pass -a -m.
git commit -am "chore(release): vX.Y.Z"
git tag -a "vX.Y.Z" -m "vX.Y.Z — <codename>"
git push origin main --follow-tags

# 4. Create the GitHub release with notes extracted from CHANGELOG.
gh release create "vX.Y.Z" \
  --notes-file <(awk '/^## \[X\.Y\.Z\]/{flag=1; next} /^## \[/{flag=0} flag' CHANGELOG.md)
```

The `awk` expression lifts everything between the `## [X.Y.Z]` heading
and the next `## [` heading (the previous release). Because the script
literally reads `CHANGELOG.md`, the release notes and the CHANGELOG can
never diverge.

## `update.sh` and the check commands

`./update.sh --check` and `/recall-update` both query
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
3. Bump the patch digit (0.7.11 → 0.7.12).
4. Add a `## [0.7.12] — YYYY-MM-DD` entry to CHANGELOG with only a
   `### Fixed` section.
5. Follow the recipe above.

Keep hotfix scope surgical. If scope is growing, promote to a normal
release so the entry captures `### Added` / `### Changed` too.

## Never skip the CHANGELOG

`./update.sh` and `/recall-update` read the GitHub release body for the
excerpt shown to users. If you push a tag without a release note, the
update experience degrades to "new version available" with no detail —
users won't know what they're updating to. Always release from the
CHANGELOG.
