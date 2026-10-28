// Built-in texture recipes. Most build a height field first, then Colorize maps height to color, then Shade.
import { OPS } from './texgen.js';

const CODE = {};
for (const [code, spec] of Object.entries(OPS)) CODE[spec.name] = Number(code);
const o = (name, ...args) => ({ op: CODE[name], args: args.flat() });
const ref = (name) => ({ ref: name }); // resolved to a texture number by insertPreset

export const PRESETS = [
  {
    name: 'Brick wall',
    size: 64,
    ops: [
      o('Bricks', 4, 8, 40, 128, 1),
      o('Noise', 2, 8, 4, 140),
      o('Multiply', 90),
      o('Colorize', [0, 70, 66, 60], [100, 90, 40, 30], [255, 175, 85, 60]),
      o('Shade', 140),
    ],
  },
  {
    name: 'Metal panel',
    size: 64,
    ops: [
      o('Rounded rect', 10, 10, 245, 245, 16),
      o('Bevel', 4, 0),
      o('Noise', 3, 16, 3, 110),
      o('Multiply', 50),
      o('Circle', 28, 28, 10),
      o('Circle', 227, 28, 10),
      o('Add', 255),
      o('Circle', 28, 227, 10),
      o('Add', 255),
      o('Circle', 227, 227, 10),
      o('Add', 255),
      o('Bevel', 2, 0),
      o('Over', 255),
      o('Colorize', [0, 35, 37, 40], [160, 95, 100, 106], [255, 150, 156, 162]),
      o('Shade', 120),
    ],
  },
  {
    name: 'Wood planks',
    size: 64,
    ops: [
      o('Stripes', 0, 24, 255),
      o('Warp', 6, 24, 3),
      o('Noise', 9, 2, 3, 120),
      o('Multiply', 120),
      o('Bricks', 2, 4, 14, 128, 4),
      o('Multiply', 255),
      o('Colorize', [0, 35, 22, 12], [90, 95, 60, 32], [255, 170, 115, 65]),
      o('Shade', 70),
    ],
  },
  {
    name: 'Door',
    size: 64,
    ops: [
      ref('Wood planks'),
      o('Rect', 0, 30, 255, 56),
      o('Colorize', [0, 0, 0, 0], [255, 55, 55, 60]),
      o('Over', 255),
      o('Rect', 0, 199, 255, 225),
      o('Colorize', [0, 0, 0, 0], [255, 55, 55, 60]),
      o('Over', 255),
      o('Circle', 215, 128, 12),
      o('Bevel', 3, 0),
      o('Colorize', [0, 90, 70, 20], [255, 220, 180, 70]),
      o('Over', 255),
      o('Shade', 110),
    ],
  },
  {
    name: 'Window',
    size: 64,
    transparent: true, // glass: mask 0 + 80/255 from the final Add; frame: mask 1
    ops: [
      o('Gradient', 0, 0, 0, 255, 255),
      o('Colorize', [0, 110, 140, 170], [255, 30, 45, 65]),
      o('Invert', 2),
      o('Bricks', 2, 2, 70, 0, 1),
      o('Threshold', 40, 10),
      o('Invert', 3),
      o('Bevel', 3, 0),
      o('Colorize', [0, 60, 45, 30], [255, 130, 100, 70]),
      o('Over', 255),
      o('Fill', 0, 0, 0, 0),
      o('Add', 80),
      o('Shade', 120),
    ],
  },
  {
    name: 'Stone floor',
    size: 64,
    ops: [
      o('Cells', 7, 4, 1),
      o('Threshold', 20, 30),
      o('Cells', 7, 4, 2),
      o('Multiply', 100),
      o('Noise', 8, 8, 5, 150),
      o('Multiply', 110),
      o('Colorize', [0, 30, 28, 26], [120, 85, 82, 76], [255, 150, 146, 138]),
      o('Shade', 140),
    ],
  },
  {
    name: 'Grate',
    size: 64,
    ops: [
      o('Stripes', 6, 0, 60),
      o('Threshold', 150, 40),
      o('Stripes', 0, 6, 60),
      o('Threshold', 150, 40),
      o('Add', 255),
      o('Blur', 1),
      o('Colorize', [0, 12, 12, 12], [128, 60, 62, 66], [255, 125, 130, 136]),
      o('Shade', 160),
    ],
  },
  {
    name: 'Crate',
    size: 64,
    ops: [
      ref('Wood planks'),
      o('Rect', 0, 0, 255, 255),
      o('Rect', 36, 36, 219, 219),
      o('Subtract', 255),
      o('Line', 36, 36, 219, 219, 30),
      o('Add', 255),
      o('Bevel', 3, 0),
      o('Colorize', [0, 80, 52, 25], [255, 160, 112, 62]),
      o('Over', 255),
      o('Shade', 120),
    ],
  },
];

// Appends the preset (and any preset it references) to `textures`, reusing identical existing slots.
// Returns its texture number (1-based, as used by faces).
export function insertPreset(textures, name) {
  const p = PRESETS.find((x) => x.name === name);
  const ops = p.ops.map((x) => (x.ref ? { op: CODE.Reference, args: [insertPreset(textures, x.ref)] } : { op: x.op, args: [...x.args] }));
  const tex = p.transparent ? { size: p.size, transparent: true, ops } : { size: p.size, ops };
  const json = JSON.stringify(tex);
  const existing = textures.findIndex((t) => JSON.stringify(t) === json);
  if (existing >= 0) return existing + 1;
  textures.push(tex);
  return textures.length;
}
