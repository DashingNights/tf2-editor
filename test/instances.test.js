// node --test "test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false } };
const V = await import('../vmf.js');
const { candidates, angleRows, placer, fixName, collapse, relTo } = await import('../src/instances.js');

// The test instance in dev/scratch/instances: three world brushes, func_door "door", logic_relay "relay" whose outputs
// target door, @global and $target.
function instance() {
  let id = 1;
  const nid = () => String(++id), root = V.parse('versioninfo\n{\n}\nworld\n{\n\t"id" "1"\n\t"classname" "worldspawn"\n}\n'), world = V.kids(root, 'world')[0];
  world.children.push(V.block([-64, -64, 0], [64, 64, 16], 'DEV/A', nid), V.block([64, -16, 0], [160, 16, 32], 'DEV/B', nid));
  V.kids(world.children[0], 'editor')[0].kv.push(['visgroupid', '7'], ['groupid', '9']);
  const door = { name: 'entity', kv: [['id', nid()], ['classname', 'func_door'], ['targetname', 'door']], children: [V.block([-64, 48, 16], [64, 64, 96], 'DEV/C', nid)] };
  const relay = V.entity('logic_relay', [0, 0, 128], nid);
  relay.kv.push(['targetname', 'relay'], ['parentname', 'door'], ['note', '$what']);
  relay.children.unshift({ name: 'connections', kv: [['OnTrigger', 'door\x1bOpen\x1b\x1b0\x1b-1'], ['OnTrigger', '@global,Show,,0,-1'], ['OnTrigger', '$target,Enable,,0,-1']], children: [] });
  const parms = V.entity('func_instance_parms', [0, 0, 0], nid);
  root.children.push(door, relay, parms);
  return { root, max: id };
}
const inst = (over = {}) => ({ name: 'entity', kv: [['id', '500'], ['classname', 'func_instance'], ['targetname', 'inst1'], ['angles', '0 90 0'], ['file', 'instances/test_instance.vmf'], ['fixup_style', '0'], ['replace01', '$target door'], ['replace02', '$what a b'], ['origin', '1000 0 64']].map(([k, v]) => [k, over[k] ?? v]), children: [] });

test('instance file lookup: next to the map, then under the maps folder (vbsp order)', () => {
  assert.deepEqual(candidates('D:\\x\\maps\\sub\\a.vmf', 'instances/foo'), ['D:\\x\\maps\\sub\\instances\\foo.vmf', 'D:\\x\\maps\\instances\\foo.vmf']);
  assert.deepEqual(candidates('D:/x/maps/a.vmf', 'instances\\foo.vmf'), ['D:\\x\\maps\\instances\\foo.vmf']);
  assert.deepEqual(candidates('D:\\x\\a.vmf', 'b.vmf'), ['D:\\x\\b.vmf']);
  assert.deepEqual(candidates(null, 'b.vmf'), []);
});

test('angles turn like Source AngleMatrix: forward = (cp cy, cp sy, -sp)', () => {
  const [p, y, r] = [30, 45, 10], m = angleRows([p, y, r]), D = Math.PI / 180;
  const fwd = [m[0][0], m[1][0], m[2][0]], want = [Math.cos(p * D) * Math.cos(y * D), Math.cos(p * D) * Math.sin(y * D), -Math.sin(p * D)];
  fwd.forEach((x, k) => assert(Math.abs(x - want[k]) < 1e-9));
  assert.deepEqual(placer(inst())([100, 0, 0]).map(Math.round), [1000, 100, 64]);
});

test('name fixup styles; @ and ! names stay', () => {
  assert.equal(fixName('door', 'inst1', 0), 'inst1-door');
  assert.equal(fixName('door', 'inst1', 1), 'door-inst1');
  assert.equal(fixName('door', 'inst1', 2), 'door');
  assert.equal(fixName('@global', 'inst1', 0), '@global');
  assert.equal(fixName('!player', 'inst1', 0), '!player');
  assert.equal(fixName('', 'inst1', 0), '');
});

