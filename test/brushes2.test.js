// Hammer++ brush features: merge (convex hull), polygon prism, microgrid, movable pivot, path node auto-link, and
// vertices_plus on recomputed sides.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false } };
const V = await import('../vmf.js');
const H = await import('../src/hullgeo.js');
const P = await import('../src/polygeo.js');
const st = await import('../src/state.js');

let id = 0;
const next = () => String(++id);
const block = (mn, mx, m = 'DEV/A') => V.block(mn, mx, m, next);
const box = s => V.bounds(V.faces(s));
const sides = s => V.kids(s, 'side');
const faceAt = (s, n) => V.faces(s).find(f => n.every((x, k) => Math.abs(f.n[k] - x) < 1e-6));
const area2 = ps => Math.abs(ps.reduce((a, p, i) => a + p[0] * ps[(i + 1) % ps.length][1] - ps[(i + 1) % ps.length][0] * p[1], 0)) / 2;
const corners = side => V.kids(side, 'vertices_plus')[0]?.kv.map(p => V.nums(p[1]));

test('hullPlanes: a cube from its corners and inner points, nothing from flat points', () => {
  const cube = [0, 1].flatMap(x => [0, 1].flatMap(y => [0, 1].map(z => [x * 64, y * 64, z * 64])));
  const pl = H.hullPlanes([...cube, [32, 32, 32], [10, 20, 30], [64, 32, 32]]);
  assert.equal(pl.length, 6);
  for (const q of pl) {
    const { n, d } = V.planeOf(q);
    assert.ok(cube.every(p => n.reduce((s, x, k) => s + x * p[k], 0) - d <= 1e-9), 'every point behind each plane');
  }
  assert.deepEqual(H.hullPlanes([[0, 0, 0], [64, 0, 0], [0, 64, 0], [64, 64, 0]]), []);
});

test('merge: two boxes side by side become one box; faces keep their old textures', () => {
  const a = block([0, 0, 0], [64, 64, 64], 'DEV/A'), b = block([64, 0, 0], [128, 64, 64], 'DEV/B'), ids = new Map();
  const m = H.merge([a, b], next, ids);
  assert.ok(V.valid(m));
  assert.equal(sides(m).length, 6);
  assert.deepEqual(box(m), [[0, 0, 0], [128, 64, 64]]);
  assert.equal(V.get(m, 'id'), V.get(a, 'id'), 'the first brush id');
  assert.deepEqual(V.kids(m, 'editor'), V.kids(a, 'editor'), 'the first brush editor block');
  assert.equal(V.get(faceAt(m, [1, 0, 0]).side, 'material'), 'DEV/B');
  assert.equal(V.get(faceAt(m, [-1, 0, 0]).side, 'material'), 'DEV/A');
  assert.equal(V.get(faceAt(m, [0, 0, 1]).side, 'material'), 'DEV/A', 'both tops on one plane: the first brush wins');
  const uOf = s => V.get(faceAt(s, [1, 0, 0]).side, 'uaxis');
  assert.equal(uOf(m), uOf(b), 'axes kept');
  const inner = V.get(faceAt(a, [1, 0, 0]).side, 'id'), outer = V.get(faceAt(b, [1, 0, 0]).side, 'id');
  assert.deepEqual(ids.get(inner), [], 'the faces between them are gone');
  assert.deepEqual(ids.get(outer), [V.get(faceAt(m, [1, 0, 0]).side, 'id')]);
});

test('merge: boxes meeting at an edge give the hull with slanted faces in the first material', () => {
  const a = block([0, 0, 0], [64, 64, 64], 'DEV/A'), b = block([64, 64, 0], [128, 128, 64], 'DEV/B');
  const m = H.merge([a, b], next);
  assert.ok(V.valid(m));
  assert.equal(sides(m).length, 8);
  const top = faceAt(m, [0, 0, 1]);
  assert.equal(area2(top.pts), 128 * 128 - 64 * 64);
  const slants = V.faces(m).filter(f => Math.abs(f.n[0]) > 0.1 && Math.abs(f.n[1]) > 0.1);
  assert.equal(slants.length, 2);
  assert.ok(slants.every(f => V.get(f.side, 'material') === 'DEV/A'));
});

