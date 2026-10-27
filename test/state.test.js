// node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false } };
const st = await import('../src/state.js');
const { on } = await import('../src/bus.js');
const V = await import('../vmf.js');
const { cfg } = await import('../src/settings.js');

const events = [];
for (const t of ['doc', 'selection', 'filters', 'file']) on(t, d => events.push([t, d]));

test('create, clone+move as one undo step, delete, undo, redo', () => {
  st.load(st.EMPTY, null);
  const empty = st.serialize();
  const b = st.createBlock([0, 0, 0], [64, 64, 64]);
  assert.equal(st.cache.size, 1);
  assert.deepEqual([...st.sel], [b]);
  const one = st.serialize();

  st.cloneSel();
  st.transformSel([1, 1, 1], [64, 0, 0]);
  st.mergeUndo();
  assert.equal(st.cache.size, 2);
  assert.deepEqual(st.selBox(), [[64, 0, 0], [128, 64, 64]]);
  st.undo();
  assert.equal(st.serialize(), one, 'one undo removes clone and move');
  st.redo();
  assert.equal(st.cache.size, 2);

  st.setSelection(st.cache.keys());
  st.deleteSel();
  assert.equal(st.cache.size, 0);
  assert.equal(st.sel.size, 0, 'deleted nodes leave the selection');
  st.undo();
  assert.equal(st.cache.size, 2);
  st.undo(); // selecting both: a step of its own
  assert.equal(st.sel.size, 1);
  st.undo();
  st.undo();
  assert.equal(st.serialize(), empty);
  assert.ok(events.some(([t, d]) => t === 'doc' && d instanceof Set));
});

test('point entity, material, show filters, hide', () => {
  st.load(st.EMPTY, null);
  const e = st.createEntity([0, 0, 0]);
  assert.ok(st.cache.get(e).point);
  const clip = st.createBlock([0, 0, 0], [32, 32, 32]);
  st.applyMaterial('TOOLS/TOOLSPLAYERCLIP');
  assert.ok(V.kids(clip, 'side').every(s => V.get(s, 'material') === 'TOOLS/TOOLSPLAYERCLIP'));
  const vis = () => [...st.cache.values()].filter(c => c.visible).map(c => c.node);

  st.setFilter('clips', false);
  assert.deepEqual(vis(), [e]);
  assert.equal(st.sel.size, 0, 'hidden nodes leave the selection');
  st.setFilter('clips', true);
  st.setFilter('tools', false);
  assert.deepEqual(vis(), [e]);
  st.setFilter('tools', true);
  st.setFilter('entities', false);
  assert.deepEqual(vis(), [clip]);
  st.setFilter('entities', true);

  st.setSelection([clip]);
  st.hideSel();
  assert.deepEqual(vis(), [e]);
  st.unhideAll();
  assert.equal(vis().length, 2);
  assert.ok(events.some(([t]) => t === 'filters'));
});

test('visgroups hide brushes', () => {
  st.load(st.EMPTY, null);
  const b = st.createBlock([0, 0, 0], [16, 16, 16]);
  V.kids(b, 'editor')[0].kv.push(['visgroupid', '7']);
  st.filters.hiddenVisgroups.add('7');
  st.applyFilters();
  assert.equal(st.cache.get(b).visible, false);
});

const MAP = process.env.TEST_MAP; // any .vmf; without it the real-map test is skipped
test('real map: load, move, undo is byte-identical', { skip: !MAP }, () => {
  const text = readFileSync(MAP, 'latin1');
  st.load(text, null);
  assert.equal(st.serialize(), text);
  st.setSelection([[...st.cache.values()].find(c => !c.point).node]);
  st.transformSel([1, 1, 1], [64, 0, 0]);
  assert.notEqual(st.serialize(), text);
  st.undo();
  assert.equal(st.serialize(), text);
});

