// Theme flash check. System scheme is forced opposite the saved choice, both
// directions, on the landing page, CPU throttled 4x.
// A frame counts only once the browser has painted. Chrome's blank
// pre-navigation frame is not one of ours (it is pure black or pure white).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = path.resolve('dist');
const chrome = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const dark = [11, 17, 19];
const light = [246, 245, 241];

function serve(dir) {
  return http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    let file = path.join(dir, url);
    if (url.endsWith('/')) file = path.join(file, 'index.html');
    else if (!path.extname(file)) {
      if (fs.existsSync(file + '.html')) file += '.html';
      else if (fs.existsSync(path.join(file, 'index.html'))) file = path.join(file, 'index.html');
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      const types = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css',
        '.js': 'text/javascript',
        '.svg': 'image/svg+xml',
        '.woff2': 'font/woff2',
        '.xml': 'application/xml',
      };
      res.setHeader('content-type', types[path.extname(file)] || 'application/octet-stream');
      res.end(data);
    });
  });
}

const parse = (value) => {
  const v = value.trim();
  if (v[0] === '#') return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16));
  return (v.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
};
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function themeOf(rgb) {
  if (dist(rgb, dark) <= 28) return 'dark';
  if (dist(rgb, light) <= 28) return 'light';
  return '';
}

const cases = [
  { system: 'light', saved: 'dark', expect: 'dark' },
  { system: 'dark', saved: 'light', expect: 'light' },
  { system: 'light', saved: null, expect: 'light' },
  { system: 'dark', saved: null, expect: 'dark' },
];

const pages = ['/'];

const server = serve(root);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  executablePath: chrome,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

let failed = false;
const lines = [];

for (const pagePath of pages) {
  for (const item of cases) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      colorScheme: item.system,
    });
    const page = await context.newPage();
    const client = await context.newCDPSession(page);
    await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.addInitScript((saved) => {
      try {
        if (saved) localStorage.setItem('recall-theme', saved);
        else localStorage.removeItem('recall-theme');
      } catch (e) {}
      window.__frames = [];
      const sample = () => {
        const cs = getComputedStyle(document.documentElement);
        window.__frames.push({
          t: performance.now(),
          theme: document.documentElement.dataset.theme || '',
          bg: cs.backgroundColor,
        });
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, item.saved);
    await page.goto(base + pagePath, { waitUntil: 'load' });
    await page.waitForTimeout(350);
    const result = await page.evaluate(() => {
      const paint = performance.getEntriesByType('paint');
      const first = paint.find((entry) => entry.name === 'first-contentful-paint') || paint[0];
      return {
        themeAt: window.__recallThemeAt ?? null,
        firstPaint: first ? first.startTime : null,
        theme: document.documentElement.dataset.theme || '',
        frames: window.__frames,
      };
    });
    const painted = result.frames.filter((frame) => result.firstPaint != null && frame.t >= result.firstPaint);
    const wrong = painted.filter((frame) => {
      const seen = themeOf(parse(frame.bg)) || frame.theme;
      return seen !== item.expect;
    });
    const late = result.themeAt != null && result.firstPaint != null && result.themeAt > result.firstPaint;
    const label = `${pagePath} system=${item.system} saved=${item.saved || 'none'} expect=${item.expect}`;
    if (wrong.length || late || result.theme !== item.expect) failed = true;
    lines.push(
      `${wrong.length || late || result.theme !== item.expect ? 'FAIL' : 'ok  '} ${label} themeAt=${
        result.themeAt == null ? 'n/a' : result.themeAt.toFixed(0)
      }ms firstPaint=${result.firstPaint == null ? 'n/a' : result.firstPaint.toFixed(0)}ms painted=${
        painted.length
      } wrong=${wrong.length}`,
    );
    await context.close();
  }
}

await browser.close();
server.close();
console.log(lines.join('\n'));
console.log(failed ? 'FAIL' : 'PASS');
if (failed) process.exit(1);
