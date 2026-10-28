import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Worker as NodeWorker } from 'node:worker_threads';
import { OPS, checkRecipe, checkTextures, defaultArgs, generateTextures, generateTexturesAsync, MAX_STACK } from '../src/texgen.js';
import { PRESETS, insertPreset } from '../src/presets.js';
import { encodeBytes, decodeBytes } from '../src/format.js';
import { mulberry32 } from '../src/prng.js';

const hash = (img) => createHash('sha256').update(img.data).digest('hex');

// Presets: valid, deterministic, survive the binary format.
const textures = [];
for (const p of PRESETS) insertPreset(textures, p.name);
assert.equal(textures.length, PRESETS.length, 'door and crate reuse the wood slot');
assert.equal(checkTextures(textures), null);
const a = generateTextures(textures).map(hash);
// A different list defeats the memo cache, so this really regenerates.
const b = generateTextures([...textures, { size: 64, ops: [] }]).slice(0, a.length).map(hash);
assert.deepEqual(a, b);
const lv = { name: '', ambient: [0, 0, 0], fog: [0, 0, 0], fogDist: 0, textures, boxes: [], entities: [] };
assert.deepEqual(decodeBytes(encodeBytes({ levels: [lv] })).levels[0].textures, textures);

// Shade turns on the normal map (height + bump); no Shade or placeholder = flat.
const shaded = generateTextures(textures)[1];
assert.ok(shaded.bump > 0 && shaded.heights.length === 64 * 64 && shaded.heights.some((h) => h !== shaded.heights[0]));
assert.ok(!generateTextures([{ size: 64, ops: [{ op: 1, args: defaultArgs(1) }] }])[1].bump);
assert.ok(!generateTextures([])[0].bump);

// Transparent: alpha = mask, no normal map.
const clear = generateTextures([{ size: 64, transparent: true, ops: [{ op: 18, args: defaultArgs(18) }] }])[1];
assert.ok(clear.transparent && !clear.bump && clear.data[3] === 0 && clear.data.some((v, i) => i % 4 === 3 && v === 255));

// 128 px works and references across sizes resample.
const big = [{ size: 128, ops: textures[2].ops }, { size: 64, ops: [{ op: 80, args: [1] }] }];
const imgs = generateTextures(big);
assert.equal(imgs[1].width, 128);
assert.equal(imgs[2].width, 64);

// Every op with default args runs, on both sizes, and produces finite pixels.
const ops = Object.keys(OPS).map(Number);
for (const size of [64, 128]) {
  for (const op of ops) {
    const spec = OPS[op];
    const pre = Array.from({ length: spec.pop }, (_, i) => ({ op: 2, args: [i, 4, 3, 128] }));
    const recipe = op === 80 ? [{ op: 80, args: [2] }] : [...pre, { op, args: defaultArgs(op) }];
    const tex = [{ size, ops: recipe }, { size: 64, ops: [{ op: 1, args: [1, 2, 3, 4] }] }];
    assert.equal(checkTextures(tex), null, spec.name);
    const img = generateTextures(tex)[1];
    assert.ok(img.data.every((v) => Number.isFinite(v)), spec.name);
  }
}

// Random valid recipes never throw.
const rnd = mulberry32(11);
for (let n = 0; n < 150; n++) {
  const recipe = [];
  let depth = 0;
  for (let k = 0; k < 8; k++) {
    const cands = ops.filter((op) => OPS[op].pop <= depth && !OPS[op].final && op !== 80 && depth - OPS[op].pop + 1 <= MAX_STACK);
    const op = cands[rnd() % cands.length];
    // Random values within each param's range; variable-length tails keep their defaults.
    const def = defaultArgs(op);
    const args = [];
    for (const [, kind, min, max] of OPS[op].params) {
      if (kind === 'u8') args.push(min + (rnd() % (max - min + 1)));
      else if (kind === 'pos') args.push(rnd() & 255);
      else if (kind === 'color') args.push(rnd() & 255, rnd() & 255, rnd() & 255);
      else args.push(...def.slice(args.length));
    }
    recipe.push({ op, args });
    depth += 1 - OPS[op].pop;
  }
  if (rnd() & 1) recipe.push({ op: 64, args: [rnd() & 255] });
  assert.equal(checkRecipe(recipe, 1, 0), null);
  generateTextures([{ size: 64, ops: recipe }]);
}

