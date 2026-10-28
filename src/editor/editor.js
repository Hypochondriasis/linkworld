// Editor: state, undo/redo, properties panel, autosave, link size, play test, copy link.
import { encodeLink, decodeLink, encodeBytes, decodeBytes, parseFragment, fragmentOf, removeBox, removeLevel, ENT, LIMITS } from '../format.js';
import { createGrid } from './grid.js';
import { createView3d } from './view3d.js';
import { createTexEditor } from './texedit.js';
import { createEntityPanel } from './entities.js';
import { createPartEditor } from './partedit.js';
import { createModelEditor } from './modeledit.js';
import { fitShape, saveShape, restoreShape } from '../shape.js';

const $ = (id) => document.getElementById(id);
const DRAFT_KEY = 'linkworld.draft';
const WARN_KEY = 'linkworld.warnKB';
const GAME_URL = new URL('index.html', location.href).href;

const faces = (tex) => Array.from({ length: 6 }, () => ({ tex, scale: 16, ox: 0, oy: 0 }));

function newLevel() {
  return {
    name: 'Untitled',
    ambient: [150, 150, 150],
    fog: [100, 120, 150],
    fogDist: 0,
    textures: [],
    boxes: [{ min: [-64, -8, -64], max: [64, 0, 64], solid: true, faces: faces(0) }],
    entities: [{ type: ENT.PLAYER_START, pos: [0, 0, 0], angle: 0 }],
  };
}

const newPack = () => ({ levels: [newLevel()] });

const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
};

// A draft is only trusted after it survives the same encode/decode the game uses.
function loadDraft() {
  try {
    const s = storage.get(DRAFT_KEY);
    const d = s && JSON.parse(s);
    return d ? decodeBytes(encodeBytes(d)) : null;
  } catch {
    return null;
  }
}

const ed = {
  pack: loadDraft() || newPack(),
  li: 0, // level of the pack being edited; ed.level is that level
  sel: -1,
  selEnt: -1, // selected entity with its own position (start, light, message)
  tool: 'select',
  layerY: 0,
  layerH: 32,
  snap: 8,
  tex: 0, // texture for new boxes
  face: -1, // face being edited in the panel, -1 = all
  texSel: -1, // texture slot open in the texture editor (0-based)
  partSel: -1, // particle type open on the particles screen (0-based)
  shared: false, // texture and particle screens edit the pack's shared lists (for models) instead of the level's
  mdlSel: -1, // model open on the models screen (0-based)
  mdlPart: -1, // its selected part
  mdlVerts: [], // selected vertices of that part
  uvSel: [], // selected uv corners of that part (in face order)
  drawOp: 0, // shape op being drawn on the texture preview
  sideAxis: 0, // side view's horizontal axis: 0 = x (front), 2 = z
  faceMode: false, // 3D view: clicks pick single faces (Tab)
  selVert: [], // vertex tool: selected corner indices of the selected box (corners at one spot move together)
  dirty3d: true,
  looking: false,
  cam: null,
};

Object.defineProperty(ed, 'level', { get: () => ed.pack.levels[ed.li] });
// What the texture and particle screens edit. The pack's lists are omitted when empty, so they start here.
ed.owner = () => (ed.shared ? ((ed.pack.textures ||= []), ed.pack) : ed.level);

// Defined first: startup code (restoring splitter widths, tools) asks for redraws before the grids exist.
let gridRedraw = 0, gridTop = null, gridSide = null;
ed.redrawGrid = () => {
  if (gridRedraw) return;
  gridRedraw = requestAnimationFrame(() => {
    gridRedraw = 0;
    if (gridTop) { gridTop.draw(); gridSide.draw(); }
  });
};

// ---- undo / redo: whole-pack JSON snapshots ----

