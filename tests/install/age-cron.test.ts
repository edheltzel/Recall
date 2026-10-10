import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

const REPO = process.cwd();
const LIB = join(REPO, 'lib', 'install-lib.sh');
const INSTALL = join(REPO, 'packaging', 'install.sh');
const MARKER = '# recall-memory: quarterly age';

function bunStub(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'bun'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
}

function cronStub(binDir: string, file: string, rejectRestore = false): void {
  bunStub(binDir);
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
content="$(cat; printf .)"
content="\${content%.}"
if [[ -n "$content" && "$content" != *$'\\n' ]]; then
  echo "missing final newline" >&2
  exit 2
fi
if ${rejectRestore} && [[ -f "$file.written" ]]; then
  echo "restore denied" >&2
  exit 2
fi
printf '%s' "$content" > "$file"
touch "$file.written"
exit 0
`,
    { mode: 0o755 },
  );
}

function durablePackage(root: string, home: string): { repo: string; runner: string; stale: string } {
  const repo = join(root, 'pkg');
  const runner = join(repo, 'dist', 'index.js');
  const stale = join(home, '.bun', 'install', 'global', 'node_modules', 'recall-memory', 'dist', 'index.js');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(runner, '..'), { recursive: true });
  mkdirSync(join(stale, '..'), { recursive: true });
  writeFileSync(runner, '#!/usr/bin/env bun\n', { mode: 0o755 });
  writeFileSync(stale, '#!/usr/bin/env bun\nstale\n', { mode: 0o755 });
  const bunBin = join(home, '.bun', 'bin');
  mkdirSync(bunBin, { recursive: true });
  symlinkSync(stale, join(bunBin, 'recall'));
  return { repo, runner, stale };
}

function wrapper(recallDir: string): string {
  return join(recallDir, 'shared', 'age-quarterly.sh');
}

function fixedLine(recallDir: string): string {
  return `0 3 1 1,4,7,10 * /bin/sh '${recallDir}/shared/age-quarterly.sh' ${MARKER}`;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function expectedScript(db: string, bun: string, runner: string, log: string): string {
  return `#!/bin/sh\nexport RECALL_DB_PATH=${quote(db)}\nexec ${quote(bun)} ${quote(runner)} age --execute >> ${quote(log)} 2>&1\n`;
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
        CLAUDE_DIR: join(home, '.claude'),
        RECALL_DIR: recallDir,
        RECALL_REPO_DIR: join(home, 'not-durable'),
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

function planAction(stdout: string): string {
  const line = stdout.split('\n').find((entry) => entry.startsWith('Quarterly aging cron: '));
  return line?.slice('Quarterly aging cron: '.length) ?? '';
}

describe('quarterly age cron', () => {
  test('install writes the fixed line and the installing package, not a stale global', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-age-cron-'));
    try {
      const home = join(root, 'home');
      const recallDir = join(home, 'Recall Data');
      const bin = join(root, 'bin');
      const cronFile = join(root, 'cron');
      const pkg = durablePackage(root, home);
      mkdirSync(home, { recursive: true });
      writeFileSync(cronFile, '15 2 * * * /usr/bin/true # user\n');
      cronStub(bin, cronFile);

      const first = runLib(home, recallDir, bin, 'recall_install_age_cron', { RECALL_REPO_DIR: pkg.repo });
      expect(first.status).toBe(0);
      const cron = readFileSync(cronFile, 'utf-8');
      const lines = cron.trim().split('\n');
      expect(lines.filter((line) => line.includes(MARKER))).toEqual([fixedLine(recallDir)]);
      expect(lines[0]).toBe('15 2 * * * /usr/bin/true # user');
      expect(cron).not.toContain(pkg.runner);
      expect(cron).not.toContain(pkg.stale);
      const script = readFileSync(wrapper(recallDir), 'utf-8');
      expect(script).toBe(expectedScript(
        join(recallDir, 'recall.db'),
        join(bin, 'bun'),
        pkg.runner,
        join(recallDir, 'logs', 'age.log'),
      ));
      expect(script).not.toContain(pkg.stale);
      expect(statSync(wrapper(recallDir)).mode & 0o777).toBe(0o700);

      const second = runLib(home, recallDir, bin, 'recall_install_age_cron', { RECALL_REPO_DIR: pkg.repo });
      expect(second.status).toBe(0);
      expect(readFileSync(cronFile, 'utf-8').trim().split('\n').filter((line) => line.includes(MARKER))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('script quoting keeps a space, a quote, and a percent in the database path', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-age-quote-'));
    try {
      const home = join(root, 'home');
      const recallDir = join(home, '.agents', 'Recall');
      const bin = join(root, 'bin');
      const cronFile = join(root, 'cron');
      const pkg = durablePackage(root, home);
      const databases = [
        join(root, 'custom data', 'recall.db'),
        join(root, "bad'path", 'recall.db'),
        join(root, 'bad%path', 'recall.db'),
      ];
      mkdirSync(home, { recursive: true });
      cronStub(bin, cronFile);
      for (const db of databases) {
        writeFileSync(cronFile, '15 2 * * * /usr/bin/true # user\n');
        rmSync(wrapper(recallDir), { force: true });
        const result = runLib(home, recallDir, bin, 'recall_install_age_cron', {
          RECALL_REPO_DIR: pkg.repo,
          RECALL_DB_PATH: db,
        });
        expect(result.status).toBe(0);
        expect(readFileSync(cronFile, 'utf-8')).toContain(fixedLine(recallDir));
        expect(readFileSync(cronFile, 'utf-8')).not.toContain(db);
        expect(readFileSync(wrapper(recallDir), 'utf-8')).toBe(expectedScript(
          db,
          join(bin, 'bun'),
          pkg.runner,
          join(recallDir, 'logs', 'age.log'),
        ));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refresh replaces the marked line in place and keeps CRON_TZ above it', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-age-tz-'));
    try {
      const home = join(root, 'home');
      const recallDir = join(home, '.agents', 'Recall');
      const bin = join(root, 'bin');
      const cronFile = join(root, 'cron');
      const pkg = durablePackage(root, home);
      mkdirSync(home, { recursive: true });
      writeFileSync(
        cronFile,
        `CRON_TZ=America/New_York\n0 3 1 1,4,7,10 * /bin/true ${MARKER}\n15 2 * * * /usr/bin/true # user\n`,
      );
      cronStub(bin, cronFile);

      const result = runLib(home, recallDir, bin, 'recall_refresh_age_cron', { RECALL_REPO_DIR: pkg.repo });
      expect(result.status).toBe(0);
      expect(readFileSync(cronFile, 'utf-8').split('\n')).toEqual([
        'CRON_TZ=America/New_York',
        fixedLine(recallDir),
        '15 2 * * * /usr/bin/true # user',
        '',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('preview matches apply for every action', () => {
    const cases = [
      { name: 'add', mode: 'install', cron: '15 2 * * * /usr/bin/true # user\n', durable: true, action: 'add' },
      { name: 'refresh', mode: 'install', cron: `CRON_TZ=UTC\n0 3 1 1,4,7,10 * /bin/true ${MARKER}\n15 2 * * * /usr/bin/true # user\n`, durable: true, action: 'refresh' },
      { name: 'keep', mode: 'install', cron: `15 2 * * * /usr/bin/true # user\n0 3 1 1,4,7,10 * /bin/true ${MARKER}\n`, durable: false, action: 'keep' },
      { name: 'remove', mode: 'remove', cron: `15 2 * * * /usr/bin/true # user\n0 3 1 1,4,7,10 * /bin/true ${MARKER}\n`, durable: true, action: 'remove', seedScript: true },
      { name: 'not-scheduled', mode: 'install', cron: '15 2 * * * /usr/bin/true # user\n', durable: false, action: 'not scheduled' },
      { name: 'refresh-absent', mode: 'refresh', cron: '15 2 * * * /usr/bin/true # user\n', durable: true, action: 'not scheduled' },
    ] as const;
    for (const plan of cases) {
      const root = mkdtempSync(join(tmpdir(), `recall-age-plan-${plan.name}-`));
      try {
        const home = join(root, 'home');
        const recallDir = join(home, '.agents', 'Recall');
        const bin = join(root, 'bin');
        const cronFile = join(root, 'cron');
        const pkg = durablePackage(root, home);
        mkdirSync(home, { recursive: true });
        writeFileSync(cronFile, plan.cron);
        cronStub(bin, cronFile);
        if ('seedScript' in plan) {
          mkdirSync(join(recallDir, 'shared'), { recursive: true });
          writeFileSync(wrapper(recallDir), '#!/bin/sh\nexport RECALL_DB_PATH=\'/old\'\n', { mode: 0o700 });
        }
        const env = { RECALL_REPO_DIR: plan.durable ? pkg.repo : join(home, 'not-durable') };
        const body = plan.mode === 'install'
          ? 'recall_install_age_cron'
          : plan.mode === 'refresh'
            ? 'recall_refresh_age_cron'
            : 'recall_remove_age_cron';
        const preview = runLib(home, recallDir, bin, `recall_print_age_cron_plan ${plan.mode}`, env);
        expect(preview.status).toBe(0);
        expect(planAction(preview.stdout)).toBe(plan.action);
        expect(readFileSync(cronFile, 'utf-8')).toBe(plan.cron);

        const applied = runLib(home, recallDir, bin, body, env);
        expect(applied.status).toBe(0);
        const after = readFileSync(cronFile, 'utf-8');
        if (plan.action === 'add' || plan.action === 'refresh') {
          expect(after).toContain(fixedLine(recallDir));
          expect(existsSync(wrapper(recallDir))).toBe(true);
          if (plan.action === 'refresh') expect(after.startsWith('CRON_TZ=UTC\n')).toBe(true);
        } else if (plan.action === 'remove') {
          expect(after).not.toContain(MARKER);
          expect(after).toContain('/usr/bin/true');
          expect(existsSync(wrapper(recallDir))).toBe(false);
        } else {
          expect(after).toBe(plan.cron);
          if (!('seedScript' in plan)) expect(existsSync(wrapper(recallDir))).toBe(false);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('preview accounts for a source build while apply requires the runner', () => {
    const cases = [
      { mode: 'install', scheduled: false, packaged: false, action: 'add' },
      { mode: 'install', scheduled: true, packaged: false, action: 'refresh' },
      { mode: 'refresh', scheduled: true, packaged: false, action: 'refresh' },
      { mode: 'install', scheduled: false, packaged: true, action: 'not scheduled' },
      { mode: 'install', scheduled: true, packaged: true, action: 'keep' },
    ];
    for (const plan of cases) {
      const root = mkdtempSync(join(tmpdir(), 'recall-age-planned-build-'));
      try {
        const home = join(root, 'home');
        const recallDir = join(home, '.agents', 'Recall');
        const bin = join(root, 'bin');
        const cronFile = join(root, 'cron');
        const pkg = durablePackage(root, home);
        rmSync(pkg.runner);
        const original = `15 2 * * * /usr/bin/true # user\n${plan.scheduled ? `0 3 1 1,4,7,10 * /bin/true ${MARKER}\n` : ''}`;
        writeFileSync(cronFile, original);
        cronStub(bin, cronFile);
        const env = { RECALL_REPO_DIR: pkg.repo, RECALL_PACKAGED: plan.packaged ? '1' : '' };
        const preview = runLib(home, recallDir, bin, `recall_print_age_cron_plan ${plan.mode}`, env);
        expect(preview.status).toBe(0);
        expect(planAction(preview.stdout)).toBe(plan.action);
        expect(readFileSync(cronFile, 'utf-8')).toBe(original);
        expect(existsSync(wrapper(recallDir))).toBe(false);
        expect(existsSync(pkg.runner)).toBe(false);

        const body = plan.mode === 'install' ? 'recall_install_age_cron' : 'recall_refresh_age_cron';
        const beforeBuild = runLib(home, recallDir, bin, body, env);
        expect(beforeBuild.status).toBe(0);
        expect(readFileSync(cronFile, 'utf-8')).toBe(original);
        expect(existsSync(wrapper(recallDir))).toBe(false);

        if (!plan.packaged) {
          writeFileSync(pkg.runner, '#!/usr/bin/env bun\n', { mode: 0o755 });
          const afterBuild = runLib(home, recallDir, bin, body, env);
          expect(afterBuild.status).toBe(0);
          expect(readFileSync(cronFile, 'utf-8')).toContain(fixedLine(recallDir));
          expect(readFileSync(wrapper(recallDir), 'utf-8')).toContain(quote(pkg.runner));
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('wrapper failure restores a newline-terminated crontab or reports rollback failure', () => {
    const cases = [
      { mode: 'install', cron: '' },
      { mode: 'install', cron: '15 2 * * * /usr/bin/true # user\n' },
      { mode: 'refresh', cron: `15 2 * * * /usr/bin/true # user\n0 3 1 1,4,7,10 * /bin/true ${MARKER}\n` },
    ];
    for (const { mode, cron: original } of cases) {
      for (const rejectRestore of [false, true]) {
        const root = mkdtempSync(join(tmpdir(), 'recall-age-wrapper-rollback-'));
        try {
          const home = join(root, 'home');
          const recallDir = join(home, '.agents', 'Recall');
          const bin = join(root, 'bin');
          const cronFile = join(root, 'cron');
          const pkg = durablePackage(root, home);
          const originalScript = expectedScript(join(root, 'stored.db'), '/bun', '/runner', '/log');
          mkdirSync(join(recallDir, 'shared'), { recursive: true });
          if (mode === 'refresh') writeFileSync(wrapper(recallDir), originalScript, { mode: 0o700 });
          writeFileSync(join(recallDir, 'logs'), 'blocks wrapper creation');
          writeFileSync(cronFile, original);
          cronStub(bin, cronFile, rejectRestore);
          const result = runLib(
            home, recallDir, bin,
            `${mode === 'install' ? 'recall_install_age_cron' : 'recall_refresh_age_cron'}\nrecall_print_age_cron_notice`,
            { RECALL_REPO_DIR: pkg.repo },
          );
          expect(result.status).toBe(0);
          if (rejectRestore) {
            expect(readFileSync(cronFile, 'utf-8')).toContain(fixedLine(recallDir));
            expect(result.stdout).toContain('could not restore the previous crontab');
            expect(result.stdout).not.toContain('unchanged');
          } else {
            expect(readFileSync(cronFile, 'utf-8')).toBe(original);
            expect(result.stdout).toContain('Schedule unchanged');
          }
          if (mode === 'refresh') expect(readFileSync(wrapper(recallDir), 'utf-8')).toBe(originalScript);
          else expect(existsSync(wrapper(recallDir))).toBe(false);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    }
  });

  test('refresh rejects a wrapper without an exported database assignment', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-age-unexported-db-'));
    try {
      const home = join(root, 'home');
      const recallDir = join(home, '.agents', 'Recall');
      const bin = join(root, 'bin');
      const cronFile = join(root, 'cron');
      const pkg = durablePackage(root, home);
      const original = `0 3 1 1,4,7,10 * /bin/true ${MARKER}\n`;
      const script = `#!/bin/sh\nRECALL_DB_PATH=${quote(join(root, 'stored.db'))}\n`;
      mkdirSync(join(recallDir, 'shared'), { recursive: true });
      writeFileSync(wrapper(recallDir), script, { mode: 0o700 });
      writeFileSync(cronFile, original);
      cronStub(bin, cronFile);
      const result = runLib(home, recallDir, bin, 'recall_refresh_age_cron', { RECALL_REPO_DIR: pkg.repo });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('stored database path cannot be read');
      expect(readFileSync(cronFile, 'utf-8')).toBe(original);
      expect(readFileSync(wrapper(recallDir), 'utf-8')).toBe(script);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('update keeps the database stored in the wrapper unless an override is set', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-age-db-refresh-'));
    try {
      const home = join(root, 'home');
      const recallDir = join(home, '.agents', 'Recall');
      const bin = join(root, 'bin');
      const cronFile = join(root, 'cron');
      const pkg = durablePackage(root, home);
      const stored = join(root, 'custom data', 'recall.db');
      const other = join(root, 'other-pkg');
      mkdirSync(join(other, '.git'), { recursive: true });
      mkdirSync(join(other, 'dist'), { recursive: true });
      const otherRunner = join(other, 'dist', 'index.js');
      writeFileSync(otherRunner, '#!/usr/bin/env bun\n', { mode: 0o755 });
      mkdirSync(home, { recursive: true });
      cronStub(bin, cronFile);

      const installed = runLib(home, recallDir, bin, 'recall_install_age_cron', {
        RECALL_REPO_DIR: pkg.repo,
        RECALL_DB_PATH: stored,
      });
      expect(installed.status).toBe(0);

      const refreshed = runLib(home, recallDir, bin, 'recall_refresh_age_cron', { RECALL_REPO_DIR: other });
      expect(refreshed.status).toBe(0);
      const kept = readFileSync(wrapper(recallDir), 'utf-8');
      expect(kept).toContain(`export RECALL_DB_PATH=${quote(stored)}`);
      expect(kept).toContain(otherRunner);
      expect(kept).not.toContain(pkg.runner);

      const overridden = runLib(home, recallDir, bin, 'recall_refresh_age_cron', {
        RECALL_REPO_DIR: other,
        MEM_DB_PATH: join(root, 'override', 'recall.db'),
      });
      expect(overridden.status).toBe(0);
      expect(readFileSync(wrapper(recallDir), 'utf-8')).toContain(
        `export RECALL_DB_PATH=${quote(join(root, 'override', 'recall.db'))}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each(['RECALL_DB_PATH', 'MEM_DB_PATH'])('relative %s overrides keep the selected database from cron HOME', (key) => {
    for (const mode of ['install', 'refresh']) {
      for (const relative of ['data/recall.db', 'not-created/data/recall.db']) {
        const root = mkdtempSync(join(tmpdir(), 'recall-age-relative-override-'));
        try {
          const home = join(root, 'home');
          const recallDir = join(home, '.agents', 'Recall');
          const bin = join(root, 'bin');
          const cronFile = join(root, 'cron');
          const output = join(root, 'executed-db.json');
          const pkg = durablePackage(root, home);
          const db = join(pkg.repo, relative);
          const homeDb = join(home, relative);
          const original = `15 2 * * * /usr/bin/true # user\n${mode === 'refresh' ? `0 3 1 1,4,7,10 * /bin/true ${MARKER}\n` : ''}`;
          writeFileSync(cronFile, original);
          cronStub(bin, cronFile);
          writeFileSync(pkg.runner,
            `import { readFileSync, writeFileSync } from 'fs';\nwriteFileSync(${JSON.stringify(output)}, JSON.stringify({ path: process.env.RECALL_DB_PATH, data: readFileSync(process.env.RECALL_DB_PATH, 'utf-8') }));\n`,
          );
          const env = { RECALL_REPO_DIR: pkg.repo, [key]: relative };
          const preview = runLib(home, recallDir, bin, `cd ${quote(pkg.repo)}\nrecall_print_age_cron_plan ${mode}`, env);
          expect(preview.status).toBe(0);
          expect(planAction(preview.stdout)).toBe(mode === 'install' ? 'add' : 'refresh');
          expect(preview.stdout).toContain(`Database: ${db}`);
          expect(readFileSync(cronFile, 'utf-8')).toBe(original);
          expect(existsSync(wrapper(recallDir))).toBe(false);

          mkdirSync(dirname(db), { recursive: true });
          mkdirSync(dirname(homeDb), { recursive: true });
          writeFileSync(db, 'selected database');
          writeFileSync(homeDb, 'unrelated HOME database');
          const applied = runLib(home, recallDir, bin,
            `cd ${quote(pkg.repo)}\n${mode === 'install' ? 'recall_install_age_cron' : 'recall_refresh_age_cron'}`, env,
          );
          expect(applied.status).toBe(0);
          const execution = spawnSync('/bin/sh', [wrapper(recallDir)], {
            cwd: home, encoding: 'utf-8', env: { ...process.env, HOME: home },
          });
          expect(execution.status).toBe(0);
          expect(JSON.parse(readFileSync(output, 'utf-8'))).toEqual({ path: db, data: 'selected database' });
          expect(readFileSync(homeDb, 'utf-8')).toBe('unrelated HOME database');
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    }
  });

  test('relative stored wrapper and MCP targets preserve state instead of scheduling', () => {
    const cases = [
      { source: 'wrapper', key: 'RECALL_DB_PATH' },
      { source: 'legacy', key: 'RECALL_DB_PATH' },
      { source: 'legacy', key: 'MEM_DB_PATH' },
      { source: 'settings', key: 'RECALL_DB_PATH' },
      { source: 'settings', key: 'MEM_DB_PATH' },
    ];
    for (const target of cases) {
      for (const mode of ['install', 'refresh']) {
        const root = mkdtempSync(join(tmpdir(), 'recall-age-relative-stored-'));
        try {
          const home = join(root, 'home');
          const recallDir = join(home, '.agents', 'Recall');
          const bin = join(root, 'bin');
          const cronFile = join(root, 'cron');
          const pkg = durablePackage(root, home);
          const storedFile = target.source === 'wrapper'
            ? wrapper(recallDir)
            : target.source === 'legacy' ? join(home, '.claude.json') : join(home, '.claude', 'settings.json');
          const stored = target.source === 'wrapper'
            ? expectedScript('data/recall.db', join(bin, 'bun'), pkg.runner, join(recallDir, 'logs', 'age.log'))
            : JSON.stringify({ mcpServers: { 'recall-memory': { command: 'bun', env: { [target.key]: 'data/recall.db' } } } });
          const original = `15 2 * * * /usr/bin/true # user\n0 3 1 1,4,7,10 * /bin/true ${MARKER}\n`;
          mkdirSync(dirname(storedFile), { recursive: true });
          writeFileSync(storedFile, stored);
          writeFileSync(cronFile, original);
          cronStub(bin, cronFile);
          const env = { RECALL_REPO_DIR: pkg.repo };
          const preview = runLib(home, recallDir, bin, `recall_print_age_cron_plan ${mode}`, env);
          expect(preview.status).toBe(0);
          expect(planAction(preview.stdout)).toBe('not scheduled');
          expect(preview.stdout).toContain('relative');
          const applied = runLib(home, recallDir, bin,
            mode === 'install' ? 'recall_install_age_cron' : 'recall_refresh_age_cron', env,
          );
          expect(applied.status).toBe(0);
          expect(applied.stdout).toContain('relative');
          expect(readFileSync(cronFile, 'utf-8')).toBe(original);
          expect(readFileSync(storedFile, 'utf-8')).toBe(stored);
          if (target.source !== 'wrapper') expect(existsSync(wrapper(recallDir))).toBe(false);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    }
  });

  test('duplicate marked lines do not interrupt preview or lifecycle actions', () => {
    for (const mode of ['install', 'refresh', 'remove']) {
      const root = mkdtempSync(join(tmpdir(), 'recall-age-duplicates-'));
      try {
        const home = join(root, 'home');
        const recallDir = join(home, '.agents', 'Recall');
        const bin = join(root, 'bin');
        const cronFile = join(root, 'cron');
        const pkg = durablePackage(root, home);
        const userLines = 'CRON_TZ=UTC\n15 2 * * * /usr/bin/true # user\n';
        const managedLine = `0 3 1 1,4,7,10 * /bin/true ${MARKER}\n`;
        writeFileSync(cronFile, userLines + managedLine + managedLine);
        cronStub(bin, cronFile);
        const operation = mode === 'install' ? 'recall_install_age_cron'
          : mode === 'refresh' ? 'recall_refresh_age_cron' : 'recall_remove_age_cron';
        const result = runLib(home, recallDir, bin, `recall_print_age_cron_plan ${mode}\n${operation}`, { RECALL_REPO_DIR: pkg.repo });
        expect(result.status).toBe(0);
        expect(planAction(result.stdout)).toBe(mode === 'remove' ? 'remove' : 'refresh');
        expect(readFileSync(cronFile, 'utf-8')).toBe(userLines + (mode === 'remove' ? '' : `${fixedLine(recallDir)}\n`));
        expect(existsSync(wrapper(recallDir))).toBe(mode !== 'remove');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('wrapper deletion failure reports an absent schedule with the wrapper remaining', () => {
    for (const scheduled of [true, false]) {
      const root = mkdtempSync(join(tmpdir(), 'recall-age-remove-wrapper-'));
      try {
        const home = join(root, 'home');
        const recallDir = join(home, '.agents', 'Recall');
        const bin = join(root, 'bin');
        const cronFile = join(root, 'cron');
        const userLine = '15 2 * * * /usr/bin/true # user\n';
        const stored = expectedScript(join(root, 'recall.db'), '/bun', '/runner', '/log');
        mkdirSync(dirname(wrapper(recallDir)), { recursive: true });
        writeFileSync(wrapper(recallDir), stored);
        writeFileSync(cronFile, userLine + (scheduled ? `${fixedLine(recallDir)}\n` : ''));
        cronStub(bin, cronFile);
        const result = runLib(home, recallDir, bin,
          'rm() { return 1; }\nrecall_remove_age_cron\nrecall_print_age_cron_notice',
        );
        expect(result.status).toBe(0);
        expect(readFileSync(cronFile, 'utf-8')).toBe(userLine);
        expect(readFileSync(wrapper(recallDir), 'utf-8')).toBe(stored);
        expect(result.stdout).toContain('Quarterly aging: disabled; no managed schedule remains');
        expect(result.stdout).toContain('wrapper could not be removed');
        expect(result.stdout).not.toContain('Schedule unchanged');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('Bun absent from PATH does not use a home-directory fallback', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-age-no-bun-'));
    try {
      const home = join(root, 'home');
      const recallDir = join(home, '.agents', 'Recall');
      const bin = join(root, 'bin');
      const cronFile = join(root, 'cron');
      const pkg = durablePackage(root, home);
      const original = '15 2 * * * /usr/bin/true # user\n';
      writeFileSync(join(home, '.bun', 'bin', 'bun'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      writeFileSync(cronFile, original);
      cronStub(bin, cronFile);
      rmSync(join(bin, 'bun'));
      const result = runLib(home, recallDir, bin,
        'recall_print_age_cron_plan install\nrecall_install_age_cron\nrecall_print_age_cron_notice',
        { RECALL_REPO_DIR: pkg.repo, RECALL_DB_PATH: join(root, 'recall.db') },
      );
      expect(result.status).toBe(0);
      expect(planAction(result.stdout)).toBe('not scheduled');
      expect(result.stdout).toContain('Bun could not be resolved from PATH');
      expect(readFileSync(cronFile, 'utf-8')).toBe(original);
      expect(existsSync(wrapper(recallDir))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a trailing newline in the raw database path is not scheduled', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-age-newline-'));
    try {
      const home = join(root, 'home');
      const recallDir = join(home, '.agents', 'Recall');
      const bin = join(root, 'bin');
      const cronFile = join(root, 'cron');
      const original = '15 2 * * * /usr/bin/true # user\n';
      const pkg = durablePackage(root, home);
      mkdirSync(home, { recursive: true });
      writeFileSync(cronFile, original);
      cronStub(bin, cronFile);

      const result = runLib(
        home,
        recallDir,
        bin,
        'recall_install_age_cron\nrecall_print_age_cron_notice',
        { RECALL_REPO_DIR: pkg.repo, RECALL_DB_PATH: `${join(root, 'recall.db')}\n` },
      );
      expect(result.status).toBe(0);
      expect(readFileSync(cronFile, 'utf-8')).toBe(original);
      expect(existsSync(wrapper(recallDir))).toBe(false);
      expect(result.stdout).toContain('NOT scheduled');
      expect(result.stdout).toContain('newline');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an install path that cannot be written to crontab is not scheduled', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-age-dir-'));
    try {
      const home = join(root, 'home');
      const recallDir = join(home, 'bad%dir');
      const bin = join(root, 'bin');
      const cronFile = join(root, 'cron');
      const original = `15 2 * * * /usr/bin/true # user\n0 3 1 1,4,7,10 * /bin/true ${MARKER}\n`;
      const pkg = durablePackage(root, home);
      mkdirSync(home, { recursive: true });
      writeFileSync(cronFile, original);
      cronStub(bin, cronFile);

      const result = runLib(
        home,
        recallDir,
        bin,
        'recall_print_age_cron_plan install\nrecall_install_age_cron\nrecall_print_age_cron_notice',
        { RECALL_REPO_DIR: pkg.repo },
      );
      expect(result.status).toBe(0);
      expect(planAction(result.stdout)).toBe('not scheduled');
      expect(readFileSync(cronFile, 'utf-8')).toBe(original);
      expect(result.stdout).toContain('NOT scheduled');
      expect(result.stdout).toContain('crontab -e');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('skip and remove delete the crontab line and the wrapper', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-age-skip-'));
    try {
      const home = join(root, 'home');
      const recallDir = join(home, '.agents', 'Recall');
      const bin = join(root, 'bin');
      const cronFile = join(root, 'cron');
      const pkg = durablePackage(root, home);
      mkdirSync(join(recallDir, 'shared'), { recursive: true });
      writeFileSync(wrapper(recallDir), '#!/bin/sh\nexport RECALL_DB_PATH=\'/stored\'\n', { mode: 0o700 });
      writeFileSync(cronFile, `15 2 * * * /usr/bin/true # user\n0 3 1 1,4,7,10 * /bin/true ${MARKER}\n`);
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
        RECALL_DIR: recallDir,
        RECALL_REPO_DIR: pkg.repo,
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
      expect(flagged.stdout).toContain('removed the existing managed schedule and wrapper script');
      expect(readFileSync(cronFile, 'utf-8')).toBe('15 2 * * * /usr/bin/true # user\n');
      expect(existsSync(wrapper(recallDir))).toBe(false);

      const unflagged = spawnSync('bash', [INSTALL, '--yes'], {
        encoding: 'utf-8',
        cwd: REPO,
        env,
      });
      expect(unflagged.status).toBe(0);
      expect(unflagged.stdout).toContain('Quarterly aging: scheduled');
      expect(readFileSync(cronFile, 'utf-8')).toContain(fixedLine(recallDir));
      expect(existsSync(wrapper(recallDir))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refresh does not add a missing line or wrapper', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-age-refresh-'));
    try {
      const home = join(root, 'home');
      const recallDir = join(home, '.agents', 'Recall');
      const bin = join(root, 'bin');
      const cronFile = join(root, 'cron');
      const pkg = durablePackage(root, home);
      writeFileSync(cronFile, '15 2 * * * /usr/bin/true # user\n');
      cronStub(bin, cronFile);
      const absent = runLib(home, recallDir, bin, 'recall_refresh_age_cron', { RECALL_REPO_DIR: pkg.repo });
      expect(absent.status).toBe(0);
      expect(readFileSync(cronFile, 'utf-8')).not.toContain(MARKER);
      expect(existsSync(wrapper(recallDir))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('dry-run prints the line and does not write', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-age-dry-'));
    try {
      const home = join(root, 'home');
      const recallDir = join(home, '.agents', 'Recall');
      const bin = join(root, 'bin');
      const cronFile = join(root, 'cron');
      const pkg = durablePackage(root, home);
      mkdirSync(home, { recursive: true });
      writeFileSync(cronFile, '15 2 * * * /usr/bin/true # user\n');
      cronStub(bin, cronFile);
      const before = readFileSync(cronFile, 'utf-8');
      const result = runLib(home, recallDir, bin, 'DRY_RUN=true recall_install_age_cron', { RECALL_REPO_DIR: pkg.repo });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('[dry-run]');
      expect(result.stdout).toContain(MARKER);
      expect(readFileSync(cronFile, 'utf-8')).toBe(before);
      expect(existsSync(wrapper(recallDir))).toBe(false);
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
      const pkg = durablePackage(root, home);
      const result = spawnSync('/bin/bash', ['-c', `set -euo pipefail\nsource ${JSON.stringify(LIB)}\nrecall_install_age_cron`], {
        encoding: 'utf-8',
        cwd: REPO,
        env: {
          ...process.env,
          HOME: home,
          RECALL_DIR: join(home, '.agents', 'Recall'),
          RECALL_REPO_DIR: pkg.repo,
          PATH: `${bin}:/usr/bin:/bin`,
          RECALL_CRONTAB_BIN: join(bin, 'missing-crontab'),
          NO_COLOR: '1',
        },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('crontab not found');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('bun-global package that ran install is scheduled', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-age-global-'));
    try {
      const home = join(root, 'home');
      const recallDir = join(home, '.agents', 'Recall');
      const bin = join(root, 'bin');
      const cronFile = join(root, 'cron');
      const repo = join(home, '.bun', 'install', 'global', 'node_modules', 'recall-memory');
      const runner = join(repo, 'dist', 'index.js');
      mkdirSync(join(runner, '..'), { recursive: true });
      writeFileSync(runner, '#!/usr/bin/env bun\n', { mode: 0o755 });
      cronStub(bin, cronFile);
      const result = runLib(home, recallDir, bin, 'recall_install_age_cron', { RECALL_REPO_DIR: repo });
      expect(result.status).toBe(0);
      expect(readFileSync(wrapper(recallDir), 'utf-8')).toContain(runner);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a stale global binary is not scheduled when install is not durable', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-age-ephemeral-'));
    try {
      const home = join(root, 'home');
      const bin = join(root, 'bin');
      const cronFile = join(root, 'cron');
      durablePackage(root, home);
      mkdirSync(home, { recursive: true });
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
      const original = `15 2 * * * /usr/bin/true # user\n0 3 1 1,4,7,10 * /bin/true ${MARKER}\n`;
      mkdirSync(home, { recursive: true });
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
      const pkg = durablePackage(root, home);
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
        { RECALL_REPO_DIR: pkg.repo },
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
      const recallDir = join(home, '.agents', 'Recall');
      const bin = join(root, 'bin');
      const cronFile = join(root, 'cron');
      mkdirSync(home, { recursive: true });
      bunStub(bin);
      const pkg = durablePackage(root, home);
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
        recallDir,
        bin,
        'recall_install_age_cron\nrecall_print_age_cron_notice',
        { RECALL_REPO_DIR: pkg.repo },
      );
      expect(result.status).toBe(0);
      expect(readFileSync(cronFile, 'utf-8')).toBe(before);
      expect(existsSync(wrapper(recallDir))).toBe(false);
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
      const env = {
        ...process.env,
        HOME: home,
        RECALL_DIR: join(home, '.agents', 'Recall'),
        PATH: `${bin}:/usr/bin:/bin`,
        NO_COLOR: '1',
      };
      delete env.RECALL_CRONTAB_BIN;
      const result = spawnSync('/bin/bash', ['-c', `set -euo pipefail\nsource ${JSON.stringify(LIB)}\nrecall_print_age_cron_plan install\nrecall_install_age_cron\nrecall_refresh_age_cron\nrecall_remove_age_cron`], {
        encoding: 'utf-8',
        cwd: REPO,
        env,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Skipping quarterly age cron');
      expect(existsSync(called)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('plan reports lifecycle actions without writing', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-age-plan-'));
    try {
      const home = join(root, 'home');
      const bin = join(root, 'bin');
      const cronFile = join(root, 'cron');
      const pkg = durablePackage(root, home);
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
        const result = runLib(home, join(home, '.agents', 'Recall'), bin, `recall_print_age_cron_plan ${plan.mode}`, {
          RECALL_REPO_DIR: pkg.repo,
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(`Quarterly aging cron: ${plan.action}`);
        expect(result.stdout).toContain('Schedule: 0 3 1 1,4,7,10 * | Command: recall age --execute');
        expect(readFileSync(cronFile, 'utf-8')).toBe(plan.cron);
      }
      writeFileSync(join(bin, 'crontab'), '#!/bin/sh\necho "permission denied" >&2\nexit 2\n', { mode: 0o755 });
      const kept = runLib(home, join(home, '.agents', 'Recall'), bin, 'recall_print_age_cron_plan install');
      expect(kept.status).toBe(0);
      expect(kept.stdout).toContain('Quarterly aging cron: keep');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('stored MCP database is previewed before any MCP write and then scheduled', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-age-mcp-db-'));
    try {
      const home = join(root, 'home');
      const recallDir = join(home, '.agents', 'Recall');
      const bin = join(root, 'bin');
      const cronFile = join(root, 'cron');
      const customDb = join(root, 'custom', 'recall.db');
      const claudeDir = join(home, '.claude');
      const settings = join(claudeDir, 'settings.json');
      const pkg = durablePackage(root, home);
      const bunBin = dirname(Bun.which('bun') ?? '');
      const before = JSON.stringify({
        mcpServers: { 'recall-memory': { command: 'bun', env: { RECALL_DB_PATH: customDb } } },
      });
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(settings, before);
      cronStub(bin, cronFile);
      const env = {
        RECALL_REPO_DIR: pkg.repo,
        CLAUDE_DIR: claudeDir,
        PATH: `${bunBin}:${bin}:/usr/bin:/bin`,
      };
      const preview = runLib(home, recallDir, bin, 'recall_print_age_cron_plan install', env);
      expect(preview.status).toBe(0);
      expect(preview.stdout).toContain(`Database: ${customDb}`);
      expect(readFileSync(settings, 'utf-8')).toBe(before);
      expect(existsSync(wrapper(recallDir))).toBe(false);
      const applied = runLib(home, recallDir, bin, 'recall_install_age_cron', env);
      expect(applied.status).toBe(0);
      expect(readFileSync(wrapper(recallDir), 'utf-8')).toContain(`export RECALL_DB_PATH=${quote(customDb)}`);
      expect(readFileSync(settings, 'utf-8')).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('conflicting MCP database pins are not scheduled instead of falling back to the default', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-age-mcp-conflict-'));
    try {
      const home = join(root, 'home');
      const recallDir = join(home, '.agents', 'Recall');
      const bin = join(root, 'bin');
      const cronFile = join(root, 'cron');
      const claudeDir = join(home, '.claude');
      const pkg = durablePackage(root, home);
      const bunBin = dirname(Bun.which('bun') ?? '');
      const pin = (db: string) => JSON.stringify({ mcpServers: { 'recall-memory': { command: 'bun', env: { RECALL_DB_PATH: db } } } });
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(join(claudeDir, 'settings.json'), pin(join(root, 'a', 'recall.db')));
      writeFileSync(join(home, '.claude.json'), pin(join(root, 'b', 'recall.db')));
      cronStub(bin, cronFile);
      const original = '15 2 * * * /usr/bin/true # user\n';
      writeFileSync(cronFile, original);
      const env = { RECALL_REPO_DIR: pkg.repo, CLAUDE_DIR: claudeDir, PATH: `${bunBin}:${bin}:/usr/bin:/bin` };
      const preview = runLib(home, recallDir, bin, 'recall_print_age_cron_plan install', env);
      expect(planAction(preview.stdout)).toBe('not scheduled');
      const applied = runLib(home, recallDir, bin, 'recall_install_age_cron', env);
      expect(applied.stdout).toContain('NOT scheduled');
      expect(readFileSync(cronFile, 'utf-8')).toBe(original);
      expect(existsSync(wrapper(recallDir))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
