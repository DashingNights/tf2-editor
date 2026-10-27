import test from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../vmf.js';
import { build, across, ROOF } from '../src/roofgeo.js';
import { area, clipConvex } from '../src/poly2d.js';

let id = 0;
const next = () => String(++id);
const box = (mn, mx) => V.block(mn, mx, 'DEV/WALL', next);
// an upright prism over a plan polygon (a slanted wall)
const prism = (poly, z0, z1) => {
  const d = poly.map(p => [p[0], p[1], z0]), u = poly.map(p => [p[0], p[1], z1]);
  return V.brush([d, u, ...poly.map((_, i) => { const j = (i + 1) % poly.length; return [d[i], d[j], u[j], u[i]]; })], 'DEV/WALL', next);
};
const wall = (solid, pick) => { const faces = V.faces(solid); return { faces, face: faces.find(f => pick(f.n)), solid }; };
const north = n => n[1] > 0.9, south = n => n[1] < -0.9, top = n => n[2] > 0.99;
const bounds = r => V.bounds(r.solids.flatMap(V.faces));
const bottoms = r => r.solids.flatMap(s => V.faces(s).filter(f => f.n[2] < -0.1));
const plan = f => Math.abs(area(f.pts));

// The wall's top face is covered by roof bottoms at its own height (no gap), and no roof brush reaches below the
// wall's top over it (no overlap).
function seated(r, w) {
  const t = V.faces(w.solid).find(f => f.n[2] > 0.99), z = t.pts[0][2];
  const flat = bottoms(r).filter(f => f.n[2] < -0.99 && Math.abs(f.pts[0][2] - z) < 0.01);
  assert.ok(Math.abs(flat.reduce((s, f) => s + Math.abs(area(clipConvex(t.pts, f.pts))), 0) - plan(t)) < 0.5, 'wall top covered');
  for (const s of r.solids) {
    const fs = V.faces(s), low = Math.min(...fs.flatMap(f => f.pts.map(p => p[2]))), b = fs.find(f => f.n[2] < -0.1);
    if (Math.abs(area(clipConvex(b.pts, t.pts))) > 0.5) assert.ok(low >= z - 0.01, 'roof stays above the wall');
  }
}

const A = () => wall(box([0, -16, 0], [512, 0, 192]), north);
const B = (z = 192) => wall(box([0, 128, 0], [512, 144, z]), south);

test('parallel walls: one slab over the gap and both wall tops, whichever faces are picked', () => {
  const a = A(), b = B(), r = build(a, b, {}, next);
  assert.equal(r.solids.length, 1);
  assert.ok(r.solids.every(V.valid));
  assert.deepEqual(bounds(r), [[0, -16, 192], [512, 144, 208]]);
  seated(r, a);
  seated(r, b);
  const fs = V.faces(r.solids[0]);
  assert.equal(V.get(fs.find(f => f.n[2] > 0.99).side, 'material'), ROOF);
  assert.ok(fs.filter(f => f.n[2] < 0.5).every(f => V.get(f.side, 'material') === 'DEV/WALL'));
  assert.deepEqual(bounds(build({ ...a, face: a.faces.find(f => top(f.n)) }, { ...b, face: b.faces.find(f => top(f.n)) })), bounds(r));
  assert.deepEqual(bounds(build(b, a)), bounds(r));
  assert.deepEqual(bounds(build(a, b, { tops: false })), [[0, 0, 192], [512, 128, 208]]);
  assert.deepEqual(bounds(build(a, b, { thickness: 32 })), [[0, -16, 192], [512, 144, 224]]);
});

test('offset walls: the overlap, or with extend the longer span (the wall tops as their own brushes)', () => {
  const a = A(), b = wall(box([128, 128, 0], [640, 144, 192]), south);
  const r = build(a, b);
  assert.deepEqual(bounds(r), [[128, -16, 192], [512, 144, 208]]);
  const x = build(a, b, { extend: true }, next);
  assert.equal(x.solids.length, 3);
  assert.ok(x.solids.every(V.valid));
  assert.deepEqual(bounds(x), [[0, -16, 192], [640, 144, 208]]);
  assert.equal(Math.round(bottoms(x).reduce((s, f) => s + plan(f), 0)), 640 * 128 + 2 * 512 * 16);
  seated(x, a);
  seated(x, b);
  assert.match(build(a, wall(box([600, 128, 0], [900, 144, 192]), south)).error, /Extend/);
});

test('offset walls picked by their tops give the roof the inner faces give, in either order, with or without extend', () => {
  const a = A(), b = wall(box([400, 128, 0], [1400, 144, 192]), south), up = w => ({ ...w, face: w.faces.find(f => top(f.n)) });
  for (const extend of [false, true]) {
    const want = bounds(build(a, b, { extend }));
    assert.deepEqual(want, extend ? [[0, -16, 192], [1400, 144, 208]] : [[400, -16, 192], [512, 144, 208]]);
    for (const [p, q] of [[up(a), b], [a, up(b)], [up(a), up(b)], [up(b), up(a)], [b, up(a)]]) assert.deepEqual(bounds(build(p, q, { extend })), want);
  }
});

test('angled walls: either pick order gives the same roof (float noise on an end line merges nothing wrongly)', () => {
  const a = wall(box([-135, -39, 0], [564, 0, 128]), north), b = wall(prism([[-293, 308], [471, 322], [471, 332], [-293, 318]], 0, 128), f => f[1] < -0.9);
  const r = build(a, b, {}, next), s = build(b, a, {}, next), area2 = x => Math.round(bottoms(x).reduce((t, f) => t + plan(f), 0));
  assert.equal(r.solids.length, 1);
  assert.ok(r.solids.every(V.valid));
  assert.equal(area2(r), area2(s));
  assert.deepEqual(bounds(r).map(p => p.map(Math.round)), [[-135, -39, 128], [478, 332, 144]]); // flush with each ending wall's end face
});

