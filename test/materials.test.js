// node --test test/
// materials.js against an in-memory game folder: search-path priority, VMT patch/include, conditionals, flat material.
import test from 'node:test';
import assert from 'node:assert/strict';

const G = 'X:\\game', files = new Map(Object.entries({
  [`${G}\\tf\\custom\\mymod\\materials\\Dev\\Dev_MeasureGeneric01b.vmt`]: '"UnlitGeneric" { "$basetexture" "custom/override" }',
  [`${G}\\tf\\materials\\dev\\dev_measuregeneric01b.vmt`]: '"LightmappedGeneric" { "$basetexture" "dev/shadowed" }',
  [`${G}\\tf\\materials\\base.vmt`]: '// c\n"LightmappedGeneric"\n{\n\t"$basetexture" "Foo\\Bar.vtf"\n\t"$envmap" "env_cubemap" [$X360]\n\t"$translucent" 1\n\t"$color" "{255 0 0}"\n\t"$alphatest" "1"\n}',
  [`${G}\\tf\\materials\\patched.vmt`]: 'patch { include "materials/base.vmt" insert { "$NoCull" 1 } replace { "$basetexture" "foo/baz" } }',
  [`${G}\\hl2\\materials\\hl2only.vmt`]: 'UnlitGeneric { $basetexture hl2/x }',
}).map(([k, v]) => [k, Buffer.from(v)]));
const listDir = async p => {
  const out = new Map();
  for (const f of files.keys()) if (f.startsWith(p + '\\')) { const rest = f.slice(p.length + 1).split('\\'); out.set(rest[0], rest.length > 1); }
  return out.size ? [...out].map(([name, isDirectory]) => ({ name, isDirectory })) : null;
};
globalThis.window = { api: {
  settingsPath: 'X:\\ud\\settings.json', read: async p => (p === 'X:\\ud\\settings.json' ? JSON.stringify({ tf2: G }) : null), write: async () => {}, exists: async () => false,
  readBytes: async (p, o, l) => files.get(p)?.subarray(o, o + l) ?? null, stat: async p => (files.has(p) ? { size: files.get(p).length, isDirectory: false } : null), listDir,
} };
console.warn = () => {}; // the fake game has no VPKs
const M = await import('../src/materials.js');

test('index: names sorted, custom folders win over tf/materials', async () => {
  assert.deepEqual(await M.listMaterials(), ['base', 'dev/dev_measuregeneric01b', 'hl2only', 'patched']);
  const v = await M.getVmt('DEV\\DEV_MEASUREGENERIC01B.vmt');
  assert.equal(v.shader, 'unlitgeneric');
  assert.equal(v.basetexture, 'custom/override');
  assert.equal((await M.getVmt('hl2only')).basetexture, 'hl2/x');
  assert.equal(await M.getVmt('missing/thing'), null);
});

test('VMT: case-insensitive keys, [$X360] dropped, {0-255} colour, patch include + insert/replace', async () => {
  const b = await M.getVmt('base');
  assert.deepEqual([b.shader, b.basetexture, b.translucent, b.alphatest, b.nocull, b.color], ['lightmappedgeneric', 'Foo\\Bar.vtf', true, true, false, [1, 0, 0]]);
  const p = await M.getVmt('materials/patched.vmt');
  assert.deepEqual([p.shader, p.basetexture, p.translucent, p.nocull], ['lightmappedgeneric', 'foo/baz', true, true]);
});

test('getMaterial: flat colour now, cached per name, no size without a texture', async () => {
  const m = M.getMaterial('Base');
  assert.equal(M.getMaterial('base'), m);
  assert.ok(m.color.equals(M.flatColor('BASE')) && m.vertexColors && !m.map);
  assert.equal(M.flatColor('TOOLS/TOOLSNODRAW').getHex(), 0xc9b23c);
  await M.getVmt('base');
  assert.equal(M.getTextureSize('base'), null);
});
