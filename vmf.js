// VMF (Valve KeyValues text) parse/serialize + brush geometry. Shared by renderer and test.js.
// Nodes are { name, kv: [[key, value], ...], children: [...] } so key order and duplicates survive a round trip.
import * as D from './src/dispgeo.js'; // a cycle (dispgeo uses this module); neither touches the other at load time

const node = name => ({ name, kv: [], children: [] });

export function parse(text) {
  const root = node('');
  const stack = [root];
  let key = null;
  for (const m of text.matchAll(/\/\/[^\n]*|"([^"]*)"|([{}])|([^\s{}"]+)/g)) {
    const top = stack[stack.length - 1];
    if (m[2] === '{') { const n = node(key); top.children.push(n); stack.push(n); key = null; }
    else if (m[2] === '}') { if (stack.length > 1) stack.pop(); }
    else if (m[1] !== undefined || m[3] !== undefined) {
      const s = m[1] ?? m[3];
      if (key === null) key = s;
      else {
        // A key after a child block (Hammer++ writes vertices_plus between "plane" and "material"): the children so far
        // remember how many keys came before them, so serialize() keeps the order.
        for (let i = top.children.length - 1; i >= 0 && top.children[i].at === undefined; i--) top.children[i].at = top.kv.length;
        top.kv.push([key, s]);
        key = null;
      }
    }
  }
  root.eol = text.includes('\r\n') ? '\r\n' : '\n';
  return root;
}

// VMF strings cannot hold a double quote (there is no escape), so one is dropped. parse() never yields one.
const q = s => String(s).replaceAll('"', '');

export function serialize(root) {
  const out = [];
  const walk = (n, d) => {
    const t = '\t'.repeat(d), kv = i => out.push(`${t}"${q(n.kv[i][0])}" "${q(n.kv[i][1])}"`);
    let i = 0;
    for (const c of n.children) {
      for (const end = Math.min(c.at ?? n.kv.length, n.kv.length); i < end; i++) kv(i);
      out.push(t + c.name, t + '{');
      walk(c, d + 1);
      out.push(t + '}');
    }
    for (; i < n.kv.length; i++) kv(i);
  };
  walk(root, 0);
  const eol = root.eol || '\r\n';
  return out.join(eol) + eol;
}

export const get = (n, k) => n.kv.find(p => p[0] === k)?.[1];
// A new plane drops Hammer++'s vertices_plus (the exact corners of the old plane), which would be stale.
export function set(n, k, v) {
  const p = n.kv.find(p => p[0] === k);
  if (k === 'plane' && p?.[1] !== v && n.children.length) n.children = n.children.filter(c => c.name !== 'vertices_plus');
  if (p) p[1] = v; else n.kv.push([k, v]);
}
export const kids = (n, name) => n.children.filter(c => c.name === name);
export const nums = s => (s?.match(/[-+\d.eE]+/g) || []).map(Number);
const fmt = x => String(Math.round(x * 1e6) / 1e6);

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(...a); return a.map(x => x / l); };
const pts3 = side => { const p = nums(get(side, 'plane')); return [p.slice(0, 3), p.slice(3, 6), p.slice(6, 9)]; };
export const planeText = q => q.map(p => `(${p.map(fmt).join(' ')})`).join(' ');

// Hammer plane: 3 points, outward normal = (p0 - p1) x (p2 - p1); inside is dot(n, x) <= d.
export const planeOf = ([a, b, c]) => { const n = norm(cross(sub(a, b), sub(c, b))); return { n, d: dot(n, a), ok: n.every(Number.isFinite) }; };
export const plane = side => planeOf(pts3(side));

const EPS = 0.01, S = 1e5;
function clipPoly(pts, n, d) {
  const out = [];
  pts.forEach((a, i) => {
    const b = pts[(i + 1) % pts.length], da = dot(n, a) - d, db = dot(n, b) - d;
    if (da <= EPS) out.push(a);
    if ((da < -EPS && db > EPS) || (da > EPS && db < -EPS)) {
      const t = da / (da - db);
      out.push(a.map((x, k) => x + (b[k] - x) * t));
    }
  });
  return out;
}

