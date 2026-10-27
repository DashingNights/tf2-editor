// Playtest (F5, toolbar Playtest): walk the open map as a TF2 class in the 3D view. Movement and collision are
// playmove.js; this is the class picker, input, first-person camera and HUD. The document is only read: no edit, no
// undo step, the map stays as it was. Esc gives the editor camera, view and tool back untouched.
import * as V from '../vmf.js';
import * as PM from './playmove.js';
import { setCamHook, flyView, setRenderMode } from './view3d.js';
import { doc, cache, setCursor, inHiddenBlock } from './state.js';
import { modelCorners } from './models.js';
import { vmtNow } from './materials.js';
import { register, held } from './commands.js';
import { cfg, setCfg } from './settings.js';
import { on } from './bus.js';
import { el } from './dom.js';

const D2R = Math.PI / 180, TEAM = { [PM.BLU]: 'BLU', [PM.RED]: 'RED' };
const HELP = 'WASD move  Space jump  Ctrl crouch  Shift walk  1-9 class  R respawn  Esc leave';
let pane, canvas, hud, picker, world = null, p = null, from = null, prev = null;
let playing = false, locked = false, mode = null, escUntil = 0, look = { yaw: 0, pitch: 0 }, acc = 0, lastT = 0, viewZ = null, lastEye = 0;
const keys = new Set(), taps = new Set(); // KeyboardEvent.code held, and pressed since the last tick (short taps count)

// fov_desired is horizontal at 4:3; the game keeps it for wider screens (ScaleFOVByWidthRatio), so the vertical fov is fixed.
const vfov = () => 2 * Math.atan(Math.tan((Math.min(90, Math.max(20, +cfg.playtestFov || 90)) * D2R) / 2) * 0.75) / D2R;

// ---------- start, respawn, leave ----------
const facesOf = s => cache.get(s)?.faces ?? V.faces(s);
// Water and slime brushes are not solid: the VMT's %compilewater / %compileslime or the Water shader (vbsp). Known for
// the materials whose VMT has loaded, which the drawn ones have.
const water = m => { const v = vmtNow(m); return !!v && (v.shader === 'water' || ['%compilewater', '%compileslime'].some(k => parseFloat(v.kv.get(k)))); };
const build = () => PM.buildWorld(doc.root, facesOf, { prop: modelCorners, water });
// The floor straight below the 3D camera, or why there is none (the player is moved out of walls next to it).
function underCamera(w, teamNum) {
  const v = flyView(), t = PM.trace(w, v.pos, [v.pos[0], v.pos[1], v.pos[2] - 65536], [0, 0, 0], [0, 0, 0], teamNum);
  if (t.startsolid) return 'the 3D camera is inside a brush';
  return t.fraction === 1 ? 'no floor below the 3D camera' : { origin: t.end, yaw: v.yaw / D2R, pitch: v.pitch / D2R };
}

// Does not start (and says why in the status bar) without a floor or room for the player there.
function start(cls, teamNum, atCamera) {
  const w = build(), sp = PM.spawnPoints(doc.root, teamNum)[0], cam = atCamera || !sp;
  const at = cam ? underCamera(w, teamNum) : { origin: sp.origin, yaw: sp.yaw, pitch: 0 };
  const q = typeof at === 'string' ? null : PM.newPlayer(cls, teamNum, at.origin), none = cam && !atCamera ? `no ${TEAM[teamNum]} spawn point, ` : '';
  if (!q || !PM.unstick(w, q)) return setCursor(`playtest: ${none}${q ? `no room for a player ${cam ? 'below the 3D camera' : 'at the spawn point'}` : at}`);
  if (none) setCursor(`playtest: ${none}starting below the 3D camera`);
  world = w;
  from = at;
  p = q;
  respawn();
  // the textured render (lit too, it is textured), not flat or wireframe; not saved, stop() puts it back
  if (!playing) mode = ['textured', 'lit'].includes(cfg.renderMode) ? null : setRenderMode('textured', false);
  playing = true;
  keys.clear();
  taps.clear();
  lastT = 0;
  hud.hidden = false;
  pane.classList.add('playing');
  toolTextures(false);
  setCamHook(place);
  lock();
}
// Pointer lock needs a user gesture (a click or key); without it the view waits for a click.
const lock = () => { try { canvas.requestPointerLock()?.catch?.(() => {}); } catch {} };
function respawn() {
  p = PM.newPlayer(p.cls, p.team, from.origin);
  if (!PM.unstick(world, p)) setCursor('playtest: the start point is inside a brush, press R after moving it');
  look = { yaw: from.yaw, pitch: from.pitch };
  prev = { o: p.o, eye: p.eye };
  viewZ = null;
  acc = 0;
}
function stop() {
  playing = false;
  for (const c of cache.values()) if (c.mesh) c.mesh.visible = c.visible;
  toolTextures(true);
  if (mode) setRenderMode(mode, false);
  mode = null;
  setCamHook(null);
  hud.hidden = true;
  pane.classList.remove('playing');
  world = p = null;
  keys.clear();
  if (document.pointerLockElement === canvas) { locked = false; document.exitPointerLock(); }
}

