// Stair player clips (src/stairclip.js): smooth planes on the nosings, an apron to the floor, flat over the landing.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../vmf.js';
import { clipStairs } from '../src/stairclip.js';

let n = 0;
const nid = () => String(++n);
const box = (a, b) => V.block(a, b, 'DEV/STEP', nid);
// top of the clip brushes at (x, y): the highest of each convex brush's top there (its lowest upward face plane)
const topAt = (solids, x, y) => Math.max(-Infinity, ...solids.map(s => {
  let hi = Infinity, lo = -Infinity;
  for (const f of V.faces(s)) {
    const q = f.pts[0], c = f.n[0] * q[0] + f.n[1] * q[1] + f.n[2] * q[2] - f.n[0] * x - f.n[1] * y;
    if (Math.abs(f.n[2]) < 1e-9) { if (c < -0.01) return -Infinity; continue; }
    if (f.n[2] > 0) hi = Math.min(hi, c / f.n[2]); else lo = Math.max(lo, c / f.n[2]);
  }
  return hi > lo ? hi : -Infinity;
}));

test('a straight flight: one ramp through the nosings, an apron to the floor, nothing over the landing; the floor and a deep landing selected too change nothing', () => {
  const steps = Array.from({ length: 8 }, (_, i) => box([i * 32, 0, 0], [i * 32 + 32, 128, 16 * (i + 1)]));
  const landing = box([256, 0, 0], [640, 128, 128]), floor = box([-512, -256, -16], [0, 384, 0]);
  const t0 = Date.now(), r = clipStairs([...steps, landing, floor], { nextId: nid });
  assert.ok(!r.error, r.error);
  assert.ok(Date.now() - t0 < 2000, 'fast enough to click');
  assert.ok(r.solids.length >= 1 && r.solids.every(V.valid));
  assert.ok(r.solids.every(s => V.kids(s, 'side').every(x => V.get(x, 'material') === 'TOOLS/TOOLSPLAYERCLIP')));
  for (let i = 0; i < 8; i++) assert.ok(Math.abs(topAt(r.solids, i * 32 + 0.01, 64) - 16 * (i + 1)) < 0.05, `nosing ${i} under the slope`);
  assert.ok(Math.abs(topAt(r.solids, -31.9, 64)) < 0.1, 'the apron reaches the floor one tread in front');
  assert.ok(topAt(r.solids, 300, 64) === -Infinity, 'nothing over the landing');
  assert.equal(r.solids.length, 1, 'one ramp brush, no flat pieces');
});

test('an L-shaped flight: the ramp follows the turn, no step corner pokes through, every piece walkable', () => {
  const steps = [];
  for (let i = 0; i < 5; i++) steps.push(box([i * 32, 0, 0], [i * 32 + 32, 96, 16 * (i + 1)]));
  steps.push(box([160, 0, 0], [256, 96, 96])); // the corner landing
  for (let i = 0; i < 5; i++) steps.push(box([160, 96 + i * 32, 0], [256, 128 + i * 32, 96 + 16 * (i + 1)]));
  const r = clipStairs(steps, { nextId: nid });
  assert.ok(!r.error, r.error);
  assert.ok(r.solids.every(V.valid));
  for (const s of r.solids) for (const f of V.faces(s)) if (f.n[2] > 0.01) assert.ok(f.n[2] >= Math.cos(Math.PI / 4) - 1e-6, 'walkable');
  // where there is clip, no step corner pokes through it; every nosing has clip on it
  for (const s of steps) for (const f of V.faces(s)) if (f.n[2] > 0.99) for (const p of f.pts) {
    const c = [0, 1].map(k => f.pts.reduce((a, q) => a + q[k], 0) / f.pts.length), q = [0, 1].map(k => p[k] + Math.sign(c[k] - p[k]) * 0.01); // just inside the tread
    const z = topAt(r.solids, ...q);
    assert.ok(z === -Infinity || z >= p[2] - 0.05, `corner ${p} pokes through the clip`);
  }
  // on every nosing, at most one riser above it (pieces merged into one plane may stand that much over one)
  for (const [x, y, z] of [[32, 48, 32], [64, 48, 48], [128, 48, 80], [208, 96, 112], [208, 128, 128], [208, 160, 144]]) { const t = topAt(r.solids, x + 0.01, y + 0.01) - z; assert.ok(t > -0.05 && t < 16.1, `nosing at ${x} ${y}: ${t}`); }
});

