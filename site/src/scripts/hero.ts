export {};

function mount() {
  const stageEl = document.getElementById('stage');
  const field = document.getElementById('field');
  if (!(stageEl instanceof HTMLElement) || !(field instanceof HTMLCanvasElement)) {
    throw new Error('hero stage missing');
  }
  const pen = field.getContext('2d');
  if (!pen) throw new Error('hero canvas missing');
  return { stageEl, field, pen };
}

const { stageEl, field, pen } = mount();

const root = document.documentElement;
const params = new URLSearchParams(location.search);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches || params.get('still') === '1';
const freeze = params.has('t') ? Number(params.get('t')) : null;
const still = reduced || freeze !== null;
const settled = 99;
const resolveIn = 1.3;
// Live only: the globe turns once every spinPeriod seconds. Still, ?t= and
// reduced-motion do not spin and draw exactly as before.
const spin = !still;
const spinPeriod = 72;
const texW = 256;
const texH = 64;
const tilt = 0.32;
// Spinning: sea sits this far below the flat tone so the glyph count stays level with still.
const seaBias = 52;
const period = 7;
const ramp = ' .:-=+*#%@';
const cellW = 6;
const cellH = 10;
const fontSize = 10;

const bayer = (() => {
  let m = [[0]];
  for (let s = 1; s < 8; s *= 2) {
    const n: number[][] = [];
    for (let y = 0; y < 2 * s; y++) {
      n.push([]);
      for (let x = 0; x < 2 * s; x++) {
        const v = m[y % s][x % s] * 4;
        n[y][x] = v + [[0, 2], [3, 1]][Math.floor(y / s)][Math.floor(x / s)];
      }
    }
    m = n;
  }
  return m.map((row) => row.map((v) => (v + 0.5) / 64));
})();

