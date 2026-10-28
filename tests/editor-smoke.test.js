// Smoke test: loads the whole editor against a stub DOM and runs a few frames, so startup-order bugs
// (calling something before it is defined) fail here instead of in the browser. It checks nothing visual.
import assert from 'node:assert/strict';

// A universal stub: any property is another stub (remembered), calls and `new` return stubs,
// numbers come out as 0, iteration is empty, and values that are set read back.
function stub() {
  const values = new Map();
  const p = new Proxy(function () {}, {
    get(_, k) {
      if (k === 'then') return undefined; // not a promise
      if (k === Symbol.toPrimitive) return () => 0;
      if (k === Symbol.iterator) return function* () {};
      if (!values.has(k)) values.set(k, stub());
      return values.get(k);
    },
    set(_, k, v) { values.set(k, v); return true; },
    apply: () => stub(),
    construct: () => stub(),
  });
  return p;
}

const elements = new Map();
const listeners = [];
let frames = [];
globalThis.document = stub();
document.getElementById = (id) => { if (!elements.has(id)) elements.set(id, stub()); return elements.get(id); };
document.createElement = () => stub();
document.querySelectorAll = () => [];
globalThis.window = globalThis;
globalThis.location = new URL('http://localhost/editor.html');
globalThis.history = { replaceState() {} };
globalThis.addEventListener = (type, fn) => listeners.push([type, fn]);
globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
globalThis.devicePixelRatio = 1;
globalThis.Option = class { constructor(text, value) { this.text = text; this.value = value; } };
globalThis.ImageData = class { constructor(data, w, h) { Object.assign(this, { data, width: w, height: h }); } };
// Stored divider widths: the case that crashed on startup.
const store = { 'linkworld.split': '400', 'linkworld.split2': '300' };
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } };

await import('../src/editor/editor.js');
for (let round = 0; round < 3; round++) {
  const run = frames;
  frames = [];
  for (const fn of run) fn(performance.now());
}
assert.ok(listeners.some(([t]) => t === 'keydown'), 'editor installed its keyboard handler');
// Levels of a pack: add one, switch between them, delete it again (each also redraws the panels).
globalThis.confirm = () => true;
const $ = (id) => document.getElementById(id);
$('addLevel').onclick();
$('levelSel').value = '0';
$('levelSel').onchange();
$('delLevel').onclick();
$('undo').onclick();
$('redo').onclick();
// Models screen and the shared texture / particle lists.
$('tabModels').onclick();
$('addMdl').onclick();
$('mdlEmit').checked = true;
$('mdlEmit').onchange();
$('mkFace').onclick();
$('extrude').onclick();
$('merge').onclick();
$('resetUV').onclick();
$('sidePane').value = 'uv';
$('sidePane').onchange();
$('tabWiki').onclick();
$('texOwner').value = '1';
$('texOwner').onchange();
$('addTex').onclick();
$('tabTextures').onclick();
$('undo').onclick();
for (let round = 0; round < 2; round++) {
  const run = frames;
  frames = [];
  for (const fn of run) fn(performance.now());
}
console.log('editor smoke: ok');
process.exit(0); // the editor's timers would keep node alive