test('one height selected: an error, not a flat slab', () => {
  assert.ok(clipStairs([box([0, 0, 0], [64, 64, 16])]).error);
});

test('context: the ramp starts at the real floor, ends at the ledge the steps lead to, and widens to a wall beside it', () => {
  const steps = Array.from({ length: 8 }, (_, i) => box([i * 32, 0, 0], [i * 32 + 32, 128, 16 * (i + 1)]));
  const ledge = box([256, -64, 0], [512, 192, 144]), floor = box([-256, -128, -16], [0, 256, 0]);
  const wall = box([0, 152, 0], [256, 184, 256]), far = box([0, -184, 0], [256, -100, 256]); // 24 units off one side, 100 off the other
  const r = clipStairs(steps, { nextId: nid, context: [ledge, floor, wall, far] });
  assert.ok(!r.error, r.error);
  assert.match(r.info, /up to the ledge/);
  assert.ok(Math.abs(topAt(r.solids, 255.9, 64) - 144) < 0.1, 'reaches the ledge edge at its height');
  assert.ok(topAt(r.solids, 260, 64) === -Infinity, 'nothing over the ledge');
  assert.ok(Math.abs(topAt(r.solids, -31.9, 64)) < 0.1 && topAt(r.solids, -40, 64) === -Infinity, 'the apron ends at the floor');
  assert.ok(Math.abs(topAt(r.solids, 100, 151) - topAt(r.solids, 100, 64)) < 1e-6, 'widened to the wall 24 units off');
  assert.ok(topAt(r.solids, 100, -20) === -Infinity, 'not to the one 100 units off');
});

test('a curved flight: pieces meet flush (no step between them), nosings on the ramp, every piece walkable', () => {
  // ten steps turning 135 degrees round a post, treads from radius 80 to 208
  const at = (r, a) => [r * Math.cos(a), r * Math.sin(a)], prismOf = (poly, z0, z1) => V.brush([poly.map(p => [...p, z0]).reverse(), poly.map(p => [...p, z1]), ...poly.map((p, i) => { const q = poly[(i + 1) % poly.length]; return [[...p, z0], [...q, z0], [...q, z1], [...p, z1]]; })], 'DEV/STEP', nid);
  const steps = Array.from({ length: 10 }, (_, i) => { const a0 = (i * 13.5 * Math.PI) / 180, a1 = ((i + 1) * 13.5 * Math.PI) / 180; return prismOf([at(80, a0), at(208, a0), at(208, a1), at(80, a1)], 0, 16 * (i + 1)); });
  const r = clipStairs(steps, { nextId: nid });
  assert.ok(!r.error, r.error);
  assert.ok(r.solids.every(V.valid));
  assert.ok(r.solids.length <= 30, `${r.solids.length} pieces`);
  for (const s of r.solids) for (const f of V.faces(s)) if (f.n[2] > 0.01) assert.ok(f.n[2] >= Math.cos(Math.PI / 4) - 1e-3, 'walkable');
  // flush: along every piece's top edges, its height equals the clip's height just across the edge
  const tops = r.solids.map(s => V.faces(s).find(f => f.n[2] > 0.01));
  for (const f of tops) f.pts.forEach((p, i) => {
    const q = f.pts[(i + 1) % f.pts.length], m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], h = (p[2] + q[2]) / 2, d = [q[1] - p[1], p[0] - q[0]], l = Math.hypot(...d);
    for (const s of [1, -1]) { const z = topAt(r.solids, m[0] + (s * d[0]) / l * 0.05, m[1] + (s * d[1]) / l * 0.05); assert.ok(z === -Infinity || Math.abs(z - h) < 0.1, `step of ${(z - h).toFixed(2)} at ${m.map(Math.round)}`); }
  });
  // the ramp runs through each nosing (the front edge of step i + 1, over step i); it starts at the second step's (with
  // no floor in front, the first step is a step up onto it)
  for (let i = 2; i < 10; i++) for (const rad of [96, 144, 192]) { const [x, y] = at(rad, ((i * 13.5 - 0.1) * Math.PI) / 180), t = topAt(r.solids, x, y) - 16 * (i + 1); assert.ok(t > -0.5 && t < 0.5, `nosing ${i} at radius ${rad}: ${t.toFixed(2)}`); }
});
