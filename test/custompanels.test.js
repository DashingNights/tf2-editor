// Custom panels (src/custompanels.js) and kept views (src/viewstate.js): the data operations.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false } };
const CP = await import('../src/custompanels.js');
const VS = await import('../src/viewstate.js');

const panels = () => [
  { id: '1', title: 'A', sections: [{ title: 'S1', items: [{ cmd: 'a' }, { cmd: 'b' }, { cmd: 'c' }] }, { title: 'S2', items: [{ slot: 'poly' }] }] },
  { id: '2', title: 'B', sections: [{ title: 'T1', items: [] }] },
];
const cmds = (ps, p, s) => ps.find(x => x.id === p).sections[s].items.map(x => x.cmd ?? x.slot ?? x.rollout);

test('short labels drop the group prefix and the toggle note', () => {
  assert.equal(CP.shortLabel('Mirror: plane through the selection centre'), 'Plane through the selection centre');
  assert.equal(CP.shortLabel('Snap: toggle grid snapping'), 'Toggle grid snapping');
  assert.equal(CP.shortLabel('Select: ignore groups (toggle)'), 'Ignore groups');
  assert.equal(CP.shortLabel('Copy'), 'Copy');
});

test('items move within a section, between panels, insert, and leave the input as it was', () => {
  const ps = panels();
  assert.deepEqual(cmds(CP.moveItem(ps, ['1', 0, 0], ['1', 0, 3]), '1', 0), ['b', 'c', 'a']); // to the end of its own section
  assert.deepEqual(cmds(CP.moveItem(ps, ['1', 0, 2], ['1', 0, 0]), '1', 0), ['c', 'a', 'b']);
  const m = CP.moveItem(ps, ['1', 0, 1], ['2', 0, Infinity]);
  assert.deepEqual([cmds(m, '1', 0), cmds(m, '2', 0)], [['a', 'c'], ['b']]);
  assert.deepEqual(cmds(CP.moveItem(ps, null, ['2', 0, 0], { cmd: 'x' }), '2', 0), ['x']);
  assert.deepEqual(cmds(CP.removeItem(ps, ['1', 0, 1]), '1', 0), ['a', 'c']);
  assert.deepEqual(cmds(ps, '1', 0), ['a', 'b', 'c'], 'the input is not changed');
  assert.equal(CP.newId(ps), '3');
});

test("a tool's option bar lives in one place: adding it elsewhere takes it out of the other section", () => {
  const m = CP.moveItem(panels(), null, ['2', 0, 0], { slot: 'poly' });
  assert.deepEqual([cmds(m, '1', 1), cmds(m, '2', 0)], [[], ['poly']]);
});

test('kept views: the map used last goes last, only the newest 20 stay', () => {
  let v = {};
  for (let i = 0; i < 25; i++) v = VS.remember(v, `m${i}.vmf`, { i });
  assert.equal(Object.keys(v).length, 20);
  assert.equal(Object.keys(v)[0], 'm5.vmf');
  v = VS.remember(v, 'm5.vmf', { i: 'again' });
  assert.equal(Object.keys(v).at(-1), 'm5.vmf');
  assert.equal(v['m5.vmf'].i, 'again');
});

test('Window: buttons put in a custom panel become tabs of its own dock (other buttons stay)', () => {
  const q = [], ps = CP.asTabs([{ id: '1', title: 'A', sections: [{ title: 'S', items: [{ cmd: 'panel.textures' }, { cmd: 'select.all' }, { cmd: 'panel.custom-2' }, { cmd: 'panel.outliner' }] }] }], q);
  assert.deepEqual(ps[0].sections[0].items.map(x => x.cmd), ['select.all', 'panel.custom-2']);
  assert.deepEqual(q, [['1', 'textures'], ['1', 'outliner']]);
});
