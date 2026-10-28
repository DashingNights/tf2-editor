// node --test "test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false } };
const V = await import('../vmf.js');
const F = await import('../src/fgd.js');
const C = await import('../src/mapcheck.js');
const st = await import('../src/state.js');
const { recover } = await import('../src/crash.js');
const { leakEnds } = await import('../src/compile.js');
const { assetOf } = await import('../src/hotload.js');

let id = 0;
const next = () => String(++id);
const box = (mn, mx, mat = 'DEV/X') => V.block(mn, mx, mat, next);
const ent = (cls, kv = [], kids = []) => ({ name: 'entity', kv: [['id', next()], ['classname', cls], ...kv], children: kids });
const kinds = ps => ps.map(p => p.kind).sort();

test('check for problems: solids, contents, ids, keyvalues, targets, overlays, models, bounds; the simple fixes', () => {
  const floor = box([-512, -512, -64], [512, 512, 0]), sky = box([-512, -512, 512], [512, 512, 576]);
  const thin = box([0, 0, 0], [16, 16, 16]), open = box([32, 0, 0], [48, 16, 16]);
  thin.children = V.kids(thin, 'side').slice(0, 3);
  open.children = V.kids(open, 'side').slice(0, 5);
  const mixed = box([64, 0, 0], [128, 64, 64]), twin = box([160, 0, 0], [224, 64, 64]);
  V.set(V.kids(mixed, 'side')[0], 'material', 'TOOLS/TOOLSPLAYERCLIP');
  V.set(twin, 'id', V.get(floor, 'id'));
  V.set(V.kids(sky, 'side')[0], 'id', V.get(V.kids(floor, 'side')[0], 'id'));
  const disp = box([0, 128, 0], [64, 192, 16]);
  V.kids(disp, 'side')[5].children.push({ name: 'dispinfo', kv: [['power', '3']], children: [] });
  const world = { name: 'world', kv: [['id', next()], ['classname', 'worldspawn']], children: [floor, sky, thin, open, mixed, twin] };
  const outs = { name: 'connections', kv: [['OnMapSpawn', 'relay,Trigger,,0,-1'], ['OnMapSpawn', 'ghost,Kill,,0,-1'], ['OnMapSpawn', 'ghost2\x1bKill\x1b\x1b0\x1b-1'],
    ['OnMapSpawn', '!activator,Kill,,0,-1'], ['OnMapSpawn', 'rel*,Trigger,,0,-1'], ['OnMapSpawn', 'player,AddOutput,x,0,-1'], ['OnMapSpawn', 'door-relay,Trigger,,0,-1'], ['OnMapSpawn', '@lights,TurnOn,,0,-1']], children: [] };
  const dup = ent('info_target', [['targetname', 'a'], ['TargetName', 'b'], ['origin', '0 0 64']]);
  const root = { name: '', kv: [], children: [world,
    ent('logic_relay', [['targetname', 'relay'], ['origin', '0 0 64']]),
    ent('func_instance', [['targetname', 'door'], ['origin', '0 0 64']]),
    ent('logic_auto', [['origin', '0 0 64']], [outs]),
    ent('env_laser', [['target', 'nothing'], ['parentname', 'relay,attach'], ['origin', '0 0 64']]),
    dup,
    ent('info_target', [['bogus', '1'], ['origin', '0 0 64']]),
    ent('func_detail', [], [disp]),
    ent('info_overlay', [['material', ''], ['sides', '99999'], ['origin', '0 0 1']]),
    ent('prop_static', [['origin', '0 0 1']]),
    ent('prop_dynamic', [['model', 'models/gone.mdl'], ['origin', '0 0 1']]),
    { name: 'hidden', kv: [], children: [ent('info_target', [['origin', '0 0 2000']])] },
    ent('info_target', [['origin', '20000 0 0']]),
  ] };
  const fgd = F.parse('@PointClass = info_target : "A target" [ targetname(target_source) : "Name" ]');
  const opt = { fgd, nextId: next, contents: m => (m.toLowerCase() === 'tools/toolsplayerclip' ? 'playerclip' : ''), hasModel: m => m === 'models/ok.mdl' };
  const ps = C.problems(root, opt), of = k => ps.filter(p => p.kind === k);
  assert.deepEqual(kinds(ps), ['bounds', 'bounds', 'contents', 'disp', 'fgd', 'id', 'id', 'key', 'model', 'model', 'output', 'overlay', 'solid', 'solid', 'target']);
  assert.deepEqual(of('solid').map(p => p.objs[0]), [thin, open]);
  assert.match(of('contents')[0].text, /playerclip, solid/);
  assert.deepEqual(of('disp')[0].objs, [disp]);
  assert.deepEqual(of('fgd')[0].keys, ['bogus']);
  assert.match(of('target')[0].text, /target "nothing"/);
  assert.doesNotMatch(of('target')[0].text, /parentname/, 'parentname "relay,attach" names relay');
  assert.match(of('output')[0].text, /OnMapSpawn > ghost, OnMapSpawn > ghost2$/, 'special, wildcard, runtime and instance names are known');
  assert.match(of('overlay')[0].text, /no material/);
  assert.deepEqual(of('model').map(p => p.text), ['prop_static has no model', 'Model not found: models/gone.mdl']);
  assert.deepEqual(of('bounds').map(p => p.text.split(' ')[2]), ['world', 'map:'], 'a hidden entity in the void, one beyond the limit');
  assert.equal(C.problems(root, { ...opt, ignoreKeys: new Set(['bogus']) }).filter(p => p.kind === 'fgd').length, 0, 'ignored keys');
  assert.equal(C.label(dup), `info_target "a" (id ${V.get(dup, 'id')})`);

  const taken = [];
  for (const p of ps) p.fix?.((n, deep) => taken.push([n, deep]));
  assert.deepEqual(kinds(C.problems(root, opt)), ['bounds', 'bounds', 'contents', 'disp', 'fgd', 'model', 'model', 'overlay', 'solid', 'solid', 'target']);
  assert.deepEqual(dup.kv.slice(2), [['TargetName', 'b'], ['origin', '0 0 64']], 'the last of a repeated key stays');
  assert.equal(outs.kv.length, 6);
  assert.notEqual(V.get(twin, 'id'), V.get(floor, 'id'));
  assert.ok(taken.some(([n, deep]) => n === sky && deep), 'a renumbered face snapshots its solid');
});

