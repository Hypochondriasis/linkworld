// Level data model and binary format. See FORMAT.md for the byte layout. Not released yet: only the current
// version decodes; once links are out, old versions must keep decoding.
//
// A link holds a pack: { levels: [level, ...], textures?, particles?, models? }, 1 to 64 levels. Exits go to
// another level of the pack, to another Linkworld link, or back to the menu. The pack's own textures and
// particle types (like a level's, omitted when empty) are shared by its models (see model.js); prop entities
// place models in levels.
// Level (plain JSON-able object):
// {
//   name: string, ambient: [r,g,b], fog: [r,g,b], fogDist: units (0 = no fog),
//   textures: [{ size: 64|128, transparent?: true, ops: [{ op: u8, args: [u8...] }] }],
//   boxes: [{ min: [x,y,z], max: [x,y,z], solid: bool, shape?: 8 x [dx,dy,dz],
//             faces: 6 x { tex, scale, ox, oy } }],   // face order -x +x -y +y -z +z; tex 0 = default, i = textures[i-1]
//   particles?: [{ tex, additive, burst, rate, life, speed, spread, gravity, size0, size1 }], // omitted when empty
//   entities: [{ type, pos: [x,y,z], angle: u8, ...params of ENT_TYPES[type] }],
// }
// Units: 1 unit = 1/8 block, y is up.
import { ByteWriter, ByteReader, DecodeError } from './bytes.js';
import { pack, unpack } from './codec.js';
import { checkTextures } from './texgen.js';
import { hullOf, offsetRange } from './shape.js';

export const MAGIC = 0x4c; // 'L'
export const VERSION = 8;

export const LIMITS = {
  levels: 64,
  name: 64, // bytes
  textures: 64,
  particles: 64,
  gravity: 1000, // |units/s²| of a particle type
  ops: 64,
  opArgs: 255,
  boxes: 4096,
  entities: 1024,
  text: 1024, // bytes
  link: 32768, // bytes; an exit to another link embeds that whole link
  coord: 32768, // |coordinate| in units
  dist: 65535,
  turn: 360, // |degrees| of a rotating door
  models: 64,
  modelName: 32, // bytes
  parts: 32, // per model
  verts: 255, // per part
  faces: 255, // per part
  modelCoord: 255, // |model units|
  uv: 4096, // |uv| in 1/64 of a texture repeat
  propTris: 32768, // per level, all props together (mirrored copies count)
};

export const ENT = { PLAYER_START: 0, LIGHT: 1, DOOR: 2, TRIGGER: 3, EXIT: 4, MESSAGE: 5, EMITTER: 6, ROTATOR: 7, PROP: 8 };
// What fires a trigger: the player walking in (its box is then invisible and non-solid), using it (E) or shooting it.
export const ON = { ENTER: 0, USE: 1, SHOOT: 2 };

