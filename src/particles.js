// Particle simulation, without DOM or GL: emitters spawn particles of a level particle type.
// Type: { tex, additive, burst, rate, life (1/10 s), speed, spread (0 = straight, 255 = all directions),
//         gravity (units/s², down), size0, size1 (units at birth / death) }. See FORMAT.md.
import { ENT } from './format.js';
import { mulberry32 } from './prng.js';
import { cross, forward } from './shape.js';

export const MAX_PARTICLES = 2048; // all emitters together; keeps hostile links cheap

// Unit vector an emitter fires along: angle is yaw (0 faces −z, 64 faces −x), pitch 0 level, 64 up, 192 down.
export const emitterDir = (e) => forward((e.angle / 256) * Math.PI * 2, (e.pitch / 256) * Math.PI * 2);

// types: level.particles; emitters: emitter entities (always: on from the start, like a prop's). Particles: { pos, vel, age, life, type }.
export function createParticles(types, emitters, seed = 1) {
  const rnd = mulberry32(seed);
  const r = () => rnd() / 4294967296;
  const list = [];
  const ems = emitters.map((e) => ({ e, t: types[e.kind], dir: emitterDir(e), on: !!e.always, acc: 0 }));

  // Random direction inside the cone around em.dir (uniform over the cap).
  function spawn(em) {
    if (list.length >= MAX_PARTICLES) return;
    const d = em.dir, t = em.t;
    const cosMax = Math.cos((t.spread / 255) * Math.PI);
    const z = 1 - r() * (1 - cosMax), s = Math.sqrt(1 - z * z), phi = r() * Math.PI * 2;
    // Basis perpendicular to d.
    const a = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let u = cross(d, a);
    const ul = Math.hypot(...u);
    u = u.map((x) => x / ul);
    const v = cross(d, u);
    const dir = [0, 1, 2].map((k) => d[k] * z + (u[k] * Math.cos(phi) + v[k] * Math.sin(phi)) * s);
    list.push({ pos: [...em.e.pos], vel: dir.map((x) => x * t.speed), age: 0, life: t.life / 10, type: em.e.kind });
  }

  // Activates emitter entity e: a burst type emits `rate` particles each time; a continuous one switches on.
  function fire(e) {
    for (const em of ems) {
      if (em.e !== e || !em.t) continue;
      if (em.t.burst) for (let i = 0; i < em.t.rate; i++) spawn(em);
      else em.on = true;
    }
  }

  function update(dt) {
    for (const em of ems) {
      if (!em.on) continue;
      em.acc += em.t.rate * dt;
      for (; em.acc >= 1; em.acc--) spawn(em);
    }
    let n = 0;
    for (const p of list) {
      p.age += dt;
      if (p.age >= p.life) continue;
      p.vel[1] -= types[p.type].gravity * dt;
      for (let k = 0; k < 3; k++) p.pos[k] += p.vel[k] * dt;
      list[n++] = p;
    }
    list.length = n;
  }

  return { list, types, fire, update };
}

export const emittersOf = (level) => level.entities.filter((e) => e.type === ENT.EMITTER);
