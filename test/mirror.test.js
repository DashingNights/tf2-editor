// node --test "test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false } };
const st = await import('../src/state.js');
const V = await import('../vmf.js');
const D = await import('../src/dispgeo.js');
const G = await import('../src/mirrorgeo.js');
const mirror = await import('../src/mirror.js');

let id = 0;
const next = () => String(++id);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const ser = n => V.serialize({ name: '', kv: [], children: [n], eol: '\n' });
const close = (a, b, msg, eps = 1e-6) => assert.ok(a.length === b.length && a.every((x, k) => Math.abs(x - b[k]) < eps), `${msg}: ${a} vs ${b}`);
const axes = s => ['uaxis', 'vaxis'].map(k => V.nums(V.get(s, k)));
const texel = (s, p) => axes(s).map(a => dot(p, a) / a[4] + a[3]);
const walls = s => V.kids(s, 'side').filter(x => Math.abs(V.plane(x).n[2]) < 0.7);

test('reflect: planes and bounds mirror, the brush stays valid, the texel grid lines up on the mirrored faces', () => {
  const b = V.block([16, 0, 0], [80, 32, 48], 'DEV/X', next);
  V.set(V.kids(b, 'side')[2], 'uaxis', '[0.6 0.8 0 13] 0.25'); // a skewed wall
  const r = G.reflect(b, 0, 8);
  assert.ok(V.valid(r));
  assert.deepEqual(V.bounds(V.faces(r)), [[-64, 0, 0], [0, 32, 48]]);
  assert.equal(G.isTwin(b, r, 0, 8), true);
  assert.equal(G.isTwin(b, r, 0, 9), false);
  const fr = V.faces(r);
  for (const f of V.faces(b)) {
    const side = fr.find(g => V.get(g.side, 'id') === V.get(f.side, 'id')).side;
    for (const p of f.pts) {
      const [u, v] = texel(f.side, p), [u2, v2] = texel(side, G.reflectPoint(p, 0, 8));
      // the reflection keeps every texel coordinate; a flipped axis negates it (the same grid lines)
      assert.ok(Math.abs(Math.abs(u2) - Math.abs(u)) < 1e-6 && Math.abs(Math.abs(v2) - Math.abs(v)) < 1e-6, `texel at ${p}`);
    }
  }
});

test('readable: every wall of a twin has u pointing right seen from outside and reads the right way round', () => {
  for (const [ax, c] of [[0, 0], [0, 40], [1, -24]]) {
    const b = V.block([8, 8, 0], [72, 40, 64], 'DEV/MEASUREWALL', next), r = G.reflect(b, ax, c);
    for (const s of walls(r)) {
      const { n } = V.plane(s), [u, v] = axes(s), right = [-n[1], n[0], 0];
      assert.ok(dot(u, right) > 0, `u points right on ${n}`);
      assert.ok(dot(cross(u, v), n) < 0, `reads the right way on ${n}`);
    }
    // a twin of a new brush is the brush made new there: the same texture axes
    const [mn, mx] = V.bounds(V.faces(r)), fresh = V.block(mn, mx, 'DEV/MEASUREWALL', next);
    for (const s of walls(r)) {
      const f = V.kids(fresh, 'side').find(x => dot(V.plane(x).n, V.plane(s).n) > 0.999);
      assert.deepEqual(axes(s).map(a => a.slice(0, 3)), axes(f).map(a => a.slice(0, 3)), 'same axes as a new brush there');
    }
    const top = V.kids(r, 'side').find(x => V.plane(x).n[2] > 0.9), [u, v] = axes(top);
    assert.ok(dot(cross(u, v), V.plane(top).n) < 0, 'the floor reads the right way round from above');
  }
  // reflect twice gives back a brush whose faces read the right way round, byte for byte
  const b = V.block([0, 0, 0], [64, 64, 64], 'DEV/X', next), bottom = V.kids(b, 'side').find(x => V.plane(x).n[2] < -0.9);
  G.readable(bottom, 0); // Hammer's bottom faces read backwards from below; make it read right first
  assert.equal(ser(G.reflect(G.reflect(b, 0, 100), 0, 100)), ser(b));
  // a face that read backwards reads the right way round on its twin, and is not flipped
  const back = V.block([0, 0, 0], [64, 64, 64], 'DEV/X', next), s0 = V.kids(back, 'side').find(x => V.plane(x).n[0] > 0.9);
  V.set(s0, 'uaxis', '[0 -1 0 0] 0.25'); // +x wall, u pointing left: backwards
  const t0 = V.kids(G.reflect(back, 0, 0), 'side').find(x => V.get(x, 'id') === V.get(s0, 'id'));
  assert.deepEqual(axes(t0)[0], [0, -1, 0, 0, 0.25], 'the -x twin: u points right without a flip');
});

// A displacement on the given face of a block, painted lopsided, with alphas, a forced tag and allowed_verts.
function dispBrush(face, power = 3) {
  const b = V.block([0, 0, 0], [256, 128, 64], 'DEV/X', next), f = V.faces(b).find(x => dot(x.n, face) > 0.99);
  const g = D.create(f.side, f.pts, power);
  D.paint(g, f.pts[0], 160, 24, 'raise');
  D.paint(g, f.pts[1], 90, 10, 'lower');
  g.alpha = g.alpha.map((_, i) => (i * 37) % 256);
  g.tags[3] |= 2;
  g.allowed = [['10', '-1 -1 -1 -1 -1 -1 -1 -1 -1 -1'.replace(/^-1/, String(~(1 << 3) & ~(1 << 20)))]];
  D.write(f.side, g);
  return b;
}
const grid = s => { const f = V.faces(s).find(x => V.kids(x.side, 'dispinfo').length); return D.parse(f.side, f.pts); };

test('displacements: the twin\'s displaced surface is the reflected original; data transposed; twice is identity', () => {
  for (const [face, ax, c] of [[[0, 0, 1], 0, 0], [[1, 0, 0], 0, -40], [[0, -1, 0], 1, 300], [[0, 0, 1], 1, 7.5]]) {
    const b = dispBrush(face), g = grid(b), r = G.reflect(b, ax, c), h = grid(r), n = g.n;
    const P = D.positions(g), Q = D.positions(h);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) close(Q[i * n + j], G.reflectPoint(P[j * n + i], ax, c), `vertex ${i},${j}`, 1e-4);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) assert.equal(h.alpha[i * n + j], g.alpha[j * n + i], 'alphas transposed');
    const bit = (a, v) => (Number(a[0][1].split(' ')[v >> 5]) >>> (v & 31)) & 1;
    for (let v = 0; v < n * n; v++) assert.equal(bit(h.allowed, (v % n) * n + Math.floor(v / n)), bit(g.allowed, v), `allowed vertex ${v}`);
    assert.equal(h.tags.filter(t => t & 2).length, 1, 'the forced tag stays on one triangle');
    const back = grid(G.reflect(r, ax, c));
    for (const k of ['field', 'dist', 'offset', 'offNormal', 'alpha', 'tags', 'allowed', 'start']) assert.deepEqual(back[k], g[k], `${k} after two reflections`);
    assert.equal(back.elevation, g.elevation);
    assert.equal(back.power, g.power);
  }
});

test('displacements: a missing offset_normals block is not mirrored twice', () => {
  const b = dispBrush([1, 0, 0]), side = V.kids(b, 'side').find(s => V.kids(s, 'dispinfo').length), di = V.kids(side, 'dispinfo')[0];
  di.children = di.children.filter(c => c.name !== 'offset_normals');
  const h = grid(G.reflect(b, 0, 0));
  assert.ok(h.offNormal.every(v => v[0] === -1 && v[1] === 0 && v[2] === 0), 'the mirrored wall faces -x');
});