test('angled walls: the gap between the inner lines, ends joined, one convex brush with the tops', () => {
  const a = A(), b = wall(prism([[0, 128], [512, 256], [512, 272], [0, 144]], 0, 192), south);
  const r = build(a, b, {}, next);
  assert.equal(r.solids.length, 1);
  assert.ok(r.solids.every(V.valid));
  assert.equal(Math.round(plan(bottoms(r)[0])), (512 * (128 + 256)) / 2 + 2 * 512 * 16);
  seated(r, a);
  seated(r, b);
  // a corner: two walls at right angles, ends apart, give the triangle-ish piece between them
  const c = wall(box([-16, 32, 0], [0, 512, 192]), n => n[0] > 0.9), k = build(wall(box([32, -16, 0], [512, 0, 192]), north), c, { tops: false });
  assert.ok(k.solids.length >= 1 && k.solids.every(V.valid));
  assert.equal(Math.round(bottoms(k).reduce((s, f) => s + plan(f), 0)), (512 * 512) / 2 - (32 * 32) / 2);
});

test('different heights: flush on the lower wall, flat at the higher one closed down, or sloped between them', () => {
  const a = A(), b = B(256);
  const flush = build(a, b);
  assert.deepEqual(bounds(flush), [[0, -16, 192], [512, 128, 208]]); // stops at the higher wall's face
  assert.ok(flush.warnings.some(w => /differ by 64/.test(w)));
  seated(flush, a);
  const flat = build(a, b, { height: 'flat' }, next);
  assert.equal(flat.solids.length, 2);
  assert.deepEqual(bounds(flat), [[0, -16, 192], [512, 144, 272]]);
  seated(flat, a);
  seated(flat, b);
  const lid = build(a, b, { height: 'flat', tops: false });
  assert.deepEqual(lid.solids.map(s => V.bounds(V.faces(s))).sort((p, q) => p[0][1] - q[0][1]), [[[0, -16, 192], [512, 0, 256]], [[0, 0, 256], [512, 128, 272]]]);
  const slope = build(a, b, { height: 'slope' }, next);
  assert.equal(slope.solids.length, 3);
  assert.ok(slope.solids.every(V.valid));
  seated(slope, a);
  seated(slope, b);
  // the sloped piece runs from one wall's top edge to the other's, its top meeting the flat pieces' tops
  const ramp = slope.solids.map(V.faces).find(fs => fs.some(f => f.n[2] < -0.1 && f.n[2] > -0.99));
  const pts = ramp.flatMap(f => f.pts), at = (y, z) => pts.some(p => Math.abs(p[1] - y) < 0.01 && Math.abs(p[2] - z) < 0.01);
  assert.ok(at(0, 192) && at(0, 208) && at(128, 256) && at(128, 272));
  // angled and sloped: the gap is not planar, so it splits into triangles
  const bent = build(a, wall(prism([[0, 128], [512, 256], [512, 272], [0, 144]], 0, 256), south), { height: 'slope' }, next);
  assert.equal(bent.solids.length, 4);
  assert.ok(bent.solids.every(V.valid));
});

test('an outer face picked counts as the wall face toward the other wall; walls with no gap are refused', () => {
  const a = A(), b = B();
  assert.deepEqual(bounds(build({ ...a, face: a.faces.find(f => south(f.n)) }, { ...b, face: b.faces.find(f => north(f.n)) })), bounds(build(a, b)));
  assert.match(build(a, wall(box([0, 0, 0], [512, 16, 192]), south)).error, /face each other/);
});

test('across: the first wall face facing back across the gap, from a side or a top pick', () => {
  const a = A(), b = B(), far = wall(box([0, 400, 0], [512, 416, 192]), south);
  const faces = [...b.faces, ...far.faces];
  const g = across(a, faces);
  assert.ok(g && g.n[1] < -0.99 && g.dist === 128 && b.faces.some(f => f.side === g.side));
  assert.equal(across({ ...a, face: a.faces.find(f => top(f.n)) }, faces).side, g.side);
  assert.equal(across(a, far.faces).dist, 400);
  assert.equal(across(a, []), null);
  // offset along the corridor or short, away from the middle of the first wall: still met
  const off = wall(box([400, 128, 0], [1400, 144, 192]), south), stub = wall(box([16, 128, 0], [80, 144, 192]), south);
  for (const w of [off, stub]) for (const p of [a, { ...a, face: a.faces.find(f => top(f.n)) }]) {
    const h = across(p, w.faces);
    assert.ok(h && h.dist === 128 && h.n[1] < -0.99, 'facing hit');
  }
});

test('walls that close in at an angle: the roof stops level with the shorter wall, no point running on past it', () => {
  // A along y from 0 to 300 (inner face x = 0); B slants in, its inner face from (300, -50) to (120, 420)
  const a = wall(prism([[-16, 0], [0, 0], [0, 300], [-16, 300]], 0, 192), n => n[0] > 0.9);
  const b = wall(prism([[300, -50], [316, -44], [136, 426], [120, 420]], 0, 192), n => n[0] < -0.5);
  const r = build(a, b, { tops: false }, next);
  assert.ok(r.solids.length && r.solids.every(V.valid), JSON.stringify(r));
  const [mn, mx] = bounds(r);
  assert.ok(mx[1] <= 300 + 0.5 && mn[1] >= -0.5, `roof y ${mn[1]}..${mx[1]} stays within A's 0..300`);
});