const undoStack = [];
const redoStack = [];
const UNDO_CHARS = 64e6; // a max-size level is ~1 MB of JSON; keep the history around 128 MB of strings
let undoChars = 0;
const snapshot = () => JSON.stringify({ pack: ed.pack, li: ed.li, sel: ed.sel, selEnt: ed.selEnt, texSel: ed.texSel, partSel: ed.partSel, mdlSel: ed.mdlSel, mdlPart: ed.mdlPart });
let dragBefore = null;

function push(before) {
  if (before === snapshot()) return;
  undoStack.push(before);
  undoChars += before.length;
  while (undoStack.length > 300 || (undoChars > UNDO_CHARS && undoStack.length > 1)) undoChars -= undoStack.shift().length;
  redoStack.length = 0;
}

ed.edit = (fn) => {
  const before = snapshot();
  fn();
  push(before);
  ed.changed();
};
ed.begin = () => { dragBefore = snapshot(); };
ed.commit = () => {
  if (dragBefore) push(dragBefore);
  dragBefore = null;
  ed.changed();
};
ed.dragging = () => dragBefore !== null;

function restore(s) {
  const o = JSON.parse(s);
  ed.pack = o.pack;
  ed.li = Math.min(o.li, ed.pack.levels.length - 1);
  ed.sel = o.sel < ed.level.boxes.length ? o.sel : -1;
  if (ed.sel < 0) ed.selVert = [];
  ed.texSel = Math.min(o.texSel, ed.owner().textures.length - 1);
  ed.partSel = Math.min(o.partSel ?? -1, (ed.owner().particles || []).length - 1);
  ed.mdlSel = Math.min(o.mdlSel ?? -1, (ed.pack.models || []).length - 1);
  ed.mdlPart = ed.mdlSel < 0 ? -1 : Math.min(o.mdlPart ?? -1, ed.pack.models[ed.mdlSel].parts.length - 1);
  ed.mdlVerts = ed.uvSel = [];
  ed.selEnt = o.selEnt < ed.level.entities.length ? o.selEnt : -1;
  ed.changed();
}
function undo() { if (undoStack.length) { redoStack.push(snapshot()); undoChars -= undoStack[undoStack.length - 1].length; restore(undoStack.pop()); } }
function redo() { if (redoStack.length) { undoStack.push(snapshot()); undoChars += undoStack[undoStack.length - 1].length; restore(redoStack.pop()); } }

ed.newBox = (min, max) => ({ min, max, solid: true, faces: faces(ed.tex) });
ed.select = (i) => {
  if (ed.sel === i && ed.selEnt < 0) return;
  ed.sel = i;
  ed.selEnt = -1;
  ed.selVert = [];
  if (i < 0) setFaceMode(false);
  refreshPanel();
  ed.redrawGrid();
};
ed.selectVertex = (idx) => {
  ed.selVert = idx;
  ed.redrawGrid();
};
ed.selectEnt = (i) => {
  ed.sel = -1;
  ed.selVert = [];
  setFaceMode(false);
  ed.selEnt = i;
  refreshPanel();
  ed.redrawGrid();
};

// ---- change propagation ----

let saveTimer = 0;
ed.changed = () => {
  ed.dirty3d = true;
  ed.redrawGrid();
  refreshPanel();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveAndMeasure, 200);
};

function save() {
  if (!storage.set(DRAFT_KEY, JSON.stringify(ed.pack))) flash('Autosave unavailable (storage blocked)', true);
}

// Encodes through the real codec and decodes again, so the counter also catches invalid levels.
let measureId = 0;
async function saveAndMeasure() {
  save();
  const id = ++measureId;
  const el = $('size');
  try {
    const url = await linkFor(ed.pack);
    if (id !== measureId) return;
    const warn = Number(storage.get(WARN_KEY)) || 8;
    el.textContent = `Link: ${url.length} bytes (${(url.length / 1024).toFixed(1)} KB)` + (url.length > warn * 1024 ? ` — over ${warn} KB` : '');
    el.className = url.length > warn * 1024 ? 'warn' : '';
  } catch (e) {
    if (id !== measureId) return;
    el.textContent = 'Invalid level: ' + e.message;
    el.className = 'warn';
  }
}

