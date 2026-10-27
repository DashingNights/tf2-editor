// Roof slab between two walls (the Roof tool). Pure: no DOM, no three.js.
// A wall is a picked face plus its brush's faces. Its inner face is the upright face toward the other wall (the picked
// face itself when it is upright and faces that way); in plan that face is a segment on the wall's inner line. The
// roof covers the gap between the two segments, trimmed to where they overlap (extend: carried on to the longer one),
// and the wall tops out to their outer faces between the same end lines (tops), so roof and walls meet face to face.
import * as V from '../vmf.js';
import { sub, dot, cross, area, hull, clipHalf, convexParts, simplify } from './poly2d.js';

// height: 'flush' (bottom at the lower wall's top), 'flat' (at the higher top, closed down to the lower wall) or
// 'slope' (from one wall's top to the other's); tops: cover the wall tops; extend: run on to the longer wall's ends;
// detail: the tool ties the result to func_detail (else world brushes, grouped).
export const DEFAULTS = { height: 'flush', thickness: 16, tops: true, extend: false, detail: true };
export const ROOF = 'DEV/DEV_MEASUREGENERIC01';
const up = f => Math.abs(f.n[2]) < 0.1;
const len = a => Math.hypot(a[0], a[1]);
const unit = a => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };
const centre = f => [0, 1, 2].map(k => f.pts.reduce((s, p) => s + p[k], 0) / f.pts.length);
// coordinates within 1e-4 of a whole unit snap to it: float noise would leave near-duplicate corners and planes
const snap = p => p.map(x => (Math.abs(x - Math.round(x)) < 1e-4 ? Math.round(x) : x));
const foot = (p, o, u) => { const s = dot(u, sub(p, o)); return snap([o[0] + u[0] * s, o[1] + u[1] * s]); };
const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
const fmt = x => String(Math.round(x * 10) / 10);

// An upright face's extent along the wall (in plan, square to its normal).
const span = f => { const n = unit(f.n), s = f.pts.map(p => n[1] * p[0] - n[0] * p[1]); return Math.max(...s) - Math.min(...s); };
// The wall's long upright sides: its ends (under half the longest side) left out.
const sides = wall => { const fs = wall.faces.filter(up), l = Math.max(0, ...fs.map(span)); return fs.filter(f => span(f) >= l / 2); };

// The wall's upright face toward the plan point `to`: the picked face when it is upright and faces it, else the long
// side that faces it most (not an end face, which offset walls would face more).
export function innerFace(wall, to) {
  const f = wall.face, toward = g => dot(g.n, unit(sub(to, centre(g))));
  if (up(f) && toward(f) > 0) return f;
  return sides(wall).reduce((b, g) => (!b || toward(g) > toward(b) ? g : b), null);
}

// An upright face in plan: normal n, the way u it runs (n turned by `sign`, so both walls' segments run the same way),
// its ends p0, p1 along u and its top z.
function seg(f, sign) {
  const n = unit(f.n), u = sign > 0 ? [n[1], -n[0]] : [-n[1], n[0]], top = f.pts.reduce((a, p) => (p[2] > a[2] ? p : a));
  const o = dot(n, top), s = f.pts.map(p => dot(u, p)), at = t => snap([n[0] * o + u[0] * t, n[1] * o + u[1] * t]);
  return { n, u, p0: at(Math.min(...s)), p1: at(Math.max(...s)), z: top[2] };
}

// Faces of the upright prism over poly from z0(p) up to z1(p).
function prism(poly, z0, z1) {
  const d = poly.map(p => [p[0], p[1], z0(p)]), u = poly.map(p => [p[0], p[1], z1(p)]);
  return [d, u, ...poly.map((_, i) => { const j = (i + 1) % poly.length; return [d[i], d[j], u[j], u[i]]; })];
}

// Level pieces at the same heights whose union is convex become one (fewer brushes, no inner faces).
function merge(ps) {
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
    const p = ps[i], q = ps[j];
    if (p.slope || q.slope || p.z0 !== q.z0 || p.z1 !== q.z1) continue;
    const h = simplify(hull([...p.poly, ...q.poly]));
    if (Math.abs(Math.abs(area(h)) - Math.abs(area(p.poly)) - Math.abs(area(q.poly))) < 0.5) { ps[i] = { ...p, poly: h }; ps.splice(j, 1); j = i; }
  }
  return ps;
}

