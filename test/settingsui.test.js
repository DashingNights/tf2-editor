// node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false } };
const U = await import('../src/settingsui.js');
const { chord, keyOf, norm } = await import('../src/commands.js');

test('conflicts: shared chords without `when` clash, contextual ones do not', () => {
  const c = (id, keys, when) => ({ id, title: id.toUpperCase(), keys, when });
  const bad = U.conflicts([c('a', ['ctrl+d']), c('b', ['ctrl+d', 'x']), c('c', ['x']), c('d', ['escape']), c('e', ['escape'], () => true), c('f', [])]);
  assert.deepEqual(bad.get('a'), ['B']);
  assert.deepEqual(bad.get('b'), ['A', 'C']);
  assert.deepEqual(bad.get('c'), ['B']);
  assert.equal(bad.has('d'), false);
  assert.equal(bad.has('e'), false);
  assert.equal(bad.has('f'), false);
});

test('chord and has', () => {
  assert.equal(chord('ctrl+shift+arrowleft'), 'Ctrl+Shift+Left');
  assert.equal(chord(' '), 'Space');
  assert.equal(chord('ctrl+,'), 'Ctrl+,');
  assert.ok(U.has('fov', 'Field of view', 'fov'));
  assert.ok(!U.has('zzz', 'Field of view', undefined));
});

test("the '+' key round-trips keyOf -> norm -> chord; a 'shift++' saved before reads the same", () => {
  const k = keyOf({ shiftKey: true, key: '+' });
  assert.equal(k, 'shift+plus');
  assert.equal(norm(k), 'shift+plus');
  assert.equal(norm('shift++'), 'shift+plus');
  assert.equal(norm('+'), 'plus');
  assert.equal(chord(norm('ctrl++')), 'Ctrl+Plus');
});
