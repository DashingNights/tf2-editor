// node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';

// A hand-edited file with a single backslash is not valid JSON.
const bad = '{ "tf2": "D:\\SteamLibrary", "keys": { "focus": ["ctrl+d"] } }', writes = [];
globalThis.window = { api: {
  settingsPath: 'C:\\u\\settings.json',
  read: async p => (p.endsWith('settings.json') ? bad : null),
  write: async (p, t) => { writes.push([p, t]); },
  exists: async () => false,
} };
const err = console.error;
console.error = () => {};
const { cfg } = await import('../src/settings.js');
console.error = err;

test('an invalid settings.json is kept as settings.bad.json before defaults take over', () => {
  assert.deepEqual(writes, [['C:\\u\\settings.bad.json', bad]]);
  assert.deepEqual(cfg.keys, {});
});

const { DEFAULTS, SCHEMA, merge } = await import('../src/settings.js');

test('every SCHEMA row has a default of the right type', () => {
  const ok = {
    bool: (v) => typeof v === 'boolean',
    number: (v, r) => typeof v === 'number' && v >= r.min && v <= r.max,
    select: (v, r) => r.options.some(o => o[0] === v),
    text: v => typeof v === 'string',
    path: v => typeof v === 'string',
    color: v => /^#[0-9a-f]{6}$/.test(v),
  };
  const rows = SCHEMA.flatMap(c => c.rows);
  assert.ok(rows.length > 20);
  for (const r of rows) {
    assert.ok(r.key in DEFAULTS, `${r.key} has a default`);
    assert.ok(ok[r.type]?.(DEFAULTS[r.key], r), `${r.key}: ${JSON.stringify(DEFAULTS[r.key])} fits ${r.type}`);
  }
  assert.equal(new Set(rows.map(r => r.key)).size, rows.length, 'no key twice');
  for (const k of ['tf2', 'steps', 'keys', 'layout', 'lastFile', 'material', 'cls', 'texLock', 'sizeLock', 'anchor', 'flySpeed', 'renderMode', 'recent', 'recentFiles']) assert.ok(k in DEFAULTS, k);
});

test('merge: saved values win, unknown keys stay, defaults are not shared', () => {
  const m = merge({ fov: 90, keys: { focus: ['ctrl+d'] }, futureKey: 1 });
  assert.equal(m.fov, 90);
  assert.deepEqual(m.keys, { focus: ['ctrl+d'] });
  assert.equal(m.futureKey, 1);
  assert.equal(m.snapGrid, true);
  m.steps[0].on = false;
  m.recentFiles.push('x');
  assert.equal(DEFAULTS.steps[0].on, true);
  assert.deepEqual(DEFAULTS.recentFiles, []);
});

const { STEPS, migrateSteps, keepRecent } = await import('../src/settings.js');

test('steps migration: Pack goes in after the compile tools once; a Pack removed later stays removed', () => {
  assert.deepEqual(DEFAULTS.steps.map(s => s.name), ['VBSP', 'VVIS', 'VRAD', 'Pack', 'Copy', 'Run TF2']);
  const old = { steps: structuredClone(STEPS).filter(s => s.cmd !== '@pack') };
  assert.equal(migrateSteps(old), true);
  assert.deepEqual(old.steps.map(s => s.name), ['VBSP', 'VVIS', 'VRAD', 'Pack', 'Copy', 'Run TF2']);
  assert.deepEqual(old.steps[3], { on: true, name: 'Pack', cmd: '@pack' });
  assert.equal(merge(old).packStepAdded, true);
  assert.equal(migrateSteps(old), false, 'idempotent');
  old.steps.splice(3, 1);
  assert.equal(migrateSteps(old), false, 'not added back');
  assert.equal(old.steps.length, 5);

  const custom = { steps: [{ on: true, name: 'BSP', cmd: '"x\\vbsp++.exe" a' }, { on: true, name: 'Copy', cmd: 'cmd /c copy a b' }] };
  migrateSteps(custom);
  assert.deepEqual(custom.steps.map(s => s.name), ['BSP', 'Pack', 'Copy']);
  const none = { steps: [{ on: true, name: 'Echo', cmd: 'cmd /c echo hi' }] };
  migrateSteps(none);
  assert.deepEqual(none.steps.map(s => s.name), ['Echo', 'Pack']);
  const has = { steps: [{ on: false, name: 'Mine', cmd: ' @pack ' }] };
  assert.equal(migrateSteps(has), true);
  assert.equal(has.steps.length, 1, 'an existing @pack step is kept as it is');
  assert.equal(migrateSteps({}), false, 'fresh settings use the defaults');
  assert.equal(migrateSteps(null), false);
});

test('mode migration: tool steps still as the old defaults get the flag vars once; edited steps stay', async () => {
  const { migrateModes, MODES } = await import('../src/settings.js');
  const edited = '"$bin\\vrad++.exe" -game "$gamedir" -bounce 2 "$mapbase"';
  const old = { steps: [{ on: true, name: 'VBSP', cmd: '"$bin\\vbsp++.exe" -game "$gamedir" "$vmf"' }, { on: true, name: 'VVIS', cmd: '"$bin\\vvis++.exe" -game "$gamedir" -fast "$mapbase"' }, { on: true, name: 'VRAD', cmd: edited }] };
  assert.equal(migrateModes(old), true);
  assert.deepEqual(old.steps.map(s => s.cmd), [STEPS[0].cmd, STEPS[1].cmd, edited]);
  assert.equal(migrateModes(old), false, 'idempotent');
  assert.equal(migrateModes({}), false, 'fresh settings use the defaults');
  assert.ok(MODES[DEFAULTS.compileMode]);
});

test('recent files: missing ones are dropped when chosen; the palette lists the rest, most recent first', async () => {
  const C = await import('../src/commands.js');
  cfg.recentFiles = ['C:\\maps\\a.vmf', 'C:\\maps\\gone.vmf', 'D:\\b.vmf'];
  window.api.exists = async p => !p.includes('gone');
  assert.equal(await keepRecent('C:\\maps\\a.vmf'), true);
  assert.equal(await keepRecent('C:\\maps\\gone.vmf'), false);
  assert.deepEqual(cfg.recentFiles, ['C:\\maps\\a.vmf', 'D:\\b.vmf']);
  const titles = C.paletteItems('').map(x => x.c.title).filter(t => t.startsWith('Open recent:'));
  assert.deepEqual(titles, ['Open recent: a.vmf', 'Open recent: b.vmf']);
  assert.equal(C.paletteItems('recent b')[0].c.title, 'Open recent: b.vmf');
  assert.ok(!C.list().some(c => c.id.startsWith('recent:')), 'not in the Keys settings');
  assert.ok(C.list().some(c => c.id === 'file.openRecent'));
});
