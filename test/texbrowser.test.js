// node --test "test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false } };
const T = await import('../src/texbrowser.js');

const NAMES = ['brick/brickwall001', 'concrete/measure_dev', 'dev/dev_blendmeasure', 'dev/dev_measuregeneric01b', 'dev/dev_measurewall01a', 'dev/reflectivity_50', 'nature/dirtfloor001a', 'tools/toolsnodraw', 'tools/toolsplayerclip'];

test('search: every word must match; prefix, then word start, then substring, then scattered letters', () => {
  const r = T.search('dev measure', NAMES);
  assert.deepEqual(r.slice(0, 3), ['dev/dev_measurewall01a', 'dev/dev_measuregeneric01b', 'dev/dev_blendmeasure'], 'prefix + word start (shorter first), then substring');
  assert.ok(!r.includes('brick/brickwall001'), 'a word that does not match drops the name');
  assert.deepEqual(T.search('nodraw', NAMES), ['tools/toolsnodraw'], 'matches inside the full path');
  assert.equal(T.search('tools/', NAMES).length, 2);
  assert.ok(T.score('measure', 'dev/dev_measurewall01a') > T.score('measure', 'dev/dev_blendmeasure'));
  assert.ok(T.score('dmg', 'dev/dev_measuregeneric01b') >= 0, 'scattered letters still match');
  assert.equal(T.score('  ', 'x'), 0, 'blank query matches everything');
});

test('buildTree: folders with counts including subfolders', () => {
  const t = T.buildTree(['a/b/c', 'a/b/d', 'a/e', 'f', 'g/h']);
  assert.equal(t.count, 5);
  assert.deepEqual([...t.kids.keys()], ['a', 'g']);
  const a = t.kids.get('a');
  assert.deepEqual([a.path, a.count, a.kids.get('b').path, a.kids.get('b').count], ['a/', 3, 'a/b/', 2]);
  assert.equal(t.kids.get('g').count, 1);
  assert.equal(T.buildTree([]).kids.size, 0);
});

test('materials.addLoose: a file written after indexing joins the list', async () => {
  const M = await import('../src/materials.js');
  assert.deepEqual(await M.listMaterials(), [], 'no TF2 folder in the test');
  M.addLoose('materials/Custom/New.vmt', 'X:\\tf\\custom\\p\\materials\\custom\\new.vmt');
  assert.deepEqual(await M.listMaterials(), ['custom/new']);
});

test('filter predicates', () => {
  const ctx = { used: new Set(['brick/brickwall001']), recent: new Set(['dev/reflectivity_50']), favs: new Set(['nature/dirtfloor001a']), custom: new Set(['concrete/measure_dev']) };
  const by = f => NAMES.filter(n => T.FILTERS[f][1](n, ctx));
  assert.equal(by('all').length, NAMES.length);
  assert.deepEqual(by('used'), ['brick/brickwall001']);
  assert.deepEqual(by('recent'), ['dev/reflectivity_50']);
  assert.deepEqual(by('favs'), ['nature/dirtfloor001a']);
  assert.deepEqual(by('custom'), ['concrete/measure_dev']);
  assert.deepEqual(by('tools'), ['tools/toolsnodraw', 'tools/toolsplayerclip']);
  assert.deepEqual(by('dev'), ['dev/dev_blendmeasure', 'dev/dev_measuregeneric01b', 'dev/dev_measurewall01a', 'dev/reflectivity_50']);
});

test('replaceMaterial on the whole map: faces, overlays and decals in one undo step', async () => {
  const V = await import('../vmf.js'), st = await import('../src/state.js');
  st.load(st.EMPTY, null);
  st.createBlock([0, 0, 0], [64, 64, 64]);
  st.applyMaterial('materials/Custom/A.vmt');
  assert.equal(V.get(V.kids([...st.sel][0], 'side')[0], 'material'), 'CUSTOM/A', 'applyMaterial writes the clean upper-case name');
  const r = st.doc.root, ov = V.entity('info_overlay', [0, 0, 64], st.nextId), dec = V.entity('infodecal', [0, 0, 0], st.nextId);
  V.set(ov, 'material', 'CUSTOM/A');
  V.set(dec, 'texture', 'custom\\a');
  st.edit([], [r], () => r.children.push(ov, dec));
  assert.equal(T.replaceMaterial('custom/a', 'custom/b'), 8, '6 faces, 1 overlay, 1 decal');
  assert.deepEqual([V.get(ov, 'material'), V.get(dec, 'texture')], ['CUSTOM/B', 'CUSTOM/B']);
  st.undo();
  assert.deepEqual([V.get(ov, 'material'), V.get(dec, 'texture'), V.get(V.kids(V.kids(st.doc.world, 'solid')[0], 'side')[0], 'material')], ['CUSTOM/A', 'custom\\a', 'CUSTOM/A']);
});
