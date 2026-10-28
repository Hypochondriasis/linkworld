// Models, without DOM or GL: meshes shared by every level of a pack, placed by prop entities.
// Model: { name, scale (world units per 32 model units), parts, emitter? }
// Part: { mirror (base part: also drawn mirrored across x = 0), tex (0 = color, i = pack.textures[i-1]), color: rgb,
//         scale (model units per texture repeat, 0 = 256), verts: [[x,y,z]], faces: [[a,b,c] | [a,b,c,d]] CCW from outside,
//         uv?: per face, [u,v] per corner in 1/64 of a repeat (without it, uvs are projected along each face's main axis) }
// Emitter: { kind (pack.particles index), pos, angle, pitch } in model space; always on (never a burst).
// A model faces −z, like an entity with angle 0.
import { ENT } from './format.js';
import { sub, dot, cross } from './shape.js';

const norm = (v) => { const l = Math.hypot(...v); return l ? v.map((x) => x / l) : null; };
const center = (pts) => [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / (pts.length || 1));
// Newell's normal of a polygon (not unit length): works for any vertex order and quads that aren't flat.
const newell = (pts) => pts.reduce((n, p, i) => {
  const q = pts[(i + 1) % pts.length];
  return [n[0] + (p[1] - q[1]) * (p[2] + q[2]), n[1] + (p[2] - q[2]) * (p[0] + q[0]), n[2] + (p[0] - q[0]) * (p[1] + q[1])];
}, [0, 0, 0]);

// Texture coordinates (in repeats) of point p projected along axis a, rep units per repeat. Texture "up" is +y.
export function projectUV(p, a, rep) {
  const [u, v] = a === 0 ? [p[2], -p[1]] : a === 1 ? [p[0], p[2]] : [p[0], -p[1]];
  return [u / rep, v / rep];
}

// Face k's uvs in 1/64 of a repeat: its own, or projected along its main axis.
export function faceUV(part, k) {
  if (part.uv) return part.uv[k];
  const pts = part.faces[k].map((i) => part.verts[i]), a = axisOf(newell(pts));
  return pts.map((p) => projectUV(p, a, part.scale || 256).map((x) => Math.round(x * 64) + 0)); // + 0: no -0
}

// Every drawn polygon of a model in model space: [{ part, verts, uv (repeats), mirrored }], mirrored copies of
// base parts included (with the same uvs, so their texture is mirrored too).
export function modelPolys(model) {
  const out = [];
  for (const part of model.parts) {
    part.faces.forEach((f, k) => {
      const verts = f.map((i) => part.verts[i]), uv = faceUV(part, k).map((c) => c.map((x) => x / 64));
      out.push({ part, verts, uv });
      if (part.mirror) out.push({ part, verts: verts.map(([x, y, z]) => [-x, y, z]).reverse(), uv: [...uv].reverse(), mirrored: true });
    });
  }
  return out;
}

// Model space -> world for prop e: scaled, turned by its angle about y, moved to its position.
export function placer(model, e) {
  const a = (e.angle / 256) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a), k = model.scale / 32;
  return ([x, y, z]) => [e.pos[0] + (x * c + z * s) * k, e.pos[1] + y * k, e.pos[2] + (z * c - x * s) * k];
}

// Everything props add to a level. levelImgs / sharedImgs: generateTextures of level.textures / pack.textures.
// images: level images, then shared ones, then one 1×1 image per part color. faces: triangles for render.js
// (lit like boxes, with their own uvs so a texture sticks to the model). particles: the pack's particle types
// as continuous types, to append to level.particles; emitters: the props' emitters for those.
export function propScene(pack, level, levelImgs, sharedImgs) {
  const models = pack.models || [];
  const props = level.entities.filter((e) => e.type === ENT.PROP && models[e.model]);
  const nTex = levelImgs.length - 1, nParts = (level.particles || []).length;
  const colors = new Map(), firstColor = levelImgs.length + Math.max(0, sharedImgs.length - 1);
  const texOf = (part) => {
    if (part.tex) return nTex + part.tex;
    const key = part.color.join();
    if (!colors.has(key)) colors.set(key, firstColor + colors.size);
    return colors.get(key);
  };
  const faces = [], emitters = [];
  for (const e of props) {
    const m = models[e.model], place = placer(m, e);
    for (const { part, verts, uv } of modelPolys(m)) {
      for (let i = 1; i + 1 < verts.length; i++) {
        const world = [verts[0], verts[i], verts[i + 1]].map(place);
        const n = norm(cross(sub(world[1], world[0]), sub(world[2], world[0])));
        if (!n) continue; // no area
        // shortcut: normal-map tangents follow world axes (render.js), so Shade textures bump wrongly on uv-mapped or turned props; pass tangents if it shows.
        faces.push({ tex: texOf(part), a: axisOf(n), n, verts: world, uv: [uv[0], uv[i], uv[i + 1]] });
      }
    }
    if (m.emitter) {
      const me = m.emitter;
      emitters.push({ type: ENT.EMITTER, pos: place(me.pos), angle: (e.angle + me.angle) & 255, pitch: me.pitch, kind: nParts + me.kind, always: true });
    }
  }
  const particles = (pack.particles || []).map((t) => ({ ...t, burst: false, tex: t.tex && nTex + t.tex }));
  return { images: imagesFor(levelImgs, sharedImgs, [...colors.keys()]), faces, particles, emitters };
}

