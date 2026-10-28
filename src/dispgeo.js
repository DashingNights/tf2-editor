// Displacements (Hammer's dispinfo) as vertex grids: parse, write back byte-compatible, create, destroy, sew, paint.
// Pure: VMF nodes and plain arrays, node-testable.
//
// Layout as in Source's CCoreDispInfo (public/builddisp.cpp), which vbsp and the engine use: the face's 4 corners in
// vbsp's winding order (clockwise seen from the front), rotated so the corner nearest startposition comes first, are
// p0..p3. With n = 2^power + 1, vertex (row i, column j) is index i * n + j: row i starts at p0 + (p1 - p0) * i / (n - 1)
// and runs to the matching point on p3 -> p2. Its position is that flat point + face normal * elevation + offset +
// normal * distance. The VMF holds each per-vertex block as one key per row ("row0" ..), values space-separated.
import * as V from '../vmf.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = a => Math.hypot(a[0], a[1], a[2]);
const lerp = (a, b, t) => a.map((x, k) => x + (b[k] - x) * t);
const unit = a => { const l = len(a); return l > 1e-12 ? mul(a, 1 / l) : a; };
const z0 = v => v.map(x => x + 0); // no -0 in values we compute

// C's printf("%g"), which Hammer writes every displacement number with: 6 significant digits, exponent form below 1e-4
// and from 1e6 on, no trailing zeros.
export function fmt(x) {
  if (!Number.isFinite(x)) return '0';
  if (x === 0) return Object.is(x, -0) ? '-0' : '0';
  const trim = s => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
  const [m, e] = x.toExponential(5).split('e'), X = +e;
  if (X < -4 || X >= 6) return `${trim(m)}e${X < 0 ? '-' : '+'}${String(Math.abs(X)).padStart(2, '0')}`;
  return trim(x.toFixed(5 - X));
}
const vec = v => v.map(fmt).join(' ');

// The face's corners clockwise seen from the front (vmf.js faces() runs counter-clockwise), the one nearest start
// first. null unless the face has 4 corners.
export function corners(facePts, start) {
  const pts = facePts.filter((p, i) => len(sub(p, facePts[(i + 1) % facePts.length])) > 0.01).reverse();
  if (pts.length !== 4) return null;
  let k = 0;
  pts.forEach((p, i) => { if (len(sub(start, p)) < len(sub(start, pts[k]))) k = i; });
  return pts.map((_, i) => pts[(i + k) % 4]);
}

function flatGrid([p0, p1, p2, p3], n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = lerp(p0, p1, i / (n - 1)), b = lerp(p3, p2, i / (n - 1));
    for (let j = 0; j < n; j++) out.push(lerp(a, b, j / (n - 1)));
  }
  return out;
}

// rows x count numbers of block name; missing rows and values read as 0.
function readRows(di, name, rows, count) {
  const b = V.kids(di, name)[0], out = new Array(rows * count).fill(0);
  if (b) for (let r = 0; r < rows; r++) V.nums(V.get(b, 'row' + r)).slice(0, count).forEach((x, i) => { out[r * count + i] = x; });
  return out;
}
const triples = a => Array.from({ length: a.length / 3 }, (_, i) => a.slice(i * 3, i * 3 + 3));
const ALLOWED = () => [['10', '-1 -1 -1 -1 -1 -1 -1 -1 -1 -1']];