// li: start at that level of the pack.
async function linkFor(pack, li = 0) {
  const frag = await encodeLink(pack);
  await decodeLink(frag);
  return GAME_URL + '#' + frag + (li ? '~' + li : '');
}

let msgTimer = 0;
ed.flash = flash;
function flash(text, bad) {
  const m = $('msg');
  m.textContent = text;
  m.style.color = bad ? '#f66' : '#8c8';
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => { m.textContent = ''; }, 3000);
}

// ---- panel ----

let texEditor = null, entityPanel = null, partEditor = null, modelEditor = null;
const bindings = [];
// get() returns the value to show ('' when not applicable); set(v) mutates the level inside an undoable edit.
function bind(id, get, set, parse = Number) {
  const el = $(id);
  const prop = el.type === 'checkbox' ? 'checked' : 'value';
  el.addEventListener('change', () => {
    const v = parse(el[prop]);
    if (typeof v === 'number' && !Number.isFinite(v)) return refreshPanel();
    ed.edit(() => set(v));
  });
  bindings.push(() => {
    if (document.activeElement !== el) el[prop] = get();
  });
}

const int = (lo, hi) => (s) => {
  const v = Math.round(Number(s));
  return s === '' || !Number.isFinite(v) ? NaN : Math.max(lo, Math.min(hi, v));
};
const coord = int(-LIMITS.coord, LIMITS.coord);
const box = () => ed.level.boxes[ed.sel];
const start = () => ed.level.entities.find((e) => e.type === ENT.PLAYER_START);
const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
const rgb = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));

['X', 'Y', 'Z'].forEach((axis, k) => {
  bind('min' + axis, () => (box() ? box().min[k] : ''), (v) => resized(() => { box().min[k] = Math.min(v, box().max[k] - 1); }), coord);
  bind('max' + axis, () => (box() ? box().max[k] : ''), (v) => resized(() => { box().max[k] = Math.max(v, box().min[k] + 1); }), coord);
});
// Resizing keeps a shaped box's corners inside it; a size that would flatten the shape is refused.
function resized(fn) {
  const b = box(), prev = saveShape(b);
  fn();
  if (fitShape(b)) return;
  restoreShape(b, prev);
  flash('That size would flatten the shape', true);
}
$('resetShape').onclick = () => ed.edit(() => { delete box().shape; });

bind('solid', () => !!(box() && box().solid), (v) => { box().solid = v; }, Boolean);

const editedFaces = () => (ed.face < 0 ? box().faces : [box().faces[ed.face]]);
const faceField = (id, key, parse) => bind(id, () => (box() ? box().faces[Math.max(0, ed.face)][key] : ''), (v) => {
  for (const f of editedFaces()) f[key] = v;
}, parse);
faceField('scale', 'scale', int(0, 255));
faceField('ox', 'ox', int(0, 255));
faceField('oy', 'oy', int(0, 255));
ed.setFace = (f) => {
  ed.face = f;
  refreshPanel();
};
$('face').onchange = () => ed.setFace(Number($('face').value));

// Face mode: clicking in the 3D view picks one face of a box; leaving it goes back to "All faces".
function setFaceMode(on) {
  if (ed.faceMode === on) return;
  ed.faceMode = on;
  if (!on) ed.face = -1;
  $('viewMode').textContent = on ? 'Face mode: click a face of the selected box, pick its texture in the panel (Tab to leave)' : '';
  refreshPanel();
}

bind('name', () => ed.level.name, (v) => { ed.level.name = v; }, (s) => {
  // Trim to the format's byte limit without splitting a UTF-8 character.
  while (new TextEncoder().encode(s).length > LIMITS.name) s = s.slice(0, -1);
  return s;
});
bind('ambient', () => hex(ed.level.ambient), (v) => { ed.level.ambient = v; }, rgb);
bind('fog', () => hex(ed.level.fog), (v) => { ed.level.fog = v; }, rgb);
bind('fogDist', () => ed.level.fogDist, (v) => { ed.level.fogDist = v; }, int(0, LIMITS.dist));
bind('startAngle', () => (start() ? start().angle : ''), (v) => { if (start()) start().angle = v; }, int(0, 255));