test('tie, untie, hollow, clip, snap through the selection; undo is byte-identical', () => {
  st.load(st.EMPTY, null);
  const a = st.createBlock([0, 0, 0], [128, 128, 128]), empty = st.serialize();

  st.tieSel('func_detail');
  assert.equal(V.get(st.cache.get(a).owner, 'classname'), 'func_detail');
  st.tieSel('func_brush');
  assert.equal(V.kids(st.doc.root, 'entity').length, 1, 'whole entity selected: class change only');
  assert.equal(V.get(st.cache.get(a).owner, 'classname'), 'func_brush');
  st.untieSel();
  assert.equal(st.cache.get(a).owner, st.doc.world);
  assert.equal(st.serialize(), empty, 'untied back to the world');
  st.undo(); st.undo(); st.undo();
  assert.equal(st.serialize(), empty);

  assert.ok(st.hollowSel(16));
  assert.equal(st.sel.size, 6);
  assert.equal(st.hollowSel(1024), false, 'too thick: nothing changes');
  st.undo();
  assert.equal(st.serialize(), empty);

  st.setSelection([a]);
  st.clipSel([[64, 0, 0], [64, 128, 0], [64, 0, 128]]);
  assert.equal(st.sel.size, 2);
  st.undo();
  assert.equal(st.serialize(), empty);

  st.setSelection([a]);
  st.rotateSel(2, 30);
  st.setGrid(16);
  assert.equal(st.snapSel(), 0);
  for (const c of st.cache.get(a).faces) for (const p of c.pts) assert.ok(p.every(x => x % 16 === 0), `${p} on the 16 grid`);
  st.undo(); st.undo();
  assert.equal(st.serialize(), empty);
});

test('undo keeps node identity: older steps on children and the face selection survive', () => {
  st.load(st.EMPTY, null);
  const e = st.createEntity([0, 0, 0]), conn = { name: 'connections', kv: [['OnUser1', 'a,b,,0,-1']], children: [] };
  st.edit([], [e], () => e.children.unshift(conn));
  const before = st.serialize();
  st.edit([], [conn], () => { conn.kv[0][1] = 'a,b,,5,-1'; }); // details: edit one output
  st.transformSel([1, 1, 1], [0, 0, 64]); // deep snapshot of the entity
  const after = st.serialize();
  st.undo(); st.undo();
  assert.equal(st.serialize(), before);
  st.redo(); st.redo();
  assert.equal(st.serialize(), after);

  const a = st.createBlock([0, 0, 0], [64, 64, 64]), b = st.createBlock([64, 0, 0], [128, 64, 64]);
  st.setSelection([a, b]);
  st.tieSel('func_detail');
  const tied = st.serialize(), owner = st.cache.get(a).owner;
  st.setSelection([a]);
  st.transformSel([1, 1, 1], [0, 0, 64]);
  st.edit([owner], [], () => V.set(owner, 'targetname', 'x')); // outliner visgroup ops snapshot entities deep
  st.undo(); st.undo();
  assert.equal(st.serialize(), tied);

  const side = V.kids(a, 'side')[0];
  st.setFaceSelection([side]);
  st.applyMaterial('DEV/OTHER', { solid: a, side });
  st.undo();
  assert.ok(st.faceSel.has(side) && a.children.includes(side), 'the face stays selected and in the tree');
});

test('deleted nodes cannot be selected again', () => {
  st.load(st.EMPTY, null);
  const e = st.createEntity([0, 0, 0]);
  st.deleteSel();
  st.setSelection([e]);
  st.toggle(e);
  assert.equal(st.sel.size, 0);
});

test('moving or rotating every solid of a brush entity moves its origin; its angles stay', () => {
  st.load(st.EMPTY, null);
  const b = st.createBlock([0, 0, 0], [64, 8, 128]);
  st.tieSel('func_door_rotating');
  const e = st.cache.get(b).owner;
  st.edit([], [e], () => V.set(e, 'origin', '0 4 64')); // the hinge
  st.transformSel([1, 1, 1], [256, 0, 0]);
  assert.equal(V.get(e, 'origin'), '256 4 64');
  st.rotateSel(2, 90); // about the box centre 288 4 64
  assert.equal(V.get(e, 'origin'), '288 -28 64');
  assert.equal(V.get(e, 'angles'), undefined);
});

