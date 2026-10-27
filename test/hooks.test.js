// node --test "test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false } };
const st = await import('../src/state.js');
const V = await import('../vmf.js');
const { cfg } = await import('../src/settings.js');

// World solids a, b, c; point entity e; func_detail d with solids d1, d2. Plus the root blocks Hammer writes.
const EXTRA = 'cameras\n{\n\t"activecamera" "0"\n\tcamera\n\t{\n\t\t"position" "[0 0 64]"\n\t\t"look" "[0 256 64]"\n\t}\n}\n'
  + 'cordons\n{\n\t"active" "1"\n\tcordon\n\t{\n\t\t"name" "c1"\n\t\t"active" "1"\n\t\tbox\n\t\t{\n\t\t\t"mins" "(-64 -64 -64)"\n\t\t\t"maxs" "(64 64 64)"\n\t\t}\n\t}\n}\n'
  + 'cordon\n{\n\t"mins" "(-1 -1 -1)"\n\t"maxs" "(1 1 1)"\n\t"active" "0"\n}\ninstances\n{\n}\nsomething_new\n{\n\t"k" "v"\n\tinner\n\t{\n\t}\n}\n';
function plainMap() {
  let id = 1;
  const nid = () => String(++id), root = V.parse(st.EMPTY), world = V.kids(root, 'world')[0];
  world.children.push(...[0, 128, 256].map(x => V.block([x, 0, 0], [x + 64, 64, 64], 'DEV/A', nid)));
  const d = { name: 'entity', kv: [['id', nid()], ['classname', 'func_detail']], children: [V.block([0, 128, 0], [64, 192, 64], 'DEV/B', nid), V.block([64, 128, 0], [128, 192, 64], 'DEV/B', nid)] };
  root.children.push(V.entity('info_target', [0, -128, 0], nid), d);
  return V.serialize(root) + EXTRA;
}
const PLAIN = plainMap();
const nodes = () => {
  const { root, world } = st.doc, [d1, d2] = st.objects().filter(n => n.name === 'entity')[1].children.flatMap(c => (c.name === 'hidden' ? c.children : [c]));
  const [a, b, c] = st.objects().filter(n => n.name === 'solid'), [e, d] = st.objects().filter(n => n.name === 'entity');
  return { root, world, a, b, c, e, d, d1, d2 };
};
const wrap = (list, n) => list.splice(list.indexOf(n), 1, { name: 'hidden', kv: [], children: [n] });

test('unknown and Hammer root blocks (cameras, cordons, cordon, instances) load and round-trip', () => {
  st.load(PLAIN, null);
  assert.equal(st.serialize(), PLAIN);
  assert.equal(st.cache.size, 6);
});

