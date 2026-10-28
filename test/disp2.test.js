// Displacement tools after Hammer's Displacement tab: invert alpha, noise, power, subdivide, tag tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../vmf.js';
import * as D from '../src/dispgeo.js';

let id = 0;
const next = () => String(++id);
const near = (a, b, msg, eps = 1e-6) => a.forEach((x, k) => assert.ok(Math.abs(x - b[k]) < eps, `${msg}: ${a} vs ${b}`));
// A flat displacement of power p on the top of the box mn..mx: [face, grid]. Vertex (i, j) of a box from 0, 0 is at
// x = j * step, y = i * step.
function flat(mn, mx, p) {
  const f = V.faces(V.block(mn, mx, 'DEV/X', next)).find(x => x.n[2] > 0.99);
  return [f, D.create(f.side, f.pts, p)];
}
const at = (g, x, y) => g.flat.findIndex(f => f[0] === x && f[1] === y);

test('invertAlpha flips 0-255', () => {
  const [, g] = flat([0, 0, -16], [64, 64, 0], 2);
  g.alpha[3] = 233.938;
  D.invertAlpha(g);
  assert.equal(g.alpha[0], 255);
  assert.ok(Math.abs(g.alpha[3] - 21.062) < 1e-9);
});

test('noise moves along the normal within min..max, alike on a shared edge', () => {
  const [, a] = flat([0, 0, -16], [64, 64, 0], 2), [, b] = flat([64, 0, -16], [128, 64, 0], 2), P = D.positions(a);
  assert.equal(D.noise(a, 0, 0, 1), false);
  assert.ok(D.noise(a, -4, 6, 7) && D.noise(b, -4, 6, 7));
  const PA = D.positions(a), PB = D.positions(b);
  PA.forEach((p, i) => { near(p.slice(0, 2), P[i].slice(0, 2), 'along z only'); assert.ok(p[2] >= -4 && p[2] <= 6); });
  assert.ok(new Set(PA.map(p => p[2].toFixed(3))).size > 5, 'random');
  for (const y of [0, 16, 32, 48, 64]) near(PA[at(a, 64, y)], PB[at(b, 64, y)], 'seam');
});

test('setPower resamples up and back down', () => {
  const [f, g] = flat([0, 0, -16], [64, 64, 0], 2);
  D.paint(g, [32, 32, 0], 40, 16, 'raise', 'z');
  g.alpha[6] = 200;
  const P = D.positions(g), A = [...g.alpha];
  assert.equal(D.setPower(g, 2), false);
  assert.ok(D.setPower(g, 4));
  assert.equal(g.n, 17);
  assert.equal(g.tags.length, 2 * 16 * 16);
  const Q = D.positions(g);
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
    near(Q[i * 4 * 17 + j * 4], P[i * 5 + j], 'kept vertex');
    assert.ok(Math.abs(g.alpha[i * 4 * 17 + j * 4] - A[i * 5 + j]) < 1e-9);
  }
  near(Q[2], P[0].map((x, k) => (x + P[1][k]) / 2), 'between two old vertices');
  assert.ok(Math.abs(g.alpha[4 * 17 + 6] - 100) < 1e-9);
  D.write(f.side, g);
  const di = V.kids(f.side, 'dispinfo')[0];
  assert.equal(V.get(di, 'power'), '4');
  assert.equal(V.kids(di, 'distances')[0].kv.length, 17);
  assert.equal(V.kids(di, 'triangle_tags')[0].kv.length, 16);
  const back = D.parse(f.side, f.pts);
  assert.ok(D.setPower(back, 2));
  D.positions(back).forEach((p, i) => near(p, P[i], 'down again', 1e-3));
});

test('subdivide smooths across a shared edge and keeps open borders', () => {
  const [, a] = flat([0, 0, -16], [64, 64, 0], 2), [, b] = flat([64, 0, -16], [128, 64, 0], 2);
  assert.equal(D.subdivide([a]), 0, 'a flat displacement stays');
  const i = at(a, 64, 32);
  a.field[i] = [0, 0, 1];
  a.dist[i] = 32; // a bump on a's side of the seam only
  assert.ok(D.subdivide([a, b]) > 0);
  const PA = D.positions(a), PB = D.positions(b);
  for (const y of [0, 16, 32, 48, 64]) near(PA[at(a, 64, y)], PB[at(b, 64, y)], 'sewn');
  assert.ok(PA[i][2] > 0 && PA[i][2] < 32, 'the bump is lower');
  assert.ok(PB[at(b, 80, 32)][2] > 0, 'and spreads over the seam');
  a.flat.forEach((f, k) => { if (f[0] === 0 || f[1] === 0 || f[1] === 64) near(PA[k], f, 'open border'); });
});

test('tag tools flip a triangle through the force bits Hammer writes', () => {
  const [f, g] = flat([0, 0, -16], [64, 64, 0], 2);
  assert.equal(g.tags[3], 9);
  assert.equal(D.tagState(9, 'walkable'), 'on');
  D.toggleTag(g, 3, 'walkable');
  assert.equal(g.tags[3], 9 | 2, 'force bit set, forced value 0: not walkable');
  assert.equal(D.tagState(g.tags[3], 'walkable'), 'forced off');
  D.toggleTag(g, 3, 'buildable');
  assert.equal(g.tags[3], 11 | 16);
  assert.equal(D.tagState(g.tags[3], 'buildable'), 'forced off');
  D.retag(g);
  assert.equal(g.tags[3], 27, 'retag keeps the force bits');
  D.toggleTag(g, 3, 'walkable');
  assert.equal(g.tags[3], 25, 'back to the slope');
  const steep = { tags: [0] };
  D.toggleTag(steep, 0, 'walkable');
  assert.equal(steep.tags[0], 6);
  assert.equal(D.tagState(6, 'walkable'), 'forced on');
  D.write(f.side, g);
  assert.equal(V.get(V.kids(V.kids(f.side, 'dispinfo')[0], 'triangle_tags')[0], 'row0'), '9 9 9 25 9 9 9 9');
});

test('rayTri finds the triangle under a ray in triangle_tags order', () => {
  const [, g] = flat([0, 0, -16], [64, 64, 0], 2);
  // Quad 0 starts at an even vertex: it splits along the diagonal from vertex 0, triangle 0 on the x < y side. Quad 1
  // (odd) splits along the other diagonal, triangle 3 on its far side.
  assert.equal(D.rayTri(g, [3, 6, 50], [0, 0, -1]), 0);
  assert.equal(D.rayTri(g, [6, 3, 50], [0, 0, -1]), 1);
  assert.equal(D.rayTri(g, [20, 6, 50], [0, 0, -1]), 2);
  assert.equal(D.rayTri(g, [28, 12, 50], [0, 0, -1]), 3);
  assert.equal(D.rayTri(g, [3, 6, -50], [0, 0, -1]), -1, 'pointing away');
  assert.equal(D.rayTri(g, [100, 6, 50], [0, 0, -1]), -1, 'off the grid');
});