// Every entity type in one place. params: [key, kind, label, min?] in byte order; the kind says how the
// format stores it and which input the editor shows. angle: label when the editor shows the entity's angle.
// tag: how the 2D views label the box a box entity uses (tagOf). activatable: a trigger can target it (untargeted,
// doors open when the player is near, messages show and emitters start at level start).
// defaults(box): params of a new one.
export const ENT_TYPES = {
  [ENT.PLAYER_START]: { name: 'Player start', angle: 'Angle (0–255)', params: [] },
  [ENT.LIGHT]: {
    name: 'Light',
    params: [['color', 'rgb', 'Color'], ['radius', 'dist', 'Radius (units)', 1]],
    defaults: () => ({ color: [255, 235, 200], radius: 120 }),
  },
  [ENT.DOOR]: {
    name: 'Door', tag: ['DOOR', '#f93'], activatable: true,
    params: [['box', 'box'], ['dir', 'dir', 'Opens towards'], ['dist', 'dist', 'Distance (units)'], ['speed', 'u8', 'Speed (units/s)', 1]],
    defaults: (b) => ({ dir: 3, dist: Math.max(1, b.max[1] - b.min[1] - 2), speed: 32 }),
  },
  [ENT.ROTATOR]: {
    name: 'Rotating door', tag: ['DOOR', '#f93'], activatable: true,
    params: [['box', 'box'], ['axis', 'axis', 'Axis'], ['edge', 'edge', 'Hinge edge'], ['turn', 'turn', 'Turn (degrees, + = counter-clockwise)'],
      ['speed', 'u8', 'Speed (degrees/s)', 1]],
    defaults: () => ({ axis: 1, edge: 0, turn: 90, speed: 90 }),
  },
  // Use and shoot triggers keep their box visible and solid: any geometry can be a button or a target.
  // text: the prompt of a use trigger.
  [ENT.TRIGGER]: {
    name: 'Trigger',
    params: [['box', 'box'], ['on', 'on', 'Fires'], ['once', 'once', 'Only the first time'], ['text', 'text', 'Prompt when looked at (optional)'],
      ['targets', 'targets', 'Activates']],
    defaults: () => ({ on: ON.ENTER, once: false, text: '', targets: [] }),
  },
  [ENT.EXIT]: {
    name: 'Exit', tag: ['EXIT', '#4cf'],
    params: [['box', 'box'], ['level', 'level', 'Goes to'], ['link', 'link']], // level 0 = menu, i = levels[i-1]; link wins
    defaults: () => ({ level: 0, link: '' }),
  },
  [ENT.MESSAGE]: { name: 'Message', activatable: true, params: [['text', 'text', 'Text']], defaults: () => ({ text: 'HELLO' }) },
  [ENT.EMITTER]: {
    name: 'Emitter', angle: 'Yaw (0–255, 64 = −x)', activatable: true,
    params: [['kind', 'kind', 'Particle type'], ['pitch', 'u8', 'Pitch (0 level, 64 up, 192 down)']],
    defaults: () => ({ kind: 0, pitch: 64 }),
  },
  // A model of the pack, drawn where it stands, turned by its angle. Never solid; its emitter is always on.
  [ENT.PROP]: { name: 'Prop', angle: 'Angle (0–255)', params: [['model', 'model', 'Model']], defaults: () => ({ model: 0 }) },
};

// The 2D views' label of a box entity: triggers by what fires them.
const ON_TAGS = [['TRIGGER', '#6d6'], ['USE', '#fd4'], ['SHOOT', '#f66']];
export const tagOf = (e) => (e.type === ENT.TRIGGER ? ON_TAGS[e.on] : ENT_TYPES[e.type].tag);

const PARTICLE_U8 = ['rate', 'life', 'speed', 'spread', 'size0', 'size1'];

// A Linkworld link without the page: '<payload>' or '<payload>~<level>' (0-based level of the pack).
const LINK_RE = /^[A-Za-z0-9_-]+(~\d{1,2})?$/;
export const isLink = (s) => s.length <= LIMITS.link && LINK_RE.test(s);

// Splits a fragment ('#' optional) into the payload and the level to start at.
export function parseFragment(frag) {
  const m = /^#?([A-Za-z0-9_-]*)(?:~(\d{1,2}))?$/.exec(frag.trim());
  if (!m) throw new DecodeError('link contains invalid characters');
  return { payload: m[1], level: m[2] ? Number(m[2]) : 0 };
}
// Accepts a whole URL, a fragment, or a bare payload (what people paste).
export const fragmentOf = (text) => (text.includes('#') ? text.slice(text.indexOf('#') + 1) : text).trim();

export async function encodeLink(pk) {
  return pack(encodeBytes(pk));
}

// Accepts the fragment with or without '#' and '~level'. Returns the pack; throws DecodeError on bad input.
export async function decodeLink(fragment) {
  return decodeBytes(await unpack(parseFragment(fragment).payload));
}

// ---------- encoding (always the current version) ----------

