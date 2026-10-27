// Player clip (or Block Bullets 2) ramp over stairs: a smooth ramp resting on every step's nosing instead of the steps,
// so players walk up and down without the step bump and do not catch on step corners. Pure: no DOM, no three.js.
// The nosings (tread edges over a lower tread) are joined into a surface of triangles: two between each nosing and the
// one it faces a level down (the two nosings of a turning flight are not in one plane: Source brush faces are flat),
// so the ramp passes through every nosing and covers the whole flight however it turns; round the inside of a tight
// turn, where that would be steeper than walkable (TF2: normal z 0.7, about 45.6 degrees), the strip is flat at the
// higher nosing (a block players go round). An apron runs from the first nosing of a straight part down to the floor
// in front, so the toe meets the ground with no lip; the floor in front and the ledge the steps lead to come from the
// context (brushes around the steps), as do walls beside them: each nosing reaches out to a wall within `reach` (48: a
// gap the 48-unit player box cannot fit in). Triangles in one plane are merged (a straight flight is one brush), with
// shared corners at one height so pieces meet flush; each piece is a brush from below the floor up to it.
import * as V from '../vmf.js';
import { hull, simplify } from './poly2d.js';

const WALKABLE = Math.tan((45 * Math.PI) / 180); // the steepest ramp built (TF2 walks up to about 45.6 degrees)

// Treads of solids: upward faces as { pts: [[x, y], ...], z }, lowest first.
function treads(solids) {
  const out = [];
  for (const s of solids) for (const f of V.faces(s)) if (f.n[2] > 0.99) out.push({ pts: f.pts.map(p => [p[0], p[1]]), z: f.pts[0][2] });
  return out.sort((a, b) => a.z - b.z);
}
const area2 = poly => poly.reduce((a, p, i) => { const q = poly[(i + 1) % poly.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0);
// Point m on or in the convex polygon poly (in plan), within tol.
const inside = (poly, m, tol) => {
  const s = Math.sign(area2(poly)) || 1;
  return poly.every((p, i) => { const q = poly[(i + 1) % poly.length], l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1; return (s * ((q[0] - p[0]) * (m[1] - p[1]) - (q[1] - p[1]) * (m[0] - p[0]))) / l >= -tol; });
};
const touching = (t, u) => t.pts.some(p => inside(u.pts, p, 0.5)) || u.pts.some(p => inside(t.pts, p, 0.5));
// The part [t0, t1] (0 at a, 1 at b) of segment a-b on or in the convex polygon poly, within tol; null when none.
function within(poly, a, b, tol) {
  const s = Math.sign(area2(poly)) || 1;
  let t0 = 0, t1 = 1;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length], l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    const f = m => (s * ((q[0] - p[0]) * (m[1] - p[1]) - (q[1] - p[1]) * (m[0] - p[0]))) / l + tol, fa = f(a), fb = f(b);
    if (fa < 0 && fb < 0) return null;
    if (fa < 0) t0 = Math.max(t0, fa / (fa - fb));
    else if (fb < 0) t1 = Math.min(t1, fa / (fa - fb));
  }
  return t1 - t0 > 1e-6 ? [t0, t1] : null;
}
// Nosings: the edges of treads `from` that stand over a tread of `under` that ok(t, u) allows (lower: the top of the
// riser below them), only the part over it. { a, b, z, dir, out } (dir: unit direction; out: unit normal pointing away
// from the edge's tread, down the stairs).
function nosings(from, under, ok) {
  const res = [];
  for (const t of from) {
    const lower = under.filter(u => u.z < t.z - 0.25 && ok(t, u)), c = t.pts.reduce((s, p) => [s[0] + p[0] / t.pts.length, s[1] + p[1] / t.pts.length], [0, 0]);
    t.pts.forEach((a, i) => {
      const b = t.pts[(i + 1) % t.pts.length], m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (l <= 0.5 || !lower.some(u => inside(u.pts, m, 0.5))) return;
      const spans = lower.map(u => within(u.pts, a, b, 0.5)).filter(Boolean), t0 = Math.min(...spans.map(x => x[0])), t1 = Math.max(...spans.map(x => x[1]));
      const P = k => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k], dir = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
      let out = [dir[1], -dir[0]];
      if ((c[0] - m[0]) * out[0] + (c[1] - m[1]) * out[1] > 0) out = [-out[0], -out[1]];
      res.push({ a: P(t0), b: P(t1), z: t.z, dir, out });
    });
  }
  return res;
}
// The distance along ray o + d s (s > 0) to the first convex polygon of polys it meets, or Infinity.
function rayHit(o, d, polys) {
  let best = Infinity;
  for (const poly of polys) {
    if (inside(poly, o, -0.01)) continue; // starting inside: not a wall ahead
    poly.forEach((p, i) => {
      const q = poly[(i + 1) % poly.length], e = [q[0] - p[0], q[1] - p[1]], den = d[0] * e[1] - d[1] * e[0];
      if (Math.abs(den) < 1e-9) return;
      const w = [p[0] - o[0], p[1] - o[1]], s = (w[0] * e[1] - w[1] * e[0]) / den, u = (w[0] * d[1] - w[1] * d[0]) / den;
      if (s > 1e-6 && u >= -1e-6 && u <= 1 + 1e-6) best = Math.min(best, s);
    });
  }
  return best;
}