// The side's dispinfo as a grid: { power, n, start, corners, normal (face), flags, elevation, subdiv (as written),
// field (normals), dist, offset, offNormal, alpha, tags, allowed (allowed_verts key values), flat }. Per-vertex arrays
// are indexed i * n + j. null without a dispinfo, with a power other than 2-4 or on a face that is not 4-sided.
export function parse(side, facePts) {
  const di = V.kids(side, 'dispinfo')[0], power = di && +V.get(di, 'power');
  if (!(power >= 2 && power <= 4)) return null;
  const start = V.nums(V.get(di, 'startposition')), c = start.length === 3 && corners(facePts, start);
  if (!c) return null;
  const n = (1 << power) + 1, normal = V.plane(side).n, vs = name => triples(readRows(di, name, n, n * 3));
  const g = {
    power, n, start, corners: c, normal, flags: V.get(di, 'flags'), elevation: V.get(di, 'elevation'), subdiv: V.get(di, 'subdiv'),
    field: vs('normals'), dist: readRows(di, 'distances', n, n), offset: vs('offsets'), offNormal: vs('offset_normals'),
    alpha: readRows(di, 'alphas', n, n), tags: readRows(di, 'triangle_tags', n - 1, 2 * (n - 1)),
    allowed: V.kids(di, 'allowed_verts')[0]?.kv.map(p => [...p]) ?? ALLOWED(), flat: flatGrid(c, n),
  };
  if (!V.kids(di, 'offset_normals').length) { g.offNormal = g.flat.map(() => z0(normal)); g.offDefault = true; } // what Hammer creates
  return g;
}

// Writes grid g into the side's dispinfo the way Hammer does (keys in its order, numbers as %g). Keys and blocks the
// dispinfo already has keep their place, so writing an unchanged parse gives back the same bytes.
export function write(side, g) {
  let di = V.kids(side, 'dispinfo')[0];
  if (!di) side.children.push((di = { name: 'dispinfo', kv: [], children: [] }));
  V.set(di, 'power', String(g.power));
  V.set(di, 'startposition', `[${vec(g.start)}]`);
  for (const k of ['flags', 'elevation', 'subdiv']) if (g[k] !== undefined) V.set(di, k, g[k]);
  const rows = (vals, w) => Array.from({ length: vals.length / w }, (_, r) => [`row${r}`, vals.slice(r * w, r * w + w).join(' ')]);
  const n = g.n, blocks = {
    normals: rows(g.field.map(vec), n), distances: rows(g.dist.map(fmt), n), offsets: rows(g.offset.map(vec), n),
    offset_normals: rows(g.offNormal.map(vec), n), alphas: rows(g.alpha.map(fmt), n),
    triangle_tags: rows(g.tags.map(String), 2 * (n - 1)), allowed_verts: g.allowed.map(p => [...p]),
  };
  for (const [name, kv] of Object.entries(blocks)) {
    const b = V.kids(di, name)[0];
    if (b) b.kv = kv;
    else di.children.push({ name, kv, children: [] });
  }
}

// Removes the side's displacement. True when it had one.
export function destroy(side) {
  const k = side.children.length;
  side.children = side.children.filter(c => c.name !== 'dispinfo');
  return side.children.length < k;
}

// Hammer's Create: a flat displacement of power 2-4 on a 4-sided face (replacing one it has), starting at the corner
// nearest the minimum of the face's bounds as Hammer picks it. Returns the grid, or null when the face is not 4-sided.
export function create(side, facePts, power = 3) {
  const lo = [0, 1, 2].map(k => Math.min(...facePts.map(p => p[k]))), c = corners(facePts, lo);
  if (!c) return null;
  const n = (1 << power) + 1, N = n * n, normal = z0(V.plane(side).n), zero = () => [0, 0, 0];
  const g = {
    power, n, start: c[0], corners: c, normal, flags: '0', elevation: '0', subdiv: '0',
    field: Array.from({ length: N }, zero), dist: new Array(N).fill(0), offset: Array.from({ length: N }, zero),
    offNormal: Array.from({ length: N }, () => [...normal]), alpha: new Array(N).fill(0),
    tags: new Array(2 * (n - 1) ** 2).fill(0), allowed: ALLOWED(), flat: flatGrid(c, n),
  };
  retag(g);
  destroy(side);
  write(side, g);
  return g;
}

// Displaced vertex positions [[x, y, z], ...].
export function positions(g) {
  const e = mul(g.normal, +g.elevation || 0);
  return g.flat.map((f, i) => [0, 1, 2].map(k => f[k] + e[k] + g.offset[i][k] + g.field[i][k] * g.dist[i]));
}