// ---------- per frame: fixed ticks, interpolated camera ----------
const k = c => (keys.has(c) || taps.has(c) ? 1 : 0);
const input = () => ({
  fwd: k('KeyW') - k('KeyS'), side: k('KeyD') - k('KeyA'), jump: !!k('Space'), duck: !!(k('ControlLeft') || k('ControlRight')),
  walk: keys.has('ShiftLeft') || keys.has('ShiftRight'), yaw: look.yaw,
});
function place(cam, now) {
  const dt = lastT ? Math.min(0.25, (now - lastT) / 1000) : 0;
  lastT = now;
  for (acc += dt; acc >= PM.TICK; acc -= PM.TICK) {
    prev = { o: p.o, eye: p.eye };
    PM.tick(world, p, input());
    taps.clear();
  }
  const a = acc / PM.TICK, o = prev.o.map((x, i) => x + (p.o[i] - x) * a), eye = prev.eye + (p.eye - prev.eye) * a;
  // C_BasePlayer::SmoothViewOnStairs: on the ground the view follows height changes at 150 u/s, at most 18 behind.
  if (p.ground && viewZ !== null && o[2] !== viewZ && eye === lastEye) {
    const up = o[2] > viewZ;
    viewZ += (up ? 150 : -150) * dt;
    viewZ = up ? Math.max(Math.min(viewZ, o[2]), o[2] - 18) : Math.min(Math.max(viewZ, o[2]), o[2] + 18);
  } else viewZ = o[2];
  lastEye = eye;
  const y = look.yaw * D2R, pt = look.pitch * D2R, d = [Math.cos(pt) * Math.cos(y), Math.cos(pt) * Math.sin(y), Math.sin(pt)];
  cam.position.set(o[0], o[1], viewZ + eye);
  cam.lookAt(o[0] + d[0], o[1] + d[1], viewZ + eye + d[2]);
  if (cam.fov !== vfov()) { cam.fov = vfov(); cam.updateProjectionMatrix(); }
  const open = new Set(world.doors.filter(d => d.open).flatMap(d => d.nodes));
  for (const c of cache.values()) if (c.mesh) c.mesh.visible = ingame(c) && !open.has(c.node);
  hudText();
}
// What the game draws, like what collides (playmove.buildWorld): everything vbsp compiles, so hidden visgroups, show
// filters and objects hidden for the session only (isolate, Figma review) are drawn, objects hidden with H (Hammer's
// hidden blocks) are not; of the point entities only props, overlays and decals; spawn doors not while they are open;
// no tool textures (toolTextures).
const ingame = c => !inHiddenBlock(c.node) && (!c.point || c.kinds.includes('models') || /^info_?(overlay|decal)/.test(V.get(c.node, 'classname')));
// Tool textures (nodraw, clips, triggers, hints...; not the sky) are not drawn while playing: their shared materials
// are made invisible, so a brush with a nodraw face still shows its other faces.
const toolMats = new Set();
function toolTextures(show) {
  if (show) { toolMats.forEach(m => { m.visible = true; }); toolMats.clear(); return; }
  for (const c of cache.values()) c.mesh?.traverse(x => x.userData.mats?.forEach((n, i) => {
    const m = Array.isArray(x.material) ? x.material[i] : null; // not a shared single material (dimmed: one for all)
    if (m?.visible && n.startsWith('tools/') && !n.startsWith('tools/toolsskybox')) { m.visible = false; toolMats.add(m); }
  }));
}

const f1 = x => (Math.round(x * 10) / 10).toFixed(1);
function hudText() {
  const t = `${PM.CLASSES[p.cls].name}  ${TEAM[p.team]}  ${f1(Math.hypot(p.v[0], p.v[1]))} u/s  ${p.ground ? 'on ground' : 'in air'}${p.ducked ? '  crouched' : ''}\n`
    + `pos ${p.o.map(f1).join(' ')}\n${HELP}${document.pointerLockElement === canvas ? '' : '\nClick the view to look around'}`;
  if (hud.textContent !== t) hud.textContent = t;
}

