// Poly edit geometry (src/polygeo.js): planar faces, convex pieces, extrude / inset / bevel / chamfer / connect, sticky
// moves, refusals, texture lock.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../vmf.js';
import * as P from '../src/polygeo.js';

let id = 100;
const next = () => String(++id);
const box = (mn = [0, 0, 0], mx = [128, 128, 128]) => V.block(mn, mx, 'DEV/A', next);
const vol = s => V.faces(s).reduce((t, f) => { for (let i = 1; i + 1 < f.pts.length; i++) t += V.areaVec([f.pts[0], f.pts[i], f.pts[i + 1]]).reduce((a, x, k) => a + x * f.pts[0][k], 0) / 3; return t; }, 0);
const near = (a, b, msg, eps = 1e-3) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);
const at = (m, p) => m.v.findIndex(q => q.every((x, k) => Math.abs(x - p[k]) < 1e-6));
const faceBy = (m, test) => m.f.findIndex(fc => test(P.normal(m, fc)));
const top = n => n[2] > 0.99;
const build = (m, s, o) => P.build(m, s, { nextId: next, ...o });
const text = ss => V.serialize({ name: '', kv: [], children: ss });

test('meshOf: a box has 8 shared vertices, 6 quads, 12 edges', () => {
  const m = P.meshOf(box());
  assert.equal(m.v.length, 8);
  assert.equal(m.f.length, 6);
  assert.ok(m.f.every(f => f.vs.length === 4));
  assert.equal(P.edgeMap(m).size, 12);
});

test('an unchanged mesh gives back the same brush, side nodes and order included', () => {
  const s = box(), r = build(P.meshOf(s), s);
  assert.equal(r.solids.length, 1);
  assert.equal(V.serialize({ name: '', kv: [], children: [r.solids[0]] }), V.serialize({ name: '', kv: [], children: [s] }));
  assert.ok(V.kids(r.solids[0], 'side').every((x, i) => x === V.kids(s, 'side')[i]));
});

test('planarity: a raised corner splits the bent top into two triangles along the convex fold (one brush)', () => {
  const s = box(), m = P.meshOf(s), c = at(m, [128, 128, 128]);
  const r = build(P.moved(m, (p, i) => (i === c ? [128, 128, 160] : undefined)), s);
  assert.ifError(r.error);
  assert.equal(r.solids.length, 1);
  assert.ok(V.valid(r.solids[0]));
  assert.equal(V.kids(r.solids[0], 'side').length, 7);
  near(vol(r.solids[0]), 128 ** 3 + (128 * 128 * 32) / 3, 'volume');
  assert.ok(V.faces(r.solids[0]).some(f => f.pts.some(p => p[2] === 160)), 'the moved corner is a vertex');
});

test('planarity: a lowered corner also stays one convex brush', () => {
  const s = box(), m = P.meshOf(s), c = at(m, [128, 128, 128]);
  const r = build(P.moved(m, (p, i) => (i === c ? [128, 128, 96] : undefined)), s);
  assert.equal(r.solids.length, 1);
  near(vol(r.solids[0]), 128 ** 3 - (128 * 128 * 32) / 6, 'volume');
});

// A prism over outline o (CCW), 0..64 high; by default an L: (0,0) (128,0) (128,64) (64,64) (64,128) (0,128).
function lMesh(o = [[0, 0], [128, 0], [128, 64], [64, 64], [64, 128], [0, 128]]) {
  const v = [...o.map(p => [...p, 0]), ...o.map(p => [...p, 64])], s = box();
  const side = V.kids(s, 'side')[0], n = o.length;
  const f = [{ vs: o.map((_, i) => n - 1 - i), side }, { vs: o.map((_, i) => n + i), side }];
  for (let i = 0; i < n; i++) f.push({ vs: [i, (i + 1) % n, n + (i + 1) % n, n + i], side });
  return { m: { v, f }, s };
}

