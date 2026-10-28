// Procedural textures, generated on the CPU. A recipe is a list of ops run on a stack of layers.
// A layer has color (r,g,b), height (h) and mask (a), all 0..1 floats.
// Coordinates in op args are bytes: 0..255 spans the whole tile, so recipes look the same at 64 and 128 px.
// All randomness comes from mulberry32. See FORMAT.md for the op table.
import { mulberry32 } from './prng.js';

export const MAX_STACK = 8;
export const MAX_TOTAL_OPS = 256; // worst case ~1.2 s on a desktop; keeps hostile links from freezing phones for long

// Param kinds: u8 [name, 'u8', min, max, default, labels?], pos [name, 'pos', default], color [name, 'color', [r,g,b]].
// The last param may be a variable-length tail: points, text, bits, stops.
const seed = ['seed', 'u8', 0, 255, 1];
const amount = ['amount', 'u8', 0, 255, 255];
const rect = [['x0', 'pos', 32], ['y0', 'pos', 32], ['x1', 'pos', 223], ['y1', 'pos', 223]];
export const OPS = {
  1: { name: 'Fill', pop: 0, params: [['color', 'color', [128, 128, 128]], ['height', 'u8', 0, 255, 128]] },
  2: { name: 'Noise', pop: 0, params: [seed, ['scale', 'u8', 1, 32, 4], ['octaves', 'u8', 1, 8, 4], ['roughness', 'u8', 0, 255, 128]] },
  3: { name: 'Cells', pop: 0, params: [seed, ['count', 'u8', 1, 16, 4], ['mode', 'u8', 0, 2, 0, ['distance', 'edges', 'flat']]] },
  4: { name: 'Stripes', pop: 0, params: [['x count', 'u8', 0, 32, 0], ['y count', 'u8', 0, 32, 4], ['softness', 'u8', 0, 255, 128]] },
  5: { name: 'Bricks', pop: 0, params: [['columns', 'u8', 1, 32, 4], ['rows', 'u8', 1, 32, 8], ['mortar', 'u8', 0, 255, 32], ['shift', 'u8', 0, 255, 128], seed] },
  6: { name: 'Gradient', pop: 0, params: [['type', 'u8', 0, 1, 0, ['linear', 'radial']], ['x0', 'pos', 0], ['y0', 'pos', 0], ['x1', 'pos', 255], ['y1', 'pos', 255]] },
  16: { name: 'Rect', pop: 0, shape: true, params: rect },
  17: { name: 'Rounded rect', pop: 0, shape: true, params: [...rect, ['radius', 'u8', 0, 128, 24]] },
  18: { name: 'Circle', pop: 0, shape: true, params: [['x', 'pos', 128], ['y', 'pos', 128], ['radius', 'u8', 1, 255, 48]] },
  19: { name: 'Line', pop: 0, shape: true, params: [['x0', 'pos', 32], ['y0', 'pos', 32], ['x1', 'pos', 223], ['y1', 'pos', 223], ['width', 'u8', 1, 255, 16]] },
  20: { name: 'Polygon', pop: 0, shape: true, params: [['points', 'points']] },
  21: { name: 'Text', pop: 0, shape: true, params: [['x', 'pos', 128], ['y', 'pos', 128], ['size', 'u8', 1, 64, 8], ['angle', 'u8', 0, 255, 0], ['text', 'text']] }, // x,y = center
  22: { name: 'Stamp', pop: 0, shape: true, params: [...rect, ['pixels', 'bits']] },
  32: { name: 'Warp', pop: 1, params: [seed, ['strength', 'u8', 0, 255, 32], ['scale', 'u8', 1, 16, 4]] },
  33: { name: 'Blur', pop: 1, params: [['radius', 'u8', 1, 32, 2]] },
  34: { name: 'Tile', pop: 1, params: [['x', 'u8', 1, 16, 2], ['y', 'u8', 1, 16, 2]] },
  35: { name: 'Bevel', pop: 1, params: [['width', 'u8', 1, 64, 4], ['mode', 'u8', 0, 1, 0, ['raised', 'engraved']]] },
  36: { name: 'Invert', pop: 1, params: [['what', 'u8', 0, 3, 1, ['color', 'height', 'mask', 'all']]] },
  37: { name: 'Threshold', pop: 1, params: [['level', 'u8', 0, 255, 128], ['softness', 'u8', 0, 255, 16]] },
  48: { name: 'Add', pop: 2, params: [amount] },
  49: { name: 'Subtract', pop: 2, params: [amount] },
  50: { name: 'Multiply', pop: 2, params: [amount] },
  51: { name: 'Over', pop: 2, params: [amount] }, // top layer over the one below, through its mask
  52: { name: 'Blend', pop: 3, params: [amount] }, // lerp(bottom, middle, top.height)
  53: { name: 'Colorize', pop: 1, params: [['stops', 'stops']] },
  64: { name: 'Shade', pop: 1, final: true, params: [['strength', 'u8', 0, 255, 128]] },
  80: { name: 'Reference', pop: 0, params: [['texture', 'u8', 1, 64, 1]] },
};

