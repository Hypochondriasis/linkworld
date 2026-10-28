import assert from 'node:assert/strict';
import { primitive, makeFace, deleteVerts, deleteFaces, flipFaces, mergeVerts, extrude, faceUV, modelPolys, placer, propScene } from '../src/model.js';
import { encodeBytes, decodeBytes } from '../src/format.js';
import { ENT, modelTris } from '../src/format.js';
import { createParticles } from '../src/particles.js';
import { sub, dot } from '../src/shape.js';

const center = (pts) => [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length);
const normal = (pts) => pts.reduce((n, p, i) => {
  const q = pts[(i + 1) % pts.length];
  return [n[0] + (p[1] - q[1]) * (p[2] + q[2]), n[1] + (p[2] - q[2]) * (p[0] + q[0]), n[2] + (p[0] - q[0]) * (p[1] + q[1])];
}, [0, 0, 0]);
const outward = (part) => part.faces.every((f) => {
  const pts = f.map((i) => part.verts[i]);
  return dot(normal(pts), sub(center(pts), center(part.verts))) > 0;
});
// Closed: every edge is used once in each direction.
const closed = (part) => {
  const edges = new Map();
  for (const f of part.faces) f.forEach((a, i) => { const k = a + ',' + f[(i + 1) % f.length]; edges.set(k, (edges.get(k) || 0) + 1); });
  return [...edges].every(([k, n]) => n === 1 && edges.get(k.split(',').reverse().join(',')) === 1);
};

for (const [kind, nv, nf] of [['box', 8, 6], ['cylinder', 16, 20], ['sphere', 26, 32]]) {
  const p = primitive(kind, [8, 8, 0], 16);
  assert.deepEqual([p.verts.length, p.faces.length], [nv, nf], kind);
  assert.ok(outward(p), `${kind} faces point outward`);
  assert.ok(closed(p), `${kind} is closed`);
  assert.ok(p.verts.every((v) => v.every(Number.isInteger)), `${kind} has integer vertices`);
}

// Make face: any selection order gives an uncrossed quad facing away from the part.
const part = { verts: [[0, 0, 0], [8, 0, 0], [0, 8, 0], [8, 8, 0], [4, 4, -8]], faces: [] };
assert.equal(makeFace(part, [0, 3, 1, 2]), true);
assert.ok(outward(part), 'faces away from the apex');
assert.equal(Math.abs(normal(part.faces[0].map((i) => part.verts[i]))[2]), 128, 'not crossed: full area');
assert.equal(makeFace(part, [2, 1, 3, 0]), false, 'exists already');
assert.equal(makeFace({ verts: [[0, 0, 0], [1, 1, 1], [2, 2, 2]], faces: [] }, [0, 1, 2]), false, 'in a line');
assert.equal(makeFace(part, [0, 1, 4]), true);
flipFaces(part, [0, 1, 4]);
assert.ok(!outward(part));
deleteFaces(part, [0, 1, 4]);
assert.deepEqual(part.faces.length, 1);
deleteVerts(part, [1]);
assert.deepEqual([part.verts.length, part.faces], [4, []], 'faces using a deleted vertex go too');
const tri = { verts: [[0, 0, 0], [9, 9, 9], [1, 0, 0], [0, 1, 0]], faces: [[0, 2, 3]] };
deleteVerts(tri, [1]);
assert.deepEqual(tri.faces, [[0, 1, 2]], 'renumbered');

// Base parts are mirrored across x = 0 with their winding reversed (still facing out).
const box = { mirror: true, tex: 0, color: [255, 0, 0], scale: 0, ...primitive('box', [8, 8, 0], 16) };
const model = { name: 'm', scale: 32, parts: [box, { ...box, mirror: false, tex: 1, color: [0, 0, 0] }], emitter: { kind: 1, pos: [0, 16, 0], angle: 0, pitch: 64 } };
const polys = modelPolys(model);
assert.equal(polys.length, 18);
assert.equal(modelTris(model), 36);
const mirrored = { verts: polys.filter((p) => p.mirrored).flatMap((p) => p.verts), faces: [] };
assert.ok(mirrored.verts.every((v) => v[0] <= 0));
const c = center(mirrored.verts);
assert.ok(polys.filter((p) => p.mirrored).every((p) => dot(normal(p.verts), sub(center(p.verts), c)) > 0), 'mirrored faces point outward');

// Placing: angle 64 turns the model's front (−z) to −x; scale 64 doubles it.
const at = placer({ scale: 64 }, { pos: [100, 10, 0], angle: 64 });
assert.deepEqual(at([0, 1, -1]).map((v) => Math.round(v * 1e9) / 1e9 + 0), [98, 12, 0]);