// Triangles as vertex index triples in Hammer's order and winding (clockwise seen from the front): a quad whose first
// vertex index is even splits along the diagonal from that vertex, an odd one along the other diagonal.
export function triangles(n) {
  const out = [];
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < n - 1; j++) {
    const a = i * n + j, b = a + n;
    if (a % 2) out.push([a, b, a + 1], [a + 1, b, b + 1]);
    else out.push([a, b, b + 1], [a, b + 1, a + 1]);
  }
  return out;
}
const frontNormal = (P, [a, b, c]) => unit(cross(sub(P[c], P[a]), sub(P[b], P[a])));

// Vertex indices around the edge: row 0, last column, last row back, first column back.
export function border(n) {
  const out = [];
  for (let j = 0; j < n - 1; j++) out.push(j);
  for (let i = 0; i < n - 1; i++) out.push(i * n + n - 1);
  for (let j = n - 1; j > 0; j--) out.push((n - 1) * n + j);
  for (let i = n - 1; i > 0; i--) out.push(i * n);
  return out;
}

// Render data: flat positions and smooth normals (3 per vertex), alphas (0-255), indices counter-clockwise seen from
// the front (three.js), rows = n.
export function mesh(g) {
  const P = positions(g), acc = P.map(() => [0, 0, 0]), indices = [];
  for (const t of triangles(g.n)) {
    const [a, b, c] = t, f = frontNormal(P, t);
    indices.push(a, c, b);
    for (const v of t) acc[v] = add(acc[v], f);
  }
  return { positions: P.flat(), normals: acc.map(a => (len(a) > 1e-9 ? unit(a) : g.normal)).flat(), alphas: [...g.alpha], indices, rows: g.n };
}

// parse + mesh: { grid, positions, normals, alphas, indices, rows }, or null.
export function build(side, facePts) {
  const g = parse(side, facePts);
  return g && { grid: g, ...mesh(g) };
}

// Hammer's walkable (bit 0: triangle normal z >= 0.7) and buildable (bit 3: z >= 0.8) triangle tags from the
// displaced surface. The force bits of Hammer's walkable / buildable override tools stay.
export function retag(g) {
  const P = positions(g);
  triangles(g.n).forEach((t, i) => {
    const z = frontNormal(P, t)[2];
    g.tags[i] = (g.tags[i] & ~9) | (z >= 0.7 ? 1 : 0) | (z >= 0.8 ? 8 : 0);
  });
}

// The grid after its brush was mirrored (vmf.js transform, sgn: the scale's sign per axis, an odd number negative) and
// parsed again from the mirrored corners: the face winding reversed, so vertex (i, j) is the old (j, i), and the
// vectors mirror (offset normals parse filled in from the face are the mirrored face's already). In a transposed quad
// the two triangles swap where the quad's first vertex index is even. allowed_verts (a bit per vertex index, 32 to a
// word) is transposed the same way. Retags.
export function mirror(g, sgn) {
  const n = g.n, m = n - 1, T = a => a.map((_, k) => a[(k % n) * n + Math.floor(k / n)]), M = v => z0(v.map((x, k) => x * sgn[k]));
  Object.assign(g, { field: T(g.field).map(M), offset: T(g.offset).map(M), offNormal: g.offDefault ? g.offNormal : T(g.offNormal).map(M), dist: T(g.dist), alpha: T(g.alpha) });
  const [key, words] = g.allowed[0] ?? [], w = (words ?? '').split(/\s+/).filter(Boolean).map(Number);
  if (w.length) {
    const out = w.map(() => 0);
    for (let v = 0; v < w.length * 32; v++) if ((w[v >> 5] >>> (v & 31)) & 1) { const u = v < n * n ? (v % n) * n + Math.floor(v / n) : v; out[u >> 5] |= 1 << (u & 31); }
    g.allowed = [[key, out.map(x => String(x | 0)).join(' ')], ...g.allowed.slice(1)];
  }
  const tags = [];
  for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) {
    const q = 2 * (j * m + i), sw = (i * n + j) % 2 ? 0 : 1;
    tags.push(g.tags[q + sw], g.tags[q + 1 - sw]);
  }
  g.tags = tags;
  retag(g);
}