const TAILS = {
  points: { min: 6, max: 16, step: 2 }, // 3..8 points
  text: { min: 1, max: 32, step: 1 },
  bits: { sizes: [32, 128] }, // 16x16 or 32x32, 1 bit per pixel, row-major, MSB first
  stops: { min: 8, max: 16, step: 4 }, // 2..4 stops of (pos, r, g, b)
};

// 5x7 font: each glyph is its char followed by 7 rows as base-32 digits (5 bits each).
const FONT = {};
const FONT_DATA = '0ehjlphe14c4444e2eh1248v3v2421he426aiv225vgu11he668guhhe7v1248888ehhehhe9ehhf12cAehhvhhhBuhhuhhuCehgggheDuhhhhhuEvgguggvFvggugggGehgnhhfHhhhvhhhIe44444eJ72222icKhikokihLggggggvMhrllhhhNhhpljhhOehhhhhePuhhugggQehhhlidRuhhukihSfgge11uTv444444UhhhhhheVhhhhha4WhhhlllaXhha4ahhYhha4444Zv1248gv 0000000.00000cc,0000c48!4444404?eh12404-000v000+044v440:0cc0cc0/01248g0#aavavaa(2488842)8422248=00v0v00*04lel40';
for (let i = 0; i < FONT_DATA.length; i += 8) FONT[FONT_DATA[i]] = [...FONT_DATA.slice(i + 1, i + 8)].map((c) => parseInt(c, 32));
export const FONT_CHARS = Object.keys(FONT).join('');

// Number of bytes the fixed (non-tail) params take.
const fixedLen = (spec) => spec.params.reduce((n, p) => n + (p[1] === 'color' ? 3 : TAILS[p[1]] ? 0 : 1), 0);

// Checks one texture's ops; returns an error string or null. `count` = number of textures in the level.
export function checkRecipe(ops, count, self) {
  let depth = 0;
  for (let i = 0; i < ops.length; i++) {
    const { op, args } = ops[i];
    const spec = OPS[op];
    const at = `op ${i + 1}`;
    if (!spec) return `${at}: unknown op ${op}`;
    const name = `${at} (${spec.name})`;
    if (depth < spec.pop) return `${name} needs ${spec.pop} layer(s), has ${depth}`;
    if (spec.final && i !== ops.length - 1) return `${name} must be the last op`;
    let pos = 0;
    for (const [pname, kind, min, max] of spec.params) {
      const tail = TAILS[kind];
      if (tail) {
        const n = args.length - pos;
        if (tail.sizes ? !tail.sizes.includes(n) : n < tail.min || n > tail.max || n % tail.step) return `${name}: bad ${pname} length`;
        if (kind === 'text' && args.slice(pos).some((c) => !FONT[String.fromCharCode(c)])) return `${name}: unsupported character`;
        if (kind === 'stops') for (let s = pos + 4; s < args.length; s += 4) if (args[s] < args[s - 4]) return `${name}: stops out of order`;
        pos = args.length;
      } else {
        const len = kind === 'color' ? 3 : 1;
        if (pos + len > args.length) return `${name}: missing ${pname}`;
        if (kind === 'u8' && (args[pos] < min || args[pos] > max)) return `${name}: ${pname} out of range`;
        pos += len;
      }
    }
    if (pos !== args.length) return `${name}: wrong number of arguments`;
    if (op === 80 && (args[0] > count || args[0] === self + 1)) return `${name}: no texture ${args[0]}`;
    depth = depth - spec.pop + 1;
    if (depth > MAX_STACK) return `${name}: more than ${MAX_STACK} layers`;
  }
  return null;
}