test('convex decomposition: an L-shape gives 2 valid convex brushes with the right volume', () => {
  const { m, s } = lMesh(), r = build(m, s);
  assert.ifError(r.error);
  assert.equal(r.solids.length, 2);
  assert.ok(r.solids.every(V.valid));
  near(r.solids.reduce((t, x) => t + vol(x), 0), (128 * 128 - 64 * 64) * 64, 'volume');
  assert.equal(V.get(r.solids[0], 'id'), V.get(s, 'id'), 'the first piece keeps the id');
  assert.notEqual(V.get(r.solids[1], 'id'), V.get(s, 'id'));
});

test('extrude: the whole top face of a box makes it taller (one brush, coplanar walls merged)', () => {
  const s = box(), m = P.meshOf(s), r = build(P.extrude(m, new Set([faceBy(m, top)]), 64), s);
  assert.equal(r.solids.length, 1);
  assert.equal(V.kids(r.solids[0], 'side').length, 6);
  assert.deepEqual(V.bounds(V.faces(r.solids[0])), [[0, 0, 0], [128, 128, 192]]);
});

test('connect + extrude half the top: an L in section, 2 convex pieces', () => {
  const s = box(), m = P.meshOf(s), t = faceBy(m, top), vs = m.f[t].vs;
  // two opposite edges of the top face
  const c = P.connect(m, new Set([P.ek(vs[0], vs[1]), P.ek(vs[2], vs[3])]));
  assert.equal(c.edges.length, 1);
  assert.equal(c.mesh.f.length, 7 + 0, 'top split in two, the sides next to the cut get a point (still 6 + 1 faces)');
  const same = build(c.mesh, s);
  assert.equal(same.solids.length, 1);
  assert.equal(V.serialize({ name: '', kv: [], children: same.solids }), V.serialize({ name: '', kv: [], children: [s] }), 'connect alone leaves the brush as it was');
  const half = c.mesh.f.findIndex(fc => top(P.normal(c.mesh, fc)));
  const r = build(P.extrude(c.mesh, new Set([half]), 64), s);
  assert.ifError(r.error);
  assert.equal(r.solids.length, 2);
  near(r.solids.reduce((a, x) => a + vol(x), 0), 128 ** 3 + 64 * 128 * 64, 'volume');
});

test('inset keeps the shape; extruding the inner face gives a raised platform (2 pieces)', () => {
  const s = box(), m = P.meshOf(s), t = faceBy(m, top), i = P.inset(m, new Set([t]), 16);
  assert.ifError(i.error);
  assert.equal(i.mesh.f.length, 10);
  const same = build(i.mesh, s);
  assert.equal(same.solids.length, 1);
  assert.equal(V.kids(same.solids[0], 'side').length, 6);
  const r = build(P.extrude(i.mesh, new Set(i.faces), 32), s);
  assert.equal(r.solids.length, 2);
  near(r.solids.reduce((a, x) => a + vol(x), 0), 128 ** 3 + 96 * 96 * 32, 'volume');
  assert.ok(P.inset(m, new Set([t]), 64).error, 'an inset past the middle is refused');
});

test('bevel: extrude + shrink the outline gives a frustum on top (one convex brush)', () => {
  const s = box(), m = P.meshOf(s), r = build(P.bevel(m, new Set([faceBy(m, top)]), 32, -16).mesh, s);
  assert.equal(r.solids.length, 1);
  near(vol(r.solids[0]), 128 ** 3 + (32 / 3) * (128 * 128 + 96 * 96 + 128 * 96), 'volume');
});

test('chamfer: an edge set back 16 (one strip, then 3 round)', () => {
  const s = box(), m = P.meshOf(s), e = P.ek(at(m, [0, 0, 128]), at(m, [128, 0, 128]));
  const one = P.chamferEdges(s, m, new Set([e]), 16, 1, next);
  assert.ok(one && V.valid(one));
  assert.equal(V.kids(one, 'side').length, 7);
  near(vol(one), 128 ** 3 - (128 * 16 * 16) / 2, 'volume');
  const round = P.chamferEdges(s, m, new Set([e]), 16, 3, next);
  assert.equal(V.kids(round, 'side').length, 9);
  const v = vol(round);
  assert.ok(v < 128 ** 3 && v > vol(one), 'a round chamfer keeps more than a flat one');
  near(V.bounds(V.faces(round))[1][2], 128, 'top stays');
});

