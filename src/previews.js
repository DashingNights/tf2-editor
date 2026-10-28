// Entity previews in 3D, as helpers (never picked; rebuilt on every 'doc' and 'filters' event) unless said otherwise:
// - ropes ('view.ropes', cfg.ropes): move_rope / keyframe_rope to their NextKey target as a catenary sagging by Slack,
//   also as polylines in the 2D views;
// - the rest ('view.entityPreviews', cfg.entityPreviews): editor_text and point_worldtext text (a view3d builder: the
//   text is the entity's visual, a click on it selects it), env_sun's disc in the sky, point_spotlight's cone,
//   env_beam / env_laser beams, trigger_catapult's launch arc.
import * as THREE from 'three';
import * as V from '../vmf.js';
import { on } from './bus.js';
import { cache, setCursor } from './state.js';
import { cfg, setCfg } from './settings.js';
import { register } from './commands.js';
import { addHelper, invalidate, registerBuilder, refreshEntry } from './view3d.js';
import { registerOverlay, invalidate as invalidate2d } from './view2d.js';
import { lightDir } from './lighting.js';

const D2R = Math.PI / 180, ROPE = '#c8a46e', ARC = '#40d8ff', GRAVITY = 800;

// ---------- pure helpers ----------
// Keyvalue by case-insensitive key (Hammer writes keys as the FGD spells them: NextKey, Slack, playerSpeed).
export const kv = (n, k) => n.kv.find(p => p[0].toLowerCase() === k.toLowerCase())?.[1];
const num = (n, k, d) => { const v = parseFloat(kv(n, k)); return Number.isFinite(v) ? v : d; };
const rgb = (s, d = [255, 255, 255]) => { const v = V.nums(s); return v.length >= 3 ? v : d; };

// Source angles 'pitch yaw roll' as a rotation (yaw about z, pitch about y, roll about x): columns forward, left, up;
// positive pitch looks down, as AngleVectors.
export const turn = a => new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler((a[2] || 0) * D2R, (a[0] || 0) * D2R, (a[1] || 0) * D2R, 'ZYX'));
const forward = a => { const m = turn(a).elements; return [m[0], m[1], m[2]]; };

// n + 1 points of a rope hanging from a to b, |b - a| + slack long: a catenary in the vertical plane through a and b.
// Straight without slack or with the ends on one vertical line. With x = h / 2c, sinh(x) / x = sqrt(L^2 - v^2) / h
// gives c (bisection); x0, where the lowest point is along the ground line, follows from v / L = tanh((h - 2 x0) / 2c).
export function catenary(a, b, slack = 25, n = 16) {
  const d = b.map((x, k) => x - a[k]), h = Math.hypot(d[0], d[1]), v = d[2], L = Math.hypot(h, v) + slack;
  const at = (i, z) => [a[0] + (d[0] * i) / n, a[1] + (d[1] * i) / n, z];
  if (!(slack > 0) || h < 1e-3) return Array.from({ length: n + 1 }, (_, i) => at(i, a[2] + (v * i) / n));
  const r = Math.sqrt(L * L - v * v) / h;
  let lo = 0, hi = 1;
  while (Math.sinh(hi) / hi < r) hi *= 2;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (Math.sinh(m) / m < r) lo = m; else hi = m; }
  const c = h / (lo + hi), x0 = h / 2 - c * Math.atanh(v / L), y0 = c * Math.cosh(x0 / c);
  return Array.from({ length: n + 1 }, (_, i) => at(i, a[2] + c * Math.cosh(((h * i) / n - x0) / c) - y0));
}

// n + 1 points of the path trigger_catapult throws a player on from s at speed, under gravity g: to target as the game
// aims (time = distance / speed, plus g * time / 2 upwards so it comes down there), else along dir until 512 units
// below s. [] without a speed.
export function launchArc(s, speed, { target, dir }, g = GRAVITY, n = 32) {
  if (!(speed > 0)) return [];
  let v, T;
  if (target) {
    const d = target.map((x, k) => x - s[k]);
    T = Math.hypot(...d) / speed;
    if (!T) return [];
    v = d.map(x => x / T);
    v[2] += (g * T) / 2;
  } else {
    v = dir.map(x => x * speed);
    T = (v[2] + Math.sqrt(v[2] * v[2] + 2 * g * 512)) / g;
  }
  return Array.from({ length: n + 1 }, (_, i) => { const t = (T * i) / n; return [s[0] + v[0] * t, s[1] + v[1] * t, s[2] + v[2] * t - (g * t * t) / 2]; });
}