$('warnKB').value = Number(storage.get(WARN_KEY)) || 8;
$('warnKB').onchange = () => { storage.set(WARN_KEY, String(Math.max(1, Number($('warnKB').value) || 8))); saveAndMeasure(); };

// The panel shows only what is selected.
function refreshPanel() {
  const ent = ed.level.entities[ed.selEnt];
  $('boxProps').hidden = !box();
  $('nothing').hidden = !!(box() || ent);
  $('face').value = ed.face;
  $('shapeRow').hidden = !(box() && box().shape);
  $('undo').disabled = !undoStack.length;
  levelList();
  $('redo').disabled = !redoStack.length;
  for (const b of bindings) b();
  if (texEditor) texEditor.refresh();
  if (entityPanel) entityPanel.refresh();
  if (partEditor) partEditor.refresh();
  if (modelEditor) modelEditor.refresh();
}

// ---- screens, options, splitter ----

ed.screen = 'level';
ed.showScreen = (name) => {
  ed.screen = name;
  $('main').hidden = name !== 'level';
  $('levelTools').hidden = name !== 'level';
  $('texScreen').hidden = name !== 'textures';
  $('partScreen').hidden = name !== 'particles';
  $('mdlScreen').hidden = name !== 'models';
  $('wikiScreen').hidden = name !== 'wiki';
  $('tabWiki').classList.toggle('on', name === 'wiki');
  $('tabParticles').classList.toggle('on', name === 'particles');
  $('tabModels').classList.toggle('on', name === 'models');
  $('tabLevel').classList.toggle('on', name === 'level');
  $('tabTextures').classList.toggle('on', name === 'textures');
  if (name === 'textures' && ed.texSel < 0 && ed.owner().textures.length) ed.texSel = 0;
  ed.dirty3d = true;
  refreshPanel();
  ed.redrawGrid();
};
$('tabLevel').onclick = () => ed.showScreen('level');
$('tabTextures').onclick = () => ed.showScreen('textures');
$('tabParticles').onclick = () => ed.showScreen('particles');
$('tabModels').onclick = () => ed.showScreen('models');
$('tabWiki').onclick = () => ed.showScreen('wiki');
// Wiki: one topic at a time.
const showTopic = (t) => {
  for (const b of document.querySelectorAll('#wikiNav [data-topic]')) b.classList.toggle('on', b.dataset.topic === t);
  for (const s of document.querySelectorAll('#wiki [data-topic]')) s.hidden = s.dataset.topic !== t;
};
for (const b of document.querySelectorAll('#wikiNav [data-topic]')) b.onclick = () => showTopic(b.dataset.topic);
showTopic('start');
// Textures and particle types of this level, or the pack's shared ones (for models). shared: true / false.
ed.setShared = (shared) => {
  ed.shared = shared;
  ed.texSel = Math.min(Math.max(ed.texSel, 0), ed.owner().textures.length - 1);
  ed.partSel = Math.min(Math.max(ed.partSel, 0), (ed.owner().particles || []).length - 1);
  $('texOwner').value = $('partOwner').value = shared ? '1' : '';
  refreshPanel();
};
$('texOwner').onchange = () => ed.setShared(!!$('texOwner').value);
$('partOwner').onchange = () => ed.setShared(!!$('partOwner').value);
// Opens the texture screen on the texture of the selected face (or the first face).
$('editTextures').onclick = () => {
  ed.setShared(false);
  const t = box() && box().faces[Math.max(0, ed.face)].tex;
  if (t) ed.texSel = t - 1;
  ed.showScreen('textures');
};

const options = (show) => { $('options').hidden = !show; };
$('openOptions').onclick = () => options(true);
$('closeOptions').onclick = () => options(false);
$('options').onclick = (e) => { if (e.target === $('options')) options(false); };

