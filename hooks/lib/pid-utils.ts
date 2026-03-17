// Shared PID utilities for extraction hooks — self-contained, no imports from src/

/**
 * Check if a PID is still alive using signal 0.
 * Returns true if process is running or we lack permission to check (EPERM).
 * Returns false if process does not exist (ESRCH).
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'EPERM') return true;
    return false;
  }
}
