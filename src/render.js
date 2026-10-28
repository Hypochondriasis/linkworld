// WebGL 1 renderer: static per-texture vertex buffers, baked lightmaps (light.js), linear fog.
import { hullOf, faceSlot, cross, forward } from './shape.js';
import { bakeLight } from './light.js';
import { projectUV } from './model.js';

export const FOVY = 1.3; // vertical field of view, radians

const VS = `
attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec2 aUV;
attribute vec2 aLM;
uniform mat4 uViewProj;
uniform mat4 uModel; // moving boxes (doors); identity for the rest
varying vec3 vPos;
varying vec3 vNormal; // in the box's own (resting) frame, like its baked light
varying vec2 vUV;
varying vec2 vLM;
void main() {
  vPos = (uModel * vec4(aPos, 1.0)).xyz;
  vNormal = aNormal;
  vUV = aUV;
  vLM = aLM;
  gl_Position = uViewProj * vec4(vPos, 1.0);
}`;

// highp where available: mediump world positions band badly a few hundred units out.
const FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uTex; // alpha = height, for normal mapping
uniform sampler2D uLight; // baked light / 2
uniform sampler2D uLightDir; // main direction of the baked light, * 0.5 + 0.5
uniform vec2 uBump; // slope per height step (0 = flat), texel size
uniform vec3 uAmbient;
uniform vec3 uEye;
uniform vec3 uFogColor;
uniform float uFogDist;
varying vec3 vPos;
varying vec3 vNormal;
varying vec2 vUV;
varying vec2 vLM;
void main() {
  vec3 n = normalize(vNormal);
  vec3 light = texture2D(uLight, vLM).rgb * 2.0;
  if (uBump.x > 0.0) {
    // Tangents of the world-axis UV projection in render.js uv(); the axis picks like shape.js faceSlot.
    vec3 m = abs(n), t = vec3(1.0, 0.0, 0.0), b = vec3(0.0, -1.0, 0.0);
    if (m.x >= m.y && m.x >= m.z) t = vec3(0.0, 0.0, 1.0);
    else if (m.y >= m.z) b = vec3(0.0, 0.0, 1.0);
    vec2 e = vec2(uBump.y, 0.0);
    float du = texture2D(uTex, vUV + e.xy).a - texture2D(uTex, vUV - e.xy).a;
    float dv = texture2D(uTex, vUV + e.yx).a - texture2D(uTex, vUV - e.yx).a;
    // The baked light already holds the flat face's n·l; rescale it by how the bumped normal faces the light.
    vec3 ld = texture2D(uLightDir, vLM).rgb * 2.0 - 1.0;
    vec3 bn = normalize(n - uBump.x * (du * t + dv * b));
    light *= clamp(max(dot(bn, ld), 0.0) / max(dot(n, ld), 0.2), 0.0, 2.0);
  }
  vec4 t = texture2D(uTex, vUV);
  vec3 c = t.rgb * (uAmbient + light);
  if (uFogDist > 0.0) c = mix(c, uFogColor, clamp(length(vPos - uEye) / uFogDist, 0.0, 1.0));
  gl_FragColor = vec4(c, uBump.x > 0.0 ? 1.0 : t.a); // bumped textures keep height in alpha
}`;

// Particles: camera-facing quads, unlit, fading out over their life. Drawn after the scene, no depth writes.
const PART_VS = `
attribute vec3 aPos;
attribute vec3 aUVA; // u, v, alpha
uniform mat4 uViewProj;
varying vec3 vUVA;
varying vec3 vPos;
void main() {
  vUVA = aUVA;
  vPos = aPos;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;
const PART_FS = `
precision mediump float;
uniform sampler2D uTex;
uniform float uUseAlpha; // 1 = transparent texture (alpha = opacity), 0 = alpha holds height
uniform float uAdd; // additive: fog fades the particle out instead of tinting it
uniform vec3 uEye;
uniform vec3 uFogColor;
uniform float uFogDist;
varying vec3 vUVA;
varying vec3 vPos;
void main() {
  vec4 t = texture2D(uTex, vUVA.xy);
  float a = mix(1.0, t.a, uUseAlpha) * vUVA.z;
  vec3 c = t.rgb;
  if (uFogDist > 0.0) {
    float f = clamp(length(vPos - uEye) / uFogDist, 0.0, 1.0);
    if (uAdd > 0.5) a *= 1.0 - f; else c = mix(c, uFogColor, f);
  }
  gl_FragColor = vec4(c, a);
}`;

// Editor overlays (selection outlines, picked faces): flat color, drawn on top of the scene.
const OVERLAY_VS = `
attribute vec3 aPos;
uniform mat4 uViewProj;
void main() { gl_Position = uViewProj * vec4(aPos, 1.0); }`;
const OVERLAY_FS = `
precision mediump float;
uniform vec4 uColor;
void main() { gl_FragColor = uColor; }`;

export function createRenderer(canvas) {
  const gl = canvas.getContext('webgl', { antialias: false }) || canvas.getContext('experimental-webgl');
  if (!gl) throw new Error('WebGL is not available in this browser');

  const prog = program(gl, VS, FS);
  const loc = {};
  const ATTRS = ['aPos', 'aNormal', 'aUV', 'aLM'];
  for (const n of ATTRS) loc[n] = gl.getAttribLocation(prog, n);
  for (const n of ['uViewProj', 'uModel', 'uTex', 'uLight', 'uLightDir', 'uBump', 'uAmbient', 'uEye', 'uFogColor', 'uFogDist']) loc[n] = gl.getUniformLocation(prog, n);

  const overlayProg = program(gl, OVERLAY_VS, OVERLAY_FS);
  const oloc = { aPos: gl.getAttribLocation(overlayProg, 'aPos'), uViewProj: gl.getUniformLocation(overlayProg, 'uViewProj'), uColor: gl.getUniformLocation(overlayProg, 'uColor') };
  const overlayBuf = gl.createBuffer();

  const partProg = program(gl, PART_VS, PART_FS);
  const ploc = {};
  for (const n of ['aPos', 'aUVA']) ploc[n] = gl.getAttribLocation(partProg, n);
  for (const n of ['uViewProj', 'uTex', 'uUseAlpha', 'uAdd', 'uEye', 'uFogColor', 'uFogDist']) ploc[n] = gl.getUniformLocation(partProg, n);
  const partBuf = gl.createBuffer();

  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE);
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE); // keep the canvas opaque

  let batches = []; // { tex, bump, blend, buf, count, dyn: index into opts.dynamic or -1 }; blended ones last
  let textures = [];
  let level = null;
  let images = null;
  let lightTex = [];

  // images[i] is the texture for face tex index i: { width, height, data: Uint8ClampedArray RGBA }.
  // The same images array as last time (texgen memoizes) keeps its GL textures.
  // opts.hidden: Set of box indices not drawn. opts.dynamic: box indices drawn with a per-frame transform.
  // opts.props: more static faces (model.js propScene), whose tex indices go past the level's textures.
  function load(lv, imgs, opts = {}) {
    if (imgs !== images) {
      for (const t of textures) gl.deleteTexture(t);
      textures = imgs.map((img) => texture(gl, img));
      images = imgs;
    }
    for (const b of batches) gl.deleteBuffer(b.buf);
    for (const t of lightTex) gl.deleteTexture(t);
    level = lv;
    const dynamic = opts.dynamic || [];
    const skip = new Set([...(opts.hidden || []), ...dynamic]);
    const groups = [[buildFaces(lv, skip).concat(opts.props || []), -1], ...dynamic.map((b, k) => [boxFaces(lv.boxes[b]), k])];
    const lm = bakeLight(lv, groups.flatMap(([faces]) => faces));
    lightTex = [lm.color, lm.dir].map((data) => texture(gl, { width: lm.width, height: lm.height, data }, true));
    batches = [];
    for (const [faces, dyn] of groups) {
      meshes(faces, imgs.length - 1).forEach((verts, i) => {
        if (!verts.length) return;
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
        batches.push({ tex: textures[i], bump: [images[i].bump || 0, 1 / images[i].width], blend: !!images[i].transparent, buf, count: verts.length / 10, dyn });
      });
    }
    batches.sort((a, b) => a.blend - b.blend);
  }

  // cam: { pos: [x,y,z] eye position, yaw, pitch } in units / radians. models[k]: mat4 of opts.dynamic[k].
  // overlay: [{ lines: bool, verts: [x,y,z,...], color: [r,g,b,a] }] drawn last, through walls.
  // parts: a particle system from particles.js (or null).
  function draw(cam, models = [], overlay = [], parts = null) {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5); // shortcut: fixed DPR cap for low-end fill rate; make it a setting if it looks soft
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    const fog = level.fog.map((c) => c / 255);
    gl.clearColor(fog[0], fog[1], fog[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(prog);
    const vp = mul(perspective(FOVY, w / h, 0.5, 10000), viewMatrix(cam));
    gl.uniformMatrix4fv(loc.uViewProj, false, vp);
    gl.uniform3fv(loc.uAmbient, level.ambient.map((c) => c / 255));
    gl.uniform3fv(loc.uEye, cam.pos);
    gl.uniform3fv(loc.uFogColor, fog);
    gl.uniform1f(loc.uFogDist, level.fogDist);

    gl.uniform1i(loc.uTex, 0);
    gl.uniform1i(loc.uLight, 1);
    gl.uniform1i(loc.uLightDir, 2);
    lightTex.forEach((t, i) => { gl.activeTexture(gl.TEXTURE1 + i); gl.bindTexture(gl.TEXTURE_2D, t); });
    gl.activeTexture(gl.TEXTURE0);
    for (const n of ATTRS) gl.enableVertexAttribArray(loc[n]);
    // shortcut: transparent surfaces aren't depth-sorted, so overlapping ones of different textures can blend
    // in the wrong order; sort faces back to front if glass-behind-glass looks wrong.
    for (const b of batches) {
      if (b.blend && !gl.isEnabled(gl.BLEND)) { gl.enable(gl.BLEND); gl.depthMask(false); }
      gl.uniformMatrix4fv(loc.uModel, false, (b.dyn >= 0 && models[b.dyn]) || IDENTITY);
      gl.uniform2fv(loc.uBump, b.bump);
      gl.bindTexture(gl.TEXTURE_2D, b.tex);
      gl.bindBuffer(gl.ARRAY_BUFFER, b.buf);
      gl.vertexAttribPointer(loc.aPos, 3, gl.FLOAT, false, 40, 0);
      gl.vertexAttribPointer(loc.aNormal, 3, gl.FLOAT, false, 40, 12);
      gl.vertexAttribPointer(loc.aUV, 2, gl.FLOAT, false, 40, 24);
      gl.vertexAttribPointer(loc.aLM, 2, gl.FLOAT, false, 40, 32);
      gl.drawArrays(gl.TRIANGLES, 0, b.count);
    }
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    for (const n of ATTRS) if (n !== 'aPos') gl.disableVertexAttribArray(loc[n]);

    if (parts && parts.list.length) drawParticles(cam, vp, fog, parts);
    if (!overlay.length) return;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.useProgram(overlayProg);
    gl.uniformMatrix4fv(oloc.uViewProj, false, vp);
    gl.bindBuffer(gl.ARRAY_BUFFER, overlayBuf);
    gl.enableVertexAttribArray(oloc.aPos);
    gl.vertexAttribPointer(oloc.aPos, 3, gl.FLOAT, false, 0, 0);
    for (const o of overlay) {
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(o.verts), gl.DYNAMIC_DRAW);
      gl.uniform4fv(oloc.uColor, o.color);
      gl.drawArrays(o.lines ? gl.LINES : gl.TRIANGLES, 0, o.verts.length / 3);
    }
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST);
  }

  // One draw per particle type, back to front within it; normal-blend types before additive ones.
  // shortcut: particles of different types aren't sorted against each other; merge into one sort if it shows.
  function drawParticles(cam, vp, fog, parts) {
    const right = [Math.cos(cam.yaw), 0, -Math.sin(cam.yaw)];
    const fwd = forward(cam.yaw, cam.pitch);
    const up = cross(right, fwd);
    const depth = (p) => (p.pos[0] - cam.pos[0]) * fwd[0] + (p.pos[1] - cam.pos[1]) * fwd[1] + (p.pos[2] - cam.pos[2]) * fwd[2];
    const groups = new Map();
    for (const p of parts.list) {
      if (!groups.has(p.type)) groups.set(p.type, []);
      groups.get(p.type).push(p);
    }
    const order = [...groups.keys()].sort((a, b) => parts.types[a].additive - parts.types[b].additive);

    gl.useProgram(partProg);
    gl.uniformMatrix4fv(ploc.uViewProj, false, vp);
    gl.uniform3fv(ploc.uEye, cam.pos);
    gl.uniform3fv(ploc.uFogColor, fog);
    gl.uniform1f(ploc.uFogDist, level.fogDist);
    gl.uniform1i(ploc.uTex, 0);
    gl.enable(gl.BLEND);
    gl.depthMask(false);
    gl.bindBuffer(gl.ARRAY_BUFFER, partBuf);
    gl.enableVertexAttribArray(ploc.aPos);
    gl.enableVertexAttribArray(ploc.aUVA);
    gl.vertexAttribPointer(ploc.aPos, 3, gl.FLOAT, false, 24, 0);
    gl.vertexAttribPointer(ploc.aUVA, 3, gl.FLOAT, false, 24, 12);
    for (const ti of order) {
      const t = parts.types[ti], list = groups.get(ti);
      list.sort((a, b) => depth(b) - depth(a));
      const v = new Float32Array(list.length * 36);
      let o = 0;
      for (const p of list) {
        const k = p.age / p.life;
        const h = (t.size0 + (t.size1 - t.size0) * k) / 2, a = 1 - k;
        for (const [su, sv, u, w] of [[-1, 1, 0, 0], [-1, -1, 0, 1], [1, -1, 1, 1], [-1, 1, 0, 0], [1, -1, 1, 1], [1, 1, 1, 0]]) {
          for (let i = 0; i < 3; i++) v[o++] = p.pos[i] + (right[i] * su + up[i] * sv) * h;
          v[o++] = u; v[o++] = w; v[o++] = a;
        }
      }
      const img = images[t.tex];
      gl.bindTexture(gl.TEXTURE_2D, textures[t.tex]);
      gl.uniform1f(ploc.uUseAlpha, img && img.transparent ? 1 : 0);
      gl.uniform1f(ploc.uAdd, t.additive ? 1 : 0);
      if (t.additive) gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ZERO, gl.ONE);
      gl.bufferData(gl.ARRAY_BUFFER, v, gl.STREAM_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, list.length * 6);
      if (t.additive) gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    }
    gl.disableVertexAttribArray(ploc.aUVA);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
  }

  return { load, draw };
}

