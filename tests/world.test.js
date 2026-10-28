import assert from 'node:assert/strict';
import { createWorld } from '../src/game.js';
import { ENT, ON } from '../src/format.js';
import { demoLevel, liftLevel } from '../src/demo.js';
import { exitHref } from '../src/play.js';

const faces = () => Array.from({ length: 6 }, () => ({ tex: 0, scale: 16, ox: 0, oy: 0 }));
const box = (min, max, solid = true) => ({ min, max, solid, faces: faces() });
const level = (boxes, entities) => ({ name: '', ambient: [0, 0, 0], fog: [0, 0, 0], fogDist: 0, textures: [], boxes, entities });
const idle = { forward: 0, right: 0, jump: false };
const walk = { forward: 1, right: 0, jump: false };
const run = (w, input, s) => { for (let i = 0; i < s * 120; i++) w.tick(input, 1 / 120); };

// Boxes: 0 floor, 1 wall with a door gap, 2 door (fills the gap), 3 trigger volume, 4 exit volume, 5 event door.
const boxes = [
  box([-200, -8, -400], [200, 0, 100]),
  box([-200, 0, -60], [-16, 40, -52]),
  box([-16, 0, -60], [16, 40, -52]),
  box([-50, 0, -150], [50, 30, -130], false),
  box([-50, 0, -300], [50, 30, -290], true), // exits are volumes even if marked solid
  box([60, 0, -10], [80, 30, 10]),
];
const ents = [
  { type: ENT.PLAYER_START, pos: [0, 0, 0], angle: 0 },
  { type: ENT.DOOR, pos: [0, 0, 0], angle: 0, box: 2, dir: 3, dist: 40, speed: 80 },
  { type: ENT.TRIGGER, pos: [0, 0, 0], angle: 0, box: 3, on: ON.ENTER, once: false, text: '', targets: [3, 5] },
  { type: ENT.MESSAGE, pos: [0, 0, 0], angle: 0, text: 'triggered' },
  { type: ENT.MESSAGE, pos: [0, 0, 0], angle: 0, text: 'welcome' },
  { type: ENT.DOOR, pos: [0, 0, 0], angle: 0, box: 5, dir: 1, dist: 20, speed: 40 },
  { type: ENT.EXIT, pos: [0, 0, 0], angle: 0, box: 4, level: 2, link: '' },
];
const said = [], exits = [];
const w = createWorld(level(boxes, ents), { message: (t) => said.push(t), exit: (u) => exits.push(u) });
assert.deepEqual([...w.hidden].sort(), [3, 4]);
assert.deepEqual(w.dynamic, [2, 5]);
w.start();
assert.deepEqual(said, ['welcome']);

// Far away: proximity door stays shut.
run(w, idle, 0.5);
assert.equal(w.doors[0].t, 0);

// Walk north (-z): the door opens before we reach it, we pass through, the trigger fires once,
// the event door opens and stays open, then the exit navigates exactly once.
run(w, walk, 1);
assert.ok(w.doors[0].t > 0, 'proximity door opening');
run(w, walk, 1);
assert.ok(w.player.pos[2] < -60, `passed the door: z=${w.player.pos[2]}`);
assert.deepEqual(said, ['welcome', 'triggered']);
run(w, walk, 4);
assert.deepEqual(exits, [ents[6]]);
assert.equal(w.doors[1].t, 1);
assert.deepEqual(w.models()[1].slice(12, 15), [20, 0, 0]);
assert.deepEqual(said, ['welcome', 'triggered'], 'trigger fires once per entry');

// Proximity door closes after we leave.
run(w, idle, 4);
assert.equal(w.doors[0].t, 0);
assert.equal(w.doors[1].t, 1, 'event door stays open');

// Standing in the open doorway keeps the door open; leaving lets it close.
const w2 = createWorld(level(boxes, ents.slice(0, 2)));
w2.player.pos = [0, 0, -40];
run(w2, idle, 2);
assert.equal(w2.doors[0].t, 1);
w2.player.pos = [0, 0, -56];
run(w2, idle, 5);
assert.equal(w2.doors[0].t, 1);
w2.player.pos = [0, 0, 60];
run(w2, idle, 4);
assert.equal(w2.doors[0].t, 0);

// A door never moves into the player: block a closing event-less door's path by teleporting into it.
const w3 = createWorld(level(boxes, ents.slice(0, 2)));
w3.player.pos = [0, 0, -40];
run(w3, idle, 2);
w3.player.pos = [0, 30, 60]; // walk away (in the air above the floor, falls)
run(w3, idle, 2.2); // door starts closing
const t0 = w3.doors[0].t;
assert.ok(t0 < 1 && t0 > 0, `closing: ${t0}`);
w3.player.pos = [0, 0, -56]; // now stand under it
for (let k = 0; k < 240; k++) {
  w3.tick(idle, 1 / 120);
  const bottom = w3.doors[0].box.min[1] + w3.doors[0].at.off[1];
  assert.ok(bottom >= 14 - 1e-9, `door entered the player: bottom=${bottom}`);
}