const snap = x => (Math.abs(x - Math.round(x)) < 1e-3 ? Math.round(x) + 0 : x); // + 0: no -0

// Convex polygon per side (CCW seen from outside): huge quad on the plane clipped by every other plane.
export function faces(solid) {
  const sides = kids(solid, 'side'), planes = sides.map(plane), out = [];
  sides.forEach((side, i) => {
    const { n, d, ok } = planes[i];
    if (!ok) return;
    const u = norm(cross(n, Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0])), v = cross(n, u);
    let pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => n.map((x, k) => x * d + (u[k] * a + v[k] * b) * S));
    planes.forEach((q, j) => { if (j !== i && q.ok && pts.length) pts = clipPoly(pts, q.n, q.d); });
    if (pts.length >= 3) out.push({ side, n, pts: pts.map(p => p.map(snap)) });
  });
  return out;
}

export function bounds(fs) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const f of fs) for (const p of f.pts) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); }
  return [mn, mx];
}

// p' = p * s + t. Texture lock (texLock): the axes scale with the brush (Hammer's texture lock + scaling lock) and the
// shift follows the move, so every point keeps its texture coordinate. Without it the axes stay as written.
export function transform(n, s, t, texLock = true) {
  const xf = p => p.map((x, k) => x * s[k] + t[k]);
  const vec = p => xf(p).map(fmt).join(' ');
  if (n.name === 'entity') {
    for (const k of ['origin', 'BasisOrigin']) { const o = get(n, k); if (o !== undefined) set(n, k, vec(nums(o))); }
    scaleBasis(n, s);
    kids(n, 'solid').forEach(c => transform(c, s, t, texLock));
    return;
  }
  // uni: moves and mirrors keep the axis text as written; real scaling renormalises the axis into the scale value.
  const flip = s[0] * s[1] * s[2] < 0, lock = texLock && s.every(x => x !== 0), uni = s.every(x => Math.abs(x) === 1);
  for (const side of kids(n, 'side')) {
    const q = pts3(side);
    if (flip) q.reverse();
    set(side, 'plane', q.map(v => `(${vec(v)})`).join(' '));
    if (lock) for (const k of ['uaxis', 'vaxis']) {
      const a = nums(get(side, k));
      if (a.length !== 5) continue;
      const w = [0, 1, 2].map(i => a[i] / s[i]), l = uni ? 1 : Math.hypot(...w), f = uni ? String : fmt;
      set(side, k, `[${w.map(x => f(x / l)).join(' ')} ${fmt(a[3] - dot(w, t) / a[4])}] ${f(a[4] / l)}`);
    }
    for (const di of kids(side, 'dispinfo')) {
      const sp = get(di, 'startposition');
      if (sp !== undefined) set(di, 'startposition', `[${vec(nums(sp))}]`);
    }
  }
  // A mirror reverses the face winding, which swaps the grid's rows and columns: re-index and mirror the grid.
  if (flip) for (const f of faces(n)) if (kids(f.side, 'dispinfo').length) {
    const g = D.parse(f.side, f.pts);
    if (g) { D.mirror(g, s.map(Math.sign)); D.write(f.side, g); }
  }
}

