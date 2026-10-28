// node --test "test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';

// A fake disk for instance files behind window.api, and no-op frames for the views' redraws.
const disk = new Map();
globalThis.requestAnimationFrame = () => 0;
globalThis.window = { api: {
  settingsPath: '', read: async p => disk.get(p) ?? null, write: async (p, t) => { if (p) disk.set(p, t); }, exists: async p => disk.has(p),
  writeBinary: async () => {}, remove: async () => {}, listDir: async () => null, saveDialog: async p => p,
} };
const st = await import('../src/state.js');
const V = await import('../vmf.js');
const C = await import('../src/clipboard.js');
const I = await import('../src/instances.js');
const K = await import('../src/cordon.js');

const box = n => V.bounds(V.faces(n));
const named = (cls, name, o) => { const e = V.entity(cls, o, st.nextId); e.kv.push(['targetname', name]); return e; };

test('paste special names: the pasted set renamed once per name, its outputs and keys follow, outside names stay', () => {
  let id = 0;
  const nid = () => String(++id), door = V.entity('func_door', [0, 0, 0], nid), relay = V.entity('logic_relay', [0, 0, 64], nid);
  door.kv.push(['targetname', 'door']);
  relay.kv.push(['targetname', 'relay'], ['parentname', 'door'], ['target', 'outside']);
  relay.children.unshift({ name: 'connections', kv: [['OnTrigger', 'door\x1bOpen\x1b\x1b0\x1b-1'], ['OnTrigger', 'outside,Kill,,0,-1'], ['OnUser1', 'relay,Trigger,,1,-1']], children: [] });
  const twin = V.entity('func_door', [64, 0, 0], nid);
  twin.kv.push(['targetname', 'door']);
  assert.deepEqual([...C.rename([door, relay, twin], n => `a_${n}_b`)], [['door', 'a_door_b'], ['relay', 'a_relay_b']]);
  assert.deepEqual([door, relay, twin].map(e => V.get(e, 'targetname')), ['a_door_b', 'a_relay_b', 'a_door_b'], 'a shared name stays shared');
  assert.equal(V.get(relay, 'parentname'), 'a_door_b');
  assert.equal(V.get(relay, 'target'), 'outside');
  assert.deepEqual(V.kids(relay, 'connections')[0].kv.map(p => p[1]), ['a_door_b\x1bOpen\x1b\x1b0\x1b-1', 'outside,Kill,,0,-1', 'a_relay_b,Trigger,,1,-1']);
  const used = new Set(['door', 'door_1', 'lamp_3']);
  assert.equal(C.uniqueName('door', used), 'door_2');
  assert.equal(C.uniqueName('door', used), 'door_3', 'a name an earlier copy took counts');
  assert.equal(C.uniqueName('lamp_3', used), 'lamp_1');
  assert.equal(C.uniqueName('free', used), 'free', 'a free name stays');
});

test('paste special: unique names per copy with outputs following, Group puts everything pasted in one group, one undo step', () => {
  st.load(st.EMPTY, null);
  st.addObjects([named('func_button', 'door', [0, 0, 0])]);
  const door = named('prop_dynamic', 'door', [64, 0, 0]), relay = named('logic_relay', 'relay', [64, 0, 64]);
  relay.children.unshift({ name: 'connections', kv: [['OnTrigger', 'door,Open,,0,-1']], children: [] });
  const before = st.serialize(), d = C.readSnippet(C.snippet([door, relay]));
  const objs = C.pasteCopies(d, { n: 2, off: [128, 0, 0], rot: [0, 0, 0], centre: true, unique: true, group: true });
  assert.deepEqual(objs.map(o => V.get(o, 'targetname')), ['door_1', 'relay', 'door_2', 'relay_1']);
  assert.deepEqual([1, 3].map(i => V.kids(objs[i], 'connections')[0].kv[0][1]), ['door_1,Open,,0,-1', 'door_2,Open,,0,-1']);
  assert.deepEqual([0, 2].map(i => V.get(objs[i], 'origin')), ['192 0 0', '320 0 0']);
  const gid = V.get(V.kids(objs[0], 'editor')[0], 'groupid');
  assert(gid && objs.every(o => V.get(V.kids(o, 'editor')[0], 'groupid') === gid) && st.groups().get(gid).length === 4, 'one group holds all four');
  st.undo();
  assert.equal(st.serialize(), before, 'paste and group are one undo step');
  const plain = C.pasteCopies(d, { n: 1, off: [0, 0, 0], rot: [0, 0, 0], centre: true, prefix: 'p_', suffix: '' });
  assert.deepEqual(plain.map(o => V.get(o, 'targetname')), ['p_door', 'p_relay']);
  assert.equal(V.kids(plain[1], 'connections')[0].kv[0][1], 'p_door,Open,,0,-1');
});

