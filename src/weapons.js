// The player's weapons, without DOM: a hitscan rifle, a grenade launcher (grenades bounce, then explode on a
// fuse) and a crossbow (fast bolts that stick where they hit). Hits fire shoot triggers. The effects are
// built-in particle types (FX) and the meshes are flat-colored triangles, so they cost no link bytes.
import { cross, dot } from './shape.js';

export const WEAPONS = [
  { name: 'Rifle', delay: 0.2 },
  { name: 'Grenade launcher', delay: 0.8 },
  { name: 'Crossbow', delay: 0.9 },
];

const GRENADE = { speed: 150, lift: 25, gravity: 200, fuse: 2, bounce: 0.5, keep: 0.75, blast: 32 };
const BOLT = { speed: 700, gravity: 40, len: 3, sink: 1, flight: 5 };
const MAX_BOLTS = 64; // stuck bolts; the oldest goes first

// Effect particle types (particles.js format) and their color; fxScene gives them textures.
const SPARK = 0, SMOKE = 1, FIRE = 2, DUST = 3;
export const FX = [
  { color: [255, 210, 120], additive: true, life: 3, speed: 70, spread: 70, gravity: 150, size0: 0.7, size1: 0.1 },
  { color: [100, 96, 92], additive: false, life: 12, speed: 14, spread: 255, gravity: -10, size0: 3, size1: 9 },
  { color: [255, 140, 50], additive: true, life: 5, speed: 60, spread: 255, gravity: 0, size0: 7, size1: 1 },
  { color: [150, 140, 125], additive: false, life: 5, speed: 25, spread: 90, gravity: 80, size0: 1, size1: 0.4 },
].map((t) => ({ ...t, burst: true, rate: 0 }));

// images (the renderer's textures) plus a soft round dot per effect; particles: FX with those textures.
export function fxScene(images) {
  const blob = (c) => {
    const S = 16, data = new Uint8ClampedArray(S * S * 4);
    for (let i = 0; i < S * S; i++) {
      const r = Math.hypot((i % S) - 7.5, Math.floor(i / S) - 7.5) / 8;
      data.set([...c, Math.max(0, 1 - r * r) * 255], i * 4);
    }
    return { width: S, height: S, data, transparent: true };
  };
  return { images: [...images, ...FX.map((t) => blob(t.color))], particles: FX.map((t, k) => ({ ...t, tex: images.length + k })) };
}

const add = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const unit = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };

// api (from game.js): eye(), aim() (unit view direction), cast(o, dir, range) → { r, p, n } or null,
// shoot() (the rifle: cast along the view and fire what it hits; returns the hit), shot(hit) (fire what a hit hit),
// blast(p, radius), pin(hit, p, dir) → () => { p, dir } (follows a door), burst(fx, p, dir, count).
export function createWeapons(api) {
  const s = { current: 0, cool: 0, kick: 0 };
  const grenades = [], bolts = [];

  function fire() {
    const o = api.eye(), dir = api.aim();
    s.kick = 1;
    if (s.current === 0) {
      const h = api.shoot();
      if (h) {
        api.burst(SPARK, h.p, h.n || dir.map((x) => -x), 10);
        api.burst(DUST, h.p, h.n || dir.map((x) => -x), 5);
      }
    } else if (s.current === 1) {
      grenades.push({ p: o, v: add(dir.map((x) => x * GRENADE.speed), [0, GRENADE.lift, 0]), age: 0, trail: 0 });
    } else {
      bolts.push({ p: o, v: dir.map((x) => x * BOLT.speed), age: 0, at: null });
    }
  }

  // One tick of flight under gravity: the hit, or null after moving freely.
  function fly(q, g, dt) {
    q.v[1] -= g * dt;
    const len = Math.hypot(...q.v) * dt;
    const h = len > 0 && api.cast(q.p, q.v.map((x) => (x * dt) / len), len);
    if (!h) q.p = add(q.p, q.v, dt);
    return h || null;
  }

  function explode(g) {
    api.blast(g.p, GRENADE.blast);
    api.burst(FIRE, g.p, [0, 1, 0], 40);
    api.burst(SMOKE, g.p, [0, 1, 0], 16);
    api.burst(SPARK, g.p, [0, 1, 0], 30);
  }

  function update(dt, firing) {
    s.cool = Math.max(0, s.cool - dt);
    s.kick = Math.max(0, s.kick - dt * 6);
    if (firing && s.cool === 0) {
      fire();
      s.cool = WEAPONS[s.current].delay;
    }

    for (let i = grenades.length - 1; i >= 0; i--) {
      const g = grenades[i];
      if ((g.age += dt) >= GRENADE.fuse) {
        explode(g);
        grenades.splice(i, 1);
        continue;
      }
      if ((g.trail -= dt) <= 0) {
        g.trail = 0.06;
        api.burst(SMOKE, g.p, [0, 1, 0], 1);
      }
      const h = fly(g, GRENADE.gravity, dt);
      if (!h) continue;
      if (!h.n) { g.v = [0, 0, 0]; continue; } // started inside a solid (a door moved onto it)
      // Bounce: lose some speed along the surface, more across it; a slow bounce stops (it rests or rolls).
      const vn = dot(g.v, h.n);
      const out = -vn * GRENADE.bounce;
      g.v = add(add(g.v, h.n, -vn).map((x) => x * GRENADE.keep), h.n, out > 10 ? out : 0);
      g.p = add(h.p, h.n, 0.01);
    }

    for (let i = bolts.length - 1; i >= 0; i--) {
      const b = bolts[i];
      if (b.at) continue;
      if ((b.age += dt) >= BOLT.flight) { bolts.splice(i, 1); continue; }
      const h = fly(b, BOLT.gravity, dt);
      if (!h) continue;
      const dir = unit(b.v);
      b.at = api.pin(h, add(h.p, dir, BOLT.sink), dir);
      api.shot(h);
      api.burst(DUST, h.p, h.n || dir.map((x) => -x), 6);
    }
    const stuck = bolts.filter((b) => b.at);
    if (stuck.length > MAX_BOLTS) bolts.splice(bolts.indexOf(stuck[0]), 1);
  }

  // Grenades and bolts as flat-colored triangles: [x,y,z, r,g,b] per vertex.
  function mesh() {
    const out = [];
    for (const g of grenades) {
      const a = g.age * 9; // tumbling
      cuboid(out, g.p, [[0.6 * Math.cos(a), 0.6 * Math.sin(a), 0], [-0.6 * Math.sin(a), 0.6 * Math.cos(a), 0], [0, 0, 0.6]], [70, 90, 55]);
    }
    for (const b of bolts) {
      const { p, dir } = b.at ? b.at() : { p: b.p, dir: unit(b.v) };
      const u = unit(cross(dir, Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), w = cross(dir, u);
      cuboid(out, add(p, dir, -BOLT.len / 2), [dir.map((x) => (x * BOLT.len) / 2), u.map((x) => x * 0.1), w.map((x) => x * 0.1)], [185, 170, 140]);
      cuboid(out, add(p, dir, -BOLT.len + 0.3), [dir.map((x) => x * 0.3), u.map((x) => x * 0.3), w.map((x) => x * 0.02)], [190, 50, 40]);
    }
    return out;
  }

  // The weapon in hand for a camera { pos, yaw, pitch }, in the same format. Parts: [center, half size, color]
  // in view space (x right, y up, z forward).
  function viewModel(cam, right, up, fwd) {
    const parts = GUNS[s.current].filter((q) => !q[3] || s.cool < 0.3); // q[3]: hidden while reloading
    const out = [];
    for (const [c, h, color] of parts) {
      const at = add(add(add(cam.pos, right, c[0]), up, c[1] + s.kick * 0.05), fwd, c[2] - s.kick * 0.3);
      cuboid(out, at, [right.map((x) => x * h[0]), up.map((x) => x * h[1]), fwd.map((x) => x * h[2])], color);
    }
    return out;
  }

  return {
    update,
    grenades, // { p, v, age }
    bolts, // { p, v, age, at: () => { p, dir } once stuck }
    mesh,
    viewModel,
    get current() { return s.current; },
    select(i) {
      if (i === s.current || !WEAPONS[i]) return;
      s.current = i;
      s.cool = Math.max(s.cool, 0.3);
    },
  };
}

const GUNS = [
  [ // rifle
    [[0.9, -0.9, 2.2], [0.18, 0.22, 0.9], [70, 72, 78]],
    [[0.9, -0.8, 3.4], [0.07, 0.07, 0.6], [40, 40, 44]],
    [[0.9, -1.25, 1.7], [0.12, 0.25, 0.12], [90, 60, 40]],
  ],
  [ // grenade launcher
    [[0.9, -0.95, 2.4], [0.3, 0.3, 1], [60, 80, 50]],
    [[0.9, -0.95, 3.45], [0.22, 0.22, 0.08], [30, 30, 30]],
    [[0.9, -1.4, 1.9], [0.12, 0.25, 0.12], [90, 60, 40]],
  ],
  [ // crossbow
    [[0.9, -1, 2.2], [0.12, 0.14, 1.1], [110, 75, 45]],
    [[0.9, -0.9, 3.1], [0.9, 0.06, 0.08], [60, 50, 40]],
    [[0.9, -0.82, 2.6], [0.04, 0.04, 0.7], [200, 200, 190], true],
  ],
];

// A box with center c and three half-size vectors as 12 triangles, each face shaded by a fixed light.
const LIGHT = unit([0.4, 1, 0.3]);
function cuboid(out, c, ax, color) {
  for (let k = 0; k < 3; k++) for (const sg of [-1, 1]) {
    const a = ax[k].map((x) => x * sg), u = ax[(k + 1) % 3], v = ax[(k + 2) % 3];
    const shade = (0.55 + 0.45 * Math.max(0, dot(unit(a), LIGHT))) / 255;
    const f = add(c, a);
    const q = [add(add(f, u, -1), v, -1), add(add(f, u, 1), v, -1), add(add(f, u, 1), v, 1), add(add(f, u, -1), v, 1)];
    for (const i of [0, 1, 2, 0, 2, 3]) out.push(...q[i], ...color.map((x) => x * shade));
  }
}