test('chamfer: a corner cut off 16 along each edge', () => {
  const s = box(), m = P.meshOf(s), r = P.chamferVerts(s, m, new Set([at(m, [128, 128, 128])]), 16, next);
  assert.equal(V.kids(r, 'side').length, 7);
  near(vol(r), 128 ** 3 - 16 ** 3 / 6, 'volume');
});

test('sticky: moving the shared face of two neighbouring brushes keeps them touching', () => {
  const a = box([0, 0, 0], [64, 64, 64]), b = box([64, 0, 0], [128, 64, 64]), ma = P.meshOf(a), mb = P.meshOf(b);
  const fa = ma.f.find(fc => P.normal(ma, fc)[0] > 0.99), k = P.faceKey(ma, fa);
  const fb = mb.f.find(fc => P.faceKey(mb, fc) === k);
  assert.ok(fb, 'the coincident face has the same key');
  const move = (m, fc) => { const vs = new Set(fc.vs); return P.moved(m, (p, i) => (vs.has(i) ? [p[0] + 16, p[1], p[2]] : undefined)); };
  const ra = build(move(ma, fa), a), rb = build(move(mb, fb), b);
  assert.deepEqual(V.bounds(V.faces(ra.solids[0])), [[0, 0, 0], [80, 64, 64]]);
  assert.deepEqual(V.bounds(V.faces(rb.solids[0])), [[80, 0, 0], [128, 64, 64]]);
});

test('refused: a corner pulled through the bottom, and a box squashed flat', () => {
  const s = box(), m = P.meshOf(s), c = at(m, [128, 128, 128]);
  assert.match(build(P.moved(m, (p, i) => (i === c ? [128, 128, -64] : undefined)), s).error, /cross|volume|overlap/);
  assert.match(build(P.moved(m, p => (p[2] > 0 ? [p[0], p[1], 0] : undefined)), s).error, /volume/);
});

test('delete face: a chamfer face goes and the neighbours close the brush; a box face cannot', () => {
  const s = box(), m = P.meshOf(s), e = P.ek(at(m, [0, 0, 128]), at(m, [128, 0, 128]));
  const c = P.chamferEdges(s, m, new Set([e]), 16, 1, next), slant = V.faces(c).find(f => Math.abs(f.n[1]) > 0.1 && Math.abs(f.n[2]) > 0.1).side;
  const back = P.withoutSides(c, [slant]);
  assert.deepEqual(V.bounds(V.faces(back)), [[0, 0, 0], [128, 128, 128]]);
  assert.equal(P.withoutSides(s, [V.kids(s, 'side')[0]]), null);
});

test('texture lock: a moved face keeps its texture where it was; a turned one turns its axes', () => {
  const s = box(), m = P.meshOf(s), t = faceBy(m, top), uv = (sl, p) => { const f = V.faces(sl).find(f => f.n[2] > 0.99); return V.uv({ ...f, pts: [p] }, 1, 1)[0]; };
  const up = new Set(m.f[t].vs), r = build(P.moved(m, (p, i) => (up.has(i) ? [p[0] + 8, p[1], p[2]] : undefined)), s).solids[0];
  const a = uv(s, [0, 0, 128]), b = uv(r, [8, 0, 128]);
  near(a[0], b[0], 'u follows'); near(a[1], b[1], 'v follows');
  // the top turned 90 degrees about its centre
  const rot = p => [64 - (p[1] - 64), 64 + (p[0] - 64), p[2]], r2 = build(P.moved(m, (p, i) => (up.has(i) ? rot(p) : undefined)), s).solids[0];
  const c = uv(s, [0, 0, 128]), d = uv(r2, rot([0, 0, 128]));
  near(c[0], d[0], 'u turns'); near(c[1], d[1], 'v turns');
  const off = build(P.moved(m, (p, i) => (up.has(i) ? [p[0] + 8, p[1], p[2]] : undefined)), s, { texLock: false }).solids[0];
  assert.equal(V.get(V.kids(off, 'side').find(x => V.plane(x).n[2] > 0.99), 'uaxis'), V.get(V.kids(s, 'side').find(x => V.plane(x).n[2] > 0.99), 'uaxis'));
});

