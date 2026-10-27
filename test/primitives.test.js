// node --test "test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../vmf.js';
import * as P from '../src/primitives.js';

let id = 0;
const next = () => String(++id);
const mn = [0, 0, 0], mx = [256, 128, 128], g = 16;
const pts = ss => ss.flatMap(V.faces).flatMap(f => f.pts);
const onGrid = ss => pts(ss).every(p => p.every(x => x % g === 0));

const cases = {
  box: [{}, 1],
  ramp: [{ dir: '-y' }, 1],
  stairs: [{ count: 8, solid: true }, 8],
  cylinder: [{ sides: 8 }, 1],
  arch: [{ segments: 8, thickness: 16 }, 8],
  doorway: [{ width: 96, height: 96, thickness: 16 }, 3],
  room: [{ thickness: 16 }, 6],
};

for (const [type, [o, n]] of Object.entries(cases)) test(`${type}: valid, fills the box, on grid ${g}`, () => {
  const ss = P.make(type, mn, mx, { ...P.TYPES[type], ...o, grid: g }, P.devMaterial, next);
  assert.equal(ss.length, n);
  assert.ok(ss.every(V.valid), 'every piece is a valid convex brush');
  assert.deepEqual(V.bounds(ss.flatMap(V.faces)), [mn, mx]);
  assert.ok(onGrid(ss), 'vertices on the grid');
});

test('cylinder: inscribed ellipse, 6..32 sides, vertices on the grid where it stays convex', () => {
  const [c8] = P.cylinder([0, 0, 0], [128, 128, 64], { sides: 8, grid: g }, 'X', next);
  assert.equal(V.faces(c8).length, 10);
  assert.deepEqual(V.bounds(V.faces(c8)), [[0, 0, 0], [128, 128, 64]]);
  assert.ok(onGrid([c8]));
  for (const sides of [3, 32, 64]) {
    const [c] = P.cylinder([0, 0, 0], [128, 128, 64], { sides, grid: 64 }, 'X', next);
    assert.ok(V.valid(c));
    assert.equal(V.faces(c).length, Math.min(32, Math.max(6, sides)) + 2);
  }
});

test('stairs: count from step height, direction, open back', () => {
  const up = P.stairs([0, 0, 0], [128, 64, 64], { step: 16, dir: '+x' }, 'X', next);
  assert.equal(up.length, 4);
  assert.deepEqual(up.map(s => V.bounds(V.faces(s))), [0, 1, 2, 3].map(i => [[i * 32, 0, 0], [i * 32 + 32, 64, (i + 1) * 16]]));
  const open = P.stairs([0, 0, 0], [128, 64, 64], { count: 4, solid: false, dir: '-x' }, 'X', next);
  assert.deepEqual(open.map(s => V.bounds(V.faces(s))), [0, 1, 2, 3].map(i => [[96 - i * 32, 0, i * 16], [128 - i * 32, 64, (i + 1) * 16]]));
});

test('ramp rises along dir; dev materials by face direction', () => {
  const [r] = P.ramp([0, 0, 0], [128, 64, 64], { dir: '+x' }, P.devMaterial, next);
  const fs = V.faces(r), slope = fs.find(f => f.n[0] < 0 && f.n[2] > 0);
  assert.ok(slope && Math.abs(slope.n[2] - 2 / Math.sqrt(5)) < 1e-9, 'slope faces up and back');
  assert.ok(fs.some(f => f.n[0] > 0.99), 'vertical back at +x');
  for (const f of fs) assert.equal(V.get(f.side, 'material'), f.n[2] > 0.7 ? P.DEV.floor : f.n[2] < -0.7 ? P.DEV.ceiling : P.DEV.wall);
});

test('shapes that do not fit return nothing', () => {
  assert.deepEqual(P.room([0, 0, 0], [32, 32, 32], { thickness: 16 }, 'X', next), []);
  assert.deepEqual(P.doorway([0, 0, 0], [96, 16, 128], { width: 96, height: 112 }, 'X', next), []);
  assert.deepEqual(P.arch([0, 0, 0], [32, 16, 64], { thickness: 16 }, 'X', next), []);
});

test('curved shapes in a box that is grid-sized but not grid-aligned stay in the box', () => {
  const box = (type, lo, hi, o) => V.bounds(P.make(type, lo, hi, { ...P.TYPES[type], ...o, grid: g }, 'X', next).flatMap(V.faces));
  assert.deepEqual(box('arch', [0, 0, 8], [256, 64, 200], { thickness: 32 }), [[0, 0, 8], [256, 64, 200]], 'arch on a floor at z 8');
  assert.deepEqual(box('arch', [0, 0, 4], [256, 64, 132], {}), [[0, 0, 4], [256, 64, 132]]);
  assert.deepEqual(box('cylinder', [8, 0, 0], [72, 64, 64], { sides: 6 }), [[8, 0, 0], [72, 64, 64]], 'cylinder from an off-grid wall');
});
