// Poly edit geometry (3ds Max Editable Poly on brushes). A brush is a polygon mesh { v: points, f: [{ vs, side }] }
// (faces CCW seen from outside; side: the VMF side giving the face its material and texture). Edits change the mesh and
// build() turns it back into valid brushes: close vertices weld, a bent face splits into triangles (convex folds first)
// that merge again where coplanar, a concave result is cut into convex pieces along its own face planes (a BSP) and the
// pieces merge again while their union stays convex. Faces keep their texture (texture lock: the axes follow the
// face's own move). Plane edits (chamfer, delete face) cut the brush directly. Pure, node-testable.
import * as V from '../vmf.js';
import { convexParts, join, inside, clipConvex, segCross, area as area2 } from './poly2d.js';

const EPS = 0.01, BIG = 1e5;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = a => Math.hypot(a[0], a[1], a[2]);
const unit = a => { const l = len(a); return l > 1e-12 ? mul(a, 1 / l) : [0, 0, 0]; };
const fmt = x => String(Math.round(x * 1e6) / 1e6 + 0);
const centre = ps => mul(ps.reduce(add, [0, 0, 0]), 1 / ps.length);
// Area vector (Newell): length = area, direction = normal of a CCW polygon, bent ones too.
const newell = ps => {
  const n = [0, 0, 0];
  ps.forEach((a, i) => {
    const b = ps[(i + 1) % ps.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  });
  return mul(n, 0.5);
};
// u, w in the plane with u x w = n
const basis = n => { const u = unit(cross(n, Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0])); return [u, cross(n, u)]; };
const pts = (m, vs) => vs.map(i => m.v[i]);
export const normal = (m, fc) => unit(newell(pts(m, fc.vs)));
export const area = (m, fc) => len(newell(pts(m, fc.vs)));

// Position keys: elements of different brushes on the same spot share a key (sticky selection).
export const key = p => p.map(x => Math.round(x * 1000) / 1000 + 0).join(' ');
export const ek = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
export const vertexKey = (m, i) => key(m.v[i]);
export const edgeKey = (m, a, b) => [key(m.v[a]), key(m.v[b])].sort().join('|');
export const faceKey = (m, fc) => fc.vs.map(i => key(m.v[i])).sort().join(';');

// ---------- mesh ----------
// The mesh of a solid: its faces() polygons with shared corners as one vertex.
export function meshOf(solid) {
  const v = [], at = new Map(), f = [];
  for (const fc of V.faces(solid)) {
    const vs = fc.pts.map(p => { const k = key(p); if (!at.has(k)) { at.set(k, v.length); v.push(p); } return at.get(k); });
    const u = vs.filter((x, i) => x !== vs[(i + 1) % vs.length]);
    if (u.length >= 3) f.push({ vs: u, side: fc.side });
  }
  return { v, f };
}

// Undirected edges: 'a|b' -> { a, b, f: [face indices] }.
export function edgeMap(m) {
  const map = new Map();
  m.f.forEach((fc, fi) => fc.vs.forEach((a, i) => {
    const b = fc.vs[(i + 1) % fc.vs.length], k = ek(a, b);
    (map.get(k) ?? map.set(k, { a: Math.min(a, b), b: Math.max(a, b), f: [] }).get(k)).f.push(fi);
  }));
  return map;
}

// The mesh with vertex i at fn(p, i) (undefined: stays). old: the positions before, for texture lock.
export const moved = (m, fn) => ({ v: m.v.map((p, i) => fn(p, i) ?? p), f: m.f, old: m.v });

// Drops a -> b -> a spikes (a face merged with itself across two edges).
function despike(vs) {
  vs = [...vs];
  for (let i = 0; vs.length > 2 && i < vs.length;) {
    const L = vs.length;
    if (vs[i] === vs[(i + 1) % L] || vs[(i + L - 1) % L] === vs[(i + 1) % L]) { vs.splice(i, 1); i = 0; } else i++;
  }
  return vs;
}

// Vertices closer than EPS merge (the first one stays); faces lose repeated corners, and ones left without area go.
function weld(m) {
  const old = m.old ?? m.v, rep = m.v.map((_, i) => i);
  for (let i = 0; i < m.v.length; i++) for (let j = 0; j < i; j++) if (rep[j] === j && len(sub(m.v[i], m.v[j])) < EPS) { rep[i] = j; break; }
  const idx = new Map(), v = [], o = [];
  const map = i => { const r = rep[i]; if (!idx.has(r)) { idx.set(r, v.length); v.push(m.v[r]); o.push(old[r]); } return idx.get(r); };
  const f = [];
  for (const fc of m.f) {
    const vs = despike(fc.vs.map(map).filter((x, i, a) => x !== a[(i + 1) % a.length]));
    if (new Set(vs).size >= 3 && len(newell(vs.map(i => v[i]))) > 1e-6) f.push({ ...fc, vs });
  }
  // a face that collapsed onto a line went, leaving corners on its neighbours' edges (edges without a twin): they go
  // into those edges
  const used = [...new Set(f.flatMap(fc => fc.vs))], half = new Set(f.flatMap(fc => fc.vs.map((a, i) => `${a}>${fc.vs[(i + 1) % fc.vs.length]}`)));
  for (const fc of f) fc.vs = fc.vs.flatMap((a, i) => {
    const b = fc.vs[(i + 1) % fc.vs.length], d = sub(v[b], v[a]), l2 = dot(d, d), on = [];
    if (half.has(`${b}>${a}`)) return [a];
    for (const k of used) {
      const t = dot(sub(v[k], v[a]), d) / l2;
      if (!fc.vs.includes(k) && t > 1e-6 && t < 1 - 1e-6 && len(sub(v[k], add(v[a], mul(d, t)))) < EPS) on.push([t, k]);
    }
    return [a, ...on.sort((x, y) => x[0] - y[0]).map(x => x[1])];
  });
  return { v, f, old: o };
}

