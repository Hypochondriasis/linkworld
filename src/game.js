// Player movement (Quake-style), collision against solid convex shapes, and the level's rules (doors, triggers,
// exits), without DOM. Input and the frame loop are in play.js.
// Units: 1 unit = 1/8 block. Quake values scaled by 1/4 (Quake player is 56 tall, ours 14).
import { ENT, ON } from './format.js';
import { corners, hullOf, dot, cross, forward } from './shape.js';
import { createParticles, emittersOf } from './particles.js';

export const PHYS = {
  gravity: 200,
  jumpSpeed: 68,
  maxSpeed: 80,
  accel: 10,
  airAccel: 10,
  airWishCap: 7.5, // Quake's 30, scaled: this is what makes air strafing work
  friction: 4,
  stopSpeed: 25,
  stepHeight: 3,
  halfWidth: 2.5,
  height: 14,
  eyeHeight: 12.5,
};

const DIST_EPS = 0.01; // traces stop this far short of a surface (Quake's DIST_EPSILON, scaled)
const GROUND_NY = 0.7; // a surface is floor if its normal's y is at least this (about 45°)
// Solids are shrunk by this, so a point exactly on a surface (a spawn point, a level edit) is outside it.
const SKIN = DIST_EPS / 2;
const OVERCLIP = 1.001; // clipped velocity points slightly away from the surface, so it never re-hits it

export function createPlayer(level) {
  const start = level.entities.find((e) => e.type === ENT.PLAYER_START);
  const pos = start ? [...start.pos] : [0, 0, 0];
  return { pos, spawn: [...pos], vel: [0, 0, 0], yaw: start ? (start.angle / 256) * Math.PI * 2 : 0, pitch: 0, onGround: false };
}

// Collision works like Quake: the player is a point (their feet), and every solid is grown by the player box.
// A brush is that grown solid: inside where n·p < d for every plane. Its planes are the shape's face normals,
// the axes, and every shape edge × axis, which makes the grown shape exact (Minkowski sum with a box).
// off: current translation (doors).
export const makeBrush = (box) => brushOf(corners(box), box.shape ? hullOf(box).faces : []);

// Brush of a convex solid given by its points and faces ({ n, verts }; none needed for an axis-aligned box).
// Rotating doors pass rotated, non-integer points.
function brushOf(pts, faces) {
  const normals = [];
  const add = (n) => {
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len < 1e-9) return;
    const u = n.map((v) => v / len);
    if (!normals.some((m) => Math.abs(m[0] - u[0]) + Math.abs(m[1] - u[1]) + Math.abs(m[2] - u[2]) < 1e-7)) normals.push(u);
  };
  for (let k = 0; k < 3; k++) for (const sgn of [-1, 1]) add([0, 1, 2].map((a) => (a === k ? sgn : 0)));
  for (const f of faces) {
    add(f.n);
    f.verts.forEach((a, i) => {
      const b = f.verts[(i + 1) % f.verts.length];
      const e = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      for (let k = 0; k < 3; k++) {
        const c = cross(e, [0, 1, 2].map((x) => (x === k ? 1 : 0)));
        add(c);
        add(c.map((v) => -v));
      }
    });
  }
  const hw = PHYS.halfWidth, H = PHYS.height;
  // Player box relative to the feet: x,z in ±hw, y in 0..H.
  const planes = normals.map((n) => ({ n, d: Math.max(...pts.map((p) => dot(n, p))) + hw * (Math.abs(n[0]) + Math.abs(n[2])) + Math.max(0, -n[1]) * H }));
  const lo = [0, 1, 2].map((k) => Math.min(...pts.map((p) => p[k])));
  const hi = [0, 1, 2].map((k) => Math.max(...pts.map((p) => p[k])));
  return { planes, min: [lo[0] - hw, lo[1] - H, lo[2] - hw], max: [hi[0] + hw, hi[1], hi[2] + hw], off: [0, 0, 0] };
}

// Is the feet point inside the brush (the player box overlaps the solid)? A point on its surface is outside.
export const insideBrush = (b, p) => b.planes.every((pl) => dot(pl.n, p) < pl.d + dot(pl.n, b.off) - SKIN);

