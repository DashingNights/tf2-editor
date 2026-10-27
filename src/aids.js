// TF2 scale aids in the 3D view: player box at the cursor, measure tool (M), jump-height bands, sentry range sphere.
// Display only: the helpers never touch the document, and pick() never hits them (it tests cache meshes only).
import * as THREE from 'three';
import * as V from '../vmf.js';
import * as view3d from './view3d.js';
import { on } from './bus.js';
import { S, sel, cache, setCursor } from './state.js';
import { register } from './commands.js';
import { cfg } from './settings.js';
import { el } from './dom.js';

// TF2 player hull: 48x48, 82 tall (62 crouched), eyes at 68. Sentry gun range 1100 (cfg.sentryRange).
export const HULL = { w: 48, h: 82, crouch: 62, eye: 68 }, SENTRY = 1100;
const BAND_R = 128, MAX_MEASURES = 5, WALKABLE = 0.7; // Source: floors need normal z >= 0.7 (45.6 degrees)
const sn = (x, g) => Math.round(x / g) * g;
const r1 = x => String(Math.round(x * 10) / 10);

// [height, colour] per jump band: walk jump (green), crouch jump (yellow), 1.5x crouch jump = unreachable (red).
export const bandHeights = (jump, crouch) => [[jump, 0x40d050], [crouch, 0xf0d040], [crouch * 1.5, 0xf04040]];

// 'total u   dx  dy  dz', one decimal.
export function measureText(a, b) {
  const d = b.map((x, k) => Math.abs(x - a[k]));
  return `${r1(Math.hypot(...d))} u   dx ${r1(d[0])}  dy ${r1(d[1])}  dz ${r1(d[2])}`;
}

// p on the plane with unit normal n, snapped to the grid g on the two axes least aligned with n; the third coordinate
// is solved from the plane so the point stays on the surface (slopes too; on a 45 degree tie z is solved).
export function snapOnSurface(p, n, g) {
  const k = [0, 1, 2].reduce((b, i) => (Math.abs(n[i]) >= Math.abs(n[b]) ? i : b));
  const q = p.map((x, i) => (i === k ? x : sn(x, g)));
  q[k] -= q.reduce((s, x, i) => s + (i === k ? 0 : n[i] * (x - p[i])), 0) / n[k];
  return q;
}

// Bottom centre of a standing hull touching the surface at p (unit normal n): pushed along n until the box clears
// the plane. Floors: p itself; walls: half a hull out; ceilings: hanging below.
export function standOn(p, n) {
  const d = (HULL.w / 2) * (Math.abs(n[0]) + Math.abs(n[1])) + Math.max(0, -n[2]) * HULL.h;
  return p.map((x, k) => x + n[k] * d);
}

// ---------- scene objects ----------
const lineMat = (color, opacity = 1, depthTest = true) => new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, depthTest });
const edges = (g, color, opacity) => new THREE.LineSegments(new THREE.EdgesGeometry(g), lineMat(color, opacity));
const player = new THREE.Group(), bands = new THREE.Group(), marks = new THREE.Group();
// A UV sphere's quads are planar, so its edges are the latitude and longitude lines only.
const sentry = edges(new THREE.SphereGeometry(SENTRY, 32, 16), 0xff8a3c, 0.35);
player.add(
  edges(new THREE.BoxGeometry(HULL.w, HULL.w, HULL.h).translate(0, 0, HULL.h / 2), 0x4fd0ff),
  edges(new THREE.BoxGeometry(HULL.w, HULL.w, HULL.crouch).translate(0, 0, HULL.crouch / 2), 0x4fd0ff, 0.35),
  edges(new THREE.PlaneGeometry(HULL.w + 16, HULL.w + 16).translate(0, 0, HULL.eye), 0xffffff, 0.9),
);

// Band heights and sentry radius from the settings.
function applyCfg() {
  sentry.scale.setScalar(+(cfg.sentryRange ?? SENTRY) / SENTRY);
  for (const o of bands.children) { o.geometry.dispose(); o.material.dispose(); }
  bands.clear();
  for (const [h, color] of bandHeights(+(cfg.jumpHeight ?? 64), +(cfg.crouchJumpHeight ?? 72))) {
    // Rings only: a filled disc near eye height would tint most of the view.
    bands.add(edges(new THREE.CircleGeometry(BAND_R, 48).translate(0, 0, h), color, 0.8));
  }
}

// ---------- state ----------
const show = { player: false, measure: false, jump: false, sentry: false };
const NAMES = { player: 'player box', measure: 'measure tool', jump: 'jump bands', sentry: 'sentry range' };
let pane, canvas, at = null, pending = null, unhover = null;
const done = [];
const step = () => (cfg.snapGrid === false ? 1 : S.grid);

// A pick() hit as its grid-snapped surface point, normal and unsnapped height.
const surface = h => h && { p: snapOnSurface(h.point.toArray(), h.face.n, step()), n: h.face.n, z: h.point.z };

// Where the hull stands for a hover: on walkable ground at the snapped point; off a wall, slope or ceiling it moves
// out of the surface and down onto the first visible surface below.
const ray = new THREE.Raycaster(), DOWN = new THREE.Vector3(0, 0, -1);
function standAt(s) {
  const b = standOn(s.p, s.n);
  if (s.n[2] >= WALKABLE) return b;
  ray.set(new THREE.Vector3(b[0], b[1], s.z + 1), DOWN);
  const h = ray.intersectObjects([...cache.values()].filter(c => c.visible && c.mesh).map(c => c.mesh), false)[0];
  if (h) b[2] = h.point.z;
  return b;
}

// Origin of the first selected point entity: the sentry sphere goes there instead of the cursor.
function selOrigin() {
  for (const n of sel) {
    const o = cache.get(n)?.point && V.nums(V.get(n, 'origin'));
    if (o?.length === 3) return o;
  }
  return null;
}