test('extrude side walls get world-aligned axes; extruding by polygon keeps faces apart', () => {
  const s = box(), m = P.meshOf(s), fs = new Set([faceBy(m, top), faceBy(m, n => n[0] > 0.99)]);
  const g = build(P.extrude(m, fs, 32, 'group'), s), p = build(P.extrude(m, fs, 32, 'poly'), s), l = build(P.extrude(m, fs, 32, 'local'), s);
  for (const r of [g, p, l]) { assert.ifError(r.error); assert.ok(r.solids.every(V.valid)); }
  near(l.solids.reduce((a, x) => a + vol(x), 0), 160 * 128 * 160, 'local normal: both faces move 32 out, one box');
  assert.equal(l.solids.length, 1);
  near(p.solids.reduce((a, x) => a + vol(x), 0), 128 ** 3 + 2 * 128 * 128 * 32, 'by polygon: two slabs');
});

test('remove: an edge between coplanar faces goes; removing a box edge keeps the box', () => {
  const s = box(), m = P.meshOf(s), vs = m.f[faceBy(m, top)].vs, c = P.connect(m, new Set([P.ek(vs[0], vs[1]), P.ek(vs[2], vs[3])]));
  const back = P.removeEdges(c.mesh, new Set([P.ek(...c.edges[0])]));
  assert.equal(back.f.length, 6);
  const r = build(P.removeEdges(m, new Set([P.ek(vs[0], vs[1])])), s);
  assert.deepEqual(V.bounds(V.faces(r.solids[0])), [[0, 0, 0], [128, 128, 128]]);
  assert.equal(r.solids.length, 1);
});

test('ring and loop', () => {
  const s = box(), m = P.meshOf(s), e = P.ek(at(m, [0, 0, 128]), at(m, [128, 0, 128]));
  assert.equal(P.ringOf(m, e).size, 4, 'the four edges along x');
  assert.equal(P.loopOf(m, e).size, 1, 'box corners have three edges: a loop stops');
});

test('texture lock: a face reshaped so no single mapping follows keeps its axes (no stretched texture)', () => {
  const s = box(), m = P.meshOf(s), c = at(m, [128, 128, 128]), r = build(P.moved(m, (p, i) => (i === c ? [160, 128, 128] : undefined)), s).solids[0];
  const topOf = x => V.kids(x, 'side').find(sd => V.plane(sd).n[2] > 0.99);
  assert.equal(V.get(topOf(r), 'uaxis'), V.get(topOf(s), 'uaxis'));
  assert.equal(V.get(topOf(r), 'vaxis'), V.get(topOf(s), 'vaxis'));
});

test('texture lock: faces stretched or sheared by a neighbour moving keep their texel scale; the moved face follows', () => {
  const s = box(), m = P.meshOf(s), fx = m.f[faceBy(m, n => n[0] > 0.99)], out = new Set(fx.vs);
  const r = build(P.moved(m, (p, i) => (out.has(i) ? [p[0] + 64, p[1] + 32, p[2]] : undefined)), s).solids[0];
  const sideOf = (x, k, sg) => V.kids(x, 'side').find(sd => V.plane(sd).n[k] * sg > 0.99);
  for (const k of ['uaxis', 'vaxis']) assert.equal(V.get(sideOf(r, 2, 1), k), V.get(sideOf(s, 2, 1), k), 'top: not stretched');
  assert.notEqual(V.get(sideOf(r, 0, 1), 'uaxis') + V.get(sideOf(r, 0, 1), 'vaxis'), V.get(sideOf(s, 0, 1), 'uaxis') + V.get(sideOf(s, 0, 1), 'vaxis'), 'the moved face shifts its texture');
});