// Validates every recipe, the total op count and reference cycles. Returns an error string or null.
export function checkTextures(textures) {
  let total = 0;
  for (let t = 0; t < textures.length; t++) {
    total += textures[t].ops.length;
    const err = checkRecipe(textures[t].ops, textures.length, t);
    if (err) return `texture ${t + 1}: ${err}`;
  }
  if (total > MAX_TOTAL_OPS) return `too many texture ops in total (${total} > ${MAX_TOTAL_OPS})`;
  const state = []; // 1 = visiting, 2 = done
  const visit = (t) => {
    if (state[t] === 2) return null;
    if (state[t] === 1) return `texture ${t + 1}: references form a cycle`;
    state[t] = 1;
    for (const o of textures[t].ops) {
      if (o.op !== 80) continue;
      const err = visit(o.args[0] - 1);
      if (err) return err;
    }
    state[t] = 2;
    return null;
  };
  for (let t = 0; t < textures.length; t++) {
    const err = visit(t);
    if (err) return err;
  }
  return null;
}

// Splits raw args into named values for the editor and the generator.
export function readParams(op, args) {
  const out = {};
  let pos = 0;
  for (const [name, kind] of OPS[op].params) {
    if (TAILS[kind]) {
      out[name] = args.slice(pos);
      pos = args.length;
    } else if (kind === 'color') out[name] = args.slice(pos, (pos += 3));
    else out[name] = args[pos++];
  }
  return out;
}

export function defaultArgs(op) {
  const args = [];
  for (const [name, kind, a, b, def] of OPS[op].params) {
    if (kind === 'color') args.push(...a);
    else if (kind === 'pos') args.push(a);
    else if (kind === 'u8') args.push(def);
    else if (kind === 'points') args.push(128, 32, 223, 200, 32, 200);
    else if (kind === 'text') args.push(...[...'HELLO'].map((c) => c.charCodeAt(0)));
    else if (kind === 'bits') args.push(...new Array(32).fill(0).map((_, i) => (i % 4 < 2 ? 0x0f : 0xf0)));
    else if (kind === 'stops') args.push(0, 0, 0, 0, 255, 255, 255, 255);
  }
  return args;
}

// ---------- generation ----------

const cache = new Map(); // recipe list JSON -> images, the last few (a level's and the pack's lists)

// images[0] is the default texture; images[i] is textures[i-1]. Invalid or empty recipes get a placeholder.
// Results are memoized on the recipe list, so callers can ask on every edit.
export function generateTextures(textures) {
  const key = JSON.stringify(textures);
  if (cache.has(key)) return cache.get(key);
  const valid = !checkTextures(textures);
  const layers = [];
  const result = (t) => {
    if (layers[t] === 'busy') throw new Error('reference cycle');
    if (!layers[t]) {
      layers[t] = 'busy';
      layers[t] = runRecipe(textures[t], result);
    }
    return layers[t];
  };
  const images = [placeholderTexture(0)];
  textures.forEach((tex, t) => {
    if (!valid && checkRecipe(tex.ops, textures.length, t)) images.push(placeholderTexture(t + 1, tex.size));
    else if (!tex.ops.length) images.push(placeholderTexture(t + 1, tex.size));
    else {
      try {
        images.push(toImage(result(t), tex));
      } catch {
        images.push(placeholderTexture(t + 1, tex.size)); // e.g. a cycle in an invalid level being edited
      }
    }
  });
  cache.set(key, images);
  if (cache.size > 4) cache.delete(cache.keys().next().value);
  return images;
}