// ---------- planar faces ----------
const flat = (vs, v) => {
  const ps = vs.map(i => v[i]), n = unit(newell(ps)), d = dot(n, centre(ps));
  return n.some(Boolean) && ps.every(p => Math.abs(dot(n, p) - d) <= EPS);
};
// Triangles of a planar polygon (any simple shape): fans of its convex parts.
function triangles(vs, v) {
  const ps = vs.map(i => v[i]), n = unit(newell(ps)), [u, w] = basis(n);
  if (vs.length === 3) return [vs];
  return convexParts(ps.map((p, k) => [dot(p, u), dot(p, w), vs[k]])).flatMap(c => c.slice(1, -1).map((p, j) => [c[0][2], p[2], c[j + 2][2]]));
}
// Every triangulation of polygon vs (Catalan(n - 2) of them: 132 for 8 corners).
function triangulations(vs) {
  if (vs.length < 3) return [[]];
  const out = [];
  for (let k = 1; k + 1 < vs.length; k++) for (const L of triangulations(vs.slice(0, k + 1))) for (const R of triangulations(vs.slice(k))) out.push([...L, [vs[0], vs[k], vs.at(-1)], ...R]);
  return out;
}
// A face as planar pieces (index polygons): itself when flat, else triangles - the triangulation with the fewest
// concave folds, fat ones on a tie (a convex fold keeps a brush in one piece; up to 8 corners every triangulation is
// tried, past that the fans from each corner) - merged again where neighbours are coplanar.
function planar(vs, v) {
  if (flat(vs, v)) return [vs];
  const n = unit(newell(vs.map(i => v[i])));
  const fans = () => vs.map((_, k) => vs.slice(1, -1).map((_, i) => [vs[k], vs[(k + i + 1) % vs.length], vs[(k + i + 2) % vs.length]]));
  let best = null;
  for (const tri of vs.length <= 8 ? triangulations(vs) : fans()) {
    const ns = tri.map(t => newell(t.map(i => v[i])));
    if (ns.some(a => dot(a, n) <= 1e-9)) continue;
    let bad = 0;
    for (let i = 0; i < tri.length; i++) for (let j = 0; j < tri.length; j++) {
      const o = tri[j].filter(x => !tri[i].includes(x));
      if (i !== j && o.length === 1 && dot(unit(ns[i]), sub(v[o[0]], v[tri[i][0]])) > EPS) bad++;
    }
    const thin = Math.min(...ns.map(len));
    if (!best || bad < best.bad || (bad === best.bad && thin > best.thin)) best = { tri, bad, thin };
  }
  const out = best?.tri ?? triangles(vs, v);
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < out.length && !merged; i++) for (let j = i + 1; j < out.length && !merged; j++) {
      const m = join(out[i], out[j]);
      if (m && flat(m, v)) { out[i] = m; out.splice(j, 1); merged = true; }
    }
  }
  return out;
}

// ---------- checks ----------
const volumeOf = polys => polys.reduce((s, ps) => { let t = 0; for (let i = 1; i + 1 < ps.length; i++) t += dot(ps[0], cross(ps[i], ps[i + 1])); return s + t / 6; }, 0);

// Segment p-q through the inside of triangle a, b, c (touching its border or ends does not count).
function segTri(p, q, a, b, c) {
  const d = sub(q, p), e1 = sub(b, a), e2 = sub(c, a), h = cross(d, e2), det = dot(e1, h);
  if (Math.abs(det) < 1e-9 * Math.max(1, len(d) * len(e1) * len(e2))) return false;
  const s = sub(p, a), u = dot(s, h) / det, r = cross(s, e1), w = dot(d, r) / det, t = dot(e2, r) / det, k = 1e-6;
  return t > k && t < 1 - k && u > k && w > k && u + w < 1 - k;
}
// Whether an edge passes through a face it does not belong to (faces crossing each other).
function crossing(faces, v) {
  const es = new Map(), tris = [];
  for (const vs of faces) {
    vs.forEach((a, i) => { const b = vs[(i + 1) % vs.length]; es.set(ek(a, b), [a, b]); });
    const own = new Set(vs);
    for (const t of triangles(vs, v)) tris.push([t, own]);
  }
  for (const [a, b] of es.values()) for (const [t, own] of tris) if (!own.has(a) && !own.has(b) && segTri(v[a], v[b], v[t[0]], v[t[1]], v[t[2]])) return true;
  return false;
}
// Whether faces facing the same way on one plane overlap (an inner face dragged across its ring; crossing() cannot see
// that) or a face crosses itself. Faces facing each other may overlap: the shape opens there (a dent pulled through
// a face; the volume check sees whether the pieces fill it), unless they fold out past it (onSurface).
function overlapping(polys) {
  const gs = [];
  for (const ps of polys) {
    const n = unit(newell(ps));
    let g = gs.find(G => dot(G.n, n) > 0.9 && ps.every(p => Math.abs(dot(G.n, p) - G.d) <= EPS));
    if (!g) gs.push((g = { n, d: dot(n, ps[0]), ps: [] }));
    g.ps.push(ps);
  }
  for (const g of gs) {
    const [u, w] = basis(g.n), qs = g.ps.map(ps => ps.map(p => [dot(p, u), dot(p, w)]));
    for (const q of qs) for (let i = 0; i < q.length; i++) for (let j = i + 2; j < q.length; j++) if ((i || j < q.length - 1) && segCross(q[i], q[i + 1], q[j], q[(j + 1) % q.length], 1e-6)) return true;
    if (qs.length < 2) continue;
    const parts = qs.map(q => convexParts(q));
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) for (const a of parts[i]) for (const b of parts[j]) if (Math.abs(area2(clipConvex(a, b))) > 0.1) return true;
  }
  return false;
}

// p on convex polygon ps (its plane, inside or on its border).
function onPoly(p, ps) {
  const n = unit(newell(ps));
  return Math.abs(dot(n, sub(p, ps[0]))) <= EPS && ps.every((a, i) => { const e = sub(ps[(i + 1) % ps.length], a); return dot(cross(e, sub(p, a)), n) >= -EPS * len(e); });
}