test('an edit that changes nothing adds no undo step', () => {
  st.load(st.EMPTY, null);
  st.createBlock([0, 0, 0], [64, 64, 64]);
  st.load(st.serialize(), null);
  st.setSelection(st.cache.keys());
  st.untieSel(); // a world brush: nothing to untie
  st.tieSel('func_detail');
  st.tieSel('func_detail'); // already func_detail
  assert.equal(st.S.dirty, true);
  st.undo();
  assert.equal(st.cache.get([...st.sel][0]).owner, st.doc.world, 'one undo reverts the only real change');
  st.undo();
  assert.equal(st.cache.size, 1, 'nothing older to undo');
});

// ---------- Hammer parity fixes ----------
// A func_detail with two solids; H on the first gives entity > hidden > solid.
function hiddenDetail() {
  let id = 1;
  const nid = () => String(++id), root = V.parse(st.EMPTY);
  root.children.push({ name: 'entity', kv: [['id', nid()], ['classname', 'func_detail']], children: [V.block([0, 128, 0], [64, 192, 64], 'DEV/B', nid), V.block([64, 128, 0], [128, 192, 64], 'DEV/B', nid)] });
  st.load(V.serialize(root), null);
  const [e] = st.objects().filter(n => n.name === 'entity'), [d1, d2] = V.kids(e, 'solid');
  st.hide([d1]);
  return { e, d1, d2 };
}
const solidCount = () => (st.serialize().match(/^\s*solid$/gm) || []).length;

test('delete, untie and tie keep the hidden solids of a brush entity', () => {
  let { d2 } = hiddenDetail();
  st.setSelection([d2]);
  st.deleteSel();
  assert.equal(solidCount(), 1, 'delete: the hidden solid stays, in its entity');
  assert.match(st.serialize(), /"classname" "func_detail"/);
  ({ d2 } = hiddenDetail());
  st.setSelection([d2]);
  st.untieSel();
  assert.equal(solidCount(), 2, 'untie: the hidden solid moves to the world with it');
  ({ d2 } = hiddenDetail());
  st.setSelection([d2]);
  st.tieSel('func_brush');
  assert.equal(solidCount(), 2);
});

test('tie writes the FGD defaults (spawnflags, a centred origin) of the new class', () => {
  st.load(st.EMPTY, null);
  st.setEntityDefaults(cls => (cls === 'func_door_rotating' ? [['speed', '100'], ['origin', ''], ['spawnflags', '1']] : []));
  st.createBlock([0, 0, 0], [64, 32, 128]);
  st.tieSel('func_door_rotating');
  const e = st.objects().find(n => n.name === 'entity');
  assert.deepEqual(e.kv.slice(1).map(p => p.join('=')), ['classname=func_door_rotating', 'speed=100', 'origin=32 16 64', 'spawnflags=1']);
  st.setEntityDefaults(() => []);
});

test('a turned brush keeps its own angle in local gizmo space: its own box, pivot and scaling along its own axes', () => {
  cfg.gizmoSpace = 'local';
  st.load(st.EMPTY, null);
  st.createBlock([0, 0, 0], [128, 32, 64]);
  assert.equal(st.selYaw(), 0);
  st.rotateSel(2, 30, [0, 0, 0]);
  const near = (a, b) => a.every((x, i) => Math.abs(x - b[i]) < 1e-3);
  let f = st.selFrame();
  assert.ok(Math.abs(f.yaw - 30) < 1e-6 && near(f.box[0], [0, 0, 0]) && near(f.box[1], [128, 32, 64]), JSON.stringify(f));
  assert.ok(near(st.selPivot(), st.turnZ([64, 16, 32], 30)));
  st.transformSel([2, 1, 1], [0, 0, 0], f.yaw); // twice as long along its own x
  f = st.selFrame();
  assert.ok(Math.abs(f.yaw - 30) < 1e-6 && near(f.box[0], [0, 0, 0]) && near(f.box[1], [256, 32, 64]), JSON.stringify(f));
  cfg.gizmoSpace = 'world'; // world space: the axis-aligned box, the same brush
  assert.equal(st.selFrame().yaw, 0);
  assert.ok(near(st.selFrame().box[0], st.selBox()[0]) && near(st.selFrame().box[1], st.selBox()[1]));
  cfg.gizmoSpace = 'local';
  st.rotateSel(2, 60, [0, 0, 0]); // 90 in all: the local axes keep turning with it (own x along world y), no fold back
  assert.equal(st.selYaw(), 90);
  f = st.selFrame();
  assert.deepEqual(f.box[1].map((x, k) => Math.round(x - f.box[0][k])), [256, 32, 64], 'its own x is still the long side');
  delete cfg.gizmoSpace;
});

