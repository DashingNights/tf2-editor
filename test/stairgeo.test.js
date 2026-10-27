import test from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../vmf.js';
import { build, risers } from '../src/stairgeo.js';
import { area } from '../src/poly2d.js';

let id = 0;
const next = () => String(++id);
const box = (x0, y0, x1, y1, z0 = 0, z1 = 256) => ({ poly: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], z0, z1 });
const bounds = s => V.bounds(V.faces(s));
const floorArea = s => Math.abs(area(V.faces(s).find(f => f.n[2] < -0.99).pts));
const lower = [[0, 0, 0], [128, 0, 0]], upper = [[0, 128, 64], [128, 128, 64]];

test('risers are whole units adding up to the rise, taller ones first', () => {
  const hs = risers(100, 7);
  assert.equal(hs.reduce((a, b) => a + b), 100);
  assert.deepEqual(hs, [15, 15, 14, 14, 14, 14, 14]);
});

test('parallel edges give straight stairs: N risers of at most 16, the upper edge is the last riser', () => {
  const r = build(lower, upper, { fit: false, depth: 64 }, [], 'DEV/X', next);
  assert.equal(r.kind, 'straight');
  assert.equal(r.solids.length, 3);
  const bs = r.solids.map(bounds).sort((a, b) => a[0][1] - b[0][1]);
  assert.deepEqual(bs.map(b => [b[0][1], b[1][1], b[0][2], b[1][2]]), [[0, 43, 0, 16], [43, 85, 0, 32], [85, 128, 0, 48]]);
  assert.ok(bs.every(b => b[0][0] === 0 && b[1][0] === 128));
  const swapped = build(upper, lower, { fit: false, depth: 64 }, [], 'DEV/X', next);
  assert.deepEqual(swapped.solids.map(bounds).sort((a, b) => a[0][1] - b[0][1]), bs);
});

test('fit grows the stairs sideways to the nearest walls, cuts them back to walls inside the edges, keeps out of reach', () => {
  const grow = build(lower, upper, {}, [box(-80, -100, -64, 228), box(192, -100, 208, 228)], 'DEV/X', next);
  assert.ok(grow.solids.every(s => bounds(s)[0][0] === -64 && bounds(s)[1][0] === 192));
  const long = [[[0, 0, 0], [512, 0, 0]], [[0, 128, 64], [512, 128, 64]]];
  const cut = build(...long, {}, [box(96, -100, 112, 228), box(400, -100, 416, 228)], 'DEV/X', next);
  assert.ok(cut.solids.every(s => bounds(s)[0][0] === 112 && bounds(s)[1][0] === 400));
  const far = build(lower, upper, {}, [box(2000, -100, 2016, 228)], 'DEV/X', next);
  assert.ok(far.solids.every(s => bounds(s)[1][0] === 128));
  const pillar = build(lower, upper, {}, [box(48, 40, 80, 60)], 'DEV/X', next);
  assert.ok(pillar.warnings.some(w => /middle/.test(w)));
  const low = build(lower, upper, {}, [box(-80, -100, -64, 228, -64, 0)], 'DEV/X', next); // below the stairs: ignored
  assert.ok(low.solids.every(s => bounds(s)[0][0] === 0));
});

test('equal edges offset along each other (a slanted corridor): parallelogram treads join their ends, fitted along the walls', () => {
  const b = [[0, 0, 0], [128, 0, 0]], t = [[64, 128, 64], [192, 128, 64]];
  const xs = (r, y) => { const v = r.solids.flatMap(s => V.faces(s).flatMap(f => f.pts)).filter(p => Math.abs(p[1] - y) < 0.01).map(p => p[0]); return [Math.min(...v), Math.max(...v)]; };
  const r = build(b, t, { fit: false, depth: 64 }, [], 'DEV/X', next);
  assert.deepEqual(xs(r, 0), [0, 128]);
  assert.deepEqual(xs(r, 128), [64, 192]);
  assert.equal(Math.round(r.solids.reduce((a, s) => a + floorArea(s), 0)), 128 * 128); // the whole parallelogram
  const wall = (x0, x1) => ({ poly: [[x0, 0], [x1, 0], [x1 + 64, 128], [x0 + 64, 128]], z0: 0, z1: 256 });
  const fitted = build(b, t, {}, [wall(-48, -32), wall(160, 176)], 'DEV/X', next);
  assert.deepEqual(xs(fitted, 0), [-32, 160]); // grown along the slanted walls to their faces
  assert.deepEqual(xs(fitted, 128), [32, 224]);
});