// Visible faces: { tex, face (texture settings), a (projection axis), n (unit normal), verts: CCW polygon }.
// Boxes in `skip` are left out, and don't hide their neighbours' faces either.
export function buildFaces(level, skip = new Set()) {
  // Only plain opaque boxes hide neighbouring faces; a shaped box doesn't fill its bounding box.
  const seeThrough = (b) => b.faces.some((f) => f.tex && level.textures[f.tex - 1].transparent);
  const hiding = boxGrid(level.boxes.filter((b, i) => b.solid && !b.shape && !seeThrough(b) && !skip.has(i)));
  const out = [];
  level.boxes.forEach((box, i) => {
    if (skip.has(i)) return;
    if (box.shape) return out.push(...boxFaces(box));
    for (let f = 0; f < 6; f++) if (!covered(box, f >> 1, f & 1 ? 1 : -1, hiding)) out.push(rectFace(box, f));
  });
  return out;
}

// All faces of one box, no culling (it moves).
export function boxFaces(box) {
  if (!box.shape) return [0, 1, 2, 3, 4, 5].map((f) => rectFace(box, f));
  return hullOf(box).faces.map(({ n, verts }) => {
    const slot = faceSlot(n);
    const len = Math.hypot(...n);
    return { tex: box.faces[slot].tex, face: box.faces[slot], a: slot >> 1, n: n.map((v) => v / len), verts };
  });
}

