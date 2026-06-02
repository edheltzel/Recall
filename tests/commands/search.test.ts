import { describe, test, expect, afterEach } from 'bun:test';
import { runSearch } from '../../src/commands/search.js';

describe('runSearch --bias-type guard', () => {
  const originalError = console.error;
  const originalExitCode = process.exitCode;

  afterEach(() => {
    console.error = originalError;
    process.exitCode = originalExitCode;
  });

  test('rejects an invalid bias-type before searching', () => {
    let errorOutput = '';
    console.error = (msg?: unknown) => {
      errorOutput += String(msg);
    };

    runSearch('anything', { biasType: 'decsion' });

    expect(errorOutput).toContain('Invalid --bias-type "decsion"');
    expect(errorOutput).toContain('messages, loa, decisions, learnings, breadcrumbs');
    expect(process.exitCode).toBe(1);
  });
});