// Same images, generated in a module worker so the page stays responsive. Browsers without module
// workers (Firefox < 114, Safari < 15) throw or fire 'error' on load, so they generate here instead.
export function generateTexturesAsync(textures) {
  return new Promise((resolve) => {
    let worker = null;
    const here = () => {
      if (worker) worker.terminate();
      resolve(generateTextures(textures));
    };
    try {
      worker = new Worker(new URL('./texworker.js', import.meta.url), { type: 'module' });
    } catch {
      return here();
    }
    worker.onmessage = (e) => {
      worker.terminate();
      resolve(e.data);
    };
    worker.onerror = here;
    worker.postMessage(textures);
  });
}

// Returns the top layer before the final Shade, at the recipe's own size.
function runRecipe(tex, refResult) {
  const N = tex.size;
  const stack = [];
  for (const { op, args } of tex.ops) {
    if (op === 64) break;
    const p = readParams(op, args);
    const spec = OPS[op];
    const inputs = stack.splice(stack.length - spec.pop, spec.pop);
    stack.push(apply(op, p, inputs, N, refResult));
  }
  return stack.length ? stack[stack.length - 1] : layer(N, () => [0.5, 0.5, 0.5, 0.5, 1]);
}

function layer(N, f) {
  const L = { N, r: new Float32Array(N * N), g: new Float32Array(N * N), b: new Float32Array(N * N), h: new Float32Array(N * N), a: new Float32Array(N * N) };
  if (f) {
    for (let y = 0, i = 0; y < N; y++) {
      for (let x = 0; x < N; x++, i++) {
        const v = f(x, y);
        L.r[i] = v[0]; L.g[i] = v[1]; L.b[i] = v[2]; L.h[i] = v[3]; L.a[i] = v[4];
      }
    }
  }
  return L;
}