// Moves vertex i to p through its normal and distance (offset and elevation stay).
function setPos(g, i, p) {
  const e = +g.elevation || 0, d = [0, 1, 2].map(k => p[k] - g.flat[i][k] - g.normal[k] * e - g.offset[i][k]), l = len(d);
  if (l < 1e-9) return void (g.dist[i] = 0);
  g.field[i] = z0(mul(d, 1 / l));
  g.dist[i] = l;
}

const weight = (p, c, r) => { const t = len(sub(p, c)) / r; return t < 1 ? (1 - t * t) ** 2 : 0; };
const neighbours = (n, i) => {
  const r = Math.floor(i / n), c = i % n;
  return [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]].filter(([a, b]) => a >= 0 && a < n && b >= 0 && b < n).map(([a, b]) => a * n + b);
};
const axisOf = (g, axis) => (axis === 'z' ? [0, 0, 1] : g.normal);

// Hammer's paint geometry, one dab: vertices within radius of center (a smooth falloff to the rim) move along axis
// ('normal': the face normal, or 'z') by strength ('raise', 'lower'), toward strength units off the face ('raiseTo'), or
// toward their neighbours ('smooth'). True when a vertex moved; the triangle tags follow.
export function paint(g, center, radius, strength, mode = 'raise', axis = 'normal') {
  if (mode === 'smooth') return smooth(g, radius, center, axis);
  const P = positions(g), dir = axisOf(g, axis);
  let hit = false;
  P.forEach((p, i) => {
    const w = weight(p, center, radius);
    if (!w) return;
    const s = mode === 'raiseTo' ? (strength - dot(sub(p, g.flat[i]), dir)) * w : (mode === 'lower' ? -strength : strength) * w;
    setPos(g, i, add(p, mul(dir, s)));
    hit = true;
  });
  if (hit) retag(g);
  return hit;
}

// Moves vertices within radius of center along axis toward the average of their grid neighbours (amount at the centre).
export function smooth(g, radius, center, axis = 'normal', amount = 0.5) {
  const P = positions(g), dir = axisOf(g, axis);
  let hit = false;
  P.forEach((p, i) => {
    const w = weight(p, center, radius) * amount;
    if (!w) return;
    const nb = neighbours(g.n, i), avg = mul(nb.reduce((s, j) => add(s, P[j]), [0, 0, 0]), 1 / nb.length);
    setPos(g, i, add(p, mul(dir, dot(sub(avg, p), dir) * w)));
    hit = true;
  });
  if (hit) retag(g);
  return hit;
}

// Hammer's paint alpha, one dab: alphas (0-255) within radius of center rise or fall by strength, move toward strength
// ('raiseTo') or toward their neighbours ('smooth'). True when one changed.
export function paintAlpha(g, center, radius, strength, mode = 'raise') {
  const P = positions(g), a0 = [...g.alpha];
  let hit = false;
  P.forEach((p, i) => {
    const w = weight(p, center, radius);
    if (!w) return;
    const nb = mode === 'smooth' && neighbours(g.n, i), a = a0[i];
    const to = mode === 'smooth' ? a + (nb.reduce((s, j) => s + a0[j], 0) / nb.length - a) * 0.5 : mode === 'raiseTo' ? strength : a + (mode === 'lower' ? -strength : strength);
    g.alpha[i] = Math.min(255, Math.max(0, a + (to - a) * w));
    hit = true;
  });
  return hit;
}

// Edge vertices of g that lie between two consecutive edge vertices of h (a finer edge meeting a coarser one) move
// onto h's displaced edge, as vbsp does. Returns how many moved.
function fit(g, h) {
  const Q = positions(h), eh = border(h.n), m = eh.length;
  let k = 0;
  for (const i of border(g.n)) for (let e = 0; e < m; e++) {
    const u = eh[e], v = eh[(e + 1) % m], A = h.flat[u], AB = sub(h.flat[v], A), t = dot(sub(g.flat[i], A), AB) / dot(AB, AB);
    if (t < 1e-6 || t > 1 - 1e-6 || len(sub(g.flat[i], add(A, mul(AB, t)))) > 0.01) continue;
    setPos(g, i, lerp(Q[u], Q[v], t));
    k++;
  }
  return k;
}

