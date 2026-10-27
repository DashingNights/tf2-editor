// node --test "test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false } };
const { entityRows, filterRows } = await import('../src/report.js');

test('entity report: Hammer\'s by key/value filter, with Exact', () => {
  const ent = (cls, ...kv) => ({ name: 'entity', kv: [['classname', cls], ...kv], children: [] });
  const rows = entityRows([ent('func_regenerate', ['model', 'models/props_gameplay/resupply_locker.mdl']), ent('prop_dynamic', ['model', 'models/props_gameplay/resupply_locker.mdl'], ['targetname', 'locker']), ent('info_target', ['targetname', 'resupply'])]);
  const cls = f => filterRows(rows, f).map(r => r.cls);
  assert.deepEqual(cls({ key: 'model', value: 'resupply' }), ['func_regenerate', 'prop_dynamic']);
  assert.deepEqual(cls({ value: 'resupply' }), ['func_regenerate', 'prop_dynamic', 'info_target'], 'any key');
  assert.deepEqual(cls({ key: 'targetname', value: 'resupply', exact: true }), ['info_target']);
  assert.deepEqual(cls({ key: 'TargetName' }), ['prop_dynamic', 'info_target'], 'a key alone: entities that have it');
  assert.deepEqual(cls({ cls: 'prop', key: 'model' }), ['prop_dynamic']);
});
