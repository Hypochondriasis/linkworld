// Baked lighting: light entities are lit into a lightmap atlas when a level loads, with shadows. No DOM/GL.
// Every lit face gets a rectangle of texels, one per `step` units, projected along its main axis. A texel stores
// the light reaching it (rgb / 2, so 2x overbright fits a byte) and the main direction that light comes from
// (rgb = dir * 0.5 + 0.5), so normal maps still respond to lights. Unlit faces share one black texel.
// Shadows come from visible boxes; doors, triggers, exits and boxes with transparent faces cast none
// (doors move, so like Quake they don't take part).
import { ENT, ON } from './format.js';
import { hullOf } from './shape.js';

const MAX_TEXELS = 1 << 19; // keeps the bake around a second on big levels; texels grow until it fits
const MAX_SIZE = 2048; // atlas width and height
const EPS = 1e-4;

// faces: [{ verts: CCW polygon, n: unit normal, a: projection axis }]. Sets face.lm (a lightmap uv per vertex).
// Returns { width, height, color, dir, step } with RGBA bytes.
export function bakeLight(level, faces) {
  const lights = level.entities.filter((e) => e.type === ENT.LIGHT && e.radius > 0);
  const casters = shadowCasters(level);
  const work = faces.map((f) => prepare(f, lights));
  let step = 4, layout;
  while (!(layout = pack(work, step))) step *= 2;
  const { width, height } = layout;
  const color = new Uint8Array(width * height * 4);
  const dir = new Uint8Array(width * height * 4);
  dir.set([128, 128, 255, 255]); // the shared unlit texel at 0,0
  color[3] = 255;
  const near = new Map(lights.map((l) => [l, casters.filter((c) => sphereHitsBox(l.pos, l.radius, c.min, c.max))]));
  const last = new Map(); // light -> caster that blocked its previous ray (neighbouring texels are usually blocked by it too)

  for (const w of work) {
    const f = w.face;
    if (!w.lights.length) {
      f.lm = f.verts.map(() => [0.5 / width, 0.5 / height]);
      continue;
    }
    const { u, v, a, umin, vmin, nu, nv, x0, y0 } = w;
    f.lm = f.verts.map((p) => [(x0 + 0.5 + (p[u] - umin) / step) / width, (y0 + 0.5 + (p[v] - vmin) / step) / height]);
    const n = f.n;
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        // Texel center on the face plane, clamped to the face's extent, nudged off the surface.
        const p = [0, 0, 0];
        p[u] = Math.min(umin + i * step, w.umax);
        p[v] = Math.min(vmin + j * step, w.vmax);
        p[a] = (w.d - n[u] * p[u] - n[v] * p[v]) / n[a];
        for (let k = 0; k < 3; k++) p[k] += n[k] * 0.5;
        let r = 0, g = 0, b = 0;
        const dsum = [0, 0, 0];
        for (const l of w.lights) {
          const d = [l.pos[0] - p[0], l.pos[1] - p[1], l.pos[2] - p[2]];
          const dist = Math.hypot(d[0], d[1], d[2]);
          if (dist >= l.radius) continue;
          const ndl = (n[0] * d[0] + n[1] * d[1] + n[2] * d[2]) / Math.max(dist, 1e-3);
          if (ndl <= 0 || blocked(p, l.pos, near.get(l), last, l)) continue;
          const k = (1 - dist / l.radius) ** 2 * ndl;
          r += (l.color[0] / 255) * k;
          g += (l.color[1] / 255) * k;
          b += (l.color[2] / 255) * k;
          const lum = (l.color[0] + l.color[1] + l.color[2]) * k;
          for (let c = 0; c < 3; c++) dsum[c] += (d[c] / dist) * lum;
        }
        const o = ((y0 + j) * width + x0 + i) * 4;
        color[o] = Math.min(255, r * 127.5);
        color[o + 1] = Math.min(255, g * 127.5);
        color[o + 2] = Math.min(255, b * 127.5);
        color[o + 3] = 255;
        const dl = Math.hypot(dsum[0], dsum[1], dsum[2]);
        const dn = dl > 0 ? dsum.map((x) => x / dl) : n;
        for (let c = 0; c < 3; c++) dir[o + c] = Math.round((dn[c] * 0.5 + 0.5) * 255);
        dir[o + 3] = 255;
      }
    }
  }
  return { width, height, color, dir, step };
}