export function encodeBytes(pk) {
  const w = new ByteWriter();
  w.u8(MAGIC);
  w.u8(VERSION);
  writeTextures(w, pk.textures || []);
  writeParticles(w, pk.particles || []);
  const models = pk.models || [];
  w.varint(models.length);
  for (const m of models) {
    w.string(m.name);
    w.u8(m.scale);
    w.u8(m.emitter ? 1 : 0);
    w.varint(m.parts.length);
    for (const p of m.parts) {
      w.u8((p.mirror ? 1 : 0) | (p.uv ? 2 : 0));
      w.varint(p.tex);
      w.bytes(p.color);
      w.u8(p.scale);
      w.varint(p.verts.length);
      for (const v of p.verts) for (const c of v) w.svarint(c);
      w.varint(p.faces.length);
      for (const f of p.faces) {
        w.varint(f[0] * 2 + (f.length === 4 ? 1 : 0)); // low bit: quad
        for (const i of f.slice(1)) w.varint(i);
      }
      if (p.uv) for (const c of p.uv.flat(2)) w.svarint(c);
    }
    if (m.emitter) {
      w.varint(m.emitter.kind);
      for (const c of m.emitter.pos) w.svarint(c);
      w.u8(m.emitter.angle);
      w.u8(m.emitter.pitch);
    }
  }
  w.varint(pk.levels.length);
  for (const level of pk.levels) writeLevel(w, level);
  return w.finish();
}

function writeLevel(w, level) {
  w.string(level.name);
  w.bytes(level.ambient);
  w.bytes(level.fog);
  w.varint(level.fogDist);
  writeTextures(w, level.textures);
  writeParticles(w, level.particles || []);

  w.varint(level.boxes.length);
  for (const b of level.boxes) {
    for (let i = 0; i < 3; i++) w.svarint(b.min[i]);
    for (let i = 0; i < 3; i++) w.varint(b.max[i] - b.min[i]);
    const f = b.faces;
    const uniform = f.every((x) => sameFace(x, f[0]));
    w.u8((b.solid ? 1 : 0) | (uniform ? 2 : 0) | (b.shape ? 4 : 0));
    for (const face of uniform ? [f[0]] : f) {
      w.varint(face.tex);
      w.u8(face.scale);
      w.u8(face.ox);
      w.u8(face.oy);
    }
    if (b.shape) for (const o of b.shape) for (const v of o) w.svarint(v);
  }

  w.varint(level.entities.length);
  for (const e of level.entities) {
    const spec = ENT_TYPES[e.type];
    if (!spec) throw new RangeError(`unknown entity type ${e.type}`);
    w.u8(e.type);
    for (let i = 0; i < 3; i++) w.svarint(e.pos[i]);
    w.u8(e.angle);
    for (const [key, kind] of spec.params) writeField(w, kind, e[key]);
  }
}

function writeTextures(w, textures) {
  w.varint(textures.length);
  for (const t of textures) {
    w.u8((t.size === 128 ? 1 : 0) | (t.transparent ? 2 : 0));
    w.varint(t.ops.length);
    for (const o of t.ops) {
      w.u8(o.op);
      w.varint(o.args.length);
      w.bytes(o.args);
    }
  }
}

function writeParticles(w, parts) {
  w.varint(parts.length);
  for (const p of parts) {
    w.varint(p.tex);
    w.u8((p.additive ? 1 : 0) | (p.burst ? 2 : 0));
    for (const k of PARTICLE_U8) w.u8(p[k]);
    w.svarint(p.gravity);
  }
}

function sameFace(a, b) {
  return a.tex === b.tex && a.scale === b.scale && a.ox === b.ox && a.oy === b.oy;
}

function writeField(w, kind, v) {
  if (kind === 'rgb') w.bytes(v);
  else if (kind === 'once') w.u8(v ? 1 : 0);
  else if (kind === 'u8' || kind === 'on' || kind === 'dir' || kind === 'axis' || kind === 'edge') w.u8(v);
  else if (kind === 'text' || kind === 'link') w.string(v);
  else if (kind === 'turn') w.svarint(v);
  else if (kind === 'targets') {
    w.varint(v.length);
    for (const t of v) w.varint(t);
  } else w.varint(v); // box, kind, dist, level, model
}

// ---------- decoding ----------

export function decodeBytes(bytes) {
  const r = new ByteReader(bytes);
  if (r.u8() !== MAGIC) throw new DecodeError('not a Linkworld level');
  const version = r.u8();
  if (version !== VERSION) throw new DecodeError(`unsupported level version ${version} (this game reads version ${VERSION})`);
  const textures = readTextures(r);
  const particles = readParticles(r, textures.length);
  const models = readModels(r, textures.length, particles.length);
  const pk = readLevels(r, models);
  for (const [k, v] of [['textures', textures], ['particles', particles], ['models', models]]) if (v.length) pk[k] = v;
  if (r.remaining) throw new DecodeError('unexpected data after end of level');
  return pk;
}

