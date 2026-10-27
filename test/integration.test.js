// node --test "test/*.test.js" - state.js hooks added when the feature modules were integrated.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false } };
const st = await import('../src/state.js');
const V = await import('../vmf.js');
const { cfg } = await import('../src/settings.js');

// World solids a, b; point entity e; func_door d with solids d1, d2.
function map() {
  let id = 1;
  const nid = () => String(++id), root = V.parse(st.EMPTY), world = V.kids(root, 'world')[0];
  world.children.push(...[0, 128].map(x => V.block([x, 0, 0], [x + 64, 64, 64], 'DEV/A', nid)));
  const d = { name: 'entity', kv: [['id', nid()], ['classname', 'func_door']], children: [V.block([0, 128, 0], [64, 192, 64], 'DEV/B', nid), V.block([64, 128, 0], [128, 192, 64], 'DEV/B', nid)] };
  root.children.push(V.entity('info_target', [0, -128, 0], nid), d);
  return V.serialize(root);
}
const TEXT = map();
const nodes = () => {
  const [a, b] = st.objects().filter(n => n.name === 'solid'), [e, d] = st.objects().filter(n => n.name === 'entity');
  return { a, b, e, d, d1: V.kids(d, 'solid')[0], d2: V.kids(d, 'solid')[1] };
};

test('a click on a brush entity solid selects the whole entity unless groups are ignored', () => {
  st.load(TEXT, null);
  const { a, d, d1, d2 } = nodes();
  st.clickSelect(d1, false);
  assert.deepEqual([...st.sel], [d1, d2]);
  assert.deepEqual(st.movable(), [d], 'the entity stands in for its solids');
  st.clickSelect(a, false);
  assert.deepEqual([...st.sel], [a]);
  cfg.ignoreGroups = true;
  st.clickSelect(d2, false);
  assert.deepEqual([...st.sel], [d2]);
  cfg.ignoreGroups = false;
});

test('deleting every member of a group removes its group block; undo brings both back', () => {
  st.load(TEXT, null);
  const { a, b } = nodes();
  st.setSelection([a, b]);
  st.groupSel();
  const grouped = st.serialize();
  st.setSelection([a, b]);
  st.deleteSel();
  assert.equal(V.kids(st.doc.world, 'group').length, 0);
  st.undo();
  assert.equal(st.serialize(), grouped);
});

test('point looks give point entities their box and colour; touch rebuilds them later', async () => {
  st.load(TEXT, null);
  const { e } = nodes();
  assert.deepEqual(st.cache.get(e).min, [-8, -136, -8], 'the default 16-unit box');
  let big = false;
  const off1 = st.registerPointLook(n => (big && n === e ? { box: [[-32, -160, 0], [32, -96, 0]] } : null));
  const off2 = st.registerPointLook(() => ({ box: [[0, 0, 0], [1, 1, 1]], color: 'rgb(1,2,3)' }));
  big = true;
  st.touch([e]);
  await new Promise(r => setTimeout(r, 10));
  const c = st.cache.get(e);
  assert.deepEqual([c.min, c.max], [[-32, -160, -1], [32, -96, 1]], 'the first box wins, made 2 units thick');
  assert.equal(c.color2d, 'rgb(1,2,3)', 'a colour from a later look');
  st.setSelection([e]);
  assert.deepEqual(st.selPivot(), [0, -128, 0], 'a point entity pivots at its origin, not its box centre');
  assert.deepEqual(st.snapRef(), [0, -128, 0]);
  st.rotateSel(2, 90);
  assert.equal(V.get(e, 'origin'), '0 -128 0');
  off1();
  off2();
});

test('new entities get the keys of setEntityDefaults before origin', () => {
  st.load(TEXT, null);
  st.setEntityDefaults(cls => (cls === 'prop_static' ? [['solid', '6'], ['origin', 'x'], ['skin', '0']] : []));
  cfg.cls = 'prop_static';
  const e = st.createEntity([1, 2, 3]);
  assert.deepEqual(e.kv.map(p => p[0]), ['id', 'classname', 'solid', 'skin', 'origin']);
  st.setEntityDefaults(() => []);
});