test('edges at an angle the same distance from where their lines cross give a circular stair round that point', () => {
  const r = build([[0, 0, 0], [128, 0, 0]], [[0, 0, 96], [0, 128, 96]], { fit: false }, [], 'DEV/X', next);
  assert.equal(r.kind, 'curved');
  assert.equal(r.solids.length, 5); // 6 risers of 16, 5 treads of 18 degrees
  const tops = r.solids.map(s => bounds(s)[1][2]).sort((a, b) => a - b);
  assert.deepEqual(tops, [16, 32, 48, 64, 80]);
  for (const s of r.solids) for (const f of V.faces(s)) for (const p of f.pts) {
    assert.ok(p[0] >= -1e-6 && p[1] >= -1e-6 && Math.hypot(p[0], p[1]) <= 128 + 1e-3);
  }
  for (const s of r.solids) assert.ok(Math.abs(floorArea(s) - (Math.PI * 128 * 128) / 20) < 5); // equal wedges
  const long = build([[0, 0, 0], [128, 0, 0]], [[0, 0, 96], [0, 128, 96]], { fit: false, longWay: true }, [], 'DEV/X', next);
  const pts = long.solids.flatMap(s => V.faces(s).flatMap(f => f.pts));
  assert.ok(pts.some(p => p[0] < -64) && pts.some(p => p[1] < -64)); // 270 degrees: round the other side
});

test('a fitted curved stair fills a square stairwell up to its walls, corner included', () => {
  const walls = [box(128, -16, 144, 144), box(-16, 128, 144, 144)];
  const r = build([[0, 0, 0], [64, 0, 0]], [[0, 0, 96], [0, 64, 96]], {}, walls, 'DEV/X', next);
  const total = r.solids.reduce((a, s) => a + floorArea(s), 0);
  assert.ok(Math.abs(total - 128 * 128) < 5, `area ${total}`);
  assert.ok(r.solids.every(s => bounds(s)[1][0] <= 128 + 1e-3 && bounds(s)[1][1] <= 128 + 1e-3));
});

test('bad picks are refused with a reason', () => {
  assert.match(build(lower, [[0, 128, 0], [128, 128, 0]]).error, /same height/);
  assert.match(build(lower, [[0, 0, 64], [0, 0, 128]]).error, /horizontal/);
  assert.match(build([[-64, 0, 0], [64, 0, 0]], [[0, -64, 64], [0, 64, 64]]).error, /cross inside/);
  assert.match(build(lower, [[256, 0, 64], [384, 0, 64]]).error, /one line/);
});

test('ramps: one wedge when straight, triangles following the walking line when curved', () => {
  const r = build(lower, upper, { type: 'ramp', fit: false }, [], 'DEV/X', next);
  assert.equal(r.solids.length, 1);
  assert.deepEqual(bounds(r.solids[0]), [[0, 0, 0], [128, 128, 64]]);
  const c = build([[0, 0, 0], [128, 0, 0]], [[0, 0, 96], [0, 128, 96]], { type: 'ramp', fit: false }, [], 'DEV/X', next);
  assert.ok(c.solids.length > 4);
  assert.ok(c.warnings.some(w => /8 units short/.test(w)));
  assert.equal(Math.max(...c.solids.map(s => bounds(s)[1][2])), 96);
  const steep = build(lower, [[0, 64, 128], [128, 64, 128]], { type: 'ramp', fit: false }, [], 'DEV/X', next);
  assert.ok(steep.warnings.some(w => /steep/.test(w)));
});

test('a step count overrides the 16-unit default; non-solid treads are riser-thick', () => {
  const r = build(lower, upper, { count: 8, fit: false, solid: false }, [], 'DEV/X', next);
  assert.equal(r.solids.length, 7);
  assert.ok(r.solids.every(s => bounds(s)[1][2] - bounds(s)[0][2] === 8));
});

test('long runs get more, shallower steps: treads at most 32 deep along the walking line', () => {
  const r = build(lower, upper, { fit: false }, [], 'DEV/X', next);
  assert.equal(r.solids.length, 4); // run 128: 5 risers (13 13 13 13 12), 4 treads of 32
  assert.deepEqual(r.solids.map(s => bounds(s)[1][2]).sort((a, b) => a - b), [13, 26, 39, 52]);
  const long = build([[0, 0, 0], [256, 0, 0]], [[0, 1024, 64], [256, 1024, 64]], { fit: false }, [], 'DEV/X', next);
  assert.equal(long.solids.length, 32); // 1024 / 32
  assert.match(long.info, /treads 32 deep/);
});