test('selection box next to solids counts point entities as their origins (moves stay on the grid)', () => {
  st.load(st.EMPTY, null);
  const off = st.registerPointLook(n => (V.get(n, 'classname') === 'prop_static' ? { box: [[104.3, -30.1, -0.4], [151.7, 30.1, 112.6]] } : null));
  const b = st.createBlock([0, 0, 0], [64, 64, 64]);
  st.cache.clear(); st.sync(); // rebuild with the look
  const p = st.createEntity([128, 0, 0]);
  V.set(p, 'classname', 'prop_static');
  st.touch([p]);
  st.sync();
  st.setSelection([b, p]);
  assert.deepEqual(st.snapRef(), [0, 0, 0]);
  st.setSelection([p]);
  assert.deepEqual(st.selBox().map(c => c.map(x => Math.round(x * 10) / 10)), [[104.3, -30.1, -0.4], [151.7, 30.1, 112.6]], 'alone it keeps its model box');
  off();
});

test('clip and clone move overlays to the new faces', () => {
  let id = 1;
  const nid = () => String(++id), root = V.parse(st.EMPTY), b = V.block([0, 0, 0], [256, 256, 64], 'DEV/A', nid);
  const top = V.kids(b, 'side').find(s => V.plane(s).n[2] > 0.9);
  V.kids(root, 'world')[0].children.push(b);
  const ov = V.entity('info_overlay', [128, 128, 64], nid);
  ov.kv.push(['sides', V.get(top, 'id')]);
  root.children.push(ov);
  st.load(V.serialize(root), null);
  const [solid, o] = st.objects();
  st.setSelection([solid]);
  st.clipSel([[128, 0, 0], [128, 256, 0], [128, 0, 64]]);
  const tops = [...st.sel].map(s => V.get(V.kids(s, 'side').find(x => V.plane(x).n[2] > 0.9), 'id'));
  assert.equal(V.get(o, 'sides'), tops.join(' '), 'both halves of the top');
  st.undo();
  assert.equal(V.get(o, 'sides'), V.get(top, 'id'), 'undo puts the old face back');
  st.setSelection([st.objects()[0], o]);
  st.cloneSel();
  const [cb, co] = [...st.sel];
  assert.equal(V.get(co, 'sides'), V.get(V.kids(cb, 'side').find(x => V.plane(x).n[2] > 0.9), 'id'));
});

test('unhide all gives objects Hammer hid through a visgroup their shown flags back', () => {
  const text = st.EMPTY.replace(/}\n$/, 'hidden\n{\nsolid\n{\n"id" "5"\neditor\n{\n"color" "0 1 2"\n"visgroupid" "3"\n"visgroupshown" "0"\n"visgroupautoshown" "1"\n}\n}\n}\n}\n');
  st.load(text, null);
  const before = st.serialize();
  st.unhideAll();
  assert.match(st.serialize(), /"visgroupshown" "1"\s+"visgroupautoshown" "1"/);
  assert.doesNotMatch(st.serialize(), /hidden/);
  st.undo();
  assert.equal(st.serialize(), before);
});