// Unit vector towards env_sun's sun: from its target to it while use_angles is off and the target exists (as the game
// does), else against the way its light would shine (angles and pitch read like a light_environment's, lighting.js).
export function sunDir(n, origin, target) {
  const d = target && kv(n, 'use_angles') !== '1' ? origin.map((x, k) => x - target[k]) : null, l = d && Math.hypot(...d);
  return l ? d.map(x => x / l) : lightDir(kv(n, 'angles'), num(n, 'pitch', 0)).map(x => -x);
}

// ---------- shared drawing (particles.js uses the text) ----------
// One line of text as a texture: white with a dark outline (a material colour tints it), width / height in userData.
export function textTexture(s) {
  const c = document.createElement('canvas'), x = c.getContext('2d'), font = 'bold 48px sans-serif';
  x.font = font;
  c.width = Math.ceil(x.measureText(s).width) + 12;
  c.height = 62;
  x.font = font; // resizing resets the context
  x.textBaseline = 'middle';
  x.lineWidth = 6;
  x.strokeStyle = '#000';
  x.strokeText(s, 6, 31);
  x.fillStyle = '#fff';
  x.fillText(s, 6, 31);
  const t = new THREE.CanvasTexture(c);
  t.userData.aspect = c.width / c.height;
  return t;
}

const PLANE = new THREE.PlaneGeometry(1, 1), FACE = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0));
// Text size units high (the line box 1.3 times that) centred on p in colour col (THREE.Color): a camera-facing sprite,
// or with angles a a plane facing their forward, the text running along their left (readable from the front).
export function text(tex, size, col, p, a = null, opacity = 1) {
  const h = size * 1.3, o = { map: tex, color: col, transparent: true, opacity, depthWrite: false };
  const m = a ? new THREE.Mesh(PLANE, new THREE.MeshBasicMaterial({ ...o, side: THREE.DoubleSide })) : new THREE.Sprite(new THREE.SpriteMaterial(o));
  m.position.set(...p);
  if (a) m.quaternion.setFromRotationMatrix(turn(a).multiply(FACE));
  m.scale.set(h * tex.userData.aspect, h, 1);
  return m;
}

// ---------- text entities (builder) ----------
const owned = new Map(); // node -> the texture and material of its text visual
function free(n) { owned.get(n)?.forEach(x => x.dispose()); owned.delete(n); }
const color = s => new THREE.Color(...rgb(s).slice(0, 3).map(x => x / 255)), angles = n => V.nums(kv(n, 'angles') ?? '');

// editor_text / point_worldtext: message, textsize and color (its alpha too); point_worldtext turned by its angles
// unless its orientation faces the player (1, 2). null (the default box) without a message or with previews off.
function textVisual(c) {
  const n = c.node, cls = c.point && kv(n, 'classname');
  free(n); // also when the class changed
  if (cls !== 'editor_text' && cls !== 'point_worldtext') return null;
  const s = kv(n, 'message');
  if (!s || !previewsOn()) return null;
  const fixed = cls === 'point_worldtext' && !(+kv(n, 'orientation') > 0);
  const o = text(textTexture(s), num(n, 'textsize', 10), color(kv(n, 'color')), V.nums(V.get(n, 'origin')), fixed ? angles(n) : null, (rgb(kv(n, 'color'))[3] ?? 255) / 255);
  owned.set(n, [o.material.map, o.material]);
  return o;
}

