import assert from 'node:assert/strict';
import { convexHull, hullOf, corners, faceSlot, setCorner, fitShape } from '../src/shape.js';
import { encodeBytes, decodeBytes, MAGIC } from '../src/format.js';
import { DecodeError } from '../src/bytes.js';
import { step, makeBrush, PHYS } from '../src/game.js';

const faces = () => Array.from({ length: 6 }, (_, i) => ({ tex: 0, scale: 16, ox: i, oy: 0 }));
const box = (min, max, shape) => ({ min, max, solid: true, faces: faces(), ...(shape ? { shape } : {}) });
const zero = () => Array.from({ length: 8 }, () => [0, 0, 0]);

// Hulls: a cube has 6 quads; a wedge (two top corners pulled down) has 5 faces; flat has none.
const cube = hullOf(box([0, 0, 0], [8, 8, 8]));
assert.equal(cube.faces.length, 6);
assert.ok(cube.faces.every((f) => f.verts.length === 4));
// Each face's normal points out and its vertices go counter-clockwise seen from outside.
for (const f of cube.faces) {
  const [a, b, c] = f.verts;
  const n = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])];
  assert.ok(n[0] * f.n[0] + n[1] * f.n[1] + n[2] * f.n[2] > 0, 'CCW from outside');
}
const wedgeShape = zero();
wedgeShape[6] = [0, -8, 0]; // corner 6 = x min, y max, z max
wedgeShape[7] = [0, -8, 0];
const wedge = box([0, 0, 0], [8, 8, 8], wedgeShape);
assert.equal(hullOf(wedge).faces.length, 5);
assert.equal(convexHull([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]]), null);
assert.equal(faceSlot([0, 5, -3]), 3);
assert.equal(faceSlot([-2, 1, 1]), 0);

// setCorner grows the box to contain the corner and keeps the other corners in place; flat shapes are refused.
const b = box([0, 0, 0], [8, 8, 8]);
const before = corners(b);
assert.ok(setCorner(b, 7, [12, 8, 8]));
assert.deepEqual(b.max, [12, 8, 8]);
assert.deepEqual(corners(b).slice(0, 7), before.slice(0, 7));
assert.ok(setCorner(b, 7, [8, 8, 8]));
assert.equal(b.shape, undefined, 'back to a plain box');
const flat = box([0, 0, 0], [8, 8, 8]);
for (const i of [2, 3, 6]) setCorner(flat, i, [i & 1 ? 8 : 0, 0, i & 4 ? 8 : 0]);
assert.equal(setCorner(flat, 7, [8, 0, 8]), false);
// fitShape clamps offsets into a smaller box.
const fit = box([0, 0, 0], [8, 8, 8], wedgeShape.map((o) => [...o]));
fit.max[1] = 4;
assert.ok(fitShape(fit));
assert.deepEqual(fit.shape[6], [0, -4, 0]);

// Format: shapes round-trip; bad offsets and flat shapes are rejected.
const level = { name: '', ambient: [0, 0, 0], fog: [0, 0, 0], fogDist: 0, textures: [], boxes: [wedge, box([0, 0, 0], [8, 8, 8])], entities: [] };
const bytes = encodeBytes({ levels: [level] });
assert.deepEqual(decodeBytes(bytes).levels[0], level);
assert.deepEqual(encodeBytes(decodeBytes(bytes)), bytes);
const bad = (shape) => () => decodeBytes(encodeBytes({ levels: [{ ...level, boxes: [box([0, 0, 0], [8, 8, 8], shape)] }] }));
const out = zero(); out[0] = [-1, 0, 0]; // min corner may only move inward (+)
assert.throws(bad(out), /corner offset out of range/);
assert.throws(bad(zero()), /empty shape/);
const squash = zero(); for (const i of [2, 3, 6, 7]) squash[i] = [0, -8, 0];
assert.throws(bad(squash), /no volume/);
assert.equal(MAGIC, bytes[0]);

// Collision: a plain box brush has just its 6 axis planes.
assert.equal(makeBrush(box([0, 0, 0], [8, 8, 8])).planes.length, 6);

