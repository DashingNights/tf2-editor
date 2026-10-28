// node --test "test/*.test.js"
// Model extras: body groups, sequences and attachments (mdl.js; the real-model test is skipped without TF2), render
// effects, the body key, the browser's wildcard search, forget, the modelscale step and sprite sizes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { open } from 'node:fs/promises';
import { existsSync } from 'node:fs';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false, listDir: async () => null } };
const M = await import('../src/mdl.js');
const models = await import('../src/models.js');
const { on } = await import('../src/bus.js');
const { scaleStep } = await import('../src/modelprops.js');
const { spriteScale } = await import('../src/helpers.js');
const { openVpk, readFile } = await import('../src/vpk.js');

const ent = kv => ({ name: 'entity', kv: Object.entries(kv), children: [] });

test('body groups: the model index of each part and switching one part (Source GetBodygroup / SetBodygroup)', () => {
  // models/props_ui/banner.mdl: body (1 model), numbers (2), text (2), logos (2); base = product of the counts before
  const parts = [['body', 1, 1], ['numbers', 1, 2], ['text', 2, 2], ['logos', 4, 2]].map(([name, base, n]) => ({ name, base, models: Array(n).fill('m') }));
  assert.deepEqual(parts.map(p => M.bodyIndex(5, p)), [0, 1, 0, 1]);
  const b = M.setBody(5, parts[2], 1);
  assert.equal(b, 7);
  assert.deepEqual(parts.map(p => M.bodyIndex(b, p)), [0, 1, 1, 1], 'only text changed');
  assert.equal(M.setBody(7, parts[1], 0), 6);
  assert.equal(M.bodyIndex(-3, parts[1]), 0, 'a negative body reads as 0');
  assert.equal(M.bodyIndex(3, { base: 1, models: [] }), 0, 'a part without models');
});

test('the body key: the last of body / SetBodyGroup the entity has, else body', () => {
  assert.equal(models.bodyKey(ent({ classname: 'prop_dynamic' })), 'body');
  assert.equal(models.bodyOf(ent({ classname: 'prop_dynamic' })), 0);
  const e = ent({ classname: 'prop_dynamic', SetBodyGroup: '2' });
  assert.equal(models.bodyKey(e), 'SetBodyGroup');
  assert.equal(models.bodyOf(e), 2);
  const both = ent({ body: '3', SetBodyGroup: '1' });
  assert.equal(models.bodyKey(both), 'SetBodyGroup');
  assert.equal(models.bodyOf(both), 1, 'the later key wins, as in the game');
  assert.equal(models.bodyOf(ent({ body: 'x' })), 0);
});

test('render effects: rendercolor tints, renderamt fades except in Normal mode, additive modes add', () => {
  assert.equal(models.renderFx(ent({ classname: 'prop_dynamic' })), null);
  assert.equal(models.renderFx(ent({ rendercolor: '255 255 255', renderamt: '100', rendermode: '0' })), null, 'Normal ignores renderamt');
  assert.deepEqual(models.renderFx(ent({ rendercolor: '255 0 51' })), { tint: [1, 0, 0.2], alpha: 1, add: false });
  assert.deepEqual(models.renderFx(ent({ RenderMode: '1', renderamt: '51' })), { tint: [1, 1, 1], alpha: 0.2, add: false }, 'keys in any case');
  assert.deepEqual(models.renderFx(ent({ rendermode: '5' })), { tint: [1, 1, 1], alpha: 1, add: true });
  assert.equal(models.renderFx(ent({ rendermode: '10' })).alpha, 0.1, "Don't Render shows faint");
  assert.deepEqual(models.renderFx(ent({ rendercolor: '300 -5 255' })).tint, [1, 0, 1], 'clamped');
});

