// WCAG contrast for the token file. Text pairs must be >= 4.5:1.
// Meaningful lines (focus ring, tab underline, callout borders, diagram strokes) must be >= 3:1.
//
// Neutral hairline borders on labelled controls are decorative and excluded.
// Those are --b1, --b2, --b3, and --b4 (nav pills, the install box, card edges,
// diagram boxes). Each of those controls is identified by its own text.
//
// This gate reads flat token pairs. It does not sample the landing hero's glyph
// pixels under the headline. scripts/flash.mjs does that in a browser when the
// hero canvas is on the page.

import fs from 'node:fs';

const file = new URL('../src/styles/landing/tokens.css', import.meta.url);
const css = fs.readFileSync(file, 'utf8');

function blocks(source) {
  const out = {};
  const re = /\/\*\s*@theme\s+([\w-]+)\s*\*\/([\s\S]*?)(?=\/\*\s*@theme\s+|$)/g;
  for (const match of source.matchAll(re)) {
    const vars = {};
    for (const prop of match[2].matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      vars['--' + prop[1]] = prop[2].trim();
    }
    out[match[1]] = vars;
  }
  return out;
}

function parse(value) {
  const v = value.trim();
  if (v.startsWith('#')) {
    const h = v.slice(1);
    const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    return { c: [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16)), a: 1 };
  }
  const parts = v.match(/[\d.]+/g);
  if (!parts) throw new Error('cannot parse color ' + value);
  const n = parts.map(Number);
  return { c: n.slice(0, 3), a: n.length > 3 ? n[3] : 1 };
}

function channels(vars, name) {
  if (name.endsWith('-rgb')) return vars[name].split(',').map((n) => Number(n.trim()));
  return parse(vars[name]).c;
}

const lin = (v) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const contrast = (a, b) => {
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const over = (fg, bg, a) => fg.map((v, i) => v * a + bg[i] * (1 - a));

const themes = blocks(css);
for (const name of ['dark', 'light', 'light-nojs']) {
  if (!themes[name]) {
    console.error('missing @theme ' + name);
    process.exit(1);
  }
}

const lightKeys = Object.keys(themes.light).sort();
const nojsKeys = Object.keys(themes['light-nojs']).sort();
const drift = lightKeys.filter((k) => themes.light[k] !== themes['light-nojs'][k]);
const extra = nojsKeys.filter((k) => !(k in themes.light));
if (drift.length || extra.length || lightKeys.length !== nojsKeys.length) {
  console.error('light and light-nojs token blocks differ');
  for (const k of drift) console.error(`  ${k}: ${themes.light[k]} != ${themes['light-nojs'][k]}`);
  process.exit(1);
}

const textOn = ['--bg', '--s1', '--s2'];
const textFg = ['--text', '--t2', '--t3', '--l2', '--acc', '--acc2'];

let failed = false;
const summary = [];

for (const name of ['dark', 'light']) {
  const v = themes[name];
  const bg = channels(v, '--bg');
  const rows = [];
  const add = (kind, label, ratio) => rows.push({ kind, label, ratio });

  for (const fg of textFg) {
    for (const surface of textOn) add('text', `${fg} on ${surface}`, contrast(channels(v, fg), channels(v, surface)));
  }
  add('text', '--btn-fg on --btn-bg', contrast(channels(v, '--btn-fg'), channels(v, '--btn-bg')));

  const note = over(channels(v, '--acc-rgb'), bg, 0.07);
  const tip = over(channels(v, '--acc2-rgb'), bg, 0.08);
  add('text', '--callout on note tint', contrast(channels(v, '--callout'), note));
  add('text', '--callout on tip tint', contrast(channels(v, '--callout'), tip));
  add('text', '--acc on note tint', contrast(channels(v, '--acc'), note));
  add('text', '--acc2 on tip tint', contrast(channels(v, '--acc2'), tip));

  for (const fg of ['--acc', '--acc2', '--mid']) {
    for (const surface of textOn) add('line', `${fg} on ${surface}`, contrast(channels(v, fg), channels(v, surface)));
  }
  add('line', 'note border on its tint', contrast(channels(v, '--acc'), note));
  add('line', 'tip border on its tint', contrast(channels(v, '--acc2'), tip));

  const hair = ['--b1', '--b2', '--b3', '--b4'].map((token) => {
    const c = parse(v[token]);
    return `${token} ${contrast(over(c.c, bg, c.a), bg).toFixed(2)}`;
  });

  console.log(name);
  for (const row of rows) {
    const min = row.kind === 'text' ? 4.5 : 3;
    const ok = row.ratio >= min;
    if (!ok) failed = true;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${row.kind.padEnd(4)} ${row.ratio.toFixed(2).padStart(5)}  ${row.label}`);
  }
  console.log('  hairlines (decorative, not gated): ' + hair.join(', '));

  const texts = rows.filter((r) => r.kind === 'text');
  const lines = rows.filter((r) => r.kind === 'line');
  const lowText = texts.reduce((a, b) => (b.ratio < a.ratio ? b : a));
  const lowLine = lines.reduce((a, b) => (b.ratio < a.ratio ? b : a));
  summary.push({ name, lowText, lowLine });
  console.log(`  lowest text ${lowText.ratio.toFixed(2)} (${lowText.label})`);
  console.log(`  lowest line ${lowLine.ratio.toFixed(2)} (${lowLine.label})\n`);
}

console.log(failed ? 'FAIL' : 'PASS');
if (failed) process.exit(1);