// Faces of the upright prism over poly from z0 up to heights top(p).
function prism(poly, z0, top) {
  if (area2(poly) < 0) poly = [...poly].reverse();
  const up = poly.map(p => [p[0], p[1], top(p)]), down = poly.map(p => [p[0], p[1], z0]);
  return [down, up, ...poly.map((_, i) => { const j = (i + 1) % poly.length; return [down[i], down[j], up[j], up[i]]; })];
}

// solids: the steps of one flight (any order; the floor in front and the landings may be in). context: brushes around
// them (not selected). Returns { solids, info } or { error }.
export function clipStairs(solids, { material = 'TOOLS/TOOLSPLAYERCLIP', reach = 48, context = [], nextId = () => '0' } = {}) {
  const lvl = z => Math.round(z * 1000) / 1000, ts = treads(solids), own = [...new Set(ts.map(t => lvl(t.z)))];
  if (own.length < 2) return { error: 'select the steps of a flight (two or more step heights)' };
  const diffs = own.slice(1).map((z, i) => z - own[i]).sort((a, b) => a - b), riser = diffs[diffs.length >> 1];
  const lo = own[0], hi = own[own.length - 1], ctx = treads(context);
  // the floor in front (under the lowest steps) and the ledge the steps end at (above the highest), from the context
  const floors = ctx.filter(u => u.z < lo - 0.25 && u.z >= lo - 2 * riser && ts.some(t => lvl(t.z) === lo && touching(t, u)));
  const ledges = ctx.filter(u => u.z > hi + 0.25 && u.z <= hi + 2 * riser && ts.some(t => lvl(t.z) === hi && touching(t, u)));
  const floor = floors.length ? Math.max(...floors.map(u => u.z)) : lo - riser;
  // nosings: a step's edges over the next step down (one riser: not a floor far below beside it), the ledge's edge over
  // the top step, and the first step's front over the floor (its edge facing away from the next step up)
  const ns = [...nosings(ts, ts, (t, u) => u.z >= t.z - 1.5 * riser - 0.5), ...nosings(ledges, ts.filter(t => lvl(t.z) === hi), () => true)];
  const firsts = ts.filter(t => lvl(t.z) === lo), seconds = ns.filter(n => lvl(n.z) === lvl(Math.min(...ns.map(x => x.z))));
  if (floors.length && firsts.length && seconds.length) {
    const mid = ps => ps.reduce((s, p) => [s[0] + p[0] / ps.length, s[1] + p[1] / ps.length], [0, 0]);
    const a = mid(firsts.flatMap(t => t.pts)), b = mid(seconds.flatMap(n => [n.a, n.b])), l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, up = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
    // a first step's front faces away from the next step up and stands within two treads of it (a landing's far edge
    // over another flight going down is no front)
    const md = n => [(n.a[0] + n.b[0]) / 2, (n.a[1] + n.b[1]) / 2], gap = n => Math.min(...seconds.map(m => Math.hypot(md(m)[0] - md(n)[0], md(m)[1] - md(n)[1])));
    const tread = Math.min(...seconds.map(m => Math.max(...firsts.flatMap(t => t.pts.map(p => Math.abs((p[0] - m.a[0]) * m.out[0] + (p[1] - m.a[1]) * m.out[1]))))));
    ns.push(...nosings(firsts, floors, () => true).filter(n => n.out[0] * up[0] + n.out[1] * up[1] < -0.5 && gap(n) <= 2 * Math.min(tread, 128)));
  }
  const levels = [...new Set(ns.map(n => lvl(n.z)))].sort((a, b) => a - b);
  if (levels.length < 2) return { error: 'no step stands on another here: select the steps of one flight' };
  // a nosing of a straight part: one a level up or down runs the same way (in a turn they fan out, and anything reaching
  // out from them would stick out past the stairs over the floor)
  const straight = (n, list) => list.some(m => m !== n && Math.abs(levels.indexOf(lvl(m.z)) - levels.indexOf(lvl(n.z))) === 1 && Math.abs(m.dir[0] * n.dir[0] + m.dir[1] * n.dir[1]) > 0.98);
  // walls beside a straight part: each nosing reaches out along itself to a wall standing above it within reach (a
  // wider gap is room players walk in: the ramp stops at the steps' open side)
  const walls = context.map(s => { const vs = V.faces(s).flatMap(f => f.pts); return { poly: hull(vs.map(p => [p[0], p[1]])), z0: Math.min(...vs.map(p => p[2])), z1: Math.max(...vs.map(p => p[2])) }; });
  for (const n of ns.filter(x => straight(x, ns))) {
    const block = walls.filter(w => w.z0 < n.z + 1 && w.z1 > n.z + 1 && w.poly.length >= 3).map(w => w.poly);
    const sa = rayHit(n.a, [-n.dir[0], -n.dir[1]], block), sb = rayHit(n.b, n.dir, block);
    if (sa > 0.5 && sa <= reach) n.a = [n.a[0] - n.dir[0] * sa, n.a[1] - n.dir[1] * sa];
    if (sb > 0.5 && sb <= reach) n.b = [n.b[0] + n.dir[0] * sb, n.b[1] + n.dir[1] * sb];
  }
  // tread depth: the distance between neighbouring nosings that run the same way (for the apron)
  const gaps = [];
  for (let i = 1; i < levels.length; i++) for (const n of ns.filter(x => lvl(x.z) === levels[i])) for (const m of ns.filter(x => lvl(x.z) === levels[i - 1] && Math.abs(x.dir[0] * n.dir[0] + x.dir[1] * n.dir[1]) > 0.9)) gaps.push(Math.abs((m.a[0] - n.a[0]) * n.out[0] + (m.a[1] - n.a[1]) * n.out[1]));
  gaps.sort((a, b) => a - b);
  const depth = gaps.length ? gaps[gaps.length >> 1] : 32;
  // one nosing per line and level: pieces of one step side by side (cut up by the grid) join into one
  const joined = [];
  for (const n of ns) {
    const o = joined.find(m => lvl(m.z) === lvl(n.z) && Math.abs(m.dir[0] * n.dir[0] + m.dir[1] * n.dir[1]) > 0.999 && Math.abs((n.a[0] - m.a[0]) * m.dir[1] - (n.a[1] - m.a[1]) * m.dir[0]) < 0.5);
    if (!o) { joined.push({ ...n }); continue; }
    const t = q => (q[0] - o.a[0]) * o.dir[0] + (q[1] - o.a[1]) * o.dir[1], ts2 = [0, t(o.b), t(n.a), t(n.b)], t0 = Math.min(...ts2), t1 = Math.max(...ts2), A = o.a;
    o.a = [A[0] + o.dir[0] * t0, A[1] + o.dir[1] * t0];
    o.b = [A[0] + o.dir[0] * t1, A[1] + o.dir[1] * t1];
  }
  // the surface: a strip of two triangles between each nosing and the one it faces a level down (their ends matched),
  // and the apron below the lowest ones. Where part of a strip is steeper than walkable (round the inside of a tight
  // turn, where the treads run to nothing) the strip is cut once where it gets too steep, and that part is flat at the
  // upper nosing's height: one block players go round (one upright face), not a hole to fall into.
  const P = [], Z = [], tris = [];
  let blocked = 0;
  const pt = (p, z) => { const j = P.findIndex((q, i) => Math.abs(q[0] - p[0]) < 0.01 && Math.abs(q[1] - p[1]) < 0.01 && Math.abs(Z[i] - z) < 0.01); if (j >= 0) return j; P.push(p); Z.push(z); return P.length - 1; };
  // a triangle's slope (rise over run; Infinity upright), corners [[x, y], z]
  const slope = v => {
    const [A, B, C] = v.map(([p, z]) => [p[0], p[1], z]), u = B.map((x, k) => x - A[k]), w = C.map((x, k) => x - A[k]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    return Math.hypot(n[0], n[1]) / Math.abs(n[2]);
  };
  const tri = (...v) => {
    if (Math.abs(area2(v.map(x => x[0]))) < 1) return;
    const steep = slope(v) > WALKABLE, top = Math.max(...v.map(x => x[1]));
    if (steep) blocked++;
    tris.push(v.map(([p, z]) => pt(p, steep ? top : z)));
  };
  const d2 = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2, mid = n => [(n.a[0] + n.b[0]) / 2, (n.a[1] + n.b[1]) / 2];
  // the quad lo p0 p1, hi q0 q1 as two triangles: across the diagonal that leaves the gentler steepest one
  const pair = (p0, p1, q0, q1, zl, zh) => {
    const A = [[[p0, zl], [q0, zh], [q1, zh]], [[p0, zl], [q1, zh], [p1, zl]]], B = [[[p0, zl], [q0, zh], [p1, zl]], [[q0, zh], [q1, zh], [p1, zl]]];
    const worst = ts => Math.max(...ts.filter(t => Math.abs(area2(t.map(x => x[0]))) >= 1).map(slope), 0);
    return worst(A) <= worst(B) ? A : B;
  };
  const strip = (lo, hi) => {
    let [a0, b0] = [lo.a, lo.b];
    if (d2(a0, hi.a) + d2(b0, hi.b) > d2(a0, hi.b) + d2(b0, hi.a)) [a0, b0] = [b0, a0];
    const at = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
    // where the gap between the two nosings (D(u), linear in u) is under the run a walkable climb needs, the strip is
    // steep: |D(u)| < need is one stretch [r0, r1] (|D|^2 is a convex quadratic)
    const need = ((hi.z - lo.z) / WALKABLE) * 1.15, D0 = [a0[0] - hi.a[0], a0[1] - hi.a[1]], dD = [b0[0] - hi.b[0] - D0[0], b0[1] - hi.b[1] - D0[1]];
    const qa = dD[0] ** 2 + dD[1] ** 2, qb = 2 * (D0[0] * dD[0] + D0[1] * dD[1]), qc = D0[0] ** 2 + D0[1] ** 2 - need * need, disc = qb * qb - 4 * qa * qc;
    let cuts = [0, 1];
    if (qa > 1e-9 && disc > 0) {
      const r0 = (-qb - Math.sqrt(disc)) / (2 * qa), r1 = (-qb + Math.sqrt(disc)) / (2 * qa);
      cuts = [0, ...[r0, r1].filter(r => r > 0.02 && r < 0.98), 1];
    }
    for (let i = 0; i + 1 < cuts.length; i++) for (const t of pair(at(a0, b0, cuts[i]), at(a0, b0, cuts[i + 1]), at(hi.a, hi.b, cuts[i]), at(hi.a, hi.b, cuts[i + 1]), lo.z, hi.z)) tri(...t);
  };
  for (let k = 1; k < levels.length; k++) for (const n of joined.filter(x => lvl(x.z) === levels[k])) {
    const below = joined.filter(x => lvl(x.z) === levels[k - 1]), ahead = below.filter(x => (mid(x)[0] - mid(n)[0]) * n.out[0] + (mid(x)[1] - mid(n)[1]) * n.out[1] > -1);
    const lo = (ahead.length ? ahead : below).sort((x, y) => d2(mid(x), mid(n)) - d2(mid(y), mid(n)))[0];
    if (lo) strip(lo, n);
  }
  // the apron of each lowest nosing of a straight part runs down to the floor just in front of it (the highest tread
  // there below it, of the steps or around them), so its edge meets the ground; a turning flight starts at its first
  // nosing (one riser, a step players take as they walk)
  const under = [...ts, ...ctx];
  for (const n of joined.filter(x => lvl(x.z) === levels[0] && straight(x, joined))) {
    const m = [(n.a[0] + n.b[0]) / 2 + n.out[0] * 4, (n.a[1] + n.b[1]) / 2 + n.out[1] * 4];
    const zs = under.filter(u => u.z < n.z - 0.25 && inside(u.pts, m, 0.01)).map(u => u.z), z = zs.length ? Math.max(...zs) : floor;
    const run = Math.max(depth / riser, 1 / WALKABLE) * Math.max(0, n.z - z); // as steep as the flight, at most walkable
    if (run > 0.5) strip({ a: [n.a[0] + n.out[0] * run, n.a[1] + n.out[1] * run], b: [n.b[0] + n.out[0] * run, n.b[1] + n.out[1] * run], z }, n);
  }
  if (!tris.length) return { error: 'no ramp fits these steps' };
  // merge the triangles into planes: grown over neighbouring triangles while a plane on or above all their corners (the
  // nosings) stays within tol of every one (a straight flight with a riser a unit off: one plane), then each plane's
  // triangles as few convex pieces as it takes. A finished plane's corners keep its heights (fixed) and every later
  // plane passes exactly through the fixed corners it shares: pieces meet flush, never a step (a fin) between them.
  const tol = Math.max(1.5, riser / 4), area = t => Math.abs(area2(t.map(i => P[i]))) / 2;
  // where the ramp meets the ground (the apron's floor edge, the top nosing at the ledge) a merged plane may not stand
  // over the point: that would be a lip to walk into
  const top = levels[levels.length - 1], edge = i => Z[i] < levels[0] - 0.01 || Math.abs(Z[i] - top) < 0.01;
  const fixed = new Map(), zOf = i => fixed.get(i) ?? Z[i];
  const fit = ids => {
    // least squares z = c + gx x + gy y (the fixed corners weigh most), raised until no corner is above it; null when it
    // misses a fixed corner
    let n = 0, sx = 0, sy = 0, sz = 0, sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0;
    for (const i of ids) { const [x, y] = P[i], z = zOf(i), w = fixed.has(i) ? 1e4 : 1; n += w; sx += w * x; sy += w * y; sz += w * z; sxx += w * x * x; sxy += w * x * y; syy += w * y * y; sxz += w * x * z; syz += w * y * z; }
    const mx = sx / n, my = sy / n, mz = sz / n, a = sxx / n - mx * mx, b = sxy / n - mx * my, d = syy / n - my * my, e = sxz / n - mx * mz, f = syz / n - my * mz, det = a * d - b * b;
    const gx = Math.abs(det) < 1e-9 ? 0 : (e * d - f * b) / det, gy = Math.abs(det) < 1e-9 ? 0 : (a * f - b * e) / det;
    const r = [...ids].map(i => zOf(i) - (mz + gx * (P[i][0] - mx) + gy * (P[i][1] - my))), up = Math.max(...r);
    const pl = { gx, gy, c: mz - gx * mx - gy * my + up, dev: up - Math.min(...r) };
    return [...ids].some(i => fixed.has(i) && Math.abs(pl.c + gx * P[i][0] + gy * P[i][1] - fixed.get(i)) > 0.05) ? null : pl;
  };
  const edgeOf = new Map(), next = tris.map(() => []), around = P.map(() => []);
  tris.forEach((t, i) => t.forEach(k => around[k].push(i)));
  tris.forEach((t, i) => [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]].forEach(([a, b]) => {
    const k = a < b ? `${a},${b}` : `${b},${a}`;
    if (!edgeOf.has(k)) return void edgeOf.set(k, i);
    const j = edgeOf.get(k);
    next[i].push(j);
    next[j].push(i);
  }));
  const used = new Set(), out = [], bottom = Math.min(floor, lo) - riser;
  let maxSlope = 0;
  for (const i0 of tris.map((_, i) => i).sort((a, b) => area(tris[b]) - area(tris[a]))) {
    if (used.has(i0)) continue;
    const group = [i0], ids = new Set(tris[i0]), queue = [...next[i0]];
    // a lone triangle: the plane through its corners (fixed ones as they are)
    let pl = fit(ids) ?? (([a, b, c]) => { const u = [P[b][0] - P[a][0], P[b][1] - P[a][1], zOf(b) - zOf(a)], w = [P[c][0] - P[a][0], P[c][1] - P[a][1], zOf(c) - zOf(a)], nz = u[0] * w[1] - u[1] * w[0];
      const gx = -(u[1] * w[2] - u[2] * w[1]) / nz, gy = -(u[2] * w[0] - u[0] * w[2]) / nz; return { gx, gy, c: zOf(a) - gx * P[a][0] - gy * P[a][1] }; })(tris[i0]);
    used.add(i0);
    while (queue.length) {
      const j = queue.shift();
      if (used.has(j)) continue;
      const ids2 = new Set([...ids, ...tris[j]]), p2 = fit(ids2);
      if (!p2 || p2.dev > tol || Math.hypot(p2.gx, p2.gy) > WALKABLE + 0.01 || [...ids2].some(i => edge(i) && p2.c + p2.gx * P[i][0] + p2.gy * P[i][1] - Z[i] > 0.5)) continue; // off the plane, too steep, or a lip
      // nor may a corner it raises tip a walkable triangle beside it past walkable
      const zz = i => p2.c + p2.gx * P[i][0] + p2.gy * P[i][1], walk = (t, f) => slope(tris[t].map(k => [P[k], f(k)])) <= WALKABLE + 0.01;
      if ([...ids2].some(i => !fixed.has(i) && zz(i) - Z[i] > 0.05 && around[i].some(t => !used.has(t) && t !== j && walk(t, zOf) && !walk(t, k => (k === i ? zz(i) : zOf(k)))))) continue;
      group.push(j);
      used.add(j);
      tris[j].forEach(i => ids.add(i));
      pl = p2;
      queue.push(...next[j]);
    }
    for (const i of ids) if (!fixed.has(i)) fixed.set(i, pl.c + pl.gx * P[i][0] + pl.gy * P[i][1]);
    maxSlope = Math.max(maxSlope, Math.hypot(pl.gx, pl.gy));
    // as few convex pieces as merging neighbours allows: two join where their hull is just the two of them (exactly
    // their own triangles, never more)
    let polys = group.map(i => tris[i].map(k => P[k])), parts = polys.map(t => [t]);
    const A = q => Math.abs(area2(q)) / 2;
    for (let merged = true; merged;) {
      merged = false;
      for (let a = 0; a < polys.length && !merged; a++) for (let b = a + 1; b < polys.length && !merged; b++) {
        const shared = polys[a].filter(p => polys[b].some(q => Math.abs(q[0] - p[0]) < 0.01 && Math.abs(q[1] - p[1]) < 0.01)).length;
        if (shared < 2) continue;
        const h = hull([...polys[a], ...polys[b]]);
        if (Math.abs(A(h) - A(polys[a]) - A(polys[b])) < 0.5 + 1e-4 * A(h)) { polys[a] = h; parts[a].push(...parts[b]); polys.splice(b, 1); parts.splice(b, 1); merged = true; }
      }
    }
    // corners a hair off a straight side dropped (they make near-duplicate side planes: an invalid brush); a piece that
    // still fails goes in as its triangles, so the ramp never has a hole
    const height = q => pl.c + pl.gx * q[0] + pl.gy * q[1];
    polys.forEach((poly, k) => {
      const s = V.brush(prism(simplify(poly, 0.1), bottom, height), material, nextId);
      if (V.valid(s)) out.push(s);
      else for (const t of parts[k]) { const u = V.brush(prism(t, bottom, height), material, nextId); if (V.valid(u)) out.push(u); }
    });
  }
  if (!out.length) return { error: 'no ramp fits these steps' };
  const deg = Math.round((Math.atan(maxSlope) * 180) / Math.PI);
  return { solids: out, info: `${out.length} ramp brush${out.length === 1 ? '' : 'es'} over ${levels.length} nosings${ledges.length ? ' up to the ledge' : ''}${floors.length ? ', from the floor' : ''}, up to ${deg} degrees${blocked ? ', the inside of the turn blocked (too steep)' : ''}` };
}