test('pairUp: pairs each brush with its exact reflection only (planes within 0.05, same materials)', () => {
  const a = [V.block([-128, 0, 0], [-64, 64, 64], 'DEV/A', next), V.block([-64, 0, 0], [0, 64, 32], 'DEV/A', next), V.block([-256, 0, 0], [-192, 64, 64], 'DEV/A', next), V.block([-320, 0, 0], [-288, 32, 32], 'DEV/A', next)];
  const b = [G.reflect(a[1], 0, 0), V.block([64, 0, 0], [128.02, 64, 64], 'DEV/A', next), V.block([192, 0, 0], [256, 64, 72], 'DEV/A', next), V.block([288, 0, 0], [320, 32, 32], 'DEV/B', next)];
  const p = G.pairUp(a, b, 0, 0);
  assert.deepEqual([...p].map(([x, y]) => [a.indexOf(x), b.indexOf(y)]), [[0, 1], [1, 0]], 'hand-edited (taller) and other-material brushes stay unpaired');
  assert.equal(G.sideOf(V.bounds(V.faces(a[1])), 0, 0), -1, 'touching the plane counts as its side');
  assert.equal(G.sideOf([[-8, 0, 0], [8, 1, 1]], 0, 0), 0);
});

// BLU (x < 0): world a, b (grouped), c; func_detail d1, d2. RED: a's twin (paired), b's hand-edited twin, a lone brush
// r; a pickup on RED, a door (func_door) on BLU, one brush across the plane.
function halfMap() {
  let n = 1;
  const nid = () => String(++n), root = V.parse(st.EMPTY), world = V.kids(root, 'world')[0], blk = (a, b, m = 'DEV/A') => V.block(a, b, m, nid);
  const a = blk([-256, 0, 0], [-192, 64, 64]), b = blk([-128, 0, 0], [-64, 64, 64]), c = blk([-64, 128, 0], [-32, 192, 48], 'DEV/C');
  const ra = G.reflect(a, 0, 0); V.kids(ra, 'side').forEach(s => V.set(s, 'id', nid())); V.set(ra, 'id', nid());
  const rb = blk([64, 0, 0], [128, 64, 80]), r = blk([300, 300, 0], [364, 364, 64]), across = blk([-32, -256, 0], [32, -192, 16]);
  const g = nid(), gid = s => V.kids(s, 'editor')[0].kv.splice(1, 0, ['groupid', g]);
  gid(a); gid(b); // ra stays out of the group (it was copied before)
  world.children.push(a, b, c, ra, rb, r, across, { name: 'group', kv: [['id', g]], children: [{ name: 'editor', kv: [['color', '0 100 200'], ['visgroupshown', '1'], ['visgroupautoshown', '1']], children: [] }] });
  const det = { name: 'entity', kv: [['id', nid()], ['classname', 'func_detail']], children: [blk([-512, 0, 0], [-448, 64, 16], 'DEV/D'), blk([-512, 64, 0], [-448, 128, 32], 'DEV/D')] };
  const door = { name: 'entity', kv: [['id', nid()], ['classname', 'func_door'], ['speed', '500']], children: [blk([-600, 0, 0], [-590, 64, 96])] };
  root.children.push(V.entity('item_healthkit_medium', [200, 0, 0], nid), det, door);
  return V.serialize(root);
}
const terrainOf = () => [...st.cache.values()].filter(c => c.node.name === 'solid' && (c.owner === st.doc.world || V.get(c.owner, 'classname') === 'func_detail'));
const sideBy = (c, s) => G.sideOf([c.min, c.max], 0, 0) === s;
const entitiesText = () => V.kids(st.doc.root, 'entity').filter(e => V.get(e, 'classname') !== 'func_detail').map(ser).join('');
// Every BLU terrain brush has exactly one RED twin that is its reflection, with the reflection's texture axes.
function assertMirrored(msg) {
  const blu = terrainOf().filter(c => sideBy(c, -1)), red = terrainOf().filter(c => sideBy(c, 1));
  assert.equal(red.length, blu.length, `${msg}: as many RED terrain brushes as BLU`);
  for (const c of blu) {
    const t = mirror.twinOf(c.node);
    assert.ok(t && red.some(x => x.node === t), `${msg}: brush ${V.get(c.node, 'id')} has a RED twin`);
    const want = G.reflect(c.node, 0, 0);
    assert.deepEqual(V.kids(t, 'side').map(s => ['plane', 'material', 'uaxis', 'vaxis'].map(k => V.get(s, k))), V.kids(want, 'side').map(s => ['plane', 'material', 'uaxis', 'vaxis'].map(k => V.get(s, k))), `${msg}: brush ${V.get(c.node, 'id')}'s twin is its reflection`);
    const tc = st.cache.get(t), detail = o => o !== st.doc.world;
    assert.equal(detail(tc.owner), detail(c.owner), `${msg}: the twin is func_detail when its source is`);
  }
}

test('Mirror BLU to RED: RED terrain becomes the reflection of BLU in one undo step; RED gameplay entities are BLU ones reflected; brushes across the plane stay', () => {
  st.load(halfMap(), null);
  const before = st.serialize(), { root, world } = st.doc, door = V.kids(root, 'entity')[2], doorText = ser(door);
  const across = V.kids(world, 'solid')[6], acrossText = ser(across), ra = V.kids(world, 'solid')[3];
  Object.assign(mirror.M, { on: true, axis: 0, at: 0, base: -1 });
  mirror.mirrorAll();
  assertMirrored('after BLU to RED');
  const play = V.kids(root, 'entity').filter(e => V.get(e, 'classname') !== 'func_detail');
  assert.equal(ser(door), doorText, 'the BLU door stays as it is');
  assert.deepEqual(play.map(e => V.get(e, 'classname')), ['func_door', 'func_door'], 'the lone RED pickup goes, the door gets a RED copy');
  assert.ok(G.isTwin(V.kids(door, 'solid')[0], V.kids(play[1], 'solid')[0], 0, 0), 'the RED door is the reflection of the BLU one');
  assert.notEqual(V.get(play[1], 'id'), V.get(door, 'id'), 'with ids of its own');
  assert.equal(ser(across), acrossText, 'the brush across the plane stays');
  assert.ok(V.kids(world, 'solid').includes(ra) && mirror.twinOf(V.kids(world, 'solid')[0]) === ra, 'an exact twin keeps its node and ids');
  const dets = V.kids(root, 'entity').filter(e => V.get(e, 'classname') === 'func_detail');
  assert.equal(dets.length, 2, 'the func_detail got a RED counterpart');
  const [a, b] = V.kids(world, 'solid'), gid = o => V.get(V.kids(o, 'editor')[0], 'groupid');
  assert.ok(gid(mirror.twinOf(a)) && gid(mirror.twinOf(a)) === gid(mirror.twinOf(b)) && gid(mirror.twinOf(a)) !== gid(a), 'the group\'s twins share their own group');
  st.undo();
  assert.equal(st.serialize(), before, 'one undo gives back the old RED');
  st.redo();
  assertMirrored('after redo');
  mirror.M.on = false;
});