const CH = ['r', 'g', 'b', 'h', 'a'];
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (e0, e1, v) => {
  if (e1 <= e0) return v < e0 ? 0 : 1;
  const t = clamp01((v - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const gray = (v) => [v, v, v, v, 1];
// Shapes: color = height = mask = antialiased coverage from a signed distance in pixels (white on black).
const shape = (N, sd) => layer(N, (x, y) => { const m = clamp01(0.5 - sd(x + 0.5, y + 0.5)); return [m, m, m, m, m]; });
const pos = (v, N) => (v / 255) * N;

function apply(op, p, inputs, N, refResult) {
  const [A, B, C] = inputs;
  switch (op) {
    case 1: return layer(N, () => [...p.color.map((c) => c / 255), p.height / 255, 1]);
    case 2: {
      const n = noiseField(N, p.seed, p.scale, p.octaves, p.roughness / 255);
      return layer(N, (x, y) => gray(n[y * N + x]));
    }
    case 3: return cells(N, p.seed, p.count, p.mode);
    case 4: {
      const soft = p.softness / 255;
      return layer(N, (x, y) => {
        const v = 0.5 + 0.5 * Math.cos(2 * Math.PI * ((p['x count'] * x) / N + (p['y count'] * y) / N));
        return gray(soft >= 1 ? v : smooth(0.5 - soft / 2, 0.5 + soft / 2, v));
      });
    }
    case 5: return bricks(N, p);
    case 6: {
      const [x0, y0, x1, y1] = [p.x0, p.y0, p.x1, p.y1].map((v) => pos(v, N));
      const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy || 1;
      return layer(N, (x, y) => gray(p.type ? clamp01(Math.hypot(x - x0, y - y0) / Math.sqrt(len2)) : clamp01(((x - x0) * dx + (y - y0) * dy) / len2)));
    }
    case 16: case 17: {
      const [x0, y0, x1, y1] = [p.x0, p.y0, p.x1, p.y1].map((v) => pos(v, N));
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, hx = Math.abs(x1 - x0) / 2, hy = Math.abs(y1 - y0) / 2;
      const r = op === 17 ? Math.min(pos(p.radius, N), hx, hy) : 0;
      return shape(N, (x, y) => {
        const qx = Math.abs(x - cx) - hx + r, qy = Math.abs(y - cy) - hy + r;
        return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
      });
    }
    case 18: {
      const cx = pos(p.x, N), cy = pos(p.y, N), r = pos(p.radius, N);
      return shape(N, (x, y) => Math.hypot(x - cx, y - cy) - r);
    }
    case 19: {
      const [x0, y0, x1, y1] = [p.x0, p.y0, p.x1, p.y1].map((v) => pos(v, N));
      const w = pos(p.width, N) / 2;
      return shape(N, (x, y) => segDist(x, y, x0, y0, x1, y1) - w);
    }
    case 20: {
      const pts = [];
      for (let i = 0; i < p.points.length; i += 2) pts.push([pos(p.points[i], N), pos(p.points[i + 1], N)]);
      return shape(N, (x, y) => polyDist(x, y, pts));
    }
    case 21: return text(N, p);
    case 22: return stamp(N, p);
    case 32: return warp(A, p);
    case 33: return blur(A, Math.max(1, Math.round((p.radius * N) / 64)));
    case 34: return layer(N, (x, y) => sample(A, (x * p.x) % N, (y * p.y) % N));
    case 35: return bevel(A, (p.width * N) / 64, p.mode);
    case 36: {
      const keys = [['r', 'g', 'b'], ['h'], ['a'], CH][p.what];
      const L = copy(A);
      for (const k of keys) for (let i = 0; i < N * N; i++) L[k][i] = 1 - L[k][i];
      return L;
    }
    case 37: {
      const L = copy(A), lv = p.level / 255, s = p.softness / 510;
      for (let i = 0; i < N * N; i++) L.h[i] = L.a[i] = smooth(lv - s, lv + s, L.h[i]);
      return L;
    }
    case 48: case 49: case 50: case 51: return combine(op, A, B, p.amount / 255);
    case 52: {
      const L = layer(N), t = p.amount / 255;
      for (let i = 0; i < N * N; i++) {
        const m = C.h[i] * t;
        for (const k of CH) L[k][i] = A[k][i] + (B[k][i] - A[k][i]) * m;
      }
      return L;
    }
    case 53: {
      const L = copy(A), s = p.stops;
      for (let i = 0; i < N * N; i++) {
        const v = A.h[i] * 255;
        let k = 0;
        while (k + 4 < s.length && s[k + 4] <= v) k += 4;
        const j = Math.min(k + 4, s.length - 4);
        const t = s[j] > s[k] ? clamp01((v - s[k]) / (s[j] - s[k])) : 0;
        L.r[i] = (s[k + 1] + (s[j + 1] - s[k + 1]) * t) / 255;
        L.g[i] = (s[k + 2] + (s[j + 2] - s[k + 2]) * t) / 255;
        L.b[i] = (s[k + 3] + (s[j + 3] - s[k + 3]) * t) / 255;
      }
      return L;
    }
    case 80: {
      const R = refResult(p.texture - 1);
      return R.N === N ? R : layer(N, (x, y) => sample(R, Math.floor((x * R.N) / N), Math.floor((y * R.N) / N)));
    }
  }
}

function copy(A) {
  const L = layer(A.N);
  for (const k of CH) L[k].set(A[k]);
  return L;
}

const sample = (L, x, y) => { const i = y * L.N + x; return [L.r[i], L.g[i], L.b[i], L.h[i], L.a[i]]; };

// B onto A, weighted by B's mask and the amount.
function combine(op, A, B, amt) {
  const L = layer(A.N);
  for (let i = 0; i < A.N * A.N; i++) {
    const t = B.a[i] * amt;
    for (const k of CH) {
      const a = A[k][i], b = B[k][i];
      let v;
      if (k === 'a') v = op === 48 ? a + b * amt : op === 49 ? a - b * amt : op === 50 ? a * (1 + (b - 1) * amt) : Math.max(a, b * amt);
      else v = op === 48 ? a + b * t : op === 49 ? a - b * t : op === 50 ? a * (1 + (b - 1) * t) : a + (b - a) * t;
      L[k][i] = clamp01(v);
    }
  }
  return L;
}

// Tileable fractal value noise. Lattice tables come from mulberry32, one per octave.
function noiseField(N, seedV, scale, octaves, rough) {
  const out = new Float32Array(N * N);
  let amp = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    const P = Math.min(scale << o, N);
    const rnd = mulberry32(seedV * 977 + o * 131 + 1);
    const lat = Float32Array.from({ length: P * P }, () => rnd() / 4294967296);
    for (let y = 0; y < N; y++) {
      const fy = (y / N) * P, iy = Math.floor(fy), ty = fy - iy, sy = ty * ty * (3 - 2 * ty);
      const y0 = iy % P, y1 = (iy + 1) % P;
      for (let x = 0; x < N; x++) {
        const fx = (x / N) * P, ix = Math.floor(fx), tx = fx - ix, sx = tx * tx * (3 - 2 * tx);
        const x0 = ix % P, x1 = (ix + 1) % P;
        const a = lat[y0 * P + x0] + (lat[y0 * P + x1] - lat[y0 * P + x0]) * sx;
        const b = lat[y1 * P + x0] + (lat[y1 * P + x1] - lat[y1 * P + x0]) * sx;
        out[y * N + x] += (a + (b - a) * sy) * amp;
      }
    }
    total += amp;
    amp *= rough;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

// Tileable Voronoi: one jittered point per grid cell, nearest search over the 3x3 neighbourhood.
function cells(N, seedV, count, mode) {
  const rnd = mulberry32(seedV * 7919 + 3);
  const pts = Array.from({ length: count * count }, () => [rnd() / 4294967296, rnd() / 4294967296, rnd() / 4294967296]);
  return layer(N, (x, y) => {
    const fx = ((x + 0.5) / N) * count, fy = ((y + 0.5) / N) * count;
    const cx = Math.floor(fx), cy = Math.floor(fy);
    let d1 = 9, d2 = 9, id = 0;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const gx = cx + i, gy = cy + j;
        const pt = pts[(((gy % count) + count) % count) * count + (((gx % count) + count) % count)];
        const d = Math.hypot(gx + pt[0] - fx, gy + pt[1] - fy);
        if (d < d1) { d2 = d1; d1 = d; id = pt[2]; } else if (d < d2) d2 = d;
      }
    }
    return gray(mode === 0 ? clamp01(d1) : mode === 1 ? clamp01(d2 - d1) : id);
  });
}

function bricks(N, p) {
  const rnd = mulberry32(p.seed * 104729 + 5);
  const shade = Float32Array.from({ length: p.columns * p.rows }, () => 0.75 + 0.25 * (rnd() / 4294967296));
  const bw = N / p.columns, bh = N / p.rows;
  const mortar = ((p.mortar / 255) * Math.min(bw, bh)) / 2;
  return layer(N, (x, y) => {
    const row = Math.floor((y + 0.5) / bh);
    const sx = x + 0.5 + (row % 2) * (p.shift / 255) * bw;
    const col = Math.floor(sx / bw) % p.columns;
    const ex = Math.min(sx % bw, bw - (sx % bw)), ey = Math.min((y + 0.5) % bh, bh - ((y + 0.5) % bh));
    const v = clamp01(Math.min(ex, ey) - mortar + 0.5) * shade[row * p.columns + col];
    return gray(v);
  });
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = clamp01(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1));
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
}

// Signed distance to a polygon (even-odd inside test).
function polyDist(x, y, pts) {
  let d = Infinity, inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    d = Math.min(d, segDist(x, y, xi, yi, xj, yj));
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside ? -d : d;
}

// Bitmap shapes (text, stamp): nearest-neighbour, no antialiasing.
// Text box in 0..255 tile units: half width/height of the unrotated text. Shared with the editor's hit test.
export function textBox(p) {
  return [((p.text.length * 6 - 1) * p.size) / 2, (7 * p.size) / 2];
}

// Rotated around its center; 4 samples per pixel so rotated edges are smooth.
function text(N, p) {
  const cell = (p.size / 255) * N; // size of one font pixel
  const cx = pos(p.x, N), cy = pos(p.y, N);
  const [hw, hh] = textBox(p).map((v) => pos(v, N));
  const ang = (p.angle / 256) * 2 * Math.PI, c = Math.cos(ang), s = Math.sin(ang);
  const chars = p.text.map((ch) => FONT[String.fromCharCode(ch)]);
  const on = (x, y) => {
    const dx = x - cx - N * Math.round((x - cx) / N), dy = y - cy - N * Math.round((y - cy) / N); // nearest tiled copy
    const gx = Math.floor((dx * c + dy * s + hw) / cell), gy = Math.floor((-dx * s + dy * c + hh) / cell);
    const ch = chars[Math.floor(gx / 6)];
    return gx >= 0 && gy >= 0 && gy < 7 && ch && gx % 6 < 5 && (ch[gy] >> (4 - (gx % 6))) & 1 ? 0.25 : 0;
  };
  return layer(N, (x, y) => {
    const m = on(x + 0.25, y + 0.25) + on(x + 0.75, y + 0.25) + on(x + 0.25, y + 0.75) + on(x + 0.75, y + 0.75);
    return [m, m, m, m, m];
  });
}

function stamp(N, p) {
  const S = p.pixels.length === 32 ? 16 : 32;
  const [x0, y0, x1, y1] = [p.x0, p.y0, p.x1, p.y1].map((v) => pos(v, N));
  return layer(N, (x, y) => {
    const u = Math.floor(((x + 0.5 - x0) / (x1 - x0)) * S), v = Math.floor(((y + 0.5 - y0) / (y1 - y0)) * S);
    const on = u >= 0 && v >= 0 && u < S && v < S && (p.pixels[(v * S + u) >> 3] >> (7 - (u & 7))) & 1;
    return on ? [1, 1, 1, 1, 1] : [0, 0, 0, 0, 0];
  });
}

function warp(A, p) {
  const N = A.N;
  const nx = noiseField(N, p.seed, p.scale, 3, 0.5), ny = noiseField(N, p.seed + 101, p.scale, 3, 0.5);
  const s = (p.strength / 255) * N * 0.25;
  return layer(N, (x, y) => {
    const i = y * N + x;
    return bilinear(A, x + (nx[i] - 0.5) * 2 * s, y + (ny[i] - 0.5) * 2 * s);
  });
}

function bilinear(L, x, y) {
  const N = L.N, x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
  const w = (v) => ((v % N) + N) % N;
  const i00 = w(y0) * N + w(x0), i10 = w(y0) * N + w(x0 + 1), i01 = w(y0 + 1) * N + w(x0), i11 = w(y0 + 1) * N + w(x0 + 1);
  return CH.map((k) => {
    const c = L[k];
    const a = c[i00] + (c[i10] - c[i00]) * tx, b = c[i01] + (c[i11] - c[i01]) * tx;
    return a + (b - a) * ty;
  });
}

// Two passes of a wrapping box blur per axis (close to Gaussian), cost independent of radius.
function blur(A, r) {
  const N = A.N;
  let L = copy(A);
  const tmp = new Float32Array(N);
  for (let pass = 0; pass < 2; pass++) {
    for (const k of CH) {
      const c = L[k];
      for (let axis = 0; axis < 2; axis++) {
        for (let line = 0; line < N; line++) {
          const at = (t) => (axis ? (((t % N) + N) % N) * N + line : line * N + (((t % N) + N) % N));
          let sum = 0;
          for (let t = -r; t <= r; t++) sum += c[at(t)];
          for (let t = 0; t < N; t++) {
            tmp[t] = sum / (2 * r + 1);
            sum += c[at(t + r + 1)] - c[at(t - r)];
          }
          for (let t = 0; t < N; t++) c[at(t)] = tmp[t];
        }
      }
    }
  }
  return L;
}

// Height from distance to the mask edge (chamfer distance transform). Raised: ramps up inside the shape.
// Engraved: the surface outside is high and the shape slopes down into it.
function bevel(A, width, mode) {
  const N = A.N, D = Math.SQRT2;
  const d = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) d[i] = A.a[i] > 0.5 ? 1e9 : 0;
  const w = (v) => (v + N) % N;
  const back = [[-1, 0, 1], [0, -1, 1], [-1, -1, D], [1, -1, D]];
  // Forward and backward passes, twice, so distances also propagate across the wrapped tile edges.
  for (let rep = 0; rep < 2; rep++) {
    for (const sign of [1, -1]) {
      for (let k = 0; k < N * N; k++) {
        const i = sign > 0 ? k : N * N - 1 - k;
        if (!d[i]) continue;
        const x = i % N, y = (i - x) / N;
        for (const [dx, dy, c] of back) d[i] = Math.min(d[i], d[w(y + dy * sign) * N + w(x + dx * sign)] + c);
      }
    }
  }
  const L = copy(A);
  for (let i = 0; i < N * N; i++) {
    const prof = smooth(0, 1, (d[i] - 0.5) / width) * A.a[i];
    L.h[i] = mode ? 1 - prof : prof;
  }
  return L;
}

