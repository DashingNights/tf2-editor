// Stairs or a ramp between two brush edges (the Stairs tool). Pure: no DOM, no three.js.
// The edges are worked in plan (XY); their heights pick the bottom (the lower edge) and the top. Parallel edges give
// straight stairs, risers parallel to the edges. Edges at an angle give curved stairs laid out like a real curved
// staircase: a walking line runs from the middle of the lower edge to the middle of the upper one, leaving and
// entering each edge square to it; every riser is square to the walking line, so the risers fan out from the curve's
// centre and the treads are equally deep along the walking line; the width blends from one edge's length to the
// other's, so each end carries on its corridor. Edges the same distance from the point where their lines cross give
// a circular stair round that point. The treads are grown or cut back to the nearest walls (fit), in risers of at
// most `step` units; the upper edge is the last riser.
import * as V from '../vmf.js';
import { sub, cross, dot, turn, area, clipHalf, rayHits, convexParts } from './poly2d.js';

// type 'stairs' | 'ramp'; count: risers (0: risers of at most `step` units and treads of at most `depth` along the
// walking line); fit: cut the treads back to walls inside the stairs, and stretch them to walls that enclose a side
// within `reach`; longWay: curved stairs turn the long way round (more than half a turn, a spiral); solid: treads
// reach down to the bottom edge's height; group: the tool groups the result; clip: the tool adds a ramp over the steps
// (stairclip.js): false (the steps collide), true or 'players' (a player clip), 'all' (Block Bullets 2, for everything).
export const DEFAULTS = { type: 'stairs', count: 0, step: 16, depth: 32, fit: true, longWay: false, solid: true, group: true, reach: 128, clip: false };
const PARALLEL = Math.sin((2 * Math.PI) / 180); // edges within 2 degrees of each other count as parallel
const RAMP_WEDGE = (7.5 * Math.PI) / 180; // a curved ramp gets a wedge at least every 7.5 degrees of turn
const SAMPLE = (3 * Math.PI) / 180; // curved outlines get a point at least every 3 degrees of turn
const SAG = 2; // a tread side bending in by at most this much is built straight, so the tread stays one brush
const WALKABLE = Math.tan((45.57 * Math.PI) / 180); // steepest slope a TF2 player walks up
const len = a => Math.hypot(a[0], a[1]);
const unit = a => [a[0] / len(a), a[1] / len(a)];
const mid = E => [(E[0][0] + E[1][0]) / 2, (E[0][1] + E[1][1]) / 2];
const lerp = (a, b, t) => a + (b - a) * t;
const wrap = a => { while (a <= -Math.PI) a += 2 * Math.PI; while (a > Math.PI) a -= 2 * Math.PI; return a; };
const tidy = x => (Math.abs(x - Math.round(x)) < 1e-4 ? Math.round(x) : Math.round(x * 1000) / 1000);
const fmt = x => String(tidy(x));

