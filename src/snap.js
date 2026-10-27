// Object snapping (3ds Max's snaps): while the selection moves, the moving point nearest a target on screen is pulled
// onto the unselected geometry: onto a vertex (cfg.snapVertex), onto the nearest point of an edge (cfg.snapEdge), onto
// the point where two edges cross (cfg.snapIntersection, CAD's intersection snap), or onto the plane of the face under
// the cursor (cfg.snapFace, 3D view). Targets count within R pixels; where there is none the move keeps its grid
// snapping. A drag builds one snapper at its start (the targets do not move during it).
import { cfg } from './settings.js';
import { cache } from './state.js';

export const R = 10; // pixels
export const any = () => !!(cfg.snapVertex || cfg.snapEdge || cfg.snapIntersection || cfg.snapFace);
// The target point of the last snap (or null): the views draw a marker there.
export const mark = { at: null };

const add = (a, b) => a.map((x, k) => x + b[k]), sub = (a, b) => a.map((x, k) => x - b[k]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const key = p => p.map(x => Math.round(x * 64)).join();

// The points of nodes that move: their brushes' vertices (each once), point entities' origins.
export function movingOf(nodes) {
  const pts = new Map();
  for (const n of nodes) {
    const c = cache.get(n);
    if (!c) continue;
    if (c.point) { const o = (n.kv.find(p => p[0] === 'origin')?.[1] ?? '').split(/\s+/).map(Number); if (o.length === 3 && o.every(Number.isFinite)) pts.set(key(o), o); }
    else for (const f of c.faces) for (const p of f.pts) pts.set(key(p), p);
  }
  return [...pts.values()];
}

// Vertices and edges (each once) of the visible brushes skip(node) does not exclude. drop: keys (key()) of points that
// move: they are no targets, nor the edges that end at them.
export function geometry(skip, drop = null) {
  const pts = new Map(), edges = new Map();
  for (const c of cache.values()) {
    if (!c.visible || c.point || skip(c.node)) continue;
    for (const f of c.faces) f.pts.forEach((p, i) => {
      const q = f.pts[(i + 1) % f.pts.length], a = key(p), b = key(q);
      if (drop?.has(a)) return;
      pts.set(a, p);
      if (a !== b && !drop?.has(b)) edges.set(a < b ? a + '|' + b : b + '|' + a, [p, q]);
    });
  }
  return { pts: [...pts.values()], edges: [...edges.values()] };
}

// Closest point of segment a-b to the ray o + s d (3D, d need not be unit length).
export function rayToSegment(o, d, a, b) {
  const e = sub(b, a), w = sub(a, o), dd = dot(d, d), de = dot(d, e), ee = dot(e, e), dw = dot(d, w), ew = dot(e, w);
  const den = dd * ee - de * de;
  let u = den > 1e-12 ? (de * dw - dd * ew) / den : 0;
  u = Math.max(0, Math.min(1, u));
  return add(a, e.map(x => x * u));
}

// One drag's snapper. proj(p): the screen point [x, y] of world point p (null when it is not on screen); ray(s):
// { o, d } through screen point s (3D views; 2D views leave it null: the screen is linear there); hit(s): { point, n }
// of the face under s that skip() does not exclude (face snap, 3D only). moving: the points that move.
// own: true when the moving points belong to brushes that stay targets (poly edit): only those points (and the edges
// at them) are left out, and the target is the one nearest the cursor (an axis drag slides the point along its line
// while the cursor goes to the target; the moving point nearest the target goes onto it, along the allowed axes).
// Otherwise (objects) the targets near the moving points pull the nearest one.
// snap(t, allow, cursor) -> { t, at } or null: t the offset putting a moving point on a target, allow(d) the part of
// displacement d the drag may make (its axes), at the target point.
export function snapper({ proj, ray = null, hit = null, moving, skip = () => false, own = false, geo = geometry(skip, own ? new Set(moving.map(key)) : null) }) {
  const cells = new Map(), C = R, cell = s => Math.floor(s[0] / C) + ',' + Math.floor(s[1] / C);
  const put = (s, x) => { const k = cell(s); (cells.get(k) ?? cells.set(k, new Set()).get(k)).add(x); };
  if (cfg.snapVertex) for (const p of geo.pts) { const s = proj(p); if (s) put(s, { p, s }); }
  if (cfg.snapEdge || cfg.snapIntersection) for (const [a, b] of geo.edges) {
    const sa = proj(a), sb = proj(b);
    if (!sa || !sb) continue;
    const n = Math.min(2000, Math.ceil(dist2(sa, sb) / (C / 2)) + 1), x = { a, b, sa, sb };
    for (let i = 0; i <= n; i++) put([sa[0] + ((sb[0] - sa[0]) * i) / n, sa[1] + ((sb[1] - sa[1]) * i) / n], x);
  }
  const near = s => {
    const [i, j] = [Math.floor(s[0] / C), Math.floor(s[1] / C)], out = new Set();
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const x of cells.get(i + di + ',' + (j + dj)) ?? []) out.add(x);
    return out;
  };
  const onEdge = (x, s) => {
    if (ray) { const r = ray(s); return r && rayToSegment(r.o, r.d, x.a, x.b); }
    const e = sub(x.sb, x.sa), l = e[0] * e[0] + e[1] * e[1];
    const u = l > 1e-9 ? Math.max(0, Math.min(1, ((s[0] - x.sa[0]) * e[0] + (s[1] - x.sa[1]) * e[1]) / l)) : 0;
    return add(x.a, sub(x.b, x.a).map(v => v * u));
  };
  // The points where two target edges near screen point s cross on screen, as { at, s } (s: on screen); per cell, as
  // near() depends on the cell only. Parallel and collinear pairs give none, nor do edges seen end-on (2D views: a
  // brush's depth edges; its top and bottom edges overlap there). 2D views: at is the crossing on the first edge (the
  // drag's allow() drops the depth axis). 3D: only edges that nearly meet (closest points under 1 unit apart) count,
  // at the midpoint of their closest points.
  const xs = new Map();
  const crossings = s => {
    const k = cell(s);
    if (xs.has(k)) return xs.get(k);
    const es = [...near(s)].filter(x => x.a), out = [];
    // ponytail: every pair of the edges near s (O(n^2) per cell, once per drag); a sweep if zoomed-out dense views stall
    for (let i = 0; i < es.length; i++) for (let j = i + 1; j < es.length; j++) {
      const x = es[i], y = es[j], e = sub(x.sb, x.sa), f = sub(y.sb, y.sa), g = sub(y.sa, x.sa), den = e[0] * f[1] - e[1] * f[0];
      if (!(Math.abs(den) > 1e-3 * Math.hypot(...e) * Math.hypot(...f))) continue; // parallel, collinear or a point
      const u = (g[0] * f[1] - g[1] * f[0]) / den, w = (g[0] * e[1] - g[1] * e[0]) / den;
      if (!(u > -1e-6 && u < 1 + 1e-6 && w > -1e-6 && w < 1 + 1e-6)) continue; // the lines cross off the segments
      let at = add(x.a, sub(x.b, x.a).map(v => v * u));
      if (ray) {
        const p = rayToSegment(y.a, sub(y.b, y.a), x.a, x.b), q = rayToSegment(x.a, sub(x.b, x.a), y.a, y.b);
        if (Math.hypot(...sub(p, q)) >= 1) continue;
        at = add(p, q).map(v => v / 2);
      }
      out.push({ at, s: [x.sa[0] + e[0] * u, x.sa[1] + e[1] * u] });
    }
    xs.set(k, out);
    return out;
  };
  return (t, allow, cursor) => {
    if (own && cursor && cells.size) {
      let tgt = null;
      for (const x of near(cursor)) {
        if (x.p) { const d = dist2(cursor, x.s); if (d < R && (!tgt || d - R / 2 < tgt.score)) tgt = { at: x.p, score: d - R / 2 }; }
        else if (cfg.snapEdge) { const w = onEdge(x, cursor), sw = w && proj(w), d = sw && dist2(cursor, sw); if (sw && d < R && (!tgt || d < tgt.score)) tgt = { at: w, score: d }; }
      }
      if (cfg.snapIntersection) for (const c of crossings(cursor)) { const d = dist2(cursor, c.s); if (d < R && (!tgt || d - R / 2 < tgt.score)) tgt = { at: c.at, score: d - R / 2 }; }
      if (tgt) {
        const st = proj(tgt.at);
        let p = null, pd = Infinity;
        for (const q of moving) { const s = proj(add(q, t)), d = s && st ? dist2(s, st) : Infinity; if (d < pd) { pd = d; p = q; } }
        if (p) return { t: allow(sub(tgt.at, p)), at: tgt.at };
      }
    }
    let best = null;
    // d: pixels to the target; a vertex or an intersection scores R / 2 better, so it wins over the edges through it
    const offer = (d, score, at, p) => { if (d < R && (!best || score < best.score)) best = { score, t: allow(sub(at, p)), at }; };
    if (cells.size) for (const p of moving) {
      const s = proj(add(p, t));
      if (!s) continue;
      for (const x of near(s)) {
        if (x.p) { const d = dist2(s, x.s); offer(d, d - R / 2, x.p, p); }
        else if (cfg.snapEdge) { const w = onEdge(x, s), sw = w && proj(w), d = sw && dist2(s, sw); if (sw) offer(d, d, w, p); }
      }
      if (cfg.snapIntersection) for (const c of crossings(s)) { const d = dist2(s, c.s); offer(d, d - R / 2, c.at, p); }
    }
    if (best || !cfg.snapFace || !hit || !cursor) return best && { t: best.t, at: best.at };
    // face: the moving point nearest the plane under the cursor goes onto it, along the drag's axes
    const h = hit(cursor);
    if (!h) return null;
    const c = dot(h.n, h.point), a = allow(h.n), na = dot(h.n, a);
    if (Math.abs(na) < 1e-3) return null;
    let p = null, e = Infinity;
    for (const q of moving) { const x = c - dot(h.n, add(q, t)); if (Math.abs(x) < Math.abs(e)) { e = x; p = q; } }
    if (!p) return null;
    const t2 = add(t, a.map(x => (x * e) / na));
    return { t: t2, at: add(p, t2) };
  };
}
