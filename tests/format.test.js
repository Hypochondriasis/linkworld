import assert from 'node:assert/strict';
import { ByteWriter, DecodeError } from '../src/bytes.js';
import { pack, unpack } from '../src/codec.js';
import { encodeBytes, decodeBytes, encodeLink, decodeLink, parseFragment, ENT, ON, LIMITS, MAGIC, VERSION, removeBox, removeEntity, removeTexture, removeParticleType, removeLevel, removeModel } from '../src/format.js';
import { demoPack } from '../src/demo.js';
import { mulberry32 } from '../src/prng.js';

const face = (tex = 0) => ({ tex, scale: 16, ox: 0, oy: 0 });
const box = (min, max, solid = true, tex = 0) => ({ min, max, solid, faces: [0, 1, 2, 3, 4, 5].map(() => face(tex)) });

const empty = { name: '', ambient: [0, 0, 0], fog: [0, 0, 0], fogDist: 0, textures: [], boxes: [], entities: [] };

const room = {
  name: 'Test room – ünïcode 🙂',
  ambient: [40, 40, 50],
  fog: [20, 20, 30],
  fogDist: 800,
  textures: [
    { size: 64, ops: [{ op: 1, args: [10, 20, 30, 40] }, { op: 33, args: [2] }] },
    { size: 128, transparent: true, ops: [{ op: 22, args: [0, 0, 255, 255, ...new Array(128).fill(7)] }, { op: 80, args: [1] }, { op: 51, args: [255] }, { op: 64, args: [100] }] },
  ],
  boxes: [
    box([-64, -8, -64], [64, 0, 64], true, 1),
    box([-64, 0, -64], [-56, 32, 64], true, 2),
    { min: [0, 0, 0], max: [8, 24, 2], solid: true, faces: [face(0), face(1), face(2), face(1), face(0), { tex: 2, scale: 255, ox: 3, oy: 200 }] },
    box([40, 0, 40], [56, 16, 56], false),
  ],
  entities: [
    { type: ENT.PLAYER_START, pos: [0, 0, 0], angle: 64 },
    { type: ENT.LIGHT, pos: [0, 24, 0], angle: 0, color: [255, 200, 150], radius: 200 },
    { type: ENT.DOOR, pos: [0, 0, 0], angle: 0, box: 2, dir: 3, dist: 24, speed: 32 },
    { type: ENT.TRIGGER, pos: [0, 0, 0], angle: 0, box: 3, on: ON.ENTER, once: false, text: '', targets: [4, 7] },
    { type: ENT.MESSAGE, pos: [0, 0, 0], angle: 0, text: 'You found the secret!' },
    { type: ENT.EXIT, pos: [0, 0, 0], angle: 0, box: 3, level: 0, link: 'AQID' },
    { type: ENT.EXIT, pos: [0, 0, 0], angle: 0, box: 3, level: 0, link: 'AQID' },
    { type: ENT.EMITTER, pos: [8, 16, -8], angle: 32, kind: 0, pitch: 64 },
    { type: ENT.ROTATOR, pos: [0, 0, 0], angle: 0, box: 1, axis: 1, edge: 2, turn: -90, speed: 60 },
    { type: ENT.EXIT, pos: [0, 0, 0], angle: 0, box: 3, level: 2, link: '' },
    { type: ENT.TRIGGER, pos: [0, 0, 0], angle: 0, box: 1, on: ON.USE, once: true, text: 'Press E', targets: [2, 4] },
    { type: ENT.TRIGGER, pos: [0, 0, 0], angle: 0, box: 0, on: ON.SHOOT, once: false, text: '', targets: [] },
  ],
  particles: [{ tex: 2, additive: true, burst: false, rate: 30, life: 15, speed: 20, spread: 40, size0: 2, size1: 6, gravity: -40 }],
};

function randomLevel(seed, nBoxes) {
  const rnd = mulberry32(seed);
  const int = (lo, hi) => lo + (rnd() % (hi - lo + 1));
  const lv = { ...empty, name: `random ${seed}`, textures: [{ size: 64, ops: [] }], boxes: [], entities: [] };
  for (let i = 0; i < nBoxes; i++) {
    const min = [int(-2000, 2000), int(-200, 200), int(-2000, 2000)];
    const b = box(min, min.map((m) => m + int(1, 64)), !!(rnd() & 1), int(0, 1));
    if (rnd() & 1) b.faces[int(0, 5)] = { tex: 1, scale: int(0, 255), ox: int(0, 255), oy: int(0, 255) };
    lv.boxes.push(b);
  }
  lv.entities.push({ type: ENT.PLAYER_START, pos: [int(-100, 100), 0, int(-100, 100)], angle: int(0, 255) });
  return lv;
}

