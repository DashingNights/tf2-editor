// node --test "test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false } };
const V = await import('../vmf.js');
const F = await import('../src/fgd.js');
const L = await import('../src/lighting.js');
const H = await import('../src/helpers.js');

const near = (a, b, msg) => assert.ok(a.every((x, i) => Math.abs(x - b[i]) < 1e-6), `${msg}: ${a} != ${b}`);
const ent = (kv, children = []) => ({ name: 'entity', kv: Object.entries(kv), children });

const MAP = `world
{
	"id" "1"
	"classname" "worldspawn"
}
entity
{
	"id" "2"
	"classname" "light"
	"_light" "255 128 0 200"
	"_fifty_percent_distance" "256"
	"origin" "0 0 64"
}
entity
{
	"id" "3"
	"classname" "light_spot"
	"_light" "255 255 255 255"
	"_cone" "60"
	"_inner_cone" "20"
	"angles" "-90 0 0"
	"pitch" "-90"
	"origin" "128 0 128"
}
entity
{
	"id" "4"
	"classname" "light_environment"
	"_light" "255 255 255"
	"_ambient" "128 128 255 51"
	"angles" "0 90 0"
	"pitch" "-45"
	"origin" "0 0 256"
}
hidden
{
	entity
	{
		"id" "5"
		"classname" "light"
		"origin" "0 0 0"
	}
}
entity
{
	"id" "6"
	"classname" "info_target"
	"origin" "0 0 0"
}
`;

test('lighting: lights from a VMF, hidden ones skipped', () => {
  const ls = L.extract(V.parse(MAP));
  assert.deepEqual(ls.map(l => l.kind), ['point', 'spot', 'sun']);
  const [pt, spot, sun] = ls;
  near(pt.color, [200 / 255, (128 / 255) * (200 / 255), 0], 'colour scaled by brightness');
  assert.deepEqual([pt.fifty, pt.zero, pt.distance], [256, 0, 0]);
  near(spot.dir, [0, 0, -1], 'pitch -90 shines down');
  assert.deepEqual([spot.cone, spot.inner], [60, 20]);
  near(sun.color, [1, 1, 1], 'three numbers: full brightness');
  near(sun.dir, [0, Math.SQRT1_2, -Math.SQRT1_2], 'yaw 90, pitch -45');
  near(sun.ambient, [(128 / 255) * 0.2, (128 / 255) * 0.2, 0.2], 'ambient');
});

test('lighting: light direction like vrad', () => {
  near(L.lightDir('0 180 0'), [-1, 0, 0], 'yaw only');
  near(L.lightDir('-30 0 0', 0), [Math.cos(Math.PI / 6), 0, -0.5], 'angles pitch when the pitch key is 0');
  near(L.lightDir('0 0 0', 0, -2), [0, 0, -1], 'angle -2 is down');
  near(L.lightDir('0 0 0', 0, -1), [0, 0, 1], 'angle -1 is up');
  near(L.lightColor('100'), [100 / 255, 100 / 255, 100 / 255], 'one number is grey');
});

test('info_overlay quad: basis, uv corners, texture coordinates, lifted off the face', () => {
  const n = ent({ classname: 'info_overlay', BasisOrigin: '0 0 0', BasisU: '1 0 0', BasisV: '0 1 0', BasisNormal: '0 0 1', StartU: '0', EndU: '1', StartV: '1', EndV: '0',
    uv0: '-16 -8 0', uv1: '-16 8 0', uv2: '16 8 0', uv3: '16 -8 0', origin: '0 0 0' });
  const q = H.overlayQuad(n);
  assert.deepEqual(q.pts.map(p => p.slice(0, 2)), [[-16, -8], [-16, 8], [16, 8], [16, -8]]);
  assert.ok(q.pts.every(p => p[2] > 0 && p[2] < 1), 'lifted along BasisNormal');
  assert.deepEqual(q.uv, [[0, 1], [0, 0], [1, 0], [1, 1]], 'bottom-left of the image at uv0 (StartV 1)');
  assert.equal(H.overlayQuad(ent({ classname: 'info_overlay', origin: '0 0 0' })), null);
});

