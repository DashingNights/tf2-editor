// Self-check: node test.js [map.vmf]
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as V from './vmf.js';

let id = 0;
const next = () => String(++id);
const top = b => V.faces(b).find(f => f.n[2] > 0.99);
const uRange = f => { const a = V.nums(V.get(f.side, 'uaxis')); return Math.min(...f.pts.map(p => (p[0] * a[0] + p[1] * a[1] + p[2] * a[2]) / a[4] + a[3])); };

const b = V.block([0, 0, 0], [64, 32, 16], 'DEV/X', next);
assert.equal(V.faces(b).length, 6);
assert.deepEqual(V.bounds(V.faces(b)), [[0, 0, 0], [64, 32, 16]]);
for (const f of V.faces(b)) {
  assert.equal(f.pts.length, 4);
  const c = f.pts.reduce((s, p) => s.map((x, k) => x + p[k] / 4), [0, 0, 0]);
  assert.ok(f.n.reduce((s, x, k) => s + x * (c[k] - [32, 16, 8][k]), 0) > 0, 'normal points outward');
}

const u0 = uRange(top(b));
V.transform(b, [1, 1, 1], [16, 0, 0]);
assert.deepEqual(V.bounds(V.faces(b)), [[16, 0, 0], [80, 32, 16]]);
assert.ok(Math.abs(uRange(top(b)) - u0) < 1e-6, 'texture lock keeps u');

V.transform(b, [-1, 2, 1], [0, 0, 0]);
assert.equal(V.faces(b).length, 6, 'mirror keeps brush valid');
assert.deepEqual(V.bounds(V.faces(b)), [[-80, 0, 0], [-16, 64, 16]]);

const file = process.argv[2] ?? process.env.TEST_MAP;
if (!file) { console.log('ok: geometry (no map to round-trip: node test.js map.vmf, or set TEST_MAP)'); process.exit(0); }
const text = readFileSync(file, 'latin1');
const doc = V.parse(text);
assert.equal(V.serialize(doc), text, 'lossless round trip');
const solids = [];
(function walk(n) { for (const c of n.children) c.name === 'solid' ? solids.push(c) : walk(c); })(doc);
const bad = solids.filter(s => V.faces(s).length < 4);
assert.equal(bad.length, 0, `${bad.length} solids produced < 4 faces`);
console.log(`ok: ${solids.length} solids in ${file}`);
