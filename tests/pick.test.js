import assert from 'node:assert/strict';
import { rayDir, pickBox } from '../src/editor/pick.js';

const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

// Screen center looks straight ahead: yaw 0 is -z, yaw 90° is -x, pitch up is +y.
assert.ok(close(rayDir({ yaw: 0, pitch: 0 }, 0, 0, 1), [0, 0, -1]));
assert.ok(close(rayDir({ yaw: Math.PI / 2, pitch: 0 }, 0, 0, 1), [-1, 0, 0]));
const up = rayDir({ yaw: 0, pitch: 0.5 }, 0, 0, 1);
assert.ok(up[1] > 0 && up[2] < 0);
// Right half of the screen leans to +x at yaw 0.
assert.ok(rayDir({ yaw: 0, pitch: 0 }, 0.5, 0, 1)[0] > 0);

const boxes = [
  { min: [-10, -10, -30], max: [10, 10, -20] }, // in front
  { min: [-10, -10, -60], max: [10, 10, -50] }, // behind it
  { min: [-100, -100, -100], max: [100, 100, 100] }, // contains the camera: skipped
];
// Looking down -z we enter box 0 through its +z face (index 5) at t = 20.
assert.deepEqual(pickBox(boxes, [0, 0, 0], [0, 0, -1]), { box: 0, face: 5, t: 20 });
// From the side (+x looking -x) we hit the +x face (1).
assert.equal(pickBox(boxes.slice(0, 2), [50, 0, -25], [-1, 0, 0]).face, 1);
// From above looking down: +y face (3).
assert.equal(pickBox(boxes.slice(0, 2), [0, 50, -25], [0, -1, 0]).face, 3);
// Missing everything.
assert.equal(pickBox(boxes.slice(0, 2), [0, 50, 0], [0, 1, 0]), null);

console.log('pick: ok');

// Shaped box: a wedge whose top slopes down towards +z. Looking down from above at its sloped part
// hits the slope, which uses the top (+y) face slot; from the +z side at low height it hits the front.
{
  const s = Array.from({ length: 8 }, () => [0, 0, 0]);
  s[6] = [0, -8, 0];
  s[7] = [0, -8, 0];
  const wedge = { min: [0, 0, 0], max: [8, 8, 8], shape: s };
  const top = pickBox([wedge], [4, 50, 6], [0, -1, 0]);
  assert.equal(top.face, 3);
  assert.ok(top.t > 50 - 8 && top.t < 50 - 1, `hit the slope, below the bounding box top: ${top.t}`);
  assert.equal(pickBox([wedge], [4, 50, 6.5], [0, -1, 0]).box, 0);
  // Along -z at y=7 the slope is reached at z=1 (t=49), not at the bounding box front z=8 (t=42).
  assert.equal(pickBox([wedge], [4, 7, 50], [0, 0, -1]).t, 49);
  console.log('pick shaped: ok');
}

// project() inverts rayDir: a point along a ray projects back to that ray's screen position.
{
  const { project, rayToAxis } = await import('../src/editor/pick.js');
  const cam = { pos: [5, 20, 30], yaw: 0.7, pitch: -0.3 };
  for (const [nx, ny] of [[0, 0], [0.5, -0.2], [-0.9, 0.8]]) {
    const d = rayDir(cam, nx, ny, 1.6);
    const p = cam.pos.map((v, k) => v + d[k] * 37);
    const back = project(cam, p, 1.6);
    assert.ok(Math.abs(back[0] - nx) < 1e-9 && Math.abs(back[1] - ny) < 1e-9, `${back} vs ${nx},${ny}`);
  }
  assert.equal(project({ pos: [0, 0, 0], yaw: 0, pitch: 0 }, [0, 0, 5], 1), null, 'behind the camera');
  // A ray from the origin through (3, 7, -10) passes the axis lines through that point exactly there.
  const d = [3, 7, -10];
  assert.ok(Math.abs(rayToAxis([0, 0, 0], d, [3, 0, -10], 1) - 7) < 1e-9);
  assert.ok(Math.abs(rayToAxis([0, 0, 0], d, [0, 7, -10], 0) - 3) < 1e-9);
  assert.ok(Math.abs(rayToAxis([0, 0, 0], d, [3, 7, 0], 2) + 10) < 1e-9);
  assert.equal(rayToAxis([0, 0, 0], [0, 1, 0], [0, 5, 0], 1), null, 'ray along the axis');
  console.log('pick project: ok');
}
