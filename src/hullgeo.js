// Convex hulls for brushes: Hammer++'s Merge (one brush, the hull of the selected brushes' corners) and the polygon
// tool's prism (the 2D hull of clicked points, extruded). Pure, node-testable.
import * as V from '../vmf.js';
import { hull } from './poly2d.js';

const EPS = 0.01;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// The faces of the 3D convex hull of points as Hammer planes: 3 points each (the largest triangle among the points on
// the face, wound so the normal points out), each face once. [] when the points span no volume. Every triple of
// points not on a face found already is tried as a face: all points behind it or on it.
// ponytail: O(n^3) in the corners (20 boxes 19 ms, 256 corners 0.7 s); quickhull if merging big selections gets slow.
export function hullPlanes(points) {
  const ps = [];
  for (const p of points) if (!ps.some(q => Math.hypot(...sub(p, q)) < EPS)) ps.push(p);
  const c = ps.reduce((s, p) => s.map((x, k) => x + p[k] / ps.length), [0, 0, 0]), found = [], out = [];
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) for (let k = j + 1; k < ps.length; k++) {
    if (found.some(f => f.has(i) && f.has(j) && f.has(k))) continue;
    const n = cross(sub(ps[j], ps[i]), sub(ps[k], ps[i])), l = Math.hypot(...n);
    if (l < 1e-6) continue;
    const u = n.map(x => x / l), d = dot(u, ps[i]);
    let lo = false, hi = false;
    for (const p of ps) { const s = dot(u, p) - d; if (s > EPS) hi = true; else if (s < -EPS) lo = true; if (lo && hi) break; }
    if (lo && hi) continue;
    if (!lo && !hi) return []; // every point on one plane
    const on = ps.map((p, m) => m).filter(m => Math.abs(dot(u, ps[m]) - d) <= EPS), q = V.best3(on.map(m => ps[m]));
    found.push(new Set(on));
    const pl = V.planeOf(q);
    out.push(dot(pl.n, c) > pl.d ? q.reverse() : q);
  }
  return out;
}

// Hammer++'s Merge: one solid, the convex hull of the solids' corners, with the first solid's keys (its id) and other
// children (editor block). A hull face on the plane of an old face (the same way round) copies the first such side:
// material, axes, lightmap scale, its plane text, and its children (displacement, vertices_plus) while the face is
// unchanged. Other faces take the first solid's first material with face-aligned axes. Every side gets a new id; ids
// (optional Map) records each old side id -> the new side ids on its plane ([] when none), for remapSides. null when
// the corners span no volume.
export function merge(solids, nextId, ids) {
  const olds = solids.flatMap(s => V.faces(s).map(f => ({ ...f, d: dot(f.n, f.pts[0]) })));
  const planes = hullPlanes(olds.flatMap(f => f.pts)), first = solids[0], from = new Map();
  if (!planes.length) return null;
  const mat = V.get(V.kids(first, 'side')[0] ?? { kv: [] }, 'material') ?? 'TOOLS/TOOLSNODRAW';
  if (ids) for (const f of olds) ids.set(V.get(f.side, 'id'), []);
  const s = { name: 'solid', kv: first.kv.map(p => [...p]), children: planes.map(q => {
    const { n, d } = V.planeOf(q), on = olds.filter(f => dot(f.n, n) > 1 - 1e-6 && Math.abs(f.d - d) < EPS), id = nextId();
    const [u, v] = V.axesFor(n).map(a => a + ' 0.25');
    const side = { name: 'side', kv: on.length ? on[0].side.kv.map(p => [...p]) : [['id', id], ['plane', V.planeText(q)], ['material', mat], ['uaxis', u], ['vaxis', v], ['rotation', '0'], ['lightmapscale', '16'], ['smoothing_groups', '0']], children: [] };
    V.set(side, 'id', id);
    if (on.length) from.set(side, on[0]);
    if (ids) for (const f of on) ids.get(V.get(f.side, 'id')).push(id);
    return side;
  }) };
  const fs = V.faces(s);
  s.children = s.children.filter(x => fs.some(f => f.side === x)); // planes that touch the hull in an edge or corner
  for (const f of fs) { const o = from.get(f.side); if (o && V.samePoly(f.pts, o.pts)) f.side.children = structuredClone(o.side.children); }
  s.children.push(...structuredClone(first.children.filter(x => x.name !== 'side')));
  return V.valid(s) ? s : null;
}

// The polygon tool's brush: the 2D convex hull of pts ([x, y] along the view axes ax) as a prism from lo to hi along
// the third axis, in material with world-aligned axes (vmf brush). null when the points are in a line or lo >= hi.
export function prism(pts, ax, lo, hi, material, nextId) {
  const h = hull(pts), k = 3 - ax[0] - ax[1];
  if (h.length < 3 || !(hi > lo)) return null;
  const at = (p, z) => { const q = [0, 0, 0]; q[ax[0]] = p[0]; q[ax[1]] = p[1]; q[k] = z; return q; };
  const wall = (p, i) => { const b = h[(i + 1) % h.length]; return [at(p, lo), at(b, lo), at(b, hi), at(p, hi)]; };
  const s = V.brush([h.map(p => at(p, lo)), h.map(p => at(p, hi)), ...h.map(wall)], material, nextId);
  return V.valid(s) ? s : null;
}
