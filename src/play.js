// Plays one level of a pack: input (keyboard, mouse, touch), HUD, messages, exits, and the frame loop.
import { PHYS, createWorld } from './game.js';

const TICK = 1 / 120;
const GAME_URL = () => new URL('index.html', location.href).href;

// Where an exit leads: another level of this pack, another Linkworld link, or the menu. Never another site:
// a link is only ever a fragment of this game page.
export function exitHref(e, payload, gameUrl = GAME_URL()) {
  if (e.link) return gameUrl + '#' + e.link;
  if (!e.level) return gameUrl;
  return gameUrl + '#' + payload + (e.level > 1 ? '~' + (e.level - 1) : '');
}

// scene: model.js propScene (the textures and the props). payload: this pack's link payload (exits to its other levels reuse it).
export function startGame(canvas, level, payload, renderer, scene, hud, messageEl) {
  let msgTimer = 0;
  const world = createWorld(level, {
    message(text) {
      messageEl.textContent = text;
      messageEl.hidden = false;
      clearTimeout(msgTimer);
      msgTimer = setTimeout(() => { messageEl.hidden = true; }, 4000);
    },
    // Normal navigation, so Back returns to this level. An exit to this same level restarts it.
    exit(e) {
      const href = exitHref(e, payload);
      if (href === location.href) location.reload();
      else location.assign(href);
    },
  }, scene);
  renderer.load(level, scene.images, { hidden: world.hidden, dynamic: world.dynamic, props: scene.faces });
  const p = world.player;
  const keys = new Set();
  const touch = { move: null, look: null, jump: false, forward: 0, right: 0 };

  addEventListener('keydown', (e) => {
    keys.add(e.code);
    if (e.code === 'KeyE' && !e.repeat) world.use();
    if (e.code === 'Space') e.preventDefault();
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());

  const look = (dx, dy, sens) => {
    p.yaw -= dx * sens;
    p.pitch = Math.max(-1.55, Math.min(1.55, p.pitch - dy * sens));
  };
  canvas.addEventListener('click', () => {
    if (!touch.used && canvas.requestPointerLock) canvas.requestPointerLock();
  });
  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 0 && document.pointerLockElement === canvas) world.shoot();
  });
  document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement === canvas) look(e.movementX, e.movementY, 0.0025);
  });

  // Touch: left half = move stick (origin where the finger lands), right half = look.
  const STICK = 50; // px for full speed
  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    touch.used = true;
    for (const t of e.changedTouches) {
      const slot = t.clientX < canvas.clientWidth / 2 ? 'move' : 'look';
      if (!touch[slot]) touch[slot] = { id: t.identifier, x: t.clientX, y: t.clientY };
    }
  }, { passive: false });
  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (touch.move && t.identifier === touch.move.id) {
        touch.right = Math.max(-1, Math.min(1, (t.clientX - touch.move.x) / STICK));
        touch.forward = Math.max(-1, Math.min(1, (touch.move.y - t.clientY) / STICK));
      } else if (touch.look && t.identifier === touch.look.id) {
        look(t.clientX - touch.look.x, t.clientY - touch.look.y, 0.006);
        touch.look.x = t.clientX;
        touch.look.y = t.clientY;
      }
    }
  }, { passive: false });
  const touchEnd = (e) => {
    for (const t of e.changedTouches) {
      if (touch.move && t.identifier === touch.move.id) {
        touch.move = null;
        touch.forward = touch.right = 0;
      }
      if (touch.look && t.identifier === touch.look.id) touch.look = null;
    }
  };
  canvas.addEventListener('touchend', touchEnd);
  canvas.addEventListener('touchcancel', touchEnd);

  const isTouch = 'ontouchstart' in window;
  const button = (id, down, up) => {
    const b = document.getElementById(id);
    b.addEventListener('touchstart', (e) => { e.preventDefault(); down(); }, { passive: false });
    if (up) b.addEventListener('touchend', up);
    return b;
  };
  const jumpBtn = button('jump', () => { touch.jump = true; }, () => { touch.jump = false; });
  const fireBtn = button('fire', () => world.shoot());
  const useBtn = button('use', () => world.use());
  jumpBtn.hidden = fireBtn.hidden = !isTouch;
  const prompt = document.getElementById('prompt');
  let looked; // the usable last shown, so the DOM changes only when it does

  const input = () => {
    const k = (c) => (keys.has(c) ? 1 : 0);
    return {
      forward: Math.max(-1, Math.min(1, k('KeyW') + k('ArrowUp') - k('KeyS') - k('ArrowDown') + touch.forward)),
      right: Math.max(-1, Math.min(1, k('KeyD') + k('ArrowRight') - k('KeyA') - k('ArrowLeft') + touch.right)),
      jump: keys.has('Space') || touch.jump,
    };
  };

  let last = performance.now();
  let acc = 0;
  let frames = 0, fpsTime = last, fps = 0;
  function frame(now) {
    acc += Math.min((now - last) / 1000, 0.1);
    last = now;
    const inp = input();
    while (acc >= TICK) {
      world.tick(inp, TICK);
      acc -= TICK;
    }
    const u = world.usable();
    if (u !== looked) {
      looked = u;
      prompt.textContent = u ? u.text : '';
      prompt.hidden = !(u && u.text);
      useBtn.hidden = !(isTouch && u);
    }
    renderer.draw({ pos: [p.pos[0], p.pos[1] + PHYS.eyeHeight, p.pos[2]], yaw: p.yaw, pitch: p.pitch }, world.models(), [], world.particles);
    frames++;
    if (now - fpsTime > 500) {
      fps = Math.round((frames * 1000) / (now - fpsTime));
      frames = 0;
      fpsTime = now;
      hud.textContent = `${level.name}  ${fps} fps`;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  world.start();
  return world;
}
