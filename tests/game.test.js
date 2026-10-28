import assert from 'node:assert/strict';
import { step, makeBrush, PHYS } from '../src/game.js';
import { buildFaces } from '../src/render.js';
import { decodeBytes, encodeBytes } from '../src/format.js';
import { demoLevel, demoPack } from '../src/demo.js';

const box = (min, max) => makeBrush({ min, max, solid: true });
const EPS = 0.05; // traces stop 0.01 short of surfaces
const floor = box([-500, -8, -500], [500, 0, 500]);
const idle = { forward: 0, right: 0, jump: false };
const player = (pos) => ({ pos, vel: [0, 0, 0], yaw: 0, pitch: 0, onGround: false });
const run = (p, solids, input, seconds) => { for (let t = 0; t < seconds * 120; t++) step(p, solids, input, 1 / 120); };

// Falls and lands on the floor.
let p = player([0, 20, 0]);
run(p, [floor], idle, 2);
assert.ok(Math.abs(p.pos[1]) < EPS && p.onGround, `landed at ${p.pos[1]}`);

// Walks forward (-z at yaw 0), reaches max speed, stops at a wall without passing it.
p = player([0, 0, 0]);
run(p, [floor], { forward: 1, right: 0, jump: false }, 1);
assert.ok(p.pos[2] < -40 && Math.abs(Math.hypot(p.vel[0], p.vel[2]) - PHYS.maxSpeed) < 1);
const wall = box([-50, 0, -60], [50, 50, -52]);
p = player([0, 0, 0]);
run(p, [floor, wall], { forward: 1, right: 0, jump: false }, 3);
assert.ok(Math.abs(p.pos[2] - (-52 + PHYS.halfWidth)) < EPS, `stopped at ${p.pos[2]}`);

// Friction stops the player.
run(p, [floor, wall], idle, 2);
assert.equal(Math.hypot(p.vel[0], p.vel[2]), 0);

// Step-up: climbs a 3-unit ledge, not a 4-unit one.
for (const [h, climbs] of [[2, true], [3, true], [4, false]]) {
  p = player([0, 0, 0]);
  run(p, [floor, box([-50, 0, -400], [50, h, -20])], { forward: 1, right: 0, jump: false }, 1.5);
  assert.equal(Math.abs(p.pos[1] - h) < EPS, climbs, `ledge ${h}: y=${p.pos[1]}`);
}

// Jump height ~ v²/2g.
p = player([0, 0, 0]);
run(p, [floor], idle, 0.1);
let top = 0;
for (let t = 0; t < 240; t++) { step(p, [floor], { forward: 0, right: 0, jump: t < 1 }, 1 / 120); top = Math.max(top, p.pos[1]); }
const expected = PHYS.jumpSpeed ** 2 / (2 * PHYS.gravity);
assert.ok(Math.abs(top - expected) < 0.5, `jump ${top} vs ${expected}`);
assert.ok(top < 12, 'jumps onto the 4-unit block but not much higher');

// Demo level round-trips, and face culling hides faces under neighbours.
const demo = demoLevel();
assert.deepEqual(decodeBytes(encodeBytes(demoPack())), demoPack());
const faces = buildFaces(demo).length;
assert.ok(faces < demo.boxes.length * 6, `culled: ${faces} of ${demo.boxes.length * 6}`);
// Two stacked boxes: the shared faces disappear.
const two = { textures: [], boxes: [[[0, 0, 0], [8, 8, 8]], [[0, 8, 0], [8, 16, 8]]].map(([min, max]) => ({ min, max, solid: true, faces: Array(6).fill({ tex: 0, scale: 16, ox: 0, oy: 0 }) })) };
assert.equal(buildFaces(two).length, 10);

console.log(`game: ok (demo ${faces}/${demo.boxes.length * 6} faces drawn)`);