test('face contents from the VMT: clip flags count, nodraw and water do not, hint and skip are both empty', () => {
  const kv = o => new Map(Object.entries(o));
  assert.equal(C.contentsOf(null), '');
  assert.equal(C.contentsOf(kv({ '%compilenodraw': '1', '%compilewater': '1' })), '');
  assert.equal(C.contentsOf(kv({ '%compileclip': '1' })), 'clip');
  assert.equal(C.contentsOf(kv({ '%compileclip': '0', '%playerclip': 'TRUE' })), 'playerclip');
  assert.equal(C.contentsOf(kv({ '%compilehint': '1' })), 'empty');
  assert.equal(C.contentsOf(kv({ '%compileskip': '1' })), 'empty');
});

test('leak: the entity on either end of the .lin leaked; the camera goes to the other end', () => {
  const a = { name: 'entity' }, b = { name: 'entity' };
  const pts = [[600, 0, 0], [300, 0, 0], [0, 0, 64]], ents = [[a, [0, 0, 64]], [b, [590, 0, 0]]];
  assert.deepEqual(leakEnds(pts, ents), { ent: a, exit: [600, 0, 0], next: [300, 0, 0] });
  assert.deepEqual(leakEnds([...pts].reverse(), ents), { ent: a, exit: [600, 0, 0], next: [300, 0, 0] });
});

test('hotload: changed files under tf (and tf/custom/<mod>) map to material names and model paths', () => {
  assert.deepEqual(assetOf('D:\\TF2\\tf\\custom\\mymod\\materials\\Foo\\Bar.VTF'), { material: 'foo/bar' });
  assert.deepEqual(assetOf('D:\\TF2\\tf\\materials\\models\\props\\x.vmt'), { material: 'models/props/x' });
  assert.deepEqual(assetOf('D:\\TF2\\tf\\custom\\m\\models\\props\\a.b.dx90.vtx'), { model: 'models/props/a.b.mdl' });
  assert.deepEqual(assetOf('D:\\TF2\\tf\\models\\x.phy'), { model: 'models/x.mdl' });
  assert.deepEqual(assetOf('D:\\tf\\games\\tf\\custom\\m\\materials\\a.vmt'), { material: 'a' });
  assert.equal(assetOf('D:\\TF2\\tf\\custom\\m\\sound\\a.wav'), null);
  assert.equal(assetOf('D:\\TF2\\tf\\custom\\pack.vpk'), null);
});

test('crash recovery: the autosave replaces the map as one undo step, and new ids come after its own', () => {
  st.load(st.EMPTY, 'C:\\maps\\a.vmf');
  const saved = st.serialize(), r = V.parse(st.EMPTY);
  let k = 499;
  V.kids(r, 'world')[0].children.push(V.block([0, 0, 0], [64, 64, 64], 'DEV/X', () => String(++k)));
  const text = V.serialize(r);
  assert.equal(recover('nothing here'), false);
  assert.ok(recover(text));
  assert.equal(st.serialize(), text);
  assert.equal(st.cache.size, 1);
  assert.ok(st.S.dirty);
  assert.ok(+st.nextId() > k);
  st.undo();
  assert.equal(st.serialize(), saved);
  assert.equal(st.cache.size, 0);
});
