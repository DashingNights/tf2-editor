// 2D polygon helpers for points [x, y] (extra elements ride along untouched). Pure.
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
export const turn = (a, b, c) => cross(sub(b, a), sub(c, b));
export const area = poly => poly.reduce((s, p, i) => s + cross(p, poly[(i + 1) % poly.length]), 0) / 2;
export const ccw = poly => (area(poly) < 0 ? [...poly].reverse() : poly);

// Convex hull, counter-clockwise, without collinear points (Andrew's monotone chain).
export function hull(pts) {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const half = list => {
    const h = [];
    for (const q of list) {
      while (h.length >= 2 && turn(h[h.length - 2], h[h.length - 1], q) <= 1e-9) h.pop();
      h.push(q);
    }
    h.pop();
    return h;
  };
  return [...half(p), ...half([...p].reverse())];
}

// The part of poly where f(p) >= 0, f affine (Sutherland-Hodgman against one half-plane). New points get every
// element interpolated.
export function clipHalf(poly, f) {
  const out = [];
  poly.forEach((a, i) => {
    const b = poly[(i + 1) % poly.length], fa = f(a), fb = f(b);
    if (fa >= 0) out.push(a);
    if ((fa > 0 && fb < 0) || (fa < 0 && fb > 0)) {
      const t = fa / (fa - fb);
      out.push(a.map((v, k) => v + (b[k] - v) * t));
    }
  });
  return out;
}

// Signed distance of p from the line a -> b: positive on its left.
const side = (a, b, p) => { const e = sub(b, a), l = Math.hypot(e[0], e[1]); return l > 1e-12 ? cross(e, sub(p, a)) / l : 0; };

// The corners of a convex polygon, ccw, without repeats: a corner listed twice gives an edge with no direction, whose
// half-plane would keep everything on both sides.
const corners = poly => ccw(poly).filter((p, i, a) => Math.hypot(p[0] - a[(i + 1) % a.length][0], p[1] - a[(i + 1) % a.length][1]) > 1e-6);

// poly (any simple polygon) cut to the inside of the convex polygon clip.
export function clipConvex(poly, clip) {
  const c = corners(clip);
  if (c.length < 3) return [];
  let out = poly;
  for (let i = 0; i < c.length && out.length >= 3; i++) out = clipHalf(out, p => side(c[i], c[(i + 1) % c.length], p));
  return out.length >= 3 ? out : [];
}

// Convex poly minus convex cut, as convex pieces (one per edge of cut that poly reaches past). Pieces under minArea
// are dropped.
export function subtractConvex(poly, cut, minArea = 0.5) {
  const c = corners(cut), out = [];
  if (c.length < 3) return [poly];
  let rest = poly;
  for (let i = 0; i < c.length && rest.length >= 3; i++) {
    const a = c[i], b = c[(i + 1) % c.length], outside = clipHalf(rest, p => -side(a, b, p));
    if (outside.length >= 3 && Math.abs(area(outside)) >= minArea) out.push(outside);
    rest = clipHalf(rest, p => side(a, b, p));
  }
  return out;
}

// Whether p is inside poly (even-odd rule; points on an edge count either way).
export function inside(p, poly) {
  let n = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) n = !n;
  }
  return n;
}

// Distance from p to the segment a-b.
export function segDist(p, a, b) {
  const d = sub(b, a), l2 = dot(d, d), t = l2 ? Math.max(0, Math.min(1, dot(sub(p, a), d) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - d[0] * t, p[1] - a[1] - d[1] * t);
}

// Whether segments a-b and c-d cross at a point inside both (touching ends do not count).
export function segCross(a, b, c, d, eps = 1e-9) {
  const d1 = turn(a, b, c), d2 = turn(a, b, d), d3 = turn(c, d, a), d4 = turn(c, d, b);
  return ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps));
}

// Distances t along the ray o + t * d where it crosses poly's edges, ascending (d need not be a unit vector).
export function rayHits(o, d, poly) {
  const ts = [];
  poly.forEach((a, i) => {
    const e = sub(poly[(i + 1) % poly.length], a), den = cross(d, e);
    if (Math.abs(den) < 1e-12) return;
    const w = sub(a, o), s = cross(w, d) / den;
    if (s >= -1e-9 && s <= 1 + 1e-9) ts.push(cross(w, e) / den);
  });
  return ts.sort((x, y) => x - y);
}

// Distance from b to the line through a and c (the line through a and b when c is a).
const offLine = (a, b, c) => { const l = Math.hypot(...sub(c, a)); return l > 1e-12 ? Math.abs(turn(a, b, c)) / l : Math.hypot(...sub(b, a)); };

// Drops repeated points and points within eps of the straight line between their neighbours (rounded coordinates
// leave points a hair off a straight side; kept, they make thin slivers and near-duplicate brush planes).
export function simplify(poly, eps = 0.01) {
  let p = poly.filter((q, i) => Math.hypot(...sub(q, poly[(i + 1) % poly.length])) > eps);
  for (let changed = true; changed && p.length > 3;) {
    changed = false;
    for (let i = 0; i < p.length; i++) {
      if (offLine(p[(i + p.length - 1) % p.length], p[i], p[(i + 1) % p.length]) <= eps) { p = p.filter((_, k) => k !== i); changed = true; break; }
    }
  }
  return p;
}