// Moves the feet point from start towards end. Returns { frac, end, n, brush }: how far it got, where, and the
// unit normal and brush it hit (null if nothing). Brushes the point starts inside are ignored, so it can get out.
export function trace(brushes, start, end) {
  let frac = 1, hitN = null, hitB = null;
  for (const b of brushes) {
    const o = b.off;
    let outside = false;
    for (let k = 0; k < 3; k++) {
      if (Math.max(start[k], end[k]) < b.min[k] + o[k] - DIST_EPS || Math.min(start[k], end[k]) > b.max[k] + o[k] + DIST_EPS) { outside = true; break; }
    }
    if (outside) continue;
    let enter = -Infinity, leave = 1, n = null, startOut = false, away = false;
    for (const pl of b.planes) {
      const d = pl.d + dot(pl.n, o) - SKIN;
      const d1 = dot(pl.n, start) - d, d2 = dot(pl.n, end) - d;
      if (d1 > 0) startOut = true;
      if (d1 > 0 && d2 >= d1) { away = true; break; } // in front of this plane and not approaching
      if (d1 <= 0 && d2 <= 0) continue;
      if (d1 > d2) {
        const f = (d1 - DIST_EPS) / (d1 - d2);
        if (f > enter) { enter = f; n = pl.n; }
      } else {
        leave = Math.min(leave, (d1 + DIST_EPS) / (d1 - d2));
      }
    }
    if (away || !startOut) continue;
    // `n` marks that a plane was entered. (Quake uses enter > -1 for that, which drops real hits when the
    // point starts closer than DIST_EPS to a surface and moves very slowly into it: enter is then below -1.)
    if (n && enter < leave && enter < frac) {
      frac = Math.max(0, enter);
      hitN = n;
      hitB = b;
    }
  }
  return { frac, n: hitN, brush: hitB, end: start.map((v, k) => v + (end[k] - v) * frac) };
}

const clip = (v, n) => { const b = dot(v, n) * OVERCLIP; return v.map((x, k) => x - n[k] * b); };

// Quake's PM_FlyMove: move, and on each hit slide along the surface (or the crease of two), up to 4 times.
function slideMove(brushes, p, dt) {
  let time = dt;
  const original = [...p.vel];
  const planes = [];
  for (let bump = 0; bump < 4; bump++) {
    const tr = trace(brushes, p.pos, p.pos.map((v, k) => v + p.vel[k] * time));
    if (tr.frac > 0) {
      p.pos = tr.end;
      planes.length = 0;
    }
    if (tr.frac === 1) return;
    time -= time * tr.frac;
    planes.push(tr.n);
    let ok = -1;
    for (let i = 0; i < planes.length && ok < 0; i++) {
      const v = clip(original, planes[i]);
      if (planes.every((q, j) => j === i || dot(v, q) >= 0)) { p.vel = v; ok = i; }
    }
    if (ok < 0) {
      if (planes.length !== 2) { p.vel = [0, 0, 0]; return; }
      const dir = cross(planes[0], planes[1]);
      const len = Math.hypot(...dir) || 1;
      const u = dir.map((x) => x / len);
      p.vel = u.map((x) => x * dot(u, p.vel));
    }
    if (dot(p.vel, original) <= 0) { p.vel = [0, 0, 0]; return; }
  }
}

// On the ground: try a plain slide, and a step up / slide / step down; keep whichever went farther.
// Then stick to the floor, so walking down ramps and small steps doesn't become falling.
function groundMove(brushes, p, dt) {
  const start = [...p.pos], startVel = [...p.vel];
  slideMove(brushes, p, dt);
  const down = p.pos, downVel = p.vel;

  p.pos = [...start];
  p.vel = [...startVel];
  p.pos = trace(brushes, start, [start[0], start[1] + PHYS.stepHeight, start[2]]).end;
  const rise = p.pos[1] - start[1];
  slideMove(brushes, p, dt);
  const dn = trace(brushes, p.pos, [p.pos[0], p.pos[1] - rise, p.pos[2]]);
  p.pos = dn.end;
  const dist = (q) => (q[0] - start[0]) ** 2 + (q[2] - start[2]) ** 2;
  if (!(dn.n && dn.n[1] >= GROUND_NY) || dist(down) >= dist(p.pos)) {
    p.pos = down;
    p.vel = downVel;
  }

  const snap = trace(brushes, p.pos, [p.pos[0], p.pos[1] - PHYS.stepHeight, p.pos[2]]);
  if (snap.n && snap.n[1] >= GROUND_NY) p.pos = snap.end;
  p.vel[1] = 0;
}

// p.ground: the brush stood on (doors carry the player standing on them).
function categorize(brushes, p) {
  const tr = trace(brushes, p.pos, [p.pos[0], p.pos[1] - 0.25, p.pos[2]]);
  p.onGround = p.vel[1] <= 0.5 && !!tr.n && tr.n[1] >= GROUND_NY;
  p.ground = p.onGround ? tr.brush : null;
}

