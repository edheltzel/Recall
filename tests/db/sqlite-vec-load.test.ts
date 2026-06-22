import { describe, test, expect, afterEach } from 'bun:test';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { isVecAvailable } from '../../src/db/vec';

// Explicit native-load proof (issue #148, AC). This file is run as a focused
// step on the ubuntu-latest CI leg (which otherwise only lints + builds) to
// confirm Bun's bundled SQLite loads sqlite-vec natively on Linux. On macOS the
// load is best-effort (auto-detected Homebrew libsqlite3) so the assertion is
// platform-aware: required on Linux, best-effort elsewhere.
describe('sqlite-vec extension load (issue #148)', () => {
  afterEach(() => teardownTestDb());

  test('loads natively on Linux; best-effort on macOS', () => {
    setupTestDb(); // initDb() attempts the extension load on open

    if (process.platform === 'linux') {
      expect(isVecAvailable()).toBe(true);
    } else {
      // macOS/other: may or may not have an extension-capable libsqlite3.
      // Either way the call must be safe and never crash.
      expect(typeof isVecAvailable()).toBe('boolean');
    }
  });
});