// Triangles a model draws: quads are two, base parts are drawn twice (mirrored).
export const modelTris = (m) => m.parts.reduce((n, p) => n + p.faces.reduce((k, f) => k + f.length - 2, 0) * (p.mirror ? 2 : 1), 0);

function readModels(r, nTex, nParts) {
  const models = [];
  const n = num(r, LIMITS.models, 'model count');
  const mc = (what) => {
    const v = r.svarint();
    if (Math.abs(v) > LIMITS.modelCoord) throw new DecodeError(`${what}: coordinate out of range`);
    return v;
  };
  for (let m = 0; m < n; m++) {
    const at = `model ${m + 1}`;
    const model = { name: r.string(LIMITS.modelName), scale: r.u8() };
    if (!model.scale) throw new DecodeError(`${at}: scale must be at least 1`);
    const flags = r.u8();
    if (flags & ~1) throw new DecodeError(`${at}: unknown flags`);
    model.parts = [];
    const np = num(r, LIMITS.parts, `${at} part count`);
    for (let p = 0; p < np; p++) {
      const pf = r.u8();
      if (pf & ~3) throw new DecodeError(`${at} part ${p + 1}: unknown flags`);
      const part = { mirror: !!(pf & 1), tex: num(r, nTex, `${at} texture`), color: r.bytes(3), scale: r.u8() };
      const nv = num(r, LIMITS.verts, `${at} vertex count`);
      part.verts = Array.from({ length: nv }, () => [mc(at), mc(at), mc(at)]);
      const idx = () => num(r, nv - 1, `${at} face vertex`);
      part.faces = Array.from({ length: num(r, LIMITS.faces, `${at} face count`) }, () => {
        const first = r.varint();
        if (first >> 1 >= nv) throw new DecodeError(`${at} face vertex out of range`);
        return [first >> 1, idx(), idx(), ...(first & 1 ? [idx()] : [])];
      });
      if (pf & 2) {
        part.uv = part.faces.map((f) => f.map(() => [0, 0].map(() => {
          const v = r.svarint();
          if (Math.abs(v) > LIMITS.uv) throw new DecodeError(`${at}: uv out of range`);
          return v;
        })));
      }
      model.parts.push(part);
    }
    if (flags & 1) {
      model.emitter = { kind: num(r, nParts - 1, `${at} emitter type`), pos: [mc(at), mc(at), mc(at)], angle: r.u8(), pitch: r.u8() };
    }
    models.push(model);
  }
  return models;
}

function readLevels(r, models) {
  const n = num(r, LIMITS.levels, 'level count');
  if (!n) throw new DecodeError('the link has no levels');
  const levels = [];
  for (let i = 0; i < n; i++) {
    try {
      levels.push(readLevel(r, n, models));
    } catch (e) {
      if (e instanceof DecodeError && n > 1) throw new DecodeError(`level ${i + 1}: ${e.message}`);
      throw e;
    }
  }
  return { levels };
}

function num(r, max, what) {
  const v = r.varint();
  if (v > max) throw new DecodeError(`${what} out of range (${v} > ${max})`);
  return v;
}

function coord(r) {
  const v = r.svarint();
  if (Math.abs(v) > LIMITS.coord) throw new DecodeError(`coordinate ${v} out of range`);
  return v;
}

function readLevel(r, nLevels, models) {
  const level = {
    name: r.string(LIMITS.name),
    ambient: r.bytes(3),
    fog: r.bytes(3),
    fogDist: num(r, LIMITS.dist, 'fog distance'),
  };
  level.textures = readTextures(r);
  const nTex = level.textures.length;
  const particles = readParticles(r, nTex);
  if (particles.length) level.particles = particles;
  level.boxes = readBoxes(r, nTex);
  level.entities = readEntities(r, { nBoxes: level.boxes.length, nParts: particles.length, nLevels, nModels: models.length });
  const tris = level.entities.reduce((n, e) => n + (e.type === ENT.PROP ? modelTris(models[e.model]) : 0), 0);
  if (tris > LIMITS.propTris) throw new DecodeError(`props have too many triangles (${tris} > ${LIMITS.propTris})`);
  return level;
}

