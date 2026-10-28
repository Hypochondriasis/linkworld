// Particle types screen: type list, plain inputs per field, and a live side-view preview.
import { ENT, LIMITS, removeParticleType } from '../format.js';
import { generateTextures } from '../texgen.js';
import { createParticles } from '../particles.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};

export const DEFAULT_TYPE = { tex: 0, additive: false, burst: false, rate: 20, life: 20, speed: 16, spread: 30, size0: 4, size1: 8, gravity: 0 };

// [key, label, min, max]
const FIELDS = [
  ['rate', 'Rate (per second; burst: count)', 0, 255],
  ['life', 'Life (1/10 s)', 1, 255],
  ['speed', 'Speed (units/s)', 0, 255],
  ['spread', 'Spread (0 straight … 255 all directions)', 0, 255],
  ['gravity', 'Gravity (units/s², negative rises)', -LIMITS.gravity, LIMITS.gravity],
  ['size0', 'Size at birth (units)', 0, 255],
  ['size1', 'Size at death (units)', 0, 255],
];
const ZOOM = 3; // preview px per unit

export function createPartEditor(ed) {
  const preview = $('partPreview');
  let builtKey = null, builtLevel = null;
  let sim = null, simKey = null, last = 0;

  const types = () => ed.owner().particles || [];
  const type = () => types()[ed.partSel];

  $('addPart').onclick = () => {
    if (types().length >= LIMITS.particles) return ed.flash('Too many particle types', true);
    ed.edit(() => {
      const list = (ed.owner().particles ||= []);
      list.push({ ...DEFAULT_TYPE });
      ed.partSel = list.length - 1;
    });
  };
  $('delPart').onclick = () => {
    const n = ed.partSel;
    if (!type()) return;
    let ok = true;
    ed.edit(() => {
      ok = removeParticleType(ed.owner(), n);
      ed.partSel = Math.min(n, types().length - 1);
    });
    if (!ok) ed.flash(`Type ${n + 1} is used by ${ed.shared ? 'a model' : 'an emitter'}`, true);
  };

  function buildFields(t) {
    const box = $('partFields');
    box.innerHTML = '';
    const tex = el('select');
    tex.add(new Option('Default', 0));
    ed.owner().textures.forEach((_, i) => tex.add(new Option(`Texture ${i + 1}`, i + 1)));
    tex.value = t.tex;
    tex.onchange = () => ed.edit(() => { t.tex = Number(tex.value); });
    box.append(el('label', {}, 'Texture ', tex));
    for (const [key, label] of [['additive', 'Additive (glow: fire, sparks)'], ['burst', 'Burst (emit once per event)']]) {
      const c = el('input', { type: 'checkbox', checked: t[key] });
      c.onchange = () => ed.edit(() => { t[key] = c.checked; });
      box.append(el('label', {}, c, ' ' + label));
    }
    for (const [key, label, min, max] of FIELDS) {
      const input = el('input', { type: 'number', min, max, value: t[key] });
      input.onchange = () => {
        const v = Math.round(Number(input.value));
        if (input.value === '' || !Number.isFinite(v)) return (input.value = t[key]);
        ed.edit(() => { t[key] = Math.max(min, Math.min(max, v)); });
      };
      box.append(el('label', {}, label + ' ', input));
    }
  }

  function slots() {
    const box = $('partSlots');
    box.innerHTML = '';
    types().forEach((_, i) => box.append(el('button', { textContent: `Type ${i + 1}`, className: i === ed.partSel ? 'on' : '', onclick: () => { ed.partSel = i; refresh(); } })));
  }

  // Rebuild inputs only when the data changed from elsewhere, never under the user's cursor.
  function refresh() {
    if (ed.partSel >= types().length) ed.partSel = types().length - 1;
    if (ed.partSel < 0 && types().length) ed.partSel = 0;
    const t = type();
    $('partEdit').hidden = !t;
    $('delPart').disabled = !t;
    const key = ed.partSel + JSON.stringify(types()) + ed.owner().textures.length;
    if ((key !== builtKey || ed.owner() !== builtLevel) && !$('partFields').contains(document.activeElement)) {
      builtKey = key;
      builtLevel = ed.owner();
      slots();
      if (t) buildFields(t);
    }
  }

  // Preview: the selected type from an emitter pointing up, seen from the side. Restarts when the type changes.
  const texCanvas = new Map();
  function image(i) {
    const imgs = generateTextures(ed.owner().textures);
    const img = imgs[i] || imgs[0];
    if (!texCanvas.has(img)) {
      const c = el('canvas', { width: img.width, height: img.height });
      c.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
      texCanvas.set(img, c);
    }
    return texCanvas.get(img);
  }

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    const t = type();
    if (ed.screen !== 'particles' || !t) return;
    const key = JSON.stringify(t);
    if (key !== simKey) {
      simKey = key;
      const emitter = { type: ENT.EMITTER, pos: [0, 0, 0], angle: 0, pitch: 64, kind: 0 };
      sim = createParticles([t], [emitter]);
      sim.fire(emitter);
      sim.emitter = emitter;
      sim.burstTimer = 0;
    }
    // Bursts repeat every life + 0.5 s so the preview keeps showing something.
    if (t.burst && (sim.burstTimer -= dt) <= 0) {
      sim.burstTimer = t.life / 10 + 0.5;
      sim.fire(sim.emitter);
    }
    sim.update(dt);

    const ctx = preview.getContext('2d');
    const w = preview.width, h = preview.height, ox = w / 2, oy = h * 0.7;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fa4';
    ctx.fillRect(ox - 3, oy - 3, 6, 6);
    ctx.imageSmoothingEnabled = false;
    ctx.globalCompositeOperation = t.additive ? 'lighter' : 'source-over';
    const src = image(t.tex);
    for (const p of sim.list.slice().sort((a, b) => a.pos[2] - b.pos[2])) {
      const k = p.age / p.life, s = (t.size0 + (t.size1 - t.size0) * k) * ZOOM;
      ctx.globalAlpha = 1 - k;
      ctx.drawImage(src, ox + p.pos[0] * ZOOM - s / 2, oy - p.pos[1] * ZOOM - s / 2, s, s);
    }
  }
  requestAnimationFrame(frame);

  return { refresh };
}
