import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hull, clipHalf, rayHits, convexParts, isConvex, area, simplify, subtractConvex, clipConvex } from '../src/poly2d.js';

test('a cut with a corner listed twice still cuts: nothing of it is left over', () => {
  const sq = [[0, 0], [4, 0], [4, 4], [0, 4]], cut = [[1, 1], [3, 1], [3, 3], [3, 3 + 3e-13], [1, 3]];
  assert.ok(Math.abs(subtractConvex(sq, cut).reduce((s, q) => s + Math.abs(area(q)), 0) - 12) < 1e-6);
  assert.ok(Math.abs(Math.abs(area(clipConvex(sq, cut))) - 4) < 1e-6);
});

test('hull drops inner and collinear points, counter-clockwise', () => {
  const h = hull([[0, 0], [2, 0], [1, 0], [2, 2], [0, 2], [1, 1]]);
  assert.equal(h.length, 4);
  assert.ok(area(h) > 0);
  assert.equal(area(h), 4);
});

test('clipHalf keeps the part where f >= 0', () => {
  const half = clipHalf([[0, 0], [2, 0], [2, 2], [0, 2]], p => p[0] - 1);
  assert.equal(Math.abs(area(half)), 2);
  assert.equal(clipHalf([[0, 0], [1, 0], [0, 1]], p => -1 - p[0]).length, 0);
});

test('rayHits gives entry and exit distances', () => {
  assert.deepEqual(rayHits([-1, 0.5], [1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]), [1, 2]);
  assert.deepEqual(rayHits([-1, 5], [1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]), []);
});

test('convexParts splits an L and keeps a convex polygon whole', () => {
  const L = [[0, 0], [3, 0], [3, 1], [1, 1], [1, 3], [0, 3]];
  const parts = convexParts(L);
  assert.equal(parts.length, 2);
  assert.ok(parts.every(isConvex));
  assert.ok(Math.abs(parts.reduce((s, q) => s + area(q), 0) - 5) < 1e-9);
  const sq = [[0, 0], [0, 2], [2, 2], [2, 0]]; // clockwise in: counter-clockwise out
  const one = convexParts(sq);
  assert.equal(one.length, 1);
  assert.ok(area(one[0]) > 0);
  assert.deepEqual(simplify([[0, 0], [1, 0], [2, 0], [2, 2], [0, 2], [0, 2]]).length, 4);
});

test('convexParts handles a comb (many reflex corners)', () => {
  const comb = [[0, 0], [5, 0], [5, 3], [4, 3], [4, 1], [3, 1], [3, 3], [2, 3], [2, 1], [1, 1], [1, 3], [0, 3]];
  const parts = convexParts(comb);
  assert.ok(parts.length >= 4);
  assert.ok(parts.every(isConvex));
  assert.ok(Math.abs(parts.reduce((s, q) => s + area(q), 0) - Math.abs(area(comb))) < 1e-9);
});

test('partition: the union of pieces cut again into as few convex pieces as it takes, none thin', async () => {
  const { partition, narrowest } = await import('../src/poly2d.js');
  const sum = ps => ps.reduce((s, q) => s + area(q), 0);
  // an L in three triangles: two pieces
  const L = partition([[[0, 0], [300, 0], [300, 100]], [[0, 0], [300, 100], [100, 100]], [[0, 0], [100, 100], [100, 300], [0, 300]]]);
  assert.equal(L.length, 2);
  assert.ok(Math.abs(sum(L) - 50000) < 1e-6 && L.every(q => isConvex(q)));
  // a square less a diamond, as subtractConvex leaves it: a ring of four
  const ring = partition(subtractConvex([[0, 0], [300, 0], [300, 300], [0, 300]], [[150, 80], [220, 150], [150, 220], [80, 150]]));
  assert.equal(ring.length, 4);
  // a half circle bitten out of a side (16 chords): cut along the grid (no cut off the axes, no fan of triangles), none
  // thinner than 8
  const arc = Array.from({ length: 15 }, (_, k) => [300 + 150 * Math.cos((Math.PI * (k + 1)) / 16), 150 * Math.sin((Math.PI * (k + 1)) / 16)]);
  const shape = [[0, 0], [150, 0], ...arc.reverse(), [450, 0], [600, 0], [600, 400], [0, 400]], bite = partition([shape]);
  const drawn = p => Math.abs(Math.hypot(p[0] - 300, p[1]) - 150) < 0.01 || [0, 600].includes(p[0]) || [0, 400].includes(p[1]);
  assert.ok(bite.length <= 16 && bite.every(q => isConvex(q) && narrowest(q) > 8));
  assert.ok(bite.every(q => q.every((a, i) => { const b = q[(i + 1) % q.length]; return Math.abs(a[0] - b[0]) < 1e-6 || Math.abs(a[1] - b[1]) < 1e-6 || (drawn(a) && drawn(b)); })));
  assert.ok(Math.abs(sum(bite) - area(shape)) < 1e-6);
  // an L: cut along the grid at its inner corner, not on the diagonal between its corners
  const L2 = partition([[[0, 0], [400, 0], [400, 100], [100, 100], [100, 300], [0, 300]]]);
  assert.equal(L2.length, 2);
  assert.ok(L2.every(q => q.every((a, i) => { const b = q[(i + 1) % q.length]; return a[0] === b[0] || a[1] === b[1]; })));
  // a jog of 6 in a side, under a wall 16 thick: the side runs straight there, one piece
  const jog = [[0, 0], [200, 0], [200, 100], [206, 100], [206, 300], [0, 300]], wall = [[195, -8], [211, -8], [211, 308], [195, 308]];
  assert.equal(partition([jog]).length, 2);
  const under = partition([jog], { slack: [wall] });
  assert.equal(under.length, 1);
  assert.ok(under[0].every(p => !(p[0] === 206 && p[1] === 100) && !(p[0] === 200 && p[1] === 100)));
  // a sliver a third of a unit wide along a piece goes into it
  const s = partition([[[0, 0], [100, 0], [100, 50], [0, 50]], [[0, 50], [100, 50], [100, 50.3], [0, 50.3]]]);
  assert.equal(s.length, 1);
  assert.equal(partition([[[0, 0], [10, 0], [10, 10], [0, 10]], [[0, 0], [10, 0], [10, 10], [0, 10]]]), null, 'overlapping pieces');
});