// Splitters: 2D views | 3D view | panel. Widths remembered per browser; the 3D view keeps at least 150 px.
function splitter(handle, target, key, widthAt) {
  const set = (px) => {
    const others = $('main').clientWidth - target.offsetWidth - $('viewWrap').offsetWidth;
    target.style.width = Math.max(150, Math.min($('main').clientWidth - others - 150, px)) + 'px';
    ed.redrawGrid();
  };
  if (storage.get(key)) set(Number(storage.get(key)));
  handle.onmousedown = (e) => {
    e.preventDefault();
    const r = $('main').getBoundingClientRect();
    const move = (ev) => set(widthAt(ev.clientX, r));
    const up = () => {
      removeEventListener('mousemove', move);
      removeEventListener('mouseup', up);
      storage.set(key, String(target.offsetWidth));
    };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  };
}
splitter($('split'), $('views2d'), 'linkworld.split', (x, r) => x - r.left);
splitter($('split2'), $('panel'), 'linkworld.split2', (x, r) => r.right - x);

$('sideAxis').onchange = () => { ed.sideAxis = Number($('sideAxis').value); ed.redrawGrid(); };

$('dup').onclick = duplicate;
$('del').onclick = remove;

function duplicate() {
  if (!box()) return;
  ed.edit(() => {
    const b = JSON.parse(JSON.stringify(box()));
    for (const k of [0, 2]) { b.min[k] += ed.snap; b.max[k] += ed.snap; }
    ed.level.boxes.push(b);
    ed.sel = ed.level.boxes.length - 1;
  });
}
function remove() {
  if (ed.selEnt >= 0) return ed.deleteEntity(ed.selEnt);
  if (!box()) return;
  ed.edit(() => { removeBox(ed.level, ed.sel); ed.sel = -1; });
}

// ---- toolbar ----

function setTool(t) {
  ed.tool = t;
  ed.redrawGrid();
  for (const b of document.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === t);
}
for (const b of document.querySelectorAll('[data-tool]')) b.onclick = () => setTool(b.dataset.tool);
setTool('select');

const layerInputs = () => { $('layerY').value = ed.layerY; $('layerH').value = ed.layerH; ed.redrawGrid(); };
$('layerY').onchange = () => { ed.layerY = coord($('layerY').value) || 0; layerInputs(); };
$('layerH').onchange = () => { ed.layerH = int(1, 4096)($('layerH').value) || 32; layerInputs(); };
$('layerDown').onclick = () => { ed.layerY -= ed.layerH; layerInputs(); };
$('layerUp').onclick = () => { ed.layerY += ed.layerH; layerInputs(); };
$('snap').onchange = () => { ed.snap = Number($('snap').value); };

$('undo').onclick = undo;
$('redo').onclick = redo;
$('new').onclick = () => ed.edit(() => { ed.pack = newPack(); ed.li = 0; ed.sel = ed.selEnt = -1; });

// ---- levels of the pack ----

let levelKey = null;
function levelList() {
  const key = ed.li + JSON.stringify(ed.pack.levels.map((l) => l.name));
  if (key === levelKey) return;
  levelKey = key;
  const s = $('levelSel');
  s.innerHTML = '';
  ed.pack.levels.forEach((l, i) => s.add(new Option(`${i + 1}: ${l.name || 'Untitled'}`, i)));
  s.value = ed.li;
  $('delLevel').disabled = ed.pack.levels.length < 2;
}
function showLevel(i) {
  ed.li = i;
  ed.sel = ed.selEnt = -1;
  ed.selVert = [];
  const s = start();
  if (s && ed.cam) ed.cam.pos = [s.pos[0], s.pos[1] + 40, s.pos[2] + 80];
  ed.changed();
}
$('levelSel').onchange = () => showLevel(Number($('levelSel').value));
$('addLevel').onclick = () => {
  if (ed.pack.levels.length >= LIMITS.levels) return flash('Too many levels', true);
  ed.edit(() => { ed.pack.levels.push(newLevel()); showLevel(ed.pack.levels.length - 1); });
};
$('delLevel').onclick = () => {
  if (ed.pack.levels.length < 2 || !confirm(`Delete level ${ed.li + 1} (${ed.level.name})? Exits to it will go to the menu.`)) return;
  ed.edit(() => { removeLevel(ed.pack, ed.li); showLevel(Math.min(ed.li, ed.pack.levels.length - 1)); });
};

