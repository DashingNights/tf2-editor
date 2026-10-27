// node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false } };
const st = await import('../src/state.js');
const O = await import('../src/outliner.js');
const V = await import('../vmf.js');

const leaves = model => model.flatMap(g => g.kids);

test('visgroup create, assign, rename, delete; undo restores the text', () => {
  st.load(st.EMPTY, null);
  const a = st.createBlock([0, 0, 0], [64, 64, 64]), b = st.createBlock([128, 0, 0], [192, 64, 64]);
  const before = st.serialize();
  st.setSelection([a]);
  const id = O.createVisgroup('Walls "x"');
  const text = st.serialize();
  assert.match(text, /\nvisgroups\n\{\n\tvisgroup\n\t\{\n\t\t"name" "Walls x"\n\t\t"visgroupid" "1"\n\t\t"color" "\d+ \d+ \d+"\n\t\}\n\}\nworld\n/);
  assert.deepEqual(V.kids(a, 'editor')[0].kv.map(p => p[0]), ['color', 'visgroupid', 'visgroupshown', 'visgroupautoshown']);
  assert.deepEqual(O.vgIds(a), [id]);

  st.setSelection([b]);
  O.assign(id, true);
  assert.deepEqual(O.vgIds(b), [id]);
  O.assign(null, false);
  assert.deepEqual(O.vgIds(b), []);

  O.renameVisgroup(id, 'Floors');
  assert.equal(O.visgroups()[0].name, 'Floors');
  st.setSelection([]);
  const child = O.createVisgroup('Child');
  // nest Child under Floors by hand, then delete Floors: Child moves up, a leaves the group
  const [f, c] = O.visgroups().map(g => g.node), blk = V.kids(st.doc.root, 'visgroups')[0];
  blk.children.splice(blk.children.indexOf(c), 1);
  f.children.push(c);
  assert.equal(O.visgroups()[1].path, 'Floors / Child');
  O.deleteVisgroup(id);
  assert.deepEqual(O.visgroups().map(g => [g.id, g.depth]), [[child, 0]]);
  assert.deepEqual(O.vgIds(a), []);

  for (let i = 0; i < 6; i++) st.undo();
  assert.equal(st.serialize(), before);
});

test('tree groups world solids by visgroup and entities by class', () => {
  st.load(st.EMPTY, null);
  const a = st.createBlock([0, 0, 0], [64, 64, 64]);
  st.createBlock([128, 0, 0], [192, 64, 64]);
  st.createEntity([0, 0, 0]);
  st.setSelection([a]);
  const id = O.createVisgroup('Walls');
  const model = O.buildTree();
  assert.deepEqual(model.map(g => [g.label, g.count]), [['World', 2], ['Entities', 1]]);
  assert.deepEqual(leaves(model).map(g => [g.label, g.count, g.vg]), [['Walls', 1, id], ['Ungrouped', 1, undefined], ['info_player_teamspawn', 1, undefined]]);

  const closed = O.flatten(model, new Set(['w', 'e']), '');
  assert.deepEqual(closed.map(r => (r.it ? 'item' : r.g.label)), ['World', 'Walls', 'Ungrouped', 'Entities', 'info_player_teamspawn']);
  const found = O.flatten(model, new Set(), 'teamspawn');
  assert.deepEqual(found.map(r => (r.it ? r.it.label : `${r.g.label}:${r.g.n}`)), ['Entities:1', 'info_player_teamspawn:1', 'info_player_teamspawn']);

  const ent = [...st.cache.values()].find(c => c.point).node;
  assert.deepEqual(O.pathTo(model, a), ['w', `w/${id}`]);
  assert.deepEqual(O.pathTo(model, ent), ['e', 'e/info_player_teamspawn']);
  assert.equal(O.pathTo(model, { name: 'solid' }), undefined);
});

const MAP = process.env.TEST_MAP; // any .vmf; without it the real-map test is skipped
test('real map: counts add up to the cache; visgroup create + undo is byte-identical', { skip: !MAP }, () => {
  const text = readFileSync(MAP, 'latin1');
  st.load(text, null);
  const model = O.buildTree(), [world, ents] = model;
  const worldSolids = [...st.cache.values()].filter(c => c.owner === st.doc.world).length;
  assert.equal(world.count, worldSolids);
  assert.equal(leaves([ents]).reduce((s, g) => s + g.items.reduce((t, it) => t + it.nodes.length, 0), 0), st.cache.size - worldSolids);

  const t0 = performance.now();
  O.flatten(model, new Set(['w', 'e', ...leaves(model).map(g => g.key)]), '');
  assert.ok(performance.now() - t0 < 200, 'flatten stays fast');

  st.setSelection([...st.cache.keys()].slice(0, 50));
  O.createVisgroup('Test');
  assert.notEqual(st.serialize(), text);
  st.undo();
  assert.equal(st.serialize(), text);
});
