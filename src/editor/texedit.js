// Texture slots + recipe editor: preview canvas, op list with plain inputs, shapes drawn on the preview.
import { OPS, FONT_CHARS, checkRecipe, checkTextures, defaultArgs, generateTextures, readParams, textBox } from '../texgen.js';
import { PRESETS, insertPreset } from '../presets.js';
import { LIMITS, removeTexture } from '../format.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};
const SHADE = 64, REF = 80, OVER = 51, TEXT = 21;

export function createTexEditor(ed) {
  const preview = $('texPreview');
  let built = null; // key of what the op list currently shows
  let builtLevel = null; // the op list holds references into this owner (level or pack)
  let session = false; // a live slider drag in progress (one undo step)
  let draw = null; // { op, start, index } while dragging a shape on the preview
  let poly = null; // points collected for a polygon

  const tex = () => ed.owner().textures[ed.texSel];

  // Slider-style edits: one undo step from first 'input' to 'change'.
  const live = (fn) => {
    if (!session) { ed.begin(); session = true; }
    fn();
    ed.changed();
  };
  const done = () => {
    if (session) { session = false; ed.commit(); }
  };

  for (const p of PRESETS) $('preset').add(new Option(p.name, p.name));
  $('preset').onchange = () => {
    const name = $('preset').value;
    $('preset').value = '';
    if (ed.owner().textures.length + 2 > LIMITS.textures) return ed.flash('Too many textures', true);
    ed.edit(() => { ed.texSel = insertPreset(ed.owner().textures, name) - 1; });
  };
  $('addTex').onclick = () => {
    if (ed.owner().textures.length >= LIMITS.textures) return ed.flash('Too many textures', true);
    ed.edit(() => {
      ed.owner().textures.push({ size: 64, ops: [{ op: 2, args: defaultArgs(2) }] });
      ed.texSel = ed.owner().textures.length - 1;
    });
  };
  $('delTex').onclick = () => {
    const n = ed.texSel + 1;
    if (!tex()) return;
    if (ed.owner().textures.some((t) => t.ops.some((o) => o.op === REF && o.args[0] === n))) return ed.flash(`Texture ${n} is used by a Reference op`, true);
    ed.edit(() => {
      removeTexture(ed.owner(), n);
      ed.texSel = Math.min(ed.texSel, ed.owner().textures.length - 1);
    });
  };
  $('texSize').onchange = () => ed.edit(() => { tex().size = Number($('texSize').value); });
  $('texAlpha').onchange = () => ed.edit(() => { if ($('texAlpha').checked) tex().transparent = true; else delete tex().transparent; });
  $('texTiled').onchange = () => refresh();

  for (const op of Object.keys(OPS).map(Number)) $('addOp').add(new Option(OPS[op].name, op));
  $('addOp').onchange = () => {
    const op = Number($('addOp').value);
    $('addOp').value = '';
    if (op !== REF) return op && addOp(op, defaultArgs(op), false);
    if (ed.owner().textures.length < 2) return ed.flash('Reference needs another texture to point at', true);
    addOp(REF, [ed.texSel === 0 ? 2 : 1], false);
  };

  // Inserts before a final Shade (or replaces it with a new Shade). withOver: composite a drawn shape onto what is below.
  function addOp(op, args, withOver) {
    const t = tex();
    if (!t) return -1;
    if (t.ops.length + (withOver ? 2 : 1) > LIMITS.ops) {
      ed.flash('Too many ops in this texture', true);
      return -1;
    }
    const hasShade = t.ops.length && t.ops[t.ops.length - 1].op === SHADE;
    let at = hasShade ? t.ops.length - 1 : t.ops.length;
    ed.edit(() => {
      if (op === SHADE && hasShade) t.ops[at] = { op, args };
      else {
        const add = [{ op, args }];
        if (withOver && at > 0) add.push({ op: OVER, args: [255] });
        t.ops.splice(at, 0, ...add);
      }
    });
    return at;
  }

  // ---- drawing shapes on the preview ----

  const DRAW_NAMES = { 16: 'Rect', 17: 'Rounded', 18: 'Circle', 19: 'Line', 20: 'Polygon', 21: 'Text' };
  for (const [op, name] of Object.entries(DRAW_NAMES)) {
    const b = el('button', { textContent: name });
    b.dataset.draw = op;
    b.onclick = () => {
      ed.drawOp = ed.drawOp === Number(op) ? 0 : Number(op);
      poly = null;
      refresh();
    };
    $('drawTools').append(b);
  }
  $('polyDone').onclick = finishPoly;

  // Mouse position -> 0..255 tile coordinates (wrapped when the preview shows 2x2 tiles).
  const toTex = (e) => {
    const r = preview.getBoundingClientRect();
    const reps = $('texTiled').checked ? 2 : 1;
    const f = (v, len) => Math.max(0, Math.min(255, Math.round((((v / len) * reps) % 1) * 255)));
    return [f(e.clientX - r.left, r.width), f(e.clientY - r.top, r.height)];
  };
  const shapeArgs = (op, a, b) => {
    const [x0, y0, x1, y1] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    if (op === 16) return [x0, y0, x1, y1];
    if (op === 17) return [x0, y0, x1, y1, Math.min(24, (x1 - x0) >> 1, (y1 - y0) >> 1)];
    if (op === 18) return [a[0], a[1], Math.max(1, Math.min(255, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]))))];
    return [...a, ...b, 16];
  };

  // Topmost Text op under the point (tile units), testing in the text's rotated frame.
  const textAt = ([mx, my]) => {
    const ops = tex().ops;
    for (let i = ops.length - 1; i >= 0; i--) {
      if (ops[i].op !== TEXT) continue;
      const p = readParams(TEXT, ops[i].args);
      const [hw, hh] = textBox(p);
      const a = (p.angle / 128) * Math.PI, dx = mx - p.x, dy = my - p.y;
      if (Math.abs(dx * Math.cos(a) + dy * Math.sin(a)) <= hw + 4 && Math.abs(-dx * Math.sin(a) + dy * Math.cos(a)) <= hh + 4) return i;
    }
    return -1;
  };
  const angleFrom = (args, m) => Math.atan2(m[1] - args[1], m[0] - args[0]);

  // Drag on text: move it. Shift+drag: rotate it. One undo step per drag.
  function grabText(i, m, rotate) {
    const args = tex().ops[i].args;
    draw = rotate ? { rotate: i, angle: args[3], a0: angleFrom(args, m) } : { move: i, off: [args[0] - m[0], args[1] - m[1]] };
    ed.begin();
    session = true;
  }

  preview.addEventListener('mousedown', (e) => {
    if (!tex()) return;
    const p = toTex(e);
    if (ed.drawOp !== 20) {
      const hit = textAt(p);
      if (hit >= 0) return grabText(hit, p, e.shiftKey);
    }
    if (ed.drawOp === TEXT) {
      const at = addOp(TEXT, [p[0], p[1], 8, 0, ...[...'TEXT'].map((c) => c.charCodeAt(0))], true);
      if (at >= 0) grabText(at, p, false);
      return;
    }
    if (!ed.drawOp) return;
    if (ed.drawOp === 20) {
      poly = poly || [];
      poly.push(p);
      if (poly.length === 8) finishPoly();
      else refresh();
      return;
    }
    draw = { op: ed.drawOp, start: p, index: -1 };
  });
  addEventListener('mousemove', (e) => {
    if (!draw) return;
    if (draw.move !== undefined || draw.rotate !== undefined) {
      const m = toTex(e);
      live(() => {
        if (draw.move !== undefined) {
          const args = tex().ops[draw.move].args;
          args[0] = Math.max(0, Math.min(255, m[0] + draw.off[0]));
          args[1] = Math.max(0, Math.min(255, m[1] + draw.off[1]));
        } else {
          const args = tex().ops[draw.rotate].args;
          const turn = (angleFrom(args, m) - draw.a0) / (2 * Math.PI);
          args[3] = (((Math.round(draw.angle + turn * 256)) % 256) + 256) % 256;
        }
      });
      return;
    }
    const args = shapeArgs(draw.op, draw.start, toTex(e));
    if (draw.index < 0) {
      draw.index = addOp(draw.op, args, true); // first move creates the op (its own undo step)
      if (draw.index < 0) draw = null;
      else { ed.begin(); session = true; }
    } else {
      live(() => { tex().ops[draw.index].args = args; });
    }
  });
  addEventListener('mouseup', () => {
    if (!draw) return;
    done();
    draw = null;
  });
  preview.addEventListener('dblclick', finishPoly);

  function finishPoly() {
    if (poly && poly.length >= 3) addOp(20, poly.flat(), true);
    else if (poly) ed.flash('A polygon needs at least 3 points', true);
    poly = null;
    refresh();
  }

  // ---- op list ----

  function buildList() {
    const list = $('opList');
    list.innerHTML = '';
    const t = tex();
    if (!t) return;
    t.ops.forEach((o, i) => {
      const spec = OPS[o.op];
      const head = el('div', { className: 'ophead' }, el('b', { textContent: `${i + 1}. ${spec ? spec.name : '?'}` }),
        btn('Up', i > 0, () => swap(i, i - 1)), btn('Down', i < t.ops.length - 1, () => swap(i, i + 1)),
        btn('Del', true, () => ed.edit(() => t.ops.splice(i, 1))));
      const li = el('li', {}, head);
      if (spec) for (const c of paramControls(o, spec)) li.append(c);
      list.append(li);
    });
  }
  const btn = (text, enabled, fn) => el('button', { textContent: text, disabled: !enabled, onclick: fn });
  const swap = (i, j) => ed.edit(() => { const ops = tex().ops; [ops[i], ops[j]] = [ops[j], ops[i]]; });

  // One row per param; edits write straight into o.args.
  function paramControls(o, spec) {
    const rows = [];
    const values = readParams(o.op, o.args);
    let offset = 0;
    for (const [name, kind, min, max, , labels] of spec.params) {
      const at = offset;
      const row = el('label', { className: 'param' }, name + ' ');
      if (kind === 'u8' && o.op === REF) {
        const sel = el('select');
        ed.owner().textures.forEach((_, k) => { if (k !== ed.texSel) sel.add(new Option(`Texture ${k + 1}`, k + 1)); });
        sel.value = values[name];
        sel.onchange = () => ed.edit(() => { o.args[at] = Number(sel.value); });
        row.append(sel);
      } else if (kind === 'u8' && labels) {
        const sel = el('select');
        labels.forEach((l, k) => sel.add(new Option(l, min + k)));
        sel.value = values[name];
        sel.onchange = () => ed.edit(() => { o.args[at] = Number(sel.value); });
        row.append(sel);
      } else if (kind === 'u8' || kind === 'pos') {
        row.append(...slider(values[name], kind === 'pos' ? 0 : min, kind === 'pos' ? 255 : max, (v) => { o.args[at] = v; }));
      } else if (kind === 'color') {
        row.append(colorInput(values[name], (c) => { o.args.splice(at, 3, ...c); }));
      } else if (kind === 'points') {
        const inp = el('input', { value: pairs(values[name]), size: 28 });
        inp.onchange = () => {
          const nums = inp.value.split(/[^0-9]+/).filter(Boolean).map((v) => Math.min(255, Number(v)));
          if (nums.length < 6 || nums.length > 16 || nums.length % 2) {
            ed.flash('Enter 3 to 8 points as x,y pairs', true);
            inp.value = pairs(values[name]);
            return;
          }
          ed.edit(() => { o.args.splice(at, o.args.length - at, ...nums); });
        };
        row.append(inp);
      } else if (kind === 'text') {
        const inp = el('input', { value: String.fromCharCode(...values[name]), maxLength: 32, size: 16 });
        inp.oninput = () => {
          const s = [...inp.value.toUpperCase()].filter((c) => FONT_CHARS.includes(c)).join('') || ' ';
          live(() => { o.args.splice(at, o.args.length - at, ...[...s].map((c) => c.charCodeAt(0))); });
        };
        inp.onchange = done;
        row.append(inp, el('div', { className: 'hint', textContent: 'Uppercase, digits and ' + FONT_CHARS.replace(/[A-Z0-9]/g, '') }));
      } else if (kind === 'bits') {
        row.append(pixelGrid(o, at));
      } else if (kind === 'stops') {
        row.append(stopsEditor(o, at));
      }
      rows.push(row);
      offset += kind === 'color' ? 3 : 1;
    }
    return rows;
  }

  const pairs = (a) => a.reduce((s, v, i) => s + (i % 2 ? ',' : i ? ' ' : '') + v, '');

  function slider(value, min, max, set) {
    const r = el('input', { type: 'range', min, max, value });
    const n = el('span', { className: 'val', textContent: value });
    r.oninput = () => { n.textContent = r.value; live(() => set(Number(r.value))); };
    r.onchange = done;
    return [r, n];
  }

  const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  function colorInput(c, set) {
    const inp = el('input', { type: 'color', value: hex(c) });
    inp.oninput = () => live(() => set([1, 3, 5].map((i) => parseInt(inp.value.slice(i, i + 2), 16))));
    inp.onchange = done;
    return inp;
  }

  // Colorize stops: (pos, r, g, b) each; 2..4 stops. A stop can't pass its neighbours, so order holds.
  function stopsEditor(o, at) {
    const box = el('div');
    const n = (o.args.length - at) / 4;
    for (let s = 0; s < n; s++) {
      const i = at + s * 4;
      const [r, v] = slider(o.args[i], 0, 255, (x) => {
        const lo = s > 0 ? o.args[i - 4] : 0, hi = s < n - 1 ? o.args[i + 4] : 255;
        o.args[i] = Math.max(lo, Math.min(hi, x));
      });
      box.append(el('div', {}, colorInput(o.args.slice(i + 1, i + 4), (c) => { o.args.splice(i + 1, 3, ...c); }), r, v,
        btn('×', n > 2, () => ed.edit(() => o.args.splice(i, 4)))));
    }
    box.append(btn('Add stop', n < 4, () => ed.edit(() => o.args.push(255, 255, 255, 255))));
    return box;
  }

  // Stamp: 16x16 or 32x32 1-bit paint grid. Drag paints with the value of the first pixel clicked, inverted.
  function pixelGrid(o, at) {
    const S = o.args.length - at === 32 ? 16 : 32;
    const cell = S === 16 ? 10 : 5;
    const c = el('canvas', { width: S * cell, height: S * cell, className: 'pixels' });
    const ctx = c.getContext('2d');
    const get = (x, y) => (o.args[at + ((y * S + x) >> 3)] >> (7 - (x & 7))) & 1;
    const paint = () => {
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        ctx.fillStyle = get(x, y) ? '#eee' : '#333';
        ctx.fillRect(x * cell, y * cell, cell - 1, cell - 1);
      }
    };
    let value = null;
    const at_ = (e) => {
      const r = c.getBoundingClientRect();
      return [Math.floor(((e.clientX - r.left) / r.width) * S), Math.floor(((e.clientY - r.top) / r.height) * S)];
    };
    const set = (e) => {
      const [x, y] = at_(e);
      if (x < 0 || y < 0 || x >= S || y >= S) return;
      const i = at + ((y * S + x) >> 3), bit = 1 << (7 - (x & 7));
      live(() => { o.args[i] = value ? o.args[i] | bit : o.args[i] & ~bit; });
      paint();
    };
    c.onmousedown = (e) => {
      const [x, y] = at_(e);
      value = get(x, y) ? 0 : 1;
      set(e);
      addEventListener('mouseup', () => { value = null; done(); }, { once: true });
    };
    c.onmousemove = (e) => { if (value !== null) set(e); };
    paint();
    const size = el('select');
    size.add(new Option('16×16', 16));
    size.add(new Option('32×32', 32));
    size.value = S;
    size.onchange = () => ed.edit(() => { o.args.splice(at, o.args.length - at, ...new Array(Number(size.value) === 16 ? 32 : 128).fill(0)); });
    return el('div', {}, size, el('br'), c);
  }

  // ---- slots + preview ----

  // Box panel: click a thumbnail to put that texture on the selected face(s). 0 = default texture.
  let pickerKey = null;
  function picker() {
    const b = ed.level.boxes[ed.sel];
    if (!b) return;
    const faces = ed.face < 0 ? b.faces : [b.faces[ed.face]];
    const current = faces.every((f) => f.tex === faces[0].tex) ? faces[0].tex : -1; // -1: mixed
    const key = current + JSON.stringify(ed.level.textures);
    if (key === pickerKey) return;
    pickerKey = key;
    const imgs = generateTextures(ed.level.textures);
    const box = $('texPicker');
    box.innerHTML = '';
    imgs.forEach((img, i) => {
      const c = el('canvas', { width: 32, height: 32, title: i ? `Texture ${i}` : 'Default', className: i === current ? 'slot on' : 'slot' });
      blit(c, img, 1);
      c.onclick = () => ed.edit(() => {
        const bb = ed.level.boxes[ed.sel];
        for (const f of ed.face < 0 ? bb.faces : [bb.faces[ed.face]]) f.tex = i;
        ed.tex = i;
      });
      box.append(c);
    });
  }

  let slotKey = null;
  function slots() {
    const key = ed.shared + ed.texSel + JSON.stringify(ed.owner().textures);
    if (key === slotKey) return;
    slotKey = key;
    const box = $('texSlots');
    const imgs = generateTextures(ed.owner().textures);
    box.innerHTML = '';
    ed.owner().textures.forEach((t, i) => {
      const c = el('canvas', { width: 40, height: 40, title: `Texture ${i + 1}`, className: i === ed.texSel ? 'slot on' : 'slot' });
      blit(c, imgs[i + 1], 1);
      c.onclick = () => { ed.texSel = i; if (!ed.shared) ed.tex = i + 1; refresh(); };
      box.append(el('span', { className: 'slotwrap' }, c, el('small', { textContent: i + 1 })));
    });
  }

  function blit(canvas, img, reps) {
    const src = el('canvas', { width: img.width, height: img.height });
    src.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    const w = canvas.width / reps;
    for (let y = 0; y < reps; y++) for (let x = 0; x < reps; x++) ctx.drawImage(src, x * w, y * w, w, w);
  }

  function drawPreview() {
    const t = tex();
    if (!t) return;
    blit(preview, generateTextures(ed.owner().textures)[ed.texSel + 1], $('texTiled').checked ? 2 : 1);
    if (poly) {
      const ctx = preview.getContext('2d');
      const k = preview.width / 255 / ($('texTiled').checked ? 2 : 1);
      ctx.strokeStyle = '#fd3';
      ctx.beginPath();
      poly.forEach(([x, y], i) => (i ? ctx.lineTo(x * k, y * k) : ctx.moveTo(x * k, y * k)));
      ctx.stroke();
      for (const [x, y] of poly) ctx.strokeRect(x * k - 2, y * k - 2, 4, 4);
    }
  }

  function refresh() {
    if (ed.texSel >= ed.owner().textures.length) ed.texSel = ed.owner().textures.length - 1;
    const t = tex();
    $('texEdit').hidden = !t;
    $('delTex').disabled = !t;
    picker();
    for (const b of document.querySelectorAll('[data-draw]')) b.classList.toggle('on', Number(b.dataset.draw) === ed.drawOp);
    $('polyDone').hidden = ed.drawOp !== 20;
    slots();
    if (!t) return;
    $('texSize').value = t.size;
    $('texAlpha').checked = !!t.transparent;
    const err = checkRecipe(t.ops, ed.owner().textures.length, ed.texSel) || checkTextures(ed.owner().textures);
    $('opErr').textContent = err || '';
    const total = ed.owner().textures.reduce((n, x) => n + x.ops.length, 0);
    $('opCount').textContent = `${t.ops.length} ops in this texture, ${total} in ${ed.shared ? 'the shared list' : 'the level'}`;
    drawPreview();
    // Rebuild the op list only when the recipe changed from outside it (undo, add, reorder),
    // never while one of its inputs is being used.
    const key = ed.texSel + JSON.stringify(t) + ed.owner().textures.length;
    if ((key !== built || ed.owner() !== builtLevel) && !$('opList').contains(document.activeElement) && !session) {
      built = key;
      builtLevel = ed.owner();
      buildList();
    }
  }

  return { refresh };
}