// Corners of a convex part with heights p[2] lie on one plane (a triangle always does).
function planar(poly) {
  const [a, b, c] = poly, e = sub(b, a), g = sub(c, a), den = cross(e, g);
  return Math.abs(den) < 1e-9 || poly.slice(3).every(p => {
    const s = cross(sub(p, a), g) / den, r = cross(e, sub(p, a)) / den;
    return Math.abs(a[2] + s * (b[2] - a[2]) + r * (c[2] - a[2]) - p[2]) < 0.01;
  });
}

// A, B: { face: { pts, n, side }, faces: [the brush's faces] } (V.faces shape). Returns { solids, info, warnings } or
// { error }.
export function build(A, B, opts = {}, nextId = () => '0') {
  const o = { ...DEFAULTS, ...opts }, t = Math.max(1, +o.thickness || 16);
  if (!A?.face || !B?.face) return { error: 'pick a face on each wall' };
  const fa = innerFace(A, centre(B.face)), fb = innerFace(B, centre(A.face));
  if (!fa || !fb) return { error: 'a picked brush has no upright face' };
  const a = seg(fa, 1), b = seg(fb, -1);
  if (dot(a.n, sub(mid(b.p0, b.p1), mid(a.p0, a.p1))) < 1 || dot(b.n, sub(mid(a.p0, a.p1), mid(b.p0, b.p1))) < 1)
    return { error: 'the faces do not face each other across a gap: pick the inner sides (or the tops) of two walls' };
  // Where one wall runs on past the other's end (q further along both walls than p; ends of angled walls on a line
  // between the two square ones count as level): trimmed to the other's end, or (extend) the other carried on to it.
  // A trim is square to the wall that ends there, flush with its end face (square to the longer one would leave a
  // wedge past the shorter wall's end when the walls are angled).
  let [a0, a1, b0, b1] = [a.p0, a.p1, b.p0, b.p1];
  const past = (p, q) => dot(a.u, sub(q, p)) > 0.5 && dot(b.u, sub(q, p)) > 0.5;
  // the point of the line through o along u level with p along w
  const flush = (p, o, u, w) => { const k = dot(w, u); return Math.abs(k) < 1e-6 ? foot(p, o, u) : snap([o[0] + (u[0] * dot(w, sub(p, o))) / k, o[1] + (u[1] * dot(w, sub(p, o))) / k]); };
  if (past(a0, b0)) { if (o.extend) b0 = foot(a0, b0, b.u); else a0 = flush(b0, a0, a.u, b.u); }
  else if (past(b0, a0)) { if (o.extend) a0 = foot(b0, a0, a.u); else b0 = flush(a0, b0, b.u, a.u); }
  if (past(b1, a1)) { if (o.extend) b1 = foot(a1, b1, b.u); else a1 = flush(b1, a1, a.u, b.u); }
  else if (past(a1, b1)) { if (o.extend) a1 = foot(b1, a1, a.u); else b1 = flush(a1, b1, b.u, a.u); }
  if (dot(a.u, sub(a1, a0)) < 1 || dot(b.u, sub(b1, b0)) < 1) return { error: 'the faces do not overlap along the walls: turn on Extend' };
  // The gap, corners carrying their wall's top as p[2] (slope).
  const quad = [[...a0, a.z], [...a1, a.z], [...b1, b.z], [...b0, b.z]], gap = convexParts(quad);
  if (!gap.length) return { error: 'the faces cross: pick two walls with a gap between them' };
  // End lines through each pair of ends (where the ends meet, square to the walls' mean direction); the wall tops
  // between them carry the roof's ends straight on.
  const c = quad.reduce((s, p) => [s[0] + p[0] / 4, s[1] + p[1] / 4], [0, 0]), along = unit([a.u[0] + b.u[0], a.u[1] + b.u[1]]);
  const endLine = (p, q) => {
    const d = len(sub(q, p)) > 1 ? unit(sub(q, p)) : [-along[1], along[0]], s = Math.sign(cross(d, sub(c, p)));
    return x => s * cross(d, sub(x, p));
  };
  const ends = [endLine(a0, b0), endLine(a1, b1)];
  const topOf = (w, s) => {
    let p = hull(w.faces.flatMap(f => f.pts.map(q => [q[0], q[1]])));
    for (const f of [...ends, x => -dot(s.n, sub(x, s.p0))]) p = clipHalf(p, f);
    p = simplify(p).map(snap); // snapped: x noise on an end line would make hull() in merge() drop corners
    return p.length >= 3 && Math.abs(area(p)) >= 1 ? p : null;
  };
  const walls = [[A, a], [B, b]].map(([w, s]) => ({ s, top: topOf(w, s) }));
  const lo = Math.min(a.z, b.z), hi = Math.max(a.z, b.z), differ = hi - lo >= 0.5, warnings = [];
  const mode = differ ? o.height : 'flush', pieces = [];
  const level = (poly, z0, z1) => z1 - z0 >= 0.5 && pieces.push({ poly, z0, z1 });
  if (mode === 'slope') {
    for (const part of gap) {
      const tris = planar(part) ? [part] : part.slice(1, -1).map((p, i) => [part[0], p, part[i + 2]]);
      for (const tri of tris) pieces.push({ poly: tri, slope: true });
    }
    if (o.tops) for (const w of walls) if (w.top) level(w.top, w.s.z, w.s.z + t);
  } else {
    const base = mode === 'flat' ? hi : lo;
    for (const part of gap) level(part, base, base + t);
    for (const w of walls) {
      if (!w.top) continue;
      if (o.tops) level(w.top, Math.min(w.s.z, base + t), base + t);
      else if (mode === 'flat') level(w.top, w.s.z, base); // closes the gap down to the lower wall
    }
    if (differ && mode === 'flush') warnings.push(`the wall tops differ by ${fmt(hi - lo)}: the roof sits on the lower one (Flat or Slope cover both)`);
  }
  const material = n => (n[2] > 0.5 ? ROOF : (fa.side && V.get(fa.side, 'material')) || 'DEV/DEV_MEASUREWALL01D');
  const polys = merge(pieces).map(p => (p.slope ? prism(p.poly, q => q[2], q => q[2] + t) : prism(p.poly, () => p.z0, () => p.z1)));
  const solids = polys.map(f => V.brush(f, material, nextId)).filter(s => V.valid(s));
  if (solids.length < polys.length) warnings.push(`${polys.length - solids.length} piece(s) were degenerate and left out`);
  const width = dot(a.n, sub(mid(b0, b1), mid(a0, a1))), length = (len(sub(a1, a0)) + len(sub(b1, b0))) / 2;
  const how = mode === 'slope' ? `sloping from ${fmt(a.z)} to ${fmt(b.z)}` : `bottom at ${fmt(mode === 'flat' ? hi : lo)}`;
  return { solids, info: `roof ${fmt(width)} wide, ${fmt(length)} long, ${fmt(t)} thick, ${how}, ${solids.length} brush${solids.length === 1 ? '' : 'es'}`, warnings };
}