// Counter-clockwise and convex: no corner bends the wrong way by more than eps (a distance).
export const isConvex = (poly, eps = 0.01) => poly.length >= 3 && poly.every((p, i) => {
  const q = poly[(i + 1) % poly.length], r = poly[(i + 2) % poly.length];
  return turn(p, q, r) >= 0 || offLine(p, q, r) <= eps;
});

const inTri = (p, a, b, c) => turn(a, b, p) >= -1e-9 && turn(b, c, p) >= -1e-9 && turn(c, a, p) >= -1e-9;

// Ear clipping: triangles as index triples into p (counter-clockwise, simplified). Each step cuts the ear with the
// shortest diagonal, which gives fat triangles (and fat pieces once merged) instead of long fans.
function earClip(p) {
  const idx = p.map((_, i) => i), tris = [];
  while (idx.length > 3) {
    let best = -1, bestLen = Infinity;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k + idx.length - 1) % idx.length], i1 = idx[k], i2 = idx[(k + 1) % idx.length];
      if (turn(p[i0], p[i1], p[i2]) <= 1e-9) continue;
      if (idx.some(j => j !== i0 && j !== i1 && j !== i2 && inTri(p[j], p[i0], p[i1], p[i2]))) continue;
      const l = Math.hypot(...sub(p[i2], p[i0]));
      if (l < bestLen) { bestLen = l; best = k; }
    }
    if (best < 0) return null; // self-intersecting or degenerate input
    tris.push([idx[(best + idx.length - 1) % idx.length], idx[best], idx[(best + 1) % idx.length]]);
    idx.splice(best, 1);
  }
  tris.push(idx);
  return tris;
}

// Index polygons A and B sharing an edge (A has u, v; B has v, u) merged into one, else null.
const rot = (arr, start) => [...arr.slice(start), ...arr.slice(0, start)];
export function join(A, B) {
  for (let i = 0; i < A.length; i++) {
    const u = A[i], v = A[(i + 1) % A.length], j = B.findIndex((x, k) => x === v && B[(k + 1) % B.length] === u);
    if (j < 0) continue;
    // A from v round to u, then B from after u round to before v
    return [...rot(A, (i + 1) % A.length), ...rot(B, (j + 2) % B.length).slice(0, B.length - 2)];
  }
  return null;
}

// A simple polygon split into convex pieces (counter-clockwise, simplified): ear clipping, then Hertel-Mehlhorn
// merging of neighbouring triangles while the union stays convex. [] for a degenerate polygon.
export function convexParts(poly) {
  const p = simplify(ccw(poly));
  if (p.length < 3 || Math.abs(area(p)) < 1e-9) return [];
  if (isConvex(p)) return [p];
  const tris = earClip(p);
  if (!tris) return [];
  const parts = tris.map(t => [...t]), pts = ix => ix.map(k => p[k]);
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < parts.length && !merged; i++) for (let j = i + 1; j < parts.length && !merged; j++) {
      const m = join(parts[i], parts[j]);
      if (m && isConvex(pts(m))) { parts[i] = m; parts.splice(j, 1); merged = true; }
    }
  }
  return parts.map(ix => simplify(pts(ix)));
}