$('open').onclick = async () => {
  const text = prompt('Paste a Linkworld link to edit:');
  if (text) await openLink(text);
};

// Opening a link is an undoable edit, so the previous draft is one Undo away.
async function openLink(text) {
  try {
    const frag = fragmentOf(text);
    const pack = await decodeLink(frag);
    ed.edit(() => { ed.pack = pack; showLevel(Math.min(parseFragment(frag).level, pack.levels.length - 1)); });
    flash('Level opened (Undo to get your previous draft back)');
  } catch (e) {
    flash('Could not open link: ' + e.message, true);
  }
}

// Play test goes through the real encoder and the game's own decoder; never editor state.
$('play').onclick = async () => {
  const w = window.open('', 'linkworld-play'); // opened synchronously so popup blockers allow it
  try {
    const url = await linkFor(ed.pack, ed.li);
    save();
    if (w) {
      w.location.href = url;
      w.focus();
    } else {
      location.href = url;
    }
  } catch (e) {
    if (w) w.close();
    flash('Cannot play: ' + e.message, true);
  }
};

$('copy').onclick = async () => {
  try {
    const url = await linkFor(ed.pack);
    flash((await copyText(url)) ? 'Link copied' : 'Copy the link from the dialog');
  } catch (e) {
    flash('Cannot copy: ' + e.message, true);
  }
};

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  ta.remove();
  if (!ok) prompt('Copy this link:', text);
  return ok;
}

addEventListener('keydown', (e) => {
  if (ed.looking || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (e.key === 'Escape' && !$('options').hidden) return options(false);
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && k === 'y') { e.preventDefault(); redo(); }
  else if (!$('options').hidden) return;
  else if (ed.screen === 'models') modelEditor.key(e);
  else if (ed.screen !== 'level') return; // the rest are level-screen shortcuts
  else if (e.key === 'Tab') {
    e.preventDefault();
    if (box()) setFaceMode(!ed.faceMode);
    else flash('Select a box first, then Tab picks its faces', true);
  }
  else if (mod && k === 'd') { e.preventDefault(); duplicate(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(); }
  else if (e.key === 'Escape') ed.select(-1);
  else if (!mod && k === 'l') setTool('light');
  else if (!mod && k === 'm') setTool('message');
  else if (!mod && k === 'f') setTool('emitter');
  else if (!mod && k === 'v') setTool('select');
  else if (!mod && k === 'b') setTool('box');
  else if (!mod && k === 'e') setTool('vertex');
  else if (!mod && k === 'p') setTool('start');
  else if (!mod && k === 'o') setTool('prop');
});

// ---- start ----

gridTop = createGrid($('gridTop'), ed);
gridSide = createGrid($('gridSide'), ed, true);
texEditor = createTexEditor(ed);
entityPanel = createEntityPanel(ed);
partEditor = createPartEditor(ed);
modelEditor = createModelEditor(ed);
const view = createView3d($('view'), ed);
if (view) {
  ed.cam = view.cam;
  const s = start();
  if (s) view.cam.pos = [s.pos[0], s.pos[1] + 40, s.pos[2] + 80];
}
addEventListener('resize', ed.redrawGrid);
layerInputs();
ed.showScreen('level');
ed.changed();

// editor.html#<link> opens that level for remixing; drop the fragment so a reload doesn't re-import.
if (location.hash.length > 1) {
  const frag = location.hash.slice(1);
  history.replaceState(null, '', location.pathname + location.search);
  openLink(frag);
}
