import assert from 'node:assert/strict';
import { mulberry32 } from '../src/prng.js';

const seq = (seed, n) => { const r = mulberry32(seed); return Array.from({ length: n }, r); };

assert.deepEqual(seq(42, 100), seq(42, 100));
assert.notDeepEqual(seq(1, 10), seq(2, 10));
for (const v of seq(7, 1000)) assert.ok(Number.isInteger(v) && v >= 0 && v <= 0xffffffff);

// Locked reference values: changing these changes every procedural texture.
assert.deepEqual(seq(0, 3), [1144304738, 1416247, 958946056]);

// Rough uniformity: each of 16 buckets within 20% of expectation.
const buckets = new Array(16).fill(0);
for (const v of seq(123, 16000)) buckets[v >>> 28]++;
for (const b of buckets) assert.ok(b > 800 && b < 1200, `bucket ${b}`);

console.log('prng: ok');