function readTextures(r) {
  const textures = [];
  const n = num(r, LIMITS.textures, 'texture count');
  for (let t = 0; t < n; t++) {
    const flags = r.u8();
    if (flags & ~3) throw new DecodeError(`texture ${t}: unknown flags`);
    const ops = [];
    const nOps = num(r, LIMITS.ops, `texture ${t} op count`);
    for (let i = 0; i < nOps; i++) {
      const op = r.u8();
      ops.push({ op, args: r.bytes(num(r, LIMITS.opArgs, `texture ${t} op ${i} args`)) });
    }
    textures.push(flags & 2 ? { size: flags & 1 ? 128 : 64, transparent: true, ops } : { size: flags & 1 ? 128 : 64, ops });
  }
  const err = checkTextures(textures);
  if (err) throw new DecodeError(err);
  return textures;
}

function readParticles(r, nTex) {
  const out = [];
  const n = num(r, LIMITS.particles, 'particle type count');
  for (let t = 0; t < n; t++) {
    const p = { tex: num(r, nTex, `particle type ${t} texture`) };
    const flags = r.u8();
    if (flags & ~3) throw new DecodeError(`particle type ${t}: unknown flags`);
    p.additive = !!(flags & 1);
    p.burst = !!(flags & 2);
    for (const k of PARTICLE_U8) p[k] = r.u8();
    if (!p.life) throw new DecodeError(`particle type ${t}: life must be at least 1`);
    p.gravity = r.svarint();
    if (Math.abs(p.gravity) > LIMITS.gravity) throw new DecodeError(`particle type ${t}: gravity out of range`);
    out.push(p);
  }
  return out;
}

function readBoxes(r, nTex) {
  const boxes = [];
  const n = num(r, LIMITS.boxes, 'box count');
  for (let b = 0; b < n; b++) {
    const min = [coord(r), coord(r), coord(r)];
    const max = min.map((m) => {
      const size = r.varint();
      if (size === 0 || m + size > LIMITS.coord) throw new DecodeError(`box ${b}: bad size`);
      return m + size;
    });
    const flags = r.u8();
    if (flags & ~7) throw new DecodeError(`box ${b}: unknown flags`);
    const faces = [];
    for (let i = 0; i < (flags & 2 ? 1 : 6); i++) {
      faces.push({ tex: num(r, nTex, `box ${b} texture`), scale: r.u8(), ox: r.u8(), oy: r.u8() });
    }
    while (faces.length < 6) faces.push({ ...faces[0] });
    const box = { min, max, solid: !!(flags & 1), faces };
    if (flags & 4) {
      box.shape = Array.from({ length: 8 }, (_, i) => [0, 1, 2].map((k) => {
        const v = r.svarint();
        const [lo, hi] = offsetRange(box, i, k);
        if (v < lo || v > hi) throw new DecodeError(`box ${b}: corner offset out of range`);
        return v;
      }));
      if (!box.shape.some((o) => o.some((v) => v))) throw new DecodeError(`box ${b}: empty shape`);
      if (!hullOf(box)) throw new DecodeError(`box ${b}: shape has no volume`);
    }
    boxes.push(box);
  }
  return boxes;
}

function readEntities(r, ctx) {
  const ents = [];
  const n = (ctx.nEnt = num(r, LIMITS.entities, 'entity count'));
  for (let i = 0; i < n; i++) {
    const type = r.u8();
    const spec = ENT_TYPES[type];
    if (!spec) throw new DecodeError(`entity ${i}: unknown type ${type}`);
    const e = { type, pos: [coord(r), coord(r), coord(r)], angle: r.u8() };
    for (const [key, kind] of spec.params) e[key] = readField(r, kind, ctx, `entity ${i} ${key}`);
    ents.push(e);
  }
  // Checks that need every entity read first.
  ents.forEach((e, i) => {
    if (e.targets && e.targets.some((t) => !ENT_TYPES[ents[t].type].activatable)) throw new DecodeError(`entity ${i}: target can't be activated`);
    if (e.link && e.level) throw new DecodeError(`entity ${i}: exit has both a level and a link`);
  });
  return ents;
}