test('fewest pieces: extruding the top of a tapered brush cuts at the seam (2 pieces, not more)', () => {
  const s = box(), m0 = P.meshOf(s), r0 = build(P.moved(m0, p => (p[2] === 128 ? [p[0], p[1] === 0 ? 32 : 96, p[2]] : undefined)), s);
  const t = r0.solids[0], m = r0.mesh, top = faceBy(m, n => n[2] > 0.99);
  const r = build(P.extrude(m, new Set([top]), 64), t);
  assert.ifError(r.error);
  assert.equal(r.solids.length, 2);
  near(r.solids.reduce((a, x) => a + vol(x), 0), vol(t) + 128 * 64 * 64, 'volume');
});

test('planarity: removing a box corner cuts the corner off (every triangulation tried, not just fans: one brush)', () => {
  const s = box(), m = P.meshOf(s), r = build(P.removeVerts(m, new Set([at(m, [0, 0, 0])])), s);
  assert.ifError(r.error);
  assert.equal(r.solids.length, 1);
  near(vol(r.solids[0]), 128 ** 3 - 128 ** 3 / 6, 'volume');
});

test('pieces of a concave edit build again as one shape: moving the corner back gives the box (one brush, first id)', () => {
  const s = box(), m = P.meshOf(s), c = at(m, [128, 0, 128]), r = build(P.moved(m, (p, i) => (i === c ? [64, 64, 32] : undefined)), s);
  assert.ifError(r.error);
  assert.ok(r.solids.length > 1, 'a dent: convex pieces');
  const meshVol = mm => mm.f.reduce((t, fc) => { const ps = fc.vs.map(i => mm.v[i]); for (let i = 1; i + 1 < ps.length; i++) t += V.areaVec([ps[0], ps[i], ps[i + 1]]).reduce((a, x, k) => a + x * ps[0][k], 0) / 3; return t; }, 0);
  near(r.solids.reduce((a, x) => a + vol(x), 0), meshVol(r.mesh), 'the pieces fill the shape');
  const same = build(r.mesh, r.solids);
  assert.equal(same.solids.length, r.solids.length);
  assert.deepEqual(same.solids.map(x => V.get(x, 'id')), r.solids.map(x => V.get(x, 'id')), 'pieces keep their ids');
  const k = at(r.mesh, [64, 64, 32]), back = build(P.moved(r.mesh, (p, i) => (i === k ? [128, 0, 128] : undefined)), r.solids);
  assert.ifError(back.error);
  assert.equal(back.solids.length, 1);
  near(vol(back.solids[0]), 128 ** 3, 'volume');
  assert.equal(V.get(back.solids[0], 'id'), V.get(s, 'id'));
});

test('overlap: an inset face dragged across its ring is refused; a small move keeps the texture of the side', () => {
  const s = box(), m = P.meshOf(s), i = P.inset(m, new Set([faceBy(m, top)]), 8), inner = new Set(i.mesh.f[i.faces[0]].vs);
  const by = dx => build(P.moved(i.mesh, (p, k) => (inner.has(k) ? [p[0] + dx, p[1], p[2]] : undefined)), s);
  assert.match(by(200).error, /overlap/);
  const r = by(4), topOf = x => V.kids(x, 'side').find(sd => V.plane(sd).n[2] > 0.99);
  assert.ifError(r.error);
  assert.equal(V.get(topOf(r.solids[0]), 'uaxis'), V.get(topOf(s), 'uaxis'), 'a sub-face moving in its plane does not shift the whole side');
});

