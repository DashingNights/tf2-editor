// node --test "test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';

const V = await import('../vmf.js');
const W = await import('../src/weldgeo.js');

let id = 0;
const next = () => String(++id);
const box = (mn, mx) => V.block(mn, mx, 'DEV/X', next);
// Brushes turned 15 degrees about z: slanted planes with decimal corners, as a Figma import writes them.
const turned = (...bs) => { bs.forEach(b => V.rotate(b, [0, 0, 0], 2, 15)); return bs; };
const side = (b, i) => V.kids(b, 'side')[i]; // block(): -x, +x, -y, +y, -z, +z
const planeOf = s => V.plane(s);

test('two walls 0.3 apart face to face end on one exact plane, one reversed; check() finds them before, not after', () => {
  // b sits further along y so that only the x faces pair up (turned walls in one line would pair too)
  const [a, b] = turned(box([0, 0, 0], [64, 64, 64]), box([64.3, 100, 0], [128, 164, 64]));
  const c = W.check([a, b]);
  assert.equal(c.groups.length, 1);
  assert.deepEqual(c.groups[0].sides.map(s => s.side), [side(a, 1), side(b, 0)]);
  const taken = [], r = W.weld([a, b], s => taken.push(s));
  assert.equal(r.moved, 1);
  assert.ok(Math.abs(r.maxMove - 0.3) < 1e-6, `moved ${r.maxMove}`);
  assert.equal(taken.length, 1, 'only the brush that changes is snapshotted');
  const p = planeOf(side(a, 1)), q = planeOf(side(b, 0));
  assert.ok(Math.abs(p.n[0] + q.n[0]) < 1e-12 && Math.abs(p.n[1] + q.n[1]) < 1e-12 && Math.abs(p.d + q.d) < 1e-9, 'the same plane, facing the other way');
  assert.equal(V.get(side(b, 0), 'plane'), V.get(side(a, 1), 'plane').match(/\([^)]*\)/g).reverse().join(' '), 'its points reversed');
  assert.equal(V.faces(b).length, 6);
  assert.deepEqual(W.check([a, b]).groups, []);
  assert.equal(W.weld([a, b]).moved, 0, 'nothing left to weld');
});

test('faces a unit apart, or meeting at a real angle, are left alone', () => {
  const [a, b] = turned(box([0, 0, 0], [64, 64, 64]), box([65, 0, 0], [128, 64, 64]));
  const [c] = turned(box([0, 64.2, 0], [64, 128, 64]));
  V.rotate(c, [0, 64, 0], 2, 1); // 1 degree off the first wall's +y face
  assert.deepEqual(W.check([a, b, c]).groups, []);
  assert.equal(W.weld([a, b, c]).moved, 0);
});

test('a brush that would lose a face keeps its planes', () => {
  // A 0.4 thick sliver beside a wall: both its x faces are within reach of the wall's +x face.
  const [a, t] = turned(box([0, 0, 0], [64, 64, 64]), box([64.2, 0, 0], [64.6, 64, 64]));
  const before = V.kids(t, 'side').map(s => V.get(s, 'plane'));
  const r = W.weld([a, t]);
  assert.equal(r.kept, 1);
  assert.deepEqual(V.kids(t, 'side').map(s => V.get(s, 'plane')), before);
});

test('a side that repeats its brush plane is dropped (vbsp: duplicate plane), the larger one stays', () => {
  const [b] = turned(box([0, 0, 0], [64, 64, 64]));
  const dup = structuredClone(side(b, 3));
  V.set(dup, 'id', next());
  b.children.splice(4, 0, dup);
  assert.equal(W.check([b]).duplicates.length, 1);
  const taken = [], r = W.weld([b], s => taken.push(s));
  assert.equal(r.dropped, 1);
  assert.deepEqual(taken, [b]);
  assert.equal(V.kids(b, 'side').length, 6);
  assert.equal(V.faces(b).length, 6);
  assert.deepEqual(W.check([b]).duplicates, []);
});
