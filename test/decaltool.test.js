// Decal tool (src/decaltool.js): the infodecal entity it places.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false } };
const { decal } = await import('../src/decaltool.js');
const V = await import('../vmf.js');

test('an infodecal of the material at the point, keys in Hammer order', () => {
  let n = 40;
  const e = decal([12, -8.5, 64], 'DECALS/SCORCH1', () => String(++n));
  assert.deepEqual(e.kv, [['id', '41'], ['classname', 'infodecal'], ['texture', 'DECALS/SCORCH1'], ['origin', '12 -8.5 64']]);
  assert.equal(V.get(e, 'classname'), 'infodecal');
});