// Scene: level textures, then shared ones, then one image per color; particle types appended and always on.
const img = (n) => Array.from({ length: n }, (_, i) => ({ width: 1, height: 1, data: new Uint8ClampedArray(4), id: i }));
const level = { textures: [{}, {}], particles: [{ burst: true }], entities: [{ type: ENT.PROP, pos: [0, 0, 0], angle: 0, model: 0 }, { type: ENT.PROP, pos: [0, 0, 0], angle: 0, model: 5 }] };
const pack = { models: [model], particles: [{ tex: 0 }, { tex: 1, burst: true, rate: 10, life: 10, speed: 1, spread: 0, gravity: 0 }] };
const levelImgs = img(3), sharedImgs = img(2);
const sc = propScene(pack, level, levelImgs, sharedImgs);
assert.equal(sc.images.length, 5, '3 level + 1 shared + 1 color');
assert.deepEqual([...sc.images[4].data], [255, 0, 0, 255]);
assert.deepEqual(new Set(sc.faces.map((f) => f.tex)), new Set([3, 4]), 'textured part -> shared texture 1, color part -> its image');
assert.equal(sc.faces.length, 36, 'quads split into triangles; the missing model is skipped');
assert.ok(sc.faces.every((f) => f.n && Math.abs(Math.hypot(...f.n) - 1) < 1e-9 && f.uv.length === 3));
assert.deepEqual(sc.particles.map((t) => [t.tex, t.burst]), [[0, false], [3, false]]);
assert.deepEqual([sc.emitters.length, sc.emitters[0].kind, sc.emitters[0].pos], [1, 2, [0, 16, 0]]);
assert.equal(propScene(pack, level, levelImgs, sharedImgs).images, sc.images, 'same inputs, same images');
const sim = createParticles([...level.particles, ...sc.particles], sc.emitters);
sim.update(0.5);
assert.ok(sim.list.length >= 4, 'a model emitter runs without being fired, even with a burst type');


// Extrude the top of a box: 4 more vertices, 4 side quads, the top moves up, still closed and outward.
const ex = primitive('box', [0, 8, 0], 16);
const topVerts = ex.verts.map((v, i) => i).filter((i) => ex.verts[i][1] === 16);
const moved = extrude(ex, topVerts, 8, 255, 255);
assert.deepEqual([ex.verts.length, ex.faces.length, moved.length], [12, 10, 4]);
assert.ok(moved.every((i) => ex.verts[i][1] === 24), 'moved along the normal');
assert.ok(closed(ex) && outward(ex));
assert.equal(extrude(ex, [0, 1], 8, 255, 255), null, 'no whole face selected');
assert.equal(extrude(ex, moved, 8, 12, 255), null, 'too many vertices');
// Extruding one face of two that share an edge: the shared edge gets a side quad, the inner vertices stay.
const strip = { verts: [[0, 0, 0], [8, 0, 0], [16, 0, 0], [0, 8, 0], [8, 8, 0], [16, 8, 0]], faces: [[0, 1, 4, 3], [1, 2, 5, 4]] };
extrude(strip, [0, 1, 3, 4], 4, 255, 255);
assert.deepEqual([strip.verts.length, strip.faces.length], [10, 6]);

// Merge: a box's top collapses to a point (a pyramid); collapsed faces lose corners, the top face goes.
const pyr = primitive('box', [0, 8, 0], 16);
const tops = pyr.verts.map((v, i) => i).filter((i) => pyr.verts[i][1] === 16);
const apex = mergeVerts(pyr, tops);
assert.deepEqual(pyr.verts[apex], [0, 16, 0]);
assert.deepEqual([pyr.verts.length, pyr.faces.length, pyr.faces.filter((f) => f.length === 3).length], [5, 5, 4]);
assert.ok(closed(pyr) && outward(pyr));

// Uvs: projected until a part has its own; edits keep them in step with the faces; they round-trip.
const uvp = { mirror: false, tex: 1, color: [0, 0, 0], scale: 16, ...primitive('box', [0, 8, 0], 16) };
assert.deepEqual(faceUV(uvp, 3), uvp.faces[3].map((i) => [uvp.verts[i][0] * 4, uvp.verts[i][2] * 4]), 'top face: x / z, 64 per 16 units');
uvp.uv = uvp.faces.map((_, k) => faceUV(uvp, k));
uvp.uv[0][0] = [99, -7];
flipFaces(uvp, uvp.faces[0]);
assert.deepEqual(uvp.uv[0].at(-1), [99, -7], 'flipped with its face');
makeFace(uvp, [0, 3, 5]);
assert.equal(uvp.uv.length, uvp.faces.length);
deleteVerts(uvp, [7]);
assert.equal(uvp.uv.length, uvp.faces.length);
assert.ok(uvp.uv.every((c, k) => c.length === uvp.faces[k].length));
extrude(uvp, uvp.faces[0], 4, 255, 255);
mergeVerts(uvp, [0, 1]);
assert.ok(uvp.uv.length === uvp.faces.length && uvp.uv.every((c, k) => c.length === uvp.faces[k].length), 'still in step');
const pk = { levels: [{ name: '', ambient: [0, 0, 0], fog: [0, 0, 0], fogDist: 0, textures: [], boxes: [], entities: [] }], textures: [{ size: 64, ops: [] }], models: [{ name: '', scale: 8, parts: [uvp] }] };
assert.deepEqual(decodeBytes(encodeBytes(pk)), pk);
const poly = modelPolys({ parts: [uvp] })[0];
assert.deepEqual(poly.uv, uvp.uv[0].map((c) => c.map((x) => x / 64)), 'drawn with its own uvs');

console.log('model: ok');