// Final output: RGBA bytes; a final Shade op lights the height field from the top-left.
// Shade also turns on normal mapping in the renderer: `heights` (u8 per pixel) and `bump` (slope per height step,
// same scale as the baked shading), so the normal map costs no link bytes.
// A transparent texture puts the top layer's mask in alpha instead, so it has no normal map.
function toImage(L, tex) {
  const N = L.N;
  const last = tex.ops[tex.ops.length - 1];
  const strength = last.op === 64 ? last.args[0] / 255 : 0;
  const data = new Uint8ClampedArray(N * N * 4);
  const heights = new Uint8ClampedArray(N * N);
  const lx = -1 / Math.sqrt(6), ly = -1 / Math.sqrt(6), lz = 2 / Math.sqrt(6);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      let k = 1;
      if (strength) {
        const h = (xx, yy) => L.h[((yy + N) % N) * N + ((xx + N) % N)];
        const s = strength * (N / 16); // slopes in "tile units" so 64 and 128 px look alike
        const dx = (h(x + 1, y) - h(x - 1, y)) * s, dy = (h(x, y + 1) - h(x, y - 1)) * s;
        const len = Math.hypot(dx, dy, 1);
        k = Math.max(0, (-dx * lx - dy * ly + lz) / len) / lz; // flat surface = 1
      }
      data[i * 4] = L.r[i] * k * 255;
      data[i * 4 + 1] = L.g[i] * k * 255;
      data[i * 4 + 2] = L.b[i] * k * 255;
      data[i * 4 + 3] = tex.transparent ? L.a[i] * 255 : 255;
      heights[i] = L.h[i] * 255;
    }
  }
  if (tex.transparent) return { width: N, height: N, data, transparent: true };
  return { width: N, height: N, data, heights, bump: strength * (N / 16) };
}

// Tinted tile used for the default texture and for empty or broken recipes.
export function placeholderTexture(index, size = 64) {
  const data = new Uint8ClampedArray(size * size * 4);
  const rnd = mulberry32(index + 1);
  // Index 0 (default texture) is neutral grey; others get a hue from the golden angle.
  const h = index * 2.39996;
  const tint = index ? [0, 2, 4].map((k) => 0.75 + 0.25 * Math.cos(h - (k * Math.PI) / 3)) : [1, 1, 1];
  const cell = size / 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const edge = x % cell === 0 || y % cell === 0;
      const v = (edge ? 120 : 190) + (rnd() % 24) - ((((x / cell) ^ (y / cell)) & 1) * 14);
      const i = (y * size + x) * 4;
      for (let k = 0; k < 3; k++) data[i + k] = v * tint[k];
      data[i + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}
