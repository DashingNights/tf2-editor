import test from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../vmf.js';
import { corner, chamfer, inside } from '../src/chamfergeo.js';

let id = 0;
const next = () => String(++id);
const entry = (node, owner = null) => { const faces = V.faces(node), [min, max] = V.bounds(faces); return { node, faces, owner, min, max }; };
const box = (mn, mx, mat = 'WALL') => entry(V.block(mn, mx, mat, next));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
// divergence theorem over the faces (CCW seen from outside)
const volume = s => V.faces(s).reduce((v, f) => v + f.pts.slice(1, -1).reduce((a, p, i) => a + dot(f.pts[0], cross(p, f.pts[i + 2])), 0) / 6, 0);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const O = { size: 16, segments: 1, material: null };
const vert = (x, y, z0 = 0, z1 = 128) => [[x, y, z0], [x, y, z1], [x, y, (z0 + z1) / 2]];

test('In on a box corner: one valid brush, the corner prism gone, the bevel faces the corner', () => {
  const b = box([0, 0, 0], [64, 64, 128]);
  const c = corner([b], ...vert(0, 0));
  assert.ok(c.convex);
  assert.ok(near(c.angle, 90));
  const r = chamfer([b], [c], O, next, new Map());
  assert.equal(r.error, undefined);
  assert.equal(r.cuts.length, 1);
  const [node, [piece]] = r.cuts[0];
  assert.equal(node, b.node);
  assert.ok(V.valid(piece));
  assert.ok(near(volume(piece), 64 * 64 * 128 - 0.5 * 16 * 16 * 128, 1e-3));
  const bevel = V.faces(piece).find(f => near(f.n[0], -Math.SQRT1_2) && near(f.n[1], -Math.SQRT1_2));
  assert.ok(bevel);
  assert.equal(V.get(bevel.side, 'material'), 'WALL');
  assert.deepEqual(V.bounds([bevel]), [[0, 0, 0], [16, 16, 128]]);
});

test('the bevel continues the picked face texture across the seam (axes turned about it)', () => {
  const b = box([0, 0, 0], [64, 64, 128]);
  const f1 = b.faces.find(f => f.n[1] < -0.99); // y = 0, runs along +x from the corner
  const c = corner([b], [0, 0, 0], [0, 0, 128], [0, 0, 64], f1);
  assert.ok(near(c.e[0][0], 1));
  const [piece] = chamfer([b], [c], O, next, new Map()).cuts[0][1];
  const bevel = V.faces(piece).find(f => near(f.n[0], -Math.SQRT1_2));
  const uv = (side, p) => ['uaxis', 'vaxis'].map(k => { const a = V.nums(V.get(side, k)); return dot(p, a) / a[4] + a[3]; });
  for (const p of [[16, 0, 0], [16, 0, 100]]) uv(f1.side, p).forEach((x, i) => assert.ok(near(x, uv(bevel.side, p)[i], 1e-4)));
});

test('L corner of two brushes: In cuts both where the bevel crosses them, Out fills the inside corner to the lower wall', () => {
  // A along x, B along y butting onto A's back, both 128 high
  const A = box([0, 0, 0], [256, 16, 128]), B = box([0, 16, 0], [16, 256, 128]), all = [A, B];
  const out = corner(all, ...vert(0, 0, 0, 128));
  assert.ok(out.convex);
  assert.deepEqual(out.run, [-64, 64]); // along the line from the picked point
  const r = chamfer(all, [out], { ...O, size: 24 }, next, new Map());
  assert.equal(r.error, undefined);
  const got = new Map(r.cuts.map(([n, [p]]) => [n, p]));
  assert.equal(got.size, 2);
  for (const p of got.values()) assert.ok(V.valid(p));
  assert.ok(near(volume(got.get(A.node)), 256 * 16 * 128 - (288 - 32) * 128, 1e-3));
  assert.ok(near(volume(got.get(B.node)), 16 * 240 * 128 - 32 * 128, 1e-3));
  // 32 would cut right through to the inside corner
  assert.match(chamfer(all, [out], { ...O, size: 32 }, next).error, /cuts through/);

  // B only 96 high: above it A's 16 wide end is the whole second face
  const B2 = box([0, 16, 0], [16, 256, 96]), all2 = [A, B2];
  for (const z of [50, 110]) assert.match(chamfer(all2, [corner(all2, [0, 0, 0], [0, 0, 128], [0, 0, z])], { ...O, size: 24 }, next).error, /runs past/);
  const r16 = chamfer(all2, [corner(all2, ...vert(0, 0, 0, 128))], O, next);
  assert.equal(r16.error, undefined);
  assert.deepEqual(r16.cuts.map(([n]) => n), [A.node]);
  assert.ok(near(volume(r16.cuts[0][1][0]), 256 * 16 * 128 - 128 * 128, 1e-3));

  const inner = corner(all2, ...vert(16, 16, 0, 96));
  assert.equal(inner.convex, false);
  assert.ok(near(inner.angle, 90));
  assert.deepEqual(corner(all2, ...vert(16, 16, 0, 128)).run, [-64, 32]); // the corner stops at B's top
  const w = chamfer(all2, [inner], { ...O, size: 32 }, next);
  assert.equal(w.error, undefined);
  assert.equal(w.adds.length, 1);
  const { solid, owner } = w.adds[0];
  assert.equal(owner, null);
  assert.ok(V.valid(solid));
  assert.ok(near(volume(solid), 0.5 * 32 * 32 * 96, 1e-3));
  assert.deepEqual(V.bounds(V.faces(solid)), [[16, 16, 0], [48, 48, 96]]);
});