// info_overlay basis under p' = p * s (origin keys move with transform): U and V follow the faces, uv0-uv3 stretch so
// the corners (BasisOrigin + u * U + v * V) follow too, and the normal stays on the faces. A mirror turns V and the v
// coordinates over, so the basis stays right-handed (BasisNormal = U x V). Moves leave the text as written.
function scaleBasis(n, s) {
  const U = nums(get(n, 'BasisU')), W = nums(get(n, 'BasisV')), N = nums(get(n, 'BasisNormal'));
  if (U.length !== 3 || W.length !== 3 || N.length !== 3 || s.every(x => x === 1) || s.some(x => !x)) return;
  const uni = s.every(x => Math.abs(x) === 1), u = U.map((x, k) => x * s[k]), w = W.map((x, k) => x * s[k]), m = s[0] * s[1] * s[2] < 0 ? -1 : 1;
  const lu = uni ? 1 : Math.hypot(...u), lw = uni ? 1 : Math.hypot(...w), nn = N.map((x, k) => x / s[k]), ln = uni ? 1 : Math.hypot(...nn);
  set(n, 'BasisU', u.map(x => tidy(x / lu)).join(' '));
  set(n, 'BasisV', w.map(x => tidy((m * x) / lw)).join(' '));
  set(n, 'BasisNormal', nn.map(x => tidy(x / ln)).join(' '));
  for (let i = 0; i < 4; i++) {
    const c = nums(get(n, 'uv' + i));
    if (c.length === 3) set(n, 'uv' + i, [c[0] * lu, c[1] * lw * m, c[2]].map(tidy).join(' '));
  }
}

// ---------- rotation ----------
const D2R = Math.PI / 180;
const near = x => (Math.abs(x - Math.round(x)) < 1e-4 ? Math.round(x) : x);
const tidy = x => fmt(near(x));
const mul = (m, v) => m.map(r => dot(r, v));
const mm = (a, b) => a.map(r => [0, 1, 2].map(j => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]));

// Right-handed rotation matrix (rows) about axis 0|1|2 (x/y/z) or a direction vector (Rodrigues).
export function rotation(axis, deg) {
  const [x, y, z] = typeof axis === 'number' ? [0, 1, 2].map(k => +(k === axis)) : norm(axis);
  const c = Math.cos(deg * D2R), s = Math.sin(deg * D2R), t = 1 - c;
  return [[t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c]];
}

// Source AngleMatrix / MatrixAngles: angles are pitch (y), yaw (z), roll (x); matrix columns are forward, left, up.
function angleMatrix(ang) {
  const [sp, cp, sy, cy, sr, cr] = ang.flatMap(a => [Math.sin(a * D2R), Math.cos(a * D2R)]);
  return [[cp * cy, sr * sp * cy - cr * sy, cr * sp * cy + sr * sy],
    [cp * sy, sr * sp * sy + cr * cy, cr * sp * sy - sr * cy],
    [-sp, sr * cp, cr * cp]];
}
function matrixAngles(m) {
  const xy = Math.hypot(m[0][0], m[1][0]);
  const a = xy > 1e-3 ? [Math.atan2(-m[2][0], xy), Math.atan2(m[1][0], m[0][0]), Math.atan2(m[2][1], m[2][2])]
    : [Math.atan2(-m[2][0], xy), Math.atan2(-m[0][1], m[1][1]), 0];
  return a.map(x => x / D2R);
}

// Lights whose angles' pitch is negative down (vrad's light direction, z = sin(pitch); Hammer draws them so), with a
// pitch key that vrad prefers and Hammer keeps equal to it.
export const LIGHT = /^light_(spot|environment)$/i;