// Demo level 1: walk south from the start, through the courtyard door, into the exit to level 2.
const demoExits = [];
const dw = createWorld(demoLevel(), { exit: (e) => demoExits.push(e.level) });
run(dw, { forward: -1, right: 0, jump: false }, 5);
assert.deepEqual(demoExits, [2], `demo exit reached: ${dw.player.pos}`);

// Demo level 2: step on the lift, ride it up (the pusher carries the player), walk through the rotating door.
const lw = createWorld(liftLevel(), { exit: (e) => demoExits.push(e.level) });
const liftDoor = lw.doors.find((d) => d.e.type === ENT.DOOR);
run(lw, walk, 0.6); // onto the lift
run(lw, idle, 3);
assert.equal(liftDoor.t, 1, 'lift went up');
assert.ok(Math.abs(lw.player.pos[1] - 56) < 0.1, `carried to the top: y=${lw.player.pos[1]}`);
run(lw, walk, 3);
assert.ok(lw.doors.find((d) => d.e.type === ENT.ROTATOR).t > 0, 'rotating door opened');
assert.deepEqual(demoExits, [2, 1], `level 2 exits back to level 1: ${lw.player.pos}`);

// Exits never leave the game page.
assert.equal(exitHref({ level: 0, link: '' }, 'P', 'https://g/index.html'), 'https://g/index.html');
assert.equal(exitHref({ level: 1, link: '' }, 'P', 'https://g/index.html'), 'https://g/index.html#P');
assert.equal(exitHref({ level: 3, link: '' }, 'P', 'https://g/index.html'), 'https://g/index.html#P~2');
assert.equal(exitHref({ level: 0, link: 'Q~1' }, 'P', 'https://g/index.html'), 'https://g/index.html#Q~1');

// A sliding door pushes the player out of its way; with a wall behind them it stops instead (no crushing).
const pushLevel = (wallAt) => level([box([-100, -8, -100], [100, 0, 100]), box([-20, 0, -40], [20, 20, -30]), ...(wallAt ? [box([-50, 0, wallAt], [50, 40, wallAt + 8])] : []),
  box([-50, 0, 40], [50, 30, 50], false)], [
  { type: ENT.PLAYER_START, pos: [0, 0, -20], angle: 0 },
  { type: ENT.DOOR, pos: [0, 0, 0], angle: 0, box: 1, dir: 5, dist: 30, speed: 40 },
  { type: ENT.TRIGGER, pos: [0, 0, 0], angle: 0, box: wallAt ? 3 : 2, on: ON.ENTER, once: false, text: '', targets: [1] },
]);
const pw = createWorld(pushLevel(0));
pw.tick(idle, 1 / 120);
pw.doors[0].open = true;
run(pw, idle, 1.5);
assert.equal(pw.doors[0].t, 1);
assert.ok(pw.player.pos[2] >= 0 + 2.5 - 0.1, `pushed ahead of the door: z=${pw.player.pos[2]}`);
const cw = createWorld(pushLevel(-15));
cw.doors[0].open = true;
run(cw, idle, 1.5);
assert.ok(cw.doors[0].t < 0.6, `stopped at the player: t=${cw.doors[0].t}`);
assert.ok(cw.player.pos[2] <= -15 - 2.5 + 0.1, `player stays in front of the wall: z=${cw.player.pos[2]}`);

