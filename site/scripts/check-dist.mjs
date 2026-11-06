// Checks the built site in dist/ without a network:
// - every internal href/src on every page resolves to a built file, or to a
//   redirect in public/_redirects whose target resolves;
// - every #fragment on an internal link names an id on the target page;
// - every link to this repo on GitHub (blob/edit) names a file that exists here.

import fs from 'node:fs';
import path from 'node:path';

const dist = path.resolve('dist');
const repoRoot = path.resolve('..');
const repoPrefix = /^https:\/\/github\.com\/edheltzel\/Recall\/(?:blob|edit)\/main\/([^#?]+)/;
const origin = 'https://recall.edheltzel.codes';

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('dist/index.html is missing. Run npm run build first.');
  process.exit(1);
}

const redirects = new Map(
  fs
    .readFileSync(path.join(dist, '_redirects'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'))
    .map((line) => line.trim().split(/\s+/)),
);

/** The built file a site path serves, as Cloudflare Pages would pick it. */
function fileFor(pathname) {
  const clean = decodeURIComponent(pathname);
  const candidates = clean.endsWith('/')
    ? [path.join(dist, clean, 'index.html')]
    : [path.join(dist, clean), path.join(dist, `${clean}.html`), path.join(dist, clean, 'index.html')];
  return candidates.find((file) => fs.existsSync(file) && fs.statSync(file).isFile());
}

const idsCache = new Map();
function idsOf(file) {
  if (!idsCache.has(file)) {
    const html = fs.readFileSync(file, 'utf8');
    idsCache.set(file, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
  }
  return idsCache.get(file);
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : full.endsWith('.html') ? [full] : [];
  });
}

const problems = [];
let checked = 0;

for (const [from, to] of redirects) {
  if (!fileFor(to)) problems.push(`_redirects: ${from} -> ${to} has no built target`);
}

for (const page of walk(dist)) {
  const html = fs.readFileSync(page, 'utf8');
  const pagePath = '/' + path.relative(dist, page).split(path.sep).join('/').replace(/index\.html$/, '');
  for (const [, attr, raw] of html.matchAll(/\s(href|src)="([^"]*)"/g)) {
    const value = raw.replaceAll('&amp;', '&');
    checked++;
    const repo = repoPrefix.exec(value);
    if (repo) {
      if (!fs.existsSync(path.join(repoRoot, decodeURIComponent(repo[1])))) {
        problems.push(`${pagePath}: ${attr} ${value} names a repo file that does not exist`);
      }
      continue;
    }
    let url;
    try {
      url = new URL(value, origin + pagePath);
    } catch {
      problems.push(`${pagePath}: unparsable ${attr} ${value}`);
      continue;
    }
    if (url.origin !== origin) continue;
    // The 404 page's own canonical URL; Pages serves 404.html for any miss.
    if (pagePath === '/404.html' && url.pathname === '/404/') continue;
    const target = redirects.get(url.pathname) ?? url.pathname;
    const file = fileFor(target);
    if (!file) {
      problems.push(`${pagePath}: ${attr} ${value} does not resolve`);
      continue;
    }
    const hash = decodeURIComponent(url.hash.slice(1));
    if (hash && file.endsWith('.html') && !idsOf(file).has(hash)) {
      problems.push(`${pagePath}: ${attr} ${value} names a missing #${hash}`);
    }
  }
}

console.log(`checked ${checked} links on ${walk(dist).length} pages, ${redirects.size} redirects`);
if (problems.length) {
  console.log(problems.join('\n'));
  console.log(`FAIL (${problems.length})`);
  process.exit(1);
}
console.log('PASS');