// ---------- 3D helpers ----------
const root = new THREE.Group(), lineMat = new THREE.LineBasicMaterial({ vertexColors: true });
// Unit shapes along +x from 0 to 1, radius 1: an open cylinder (beams) and a cone from its apex, bright there and
// fading to black (additive) at its base.
const BEAM = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true).translate(0, 0.5, 0).rotateZ(-Math.PI / 2);
const CONE = new THREE.CylinderGeometry(1, 0, 1, 24, 1, true).translate(0, 0.5, 0).rotateZ(-Math.PI / 2), cp = CONE.attributes.position;
CONE.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: cp.count * 3 }, (_, i) => 1 - cp.getX(Math.floor(i / 3))), 3));
const DISC = new THREE.PlaneGeometry(2, 2), SHARED = new Set([PLANE, BEAM, CONE, DISC]);
let ropes = [], glowTex = null; // ropes: polylines for the 2D views
const ropesOn = () => cfg.ropes ?? true, previewsOn = () => cfg.entityPreviews ?? true;

// A white disc with a soft rim on transparent, made once.
function glow() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas'), x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  c.width = c.height = 64;
  [[0, 1], [0.25, 1], [0.4, 0.3], [1, 0]].forEach(([t, a]) => g.addColorStop(t, `rgba(255,255,255,${a})`));
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  return (glowTex = new THREE.CanvasTexture(c));
}

// Polylines [[points, css]] as one LineSegments.
function lines(polys) {
  const pos = [], col = [], c = new THREE.Color();
  for (const [pts, css] of polys) {
    c.set(css);
    for (let i = 1; i < pts.length; i++) { pos.push(...pts[i - 1], ...pts[i]); col.push(c.r, c.g, c.b, c.r, c.g, c.b); }
  }
  const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)).setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return new THREE.LineSegments(g, lineMat);
}

const glowMat = (col, opacity, o = {}) => new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, ...o });
// A unit shape stretched along x to len and to radius r across, placed at p turned by quaternion q.
function stretch(geo, mat, p, q, len, r) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(...p);
  m.quaternion.copy(q);
  m.scale.set(len, r, r);
  return m;
}
// A beam from a to b, width units across; null when a and b coincide.
function beam(a, b, width, col) {
  const d = new THREE.Vector3(...b).sub(new THREE.Vector3(...a)), len = d.length();
  return len ? stretch(BEAM, glowMat(col, 0.8), a, new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), d.normalize()), len, Math.max(width, 1) / 2) : null;
}

// env_sun: a glow 2 * size wide 100 units from the camera along dir (where the game draws its sprite), drawn first and
// without depth, so every face drawn after covers it: it shows only where nothing else is (the sky).
const camAt = new THREE.Vector3();
function sun(dir, size, col) {
  const d = new THREE.Vector3(...dir), q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), d.clone().negate()), s = new THREE.Vector3(size, size, 1);
  const m = new THREE.Mesh(DISC, glowMat(col, 1, { map: glow(), transparent: false, depthTest: false }));
  m.frustumCulled = false;
  m.renderOrder = -1e9;
  m.onBeforeRender = (r, sc, cam) => m.matrixWorld.compose(camAt.copy(cam.position).addScaledVector(d, 100), q, s);
  return m;
}

// Entities with a position (point entities their origin, brush entities their solids' centre), the visible ones, and
// find(targetname) -> the position of the first entity of that name (case-insensitive) or null.
function scan() {
  const at = new Map(), box = new Map(), vis = new Set(), named = new Map();
  for (const c of cache.values()) {
    const e = c.point ? c.node : c.owner;
    if (e?.name !== 'entity') continue;
    if (c.visible) vis.add(e);
    if (c.point) { at.set(e, V.nums(V.get(e, 'origin'))); continue; }
    const b = box.get(e);
    box.set(e, b ? [b[0].map((x, k) => Math.min(x, c.min[k])), b[1].map((x, k) => Math.max(x, c.max[k]))] : [c.min, c.max]);
  }
  for (const [e, [a, b]] of box) at.set(e, a.map((x, k) => (x + b[k]) / 2));
  for (const e of at.keys()) { const t = kv(e, 'targetname')?.toLowerCase(); if (t && !named.has(t)) named.set(t, e); }
  return { at, vis, find: s => at.get(named.get(s?.toLowerCase())) ?? null };
}