// input: { forward, right } in -1..1, jump: bool. brushes: from makeBrush.
export function step(p, brushes, input, dt) {
  categorize(brushes, p);
  const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
  // forward = (fx, fz), right = (-fz, fx)
  const wish = [fx * input.forward - fz * input.right, fz * input.forward + fx * input.right];
  let wishSpeed = Math.hypot(wish[0], wish[1]);
  if (wishSpeed > 0) {
    wish[0] /= wishSpeed;
    wish[1] /= wishSpeed;
  }
  wishSpeed = Math.min(wishSpeed, 1) * PHYS.maxSpeed;

  const v = p.vel;
  if (p.onGround) {
    const speed = Math.hypot(v[0], v[2]);
    if (speed < 0.01) v[0] = v[2] = 0;
    else {
      const drop = Math.max(speed, PHYS.stopSpeed) * PHYS.friction * dt;
      const k = Math.max(speed - drop, 0) / speed;
      v[0] *= k;
      v[2] *= k;
    }
  }
  const cap = p.onGround ? wishSpeed : Math.min(wishSpeed, PHYS.airWishCap);
  const add = cap - (v[0] * wish[0] + v[2] * wish[1]);
  if (add > 0) {
    const a = Math.min((p.onGround ? PHYS.accel : PHYS.airAccel) * dt * wishSpeed, add);
    v[0] += a * wish[0];
    v[2] += a * wish[1];
  }
  if (input.jump && p.onGround) {
    v[1] = PHYS.jumpSpeed;
    p.onGround = false;
  }

  if (p.onGround) {
    v[1] = 0;
    groundMove(brushes, p, dt);
  } else {
    v[1] -= PHYS.gravity * dt;
    slideMove(brushes, p, dt);
  }
  categorize(brushes, p);
}

const DIRS = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]]; // same order as faces
const DOOR_RANGE = 16; // units around a door that open it when nobody triggers it
const DOOR_CLOSE_DELAY = 2; // seconds after the player leaves
const USE_RANGE = 24; // units from the eye a usable box can be used from

// A box's real solid as planes (inside where n·p < d; normals not unit length): its sides plus the hull faces.
function solidPlanes(box) {
  const planes = [0, 1, 2].flatMap((k) => [-1, 1].map((s) => ({ n: [0, 1, 2].map((a) => (a === k ? s : 0)), d: s > 0 ? box.max[k] : -box.min[k] })));
  if (box.shape) for (const f of hullOf(box).faces) planes.push({ n: f.n, d: dot(f.n, f.verts[0]) });
  return planes;
}
// How far along the ray o + t·dir it enters the solid (0 when o is inside); Infinity when it misses.
function rayEnter(planes, o, dir) {
  let enter = 0, leave = Infinity;
  for (const { n, d } of planes) {
    const s = dot(n, o) - d, v = dot(n, dir);
    if (v === 0) { if (s > 0) return Infinity; }
    else if (v < 0) enter = Math.max(enter, -s / v);
    else leave = Math.min(leave, -s / v);
  }
  return enter <= leave ? enter : Infinity;
}

const overlaps = (a, b) => [0, 1, 2].every((k) => a.max[k] > b.min[k] && a.min[k] < b.max[k]);
const playerBox = (p) => ({
  min: [p.pos[0] - PHYS.halfWidth, p.pos[1], p.pos[2] - PHYS.halfWidth],
  max: [p.pos[0] + PHYS.halfWidth, p.pos[1] + PHYS.height, p.pos[2] + PHYS.halfWidth],
});

// Rotating doors turn about an edge of their box parallel to `axis`; edge bit 0 / bit 1 pick the max side
// on the next two axes. Positive turns are counter-clockwise seen from the axis' + end (from above for y).
export function hingeOf(e, box) {
  const u = (e.axis + 1) % 3, v = (e.axis + 2) % 3, h = [0, 0, 0];
  h[u] = e.edge & 1 ? box.max[u] : box.min[u];
  h[v] = e.edge & 2 ? box.max[v] : box.min[v];
  return h;
}
function rotate(p, h, k, ang) {
  const u = (k + 1) % 3, v = (k + 2) % 3, c = Math.cos(ang), s = Math.sin(ang);
  const q = [...p], du = p[u] - h[u], dv = p[v] - h[v];
  q[u] = h[u] + du * c - dv * s;
  q[v] = h[v] + du * s + dv * c;
  return q;
}