// Rotates a solid or an entity (its solids and origin; angles on point entities, a missing key counting as 0 0 0)
// about pivot. Brush entity angles stay: the game turns the compiled brushes by them. Texture lock: uaxis/vaxis turn
// with the faces and the shift compensates for the pivot; without it they stay as written. Values within 1e-4 of an
// integer snap, so 90-degree steps stay exact.
export function rotate(n, pivot, axis, deg, texLock = true) {
  const m = rotation(axis, deg), at = p => mul(m, sub(p, pivot)).map((x, k) => x + pivot[k]);
  const vec = p => p.map(tidy).join(' ');
  if (n.name === 'entity') {
    const o = get(n, 'origin'), a = kids(n, 'solid').length ? [] : nums(get(n, 'angles') ?? '0 0 0');
    if (o !== undefined) set(n, 'origin', vec(at(nums(o))));
    if (a.length === 3) {
      // (a light keeps its pitch as vrad and Hammer read it, negative down: turned as Source angles, positive down,
      // and back; its pitch key follows)
      const lit = LIGHT.test(get(n, 'classname') ?? ''), [p, y, r] = matrixAngles(mm(m, angleMatrix(lit ? [-a[0], a[1], a[2]] : a)));
      set(n, 'angles', vec([lit ? -p : p, ((near(y) % 360) + 360) % 360, r]));
      if (lit && get(n, 'pitch') !== undefined) set(n, 'pitch', tidy(-p));
    }
    // info_overlay: its basis turns with it
    const bo = get(n, 'BasisOrigin');
    if (bo !== undefined) set(n, 'BasisOrigin', vec(at(nums(bo))));
    for (const k of ['BasisU', 'BasisV', 'BasisNormal']) { const v = nums(get(n, k)); if (v.length === 3) set(n, k, vec(mul(m, v))); }
    kids(n, 'solid').forEach(c => rotate(c, pivot, axis, deg, texLock));
    return;
  }
  for (const side of kids(n, 'side')) {
    set(side, 'plane', pts3(side).map(p => `(${vec(at(p))})`).join(' '));
    if (texLock) for (const k of ['uaxis', 'vaxis']) {
      const a = nums(get(side, k)), r = mul(m, a);
      if (a.length === 5) set(side, k, `[${vec(r)} ${tidy(a[3] + (dot(pivot, a) - dot(pivot, r)) / a[4])}] ${a[4]}`);
    }
    for (const di of kids(side, 'dispinfo')) {
      const sp = get(di, 'startposition');
      if (sp !== undefined) set(di, 'startposition', `[${vec(at(nums(sp)))}]`);
      for (const c of di.children) if (/^(normals|offsets|offset_normals)$/.test(c.name)) for (const kv of c.kv) {
        const v = nums(kv[1]);
        kv[1] = Array.from({ length: v.length / 3 }, (_, i) => vec(mul(m, v.slice(i * 3, i * 3 + 3)))).join(' ');
      }
    }
  }
}

// ---------- brush checks and edits ----------
// Area vector of a polygon: length = area, direction = normal when the points run CCW seen from outside.
export const areaVec = pts => pts.reduce((s, p, i) => {
  const c = cross(sub(p, pts[0]), sub(pts[(i + 1) % pts.length], pts[0]));
  return s.map((x, k) => x + c[k] / 2);
}, [0, 0, 0]);

// Every side yields a polygon with area and none reaches the huge start quad of faces() (an open brush does).
// Brushes built from planes are convex by construction.
export function valid(solid) {
  const fs = faces(solid), n = kids(solid, 'side').length;
  return n >= 4 && fs.length === n && fs.every(f => dot(areaVec(f.pts), f.n) > 1e-3 && f.pts.every(p => Math.hypot(...p) < S / 2));
}

// The three points with the largest triangle, so the plane they span is well conditioned.
export function best3(pts) {
  let best = null, top = 1e-6;
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) for (let k = j + 1; k < pts.length; k++) {
    const a = Math.hypot(...cross(sub(pts[j], pts[i]), sub(pts[k], pts[i])));
    if (a > top) { top = a; best = [pts[i], pts[j], pts[k]]; }
  }
  return best;
}

// Rebuilds each off-grid face's plane from its grid-snapped vertices. Leaves the solid unchanged and returns false
// when the result would be invalid or still have vertices off the grid (a face whose snapped vertices are not coplanar).
// A face that changes shape loses Hammer++'s vertices_plus (its old corners).
const onGrid = (solid, grid) => faces(solid).every(f => f.pts.every(p => p.every(x => Math.abs(x - Math.round(x / grid) * grid) < 1e-3)));
export function snapVertices(solid, grid) {
  const sides = kids(solid, 'side'), fs = faces(solid), old = sides.map(s => [get(s, 'plane'), s.children]);
  const undo = () => { sides.forEach((s, i) => { set(s, 'plane', old[i][0]); s.children = old[i][1]; }); return false; };
  if (fs.length !== sides.length) return false;
  for (const f of fs) {
    const pts = f.pts.map(p => p.map(x => Math.round(x / grid) * grid));
    if (pts.every((p, i) => p.every((x, k) => x === f.pts[i][k]))) continue;
    const q = best3(pts);
    if (!q) return undo();
    if (dot(planeOf(q).n, f.n) < 0) q.reverse();
    set(f.side, 'plane', planeText(q));
  }
  if (!valid(solid) || !onGrid(solid, grid)) return undo();
  for (const f of faces(solid)) if (!samePoly(f.pts, fs.find(g => g.side === f.side).pts)) f.side.children = f.side.children.filter(c => c.name !== 'vertices_plus');
  return true;
}

