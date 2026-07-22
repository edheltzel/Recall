// Encode a cwd to the folder name Claude Code uses under ~/.claude/projects/.
// Claude folder names only contain [a-zA-Z0-9-]; every other character is
// replaced with "-".
export function encodeProjectDir(cwd: string): string {
  return '-' + cwd.replace(/^\//, '').replace(/[^a-zA-Z0-9-]/g, '-');
}