// Walking on shapes. Ramp rising towards -z: the +z end of the top is pulled down to the floor.
const ramp = (rise, depth) => {
  const s = zero();
  s[6] = [0, -rise, 0];
  s[7] = [0, -rise, 0];
  return box([-40, 0, -20 - depth], [40, rise, -20], s);
};
const floor = box([-500, -8, -500], [500, 0, 500]);
const player = () => ({ pos: [0, 0, 0], vel: [0, 0, 0], yaw: 0, pitch: 0, onGround: false });
const walk = (p, brushes, s) => { let ground = 0; const n = s * 120; for (let t = 0; t < n; t++) { step(p, brushes, { forward: 1, right: 0, jump: false }, 1 / 120); ground += p.onGround; } return ground / n; };

// Gentle ramp (rise 20 over 100): walked up, staying on the ground.
let p = player();
let g = walk(p, [makeBrush(floor), makeBrush(ramp(20, 100))], 1.4);
assert.ok(p.pos[1] > 14 && g > 0.95, `up the ramp: y=${p.pos[1]} ground=${g}`);
// Steep wedge (rise 40 over 10, ~76°): a wall.
p = player();
walk(p, [makeBrush(floor), makeBrush(ramp(40, 10))], 1.5);
assert.ok(p.pos[1] < 1 && p.pos[2] > -20, `blocked by steep slope: ${p.pos}`);
// Down the gentle ramp: stays on the ground the whole way (no hopping).
p = player();
p.yaw = Math.PI; // facing +z
p.pos = [0, 20, -119];
g = walk(p, [makeBrush(floor), makeBrush(ramp(20, 100))], 1.5);
assert.ok(p.pos[2] > -20 && Math.abs(p.pos[1]) < 0.05 && g > 0.95, `down the ramp: ${p.pos} ground=${g}`);
// Steep pyramid (sides ~63°): dropped onto a side, the player slides down and outwards instead of standing.
p = player();
p.pos = [12, 50, -60];
const apex = zero();
for (const i of [2, 3, 6, 7]) apex[i] = [i & 1 ? -20 : 20, 0, i & 4 ? -20 : 20];
const pyramid = [makeBrush(floor), makeBrush(box([-20, 0, -80], [20, 40, -40], apex))];
for (let t = 0; t < 360; t++) step(p, pyramid, { forward: 0, right: 0, jump: false }, 1 / 120);
assert.ok(p.pos[0] > 20 && p.pos[1] < 0.05, `slid off: ${p.pos}`);

// Fuzz: run into random leaning/tapered pillars from all sides, strafing and jumping. The player must never
// sink into the floor or end up inside the pillar. (Regression: sliding along a tilted face sank through the floor.)
{
  const { mulberry32 } = await import('../src/prng.js');
  const rnd = mulberry32(3);
  const r = (a, b) => a + (rnd() / 4294967296) * (b - a);
  const inside = (brush, q) => Math.max(...brush.planes.map((pl) => pl.n[0] * q[0] + pl.n[1] * q[1] + pl.n[2] * q[2] - pl.d));
  let runs = 0;
  for (let n = 0; n < 24; n++) {
    const shape = Array.from({ length: 8 }, (_, i) => [0, 1, 2].map((k) => {
      if (k === 1) return 0;
      const [lo, hi] = (i >> k) & 1 ? [-12, 0] : [0, 12];
      return (i & 2) || n % 2 ? Math.round(r(lo, hi)) : 0;
    }));
    const pillar = box([-8, 0, -8], [8, 64, 8], shape);
    if (!hullOf(pillar)) continue;
    const brushes = [makeBrush(floor), makeBrush(pillar)];
    for (let t = 0; t < 25; t++, runs++) {
      const ang = r(0, Math.PI * 2);
      const q = { pos: [Math.sin(ang) * 30, 0, Math.cos(ang) * 30], vel: [0, 0, 0], yaw: ang + r(-0.6, 0.6), pitch: 0, onGround: false };
      const input = { forward: 1, right: r(-1, 1), jump: rnd() % 4 === 0 };
      for (let i = 0; i < 300; i++) {
        step(q, brushes, input, 1 / 120);
        assert.ok(q.pos[1] > -0.01, `sank into the floor: shape ${n} run ${t} tick ${i} y=${q.pos[1]}`);
        assert.ok(inside(brushes[1], q.pos) > -0.01, `inside the pillar: shape ${n} run ${t} tick ${i}`);
      }
    }
  }
  assert.ok(runs > 400);
}

console.log('shape: ok');
