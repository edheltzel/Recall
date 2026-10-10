import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO = process.cwd();
const LIB = join(REPO, 'lib', 'install-lib.sh');
const INSTALL = join(REPO, 'packaging', 'install.sh');
const MARKER = '# recall-memory: quarterly age';

function cronStub(binDir: string, file: string): void {
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, 'crontab'),
    `#!/bin/bash
file=${JSON.stringify(file)}
if [[ "\${1:-}" == "-l" ]]; then
  [[ -f "$file" ]] || exit 1
  cat "$file"
  exit 0
fi
cat > "$file"
exit 0
`,
    { mode: 0o755 },
  );
  chmodSync(join(binDir, 'crontab'), 0o755);
}

function runLib(home: string, recallDir: string, pathDir: string, body: string) {
  return spawnSync(
    'bash',
    ['-c', `set -euo pipefail\nsource ${JSON.stringify(LIB)}\n${body}`],
    {
      encoding: 'utf-8',
      cwd: REPO,
      env: {
        ...process.env,
        HOME: home,
        RECALL_DIR: recallDir,
        PATH: `${pathDir}:/usr/bin:/bin`,
        RECALL_CRONTAB_BIN: join(pathDir, 'crontab'),
        NO_COLOR: '1',
        DRY_RUN: '',
        SKIP_AGE_CRON: '',
      },
    },
  );
}