test('collapse: contents placed by origin and angles with new ids, fixups like vbsp, parms and visgroups dropped', () => {
  const { root, max } = instance(), before = V.serialize(root);
  let id = 1000;
  const objs = collapse(root, inst(), () => String(++id));
  assert.equal(V.serialize(root), before, 'the instance is not changed');
  assert.deepEqual(objs.map(o => o.name), ['solid', 'solid', 'entity', 'entity']);
  const ids = []; (function walk(n) { for (const [k, v] of n.kv) if (k === 'id') ids.push(+v); n.children.forEach(walk); })({ kv: [], children: objs });
  assert(ids.every(x => x > 1000) && new Set(ids).size === ids.length && max < 1000, 'fresh unique ids');
  // yaw 90: x -> y; then + origin
  assert.deepEqual(V.bounds(V.faces(objs[1])), [[984, 64, 64], [1016, 160, 96]]);
  assert.deepEqual(V.kids(objs[0], 'editor')[0].kv.map(p => p[0]), ['color', 'visgroupshown', 'visgroupautoshown']);
  const [door, relay] = objs.slice(2), kv = (e, k) => V.get(e, k);
  assert.equal(kv(door, 'targetname'), 'inst1-door');
  assert.equal(kv(relay, 'targetname'), 'inst1-relay');
  assert.equal(kv(relay, 'parentname'), 'inst1-door');
  assert.equal(kv(relay, 'note'), 'a b', '$variables replaced in any value');
  assert.equal(kv(relay, 'origin'), '1000 0 192');
  assert.equal(kv(relay, 'angles'), '0 90 0');
  // the vbsp++ compile of dev/scratch/organize.vmf wrote these into the BSP
  assert.deepEqual(V.kids(relay, 'connections')[0].kv.map(p => p[1]), ['inst1-door\x1bOpen\x1b\x1b0\x1b-1', '@global,Show,,0,-1', 'inst1-door,Enable,,0,-1']);
  assert.equal(V.get(collapse(root, inst({ fixup_style: '1' }), () => String(++id))[2], 'targetname'), 'door-inst1');
  assert.equal(V.get(collapse(root, inst({ fixup_style: '2' }), () => String(++id))[2], 'targetname'), 'door');
});

test('nested instance files: paths relative to the map, InstancePath folders last', () => {
  assert.equal(relTo('D:\\x\\maps', 'D:\\x\\maps\\instances\\sub.vmf'), 'instances/sub.vmf');
  assert.equal(relTo('D:/x/maps/sub', 'D:\\x\\maps\\instances\\sub.vmf'), '../instances/sub.vmf');
  assert.equal(relTo('D:\\x', 'E:\\y\\a.vmf'), 'E:\\y\\a.vmf');
  assert.deepEqual(candidates('D:\\x\\a.vmf', 'b.vmf', ['T:\\tf\\custom\\c\\maps\\instances\\', 'T:\\tf\\maps\\instances\\']), ['D:\\x\\b.vmf', 'T:\\tf\\custom\\c\\maps\\instances\\b.vmf', 'T:\\tf\\maps\\instances\\b.vmf']);
});

test('collapse: hidden objects stay out, FGD angle keys turn, brush origins and overlay faces follow', () => {
  let id = 1;
  const nid = () => String(++id), root = V.parse('versioninfo\n{\n}\nworld\n{\n\t"id" "1"\n\t"classname" "worldspawn"\n}\n'), world = V.kids(root, 'world')[0];
  const b = V.block([0, 0, 0], [64, 64, 16], 'DEV/A', nid), top = V.kids(b, 'side').find(s => V.plane(s).n[2] > 0.9);
  world.children.push(b, { name: 'hidden', kv: [], children: [V.block([0, 0, 64], [8, 8, 72], 'DEV/HIDDEN', nid)] });
  const push = { name: 'entity', kv: [['id', nid()], ['classname', 'trigger_push'], ['pushdir', '0 0 0']], children: [V.block([0, 0, 16], [32, 32, 48], 'TOOLS/TOOLSTRIGGER', nid)] };
  const ov = V.entity('info_overlay', [32, 32, 16], nid);
  ov.kv.push(['sides', `${V.get(top, 'id')} 4242`]);
  root.children.push(push, ov, { name: 'hidden', kv: [], children: [V.entity('info_target', [0, 0, 0], nid)] });
  const types = cls => new Map(cls === 'trigger_push' ? [['pushdir', 'angle'], ['origin', 'origin']] : []);
  const e = inst({ angles: '0 90 0', origin: '256 0 0', file: 'x.vmf' });
  const objs = collapse(root, e, () => String(5000 + ++id), true, types);
  assert.deepEqual(objs.map(o => (o.name === 'solid' ? V.get(V.kids(o, 'side')[0], 'material') : V.get(o, 'classname'))), ['DEV/A', 'trigger_push', 'info_overlay'], 'hidden ones left out');
  const [cb, cp, co] = objs;
  assert.equal(V.get(cp, 'pushdir'), '0 90 0');
  assert.equal(V.get(cp, 'origin'), '256 0 0', 'the push gets the instance origin');
  assert.equal(V.get(co, 'sides'), V.get(V.kids(cb, 'side').find(s => V.plane(s).n[2] > 0.9), 'id'), 'the overlay names the copied face; ids outside the instance go');
});