// ---------- texture ----------
// uaxis / vaxis for a face whose points moved from olds to news (same order), so its texture moves with it: a face
// that moves or turns as a whole (rigidly) carries its axes along and the shifts follow. A face that is stretched or
// reshaped keeps its axes, so textures never stretch or shear. null: keep the axes as written.
function lockTex(side, olds, news) {
  const ax = ['uaxis', 'vaxis'].map(k => V.nums(V.get(side, k))), q = V.best3(olds);
  if (!q || ax.some(a => a.length !== 5 || !a[4])) return null;
  const frame = ([a, b, c]) => { const u = unit(sub(b, a)), w = unit(sub(sub(c, a), mul(u, dot(sub(c, a), u)))); return [u, w, cross(u, w)]; };
  const k = q.map(p => olds.indexOf(p)), F = frame(q), G = frame(k.map(i => news[i]));
  const R = x => G.reduce((s, g, i) => add(s, mul(g, dot(F[i], x))), [0, 0, 0]), t = sub(news[k[0]], R(olds[k[0]]));
  if (news.some((p, i) => len(sub(add(R(olds[i]), t), p)) > EPS)) return null;
  if (len(t) < 1e-9 && F.every((f, i) => len(sub(f, G[i])) < 1e-9)) return null;
  return ax.map(a => { const r = R(a); return `[${r.map(fmt).join(' ')} ${fmt(a[3] - dot(t, r) / a[4])}] ${a[4]}`; });
}
// Least squares for 3 unknowns (normal equations, Cramer); null when singular.
function lsq(rows, b) {
  const M = [0, 1, 2].map(i => [0, 1, 2].map(j => rows.reduce((s, r) => s + r[i] * r[j], 0))), y = [0, 1, 2].map(i => rows.reduce((s, r, k) => s + r[i] * b[k], 0));
  const det = m => dot(m[0], cross(m[1], m[2])), D = det(M);
  if (Math.abs(D) < 1e-9) return null;
  return [0, 1, 2].map(c => det(M.map((r, i) => r.map((x, j) => (j === c ? y[i] : x)))) / D);
}
const worldTex = (side, n) => { const [u, w] = V.axesFor(n), s = k => V.nums(V.get(side, k))[4] || 0.25; return [`${u} ${s('uaxis')}`, `${w} ${s('vaxis')}`]; };

// A new side copying src's keys (material, lightmap scale, ...) with plane q, axes tex ([u, v] text or null: src's).
function sideFrom(src, q, tex, id) {
  const s = { name: 'side', kv: src.kv.map(p => [...p]), children: [] };
  V.set(s, 'id', id);
  V.set(s, 'plane', V.planeText(q));
  if (tex) { V.set(s, 'uaxis', tex[0]); V.set(s, 'vaxis', tex[1]); }
  return s;
}

// ---------- convex pieces ----------
const sideOf = (ps, n, d) => { let lo = Infinity, hi = -Infinity; for (const p of ps) { const x = dot(n, p) - d; lo = Math.min(lo, x); hi = Math.max(hi, x); } return hi > EPS && lo < -EPS ? 2 : hi > EPS ? 1 : lo < -EPS ? -1 : 0; };
// [front, back] parts of a convex polygon.
function cutPoly(ps, n, d) {
  const f = [], b = [];
  ps.forEach((a, i) => {
    const c = ps[(i + 1) % ps.length], da = dot(n, a) - d, dc = dot(n, c) - d;
    if (da >= -EPS) f.push(a);
    if (da <= EPS) b.push(a);
    if ((da < -EPS && dc > EPS) || (da > EPS && dc < -EPS)) { const p = add(a, mul(sub(c, a), da / (da - dc))); f.push(p); b.push(p); }
  });
  return [f, b];
}
const clipBack = (ps, n, d) => cutPoly(ps, n, d)[1];

// Solid-leaf BSP over convex polygons { pts, pl }: a split with nothing behind it is a piece of the inside; one with
// nothing in front is outside. Planes with everything behind them go first, then the one splitting the fewest polygons;
// an extra plane through concave edges (it needs polygons on both sides) goes before a face plane splitting as many,
// since a face plane cut past its face slices through parts that were fine. cells gets each inside piece as its bounding planes [{ pi, flip }] (flip: the far side of plane pi).
function bsp(polys, planes, path, cells, seams, depth = 0) {
  if (depth > 256) throw new Error('bsp too deep');
  let pick = -1, score = Infinity;
  for (const pi of [...new Set(polys.map(x => x.pl)), ...(seams ? planes.keys().filter(i => planes[i].extra) : [])]) {
    const { n, d, extra, area } = planes[pi];
    let fr = 0, bk = 0, sp = 0;
    for (const x of polys) { if (x.pl === pi) continue; const c = sideOf(x.pts, n, d); if (c === 2) sp++; else if (c === 1) fr++; else if (c === -1) bk++; }
    if (extra && (!fr || !bk)) continue;
    const s = !fr && !sp ? 0 : (sp ? 2 + sp : 1) - (extra ? 0.5 : area * 1e-12);
    if (s < score) { score = s; pick = pi; if (!s) break; }
  }
  const { n, d } = planes[pick], front = [], back = [];
  for (const x of polys) {
    if (x.pl === pick) continue;
    const c = sideOf(x.pts, n, d);
    if (c === 1) front.push(x);
    else if (c === -1) back.push(x);
    else if (c === 2) { const [f, b] = cutPoly(x.pts, n, d); if (f.length >= 3) front.push({ pl: x.pl, pts: f }); if (b.length >= 3) back.push({ pl: x.pl, pts: b }); }
  }
  if (front.length) bsp(front, planes, [...path, { pi: pick, flip: true }], cells, seams, depth + 1);
  if (back.length) bsp(back, planes, [...path, { pi: pick, flip: false }], cells, seams, depth + 1);
  else cells.push([...path, { pi: pick, flip: false }]);
}