function hash(n: number) {
  n |= 0;
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
function smooth(a: number, b: number, x: number) {
  x = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return x * x * (3 - 2 * x);
}
function mix(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
function channels(name: string) {
  return getComputedStyle(root).getPropertyValue(name).split(',').map(Number);
}

let light = false;
let accent = [0, 0, 0];
let accent2 = [0, 0, 0];
let hot = [255, 255, 255];
let ink = [237, 237, 237];
let palette: string[][] = [];
let width = 0;
let height = 0;
let count = 0;
let px: Float32Array;
let py: Float32Array;
let tone: Float32Array;
let bay: Float32Array;
let hh: Float32Array;
let heat: Uint8Array;
let haze = [0, 0, 0];
let glow: CanvasGradient;
let lonU: Float32Array; // texture column of each disc cell at zero rotation
let latRow: Int32Array; // texture row offset of each disc cell, -1 off the disc
let boost: Float32Array; // how much a land cell adds to its tone
let order: Int32Array; // draw order scratch, reused every frame
let lvl: Uint8Array; // glyph level scratch, reused every frame
const counts = new Int32Array(31);
let surface: Uint8Array | null = null;

function readTheme() {
  light = root.dataset.theme === 'light';
  accent = channels('--acc-rgb');
  accent2 = channels('--acc2-rgb');
  ink = channels('--ink-rgb');
  hot = channels('--hot-rgb');
  palette = [];
  for (let level = 0; level < 10; level++) {
    palette.push([]);
    for (let bucket = 0; bucket < 3; bucket++) {
      const t = level / 9;
      const base = [0, 1, 2].map((k) => mix(accent[k], accent2[k], bucket / 2));
      const color = light
        ? base.map((v, k) => mix(v, ink[k], 0.15 + t * 0.55))
        : base.map((v, k) => mix(v, hot[k], t ** 3 * 0.75));
      const alpha = light ? 0.34 + 0.66 * t ** 0.6 : 0.22 + 0.78 * t ** 0.6;
      palette[level].push(`rgba(${color[0] | 0},${color[1] | 0},${color[2] | 0},${alpha.toFixed(2)})`);
    }
  }
}

// Land and sea, once: value noise that wraps in longitude.
function makeSurface() {
  const grid = (cols: number, rows: number, seed: number) => {
    const g = new Float32Array(cols * rows);
    for (let i = 0; i < g.length; i++) g[i] = hash(i * 2654435 + seed);
    return g;
  };
  const octaves = [
    { cols: 8, rows: 5, amp: 1, g: grid(8, 5, 11) },
    { cols: 16, rows: 10, amp: 0.5, g: grid(16, 10, 23) },
    { cols: 32, rows: 20, amp: 0.25, g: grid(32, 20, 37) },
  ];
  const out = new Uint8Array(texW * texH);
  for (let y = 0; y < texH; y++) {
    for (let x = 0; x < texW; x++) {
      let v = 0;
      let norm = 0;
      for (const o of octaves) {
        const fx = (x / texW) * o.cols;
        const fy = (y / (texH - 1)) * (o.rows - 1);
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const tx = smooth(0, 1, fx - x0);
        const ty = smooth(0, 1, fy - y0);
        const x1 = (x0 + 1) % o.cols;
        const y1 = Math.min(o.rows - 1, y0 + 1);
        const top = mix(o.g[y0 * o.cols + (x0 % o.cols)], o.g[y0 * o.cols + x1], tx);
        const bot = mix(o.g[y1 * o.cols + (x0 % o.cols)], o.g[y1 * o.cols + x1], tx);
        v += mix(top, bot, ty) * o.amp;
        norm += o.amp;
      }
      out[y * texW + x] = Math.round(smooth(0.56, 0.7, v / norm) * 255);
    }
  }
  return out;
}

function draw(time: number) {
  pen.clearRect(0, 0, width, height);
  const eased = smooth(0, 1, Math.min(1, time / resolveIn));
  const bucket = time / period;
  // Turn: only a longitude shift of the precomputed texture columns, no trig.
  const shift = spin ? (time / spinPeriod) * texW : 0;
  const whole = Math.floor(shift);
  const part = shift - whole;
  counts.fill(0);
  for (let i = 0; i < count; i++) {
    let value = tone[i];
    if (spin && latRow[i] >= 0) {
      const u = lonU[i] - part;
      const k = Math.floor(u);
      const f = u - k;
      const col = (k - whole) & (texW - 1);
      const a = surface![latRow[i] + col];
      const b = surface![latRow[i] + ((col + 1) & (texW - 1))];
      value += (a + (b - a) * f) * boost[i];
    }
    if (time < settled) {
      const reveal = Math.max(0, Math.min(1, eased * 1.5 - (1 - px[i] / width) * 0.5 - (py[i] / height) * 0.15));
      value *= reveal;
    }
    let level = Math.floor(value + bay[i]);
    if (level > 9) level = 9;
    if (level < 1) {
      lvl[i] = 0;
      continue;
    }
    if (time < settled) {
      const j = hash((i * 31 + Math.floor(bucket + hh[i])) * 977);
      if (j < 0.06) level = Math.max(1, level - 1);
      else if (j > 0.95) level = Math.min(9, level + 1);
    }
    lvl[i] = level;
    counts[level * 3 + heat[i] + 1]++;
  }
  for (let key = 1; key < 31; key++) counts[key] += counts[key - 1];
  for (let i = 0; i < count; i++) {
    if (lvl[i]) order[counts[lvl[i] * 3 + heat[i]]++] = i;
  }
  let at = 0;
  for (let key = 3; key < 30; key++) {
    const end = counts[key];
    if (end === at) continue;
    pen.fillStyle = palette[(key / 3) | 0][key % 3];
    for (; at < end; at++) {
      const i = order[at];
      pen.fillText(ramp[lvl[i]], px[i], py[i]);
    }
  }
  pen.globalCompositeOperation = 'destination-over';
  pen.fillStyle = glow;
  pen.fillRect(0, 0, width, height);
  pen.globalCompositeOperation = 'source-over';
}

function sparkles() {
  const one = document.getElementById('sp1');
  const two = document.getElementById('sp2');
  if (one) {
    one.style.left = width * 0.46 + 'px';
    one.style.top = height * 0.2 + 'px';
  }
  if (two) {
    two.style.left = width * 0.49 + 'px';
    two.style.top = height * 0.8 + 'px';
  }
}

function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  width = stageEl.clientWidth;
  height = stageEl.clientHeight;
  field.width = Math.round(width * dpr);
  field.height = Math.round(height * dpr);
  pen.setTransform(dpr, 0, 0, dpr, 0, 0);
  const narrow = width < 860;
  // Disc geometry is tuned per page with data-* on the stage, as fractions of the stage.
  const data = stageEl.dataset;
  const tune = (key: string, fallback: number) => (data[key] ? parseFloat(data[key]) : fallback);
  const radius = narrow ? width * tune('nr', 0.36) : Math.min(height * tune('rh', 0.4), width * tune('rw', 0.25));
  const cx = narrow ? width * tune('ncx', 0.6) : width * tune('cx', 0.72);
  const cy = narrow ? height * tune('ncy', 0.7) : height * tune('cy', 0.5);
  const lx = -0.65;
  const ly = -0.76;
  haze = [cx + lx * radius * 0.9, cy + ly * radius * 0.9, radius];
  const cols = Math.ceil(width / cellW);
  const rows = Math.ceil(height / cellH);
  const cap = cols * rows;
  px = new Float32Array(cap);
  py = new Float32Array(cap);
  tone = new Float32Array(cap);
  bay = new Float32Array(cap);
  hh = new Float32Array(cap);
  heat = new Uint8Array(cap);
  order = new Int32Array(cap);
  lvl = new Uint8Array(cap);
  if (spin) {
    surface ??= makeSurface();
    lonU = new Float32Array(cap);
    latRow = new Int32Array(cap).fill(-1);
    boost = new Float32Array(cap);
  }
  const lean = [Math.cos(tilt), Math.sin(tilt)];
  count = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = (c + 0.5) * cellW;
      const y = (r + 0.5) * cellH;
      const dx = (x - cx) / radius;
      const dy = (y - cy) / radius;
      const rr = Math.sqrt(dx * dx + dy * dy) || 1e-6;
      const ld = (dx * lx + dy * ly) / rr;
      const lit = smooth(-0.45, 0.95, ld);
      let t: number;
      if (rr < 1) {
        const edge = 1 - rr;
        const widthTone = 0.02 + 0.15 * lit;
        t =
          Math.exp(-edge / widthTone) * lit ** 0.9 +
          0.11 * smooth(-0.3, 1, ld) * (1 - rr * 0.55) ** 2 +
          0.24 * Math.exp(-edge / 0.025) * (1 - lit) +
          0.17 * Math.exp(-edge / 0.02);
      } else {
        const outside = rr - 1;
        t = (Math.exp(-outside / 0.025) * 0.6 + Math.exp(-outside / 0.22) * 0.07) * lit;
      }
      if (light) t = Math.min(1, t * 1.15);
      // Spinning: every disc cell stays, so land can turn into view on the night side.
      if (t < 0.012 && !(spin && rr < 1)) continue;
      px[count] = x;
      py[count] = y;
      tone[count] = t * 9;
      bay[count] = bayer[r & 7][c & 7];
      hh[count] = hash(r * 977 + c * 131 + 7);
      heat[count] = Math.min(2, Math.floor(lit * Math.min(1, t * 2.4) * 3));
      if (spin && rr < 1) {
        // Where this cell sits on the globe, once. Tilt the axis, then read lat/lon.
        const depth = Math.sqrt(1 - rr * rr);
        const up = -dy * lean[0] + depth * lean[1];
        const front = depth * lean[0] + dy * lean[1];
        lonU[count] = (Math.atan2(dx, front) / (2 * Math.PI) + 0.5) * texW;
        latRow[count] = Math.min(texH - 1, Math.floor((Math.asin(Math.max(-1, Math.min(1, up))) / Math.PI + 0.5) * texH)) * texW;
        boost[count] = (3.4 / 255) * (0.22 + 0.78 * lit) * depth ** 0.5;
        tone[count] -= seaBias * boost[count];
      }
      count++;
    }
  }
  pen.font = `${light ? 600 : 400} ${fontSize}px "Geist Mono Variable", "Geist Mono", ui-monospace, Menlo, Consolas, monospace`;
  pen.textAlign = 'center';
  pen.textBaseline = 'middle';
  const hazeAlpha = light ? 0.09 : 0.08;
  glow = pen.createRadialGradient(haze[0], haze[1], 0, haze[0], haze[1], haze[2] * 0.7);
  glow.addColorStop(0, `rgba(${accent.join(',')},${hazeAlpha})`);
  glow.addColorStop(1, `rgba(${accent.join(',')},0)`);
  sparkles();
  draw(still ? (freeze ?? settled) : clock());
}

