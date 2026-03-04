import { describe, test, expect } from 'bun:test';
import { VERSION, DISPLAY_NAME } from '../src/version';

describe('VERSION', () => {
  test('matches semver pattern X.Y.Z', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('equals the current package.json version', () => {
    expect(VERSION).toBe('4.1.0');
  });
});

describe('DISPLAY_NAME', () => {
  test('starts with "Recall"', () => {
    expect(DISPLAY_NAME.startsWith('Recall')).toBe(true);
  });

  test('contains the major.minor version derived from VERSION', () => {
    const majorMinor = VERSION.split('.').slice(0, 2).join('.');
    expect(DISPLAY_NAME).toContain(majorMinor);
  });
});
