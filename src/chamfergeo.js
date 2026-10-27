// Corner chamfer and fillet (the Chamfer tool). Pure: no DOM, no three.js.
// A corner is a line where two faces meet at an angle. Edges of several brushes on one line are one corner: what is
// solid round it is the union of the brushes. In cuts an outside (convex) corner off, clipping every brush there; Out
// fills an inside (concave) corner with wedge brushes; the corner decides which (In on an inside corner or Out on an
// outside one has no bounded shape). The facets run between the points `size` from the corner along each face: one
// flat bevel, or with segments > 1 a round fillet (facets along the arc tangent to both faces there).
import * as V from '../vmf.js';

const EPS = 0.01, D2R = Math.PI / 180;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(...a); return a.map(x => x / l); };
const clamp1 = x => Math.max(-1, Math.min(1, x));
const off = (f, x) => dot(f.n, x) - dot(f.n, f.pts[0]); // signed distance of x from face f's plane
const coplanar = (g, h) => dot(g.n, h.n) > 1 - 1e-6 && Math.abs(off(g, h.pts[0])) < EPS;
const disp = n => V.kids(n, 'side').some(s => V.kids(s, 'dispinfo').length);

// x inside (or on) one of the convex solids ({ faces }).
export const inside = (ss, x) => ss.some(s => s.faces.every(f => off(f, x) <= 1e-4));

// The solids ({ min, max }) whose box comes within r of the line through p along unit d.
export const near = (ss, p, d, r) => ss.filter(s => {
  const c = s.min.map((x, k) => (x + s.max[k]) / 2);
  return Math.hypot(...cross(sub(c, p), d)) <= Math.hypot(...sub(s.max, s.min)) / 2 + r;
});

// x on face f's polygon (CCW seen from outside), edges included.
const onPoly = (f, x) => f.pts.every((q, i) => {
  const e = sub(f.pts[(i + 1) % f.pts.length], q);
  return dot(cross(e, sub(x, q)), f.n) >= -EPS * Math.hypot(...e);
});

// [t0, t1] where the line p + t d (in face f's plane) crosses f's polygon, or null.
function span(f, p, d) {
  const m = cross(f.n, d), ts = [];
  f.pts.forEach((a, i) => {
    const b = f.pts[(i + 1) % f.pts.length], wa = dot(sub(a, p), m), wb = dot(sub(b, p), m);
    if (Math.abs(wa) <= EPS) ts.push(dot(sub(a, p), d));
    else if (Math.abs(wb) > EPS && wa * wb < 0) ts.push(dot(sub(add(a, sub(b, a), wa / (wa - wb)), p), d));
  });
  return ts.length ? [Math.min(...ts), Math.max(...ts)] : null;
}

// The run of touching intervals that holds 0, merged; null when none holds it.
function reach(ivs) {
  let lo = 0, hi = 0, hit = false, grew = true;
  while (grew) {
    grew = false;
    for (const [a, b] of ivs) if (a <= hi + EPS && b >= lo - EPS && (!hit || a < lo - 1e-9 || b > hi + 1e-9)) { lo = Math.min(lo, a); hi = Math.max(hi, b); grew = hit = true; }
  }
  return hit ? [lo, hi] : null;
}

// [t0, t1] where the line c + t d runs inside convex solid s, or null.
function through(s, c, d) {
  let lo = -Infinity, hi = Infinity;
  for (const f of s.faces) {
    const nd = dot(f.n, d), h = -off(f, c);
    if (Math.abs(nd) < 1e-9) { if (h < -1e-4) return null; } else if (nd > 0) hi = Math.min(hi, h / nd); else lo = Math.max(lo, h / nd);
  }
  return lo < hi - EPS ? [lo, hi] : null;
}

// Stretches [t0, t1] of [lo, hi] along the line (from c.p) between the heights where a brush of ss starts or ends.
function stretches(ss, c, lo, hi) {
  const b = [lo, hi, ...ss.flatMap(s => s.faces.flatMap(f => f.pts.map(q => dot(sub(q, c.p), c.d))))]
    .filter(t => t >= lo && t <= hi).sort((x, y) => x - y).filter((t, i, l) => !i || t - l[i - 1] > EPS);
  return b.slice(1).map((t, i) => [b[i], t]);
}
// At height t (along the line from c.p) both faces reach x from the line: solid just behind each, empty just in front.
const holds = (ss, c, t, x) => c.e.every((e, k) => {
  const q = add(add(c.p, c.d, t), e, x);
  return inside(ss, add(q, c.n[k], -0.05)) && !inside(ss, add(q, c.n[k], 0.05));
});
// Heights to test a cut or wedge at: the run's middle, and near both ends and in the middle of each stretch of it
// (but slivers between vertices a hair apart).
const heights = (ss, c) => [(c.run[0] + c.run[1]) / 2, ...stretches(ss, c, ...c.run).filter(([a, b]) => b - a > 0.1)
  .flatMap(([a, b]) => { const m = Math.min(0.5, (b - a) / 4); return [a + m, (a + b) / 2, b - m]; })];