// Text rotates around its center: "I" at 90° is wider than tall; 180° keeps a symmetric "H" the same size.
const textImg = (str, angle) => generateTextures([{ size: 64, ops: [{ op: 21, args: [128, 128, 12, angle, ...[...str].map((c) => c.charCodeAt(0))] }] }])[1];
const extent = (img) => {
  let x0 = 64, x1 = -1, y0 = 64, y1 = -1, lit = 0;
  for (let i = 0; i < 64 * 64; i++) if (img.data[i * 4] > 127) { const x = i % 64, y = (i - x) / 64; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); lit++; }
  return { w: x1 - x0 + 1, h: y1 - y0 + 1, lit };
};
const i0 = extent(textImg('I', 0)), i90 = extent(textImg('I', 64));
assert.ok(i0.h > i0.w && i90.w > i90.h, JSON.stringify([i0, i90]));
const h0 = extent(textImg('H', 0)), h180 = extent(textImg('H', 128));
assert.ok(Math.abs(h0.lit - h180.lit) <= h0.lit * 0.05 && Math.abs(h0.w - h180.w) <= 1);

// Validation errors.
const err = (recipe, count = 1, self = 0) => checkRecipe(recipe, count, self);
assert.match(err([{ op: 99, args: [] }]), /unknown op/);
assert.match(err([{ op: 48, args: [255] }]), /needs 2 layer/);
assert.match(err([{ op: 1, args: [1, 2, 3] }]), /missing height/);
assert.match(err([{ op: 1, args: [1, 2, 3, 4, 5] }]), /wrong number/);
assert.match(err([{ op: 2, args: [1, 0, 4, 128] }]), /scale out of range/);
assert.match(err([{ op: 2, args: [1, 4, 4, 128] }, { op: 64, args: [1] }, { op: 33, args: [1] }]), /must be the last/);
assert.match(err([{ op: 20, args: [1, 2, 3, 4] }]), /bad points length/);
assert.match(err([{ op: 21, args: [0, 0, 8, 0, 97] }]), /unsupported character/); // lowercase 'a'
assert.match(err([{ op: 22, args: [0, 0, 255, 255, 1, 2, 3] }]), /bad pixels length/);
assert.match(err([{ op: 2, args: [1, 4, 4, 128] }, { op: 53, args: [200, 0, 0, 0, 100, 1, 1, 1] }]), /out of order/);
assert.match(err([{ op: 80, args: [1] }]), /no texture 1/); // self
assert.match(err([{ op: 80, args: [3] }], 2), /no texture 3/);
assert.match(err(Array(MAX_STACK + 1).fill({ op: 1, args: [0, 0, 0, 0] })), /more than/);
assert.match(checkTextures([{ size: 64, ops: [{ op: 80, args: [2] }] }, { size: 64, ops: [{ op: 80, args: [3] }] }, { size: 64, ops: [{ op: 80, args: [1] }] }]), /cycle/);
assert.match(checkTextures(Array(5).fill({ size: 64, ops: [{ op: 1, args: [0, 0, 0, 0] }, ...Array(59).fill({ op: 33, args: [1] })] })), /too many texture ops/);

// Async generation gives the same images: here when there is no Worker (node, very old browsers) or it fails
// to load (no module workers: Firefox < 114), and from the real texworker.js run through a browser-like shim.
const same = async (msg) => assert.deepEqual((await generateTexturesAsync(textures)).map(hash), a, msg);
await same('no Worker');
globalThis.Worker = class { constructor() { setTimeout(() => this.onerror(new Error('load'))); } postMessage() {} terminate() {} };
await same('worker fails to load');
globalThis.Worker = class {
  constructor(url, opts) {
    assert.equal(opts.type, 'module');
    this.w = new NodeWorker(`const { parentPort } = require('node:worker_threads');
      globalThis.onmessage = null;
      globalThis.postMessage = (m) => parentPort.postMessage(m);
      const ready = import(${JSON.stringify(url.href)});
      parentPort.on('message', async (data) => { await ready; globalThis.onmessage({ data }); });`, { eval: true });
    this.w.on('message', (data) => this.onmessage({ data }));
  }
  postMessage(m) { this.w.postMessage(m); }
  terminate() { this.w.terminate(); }
};
await same('module worker');
delete globalThis.Worker;

console.log('texgen: ok');