test('chamfer: an amount past the faces stops at their far corners (at most half the box)', () => {
  const s = box(), m = P.meshOf(s), e = P.ek(at(m, [0, 0, 128]), at(m, [128, 0, 128]));
  const c = P.chamferEdges(s, m, new Set([e]), 200, 1, next);
  assert.ok(c && V.valid(c));
  near(vol(c), 128 ** 3 / 2, 'volume');
});

test('displacement: a face moved as a whole keeps it (start position moved along); a reshaped one loses it', () => {
  const s = box(), topSide = V.kids(s, 'side').find(x => V.plane(x).n[2] > 0.99);
  topSide.children.push({ name: 'dispinfo', kv: [['power', '2'], ['startposition', '[0 0 128]']], children: [] });
  const m = P.meshOf(s), up = new Set(m.f[faceBy(m, top)].vs), r = build(P.moved(m, (p, i) => (up.has(i) ? [p[0], p[1], p[2] + 16] : undefined)), s);
  const di = V.kids(r.solids[0], 'side').flatMap(x => V.kids(x, 'dispinfo'));
  assert.equal(di.length, 1);
  assert.equal(V.get(di[0], 'startposition'), '[0 0 144]');
  const c = at(m, [128, 128, 128]), bent = build(P.moved(m, (p, i) => (i === c ? [128, 128, 160] : undefined)), s);
  assert.equal(V.kids(bent.solids[0], 'side').flatMap(x => V.kids(x, 'dispinfo')).length, 0);
});

test('pieces built again from their own mesh come out byte for byte the same (seams keep their sides)', () => {
  const s = box(), m0 = P.meshOf(s), r0 = build(P.moved(m0, p => (p[2] === 128 ? [p[0], p[1] === 0 ? 32 : 96, p[2]] : undefined)), s);
  const m = r0.mesh, r = build(P.extrude(m, new Set([faceBy(m, top)]), 64), r0.solids[0]);
  assert.equal(r.solids.length, 2);
  const again = build(r.mesh, r.solids), text = ss => V.serialize({ name: '', kv: [], children: ss });
  assert.equal(text(again.solids), text(r.solids));
  const i = P.inset(r.mesh, new Set([faceBy(r.mesh, top)]), 8), inset = build(i.mesh, r.solids);
  assert.equal(text(inset.solids), text(r.solids), 'an inset leaves the pieces as they were');
});

test('a dent pulled out through a face opens a notch (faces facing each other may meet); moved on, it closes again', () => {
  const s = box(), m = P.meshOf(s), c = at(m, [128, 0, 128]);
  let r = build(P.moved(m, (p, i) => (i === c ? [64, 64, 32] : undefined)), s);
  for (const [from, to, n, v] of [[[64, 64, 32], [128, 64, 32], 2, 1660245], [[128, 64, 32], [128, 0, 32], 1, 128 ** 3 - 128 * 128 * 16], [[128, 0, 32], [128, 0, 128], 1, 128 ** 3]]) {
    const k = at(r.mesh, from);
    r = build(P.moved(r.mesh, (p, i) => (i === k ? to : undefined)), r.solids);
    assert.ifError(r.error);
    assert.equal(r.solids.length, n, to.join());
    near(r.solids.reduce((a, x) => a + vol(x), 0), v, to.join(), 1e-5);
  }
});

test('a corner moved onto a line of its face and on again: the face that collapsed leaves no gap (dent, back, dent)', () => {
  const s = box();
  let r = { mesh: P.meshOf(s), solids: [s] }, cur = [128, 0, 128];
  for (const to of [[64, 0, 128], [64, 64, 128], [64, 64, 32], [128, 64, 32], [128, 0, 32], [128, 0, 128], [64, 0, 128], [64, 64, 128], [64, 64, 32]]) {
    const k = at(r.mesh, cur);
    r = build(P.moved(r.mesh, (p, i) => (i === k ? to : undefined)), r.solids);
    assert.ifError(r.error);
    cur = to;
  }
  assert.equal(r.solids.length, 3);
  near(r.solids.reduce((a, x) => a + vol(x), 0), 1485483, 'volume', 1e-6);
});