// Texture axes for a face with outward normal n. Floors and ceilings (|n.z| >= 0.7): world aligned, as Hammer creates
// them. Walls: face aligned, the texture flat on the face with u pointing right seen from outside and v down the face,
// so text reads the right way round and diagonal walls are not stretched (Hammer's world alignment shares one u between
// opposite faces and projects along an axis).
const t6 = x => { const r = Math.round(x * 1e6) / 1e6; return r === 0 ? 0 : r; };
export function axesFor(n) {
  if (Math.abs(n[2]) >= 0.7) return ['[1 0 0 0]', '[0 -1 0 0]'];
  const l = Math.hypot(n[0], n[1]), u = [-n[1] / l, n[0] / l, 0], v = cross(u, n), lv = Math.hypot(...v);
  return [`[${t6(u[0])} ${t6(u[1])} 0 0]`, `[${v.map(x => t6(x / lv)).join(' ')} 0]`];
}

function sideNode(id, q, material, u, v, lm = '16') {
  const s = node('side');
  s.kv.push(['id', id], ['plane', planeText(q)], ['material', material], ['uaxis', u], ['vaxis', v],
    ['rotation', '0'], ['lightmapscale', lm], ['smoothing_groups', '0']);
  return s;
}

// Same corners (within 0.01), in any order.
export const samePoly = (a, b) => a.length === b.length && a.every(p => b.some(q => Math.hypot(...sub(p, q)) < 0.01));

// Cuts by the plane through q into [front, back] copies (front: the side the plane normal points to; null when empty).
// The cut face copies material and lightmap scale from src, and its axes too unless world is set. Sides that no
// longer touch a piece are dropped; a side whose face the plane cuts loses its displacement (Hammer destroys one whose
// face changes shape; a 3- or 5-sided one stops vbsp) and Hammer++'s vertices_plus (the old corners). Ids are left as
// they are; callers re-id with clone().
export function split(solid, q, src, world) {
  const { n, d } = planeOf(q), fs = faces(solid), ds = fs.flatMap(f => f.pts.map(p => dot(n, p) - d));
  if (Math.max(...ds) <= EPS) return [null, structuredClone(solid)];
  if (Math.min(...ds) >= -EPS) return [structuredClone(solid), null];
  const olds = kids(solid, 'side'), was = new Map(fs.map(f => [f.side, f.pts]));
  return [[...q].reverse(), q].map(pts => {
    const s = structuredClone(solid), ax = axesFor(pts === q ? n : n.map(x => -x)), copies = kids(s, 'side');
    const [u, v] = world ? ['uaxis', 'vaxis'].map((k, i) => `${ax[i]} ${nums(get(src, k))[4] ?? 0.25}`) : [get(src, 'uaxis'), get(src, 'vaxis')];
    s.children.splice(s.children.findLastIndex(c => c.name === 'side') + 1, 0, sideNode('0', pts, get(src, 'material'), u, v, get(src, 'lightmapscale')));
    const live = faces(s);
    s.children = s.children.filter(c => c.name !== 'side' || live.some(f => f.side === c));
    for (const f of live) {
      const i = copies.indexOf(f.side);
      if (i >= 0 && !samePoly(f.pts, was.get(olds[i]) ?? [])) f.side.children = f.side.children.filter(c => c.name !== 'dispinfo' && c.name !== 'vertices_plus');
    }
    return valid(s) ? s : null;
  });
}