// Lights that can reach the face (sphere touches its bounds, light in front), and its texel frame.
function prepare(face, lights) {
  const a = face.a, u = (a + 1) % 3, v = (a + 2) % 3, n = face.n;
  const lo = [0, 1, 2].map((k) => Math.min(...face.verts.map((p) => p[k])));
  const hi = [0, 1, 2].map((k) => Math.max(...face.verts.map((p) => p[k])));
  const d = n[0] * face.verts[0][0] + n[1] * face.verts[0][1] + n[2] * face.verts[0][2];
  const reach = lights.filter((l) => n[0] * l.pos[0] + n[1] * l.pos[1] + n[2] * l.pos[2] > d && sphereHitsBox(l.pos, l.radius, lo, hi));
  return { face, lights: reach, a, u, v, d, umin: lo[u], umax: hi[u], vmin: lo[v], vmax: hi[v] };
}

// Shelf packing, tallest first. Texel (0,0) is the shared unlit one. Null when it doesn't fit at this step.
function pack(work, step) {
  const lit = work.filter((w) => w.lights.length);
  let total = 1, widest = 1;
  for (const w of lit) {
    w.nu = Math.ceil((w.umax - w.umin) / step) + 1;
    w.nv = Math.ceil((w.vmax - w.vmin) / step) + 1;
    total += w.nu * w.nv;
    widest = Math.max(widest, w.nu);
  }
  if (total > MAX_TEXELS || widest > MAX_SIZE) return null;
  let width = 64;
  while (width < MAX_SIZE && (width < widest || width * width < total * 1.3)) width *= 2;
  let x = 1, y = 0, shelf = 1;
  for (const w of lit.slice().sort((p, q) => q.nv - p.nv)) {
    if (x + w.nu > width) { y += shelf; x = 0; shelf = 0; }
    w.x0 = x;
    w.y0 = y;
    x += w.nu;
    shelf = Math.max(shelf, w.nv);
  }
  let height = 1;
  while (height < y + shelf) height *= 2;
  return height > MAX_SIZE ? null : { width, height };
}

function shadowCasters(level) {
  // Doors move and enter-trigger/exit boxes are invisible; use and shoot trigger boxes are plain geometry.
  const skip = new Set(level.entities.filter((e) => 'box' in e && !(e.type === ENT.TRIGGER && e.on !== ON.ENTER)).map((e) => e.box));
  const seeThrough = (b) => b.faces.some((f) => f.tex && level.textures[f.tex - 1].transparent);
  return level.boxes.filter((b, i) => !skip.has(i) && !seeThrough(b)).map((b) => ({
    min: b.min,
    max: b.max,
    planes: b.shape ? hullOf(b).faces.map((f) => ({ n: f.n, d: f.n[0] * f.verts[0][0] + f.n[1] * f.verts[0][1] + f.n[2] * f.verts[0][2] })) : null,
  }));
}

function sphereHitsBox(c, r, lo, hi) {
  let d2 = 0;
  for (let k = 0; k < 3; k++) {
    const e = c[k] < lo[k] ? lo[k] - c[k] : c[k] > hi[k] ? c[k] - hi[k] : 0;
    d2 += e * e;
  }
  return d2 < r * r;
}

// Does the segment p -> q pass through a caster? Points exactly on a caster's surface are outside it.
// shortcut: tests every caster near the light (with a last-hit cache); add a grid if big levels bake slowly.
function blocked(p, q, casters, last, light) {
  const prev = last.get(light);
  if (prev && hits(prev, p, q)) return true;
  for (const c of casters) {
    if (c !== prev && hits(c, p, q)) {
      last.set(light, c);
      return true;
    }
  }
  return false;
}

function hits(c, p, q) {
  let enter = -Infinity, exit = Infinity;
  for (let k = 0; k < 3; k++) {
    const dk = q[k] - p[k];
    if (Math.abs(dk) < 1e-12) {
      if (p[k] <= c.min[k] || p[k] >= c.max[k]) return false;
      continue;
    }
    let t0 = (c.min[k] - p[k]) / dk, t1 = (c.max[k] - p[k]) / dk;
    if (t0 > t1) [t0, t1] = [t1, t0];
    if (t0 > enter) enter = t0;
    if (t1 < exit) exit = t1;
  }
  if (!(enter < exit && exit > EPS && enter < 1 - EPS)) return false;
  if (!c.planes) return true;
  enter = -Infinity;
  exit = Infinity;
  for (const { n, d } of c.planes) {
    const s = n[0] * p[0] + n[1] * p[1] + n[2] * p[2] - d;
    const dn = n[0] * (q[0] - p[0]) + n[1] * (q[1] - p[1]) + n[2] * (q[2] - p[2]);
    if (Math.abs(dn) < 1e-12) {
      if (s >= 0) return false;
      continue;
    }
    const t = -s / dn;
    if (dn < 0) enter = Math.max(enter, t);
    else exit = Math.min(exit, t);
  }
  return enter < exit && exit > EPS && enter < 1 - EPS;
}