test('instance from selection: origin at the grid-snapped bottom centre', () => {
  let id = 0;
  const nid = () => String(++id);
  assert.deepEqual(I.anchor([V.block([10, 0, 5], [100, 64, 64], 'DEV/A', nid), V.entity('info_target', [300, 30, 200], nid)], 16), [160, 32, 0]);
  assert.deepEqual(I.anchor([V.block([-100, -64, -40], [-20, 0, 0], 'DEV/A', nid)], 64), [-64, 0, -64]);
});

// An instance file as Hammer writes one: two world brushes (one in a group and a visgroup), a hidden brush, a func_door
// brush entity, a logic_relay with an output and a $variable, func_instance_parms and a hidden entity.
function instanceFile() {
  let id = 1;
  const nid = () => String(++id), root = V.parse('versioninfo\n{\n\t"prefab" "0"\n}\nvisgroups\n{\n}\nworld\n{\n\t"id" "1"\n\t"classname" "worldspawn"\n}\n'), world = V.kids(root, 'world')[0];
  const a = V.block([-64, -64, 0], [64, 64, 16], 'DEV/A', nid), b = V.block([64, -16, 0], [160, 16, 32], 'DEV/B', nid);
  V.kids(a, 'editor')[0].kv.splice(1, 0, ['groupid', '9'], ['visgroupid', '7']);
  const group = { name: 'group', kv: [['id', '9']], children: [{ name: 'editor', kv: [['color', '1 2 3'], ['visgroupshown', '1'], ['visgroupautoshown', '1']], children: [] }] };
  world.children.push(a, b, { name: 'hidden', kv: [], children: [V.block([0, 0, 64], [8, 8, 72], 'DEV/H', nid)] }, group);
  const door = { name: 'entity', kv: [['id', nid()], ['classname', 'func_door'], ['targetname', 'door']], children: [V.block([-64, 48, 16], [64, 64, 96], 'DEV/C', nid)] };
  const relay = V.entity('logic_relay', [0, 0, 128], nid);
  relay.kv.push(['targetname', 'relay'], ['note', '$what'], ['angles', '0 0 0']);
  relay.children.unshift({ name: 'connections', kv: [['OnTrigger', 'door\x1bOpen\x1b\x1b0\x1b-1']], children: [] });
  root.children.push(door, relay, V.entity('func_instance_parms', [0, 0, 0], nid), { name: 'hidden', kv: [], children: [V.entity('info_target', [0, 0, 0], nid)] });
  return V.serialize(root);
}

test('edit in place: contents placed with raw names, written back as they were (groups, visgroups, parms, hidden kept)', () => {
  const text = instanceFile(), noIds = t => t.replace(/"id" "\d+"/g, '');
  for (const angles of ['0 0 0', '0 90 0', '0 30 0', '15 45 10']) {
    const e = { name: 'entity', kv: [['id', '500'], ['classname', 'func_instance'], ['angles', angles], ['file', 'x.vmf'], ['origin', '1000 -256 64']], children: [] };
    let id = 5000;
    const { objs, eds } = I.placed(V.parse(text), e, () => String(++id));
    assert.deepEqual(objs.map(o => V.get(o, 'targetname') ?? o.name), ['solid', 'solid', 'door', 'relay'], `${angles}: raw names; parms and hidden left out`);
    assert.equal(V.get(objs[3], 'note'), '$what');
    assert(objs.every(o => !V.kids(o, 'editor')[0]?.kv.some(q => /^(vis)?groupid$/.test(q[0]))), 'the file\'s groups stay out of the map');
    if (angles === '0 90 0') assert.deepEqual(box(objs[1]), [[984, -192, 64], [1016, -96, 96]]);
    for (const o of objs) V.kids(o, 'editor')[0]?.kv.splice(1, 0, ['groupid', '777'], ['visgroupid', '3']); // the map's
    assert.equal(noIds(V.serialize(I.unplace(V.parse(text), objs, e, eds))), noIds(text), angles);
  }
  const e = { name: 'entity', kv: [['angles', '0 90 0'], ['origin', '1000 -256 64']], children: [] }, made = V.block([1000, -256, 64], [1064, -192, 128], 'DEV/N', () => '9000');
  V.kids(made, 'editor')[0].kv.splice(1, 0, ['visgroupid', '3']);
  const root = I.unplace(V.parse(text), [made], e), [s] = V.kids(V.kids(root, 'world')[0], 'solid');
  assert.deepEqual(box(s), [[0, -64, 0], [64, 0, 64]], 'a brush made in place lands in instance space');
  assert.deepEqual(V.kids(s, 'editor')[0].kv.map(q => q[0]), ['color', 'visgroupshown', 'visgroupautoshown']);
  assert.deepEqual(root.children.map(c => (c.name === 'entity' ? V.get(c, 'classname') : c.name)), ['versioninfo', 'visgroups', 'world', 'func_instance_parms', 'hidden']);
});