describe('quarterly age cron', () => {
  test('install adds one managed line, keeps others, and does not duplicate', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-age-cron-'));
    try {
      const home = join(root, 'home');
      const recallDir = join(home, '.agents', 'Recall');
      const bin = join(root, 'bin');
      const cronFile = join(root, 'cron');
      mkdirSync(home, { recursive: true });
      mkdirSync(join(home, '.bun', 'bin'), { recursive: true });
      writeFileSync(join(home, '.bun', 'bin', 'bun'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      writeFileSync(join(home, '.bun', 'bin', 'recall'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      writeFileSync(cronFile, '15 2 * * * /usr/bin/true # user\n');
      cronStub(bin, cronFile);

      const first = runLib(home, recallDir, bin, 'recall_install_age_cron');
      expect(first.status).toBe(0);
      const lines = readFileSync(cronFile, 'utf-8').trim().split('\n');
      expect(lines.filter((line) => line.includes(MARKER))).toHaveLength(1);
      expect(lines.some((line) => line.includes('/usr/bin/true'))).toBe(true);
      expect(lines.some((line) => line.startsWith('0 3 1 1,4,7,10 *'))).toBe(true);
      expect(lines.some((line) => line.includes('age --execute'))).toBe(true);
      expect(lines.some((line) => line.includes(`${recallDir}/logs/age.log`))).toBe(true);

      const second = runLib(home, recallDir, bin, 'recall_install_age_cron');
      expect(second.status).toBe(0);
      const again = readFileSync(cronFile, 'utf-8').trim().split('\n');
      expect(again.filter((line) => line.includes(MARKER))).toHaveLength(1);
      expect(again.some((line) => line.includes('/usr/bin/true'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('skip flag adds nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-age-skip-'));
    try {
      const home = join(root, 'home');
      const bin = join(root, 'bin');
      const cronFile = join(root, 'cron');
      mkdirSync(home, { recursive: true });
      writeFileSync(cronFile, '15 2 * * * /usr/bin/true # user\n');
      cronStub(bin, cronFile);
      const before = readFileSync(cronFile, 'utf-8');
      const r = runLib(
        home,
        join(home, '.agents', 'Recall'),
        bin,
        'SKIP_AGE_CRON=true recall_install_age_cron',
      );
      expect(r.status).toBe(0);
      expect(readFileSync(cronFile, 'utf-8')).toBe(before);

      const trap = join(root, 'trap.sh');
      writeFileSync(
        trap,
        'trap \'if [[ "$BASH_COMMAND" == "do_install" ]]; then printf "SKIP=%s\\n" "${SKIP_AGE_CRON:-}"; exit 0; fi\' DEBUG\n',
      );
      const flagged = spawnSync('bash', [INSTALL, '--skip-age-cron', '--yes'], {
        encoding: 'utf-8',
        cwd: REPO,
        env: { ...process.env, BASH_ENV: trap, NO_COLOR: '1', HOME: home },
      });
      expect(flagged.status).toBe(0);
      expect(flagged.stdout).toContain('SKIP=true');
      expect(readFileSync(cronFile, 'utf-8')).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('uninstall removes only the managed line', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-age-rm-'));
    try {
      const home = join(root, 'home');
      const bin = join(root, 'bin');
      const cronFile = join(root, 'cron');
      mkdirSync(home, { recursive: true });
      writeFileSync(cronFile, '15 2 * * * /usr/bin/true # user\n');
      cronStub(bin, cronFile);
      const recallDir = join(home, '.agents', 'Recall');
      runLib(home, recallDir, bin, 'recall_install_age_cron');
      const removed = runLib(home, recallDir, bin, 'recall_remove_age_cron');
      expect(removed.status).toBe(0);
      const left = readFileSync(cronFile, 'utf-8');
      expect(left).not.toContain(MARKER);
      expect(left).toContain('/usr/bin/true');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refresh updates an existing line and does not add a missing one', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-age-refresh-'));
    try {
      const home = join(root, 'home');
      const bin = join(root, 'bin');
      const cronFile = join(root, 'cron');
      mkdirSync(join(home, '.bun', 'bin'), { recursive: true });
      writeFileSync(join(home, '.bun', 'bin', 'bun'), '#!/bin/sh\n', { mode: 0o755 });
      writeFileSync(join(home, '.bun', 'bin', 'recall'), '#!/bin/sh\n', { mode: 0o755 });
      writeFileSync(cronFile, '15 2 * * * /usr/bin/true # user\n');
      cronStub(bin, cronFile);
      const recallDir = join(home, '.agents', 'Recall');
      const absent = runLib(home, recallDir, bin, 'recall_refresh_age_cron');
      expect(absent.status).toBe(0);
      expect(readFileSync(cronFile, 'utf-8')).not.toContain(MARKER);

      runLib(home, recallDir, bin, 'recall_install_age_cron');
      const moved = join(home, 'moved-recall');
      mkdirSync(moved, { recursive: true });
      const refreshed = runLib(
        home,
        join(moved, 'Recall'),
        bin,
        'recall_refresh_age_cron',
      );
      expect(refreshed.status).toBe(0);
      const text = readFileSync(cronFile, 'utf-8');
      expect(text.split('\n').filter((line) => line.includes(MARKER))).toHaveLength(1);
      expect(text).toContain(`${moved}/Recall/logs/age.log`);
      expect(text).toContain('/usr/bin/true');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('dry-run prints the line and does not write', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-age-dry-'));
    try {
      const home = join(root, 'home');
      const bin = join(root, 'bin');
      const cronFile = join(root, 'cron');
      mkdirSync(home, { recursive: true });
      writeFileSync(cronFile, '15 2 * * * /usr/bin/true # user\n');
      cronStub(bin, cronFile);
      const before = readFileSync(cronFile, 'utf-8');
      const r = runLib(home, join(home, '.agents', 'Recall'), bin, 'DRY_RUN=true recall_install_age_cron');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('[dry-run]');
      expect(r.stdout).toContain(MARKER);
      expect(readFileSync(cronFile, 'utf-8')).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('missing crontab warns and exits 0', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-age-nocron-'));
    try {
      const home = join(root, 'home');
      const bin = join(root, 'bin');
      mkdirSync(bin, { recursive: true });
      mkdirSync(home, { recursive: true });
      const r = spawnSync('/bin/bash', ['-c', `set -euo pipefail\nsource ${JSON.stringify(LIB)}\nrecall_install_age_cron`], {
        encoding: 'utf-8',
        cwd: REPO,
        env: {
          ...process.env,
          HOME: home,
          RECALL_DIR: join(home, '.agents', 'Recall'),
          PATH: bin,
          RECALL_CRONTAB_BIN: join(bin, 'missing-crontab'),
          NO_COLOR: '1',
        },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('crontab not found');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('sandbox HOME does not call a PATH crontab without RECALL_CRONTAB_BIN', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-age-sandbox-'));
    try {
      const home = join(root, 'home');
      const bin = join(root, 'bin');
      const called = join(root, 'called');
      mkdirSync(home, { recursive: true });
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, 'crontab'), `#!/bin/sh\necho called >> ${JSON.stringify(called)}\nexit 0\n`, { mode: 0o755 });
      const env = { ...process.env, HOME: home, RECALL_DIR: join(home, '.agents', 'Recall'), PATH: `${bin}:/usr/bin:/bin`, NO_COLOR: '1' };
      delete env.RECALL_CRONTAB_BIN;
      const r = spawnSync('/bin/bash', ['-c', `set -euo pipefail\nsource ${JSON.stringify(LIB)}\nrecall_install_age_cron\nrecall_refresh_age_cron\nrecall_remove_age_cron`], {
        encoding: 'utf-8',
        cwd: REPO,
        env,
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Skipping quarterly age cron');
      expect(existsSync(called)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