// The preview of entity e of class cls at o: objects into root, lines into polys.
function preview(e, cls, o, find, polys) {
  if (cls === 'env_sun') {
    const c = rgb(kv(e, 'rendercolor'), [100, 80, 80]).slice(0, 3), k = Math.max(...c); // the game keeps the hue only
    root.add(sun(sunDir(e, o, find(kv(e, 'target'))), num(e, 'size', 16), new THREE.Color(...(k > 0 ? c.map(x => x / k) : [1, 1, 1]))));
  } else if (cls === 'point_spotlight') {
    const w = num(e, 'SpotlightWidth', 50);
    root.add(stretch(CONE, glowMat(color(kv(e, 'rendercolor')), 0.5, { vertexColors: true, side: THREE.DoubleSide }), o, new THREE.Quaternion().setFromRotationMatrix(turn(angles(e))), num(e, 'SpotlightLength', 500), w / 2));
  } else if (cls === 'env_beam' || cls === 'env_laser') {
    const laser = cls === 'env_laser', a = laser ? o : find(kv(e, 'LightningStart')) ?? o, b = find(kv(e, laser ? 'LaserTarget' : 'LightningEnd'));
    const m = b && beam(a, b, num(e, laser ? 'width' : 'BoltWidth', 2), color(kv(e, 'rendercolor')));
    if (m) root.add(m);
  } else if (cls === 'trigger_catapult') {
    const t = find(kv(e, 'launchTarget'));
    polys.push([launchArc(o, num(e, 'playerSpeed', 450), t ? { target: t } : { dir: forward(V.nums(kv(e, 'launchDirection') ?? '')) }), ARC]);
  }
}

// Everything again from the cache: ropes and previews of the visible entities.
function rebuild() {
  root.traverse(x => {
    if (x.geometry && !SHARED.has(x.geometry)) x.geometry.dispose();
    if (x.material && x.material !== lineMat) x.material.dispose();
  });
  root.clear();
  const { at, vis, find } = scan(), polys = [];
  ropes = [];
  for (const e of vis) {
    const o = at.get(e), cls = kv(e, 'classname') ?? '';
    if (o?.length !== 3) continue;
    if (cls === 'move_rope' || cls === 'keyframe_rope') {
      const t = ropesOn() && find(kv(e, 'NextKey'));
      if (t) ropes.push(catenary(o, t, num(e, 'Slack', 25)));
    } else if (previewsOn()) preview(e, cls, o, find, polys);
  }
  polys.push(...ropes.map(p => [p, ROPE]));
  if (polys.length) root.add(lines(polys));
  invalidate();
  invalidate2d();
}

function overlay2d(ctx, v, { toScreen }) {
  if (!ropes.length) return;
  ctx.strokeStyle = ROPE;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (const pts of ropes) pts.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](...toScreen(v, p)));
  ctx.stroke();
}

export function mount() {
  addHelper(root);
  registerOverlay(overlay2d);
  registerBuilder(textVisual);
  on('doc', () => {
    for (const n of owned.keys()) if (!cache.has(n)) free(n);
    rebuild();
  });
  on('filters', rebuild);
  on('cfg', ({ key }) => {
    if (key !== 'ropes' && key !== 'entityPreviews') return;
    if (key === 'entityPreviews') for (const c of cache.values()) if (c.point && /^(editor_text|point_worldtext)$/.test(kv(c.node, 'classname') ?? '')) refreshEntry(c.node);
    rebuild();
  });
  const toggle = (key, what, now) => () => { setCfg(key, !now()); setCursor(`${what} ${now() ? 'on' : 'off'}`); };
  register('view.ropes', { title: 'View: ropes (move_rope, keyframe_rope) (toggle)', on: ropesOn, run: toggle('ropes', 'ropes', ropesOn) });
  register('view.entityPreviews', { title: 'View: entity previews (text, env_sun, spotlights, beams, catapult arcs) (toggle)', on: previewsOn, run: toggle('entityPreviews', 'entity previews', previewsOn) });
  rebuild();
}