const one = (lv) => ({ levels: [lv] });
// v7: the pack's shared textures, particle types and models, placed by props.
const torch = {
  name: 'Torch', scale: 8,
  parts: [
    { mirror: true, tex: 1, color: [0, 0, 0], scale: 16, verts: [[0, 0, -2], [2, 0, 0], [0, 24, -2], [2, 24, 0], [0, 0, 2], [0, 24, 2]], faces: [[0, 2, 3, 1], [1, 3, 5, 4], [2, 5, 3]] },
    { mirror: false, tex: 0, color: [200, 120, 40], scale: 0, verts: [[-3, 24, -3], [3, 24, -3], [0, 30, 0]], faces: [[0, 2, 1]] },
  ],
  emitter: { kind: 0, pos: [0, 30, 0], angle: 0, pitch: 64 },
};
const withModels = {
  levels: [{ ...room, entities: [...room.entities, { type: ENT.PROP, pos: [8, 0, 8], angle: 64, model: 1 }, { type: ENT.PROP, pos: [0, 0, 0], angle: 0, model: 0 }] }, empty],
  textures: [{ size: 64, ops: [{ op: 1, args: [90, 60, 30, 128] }] }],
  particles: [{ tex: 1, additive: true, burst: true, rate: 9, life: 5, speed: 6, spread: 20, size0: 2, size1: 0, gravity: -20 }],
  models: [torch, { name: '', scale: 255, parts: [] }],
};
const samples = [one(empty), { levels: [room, empty] }, one(randomLevel(1, 50)), one(randomLevel(2, 500)), one(randomLevel(3, LIMITS.boxes)), demoPack(), withModels];