// Splits solid by the plane through 3 points q. Returns [front, back] as new solids (front: the side the plane
// normal points to), null for an empty side. The cut face gets the material of the largest side it crosses.
// ids (optional Map): each old side id -> its copies' new ids (clone), for remapSides.
export function clip(solid, q, nextId, ids) {
  const { n, d } = planeOf(q);
  let src = kids(solid, 'side')[0], top = -1;
  for (const f of faces(solid)) {
    const ds = f.pts.map(p => dot(n, p) - d), a = dot(areaVec(f.pts), f.n);
    if (Math.max(...ds) > EPS && Math.min(...ds) < -EPS && a > top) { top = a; src = f.side; }
  }
  return split(solid, q, src, true).map(s => s && clone(s, nextId, ids));
}

// Hammer's Carve: target minus cutter, cut by each cutter plane in turn. Returns the pieces outside the cutter (new ids;
// the cut faces copy the cutter's textures), [] when the cutter swallows the target, or null when they do not overlap.
export function carve(target, cutter, nextId, ids) {
  const out = [];
  let rest = target;
  for (const side of kids(cutter, 'side')) {
    const [front, back] = split(rest, pts3(side), side, false);
    if (!back) return null;
    if (front) out.push(front);
    rest = back;
  }
  return out.map(s => clone(s, nextId, ids));
}

// Hammer's Make Hollow: carves the solid with a copy whose faces move inward by t (outward walls when t < 0).
// Inner faces copy their outer face's texture. Returns the walls, or [] when they would fill the solid.
export function hollow(solid, t, nextId, ids) {
  const grown = by => {
    const s = structuredClone(solid);
    for (const side of kids(s, 'side')) { const { n } = plane(side); set(side, 'plane', planeText(pts3(side).map(p => p.map((x, k) => x + n[k] * by)))); }
    return s;
  };
  const inner = t > 0 ? grown(-t) : solid;
  return (valid(inner) && carve(t > 0 ? solid : grown(-t), inner, nextId, ids)) || [];
}

// Hammer's vertex edit: rebuilds each side's plane from its moved vertices. facePoints holds one point list per side of
// kids(solid, 'side') in faces() order (CCW seen from outside), or null. Points closer than 0.01 merge and a side left
// without area is removed. Leaves the solid unchanged and returns false when a face bends (a point more than 0.01 off
// its plane), the brush is invalid, or its corners are not the given points (a concave shape). A side whose face
// changes shape loses Hammer++'s vertices_plus; its displacement stays on a face that keeps 4 corners (the start corner
// follows its vertex) and goes otherwise, as in Hammer.
export function fromPoints(solid, facePoints) {
  const sides = kids(solid, 'side'), kept = solid.children, old = sides.map(s => [get(s, 'plane'), s.children]);
  const undo = () => { solid.children = kept; sides.forEach((s, i) => { set(s, 'plane', old[i][0]); s.children = old[i][1]; }); return false; };
  const was = new Map(faces(solid).map(f => [f.side, f.pts]));
  const gone = new Set(), want = [], far = (p, l) => !l.some(q => Math.hypot(...sub(p, q)) < 0.01);
  let bent = false;
  sides.forEach((side, i) => {
    const raw = facePoints[i] ?? [], pts = raw.filter((p, j) => !raw.slice(0, j).some(q => Math.hypot(...sub(p, q)) < 0.01));
    const a = pts.length >= 3 ? areaVec(pts) : [0, 0, 0], q = Math.hypot(...a) > 1e-3 && best3(pts);
    if (!q) return void gone.add(side);
    want.push(...pts);
    const was = plane(side);
    if (pts.every(p => Math.abs(dot(was.n, p) - was.d) < 0.01)) return; // still on its plane: keep the plane text
    const { n, d } = planeOf(q);
    bent ||= pts.some(p => Math.abs(dot(n, p) - d) > 0.01);
    if (dot(n, a) < 0) q.reverse();
    set(side, 'plane', planeText(q));
  });
  if (bent) return undo();
  solid.children = kept.filter(c => !gone.has(c));
  const fs = faces(solid), got = fs.flatMap(f => f.pts);
  if (!valid(solid) || got.some(p => far(p, want)) || want.some(p => far(p, got))) return undo();
  for (const f of fs) {
    const before = was.get(f.side), di = kids(f.side, 'dispinfo')[0];
    if (!before || samePoly(f.pts, before)) continue;
    const quad = f.pts.filter((p, j) => !f.pts.slice(0, j).some(q => Math.hypot(...sub(p, q)) < 0.01)).length === 4;
    f.side.children = f.side.children.filter(c => c.name !== 'vertices_plus' && (c !== di || quad));
    const sp = di && quad && nums(get(di, 'startposition'));
    if (sp?.length !== 3) continue;
    const k = before.reduce((b, p, j) => (Math.hypot(...sub(p, sp)) < Math.hypot(...sub(before[b], sp)) ? j : b), 0);
    const p = facePoints[sides.indexOf(f.side)]?.[k];
    if (p) set(di, 'startposition', `[${p.map(fmt).join(' ')}]`);
  }
  return true;
}

