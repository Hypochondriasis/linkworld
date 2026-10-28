import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { DecodeError } from '../src/bytes.js';
import { deflate, inflate } from '../src/deflate.js';
import { encodeBytes, ENT } from '../src/format.js';
import { mulberry32 } from '../src/prng.js';

const rnd = mulberry32(5);
const bytes = (n, f) => Uint8Array.from({ length: n }, (_, i) => f(i));

// Level-like data: many near-identical boxes.
const level = {
  name: 'deflate test', ambient: [30, 30, 30], fog: [0, 0, 0], fogDist: 0, textures: [], entities: [{ type: ENT.PLAYER_START, pos: [0, 0, 0], angle: 0 }],
  boxes: Array.from({ length: 300 }, (_, i) => ({ min: [i * 8, 0, (i % 7) * 8], max: [i * 8 + 8, 16 + (i % 3) * 8, (i % 7) * 8 + 8], solid: true, faces: Array(6).fill({ tex: 0, scale: 16, ox: 0, oy: 0 }) })),
};

const inputs = {
  empty: new Uint8Array(0),
  one: new Uint8Array([42]),
  zeros: new Uint8Array(100000),
  random: bytes(5000, () => rnd() & 255),
  lowEntropy: bytes(20000, () => rnd() % 4),
  text: new TextEncoder().encode('the quick brown fox jumps over the lazy dog. '.repeat(200)),
  allBytes: bytes(256 * 40, (i) => i & 255),
  level: encodeBytes({ levels: [level] }),
};

const cap = 1 << 20;
for (const [name, data] of Object.entries(inputs)) {
  const ours = deflate(data);
  assert.deepEqual(new Uint8Array(zlib.inflateRawSync(ours)), data, `zlib reads ours: ${name}`);
  assert.deepEqual(inflate(ours, cap), data, `we read ours: ${name}`);
  const ref = zlib.deflateRawSync(data, { level: 9 });
  assert.deepEqual(inflate(new Uint8Array(ref), cap), data, `we read zlib: ${name}`);
  const stored = zlib.deflateRawSync(data, { level: 0 });
  assert.deepEqual(inflate(new Uint8Array(stored), cap), data, `we read stored: ${name}`);
  console.log(`  ${name.padEnd(10)} ${String(data.length).padStart(6)} -> ours ${String(ours.length).padStart(5)}, zlib -9 ${String(ref.length).padStart(5)}`);
}

// Size cap applies while inflating.
assert.throws(() => inflate(deflate(new Uint8Array(5000)), 4999), /too large/);
assert.equal(inflate(deflate(new Uint8Array(5000)), 5000).length, 5000);

// Garbage and corruption: decode or DecodeError, nothing else, no hangs.
const good = deflate(inputs.level);
for (let i = 0; i < 5000; i++) {
  const b = i < 1000 ? bytes(1 + (rnd() % 64), () => rnd() & 255) : new Uint8Array(good);
  if (i >= 1000) for (let k = 0, n = 1 + (rnd() % 3); k < n; k++) b[rnd() % b.length] = rnd() & 255;
  try { inflate(b, cap); } catch (e) { if (!(e instanceof DecodeError)) throw e; }
}
for (let n = 0; n < good.length; n++) assert.throws(() => inflate(good.subarray(0, n), cap), DecodeError);
assert.throws(() => inflate(new Uint8Array([...good, 0]), cap), /trailing/);

console.log('deflate: ok');
