import assert from 'node:assert/strict';
import { bakeLight } from '../src/light.js';
import { buildFaces } from '../src/render.js';
import { ENT } from '../src/format.js';

const faces6 = () => Array.from({ length: 6 }, () => ({ tex: 0, scale: 16, ox: 0, oy: 0 }));
const box = (min, max) => ({ min, max, solid: true, faces: faces6() });
const level = (boxes, lights) => ({ name: '', ambient: [0, 0, 0], fog: [0, 0, 0], fogDist: 0, textures: [], boxes,
  entities: lights.map(([pos, radius]) => ({ type: ENT.LIGHT, pos, angle: 0, color: [255, 255, 255], radius })) });

// Light (red channel, 0..2) at a point of a face, read back through the face's own lightmap mapping.
function lightAt(lm, face, p) {
  const u = (face.a + 1) % 3, v = (face.a + 2) % 3;
  const x = Math.round(face.lm[0][0] * lm.width - 0.5 + (p[u] - face.verts[0][u]) / lm.step);
  const y = Math.round(face.lm[0][1] * lm.height - 0.5 + (p[v] - face.verts[0][v]) / lm.step);
  return lm.color[(y * lm.width + x) * 4] / 127.5;
}

// A floor lit from above, with a block between the light and part of the floor.
const lv = level([box([-64, -8, -64], [64, 0, 64]), box([8, 20, -8], [24, 24, 8])], [[[16, 40, 0], 100]]);
const faces = buildFaces(lv);
const lm = bakeLight(lv, faces);
const top = faces.find((f) => f.n[1] === 1 && f.verts[0][1] === 0);
const lit = lightAt(lm, top, [-16, 0, 0]), shadow = lightAt(lm, top, [16, 0, 0]);
assert.ok(Math.abs(lit - 0.186) < 0.01, `floor in the open is lit: ${lit}`);
assert.equal(shadow, 0, 'floor under the block is in its shadow');
// The block's top faces the light; its bottom faces away and shares the black texel.
const blockTop = faces.find((f) => f.n[1] === 1 && f.verts[0][1] === 24);
assert.ok(lightAt(lm, blockTop, [16, 24, 0]) > lit, 'closer surface is brighter');
const under = faces.find((f) => f.n[1] === -1 && f.verts[0][1] === 20);
assert.deepEqual(under.lm[0], [0.5 / lm.width, 0.5 / lm.height]);
// Light direction texel points up at the light.
const o = ((Math.round(top.lm[0][1] * lm.height - 0.5 + 64 / lm.step) * lm.width) + Math.round(top.lm[0][0] * lm.width - 0.5 + 48 / lm.step)) * 4;
assert.ok(lm.dir[o + 1] > 200, `direction mostly +y: ${lm.dir[o + 1]}`);

// Huge levels get coarser texels instead of a huge atlas.
const big = level([box([-30000, -8, -30000], [30000, 0, 30000])], [[[0, 40, 0], 65535]]);
const bigLm = bakeLight(big, buildFaces(big));
assert.ok(bigLm.step > 4 && bigLm.width <= 2048 && bigLm.height <= 2048, `step ${bigLm.step}, ${bigLm.width}x${bigLm.height}`);
console.log('light: ok');