// Non-overlapping polygons (the pieces of one floor, or any simple polygons) as few convex pieces as it takes, so
// brushes get whole faces instead of fans of thin triangles: the outline of their union (holes too), less its corners
// whose triangle with their neighbours lies under slack (convex polygons: walls standing over it, which hide the
// difference), each reflex corner cut (along the grid where that fits, rows before columns, the shorter; a diagonal to
// a reflex corner the cut also resolves only where it is under half as long; else along one of its sides where that
// leaves 30 degrees or more, else across its middle), then neighbours merged where together they are convex. Corners
// closer than weld are one, at their middle (a chain of them wider than 2 * weld stays
// apart), and a cut ending within snap of a corner goes to the corner. Pieces are left no thinner than thin and with
// no side shorter where it can be helped: a sliver (a crack or a hair of overlap in the drawing) goes into the
// neighbour whose hull with it adds no more than it is, and a short side's neighbours run on to where they meet
// (within 4 * thin), so the outline keeps its place (at worst a hair of overlap with what is beside it). Where welding
// leaves an outline that crosses itself, it is tried again with corners a thousandth apart. Pieces get at most
// maxPoints corners. Null where it fails (the caller keeps its own pieces), also where a piece came out winding
// round twice (its hull would overlap a neighbour).
export function partition(polys, { weld = 0.05, thin = 0.5, snap = 1, maxPoints = 64, slack = [] } = {}) {
  for (const w of [weld, 0.001]) { const r = cutUp(polys, w, thin, snap, maxPoints, slack); if (r) return r; }
  return null;
}
// How wide convex poly is at its narrowest.
export const narrowest = poly => Math.min(...poly.map((a, i) => { const b = poly[(i + 1) % poly.length], l = Math.hypot(...sub(b, a)); return l > 1e-9 ? Math.max(...poly.map(p => Math.abs(cross(sub(b, a), sub(p, a))) / l)) : Infinity; }));
function cutUp(polys, weld, thin, snap, maxPoints, slack) {
  const P = [], adj = [], inner = new Set(), TAU = 2 * Math.PI;
  const use = polys.filter(q => q.length >= 3 && Math.abs(area(q)) > 1e-9).map(ccw), pts = use.flat(), total = use.reduce((s, q) => s + area(q), 0);
  const up = pts.map((_, i) => i), find = i => (up[i] === i ? i : (up[i] = find(up[i]))), cells = new Map(), groups = new Map(), at = [];
  pts.forEach((p, i) => {
    const cx = Math.floor(p[0] / weld), cy = Math.floor(p[1] / weld);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const j of cells.get(`${cx + a},${cy + b}`) ?? []) if (Math.hypot(pts[j][0] - p[0], pts[j][1] - p[1]) < weld) up[find(j)] = find(i);
    (cells.get(`${cx},${cy}`) ?? cells.set(`${cx},${cy}`, []).get(`${cx},${cy}`)).push(i);
  });
  pts.forEach((_, i) => (groups.get(find(i)) ?? groups.set(find(i), []).get(find(i))).push(i));
  const add = p => { adj.push([]); return P.push(p) - 1; };
  for (const list of groups.values()) {
    const xs = list.map(i => pts[i][0]), ys = list.map(i => pts[i][1]);
    if (Math.max(...xs) - Math.min(...xs) <= 2 * weld && Math.max(...ys) - Math.min(...ys) <= 2 * weld) {
      const k = add([xs.reduce((s, x) => s + x, 0) / xs.length, ys.reduce((s, y) => s + y, 0) / ys.length]);
      for (const i of list) at[i] = k;
    } else {
      const same = new Map();
      for (const i of list) { const key = pts[i].map(v => Math.round(v * 1e4)).join(); at[i] = same.get(key) ?? same.set(key, add([pts[i][0], pts[i][1]])).get(key); }
    }
  }
  let n = 0;
  const rings = use.map(q => q.map(() => at[n++]));
  // the outline: every side, split where another polygon's corner lies on it, less the sides two polygons share
  const count = new Map();
  for (const r of rings) r.forEach((a, i) => {
    const b = r[(i + 1) % r.length], d = sub(P[b], P[a]), l2 = dot(d, d);
    if (a === b) return;
    const on = [];
    for (let k = 0; k < P.length; k++) if (k !== a && k !== b) { const t = dot(sub(P[k], P[a]), d) / l2; if (t > 0 && t < 1 && segDist(P[k], P[a], P[b]) < 0.02) on.push([t, k]); }
    const chain = [a, ...on.sort((x, y) => x[0] - y[0]).map(x => x[1]), b];
    for (let j = 0; j + 1 < chain.length; j++) { const k = `${chain[j]},${chain[j + 1]}`; count.set(k, (count.get(k) ?? 0) + 1); }
  });
  const ang = (a, b) => Math.atan2(P[b][1] - P[a][1], P[b][0] - P[a][0]);
  const order = v => adj[v].sort((x, y) => ang(v, x) - ang(v, y)); // counter-clockwise round v
  const link = (a, b) => { adj[a].push(b); adj[b].push(a); };
  for (const [k, n] of count) {
    const [a, b] = k.split(',').map(Number), m = n - (count.get(`${b},${a}`) ?? 0);
    if (m > 1) return null; // overlapping polygons
    if (m === 1) { link(a, b); inner.add(k); } // (the inside on its left)
  }
  adj.forEach((_, v) => order(v));
  // (corners of the outline less than 0.05 off the line through their neighbours go: rounding leaves chains of them,
  // each a hair off, that bend the outline further together)
  for (let again = true; again;) {
    again = false;
    adj.forEach((l, v) => {
      if (l.length !== 2) return;
      const [x, y] = inner.has(`${v},${l[0]}`) ? [l[1], l[0]] : [l[0], l[1]]; // x -> v -> y
      if (!inner.has(`${x},${v}`) || !inner.has(`${v},${y}`) || adj[x].includes(y) || offLine(P[x], P[v], P[y]) > 0.05) return;
      inner.delete(`${x},${v}`);
      inner.delete(`${v},${y}`);
      inner.add(`${x},${y}`);
      adj[x].splice(adj[x].indexOf(v), 1, y);
      adj[y].splice(adj[y].indexOf(v), 1, x);
      adj[v] = [];
      order(x);
      order(y);
      again = true;
    });
  }
  // (a corner whose triangle with its neighbours lies under slack: the outline runs straight from one neighbour to the
  // other, the wall over it hides the difference; fewer corners, fewer cuts)
  let shifted = 0;
  const covered = (a, b, c) => {
    for (let i = 0; i <= 8; i++) for (let j = 0; i + j <= 8; j++) {
      const k = 8 - i - j, q = [(a[0] * i + b[0] * j + c[0] * k) / 8, (a[1] * i + b[1] * j + c[1] * k) / 8];
      if (!slack.some(s => inside(q, s) || s.some((p, m) => segDist(q, p, s[(m + 1) % s.length]) < 0.05))) return false;
    }
    return true;
  };
  for (let again = slack.length > 0; again;) {
    again = false;
    adj.forEach((l, v) => {
      if (l.length !== 2) return;
      const [x, y] = inner.has(`${v},${l[0]}`) ? [l[1], l[0]] : [l[0], l[1]]; // x -> v -> y
      if (!inner.has(`${x},${v}`) || !inner.has(`${v},${y}`) || adj[x].includes(y) || !covered(P[x], P[v], P[y])) return;
      const tri = [P[x], P[v], P[y]];
      for (const k of inner) {
        const [a, b] = k.split(',').map(Number);
        if (a === x || a === y || a === v || b === x || b === y || b === v) continue;
        if (segCross(P[x], P[y], P[a], P[b]) || segCross(P[x], P[v], P[a], P[b]) || segCross(P[v], P[y], P[a], P[b])) return;
      }
      if (adj.some((m, k) => m.length && k !== x && k !== y && k !== v && inside(P[k], tri))) return;
      shifted -= area(tri);
      inner.delete(`${x},${v}`);
      inner.delete(`${v},${y}`);
      inner.add(`${x},${y}`);
      adj[x].splice(adj[x].indexOf(v), 1, y);
      adj[y].splice(adj[y].indexOf(v), 1, x);
      adj[v] = [];
      order(x);
      order(y);
      again = true;
    });
  }
  // (round each corner the sides go in, out, in, out: an outline that crosses itself does not)
  if (adj.some((l, v) => l.some((x, i) => inner.has(`${v},${x}`) === inner.has(`${v},${l[(i + 1) % l.length]}`)))) return null;
  const rim = [...inner].reduce((s, k) => { const [a, b] = k.split(',').map(Number); return s + Math.hypot(...sub(P[b], P[a])); }, 0);
  // the nearest point where the ray from v along d meets a side not at v: { t, a, b, s } (s: how far along a-b)
  const cast = (v, d) => {
    let best = null;
    for (let a = 0; a < P.length; a++) for (const b of adj[a]) {
      if (b < a || a === v || b === v) continue;
      const e = sub(P[b], P[a]), den = cross(d, e);
      if (Math.abs(den) < 1e-12) continue;
      const w = sub(P[a], P[v]), t = cross(w, e) / den, s = cross(w, d) / den;
      if (t > 1e-7 && s >= -1e-9 && s <= 1 + 1e-9 && (!best || t < best.t)) best = { t, a, b, s };
    }
    return best;
  };
  // the corners at v: from each side v -> x with the inside on its left round to the next side y; reflex where the walk
  // y -> v -> x turns right by more than 0.05
  const wedge = (v, x, y) => (x === y ? TAU : (((ang(v, y) - ang(v, x)) % TAU) + TAU) % TAU);
  const reflex = v => adj[v].flatMap((x, i) => {
    const y = adj[v][(i + 1) % adj[v].length];
    return inner.has(`${v},${x}`) && (x === y || (turn(P[y], P[v], P[x]) < 0 && offLine(P[y], P[v], P[x]) > 0.05)) ? [{ v, x, y, th: wedge(v, x, y) }] : [];
  });
  // whether direction phi (counter-clockwise from v -> x) leaves no angle over 180 at corner c, and both parts at least m
  const fits = (c, phi, m = 0) => phi >= c.th - Math.PI - 1e-9 && phi <= Math.PI + 1e-9 && phi >= m && c.th - phi >= m;
  const phiOf = (c, q) => (((ang(c.v, q) - ang(c.v, c.x)) % TAU) + TAU) % TAU;
  const clear = (v, q) => { const d = sub(P[q], P[v]), l = Math.hypot(...d), h = cast(v, [d[0] / l, d[1] / l]); return h && h.t >= l - 1e-6 && (h.a === q || h.b === q || h.t > l + 1e-6); };
  const MIN = (15 * Math.PI) / 180;
  const choose = c => {
    const { v } = c;
    // a diagonal to a reflex corner that it resolves too, the shortest
    let best = null;
    for (let q = 0; q < P.length; q++) {
      if (q === v || adj[v].includes(q)) continue;
      const l = Math.hypot(...sub(P[q], P[v]));
      if ((best && l >= best.l) || !fits(c, phiOf(c, q), MIN)) continue;
      if (reflex(q).some(o => fits(o, phiOf(o, v), MIN)) && clear(v, q)) best = { q, l };
    }
    // along the grid, rows before columns, the shortest by weight (a cut ending at a corner counts half; one ending under
    // 8 from a corner or meeting a side at under 15 degrees, a sliver, ten times); that diagonal only where it is under
    // half as long
    let pick = best && { ...best, l: best.l * 2 };
    for (const [d, w] of [[[1, 0], 1], [[-1, 0], 1], [[0, 1], 1.25], [[0, -1], 1.25]]) {
      const phi = (((Math.atan2(d[1], d[0]) - ang(v, c.x)) % TAU) + TAU) % TAU, h = fits(c, phi, MIN) && cast(v, d);
      if (!h) continue;
      const e = sub(P[h.b], P[h.a]), L = Math.hypot(...e), near = h.s < 0.5 ? h.a : h.b, gap = Math.min(h.s, 1 - h.s) * L, sin = Math.abs(cross(d, e)) / L;
      let o = null;
      if (gap < snap && !adj[v].includes(near) && fits(c, phiOf(c, near)) && clear(v, near)) o = { q: near, l: (w * Math.hypot(...sub(P[near], P[v]))) / 2 };
      else if (gap >= 0.5) o = { hit: h, l: w * h.t * (sin < 0.26 || gap < 8 ? 10 : 1) };
      if (o && (!pick || o.l < pick.l - 1e-6)) pick = o;
    }
    if (pick) return pick;
    // else along a side (at a corner of 210 degrees or more) or across the middle; failing those, other directions
    const phis = c.th - Math.PI >= Math.PI / 6 ? [c.th - Math.PI, Math.PI] : [c.th / 2];
    const more = [1, 2, 3, 4, 5, 6, 7].map(k => c.th - Math.PI + ((2 * Math.PI - c.th) * k) / 8);
    for (const list of [phis, more]) {
      let pick = null;
      for (const phi of list) {
        const a0 = ang(v, c.x) + phi, d = [Math.cos(a0), Math.sin(a0)], h = cast(v, d);
        if (!h) continue;
        const e = sub(P[h.b], P[h.a]), L = Math.hypot(...e), near = h.s < 0.5 ? h.a : h.b, gap = Math.min(h.s, 1 - h.s) * L, sin = Math.abs(cross(d, e)) / L;
        let o = null;
        if (gap < snap && !adj[v].includes(near) && fits(c, phiOf(c, near)) && clear(v, near)) o = { q: near, l: Math.hypot(...sub(P[near], P[v])) / 2 };
        else if (gap >= 0.5) o = { hit: h, l: h.t * (sin < 0.26 ? 10 : 1) }; // (a cut meeting a side at under 15 degrees: a sliver)
        if (o && (!pick || o.l < pick.l - 1e-6)) pick = o;
      }
      if (pick) return pick;
    }
    return null;
  };
  // side a-b split at new corner k
  const split = (a, b, k) => {
    adj[a].splice(adj[a].indexOf(b), 1);
    adj[b].splice(adj[b].indexOf(a), 1);
    link(a, k); link(k, b);
    for (const [u, w] of [[a, b], [b, a]]) if (inner.delete(`${u},${w}`)) { inner.add(`${u},${k}`); inner.add(`${k},${w}`); }
    order(a); order(b);
  };
  for (let guard = 0; ; guard++) {
    if (guard > 4 * P.length + 64) return null;
    const cs = adj.flatMap((_, v) => reflex(v));
    if (!cs.length) break;
    const c = cs.reduce((m, o) => (o.th > m.th + 1e-9 ? o : m)), pick = choose(c);
    if (!pick) return null;
    let q = pick.q;
    if (q === undefined) {
      const { a, b, s } = pick.hit;
      adj.push([]);
      q = P.push([P[a][0] + (P[b][0] - P[a][0]) * s, P[a][1] + (P[b][1] - P[a][1]) * s]) - 1;
      split(a, b, q);
    }
    link(c.v, q);
    inner.add(`${c.v},${q}`);
    inner.add(`${q},${c.v}`);
    order(c.v);
    order(q);
  }
  // the faces: walk each side with the inside on its left, turning onto the next side clockwise at each corner
  const faces = [], seen = new Set();
  for (const h of inner) {
    if (seen.has(h)) continue;
    let [u, v] = h.split(',').map(Number), k = h;
    const f = [];
    while (!seen.has(k)) {
      if (!inner.has(k) || f.length > P.length) return null;
      seen.add(k);
      f.push(P[u]);
      const l = adj[v], w = l[(l.indexOf(u) - 1 + l.length) % l.length];
      [u, v, k] = [v, w, `${v},${w}`];
    }
    const poly = simplify(f, 0.01);
    if (k !== h || !isConvex(poly, 0.05) || area(poly) <= 0) return null;
    faces.push(poly);
  }
  // neighbours that are convex together become one (the hull of the two adds no area)
  const ps = faces.map(poly => ({ poly, a: area(poly) }));
  for (let again = true; again;) {
    again = false;
    for (let i = 0; i < ps.length && !again; i++) for (let j = i + 1; j < ps.length && !again; j++) {
      const h = simplify(hull([...ps[i].poly, ...ps[j].poly]), 0.01), ha = area(h);
      if (h.length < 3 || h.length > maxPoints || Math.abs(ha - ps[i].a - ps[j].a) > 1e-3) continue;
      ps[i] = { poly: h, a: ha };
      ps.splice(j, 1);
      again = true;
    }
  }
  // (slivers go into a neighbour, short sides go)
  let grown = 0;
  for (let i = 0; i < ps.length; i++) {
    if (narrowest(ps[i].poly) >= thin) continue;
    let best = null;
    ps.forEach((q, j) => {
      if (j === i) return;
      const h = simplify(hull([...ps[i].poly, ...q.poly]), 0.01), extra = area(h) - ps[i].a - q.a;
      if (h.length <= maxPoints && extra <= ps[i].a + 0.01 && (!best || extra < best.extra)) best = { j, h, extra };
    });
    if (!best) continue;
    ps[best.j] = { poly: best.h, a: area(best.h) };
    grown += best.extra;
    ps.splice(i, 1);
    i = -1;
  }
  // (where the lines of sides p-a and b-q meet beyond a and b)
  const meet = (p, a, b, q) => { const d = sub(a, p), e = sub(q, b), den = cross(d, e); if (Math.abs(den) < 1e-9) return null; const t = cross(sub(b, p), e) / den, u = cross(sub(b, p), d) / den; return t > 1 && u < 0 ? [p[0] + d[0] * t, p[1] + d[1] * t] : null; };
  for (const p of ps) for (let i = 0, q = p.poly; i < q.length && q.length > 3; i++) {
    const n = q.length, a = q[i], b = q[(i + 1) % n], m = Math.hypot(...sub(b, a)) < thin && meet(q[(i + n - 1) % n], a, b, q[(i + 2) % n]);
    if (!m || Math.hypot(...sub(m, a)) >= 4 * thin || Math.hypot(...sub(m, b)) >= 4 * thin) continue;
    q = i + 1 < n ? [...q.slice(0, i), m, ...q.slice(i + 2)] : [m, ...q.slice(1, -1)];
    grown += area(q) - p.a;
    Object.assign(p, { poly: q, a: area(q) });
    i = -1;
  }
  // (a piece with too many corners is halved)
  const out = [], cap = poly => { if (poly.length <= maxPoints) return void out.push(poly); const m = poly.length >> 1; cap(poly.slice(0, m + 1)); cap([...poly.slice(m), poly[0]]); };
  ps.forEach(p => cap(p.poly));
  // (no piece winds round twice: its hull would cover more than it does)
  if (out.some(q => Math.abs(area(hull(q)) - area(q)) > 1e-3 * Math.abs(area(q)) + 0.01)) return null;
  // (welding moves the outline at most weld / 2)
  return Math.abs(out.reduce((s, q) => s + area(q), 0) - total - grown - shifted) <= (rim * weld) / 2 + 1 ? out : null;
}

