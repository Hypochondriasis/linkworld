// Hardcoded demo pack, also used by tests. Level 1: a lit room with stairs, jump blocks, pillars, a door to an
// open courtyard, a welcome message, a trigger on the stair platform, a button (E), a target to shoot, a ramp
// and an exit to level 2.
// Level 2: a lift up to a ledge and a rotating door to an exit back to level 1.
import { ENT, ON } from './format.js';
import { insertPreset } from './presets.js';

const box = (min, max, tex, solid = true) => ({ min, max, solid, faces: Array.from({ length: 6 }, () => ({ tex, scale: 16, ox: 0, oy: 0 })) });

export function demoLevel() {
  const textures = [];
  const FLOOR = insertPreset(textures, 'Stone floor'), WALL = insertPreset(textures, 'Brick wall'), TRIM = insertPreset(textures, 'Metal panel');
  const boxes = [
    // Room
    box([-128, -8, -128], [128, 0, 128], FLOOR),
    box([-136, -8, -136], [-128, 64, 136], WALL),
    box([128, -8, -136], [136, 64, 136], WALL),
    box([-128, -8, -136], [128, 64, -128], WALL),
    box([-128, -8, 128], [-16, 64, 136], WALL),
    box([16, -8, 128], [128, 64, 136], WALL),
    box([-16, 32, 128], [16, 64, 136], WALL),
    box([-136, 64, -136], [136, 72, 136], TRIM),
    // Platform reached by 2-unit stairs
    box([40, 0, -128], [120, 16, -88], TRIM),
    // Jump blocks: 4 units is above the 3-unit step height
    box([-100, 0, -100], [-60, 4, -60], TRIM),
    box([-90, 4, -90], [-70, 12, -70], TRIM),
    // Pillars
    box([-54, 0, 42], [-42, 64, 54], WALL),
    box([42, 0, 42], [54, 64, 54], WALL),
    // Non-solid decoration: walk through it
    box([-4, 0, 60], [4, 8, 68], 0, false),
    // Courtyard (open sky)
    box([-64, -8, 128], [64, 0, 264], FLOOR), // starts under the doorway so there is no gap
    box([-72, -8, 136], [-64, 24, 272], WALL),
    box([64, -8, 136], [72, 24, 272], WALL),
    box([-64, -8, 264], [64, 24, 272], WALL),
  ];
  for (let k = 0; k < 7; k++) boxes.push(box([40, 0, -88 + 8 * k], [120, 14 - 2 * k, -80 + 8 * k], TRIM));
  const DOORTEX = insertPreset(textures, 'Door'), GRATE = insertPreset(textures, 'Grate');
  const add = (b) => boxes.push(b) - 1;
  const door = add(box([-16, 0, 129], [16, 32, 135], DOORTEX)); // in the courtyard doorway, under the lintel
  const stairTop = add(box([40, 16, -128], [120, 32, -88], 0, false)); // trigger volume on the platform
  add(box([-16, 0, 262], [16, 2, 264], GRATE)); // marks the exit
  const exit = add(box([-16, 0, 250], [16, 24, 264], 0, false));
  // Courtyard: a ramp (a shaped box: its +z top corners pulled down to the floor) up to a ledge.
  add(box([30, 0, 140], [60, 16, 170], TRIM));
  const ramp = box([30, 0, 170], [60, 16, 240], TRIM);
  ramp.shape = Array.from({ length: 8 }, (_, i) => [0, (i & 2) && (i & 4) ? -16 : 0, 0]);
  add(ramp);
  const button = add(box([-128, 10, -20], [-126, 18, -12], TRIM)); // on the west wall
  const target = add(box([-12, 24, -128], [12, 48, -126], GRATE)); // on the north wall, ahead of the start

  return {
    name: 'Demo',
    ambient: [40, 40, 48],
    fog: [90, 110, 140],
    fogDist: 600,
    textures,
    boxes,
    entities: [
      { type: ENT.PLAYER_START, pos: [0, 0, 0], angle: 0 },
      { type: ENT.LIGHT, pos: [0, 48, 0], angle: 0, color: [255, 220, 170], radius: 160 },
      { type: ENT.LIGHT, pos: [80, 40, -100], angle: 0, color: [120, 160, 255], radius: 100 },
      { type: ENT.LIGHT, pos: [-80, 40, 60], angle: 0, color: [255, 90, 70], radius: 100 },
      { type: ENT.LIGHT, pos: [0, 40, 200], angle: 0, color: [220, 230, 255], radius: 150 },
      { type: ENT.LIGHT, pos: [0, 12, 256], angle: 0, color: [120, 255, 160], radius: 40 },
      { type: ENT.MESSAGE, pos: [0, 0, 8], angle: 0, text: 'WELCOME TO LINKWORLD' },
      { type: ENT.DOOR, pos: [0, 16, 132], angle: 0, box: door, dir: 3, dist: 30, speed: 40 },
      { type: ENT.TRIGGER, pos: [80, 24, -108], angle: 0, box: stairTop, on: ON.ENTER, once: false, text: '', targets: [9] },
      { type: ENT.MESSAGE, pos: [80, 16, -108], angle: 0, text: 'You climbed the stairs. The exit is in the courtyard.' },
      { type: ENT.EXIT, pos: [0, 12, 257], angle: 0, box: exit, level: 2, link: '' },
      { type: ENT.TRIGGER, pos: [-127, 14, -16], angle: 0, box: button, on: ON.USE, once: false, text: 'E: press the button', targets: [12] },
      { type: ENT.MESSAGE, pos: [-120, 14, -16], angle: 0, text: 'You pressed the button.' },
      { type: ENT.TRIGGER, pos: [0, 36, -127], angle: 0, box: target, on: ON.SHOOT, once: false, text: '', targets: [14] },
      { type: ENT.MESSAGE, pos: [0, 36, -120], angle: 0, text: 'Nice shot!' },
    ],
  };
}

