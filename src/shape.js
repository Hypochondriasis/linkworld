// Box shapes. A plain box is its min/max. A shaped box also has `shape`: 8 integer offsets, one per corner,
// that move each corner inward from its box corner. Corner i is at max on axis k when bit k of i is set.
// The solid is the convex hull of the 8 corners, so every shape is valid as long as it has volume.
// All hull math is exact integer arithmetic (coordinates ≤ 32768, so products stay below 2^53).
// Also home of the few vector helpers the rest of the engine shares.

export const cornerBase = (b, i) => [0, 1, 2].map((k) => (i >> k) & 1 ? b.max[k] : b.min[k]);

export function corners(b) {
  return Array.from({ length: 8 }, (_, i) => {
    const p = cornerBase(b, i);
    return b.shape ? p.map((v, k) => v + b.shape[i][k]) : p;
  });
}

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
// Unit view direction for yaw/pitch in radians: yaw 0 looks down -z, yaw +90° down -x, pitch up is positive.
export const forward = (yaw, pitch) => [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
const gcd = (a, b) => (b ? gcd(b, a % b) : Math.abs(a));

// Convex hull of a few integer points: { faces: [{ n: integer outward normal, verts: CCW from outside }] },
// or null when the points have no volume. Brute force over triples, fine for 8 points.
export function convexHull(points) {
  const pts = [];
  for (const p of points) if (!pts.some((q) => q[0] === p[0] && q[1] === p[1] && q[2] === p[2])) pts.push(p);
  const faces = new Map();
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      for (let k = j + 1; k < pts.length; k++) {
        let n = cross(sub(pts[j], pts[i]), sub(pts[k], pts[i]));
        if (!n[0] && !n[1] && !n[2]) continue;
        const g = gcd(gcd(n[0], n[1]), n[2]);
        n = n.map((v) => v / g);
        let d = dot(n, pts[i]);
        let above = 0, below = 0;
        for (const p of pts) {
          const s = dot(n, p) - d;
          if (s > 0) above++;
          else if (s < 0) below++;
        }
        if (above && below) continue;
        if (!above && !below) return null; // everything coplanar
        if (above) { n = n.map((v) => -v); d = -d; }
        const key = n.join(',');
        if (!faces.has(key)) faces.set(key, { n, d });
      }
    }
  }
  if (faces.size < 4) return null;
  return {
    faces: [...faces.values()].map(({ n, d }) => {
      const on = pts.filter((p) => dot(n, p) === d);
      const c = [0, 1, 2].map((k) => on.reduce((s, p) => s + p[k], 0) / on.length);
      const u = sub(on[0], c), w = cross(n, u);
      const ang = (p) => { const q = sub(p, c); return Math.atan2(dot(q, w), dot(q, u)); };
      return { n, verts: on.sort((a, b) => ang(a) - ang(b)) };
    }),
  };
}

export const hullOf = (b) => convexHull(corners(b));

// Which of the box's 6 face slots (texture settings) a hull face uses: the one its normal points closest to.
export function faceSlot(n) {
  const a = [0, 1, 2].reduce((best, k) => (Math.abs(n[k]) > Math.abs(n[best]) ? k : best), 0);
  return a * 2 + (n[a] > 0 ? 1 : 0);
}

// Allowed offset range for corner i on axis k: corners only move inward, at most the box size.
export function offsetRange(b, i, k) {
  const size = b.max[k] - b.min[k];
  return (i >> k) & 1 ? [-size, 0] : [0, size];
}

// Moves corners to absolute positions ({ index: [x,y,z] }). The box grows to contain them; other corners
// stay where they are. Returns false (and leaves the box unchanged) if the result would have no volume.
export function setCorners(b, moves) {
  const pts = corners(b);
  for (const i in moves) pts[i] = moves[i];
  if (!convexHull(pts)) return false;
  b.min = [0, 1, 2].map((k) => Math.min(...pts.map((p) => p[k])));
  b.max = [0, 1, 2].map((k) => Math.max(...pts.map((p) => p[k])));
  const shape = pts.map((p, c) => sub(p, cornerBase(b, c)));
  if (shape.some((o) => o.some((v) => v))) b.shape = shape;
  else delete b.shape;
  return true;
}
// Editor drags: remember a box's geometry and put it back (e.g. when a move would flatten the shape).
export const saveShape = (b) => JSON.stringify({ min: b.min, max: b.max, shape: b.shape });
export function restoreShape(b, json) {
  const o = JSON.parse(json);
  b.min = o.min;
  b.max = o.max;
  if (o.shape) b.shape = o.shape;
  else delete b.shape;
}
export const setCorner = (b, i, pos) => setCorners(b, { [i]: pos });

// After min/max changed (resize), pull offsets back into range. Returns false if the shape lost its volume.
export function fitShape(b) {
  if (!b.shape) return true;
  b.shape = b.shape.map((o, i) => o.map((v, k) => { const [lo, hi] = offsetRange(b, i, k); return Math.max(lo, Math.min(hi, v)); }));
  if (!b.shape.some((o) => o.some((v) => v))) delete b.shape;
  return !!hullOf(b);
}
