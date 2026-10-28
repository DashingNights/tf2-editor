// Move objects (Hammer++): drop.ceiling moves the selection up until it touches the surface above; drop.align drops it
// onto the surface below and turns point entities so their up axis follows that surface's normal. Also the ray cast and
// the Source angle helpers that physics.js and sprinkle.js share.
import * as THREE from 'three';
import * as V from '../vmf.js';
import { cache, sel, boxOf, edit, movable, transformSel, setCursor } from './state.js';
import { cam } from './view3d.js';
import { register } from './commands.js';
import { cfg } from './settings.js';

const D2R = Math.PI / 180;
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const unit = a => { const l = Math.hypot(...a); return a.map(x => x / l); };
export const fmt = x => String(Math.round(x * 1000) / 1000 || 0); // || 0: no -0
export const vec = p => p.map(fmt).join(' ');
export const isProp = n => /^prop_/i.test(V.get(n, 'classname') ?? '');
const origin = n => V.nums(V.get(n, 'origin'));

// ---------- Source angles ----------
// Source AngleMatrix (rows; columns forward, left, up) of [pitch, yaw, roll] in degrees, as vmf.js angleMatrix.
export function matrixOf(a) {
  const [sp, cp, sy, cy, sr, cr] = [0, 1, 2].flatMap(k => [Math.sin((a[k] || 0) * D2R), Math.cos((a[k] || 0) * D2R)]);
  return [[cp * cy, sr * sp * cy - cr * sy, cr * sp * cy + sr * sy],
    [cp * sy, sr * sp * sy + cr * cy, cr * sp * sy - sr * cy],
    [-sp, sr * cp, cr * cp]];
}
// [pitch, yaw, roll] (degrees, yaw 0-360) of an entity whose up axis is up (unit) and whose forward points along yaw as
// far as up allows (vmf.js matrixAngles of the columns forward, left, up).
export function anglesFor(up, yaw) {
  const y = yaw * D2R, f0 = [Math.cos(y), Math.sin(y), 0], s = dot(f0, up);
  let f = f0.map((x, k) => x - up[k] * s);
  if (Math.hypot(...f) < 1e-6) f = cross([-Math.sin(y), Math.cos(y), 0], up); // up lies along the heading
  f = unit(f);
  const l = cross(up, f), xy = Math.hypot(f[0], f[1]);
  const a = xy > 1e-3 ? [Math.atan2(-f[2], xy), Math.atan2(f[1], f[0]), Math.atan2(l[2], up[2])] : [Math.atan2(-f[2], xy), Math.atan2(-l[0], l[1]), 0];
  const [p, yy, r] = a.map(x => Math.round((x / D2R) * 1000) / 1000 || 0);
  return [p, (yy + 360) % 360, r];
}
// World [min, max] of the local box [lo, hi] turned by angles and moved to o.
export function worldBox(lo, hi, o, angles) {
  const m = matrixOf(angles), mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const c = [0, 1, 2].map(k => ((i >> k) & 1 ? hi : lo)[k]);
    for (let k = 0; k < 3; k++) { const v = o[k] + dot(m[k], c); mn[k] = Math.min(mn[k], v); mx[k] = Math.max(mx[k], v); }
  }
  return [mn, mx];
}

// ---------- ray cast ----------
// Ray o + t d (t >= 0) against box [mn, mx]: { t, n } at the face it enters, or null (a ray that starts inside misses).
export function rayBox(o, d, mn, mx) {
  let t0 = -Infinity, t1 = Infinity, k0 = 0;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-12) { if (o[k] < mn[k] || o[k] > mx[k]) return null; continue; }
    let a = (mn[k] - o[k]) / d[k], b = (mx[k] - o[k]) / d[k];
    if (a > b) [a, b] = [b, a];
    if (a > t0) { t0 = a; k0 = k; }
    t1 = Math.min(t1, b);
  }
  if (t0 > t1 || t0 < 0) return null;
  const n = [0, 0, 0];
  n[k0] = d[k0] > 0 ? -1 : 1;
  return { t: t0, n };
}

// Brushes made only of these let rays through: triggers, clips, sky, hint, skip and the like (nodraw stops them).
const PASS = /^tools\/tools(trigger|\w*clip|skybox\w*|hint|skip|areaportal|occluder|fog|origin|blocklight|block_los|invisibleladder)$/i;
const passes = new WeakMap(); // cache entry -> passable (entries are new objects after each rebuild)
function passable(c) {
  let p = passes.get(c);
  if (p === undefined) passes.set(c, (p = V.kids(c.node, 'side').every(s => PASS.test(V.get(s, 'material') ?? ''))));
  return p;
}