const axisOf = (n) => { const m = n.map(Math.abs); return m[0] >= m[1] && m[0] >= m[2] ? 0 : m[1] >= m[2] ? 1 : 2; };

// The same inputs give the same array, so the renderer keeps its GL textures.
let last = null;
function imagesFor(levelImgs, sharedImgs, colors) {
  const key = colors.join(';');
  if (last && last.levelImgs === levelImgs && last.sharedImgs === sharedImgs && last.key === key) return last.images;
  const solid = (c) => ({ width: 1, height: 1, data: new Uint8ClampedArray([...c.split(',').map(Number), 255]) });
  const images = [...levelImgs, ...sharedImgs.slice(1), ...colors.map(solid)];
  last = { levelImgs, sharedImgs, key, images };
  return images;
}

// ---- editing (used by the model editor) ----

// A new part shaped like a box, cylinder (8 sides, along y) or sphere, of size s around c, faces outward.
export function primitive(kind, c, s) {
  const r = s / 2, verts = [], faces = [];
  const at = (x, y, z) => verts.push([x, y, z].map((v, k) => Math.round(c[k] + v))) - 1;
  const ring = (y, rad) => Array.from({ length: 8 }, (_, i) => at(rad * Math.cos((i * Math.PI) / 4), y, rad * Math.sin((i * Math.PI) / 4)));
  const band = (a, b) => a.forEach((_, i) => faces.push([a[i], a[(i + 1) % 8], b[(i + 1) % 8], b[i]]));
  if (kind === 'box') {
    for (let i = 0; i < 8; i++) at(i & 1 ? r : -r, i & 2 ? r : -r, i & 4 ? r : -r);
    faces.push([0, 4, 6, 2], [1, 3, 7, 5], [0, 1, 5, 4], [2, 6, 7, 3], [0, 2, 3, 1], [4, 5, 7, 6]);
  } else if (kind === 'cylinder') {
    const lo = ring(-r, r), hi = ring(r, r);
    band(lo, hi);
    for (let i = 1; i < 7; i++) faces.push([lo[0], lo[i], lo[i + 1]], [hi[0], hi[i], hi[i + 1]]);
  } else {
    const bottom = at(0, -r, 0), rings = [-1, 0, 1].map((k) => ring(r * Math.sin((k * Math.PI) / 4), r * Math.cos((k * Math.PI) / 4))), top = at(0, r, 0);
    band(rings[0], rings[1]);
    band(rings[1], rings[2]);
    for (let i = 0; i < 8; i++) faces.push([bottom, rings[0][i], rings[0][(i + 1) % 8]], [top, rings[2][i], rings[2][(i + 1) % 8]]);
  }
  const part = { verts, faces };
  for (const f of faces) orient(part, f);
  return part;
}

// Turns face f (in place) to point away from the middle of its part: right for convex shapes, else Flip.
function orient(part, f) {
  const pts = f.map((i) => part.verts[i]);
  if (dot(newell(pts), sub(center(pts), center(part.verts))) < 0) f.reverse();
}

// Mesh edits keep a part's own uvs (if it has them) in step with its faces: new faces get projected ones.
const faceList = (part) => part.faces.map((f, k) => ({ f, uv: part.uv && part.uv[k] }));
function setFaces(part, list) {
  part.faces = list.map((x) => x.f);
  if (part.uv) part.uv = list.map((x, k) => x.uv || faceUV({ ...part, uv: null }, k));
}