test('prism: the hull of the clicked points along the view depth', () => {
  const s = H.prism([[0, 0], [64, 0], [64, 64], [0, 64], [32, 32]], [0, 1], 0, 32, 'DEV/C', next);
  assert.ok(V.valid(s));
  assert.equal(sides(s).length, 6);
  assert.deepEqual(box(s), [[0, 0, 0], [64, 64, 32]]);
  assert.ok(sides(s).every(x => V.get(x, 'material') === 'DEV/C'));
  const f = H.prism([[0, 0], [64, 0], [0, 64]], [1, 2], 16, 48, 'DEV/C', next); // front view: y, z; depth x
  assert.deepEqual(box(f), [[16, 0, 0], [48, 64, 64]]);
  assert.equal(sides(f).length, 5);
  assert.equal(H.prism([[0, 0], [32, 32], [64, 64]], [0, 1], 0, 32, 'DEV/C', next), null, 'points in a line');
  assert.equal(H.prism([[0, 0], [64, 0], [0, 64]], [0, 1], 32, 32, 'DEV/C', next), null, 'no depth');
});

// ---------- state ----------
const solids = () => st.objects().filter(n => n.name === 'solid');
function load(objs) {
  const root = V.parse(st.EMPTY), world = V.kids(root, 'world')[0];
  for (const o of objs) (o.name === 'solid' ? world : root).children.push(o);
  st.load(V.serialize(root), null);
}

test('mergeSel: one undo step, the first brush stays, an emptied func_detail goes', () => {
  const a = block([0, 0, 0], [64, 64, 64]), d = { name: 'entity', kv: [['id', next()], ['classname', 'func_detail']], children: [block([64, 0, 0], [128, 64, 64])] };
  load([a, d]);
  const before = st.serialize(), [s] = solids(), [ds] = V.kids(st.objects().find(n => n.name === 'entity'), 'solid');
  st.setSelection([s, ds]);
  assert.equal(st.mergeSel(), true);
  assert.equal(st.cache.size, 1);
  assert.deepEqual([...st.sel], [s], 'the first brush node, selected');
  assert.deepEqual(box(s), [[0, 0, 0], [128, 64, 64]]);
  assert.ok(!st.serialize().includes('func_detail'), 'the func_detail lost its only solid');
  st.undo();
  assert.equal(st.serialize(), before);
  st.setSelection([s]);
  assert.equal(st.mergeSel(), false, 'one brush');
});

test('microgrid: the grid goes down to 0.125 and blocks keep the decimals', () => {
  load([]);
  for (const [g, want] of [[0.5, 0.5], [0.25, 0.25], [0.125, 0.125], [0.0625, 0.125]]) { st.setGrid(g); assert.equal(st.S.grid, want); }
  st.createBlock([0.125, 0, 0], [0.5, 0.25, 0.375]);
  assert.match(st.serialize(), /\(0\.125 0 0\.375\)/);
  assert.deepEqual(box(solids()[0]), [[0.125, 0, 0], [0.5, 0.25, 0.375]]);
  st.setGrid(64);
});

test('pivot: selPivot returns it, rotation turns about it, a move takes it along, a new selection drops it', () => {
  const a = block([0, 0, 0], [64, 64, 64]), b = block([256, 0, 0], [320, 64, 64]);
  load([a, b]);
  const [s, t] = solids();
  st.setSelection([s]);
  assert.deepEqual(st.selPivot(), [32, 32, 32]);
  st.setPivot([0, 0, 0]);
  assert.deepEqual(st.selPivot(), [0, 0, 0]);
  st.rotateSel(2, 90);
  assert.deepEqual(box(s), [[-64, 0, 0], [0, 64, 64]], 'turned about the pivot');
  st.transformSel([1, 1, 1], [64, 0, 0]);
  assert.deepEqual(st.S.pivot, [64, 0, 0]);
  st.setSelection([s]);
  assert.deepEqual(st.S.pivot, [64, 0, 0], 'the same selection keeps it');
  st.setSelection([s, t]);
  assert.equal(st.S.pivot, null);
  assert.deepEqual(st.selPivot(), [160, 32, 32]);
});

test('cloning a lone path node puts the clone into the path after it', () => {
  const path = (name, target) => { const e = V.entity('path_track', [0, 0, 0], next); e.kv.push(['targetname', name], ...(target ? [['target', target]] : [])); return e; };
  load([path('p1', 'p2'), path('p2', 'p3x'), path('track_09'), V.entity('path_corner', [0, 0, 0], next)]);
  const [p1, p2, p9, pc] = st.objects();
  const before = st.serialize();
  st.setSelection([p1]);
  st.cloneSel();
  const [c] = st.sel;
  assert.deepEqual([V.get(c, 'targetname'), V.get(c, 'target'), V.get(p1, 'target')], ['p3', 'p2', 'p3'], 'p2 is taken');
  st.undo();
  assert.equal(st.serialize(), before);
  st.setSelection([p9]);
  st.cloneSel();
  assert.deepEqual([V.get([...st.sel][0], 'targetname'), V.get(p9, 'target')], ['track_10', 'track_10']);
  st.setSelection([pc]);
  st.cloneSel();
  assert.equal(V.get([...st.sel][0], 'targetname'), 'path1', 'no name: path1');
  st.setSelection([p1, p2]);
  st.cloneSel();
  assert.equal(V.get(p1, 'target'), 'p2', 'two nodes cloned together stay unlinked');
});