test('connect edges: a ring of four round a box makes a loop (raised: a ridge); two edges at a corner cut it off', () => {
  const s = box(), m = P.meshOf(s), c = P.connect(m, P.ringOf(m, P.ek(at(m, [0, 0, 128]), at(m, [128, 0, 128]))));
  assert.equal(c.edges.length, 4);
  assert.equal(c.mesh.f.length, 10, 'the four faces along x split in two');
  assert.ok(c.edges.flat().every(i => c.mesh.v[i][0] === 64), 'round the middle');
  const r = build(c.mesh, s);
  assert.equal(text(r.solids), text([s]), 'the brush stays as it was');
  const roof = build(P.moved(r.mesh, p => (p[0] === 64 && p[2] === 128 ? [64, p[1], 160] : undefined)), r.solids);
  assert.ifError(roof.error);
  assert.equal(roof.solids.length, 1);
  near(vol(roof.solids[0]), 128 ** 3 + (128 * 128 * 32) / 2, 'volume');
  const vs = m.f[faceBy(m, top)].vs, k = P.connect(m, new Set([P.ek(vs[0], vs[1]), P.ek(vs[1], vs[2])]));
  assert.equal(k.edges.length, 1);
  assert.ok(k.mesh.f.some(fc => fc.vs.length === 3 && fc.vs.includes(vs[1])), 'the corner is a triangle of its own');
});

test('connect vertices: opposite corners split a face in two (lowered: a valley); corners on one edge or on different faces do nothing', () => {
  const s = box(), m = P.meshOf(s), vs = m.f[faceBy(m, top)].vs, c = P.connectVerts(m, new Set([vs[0], vs[2]]));
  assert.deepEqual(c.edges, [[vs[0], vs[2]]]);
  assert.deepEqual(c.mesh.f.filter(fc => top(P.normal(c.mesh, fc))).map(fc => fc.vs.length), [3, 3], 'the top in two triangles');
  const r = build(c.mesh, s);
  assert.equal(text(r.solids), text([s]), 'the brush stays as it was');
  // the new edge's ends lowered: the top folds along it (a valley, 2 pieces), not along the other diagonal (a ridge)
  const ends = new Set([vs[0], vs[2]].map(i => P.key(m.v[i]))), down = (mm, src) => build(P.moved(mm, p => (ends.has(P.key(p)) ? [p[0], p[1], 96] : undefined)), src);
  const valley = down(r.mesh, r.solids);
  assert.equal(valley.solids.length, 2);
  near(valley.solids.reduce((a, x) => a + vol(x), 0), 128 ** 3 - 2 * ((128 * 128) / 2) * (64 / 3), 'volume');
  assert.equal(down(m, s).solids.length, 1, 'without the connect: a ridge');
  assert.equal(P.connectVerts(m, new Set([vs[0], vs[1]])).edges.length, 0, 'corners on one edge');
  assert.equal(P.connectVerts(m, new Set([at(m, [0, 0, 0]), at(m, [128, 128, 128])])).edges.length, 0, 'no face holds both');
});

test('connect vertices: three corners of a pentagon, two of them on one edge, give two new edges', () => {
  const s0 = box(), m0 = P.meshOf(s0), s = P.chamferVerts(s0, m0, new Set([at(m0, [128, 128, 128])]), 16, next), m = P.meshOf(s);
  const [a, b, c] = [[0, 0, 128], [128, 112, 128], [112, 128, 128]].map(p => at(m, p)), r = P.connectVerts(m, new Set([a, b, c]));
  assert.deepEqual(new Set(r.edges.map(e => P.ek(...e))), new Set([P.ek(a, b), P.ek(c, a)]), 'b and c share an edge');
  assert.deepEqual(r.mesh.f.filter(fc => top(P.normal(r.mesh, fc))).map(fc => fc.vs.length), [3, 3, 3]);
  assert.equal(text(build(r.mesh, s).solids), text([s]), 'the brush stays as it was');
});