// Whole-unit riser heights adding up to rise (the taller ones first), or equal parts for a fractional rise.
export function risers(rise, n) {
  if (Math.abs(rise - Math.round(rise)) > 1e-6) return Array(n).fill(rise / n);
  const r = Math.round(rise), base = Math.floor(r / n), extra = r - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

// ---------- plan shapes: slices(m) -> m lists of polygons from the bottom edge to the top, points [x, y, f] ----------
// (f: how far along the stairs the point is, 0 at the bottom edge, 1 at the top edge)

function straight(B, T, o, walls) {
  const u = unit(sub(B[1], B[0])), m = mid(T);
  let nrm = [-u[1], u[0]];
  if (dot(nrm, sub(m, B[0])) < 0) nrm = [u[1], -u[0]];
  const D = dot(nrm, sub(m, B[0]));
  if (D < 1) return { error: 'the edges lie on one line: pick edges facing each other across the gap' };
  const U0 = p => dot(u, sub(p, B[0])), N = p => dot(nrm, sub(p, B[0]));
  const rb = B.map(U0).sort((a, b) => a - b), rt = T.map(U0).sort((a, b) => a - b);
  // edges of one length offset along each other (a slanted corridor): the sides join their ends, so the plan is
  // worked sheared by k (sideways per unit of run) and every tread is a parallelogram. Otherwise the overlap.
  const k = Math.abs(rb[1] - rb[0] - (rt[1] - rt[0])) < 2 && Math.abs(rt[0] - rb[0]) > 1 ? (rt[0] - rb[0]) / D : 0;
  const U = p => U0(p) - k * N(p);
  const both = [Math.max(rb[0], rt[0] - k * D), Math.min(rb[1], rt[1] - k * D)];
  const own = both[1] - both[0] > 1 ? both : [Math.min(rb[0], rt[0]), Math.max(rb[1], rt[1])];
  let [a, b] = own;
  const warnings = [];
  if (o.fit) {
    // Each wall's span along the edges inside the band between the edge lines; the nearest ones either side win.
    const seed = (own[0] + own[1]) / 2;
    let left = -Infinity, right = Infinity, inside = false;
    for (const w of walls) {
      const cut = clipHalf(clipHalf(w.poly.map(p => [U(p), N(p)]), q => q[1] - 0.5), q => D - 0.5 - q[1]);
      if (cut.length < 3) continue;
      const us = cut.map(q => q[0]), lo = Math.min(...us), hi = Math.max(...us);
      if (hi <= seed) left = Math.max(left, hi);
      else if (lo >= seed) right = Math.min(right, lo);
      else inside = true;
    }
    if (inside) warnings.push('something stands in the middle of the stairs, so they were not fitted to the walls');
    else {
      if (left > own[0] - o.reach) a = left;
      if (right < own[1] + o.reach) b = right;
    }
  }
  if (b - a < 1) return { error: 'no room between the walls for the stairs' };
  // The top edge's line: its distance from the bottom edge's line at s. Edges a little off parallel (up to 2 degrees)
  // make it change along the stairs, and the stairs end on it all the way along (else a gap or an overhang, widening
  // to one end).
  const tp = T.map(p => [U(p), N(p)]), du = tp[1][0] - tp[0][0];
  const Dt = Math.abs(du) < 1e-6 ? () => D : s => tp[0][1] + ((s - tp[0][0]) * (tp[1][1] - tp[0][1])) / du;
  const W = (s, t, d) => [tidy(B[0][0] + u[0] * (s + k * t) + nrm[0] * t), tidy(B[0][1] + u[1] * (s + k * t) + nrm[1] * t), t / d];
  const slices = m => {
    // risers on whole units where the run allows; the last one on the top edge
    const at = (i, d) => (i === m ? d : d >= m ? Math.round((i * d) / m) : (i * d) / m);
    const [da, db] = [Dt(a), Dt(b)];
    return Array.from({ length: m }, (_, i) => [[W(a, at(i, da), da), W(b, at(i, db), db), W(b, at(i + 1, db), db), W(a, at(i + 1, da), da)]]);
  };
  return { kind: 'straight', slices, run: D, width: b - a, skew: Math.abs(Dt(a) - Dt(b)) > 0.01, warnings };
}

// ---------- curved stairs ----------
// The walking line's heading h(u) = h0 + sweep * u + bend * u * (1 - u), u from 0 to 1 along it: its curvature
// changes evenly (a piece of an Euler spiral), and bend 0 gives a circular arc.
const heading = (h0, sweep, bend) => u => h0 + sweep * u + bend * u * (1 - u);

// Mean unit tangent along a heading (Simpson's rule): the line's chord divided by its length.
function meanTangent(head, K = 64) {
  let x = 0, y = 0;
  for (let k = 0; k <= K; k++) {
    const w = k === 0 || k === K ? 1 : k % 2 ? 4 : 2, h = head(k / K);
    x += w * Math.cos(h);
    y += w * Math.sin(h);
  }
  return [x / (3 * K), y / (3 * K)];
}

// The bend closest to 0 that points the walking line's chord along `chord`, or null.
function solveBend(h0, sweep, chord) {
  const want = Math.atan2(chord[1], chord[0]), STEP = 0.05, LIMIT = 2 * Math.PI;
  const miss = bend => { const m = meanTangent(heading(h0, sweep, bend)); return wrap(Math.atan2(m[1], m[0]) - want); };
  let best = null, a = -LIMIT, fa = miss(a);
  while (a < LIMIT) {
    const b = a + STEP, fb = miss(b);
    // a sign change, not the jump between +180 and -180 degrees
    if (fa * fb <= 0 && Math.abs(fa - fb) < Math.PI) {
      let lo = a, hi = b, flo = fa;
      for (let i = 0; i < 40; i++) {
        const c = (lo + hi) / 2, fc = miss(c);
        if (fc * flo > 0) { lo = c; flo = fc; } else hi = c;
      }
      const root = (lo + hi) / 2;
      // a line that doubles back on itself (a tiny chord for its length) does not count
      if (len(meanTangent(heading(h0, sweep, root))) > 0.05 && (best === null || Math.abs(root) < Math.abs(best))) best = root;
    }
    a = b;
    fa = fb;
  }
  return best;
}

// A tread side, in outline order (anticlockwise), that only bends into the tread and by at most SAG becomes one
// straight edge, so the tread stays one convex brush; sides bending out, or round walls, keep their points.
function straighten(side) {
  if (side.length <= 2) return side;
  const a = side[0], b = side[side.length - 1], l = len(sub(b, a)), inner = side.slice(1, -1);
  const hollow = inner.every((p, i) => turn(side[i], p, side[i + 2]) <= 0.01 * len(sub(side[i + 2], side[i])));
  return hollow && l > 1e-9 && inner.every(p => Math.abs(turn(a, p, b)) / l <= SAG) ? [a, b] : side;
}

function curved(B, T, o, walls) {
  const dB = sub(B[1], B[0]), dT = sub(T[1], T[0]);
  const t = cross(sub(T[0], B[0]), dT) / cross(dB, dT), P = [B[0][0] + dB[0] * t, B[0][1] + dB[1] * t];
  // Each edge's direction from P, where the edge lines cross; an edge running through P is refused.
  const side = E => {
    const m = sub(mid(E), P);
    if (len(m) < 0.5) return null;
    const d = unit(m);
    return Math.min(...E.map(p => dot(sub(p, P), d))) < -0.5 ? null : Math.atan2(d[1], d[0]);
  };
  const aB = side(B), aT = side(T);
  if (aB === null || aT === null) return { error: 'the edge lines cross inside an edge: pick edges whose lines meet outside them' };
  // The stairs turn round P from the bottom edge to the top one, the short way unless longWay.
  let sweep = wrap(aT - aB);
  if (o.longWay) sweep -= Math.sign(sweep) * 2 * Math.PI;
  // The walking line leaves the middle of the bottom edge square to it and reaches the middle of the top edge square
  // to that. Its left side (normal [-sin h, cos h]) is the inside of an anticlockwise turn.
  const MB = mid(B), MT = mid(T), chord = sub(MT, MB), h0 = aB + (Math.sign(sweep) * Math.PI) / 2;
  if (len(chord) < 1) return { error: 'the edges share their middle: pick edges apart from each other' };
  const bend = solveBend(h0, sweep, chord);
  if (bend === null) return { error: 'no smooth walking line joins these edges: try Long way, or edges that face each other' };
  const head = heading(h0, sweep, bend), L = len(chord) / len(meanTangent(head));
  // Points every 1/N of the way (trapezoid sums), nudged so the last one lands on MT.
  const N = 1024, line = [[...MB]];
  for (let k = 1; k <= N; k++) {
    const h1 = head((k - 1) / N), h2 = head(k / N), p = line[k - 1];
    line.push([p[0] + ((Math.cos(h1) + Math.cos(h2)) * L) / (2 * N), p[1] + ((Math.sin(h1) + Math.sin(h2)) * L) / (2 * N)]);
  }
  const off = sub(MT, line[N]);
  line.forEach((p, k) => { p[0] += (off[0] * k) / N; p[1] += (off[1] * k) / N; });
  const at = u => {
    const x = Math.min(N - 1e-9, Math.max(0, u * N)), k = Math.floor(x), f = x - k;
    return [lerp(line[k][0], line[k + 1][0], f), lerp(line[k][1], line[k + 1][1], f)];
  };
  // Half the width: from the bottom edge's length to the top edge's, level at both ends (smoothstep) so the sides
  // leave each edge's ends square to it, carrying on the corridor's walls.
  const half = u => lerp(len(dB), len(dT), u * u * (3 - 2 * u)) / 2;
  const ramp = o.type === 'ramp';
  // Walls near enough to matter.
  const pad = Math.max(len(dB), len(dT)) / 2 + o.reach + 1, xs = line.map(p => p[0]), ys = line.map(p => p[1]);
  const lo = [Math.min(...xs) - pad, Math.min(...ys) - pad], hi = [Math.max(...xs) + pad, Math.max(...ys) + pad];
  const near = o.fit ? walls.filter(w => w.poly.some(p => p[0] >= lo[0]) && w.poly.some(p => p[0] <= hi[0]) && w.poly.some(p => p[1] >= lo[1]) && w.poly.some(p => p[1] <= hi[1])) : [];
  // One position along the walking line: its point, left normal and half width, and along the riser line there the
  // distance to the nearest wall either side (inside: a wall stands across the walking line).
  const sample = u => {
    const C = at(u), h = head(u), n = [-Math.sin(h), Math.cos(h)];
    let left = Infinity, right = Infinity, li = -1, ri = -1, inside = false;
    near.forEach((w, i) => {
      const ts = rayHits(C, n, w.poly);
      if (ts.length < 2) return;
      const t0 = ts[0], t1 = ts[ts.length - 1];
      if (t0 <= 0 && t1 >= 0) inside = true;
      else if (t0 > 0) { if (t0 < left) { left = t0; li = i; } }
      else if (-t1 < right) { right = -t1; ri = i; }
    });
    return { u, C, n, t: [Math.cos(h), Math.sin(h)], w: half(u), left, right, li, ri, inside };
  };
  const K = Math.max(8, Math.ceil((Math.abs(sweep) + Math.abs(bend)) / SAMPLE), Math.ceil(L / 32));
  // Wall corners the riser lines pass through (within reach of the stairs): fitted outlines need a point either side.
  const along = (v, u) => { const C = at(u), h = head(u); return (v[0] - C[0]) * Math.cos(h) + (v[1] - C[1]) * Math.sin(h); };
  const corners = [];
  for (const w of near) for (const v of w.poly) {
    const g = Array.from({ length: K + 1 }, (_, k) => along(v, k / K));
    for (let k = 0; k < K; k++) {
      if (g[k] * g[k + 1] > 0) continue;
      let a = k / K, b = (k + 1) / K, ga = g[k];
      for (let i = 0; i < 30; i++) {
        const c = (a + b) / 2, gc = along(v, c);
        if (gc * ga > 0) { a = c; ga = gc; } else b = c;
      }
      const u = (a + b) / 2, C = at(u), h = head(u);
      if (Math.abs(-(v[0] - C[0]) * Math.sin(h) + (v[1] - C[1]) * Math.cos(h)) <= half(u) + o.reach) corners.push(u);
    }
  }
  // Walls stretch the stairs only on a side they enclose: within reach all the way along, so a stairwell fills to its
  // walls while stairs in the open keep their width.
  const probe = [...Array.from({ length: K + 1 }, (_, k) => k / K), ...corners].map(sample);
  const reachL = o.fit && probe.every(p => p.inside || p.left - p.w <= o.reach);
  const reachR = o.fit && probe.every(p => p.inside || p.right - p.w <= o.reach);
  let blocked = false, cornered = false, pivoted = false;
  // Side widths after fitting: the nominal half width, cut back to a nearer wall or stretched to the wall of an
  // enclosed side. key names the wall each side follows (-1: none): a change between two positions marks a corner.
  const fit = p => {
    const l = p.left < p.w || (reachL && p.left < Infinity), r = p.right < p.w || (reachR && p.right < Infinity);
    return { lw: l ? p.left : p.w, rw: r ? p.right : p.w, key: p.inside ? 'x' : `${l ? p.li : -1} ${r ? p.ri : -1}` };
  };
  // A position with its side widths fitted (lw left, rw right), or null where a wall stands across the walking line.
  const fitted = u => {
    const p = sample(u);
    if (p.inside) { blocked = true; return null; }
    Object.assign(p, fit(p));
    return p.lw + p.rw >= 1 ? p : null;
  };
  // Positions either side of each corner between neighbouring positions (found by halving the gap).
  const refine = us => (!near.length ? us : us.flatMap((u, k) => {
    const v = us[k + 1], key = fit(sample(u)).key;
    if (v === undefined || key === fit(sample(v)).key) return [u];
    let a = u, b = v;
    for (let i = 0; i < 24; i++) { const c = (a + b) / 2; if (fit(sample(c)).key === key) a = c; else b = c; }
    return [u, a, b];
  }));
  // A ramp keeps 8 units short of where neighbouring riser lines cross on the inside of a tight turn, as its height
  // has no single value there.
  const unfold = ps => ps.forEach((a, k) => {
    const b = ps[k + 1];
    if (!a || !b || b.u - a.u < 1e-4) return;
    const den = cross(a.n, b.n);
    if (Math.abs(den) < 1e-12) return;
    const d = sub(b.C, a.C), ta = cross(d, b.n) / den, tb = cross(d, a.n) / den;
    const key = ta > 0 && tb > 0 ? 'lw' : ta < 0 && tb < 0 ? 'rw' : null;
    if (key) for (const [p, s] of [[a, Math.abs(ta)], [b, Math.abs(tb)]]) if (p[key] > s - 8) { p[key] = Math.max(0, s - 8); cornered = true; }
  });
  // Riser ends: R on the right, L on the left. Where the turn is too tight for the width, an end would fall behind
  // the riser before (the riser lines cross inside the stairs): it stays on that riser's end instead, so the risers
  // there pivot round one point like winders round a newel post.
  const ends = ps => ps.forEach((b, k) => {
    if (!b) return;
    b.R = [b.C[0] - b.n[0] * b.rw, b.C[1] - b.n[1] * b.rw];
    b.L = [b.C[0] + b.n[0] * b.lw, b.C[1] + b.n[1] * b.lw];
    const a = ps[k - 1];
    if (!a) return;
    const d = sub(a.L, a.R), fwd = Math.sign(cross(d, a.t)), tol = 0.01 * len(d);
    for (const s of ['R', 'L']) if (cross(d, sub(b[s], a.R)) * fwd < -tol) {
      if (len(sub(b[s], a[s])) > 1) pivoted = true;
      b[s] = a[s];
    }
  });
  // Short of half a turn the stairs stay on the gap side of both edge lines: a tight inside can poke past them
  // before it pivots.
  const hT = [Math.cos(h0 + sweep), Math.sin(h0 + sweep)], hB = [Math.cos(h0), Math.sin(h0)];
  const gap = poly => (Math.abs(sweep) > Math.PI ? poly : clipHalf(clipHalf(poly, p => dot(sub(p, MB), hB) + 0.01), p => dot(sub(MT, p), hT) + 0.01));
  const pt = (q, u) => [tidy(q[0]), tidy(q[1]), u];
  // Outline of consecutive positions: the right side forward, then the left side back (anticlockwise).
  const outline = ps => {
    const poly = gap([...straighten(ps.map(p => pt(p.R, p.u))), ...straighten(ps.map(p => pt(p.L, p.u)).reverse())]).map(p => pt(p, p[2]));
    return poly.filter((p, k) => len(sub(p, poly[(k + 1) % poly.length])) > 0.01);
  };
  // Slice i of m runs from u = i/m to (i+1)/m; a wall across the walking line splits it into separate pieces.
  const slices = m => {
    const per = Array.from({ length: m }, (_, i) => {
      const u0 = i / m, u1 = (i + 1) / m, c = Math.max(1, Math.ceil((u1 - u0) * K)), us = [u0, u1];
      for (let k = 1; k < c; k++) us.push(u0 + ((u1 - u0) * k) / c);
      for (const x of corners) if (x > u0 + 2e-6 && x < u1 - 2e-6) us.push(x - 1e-6, x + 1e-6);
      return refine(us.sort((x, y) => x - y)).slice(1);
    });
    const all = [fitted(0), ...per.flat().map(fitted)];
    if (ramp) unfold(all);
    ends(all);
    let start = 0;
    return per.map(us => {
      const part = all.slice(start, start + us.length + 1), runs = [[]];
      start += us.length;
      for (const p of part) if (p) runs[runs.length - 1].push(p); else if (runs[runs.length - 1].length) runs.push([]);
      return runs.filter(r => r.length >= 2).map(outline);
    });
  };
  // Warnings from the positions taken, read once the slices are built.
  const after = () => [...(blocked ? ['something stands across the stairs; they were left open there'] : []),
    ...(cornered ? ['a curved ramp stops 8 units short of the inside of its turn'] : []),
    ...(pivoted ? ['the turn is too tight for this width, so the inside of the stairs pivots on a point'] : [])];
  return {
    kind: 'curved', slices, after, warnings: [], run: L, degrees: Math.abs((sweep * 180) / Math.PI), widths: [len(dB), len(dT)],
    wedges: Math.max(2, Math.ceil((Math.abs(sweep) + Math.abs(bend)) / RAMP_WEDGE), Math.ceil(L / 128)),
  };
}

// ---------- solids ----------
// Faces of the upright prism over poly from z0 up to top (one height, or one per point).
function prism(poly, z0, top) {
  const up = poly.map((p, i) => [p[0], p[1], Array.isArray(top) ? top[i] : top]), down = poly.map(p => [p[0], p[1], z0]);
  return [down, up, ...poly.map((_, i) => { const j = (i + 1) % poly.length; return [down[i], down[j], up[j], up[i]]; })];
}

// e1, e2: [[x, y, z], [x, y, z]] horizontal brush edges, in any order. obstacles: [{ poly: [[x, y], ...] convex,
// z0, z1 }], the brushes that can stop the stairs (only those overlapping the stairs' height range count).
// Returns { solids, info, warnings, kind } or { error }.
export function build(e1, e2, opts = {}, obstacles = [], material = 'DEV/DEV_MEASUREGENERIC01B', nextId = () => '0') {
  const o = { ...DEFAULTS, ...opts }, zOf = e => (e[0][2] + e[1][2]) / 2;
  const [lo, hi] = zOf(e1) <= zOf(e2) ? [e1, e2] : [e2, e1];
  const zB = zOf(lo), zT = zOf(hi), rise = zT - zB;
  if (rise < 1) return { error: 'both edges are at the same height: pick a lower and a higher edge' };
  const B = lo.map(p => [p[0], p[1]]), T = hi.map(p => [p[0], p[1]]), dB = sub(B[1], B[0]), dT = sub(T[1], T[0]);
  if (len(dB) < 1 || len(dT) < 1) return { error: 'pick horizontal edges' };
  const walls = obstacles.filter(w => w.z1 > zB + 0.5 && w.z0 < zT - 0.5);
  const plan = Math.abs(cross(dB, dT)) / (len(dB) * len(dT)) < PARALLEL ? straight(B, T, o, walls) : curved(B, T, o, walls);
  if (plan.error) return plan;
  const auto = Math.max(Math.ceil(rise / Math.max(1, +o.step || 16)), Math.ceil(plan.run / Math.max(1, +o.depth || 32)) + 1);
  const n = Math.min(96, Math.max(2, Math.round(+o.count) || auto)), hs = risers(rise, n);
  const warnings = [...plan.warnings], faces = [];
  let lost = 0;
  // Convex pieces of a plan polygon; a polygon that cannot be split (self-crossing) is counted and left out.
  const pieces = poly => { const ps = convexParts(poly); if (!ps.length && Math.abs(area(poly)) > 1) lost++; return ps; };
  if (o.type === 'ramp') {
    for (const poly of plan.slices(plan.kind === 'straight' ? 1 : plan.wedges).flat()) for (const part of pieces(poly)) {
      const z = p => zB + rise * Math.min(1, Math.max(0, p[2]));
      // Straight: one planar wedge. Curved, or straight between edges a little off parallel (no one plane holds both):
      // the height follows the plan, so each triangle gets its own plane.
      const tris = plan.kind === 'straight' && !plan.skew ? [part] : part.slice(1, -1).map((p, i) => [part[0], p, part[i + 2]]);
      for (const t of tris) if (t.some(p => z(p) > zB + 0.01)) faces.push(prism(t, zB, t.map(z)));
    }
    if (rise / plan.run > WALKABLE) warnings.push(`too steep to walk up (${Math.round((Math.atan(rise / plan.run) * 180) / Math.PI)} degrees; 45 is the limit)`);
  } else {
    let top = zB;
    plan.slices(n - 1).forEach((polys, i) => {
      top += hs[i];
      for (const poly of polys) for (const part of pieces(poly)) faces.push(prism(part, o.solid ? zB : top - hs[i], top));
    });
    const depth = plan.run / (n - 1);
    if (depth < 8) warnings.push(`treads only ${Math.round(depth * 10) / 10} units deep`);
  }
  warnings.push(...(plan.after?.() ?? []));
  const solids = faces.map(f => V.brush(f, material, nextId)).filter(s => V.valid(s));
  if (solids.length < faces.length || lost) warnings.push(`${faces.length - solids.length + lost} piece(s) were degenerate and left out`);
  const h = hs[0] === hs[n - 1] ? fmt(hs[0]) : `${fmt(hs[n - 1])}-${fmt(hs[0])}`;
  const what = o.type === 'ramp' ? `ramp rising ${fmt(rise)}` : `${n} risers of ${h}, treads ${fmt(Math.round(plan.run / (n - 1)))} deep`;
  const wide = w => (Math.abs(w[0] - w[1]) < 0.5 ? fmt(Math.round(w[0])) : `${fmt(Math.round(w[0]))} to ${fmt(Math.round(w[1]))}`);
  const where = plan.kind === 'straight' ? `straight, ${fmt(plan.width)} wide, run ${fmt(plan.run)}` : `curving ${Math.round(plan.degrees)} degrees, ${wide(plan.widths)} wide, run ${fmt(Math.round(plan.run))}`;
  return { solids, info: `${what}, ${where}`, warnings, kind: plan.kind };
}
