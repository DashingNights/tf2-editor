// Brush tools geometry (vmf.js): vertex edits, carve, mirror, align, snap to grid.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../vmf.js';

let id = 0;
const next = () => String(++id);
const block = (mn, mx) => V.block(mn, mx, 'DEV/X', next);
const box = s => V.bounds(V.faces(s));
const sub = (a, b) => a.map((x, k) => x - b[k]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
// Volume of a convex solid: a third of the sum over faces of (a face point . area vector).
const volume = s => Math.round(V.faces(s).reduce((v, f) => {
  const a = f.pts.slice(1, -1).reduce((s, p, i) => s.map((x, k) => x + cross(sub(p, f.pts[0]), sub(f.pts[i + 2], f.pts[0]))[k] / 2), [0, 0, 0]);
  return v + f.pts[0].reduce((s, x, k) => s + x * a[k], 0) / 3;
}, 0) * 1000) / 1000;
const key = p => p.join(' ');
// fromPoints input for solid s with the vertices at the given keys moved by d.
const moved = (s, keys, d) => {
  const fs = V.faces(s);
  return V.kids(s, 'side').map(side => fs.find(f => f.side === side)?.pts.map(p => (keys.includes(key(p)) ? p.map((x, k) => x + d[k]) : p)) ?? null);
};

test('fromPoints refuses a single box vertex move (three faces would bend)', () => {
  const b = block([0, 0, 0], [64, 64, 64]), before = V.serialize(b);
  assert.equal(V.fromPoints(b, moved(b, ['64 64 64'], [0, 0, 32])), false);
  assert.equal(V.serialize(b), before);
});

test('fromPoints moves an edge: the side slopes, the box stays valid', () => {
  const b = block([0, 0, 0], [64, 64, 64]), planes = () => V.kids(b, 'side').map(s => V.get(s, 'plane')), was = planes();
  assert.equal(V.fromPoints(b, moved(b, ['64 0 64', '64 64 64'], [-32, 0, 0])), true);
  assert.ok(V.valid(b));
  assert.deepEqual(planes().map((p, i) => p === was[i]), [true, false, true, true, true, true], 'faces still on their plane keep the plane text');
  assert.equal(V.kids(b, 'side').length, 6);
  assert.deepEqual(box(b), [[0, 0, 0], [64, 64, 64]]);
  const top = V.faces(b).find(f => f.n[2] > 0.99);
  assert.deepEqual(V.bounds([top]), [[0, 0, 64], [32, 64, 64]]);
  assert.equal(volume(b), 64 * 64 * 64 - (32 * 64 / 2) * 64);
  for (const s of V.kids(b, 'side')) assert.match(V.get(s, 'plane'), /^(\(-?\d+ -?\d+ -?\d+\) ?){3}$/, 'grid plane points');
});

test('fromPoints merges vertices that land on each other: the top face goes', () => {
  const b = block([0, 0, 0], [64, 64, 64]);
  assert.equal(V.fromPoints(b, moved(b, ['64 0 64', '64 64 64'], [-64, 0, 0])), true);
  assert.ok(V.valid(b));
  assert.equal(V.kids(b, 'side').length, 5, 'a wedge');
  assert.equal(volume(b), 64 ** 3 / 2);
});

test('fromPoints refuses a concave or inside-out result', () => {
  const b = block([0, 0, 0], [64, 64, 64]), before = V.serialize(b);
  assert.equal(V.fromPoints(b, moved(b, ['64 0 64', '64 64 64'], [-128, 0, 0])), false);
  assert.equal(V.serialize(b), before);
});

test('fromPoints moves a tetrahedron apex', () => {
  const p = [[0, 0, 0], [64, 0, 0], [0, 64, 0], [0, 0, 64]];
  const t = V.brush([[p[0], p[1], p[2]], [p[0], p[1], p[3]], [p[0], p[2], p[3]], [p[1], p[2], p[3]]], 'DEV/X', next);
  assert.ok(V.valid(t));
  assert.equal(V.fromPoints(t, moved(t, ['0 0 64'], [16, 16, 64])), true);
  assert.deepEqual(box(t), [[0, 0, 0], [64, 64, 128]]);
});

test('carve: the pieces are the target minus the cutter', () => {
  const target = block([0, 0, 0], [128, 128, 128]);
  const through = block([32, 32, -16], [96, 96, 144]), inside = block([32, 32, 32], [96, 96, 96]);
  for (const [cutter, want] of [[through, 128 ** 3 - 64 * 64 * 128], [inside, 128 ** 3 - 64 ** 3]]) {
    const ps = V.carve(target, cutter, next), c = box(cutter);
    assert.ok(ps.length > 1 && ps.every(V.valid));
    assert.equal(ps.reduce((v, s) => v + volume(s), 0), want);
    for (const s of ps) {
      const [mn, mx] = box(s), mid = mn.map((x, k) => (x + mx[k]) / 2);
      assert.ok(mid.some((x, k) => x <= c[0][k] || x >= c[1][k]), 'piece outside the cutter');
      assert.ok(mn.every((x, k) => x >= 0) && mx.every(x => x <= 128), 'piece inside the target');
    }
  }
  assert.equal(V.carve(target, block([200, 0, 0], [300, 64, 64]), next), null, 'apart');
  assert.equal(V.carve(target, block([128, 0, 0], [300, 64, 64]), next), null, 'touching');
  assert.deepEqual(V.carve(inside, target, next), [], 'swallowed');
});

test('carve: cut faces take the cutter texture', () => {
  const target = block([0, 0, 0], [128, 128, 64]), cutter = block([64, -16, -16], [192, 144, 80]);
  V.kids(cutter, 'side').forEach(s => V.set(s, 'material', 'DEV/CUT'));
  const [piece] = V.carve(target, cutter, next);
  assert.deepEqual(box(piece), [[0, 0, 0], [64, 128, 64]]);
  assert.equal(V.get(V.faces(piece).find(f => f.n[0] > 0.99).side, 'material'), 'DEV/CUT');
});

test('mirror (transform with -1) flips a wedge about its centre', () => {
  const w = block([0, 0, 0], [64, 64, 64]);
  V.fromPoints(w, moved(w, ['64 0 64', '64 64 64'], [-64, 0, 0])); // slope faces +x
  const slope = s => V.faces(s).find(f => Math.abs(f.n[0]) > 0.1 && Math.abs(f.n[2]) > 0.1).n;
  assert.ok(slope(w)[0] > 0);
  V.transform(w, [-1, 1, 1], [64, 0, 0]);
  assert.ok(V.valid(w));
  assert.deepEqual(box(w), [[0, 0, 0], [64, 64, 64]]);
  assert.ok(slope(w)[0] < 0, 'slope faces -x');
});

test('alignTo lines up min, max and centre; point entities by origin', () => {
  const a = block([0, 0, 0], [64, 64, 64]), b = block([96, 32, 0], [128, 64, 32]), e = V.entity('info_target', [200, 8, 8], next);
  V.alignTo([a, b, e], 'min', 0);
  assert.deepEqual([box(a)[0][0], box(b)[0][0], V.get(e, 'origin')], [0, 0, '0 8 8']);
  V.alignTo([a, b], 'max', 2);
  assert.deepEqual(box(b), [[0, 32, 32], [32, 64, 64]]);
  V.alignTo([a, b], 'center', 1);
  assert.deepEqual(box(b), [[0, 16, 32], [32, 48, 64]]);
  assert.deepEqual(box(a), [[0, 0, 0], [64, 64, 64]]);
});

test('snapToGrid moves each object onto the grid and keeps its size (Hammer)', () => {
  const a = block([3, 5, -7], [67, 69, 57]), e = V.entity('info_target', [13, 17, 3], next), w = block([4000, 0, 0], [4080, 64, 80]);
  V.snapToGrid([a, e, w], 16);
  assert.deepEqual(box(a), [[0, 0, 0], [64, 64, 64]], 'moved, size kept');
  assert.equal(V.get(e, 'origin'), '16 16 0');
  V.snapToGrid([w], 64);
  assert.deepEqual(box(w), [[4032, 0, 0], [4112, 64, 80]], 'an 80-unit brush stays 80 units wide on grid 64');
});