// The first surface along the ray from o in direction d (unit) within far: { point, n, node, dist }, n facing the ray,
// or null. Brushes and displacements as drawn (their meshes); props (prop_*) as their boxes; other point entities, the
// brushes PASS lets through and nodes skip(node) picks are left out. boxes: more [min, max] boxes (props moved in the
// same operation); props false leaves all props out.
const rc = new THREE.Raycaster(), ro = new THREE.Vector3(), rd = new THREE.Vector3(), nv = new THREE.Vector3();
export function cast(o, d, { skip = () => false, far = 1e5, props = true, boxes = [] } = {}) {
  let best = null;
  const take = (t, n, node) => { if (t <= far && (!best || t < best.dist)) best = { dist: t, n, node, point: o.map((x, k) => x + d[k] * t) }; };
  const meshes = [];
  for (const c of cache.values()) {
    if (!c.visible || skip(c.node)) continue;
    if (!c.point) { if (c.mesh && !passable(c)) meshes.push(c.mesh); } else if (props && isProp(c.node)) {
      const h = rayBox(o, d, c.min, c.max);
      if (h) take(h.t, h.n, c.node);
    }
  }
  if (props) for (const [mn, mx] of boxes) { const h = rayBox(o, d, mn, mx); if (h) take(h.t, h.n, null); }
  if (!meshes.length) return best;
  rc.set(ro.set(...o), rd.set(...d));
  rc.far = far;
  rc.camera = cam; // sprites need it
  const h = rc.intersectObjects(meshes, true).find(x => x.face);
  if (h) {
    nv.copy(h.face.normal).transformDirection(h.object.matrixWorld);
    if (nv.dot(rd) > 0) nv.negate();
    take(h.distance, nv.toArray(), h.object.userData.node);
  }
  return best;
}

// ---------- commands ----------
const r3 = x => Math.round(x * 1000) / 1000;
const entries = ns => ns.map(n => cache.get(n)).filter(Boolean);

// Moves the selection up until the top of its box touches the first surface above the box's top centre.
function ceiling() {
  const es = entries([...sel]);
  if (!es.length) return setCursor('Drop: select something first');
  const [mn, mx] = boxOf(es), h = cast([(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, mx[2]], [0, 0, 1], { skip: n => sel.has(n) });
  const dz = h && r3(h.dist);
  if (dz) transformSel([1, 1, 1], [0, 0, dz]);
  else setCursor(h ? 'Drop: the selection already touches the surface above' : 'Drop: no surface above the selection');
}

// Each point entity drops along its own ray (from the middle of its box, so one sunk into the floor comes up onto it)
// and turns its up axis to the surface's normal, keeping its heading (lights only drop: their angles aim them). The
// selected brushes drop together like the drop command. One undo step.
function align() {
  const skip = n => sel.has(n), pts = [...sel].filter(n => cache.get(n)?.point), solids = entries([...sel].filter(n => !cache.get(n)?.point));
  const moves = [];
  for (const e of pts) {
    const o = origin(e), c = cache.get(e);
    if (o.length !== 3) continue;
    const z0 = Math.max(o[2] + 1, (c.min[2] + c.max[2]) / 2), h = cast([o[0], o[1], z0], [0, 0, -1], { skip });
    if (h) moves.push([e, h]);
  }
  let dz = 0;
  if (solids.length) {
    const [mn, mx] = boxOf(solids), h = cast([(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, mn[2]], [0, 0, -1], { skip });
    dz = h ? r3(h.dist) : 0;
  }
  if (!moves.length && !dz) return setCursor('Drop: no surface below the selection');
  const ns = dz ? movable(new Set(solids.map(c => c.node))) : [];
  edit([...moves.map(m => m[0]), ...ns], [], () => {
    for (const [e, h] of moves) {
      V.set(e, 'origin', vec(h.point));
      const a = V.nums(V.get(e, 'angles') ?? '0 0 0'), up = h.n[2] > 0.1 ? h.n : [0, 0, 1], b = anglesFor(up, a[1] || 0);
      if (!V.LIGHT.test(V.get(e, 'classname') ?? '') && (V.get(e, 'angles') !== undefined || b[0] || b[2])) V.set(e, 'angles', vec(b));
    }
    for (const n of ns) V.transform(n, [1, 1, 1], [0, 0, -dz], cfg.texLock !== false);
  });
  setCursor(`Drop: ${moves.length} entit${moves.length === 1 ? 'y' : 'ies'} aligned to the surface${dz ? `, brushes down ${dz}` : ''}`);
}

export function mount() {
  register('drop.ceiling', { title: 'Drop: move the selection up to the surface above', keys: ['shift+end'], run: ceiling });
  register('drop.align', { title: 'Drop: to the surface below and align entities to its slope', keys: ['ctrl+end'], run: align });
}