test('infodecal lands on the face it touches, along the face texture axes', () => {
  let id = 0;
  const b = V.block([0, 0, 0], [128, 128, 64], 'DEV/X', () => String(++id)), faces = V.faces(b), [min, max] = V.bounds(faces);
  const c = { point: false, faces, min, max };
  const top = H.decalFace([32, 32, 64.5], [c]);
  near(top.n, [0, 0, 1], 'top face');
  assert.equal(H.decalFace([32, 32, 80], [c]), null, 'too far above');
  assert.equal(H.decalFace([200, 32, 64], [c]), null, 'outside the face');
  const q = H.decalQuad([32, 32, 64.5], top, 16, 8);
  const xs = q.pts.map(p => p[0]), ys = q.pts.map(p => p[1]);
  assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], [24, 40, 28, 36]);
  assert.ok(q.pts.every(p => Math.abs(p[2] - 64.25) < 1e-9), 'on the plane, lifted');
});

test('entity links: target, parentname, outputs, wildcards, FGD line() and vecline()', () => {
  const a = ent({ classname: 'logic_relay', targetname: 'relay', target: 'door*' }, [{ name: 'connections', kv: [['OnTrigger', 'Lamp\x1bTurnOn\x1b\x1b0\x1b-1'], ['OnSpawn', '!self,Kill,,0,-1']], children: [] }]);
  const d1 = ent({ classname: 'func_door', targetname: 'door1' }), d2 = ent({ classname: 'func_door', targetname: 'door2', parentname: 'relay' });
  const lamp = ent({ classname: 'light', targetname: 'lamp' });
  const sc = ent({ classname: 'env_soundscape', targetname: 'sc', position0: 'lamp', position1: 'nobody' });
  const vl = ent({ classname: 'vl', dest: '1 2 3' });
  const fgd = F.parse('@PointClass line(255 0 0, targetname, position0) line(255 0 0, targetname, position1) = env_soundscape []\n@PointClass vecline(dest) = vl []');
  const out = H.links([a, d1, d2, lamp, sc, vl], cls => F.resolve(fgd, cls));
  const names = out.map(([x, y, c]) => [kv(x), Array.isArray(y) ? y : kv(y), c]);
  assert.deepEqual(names, [
    ['relay', 'door1', H.TARGET], ['relay', 'door2', H.TARGET], ['relay', 'lamp', H.OUTPUT],
    ['sc', 'lamp', 'rgb(255,0,0)'], [undefined, [1, 2, 3], H.TARGET],
  ], 'door2 > relay (parent) is the same pair as relay > door2; !self is skipped');
  function kv(n) { return H.kv(n, 'TargetName'); }
});

test('selected helper shapes: sphere radius key, light cone, wirebox', () => {
  const fgd = F.parse('@PointClass color(255 0 0) sphere(radius) lightcone() wirebox(mins, maxs) = x []'), d = F.resolve(fgd, 'x');
  const n = ent({ classname: 'x', origin: '0 0 0', radius: '100', _cone: '45', _inner_cone: '30', pitch: '-90', angles: '-90 0 0', _zero_percent_distance: '200', mins: '-8 -8 -8', maxs: '8 8 8' });
  const segs = H.shapes(n, d), red = segs.filter(s => s[2] === 'rgb(255,0,0)');
  const far = Math.max(...red.flatMap(([a, b]) => [a, b]).map(p => Math.hypot(...p)));
  assert.ok(Math.abs(far - 200) < 1e-6, 'the outer cone reaches the zero percent distance');
  const sphere = red.slice(0, 144).flatMap(([p]) => [Math.hypot(...p)]);
  assert.ok(sphere.every(r => Math.abs(r - 100) < 1e-6), 'three rings of the radius key');
  assert.ok(red.slice(144).some(([a, b]) => a[2] < -100 || b[2] < -100), 'cone points down');
  assert.equal(segs.filter(s => s[0].every(x => Math.abs(x) === 8) && s[1].every(x => Math.abs(x) === 8)).length, 12, 'wirebox edges');
  assert.deepEqual(H.shapes(n, null), []);
});

test('FGD helpers on the real light_spot drive the cone', { skip: !existsSync('D:/SteamLibrary/steamapps/common/Team Fortress 2/bin/tf.fgd') }, async () => {
  const map = await F.load('D:/SteamLibrary/steamapps/common/Team Fortress 2/bin/tf.fgd', p => readFile(p, 'utf8').catch(() => null));
  const n = ent({ classname: 'light_spot', origin: '0 0 0', angles: '-90 0 0', pitch: '-90', _cone: '45', _inner_cone: '30', _fifty_percent_distance: '100' });
  const segs = H.shapes(n, F.resolve(map, 'light_spot'));
  assert.ok(segs.length > 100, 'two cones and the two falloff spheres');
});