test('a group holds its members\' visgroups on its block (Hammer); ungroup gives them back', () => {
  st.load(st.EMPTY, null);
  const a = st.createBlock([0, 0, 0], [64, 64, 64]), b = st.createBlock([128, 0, 0], [192, 64, 64]);
  st.edit([a, b], [], () => [a, b].forEach(s => V.kids(s, 'editor')[0].kv.splice(1, 0, ['visgroupid', '4'])));
  const before = st.serialize();
  st.setSelection([a, b]);
  st.groupSel();
  assert.equal(st.serialize().match(/"visgroupid" "4"/g).length, 1, 'once, on the group block');
  assert.deepEqual(V.kids(st.groupOf(a), 'editor')[0].kv.map(p => p[0]), ['color', 'visgroupid', 'visgroupshown', 'visgroupautoshown']);
  st.filters.hiddenVisgroups.add('4');
  st.applyFilters();
  assert.equal([...st.cache.values()].filter(c => c.visible).length, 0, 'hiding the visgroup hides the group');
  st.filters.hiddenVisgroups.clear();
  st.applyFilters();
  st.setSelection([a]);
  st.ungroupSel();
  assert.equal(st.serialize(), before, 'group + ungroup: the same bytes');
});

test('a click selects the outermost of nested groups', () => {
  st.load(st.EMPTY.replace(/}\n$/, 'solid\n{\n"id" "2"\neditor\n{\n"color" "0 1 2"\n"groupid" "5"\n}\n}\nsolid\n{\n"id" "3"\neditor\n{\n"color" "0 1 2"\n"groupid" "7"\n}\n}\ngroup\n{\n"id" "5"\neditor\n{\n"color" "1 1 1"\n"groupid" "7"\n}\n}\ngroup\n{\n"id" "7"\neditor\n{\n"color" "1 1 1"\n}\n}\n}\n'), null);
  // the solids need sides to get cache entries
  for (const s of V.kids(st.doc.world, 'solid')) s.children.unshift(...V.kids(V.block([0, 0, 0], [8, 8, 8], 'DEV/A', () => '9'), 'side'));
  st.cache.clear(); st.sync();
  const [a, b] = V.kids(st.doc.world, 'solid');
  assert.deepEqual(st.withGroup(a), [a, b]);
});

test('replaceSolids: a brush split into pieces gets a group; merged back into one brush, the group goes', () => {
  st.load(st.EMPTY, null);
  st.addObjects([V.block([0, 0, 0], [64, 64, 64], 'DEV/A', st.nextId)]);
  const s = V.kids(st.doc.world, 'solid')[0];
  const a = V.block([0, 0, 0], [32, 64, 64], 'DEV/A', st.nextId), b = V.block([32, 0, 0], [64, 64, 64], 'DEV/A', st.nextId);
  st.replaceSolids([[s, [a, b]]]);
  const pieces = V.kids(st.doc.world, 'solid'), gidOf = n => V.get(V.kids(n, 'editor')[0] ?? { kv: [] }, 'groupid');
  assert.equal(pieces.length, 2);
  assert.ok(gidOf(pieces[0]) && gidOf(pieces[0]) === gidOf(pieces[1]) && V.kids(st.doc.world, 'group').length === 1, 'the pieces are one group');
  st.replaceSolids([[pieces, [V.block([0, 0, 0], [64, 64, 64], 'DEV/A', st.nextId)]]]);
  const left = V.kids(st.doc.world, 'solid');
  assert.equal(left.length, 1);
  assert.ok(!gidOf(left[0]) && !V.kids(st.doc.world, 'group').length, 'no group of one is left');
});

