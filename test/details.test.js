// node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false } };
const D = await import('../src/details.js');

test('calc and parseVal: maths, relative values, garbage', () => {
  assert.equal(D.calc('128*3'), 384);
  assert.equal(D.calc('(1 + 2) * -4 / 2'), -6);
  assert.ok(Number.isNaN(D.calc('2 +')));
  assert.ok(Number.isNaN(D.calc('alert(1)')));
  assert.equal(D.parseVal('=128*3')(5), 384);
  assert.equal(D.parseVal('+64')(10), 74);
  assert.equal(D.parseVal('-64')(10), -64, 'a leading minus is an absolute value');
  assert.equal(D.parseVal('*2')(10), 20);
  assert.equal(D.parseVal(' 12.5 ')(0), 12.5);
  assert.equal(D.parseVal(''), null);
  assert.equal(D.parseVal('abc'), null);
});

test('resizeXf keeps the anchor fixed', () => {
  const mn = [0, 0, 0], mx = [64, 64, 64], at = ({ s, t }, p) => p.map((x, k) => x * s[k] + t[k]);
  const c = D.resizeXf(mn, mx, [128, 64, 64], 'center');
  assert.deepEqual([at(c, mn), at(c, mx)], [[-32, 0, 0], [96, 64, 64]]);
  const m = D.resizeXf(mn, mx, [64, 64, 32], 'min');
  assert.deepEqual([at(m, mn), at(m, mx)], [[0, 0, 0], [64, 64, 32]]);
  const b = D.resizeXf(mn, mx, [32, 32, 128], 'bottom');
  assert.deepEqual([at(b, mn), at(b, mx)], [[16, 16, 0], [48, 48, 128]]);
});

test('connections: parse and join round trip', () => {
  const c = D.parseConn(['OnTrigger', 'door,SetSpeed,a,b,1.5,1']);
  assert.deepEqual([c.target, c.input, c.param, c.delay, c.times], ['door', 'SetSpeed', 'a,b', '1.5', '1']);
  assert.equal(D.joinConn(c), 'door,SetSpeed,a,b,1.5,1');
  const e = D.parseConn(['OnTrigger', 'x\x1bKill\x1b\x1b0\x1b-1']);
  assert.equal(e.input, 'Kill');
  assert.equal(D.joinConn(e), 'x\x1bKill\x1b\x1b0\x1b-1');
});

test('fitAxis: fit spans the face once, left/center shift', () => {
  const pts = [[0, 0, 0], [256, 0, 0], [256, 0, 64], [0, 0, 64]];
  const a = { v: [1, 0, 0], shift: 7, scale: 0.25 };
  D.fitAxis(a, pts, 512, 'fit', 'left', 'right');
  assert.equal(a.scale, 0.5);
  assert.equal(a.shift, 0);
  const b = { v: [1, 0, 0], shift: 7, scale: 0.25 };
  D.fitAxis(b, pts.map(p => [p[0] + 32, 0, 0]), 512, 'left', 'left', 'right');
  assert.equal(b.shift, 512 - 128);
  D.fitAxis(b, pts, 512, 'top', 'left', 'right');
  assert.equal(b.shift, 512 - 128, 'top does not touch U');
  const c = { v: [1, 0, 0], shift: 0, scale: 1 };
  D.fitAxis(c, pts, 512, 'center', 'left', 'right');
  assert.equal(c.shift, 128);
});

test('justifyFaces: the faces of one group fit as one surface; apart, each face fits by itself', async () => {
  const V = await import('../vmf.js');
  let id = 0;
  const next = () => String(++id);
  const boxes = () => [V.block([0, 0, 0], [256, 64, 128], 'DEV/A', next), V.block([256, 0, 0], [512, 64, 128], 'DEV/A', next)];
  // the faces looking along -y (the front of two boxes side by side), as details.js hands them over
  const fronts = list => list.flatMap(s => V.faces(s).filter(f => f.n[1] < -0.99).map(f => ({ side: f.side, pts: f.pts, n: f.n, solid: s })));
  const ax = (f, k) => { const a = V.nums(V.get(f.side, k)); return { shift: a[3], scale: a[4] }; };
  const size = () => ({ w: 512, h: 512 });
  // as one group: one fit over both fronts, 512 wide, the same scale and shift on both
  const g = fronts(boxes());
  D.justifyFaces(g, 'fit', size, () => 'group');
  assert.deepEqual(g.map(f => ax(f, 'uaxis')), [{ shift: 0, scale: 1 }, { shift: 0, scale: 1 }]);
  assert.deepEqual(g.map(f => ax(f, 'vaxis').scale), [0.25, 0.25]);
  // apart: each front fits by itself, 256 wide
  const a = fronts(boxes());
  D.justifyFaces(a, 'fit', size);
  assert.deepEqual(a.map(f => ax(f, 'uaxis').scale), [0.5, 0.5]);
  // as one group, left: the left edge of the pair at the texture's left edge, on both faces the same shift
  const l = fronts(boxes());
  D.justifyFaces(l, 'left', size, () => 'group');
  assert.equal(new Set(l.map(f => ax(f, 'uaxis').shift)).size, 1);
  // faces facing another way, or with another material, are another set
  const m = fronts(boxes());
  V.set(m[1].side, 'material', 'DEV/B');
  D.justifyFaces(m, 'fit', size, () => 'group');
  assert.deepEqual(m.map(f => ax(f, 'uaxis').scale), [0.5, 0.5]);
});