test('hidden wrappers load hidden; unhide all and hide again are byte-identical to Hammer\'s layout', () => {
  st.load(PLAIN, null);
  let { root, world, b, e, d, d2 } = nodes();
  wrap(world.children, b);
  wrap(root.children, e);
  wrap(d.children, d2);
  const HIDDEN = st.serialize();
  assert.match(HIDDEN, /\n\thidden\n\t\{\n\t\tsolid\n/, 'world > hidden > solid');
  assert.match(HIDDEN, /\nhidden\n\{\n\tentity\n/, 'root > hidden > entity');

  st.load(HIDDEN, null);
  assert.equal(st.serialize(), HIDDEN, 'unchanged map stays byte-identical');
  ({ b, e, d2 } = nodes());
  assert.deepEqual(new Set(st.filters.hidden), new Set([b, e, d2]));
  assert.deepEqual([...st.cache.values()].filter(c => !c.visible).map(c => c.node).sort(), [b, e, d2].sort());
  assert.equal(st.cache.get(d2).owner, nodes().d, 'a hidden solid keeps its entity as owner');

  st.unhideAll();
  assert.equal(st.serialize(), PLAIN);
  assert.equal(st.filters.hidden.size, 0);
  st.undo();
  assert.equal(st.serialize(), HIDDEN);
  assert.equal(st.filters.hidden.size, 3, 'undo hides them again');
  st.redo();
  assert.equal(st.serialize(), PLAIN);

  st.setSelection([b, e, d2]);
  st.hideSel();
  assert.equal(st.serialize(), HIDDEN, 'hide wraps in place');
  assert.equal(st.sel.size, 0, 'hidden nodes leave the selection');
  st.undo();
  assert.equal(st.serialize(), PLAIN);
  assert.equal(st.filters.hidden.size, 0);

  const { d1 } = nodes();
  st.setSelection([d1, d2]);
  st.hideSel();
  assert.match(st.serialize(), /\nhidden\n\{\n\tentity\n\t\{\n\t\t"id" "\d+"\n\t\t"classname" "func_detail"/, 'a whole brush entity is wrapped as one');
  st.unhideAll();
  assert.equal(st.serialize(), PLAIN);
});

test('groups: Ctrl+G, group-aware clicks, ignore groups, ungroup and undo are byte-identical', () => {
  st.load(PLAIN, null);
  const { world, a, c, e } = nodes();
  st.setSelection([a, e]);
  const id = st.groupSel();
  const GROUPED = st.serialize();
  assert.deepEqual(st.groups().get(id), [a, e]);
  assert.deepEqual(V.kids(a, 'editor')[0].kv.map(p => p[0]), ['color', 'groupid', 'visgroupshown', 'visgroupautoshown']);
  const g = world.children.at(-1);
  assert.equal(V.serialize({ kv: [], children: [g], eol: '\n' }), `group\n{\n\t"id" "${id}"\n\teditor\n\t{\n\t\t"color" "220 220 220"\n\t\t"visgroupshown" "1"\n\t\t"visgroupautoshown" "1"\n\t}\n}\n`);

  const selected = () => new Set(st.sel);
  st.clickSelect(a, false);
  assert.deepEqual(selected(), new Set([a, e]), 'a click on a member selects the group');
  st.clickSelect(c, true);
  assert.deepEqual(selected(), new Set([a, e, c]));
  st.clickSelect(e, true);
  assert.deepEqual(selected(), new Set([c]), 'ctrl on a selected member removes the group');
  st.clickSelect(null, true);
  assert.deepEqual(selected(), new Set([c]));
  st.clickSelect(null, false);
  assert.equal(st.sel.size, 0);
  cfg.ignoreGroups = true;
  st.clickSelect(a, false);
  assert.deepEqual(selected(), new Set([a]));
  cfg.ignoreGroups = false;

  st.ungroupSel();
  assert.equal(st.serialize(), PLAIN, 'ungroup removes the groupid keys and the group block');
  st.undo();
  assert.equal(st.serialize(), GROUPED);
  st.undo();
  assert.equal(st.serialize(), PLAIN);
  st.redo();
  assert.equal(st.serialize(), GROUPED);
});

test('regrouping drops emptied groups; clones of a group form a new group', () => {
  st.load(PLAIN, null);
  const { a, b, c } = nodes();
  st.setSelection([a, b]);
  const g1 = st.groupSel();
  st.setSelection([a, b, c]);
  const g2 = st.groupSel();
  assert.deepEqual([...st.groups().keys()], [g2], 'the emptied group is gone');

  st.setSelection([a, b]);
  st.cloneSel();
  const clones = [...st.sel], gs = st.groups();
  assert.equal(gs.size, 2);
  assert.notEqual(g1, g2);
  st.clickSelect(clones[0], false);
  assert.deepEqual(new Set(st.sel), new Set(clones), 'clones select apart from the originals');
  st.undo();
  assert.deepEqual([...st.groups().keys()], [g2]);
});

test('registerPanel before mount joins the panel list and adds its Window command', async () => {
  const L = await import('../src/layout.js');
  const C = await import('../src/commands.js');
  const element = {};
  L.registerPanel({ id: 'dummy', title: 'Dummy', element, near: 'compile' });
  assert.deepEqual(L.PANELS.at(-1), { id: 'dummy', title: 'Dummy', minimumWidth: 260, minimumHeight: 120, near: ['compile', 'center'] });
  assert.equal(L.pane('dummy'), element);
  await new Promise(r => setTimeout(r, 50)); // the command is registered after a dynamic import
  assert.ok(C.list().some(c => c.id === 'panel.dummy' && c.title === 'Window: Dummy'));
});