export function liftLevel() {
  const textures = [];
  const FLOOR = insertPreset(textures, 'Stone floor'), WALL = insertPreset(textures, 'Brick wall'), TRIM = insertPreset(textures, 'Metal panel');
  const DOORTEX = insertPreset(textures, 'Door');
  const boxes = [
    box([-64, -8, -64], [64, 0, 64], FLOOR),
    box([-72, -8, -72], [-64, 104, 72], WALL),
    box([64, -8, -72], [72, 104, 72], WALL),
    box([-64, -8, -72], [64, 104, -64], WALL),
    box([-64, -8, 64], [64, 104, 72], WALL),
    box([-64, 96, -64], [64, 104, 64], TRIM),
    box([-64, 48, -64], [64, 56, -24], TRIM), // ledge
    // Wall across the ledge with a doorway; the alcove behind it holds the exit.
    box([-64, 56, -48], [-12, 96, -44], WALL),
    box([12, 56, -48], [64, 96, -44], WALL),
    box([-12, 80, -48], [12, 96, -44], WALL),
  ];
  const add = (b) => boxes.push(b) - 1;
  // A lift: a door moving up, started by a trigger inside its footprint (so only standing on it starts it).
  const lift = add(box([-16, 0, -24], [16, 3, 0], TRIM));
  const liftTop = add(box([-12, 3, -20], [12, 20, -4], 0, false));
  const door = add(box([-12, 56, -47], [12, 80, -45], DOORTEX));
  const exit = add(box([-64, 56, -64], [64, 80, -52], 0, false));
  return {
    name: 'Demo: lift',
    ambient: [36, 36, 44],
    fog: [20, 20, 28],
    fogDist: 0,
    textures,
    boxes,
    entities: [
      { type: ENT.PLAYER_START, pos: [0, 0, 40], angle: 0 },
      { type: ENT.LIGHT, pos: [0, 80, 24], angle: 0, color: [255, 220, 170], radius: 150 },
      { type: ENT.LIGHT, pos: [0, 72, -34], angle: 0, color: [150, 180, 255], radius: 60 },
      { type: ENT.LIGHT, pos: [0, 64, -58], angle: 0, color: [120, 255, 160], radius: 40 },
      { type: ENT.MESSAGE, pos: [0, 0, 30], angle: 0, text: 'Step on the lift, then go through the door.' },
      { type: ENT.DOOR, pos: [0, 2, -12], angle: 0, box: lift, dir: 3, dist: 53, speed: 24 },
      { type: ENT.TRIGGER, pos: [0, 12, -12], angle: 0, box: liftTop, on: ON.ENTER, once: false, text: '', targets: [5] },
      { type: ENT.ROTATOR, pos: [0, 68, -46], angle: 0, box: door, axis: 1, edge: 0, turn: 90, speed: 90 },
      { type: ENT.EXIT, pos: [0, 60, -58], angle: 0, box: exit, level: 1, link: '' },
    ],
  };
}

export const demoPack = () => ({ levels: [demoLevel(), liftLevel()] });