// The corner along the line through edge a-b of the solids ({ node, faces, owner }: cache entries), looked at where
// the line passes nearest `at`. Returns { p (at, on the line), d, e: the two faces' directions away from the corner, n: their
// outward normals, f: the faces [{ f, s }], convex, angle (degrees, of the solid side for an outside corner, else of the
// empty side), run: [t0, t1] along d from p where the corner goes on (both faces run there, coplanar faces of other
// brushes joined, and bound the solid) } or { error }. hover: the face the edge was picked on; it becomes the first face.
export function corner(ss, a, b, at, hover = null) {
  const d = norm(sub(b, a));
  if (!d.every(Number.isFinite)) return { error: 'the edge has no length' };
  const p = add(a, d, Math.round(dot(sub(at, a), d))); // whole units from a: new planes stay on a's grid
  const fs = ss.flatMap(s => s.faces.filter(f => Math.abs(dot(f.n, d)) < 1e-6 && Math.abs(off(f, p)) < EPS && onPoly(f, p)).map(f => ({ f, s })));
  if (!fs.length) return { error: 'no brush face runs along this edge' };
  // Directions round the line where a face leaves it, then which sectors between them are solid.
  const u = norm(cross(d, Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0])), v = cross(d, u), dir = t => add(u.map(x => x * Math.cos(t)), v, Math.sin(t));
  const rays = fs.flatMap(({ f }) => { const r = cross(f.n, d), t = Math.atan2(dot(r, v), dot(r, u)); return [t, t > 0 ? t - Math.PI : t + Math.PI]; })
    .sort((x, y) => x - y).filter((t, i, l) => !i || t - l[i - 1] > 1e-6);
  if (rays.at(-1) - rays[0] > 2 * Math.PI - 1e-6) rays.pop();
  const n = rays.length, next = i => (i === n - 1 ? rays[0] + 2 * Math.PI : rays[i + 1]);
  const solid = rays.map((t, i) => inside(ss, add(p, dir((t + next(i)) / 2), 0.5)));
  const starts = solid.flatMap((on, i) => (on && !solid[(i + n - 1) % n] ? [i] : [])), j = solid.findIndex((on, i) => !on && solid[(i + n - 1) % n]);
  if (!starts.length) return { error: solid[0] ? 'this edge is inside a brush' : 'no corner here' };
  if (starts.length > 1) return { error: 'more than two faces meet here' };
  const i = starts[0], sweep = (((rays[j] - rays[i]) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  if (Math.abs(sweep - Math.PI) < 1e-3) return { error: 'the faces are flat here, no corner' };
  const convex = sweep < Math.PI;
  let e = (convex ? [rays[i], rays[j]] : [rays[j], rays[i]]).map(dir);
  // The face along each side: it leaves the line that way, and its outward normal points away from the solid side
  // (outside corner) or into the empty side (inside corner).
  const sgn = convex ? -1 : 1, along = (e0, e1) => fs.filter(({ f }) => Math.abs(dot(f.n, e0)) < 1e-4 && sgn * dot(f.n, e1) > 0 && f.pts.some(q => dot(sub(q, p), e0) > EPS));
  const f = [along(e[0], e[1]), along(e[1], e[0])].map(l => l.find(x => x.f === hover) ?? l[0]);
  if (!f[0] || !f[1]) return { error: 'cannot find the two faces of this corner' };
  if (hover && f[1].f === hover) { f.reverse(); e.reverse(); }
  e = f.map(({ f: g }, k) => { const r = cross(g.n, d); return dot(r, e[k]) > 0 ? r : r.map(x => -x); });
  const c = { p, d, e, n: f.map(x => x.f.n), f, convex, angle: (convex ? sweep : 2 * Math.PI - sweep) / D2R };
  const faceRun = g => reach(ss.flatMap(s => s.faces.filter(h => coplanar(g, h)).map(h => span(h, p, d)).filter(Boolean)));
  const [i1, i2] = f.map(x => faceRun(x.f)), iv = stretches(ss, c, Math.max(i1[0], i2[0]), Math.min(i1[1], i2[1]));
  const ok = iv.map(([a, b]) => holds(ss, c, (a + b) / 2, 0.25));
  let lo = iv.findIndex(([a, b], k) => ok[k] && a <= EPS && b >= -EPS), hi = lo;
  if (lo < 0) return { error: 'no corner here' };
  while (lo > 0 && ok[lo - 1]) lo--;
  while (hi < iv.length - 1 && ok[hi + 1]) hi++;
  return { ...c, run: [iv[lo][0], iv[hi][1]] };
}

// Facet corners from T1 = p + s e1 to T2 = p + s e2: a straight bevel, or segs facets along the arc tangent to both
// faces there. On a corner line along an axis the inner points are rounded to whole units from p, unless that bends
// the chain the other way somewhere (a nearly flat corner) or past a face.
function arc(c, s, segs) {
  const [e1, e2] = c.e, T1 = add(c.p, e1, s), T2 = add(c.p, e2, s);
  if (segs <= 1) return [T1, T2];
  const half = Math.acos(clamp1(dot(e1, e2))) / 2, ctr = add(c.p, norm(add(e1, e2)), s / Math.cos(half)), R = s * Math.tan(half);
  const g = c.convex ? 1 : -1, a = c.n[0].map(x => x * g), b = c.n[1].map(x => x * g), phi = Math.acos(clamp1(dot(a, b))), w = norm(add(b, a, -dot(a, b)));
  const ax = c.d.findIndex(x => Math.abs(x) > 1 - 1e-9), raw = [T1];
  for (let k = 1; k < segs; k++) { const t = (phi * k) / segs; raw.push(add(ctr, add(a.map(x => x * Math.cos(t)), w, Math.sin(t)), R)); }
  raw.push(T2);
  const rounded = raw.map((q, i) => (ax < 0 || !i || i === segs ? q : q.map((x, k) => (k === ax ? x : c.p[k] + Math.round(x - c.p[k])))));
  const turns = l => { const m = [add(c.p, e1, 2 * s), ...l, add(c.p, e2, 2 * s)]; return l.map((q, i) => dot(cross(sub(q, m[i]), sub(m[i + 2], q)), c.d)); };
  const want = turns(raw), pts = turns(rounded).every((x, i) => x * want[i] > 1e-9) ? rounded : raw;
  return pts.filter((q, i) => !i || Math.hypot(...sub(q, pts[i - 1])) > EPS);
}

// Facet planes (3 points, vmf.js order) with unit normals: toward the corner for In (the cut-off side in front),
// away from it for Out (the wedge's outer face).
const facets = (c, A) => A.slice(1).map((b, k) => {
  const a = A[k], q = [a, b, add(a, c.d, 64)];
  let n = norm(cross(sub(q[0], q[1]), sub(q[2], q[1])));
  if (dot(n, sub(c.p, a)) > 0 !== c.convex) { q.reverse(); n = n.map(x => -x); }
  return { a, b, q, n };
});

// 3 plane points (vmf.js order) through m with normal `want`.
function plane3(m, want) {
  const u = norm(cross(want, Math.abs(want[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0])), q = [m, add(m, u, 64), add(m, cross(want, u), 64)];
  return dot(cross(sub(q[0], q[1]), sub(q[2], q[1])), want) > 0 ? q : q.reverse();
}

// ---------- texture ----------
const fmt = x => { const r = Math.round(x * 1e6) / 1e6; return String(Math.abs(r - Math.round(r)) < 1e-4 ? Math.round(r) + 0 : r); };
const angleAbout = (a, b, d) => Math.atan2(dot(cross(a, b), d), dot(a, b)) / D2R;
// A side-like node for vmf.js split / the wedge faces: material, and axes and lightmap scale when given.
const look = (material, ax, lm) => ({ name: 'side', kv: [['material', material], ...(ax ? [['uaxis', ax[0]], ['vaxis', ax[1]]] : []), ...(lm ? [['lightmapscale', lm]] : [])], children: [] });
// src's material and alignment on each facet: its axes [x y z shift scale] turned onto facet after facet about the
// seam they share (from the first facet, or from the last with back), so the texture runs round the corner unbroken.
function wrap(src, srcN, fs, d, back) {
  let ax = ['uaxis', 'vaxis'].map(k => V.nums(V.get(src, k))), n = srcN;
  if (ax.some(a => a.length !== 5)) ax = null;
  const out = [];
  for (let i = 0; i < fs.length; i++) {
    const k = back ? fs.length - 1 - i : i, f = fs[k], c = back ? f.b : f.a;
    if (ax) ax = ax.map(a => { const r = V.rotation(d, angleAbout(n, f.n, d)).map(row => dot(row, a)); return [...r, a[3] + (dot(c, a) - dot(c, r)) / a[4], a[4]]; });
    n = f.n;
    out[k] = look(V.get(src, 'material'), ax?.map(a => `[${a.slice(0, 4).map(fmt).join(' ')}] ${fmt(a[4])}`), V.get(src, 'lightmapscale'));
  }
  return out;
}

// ---------- In and Out ----------
// Refusals for both: displacements, a size past either face's end (or where it bends) at any height along the run.
function check(ss, c, s, hs) {
  if (c.f.some(x => V.kids(x.f.side, 'dispinfo').length)) return 'displacement faces cannot be chamfered';
  return hs.every(t => [0.25 * s, 0.5 * s, 0.75 * s, s - 0.05].every(x => holds(ss, c, t, x))) ? null : `size ${s} runs past the end of a face (or where it bends)`;
}

// The facets stay inside the solid at height t: 0.05 behind each, the brushes cover it from end to end (0.1 in), and
// the points where two facets meet. Else the cut would open the corner through to the other side.
const backed = (ss, c, fs, t) => fs.every((f, i) => {
  const a = add(add(f.a, c.d, t), f.n, -0.05), L = Math.hypot(...sub(f.b, f.a)) - 0.2, u = norm(sub(f.b, f.a));
  return (L <= 0 || reach(ss.map(s => through(s, add(a, u, 0.1), u)).filter(Boolean))?.[1] >= L - EPS)
    && (!i || inside(ss, add(add(f.a, c.d, t), norm(add(f.n, fs[i - 1].n)), -0.05)));
});

// In: clips every brush whose part in front of the facets lies in the corner (between the two face planes) and that
// overlaps the corner's run along the line. The part of a brush past an end of the run is split off and kept as it is;
// its new end takes the look of a face on that plane facing it (a floor top), else the corner's material.
// cur: node -> its pieces so far ([]: cut away whole).
function cut(ss, c, o, cur) {
  const s = o.size, hs = heights(ss, c), err = check(ss, c, s, hs);
  if (err) return err;
  const fs = facets(c, arc(c, s, o.segments));
  if (!hs.every(t => backed(ss, c, fs, t))) return `size ${s} cuts through to the other side (or into a gap between brushes)`;
  const [lo, hi] = c.run, inCorner = q => c.n.every(n => dot(n, sub(q, c.p)) <= 0.05);
  const piece = (y, srcs) => {
    const ts = V.faces(y).flatMap(g => g.pts.map(q => dot(sub(q, c.p), c.d))), keep = [];
    if (Math.min(...ts) >= hi - EPS || Math.max(...ts) <= lo + EPS) return null;
    for (const [t, sg] of [[hi, 1], [lo, -1]]) {
      if (sg * (sg > 0 ? Math.max(...ts) : Math.min(...ts)) <= sg * t + EPS) continue;
      const dir = c.d.map(x => x * sg), m = add(c.p, c.d, t);
      const cap = o.material ? null : ss.flatMap(z => z.faces).find(h => dot(h.n, dir) < -1 + 1e-6 && Math.abs(off(h, m)) < EPS)?.side;
      const [front, back] = V.split(y, plane3(m, dir), cap ?? look(o.material ?? V.get(c.f[0].f.side, 'material')), !cap);
      if (!back) return null; // only a sliver on the run
      if (front) { keep.push(front); y = back; } // else only a sliver past it: cut with the rest
    }
    let hit = false;
    for (const [k, f] of fs.entries()) {
      const [front, back] = V.split(y, f.q, srcs[k], !!o.material || V.get(srcs[k], 'uaxis') === undefined);
      if (!front) continue;
      if (!V.faces(front).every(g => g.pts.every(inCorner))) return null; // it pokes out of the corner: left as it is
      hit = true;
      y = back;
      if (!y) break;
    }
    return hit ? [...keep, y].filter(Boolean) : null;
  };
  let count = 0;
  for (const x of ss) {
    // the new faces take this brush's own face on either face plane (else the corner's first face)
    const own = g => x.faces.find(h => coplanar(g, h)), s1 = own(c.f[0].f), s2 = !s1 && own(c.f[1].f);
    const srcs = o.material ? fs.map(() => look(o.material)) : s1 ? wrap(s1.side, s1.n, fs, c.d, false) : s2 ? wrap(s2.side, s2.n, fs, c.d, true) : wrap(c.f[0].f.side, c.n[0], fs, c.d, false);
    let hit = false;
    const ys = (cur.get(x.node) ?? [x.node]).flatMap(y => { const r = piece(y, srcs); hit ||= !!r; return r ?? [y]; });
    if (!hit) continue;
    if (disp(x.node)) return 'displacement brushes cannot be chamfered';
    cur.set(x.node, ys);
    count++;
  }
  return count ? null : 'nothing to cut at this corner';
}

// Out: one wedge per facet (a fan from the corner line), over the run both faces share where the corner is empty.
// Wedges go in the func_detail of the faces when both are func_detail.
function fill(ss, c, o, adds, nextId) {
  const s = o.size, err = check(ss, c, s, heights(ss, c));
  if (err) return err;
  const probe = add(c.p, add(c.e[0], c.e[1]), s / 4);
  if (inside(ss, probe)) return 'something already fills this corner';
  let [lo, hi] = c.run;
  for (const x of ss) {
    const r = through(x, probe, c.d);
    if (r?.[1] <= EPS) lo = Math.max(lo, r[1]); else if (r?.[0] >= -EPS) hi = Math.min(hi, r[0]);
  }
  if (hi - lo < 1) return 'no room for a wedge here';
  const fs = facets(c, arc(c, s, o.segments)), at = (q, t) => add(q, c.d, t), [f1, f2] = c.f;
  if (fs.some(f => inside(ss, add(add(c.p, f.a), f.b).map(x => x / 3)))) return 'another brush stands in this corner';
  const looks = o.material ? fs.map(() => look(o.material)) : wrap(f1.f.side, c.n[0], fs, c.d, false);
  const plain = look(o.material ?? V.get(f1.f.side, 'material'));
  // a cap takes a coplanar face's look (the walls' tops), else the plain one
  const cap = (t, n) => (o.material ? null : ss.flatMap(x => x.faces).find(h => dot(h.n, n) > 1 - 1e-6 && Math.abs(off(h, at(c.p, t))) < EPS)?.side) ?? plain;
  const detail = x => x.s.owner?.name === 'entity' && V.get(x.s.owner, 'classname') === 'func_detail';
  const owner = detail(f1) && detail(f2) ? f1.s.owner : null, ed = V.kids(f1.s.node, 'editor')[0];
  for (const [k, f] of fs.entries()) {
    const tri = [c.p, f.a, f.b], quad = (q, r) => [at(q, lo), at(r, lo), at(r, hi), at(q, hi)];
    const polys = [tri.map(q => at(q, lo)), tri.map(q => at(q, hi)), quad(c.p, f.a), quad(f.a, f.b), quad(f.b, c.p)];
    const roles = [cap(lo, c.d.map(x => -x)), cap(hi, c.d), o.material || k ? plain : f1.f.side, looks[k], o.material || k < fs.length - 1 ? plain : f2.f.side];
    const b = V.brush(polys, 'x', nextId), sides = V.kids(b, 'side');
    if (sides.length !== 5 || !V.valid(b)) return 'the wedge would be too thin to be a brush';
    sides.forEach((sd, i) => { for (const key of ['material', 'uaxis', 'vaxis', 'lightmapscale']) { const val = V.get(roles[i], key); if (val !== undefined) V.set(sd, key, val); } });
    if (ed) b.children = [...b.children.filter(x => x.name !== 'editor'), structuredClone(ed)];
    adds.push({ solid: b, owner });
  }
  return null;
}

// corners: corner() results, applied in order: In for an outside corner, Out for an inside one. o: { size, segments,
// material } (material: a name for every new face, world-aligned; null: the adjacent faces' material and alignment).
// Returns { cuts: [[node, pieces ([]: cut away whole)]], adds: [{ solid, owner (the func_detail entity, or null: the
// world) }], error }. nextId: ids for the new brushes; without it (a preview) the pieces keep the old ids and new faces
// have id '0'. ids (Map): old side id -> new ids, for remapSides.
export function chamfer(ss, corners, o, nextId, ids) {
  const cur = new Map(), adds = [];
  for (const c of corners) {
    const err = c.error ?? (c.convex ? cut(ss, c, o, cur) : fill(ss, c, o, adds, nextId ?? (() => '0')));
    if (err) return { error: err, cuts: [], adds: [] };
  }
  return { cuts: [...cur].map(([n, ys]) => [n, nextId ? ys.map(y => V.clone(y, nextId, ids)) : ys]), adds };
}
