// Entity editing: roles of the selected box (door, trigger, exit) and the selected positioned entity
// (player start, light, message, emitter). Inputs come from ENT_TYPES: one per param, by its kind.
import { ENT, ENT_TYPES, ON, LIMITS, isLink, fragmentOf, removeEntity } from '../format.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};

const DIRS = ['−x (west)', '+x (east)', '−y (down)', '+y (up)', '−z (north)', '+z (south)'];
const AX = ['x', 'y', 'z'];
const ONS = ['When entered', 'When used (E)', 'When shot'];
const RANGE = { u8: [0, 255], dist: [0, LIMITS.dist], turn: [-LIMITS.turn, LIMITS.turn] };
const ON_ITS_OWN = { [ENT.DOOR]: 'opens when the player is near', [ENT.ROTATOR]: 'opens when the player is near', [ENT.MESSAGE]: 'shows at level start', [ENT.EMITTER]: 'starts at level start' };

const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
const utf8Len = (s) => new TextEncoder().encode(s).length;

// Short name of entity i for lists: "Door (box 3)", "Message “Hello”", "Emitter 2".
export function describe(level, i) {
  const e = level.entities[i], name = ENT_TYPES[e.type].name;
  if ('box' in e) return `${name} (box ${e.box})`;
  if (e.type === ENT.MESSAGE) return `${name} “${e.text.length > 24 ? e.text.slice(0, 24) + '…' : e.text}”`;
  return `${name} ${level.entities.slice(0, i + 1).filter((x) => x.type === e.type).length}`;
}

