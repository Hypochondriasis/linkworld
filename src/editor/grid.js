// 2D grid views. Top view: x right, z down, filtered by the layer (y range).
// Side view: x (or z, per ed.sideAxis) right, y up, shows everything.
// Both create, select, move and resize boxes, move shape corners (vertex tool) and place entities.
import { ENT, ENT_TYPES, tagOf } from '../format.js';
import { hingeOf } from '../game.js';
import { corners, setCorners, fitShape, saveShape, restoreShape } from '../shape.js';
import { emitterDir } from '../particles.js';
import { DEFAULT_TYPE } from './partedit.js';
import { modelPolys, placer } from '../model.js';

const HANDLE = 6; // px
const AXIS = ['x', 'y', 'z'];
const positioned = (e) => !('box' in e); // the rest are roles of a box
const TOOL_TYPES = { light: ENT.LIGHT, message: ENT.MESSAGE, emitter: ENT.EMITTER, prop: ENT.PROP };

export function createGrid(canvas, ed, side = false) {
  const ctx = canvas.getContext('2d');
  const view = { cu: 0, cv: side ? 24 : 0, zoom: 2 }; // zoom = px per unit
  let drag = null;
  let mouse = null; // last world position under the cursor, for the status line

  // Screen axes: U to the right, V down (top view) or up (side view). D is the depth axis.
  const axes = () => (side ? [ed.sideAxis, 1, 2 - ed.sideAxis] : [0, 2, 1]);
  const flip = side ? -1 : 1;
  const su = (u) => (u - view.cu) * view.zoom + canvas.clientWidth / 2;
  const sv = (v) => flip * (v - view.cv) * view.zoom + canvas.clientHeight / 2;
  const rect = () => canvas.getBoundingClientRect();
  const local = (e) => { const r = rect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const toWorld = (e) => {
    const [px, py] = local(e);
    return [(px - canvas.clientWidth / 2) / view.zoom + view.cu, (flip * (py - canvas.clientHeight / 2)) / view.zoom + view.cv];
  };
  const snap = (v) => Math.round(v / ed.snap) * ed.snap;
  // Screen rectangle of a world-space range on the U/V axes.
  const screenRect = (u0, v0, u1, v1) => [su(u0), Math.min(sv(v0), sv(v1)), (u1 - u0) * view.zoom, (v1 - v0) * view.zoom];

  const inLayer = (b) => side || (b.max[1] > ed.layerY && b.min[1] < ed.layerY + ed.layerH);
  const entInLayer = (e) => side || (e.pos[1] >= ed.layerY && e.pos[1] <= ed.layerY + ed.layerH);
  const inside = (b, u, v) => { const [U, V] = axes(); return u >= b.min[U] && u <= b.max[U] && v >= b.min[V] && v <= b.max[V]; };

  // Draw order: far to near (top view: low to high), so picking walks it backwards.
  function order() {
    const boxes = ed.level.boxes;
    const near = side ? (ed.sideAxis === 0 ? (b) => b.max[2] : (b) => -b.min[0]) : (b) => b.max[1];
    return boxes.map((b, i) => i).sort((a, b) => near(boxes[a]) - near(boxes[b]));
  }

  // Prefer the current selection, then the nearest box, among boxes in the layer.
  function boxAt(u, v) {
    const boxes = ed.level.boxes;
    const s = boxes[ed.sel];
    if (s && inLayer(s) && inside(s, u, v)) return ed.sel;
    const o = order();
    for (let k = o.length - 1; k >= 0; k--) if (inLayer(boxes[o[k]]) && inside(boxes[o[k]], u, v)) return o[k];
    return -1;
  }

  // Which edges of the selected box are under the cursor, per screen axis: -1 = min edge, 1 = max edge, 0 = none.
  function edgesAt(e) {
    const b = ed.level.boxes[ed.sel];
    if (!b || !inLayer(b)) return null;
    const [U, V] = axes();
    const [px, py] = local(e);
    const near = (a0, a1, b0, b1, p, q) => {
      if (q < Math.min(b0, b1) - HANDLE || q > Math.max(b0, b1) + HANDLE) return 0;
      return Math.abs(p - a0) < HANDLE ? -1 : Math.abs(p - a1) < HANDLE ? 1 : 0;
    };
    const u = near(su(b.min[U]), su(b.max[U]), sv(b.min[V]), sv(b.max[V]), px, py);
    const v = near(sv(b.min[V]), sv(b.max[V]), su(b.min[U]), su(b.max[U]), py, px);
    return u || v ? { u, v } : null;
  }

  function entityAt(e) {
    const [U, V] = axes();
    const [px, py] = local(e);
    let best = -1, bestD = 10;
    ed.level.entities.forEach((en, i) => {
      if (!positioned(en) || !entInLayer(en)) return;
      const d = Math.hypot(su(en.pos[U]) - px, sv(en.pos[V]) - py);
      if (d < bestD) { best = i; bestD = d; }
    });
    return best;
  }

  function startEntity() {
    let s = ed.level.entities.find((e) => e.type === ENT.PLAYER_START);
    if (!s) ed.level.entities.unshift((s = { type: ENT.PLAYER_START, pos: [0, 0, 0], angle: 0 }));
    return s;
  }

  // Selected box's corners under the cursor (several when they overlap in this view).
  function cornersAt(e) {
    const b = ed.level.boxes[ed.sel];
    if (!b || !inLayer(b)) return [];
    const [U, V] = axes();
    const [px, py] = local(e);
    return corners(b).map((c, i) => [c, i]).filter(([c]) => Math.hypot(su(c[U]) - px, sv(c[V]) - py) <= HANDLE + 2).map(([, i]) => i);
  }

  // Shaped boxes: outline of the projected corners (2D convex hull, monotone chain), in screen space.
  function outline(b) {
    const [U, V] = axes();
    const pts = corners(b).map((c) => [su(c[U]), sv(c[V])]).sort((a, c) => a[0] - c[0] || a[1] - c[1]);
    const half = (list) => {
      const h = [];
      for (const p of list) {
        while (h.length >= 2 && (h[h.length - 1][0] - h[h.length - 2][0]) * (p[1] - h[h.length - 2][1]) - (h[h.length - 1][1] - h[h.length - 2][1]) * (p[0] - h[h.length - 2][0]) <= 0) h.pop();
        h.push(p);
      }
      return h;
    };
    const lower = half(pts), upper = half(pts.slice().reverse());
    return lower.slice(0, -1).concat(upper.slice(0, -1));
  }
  // more: add to the current path instead of starting one.
  const path = (pts, more) => { if (!more) ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); };

  // Depth for things created in the side view: the selected box's, else one block at 0.
  const sideDepth = () => {
    const b = ed.level.boxes[ed.sel], D = axes()[2];
    return b ? [b.min[D], b.max[D]] : [0, 8];
  };

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('mousedown', (e) => {
    const [U, V, D] = axes();
    const [u, v] = toWorld(e);
    if (e.button !== 0) {
      drag = { mode: 'pan', x: e.clientX, y: e.clientY };
      return;
    }
    const grab = ed.tool === 'vertex' ? cornersAt(e) : [];
    if (grab.length) {
      ed.begin();
      const b = ed.level.boxes[ed.sel];
      drag = { mode: 'vertex', idx: grab, start: [u, v], pts: corners(b), orig: saveShape(b) };
    } else if (ed.tool === 'box') {
      drag = { mode: 'create', a: [snap(u), snap(v)], b: [snap(u), snap(v)] };
    } else if (ed.tool in TOOL_TYPES) {
      if (ed.tool === 'prop' && !(ed.pack.models || []).length) return ed.flash('Make a model on the Models screen first', true);
      ed.edit(() => {
        const pos = [0, 0, 0];
        pos[U] = snap(u);
        pos[V] = snap(v);
        if (side) {
          const [d0, d1] = sideDepth();
          pos[D] = Math.round((d0 + d1) / 2);
        } else {
          pos[1] = ed.tool === 'light' ? ed.layerY + Math.round(ed.layerH * 0.75) : ed.tool === 'emitter' ? ed.layerY + Math.round(ed.layerH / 2) : ed.layerY;
        }
        // An emitter needs a particle type; the first one placed creates a default type.
        if (ed.tool === 'emitter' && !(ed.level.particles || []).length) ed.level.particles = [{ ...DEFAULT_TYPE }];
        const type = TOOL_TYPES[ed.tool];
        const e = { type, pos, angle: 0, ...ENT_TYPES[type].defaults() };
        if (type === ENT.EMITTER) e.kind = ed.shared ? 0 : Math.max(0, ed.partSel);
        if (type === ENT.PROP) e.model = Math.max(0, ed.mdlSel);
        ed.level.entities.push(e);
        ed.sel = -1;
        ed.selEnt = ed.level.entities.length - 1;
      });
    } else if (ed.tool === 'start') {
      ed.begin();
      const s = startEntity();
      if (!side) s.pos[1] = ed.layerY;
      s.pos[U] = snap(u);
      s.pos[V] = snap(v);
      drag = { mode: 'start' };
      ed.changed();
    } else {
      const ei = entityAt(e);
      if (ei >= 0) {
        ed.selectEnt(ei);
        ed.begin();
        drag = { mode: 'entity', start: [u, v], pos: [...ed.level.entities[ei].pos] };
        return;
      }
      const edges = edgesAt(e);
      const i = edges ? ed.sel : boxAt(u, v);
      if (i < 0) {
        ed.select(-1);
        drag = { mode: 'pan', x: e.clientX, y: e.clientY };
        return;
      }
      ed.select(i);
      ed.begin();
      const b = ed.level.boxes[i];
      drag = { mode: edges ? 'resize' : 'move', edges, start: [u, v], min: [...b.min], max: [...b.max] };
    }
  });

  addEventListener('mousemove', (e) => {
    if (!drag) {
      // Only the view under the cursor tracks it.
      const over = e.target === canvas;
      if (!over && !mouse) return;
      mouse = over ? toWorld(e) : null;
      if (over) canvas.style.cursor = ed.tool === 'select' && edgesAt(e) ? 'crosshair' : 'default';
      draw();
      return;
    }
    const [U, V] = axes();
    const [u, v] = (mouse = toWorld(e));
    const b = ed.level.boxes[ed.sel];
    if (drag.mode === 'pan') {
      view.cu -= (e.clientX - drag.x) / view.zoom;
      view.cv -= (flip * (e.clientY - drag.y)) / view.zoom;
      drag.x = e.clientX;
      drag.y = e.clientY;
    } else if (drag.mode === 'create') {
      drag.b = [snap(u), snap(v)];
    } else if (drag.mode === 'start') {
      if (!side) {
        const s = startEntity();
        const dx = u - s.pos[0], dz = v - s.pos[2];
        if (dx * dx + dz * dz > 4) s.angle = Math.round((Math.atan2(-dx, -dz) / (2 * Math.PI)) * 256) & 255;
        ed.changed();
      }
    } else if (drag.mode === 'entity') {
      const en = ed.level.entities[ed.selEnt];
      en.pos[U] = drag.pos[U] + snap(u - drag.start[0]);
      en.pos[V] = drag.pos[V] + snap(v - drag.start[1]);
      ed.changed();
    } else if (drag.mode === 'move') {
      const du = snap(u - drag.start[0]), dv = snap(v - drag.start[1]);
      b.min[U] = drag.min[U] + du;
      b.max[U] = drag.max[U] + du;
      b.min[V] = drag.min[V] + dv;
      b.max[V] = drag.max[V] + dv;
      ed.changed();
    } else if (drag.mode === 'resize') {
      const prev = saveShape(b);
      for (const [k, sideOf, p] of [[U, drag.edges.u, snap(u)], [V, drag.edges.v, snap(v)]]) {
        if (sideOf < 0) b.min[k] = Math.min(p, b.max[k] - 1);
        if (sideOf > 0) b.max[k] = Math.max(p, b.min[k] + 1);
      }
      if (!fitShape(b)) restoreShape(b, prev); // would flatten the shape
      ed.changed();
    } else if (drag.mode === 'vertex') {
      // Always from the drag's starting shape, so a refused (flat) position doesn't accumulate.
      const du = snap(u - drag.start[0]), dv = snap(v - drag.start[1]);
      const moves = {};
      for (const i of drag.idx) {
        const p = [...drag.pts[i]];
        p[U] += du;
        p[V] += dv;
        moves[i] = p;
      }
      restoreShape(b, drag.orig);
      if (!setCorners(b, moves)) restoreShape(b, drag.orig);
      ed.changed();
    }
    draw();
  });

  addEventListener('mouseup', () => {
    if (!drag) return;
    if (drag.mode === 'create') {
      const [U, V, D] = axes();
      const [a, b] = [drag.a, drag.b];
      if (a[0] !== b[0] && a[1] !== b[1]) {
        const min = [0, 0, 0], max = [0, 0, 0];
        [min[U], max[U]] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
        [min[V], max[V]] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
        [min[D], max[D]] = side ? sideDepth() : [ed.layerY, ed.layerY + ed.layerH];
        ed.edit(() => {
          ed.level.boxes.push(ed.newBox(min, max));
          ed.sel = ed.level.boxes.length - 1;
        });
      }
    } else if (drag.mode !== 'pan') {
      ed.commit();
    }
    drag = null;
    draw();
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [u, v] = toWorld(e);
    view.zoom = Math.max(0.05, Math.min(40, view.zoom * Math.pow(1.0015, -e.deltaY)));
    // Keep the point under the cursor fixed.
    const [u2, v2] = toWorld(e);
    view.cu += u - u2;
    view.cv += v - v2;
    draw();
  }, { passive: false });

  function draw() {
    const [U, V] = axes();
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#1b1b1b';
    ctx.fillRect(0, 0, w, h);

    // Grid: finest power-of-two spacing that is at least 8 px; brighter every 8 lines.
    let step = 1;
    while (step * view.zoom < 8) step *= 2;
    const u0 = Math.floor((view.cu - w / 2 / view.zoom) / step) * step;
    const v0 = Math.floor((view.cv - h / 2 / view.zoom) / step) * step;
    const axisColor = ['#3a5a3a', '#4a4a6a', '#5a3a3a'];
    ctx.lineWidth = 1;
    for (let u = u0; su(u) < w; u += step) line(su(u), 0, su(u), h, u === 0 ? axisColor[U] : u % (step * 8) ? '#262626' : '#333');
    for (let v = v0; v <= view.cv + h / 2 / view.zoom; v += step) line(0, sv(v), w, sv(v), v === 0 ? axisColor[V] : v % (step * 8) ? '#262626' : '#333');

    // Side view: the top view's layer as two dashed lines.
    if (side) {
      ctx.setLineDash([6, 4]);
      line(0, sv(ed.layerY), w, sv(ed.layerY), '#665');
      line(0, sv(ed.layerY + ed.layerH), w, sv(ed.layerY + ed.layerH), '#665');
      ctx.setLineDash([]);
    }

    const boxes = ed.level.boxes;
    for (const i of order()) {
      const b = boxes[i];
      const [x, y, bw, bh] = screenRect(b.min[U], b.min[V], b.max[U], b.max[V]);
      const shaped = b.shape ? outline(b) : null;
      const shapeOrRect = (fill) => {
        if (shaped) { path(shaped); fill ? ctx.fill() : ctx.stroke(); }
        else if (fill) ctx.fillRect(x, y, bw, bh);
        else ctx.strokeRect(x + 0.5, y + 0.5, bw, bh);
      };
      if (!inLayer(b)) {
        ctx.strokeStyle = '#444';
        shapeOrRect(false);
        continue;
      }
      ctx.fillStyle = b.solid ? 'rgba(110,130,160,0.55)' : 'rgba(160,110,160,0.25)';
      shapeOrRect(true);
      ctx.setLineDash(b.solid ? [] : [4, 3]);
      ctx.strokeStyle = '#9ab';
      shapeOrRect(false);
      if (shaped) { ctx.strokeStyle = '#555'; ctx.strokeRect(x + 0.5, y + 0.5, bw, bh); } // its bounding box
      ctx.setLineDash([]);
    }

    // Box roles: doors, triggers and exits label and tint the box they use. A rotating door shows its hinge.
    ctx.font = '11px sans-serif';
    for (const en of ed.level.entities) {
      const role = tagOf(en);
      const b = boxes[en.box];
      if (!role || !b || !inLayer(b)) continue;
      const [x, y, bw, bh] = screenRect(b.min[U], b.min[V], b.max[U], b.max[V]);
      ctx.strokeStyle = ctx.fillStyle = role[1];
      ctx.strokeRect(x + 2.5, y + 2.5, bw - 4, bh - 4);
      ctx.fillText(role[0], x + bw / 2 - ctx.measureText(role[0]).width / 2, y + bh / 2 + 4);
      if (en.type === ENT.ROTATOR) {
        const h0 = hingeOf(en, b), h1 = [...h0];
        h0[en.axis] = b.min[en.axis];
        h1[en.axis] = b.max[en.axis];
        ctx.lineWidth = 3;
        line(su(h0[U]), sv(h0[V]), su(h1[U]), sv(h1[V]), role[1]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(su(h0[U]), sv(h0[V]), 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Triggers: a dashed line (in their tag color) to everything they activate.
    const at = (e) => ('box' in e && boxes[e.box] ? boxes[e.box].min.map((v, k) => (v + boxes[e.box].max[k]) / 2) : e.pos);
    ctx.setLineDash([3, 3]);
    for (const en of ed.level.entities) {
      if (!en.targets || !boxes[en.box]) continue;
      const a = at(en);
      for (const t of en.targets) {
        const b = at(ed.level.entities[t]);
        line(su(a[U]), sv(a[V]), su(b[U]), sv(b[V]), tagOf(en)[1]);
      }
    }
    ctx.setLineDash([]);

    const s = boxes[ed.sel];
    if (s) {
      ctx.strokeStyle = '#fd3';
      ctx.lineWidth = 2;
      ctx.strokeRect(...screenRect(s.min[U], s.min[V], s.max[U], s.max[V]));
      ctx.lineWidth = 1;
    }

    // Vertex tool: a handle per corner of the selected box (overlapping corners share one).
    if (s && ed.tool === 'vertex' && inLayer(s)) {
      corners(s).forEach((c, i) => {
        ctx.fillStyle = ed.selVert.includes(i) ? '#fff' : '#fd3'; // white: the vertex selected in 3D
        ctx.fillRect(su(c[U]) - 3, sv(c[V]) - 3, 6, 6);
      });
    }

    if (drag && drag.mode === 'create') {
      ctx.strokeStyle = '#fd3';
      const [a, b] = [drag.a, drag.b];
      ctx.strokeRect(...screenRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])));
    }

    ed.level.entities.forEach((e, i) => {
      if (!positioned(e)) return;
      const x = su(e.pos[U]), y = sv(e.pos[V]);
      ctx.globalAlpha = entInLayer(e) ? 1 : 0.35;
      if (e.type === ENT.PLAYER_START) {
        if (side) {
          ctx.fillStyle = '#4e4';
          ctx.fillRect(x - 2.5 * view.zoom, y - 14 * view.zoom, 5 * view.zoom, 14 * view.zoom); // player height
        } else {
          arrow(x, y, (e.angle / 256) * Math.PI * 2, '#4e4');
        }
      } else if (e.type === ENT.LIGHT) {
        const c = `rgb(${e.color.join(',')})`;
        ctx.strokeStyle = c;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.arc(x, y, e.radius * view.zoom, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
      } else if (e.type === ENT.EMITTER) {
        // Directional types (spread below 255) get an arrow along the firing direction, projected on this view.
        const t = (ed.level.particles || [])[e.kind];
        if (t && t.spread < 255) {
          const d = emitterDir(e), len = 24;
          const dx = d[U] * len, dy = (side ? -1 : 1) * d[V] * len;
          ctx.strokeStyle = ctx.fillStyle = '#fa4';
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + dx, y + dy);
          ctx.stroke();
          const l = Math.hypot(dx, dy);
          if (l > 3) {
            const ux = dx / l, uy = dy / l;
            ctx.beginPath();
            ctx.moveTo(x + dx, y + dy);
            ctx.lineTo(x + dx - ux * 7 - uy * 4, y + dy - uy * 7 + ux * 4);
            ctx.lineTo(x + dx - ux * 7 + uy * 4, y + dy - uy * 7 - ux * 4);
            ctx.fill();
          }
        }
        ctx.fillStyle = '#fa4';
        ctx.beginPath();
        ctx.moveTo(x, y - 6); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 6); ctx.lineTo(x - 6, y);
        ctx.fill();
        ctx.fillStyle = '#000';
        ctx.fillText('F', x - 3, y + 4);
      } else if (e.type === ENT.PROP) {
        // The model's outline (its polygons' edges) and, from above, which way it faces.
        const m = (ed.pack.models || [])[e.model];
        if (m) {
          const place = placer(m, e);
          ctx.strokeStyle = 'rgba(140,220,140,0.6)';
          ctx.beginPath();
          for (const { verts } of modelPolys(m)) path(verts.map(place).map((p) => [su(p[U]), sv(p[V])]), true);
          ctx.stroke();
        }
        if (!side) arrow(x, y, (e.angle / 256) * Math.PI * 2, '#8d8');
        ctx.fillStyle = '#8d8';
        ctx.fillRect(x - 3, y - 3, 6, 6);
      } else {
        ctx.fillStyle = '#c8f';
        ctx.fillRect(x - 5, y - 5, 10, 10);
        ctx.fillStyle = '#000';
        ctx.fillText('M', x - 4, y + 4);
      }
      if (i === ed.selEnt) {
        ctx.strokeStyle = '#fd3';
        ctx.lineWidth = 2;
        ctx.strokeRect(x - 8, y - 8, 16, 16);
        ctx.lineWidth = 1;
      }
      ctx.globalAlpha = 1;
    });
    if (ed.cam) {
      if (side) {
        ctx.fillStyle = '#4cf';
        ctx.beginPath();
        ctx.arc(su(ed.cam.pos[U]), sv(ed.cam.pos[V]), 5, 0, Math.PI * 2);
        ctx.fill();
      } else {
        arrow(su(ed.cam.pos[0]), sv(ed.cam.pos[2]), ed.cam.yaw, '#4cf');
      }
    }

    ctx.fillStyle = '#aaa';
    ctx.font = '12px sans-serif';
    const m = mouse ? `${AXIS[U]} ${snap(mouse[0])}  ${AXIS[V]} ${snap(mouse[1])}   ` : '';
    ctx.fillText(side ? `${m}side view` : `${m}top view · layer y ${ed.layerY}..${ed.layerY + ed.layerH}`, 6, h - 6);
  }

  function line(x1, y1, x2, y2, color) {
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5);
    ctx.lineTo(Math.round(x2) + 0.5, Math.round(y2) + 0.5);
    ctx.stroke();
  }

  // Facing yaw: forward = (-sin, -cos) in (x, z).
  function arrow(x, z, yaw, color) {
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x + fx * 12, z + fz * 12);
    ctx.lineTo(x - fz * 6 - fx * 5, z + fx * 6 - fz * 5);
    ctx.lineTo(x + fz * 6 - fx * 5, z - fx * 6 - fz * 5);
    ctx.fill();
  }

  return { draw };
}