test('coincident edges of overlapping brushes are one corner: In cuts both', () => {
  const A = box([0, 0, 0], [256, 16, 128]), B = box([0, 0, 0], [16, 256, 128]), all = [A, B];
  const c = corner(all, ...vert(0, 0));
  assert.ok(c.convex);
  const r = chamfer(all, [c], O, next);
  assert.equal(r.cuts.length, 2);
  for (const [, [p]] of r.cuts) { assert.ok(V.valid(p)); assert.ok(V.faces(p).some(f => near(f.n[0], -Math.SQRT1_2) && near(f.n[1], -Math.SQRT1_2))); }
});

test('segments make a fillet: In and Out pieces stay valid, volumes between the flat cut and the round one', () => {
  const b = box([0, 0, 0], [64, 64, 128]), h = 128, s = 32;
  const c = corner([b], ...vert(0, 0));
  const [piece] = chamfer([b], [c], { ...O, size: s, segments: 4 }, next).cuts[0][1];
  assert.ok(V.valid(piece));
  const removed = 64 * 64 * h - volume(piece);
  assert.ok(removed < 0.5 * s * s * h && removed > (s * s - (Math.PI * s * s) / 4) * h * 0.9, String(removed));
  assert.equal(V.faces(piece).length, 6 + 4);

  const A = box([0, 0, 0], [256, 16, 128]), B = box([0, 16, 0], [16, 256, 128]), all = [A, B];
  const w = chamfer(all, [corner(all, ...vert(16, 16))], { ...O, size: s, segments: 3 }, next);
  assert.equal(w.adds.length, 3);
  const vol = w.adds.reduce((a, x) => (assert.ok(V.valid(x.solid)), a + volume(x.solid)), 0);
  assert.ok(vol < 0.5 * s * s * h && vol > (s * s - (Math.PI * s * s) / 4) * h, String(vol));
});

test('horizontal edges work too: In bevels the top edge of a wall along its length', () => {
  const b = box([0, 0, 0], [256, 16, 128]);
  const c = corner([b], [0, 0, 128], [256, 0, 128], [100, 0, 128]);
  assert.ok(c.convex);
  const [piece] = chamfer([b], [c], { ...O, size: 8 }, next).cuts[0][1];
  assert.ok(near(volume(piece), 256 * 16 * 128 - 0.5 * 8 * 8 * 256, 1e-3));
});

test('refusals: size past a face, flat faces, displacements', () => {
  const b = box([0, 0, 0], [64, 64, 128]);
  const c = corner([b], ...vert(0, 0));
  assert.match(chamfer([b], [c], { ...O, size: 80 }, next).error, /runs past/);
  // two boxes side by side: the edge between them on the top is flat
  const L = box([0, 0, 0], [64, 64, 64]), R = box([64, 0, 0], [128, 64, 64]);
  assert.match(corner([L, R], [64, 0, 64], [64, 64, 64], [64, 32, 64]).error, /flat/);
  const d = box([0, 0, 0], [64, 64, 128]);
  V.kids(d.node, 'side').forEach(s => s.children.push({ name: 'dispinfo', kv: [], children: [] }));
  assert.match(chamfer([d], [corner([d], ...vert(0, 0))], O, next).error, /displacement/);
});