const oriented = (planes, o) => { const P = planes[o.pi]; return o.flip ? { n: mul(P.n, -1), d: -P.d } : P; };
// A convex cell from its planes: the faces (huge quad on each plane clipped by the others; redundant planes give none),
// its corners and volume.
function cellOf(list, planes) {
  const pl = list.map(o => oriented(planes, o)), fs = [];
  pl.forEach(({ n, d }, i) => {
    const [u, w] = basis(n);
    let ps = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => add(mul(n, d), add(mul(u, a * BIG), mul(w, b * BIG))));
    pl.forEach((q, j) => { if (j !== i && ps.length) ps = clipBack(ps, q.n, q.d); });
    if (ps.length >= 3 && len(newell(ps)) > 1e-6) fs.push({ o: list[i], pts: ps });
  });
  const keep = list.filter(o => fs.some(f => f.o === o));
  return { planes: keep, fs, pts: fs.flatMap(f => f.pts), vol: volumeOf(fs.map(f => f.pts)), open: fs.some(f => f.pts.some(p => len(p) > BIG / 2)) };
}

// Cells whose union is convex merge (the union of convex A and B is convex exactly when the planes of A and B that
// have every corner of both behind them close a region of their summed volume).
function mergeCells(cells, planes) {
  for (let again = true; again;) {
    again = false;
    for (let i = 0; i < cells.length && !again; i++) for (let j = i + 1; j < cells.length && !again; j++) {
      const A = cells[i], B = cells[j], all = [...A.pts, ...B.pts], seen = new Set();
      const cand = [...A.planes, ...B.planes].filter(o => {
        const k = o.pi + (o.flip ? '-' : '+');
        if (seen.has(k)) return false;
        seen.add(k);
        const { n, d } = oriented(planes, o);
        return all.every(p => dot(n, p) - d <= EPS);
      });
      const c = cellOf(cand, planes);
      if (!c.open && Math.abs(c.vol - A.vol - B.vol) <= 1e-3 * Math.max(1, A.vol + B.vol)) { cells[i] = c; cells.splice(j, 1); again = true; }
    }
  }
  return cells;
}