// ---------- input: while playing, keys and 3D pointer events are ours ----------
// Registered at import, before view3d / view2d mount their capture listeners, so it runs first.
addEventListener('keydown', e => {
  if (!playing && !(e.code === 'Escape' && performance.now() < escUntil)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.repeat || !playing) return;
  const n = /^Digit([1-9])$/.exec(e.code);
  if (e.code === 'Escape') stop();
  else if (e.code === 'KeyR') respawn();
  else if (n) PM.setClass(p, +n[1] - 1);
  else { keys.add(e.code); taps.add(e.code); }
}, true);
addEventListener('keyup', e => { keys.delete(e.code); }, true);
addEventListener('blur', () => keys.clear());
for (const type of ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'dblclick', 'contextmenu']) addEventListener(type, e => {
  if (!playing || !pane?.contains(e.target)) return;
  e.stopImmediatePropagation();
  if (type === 'contextmenu') e.preventDefault();
  const locked = document.pointerLockElement === canvas;
  if (type === 'pointerdown' && !locked) lock();
  if (type === 'pointermove' && locked) turn(e.movementX, e.movementY);
}, true);
// Mouse look at the 3D view's look speed (cfg.mouseSensitivity), pitch within 89 degrees like the game.
export function turn(dx, dy) {
  const s = 0.0025 / D2R * (+cfg.mouseSensitivity || 1);
  look.yaw = (look.yaw - dx * s) % 360;
  look.pitch = Math.max(-89, Math.min(89, look.pitch - dy * s));
}

// ---------- the picker ----------
// atCamera: start under the 3D camera instead of the team's first spawn point. While playing (the toolbar button, with
// the mouse free) it leaves the playtest first.
function openPicker(atCamera) {
  if (playing) stop();
  const last = cfg.playtest ?? {};
  let team = last.team === 'red' ? 'red' : 'blu', cam = !!atCamera;
  picker ??= document.body.appendChild(el('dialog', { className: 'playtest-pick' }));
  const go = cls => {
    picker.close();
    setCfg('playtest', { cls, team });
    start(cls, team === 'red' ? PM.RED : PM.BLU, cam);
  };
  const draw = () => picker.replaceChildren(
    el('h3', { textContent: 'Playtest' }),
    el('div', { className: 'teams' }, ...['blu', 'red'].map(t => el('button', { textContent: t.toUpperCase(), className: `${t}${team === t ? ' on' : ''}`, onclick: () => { team = t; draw(); } }))),
    el('div', { className: 'classes' }, ...PM.CLASSES.map((c, i) => el('button', { textContent: `${i + 1}  ${c.name}`, className: i === (last.cls ?? 0) ? 'primary' : '', onclick: () => go(i) }))),
    el('label', {}, el('input', { type: 'checkbox', checked: cam, onchange: e => { cam = e.target.checked; } }), ' Start at the 3D camera (on the floor below it)'),
    el('small', { textContent: 'Click a class or press 1-9. T switches team, Esc closes.' }),
  );
  picker.onkeydown = e => {
    const n = /^Digit([1-9])$/.exec(e.code);
    if (!n && e.code !== 'KeyT') return;
    e.preventDefault();
    e.stopPropagation(); // the dialog closes on it: the editor's own keys (1-3 select modes) must not see it
    if (n) go(+n[1] - 1);
    else { team = team === 'blu' ? 'red' : 'blu'; draw(); picker.querySelector('.classes .primary')?.focus(); }
  };
  draw();
  picker.showModal();
  picker.querySelector('.classes .primary')?.focus();
}

// For tests and scripts: the running playtest, or null.
export const state = () => (playing ? { player: p, look, world, from } : null);
export { start, stop, respawn };

export function mount(el3d) {
  pane = el3d;
  canvas = el3d.querySelector('canvas');
  hud = el('div', { className: 'playtest-hud', hidden: true });
  el3d.append(hud);
  on('doc', () => { if (playing) { world = build(); queueMicrotask(() => toolTextures(false)); } }); // a player now inside a brush is moved out on the next tick
  on('file', d => { if (playing && d.op === 'load') stop(); });
  // Chromium takes the Esc that ends pointer lock and does not pass it on: the lock ending while the window has focus
  // is that Esc (stop() clears locked before it unlocks; Alt+Tab takes the focus first). An Esc keydown that does
  // arrive just after is swallowed so the editor does not see it.
  document.addEventListener('pointerlockchange', () => {
    const was = locked;
    locked = document.pointerLockElement === canvas;
    if (!playing) return;
    keys.clear();
    if (was && !locked && document.hasFocus()) { stop(); escUntil = performance.now() + 500; }
  });
  register('playtest', { title: 'Playtest: walk the map as a TF2 class', keys: ['f5'], run: () => openPicker(held.has('ShiftLeft') || held.has('ShiftRight')) });
  register('playtest.camera', { title: 'Playtest: start at the 3D camera', keys: ['shift+f5'], run: () => openPicker(true) });
}