// A rotating door turns about its hinge edge: 90° counter-clockwise from above swings +x towards -z.
const rot = level([box([-100, -8, -100], [100, 0, 100]), box([0, 0, 0], [20, 30, 2])], [
  { type: ENT.PLAYER_START, pos: [50, 0, 50], angle: 0 },
  { type: ENT.ROTATOR, pos: [0, 0, 0], angle: 0, box: 1, axis: 1, edge: 0, turn: 90, speed: 90 },
]);
const rw = createWorld(rot);
rw.doors[0].open = true;
rw.doors[0].auto = false;
run(rw, idle, 1.5);
const m = rw.models()[0], at = (p) => [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
assert.ok(at([20, 0, 0]).every((v, k) => Math.abs(v - [0, 0, -20][k]) < 1e-9), `far edge swung to -z: ${at([20, 0, 0])}`);
// It blocks the player where it now stands, and not where it was.
rw.player.pos = [10, 0, 5];
run(rw, walk, 1);
assert.ok(rw.player.pos[2] < -25, `walks through the opened doorway: z=${rw.player.pos[2]}`);
rw.player.pos = [-10, 0, -10];
rw.player.vel = [0, 0, 0];
run(rw, { forward: 0, right: 1, jump: false }, 1);
assert.ok(rw.player.pos[0] < 0, `blocked by the opened door: x=${rw.player.pos[0]}`);

// Trigger volumes use the real shape: a wedge only fires where it actually is.
const wedge = box([0, 0, 0], [40, 20, 40], false);
wedge.shape = Array.from({ length: 8 }, (_, i) => [0, (i & 2) && (i & 4) ? -20 : 0, 0]); // top slopes down to +z
const said2 = [];
const tw = createWorld(level([box([-100, -8, -100], [100, 0, 100]), wedge], [
  { type: ENT.PLAYER_START, pos: [20, 0, 60], angle: 0 },
  { type: ENT.TRIGGER, pos: [0, 0, 0], angle: 0, box: 1, on: ON.ENTER, once: false, text: '', targets: [2] },
  { type: ENT.MESSAGE, pos: [0, 0, 0], angle: 0, text: 'in' },
]), { message: (t) => said2.push(t) });
tw.player.pos = [20, 19, 39]; // inside the bounding box, above the slope
run(tw, idle, 0.01);
assert.deepEqual(said2, [], 'above the slope is outside the wedge');
tw.player.pos = [20, 0, 10];
run(tw, idle, 0.01);
assert.deepEqual(said2, ['in']);

// Usable and shootable boxes (demo level 1): the button on the west wall, the target on the north wall.
const said3 = [];
const uw = createWorld(demoLevel(), { message: (t) => said3.push(t) });
const aim = (w, pos, yaw, pitch) => Object.assign(w.player, { pos, yaw, pitch });
aim(uw, [0, 0, 0], 0, Math.atan2(36 - 12.5, 126));
assert.equal(uw.usable(), null, 'the target is not usable, and too far anyway');
uw.use();
uw.shoot();
assert.deepEqual(said3, ['Nice shot!']);
aim(uw, [0, 0, 0], 0, 0);
uw.shoot(); // below the target: the wall
aim(uw, [0, 0, -150], Math.PI, Math.atan2(36 - 12.5, 23));
uw.shoot(); // from behind the north wall: the wall is in the way
aim(uw, [-100, 0, -16], Math.PI / 2, 0);
assert.equal(uw.usable(), null, 'the button is out of reach');
aim(uw, [-118, 0, -16], Math.PI / 2, 0);
assert.equal(uw.usable().text, 'E: press the button');
uw.use();
uw.shoot(); // the button is not shootable
assert.deepEqual(said3, ['Nice shot!', 'You pressed the button.']);

// A shootable rotating door that opens when shot: the ray hits it where it is now, not where it was.
const said4 = [];
const sw = createWorld(level([box([-100, -8, -100], [100, 0, 100]), box([-12, 0, -20], [12, 24, -18])], [
  { type: ENT.PLAYER_START, pos: [0, 0, 10], angle: 0 },
  { type: ENT.ROTATOR, pos: [0, 0, 0], angle: 0, box: 1, axis: 1, edge: 0, turn: 90, speed: 90 },
  { type: ENT.TRIGGER, pos: [0, 0, 0], angle: 0, box: 1, on: ON.SHOOT, once: false, text: '', targets: [1, 3] },
  { type: ENT.MESSAGE, pos: [0, 0, 0], angle: 0, text: 'hit' },
]), { message: (t) => said4.push(t) });
sw.shoot();
run(sw, idle, 2);
assert.equal(sw.doors[0].t, 1, 'shot door opened');
sw.shoot(); // straight ahead: the door swung out of the way (to x -12..-10, z -44..-20)
assert.deepEqual(said4, ['hit']);
sw.player.yaw = Math.atan2(11, 40); // towards x -11, z -30
sw.shoot();
assert.deepEqual(said4, ['hit', 'hit']);

// Once: a use or shoot trigger fires the first time only, and a spent use trigger shows no prompt.
const said5 = [];
const once = demoLevel();
for (const e of once.entities) if (e.type === ENT.TRIGGER) e.once = true;
const ow = createWorld(once, { message: (t) => said5.push(t) });
aim(ow, [0, 0, 0], 0, Math.atan2(36 - 12.5, 126));
ow.shoot();
ow.shoot();
aim(ow, [-118, 0, -16], Math.PI / 2, 0);
assert.ok(ow.usable());
ow.use();
assert.equal(ow.usable(), null, 'spent');
ow.use();
assert.deepEqual(said5, ['Nice shot!', 'You pressed the button.']);

console.log('world: ok');