export function createEntityPanel(ed) {
  // Inputs hold references into ed.level, so a replaced level (undo, open) always forces a rebuild.
  let rolesKey = null, entKey = null, rolesLevel = null, entLevel = null;

  for (const type of [ENT.DOOR, ENT.TRIGGER, ENT.EXIT]) {
    $('roleButtons').append(el('button', {
      textContent: 'Make ' + ENT_TYPES[type].name.toLowerCase(),
      onclick: () => {
        const b = ed.level.boxes[ed.sel];
        if (!b) return;
        if (ed.level.entities.length >= LIMITS.entities) return ed.flash('Too many entities', true);
        const center = [0, 1, 2].map((k) => Math.round((b.min[k] + b.max[k]) / 2));
        ed.edit(() => ed.level.entities.push({ type, pos: center, angle: 0, box: ed.sel, ...ENT_TYPES[type].defaults(b) }));
      },
    }));
  }
  $('delEnt').onclick = () => deleteEntity(ed.selEnt);

  function deleteEntity(i) {
    if (!ed.level.entities[i]) return;
    ed.edit(() => {
      removeEntity(ed.level, i);
      if (ed.selEnt === i) ed.selEnt = -1;
      else if (ed.selEnt > i) ed.selEnt--;
    });
  }
  ed.deleteEntity = deleteEntity;

  const select = (options, value, set) => {
    const s = el('select');
    options.forEach((label, i) => s.add(new Option(label, i)));
    s.value = value;
    s.onchange = () => ed.edit(() => set(Number(s.value)));
    return s;
  };
  const number = (get, set, min, max) => {
    const input = el('input', { type: 'number', min, max, value: get() });
    input.onchange = () => {
      const v = Math.round(Number(input.value));
      if (input.value === '' || !Number.isFinite(v)) return (input.value = get());
      ed.edit(() => set(Math.max(min, Math.min(max, v))));
    };
    return input;
  };

  // One input per param, every change one undoable edit.
  function fields(e) {
    const spec = ENT_TYPES[e.type];
    const rows = [];
    const row = (label, ...kids) => rows.push(el('label', {}, label + ' ', ...kids));
    if (spec.angle) row(spec.angle, number(() => e.angle, (v) => { e.angle = v; }, 0, 255));
    for (const [key, kind, label, min] of spec.params) {
      const set = (v) => { e[key] = v; };
      if (kind === 'box' || kind === 'link') continue; // the box is the selection; the link goes with 'level'
      if (kind === 'text' && e.type === ENT.TRIGGER && e.on !== ON.USE) continue; // only use triggers prompt
      if (RANGE[kind]) row(label, number(() => e[key], set, min ?? RANGE[kind][0], RANGE[kind][1]));
      else if (kind === 'rgb') {
        const input = el('input', { type: 'color', value: hex(e[key]) });
        input.onchange = () => ed.edit(() => { e[key] = [1, 3, 5].map((i) => parseInt(input.value.slice(i, i + 2), 16)); });
        row(label, input);
      } else if (kind === 'dir') row(label, select(DIRS, e[key], set));
      else if (kind === 'on') {
        const s = select(ONS, e[key], set), change = s.onchange;
        s.onchange = () => { change(); s.blur(); }; // let the panel rebuild (the prompt comes and goes)
        row(label, s);
      } else if (kind === 'once') {
        const c = el('input', { type: 'checkbox', checked: e[key] });
        c.onchange = () => ed.edit(() => { e[key] = c.checked; });
        rows.push(el('label', {}, c, ' ' + label));
      } else if (kind === 'axis') row(label, select(AX, e[key], set));
      else if (kind === 'edge') {
        const u = AX[(e.axis + 1) % 3], v = AX[(e.axis + 2) % 3];
        row(label, select([0, 1, 2, 3].map((k) => `${k & 1 ? '+' : '−'}${u} ${k & 2 ? '+' : '−'}${v}`), e[key], set));
      } else if (kind === 'kind') {
        const go = el('button', { textContent: 'Edit types…', onclick: () => { ed.setShared(false); ed.partSel = e[key]; ed.showScreen('particles'); } });
        row(label, select((ed.level.particles || []).map((_, i) => `Type ${i + 1}`), e[key], set), ' ', go);
      } else if (kind === 'model') {
        const go = el('button', { textContent: 'Edit models…', onclick: () => { ed.mdlSel = e[key]; ed.mdlPart = -1; ed.showScreen('models'); } });
        row(label, select((ed.pack.models || []).map((m, i) => `${i + 1}: ${m.name || 'Untitled'}`), e[key], set), ' ', go);
      } else if (kind === 'text') {
        const input = el('textarea', { value: e[key], rows: 3, cols: 30 });
        input.onchange = () => {
          let v = input.value;
          while (utf8Len(v) > LIMITS.text) v = v.slice(0, -1);
          ed.edit(() => { e[key] = v; });
        };
        row(label, input);
      } else if (kind === 'targets') rows.push(targets(e, label));
      else if (kind === 'level') rows.push(...exitTarget(e, label));
    }
    if (spec.activatable) rows.push(activatedBy(e));
    return rows;
  }

  // Trigger: a checkbox per entity it can activate.
  function targets(e, label) {
    const box = el('div', {}, label + ':');
    ed.level.entities.forEach((t, i) => {
      if (!ENT_TYPES[t.type].activatable) return;
      const c = el('input', { type: 'checkbox', checked: e.targets.includes(i) });
      c.onchange = () => ed.edit(() => { e.targets = c.checked ? [...e.targets, i].sort((a, b) => a - b) : e.targets.filter((x) => x !== i); });
      box.append(el('label', {}, c, ' ' + describe(ed.level, i)));
    });
    if (box.childNodes.length === 1) box.append(el('div', { className: 'help', textContent: 'Nothing to activate yet.' }));
    return box;
  }

  // Exit: the menu, a level of this pack, or another Linkworld link (only its #part is kept).
  function exitTarget(e, label) {
    const s = el('select');
    s.add(new Option('Back to the menu', 0));
    ed.pack.levels.forEach((lv, i) => s.add(new Option(`Level ${i + 1}: ${lv.name || 'Untitled'}`, i + 1)));
    s.add(new Option('Another Linkworld link…', -1));
    s.value = e.link ? -1 : e.level;
    s.onchange = () => {
      const v = Number(s.value);
      if (v >= 0) return ed.edit(() => { e.level = v; e.link = ''; });
      if (!askLink(e)) s.value = e.link ? -1 : e.level;
    };
    const out = [el('label', {}, label + ' ', s)];
    if (e.link) out.push(el('label', {}, 'Link ', el('button', { textContent: 'Change…', onclick: () => askLink(e) }), el('small', { textContent: ` ${e.link.length} chars` })));
    return out;
  }
  function askLink(e) {
    const text = prompt('Paste a Linkworld link (any level or pack from this game):', e.link);
    if (text === null) return false;
    const frag = fragmentOf(text);
    if (!isLink(frag)) {
      ed.flash('That is not a Linkworld link', true);
      return false;
    }
    ed.edit(() => { e.level = 0; e.link = frag; });
    return true;
  }

  // Doors, messages, emitters: which triggers activate them, or what they do on their own.
  function activatedBy(e) {
    const i = ed.level.entities.indexOf(e);
    const by = ed.level.entities.map((t, k) => [t, k]).filter(([t]) => t.targets && t.targets.includes(i)).map(([, k]) => describe(ed.level, k));
    const text = by.length ? 'Activated by: ' + by.join(', ') : `Not activated by anything: ${ON_ITS_OWN[e.type]}.`;
    return el('div', { className: 'help', textContent: text });
  }

  // Doors slide or rotate; switching keeps the box and the triggers that target it.
  function doorMode(e) {
    const s = el('select');
    s.add(new Option('Slide', ENT.DOOR));
    s.add(new Option('Rotate', ENT.ROTATOR));
    s.value = e.type;
    s.onchange = () => ed.edit(() => {
      const keep = { type: Number(s.value), pos: e.pos, angle: e.angle, box: e.box };
      for (const k of Object.keys(e)) delete e[k];
      Object.assign(e, keep, ENT_TYPES[keep.type].defaults(ed.level.boxes[keep.box]));
    });
    return el('label', {}, 'Moves ', s);
  }

  // Rebuild only when the data changed from elsewhere, never under the user's cursor.
  function refresh() {
    const box = ed.level.boxes[ed.sel];
    const roles = box ? ed.level.entities.map((e, i) => [e, i]).filter(([e]) => e.box === ed.sel) : [];
    const rk = ed.sel + JSON.stringify(roles) + JSON.stringify(ed.level.entities.map((e) => e.targets || e.text || e.type));
    if ((rk !== rolesKey || ed.level !== rolesLevel) && !$('roles').contains(document.activeElement)) {
      rolesKey = rk;
      rolesLevel = ed.level;
      $('roles').innerHTML = '';
      for (const [e, i] of roles) {
        const isDoor = e.type === ENT.DOOR || e.type === ENT.ROTATOR;
        $('roles').append(el('div', { className: 'role' }, el('b', { textContent: (isDoor ? 'Door' : ENT_TYPES[e.type].name) + ' ' }),
          el('button', { textContent: 'Remove', onclick: () => deleteEntity(i) }), ...(isDoor ? [doorMode(e)] : []), ...fields(e)));
      }
    }

    const e = ed.level.entities[ed.selEnt];
    $('entProps').hidden = !e;
    const ek = ed.selEnt + JSON.stringify(e || null) + (ed.level.particles || []).length + JSON.stringify((ed.pack.models || []).map((m) => m.name)) + JSON.stringify(ed.level.entities.map((x) => x.targets || 0));
    if (e && (ek !== entKey || ed.level !== entLevel) && !$('entFields').contains(document.activeElement)) {
      entKey = ek;
      entLevel = ed.level;
      $('entLegend').textContent = ENT_TYPES[e.type].name;
      $('entFields').innerHTML = '';
      const pos = el('div', { className: 'row' }, 'pos ');
      e.pos.forEach((v, k) => pos.append(number(() => e.pos[k], (n) => { e.pos[k] = n; }, -LIMITS.coord, LIMITS.coord)));
      $('entFields').append(pos, ...fields(e));
    }
  }

  return { refresh };
}