// ---------- mesh -> brushes ----------
// mesh: { v, f: [{ vs, side, fresh }], old } (fresh faces get world-aligned axes; old: each vertex's position before the
// edit, for texture lock). src: the solid the mesh came from, or the convex pieces of an earlier build of it (ids,
// editor blocks and unchanged sides carry over). Returns { solids (largest first; piece k keeps src piece k's id and
// editor node), mesh (welded, planar, its faces on the new sides: the edit mesh for next time), error } - error and no
// solids when the result would have no volume or faces would cross or overlap.
export function build(mesh, src, { nextId = () => '0', texLock = true } = {}) {
  const srcs = [src].flat(), w = weld(mesh), pf = [];
  for (const fc of w.f) for (const vs of planar(fc.vs, w.v)) pf.push({ ...fc, vs });
  const out = { v: w.v, f: pf.map(fc => ({ vs: fc.vs, side: fc.side })) }, polys = pf.map(fc => fc.vs.map(i => w.v[i]));
  const vol = volumeOf(polys);
  if (!(vol > 0.1)) return { error: 'the brush would have no volume (or be turned inside out)', mesh: out };
  if (crossing(pf.map(fc => fc.vs), w.v)) return { error: 'faces would cross each other', mesh: out };
  if (overlapping(polys)) return { error: 'faces would overlap', mesh: out };

  // planes of the faces; coplanar faces facing the same way share one
  const planes = [];
  pf.forEach((fc, k) => {
    const ps = polys[k], n = unit(newell(ps));
    let pi = planes.findIndex(P => dot(P.n, n) > 0.9 && ps.every(p => Math.abs(dot(P.n, p) - P.d) <= EPS));
    if (pi < 0) {
      const q = V.best3(ps);
      if (dot(V.planeOf(q).n, n) < 0) q.reverse();
      const { n: pn, d } = V.planeOf(q);
      pi = planes.push({ n: pn, d, q, faces: [], area: 0 }) - 1;
    }
    planes[pi].faces.push(k);
    planes[pi].area += len(newell(ps));
    fc.pl = pi;
  });
  for (const P of planes) P.faces.sort((a, b) => len(newell(polys[b])) - len(newell(polys[a])));
  // planes through two concave edges in one plane: a cut there splits no face (the seam an extrude or a step leaves)
  const dir = new Map(), reflex = [];
  pf.forEach((fc, k) => fc.vs.forEach((a, i) => dir.set(`${a}>${fc.vs[(i + 1) % fc.vs.length]}`, k)));
  for (const [ab, k1] of dir) {
    const [a, b] = ab.split('>').map(Number), k2 = dir.get(`${b}>${a}`), P = planes[pf[k1].pl];
    if (a < b && k2 !== undefined && pf[k2].vs.some(i => dot(P.n, w.v[i]) - P.d > EPS)) reflex.push([w.v[a], w.v[b], k1]);
  }
  for (let i = 0; i < reflex.length; i++) for (let j = i + 1; j < reflex.length && planes.length < 300; j++) {
    const ps = [...reflex[i].slice(0, 2), ...reflex[j].slice(0, 2)], q = V.best3(ps), pl = q && V.planeOf(q);
    if (!pl || ps.some(p => Math.abs(dot(pl.n, p) - pl.d) > EPS) || planes.some(P => Math.abs(dot(P.n, pl.n)) > 1 - 1e-9 && Math.abs(P.d * Math.sign(dot(P.n, pl.n)) - pl.d) < EPS)) continue;
    planes.push({ n: pl.n, d: pl.d, q, faces: [reflex[i][2]], area: 0, extra: true });
  }

  // with and without the seam planes; the fewer pieces win
  const bspPolys = pf.flatMap(fc => convexOf(fc.vs, w.v).map(ps => ({ pts: ps, pl: fc.pl })));
  let cells = null;
  for (const seams of planes.some(P => P.extra) ? [true, false] : [false]) {
    const leaves = [];
    try { bsp(bspPolys, planes, [], leaves, seams); } catch { continue; }
    const cs = mergeCells(leaves.map(l => cellOf(l, planes)).filter(c => !c.open && c.vol > 1e-3), planes);
    if (!cells || cs.length < cells.length) cells = cs;
  }
  if (!cells) return { error: 'could not split the brush into convex pieces', mesh: out };
  cells.sort((a, b) => b.vol - a.vol);
  const sum = cells.reduce((s, c) => s + c.vol, 0);
  if (!cells.length || Math.abs(sum - vol) > 1e-3 * Math.max(1, vol)) return { error: 'faces would cross each other', mesh: out };
  // every corner on the pieces: faces folded over their neighbours leave a fin of corners out in the air
  const cf = cells.flatMap(c => c.fs.map(f => f.pts));
  if ([...new Set(pf.flatMap(fc => fc.vs))].some(i => !cf.some(ps => onPoly(w.v[i], ps)))) return { error: 'faces would overlap', mesh: out };

  // textures per planar face
  const was = srcs.flatMap(V.faces), srcSides = srcs.flatMap(x => V.kids(x, 'side'));
  const tex = pf.map((fc, k) => {
    if (fc.fresh) return worldTex(fc.side, planes[fc.pl].n);
    if (!texLock || !w.old) return null;
    return lockTex(fc.side, fc.vs.map(i => w.old[i]), polys[k]);
  });
  // parts of one side on one plane that would move its texture differently (a sub-face moved in its plane): it stays
  const parts = Map.groupBy(pf.keys().filter(k => !pf[k].fresh), k => pf[k].pl + '|' + srcSides.indexOf(pf[k].side));
  for (const ks of parts.values()) if (new Set(ks.map(k => String(tex[k]))).size > 1) ks.forEach(k => { tex[k] = null; });
  // a face moved as a whole without turning: its displacement goes along
  const shift = pf.map(fc => { if (!w.old) return null; const t = sub(w.v[fc.vs[0]], w.old[fc.vs[0]]); return fc.vs.every(i => len(sub(sub(w.v[i], w.old[i]), t)) < EPS) ? t : null; });
  // the face of plane o under the cell face pts: the one around its middle (null: a seam between pieces), else the
  // plane's largest
  const faceAt = (o, ps) => {
    const P = planes[o.pi], [u, wv] = basis(P.n), c = centre(ps), c2 = [dot(c, u), dot(c, wv)];
    return (o.flip ? undefined : P.faces.find(k => inside(c2, polys[k].map(p => [dot(p, u), dot(p, wv)])))) ?? null;
  };

  // unchanged faces (same corners, texture not moved) keep their side node, and so do unchanged seams between pieces
  // (sides no face of the mesh uses); the rest get new sides (the first copy of a side keeps its id)
  const meshSides = new Set(pf.map(fc => fc.side)), used = new Set(), ids = new Set(), plan = cells.map(c => c.fs.map(f => {
    const P = planes[f.o.pi], n = f.o.flip ? mul(P.n, -1) : P.n, at = faceAt(f.o, f.pts), k = at ?? P.faces[0];
    const same = g => !used.has(g.side) && dot(g.n, n) > 1 - 1e-9 && V.samePoly(g.pts, f.pts);
    const old = (!tex[k] && !pf[k].fresh && was.find(g => g.side === pf[k].side && same(g))) || (at === null && was.find(g => !meshSides.has(g.side) && same(g)));
    if (old) { used.add(old.side); ids.add(V.get(old.side, 'id')); return { keep: old.side }; }
    return { f, k, seam: at === null ? n : null };
  }));
  const solids = cells.map((c, ci) => {
    const sides = plan[ci].map(p => {
      if (p.keep) return p.keep;
      const fc = pf[p.k], id = V.get(fc.side, 'id'), q = p.f.o.flip ? [...planes[p.f.o.pi].q].reverse() : planes[p.f.o.pi].q;
      const s = sideFrom(fc.side, q, p.seam ? worldTex(fc.side, p.seam) : tex[p.k], ids.has(id) || id === undefined ? nextId() : id), di = V.kids(fc.side, 'dispinfo')[0], sp = di && V.nums(V.get(di, 'startposition'));
      if (shift[p.k] && sp?.length === 3 && V.samePoly(p.f.pts, polys[p.k])) {
        const c = structuredClone(di);
        V.set(c, 'startposition', `[${add(sp, shift[p.k]).map(fmt).join(' ')}]`);
        s.children.push(c);
      }
      ids.add(id);
      return s;
    });
    sides.sort((a, b) => (srcSides.indexOf(a) + 1 || 1e9) - (srcSides.indexOf(b) + 1 || 1e9));
    const from = srcs[ci], rest = (from ?? srcs[0]).children.filter(x => x.name !== 'side');
    return { name: 'solid', kv: from ? from.kv.map(p => [...p]) : [['id', nextId()]], children: [...sides, ...(from ? rest : structuredClone(rest))] };
  });
  if (!solids.every(V.valid)) return { error: 'could not build valid brushes from this shape', mesh: out };
  // the edit mesh, each face on the new side under its middle (else one on its plane)
  const got = solids.flatMap(V.faces);
  out.f = pf.map((fc, k) => {
    const P = planes[fc.pl], [u, wv] = basis(P.n), c = centre(polys[k]), c2 = [dot(c, u), dot(c, wv)];
    const on = got.filter(g => dot(g.n, P.n) > 1 - 1e-6 && Math.abs(dot(g.n, g.pts[0]) - P.d) < EPS);
    return { vs: fc.vs, side: (on.find(g => inside(c2, g.pts.map(p => [dot(p, u), dot(p, wv)]))) ?? on[0])?.side ?? fc.side };
  });
  return { solids, mesh: out };
}
// Convex polygons (points) of a planar face.
function convexOf(vs, v) {
  const ps = vs.map(i => v[i]), n = unit(newell(ps)), [u, w] = basis(n);
  const parts = convexParts(ps.map((p, k) => [dot(p, u), dot(p, w), k]));
  return parts.length ? parts.map(c => c.map(q => ps[q[2]])) : [ps];
}

