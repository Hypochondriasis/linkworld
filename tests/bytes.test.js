import assert from 'node:assert/strict';
import { ByteWriter, ByteReader, DecodeError } from '../src/bytes.js';

const uints = [0, 1, 127, 128, 255, 256, 16383, 16384, 2 ** 21 - 1, 2 ** 21, 2 ** 28 - 1, 2 ** 28, 0xffffffff];
const sints = [0, 1, -1, 63, -64, 64, -65, 0x7fffffff, -0x80000000];

const w = new ByteWriter();
w.u8(0); w.u8(255); w.u16(0); w.u16(0xffff); w.u16(0x1234);
for (const v of uints) w.varint(v);
for (const v of sints) w.svarint(v);
w.string(''); w.string('Hello, Ýxe 🙂');
const bytes = w.finish();

const r = new ByteReader(bytes);
assert.equal(r.u8(), 0); assert.equal(r.u8(), 255);
assert.equal(r.u16(), 0); assert.equal(r.u16(), 0xffff); assert.equal(r.u16(), 0x1234);
for (const v of uints) assert.equal(r.varint(), v);
for (const v of sints) assert.equal(r.svarint(), v);
assert.equal(r.string(100), ''); assert.equal(r.string(100), 'Hello, Ýxe 🙂');
assert.equal(r.remaining, 0);

// Known encodings.
const enc = (f) => { const x = new ByteWriter(); f(x); return [...x.finish()]; };
assert.deepEqual(enc((x) => x.varint(300)), [0xac, 0x02]);
assert.deepEqual(enc((x) => x.varint(0xffffffff)), [0xff, 0xff, 0xff, 0xff, 0x0f]);
assert.deepEqual(enc((x) => x.svarint(-1)), [1]);
assert.deepEqual(enc((x) => x.u16(0x1234)), [0x34, 0x12]);

// Writer rejects out-of-range values instead of silently wrapping.
for (const f of [(x) => x.u8(256), (x) => x.u8(-1), (x) => x.u8(1.5), (x) => x.varint(2 ** 32), (x) => x.svarint(2 ** 31)]) {
  assert.throws(() => f(new ByteWriter()), RangeError);
}

// Reader rejects bad input with DecodeError.
const bad = [
  [[], (x) => x.u8()],
  [[1], (x) => x.u16()],
  [[0x80], (x) => x.varint()], // truncated
  [[0x80, 0x00], (x) => x.varint()], // non-canonical
  [[0xff, 0xff, 0xff, 0xff, 0x1f], (x) => x.varint()], // > 32 bits
  [[0x80, 0x80, 0x80, 0x80, 0x80, 0x01], (x) => x.varint()], // too long
  [[5, 1, 2], (x) => x.bytes(5)],
  [[5, 65, 65], (x) => x.string(10)], // truncated
  [[5, 65, 65, 65, 65, 65], (x) => x.string(4)], // too long
  [[2, 0xc3, 0x28], (x) => x.string(10)], // invalid UTF-8
];
for (const [data, f] of bad) assert.throws(() => f(new ByteReader(new Uint8Array(data))), DecodeError, JSON.stringify(data));

console.log('bytes: ok');