test('Out puts the wedge in the func_detail of the walls when both are func_detail', () => {
  const e = { name: 'entity', kv: [['id', '1'], ['classname', 'func_detail']], children: [] };
  const A = box([0, 0, 0], [256, 16, 128]), B = box([0, 16, 0], [16, 256, 128]);
  e.children.push(A.node, B.node);
  const all = [{ ...A, owner: e }, { ...B, owner: e }];
  assert.equal(chamfer(all, [corner(all, ...vert(16, 16))], O, next).adds[0].owner, e);
});

// What is left solid at the points after the cut.
const solidAfter = (r, all, pts) => {
  const cut = new Set(r.cuts.map(([n]) => n)), after = [...all.filter(x => !cut.has(x.node)), ...r.cuts.flatMap(([, ps]) => ps.map(p => entry(p)))];
  return pts.filter(q => inside(after, q));
};

test('a fillet or bevel that would open the corner through to the other side is refused', () => {
  // L of two 16 thick walls: a 64 fillet's middle point passes the inside corner (16, 16)
  const A = box([0, 0, 0], [256, 16, 128]), B = box([0, 16, 0], [16, 256, 128]), all = [A, B];
  const c = corner(all, ...vert(0, 0));
  for (const s of [64, 60]) assert.match(chamfer(all, [c], { ...O, size: s, segments: 4 }, next).error, /cuts through/);
  const diag = Array.from({ length: 49 }, (_, i) => [i / 2, i / 2, 64]);
  for (const s of [32, 48]) {
    const r = chamfer(all, [c], { ...O, size: s, segments: 4 }, next);
    assert.equal(r.error, undefined);
    assert.ok(solidAfter(r, all, diag).length > 0, `size ${s} leaves the corner closed`);
  }
  // a 4 thick wall meeting a 32 thick one: a flat 40 bevel would open the thin wall at x 32..36
  const T = box([0, 0, 0], [256, 4, 128]), U = box([0, 4, 0], [32, 256, 128]), tu = [T, U];
  assert.match(chamfer(tu, [corner(tu, ...vert(0, 0))], { ...O, size: 40 }, next).error, /cuts through/);
  assert.equal(chamfer(tu, [corner(tu, ...vert(0, 0))], { ...O, size: 4 }, next).error, undefined);
});

test('In stays on the stretch where the corner is: a floor level with a ledge past its end is not grooved', () => {
  // ledge A; past its end the floor is F1 (crossing the edge line) and F2 (behind the ledge front), tops level with A
  const A = box([0, 0, 0], [128, 64, 64]), F1 = box([128, -128, 0], [512, 8, 64]), F2 = box([128, 8, 0], [512, 256, 64]), all = [A, F1, F2];
  const c = corner(all, [0, 0, 64], [128, 0, 64], [64, 0, 64]);
  assert.ok(c.convex);
  assert.deepEqual(c.run, [-64, 64]);
  const r = chamfer(all, [c], { ...O, size: 16 }, next);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.cuts.map(([n]) => n), [A.node]);
  assert.ok(near(volume(r.cuts[0][1][0]), 128 * 64 * 64 - 0.5 * 16 * 16 * 128, 1e-3));
});

test('a brush running on past the corner is split there: a pillar through a floor keeps its part below the floor', () => {
  const P = box([0, 0, -64], [64, 64, 256]), F = box([-256, -256, -64], [0, 256, 0], 'FLOOR'), G = box([0, -256, -64], [256, 0, 0], 'FLOOR'), all = [P, F, G];
  const c = corner(all, [0, 0, -64], [0, 0, 256], [0, 0, 100]);
  assert.ok(c.convex);
  assert.deepEqual(c.run, [-100, 156]); // from the floor top up
  const r = chamfer(all, [c], O, next, new Map());
  assert.equal(r.error, undefined);
  assert.deepEqual(r.cuts.map(([n]) => n), [P.node]);
  const ps = r.cuts[0][1];
  assert.equal(ps.length, 2);
  ps.forEach(p => assert.ok(V.valid(p)));
  const [below, above] = [...ps].sort((a, b) => V.bounds(V.faces(a))[0][2] - V.bounds(V.faces(b))[0][2]);
  assert.deepEqual(V.bounds(V.faces(below)), [[0, 0, -64], [64, 64, 0]]);
  assert.ok(near(volume(below), 64 * 64 * 64, 1e-3));
  assert.ok(near(volume(above), 64 * 64 * 256 - 0.5 * 16 * 16 * 256, 1e-3));
  // where the corner was cut away the part below shows its top: it takes the floor's material
  assert.equal(V.get(V.faces(below).find(f => f.n[2] > 0.99).side, 'material'), 'FLOOR');
  assert.equal(solidAfter(r, all, [[2, 2, -32]]).length, 1);
});
