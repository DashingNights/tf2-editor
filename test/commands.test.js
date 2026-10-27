// node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false } };
const C = await import('../src/commands.js');
const { cfg } = await import('../src/settings.js');

const key = (k, mods = {}) => ({ key: k, code: 'Key' + k.toUpperCase(), ctrlKey: false, shiftKey: false, altKey: false, target: { closest: () => null }, preventDefault() {}, ...mods });

test('norm and keyOf agree', () => {
  assert.equal(C.norm('Shift+Ctrl+S'), 'ctrl+shift+s');
  assert.equal(C.keyOf(key('S', { ctrlKey: true, shiftKey: true })), 'ctrl+shift+s');
});

test('fuzzy ranks word starts and runs above scattered letters', () => {
  assert.equal(C.fuzzy('xyz', 'Save'), -1);
  assert.ok(C.fuzzy('sa', 'Save as...') > C.fuzzy('sa', 'Select all'));
  assert.ok(C.fuzzy('ga', 'Grid: larger') < C.fuzzy('gl', 'Grid: larger'));
});

test('dispatch: cfg.keys override, when wins, typing ignored', () => {
  const ran = [];
  C.register('t.a', { title: 'A', keys: ['ctrl+j'], run: () => ran.push('a') });
  C.register('t.b', { title: 'B', keys: ['ctrl+j'], when: () => true, run: () => ran.push('b') });
  C.register('t.c', { title: 'C', keys: ['ctrl+j'], when: () => false, run: () => ran.push('c') });
  assert.ok(C.dispatch(key('j', { ctrlKey: true })));
  assert.deepEqual(ran, ['b']);

  cfg.keys['t.a'] = ['alt+m'];
  C.dispatch(key('m', { altKey: true }));
  assert.deepEqual(ran, ['b', 'a']);
  assert.equal(C.dispatch(key('m', { altKey: true, target: { closest: () => ({}) } })), false);
  assert.deepEqual(C.list().find(c => c.id === 't.a').keys, ['alt+m']);
  assert.equal(C.run('t.c'), undefined);
  assert.deepEqual(ran, ['b', 'a']);
  globalThis.document = { querySelector: s => s.split(', ').includes('dialog:modal') && {} }; // a modal dialog is open
  assert.equal(C.dispatch(key('m', { altKey: true })), false);
  globalThis.document = { querySelector: s => s.split(', ').includes(':popover-open') && {} }; // a context menu is open
  assert.equal(C.dispatch(key('m', { altKey: true })), false);
  delete globalThis.document;
  delete cfg.keys['t.a'];
});