// The user's case: a 600 long upper edge and a 500 long lower edge at an angle, off centre, in the open.
const upperEdge = [[-800, 0, 128], [-200, 0, 128]], lowerEdge = [[100, -300, 0], [400, -700, 0]];
const plan = r => r.solids.flatMap(s => V.faces(s).flatMap(f => f.pts.map(p => [p[0], p[1]])));
const total = r => r.solids.reduce((a, s) => a + floorArea(s), 0);

test('curved stairs keep their width from edge to edge, with even treads leaving each edge square to it', () => {
  const r = build(lowerEdge, upperEdge, {}, [], 'DEV/X', next), pts = plan(r);
  assert.equal(r.kind, 'curved');
  // the first and last risers are the whole edges
  for (const q of [[-800, 0], [-200, 0], [100, -300], [400, -700]]) assert.ok(pts.some(p => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.01), `no corner at ${q}`);
  // the width blends from 500 to 600: the area is the walking line times 550
  const run = +r.info.match(/run ([0-9]+)/)[1];
  assert.ok(Math.abs(total(r) - run * 550) < run * 550 * 0.005, `area ${total(r)} vs ${run * 550}`);
  // no slivers: treads differ in area only as much as the width does
  const areas = r.solids.map(floorArea);
  assert.ok(Math.min(...areas) > 0.8 * Math.max(...areas), `${Math.min(...areas)} vs ${Math.max(...areas)}`);
  // each side carries on square from the edge's end (the corridor's wall), 10 to 40 units out
  const square = (q, d) => pts.some(p => { const t = (p[0] - q[0]) * d[0] + (p[1] - q[1]) * d[1]; return t > 10 && t < 40 && Math.abs((p[0] - q[0]) * d[1] - (p[1] - q[1]) * d[0]) < 1.5; });
  for (const q of upperEdge) assert.ok(square(q, [0, -1]), `side at ${q}`);
  for (const q of lowerEdge) assert.ok(square(q, [-0.8, -0.6]), `side at ${q}`);
  const tops = r.solids.map(s => bounds(s)[1][2]);
  assert.ok(Math.max(...tops) < 128 && Math.min(...tops) > 0);
  assert.ok(+r.info.match(/treads ([0-9]+) deep/)[1] <= 32, r.info);
});

test('walls along part of a side do not stretch curved stairs; walls inside cut them back or leave them open', () => {
  const open = build(lowerEdge, upperEdge, {}, [], 'DEV/X', next), low = Math.min(...plan(open).map(p => p[1]));
  assert.ok(Math.abs(total(build(lowerEdge, upperEdge, {}, [box(-200, low - 60, 0, low - 40)], 'DEV/X', next)) - total(open)) < total(open) * 1e-4); // only extra points on the curve
  const cut = build(lowerEdge, upperEdge, {}, [box(-200, low - 60, 0, low + 40)], 'DEV/X', next);
  assert.ok(total(cut) < total(open) - 1000);
  assert.ok(plan(cut).every(p => !(p[0] > -199.9 && p[0] < -0.1 && p[1] < low + 39.9)), 'a tread inside the wall');
  const across = build(lowerEdge, upperEdge, {}, [box(-400, -800, -300, -200)], 'DEV/X', next);
  assert.ok(across.warnings.some(w => /left open/.test(w)));
});

test('a turn too tight for the width pivots the inside on a point, without poking past the edge lines', () => {
  const r = build([[0, 0, 0], [64, 0, 0]], [[0, 128, 128], [0, 384, 128]], {}, [], 'DEV/X', next);
  assert.ok(r.warnings.some(w => /pivots/.test(w)));
  assert.ok(!r.warnings.some(w => /degenerate/.test(w)));
  assert.ok(plan(r).every(p => p[0] >= -0.02 && p[1] >= -0.02));
});

test('edges a little off parallel: the ramp and the last riser end on the top edge all along (no gap, no overhang)', () => {
  const B = [[0, 0, 0], [360, 0, 0]], T = [[0, 34, 3], [360, 42, 3]]; // 1.3 degrees apart, as two steps of an imported flight
  const onTop = p => Math.abs(p[1] - (34 + (8 * p[0]) / 360)) < 0.01;
  for (const type of ['ramp', 'stairs']) {
    const r = build(B, T, { type, fit: false, count: type === 'stairs' ? 3 : 0 });
    assert.ok(!r.error && r.solids.length, `${type}: built`);
    const pts = r.solids.flatMap(s => V.faces(s).flatMap(f => f.pts));
    const far = pts.filter(p => p[1] > 30);
    assert.ok(far.every(onTop), `${type}: every point past the last riser line lies on the top edge`);
    for (const x of [0, 360]) assert.ok(far.some(p => Math.abs(p[0] - x) < 0.01), `${type}: reaches the top edge at x = ${x}`);
  }
});