// ---------- mesh edits ----------
function patches(m, fs, em) {
  const left = new Set(fs), out = [];
  while (left.size) {
    const first = left.values().next().value, P = [first];
    left.delete(first);
    for (let i = 0; i < P.length; i++) for (const [a, b] of pairs(m.f[P[i]].vs)) for (const g of em.get(ek(a, b)).f) if (left.has(g)) { left.delete(g); P.push(g); }
    out.push(P);
  }
  return out;
}
const pairs = vs => vs.map((a, i) => [a, vs[(i + 1) % vs.length]]);
// Each vertex's offset so every face of the patch at it moves 1 along its own normal.
function offsets(m, P) {
  const at = new Map();
  for (const fi of P) for (const i of m.f[fi].vs) (at.get(i) ?? at.set(i, []).get(i)).push(normal(m, m.f[fi]));
  return i => {
    const ns = at.get(i).filter((n, k, a) => a.findIndex(x => dot(x, n) > 1 - 1e-6) === k);
    if (ns.length === 1) return ns[0];
    if (ns.length === 2) return mul(add(ns[0], ns[1]), 1 / (1 + dot(ns[0], ns[1])));
    return lsq(ns, ns.map(() => 1)) ?? unit(ns.reduce(add));
  };
}

// Extrudes faces fs (Set of face indices) by h: 'group' moves each connected patch along its mean normal, 'local'
// moves each vertex so every face moves h along its own normal, 'poly' extrudes each face on its own. Side walls join
// the patch border to the moved faces (they take the material of the face they grow from, world-aligned).
export function extrude(m, fs, h, type = 'group') {
  const v = [...m.v], old = [...m.v], f = m.f.map(x => ({ ...x })), em = edgeMap(m);
  for (const P of type === 'poly' ? [...fs].map(i => [i]) : patches(m, fs, em)) {
    const inP = new Set(P), dup = new Map(), N = unit(P.reduce((s, i) => add(s, newell(pts(m, m.f[i].vs))), [0, 0, 0]));
    const off = type === 'local' ? offsets(m, P) : () => N;
    const nv = i => { if (!dup.has(i)) { dup.set(i, v.length); v.push(add(m.v[i], mul(off(i), h))); old.push(m.v[i]); } return dup.get(i); };
    for (const fi of P) {
      for (const [a, b] of pairs(m.f[fi].vs)) if (!em.get(ek(a, b)).f.some(g => g !== fi && inP.has(g))) f.push({ vs: [a, b, nv(b), nv(a)], side: m.f[fi].side, fresh: true });
      f[fi] = { ...m.f[fi], vs: m.f[fi].vs.map(nv) };
    }
  }
  return { v, f, old };
}

// Each corner of face fc moved inward along the face by t (its sides offset, mitred). null when it turns over.
function offsetFace(m, fc, t) {
  const ps = pts(m, fc.vs), n = normal(m, fc), L = ps.length;
  const w = ps.map((p, k) => unit(cross(n, sub(ps[(k + 1) % L], p))));
  const q = ps.map((p, k) => { const a = w[(k + L - 1) % L], b = w[k], c = 1 + dot(a, b); return c < 1e-6 ? null : add(p, mul(add(a, b), t / c)); });
  if (q.some(x => !x) || q.some((x, k) => dot(sub(q[(k + 1) % L], x), sub(ps[(k + 1) % L], ps[k])) <= 1e-6)) return null;
  return { q, n };
}

// Insets each face of fs by t: a smaller face inside it and a ring of faces round it, all on its plane (the brush keeps
// its shape until the inner face moves). { mesh, faces (inner face indices) } or { error }.
export function inset(m, fs, t) {
  if (!(t > 0)) return { error: 'inset: the amount must be more than 0' };
  const v = [...m.v], f = m.f.map(x => ({ ...x }));
  for (const fi of fs) {
    const r = offsetFace(m, m.f[fi], t);
    if (!r) return { error: 'inset: the amount is too large for a face' };
    const ix = r.q.map(p => v.push(p) - 1), vs = m.f[fi].vs;
    vs.forEach((a, k) => f.push({ vs: [a, vs[(k + 1) % vs.length], ix[(k + 1) % vs.length], ix[k]], side: m.f[fi].side }));
    f[fi] = { ...m.f[fi], vs: ix };
  }
  return { mesh: { v, f, old: v }, faces: [...fs] };
}

// Bevels each face of fs: moves it h along its normal with its outline grown by o (o < 0 shrinks it), side walls
// joining it to where it was. { mesh } or { error }.
export function bevel(m, fs, h, o) {
  const v = [...m.v], old = [...m.v], f = m.f.map(x => ({ ...x }));
  for (const fi of fs) {
    const fc = m.f[fi], r = offsetFace(m, fc, -o);
    if (!r) return { error: 'bevel: the outline is too small for a face' };
    const ix = r.q.map(p => { v.push(add(p, mul(r.n, h))); old.push(p); return v.length - 1; });
    pairs(fc.vs).forEach(([a, b], k) => f.push({ vs: [a, b, ix[(k + 1) % ix.length], ix[k]], side: fc.side, fresh: true }));
    f[fi] = { ...fc, vs: ix };
  }
  return { mesh: { v, f, old } };
}

// Corners of polygon r (indices) from a round to b, both included.
const arc = (r, a, b) => { const out = []; for (let j = r.indexOf(a); ; j = (j + 1) % r.length) { out.push(r[j]); if (r[j] === b) return out; } };

