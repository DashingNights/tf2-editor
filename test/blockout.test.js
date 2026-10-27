// node --test "test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false } };
const V = await import('../vmf.js');
const st = await import('../src/state.js');
const { hiddenSides, seeThrough } = await import('../src/blockout.js');

let id = 0;
const next = () => String(++id);
const entry = s => ({ node: s, faces: V.faces(s) });

test('nodraw hidden: two stacked boxes hide their shared faces, outer faces stay', () => {
  const a = V.block([0, 0, 0], [64, 64, 64], 'DEV/X', next), b = V.block([0, 0, 64], [64, 64, 128], 'DEV/X', next);
  const all = [entry(a), entry(b)], sides = hiddenSides(all, all);
  assert.equal(sides.length, 2);
  assert.deepEqual(sides.map(s => V.plane(s).n[2]), [1, -1], 'the top of a and the bottom of b');
});

test('nodraw hidden: partial cover, cover by several faces, see-through covers', () => {
  const floor = V.block([0, 0, -16], [128, 64, 0], 'DEV/X', next);
  const half = V.block([0, 0, 0], [64, 64, 64], 'DEV/X', next), rest = V.block([64, 0, 0], [128, 64, 64], 'DEV/X', next);
  const wide = V.block([0, 0, 0], [128, 64, 32], 'DEV/X', next);
  assert.deepEqual(hiddenSides([entry(floor)], [entry(half)]), [], 'half covered: stays');
  const two = hiddenSides([entry(floor)], [entry(half), entry(rest)]);
  assert.equal(two.length, 1, 'covered by two brushes together');
  assert.equal(V.plane(two[0]).n[2], 1);
  assert.deepEqual(hiddenSides([entry(floor)], [entry(wide)], () => false), [], 'a see-through cover hides nothing');
  const small = V.block([16, 16, 0], [48, 48, 16], 'DEV/X', next);
  assert.equal(hiddenSides([entry(small)], [entry(floor)]).length, 1, 'a small box on a floor: only its bottom');
});

test('nodraw hidden: water, glass, displacement and blocklight brushes cover nothing; displaced faces stay', () => {
  const mat = s => V.get(s, 'material').toLowerCase();
  // VMT params as materials.js getVmt returns them, by lower-case name; unknown names fall back to the name rules.
  const vmt = { 'water/water_2fort': { shader: 'water' }, 'glass/glasswindow001a': { shader: 'lightmappedgeneric', translucent: true },
    'metal/fence001': { shader: 'lightmappedgeneric', alphatest: true }, 'brick/faded': { shader: 'lightmappedgeneric', kv: new Map([['$alpha', '0.5']]) } };
  const opaque = n => !V.kids(n, 'side').some(s => seeThrough(mat(s), vmt[mat(s)]));
  const top = b => V.kids(b, 'side').find(s => V.plane(s).n[2] > 0.9);
  const floor = V.block([0, 0, -16], [256, 256, 0], 'CONCRETE/CONCRETEFLOOR001A', next);
  const water = V.block([0, 0, 0], [256, 256, 48], 'TOOLS/TOOLSNODRAW', next);
  V.set(top(water), 'material', 'WATER/WATER_2FORT');
  assert.deepEqual(hiddenSides([entry(floor)], [entry(floor), entry(water)], opaque), [], 'pool floor under a water brush');
  const wall = V.block([0, 0, 0], [16, 128, 128], 'BRICK/BRICKWALL001', next);
  for (const m of ['GLASS/GLASSWINDOW001A', 'METAL/FENCE001', 'BRICK/FADED', 'TOOLS/TOOLSBLOCKLIGHT', 'TOOLS/TOOLSBLOCK_LOS']) {
    assert.deepEqual(hiddenSides([entry(wall)], [entry(V.block([16, 0, 0], [20, 128, 128], m, next))], opaque), [], m);
  }
  assert.equal(hiddenSides([entry(wall)], [entry(V.block([16, 0, 0], [20, 128, 128], 'BRICK/BRICKWALL001', next))], opaque).length, 1, 'an opaque brush still covers');
  const terr = V.block([0, 0, -64], [512, 512, 0], 'NATURE/GRASS', next), box = V.block([512, 0, -64], [528, 64, 0], 'BRICK/BRICKWALL001', next);
  top(terr).children.push({ name: 'dispinfo', kv: [['power', '3']], children: [] });
  assert.deepEqual(hiddenSides([entry(box)], [entry(terr)], opaque), [], 'a displacement brush covers nothing');
  const ledge = V.block([0, 0, 0], [64, 64, 16], 'NATURE/GRASS', next), crate = V.block([0, 0, 16], [64, 64, 80], 'WOOD/CRATE', next);
  top(ledge).children.push({ name: 'dispinfo', kv: [['power', '2']], children: [] });
  assert.deepEqual(hiddenSides([entry(ledge)], [entry(crate)], opaque), [], 'a displaced face never gets nodraw');
});

test('repeat duplicate: a clone followed by one move stores the offset', () => {
  st.load(st.EMPTY, null);
  st.createBlock([0, 0, 0], [64, 64, 64]);
  st.transformSel([1, 1, 1], [16, 0, 0]);
  assert.equal(st.S.lastDup, null, 'a plain move is not a duplicate offset');
  st.cloneSel();
  st.transformSel([1, 1, 1], [128, 0, 0]);
  st.mergeUndo();
  assert.deepEqual(st.S.lastDup, [128, 0, 0]);
  st.cloneSel();
  st.applyMaterial('DEV/Y');
  st.transformSel([1, 1, 1], [0, 64, 0]);
  assert.deepEqual(st.S.lastDup, [128, 0, 0], 'another edit between clone and move disarms');
  st.load(st.EMPTY, null);
  assert.equal(st.S.lastDup, null);
});