test('boxes: the biggest box first, grown into the clipped corners beside it, stopping at walls and doorways', async () => {
  const { boxes } = await import('../src/poly2d.js');
  const sum = ps => ps.reduce((s, q) => s + Math.abs(area(q)), 0);
  const axes = q => q.filter((a, i) => { const b = q[(i + 1) % q.length]; return a[0] !== b[0] && a[1] !== b[1]; }).length;
  // a room with a chamfered corner, given as fan triangles: one piece, the box with its corner clipped
  const room = [[64, 0], [512, 0], [512, 384], [0, 384], [0, 64]];
  const one = boxes([[room[0], room[1], room[2]], [room[0], room[2], room[3]], [room[0], room[3], room[4]]]);
  assert.equal(one.length, 1);
  assert.equal(one[0].length, 5);
  assert.ok(Math.abs(sum(one) - Math.abs(area(room))) < 1e-6);
  // two rooms one above the other, a wall between them at y 384 with a doorway (x 192 to 320) in it, and a floor drawn
  // as one shape: a piece per room, cut at the threshold, not one running through the doorway
  const two = [[[0, 0], [512, 0], [512, 768], [0, 768]]], wall = [[[0, 384], [192, 384]], [[320, 384], [512, 384]]];
  assert.equal(boxes(two).length, 1);
  const rooms = boxes(two, { walls: wall });
  assert.equal(rooms.length, 2);
  assert.ok(rooms.every(q => Math.abs(Math.abs(area(q)) - 512 * 384) < 1e-6));
  // an L with a chamfer at the end of its short arm: the big box over the long arm, the rest a clipped box beside it
  const L = [[[0, 0], [1024, 0], [1024, 256], [256, 256], [256, 448], [192, 512], [0, 512]]];
  const parts = boxes(L);
  assert.equal(parts.length, 2);
  assert.ok(parts.some(q => q.length === 4 && Math.abs(Math.abs(area(q)) - 1024 * 256) < 1e-6));
  assert.ok(parts.every(q => axes(q) <= 1));
  // a block turned 45 degrees stays as it is
  const diamond = [[0, -100], [100, 0], [0, 100], [-100, 0]];
  assert.deepEqual(boxes([diamond]), [diamond]);
});

test('partition: where a piece would wind round twice (a roof block from a real layout) it fails, and the caller keeps its pieces', async () => {
  const { partition } = await import('../src/poly2d.js');
  const out = partition(JSON.parse(readFileSync(new URL('fixtures/towerroof.json', import.meta.url), 'utf8')));
  // (any pieces it gives are simple, the hull covering no more, and none overlaps another)
  for (const q of out ?? []) assert.ok(Math.abs(area(hull(q)) - area(q)) < 0.01 + 1e-3 * area(q));
  for (const [i, a] of (out ?? []).entries()) for (const b of out.slice(i + 1)) assert.ok(Math.abs(area(clipConvex(a, b))) < 0.5);
});
