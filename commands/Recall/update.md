---
description: Check for the latest Recall release on GitHub and print the exact update command (check-only — does not run update.sh).
---

Check whether Recall has a newer release on GitHub. This command is
read-only — it prints the recommended next step but NEVER runs
`update.sh` inline. Running the update while Claude Code is attached
can corrupt in-flight hook invocations (the `mem` binary lives in the
same process tree via `bun link`).

## What this does

1. Reads the currently installed version via `mem --version`.
2. Fetches the latest release tag from the GitHub Releases API
   (`/repos/edheltzel/Recall/releases/latest` — unauthenticated, 60
   req/hr per IP).
3. If current == latest: reports "up to date" and exits.
4. If current is behind: prints current, latest, a short excerpt of the
   release notes, and the exact recipe to run the update manually:

   ```
   cd <path-to-Recall> && ./update.sh
   ```

## Why not auto-run?

`update.sh` pulls, rebuilds, migrates the DB, and re-registers hooks.
If Claude Code is currently attached to this session, rebuilding the
`mem` binary mid-session can leave the running hook scripts in a
half-updated state. The safe sequence is: exit Claude Code →
`./update.sh` → restart Claude Code.

## Rate-limit fallback

GitHub's unauthenticated rate limit is 60 requests/hour per IP. If you
hit it, the command prints a graceful fallback pointing at the releases
page: <https://github.com/edheltzel/Recall/releases>.

## Steps for you

Run these steps to perform the check and produce the recipe. Prefer
running the Recall-shipped helper (`./update.sh --check`) if the source
directory is locatable — it implements all of the logic below.

1. **Locate the source directory.** Resolve the symlink target of the
   `mem` binary and strip `/dist/index.js` to get the Recall checkout:
   ```bash
   readlink -f "$(which mem)" | sed 's|/dist/index.js$||'
   ```
   Call this `RECALL_SRC`.

2. **Run the check helper.** If `$RECALL_SRC/update.sh` exists, delegate
   to it — it prints the exact recipe on its own:
   ```bash
   cd "$RECALL_SRC" && ./update.sh --check
   ```
   Its output already includes the "cd ... && ./update.sh" line. Relay
   it to the user and stop.

3. **Manual path** (if `update.sh` is not present on older installs):
   - Capture the current version:
     ```bash
     mem --version
     ```
   - Fetch the latest release tag + body:
     ```bash
     curl -sf https://api.github.com/repos/edheltzel/Recall/releases/latest
     ```
     Parse JSON with `jq -r .tag_name` and `jq -r .body` (or with `bun -e`
     if `jq` is not available).
   - Compare versions (strip leading `v`). Present the result as:
     ```
     Current: vX.Y.Z
     Latest:  vA.B.C

     Release notes (excerpt):
     <first ~10 lines of body>

     To apply:
       cd <RECALL_SRC> && ./update.sh
     ```

4. **Do not** run `./update.sh` on the user's behalf. Stop at printing
   the recipe. The user runs it themselves after exiting Claude Code.

$@