// Encode -> decode -> encode is byte-identical, and decode returns the same model.
for (const lv of samples) {
  const a = encodeBytes(lv);
  const back = decodeBytes(a);
  assert.deepEqual(back, lv);
  assert.deepEqual(encodeBytes(back), a);
  const link = await encodeLink(lv);
  assert.match(link, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(await decodeLink('#' + link), lv);
}

// Report sizes for the record.
for (const lv of [one(room), one(randomLevel(2, 500))]) console.log(`  ${lv.levels[0].boxes.length} boxes -> ${(await encodeLink(lv)).length} chars`);

async function rejects(p, re) {
  await assert.rejects(p, (e) => e instanceof DecodeError && (!re || re.test(e.message)));
}

// Fragments: '#payload~level'.
assert.deepEqual(parseFragment('#AbC-_~3'), { payload: 'AbC-_', level: 3 });
assert.deepEqual(parseFragment('AbC'), { payload: 'AbC', level: 0 });
assert.throws(() => parseFragment('#ab~x'), DecodeError);

// Every truncation of a valid level is rejected.
const roomBytes = encodeBytes({ levels: [room, empty] });
for (let n = 0; n < roomBytes.length; n++) assert.throws(() => decodeBytes(roomBytes.subarray(0, n)), DecodeError);
assert.throws(() => decodeBytes(new Uint8Array([...roomBytes, 0])), /after end/);

// Header checks.
assert.throws(() => decodeBytes(new Uint8Array([0, VERSION])), /not a Linkworld/);
assert.throws(() => decodeBytes(new Uint8Array([MAGIC, 99])), /unsupported level version 99/);

// Oversized counts are rejected up front.
// The pack section (shared textures, particle types, models) comes first, here empty.
const header = (f) => { const w = new ByteWriter(); w.u8(MAGIC); w.u8(VERSION); w.bytes([0, 0, 0]); w.varint(1); w.string(''); w.bytes([0, 0, 0, 0, 0, 0]); w.varint(0); f(w); return w.finish(); };
assert.throws(() => decodeBytes(new Uint8Array([MAGIC, VERSION, 0, 0, 0, 0])), /no levels/);
assert.throws(() => decodeBytes(new Uint8Array([MAGIC, VERSION, 0, 0, 0, LIMITS.levels + 1])), /level count/);
assert.throws(() => decodeBytes(new Uint8Array([MAGIC, VERSION - 1, 0, 0, 0, 1])), /unsupported level version 7/);
assert.throws(() => decodeBytes(new Uint8Array([MAGIC, VERSION, LIMITS.textures + 1])), /texture count/);
assert.throws(() => decodeBytes(new Uint8Array([MAGIC, VERSION, 0, 0, LIMITS.models + 1])), /model count/);
assert.throws(() => decodeBytes(header((w) => w.varint(LIMITS.textures + 1))), /texture count/);
assert.throws(() => decodeBytes(header((w) => { w.varint(0); w.varint(LIMITS.particles + 1); })), /particle type count/);
assert.throws(() => decodeBytes(header((w) => { w.varint(0); w.varint(0); w.varint(LIMITS.boxes + 1); })), /box count/);
assert.throws(() => decodeBytes(header((w) => { w.varint(0); w.varint(0); w.varint(0); w.varint(0xffffffff); })), /entity count/);

// Semantic checks: bad references, unsafe URLs, coordinates.
const bad = (patch) => { const lv = structuredClone(room); patch(lv); return encodeBytes({ levels: [lv, empty] }); };
assert.throws(() => decodeBytes(bad((lv) => { lv.boxes[0].faces[0].tex = 3; })), /texture out of range/);
assert.throws(() => decodeBytes(bad((lv) => { lv.textures[0].ops[0].op = 200; })), /unknown op 200/);
assert.throws(() => decodeBytes(bad((lv) => { lv.textures[0].ops.push({ op: 80, args: [2] }); })), /cycle/);
assert.throws(() => decodeBytes(bad((lv) => { lv.entities[2].box = 4; })), /box out of range/);
assert.throws(() => decodeBytes(bad((lv) => { lv.entities[2].dir = 6; })), /dir out of range/);
assert.throws(() => bad((lv) => { lv.entities[0].type = 99; }), /unknown entity type/);
assert.throws(() => decodeBytes(header((w) => { w.varint(0); w.varint(0); w.varint(0); w.varint(1); w.u8(99); })), /unknown type 99/);
// Models: references, coordinates, and what props cost to draw.
const badModel = (patch) => { const pk = structuredClone(withModels); patch(pk); return encodeBytes(pk); };
assert.throws(() => decodeBytes(badModel((pk) => { pk.levels[0].entities[12].model = 2; })), /level 1: entity 12 model out of range/);
assert.throws(() => decodeBytes(badModel((pk) => { pk.models[0].parts[0].faces[0][0] = 6; })), /face vertex out of range/);
assert.throws(() => decodeBytes(badModel((pk) => { pk.models[0].parts[0].faces[2][2] = 6; })), /face vertex out of range/);
assert.throws(() => decodeBytes(badModel((pk) => { pk.models[0].parts[1].verts[0][1] = LIMITS.modelCoord + 1; })), /coordinate out of range/);
assert.throws(() => decodeBytes(badModel((pk) => { pk.models[0].parts[0].tex = 2; })), /model 1 texture out of range/);
assert.throws(() => decodeBytes(badModel((pk) => { pk.models[0].emitter.kind = 1; })), /emitter type out of range/);
assert.throws(() => decodeBytes(badModel((pk) => { pk.models[1].scale = 0; })), /scale/);
// A part of 255 quads, mirrored, draws 1020 triangles; enough props of it exceed the per-level budget.
const heavy = { mirror: true, tex: 0, color: [0, 0, 0], scale: 0, verts: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], faces: Array.from({ length: LIMITS.faces }, () => [0, 1, 2, 3]) };
const props = (n) => Array.from({ length: n }, () => ({ type: ENT.PROP, pos: [0, 0, 0], angle: 0, model: 1 }));
const budget = Math.floor(LIMITS.propTris / 1020);
assert.doesNotThrow(() => decodeBytes(badModel((pk) => { pk.models[1].parts = [heavy]; pk.levels[1].entities = props(budget); })));
assert.throws(() => decodeBytes(badModel((pk) => { pk.models[1].parts = [heavy]; pk.levels[1].entities = props(budget + 1); })), /level 2: props have too many triangles/);
assert.throws(() => decodeBytes(bad((lv) => { lv.entities[10].targets = [5]; })), /can't be activated/);
assert.throws(() => decodeBytes(bad((lv) => { lv.entities[7].kind = 1; })), /kind out of range/);
assert.throws(() => decodeBytes(bad((lv) => { lv.entities[3].on = 3; })), /on out of range/);
assert.throws(() => decodeBytes(bad((lv) => { lv.entities[3].targets = [0]; })), /can't be activated/);
assert.throws(() => decodeBytes(bad((lv) => { lv.entities[3].targets = [12]; })), /targets out of range/);
assert.throws(() => decodeBytes(bad((lv) => { lv.entities[9].level = 3; })), /level out of range/);
assert.throws(() => decodeBytes(bad((lv) => { lv.entities[9].link = 'AQID'; })), /both/);
assert.throws(() => decodeBytes(bad((lv) => { lv.entities[8].turn = 361; })), /turn out of range/);
assert.throws(() => decodeBytes(bad((lv) => { lv.entities[8].axis = 3; })), /axis out of range/);
assert.throws(() => decodeBytes(bad((lv) => { lv.particles[0].life = 0; })), /life/);
assert.throws(() => decodeBytes(bad((lv) => { lv.particles[0].gravity = LIMITS.gravity + 1; })), /gravity/);
assert.throws(() => decodeBytes(bad((lv) => { lv.particles[0].tex = 3; })), /particle type 0 texture/);
assert.throws(() => decodeBytes(bad((lv) => { lv.boxes[0].max[0] = LIMITS.coord + 1; })), /bad size/);
assert.throws(() => decodeBytes(bad((lv) => { lv.boxes[0].min[0] = -LIMITS.coord - 1; })), /coordinate/);
// Exits only lead to Linkworld links (a fragment of this game), never to another site.
for (const link of ['https://example.com/', 'javascript:alert(1)', '#AQID', 'AQ ID', 'AQ~x', '//evil.com']) {
  assert.throws(() => decodeBytes(bad((lv) => { lv.entities[5].link = link; })), /not a Linkworld link/, link);
}
// Codec-level garbage.
for (const s of ['', '#', 'A', '!!!!', 'ab cd', 'AQ==', '/+/+', 'Ag', 'AQID'.repeat(10)]) await rejects(decodeLink(s));
await rejects(decodeLink('A'.repeat(2 * 1024 * 1024)), /too long/);

// Decompression bomb: tiny link, huge output.
const bomb = await pack(new Uint8Array(10 * 1024 * 1024));
assert.ok(bomb.length < 20000);
await rejects(decodeLink(bomb), /too large/);
await rejects(unpack(await pack(new Uint8Array(1000)), 999), /too large/);

// Fuzz: random byte corruption must either decode or throw DecodeError, never anything else.
const rnd = mulberry32(99);
const modelBytes = encodeBytes(withModels);
let ok = 0;
for (let i = 0; i < 3000; i++) {
  const b = new Uint8Array(i % 2 ? modelBytes : roomBytes);
  for (let k = 0, n = 1 + (rnd() % 4); k < n; k++) b[rnd() % b.length] = rnd() & 255;
  try { decodeBytes(b); ok++; } catch (e) { if (!(e instanceof DecodeError)) throw e; }
}
const link = await encodeLink(one(room));
for (let i = 0; i < 300; i++) {
  const chars = link.split('');
  chars[rnd() % chars.length] = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[rnd() % 64];
  try { await decodeLink(chars.join('')); } catch (e) { if (!(e instanceof DecodeError)) throw e; }
}
console.log(`  fuzz: ${ok}/3000 corrupted levels still decoded`);

// Reference-keeping edits.
const lv = structuredClone(room);
removeEntity(lv, 4); // the message: the trigger's targets follow
assert.deepEqual(lv.entities[3].targets, [6]);
assert.equal(lv.entities[6].type, ENT.EMITTER);
removeBox(lv, 1); // the rotating door's box goes with it; later boxes shift
assert.ok(!lv.entities.some((e) => e.type === ENT.ROTATOR));
assert.equal(lv.entities[2].box, 1, 'door box 2 -> 1');
assert.deepEqual(lv.entities[3].targets, [6]);
assert.equal(removeTexture(lv, 1), false, 'texture 1 is referenced by texture 2');
lv.textures[1].ops = lv.textures[1].ops.filter((o) => o.op !== 80);
assert.equal(removeTexture(lv, 1), true);
assert.deepEqual([lv.boxes[0].faces[0].tex, lv.particles[0].tex], [0, 1]);
assert.equal(removeParticleType(lv, 0), false, 'used by the emitter');
const pk = { levels: [structuredClone(room), empty, structuredClone(empty)] };
pk.levels[0].entities[9].level = 3;
removeLevel(pk, 1);
assert.deepEqual([pk.levels[0].entities[9].level, pk.levels.length], [2, 2]);
removeLevel(pk, 1);
assert.equal(pk.levels[0].entities[9].level, 0, 'exit to a removed level goes to the menu');
assert.doesNotThrow(() => decodeBytes(encodeBytes(pk)));
// The pack's shared lists and models.
const mp = structuredClone(withModels);
assert.equal(removeModel(mp, 0), false, 'a prop uses it');
mp.levels[0].entities.pop();
assert.equal(removeModel(mp, 0), true);
assert.deepEqual([mp.models.length, mp.levels[0].entities[12].model], [1, 0], 'props follow');
const tp = structuredClone(withModels);
assert.equal(removeParticleType(tp, 0), false, 'the torch emits it');
assert.equal(removeTexture(tp, 1), true);
assert.deepEqual([tp.models[0].parts[0].tex, tp.particles[0].tex, tp.textures.length], [0, 0, 0]);
delete tp.textures;
assert.deepEqual(decodeBytes(encodeBytes({ ...tp, textures: [] })), tp, 'an empty shared list is omitted');

console.log('format: ok');