// ---------- align and snap (solids and entities) ----------
const solidsOf = n => (n.name === 'solid' ? [n] : kids(n, 'solid'));
// Bounds of a solid or entity; a point entity is its origin.
export function boundsOf(n) {
  const ss = solidsOf(n), o = nums(get(n, 'origin'));
  return ss.length || o.length !== 3 ? bounds(ss.flatMap(faces)) : [o, [...o]];
}

// Moves each node along axis so the min, max or centre of its bounds lines up with that of all the nodes together.
export function alignTo(nodes, side, axis, texLock = true) {
  const bs = nodes.map(boundsOf), at = (lo, hi) => (side === 'min' ? lo : side === 'max' ? hi : (lo + hi) / 2);
  const goal = at(Math.min(...bs.map(b => b[0][axis])), Math.max(...bs.map(b => b[1][axis])));
  nodes.forEach((n, i) => {
    const t = [0, 0, 0];
    t[axis] = goal - at(bs[i][0][axis], bs[i][1][axis]);
    if (t[axis]) transform(n, [1, 1, 1], t, texLock);
  });
}

// Hammer's Snap selected to grid individually: moves each node so its bounds' min corner is on the grid. Sizes and
// vertices stay (snapVertices snaps those).
export function snapToGrid(nodes, grid, texLock = true) {
  for (const n of nodes) {
    const t = boundsOf(n)[0].map(x => Math.round(x / grid) * grid - x);
    if (t.some(Boolean)) transform(n, [1, 1, 1], t, texLock);
  }
}

// Texture coordinates of a faces() entry, per vertex, for a texW x texH texture.
export function uv(f, texW, texH) {
  const [a, b] = ['uaxis', 'vaxis'].map(k => nums(get(f.side, k)));
  return f.pts.map(p => [(dot(p, a) / a[4] + a[3]) / texW, (dot(p, b) / b[4] + b[3]) / texH]);
}

// ---------- node builders ----------
function editor(color) {
  const e = node('editor');
  e.kv.push(['color', color], ['visgroupshown', '1'], ['visgroupautoshown', '1']);
  return e;
}

export function block(mn, mx, material, nextId) {
  const s = node('solid');
  s.kv.push(['id', nextId()]);
  for (let ax = 0; ax < 3; ax++) for (const hi of [0, 1]) {
    const o = [(ax + 1) % 3, (ax + 2) % 3];
    const pt = (a, b) => { const v = []; v[ax] = hi; v[o[0]] = a; v[o[1]] = b; return v.map((h, k) => (h ? mx[k] : mn[k])); };
    const q = [pt(0, 1), pt(1, 1), pt(1, 0)];
    if (cross(sub(q[0], q[1]), sub(q[2], q[1]))[ax] > 0 !== !!hi) q.reverse();
    const [u, v] = axesFor([0, 1, 2].map(k => (k === ax ? (hi ? 1 : -1) : 0))).map(a => a + ' 0.25');
    s.children.push(sideNode(nextId(), q, material, u, v));
  }
  s.children.push(editor(randomColor()));
  return s;
}