// ---------- vertices_plus ----------
test('setCorners writes vertices_plus after the plane, clockwise from the first plane point', () => {
  const b = block([0, 0, 0], [64, 64, 64]), top = faceAt(b, [0, 0, 1]);
  V.setCorners(top.side, top.pts);
  const vs = corners(top.side), r = [...top.pts].reverse(), i = r.findIndex(p => p.join() === vs[0].join());
  assert.deepEqual(vs[0], V.nums(V.get(top.side, 'plane')).slice(0, 3));
  assert.deepEqual(vs, [...r.slice(i), ...r.slice(0, i)], 'the reverse of the CCW corners');
  assert.match(V.serialize({ name: '', kv: [], children: [top.side], eol: '\n' }), /"plane" "[^"]*"\n\tvertices_plus\n\t\{\n(\t\t"v" "[^"]*"\n){4}\t\}\n\t"material"/);
  V.setCorners(top.side, top.pts);
  assert.equal(V.kids(top.side, 'vertices_plus').length, 1, 'replaced, not added');
});

test('poly edit: recomputed sides get exact vertices_plus, untouched sides keep their text', () => {
  const s = block([0, 0, 0], [64, 64, 64]), text = x => V.serialize({ name: '', kv: [], children: [x] });
  const was = new Map(sides(s).map(x => [V.get(x, 'id'), text(x)]));
  const r = P.build(P.moved(P.meshOf(s), p => (p[0] === 64 && p[2] === 64 ? [64 / 3, p[1], 64] : undefined)), s, { nextId: next });
  assert.ifError(r.error);
  const [m] = r.solids, fs = V.faces(m);
  const kept = fs.filter(f => was.get(V.get(f.side, 'id')) === text(f.side));
  assert.deepEqual(kept.map(f => f.n.map(x => Math.round(x) + 0).join()).sort(), ['-1,0,0', '0,0,-1'], 'the bottom and the -x side as they were');
  for (const f of fs.filter(x => !kept.includes(x))) {
    const vs = corners(f.side);
    assert.equal(vs?.length, f.pts.length, 'a corner per vertex');
    assert.ok(vs.every(v => f.pts.some(p => p.every((x, k) => Math.abs(x - v[k]) < 1e-4))));
  }
  assert.match(text(faceAt(m, [0, 0, 1]).side), /"v" "21\.333333 /, 'the moved corner exactly');
});

test('vertex edit, snap and chamfer: reshaped and new sides get vertices_plus', () => {
  const b = block([0, 0, 0], [64, 64, 64]), fs = V.faces(b), key = p => p.join(' ');
  const moved = sides(b).map(side => fs.find(f => f.side === side).pts.map(p => (['64 0 64', '64 64 64'].includes(key(p)) ? [32, p[1], 64] : p)));
  assert.equal(V.fromPoints(b, moved), true);
  const bottom = faceAt(b, [0, 0, -1]), top = faceAt(b, [0, 0, 1]);
  assert.equal(corners(bottom.side), undefined, 'unchanged');
  assert.deepEqual(corners(top.side).map(p => p[0]).sort((x, y) => x - y), [0, 0, 32, 32]);
  const c = P.chamferEdges(b, P.meshOf(b), new Set(), 8, 1, next);
  assert.equal(c, null, 'nothing picked');
  const m = P.meshOf(b), e = [...P.edgeMap(m).values()].find(x => m.v[x.a][2] === 0 && m.v[x.b][2] === 0 && m.v[x.a][0] === 0 && m.v[x.b][0] === 0);
  const ch = P.chamferEdges(b, m, new Set([P.ek(e.a, e.b)]), 8, 1, next);
  assert.ok(ch && V.valid(ch));
  const cut = V.faces(ch).find(f => f.n[0] < -0.1 && f.n[2] < -0.1);
  assert.equal(corners(cut.side).length, 4, 'the new chamfer face');
  assert.equal(corners(faceAt(ch, [0, 0, -1]).side).length, 4, 'the bottom it cut');
  const t = block([0, 0, 0], [64, 64, 64]);
  V.rotate(t, [0, 0, 0], 2, 30);
  assert.equal(V.snapVertices(t, 16), true);
  const tc = corners(faceAt(t, [0, 0, 1]).side);
  assert.ok(tc.length >= 3 && tc.flat().every(x => x % 16 === 0), 'snapped corners');
});
