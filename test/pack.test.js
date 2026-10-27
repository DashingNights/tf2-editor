// node --test "test/*.test.js"
// pack.js reference extraction, resolution against a fake game, bspzip list format; import.js info_overlay keys.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false } };
const V = await import('../vmf.js');
const P = await import('../src/pack.js');
const { overlay } = await import('../src/import.js');

const VMF = `world
{
	"id" "1"
	"classname" "worldspawn"
	"skyname" "sky_custom_01"
}
entity
{
	"id" "20"
	"classname" "info_overlay"
	"material" "Custom\\Decal"
}
entity
{
	"id" "21"
	"classname" "prop_static"
	"model" "models/custom/thing.mdl"
}
entity
{
	"id" "22"
	"classname" "prop_dynamic"
	"model" "models/props_gameplay/cap_point_base.mdl"
}
entity
{
	"id" "23"
	"classname" "ambient_generic"
	"message" ")ambient\\custom\\Hum.wav"
}
entity
{
	"id" "24"
	"classname" "ambient_generic"
	"message" "Ambient.Machines"
}
entity
{
	"id" "25"
	"classname" "func_breakable"
	"material" "0"
}
`;
let id = 100;
const nextId = () => String(++id);
const root = V.parse(VMF), world = V.kids(root, 'world')[0];
world.children.push(V.block([0, 0, 0], [256, 256, 128], 'CUSTOM/MYTEX', nextId), V.block([0, 0, 0], [64, 64, 64], 'DEV/DEV_MEASUREGENERIC01B', nextId));

// Minimal .mdl: header with 1 texture ('thing_skin') and 2 $cdmaterials folders.
function mdl() {
  const b = new Uint8Array(400), dv = new DataView(b.buffer), put = (o, s) => b.set(new TextEncoder().encode(s + '\0'), o);
  dv.setInt32(0, 0x54534449, true);
  dv.setInt32(204, 1, true); // numtextures
  dv.setInt32(208, 240, true); // textureindex: mstudiotexture_t (64 bytes), name offset relative to it
  dv.setInt32(240, 100, true);
  put(340, 'thing_skin');
  dv.setInt32(212, 2, true); // numcdtextures
  dv.setInt32(216, 304, true); // cdtextureindex: offsets from the file start
  dv.setInt32(304, 360, true);
  dv.setInt32(308, 380, true);
  put(360, 'models\\other\\');
  put(380, 'models/custom/');
  return b;
}

const G = 'X:\\tf\\custom\\proj\\';
const stock = new Set(['materials/dev/dev_measuregeneric01b.vmt', 'models/props_gameplay/cap_point_base.mdl']);
const loose = new Set(['materials/custom/mytex.vmt', 'materials/custom/mytex.vtf', 'materials/custom/mytex_normal.vtf', 'materials/custom/decal.vmt',
  'models/custom/thing.mdl', 'models/custom/thing.vvd', 'models/custom/thing.dx90.vtx', 'materials/models/custom/thing_skin.vmt',
  'sound/ambient/custom/hum.wav', ...['bk', 'dn', 'ft', 'lf', 'rt', 'up'].map(f => `materials/skybox/sky_custom_01${f}.vmt`)]);
const VMTS = {
  'custom/mytex': new Map([['$basetexture', 'custom/mytex'], ['$bumpmap', 'Custom\\MyTex_Normal.vtf'], ['$envmap', 'env_cubemap'], ['$surfaceprop', 'concrete']]),
  'custom/decal': new Map([['$basetexture', 'custom/decal_missing'], ['$translucent', '1']]),
  'models/custom/thing_skin': new Map([['$basetexture', 'models/custom/thing_skin']]),
};
const io = {
  locate: async rel => (stock.has(rel) ? true : loose.has(rel) ? G + rel.replaceAll('/', '\\') : null),
  vmt: async m => VMTS[m] ?? new Map(),
  read: async () => mdl(),
};

test('refs: side, overlay, sky, model, sound references; soundscripts and non-material keys skipped', () => {
  const r = P.refs(root);
  assert.deepEqual([...r.materials].sort(), ['custom/decal', 'custom/mytex', 'dev/dev_measuregeneric01b', ...['bk', 'dn', 'ft', 'lf', 'rt', 'up'].map(f => `skybox/sky_custom_01${f}`)].sort());
  assert.deepEqual([...r.models].sort(), ['models/custom/thing.mdl', 'models/props_gameplay/cap_point_base.mdl']);
  assert.deepEqual([...r.sounds], ['sound/ambient/custom/hum.wav']);
});

