// Serves dist and checks the landing install box at a 390px viewport.
// Every install command wraps at its slashes and is never clipped. The Copy
// button sits inside its box and does not cover the command.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = path.resolve('dist');
const chrome = process.env.CHROME_PATH || '/usr/bin/google-chrome';

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

if (!fs.existsSync(path.join(root, 'index.html'))) {
  console.error('dist/index.html is missing. Run npm run build first.');
  process.exit(1);
}

const server = serve(root);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  executablePath: chrome,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

let failed = false;
const lines = [];
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
await page.goto(base + '/', { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);

const boxes = await page.evaluate(() =>
  [...document.querySelectorAll('.cmd')].map((box) => {
    const text = box.querySelector('.t');
    const button = box.querySelector('.cp');
    if (!text || !button) return { missing: true };
    const b = box.getBoundingClientRect();
    const t = text.getBoundingClientRect();
    const c = button.getBoundingClientRect();
    return {
      missing: false,
      clipped: text.scrollWidth > text.clientWidth + 0.5,
      inside: c.left >= b.left - 0.5 && c.right <= b.right + 0.5 && t.right <= b.right + 0.5,
      overlap: t.right > c.left + 0.5 && t.bottom > c.top && t.top < c.bottom,
      lines: Math.round(t.height / parseFloat(getComputedStyle(text).lineHeight)),
    };
  }),
);
const docWidth = await page.evaluate(() => document.documentElement.scrollWidth);

if (boxes.length < 1) {
  failed = true;
  lines.push(`FAIL expected the hero install box, found ${boxes.length}`);
}
boxes.forEach((box, i) => {
  if (box.missing) {
    failed = true;
    lines.push(`FAIL install box ${i + 1} elements missing`);
    return;
  }
  const ok = !box.clipped && box.inside && !box.overlap;
  if (!ok) failed = true;
  lines.push(
    `${ok ? 'ok  ' : 'FAIL'} box ${i + 1}: ${box.lines} line(s), clipped ${box.clipped}, inside ${box.inside}, overlap ${box.overlap}`,
  );
});
const fits = docWidth <= 390;
if (!fits) failed = true;
lines.push(`${fits ? 'ok  ' : 'FAIL'} document scrollWidth ${docWidth}`);

await browser.close();
server.close();
console.log(lines.join('\n'));
console.log(failed ? 'FAIL' : 'PASS');
if (failed) process.exit(1);