function rectFace(box, f) {
  const a = f >> 1, s = f & 1 ? 1 : -1;
  const u = (a + 1) % 3, v = (a + 2) % 3;
  // Corners in (u,v); CCW seen from outside for +a, reversed for -a.
  let cs = [[0, 0], [1, 0], [1, 1], [0, 1]];
  if (s < 0) cs = cs.reverse();
  const verts = cs.map(([cu, cv]) => {
    const p = [0, 0, 0];
    p[a] = s > 0 ? box.max[a] : box.min[a];
    p[u] = cu ? box.max[u] : box.min[u];
    p[v] = cv ? box.max[v] : box.min[v];
    return p;
  });
  const n = [0, 0, 0];
  n[a] = s;
  return { tex: box.faces[f].tex, face: box.faces[f], a, n, verts };
}

// One vertex array per texture index: [x,y,z, nx,ny,nz, u,v, lu,lv] per vertex, faces as triangle fans.
// Faces need their lightmap uvs (face.lm, from bakeLight). Model faces bring their own uvs (f.uv).
function meshes(faces, textureCount) {
  const out = Array.from({ length: textureCount + 1 }, () => []);
  for (const f of faces) {
    const vtx = (i) => [...f.verts[i], ...f.n, ...(f.uv ? f.uv[i] : uv(f.verts[i], f.a, f.face)), ...f.lm[i]];
    for (let i = 1; i + 1 < f.verts.length; i++) out[f.tex].push(...vtx(0), ...vtx(i), ...vtx(i + 1));
  }
  return out;
}