let started = performance.now();
let paused = 0;
let hiddenAt = 0;
let last = 0;
let frame = 0;
// True while the hero is scrolled out of view; the loop stops drawing.
let offscreen = false;

function clock() {
  return (performance.now() - started - paused) / 1000;
}

function loop(ts: number) {
  if (document.hidden || offscreen) return;
  if (ts - last > 60) {
    draw(clock());
    last = ts;
  }
  frame = requestAnimationFrame(loop);
}

document.addEventListener('visibilitychange', () => {
  if (still) return;
  if (document.hidden) {
    hiddenAt = performance.now();
    cancelAnimationFrame(frame);
    return;
  }
  paused += performance.now() - hiddenAt;
  frame = requestAnimationFrame(loop);
});

new MutationObserver(() => {
  readTheme();
  layout();
}).observe(root, { attributes: true, attributeFilter: ['data-theme'] });

addEventListener('resize', () => layout());

if (!still && 'IntersectionObserver' in window) {
  new IntersectionObserver((entries) => {
    const was = offscreen;
    offscreen = !entries[0]?.isIntersecting;
    if (offscreen) cancelAnimationFrame(frame);
    else if (was && !document.hidden) frame = requestAnimationFrame(loop);
  }).observe(stageEl);
}

readTheme();
// Live: draw now on the fallback font and start the clock. The redraw when the
// real font lands keeps the clock running, so the reveal does not restart.
// Still: draw once, on the real font, as before.
if (!still) {
  layout();
  if (!document.hidden) {
    started = performance.now();
    frame = requestAnimationFrame(loop);
  }
}
(document.fonts?.ready ?? Promise.resolve()).then(() => layout());
