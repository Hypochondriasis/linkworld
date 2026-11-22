import assert from 'node:assert/strict';
import { createWorld } from '../src/game.js';
import { ENT, ON } from '../src/format.js';

const faces = () => Array.from({ length: 6 }, () => ({ tex: 0, scale: 16, ox: 0, oy: 0 }));
const box = (min, max, solid = true) => ({ min, max, solid, faces: faces() });
const level = (boxes, entities) => ({ name: '', ambient: [0, 0, 0], fog: [0, 0, 0], fogDist: 0, textures: [], boxes, entities });
const idle = { forward: 0, right: 0, jump: false };
const run = (w, s, input = idle) => { for (let i = 0; i < s * 120; i++) w.tick(input, 1 / 120); };
const shootOnce = (w) => { w.tick({ ...idle, fire: true }, 1 / 120); };

// Boxes: 0 floor, 1 wall ahead (a shoot trigger), 2 target beside the start (a shoot trigger), 3 door (shot: it rises).
const boxes = [
  box([-200, -8, -200], [200, 0, 200]),
  box([-50, 0, -60], [50, 40, -52]),
  box([10, 0, -5], [20, 10, 5]),
  box([-10, 0, 40], [10, 20, 44]),
];
const msg = (text) => ({ type: ENT.MESSAGE, pos: [0, 0, 0], angle: 0, text });
const shot = (b, t) => ({ type: ENT.TRIGGER, pos: [0, 0, 0], angle: 0, box: b, on: ON.SHOOT, once: false, text: '', targets: [t] });
const make = () => {
  const said = [];
  const w = createWorld(level(boxes, [
    { type: ENT.PLAYER_START, pos: [0, 0, 0], angle: 0 },
    shot(1, 4), shot(2, 5), shot(3, 6),
    msg('wall'), msg('target'),
    { type: ENT.DOOR, pos: [0, 0, 0], angle: 0, box: 3, dir: 3, dist: 20, speed: 80 },
  ]), { message: (t) => said.push(t) });
  return { w, said };
};

// Grenade at the wall: it bounces back, comes to rest on the floor, then explodes after its fuse.
{
  const { w, said } = make();
  w.weapons.select(1);
  run(w, 0.5);
  shootOnce(w);
  run(w, 1.8);
  const g = w.weapons.grenades[0];
  assert.ok(g.p[2] > -52 && g.p[2] < 0, 'bounced off the wall: ' + g.p[2]);
  assert.ok(g.p[1] >= 0 && g.p[1] < 0.1, 'rests on the floor: ' + g.p[1]);
  assert.ok(Math.hypot(...g.v) < 1, 'stopped');
  run(w, 0.3);
  assert.equal(w.weapons.grenades.length, 0, 'exploded');
  assert.ok(!said.includes('wall'), 'the wall is 39 units away, out of reach');
}

// Grenade dropped at the feet: the blast reaches the target 10 units away.
{
  const { w, said } = make();
  w.weapons.select(1);
  w.player.pitch = -Math.PI / 2;
  run(w, 0.5);
  shootOnce(w);
  run(w, 2.1);
  assert.deepEqual(said, ['target']);
}

// Crossbow bolt: sticks a little into the wall and shoots it.
{
  const { w, said } = make();
  w.weapons.select(2);
  run(w, 0.5);
  shootOnce(w);
  run(w, 0.3);
  const { p, dir } = w.weapons.bolts[0].at();
  assert.ok(Math.abs(p[2] + 53) < 0.1 && dir[2] < -0.99, 'stuck in the wall: ' + p);
  assert.deepEqual(said, ['wall']);
}

// A bolt in a door moves with it.
{
  const { w } = make();
  w.weapons.select(2);
  w.player.yaw = Math.PI; // towards +z
  run(w, 0.5);
  shootOnce(w);
  run(w, 0.1);
  const rise = () => w.weapons.bolts[0].at().p[1] - w.doors[0].t * 20; // stays put relative to the door
  const y0 = rise();
  assert.ok(w.doors[0].t > 0 && w.doors[0].t < 1, 'opening');
  run(w, 1);
  assert.equal(w.doors[0].t, 1, 'the shot door opened');
  assert.ok(Math.abs(rise() - y0) < 0.01, 'the bolt rose with it');
}

// Rifle: hitscan, held down it fires at its rate.
{
  const { w, said } = make();
  run(w, 0.5, { ...idle, fire: true });
  assert.equal(said.length, 3, 'one shot at once, then every 0.2 s: ' + said.length);
}

console.log('weapons: ok');