// World-aligned UVs so neighbouring faces tile seamlessly. Texture "up" is +y.
function uv(p, a, face) {
  const [tu, tv] = projectUV(p, a, face.scale || 256);
  return [tu + face.ox / 256, tv + face.oy / 256];
}

// Boxes bucketed by 64-unit cells for point lookups; boxes spanning many cells are always checked.
const CELL = 64;
function boxGrid(boxes) {
  const cells = new Map(), big = [];
  const range = (b, k) => [Math.floor(b.min[k] / CELL), Math.floor((b.max[k] - 1) / CELL)];
  for (const b of boxes) {
    const r = [0, 1, 2].map((k) => range(b, k));
    if ((r[0][1] - r[0][0] + 1) * (r[1][1] - r[1][0] + 1) * (r[2][1] - r[2][0] + 1) > 64) { big.push(b); continue; }
    for (let x = r[0][0]; x <= r[0][1]; x++) for (let y = r[1][0]; y <= r[1][1]; y++) for (let z = r[2][0]; z <= r[2][1]; z++) {
      const key = x + ',' + y + ',' + z;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(b);
    }
  }
  return (p) => big.concat(cells.get(p.map((v) => Math.floor(v / CELL)).join(',')) || []);
}

// A face is hidden when one box covers all of it. That box contains the face's center pushed half a unit
// outward (coordinates are integers), so only boxes at that point are candidates.
function covered(box, a, s, near) {
  const u = (a + 1) % 3, v = (a + 2) % 3;
  const plane = s > 0 ? box.max[a] : box.min[a];
  const c = [0, 0, 0];
  c[a] = plane + s * 0.5;
  c[u] = (box.min[u] + box.max[u]) / 2;
  c[v] = (box.min[v] + box.max[v]) / 2;
  for (const o of near(c)) {
    if (o === box) continue;
    const inA = s > 0 ? o.min[a] <= plane && plane < o.max[a] : o.min[a] < plane && plane <= o.max[a];
    if (inA && o.min[u] <= box.min[u] && o.max[u] >= box.max[u] && o.min[v] <= box.min[v] && o.max[v] >= box.max[v]) return true;
  }
  return false;
}