test('connect vertices: a pair across the notch of a U is skipped (the edge would cross the outline); the other pairs split it', () => {
  const { m, s } = lMesh([[0, 0], [192, 0], [192, 128], [128, 128], [128, 64], [64, 64], [64, 128], [0, 128]]);
  const [a, b, c] = [[0, 0, 64], [192, 128, 64], [128, 64, 64]].map(p => at(m, p));
  assert.equal(P.connectVerts(m, new Set([a, b])).edges.length, 0, 'out of the U and in again');
  const r = P.connectVerts(m, new Set([a, b, c])), after = build(r.mesh, s);
  assert.deepEqual(new Set(r.edges.map(e => P.ek(...e))), new Set([P.ek(b, c), P.ek(c, a)]));
  assert.ifError(after.error);
  near(after.solids.reduce((t, x) => t + vol(x), 0), (192 * 128 - 64 * 64) * 64, 'volume');
});

test('connect vertices: a point an edge connect left on a long slanted edge is in line with its ends (no sliver face)', () => {
  // a + (b - a) / 3 as connect() makes it rounds a little off the line: that part has no area all the same
  const a = [0.1, 0.1, 64], b = [1000.1, 500.1, 64], p = a.map((x, k) => x + (b[k] - x) * (1 / 3));
  const m = { v: [a, p, b, [1000.1, 1012.1, 64], [0.1, 512.1, 64]], f: [{ vs: [0, 1, 2, 3, 4] }] };
  assert.equal(P.connectVerts(m, new Set([0, 2])).edges.length, 0);
  assert.equal(P.connectVerts(m, new Set([1, 3])).edges.length, 1, 'the point to a far corner');
});

test('connect edges: all twelve box edges fan each face round its centre; three segments round a ring run straight across', () => {
  const s = box(), m = P.meshOf(s), all = P.connect(m, new Set(P.edgeMap(m).keys()));
  assert.equal(all.edges.length, 24);
  assert.equal(all.mesh.f.length, 24);
  assert.equal(text(build(all.mesh, s).solids), text([s]), 'the brush stays as it was');
  const r = P.connect(m, P.ringOf(m, P.ek(at(m, [0, 0, 128]), at(m, [128, 0, 128]))), 3), x = i => r.mesh.v[i][0];
  assert.equal(r.edges.length, 12);
  assert.ok(r.edges.every(([i, j]) => x(i) === x(j)), 'each new edge at one x');
  assert.deepEqual([...new Set(r.edges.map(([i]) => x(i)))].sort((i, j) => i - j), [32, 64, 96]);
  assert.equal(text(build(r.mesh, s).solids), text([s]));
});

test('connect vertices from the point an edge connect made: to the corner below and the far corner, then dragged (a dent)', () => {
  const s = box(), m = P.meshOf(s), e = (p, q) => P.ek(at(m, p), at(m, q));
  const r = build(P.connect(m, new Set([e([0, 0, 128], [128, 0, 128]), e([0, 128, 128], [128, 128, 128])])).mesh, s), mm = r.mesh;
  const v = P.connectVerts(mm, new Set([[64, 0, 128], [0, 0, 0], [128, 128, 128]].map(p => at(mm, p))));
  assert.equal(v.edges.length, 2, 'one on the front face, one on the top');
  const again = build(v.mesh, r.solids), k = at(again.mesh, [64, 0, 128]);
  assert.equal(text(again.solids), text([s]), 'the brush stays as it was');
  const dent = build(P.moved(again.mesh, (p, i) => (i === k ? [64, 0, 96] : undefined)), again.solids);
  assert.ifError(dent.error);
  // a pyramid out of the top: apex the moved point, base the half top and the triangle beside it (a trapezoid)
  near(dent.solids.reduce((t, x) => t + vol(x), 0), 128 ** 3 - (((128 + 64) / 2) * 128 * 32) / 3, 'volume');
});
