// Blockout primitives. Pure: each builder fills the box [mn, mx] and returns vmf.js solids, one per convex piece.
// Signature: (mn, mx, opts, material, nextId); material is a name or fn(normal) -> name (vmf.js brush). opts.grid keeps
// curved shapes' vertices on the grid where that leaves every piece strictly convex (else whole units, else exact).
import * as V from '../vmf.js';

// Default options per type: the blockout preset editor shows these fields.
export const TYPES = {
  box: {},
  ramp: { dir: 'auto' },
  stairs: { count: 0, step: 16, solid: true, dir: 'auto' },
  cylinder: { sides: 16 },
  arch: { segments: 8, thickness: 16 },
  doorway: { width: 96, height: 128, thickness: 16 },
  room: { thickness: 16 },
};
export const DIRS = ['auto', '+x', '-x', '+y', '-y'];

// Dev textures by face direction (blockout mode). Upper case, as Hammer writes material names.
export const DEV = { floor: 'DEV/DEV_MEASUREGENERIC01B', wall: 'DEV/DEV_MEASUREWALL01A', ceiling: 'DEV/DEV_MEASUREGENERIC01' };
export const devMaterial = n => (n[2] > 0.7 ? DEV.floor : n[2] < -0.7 ? DEV.ceiling : DEV.wall);
export const devMaterials = solid => V.kids(solid, 'side').forEach(s => V.set(s, 'material', devMaterial(V.plane(s).n)));

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, Math.round(+x || lo)));
// Longer horizontal axis (0 | 1) of the box.
const longer = (mn, mx) => (mx[0] - mn[0] >= mx[1] - mn[1] ? 0 : 1);
// '+x' | '-x' | '+y' | '-y' -> [axis, sign]; 'auto': the longer horizontal axis, rising toward +.
const axisDir = (mn, mx, dir) => (DIRS.includes(dir) && dir !== 'auto' ? [dir[1] === 'x' ? 0 : 1, dir[0] === '-' ? -1 : 1] : [longer(mn, mx), 1]);

// Faces of a convex 2D polygon [[u, v], ...] extruded from w = lo to hi. uvw: the 3D axes of u, v and w.
function prism(poly, lo, hi, [a, b, w]) {
  const at = ([u, v], z) => { const p = []; p[a] = u; p[b] = v; p[w] = z; return p; };
  return [poly.map(p => at(p, lo)), poly.map(p => at(p, hi)),
    ...poly.map((p, i) => { const q = poly[(i + 1) % poly.length]; return [at(p, lo), at(q, lo), at(q, hi), at(p, hi)]; })];
}