// Hammer's Sew for two displacements: edge vertices whose flat positions coincide (a shared edge or corner) move to
// the average of their displaced positions; edge vertices of a finer edge in between go onto the coarser one.
// Returns the number of vertices moved.
export function sew(a, b) {
  const PA = positions(a), PB = positions(b), eb = border(b.n);
  let k = 0;
  for (const i of border(a.n)) for (const j of eb) {
    if (len(sub(a.flat[i], b.flat[j])) > 0.01) continue;
    const m = mul(add(PA[i], PB[j]), 0.5);
    setPos(a, i, m);
    setPos(b, j, m);
    k += 2;
  }
  if (k) k += fit(a, b) + fit(b, a);
  if (k) { retag(a); retag(b); }
  return k;
}

// Hammer's Invert Alpha: every alpha a becomes 255 - a.
export function invertAlpha(g) {
  g.alpha = g.alpha.map(a => 255 - a);
  return true;
}

// A number in [0, 1) from point p (to 1/8 unit) and seed: the same point always gives the same number.
function hash(p, seed) {
  let h = seed | 0;
  for (const x of p) { h = Math.imul(h ^ Math.round(x * 8), 0x85ebca6b); h ^= h >>> 13; }
  h = Math.imul(h, 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 2 ** 32;
}

// Hammer's Noise: every vertex moves along the face normal by a random distance from min to max. The number comes from
// the vertex's flat position and seed, so displacements on one plane that share an edge stay sewn. False when both are 0.
export function noise(g, min, max, seed) {
  if (!min && !max) return false;
  positions(g).forEach((p, i) => setPos(g, i, add(p, mul(g.normal, min + (max - min) * hash(g.flat[i], seed)))));
  retag(g);
  return true;
}

// Bilinear sample of per-vertex vectors A (an n x n grid) at row u, column v (in vertex steps).
function sample(A, n, u, v) {
  const i = Math.min(n - 2, Math.floor(u)), j = Math.min(n - 2, Math.floor(v)), k = i * n + j;
  return lerp(lerp(A[k], A[k + 1], v - j), lerp(A[k + n], A[k + n + 1], v - j), u - i);
}

// Hammer's power change: the grid resampled to power p (2-4), its displacements (normal * distance), offsets, offset
// normals and alphas interpolated at the new vertices (going down keeps the vertices that stay as they were). The
// triangle tags are computed again (forced ones go with the old triangles) and allowed_verts is the default again.
// False when p is the power it has.
export function setPower(g, p) {
  if (p === g.power || !(p >= 2 && p <= 4)) return false;
  const n = g.n, m = (1 << p) + 1, step = (n - 1) / (m - 1);
  const at = A => Array.from({ length: m * m }, (_, k) => sample(A, n, Math.floor(k / m) * step, (k % m) * step));
  const d = at(g.field.map((f, i) => mul(f, g.dist[i]))), l = d.map(v => (len(v) > 1e-9 ? len(v) : 0));
  Object.assign(g, {
    power: p, n: m, flat: flatGrid(g.corners, m), dist: l, field: d.map((v, i) => z0(l[i] ? mul(v, 1 / l[i]) : [0, 0, 0])),
    offset: at(g.offset).map(z0), offNormal: at(g.offNormal).map(v => z0(unit(v))), alpha: at(g.alpha.map(a => [a])).map(a => a[0]),
    tags: new Array(2 * (m - 1) ** 2).fill(0), allowed: ALLOWED(),
  });
  retag(g);
  return true;
}

// Hammer's Subdivide, simplified to smoothing: the displacements gs as one surface. Vertices at one flat position
// (shared edges and corners) are welded; each pass moves every welded vertex halfway to the average of its grid
// neighbours (all its copies' neighbours). A vertex on a border edge that no other displacement of gs has stays, so open
// borders and seams with displacements left out keep their place. Every copy of a welded vertex takes its position, so
// shared edges come out sewn. Returns how many vertices moved.
// ponytail: Laplacian passes round and shrink a closed box a little each run; Hammer fits a Catmull-Clark limit surface.
export function subdivide(gs, passes = (Math.max(...gs.map(g => g.n)) - 1) / 2) {
  const ids = new Map(), W = [], edges = new Map(), Ps = gs.map(positions), key = p => p.map(x => Math.round(x * 8)).join();
  const id = gs.map((g, gi) => g.flat.map((f, i) => {
    const k = key(f);
    if (!ids.has(k)) { ids.set(k, W.length); W.push({ copies: [], nb: new Set(), p: [0, 0, 0] }); }
    const w = W[ids.get(k)];
    w.copies.push([gi, i]);
    w.p = add(w.p, Ps[gi][i]);
    return ids.get(k);
  }));
  W.forEach(w => { w.p = mul(w.p, 1 / w.copies.length); });
  gs.forEach((g, gi) => {
    const I = id[gi], b = border(g.n);
    I.forEach((a, i) => neighbours(g.n, i).forEach(j => a !== I[j] && W[a].nb.add(I[j])));
    b.forEach((i, k) => { const e = [I[i], I[b[(k + 1) % b.length]]].sort((x, y) => x - y).join(); edges.set(e, (edges.get(e) ?? 0) + 1); });
  });
  for (const [e, c] of edges) if (c < 2) for (const v of e.split(',')) W[v].fixed = true;
  for (let s = 0; s < passes; s++) {
    const next = W.map(w => (w.fixed || !w.nb.size ? w.p : lerp(w.p, mul([...w.nb].reduce((a, v) => add(a, W[v].p), [0, 0, 0]), 1 / w.nb.size), 0.5)));
    W.forEach((w, k) => { w.p = next[k]; });
  }
  let moved = 0;
  for (const w of W) for (const [gi, i] of w.copies) {
    if (len(sub(w.p, Ps[gi][i])) < 1e-6) continue;
    setPos(gs[gi], i, w.p);
    moved++;
  }
  if (moved) gs.forEach(retag);
  return moved;
}

// Triangle tag bits (Source's COREDISPTRI_TAG_*): [computed, force bit, forced value]. Hammer's Walkable and Buildable
// tag tools write the force bit and value; CCoreDispInfo::IsTriWalkable / IsTriBuildable take the forced value when set.
const TAG = { walkable: [1, 2, 4], buildable: [8, 16, 32] };
// Tag t's walkable or buildable state: 'on' or 'off' (computed), 'forced on' or 'forced off'.
export function tagState(t, kind) {
  const [b, f, v] = TAG[kind];
  return t & f ? (t & v ? 'forced on' : 'forced off') : t & b ? 'on' : 'off';
}
// Hammer's tag tools, one click: triangle i's walkable or buildable state flips. A forced triangle goes back to the
// computed state; another is forced to the opposite of it.
export function toggleTag(g, i, kind) {
  const [b, f, v] = TAG[kind], t = g.tags[i];
  g.tags[i] = t & f ? t & ~(f | v) : t | f | (t & b ? 0 : v);
}

// The triangle (index in triangles(n) order, as triangle_tags) that the ray from o along d hits first, or -1.
export function rayTri(g, o, d) {
  const P = positions(g);
  let best = -1, near = Infinity;
  triangles(g.n).forEach(([a, b, c], i) => {
    const e1 = sub(P[b], P[a]), e2 = sub(P[c], P[a]), h = cross(d, e2), det = dot(e1, h);
    if (Math.abs(det) < 1e-12) return;
    const s = sub(o, P[a]), q = cross(s, e1), u = dot(s, h) / det, v = dot(d, q) / det, t = dot(e2, q) / det;
    if (u < -1e-7 || v < -1e-7 || u + v > 1 + 1e-7 || t <= 0 || t >= near) return;
    near = t;
    best = i;
  });
  return best;
}
