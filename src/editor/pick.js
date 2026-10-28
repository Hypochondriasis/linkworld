// Ray picking for the 3D view: which box face is under the mouse.
import { FOVY } from '../render.js';
import { hullOf, faceSlot, dot } from '../shape.js';

// Ray direction through normalized device coords (nx, ny in -1..1) for camera { yaw, pitch }.
export function rayDir(cam, nx, ny, aspect) {
  const t = Math.tan(FOVY / 2);
  const [x, y0, z0] = [nx * t * aspect, ny * t, -1];
  // Pitch about x, then yaw about y (same as the view matrix, inverted).
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch), cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
  const y = y0 * cp - z0 * sp, z = y0 * sp + z0 * cp;
  return [x * cy + z * sy, y, -x * sy + z * cy];
}

// World point -> normalized device coords [nx, ny] (the inverse of rayDir), or null when behind the camera.
export function project(cam, p, aspect) {
  const d = [p[0] - cam.pos[0], p[1] - cam.pos[1], p[2] - cam.pos[2]];
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch), cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
  // Undo yaw, then pitch.
  const x = d[0] * cy - d[2] * sy, z1 = d[0] * sy + d[2] * cy;
  const y = d[1] * cp + z1 * sp, z = -d[1] * sp + z1 * cp;
  if (z > -1e-6) return null;
  const t = Math.tan(FOVY / 2);
  return [x / (-z * t * aspect), y / (-z * t)];
}

// Closest point to the ray on the axis-k line through c: returns that point's coordinate on axis k,
// or null when the ray runs along the axis.
export function rayToAxis(o, d, c, k) {
  const w = [o[0] - c[0], o[1] - c[1], o[2] - c[2]];
  const a = d[0] * d[0] + d[1] * d[1] + d[2] * d[2], b = d[k];
  const denom = a - b * b;
  if (denom < 1e-9 * a) return null;
  return c[k] + (a * w[k] - b * (d[0] * w[0] + d[1] * w[1] + d[2] * w[2])) / denom;
}

// Nearest box the ray enters: { box, face, t } with face in box face order (-x +x -y +y -z +z), or null.
// Boxes containing the ray origin are skipped, so the camera can sit inside a room box.
export function pickBox(boxes, origin, dir) {
  let best = null;
  boxes.forEach((b, i) => {
    if (b.shape) {
      const hit = rayHull(hullOf(b), origin, dir);
      if (hit && (!best || hit.t < best.t)) best = { box: i, ...hit };
      return;
    }
    let tmin = -Infinity, tmax = Infinity, axis = -1;
    for (let k = 0; k < 3; k++) {
      if (Math.abs(dir[k]) < 1e-12) {
        if (origin[k] < b.min[k] || origin[k] > b.max[k]) return;
        continue;
      }
      let t0 = (b.min[k] - origin[k]) / dir[k], t1 = (b.max[k] - origin[k]) / dir[k];
      if (t0 > t1) [t0, t1] = [t1, t0];
      if (t0 > tmin) { tmin = t0; axis = k; }
      tmax = Math.min(tmax, t1);
    }
    if (tmin > tmax || tmin <= 0 || axis < 0) return;
    if (!best || tmin < best.t) best = { box: i, face: axis * 2 + (dir[axis] > 0 ? 0 : 1), t: tmin };
  });
  return best;
}

// Ray vs convex hull (planes from its faces): entry point and the face slot of the plane entered.
function rayHull(hull, o, d) {
  let enter = -Infinity, leave = Infinity, n = null;
  for (const f of hull.faces) {
    const d1 = dot(f.n, o) - dot(f.n, f.verts[0]), dn = dot(f.n, d);
    if (Math.abs(dn) < 1e-12) {
      if (d1 > 0) return null;
      continue;
    }
    const t = -d1 / dn;
    if (dn < 0) { if (t > enter) { enter = t; n = f.n; } }
    else leave = Math.min(leave, t);
  }
  if (enter > leave || enter <= 0 || !n) return null;
  return { face: faceSlot(n), t: enter };
}