const turn = (a, b, c) => (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
const strict = poly => { const t = poly.map((p, i) => turn(p, poly[(i + 1) % poly.length], poly[(i + 2) % poly.length])); return t.every(x => x > 1e-6) || t.every(x => x < -1e-6); };
// build(points) -> 2D polygons, for points rounded to the grid, else to whole units, else as they are. Rounding is
// relative to o (the box's 2D min corner): a box that is only grid-sized, not grid-aligned (drawn on an off-grid
// face), keeps its extremes on its own faces.
function rounded(pts, build, grid, o) {
  for (const g of [grid, 1]) {
    const polys = build(pts.map(p => p.map((x, k) => o[k] + Math.round((x - o[k]) / g) * g)));
    if (polys.every(strict)) return polys;
  }
  return build(pts);
}

export const box = (mn, mx, o, mat, nextId) =>
  [V.brush(prism([[mn[0], mn[1]], [mx[0], mn[1]], [mx[0], mx[1]], [mn[0], mx[1]]], mn[2], mx[2], [0, 1, 2]), mat, nextId)];

// Wedge rising from mn[2] to mx[2] along dir.
export function ramp(mn, mx, o = {}, mat, nextId) {
  const [k, s] = axisDir(mn, mx, o.dir), j = 1 - k;
  const tri = [[mn[k], mn[2]], [mx[k], mn[2]], [s > 0 ? mx[k] : mn[k], mx[2]]];
  return [V.brush(prism(tri, mn[j], mx[j], [k, 2, j]), mat, nextId)];
}

// count steps (0: the box height / step) climbing along dir; step height and depth are the box height and length over
// count, rounded to whole units. solid: each step reaches down to mn[2]; otherwise only its own riser height.
export function stairs(mn, mx, o = {}, mat, nextId) {
  const [k, s] = axisDir(mn, mx, o.dir), h = mx[2] - mn[2], run = mx[k] - mn[k];
  const n = clamp(o.count || h / (+o.step || 16), 1, Math.min(h, run));
  const at = i => Math.round((i * run) / n), z = i => mn[2] + Math.round((i * h) / n);
  return Array.from({ length: n }, (_, i) => {
    const lo = [...mn], hi = [...mx];
    [lo[k], hi[k]] = s > 0 ? [mn[k] + at(i), mn[k] + at(i + 1)] : [mx[k] - at(i + 1), mx[k] - at(i)];
    [lo[2], hi[2]] = [o.solid === false ? z(i) : mn[2], z(i + 1)];
    return box(lo, hi, o, mat, nextId)[0];
  });
}

// Upright prism on the ellipse inscribed in the footprint (a circle for a square footprint).
export function cylinder(mn, mx, o = {}, mat, nextId) {
  const n = clamp(o.sides ?? 16, 6, 32), c = [0, 1].map(k => (mn[k] + mx[k]) / 2), r = [0, 1].map(k => (mx[k] - mn[k]) / 2);
  const pts = Array.from({ length: n }, (_, i) => [0, 1].map(k => c[k] + r[k] * (k ? Math.sin : Math.cos)((2 * Math.PI * i) / n)));
  const [poly] = rounded(pts, p => [p], o.grid || 1, mn);
  return [V.brush(prism(poly, mn[2], mx[2], [0, 1, 2]), mat, nextId)];
}

// Half-ellipse arch spanning the longer horizontal axis, apex at mx[2], walls `thickness` thick. [] when too thin.
export function arch(mn, mx, o = {}, mat, nextId) {
  const k = longer(mn, mx), j = 1 - k, n = clamp(o.segments ?? 8, 2, 64), t = +o.thickness || 16;
  const c = (mn[k] + mx[k]) / 2, R = [(mx[k] - mn[k]) / 2, mx[2] - mn[2]];
  if (t >= R[0] || t >= R[1]) return [];
  const arc = (rx, rz) => Array.from({ length: n + 1 }, (_, i) => [c + rx * Math.cos((Math.PI * i) / n), mn[2] + rz * Math.sin((Math.PI * i) / n)]);
  const quads = p => Array.from({ length: n }, (_, i) => [p[i], p[i + 1], p[n + 2 + i], p[n + 1 + i]]);
  return rounded([...arc(...R), ...arc(R[0] - t, R[1] - t)], quads, o.grid || 1, [mn[k], mn[2]]).map(q => V.brush(prism(q, mn[j], mx[j], [k, 2, j]), mat, nextId));
}

// Two posts and a lintel around a width x height opening at the bottom centre of the box (along its longer horizontal
// axis). A width or height of 0 leaves posts or lintel `thickness` thick. [] when the opening does not fit.
export function doorway(mn, mx, o = {}, mat, nextId) {
  const k = longer(mn, mx), t = +o.thickness || 16, g = o.grid || 1, span = mx[k] - mn[k], h = mx[2] - mn[2];
  const w = +o.width || span - 2 * t, oh = +o.height || h - t, a = mn[k] + Math.round((span - w) / 2 / g) * g;
  if (w <= 0 || oh <= 0 || oh >= h || a <= mn[k] || a + w >= mx[k]) return [];
  const part = (k0, k1, z0) => { const lo = [...mn], hi = [...mx]; [lo[k], hi[k], lo[2]] = [k0, k1, z0]; return box(lo, hi, o, mat, nextId)[0]; };
  return [part(mn[k], a, mn[2]), part(a + w, mx[k], mn[2]), part(a, a + w, mn[2] + oh)];
}

// Six walls `thickness` thick on the inside of the box. [] when the box is too small.
export function room(mn, mx, o = {}, mat, nextId) {
  const t = +o.thickness || 16, [x0, y0, z0] = mn, [x1, y1, z1] = mx;
  if ([0, 1, 2].some(k => mx[k] - mn[k] <= 2 * t)) return [];
  return [[[x0, y0, z0], [x1, y1, z0 + t]], [[x0, y0, z1 - t], [x1, y1, z1]],
    [[x0, y0, z0 + t], [x0 + t, y1, z1 - t]], [[x1 - t, y0, z0 + t], [x1, y1, z1 - t]],
    [[x0 + t, y0, z0 + t], [x1 - t, y0 + t, z1 - t]], [[x0 + t, y1 - t, z0 + t], [x1 - t, y1, z1 - t]]].map(([lo, hi]) => box(lo, hi, o, mat, nextId)[0]);
}

const BUILD = { box, ramp, stairs, cylinder, arch, doorway, room };
export const make = (type, mn, mx, o, mat, nextId) => (BUILD[type] ?? box)(mn, mx, o, mat, nextId);
