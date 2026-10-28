// Models screen: model and part lists, each part's look, vertex tools (face, extrude, merge, ...), the model's
// emitter, 2D views (top, front, side or UV) to select and move vertices or uvs, and a lit 3D preview.
// Parts start as primitives; base parts are mirrored across x = 0, detail parts are drawn once.
import { ENT, LIMITS, removeModel, modelTris } from '../format.js';
import { primitive, makeFace, deleteVerts, deleteFaces, flipFaces, mergeVerts, extrude, faceUV, modelPolys, placer, propScene } from '../model.js';
import { generateTextures } from '../texgen.js';
import { createRenderer } from '../render.js';
import { createParticles, emitterDir } from '../particles.js';
import { forward } from '../shape.js';
import { DEFAULT_TYPE } from './partedit.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};
const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
const rgb = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
const int = (lo, hi) => (s) => {
  const v = Math.round(Number(s));
  return s === '' || !Number.isFinite(v) ? NaN : Math.max(lo, Math.min(hi, v));
};
const MC = LIMITS.modelCoord;
const clampC = (v) => Math.max(-MC, Math.min(MC, v));
const PRIM_SIZE = 16; // model units

export function createModelEditor(ed) {
  const models = () => (ed.pack.models ||= []);
  const model = () => models()[ed.mdlSel];
  const part = () => model() && model().parts[ed.mdlPart];
  const snapV = () => Number($('mdlSnap').value) || 1;
  const snap = (v) => Math.round(v / snapV()) * snapV();

  // ---- panel ----

  const fields = [];
  function field(id, get, set, parse) {
    const inp = $(id), prop = inp.type === 'checkbox' ? 'checked' : 'value';
    inp.onchange = () => {
      const v = parse(inp[prop]);
      if (Number.isNaN(v)) return refresh();
      ed.edit(() => set(v));
    };
    fields.push(() => { if (document.activeElement !== inp) inp[prop] = get(); });
  }
  const P = (fn, none = '') => () => (part() ? fn(part()) : none);
  field('mdlName', () => model().name, (v) => { model().name = v; }, (s) => {
    while (new TextEncoder().encode(s).length > LIMITS.modelName) s = s.slice(0, -1);
    return s;
  });
  field('mdlScale', () => model().scale, (v) => { model().scale = v; }, int(1, 255));
  field('partMirror', P((p) => p.mirror, false), (v) => { part().mirror = v; }, Boolean);
  field('partTex', P((p) => p.tex), (v) => { part().tex = v; }, Number);
  field('partColor', P((p) => hex(p.color), '#000000'), (v) => { part().color = v; }, rgb);
  field('partScale', P((p) => p.scale), (v) => { part().scale = v; }, int(0, 255));
  const em = () => model().emitter;
  const E = (fn) => () => (em() ? fn(em()) : '');
  field('emitKind', E((x) => x.kind), (v) => { em().kind = v; }, Number);
  ['X', 'Y', 'Z'].forEach((a, k) => field('emit' + a, E((x) => x.pos[k]), (v) => { em().pos[k] = v; }, int(-MC, MC)));
  field('emitAngle', E((x) => x.angle), (v) => { em().angle = v; }, int(0, 255));
  field('emitPitch', E((x) => x.pitch), (v) => { em().pitch = v; }, int(0, 255));
  // An emitter needs a shared particle type; the first one creates a default type.
  field('mdlEmit', () => !!(model() && em()), (on) => {
    if (!on) return delete model().emitter;
    if (!(ed.pack.particles || []).length) ed.pack.particles = [{ ...DEFAULT_TYPE }];
    model().emitter = { kind: 0, pos: [0, PRIM_SIZE, 0], angle: 0, pitch: 64 };
  }, Boolean);

  $('addMdl').onclick = () => {
    if (models().length >= LIMITS.models) return ed.flash('Too many models', true);
    ed.edit(() => {
      models().push({ name: `Model ${models().length + 1}`, scale: 8, parts: [] });
      ed.mdlSel = models().length - 1;
      ed.mdlPart = -1;
    });
  };
  $('delMdl').onclick = () => {
    if (!model()) return;
    let ok = true;
    ed.edit(() => { ok = removeModel(ed.pack, ed.mdlSel); });
    if (!ok) ed.flash('A prop uses this model: delete the props first', true);
  };
  // Base parts start on the +x side, touching the mirror plane; detail parts in the middle. All stand on y = 0.
  for (const b of document.querySelectorAll('[data-prim]')) {
    b.onclick = () => {
      const m = model(), base = !!b.dataset.base;
      if (!m) return;
      if (m.parts.length >= LIMITS.parts) return ed.flash('Too many parts', true);
      ed.edit(() => {
        const shape = primitive(b.dataset.prim, [base ? PRIM_SIZE / 2 : 0, PRIM_SIZE / 2, 0], PRIM_SIZE);
        m.parts.push({ mirror: base, tex: 0, color: [180, 180, 180], scale: 32, ...shape });
        ed.mdlPart = m.parts.length - 1;
        ed.mdlVerts = [];
      });
    };
  }
  $('dupPart').onclick = () => {
    const m = model();
    if (!part() || m.parts.length >= LIMITS.parts) return;
    ed.edit(() => {
      m.parts.push(structuredClone(part()));
      ed.mdlPart = m.parts.length - 1;
    });
  };
  $('delPartM').onclick = () => part() && ed.edit(() => { model().parts.splice(ed.mdlPart, 1); ed.mdlVerts = []; });
  $('editShared').onclick = () => {
    ed.setShared(true);
    if (part() && part().tex) ed.texSel = part().tex - 1;
    ed.showScreen('textures');
  };
  $('editSharedParts').onclick = () => {
    ed.setShared(true);
    if (em()) ed.partSel = em().kind;
    ed.showScreen('particles');
  };

  // ---- vertex tools (selected part) ----

  const sel = () => ed.mdlVerts;
  function makeFaceOp() {
    const p = part();
    if (!p) return;
    if (sel().length < 3 || sel().length > 4) return ed.flash('Select 3 or 4 vertices of the part to make a face', true);
    if (p.faces.length >= LIMITS.faces) return ed.flash('Too many faces in this part', true);
    let ok = true;
    ed.edit(() => { ok = makeFace(p, sel()); });
    if (!ok) ed.flash('Those vertices are in a line, or the face exists', true);
  }
  const withSel = (fn) => () => part() && sel().length && ed.edit(() => fn(part(), sel()));
  const delVerts = withSel((p, s) => { deleteVerts(p, s); ed.mdlVerts = []; });
  $('mkFace').onclick = makeFaceOp;
  $('flipFace').onclick = withSel(flipFaces);
  $('delFace').onclick = withSel(deleteFaces);
  $('delVert').onclick = delVerts;
  // Extrude: the selected faces move out by the snap distance on new vertices, which become the selection.
  function extrudeOp() {
    const p = part();
    if (!p) return;
    let out = null;
    ed.edit(() => {
      out = extrude(p, sel(), snapV(), LIMITS.verts, LIMITS.faces);
      if (out) ed.mdlVerts = out;
    });
    if (!out) ed.flash('Select every vertex of the faces to extrude (or the part is full)', true);
  }
  function mergeOp() {
    if (!part()) return;
    if (sel().length < 2) return ed.flash('Select 2 or more vertices to merge', true);
    ed.edit(() => { ed.mdlVerts = [mergeVerts(part(), sel())]; });
  }
  $('extrude').onclick = extrudeOp;
  $('merge').onclick = mergeOp;
  // Back to projected uvs: the shown faces (all of them when nothing is selected).
  $('resetUV').onclick = () => {
    const p = part();
    if (!p || !p.uv) return;
    ed.edit(() => {
      if (!sel().length) return delete p.uv;
      p.faces.forEach((f, k) => { if (f.every((i) => sel().includes(i))) p.uv[k] = faceUV({ ...p, uv: null }, k); });
    });
  };

  function key(e) {
    const k = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey) return;
    if (k === 'f') makeFaceOp();
    else if (k === 'e') extrudeOp();
    else if (k === 'm') mergeOp();
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); delVerts(); }
    else if (k === 'a' && part()) setSel(sel().length === part().verts.length ? [] : part().verts.map((_, i) => i));
    else if (e.key === 'Escape') setSel([]);
  }
  function setSel(s) {
    ed.mdlVerts = s;
    refresh();
  }

  // ---- lists ----

  let listKey = null;
  function lists() {
    const m = model();
    const key = JSON.stringify([models().map((x) => x.name), ed.mdlSel, ed.mdlPart, m && m.parts.map((p) => [p.mirror, p.tex, p.color]), (ed.pack.textures || []).length, (ed.pack.particles || []).length]);
    if (key === listKey) return;
    listKey = key;
    $('mdlSlots').innerHTML = '';
    models().forEach((x, i) => $('mdlSlots').append(el('button', {
      textContent: `${i + 1}: ${x.name || 'Untitled'}`, className: i === ed.mdlSel ? 'on' : '',
      onclick: () => { ed.mdlSel = i; ed.mdlPart = -1; ed.mdlVerts = ed.uvSel = []; refresh(); },
    })));
    $('mdlParts').innerHTML = '';
    if (!m) return;
    m.parts.forEach((p, i) => {
      const swatch = el('span', { className: 'swatch' });
      swatch.style.background = p.tex ? '#888' : hex(p.color);
      $('mdlParts').append(el('button', {
        className: i === ed.mdlPart ? 'on' : '', onclick: () => { ed.mdlPart = i; ed.mdlVerts = ed.uvSel = []; refresh(); },
      }, swatch, ` ${i + 1} ${p.mirror ? 'Base' : 'Detail'}${p.tex ? ' · tex ' + p.tex : ''}`));
    });
    const tex = $('partTex');
    tex.innerHTML = '';
    tex.add(new Option('Solid color', 0));
    (ed.pack.textures || []).forEach((_, i) => tex.add(new Option(`Shared texture ${i + 1}`, i + 1)));
    const kinds = $('emitKind');
    kinds.innerHTML = '';
    (ed.pack.particles || []).forEach((_, i) => kinds.add(new Option(`Shared type ${i + 1}`, i)));
  }

  function refresh() {
    if (ed.mdlSel >= models().length) ed.mdlSel = models().length - 1;
    if (ed.mdlSel < 0 && models().length) ed.mdlSel = 0;
    const m = model();
    if (!m) ed.mdlPart = -1;
    else if (ed.mdlPart >= m.parts.length || (ed.mdlPart < 0 && m.parts.length)) ed.mdlPart = m.parts.length - 1;
    const p = part();
    ed.mdlVerts = p ? ed.mdlVerts.filter((i) => i < p.verts.length) : [];
    ed.uvSel = p ? ed.uvSel.filter((n) => n < corners().length) : [];
    $('mdlEdit').hidden = !m;
    $('delMdl').disabled = !m;
    $('partProps').hidden = $('vertTools').hidden = !p;
    $('emitProps').hidden = !(m && m.emitter);
    lists();
    if (m) for (const f of fields) f();
    if (p) {
      $('partColor').hidden = !!p.tex;
      $('partScaleRow').hidden = !p.tex;
      $('vertInfo').textContent = `${p.verts.length} vertices, ${p.faces.length} faces, ${sel().length} selected · model: ${modelTris(m)} triangles` +
        (p.uv ? ' · own uvs' : '');
      $('resetUV').disabled = !p.uv;
    }
    redraw();
  }

  // ---- 2D views ----

  // Model views: U right, V down (top) or up (front, side). They move vertices and the emitter; double click adds a vertex.
  const modelView = (id, U, V, flip, title) => plane($(id), {
    flip, title, axes: 'xyz'[U] + 'xyz'[V], snap: snapV,
    zeroColors: [['#7a3a3a', '#3a6a3a', '#3a4a7a'][U], ['#7a3a3a', '#3a6a3a', '#3a4a7a'][V]], // x = 0 is the mirror plane
    pts: () => (part() ? part().verts.map((q) => [q[U], q[V]]) : []),
    sel, setSel,
    start: () => part().verts.map((q) => [...q]),
    move: (orig, du, dv) => { for (const i of sel()) moveIn(part().verts[i], orig[i], du, dv, U, V); },
    handle: {
      at: () => (model() && model().emitter ? [model().emitter.pos[U], model().emitter.pos[V]] : null),
      start: () => [...model().emitter.pos],
      move: (orig, du, dv) => moveIn(model().emitter.pos, orig, du, dv, U, V),
    },
    dblclick(u, v) {
      const p = part(), D = 3 - U - V;
      if (!p) return ed.flash('Add a part first', true);
      if (p.verts.length >= LIMITS.verts) return ed.flash('Too many vertices in this part', true);
      const q = [0, 0, 0];
      q[U] = clampC(snap(u));
      q[V] = clampC(snap(v));
      q[D] = p.verts.length ? snap(p.verts.reduce((s, x) => s + x[D], 0) / p.verts.length) : 0;
      ed.edit(() => {
        p.verts.push(q);
        ed.mdlVerts = [p.verts.length - 1];
      });
    },
    draw(ctx, su, sv) {
      const m = model();
      if (!m) return;
      // Other parts dim, the selected one bright; mirrored copies dashed.
      for (const { part: p, verts, mirrored } of modelPolys(m)) {
        ctx.setLineDash(mirrored ? [3, 3] : []);
        ctx.strokeStyle = p === part() ? (mirrored ? '#6b7a88' : '#9bd') : '#555';
        polyline(ctx, verts.map((q) => [su(q[U]), sv(q[V])]));
      }
      ctx.setLineDash([]);
      if (m.emitter) {
        const x = su(m.emitter.pos[U]), y = sv(m.emitter.pos[V]), d = emitterDir(m.emitter);
        ctx.fillStyle = ctx.strokeStyle = '#fa4';
        ctx.beginPath();
        ctx.moveTo(x, y - 6); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 6); ctx.lineTo(x - 6, y);
        ctx.fill();
        polyline(ctx, [[x, y], [x + d[U] * 20, y + flip * d[V] * 20]], true);
      }
    },
  });
  const moveIn = (q, o, du, dv, U, V) => { q[U] = clampC(o[U] + du); q[V] = clampC(o[V] + dv); };

  // UV view: the part's faces in texture space (64 units = one repeat, v down like the image), over its texture.
  // It shows the faces whose vertices are all selected, or all faces. Corners of one vertex at one spot move together.
  const corners = () => (part() ? part().faces.flatMap((f, k) => f.map((i, j) => ({ k, j, i }))) : []);
  const shown = () => { const s = sel(); return (f) => !s.length || f.every((i) => s.includes(i)); };
  const uvView = plane($('mdlUV'), {
    flip: 1, title: 'UV', axes: 'uv', snap: () => 1, grid: 8, zeroColors: ['#555', '#555'],
    pts() {
      const p = part(), show = shown();
      if (!p) return [];
      const uvs = p.faces.map((_, k) => faceUV(p, k));
      return corners().map((c) => (show(p.faces[c.k]) ? uvs[c.k][c.j] : null));
    },
    stack(id, pts) {
      const cs = corners(), at = pts[id];
      return cs.map((_, n) => n).filter((n) => pts[n] && cs[n].i === cs[id].i && pts[n][0] === at[0] && pts[n][1] === at[1]);
    },
    sel: () => ed.uvSel,
    setSel: (s) => { ed.uvSel = s; refresh(); },
    start() {
      const p = part();
      if (!p.uv) p.uv = p.faces.map((_, k) => faceUV(p, k)); // a part gets its own uvs on its first uv edit
      return p.uv.map((c) => c.map((x) => [...x]));
    },
    move(orig, du, dv) {
      const cs = corners(), clampUV = (v) => Math.max(-LIMITS.uv, Math.min(LIMITS.uv, v));
      for (const n of ed.uvSel) { const { k, j } = cs[n]; part().uv[k][j] = [clampUV(orig[k][j][0] + du), clampUV(orig[k][j][1] + dv)]; }
    },
    draw(ctx, su, sv, W, H) {
      const p = part();
      if (!p) return;
      const img = p.tex && texCanvas(p.tex);
      if (img) {
        // The texture under every visible repeat (at most 400 of them).
        const r0 = [Math.floor((-su(0)) / (64 * zoomOf(su))), Math.floor((-sv(0)) / (64 * zoomOf(su)))];
        const size = 64 * zoomOf(su), nu = Math.ceil(W / size) + 1, nv = Math.ceil(H / size) + 1;
        ctx.imageSmoothingEnabled = false;
        ctx.globalAlpha = 0.6;
        if (nu * nv <= 400) for (let a = 0; a < nu; a++) for (let b = 0; b < nv; b++) ctx.drawImage(img, su((r0[0] + a) * 64), sv((r0[1] + b) * 64), size, size);
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = '#777';
      for (let u = Math.floor(-su(0) / zoomOf(su) / 64) * 64; su(u) < W; u += 64) polyline(ctx, [[su(u), 0], [su(u), H]], true);
      for (let v = Math.floor(-sv(0) / zoomOf(su) / 64) * 64; sv(v) < H; v += 64) polyline(ctx, [[0, sv(v)], [W, sv(v)]], true);
      const show = shown();
      ctx.strokeStyle = '#9bd';
      p.faces.forEach((f, k) => { if (show(f)) polyline(ctx, faceUV(p, k).map(([u, v]) => [su(u), sv(v)])); });
      if (!p.tex) {
        ctx.fillStyle = '#aaa';
        ctx.fillText('Solid color part: uvs only matter with a texture', 6, 16);
      }
    },
  });
  const zoomOf = (su) => su(1) - su(0);
  const texImgs = new Map();
  function texCanvas(t) {
    const img = generateTextures(ed.pack.textures || [])[t];
    if (!img) return null;
    if (!texImgs.has(img)) {
      const c = el('canvas', { width: img.width, height: img.height });
      c.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
      texImgs.set(img, c);
    }
    return texImgs.get(img);
  }

  // The side pane shows the side view or the UV view.
  $('sidePane').onchange = () => {
    $('mdlSide').hidden = $('sidePane').value === 'uv';
    $('mdlUV').hidden = $('sidePane').value !== 'uv';
    redraw();
  };
  const views = [modelView('mdlTop', 0, 2, 1, 'Top'), modelView('mdlFront', 0, 1, -1, 'Front'), modelView('mdlSide', 2, 1, -1, 'Side'), uvView];
  let redrawId = 0;
  function redraw() {
    if (redrawId) return;
    redrawId = requestAnimationFrame(() => {
      redrawId = 0;
      if (ed.screen === 'models') for (const v of views) v.draw();
    });
  }
  addEventListener('resize', redraw);

  function polyline(ctx, pts, open) {
    ctx.beginPath();
    pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (!open) ctx.closePath();
    ctx.stroke();
  }

  // A 2D view of points in a plane: right-drag pans, wheel zooms, click selects a point (with the points stacked on
  // it; Shift toggles), drag moves the selection (one undo step), drag on empty space box-selects. src: see above.
  function plane(canvas, src) {
    const ctx = canvas.getContext('2d'), flip = src.flip;
    const view = { cu: 0, cv: 16, zoom: 4 }; // zoom = px per unit
    let drag = null, mouse = null;
    const w = () => canvas.clientWidth, h = () => canvas.clientHeight;
    const su = (u) => (u - view.cu) * view.zoom + w() / 2;
    const sv = (v) => flip * (v - view.cv) * view.zoom + h() / 2;
    const local = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const toPlane = (e) => { const [x, y] = local(e); return [(x - w() / 2) / view.zoom + view.cu, (flip * (y - h() / 2)) / view.zoom + view.cv]; };
    const snapTo = (v) => Math.round(v / src.snap()) * src.snap();
    const stack = (id, pts) => (src.stack ? src.stack(id, pts) : pts.map((_, n) => n).filter((n) => pts[n] && pts[n][0] === pts[id][0] && pts[n][1] === pts[id][1]));

    // The points stacked on the nearest one within 7 px of the cursor.
    function pointsAt(e) {
      const pts = src.pts(), m = local(e);
      let best = -1, bestD = 7;
      pts.forEach((q, n) => {
        if (!q) return;
        const d = Math.hypot(su(q[0]) - m[0], sv(q[1]) - m[1]);
        if (d < bestD) { best = n; bestD = d; }
      });
      return best < 0 ? [] : stack(best, pts);
    }

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return (drag = { mode: 'pan', x: e.clientX, y: e.clientY });
      const hp = src.handle && src.handle.at(), m = local(e);
      if (hp && Math.hypot(su(hp[0]) - m[0], sv(hp[1]) - m[1]) <= 7) {
        ed.begin();
        return (drag = { mode: 'handle', start: toPlane(e), orig: src.handle.start() });
      }
      const hits = pointsAt(e), sel = src.sel();
      if (!hits.length) return (drag = { mode: 'band', a: m, b: m, add: e.shiftKey });
      const all = hits.every((i) => sel.includes(i));
      if (e.shiftKey) return src.setSel(all ? sel.filter((i) => !hits.includes(i)) : [...sel, ...hits.filter((i) => !sel.includes(i))]);
      if (!all) src.setSel(hits);
      ed.begin();
      drag = { mode: 'move', start: toPlane(e), orig: src.start() };
    });
    addEventListener('mousemove', (e) => {
      if (e.target === canvas || mouse) {
        mouse = e.target === canvas ? toPlane(e) : null;
        if (!drag) draw();
      }
      if (!drag) return;
      if (drag.mode === 'pan') {
        view.cu -= (e.clientX - drag.x) / view.zoom;
        view.cv -= (flip * (e.clientY - drag.y)) / view.zoom;
        drag.x = e.clientX;
        drag.y = e.clientY;
        return draw();
      }
      if (drag.mode === 'band') {
        drag.b = local(e);
        return draw();
      }
      const [u, v] = toPlane(e), du = snapTo(u - drag.start[0]), dv = snapTo(v - drag.start[1]);
      (drag.mode === 'handle' ? src.handle : src).move(drag.orig, du, dv);
      ed.changed();
    });
    addEventListener('mouseup', () => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (d.mode === 'move' || d.mode === 'handle') return ed.commit();
      if (d.mode !== 'band') return;
      // A click on empty space (no band) clears the selection unless Shift is held.
      const [x0, x1] = [Math.min(d.a[0], d.b[0]), Math.max(d.a[0], d.b[0])], [y0, y1] = [Math.min(d.a[1], d.b[1]), Math.max(d.a[1], d.b[1])];
      const inBand = src.pts().map((q, n) => (q && su(q[0]) >= x0 && su(q[0]) <= x1 && sv(q[1]) >= y0 && sv(q[1]) <= y1 ? n : -1)).filter((n) => n >= 0);
      src.setSel(d.add ? [...new Set([...src.sel(), ...inBand])] : inBand);
    });
    canvas.addEventListener('dblclick', (e) => {
      if (src.dblclick && !pointsAt(e).length) src.dblclick(...toPlane(e));
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [u, v] = toPlane(e);
      view.zoom = Math.max(0.2, Math.min(60, view.zoom * Math.pow(1.0015, -e.deltaY)));
      const [u2, v2] = toPlane(e);
      view.cu += u - u2;
      view.cv += v - v2;
      draw();
    }, { passive: false });

    function draw() {
      const dpr = window.devicePixelRatio || 1, W = w(), H = h();
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#1b1b1b';
      ctx.fillRect(0, 0, W, H);
      ctx.lineWidth = 1;
      let step = src.grid || src.snap();
      while (step * view.zoom < 6) step *= 2;
      const u0 = Math.floor((view.cu - W / 2 / view.zoom) / step) * step, v0 = Math.floor((view.cv - H / 2 / view.zoom) / step) * step;
      for (let u = u0; su(u) < W; u += step) { ctx.strokeStyle = u === 0 ? src.zeroColors[0] : '#262626'; polyline(ctx, [[Math.round(su(u)) + 0.5, 0], [Math.round(su(u)) + 0.5, H]], true); }
      for (let v = v0; v <= view.cv + H / 2 / view.zoom; v += step) { ctx.strokeStyle = v === 0 ? src.zeroColors[1] : '#262626'; polyline(ctx, [[0, Math.round(sv(v)) + 0.5], [W, Math.round(sv(v)) + 0.5]], true); }
      src.draw(ctx, su, sv, W, H);
      const sel = src.sel();
      src.pts().forEach((q, n) => {
        if (!q) return;
        ctx.fillStyle = sel.includes(n) ? '#fd3' : '#ddd';
        ctx.fillRect(su(q[0]) - 2.5, sv(q[1]) - 2.5, 5, 5);
      });
      if (drag && drag.mode === 'band') {
        ctx.strokeStyle = '#fd3';
        ctx.strokeRect(Math.min(drag.a[0], drag.b[0]) + 0.5, Math.min(drag.a[1], drag.b[1]) + 0.5, Math.abs(drag.b[0] - drag.a[0]), Math.abs(drag.b[1] - drag.a[1]));
      }
      ctx.fillStyle = '#aaa';
      ctx.font = '12px sans-serif';
      ctx.fillText((mouse ? `${src.axes[0]} ${snapTo(mouse[0])}  ${src.axes[1]} ${snapTo(mouse[1])}   ` : '') + src.title, 6, H - 6);
    }
    return { draw };
  }

  // ---- 3D preview: the model as a prop at the origin, lit by two lights; drag to orbit, wheel to zoom ----

  let renderer = null;
  try {
    renderer = createRenderer($('mdl3d'));
  } catch (e) {
    $('mdl3d').replaceWith(el('p', { textContent: '3D preview unavailable: ' + e.message }));
  }
  const orbit = { yaw: Math.PI - 0.6, pitch: -0.35, zoom: 1 }; // starts in front of the model (it faces −z)
  let loaded = null, sim = null, frameInfo = null, last = performance.now();
  if (renderer) {
    const c = $('mdl3d');
    let spin = null;
    c.addEventListener('mousedown', (e) => { spin = [e.clientX, e.clientY]; });
    addEventListener('mouseup', () => { spin = null; });
    addEventListener('mousemove', (e) => {
      if (!spin) return;
      orbit.yaw -= (e.clientX - spin[0]) * 0.01;
      orbit.pitch = Math.max(-1.5, Math.min(1.5, orbit.pitch - (e.clientY - spin[1]) * 0.01));
      spin = [e.clientX, e.clientY];
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      orbit.zoom = Math.max(0.2, Math.min(5, orbit.zoom * Math.pow(1.0015, e.deltaY)));
    }, { passive: false });
    requestAnimationFrame(frame);
  }

  function load(m) {
    const k = m.scale / 32, pts = m.parts.flatMap((p) => p.verts).concat([[0, 0, 0]]);
    const ys = pts.map((p) => p[1] * k);
    const r = Math.max(4, ...pts.map((p) => Math.hypot(...p) * k));
    const level = {
      name: '', ambient: [90, 90, 100], fog: [34, 34, 40], fogDist: 0, textures: [], boxes: [],
      entities: [
        { type: ENT.LIGHT, pos: [r * 2, r * 3, -r * 3], angle: 0, color: [255, 245, 230], radius: r * 12 },
        { type: ENT.LIGHT, pos: [-r * 3, r, r * 3], angle: 0, color: [110, 120, 150], radius: r * 12 },
        { type: ENT.PROP, pos: [0, 0, 0], angle: 0, model: ed.mdlSel },
      ],
    };
    const scene = propScene(ed.pack, level, generateTextures([]), generateTextures(ed.pack.textures || []));
    renderer.load(level, scene.images, { props: scene.faces });
    sim = createParticles(scene.particles, scene.emitters);
    frameInfo = { r, cy: (Math.min(...ys) + Math.max(...ys)) / 2, place: placer(m, level.entities[2]) };
  }

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    const m = model();
    if (ed.screen !== 'models' || !m) return;
    const key = JSON.stringify([m, ed.pack.textures, ed.pack.particles]);
    if (key !== loaded) {
      loaded = key;
      load(m);
    }
    sim.update(dt);
    const { r, cy, place } = frameInfo, f = forward(orbit.yaw, orbit.pitch), dist = r * 3 * orbit.zoom;
    const cam = { pos: [-f[0] * dist, cy - f[1] * dist, -f[2] * dist], yaw: orbit.yaw, pitch: orbit.pitch };
    // Overlay: the selected part's edges and selected vertices, and the emitter.
    const out = [];
    const p = part(), s = r * 0.04;
    const cross = (c) => [0, 1, 2].flatMap((k) => { const a = [...c], b = [...c]; a[k] -= s; b[k] += s; return [...a, ...b]; });
    if (p) {
      const edges = p.faces.flatMap((fc) => fc.flatMap((i, j) => [...place(p.verts[i]), ...place(p.verts[fc[(j + 1) % fc.length]])]));
      if (edges.length) out.push({ lines: true, verts: edges, color: [1, 0.87, 0.2, 0.5] });
      const marks = sel().flatMap((i) => cross(place(p.verts[i])));
      if (marks.length) out.push({ lines: true, verts: marks, color: [1, 0.87, 0.2, 1] });
    }
    if (m.emitter) out.push({ lines: true, verts: cross(place(m.emitter.pos)), color: [1, 0.65, 0.25, 1] });
    renderer.draw(cam, [], out, sim);
  }

  return { refresh, key };
}