// lightmap: smooth, no mipmaps, no wrapping (its size may be any power of two).
function texture(gl, img, lightmap = false) {
  const t = gl.createTexture();
  // Height rides in the alpha channel, so a normal map needs no extra texture.
  const px = new Uint8Array(img.data);
  if (img.heights) for (let i = 0; i < img.heights.length; i++) px[i * 4 + 3] = img.heights[i];
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
  if (lightmap) {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  return t;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('shader link: ' + gl.getProgramInfoLog(p));
  return p;
}

// ---- column-major mat4 ----

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}

function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}

// Inverse of camera = translate(pos) * rotY(yaw) * rotX(pitch). Yaw 0 looks down -z.
function viewMatrix({ pos, yaw, pitch }) {
  const cx = Math.cos(-pitch), sx = Math.sin(-pitch), cy = Math.cos(-yaw), sy = Math.sin(-yaw);
  const rx = [1, 0, 0, 0, 0, cx, sx, 0, 0, -sx, cx, 0, 0, 0, 0, 1];
  const ry = [cy, 0, -sy, 0, 0, 1, 0, 0, sy, 0, cy, 0, 0, 0, 0, 1];
  const t = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -pos[0], -pos[1], -pos[2], 1];
  return mul(mul(rx, ry), t);
}