test('browser search: plain words stay fuzzy, * and ? are wildcards, !word leaves paths out', () => {
  assert.deepEqual(models.query('Barrel  red'), { words: 'barrel red', test: null });
  const names = ['props_farm/wood_box01', 'props_farm/wood_crate01', 'props_2fort/metal01', 'props_farm/wood.box'];
  const keep = q => { const { words, test } = models.query(q); assert.equal(words, ''); return names.filter(test); };
  assert.deepEqual(keep('wood*01'), ['props_farm/wood_box01', 'props_farm/wood_crate01']);
  assert.deepEqual(keep('wood*01 !crate'), ['props_farm/wood_box01']);
  assert.deepEqual(keep('!farm'), ['props_2fort/metal01']);
  assert.deepEqual(keep('!wood*01'), ['props_2fort/metal01', 'props_farm/wood.box']);
  assert.deepEqual(keep('wood?box'), ['props_farm/wood_box01', 'props_farm/wood.box']);
  assert.deepEqual(keep('wood.b*'), ['props_farm/wood.box'], 'a dot is a dot');
  const mixed = models.query('farm !crate');
  assert.equal(mixed.words, 'farm');
  assert.deepEqual(names.filter(mixed.test), ['props_farm/wood_box01', 'props_2fort/metal01', 'props_farm/wood.box']);
  assert.deepEqual(models.query('! '), { words: '', test: null }, 'a lone ! is ignored');
});

test('forget drops every cached skin and body of a model and says so', async () => {
  const a = models.getModel('models/props/x.mdl'), b = models.getModel('models/props/x.mdl', 1, 2), other = models.getModel('models/props/y.mdl');
  await Promise.all([a.ready, b.ready, other.ready]); // no game folder: they fail
  assert.equal(models.getModel('Models\\Props\\X.mdl'), a, 'cached by its normalised path');
  assert.equal(models.modelInfo('models/props/x.mdl'), null, 'no info from files that are missing');
  const told = [], off = on('modelForget', p => told.push(p));
  models.forget('MODELS\\props\\x.dx90.vtx');
  off();
  assert.deepEqual(told, ['models/props/x.mdl']);
  assert.notEqual(models.getModel('models/props/x.mdl'), a);
  assert.notEqual(models.getModel('models/props/x.mdl', 1, 2), b);
  assert.equal(models.getModel('models/props/y.mdl'), other, 'other models stay');
});

test('modelscale steps: 10% a notch, 2 decimals, always moving, within 0.01..100', () => {
  assert.equal(scaleStep(1, true), 1.1);
  assert.equal(scaleStep(1.1, false), 1);
  assert.equal(scaleStep(1.21, false), 1.1);
  assert.equal(scaleStep(1, false), 0.91);
  assert.equal(scaleStep(0.01, true), 0.02);
  assert.equal(scaleStep(0.01, false), 0.01);
  assert.equal(scaleStep(100, true), 100);
  let s = 1;
  for (let i = 0; i < 5; i++) s = scaleStep(s, true);
  for (let i = 0; i < 5; i++) s = scaleStep(s, false);
  assert.equal(s, 1, 'five up and five down come back');
});

test('sprite size: texture size times scale, at least 8 units', () => {
  assert.deepEqual(spriteScale([64, 32], 0.5), [32, 16]);
  assert.deepEqual(spriteScale([64, 32], 0), [64, 32], 'scale 0 or unset is 1');
  assert.deepEqual(spriteScale([16, 16], 0.25), [8, 8]);
});

const TF2 = 'D:\\SteamLibrary\\steamapps\\common\\Team Fortress 2', MISC = `${TF2}\\tf\\tf2_misc_dir.vpk`;
async function readBytes(p, offset, length) {
  const fh = await open(p);
  try { const b = Buffer.alloc(length); const { bytesRead } = await fh.read(b, 0, length, offset); return b.subarray(0, bytesRead); }
  finally { await fh.close(); }
}
test('mvm_revive_tombstone: sequences, attachments, body parts; each body draws its own part', { skip: !existsSync(MISC) && 'TF2 not installed' }, async () => {
  const vpk = await openVpk(MISC, readBytes, 'models/'), read = async k => (vpk.has(k) ? readFile(vpk.get(k)) : null);
  const path = 'models/props_mvm/mvm_revive_tombstone.mdl', m = await M.load(path, read);
  assert.deepEqual(m.sequences, ['ref', 'idle']);
  assert.deepEqual(m.attachments, ['healbeam', 'mediccall']);
  assert.deepEqual(m.parts.map(p => [p.name, p.base, p.models.length]), [['body', 1, 1], ['class', 1, 9]]);
  assert.match(m.parts[1].models[0], /scout/);
  const box = async body => (await M.load(path, read, body)).bbox.flat().map(Math.round).join();
  const [b0, b1, b9] = [await box(0), await box(1), await box(9)];
  assert.notEqual(b0, b1, 'scout and sniper tombstones differ');
  assert.equal(b9, b0, 'body 9 wraps to the first class');
});
