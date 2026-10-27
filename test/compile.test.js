// node --test "test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false } };
const { resolve, varsFor, modeVars, stockTools } = await import('../src/compile.js');
const { STEPS, MODES } = await import('../src/settings.js');

const vars = { tf2: 'T', gamedir: 'T\\tf', bin: 'T\\bin\\x64', vmf: 'C:\\m\\a.vmf', mapbase: 'C:\\m\\a', mapname: 'a' };
const steps = [
  { on: true, name: 'VBSP', cmd: '"$bin\\vbsp++.exe" -game "$gamedir" "$vmf"' },
  { on: true, name: 'Pack', cmd: ' @pack ' },
  { on: false, name: 'Off', cmd: 'x' },
  { on: true, name: 'Empty', cmd: '  ' },
  { on: true, name: 'Copy', cmd: 'copy "$mapbase.bsp" "$nope"' },
];
const BSPZIP = 'bspzip -addlist "C:\\m\\a.bsp" list.txt "C:\\m\\a.bsp"';

test('an @pack step becomes the commands pack.prepare returns; vars fill the other steps', async () => {
  const logs = [], bases = [];
  const pack = { prepare: async b => { bases.push(b); return [BSPZIP]; } };
  const cmds = await resolve(steps, vars, s => logs.push(s), async () => pack);
  assert.deepEqual(cmds, ['"T\\bin\\x64\\vbsp++.exe" -game "T\\tf" "C:\\m\\a.vmf"', BSPZIP, 'copy "C:\\m\\a.bsp" "$nope"']);
  assert.deepEqual(bases, ['C:\\m\\a']);
  assert.deepEqual(logs, ['pack: 1 command(s)\n']);
});

test('pack result object: files and missing content go to the log', async () => {
  const logs = [];
  const pack = { prepare: () => ({ cmds: ['a', 'b'], files: ['materials/x.vmt', 'materials/x.vtf', 'sound/y.wav'], missing: ['materials/z.vmt'] }) };
  const cmds = await resolve([{ on: true, cmd: '@pack' }], vars, s => logs.push(s), async () => pack);
  assert.deepEqual(cmds, ['a', 'b']);
  assert.deepEqual(logs, ['pack: 3 file(s), missing: materials/z.vmt\n']);
});

test('without pack.js, or when prepare throws, the step is skipped and the log says why', async () => {
  const logs = [];
  const cmds = await resolve(steps, vars, s => logs.push(s), () => Promise.reject(new Error('Cannot find module')));
  assert.equal(cmds.length, 2);
  assert.deepEqual(logs, ['pack: module missing\n']);
  const bad = await resolve([{ on: true, cmd: '@pack' }, { on: true, cmd: 'next' }], vars, s => logs.push(s), async () => ({ prepare: () => { throw new Error('no tf2 folder'); } }));
  assert.deepEqual(bad, ['next']);
  assert.equal(logs[1], 'pack: no tf2 folder; step skipped\n');
});

test('the default steps resolve with Pack between VRAD and Copy; no custom content packs nothing', async () => {
  const cmds = await resolve(STEPS, vars, () => {}, async () => ({ prepare: () => ['PACK'] }));
  assert.equal(cmds.length, 5);
  assert.match(cmds[2], /vrad\+\+/);
  assert.equal(cmds[3], 'PACK');
  assert.match(cmds[4], /^cmd \/c copy/);
  const logs = [], none = await resolve(STEPS, vars, s => logs.push(s), async () => ({ prepare: async () => [] }));
  assert.equal(none.length, 4);
  assert.deepEqual(logs, ['pack: nothing to pack\n']);
});

test('compile modes fill the tool flags; Entities only drops the VVIS and VRAD steps', async () => {
  const run = k => resolve(STEPS, { ...vars, ...modeVars(MODES[k]) }, () => {}, async () => ({ prepare: async () => [] }));
  const fast = await run('fast');
  assert.equal(fast[1], '"T\\bin\\x64\\vvis++.exe" -game "T\\tf" -fast "C:\\m\\a"');
  assert.match(fast[2], /vrad\+\+.* -fast "C:\\m\\a"$/);
  const normal = await run('normal');
  assert.ok(normal.every(c => !c.includes('$') && !c.includes('-fast')), normal.join('\n'));
  assert.match((await run('full'))[2], /vrad\+\+.* -both -final /);
  const ents = await run('ents');
  assert.deepEqual(ents.map(c => c.match(/v(bsp|vis|rad)|copy/)[0]), ['vbsp', 'copy']);
  assert.match(ents[0], / -onlyents "C:\\m\\a\.vmf"$/);
});

test('a map opened by a forward-slash path compiles with Windows paths (cmd copy reads "/x" as a switch)', async () => {
  const v = varsFor('C:/maps/koth_a.vmf', 'D:/Steam/Team Fortress 2');
  const T = 'D:\\Steam\\Team Fortress 2';
  assert.deepEqual(v, { tf2: T, gamedir: T + '\\tf', bin: T + '\\bin\\x64', vmf: 'C:\\maps\\koth_a.vmf', mapbase: 'C:\\maps\\koth_a', mapname: 'koth_a' });
  const cmds = await resolve(STEPS, v, () => {}, async () => ({ prepare: async () => [] }));
  assert.ok(cmds.every(c => !/[A-Z]:\//.test(c)), cmds.join('\n'));
});

test('a Hammer++ compiler that is not installed falls back to the stock tool in the same folder', async () => {
  const have = new Set(['T\\bin\\x64\\vbsp.exe', 'T\\bin\\x64\\vrad++.exe', 'T\\bin\\x64\\vrad.exe']), logs = [];
  const cmds = ['"T\\bin\\x64\\vbsp++.exe" -game "T\\tf" "a.vmf"', '"T\\bin\\x64\\vvis++.exe" a', '"T\\bin\\x64\\vrad++.exe" a', 'cmd /c copy a b'];
  const out = await stockTools(cmds, async p => have.has(p), s => logs.push(s));
  assert.deepEqual(out, ['"T\\bin\\x64\\vbsp.exe" -game "T\\tf" "a.vmf"', cmds[1], cmds[2], cmds[3]]);
  assert.deepEqual(logs, ['vbsp++.exe not found: using vbsp.exe\n']);
});