test('create from selection, edit in place, save in place: the file, the map and one undo step each', async () => {
  disk.clear();
  st.load(st.EMPTY, 'C:\\x\\maps\\m.vmf');
  st.setGrid(16);
  const other = st.createBlock([-512, 0, 0], [-448, 64, 64]), a = st.createBlock([1000, 0, 16], [1064, 64, 80]), b = st.createBlock([1064, 0, 16], [1128, 64, 48]);
  st.setSelection([a, b]);
  const before = st.serialize(), file = 'C:\\x\\maps\\instances\\instance_1.vmf';
  await I.fromSelection();
  const [inst] = st.sel, written = V.parse(disk.get(file));
  assert.deepEqual(['classname', 'file', 'origin', 'angles'].map(k => V.get(inst, k)), ['func_instance', 'instances/instance_1.vmf', '1072 32 16', '0 0 0']);
  assert.deepEqual(V.kids(V.kids(written, 'world')[0], 'solid').map(box), [[[-72, -32, 0], [-8, 32, 64]], [[-8, -32, 0], [56, 32, 32]]], 'relative to the origin');
  assert.deepEqual(st.objects(), [other, inst]);
  st.undo();
  assert.equal(st.serialize(), before);
  st.redo();

  st.setSelection([inst]);
  await I.editInPlace();
  const mine = st.objects().filter(o => o !== other);
  assert(I.inPlace() && mine.length === 2 && !st.objects().includes(inst));
  assert.deepEqual(mine.map(box), [box(a), box(b)], 'back where they were');
  const g = V.get(V.kids(mine[0], 'editor')[0], 'groupid');
  assert(g && st.groups().get(g).length === 2, 'grouped');
  st.setSelection([mine[0]]);
  st.transformSel([1, 1, 1], [0, 0, 64]);
  st.createBlock([1200, 0, 16], [1264, 64, 80]);
  const editing = st.serialize();

  await I.saveInPlace();
  assert.deepEqual(V.kids(V.kids(V.parse(disk.get(file)), 'world')[0], 'solid').map(box), [[[-72, -32, 64], [-8, 32, 128]], [[-8, -32, 0], [56, 32, 32]], [[128, -32, 0], [192, 32, 64]]]);
  const back = st.objects();
  assert.equal(back.length, 2);
  assert.equal(back[0], other, 'the rest of the map stays');
  assert.deepEqual(['classname', 'file', 'origin'].map(k => V.get(back[1], k)), ['func_instance', 'instances/instance_1.vmf', '1072 32 16']);
  assert(!I.inPlace() && !V.kids(st.doc.world, 'group').length, 'state cleared, group gone');
  st.undo();
  assert.equal(st.serialize(), editing);
  assert(I.inPlace());
});

test('cordons: add, pick, the tool edits the current one (a click picks a box), per-cordon on/off, rename, remove', () => {
  st.load(st.EMPTY, null);
  const names = () => K.cordons(st.doc.root).list.map(x => x.name);
  K.update([[0, 0, 0], [64, 64, 64]], true);
  K.add([[256, 0, 0], [512, 64, 64]]);
  assert.deepEqual(names(), ['cordon', 'cordon 2']);
  assert.equal(K.current(), 1);
  K.update([[256, 0, 0], [640, 64, 64]]);
  assert.deepEqual(K.activeBoxes(st.doc.root), [[[0, 0, 0], [64, 64, 64]], [[256, 0, 0], [640, 64, 64]]], 'the current one changed');
  K.pick(0);
  K.update([[0, 0, 0], [1024, 64, 64]]);
  assert.deepEqual(K.editBox(), [[0, 0, 0], [1024, 64, 64]]);
  const v = { name: 'top', ax: [0, 1], c: [0, 0], z: 1, w: 2000, h: 2000 }, w = [400, 32], at = { offsetX: 1000 + w[0], offsetY: 1000 - w[1] };
  K.TOOL.down(v, at, w);
  K.TOOL.up(v, at, w);
  assert.equal(K.current(), 1, 'a click picks the smallest box under it, inside the current one too');
  assert.deepEqual(K.editBox(), [[256, 0, 0], [640, 64, 64]], 'a click moves nothing');
  K.setOn(1, false);
  assert.deepEqual(K.activeBoxes(st.doc.root), [[[0, 0, 0], [1024, 64, 64]]]);
  K.setName(1, 'tower');
  K.remove();
  assert.deepEqual(names(), ['cordon']);
  assert.equal(K.current(), 0);
  st.undo();
  assert.deepEqual(names(), ['cordon', 'tower']);
  assert.match(st.serialize(), /\ncordons\n\{\n\t"active" "1"\n\tcordon\n\t\{\n\t\t"name" "cordon"\n\t\t"active" "1"\n\t\tbox\n\t\t\{\n\t\t\t"mins" "\(0 0 0\)"\n\t\t\t"maxs" "\(1024 64 64\)"/);
});