function readField(r, kind, ctx, what) {
  const u8 = (max) => {
    const v = r.u8();
    if (v > max) throw new DecodeError(`${what} out of range`);
    return v;
  };
  switch (kind) {
    case 'rgb': return r.bytes(3);
    case 'u8': return r.u8();
    case 'on': return u8(2);
    case 'once': return u8(1) === 1;
    case 'dir': return u8(5);
    case 'axis': return u8(2);
    case 'edge': return u8(3);
    case 'box': return num(r, ctx.nBoxes - 1, what); // nBoxes 0 => max -1 rejects any value
    case 'kind': return num(r, ctx.nParts - 1, what);
    case 'model': return num(r, ctx.nModels - 1, what);
    case 'dist': return num(r, LIMITS.dist, what);
    case 'level': return num(r, ctx.nLevels, what);
    case 'text': return r.string(LIMITS.text);
    case 'turn': {
      const v = r.svarint();
      if (Math.abs(v) > LIMITS.turn) throw new DecodeError(`${what} out of range`);
      return v;
    }
    case 'targets': {
      const n = num(r, LIMITS.entities, what);
      return Array.from({ length: n }, () => num(r, ctx.nEnt - 1, what));
    }
    case 'link': {
      const s = r.string(LIMITS.link);
      if (s && !isLink(s)) throw new DecodeError(`${what}: not a Linkworld link`);
      return s;
    }
  }
}

// ---------- edits that keep references valid (used by the editor) ----------

// Removes entity i; triggers drop it from their targets, later indices shift down.
export function removeEntity(level, i) {
  level.entities.splice(i, 1);
  for (const e of level.entities) if (e.targets) e.targets = e.targets.filter((t) => t !== i).map((t) => (t > i ? t - 1 : t));
}

// Removes box i and the entities using it (doors, triggers, exits); later box indices shift down.
export function removeBox(level, i) {
  level.boxes.splice(i, 1);
  for (let k = level.entities.length - 1; k >= 0; k--) if (level.entities[k].box === i) removeEntity(level, k);
  for (const e of level.entities) if (e.box > i) e.box--;
}

// Owner: a level, or the pack (its shared textures and particle types, used by its models).

// Removes texture n (1-based, as faces use it); its faces and particle types get the default texture, model
// parts their color. Refused (returns false) while a Reference op uses it.
export function removeTexture(owner, n) {
  if (owner.textures.some((t) => t.ops.some((o) => o.op === 80 && o.args[0] === n))) return false;
  owner.textures.splice(n - 1, 1);
  const users = [...(owner.boxes || []).flatMap((b) => b.faces), ...(owner.particles || []), ...(owner.models || []).flatMap((m) => m.parts)];
  for (const x of users) x.tex = x.tex === n ? 0 : x.tex > n ? x.tex - 1 : x.tex;
  for (const t of owner.textures) for (const o of t.ops) if (o.op === 80 && o.args[0] > n) o.args[0]--;
  return true;
}

// Removes particle type k (0-based). Refused (returns false) while an emitter (or a model's) uses it.
export function removeParticleType(owner, k) {
  const ems = owner.entities ? owner.entities.filter((e) => e.type === ENT.EMITTER) : (owner.models || []).flatMap((m) => (m.emitter ? [m.emitter] : []));
  if (ems.some((e) => e.kind === k)) return false;
  owner.particles.splice(k, 1);
  if (!owner.particles.length) delete owner.particles;
  for (const e of ems) if (e.kind > k) e.kind--;
  return true;
}

// Removes model k (0-based) of the pack. Refused (returns false) while a prop uses it.
export function removeModel(pk, k) {
  const props = pk.levels.flatMap((lv) => lv.entities.filter((e) => e.type === ENT.PROP));
  if (props.some((e) => e.model === k)) return false;
  pk.models.splice(k, 1);
  for (const e of props) if (e.model > k) e.model--;
  return true;
}

// Removes level i of the pack; exits to it go to the menu, exits to later levels follow them.
export function removeLevel(pk, i) {
  pk.levels.splice(i, 1);
  for (const lv of pk.levels) {
    for (const e of lv.entities) if (e.type === ENT.EXIT && e.level) e.level = e.level === i + 1 ? 0 : e.level > i + 1 ? e.level - 1 : e.level;
  }
}
