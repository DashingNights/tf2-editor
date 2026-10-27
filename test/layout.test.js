// node --test "test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false } };
const L = await import('../src/layout.js');
const C = await import('../src/commands.js');

const ids = L.PANELS.map(p => p.id);
const leaves = n => (n.type === 'leaf' ? [n] : n.data.flatMap(leaves));

test('default layout JSON: the viewports with the tool panels round them, every panel in it once, Compile closed', () => {
  const d = L.defaultLayout(), views = leaves(d.grid.root).flatMap(l => l.data.views);
  assert.equal(new Set(views).size, views.length, 'no panel twice');
  for (const id of ['3d', 'top', 'front', 'side', 'details', 'outliner', 'textures', 'tools', 'tools-main']) assert.ok(views.includes(id), id);
  assert.ok(!views.includes('compile'), 'Compile starts closed');
  assert.deepEqual(Object.keys(d.panels).sort(), [...views].sort(), 'a panel entry for each tab');
  assert.ok(leaves(d.grid.root).every(l => l.size > 0 && l.data.views.includes(l.data.activeView)));
  // a fresh copy each time: changing one leaves the default as it was
  d.grid.root.data.length = 0;
  assert.ok(leaves(L.defaultLayout().grid.root).length > 4);
});

// Stand-in for DockviewApi: fromJSON loads the panel ids it is given, or throws on { bad: true }.
function fake() {
  const panels = new Set();
  return {
    width: 1600, height: 900, loads: [],
    fromJSON(d) {
      if (d.bad) throw new Error('bad layout');
      this.loads.push(d);
      panels.clear();
      for (const id of Object.keys(d.panels)) panels.add(id);
    },
    getPanel: id => panels.has(id) || undefined,
  };
}
const all = Object.fromEntries(ids.map(id => [id, {}]));

test('restore: a good or partial layout is kept as saved; missing, throwing or viewport-less layouts fall back to the default', () => {
  let a = fake();
  const good = { panels: all };
  assert.equal(L.restore(a, good), true);
  assert.deepEqual(a.loads, [good]);

  const isDefault = a => assert.deepEqual(a.loads.at(-1), L.defaultLayout(1600, 900));
  a = fake();
  assert.equal(L.restore(a, undefined), false);
  isDefault(a);

  const warn = console.warn;
  console.warn = () => {};
  a = fake();
  assert.equal(L.restore(a, { bad: true, panels: all }), false);
  console.warn = warn;
  isDefault(a);

  a = fake();
  const { compile, textures, ...partial } = all, closed = { panels: partial };
  assert.equal(L.restore(a, closed), true, 'closed panels stay closed');
  assert.deepEqual(a.loads, [closed]);

  a = fake();
  assert.equal(L.restore(a, { panels: { details: {}, outliner: {} } }), false);
  isDefault(a);
});

test('constrain: a group takes the largest minimum of its tabs, and relayouts on a change or a group below its minimum', () => {
  const group = (...ids) => {
    const g = { panels: ids.map(id => ({ id })), minimumWidth: 100, minimumHeight: 100, width: 400, height: 400, calls: 0 };
    g.api = { location: { type: 'grid' }, setConstraints: c => { g.calls++; Object.assign(g, c); } };
    return g;
  };
  const a = { width: 1600, height: 900, groups: [group('outliner', 'details'), group('3d'), group()], layouts: 0, layout() { this.layouts++; } };
  L.constrain(a);
  assert.deepEqual(a.groups.map(g => [g.minimumWidth, g.minimumHeight, g.calls]), [[344, 120, 2], [200, 150, 2], [100, 100, 0]]);
  assert.equal(a.layouts, 1);
  L.constrain(a);
  assert.equal(a.layouts, 1, 'nothing changed');
  a.groups[1].width = 100; // a new split right of another group starts at 100 px
  L.constrain(a);
  assert.equal(a.layouts, 2);
  assert.equal(a.groups[1].calls, 2, 'constraints already set');
});

test('layout commands are registered', () => {
  const have = C.list().map(c => c.id);
  for (const id of ['layout.reset', 'layout.toggle2d', 'view.maximize', ...ids.map(id => 'panel.' + id)]) assert.ok(have.includes(id), id);
  assert.deepEqual(C.list().find(c => c.id === 'view.maximize').keys, ['alt+enter']);
});

test('panel zoom steps by tenths between 60 % and 200 %', () => {
  assert.equal(L.nextZoom(1, 0.1), 1.1);
  assert.equal(L.nextZoom(1.1, 0.1), 1.2); // no 1.2000000000000002
  assert.equal(L.nextZoom(0.6, -0.1), 0.6);
  assert.equal(L.nextZoom(2, 0.1), 2);
});

test('window resizes: beside a viewport the other panes keep their size, a split without one stays proportional', () => {
  assert.deepEqual(L.keepSizes([0.2, 0.5, 0.3], [false, true, false]), [undefined, 0.5, undefined]);
  assert.deepEqual(L.keepSizes([0.4, 0.6], [false, false]), [0.4, 0.6]);
  assert.equal(L.keepSizes(undefined, [true]), undefined);
});
