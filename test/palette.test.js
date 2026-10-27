// node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false } };
const C = await import('../src/commands.js');
const st = await import('../src/state.js');
const V = await import('../vmf.js');
const { cfg } = await import('../src/settings.js');

test('fuzzy tiers: prefix > word start > substring > scattered', () => {
  const s = q => ['Select all', 'Hide selection', 'Isolate selection (hide the rest)', 'Unhide all'].map(t => [t, C.fuzzy(q, t)]).filter(x => x[1] >= 0).sort((a, b) => b[1] - a[1]).map(x => x[0]);
  assert.deepEqual(s('hide'), ['Hide selection', 'Isolate selection (hide the rest)', 'Unhide all']);
  assert.deepEqual(s('sel'), ['Select all', 'Hide selection', 'Isolate selection (hide the rest)']);
  assert.ok(C.fuzzy('all', 'Select all') > C.fuzzy('all', 'Smallest'));
});

test('palette: recent first, > prefix ignored, unavailable greyed and last', () => {
  C.register('t.on', { title: 'Zebra on', run() {} });
  C.register('t.off', { title: 'Zebra off', when: () => false, run() {} });
  cfg.recent = ['t.off', 't.on', 'gone'];
  const top = C.paletteItems('').slice(0, 2);
  assert.deepEqual(top.map(x => [x.c.id, x.recent, x.ok]), [['t.on', true, true], ['palette', false, true]]);
  const all = C.paletteItems(''), off = all.findIndex(x => x.c.id === 't.off');
  assert.ok(!all[off].ok && all.slice(off).every(x => !x.ok), 'unavailable recent drops below available ones');
  assert.deepEqual(C.paletteItems('> zebra').map(x => [x.c.id, x.ok]), [['t.on', true], ['t.off', false]]);
  const ids = C.list().map(c => c.id);
  for (const id of ['select.all', 'select.invert', 'select.sameMaterial', 'select.sameClass', 'hide.selected', 'hide.unhideAll', 'hide.isolate', 'layout.toggle2d', 'view.maximize']) assert.ok(ids.includes(id), id);
  delete cfg.recent;
});

test('select all / invert / same class / same material; isolate', () => {
  st.load(st.EMPTY, null);
  const a = st.createBlock([0, 0, 0], [64, 64, 64]), b = st.createBlock([128, 0, 0], [192, 64, 64]), e = st.createEntity([0, 0, 0]);
  st.setSelection([a]);
  st.applyMaterial('TOOLS/TOOLSNODRAW');
  st.applyMaterial('BRICK/A', { solid: a, side: V.kids(a, 'side')[0] });
  st.applyMaterial('TOOLS/TOOLSNODRAW', { solid: b, side: V.kids(b, 'side')[0] });

  C.run('select.sameMaterial');
  assert.deepEqual([...st.sel], [a], 'nodraw alone does not match b');
  C.run('select.invert');
  assert.deepEqual([...st.sel], [b, e]);
  st.setSelection([b]);
  C.run('select.sameClass');
  assert.deepEqual([...st.sel], [a, b]);
  st.setFaceSelection([V.kids(a, 'side')[1]]);
  C.run('select.sameMaterial');
  assert.equal(st.faceSel.size, 6, '5 nodraw faces of a and 1 of b');
  st.clearSelection();
  C.run('select.all');
  assert.equal(st.sel.size, 3);

  st.setSelection([e]);
  C.run('hide.isolate');
  assert.deepEqual([...st.cache.values()].filter(c => c.visible).map(c => c.node), [e]);
  C.run('hide.unhideAll');
  assert.equal([...st.cache.values()].filter(c => c.visible).length, 3);
});
