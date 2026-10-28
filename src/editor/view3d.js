// Live 3D view with the game renderer. Hold right mouse to look; WASD to fly, Q/E down/up, Shift faster.
// Left click selects a box. In face mode (Tab) left click picks one face of the selected box.
// Vertex tool: click a corner of the selected box to select it, then drag a gizmo arrow to move it along that axis.
import { createRenderer } from '../render.js';
import { generateTextures } from '../texgen.js';
import { rayDir, pickBox, project, rayToAxis } from './pick.js';
import { hullOf, faceSlot, corners, setCorners, forward, saveShape, restoreShape } from '../shape.js';
import { ENT } from '../format.js';
import { emitterDir } from '../particles.js';
import { propScene } from '../model.js';

const YELLOW = [1, 0.87, 0.2, 1];
const AXIS_COLORS = [[1, 0.3, 0.3, 1], [0.3, 1, 0.3, 1], [0.4, 0.6, 1, 1]];
const GIZMO_SIZE = 0.15; // arrow length as a fraction of the distance to the camera: constant on screen

export function createView3d(canvas, ed) {
  let renderer;
  try {
    renderer = createRenderer(canvas);
  } catch (e) {
    canvas.replaceWith(Object.assign(document.createElement('p'), { textContent: '3D view unavailable: ' + e.message }));
    return null;
  }
  const cam = { pos: [0, 40, 80], yaw: 0, pitch: -0.4 };
  const keys = new Set();
  let looking = false;
  let hover = null; // face under the mouse in face mode

  const ndc = (e) => {
    const r = canvas.getBoundingClientRect();
    return { nx: ((e.clientX - r.left) / r.width) * 2 - 1, ny: 1 - ((e.clientY - r.top) / r.height) * 2, r };
  };
  const rayAt = (e) => { const { nx, ny, r } = ndc(e); return rayDir(cam, nx, ny, r.width / r.height); };
  const pickAt = (e) => pickBox(ed.level.boxes, cam.pos, rayAt(e));
  // Face mode works on the selected box only: other boxes are neither highlighted nor picked.
  const pickFace = (e) => {
    const b = ed.level.boxes[ed.sel];
    const hit = b && pickBox([b], cam.pos, rayAt(e));
    return hit ? { ...hit, box: ed.sel } : null;
  };

  const px = (q, r) => [((q[0] + 1) * r.width) / 2, ((1 - q[1]) * r.height) / 2]; // NDC -> canvas pixels
  const local = (e, r) => [e.clientX - r.left, e.clientY - r.top];

  // Corners of the selected box within 10 px of the cursor; corners sharing the nearest one's position go together.
  function cornersAt(e) {
    const b = ed.level.boxes[ed.sel];
    if (!b || ed.tool !== 'vertex') return [];
    const { r } = ndc(e);
    const m = local(e, r);
    const pts = corners(b);
    let best = -1, bestD = 10;
    pts.forEach((c, i) => {
      const q = project(cam, c, r.width / r.height);
      if (!q) return;
      const d = Math.hypot(px(q, r)[0] - m[0], px(q, r)[1] - m[1]);
      if (d < bestD) { best = i; bestD = d; }
    });
    if (best < 0) return [];
    return pts.map((c, i) => i).filter((i) => pts[i].every((v, k) => v === pts[best][k]));
  }

  // The selected vertex (only while the vertex tool is on and it belongs to the selected box).
  const selVertex = () => {
    const b = ed.level.boxes[ed.sel];
    return b && ed.tool === 'vertex' && ed.selVert.length ? corners(b)[ed.selVert[0]] : null;
  };
  const gizmoLen = (c) => Math.hypot(c[0] - cam.pos[0], c[1] - cam.pos[1], c[2] - cam.pos[2]) * GIZMO_SIZE;

  // Gizmo arrow under the cursor (axis 0..2) or -1: within 8 px of the arrow's screen segment.
  function gizmoAt(e) {
    const c = selVertex();
    if (!c) return -1;
    const { r } = ndc(e);
    const m = local(e, r);
    const a = project(cam, c, r.width / r.height);
    if (!a) return -1;
    const A = px(a, r);
    let best = -1, bestD = 8;
    for (let k = 0; k < 3; k++) {
      const tip = [...c];
      tip[k] += gizmoLen(c);
      const t = project(cam, tip, r.width / r.height);
      if (!t) continue;
      const T = px(t, r);
      const dx = T[0] - A[0], dy = T[1] - A[1];
      const u = Math.max(0, Math.min(1, ((m[0] - A[0]) * dx + (m[1] - A[1]) * dy) / (dx * dx + dy * dy || 1)));
      const d = Math.hypot(m[0] - A[0] - dx * u, m[1] - A[1] - dy * u);
      if (d < bestD) { best = k; bestD = d; }
    }
    return best;
  }

  // Arrow drag along axis k. Positions are recomputed from the drag's start, so refused (flat) moves don't build up.
  let drag = null;
  let hoverAxis = -1;
  function dragTo(e) {
    const b = ed.level.boxes[ed.sel];
    const s = rayToAxis(cam.pos, rayAt(e), drag.c, drag.k);
    if (s === null) return;
    const to = [...drag.c];
    to[drag.k] = Math.round((drag.c[drag.k] + s - drag.from) / ed.snap) * ed.snap;
    const moves = {};
    for (const i of ed.selVert) moves[i] = to;
    restoreShape(b, drag.base);
    if (!setCorners(b, moves)) restoreShape(b, drag.base);
    ed.changed();
  }

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 2) looking = ed.looking = true;
    if (e.button !== 0) return;
    const k = gizmoAt(e);
    if (k >= 0) {
      const b = ed.level.boxes[ed.sel];
      const c = corners(b)[ed.selVert[0]];
      const from = rayToAxis(cam.pos, rayAt(e), c, k);
      if (from === null) return;
      ed.begin();
      drag = { k, c, from, base: saveShape(b) };
      return;
    }
    const grab = cornersAt(e);
    if (grab.length) return ed.selectVertex(grab);
    if (!ed.faceMode) {
      const hit = pickAt(e);
      return ed.select(hit ? hit.box : -1);
    }
    const hit = pickFace(e);
    if (hit) ed.setFace(hit.face);
  });
  canvas.addEventListener('mousemove', (e) => {
    hover = ed.faceMode && !looking ? pickFace(e) : null;
    if (!drag) {
      hoverAxis = gizmoAt(e);
      canvas.style.cursor = hoverAxis >= 0 ? 'grab' : cornersAt(e).length ? 'pointer' : 'default';
    }
  });
  addEventListener('mousemove', (e) => { if (drag) dragTo(e); });
  addEventListener('mouseup', (e) => {
    if (e.button !== 0 || !drag) return;
    drag = null;
    ed.commit();
  });
  canvas.addEventListener('mouseleave', () => { hover = null; });
  addEventListener('mouseup', (e) => {
    if (e.button === 2) {
      looking = ed.looking = false;
      keys.clear();
    }
  });
  addEventListener('mousemove', (e) => {
    if (!looking) return;
    cam.yaw -= e.movementX * 0.004;
    cam.pitch = Math.max(-1.55, Math.min(1.55, cam.pitch - e.movementY * 0.004));
    ed.redrawGrid();
  });
  addEventListener('keydown', (e) => {
    if (!looking) return;
    keys.add(e.code);
    e.preventDefault();
  });
  addEventListener('keyup', (e) => keys.delete(e.code));

  // Selection: box outline; in face mode also the chosen face (solid) and the hovered one (faint).
  function overlay() {
    const out = [];
    const b = ed.level.boxes[ed.sel];
    if (b) out.push({ lines: true, verts: boxEdges(b), color: YELLOW });
    // Emitters: a cross, plus a line along the firing direction for directional types.
    ed.level.entities.forEach((e, i) => {
      if (e.type !== ENT.EMITTER) return;
      const color = i === ed.selEnt ? YELLOW : [1, 0.65, 0.25, 1];
      out.push({ lines: true, verts: cross(e.pos, 2), color });
      const t = (ed.level.particles || [])[e.kind];
      if (t && t.spread < 255) {
        const d = emitterDir(e);
        out.push({ lines: true, verts: [...e.pos, ...e.pos.map((v, k) => v + d[k] * 12)], color });
      }
    });
    if (b && ed.tool === 'vertex') out.push({ lines: true, verts: cornerMarks(b), color: [1, 1, 1, 1] });
    const c = selVertex();
    if (c) {
      out.push({ lines: true, verts: cross(c, 2.5), color: YELLOW });
      const len = gizmoLen(c);
      for (let k = 0; k < 3; k++) {
        const active = drag ? drag.k === k : hoverAxis === k;
        const [shaft, head] = arrow(c, k, len);
        out.push({ lines: true, verts: shaft, color: active ? YELLOW : AXIS_COLORS[k] });
        out.push({ verts: head, color: active ? YELLOW : AXIS_COLORS[k] });
      }
    }
    if (ed.faceMode) {
      if (hover && !(hover.box === ed.sel && hover.face === ed.face)) out.push({ verts: faceTris(ed.level.boxes[hover.box], hover.face), color: [1, 1, 1, 0.18] });
      if (b && ed.face >= 0) out.push({ verts: faceTris(b, ed.face), color: [1, 0.87, 0.2, 0.4] });
    }
    return out;
  }

  let last = performance.now(), nextLoad = 0;
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (looking) {
      const k = (c) => (keys.has(c) ? 1 : 0);
      const f = k('KeyW') - k('KeyS'), r = k('KeyD') - k('KeyA'), u = k('KeyE') - k('KeyQ');
      const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 300 : 100) * dt;
      const fwd = forward(cam.yaw, cam.pitch);
      const right = [Math.cos(cam.yaw), 0, -Math.sin(cam.yaw)];
      for (let i = 0; i < 3; i++) cam.pos[i] += (fwd[i] * f + right[i] * r + (i === 1 ? u : 0)) * speed;
      if (f || r || u) ed.redrawGrid();
    }
    // A rebuild bakes the lighting. While dragging, a slow one (big level) runs at most a third of the time.
    if (ed.dirty3d && now >= nextLoad) {
      ed.dirty3d = false;
      const t0 = performance.now();
      const scene = propScene(ed.pack, ed.level, generateTextures(ed.level.textures), generateTextures(ed.pack.textures || []));
      renderer.load(ed.level, scene.images, { props: scene.faces });
      const took = performance.now() - t0;
      nextLoad = ed.dragging() && took > 20 ? now + took * 2 : 0;
    }
    renderer.draw(cam, [], overlay());
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  return { cam };
}