test('mdlMaterials: texture name under each $cdmaterials folder', () => {
  assert.deepEqual(P.mdlMaterials(mdl()), [['models/other/thing_skin', 'models/custom/thing_skin']]);
  assert.deepEqual(P.mdlMaterials(new Uint8Array(300)), []);
});

test('resolve: loose custom files are packed, stock ones are not, missing ones listed', async () => {
  const { pack, missing } = await P.resolve(root, io);
  assert.deepEqual([...pack.keys()].sort(), [
    'materials/custom/decal.vmt', 'materials/custom/mytex.vmt', 'materials/custom/mytex.vtf', 'materials/custom/mytex_normal.vtf',
    'materials/models/custom/thing_skin.vmt', ...['bk', 'dn', 'ft', 'lf', 'rt', 'up'].map(f => `materials/skybox/sky_custom_01${f}.vmt`),
    'models/custom/thing.dx90.vtx', 'models/custom/thing.mdl', 'models/custom/thing.vvd', 'sound/ambient/custom/hum.wav',
  ].sort());
  assert.equal(pack.get('materials/custom/mytex.vtf'), 'X:\\tf\\custom\\proj\\materials\\custom\\mytex.vtf');
  // $envmap env_cubemap is not a file and is not listed; a missing $basetexture is.
  assert.deepEqual(missing, ['materials/custom/decal_missing.vtf', 'materials/models/custom/thing_skin.vtf']);
});

test('addlist: internal path then disk path, CRLF', () => {
  const text = P.addlist(new Map([['materials/a/b.vtf', 'X:\\m\\a\\b.vtf'], ['sound/c.wav', 'X:\\s\\c.wav']]));
  assert.equal(text, 'materials/a/b.vtf\r\nX:\\m\\a\\b.vtf\r\nsound/c.wav\r\nX:\\s\\c.wav\r\n');
});

test('overlay: Hammer keys, upright basis, sized to the image and fitted to the face', () => {
  const solid = world.children.at(-2), fs = V.faces(solid), top = fs.find(f => f.n[2] === 1), east = fs.find(f => f.n[0] === 1);
  const o = overlay(top, [128, 100, 128.004], 64, 32, 'CUSTOM/DECAL', nextId), kv = Object.fromEntries(o.kv);
  assert.deepEqual(o.kv.map(p => p[0]), ['id', 'classname', 'angles', 'BasisNormal', 'BasisOrigin', 'BasisU', 'BasisV', 'EndU', 'EndV',
    'fademindist', 'material', 'sides', 'StartU', 'StartV', 'uv0', 'uv1', 'uv2', 'uv3', 'origin']);
  assert.deepEqual([kv.BasisNormal, kv.BasisOrigin, kv.BasisU, kv.BasisV, kv.origin], ['0 0 1', '128 100 128', '1 0 0', '0 1 0', '128 100 128']);
  assert.deepEqual([kv.uv0, kv.uv1, kv.uv2, kv.uv3, kv.sides, kv.StartV, kv.EndV], ['-32 -16 0', '-32 16 0', '32 16 0', '32 -16 0', V.get(top.side, 'id'), '1', '0']);
  assert.equal(V.kids(o, 'editor').length, 1);
  // 512 x 512 on the 256 x 128 east wall: scaled by 1/4; U along +y (the wall's texture u), V up.
  const w = Object.fromEntries(overlay(east, [256, 128, 64], 512, 512, 'X', nextId).kv);
  assert.deepEqual([w.BasisNormal, w.BasisU, w.BasisV, w.uv2], ['1 0 0', '0 1 0', '0 0 1', '64 64 0']);
  // West wall: its texture u axis is +y too, which points left seen from the front; the image still goes right and up.
  const west = fs.find(f => f.n[0] === -1), x = Object.fromEntries(overlay(west, [0, 128, 64], 64, 64, 'X', nextId).kv);
  assert.deepEqual([x.BasisNormal, x.BasisU, x.BasisV], ['-1 0 0', '0 -1 0', '0 0 1']);
});