// A door's placement at open fraction t: where a point goes, and the column-major mat4 for the renderer.
function placement(d, t) {
  const e = d.e;
  if (e.type === ENT.DOOR) {
    const off = DIRS[e.dir].map((v) => v * e.dist * t);
    return { move: (p) => p.map((v, k) => v + off[k]), off, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, off[0], off[1], off[2], 1] };
  }
  const k = e.axis, u = (k + 1) % 3, v = (k + 2) % 3, ang = (e.turn * t * Math.PI) / 180, h = d.hinge;
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
  const c = Math.cos(ang), s = Math.sin(ang);
  m[k * 5] = 1;
  m[u * 5] = c;
  m[u * 4 + v] = s;
  m[v * 4 + u] = -s;
  m[v * 5] = c;
  const rh = rotate([0, 0, 0], h, k, ang); // where the origin goes: the translation column
  m[12] = rh[0];
  m[13] = rh[1];
  m[14] = rh[2];
  return { move: (p) => rotate(p, h, k, ang), matrix: m };
}

// Level state and rules, without DOM. hooks: message(text), exit(exit entity).
// A trigger activates its targets each time the player enters, uses (E) or shoots it, or only the first time
// (once). Anything no trigger targets runs on its
// own: doors open while the player is near, messages show and emitters start at level start.
// scene: the props' particle types and always-on emitters (model.js propScene), appended to the level's.
export function createWorld(level, hooks = {}, scene = { particles: [], emitters: [] }) {
  const ents = level.entities;
  const isDoor = (e) => e.type === ENT.DOOR || e.type === ENT.ROTATOR;
  // Enter-trigger and exit boxes are invisible, non-solid volumes in the game.
  const isVolume = (e) => (e.type === ENT.TRIGGER && e.on === ON.ENTER) || e.type === ENT.EXIT;
  const hidden = new Set(ents.filter(isVolume).map((e) => e.box));
  const targeted = new Set(ents.flatMap((e) => e.targets || []).map((i) => ents[i]));
  const doorEnts = ents.filter((e) => isDoor(e) && !hidden.has(e.box));
  const dynamic = [...new Set(doorEnts.map((e) => e.box))]; // a box used by two doors follows the first
  const doors = dynamic.map((b) => {
    const box = level.boxes[b];
    const e = doorEnts.find((d) => d.box === b);
    const d = { e, box, auto: !targeted.has(e), brush: makeBrush(box), t: 0, open: false, timer: 0 };
    if (e.type === ENT.ROTATOR) Object.assign(d, { hinge: hingeOf(e, box), rest: { pts: corners(box), faces: hullOf(box).faces } });
    d.at = placement(d, 0);
    return d;
  });
  const solids = level.boxes
    .filter((b, i) => b.solid && !hidden.has(i) && !dynamic.includes(i))
    .map(makeBrush)
    .concat(doors.filter((d) => d.box.solid).map((d) => d.brush));
  // Volumes test the real shape: the player is in one when their feet are inside its grown brush.
  const volume = (e) => ({ e, brush: makeBrush(level.boxes[e.box]), inside: false });
  const triggers = ents.filter((e) => e.type === ENT.TRIGGER && e.on === ON.ENTER).map(volume);
  const exits = ents.filter((e) => e.type === ENT.EXIT).map(volume);
  // The view ray stops at visible solids and at use/shoot trigger boxes (whatever they are otherwise).
  const roles = new Map();
  for (const e of ents) if (e.type === ENT.TRIGGER && e.on !== ON.ENTER) roles.set(e.box, [...(roles.get(e.box) || []), e]);
  const rayBoxes = [];
  level.boxes.forEach((box, i) => {
    if (roles.has(i) || (box.solid && !hidden.has(i))) rayBoxes.push({ box, planes: solidPlanes(box), door: doors[dynamic.indexOf(i)], on: roles.get(i) || [] });
  });
  const floor = Math.min(0, ...level.boxes.map((b) => b.min[1])) - 1000;
  const player = createPlayer(level);
  const particles = createParticles([...(level.particles || []), ...scene.particles], [...emittersOf(level), ...scene.emitters]);
  let exited = false;

  const say = (text) => hooks.message && hooks.message(text);
  function activate(e) {
    if (e.type === ENT.MESSAGE) say(e.text);
    else if (e.type === ENT.EMITTER) particles.fire(e);
    else for (const d of doors) if (d.e === e) { d.open = true; d.timer = Infinity; }
  }

  // Puts the door's brush at fraction t. A moving solid door carries a player standing on it and pushes one
  // in its way; if the player can't go (a wall behind them), nothing moves and it returns false.
  function moveDoor(d, t) {
    const prevBrush = { planes: d.brush.planes, min: d.brush.min, max: d.brush.max, off: d.brush.off };
    const next = placement(d, t);
    if (d.rest) {
      const pts = d.rest.pts.map(next.move);
      Object.assign(d.brush, brushOf(pts, d.rest.faces.map((f) => ({ n: rotate(f.n, [0, 0, 0], d.e.axis, (d.e.turn * t * Math.PI) / 180), verts: f.verts.map(next.move) }))));
    } else d.brush.off = next.off;
    if (d.box.solid && (player.ground === d.brush || insideBrush(d.brush, player.pos))) {
      // Where the point under the player's feet goes with the door (undo the old placement, apply the new).
      const from = player.pos;
      const local = d.rest ? rotate(from, d.hinge, d.e.axis, (-d.e.turn * d.t * Math.PI) / 180) : from.map((v, k) => v - d.at.off[k]);
      player.pos = trace(solids.filter((b) => b !== d.brush), from, next.move(local)).end;
      if (insideBrush(d.brush, player.pos)) {
        player.pos = from;
        Object.assign(d.brush, prevBrush);
        return false;
      }
    }
    d.t = t;
    d.at = next;
    return true;
  }

  // The nearest box the view ray hits within range, or null. Doors are tested in their resting frame.
  function look(range) {
    const o = [player.pos[0], player.pos[1] + PHYS.eyeHeight, player.pos[2]], dir = forward(player.yaw, player.pitch);
    let best = null;
    for (const r of rayBoxes) {
      let ro = o, rd = dir;
      const d = r.door;
      if (d && d.rest) {
        const a = (-d.e.turn * d.t * Math.PI) / 180;
        ro = rotate(o, d.hinge, d.e.axis, a);
        rd = rotate(dir, [0, 0, 0], d.e.axis, a);
      } else if (d) ro = o.map((v, k) => v - d.at.off[k]);
      else if (Math.hypot(...[0, 1, 2].map((k) => Math.max(r.box.min[k] - o[k], 0, o[k] - r.box.max[k]))) > range) continue;
      const t = rayEnter(r.planes, ro, rd);
      if (t < range) { // strict: a miss is Infinity
        range = t;
        best = r;
      }
    }
    return best;
  }
  const spent = new Set(); // once-triggers that fired
  const hit = (r, on) => (r ? r.on.filter((e) => e.on === on && !spent.has(e)) : []);
  const fire = (list) => {
    for (const e of list) {
      if (spent.has(e)) continue;
      if (e.once) spent.add(e);
      for (const i of e.targets) activate(ents[i]);
    }
  };

  function tick(input, dt) {
    step(player, solids, input, dt);
    particles.update(dt);
    if (player.pos[1] < floor) {
      player.pos = [...player.spawn];
      player.vel = [0, 0, 0];
    }
    const pb = playerBox(player);

    for (const d of doors) {
      if (d.auto) {
        // Near the closed position (so a door that slid away still counts the player), or riding it (lifts).
        const range = { min: d.box.min.map((v) => v - DOOR_RANGE), max: d.box.max.map((v) => v + DOOR_RANGE) };
        if (overlaps(range, pb) || player.ground === d.brush) { d.open = true; d.timer = DOOR_CLOSE_DELAY; }
        else if ((d.timer -= dt) <= 0) d.open = false;
      }
      const goal = d.open ? 1 : 0;
      if (d.t === goal) continue;
      const span = d.e.type === ENT.DOOR ? d.e.dist : Math.abs(d.e.turn);
      const rate = (Math.max(1, d.e.speed) * dt) / Math.max(1, span);
      const t = goal > d.t ? Math.min(goal, d.t + rate) : Math.max(goal, d.t - rate);
      // Blocked: a closing door that would crush the player opens again.
      if (!moveDoor(d, t) && !d.open) { d.open = true; d.timer = DOOR_CLOSE_DELAY; }
    }

    for (const tr of triggers) {
      const inside = insideBrush(tr.brush, player.pos);
      if (inside && !tr.inside) fire([tr.e]);
      tr.inside = inside;
    }
    if (!exited) {
      const x = exits.find((v) => insideBrush(v.brush, player.pos));
      if (x) {
        exited = true;
        if (hooks.exit) hooks.exit(x.e);
      }
    }
  }

  return {
    player,
    tick,
    hidden,
    dynamic,
    doors,
    particles,
    start: () => { for (const e of ents) if ((e.type === ENT.MESSAGE || e.type === ENT.EMITTER) && !targeted.has(e)) activate(e); },
    models: () => doors.map((d) => d.at.matrix),
    usable: () => hit(look(USE_RANGE), ON.USE)[0] || null, // what E would use now (its text is the prompt)
    use: () => fire(hit(look(USE_RANGE), ON.USE)),
    shoot: () => fire(hit(look(Infinity), ON.SHOOT)),
  };
}