test('live sync: move, resize, texture, clip, clone, create, delete, group, tie: the twin follows in the same undo step', () => {
  st.load(halfMap(), null);
  Object.assign(mirror.M, { on: true, axis: 0, at: 0, base: -1 });
  mirror.mirrorAll();
  const { world, root } = st.doc, [a, b] = V.kids(world, 'solid'), t = mirror.twinOf(a), tid = V.get(t, 'id'), tsides = V.kids(t, 'side').map(s => V.get(s, 'id'));
  const ents = entitiesText(), steps = () => st.serialize();
  let s0 = steps();
  st.setSelection([a]);
  st.transformSel([1, 1, 1], [-64, 16, 0]);
  assertMirrored('move');
  assert.equal(V.get(t, 'id'), tid, 'the twin keeps its id');
  assert.deepEqual(V.kids(t, 'side').map(s => V.get(s, 'id')), tsides, 'and its side ids');
  st.undo();
  assert.equal(steps(), s0, 'undo restores both');
  st.redo();
  st.transformSel([2, 1, 1], [256, 0, 0]); // resize
  assertMirrored('resize');
  st.applyMaterial('dev/dev_measurewall01d', { solid: a, side: V.kids(a, 'side')[2] });
  assertMirrored('texture on one face');
  assert.equal(V.get(V.kids(t, 'side')[2], 'material'), 'DEV/DEV_MEASUREWALL01D');
  st.edit([a], [], () => V.set(V.kids(a, 'side')[2], 'uaxis', '[0 1 0 37] 0.5')); // texture shift and scale in Details
  assertMirrored('texture shift');
  // a RED edit updates its BLU twin
  st.setSelection([t]);
  st.transformSel([1, 1, 1], [0, 0, 32]);
  assertMirrored('RED edit');
  // both selected and moved: BLU wins
  st.setSelection([a, t]);
  st.transformSel([1, 1, 1], [32, 0, 0]);
  assertMirrored('both moved');
  // clip: new pieces get new twins, the old twin goes
  st.setSelection([b]);
  st.clipSel([[-96, 0, 0], [-96, 64, 0], [-96, 0, 64]]);
  assertMirrored('clip');
  // clone, create, delete
  const [c] = V.kids(world, 'solid').filter(s => V.get(V.kids(s, 'side')[0], 'material') === 'DEV/C');
  st.setSelection([c]);
  st.cloneSel();
  st.transformSel([1, 1, 1], [0, 128, 0]);
  st.mergeUndo();
  assertMirrored('clone + move');
  const c2 = [...st.sel][0];
  s0 = steps();
  const nb = st.createBlock([-700, 0, 0], [-640, 64, 64]);
  assertMirrored('create');
  st.setSelection([nb]);
  st.deleteSel();
  assertMirrored('delete');
  assert.equal(steps(), s0, 'create then delete gives back the map');
  st.undo();
  assertMirrored('undo delete');
  st.undo();
  assert.equal(steps(), s0, 'undo create removes both');
  // group, ungroup, tie to func_detail, untie
  const gid = o => V.get(V.kids(o, 'editor')[0], 'groupid'), groupsNow = () => V.kids(world, 'group').length;
  st.setSelection([c, c2]);
  const g0 = groupsNow();
  st.groupSel();
  assertMirrored('group');
  assert.ok(gid(mirror.twinOf(c)) && gid(mirror.twinOf(c)) === gid(mirror.twinOf(c2)) && gid(mirror.twinOf(c)) !== gid(c), 'the twins get a group of their own');
  assert.equal(groupsNow(), g0 + 2);
  st.ungroupSel();
  assert.ok(!gid(mirror.twinOf(c)) && groupsNow() === g0, 'ungroup: the group of the twins goes too');
  st.setSelection([c]);
  st.tieSel('func_detail');
  assertMirrored('tie');
  const tc = st.cache.get(mirror.twinOf(c)).owner;
  assert.ok(tc !== world && tc !== st.cache.get(c).owner, 'the twin went into a func_detail of its own');
  st.untieSel();
  assertMirrored('untie');
  assert.ok(!root.children.includes(tc), 'the emptied func_detail twin is gone');
  // vertex edit, hollow
  const fp = s => { const fs = V.faces(s); return V.kids(s, 'side').map(x => fs.find(f => f.side === x)?.pts.map(p => (p[2] > 40 && p[1] > 150 ? [p[0], p[1], p[2] + 16] : p)) ?? null); };
  st.edit([c], [], () => assert.equal(V.fromPoints(c, fp(c)), true));
  assertMirrored('vertex edit');
  st.setSelection([c2]);
  st.hollowSel(8);
  assertMirrored('hollow');
  const ids = [...V.serialize(root).matchAll(/"id" "(\d+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'every id is unique');
  assert.equal(entitiesText(), ents, 'entities are never touched');
  // a brush moved onto the plane loses its twin; moved across it, its twin is on the other side
  st.setSelection([c]);
  st.transformSel([1, 1, 1], [48, 0, 0]);
  assert.equal(mirror.twinOf(c), null);
  st.transformSel([1, 1, 1], [64, 0, 0]);
  assert.ok(G.sideOf(V.bounds(V.faces(mirror.twinOf(c))), 0, 0) === -1, 'moved across: the twin is on BLU');
  mirror.M.on = false;
});

test('live sync: displacement paint (the edit after a stroke) updates the twin\'s grid', () => {
  st.load(halfMap(), null);
  Object.assign(mirror.M, { on: true, axis: 0, at: 0, base: -1 });
  mirror.mirrorAll();
  const a = V.kids(st.doc.world, 'solid')[0], f = V.faces(a).find(x => x.n[2] > 0.9);
  st.edit([a], [], () => { const g = D.create(f.side, f.pts, 2); D.paint(g, f.pts[0], 64, 16); D.write(f.side, g); });
  assertMirrored('create and paint');
  const t = mirror.twinOf(a), g = grid(a), h = grid(t), P = D.positions(g), Q = D.positions(h);
  for (let i = 0; i < g.n; i++) for (let j = 0; j < g.n; j++) close(Q[i * g.n + j], G.reflectPoint(P[j * g.n + i], 0, 0), `vertex ${i},${j}`, 1e-4);
  mirror.M.on = false;
});

test('Keep RED: links the halves as they are; the sidecar keeps the settings and the answer', async () => {
  const files = { 'C:/m/a.vmf': halfMap(), 'C:/m/a.vmf.editor.json': JSON.stringify({ hiddenVisgroups: [], show: {}, mirror: { on: true, axis: 0, at: 0, base: -1, asked: 'keep' } }) };
  const written = {};
  Object.assign(window.api, { read: async f => files[f] ?? null, write: async (f, t) => { written[f] = t; } });
  st.S.dirty = false;
  await st.open('C:/m/a.vmf');
  assert.deepEqual({ ...mirror.M }, { on: true, axis: 0, at: 0, base: -1, asked: 'keep', ents: true }, 'ents: on by default (an older sidecar)');
  assert.equal(mirror.statusText(), 'mirror x=0');
  const [a, b] = V.kids(st.doc.world, 'solid');
  assert.ok(mirror.twinOf(a), 'the exact twin is linked');
  assert.equal(mirror.twinOf(b), null, 'the hand-edited one is not');
  const before = st.serialize();
  st.setSelection([b]);
  st.transformSel([1, 1, 1], [0, 0, 16]);
  assert.ok(mirror.twinOf(b) && G.isTwin(b, mirror.twinOf(b), 0, 0), 'an edit gives it a twin');
  st.undo();
  assert.equal(st.serialize(), before);
  st.saveSidecar();
  await new Promise(r => setTimeout(r, 350));
  assert.equal(JSON.parse(written['C:/m/a.vmf.editor.json']).mirror.asked, 'keep');
  st.load(halfMap(), null);
  assert.equal(mirror.M.on, false, 'a map without a sidecar starts with the mirror off');
});

test('paste and carve make twins; an edit adding brushes on both halves (an import) pairs them and doubles nothing', async () => {
  st.load(halfMap(), null);
  Object.assign(mirror.M, { on: true, axis: 0, at: 0, base: -1 });
  mirror.mirrorAll();
  const { world } = st.doc, count = () => V.kids(world, 'solid').length;
  let n0 = count();
  const pasted = V.block([-900, 0, 0], [-836, 64, 64], 'DEV/P', st.nextId);
  st.addObjects([pasted]);
  assertMirrored('paste');
  assert.equal(count(), n0 + 2);
  // carve: the cutter (a) cuts the brushes it overlaps; their pieces get twins, the old twins go
  globalThis.addEventListener ??= () => {};
  (await import('../src/brushtools.js')).mount();
  const cutter = st.createBlock([-880, 16, 16], [-850, 48, 80]);
  st.setSelection([cutter]);
  (await import('../src/commands.js')).run('brush.carve');
  assert.ok(!st.cache.has(pasted), 'the pasted brush was carved');
  assertMirrored('carve');
  // both halves at once, as the Figma import adds them: matched pairs link, the rest stay single
  n0 = count();
  const b1 = V.block([-1200, 0, 0], [-1100, 100, 50], 'DEV/I', st.nextId), b2 = G.reflect(b1, 0, 0), odd = V.block([1100, 300, 0], [1200, 420, 50], 'DEV/I', st.nextId), odd2 = V.block([-1250, 300, 0], [-1100, 400, 50], 'DEV/I', st.nextId);
  V.set(b2, 'id', st.nextId()); V.kids(b2, 'side').forEach(s => V.set(s, 'id', st.nextId()));
  st.addSolids([b1, b2, odd, odd2]);
  assert.equal(count(), n0 + 4, 'nothing doubled');
  assert.equal(mirror.twinOf(b1), b2);
  assert.equal(mirror.twinOf(odd), null);
  mirror.M.on = false;
});

test('Mirror selection now: twins for the selected terrain only, one undo step, also with the live mirror off', () => {
  st.load(halfMap(), null);
  Object.assign(mirror.M, { on: false, axis: 0, at: 0, base: -1 });
  const before = st.serialize(), { world, root } = st.doc, [, b, c] = V.kids(world, 'solid'), door = V.kids(root, 'entity')[2];
  st.setSelection([b, c, V.kids(door, 'solid')[0]]);
  const n0 = V.kids(world, 'solid').length;
  mirror.mirrorSelection();
  assert.equal(V.kids(world, 'solid').length, n0 + 2, 'b and c got twins; the door brush did not');
  mirror.M.on = true;
  assert.ok(G.isTwin(b, mirror.twinOf(b), 0, 0) && G.isTwin(c, mirror.twinOf(c), 0, 0));
  mirror.M.on = false;
  st.undo();
  assert.equal(st.serialize(), before);
});

test('stale pairs: undo never makes a later edit delete brushes; a pair an undo took apart is found again, not doubled', () => {
  const count = () => V.kids(st.doc.world, 'solid').length, alive = n => st.cache.has(n);
  // Keep RED: b gets a twin, undo, edit c: b stays
  st.load(halfMap(), null);
  Object.assign(mirror.M, { on: true, axis: 0, at: 0, base: -1, asked: 'keep' });
  mirror.link();
  let [a, b, c] = V.kids(st.doc.world, 'solid');
  st.setSelection([b]);
  st.transformSel([1, 1, 1], [0, 0, 16]);
  st.undo();
  st.setSelection([c]);
  st.transformSel([1, 1, 1], [0, 16, 0]);
  assert.ok(alive(b) && alive(a), 'b and a stay');
  // BLU to RED, undo, edit a: nothing goes
  st.load(halfMap(), null);
  Object.assign(mirror.M, { on: true, axis: 0, at: 0, base: -1 });
  mirror.mirrorAll();
  st.undo();
  const n0 = count(), e0 = V.kids(st.doc.root, 'entity').length;
  [a, b, c] = V.kids(st.doc.world, 'solid');
  st.setSelection([a]);
  st.transformSel([1, 1, 1], [0, 0, 8]);
  assert.ok(alive(b) && alive(c) && count() === n0 && V.kids(st.doc.root, 'entity').length === e0, 'no BLU brush or func_detail deleted');
  // moved onto the plane (the twin goes), undo, moved again: the old twin is its twin again, no second one
  st.load(halfMap(), null);
  Object.assign(mirror.M, { on: true, axis: 0, at: 0, base: -1 });
  mirror.mirrorAll();
  c = V.kids(st.doc.world, 'solid')[2];
  const t = mirror.twinOf(c), n1 = count();
  st.setSelection([c]);
  st.transformSel([1, 1, 1], [48, 0, 0]);
  st.undo();
  st.transformSel([1, 1, 1], [0, 0, 16]);
  assert.equal(count(), n1);
  assert.equal(mirror.twinOf(c), t);
  assertMirrored('after undo and edit');
  // an undone move onto the plane keeps the pair: a delete takes the twin along
  st.setSelection([c]);
  st.transformSel([1, 1, 1], [48, 0, 0]);
  st.undo();
  st.setSelection([c]);
  st.deleteSel();
  assert.ok(!alive(t), 'deleted after an undone move onto the plane: the twin goes too');
  st.undo();
  // onto the plane and off it again: the old twin comes back; undo both: still paired
  st.setSelection([c]);
  st.transformSel([1, 1, 1], [48, 0, 0]);
  st.transformSel([1, 1, 1], [-200, 0, 0]);
  assert.equal(mirror.twinOf(c), t, 'off the plane: the same twin');
  assertMirrored('off the plane again');
  st.undo();
  st.undo();
  assert.equal(mirror.twinOf(c), t);
  assertMirrored('both undone');
  // create, delete, undo: the pair is live again at once
  const nb = st.createBlock([-700, 0, 0], [-640, 64, 64]), tb = mirror.twinOf(nb);
  st.deleteSel();
  st.undo();
  assert.equal(mirror.twinOf(nb), tb);
  mirror.M.on = false;
});

test('Mirror selection now with the mirror off: an existing reflection is reused; a twin deleted while off deletes nothing', () => {
  st.load(halfMap(), null);
  Object.assign(mirror.M, { on: false, axis: 0, at: 0, base: -1, asked: null });
  const [a, , c, ra] = V.kids(st.doc.world, 'solid'), n0 = V.kids(st.doc.world, 'solid').length;
  st.setSelection([a]);
  mirror.mirrorSelection();
  assert.equal(V.kids(st.doc.world, 'solid').length, n0, 'no copy over ra');
  // on, off, ra deleted while off, then c mirrored now: a stays
  Object.assign(mirror.M, { on: true });
  mirror.link();
  mirror.M.on = false;
  st.setSelection([ra]);
  st.deleteSel();
  st.setSelection([c]);
  mirror.mirrorSelection();
  assert.ok(st.cache.has(a), 'a stays');
});

test('hide one twin, edit the other, unhide all: the edit is kept and mirrored onto the unhidden twin', () => {
  for (const hideBlu of [false, true]) {
    st.load(halfMap(), null);
    Object.assign(mirror.M, { on: true, axis: 0, at: 0, base: -1 });
    mirror.mirrorAll();
    const [a] = V.kids(st.doc.world, 'solid'), t = mirror.twinOf(a), [hid, ed] = hideBlu ? [a, t] : [t, a];
    st.hide([hid]);
    st.setSelection([ed]);
    st.transformSel([1, 1, 1], [0, 0, 32]);
    st.unhideAll();
    assert.equal(V.bounds(V.faces(ed))[0][2], 32, 'the edit stays');
    assert.ok(G.isTwin(a, t, 0, 0), 'the unhidden twin is the reflection');
  }
  mirror.M.on = false;
});

test('texture rotation: a twin face shows the rotation the other way; reflect twice gives it back', () => {
  const b = V.block([0, 0, 0], [64, 64, 64], 'DEV/X', next), s = V.kids(b, 'side')[2];
  V.set(s, 'rotation', '30');
  const r = G.reflect(b, 0, 0), side = x => V.kids(x, 'side').find(y => V.get(y, 'id') === V.get(s, 'id'));
  assert.equal(V.get(side(r), 'rotation'), '330');
  assert.equal(V.get(side(G.reflect(r, 0, 0)), 'rotation'), '30');
});

test('overlays on a twin face move to the new twins when the source is clipped', () => {
  st.load(halfMap(), null);
  Object.assign(mirror.M, { on: true, axis: 0, at: 0, base: -1 });
  mirror.mirrorAll();
  const b = V.kids(st.doc.world, 'solid')[1], t = mirror.twinOf(b), top = V.kids(t, 'side').find(x => V.plane(x).n[2] > 0.9);
  const ov = V.entity('info_overlay', [96, 32, 64], st.nextId);
  V.set(ov, 'sides', V.get(top, 'id'));
  st.edit([], [st.doc.root], () => st.doc.root.children.push(ov));
  st.setSelection([b]);
  st.clipSel([[-96, 0, 0], [-96, 64, 0], [-96, 0, 64]]);
  const ids = V.get(ov, 'sides').split(' ');
  const where = id => { for (const c of st.cache.values()) for (const x of c.node.name === 'solid' ? V.kids(c.node, 'side') : []) if (V.get(x, 'id') === id) return [c, x]; return []; };
  assert.equal(ids.length, 2, 'both pieces of the top face');
  for (const id of ids) { const [c, x] = where(id); assert.ok(c && c.min[0] >= 0 && V.plane(x).n[2] > 0.9, `side ${id} is a top face on RED`); }
  st.undo();
  assert.equal(V.get(ov, 'sides'), V.get(top, 'id'));
  mirror.M.on = false;
});

test('the first-time answer: BLU to RED counts once the map is saved (a discarded rebuild asks again)', async () => {
  let pick = 0;
  globalThis.document ??= {};
  Object.assign(globalThis.document, { body: { appendChild: x => x }, createElement: () => ({ append() {}, replaceChildren() {}, querySelector: () => ({ focus() {} }), showModal() { setTimeout(() => this.close(String(pick))); }, close(v) { this.returnValue = v; this.onclose(); } }) });
  const files = { 'C:/m/q.vmf': halfMap() }, written = {};
  Object.assign(window.api, { read: async f => written[f] ?? files[f] ?? null, write: async (f, t) => { written[f] = t; } });
  st.S.dirty = false;
  await st.open('C:/m/q.vmf');
  const side = async () => { await new Promise(r => setTimeout(r, 350)); return JSON.parse(written['C:/m/q.vmf.editor.json']).mirror; };
  await mirror.toggle();
  assert.equal(mirror.M.on, true);
  assertMirrored('asked: BLU to RED');
  assert.deepEqual(await side(), { on: false, axis: 0, at: 0, base: -1, asked: null, ents: true }, 'not saved yet');
  await st.save();
  assert.deepEqual(await side(), { on: true, axis: 0, at: 0, base: -1, asked: 'mirror', ents: true }, 'saved');
  // reopened: on, answered, no question; Keep RED counts at once (the map does not change)
  st.S.dirty = false;
  await st.open('C:/m/q.vmf');
  assert.ok(mirror.M.on && mirror.M.asked === 'mirror');
  st.load(halfMap(), 'C:/m/r.vmf');
  pick = 1;
  await mirror.toggle();
  assert.equal(JSON.parse(await new Promise(r => setTimeout(() => r(written['C:/m/r.vmf.editor.json']), 350))).mirror.asked, 'keep');
  mirror.M.on = false;
});

// ---------- decor entities ----------
const { cfg } = await import('../src/settings.js');
const ents = (cls = null) => V.kids(st.doc.root, 'entity').filter(e => !cls || V.get(e, 'classname') === cls);
const at = e => V.nums(V.get(e, 'origin'));

test('reflectEntity: origin, angles and angle for both axes and planes off 0; two reflections give the input back', () => {
  const e = { name: 'entity', kv: [['id', '7'], ['classname', 'light_spot'], ['angles', '-45 30 10'], ['angle', '30'], ['pitch', '-45'], ['_cone', '45'], ['origin', '-100 20.5 64']], children: [{ name: 'connections', kv: [['OnUser1', 'x,TurnOff,,0,-1']], children: [] }] };
  const want = { '0,0': ['100 20.5 64', '-45 150 350', '150'], '0,40': ['180 20.5 64', '-45 150 350', '150'], '1,0': ['-100 -20.5 64', '-45 330 350', '330'], '1,-24': ['-100 -68.5 64', '-45 330 350', '330'] };
  for (const [k, [o, a, y]] of Object.entries(want)) {
    const [ax, c] = k.split(',').map(Number), r = G.reflectEntity(e, ax, c);
    assert.deepEqual([V.get(r, 'origin'), V.get(r, 'angles'), V.get(r, 'angle')], [o, a, y], `axis ${ax} at ${c}`);
    assert.equal(V.get(r, 'pitch'), '-45', 'light_spot pitch unchanged');
    assert.deepEqual(r.children, e.children, 'outputs copied');
    assert.equal(ser(G.reflectEntity(r, ax, c)), ser(e), `twice at axis ${ax} at ${c}`);
  }
  // the forward and up vectors of the result are the reflections of the input's (Source AngleMatrix)
  const vecs = s => { const [sp, cp, sy, cy, sr, cr] = V.nums(s).map(x => (x * Math.PI) / 180).flatMap(x => [Math.sin(x), Math.cos(x)]); return [[cp * cy, cp * sy, -sp], [cr * sp * cy + sr * sy, cr * sp * sy - sr * cy, cr * cp]]; };
  for (const ax of [0, 1]) {
    const [f, u] = vecs('-45 30 10'), [f2, u2] = vecs(G.reflectAngles('-45 30 10', ax)), m = v => v.map((x, k) => (k === ax ? -x : x));
    close(f2, m(f), 'forward', 1e-9);
    close(u2, m(u), 'up', 1e-9);
  }
  assert.equal(G.reflectYaw('-1', 0), '-1', 'angle -1 (up) stays');
  // vrad reads angle 0 as unset (the angles yaw counts): 0 stays, a yaw that comes out 0 is written 360
  assert.deepEqual(['0', '180', '360', '90'].map(y => G.reflectYaw(y, 0)), ['0', '360', '180', '90']);
  assert.deepEqual(['0', '360', '90'].map(y => G.reflectYaw(y, 1)), ['0', '360', '270']);
  for (const ax of [0, 1]) for (const y of ['0', '180', '360', '90', '12.5']) assert.equal(G.reflectYaw(G.reflectYaw(y, ax), ax), y, `angle ${y} twice`);
  assert.equal(G.originSide([0.9, 0, 0], 0, 0), 0, 'within 1 unit: on the plane');
  assert.equal(G.originSide([1.5, 0, 0], 0, 0), 1);
});

// halfMap() plus decor entities: BLU light (outputs, name), its exact RED twin with another brightness, a light_spot,
// a prop_static, an env_cubemap on the top faces of a (paired) and c (no twin yet) and a door face, a lone RED light, a light on the plane; and the
// entities that stay out: a pickup, a prop_dynamic, a light_environment, an info_overlay, a spawn point.
function decorMap() {
  const root = V.parse(halfMap()), world = V.kids(root, 'world')[0], a = V.kids(world, 'solid')[0], door = V.kids(root, 'entity')[2];
  let n = 5000;
  const nid = () => String(++n), ent = (cls, o, kv = []) => { const e = V.entity(cls, o, nid); e.kv.splice(2, 0, ...kv); root.children.push(e); return e; };
  const top = V.kids(a, 'side').find(s => V.plane(s).n[2] > 0.9), ctop = V.kids(V.kids(world, 'solid')[2], 'side').find(s => V.plane(s).n[2] > 0.9);
  const l = ent('light', [-256, 32, 96], [['targetname', 'lamp1'], ['_light', '255 255 255 200']]);
  l.children.unshift({ name: 'connections', kv: [['OnUser1', 'lamp1,TurnOff,,0,-1']], children: [] });
  ent('light', [256, 32, 96], [['_light', '255 0 0 50']]);
  ent('light_spot', [-128, 64, 128], [['angles', '-45 30 0'], ['pitch', '-45'], ['_cone', '45']]);
  ent('prop_static', [-300, -50, 0], [['angles', '0 45 0'], ['model', 'models/props_2fort/oildrum.mdl'], ['skin', '0']]);
  ent('env_cubemap', [-224, 32, 80], [['sides', `${V.get(top, 'id')} ${V.get(V.kids(V.kids(door, 'solid')[0], 'side')[0], 'id')} ${V.get(ctop, 'id')}`]]);
  ent('light', [400, 400, 64]);
  ent('light', [0.5, 0, 64]);
  ent('item_healthkit_small', [-200, 100, 0]);
  ent('prop_dynamic', [-200, -200, 0], [['model', 'models/props_gameplay/resupply_locker.mdl']]);
  ent('light_environment', [-100, -100, 300], [['angles', '-60 30 0']]);
  ent('info_overlay', [-224, 32, 64], [['sides', V.get(top, 'id')]]);
  ent('info_player_teamspawn', [-300, 300, 0], [['angles', '0 90 0']]);
  return V.serialize(root);
}
const OUT = ['item_healthkit_medium', 'item_healthkit_small', 'func_door', 'prop_dynamic', 'light_environment', 'info_overlay', 'info_player_teamspawn'];
const outText = () => V.kids(st.doc.root, 'entity').filter(e => OUT.includes(V.get(e, 'classname'))).map(ser).join('');
// Every BLU decor entity (off the plane) has a twin on RED that is its reflection, and RED has no other.
function assertEnts(msg) {
  const dec = ents().filter(e => mirror.DECOR.includes(V.get(e, 'classname'))), side = e => G.originSide(at(e), 0, 0);
  const blu = dec.filter(e => side(e) < 0), red = dec.filter(e => side(e) > 0);
  assert.equal(red.length, blu.length, `${msg}: as many RED decor entities as BLU`);
  for (const e of blu) {
    const t = mirror.twinOf(e), want = G.reflectEntity(e, 0, 0), strip = x => x.kv.filter(p => p[0] !== 'id' && p[0] !== 'sides' && p[0] !== 'groupid');
    assert.ok(t && red.includes(t), `${msg}: ${V.get(e, 'classname')} ${V.get(e, 'id')} has a RED twin`);
    assert.deepEqual([t, ...t.children].map(strip), [want, ...want.children].map(strip), `${msg}: ${V.get(e, 'id')}'s twin is its reflection (its group mapped)`);
  }
}

test('Mirror BLU to RED: decor entities too (paired ones keep their ids, lone RED ones go); the rest untouched; undo byte-identical', () => {
  st.load(decorMap(), null);
  Object.assign(mirror.M, { on: true, axis: 0, at: 0, base: -1, ents: true });
  const before = st.serialize(), out = outText(), h = mirror.halves(true);
  assert.deepEqual([h.base.length, h.other.length, h.across.length], [4, 2, 1], 'the counts the dialog shows: 4 BLU, 2 RED, 1 on the plane');
  const [l, rl, lone, plane] = ents('light'), rlId = V.get(rl, 'id');
  mirror.mirrorAll();
  assertMirrored('terrain');
  assertEnts('after BLU to RED');
  assert.equal(mirror.twinOf(l), rl, 'the paired RED light is the twin');
  assert.deepEqual([V.get(rl, 'id'), V.get(rl, '_light'), V.get(rl, 'targetname'), V.kids(rl, 'connections')[0].kv[0][1]], [rlId, '255 255 255 200', 'lamp1', 'lamp1,TurnOff,,0,-1'], 'keeps its id, takes every key and the outputs');
  assert.ok(!ents().includes(lone), 'the lone RED light goes');
  assert.ok(ents().includes(plane) && mirror.twinOf(plane) === null, 'the light on the plane stays, without a twin');
  const spot = mirror.twinOf(ents('light_spot')[0]), prop = mirror.twinOf(ents('prop_static')[0]);
  assert.deepEqual([V.get(spot, 'origin'), V.get(spot, 'angles'), V.get(spot, 'pitch')], ['128 64 128', '-45 150 0', '-45']);
  assert.deepEqual([V.get(prop, 'origin'), V.get(prop, 'angles'), V.get(prop, 'model')], ['300 -50 0', '0 135 0', 'models/props_2fort/oildrum.mdl']);
  const [a, , c] = V.kids(st.doc.world, 'solid'), top = s => V.get(V.kids(s, 'side').find(x => V.plane(x).n[2] > 0.9), 'id');
  assert.equal(V.get(mirror.twinOf(ents('env_cubemap')[0]), 'sides'), `${top(mirror.twinOf(a))} ${top(mirror.twinOf(c))}`, 'the cubemap twin names the twin faces (one made in the same step); the door face is dropped');
  assert.deepEqual(OUT.map(c => ents(c).length), [0, 2, 2, 2, 1, 1, 2], 'the RED pickup goes; the BLU pickup, door, locker and spawn get RED copies; light_environment and the overlay stay alone');
  for (const c of ['item_healthkit_small', 'prop_dynamic', 'info_player_teamspawn']) {
    const [b, r] = ents(c);
    assert.deepEqual(at(r), G.reflectPoint(at(b), 0, 0), `${c}: the RED copy is at the reflected origin`);
  }
  st.undo();
  assert.equal(st.serialize(), before, 'one undo gives back the map byte for byte');
  st.redo();
  assertEnts('after redo');
  mirror.M.on = false;
});

test('live sync of decor entities: create, model drop, clone, paste, move, rotate, keys, outputs, delete; one undo step each', () => {
  st.load(decorMap(), null);
  Object.assign(mirror.M, { on: true, axis: 0, at: 0, base: -1, ents: true });
  mirror.mirrorAll();
  const out = outText(), [l] = ents('light'), t = mirror.twinOf(l), tid = V.get(t, 'id');
  // each step: the twin follows, undo gives back the map byte for byte, redo the edit
  const step = (msg, fn) => { const s0 = st.serialize(); fn(); assertEnts(msg); const s1 = st.serialize(); st.undo(); assert.equal(st.serialize(), s0, `${msg}: undo`); st.redo(); assert.equal(st.serialize(), s1, `${msg}: redo`); };
  step('create (entity tool)', () => { cfg.cls = 'light'; st.createEntity([-512, 256, 64]); });
  step('model drop (create + model in one step)', () => {
    cfg.cls = 'prop_static';
    const n = st.createEntity([-600, 100, 0]);
    st.edit([], [n], () => { V.set(n, 'model', 'models/props_farm/wooden_barrel.mdl'); V.set(n, 'angles', '0 10 0'); });
    st.mergeUndo();
    assert.equal(V.get(mirror.twinOf(n), 'model'), 'models/props_farm/wooden_barrel.mdl');
  });
  step('move', () => { st.setSelection([l]); st.transformSel([1, 1, 1], [-64, 16, 8]); });
  assert.equal(V.get(t, 'id'), tid, 'the twin keeps its id');
  step('rotate a light_spot', () => { st.setSelection([ents('light_spot')[0]]); st.rotateSel(2, 90); });
  assert.equal(V.get(mirror.twinOf(ents('light_spot')[0]), 'angles'), '-45 60 0');
  step('_light in Details', () => st.edit([], [l], () => V.set(l, '_light', '255 0 0 300')));
  step('outputs in Details', () => { const c = V.kids(l, 'connections')[0]; st.edit([], [c], () => c.kv.push(['OnUser2', 'lamp1,TurnOn,,0,-1'])); });
  assert.equal(V.kids(t, 'connections')[0].kv.length, 2);
  step('a RED edit updates BLU', () => st.edit([], [t], () => V.set(t, 'skin', '1')));
  assert.equal(V.get(l, 'skin'), '1');
  step('both changed: BLU wins', () => st.edit([], [l, t], () => { V.set(l, '_light', '1 2 3 4'); V.set(t, '_light', '9 9 9 9'); }));
  assert.equal(V.get(t, '_light'), '1 2 3 4');
  step('clone + move', () => { st.setSelection([l]); st.cloneSel(); st.transformSel([1, 1, 1], [0, 128, 0]); st.mergeUndo(); });
  step('paste', () => st.addObjects([V.entity('env_sprite', [-700, 0, 64], st.nextId)]));
  step('group a light with a brush', () => { st.setSelection([l, V.kids(st.doc.world, 'solid')[0]]); st.groupSel(); });
  const gid = o => V.get(V.kids(o, 'editor')[0], 'groupid'), a = V.kids(st.doc.world, 'solid')[0];
  assert.ok(gid(t) && gid(t) === gid(mirror.twinOf(a)) && gid(t) !== gid(l), 'the twins share a group of their own');
  step('delete', () => { st.setSelection([l]); st.deleteSel(); assert.ok(!ents().includes(t), 'the twin goes'); });
  assert.equal(mirror.twinOf(l), null, 'redone delete: no pair');
  st.undo();
  assert.equal(mirror.twinOf(l), t, 'an undone delete is paired again at once');
  assert.equal(outText(), out, 'the rest is never touched');
  const ids = [...st.serialize().matchAll(/"id" "(\d+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'every id is unique');
  mirror.M.on = false;
});

test('decor entities: excluded classes and entities on the plane get no twin; the setting off leaves them all out', () => {
  st.load(decorMap(), null);
  Object.assign(mirror.M, { on: true, axis: 0, at: 0, base: -1, ents: true });
  mirror.mirrorAll();
  const n0 = ents().length;
  for (const cls of ['item_healthkit_small', 'item_ammopack_full', 'prop_dynamic', 'light_environment', 'info_overlay', 'info_player_teamspawn', 'func_door', 'logic_relay', 'trigger_multiple']) {
    cfg.cls = cls;
    st.createEntity([-640, 640, 0]);
  }
  assert.equal(ents().length, n0 + 9, 'no twins for the excluded classes');
  st.setSelection([ents('item_healthkit_small')[0]]);
  st.transformSel([1, 1, 1], [0, 64, 0]);
  assert.equal(ents().length, n0 + 9, 'nor when they move');
  cfg.cls = 'light';
  const p = st.createEntity([1, 300, 64]);
  assert.equal(ents().length, n0 + 10, 'a light within 1 unit of the plane is its own mirror');
  // a paired light moved onto the plane loses its twin; undo, move again: the old twin is its twin again, not doubled
  const [l] = ents('light'), t = mirror.twinOf(l), n1 = ents().length;
  st.setSelection([l]);
  st.transformSel([1, 1, 1], [256, 0, 0]);
  assert.ok(!ents().includes(t) && mirror.twinOf(l) === null);
  st.undo();
  st.transformSel([1, 1, 1], [0, 0, 16]);
  assert.equal(ents().length, n1);
  assert.equal(mirror.twinOf(l), t);
  assertEnts('after undo and a move');
  // an undone move onto the plane keeps the pair: a delete takes the twin along, a clone gets a twin of its own
  const onto = () => { st.setSelection([l]); st.transformSel([1, 1, 1], [256, 0, 0]); st.undo(); st.setSelection([l]); };
  onto();
  st.deleteSel();
  assert.ok(!ents().includes(t), 'deleted after an undone move onto the plane: the twin goes too');
  st.undo();
  onto();
  st.cloneSel();
  assertEnts('a clone after an undone move onto the plane');
  st.undo();
  // onto the plane and off it again: the old twin comes back; undo both: still paired
  st.setSelection([l]);
  st.transformSel([1, 1, 1], [256, 0, 0]);
  st.transformSel([1, 1, 1], [-100, 0, 0]);
  assert.equal(mirror.twinOf(l), t, 'off the plane: the same twin');
  assertEnts('off the plane again');
  st.undo();
  st.undo();
  assert.equal(mirror.twinOf(l), t);
  assert.equal(ents().length, n1);
  // an entity on the plane is never taken for a twin: l moved onto the plane next to one, then off again
  const q = ents('light').find(e => V.get(e, 'origin') === '0.5 0 64');
  st.setSelection([l]);
  st.transformSel([1, 1, 1], [256, -32, -48]);
  st.transformSel([1, 1, 1], [-128, 0, 0]);
  assert.deepEqual([mirror.twinOf(l), V.get(q, 'origin')], [t, '0.5 0 64'], 'the old twin comes back, the light on the plane stays');
  st.undo();
  st.undo();
  // the setting off: new lights get no twin, edits leave the twins alone
  mirror.toggleEnts();
  assert.equal(mirror.M.ents, false);
  st.createEntity([-900, 0, 64]);
  st.setSelection([l]);
  st.transformSel([1, 1, 1], [0, 0, 32]);
  assert.equal(ents().length, n1 + 1);
  assert.equal(V.get(t, 'origin'), '256 32 112', 'the twin stays where it was');
  mirror.toggleEnts();
  // stale pairs: Mirror BLU to RED undone, then an edit: no entity deleted
  st.load(decorMap(), null);
  mirror.mirrorAll();
  st.undo();
  const n2 = ents().length;
  st.setSelection([ents('light')[0]]);
  st.transformSel([1, 1, 1], [0, 0, 8]);
  assert.equal(ents().length, n2, 'nothing deleted');
  mirror.M.on = false;
});

test('decor entities: hide one twin, edit the other, unhide all; Mirror selection now; both halves pasted pair up', () => {
  for (const hideBlu of [false, true]) {
    st.load(decorMap(), null);
    Object.assign(mirror.M, { on: true, axis: 0, at: 0, base: -1, ents: true });
    mirror.mirrorAll();
    const [l] = ents('light'), t = mirror.twinOf(l), [hid, ed] = hideBlu ? [l, t] : [t, l];
    st.hide([hid]);
    st.edit([], [ed], () => V.set(ed, '_light', '1 1 1 1'));
    assert.notEqual(V.get(hid, '_light'), '1 1 1 1', 'a hidden twin is left alone');
    st.unhideAll();
    assert.equal(V.get(hid, '_light'), '1 1 1 1', 'unhide mirrors the edit onto it');
    assertEnts('after unhide');
  }
  // mirror off: Mirror selection now makes the twins of the selected decor entities only
  st.load(decorMap(), null);
  Object.assign(mirror.M, { on: false, axis: 0, at: 0, base: -1, ents: true });
  const before = st.serialize(), n0 = ents().length;
  st.setSelection([ents('light_spot')[0], ents('prop_dynamic')[0]]);
  mirror.mirrorSelection();
  assert.equal(ents().length, n0 + 1, 'the light_spot got a twin, the prop_dynamic did not');
  st.undo();
  assert.equal(st.serialize(), before);
  // both halves pasted in one edit: they pair, nothing doubled
  mirror.M.on = true;
  mirror.link();
  const n1 = ents().length, a = V.entity('light', [-1000, 0, 64], st.nextId), b = G.reflectEntity(a, 0, 0);
  V.set(b, 'id', st.nextId());
  st.addObjects([a, b]);
  assert.equal(ents().length, n1 + 2);
  assert.equal(mirror.twinOf(a), b);
  mirror.M.on = false;
});

test('decor entities: a class changed in Details to one not mirrored passes to the twin once, then the pair is left alone', () => {
  st.load(decorMap(), null);
  Object.assign(mirror.M, { on: true, axis: 0, at: 0, base: -1, ents: true });
  mirror.mirrorAll();
  const p = ents('prop_static')[0], t = mirror.twinOf(p), s0 = st.serialize(), n0 = ents().length;
  st.edit([], [p], () => V.set(p, 'classname', 'prop_dynamic'));
  assert.deepEqual([V.get(t, 'classname'), V.get(t, 'origin')], ['prop_dynamic', '300 -50 0'], 'the twin takes the new class');
  const s1 = st.serialize();
  st.undo();
  assert.equal(st.serialize(), s0, 'undo');
  st.redo();
  assert.equal(st.serialize(), s1, 'redo');
  st.setSelection([p]);
  st.transformSel([1, 1, 1], [0, 64, 0]);
  assert.equal(V.get(t, 'origin'), '300 -50 0', 'then a move is not mirrored');
  st.deleteSel();
  assert.ok(ents().includes(t) && ents().length === n0 - 1, 'nor a delete');
  st.undo();
  st.undo();
  st.edit([], [p], () => V.set(p, 'classname', 'prop_static'));
  assert.equal(V.get(t, 'classname'), 'prop_static', 'back to prop_static: the twin follows');
  assertEnts('back to prop_static');
  st.edit([], [t], () => V.set(t, 'classname', 'prop_dynamic'));
  assert.equal(V.get(p, 'classname'), 'prop_dynamic', 'the RED twin changed: BLU takes it');
  assert.equal(ents().length, n0);
  mirror.M.on = false;
});

test('a Figma update (bulk) rebuilds the RED terrain only: decor entities stay as they are', () => {
  st.load(decorMap(), null);
  Object.assign(mirror.M, { on: true, axis: 0, at: 0, base: -1, ents: true });
  const decor = () => ents().filter(e => mirror.DECOR.includes(V.get(e, 'classname'))).map(ser).join(''), d0 = decor();
  mirror.bulk(() => st.addSolids([V.block([-900, 0, 0], [-836, 64, 64], 'DEV/F', st.nextId)]));
  assertMirrored('terrain');
  assert.equal(decor(), d0, 'the lone RED light stays, no decor twin made');
  mirror.M.on = false;
});

test('team swap: TeamNum and owners 2 <-> 3; blu, blue and red at the start of a name part, in the same case; outputs too', () => {
  assert.deepEqual(['spawnroom_blu', 'door_blu_1', 'BluSpawn', 'RED_door', 'filter_red', 'bluespawn', 'shred', 'credits'].map(G.swapNames),
    ['spawnroom_red', 'door_red_1', 'RedSpawn', 'BLU_door', 'filter_blu', 'redspawn', 'shred', 'credits']);
  const e = { name: 'entity', kv: [['id', '1'], ['classname', 'trigger_multiple'], ['filtername', 'filter_blu'], ['TeamNum', '3'], ['model', 'models/blu.mdl']], children: [{ name: 'connections', kv: [['OnStartTouchAll', 'door_blu_1Open0-1']], children: [] }] };
  G.swapTeam(e);
  assert.deepEqual(e.kv.map(p => p[1]), ['1', 'trigger_multiple', 'filter_red', '2', 'models/blu.mdl']);
  assert.equal(V.kids(e, 'connections')[0].kv[0][1], 'door_red_1Open0-1');
  assert.equal(G.flipRoll('0 135 15'), '0 135 195');
});

test('Rebuild RED from BLU: the door, trigger and respawn room come across team swapped; a moved model twin still pairs', () => {
  const root = V.parse(st.EMPTY);
  let n = 100;
  const nid = () => String(++n), brush = (cls, a, b, kv) => { const e = { name: 'entity', kv: [['id', nid()], ['classname', cls], ...kv], children: [V.block(a, b, 'TOOLS/TOOLSTRIGGER', nid)] }; root.children.push(e); return e; };
  brush('func_door', [-600, 0, 0], [-590, 64, 96], [['targetname', 'door_blu_1'], ['movedir', '90 0 0']]);
  const trig = brush('trigger_multiple', [-640, -32, 0], [-560, 96, 96], [['filtername', 'filter_blu']]);
  trig.children.push({ name: 'connections', kv: [['OnStartTouchAll', 'door_blu_1,Open,,0,-1']], children: [] });
  brush('func_respawnroom', [-800, 0, 0], [-640, 128, 128], [['targetname', 'spawnroom_blu'], ['TeamNum', '3']]);
  brush('func_respawnroom', [640, 0, 0], [800, 128, 128], [['targetname', 'spawnroom_red'], ['TeamNum', '2']]);
  st.load(V.serialize(root), null);
  Object.assign(mirror.M, { on: true, axis: 0, at: 0, base: -1, ents: true });
  mirror.mirrorAll();
  const red = V.kids(st.doc.root, 'entity').filter(e => V.bounds(V.kids(e, 'solid').flatMap(V.faces))[0][0] > 0);
  assert.deepEqual(red.map(e => [V.get(e, 'classname'), V.get(e, 'targetname') ?? V.get(e, 'filtername'), V.get(e, 'TeamNum') ?? '']),
    [['func_door', 'door_red_1', ''], ['trigger_multiple', 'filter_red', ''], ['func_respawnroom', 'spawnroom_red', '2']], 'the old RED room goes; the three BLU ones come across');
  assert.equal(V.kids(red[1], 'connections')[0].kv[0][1], 'door_red_1,Open,,0,-1', 'the trigger opens the RED door');
  assert.equal(V.get(red[0], 'movedir'), '90 180 0');
  mirror.M.on = false;
  // pairing: a prop twin moved to line up its model box (not at the reflected origin) still pairs by model and angles
  const a = { name: 'entity', kv: [['id', '1'], ['classname', 'prop_static'], ['origin', '-100 0 0'], ['angles', '0 15 0'], ['model', 'models/desk.mdl']], children: [] };
  const b = { name: 'entity', kv: [['id', '2'], ['classname', 'prop_static'], ['origin', '120 60 0'], ['angles', '0 165 0'], ['model', 'models/desk.mdl']], children: [] };
  const c = { ...b, kv: b.kv.map(p => (p[0] === 'angles' ? ['angles', '0 15 0'] : p)) };
  assert.equal(G.pairEnts([a], [b], 0, 0).get(a), b);
  assert.equal(G.pairEnts([a], [c], 0, 0).get(a), undefined, 'not with other angles');
});
