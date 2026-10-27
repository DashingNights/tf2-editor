// Tools panel (src/tools.js): every button names a registered command; commands report runs and toggle states.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false } };
const { ROLLOUTS } = await import('../src/tools.js');
const C = await import('../src/commands.js');
const { on } = await import('../src/bus.js');

test('every Tools button runs a command some module registers', () => {
  const src = ['app.js', ...readdirSync('src').filter(f => f.endsWith('.js')).map(f => 'src/' + f)].map(f => readFileSync(f, 'utf8')).join('\n');
  const ids = new Set([...src.matchAll(/register\(\s*'([^']+)'/g), ...src.matchAll(/^\s*\['([A-Za-z0-9.]+)', ['`]/gm)].map(m => m[1]));
  const used = ROLLOUTS.flatMap(r => r.rows.flatMap(([, ...bs]) => bs.map(b => b[1])));
  assert.ok(used.length > 60);
  assert.deepEqual(used.filter(id => !ids.has(id)), []);
  assert.equal(new Set(ROLLOUTS.map(r => r.id)).size, ROLLOUTS.length);
});

test('a command run tells listeners, and a toggle state passes through list()', () => {
  const runs = [];
  on('cmd', id => runs.push(id));
  let x = false;
  C.register('t.toggle', { title: 'Toggle', run: () => { x = !x; }, on: () => x });
  C.run('t.toggle');
  assert.deepEqual(runs, ['t.toggle']);
  assert.equal(C.list().find(c => c.id === 't.toggle').on(), true);
  C.register('t.never', { title: 'Never', when: () => false, run: () => { throw new Error('ran'); } });
  assert.equal(C.ready(C.get('t.never')), false);
});

test('every Tools button has an icon, and every icon named is in icons.js', async () => {
  const { ICONS } = await import('../src/tools.js');
  const { has } = await import('../src/icons.js');
  const used = ROLLOUTS.flatMap(r => r.rows.flatMap(([, ...bs]) => bs.map(b => b[1])));
  assert.deepEqual(used.filter(id => !ICONS[id]), []);
  assert.deepEqual(Object.values(ICONS).filter(n => !has(n)), []);
});

test('viewport labels: the level or tool, the gizmo in 3D, snapping and blockout when on', async () => {
  const { labels } = await import('../src/viewhud.js');
  const st = await import('../src/state.js'), { cfg } = await import('../src/settings.js');
  Object.assign(cfg, { snapGrid: false, snapVertex: true, blockout: true, gizmoSpace: 'world' });
  st.S.tool = 'poly'; st.S.mode = 'vertex'; st.S.gizmo = 'rotate';
  assert.deepEqual(labels(true, true).map(x => x[0]), ['Vertex', 'Rotate world', 'Grid off', 'Vertex snap', 'Blockout', 'Mirror']);
  st.S.tool = 'select'; st.S.mode = 'object';
  assert.deepEqual(labels(false).map(x => x[0]).slice(0, 2), ['Object', 'Grid off']);
  Object.assign(cfg, { snapGrid: true, snapVertex: false, blockout: false });
});