// The face a horizontal ray from the wall's inner side meets first, facing back: { ...face, dist } or null. faces:
// [{ pts, n, ... }] of the other brushes. A wall picked on its top casts from its long upright faces. Rays start at
// points spread along the face (so a wall across that is offset or short is still met), just under the face's top
// and at its middle height.
export function across(wall, faces) {
  const from = up(wall.face) ? [wall.face] : sides(wall);
  let best = null;
  for (const f of from) {
    const n = unit(f.n), u = [n[1], -n[0]], zs = f.pts.map(p => p[2]), z1 = Math.max(...zs), z0 = Math.min(...zs);
    const t = f.pts.map(p => dot(u, p)), t0 = Math.min(...t), tw = Math.max(...t) - t0, k = Math.min(33, Math.max(9, Math.round(tw / 32)));
    const o = dot(n, centre(f)), starts = Array.from({ length: k }, (_, i) => { const x = t0 + (tw * (i + 0.5)) / k; return [n[0] * o + u[0] * x, n[1] * o + u[1] * x]; });
    for (const c of starts) for (const z of [z1 - 1, (z0 + z1) / 2]) for (const g of faces) {
      const den = g.n[0] * n[0] + g.n[1] * n[1];
      if (den > -0.2) continue;
      const p0 = g.pts[0], s = (g.n[0] * (p0[0] - c[0]) + g.n[1] * (p0[1] - c[1]) + g.n[2] * (p0[2] - z)) / den;
      if (s < 0.5 || (best && s >= best.dist)) continue;
      const h = [c[0] + n[0] * s, c[1] + n[1] * s, z];
      // inside the convex face: h on the same side of every edge (seen along the face normal)
      const sg = g.pts.map((p, i) => {
        const q = g.pts[(i + 1) % g.pts.length], e = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], w = [h[0] - p[0], h[1] - p[1], h[2] - p[2]];
        return g.n[0] * (e[1] * w[2] - e[2] * w[1]) + g.n[1] * (e[2] * w[0] - e[0] * w[2]) + g.n[2] * (e[0] * w[1] - e[1] * w[0]);
      });
      if (sg.every(x => x >= -1e-6) || sg.every(x => x <= 1e-6)) best = { ...g, dist: s };
    }
  }
  return best;
}
