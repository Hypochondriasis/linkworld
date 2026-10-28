import assert from 'node:assert/strict';
import { createParticles, emitterDir, MAX_PARTICLES } from '../src/particles.js';
import { ENT } from '../src/format.js';

const near = (a, b) => a.every((v, k) => Math.abs(v - b[k]) < 1e-9);
assert.ok(near(emitterDir({ angle: 0, pitch: 0 }), [0, 0, -1]));
assert.ok(near(emitterDir({ angle: 64, pitch: 0 }), [-1, 0, 0]));
assert.ok(near(emitterDir({ angle: 0, pitch: 64 }), [0, 1, 0]));

const type = { tex: 0, additive: false, burst: false, rate: 100, life: 10, speed: 10, spread: 0, size0: 1, size1: 1, gravity: 0 };
const em = (kind = 0) => ({ type: ENT.EMITTER, pos: [5, 5, 5], angle: 0, pitch: 64, kind });

// Continuous: nothing until activated, then ~rate per second, dying after life.
const e = em();
const s = createParticles([type], [e]);
s.update(0.5);
assert.equal(s.list.length, 0);
s.fire(e);
for (let i = 0; i < 60; i++) s.update(1 / 120);
assert.equal(s.list.length, 50);
assert.ok(s.list.every((p) => Math.abs(p.pos[0] - 5) < 1e-9 && p.pos[1] > 5), 'spread 0 fires straight up');
for (let i = 0; i < 240; i++) s.update(1 / 120);
assert.ok(s.list.length <= 101 && s.list.length >= 99, `steady state ${s.list.length}`);

// Burst: `rate` particles at once, every one within the cone; gravity pulls down.
const be = em();
const b = createParticles([{ ...type, burst: true, spread: 64, gravity: 100 }], [be]);
b.fire(be);
assert.equal(b.list.length, 100);
const cos = Math.cos((64 / 255) * Math.PI);
assert.ok(b.list.every((p) => p.vel[1] / 10 >= cos - 1e-9));
b.update(0.1);
assert.ok(b.list.every((p) => p.vel[1] < 10));

// Global cap.
const many = Array.from({ length: 20 }, () => em());
const big = createParticles([{ ...type, burst: true, rate: 255 }], many);
for (const x of many) big.fire(x);
assert.equal(big.list.length, MAX_PARTICLES);
console.log('particles: ok');