// Adds a face from 3 or 4 vertex indices in any order. Returns false when they lie on a line or it exists.
export function makeFace(part, idx) {
  if (idx.length < 3 || idx.length > 4 || new Set(idx).size !== idx.length) return false;
  const pts = idx.map((i) => part.verts[i]), c = center(pts);
  const n = norm(newell(pts)) || norm(cross(sub(pts[1], pts[0]), sub(pts[2], pts[0])));
  if (!n) return false;
  // Around the center, counter-clockwise about n: a quad never comes out crossed.
  const u = sub(pts.find((p) => Math.hypot(...sub(p, c)) > 0), c), w = cross(n, u);
  const ang = (i) => { const q = sub(part.verts[i], c); return Math.atan2(dot(q, w), dot(q, u)); };
  const f = [...idx].sort((a, b) => ang(a) - ang(b));
  if (part.faces.some((g) => g.length === f.length && f.every((i) => g.includes(i)))) return false;
  orient(part, f);
  setFaces(part, [...faceList(part), { f }]);
  return true;
}

const within = (sel) => (f) => f.every((i) => sel.includes(i));

// Deletes the vertices sel and every face using them; the rest are renumbered. Returns old index -> new.
export function deleteVerts(part, sel) {
  const map = [];
  let n = 0;
  part.verts.forEach((_, i) => { if (!sel.includes(i)) map[i] = n++; });
  part.verts = part.verts.filter((_, i) => map[i] !== undefined);
  setFaces(part, faceList(part).filter((x) => x.f.every((i) => map[i] !== undefined)).map((x) => ({ f: x.f.map((i) => map[i]), uv: x.uv })));
  return map;
}
export const deleteFaces = (part, sel) => setFaces(part, faceList(part).filter((x) => !within(sel)(x.f)));
export const flipFaces = (part, sel) => setFaces(part, faceList(part).map((x) => (within(sel)(x.f) ? { f: [...x.f].reverse(), uv: x.uv && [...x.uv].reverse() } : x)));

// Merges the vertices sel into one at their middle. Faces lose the corners that collapse; ones left with fewer
// than 3 corners go. Returns the merged vertex's new index.
export function mergeVerts(part, sel) {
  const keep = sel[0];
  part.verts[keep] = center(sel.map((i) => part.verts[i])).map(Math.round);
  const list = faceList(part).map(({ f, uv }) => {
    const g = [], guv = [];
    f.forEach((i, j) => {
      const v = sel.includes(i) ? keep : i;
      if (g.includes(v)) return;
      g.push(v);
      if (uv) guv.push(uv[j]);
    });
    return { f: g, uv: uv && guv };
  });
  setFaces(part, list.filter((x) => x.f.length >= 3));
  return deleteVerts(part, sel.filter((i) => i !== keep))[keep];
}

// Extrudes the faces whose vertices are all in sel by dist along their average normal: they move out on new
// vertices and side quads join them to where they were. Returns the new vertices (the moved faces'), or null
// when no face is selected or the part would get too big (maxVerts, maxFaces).
export function extrude(part, sel, dist, maxVerts, maxFaces) {
  const list = faceList(part), top = list.filter((x) => within(sel)(x.f));
  const n = norm(top.reduce((s, x) => s.map((v, k) => v + newell(x.f.map((i) => part.verts[i]))[k]), [0, 0, 0]));
  if (!top.length || !n) return null;
  const used = [...new Set(top.flatMap((x) => x.f))];
  const edges = new Set(top.flatMap((x) => x.f.map((a, j) => a + ',' + x.f[(j + 1) % x.f.length])));
  const rim = top.flatMap((x) => x.f.map((a, j) => [a, x.f[(j + 1) % x.f.length]]).filter(([a, b]) => !edges.has(b + ',' + a)));
  if (part.verts.length + used.length > maxVerts || part.faces.length + rim.length > maxFaces) return null;
  const copy = new Map(used.map((i) => [i, part.verts.push(part.verts[i].map((c, k) => c + Math.round(n[k] * dist))) - 1]));
  for (const x of top) x.f = x.f.map((i) => copy.get(i));
  setFaces(part, [...list, ...rim.map(([a, b]) => ({ f: [a, b, copy.get(b), copy.get(a)] }))]);
  // Vertices inside the extruded area are used by nothing now.
  const map = deleteVerts(part, used.filter((i) => !part.faces.some((f) => f.includes(i))));
  return [...copy.values()].map((i) => map[i]);
}