// Max's Connect: splits faces across the selected edges (index keys 'a|b'). A face with two of them gets segs edges
// between points spaced evenly along both; one with more gets an edge from each one's middle point to its centre.
// Points on an edge go into the faces on both sides. { mesh, edges: new edges as index pairs }.
export function connect(m, sel, segs = 1) {
  segs = Math.max(1, Math.round(segs));
  const v = [...m.v], em = edgeMap(m), split = new Map(), made = [];
  const on = m.f.map(fc => pairs(fc.vs).filter(([a, b]) => sel.has(ek(a, b))));
  for (const es of on) if (es.length >= 2) for (const [a, b] of es) {
    const k = ek(a, b), e = em.get(k);
    if (!split.has(k)) split.set(k, Array.from({ length: segs }, (_, i) => v.push(add(m.v[e.a], mul(sub(m.v[e.b], m.v[e.a]), (i + 1) / (segs + 1)))) - 1));
  }
  if (!split.size) return { mesh: m, edges: [] };
  // points of edge a -> b in that order
  const along = (a, b) => { const s = split.get(ek(a, b)); return !s ? [] : a < b ? s : [...s].reverse(); };
  const f = [];
  m.f.forEach((fc, fi) => {
    const ring = pairs(fc.vs).flatMap(([a, b]) => [a, ...along(a, b)]), es = on[fi];
    if (es.length < 2) return void f.push({ ...fc, vs: ring });
    if (es.length === 2) {
      const p = along(...es[0]), q = along(...es[1]);
      let polys = [ring];
      for (let i = 0; i < segs; i++) {
        const x = p[i], y = q[segs - 1 - i], k = polys.findIndex(r => r.includes(x) && r.includes(y));
        polys.splice(k, 1, arc(polys[k], x, y), arc(polys[k], y, x));
        made.push([x, y]);
      }
      for (const vs of polys) f.push({ ...fc, vs });
      return;
    }
    const c = v.push(centre(pts(m, fc.vs))) - 1, mids = es.map(([a, b]) => along(a, b)[Math.floor((segs - 1) / 2)]).sort((x, y) => ring.indexOf(x) - ring.indexOf(y));
    mids.forEach((x, i) => {
      f.push({ ...fc, vs: [...arc(ring, x, mids[(i + 1) % mids.length]), c] });
      made.push([x, c]);
    });
  });
  return { mesh: { v, f, old: v }, edges: made };
}
// Max's vertex Connect: each face holding two or more of the selected vertices (indices) splits along new edges from
// each of them to the next one round the face, unless a part would have no area or face the other way (the two share
// an edge, the corners between them are in a line, the edge runs outside a concave face) or the edge would cross the
// face's outline (in and out of a concave face). { mesh, edges: new edges as index pairs }.
export function connectVerts(m, verts) {
  const f = [], made = [];
  for (const fc of m.f) {
    const s = fc.vs.filter(i => verts.has(i)), polys = [fc.vs], n = normal(m, fc), [u, w] = basis(n), p2 = i => [dot(m.v[i], u), dot(m.v[i], w)];
    if (s.length > 1) s.forEach((x, i) => {
      const y = s[(i + 1) % s.length], k = polys.findIndex(r => r.includes(x) && r.includes(y)), ab = [arc(polys[k], x, y), arc(polys[k], y, x)];
      if (ab.some(q => dot(newell(pts(m, q)), n) < 1e-6) || pairs(polys[k]).some(([a, b]) => segCross(p2(x), p2(y), p2(a), p2(b)))) return;
      polys.splice(k, 1, ...ab);
      made.push([x, y]);
    });
    for (const vs of polys) f.push({ ...fc, vs });
  }
  return { mesh: { v: m.v, f, old: m.v }, edges: made };
}

// Max's Remove: the faces on both sides of each edge become one (vertices left inside one face go). The brush keeps
// its corners, so its shape only changes where a face was bent. Returns the mesh.
export function removeEdges(m, sel) {
  let f = m.f.map(x => ({ ...x }));
  for (const k of sel) {
    const [a, b] = k.split('|').map(Number), has = (vs, x, y) => pairs(vs).some(([p, q]) => p === x && q === y);
    const i = f.findIndex(x => has(x.vs, a, b)), j = f.findIndex(x => has(x.vs, b, a));
    if (i < 0 || j < 0 || i === j) continue;
    const vs = join(f[i].vs, f[j].vs);
    if (!vs) continue;
    f[i] = { ...(area(m, f[i]) >= area(m, f[j]) ? f[i] : f[j]), vs: despike(vs) };
    f.splice(j, 1);
  }
  const uses = new Map();
  for (const fc of f) for (const i of new Set(fc.vs)) uses.set(i, (uses.get(i) ?? 0) + 1);
  f = f.map(fc => ({ ...fc, vs: fc.vs.filter(i => uses.get(i) > 1) })).filter(fc => fc.vs.length >= 3);
  return { v: m.v, f, old: m.v };
}
// Removes vertices: the faces round each one become one face without it.
export function removeVerts(m, verts) {
  const ks = [...edgeMap(m).values()].filter(e => verts.has(e.a) || verts.has(e.b)).map(e => ek(e.a, e.b));
  return removeEdges(m, ks);
}