function refresh() {
  const o = selOrigin() ?? at;
  player.visible = show.player && !!at;
  bands.visible = show.jump && !!at;
  sentry.visible = show.sentry && !!o;
  if (at) { player.position.set(...at); bands.position.set(...at); }
  if (o) sentry.position.set(...o);
  view3d.invalidate();
}

// view3d.onHover (once per frame at most): moves the helpers when the snapped spot under the mouse changes.
function hovered(h) {
  const s = surface(h);
  if (!s) return;
  if (pending) setEnds(pending, s.p);
  if (!(show.player || show.jump || show.sentry)) return;
  const b = standAt(s);
  if (at?.every((x, k) => x === b[k])) return;
  at = b;
  refresh();
}

// ---------- measure ----------
const MLINE = lineMat(0xffd84a, 1, false), MDOT = new THREE.PointsMaterial({ color: 0xffd84a, size: 6, sizeAttenuation: false, depthTest: false });
const v = new THREE.Vector3();

function setEnds(m, b) {
  if (m.b?.every((x, k) => x === b[k])) return;
  m.b = b;
  m.line.geometry.dispose();
  m.line.geometry = m.dots.geometry = new THREE.BufferGeometry().setFromPoints([m.a, b].map(p => new THREE.Vector3(...p)));
  m.label.textContent = measureText(m.a, b);
  view3d.invalidate();
}

function addMeasure(a) {
  const m = { a, b: null, line: new THREE.LineSegments(new THREE.BufferGeometry(), MLINE), label: pane.appendChild(el('div', { className: 'aid-label' })) };
  m.dots = new THREE.Points(m.line.geometry, MDOT);
  m.line.add(m.dots);
  m.line.renderOrder = m.dots.renderOrder = 3;
  // Never culled, so onBeforeRender runs every frame and keeps the label on the projected midpoint.
  m.line.frustumCulled = false;
  m.line.onBeforeRender = (r, s, camera) => {
    v.set(...m.a.map((x, k) => (x + m.b[k]) / 2)).project(camera);
    m.label.hidden = v.z > 1; // behind the camera
    m.label.style.left = `${((v.x + 1) / 2) * 100}%`;
    m.label.style.top = `${((1 - v.y) / 2) * 100}%`;
  };
  marks.add(m.line);
  setEnds(m, a);
  return m;
}

function dropMeasure(m) {
  marks.remove(m.line);
  m.line.geometry.dispose();
  m.label.remove();
}

function clearMeasures() {
  [...done, pending].filter(Boolean).forEach(dropMeasure);
  done.length = 0;
  pending = null;
  view3d.invalidate();
}

// Capture phase on the pane: while measuring, a left click on the canvas places a point instead of reaching selection
// and the gizmo. Clicks on overlay UI (the blockout toolbar) pass.
function measureDown(e) {
  if (!show.measure || e.button !== 0 || e.altKey || e.target !== canvas) return;
  e.stopPropagation();
  const r = canvas.getBoundingClientRect(), s = surface(view3d.pick(e.clientX - r.left, e.clientY - r.top));
  if (!s) return;
  if (!pending) { pending = addMeasure(s.p); return; }
  setEnds(pending, s.p);
  done.push(pending);
  pending = null;
  if (done.length > MAX_MEASURES) dropMeasure(done.shift());
}

// ---------- toggles ----------
function set(k, val) {
  show[k] = val;
  if (k !== 'measure') return;
  pane.classList.toggle('measuring', val);
  if (!val && pending) { dropMeasure(pending); pending = null; }
}

// Turns the given aids all on, or all off when they are all on already.
function toggle(...ks) {
  const val = !ks.every(k => show[k]);
  ks.forEach(k => set(k, val));
  // Hover picks run only while an aid needs them.
  const need = Object.values(show).some(Boolean);
  if (need && !unhover) unhover = view3d.onHover(hovered);
  else if (!need && unhover) { unhover(); unhover = null; }
  setCursor(`${ks.map(k => NAMES[k]).join(', ')} ${val ? 'on' : 'off'}`);
  refresh();
}

// el3d: the 3D pane (#v-3d). Mount after view3d.
export function mount(el3d) {
  pane = el3d;
  canvas = el3d.querySelector('canvas');
  applyCfg();
  for (const o of [player, bands, sentry, marks]) {
    o.userData.helper = true;
    o.visible = o === marks;
    view3d.addHelper(o);
  }
  el3d.addEventListener('pointerdown', measureDown, true);
  on('selection', () => show.sentry && refresh());
  on('doc', () => show.sentry && refresh());
  on('cfg', ({ key }) => { if (['jumpHeight', 'crouchJumpHeight', 'sentryRange'].includes(key)) { applyCfg(); view3d.invalidate(); } });
  on('file', d => d?.op === 'load' && clearMeasures());

  register('aids.player', { title: 'Aids: player box at the cursor (toggle)', run: () => toggle('player'), on: () => show.player });
  register('aids.measure', { title: 'Aids: measure tool (toggle)', keys: ['m'], run: () => toggle('measure'), on: () => show.measure });
  register('aids.jump', { title: 'Aids: jump height bands (toggle)', run: () => toggle('jump'), on: () => show.jump });
  register('aids.sentry', { title: 'Aids: sentry range sphere (toggle)', run: () => toggle('sentry'), on: () => show.sentry });
  register('aids.all', { title: 'Aids: player box, jump bands and sentry range (toggle)', run: () => toggle('player', 'jump', 'sentry') });
  register('aids.clearMeasures', { title: 'Aids: clear measurements', keys: ['escape'], when: () => !!(pending || done.length), run: clearMeasures });
}
