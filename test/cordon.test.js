// node --test "test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false } };
const V = await import('../vmf.js');
const { cordons, activeBoxes, cordonRoot, shell, touches } = await import('../src/cordon.js');

const BLOCK = 'cordons\n{\n\t"active" "1"\n\tcordon\n\t{\n\t\t"name" "c1"\n\t\t"active" "1"\n\t\tbox\n\t\t{\n\t\t\t"mins" "(0 0 0)"\n\t\t\t"maxs" "(256 256 128)"\n\t\t}\n\t}\n'
  + '\tcordon\n\t{\n\t\t"name" "c2"\n\t\t"active" "0"\n\t\tbox\n\t\t{\n\t\t\t"mins" "(900 900 900)"\n\t\t\t"maxs" "(800 800 800)"\n\t\t}\n\t}\n}\n';

// World solids: inside, outside, straddling the box edge, and one hidden outside; point entities in and out; a
// func_detail with one solid in and one out.
function map() {
  let id = 0;
  const nid = () => String(++id), root = V.parse('versioninfo\n{\n}\nworld\n{\n\t"id" "1"\n\t"classname" "worldspawn"\n}\n' + BLOCK), world = V.kids(root, 'world')[0];
  id = 1;
  const inside = V.block([64, 64, 0], [128, 128, 64], 'DEV/A', nid), out = V.block([1024, 0, 0], [1088, 64, 64], 'DEV/A', nid), edge = V.block([192, 192, 0], [320, 320, 64], 'DEV/A', nid);
  const hid = { name: 'hidden', kv: [], children: [V.block([2048, 0, 0], [2112, 64, 64], 'DEV/A', nid)] };
  world.children.push(inside, out, hid, edge);
  const pin = V.entity('info_target', [32, 32, 32], nid), pout = V.entity('info_target', [-512, 0, 0], nid);
  const det = { name: 'entity', kv: [['id', nid()], ['classname', 'func_detail']], children: [V.block([0, 0, 0], [32, 32, 32], 'DEV/B', nid), V.block([4000, 0, 0], [4032, 32, 32], 'DEV/B', nid)] };
  root.children.splice(2, 0, pin, pout, det);
  return { root, inside, out, edge, pin, pout, det, max: id };
}

test('cordons block: boxes normalised, active state, only active cordons cut', () => {
  const c = cordons(V.parse(BLOCK));
  assert.equal(c.on, true);
  assert.deepEqual(c.list.map(x => [x.name, x.on]), [['c1', true], ['c2', false]]);
  assert.deepEqual(c.list[1].box, [[800, 800, 800], [900, 900, 900]]);
  assert.deepEqual(activeBoxes(V.parse(BLOCK)), [[[0, 0, 0], [256, 256, 128]]]);
  assert.deepEqual(activeBoxes(V.parse(BLOCK.replace('"active" "1"', '"active" "0"'))), [], 'cordons off');
  assert.deepEqual(activeBoxes(V.parse('world\n{\n}\n')), []);
});

test('cordon export keeps the objects touching the box, drops the rest, leaves the document alone', () => {
  const m = map(), before = V.serialize(m.root);
  let id = m.max;
  const r = cordonRoot(m.root, activeBoxes(m.root), () => String(++id)), world = V.kids(r, 'world')[0];
  assert.equal(V.serialize(m.root), before, 'input unchanged');
  const solids = V.kids(world, 'solid');
  assert.deepEqual(solids.slice(0, 2), [m.inside, m.edge], 'inside and straddling kept; outside and hidden dropped');
  assert.equal(V.kids(world, 'hidden').length, 0);
  assert.deepEqual(V.kids(r, 'entity'), [m.pin, m.det], 'point inside, brush entity with a solid inside (whole)');
  assert.deepEqual(r.children.map(c => c.name), ['versioninfo', 'world', 'entity', 'entity', 'cordons'], 'other blocks kept in order');
  assert.equal(solids.length, 2 + 6);
  const ids = new Set(); (function walk(n) { for (const [k, v] of n.kv) if (k === 'id') { assert(!ids.has(v), `duplicate id ${v}`); ids.add(v); } n.children.forEach(walk); })(r);
});

test('shell: six valid tools/toolsskybox brushes just outside the box that seal it', () => {
  const box = [[-100, 0, 20], [300, 64, 500]], t = 16;
  let id = 0;
  const ss = shell(box, t, 'TOOLS/TOOLSSKYBOX', () => String(++id));
  assert.equal(ss.length, 6);
  const bs = ss.map(s => V.bounds(V.faces(s)));
  for (const [i, s] of ss.entries()) {
    assert(V.valid(s), `brush ${i} valid`);
    assert(V.kids(s, 'side').every(sd => V.get(sd, 'material') === 'TOOLS/TOOLSSKYBOX'));
    const [mn, mx] = bs[i];
    assert(mn.some((x, k) => x >= box[1][k]) || mx.some((x, k) => x <= box[0][k]), `brush ${i} outside the box`);
    assert(mn.every((x, k) => x >= box[0][k] - t) && mx.every((x, k) => x <= box[1][k] + t), `brush ${i} within t of it`);
  }
  // no overlaps between walls, and every point of the layer around the box is in exactly one wall
  const inB = (p, [mn, mx]) => p.every((x, k) => x > mn[k] && x < mx[k]);
  const lo = box[0].map(x => x - t / 2), hi = box[1].map(x => x + t / 2), steps = [0, 0.13, 0.5, 0.87, 1];
  for (let k = 0; k < 3; k++) for (const side of [lo, hi]) for (const u of steps) for (const v of steps) {
    const [a, b] = [0, 1, 2].filter(j => j !== k), p = [];
    p[k] = side[k]; p[a] = lo[a] + (hi[a] - lo[a]) * u; p[b] = lo[b] + (hi[b] - lo[b]) * v;
    assert.equal(bs.filter(bb => inB(p, bb)).length, 1, `point ${p} sealed once`);
  }
});

test('touches: shared faces count, gaps do not', () => {
  const b = [[0, 0, 0], [64, 64, 64]];
  assert(touches([64, 0, 0], [128, 64, 64], b));
  assert(!touches([65, 0, 0], [128, 64, 64], b));
});