test('a light turned in the editor turns as vrad and Hammer read it: its pitch key follows its angles, and back', async () => {
  const { lightDir } = await import('../src/lighting.js');
  st.load(st.EMPTY, null);
  const spot = V.entity('light_spot', [0, 0, 64], st.nextId), sun = V.entity('light_environment', [0, 0, 512], st.nextId);
  V.set(spot, 'angles', '-45 0 0'); V.set(spot, 'pitch', '-45');
  V.set(sun, 'angles', '-50 30 0'); V.set(sun, 'pitch', '-50');
  st.addObjects([spot, sun]);
  const dir = n => lightDir(V.get(n, 'angles'), +V.get(n, 'pitch') || 0);
  const near = (a, b, msg) => assert.ok(a.every((v, k) => Math.abs(v - b[k]) < 1e-6), `${msg}: ${a} vs ${b}`);
  // turned about each axis (the gizmo, the rotate command): the light goes where the turn takes its direction, and the
  // pitch key equals the angles pitch (Hammer)
  for (const [axis, deg] of [[2, 90], [1, 45], [0, 30], [1, -60]]) {
    const before = dir(spot), m = V.rotation(axis, deg), after = m.map(r => r[0] * before[0] + r[1] * before[1] + r[2] * before[2]);
    st.edit([spot], [], () => V.rotate(spot, [0, 0, 64], axis, deg));
    near(dir(spot), after, `axis ${axis} by ${deg}`);
    assert.equal(+V.get(spot, 'pitch'), V.nums(V.get(spot, 'angles'))[0], 'pitch key = angles pitch');
  }
  // straight down from forward-down 45: about y by 45
  V.set(spot, 'angles', '-45 0 0'); V.set(spot, 'pitch', '-45');
  st.edit([spot], [], () => V.rotate(spot, [0, 0, 64], 1, 45));
  near(dir(spot), [0, 0, -1], 'pointing down');
  // typed in the properties: angles move the key, the key moves the angles
  st.edit([sun], [], () => V.set(sun, 'angles', '-30 90 0'));
  assert.equal(V.get(sun, 'pitch'), '-30');
  st.edit([sun], [], () => V.set(sun, 'pitch', '-70'));
  assert.equal(V.get(sun, 'angles'), '-70 90 0');
  near(dir(sun), [0, Math.cos(70 * Math.PI / 180), -Math.sin(70 * Math.PI / 180)], 'sun 70 down, toward +y');
  // a light without a pitch key gets one when its pitch turns
  const bare = V.entity('light_spot', [64, 0, 64], st.nextId);
  V.set(bare, 'angles', '-90 0 0');
  st.addObjects([bare]);
  st.edit([bare], [], () => V.set(bare, 'angles', '-60 0 0'));
  assert.equal(V.get(bare, 'pitch'), '-60');
  // other entities turn as Source angles (positive pitch down), no pitch key
  const prop = V.entity('prop_static', [0, 64, 0], st.nextId);
  V.set(prop, 'angles', '0 0 0');
  st.addObjects([prop]);
  st.edit([prop], [], () => V.rotate(prop, [0, 64, 0], 1, 30));
  assert.equal(V.get(prop, 'angles'), '30 0 0');
  assert.equal(V.get(prop, 'pitch'), undefined);
});

test('selection changes are undo steps; an edit puts back the selection it had before and after', async () => {
  const tick = () => new Promise(r => setTimeout(r, 0));
  st.load(st.EMPTY, null);
  await tick();
  const a = st.createBlock([0, 0, 0], [64, 64, 64]), b = st.createBlock([128, 0, 0], [192, 64, 64]);
  await tick();
  assert.deepEqual([...st.sel], [b]);
  st.setSelection([]); st.setSelection([a]); // one task: one step
  await tick();
  st.setSelection([a, b]);
  await tick();
  const dirty = st.S.dirty;
  st.undo();
  assert.deepEqual([...st.sel], [a]);
  st.undo();
  assert.deepEqual([...st.sel], [b]);
  assert.equal(st.S.dirty, dirty, 'a selection step leaves the map as it was');
  st.undo(); // the second block: the selection goes back to the first block
  assert.ok(!st.cache.has(b));
  assert.deepEqual([...st.sel], [a]);
  st.redo();
  assert.deepEqual([...st.sel], [b]);
  st.redo(); st.redo();
  assert.deepEqual([...st.sel], [a, b]);
  st.undo();
  st.setSelection([b]); // a new selection after an undo drops the redo steps, as an edit does
  await tick();
  st.redo();
  assert.deepEqual([...st.sel], [b]);
});

test('the grid size goes to settings (next session starts on it) and stays within 1-1024', () => {
  st.setGrid(8);
  assert.equal(st.S.grid, 8);
  assert.equal(cfg.grid, 8);
  st.setGrid(4096);
  assert.equal(cfg.grid, 1024);
  st.setGrid(64);
});