// Outline of the box's real shape: every hull face's edges as line pairs.
function boxEdges(b) {
  const v = [];
  for (const { verts } of hullOf(b).faces) verts.forEach((p, i) => v.push(...p, ...verts[(i + 1) % verts.length]));
  return v;
}

// All hull faces using face slot f, as triangles.
function faceTris(b, f) {
  const v = [];
  for (const { n, verts } of hullOf(b).faces) {
    if (faceSlot(n) !== f) continue;
    for (let i = 1; i + 1 < verts.length; i++) v.push(...verts[0], ...verts[i], ...verts[i + 1]);
  }
  return v;
}

// Small 3D crosses on the corners, for the vertex tool.
function cross(c, size) {
  const v = [];
  for (let k = 0; k < 3; k++) {
    const a = [...c], z = [...c];
    a[k] -= size;
    z[k] += size;
    v.push(...a, ...z);
  }
  return v;
}
const cornerMarks = (b) => corners(b).flatMap((c) => cross(c, 1.5));

// Gizmo arrow along +axis k: a shaft (line) and a four-sided pyramid head (triangles).
function arrow(c, k, len) {
  const at = (t, du, dv) => {
    const p = [...c];
    p[k] += len * t;
    p[(k + 1) % 3] += len * du;
    p[(k + 2) % 3] += len * dv;
    return p;
  };
  const tip = at(1, 0, 0), w = 0.07;
  const base = [at(0.75, -w, -w), at(0.75, w, -w), at(0.75, w, w), at(0.75, -w, w)];
  const head = [];
  for (let i = 0; i < 4; i++) head.push(...tip, ...base[i], ...base[(i + 1) % 4]);
  return [[...c, ...at(0.78, 0, 0)], head];
}