const randomColor = () => { const r = () => 100 + Math.floor(Math.random() * 156); return `0 ${r()} ${r()}`; };

// Convex solid from its face polygons (3D points, any winding: each plane is turned to face away from the centroid of
// all points). material: a name, or fn(outward normal) -> name. Texture axes are world-aligned like block().
export function brush(polys, material, nextId) {
  const s = node('solid'), all = polys.flat(), c = all.reduce((a, p) => a.map((x, k) => x + p[k] / all.length), [0, 0, 0]);
  s.kv.push(['id', nextId()]);
  for (const poly of polys) {
    const q = best3(poly);
    if (!q) continue;
    let { n, d } = planeOf(q);
    if (dot(n, c) > d) { q.reverse(); n = n.map(x => -x); }
    const [u, v] = axesFor(n).map(a => a + ' 0.25');
    s.children.push(sideNode(nextId(), q, typeof material === 'function' ? material(n) : material, u, v));
  }
  s.children.push(editor(randomColor()));
  return s;
}

export function entity(classname, origin, nextId) {
  const e = node('entity');
  e.kv.push(['id', nextId()], ['classname', classname], ['origin', origin.map(fmt).join(' ')]);
  e.children.push(editor('220 30 220'));
  return e;
}

// A copy with new ids. ids (optional Map): each old side id -> the new ids its copies got, for remapSides.
export function clone(n, nextId, ids) {
  const c = structuredClone(n);
  (function walk(x) {
    for (const p of x.kv) if (p[0] === 'id') {
      const v = nextId();
      if (ids && x.name === 'side') (ids.get(p[1]) ?? ids.set(p[1], []).get(p[1])).push(v);
      p[1] = v;
    }
    x.children.forEach(walk);
  })(c);
  return c;
}

// Rewrites an entity's side lists (sides / sides2 of info_overlay, info_overlay_transition, env_cubemap) through ids
// (old side id -> new ids, as clone records them). Ids not in it stay, or go with drop. True when one changed.
export function remapSides(e, ids, drop = false) {
  let hit = false;
  for (const p of e.kv) if (/^sides2?$/i.test(p[0])) {
    const v = [...new Set(p[1].split(/\s+/).filter(Boolean).flatMap(x => ids.get(x) ?? (drop ? [] : [x])))].join(' ');
    if (v !== p[1]) { p[1] = v; hit = true; }
  }
  return hit;
}
export const namesSides = (e, ids) => e.kv.some(([k, v]) => /^sides2?$/i.test(k) && v.split(/\s+/).some(x => ids.has(x)));

const hasSolids = e => e.children.some(x => x.name === 'solid' || x.name === 'hidden');

// Moves solids out of the world or other brush entities into a new brush entity placed after the last entity.
// Entities left without solids (hidden ones count) are removed. Returns the new entity.
export function tie(root, world, solids, classname, nextId) {
  for (const c of [world, ...kids(root, 'entity')]) {
    if (!solids.some(s => c.children.includes(s))) continue;
    c.children = c.children.filter(x => !solids.includes(x));
    if (c !== world && !hasSolids(c)) root.children.splice(root.children.indexOf(c), 1);
  }
  const e = node('entity');
  e.kv.push(['id', nextId()], ['classname', classname]);
  e.children.push(...solids, editor('220 30 220'));
  root.children.splice(root.children.findLastIndex(c => c.name === 'entity' || c.name === 'world') + 1, 0, e);
  return e;
}

// Moves a brush entity's solids after the world's last solid (its hidden ones too, still wrapped) and removes the
// entity. Returns the solids that are not hidden.
export function untie(root, world, e) {
  const ss = kids(e, 'solid'), i = root.children.indexOf(e);
  world.children.splice(world.children.findLastIndex(c => c.name === 'solid') + 1, 0, ...ss, ...kids(e, 'hidden'));
  if (i >= 0) root.children.splice(i, 1);
  return ss;
}