// ---------- plane edits ----------
// solid cut by half-spaces { q (3 points, normal outward), from: side } (inside: behind the plane). New faces copy
// from's material and lightmap scale with world-aligned axes; sides left without a face go, reshaped faces lose
// vertices_plus and displacements. Same ids, new sides from nextId(). null when nothing valid is left.
export function cutBy(solid, cuts, nextId) {
  const s = structuredClone(solid), was = new Map(V.faces(solid).map(f => [V.get(f.side, 'id'), f.pts]));
  s.children.splice(s.children.findLastIndex(c => c.name === 'side') + 1, 0, ...cuts.map(c => {
    const side = sideFrom(c.from, c.q, worldTex(c.from, V.planeOf(c.q).n), nextId());
    V.set(side, 'rotation', '0');
    return side;
  }));
  return tidy(s, was);
}
function tidy(s, was) {
  const fs = V.faces(s);
  s.children = s.children.filter(c => c.name !== 'side' || fs.some(f => f.side === c));
  for (const f of fs) { const p = was.get(V.get(f.side, 'id')); if (p && !V.samePoly(f.pts, p)) f.side.children = f.side.children.filter(c => c.name !== 'vertices_plus' && c.name !== 'dispinfo'); }
  return V.valid(s) ? s : null;
}
// The solid without the given sides, closed by the planes of the others; null when they leave it open.
export function withoutSides(solid, sides) {
  const s = structuredClone(solid), was = new Map(V.faces(solid).map(f => [V.get(f.side, 'id'), f.pts])), ids = new Set(sides.map(x => V.get(x, 'id')));
  s.children = s.children.filter(c => c.name !== 'side' || !ids.has(V.get(c, 'id')));
  return tidy(s, was);
}

const slerp = (a, b, t) => {
  const c = Math.max(-1, Math.min(1, dot(a, b))), th = Math.acos(c);
  return th < 1e-9 ? a : unit(add(mul(a, Math.sin((1 - t) * th) / Math.sin(th)), mul(b, Math.sin(t * th) / Math.sin(th))));
};
const outward = (q, n) => (dot(V.planeOf(q).n, n) < 0 ? [...q].reverse() : q);
// Chamfers edges of the brush (mesh m of solid, index keys 'a|b'): faces set back dist along both faces, in segs
// flat strips round an arc tangent to both, at most as far as the far corners of either face (Max stops there too).
// Edges between coplanar faces are skipped. The new solid or null.
export function chamferEdges(solid, m, sel, dist, segs = 1, nextId = () => '0') {
  const em = edgeMap(m), cuts = [];
  segs = Math.max(1, Math.round(segs));
  for (const k of sel) {
    const e = em.get(k);
    if (!e || e.f.length !== 2) continue;
    let [F1, F2] = e.f.map(i => m.f[i]), a = e.a, b = e.b;
    if (!pairs(F1.vs).some(([p, q]) => p === a && q === b)) [a, b] = [b, a];
    const p = m.v[a], dir = unit(sub(m.v[b], p)), n1 = normal(m, F1), n2 = normal(m, F2);
    if (dot(n1, n2) > 1 - 1e-6) continue;
    const w1 = unit(cross(n1, dir)), w2 = unit(cross(n2, mul(dir, -1))), reach = (F, w) => Math.max(...F.vs.map(i => dot(sub(m.v[i], p), w)));
    const t = Math.min(dist, reach(F1, w1), reach(F2, w2)), r = t * Math.tan(Math.acos(Math.max(-1, Math.min(1, dot(w1, w2)))) / 2);
    const C = sub(add(p, mul(w1, t)), mul(n1, r)), from = area(m, F1) >= area(m, F2) ? F1.side : F2.side;
    const at = i => (i === 0 ? add(p, mul(w1, t)) : i === segs ? add(p, mul(w2, t)) : add(C, mul(slerp(n1, n2, i / segs), r)));
    for (let i = 0; i < segs; i++) {
      const A = at(i), B = at(i + 1);
      cuts.push({ q: outward([A, add(A, mul(dir, 64)), B], add(slerp(n1, n2, i / segs), slerp(n1, n2, (i + 1) / segs))), from });
    }
  }
  return cuts.length ? cutBy(solid, cuts, nextId) : null;
}
// Chamfers vertices (indices): a face through the points dist along each of their edges cuts the corner off.
export function chamferVerts(solid, m, verts, dist, nextId = () => '0') {
  const em = [...edgeMap(m).values()], cuts = [];
  for (const i of verts) {
    const nb = em.filter(e => e.a === i || e.b === i).map(e => (e.a === i ? e.b : e.a)), p = m.v[i];
    if (nb.length < 3) continue;
    const ps = nb.map(j => add(p, mul(unit(sub(m.v[j], p)), Math.min(dist, len(sub(m.v[j], p)) * 0.999))));
    const n = unit(nb.reduce((s, j) => add(s, unit(sub(p, m.v[j]))), [0, 0, 0])), c = centre(ps), [u, w] = basis(n);
    const q = nb.length === 3 ? ps : [add(c, u), c, add(c, w)];
    const from = m.f.filter(fc => fc.vs.includes(i)).sort((x, y) => area(m, y) - area(m, x))[0].side;
    cuts.push({ q: outward(q, n), from });
  }
  return cuts.length ? cutBy(solid, cuts, nextId) : null;
}

// ---------- selection helpers (index elements of one mesh) ----------
// Max's Ring: across each quad face the opposite edge, on and on.
export function ringOf(m, k0) {
  const em = edgeMap(m), out = new Set([k0]), todo = [k0];
  while (todo.length) {
    const k = todo.pop();
    for (const fi of em.get(k)?.f ?? []) {
      const vs = m.f[fi].vs;
      if (vs.length !== 4) continue;
      const i = pairs(vs).findIndex(([a, b]) => ek(a, b) === k), o = ek(vs[(i + 2) % 4], vs[(i + 3) % 4]);
      if (!out.has(o)) { out.add(o); todo.push(o); }
    }
  }
  return out;
}
// Max's Loop: through each end vertex with four edges, on along the edge that shares no face with this one.
export function loopOf(m, k0) {
  const em = edgeMap(m), out = new Set([k0]), todo = [k0];
  while (todo.length) {
    const k = todo.pop(), e = em.get(k);
    if (!e) continue;
    for (const v of [e.a, e.b]) {
      const at = [...em.entries()].filter(([, x]) => x.a === v || x.b === v);
      if (at.length !== 4) continue;
      const next = at.find(([, x]) => !x.f.some(fi => e.f.includes(fi)));
      if (next && !out.has(next[0])) { out.add(next[0]); todo.push(next[0]); }
    }
  }
  return out;
}
