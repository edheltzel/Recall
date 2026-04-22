// Encode a cwd to the folder name Claude Code uses under ~/.claude/projects/.
// CC folder names only contain [a-zA-Z0-9-]; every other character — slash,
// underscore, dot, space, tilde, plus, Unicode — is replaced with "-". A
// narrower rule (e.g. only "/" and "_") fails silently for worktree paths,
// dotfile roots, and iCloud paths with spaces.
export function encodeProjectDir(cwd: string): string {
  return '-' + cwd.replace(/^\//, '').replace(/[^a-zA-Z0-9-]/g, '-');
}
