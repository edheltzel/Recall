import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
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
  if [[ ! -f "$file" ]]; then
    echo "no crontab for test-user" >&2
    exit 1
  fi
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

function installDurableRunner(home: string): void {
  const bunBin = join(home, '.bun', 'bin');
  const runner = join(home, '.bun', 'install', 'global', 'node_modules', 'recall-memory', 'dist', 'index.js');
  mkdirSync(bunBin, { recursive: true });
  mkdirSync(join(runner, '..'), { recursive: true });
  writeFileSync(join(bunBin, 'bun'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(runner, '#!/usr/bin/env bun\n', { mode: 0o755 });
  symlinkSync(runner, join(bunBin, 'recall'));
}

function runLib(
  home: string,
  recallDir: string,
  pathDir: string,
  body: string,
  extraEnv: NodeJS.ProcessEnv = {},
) {
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
        RECALL_DB_PATH: '',
        MEM_DB_PATH: '',
        ...extraEnv,
      },
    },
  );
}

describe('quarterly age cron', () => {
  test('plan reports each lifecycle action, schedule, and command without writing', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-age-plan-'));
    try {
      const home = join(root, 'home');
      const bin = join(root, 'bin');
      const cronFile = join(root, 'cron');
      const userLine = '15 2 * * * /usr/bin/true # user\n';
      const managedLine = `0 3 1 1,4,7,10 * /bin/true ${MARKER}\n`;
      mkdirSync(home, { recursive: true });
      cronStub(bin, cronFile);

      const cases = [
        { mode: 'install', cron: userLine, action: 'add' },
        { mode: 'install', cron: userLine + managedLine, action: 'refresh' },
        { mode: 'refresh', cron: userLine + managedLine, action: 'refresh' },
        { mode: 'remove', cron: userLine + managedLine, action: 'remove' },
        { mode: 'refresh', cron: userLine, action: 'not scheduled' },
      ];
      for (const plan of cases) {
        writeFileSync(cronFile, plan.cron);
        const result = runLib(
          home,
          join(home, '.agents', 'Recall'),
          bin,
          `recall_print_age_cron_plan ${plan.mode}`,
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(`Quarterly aging cron: ${plan.action}`);
        expect(result.stdout).toContain('Schedule: 0 3 1 1,4,7,10 * | Command: recall age --execute');
        expect(readFileSync(cronFile, 'utf-8')).toBe(plan.cron);
      }

      writeFileSync(
        join(bin, 'crontab'),
        '#!/bin/sh\necho "permission denied" >&2\nexit 2\n',
        { mode: 0o755 },
      );
      const kept = runLib(
        home,
        join(home, '.agents', 'Recall'),
        bin,
        'recall_print_age_cron_plan install',
      );
      expect(kept.status).toBe(0);
      expect(kept.stdout).toContain('Quarterly aging cron: keep');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('install adds one managed line, keeps others, and does not duplicate', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-age-cron-'));
    try {
      const home = join(root, 'home');
      const recallDir = join(home, '.agents', 'Recall');
      const bin = join(root, 'bin');
      const cronFile = join(root, 'cron');
      mkdirSync(home, { recursive: true });
      installDurableRunner(home);
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

  test('install flag removes the schedule and a later install restores it', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-age-skip-'));
    try {
      const home = join(root, 'home');
      const bin = join(root, 'bin');
      const cronFile = join(root, 'cron');
      mkdirSync(home, { recursive: true });
      installDurableRunner(home);
      const managed = `0 3 1 1,4,7,10 * RECALL_DB_PATH='/stored/recall.db' '/old/bun' '/old/recall' age --execute >> '/old/age.log' 2>&1 ${MARKER}\n`;
      writeFileSync(cronFile, `15 2 * * * /usr/bin/true # user\n${managed}`);
      cronStub(bin, cronFile);
      const trap = join(root, 'trap.sh');
      writeFileSync(
        trap,
        'trap \'if [[ "$BASH_COMMAND" == "do_install" ]]; then trap - DEBUG; configure_age_cron; exit 0; fi\' DEBUG\n',
      );
      const env = {
        ...process.env,
        BASH_ENV: trap,
        NO_COLOR: '1',
        HOME: home,
        RECALL_DIR: join(home, '.agents', 'Recall'),
        RECALL_CRONTAB_BIN: join(bin, 'crontab'),
        PATH: `${bin}:/usr/bin:/bin`,
        SKIP_AGE_CRON: '',
      };
      const flagged = spawnSync('bash', [INSTALL, '--skip-age-cron', '--yes'], {
        encoding: 'utf-8',
        cwd: REPO,
        env,
      });
      expect(flagged.status).toBe(0);
      expect(flagged.stdout).toContain('disabled; removed the existing managed schedule');
      expect(readFileSync(cronFile, 'utf-8')).toBe('15 2 * * * /usr/bin/true # user\n');

      const unflagged = spawnSync('bash', [INSTALL, '--yes'], {
        encoding: 'utf-8',
        cwd: REPO,
        env,
      });
      expect(unflagged.status).toBe(0);
      expect(unflagged.stdout).toContain('Quarterly aging: scheduled');
      expect(readFileSync(cronFile, 'utf-8')).toContain(MARKER);
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
      installDurableRunner(home);
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
      installDurableRunner(home);
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
      installDurableRunner(home);
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
      installDurableRunner(home);
      const r = spawnSync('/bin/bash', ['-c', `set -euo pipefail\nsource ${JSON.stringify(LIB)}\nrecall_install_age_cron`], {
        encoding: 'utf-8',
        cwd: REPO,
        env: {
          ...process.env,
          HOME: home,
          RECALL_DIR: join(home, '.agents', 'Recall'),
          PATH: `${bin}:/usr/bin:/bin`,
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

  for (const dbEnv of ['RECALL_DB_PATH', 'MEM_DB_PATH'] as const) {
    for (const mode of ['install', 'refresh'] as const) {
      test(`${mode} preserves a custom database selected through ${dbEnv}`, () => {
        const root = mkdtempSync(join(tmpdir(), 'recall-age-db-'));
        try {
          const home = join(root, 'home');
          const bin = join(root, 'bin');
          const cronFile = join(root, 'cron');
          const customDb = join(root, 'custom data', 'recall.db');
          mkdirSync(home, { recursive: true });
          installDurableRunner(home);
          cronStub(bin, cronFile);
          if (mode === 'refresh') {
            writeFileSync(cronFile, `0 3 1 1,4,7,10 * /old/recall age --execute ${MARKER}\n`);
          }

          const result = runLib(
            home,
            join(home, '.agents', 'Recall'),
            bin,
            mode === 'install' ? 'recall_install_age_cron' : 'recall_refresh_age_cron',
            {
              RECALL_DB_PATH: dbEnv === 'RECALL_DB_PATH' ? customDb : '',
              MEM_DB_PATH: dbEnv === 'MEM_DB_PATH' ? customDb : '',
            },
          );

          expect(result.status).toBe(0);
          const line = readFileSync(cronFile, 'utf-8');
          expect(line).toContain(`RECALL_DB_PATH='${customDb}'`);
          expect(line).not.toContain('MEM_DB_PATH=');
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }

  test('refresh keeps the stored database when no override is supplied', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-age-db-refresh-'));
    try {
      const home = join(root, 'home');
      const bin = join(root, 'bin');
      const cronFile = join(root, 'cron');
      const customDb = join(root, 'custom data', 'recall.db');
      const recallDir = join(home, '.agents', 'Recall');
      mkdirSync(home, { recursive: true });
      installDurableRunner(home);
      cronStub(bin, cronFile);

      const installed = runLib(home, recallDir, bin, 'recall_install_age_cron', {
        RECALL_DB_PATH: customDb,
      });
      expect(installed.status).toBe(0);

      const moved = join(home, 'moved-recall');
      const refreshed = runLib(home, moved, bin, 'recall_refresh_age_cron');
      expect(refreshed.status).toBe(0);

      const line = readFileSync(cronFile, 'utf-8');
      expect(line).toContain(`${moved}/logs/age.log`);
      expect(line).toContain(`RECALL_DB_PATH='${customDb}'`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('cron rejects unsafe paths without changing state', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-age-unsafe-'));
    try {
      const home = join(root, 'home');
      const bin = join(root, 'bin');
      const cronFile = join(root, 'cron');
      const original = '15 2 * * * /usr/bin/true # user\n';
      mkdirSync(home, { recursive: true });
      installDurableRunner(home);
      cronStub(bin, cronFile);

      const unsafePaths = [
        join(root, 'bad%path', 'recall.db'),
        join(root, 'bad\\path', 'recall.db'),
        join(root, "bad'path", 'recall.db'),
        join(root, 'bad\tpath', 'recall.db'),
        join(root, 'bad\npath', 'recall.db'),
        `${join(root, 'trailing-newline', 'recall.db')}\n`,
      ];
      for (const unsafePath of unsafePaths) {
        writeFileSync(cronFile, original);
        const result = runLib(
          home,
          join(home, '.agents', 'Recall'),
          bin,
          'recall_install_age_cron\nrecall_print_age_cron_notice',
          { RECALL_DB_PATH: unsafePath },
        );
        expect(result.status).toBe(0);
        expect(readFileSync(cronFile, 'utf-8')).toBe(original);
        expect(result.stdout).toContain('NOT scheduled or changed because a path cannot be safely written to crontab');
        expect(result.stdout).toContain('Schedule it manually with: crontab -e');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('source checkout runner is scheduled', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-age-source-'));
    try {
      const home = join(root, 'home');
      const bin = join(root, 'bin');
      const repo = join(root, 'Recall');
      const runner = join(repo, 'dist', 'index.js');
      const cronFile = join(root, 'cron');
      mkdirSync(join(home, '.bun', 'bin'), { recursive: true });
      mkdirSync(join(repo, '.git'), { recursive: true });
      mkdirSync(join(repo, 'dist'), { recursive: true });
      writeFileSync(join(home, '.bun', 'bin', 'bun'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      writeFileSync(runner, '#!/usr/bin/env bun\n', { mode: 0o755 });
      symlinkSync(runner, join(home, '.bun', 'bin', 'recall'));
      cronStub(bin, cronFile);

      const result = runLib(
        home,
        join(home, '.agents', 'Recall'),
        bin,
        'recall_install_age_cron',
        { RECALL_REPO_DIR: repo },
      );

      expect(result.status).toBe(0);
      expect(readFileSync(cronFile, 'utf-8')).toContain(runner);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ephemeral recall runner is not scheduled and prints the retry command', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-age-ephemeral-'));
    try {
      const home = join(root, 'home');
      const bin = join(root, 'bin');
      const cronFile = join(root, 'cron');
      mkdirSync(home, { recursive: true });
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, 'recall'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      writeFileSync(join(bin, 'bun'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      writeFileSync(cronFile, '15 2 * * * /usr/bin/true # user\n');
      cronStub(bin, cronFile);

      const result = runLib(
        home,
        join(home, '.agents', 'Recall'),
        bin,
        'recall_install_age_cron\nrecall_print_age_cron_notice',
      );

      expect(result.status).toBe(0);
      expect(readFileSync(cronFile, 'utf-8')).not.toContain(MARKER);
      expect(result.stdout).toContain('NOT scheduled');
      expect(result.stdout).toContain('recall install');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ephemeral runner keeps and accurately reports an existing schedule', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-age-ephemeral-existing-'));
    try {
      const home = join(root, 'home');
      const bin = join(root, 'bin');
      const cronFile = join(root, 'cron');
      mkdirSync(home, { recursive: true });
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, 'recall'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      writeFileSync(join(bin, 'bun'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const original = `15 2 * * * /usr/bin/true # user\n0 3 1 1,4,7,10 * RECALL_DB_PATH=/stored/recall.db /old/bun /old/recall age --execute >> /old/age.log 2>&1 ${MARKER}\n`;
      writeFileSync(cronFile, original);
      cronStub(bin, cronFile);

      const result = runLib(
        home,
        join(home, '.agents', 'Recall'),
        bin,
        'recall_install_age_cron\nrecall_print_age_cron_notice\nrecall_refresh_age_cron\nrecall_print_age_cron_notice',
      );

      expect(result.status).toBe(0);
      expect(readFileSync(cronFile, 'utf-8')).toBe(original);
      expect(result.stdout.match(/Existing quarterly schedule kept unchanged/g)).toHaveLength(2);
      expect(result.stdout).not.toContain('NOT scheduled');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('crontab read errors preserve state for every lifecycle mode', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-age-read-error-'));
    try {
      const home = join(root, 'home');
      const bin = join(root, 'bin');
      const cronFile = join(root, 'cron');
      const writeMarker = join(root, 'write-attempted');
      mkdirSync(home, { recursive: true });
      mkdirSync(bin, { recursive: true });
      installDurableRunner(home);
      writeFileSync(cronFile, '15 2 * * * /usr/bin/true # user\n');
      writeFileSync(
        join(bin, 'crontab'),
        `#!/bin/sh
if [ "\${1:-}" = "-l" ]; then
  echo "permission denied" >&2
  exit 2
fi
echo attempted > ${JSON.stringify(writeMarker)}
exit 2
`,
        { mode: 0o755 },
      );
      const before = readFileSync(cronFile, 'utf-8');

      const result = runLib(
        home,
        join(home, '.agents', 'Recall'),
        bin,
        'recall_install_age_cron\nrecall_refresh_age_cron\nrecall_remove_age_cron',
      );

      expect(result.status).toBe(0);
      expect(readFileSync(cronFile, 'utf-8')).toBe(before);
      expect(existsSync(writeMarker)).toBe(false);
      expect(result.stdout).toContain('Could not read crontab');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('crontab write errors preserve state and remain nonfatal', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-age-write-error-'));
    try {
      const home = join(root, 'home');
      const bin = join(root, 'bin');
      const cronFile = join(root, 'cron');
      mkdirSync(home, { recursive: true });
      mkdirSync(bin, { recursive: true });
      installDurableRunner(home);
      writeFileSync(cronFile, '15 2 * * * /usr/bin/true # user\n');
      writeFileSync(
        join(bin, 'crontab'),
        `#!/bin/sh
if [ "\${1:-}" = "-l" ]; then
  cat ${JSON.stringify(cronFile)}
  exit 0
fi
cat >/dev/null
echo "permission denied" >&2
exit 2
`,
        { mode: 0o755 },
      );
      const before = readFileSync(cronFile, 'utf-8');

      const result = runLib(
        home,
        join(home, '.agents', 'Recall'),
        bin,
        'recall_install_age_cron\nrecall_print_age_cron_notice',
      );

      expect(result.status).toBe(0);
      expect(readFileSync(cronFile, 'utf-8')).toBe(before);
      expect(result.stdout).toContain('Could not update crontab');
      expect(result.stdout).toContain('Schedule unchanged');
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