// Non-overlapping convex pieces re-cut the way a mapper blocks out floors: the biggest rectangle that fits (wholly
// inside, at least minSide each way and minArea, not across a wall), grown a grid step at a time into what is beside
// it while the piece stays convex and no wall runs through it (its corners clipped to the outline, as vertex editing
// does), then the next biggest, until none fits; what is left is cut up again (partition). The grid is the pieces'
// corner coordinates and the walls' lines. walls: [[a, b]] middle lines; only those along an axis count. A piece mostly
// not along the axes (a block turned 45 degrees) stays as it is. Null where the pieces do not add up.
export function boxes(input, { minSide = 32, minArea = 4096, walls = [], door = 192 } = {}) {
  const pieces = partition(input) ?? input; // (whole pieces: a fan of triangles is no block turned 45 degrees)
  const axisShare = p => { let ax = 0, all = 0; p.forEach((a, i) => { const b = p[(i + 1) % p.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]); all += l; if (Math.abs(a[0] - b[0]) < 0.01 || Math.abs(a[1] - b[1]) < 0.01) ax += l; }); return all ? ax / all : 0; };
  const keep = pieces.filter(p => axisShare(p) < 0.5), use = pieces.filter(p => axisShare(p) >= 0.5);
  const total = pieces.reduce((s, p) => s + Math.abs(area(p)), 0);
  if (!use.length) return pieces;
  const bx = [Math.min(...use.flat().map(p => p[0])), Math.min(...use.flat().map(p => p[1])), Math.max(...use.flat().map(p => p[0])), Math.max(...use.flat().map(p => p[1]))];
  // (walls along an axis, as { k: the axis they run along, c: their line, a, b: their ends })
  const segs = walls.flatMap(([p, q]) => (Math.abs(p[1] - q[1]) < 0.01 ? [{ k: 0, c: p[1], a: Math.min(p[0], q[0]), b: Math.max(p[0], q[0]) }] : Math.abs(p[0] - q[0]) < 0.01 ? [{ k: 1, c: p[0], a: Math.min(p[1], q[1]), b: Math.max(p[1], q[1]) }] : []));
  // (walls on one line with a gap up to door, a doorway, are one line across it: a room's floor ends at its threshold)
  const lines = [];
  for (const s of [...segs].sort((p, q) => p.k - q.k || p.c - q.c || p.a - q.a)) {
    const l = lines.at(-1);
    if (l && l.k === s.k && Math.abs(l.c - s.c) < 0.5 && s.a - l.b <= door) l.b = Math.max(l.b, s.b);
    else lines.push({ ...s });
  }
  const uniq = vs => [...new Set(vs.map(v => Math.round(v * 1000) / 1000))].sort((a, b) => a - b);
  const xs = uniq([...use.flat().map(p => p[0]), ...lines.filter(l => l.k === 1 && l.c > bx[0] && l.c < bx[2]).map(l => l.c)]);
  const ys = uniq([...use.flat().map(p => p[1]), ...lines.filter(l => l.k === 0 && l.c > bx[1] && l.c < bx[3]).map(l => l.c)]);
  const nx = xs.length - 1, ny = ys.length - 1;
  const idx = (vs, v) => { let lo = 0, hi = vs.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (vs[m] < v - 1e-3) lo = m + 1; else hi = m; } return lo; };
  const fill = Array.from({ length: ny }, () => new Float64Array(nx)), parts = new Map();
  for (const p of use) {
    const px = p.map(q => q[0]), py = p.map(q => q[1]);
    for (let j = idx(ys, Math.min(...py)); j < ny && ys[j] < Math.max(...py) - 1e-3; j++) for (let i = idx(xs, Math.min(...px)); i < nx && xs[i] < Math.max(...px) - 1e-3; i++) {
      const c = clipConvex(p, [[xs[i], ys[j]], [xs[i + 1], ys[j]], [xs[i + 1], ys[j + 1]], [xs[i], ys[j + 1]]]), a = c.length >= 3 ? Math.abs(area(c)) : 0;
      if (a <= 1e-6) continue;
      fill[j][i] += a;
      (parts.get(j * nx + i) ?? parts.set(j * nx + i, []).get(j * nx + i)).push(c);
    }
  }
  const full = fill.map((row, j) => Array.from(row, (a, i) => a >= (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]) * (1 - 1e-6) - 1e-6));
  const taken = Array.from({ length: ny }, () => new Array(nx).fill(false));
  // (a wall's line through the box, more than 12 in from its sides: the box would run on under the wall into the next room)
  const across = (i0, i1, j0, j1) => {
    const x0 = xs[i0] + 12, x1 = xs[i1] - 12, y0 = ys[j0] + 12, y1 = ys[j1] - 12;
    return lines.find(l => (l.k === 0 ? l.c > y0 && l.c < y1 && Math.min(l.b, x1) - Math.max(l.a, x0) > 1 : l.c > x0 && l.c < x1 && Math.min(l.b, y1) - Math.max(l.a, y0) > 1));
  };
  // (the box's piece: the hull of what lies in it, where that is all of it, so the piece is convex; null where it is
  // not, or the box reaches what another piece has)
  const piece = (i0, i1, j0, j1) => {
    let a = 0;
    const pts = [];
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
      const list = parts.get(j * nx + i);
      if (!list) continue;
      if (taken[j][i]) return null;
      a += fill[j][i];
      for (const c of list) pts.push(...c);
    }
    if (a <= 1e-6) return null;
    const h = simplify(hull(pts), 0.01);
    return Math.abs(Math.abs(area(h)) - a) <= 1e-4 * a + 0.05 ? { poly: h, a } : null;
  };
  // the biggest rectangle of whole free cells, at least minSide each way and minArea
  const biggest = () => {
    let best = null;
    const start = new Array(nx).fill(-1);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) start[i] = full[j][i] && !taken[j][i] ? (start[i] < 0 ? j : start[i]) : -1;
      const st = [];
      for (let i = 0; i <= nx; i++) {
        const j0 = i < nx ? start[i] : -1, h = j0 < 0 ? 0 : ys[j + 1] - ys[j0];
        let i0 = i;
        while (st.length && st.at(-1).h >= h) {
          const t = st.pop(), w = xs[i] - xs[t.i0], a = w * t.h;
          if (t.h >= minSide && w >= minSide && a >= minArea && (!best || a > best.a + 1e-6)) best = { a, i0: t.i0, i1: i, j0: t.j0, j1: j + 1 };
          i0 = t.i0;
        }
        if (h > 0) st.push({ i0, h, j0 });
      }
    }
    return best;
  };
  // (a rectangle across a wall: its biggest part either side of the wall's line, split again while walls cross it)
  const split = b => {
    const l = across(b.i0, b.i1, b.j0, b.j1);
    if (!l) return b;
    const halves = l.k === 0 ? [{ ...b, j1: idx(ys, l.c) }, { ...b, j0: idx(ys, l.c) }] : [{ ...b, i1: idx(xs, l.c) }, { ...b, i0: idx(xs, l.c) }];
    return halves.filter(h => h.i1 > h.i0 && h.j1 > h.j0).map(h => split({ ...h, a: (xs[h.i1] - xs[h.i0]) * (ys[h.j1] - ys[h.j0]) })).filter(Boolean).sort((p, q) => q.a - p.a)[0] ?? null;
  };
  const out = [];
  for (let guard = 0; guard < 4 * nx * ny + 8; guard++) {
    const seed = biggest();
    if (!seed) break;
    const b = split(seed);
    if (!b || xs[b.i1] - xs[b.i0] < minSide || ys[b.j1] - ys[b.j0] < minSide) {
      // (only slivers either side of a wall: its cells are left to the rest)
      for (let j = seed.j0; j < seed.j1; j++) for (let i = seed.i0; i < seed.i1; i++) full[j][i] = false;
      continue;
    }
    let cur = { ...b, ...piece(b.i0, b.i1, b.j0, b.j1) };
    // (grown a step at a time, the step adding most first)
    for (let grew = true; grew;) {
      grew = false;
      let pick = null;
      for (const [di0, di1, dj0, dj1] of [[-1, 0, 0, 0], [0, 1, 0, 0], [0, 0, -1, 0], [0, 0, 0, 1]]) {
        const n = { i0: cur.i0 + di0, i1: cur.i1 + di1, j0: cur.j0 + dj0, j1: cur.j1 + dj1 };
        if (n.i0 < 0 || n.j0 < 0 || n.i1 > nx || n.j1 > ny || across(n.i0, n.i1, n.j0, n.j1)) continue;
        const pc = piece(n.i0, n.i1, n.j0, n.j1);
        if (pc && pc.a > cur.a + 1e-6 && (!pick || pc.a > pick.a)) pick = { ...n, ...pc };
      }
      if (pick) { cur = pick; grew = true; }
    }
    for (let j = cur.j0; j < cur.j1; j++) for (let i = cur.i0; i < cur.i1; i++) { if (parts.has(j * nx + i)) taken[j][i] = true; full[j][i] = false; }
    out.push(cur.poly);
  }
  // (what is left, cut up again as one outline)
  const rest = [];
  for (const [k, list] of parts) if (!taken[Math.floor(k / nx)][k % nx]) rest.push(...list);
  const again = (rest.length ? partition(rest) ?? rest : []).map(q => ccw(q));
  // (and each of those joins the biggest piece beside it that it is convex with, where no wall runs through the two: a
  // box takes the corner it was clipped to, as vertex editing does)
  const crossed = poly => lines.some(l => {
    const n = Math.max(2, Math.ceil((l.b - l.a) / 8));
    for (let s = 0; s <= n; s++) {
      const t = l.a + ((l.b - l.a) * s) / n, p = l.k === 0 ? [t, l.c] : [l.c, t];
      if (inside(p, poly) && Math.min(...poly.map((a, i) => segDist(p, a, poly[(i + 1) % poly.length]))) > 12) return true;
    }
    return false;
  });
  const placed = out.map(q => ccw(q));
  for (const q of again.sort((x, y) => Math.abs(area(x)) - Math.abs(area(y)))) {
    const a = Math.abs(area(q));
    let best = null;
    placed.forEach((r, j) => {
      const h = simplify(hull([...q, ...r]), 0.01), ha = Math.abs(area(h)), ra = Math.abs(area(r));
      if (h.length >= 3 && h.length <= 64 && Math.abs(ha - a - ra) <= 1e-4 * ha + 0.05 && (!best || ra > best.ra) && !crossed(h)) best = { j, h, ra };
    });
    if (best) placed[best.j] = best.h;
    else placed.push(q);
  }
  const all = [...placed, ...keep].map(q => ccw(q));
  // (a sliver under 2 wide, a drawing's corners a unit apart, goes into the neighbour whose hull with it adds least, a
  // hair of overlap at most: vbsp cannot bound so thin a brush)
  let grown = 0;
  for (let i = 0; i < all.length; i++) {
    if (narrowest(all[i]) >= 2) continue;
    const a = Math.abs(area(all[i])), long = Math.max(...all[i].map((p, k) => Math.hypot(...sub(all[i][(k + 1) % all[i].length], p))));
    let best = null;
    all.forEach((q, j) => {
      if (j === i) return;
      const h = simplify(hull([...all[i], ...q]), 0.01), extra = Math.abs(area(h)) - a - Math.abs(area(q));
      if (h.length >= 3 && h.length <= 64 && extra <= Math.max(a + 0.01, 1.5 * long) && (!best || extra < best.extra)) best = { j, h, extra };
    });
    if (!best) continue;
    all[best.j] = best.h;
    grown += best.extra;
    all.splice(i, 1);
    i = -1;
  }
  // (a side under a unit, a box's edge a hair from a corner of the drawing: its neighbours run on to where they meet,
  // within 4)
  const meet = (p, a, b, q) => { const d = sub(a, p), e = sub(q, b), den = d[0] * e[1] - d[1] * e[0]; if (Math.abs(den) < 1e-9) return null; const w = sub(b, p), t = (w[0] * e[1] - w[1] * e[0]) / den, u = (w[0] * d[1] - w[1] * d[0]) / den; return t > 1 && u < 0 ? [p[0] + d[0] * t, p[1] + d[1] * t] : null; };
  for (let k = 0; k < all.length; k++) for (let i = 0, q = all[k]; i < q.length && q.length > 3; i++) {
    const n = q.length, a = q[i], b = q[(i + 1) % n], m = Math.hypot(...sub(b, a)) < 1 && meet(q[(i + n - 1) % n], a, b, q[(i + 2) % n]);
    if (!m || Math.hypot(...sub(m, a)) >= 4 || Math.hypot(...sub(m, b)) >= 4) continue;
    const r = i + 1 < n ? [...q.slice(0, i), m, ...q.slice(i + 2)] : [m, ...q.slice(1, -1)];
    grown += Math.abs(area(r)) - Math.abs(area(q));
    all[k] = q = r;
    i = -1;
  }
  return Math.abs(all.reduce((s, q) => s + Math.abs(area(q)), 0) - total - grown) <= 1e-3 * total + 1 ? all : null;
}
