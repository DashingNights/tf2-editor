// node --test "test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false } };
const V = await import('../vmf.js');
const D = await import('../src/droptools.js');
const { restPose } = await import('../src/physics.js');
const SP = await import('../src/sprinkle.js');
const PR = await import('../src/propper.js');

const near = (a, b, e = 1e-3) => a.every((x, k) => Math.abs(x - b[k]) < e);
const floor = o => (o[2] >= 0 ? { dist: o[2], n: [0, 0, 1], point: [o[0], o[1], 0] } : null);
const SLOPE = D.unit([-0.5, 0, 1]); // the plane z = x / 2, rising towards +x
const slope = o => ({ dist: o[2] - o[0] / 2, n: SLOPE, point: [o[0], o[1], o[0] / 2] });

test('rayBox: entry face and distance; a ray from inside or past the box misses', () => {
  assert.deepEqual(D.rayBox([0, 0, 100], [0, 0, -1], [-8, -8, 0], [8, 8, 32]), { t: 68, n: [0, 0, 1] });
  assert.deepEqual(D.rayBox([-50, 0, 16], [1, 0, 0], [-8, -8, 0], [8, 8, 32]), { t: 42, n: [-1, 0, 0] });
  assert.equal(D.rayBox([0, 0, 16], [0, 0, -1], [-8, -8, 0], [8, 8, 32]), null, 'starts inside');
  assert.equal(D.rayBox([20, 0, 100], [0, 0, -1], [-8, -8, 0], [8, 8, 32]), null, 'beside it');
  assert.equal(D.rayBox([0, 0, -5], [0, 0, -1], [-8, -8, 0], [8, 8, 32]), null, 'behind the ray');
});

test('anglesFor: up axis along a normal, heading kept; matrixOf turns it back', () => {
  assert.deepEqual(D.anglesFor([0, 0, 1], 30), [0, 30, 0]);
  assert.deepEqual(D.anglesFor([0, 0, 1], -90), [0, 270, 0]);
  assert.deepEqual(D.anglesFor(SLOPE, 0), [-26.565, 0, 0], 'facing uphill: nose up is negative pitch in Source');
  assert.deepEqual(D.anglesFor(D.unit([0, 0.5, 1]), 0), [0, 0, -26.565], 'slope across the heading: roll');
  for (const [up, yaw] of [[D.unit([0.3, -0.2, 1]), 17], [D.unit([-1, 2, 0.5]), 200], [[1, 0, 0], 0], [[0, 0, -1], 45]]) {
    const m = D.matrixOf(D.anglesFor(up, yaw));
    assert.ok(near([m[0][2], m[1][2], m[2][2]], up), `up ${up}`);
  }
  const [mn, mx] = D.worldBox([0, -8, 0], [32, 8, 16], [100, 0, 0], [0, 90, 0]);
  assert.ok(near(mn, [92, 0, 0]) && near(mx, [108, 32, 16]), 'yaw 90: forward is +y');
});

test('physics restPose: falls onto the floor, comes up out of it, sits on its box bottom', () => {
  const p = { origin: [0, 0, 100], angles: [0, 45, 0], lo: [-8, -8, 0], hi: [8, 8, 32] };
  const r = restPose(p, floor);
  assert.ok(near(r.origin, [0, 0, 0]));
  assert.deepEqual(r.angles, [0, 45, 0]);
  assert.ok(near(restPose({ ...p, origin: [0, 0, -10] }, floor).origin, [0, 0, 0]), 'sunk into the floor: comes up');
  assert.ok(near(restPose({ ...p, lo: [-8, -8, -10], hi: [8, 8, 10] }, floor).origin, [0, 0, 10]), 'model centred on its origin');
  assert.deepEqual(restPose(p, floor, 10).angles, [0, 55, 0], 'random yaw is added to the heading');
  assert.equal(restPose(p, () => null), null, 'nothing below');
});

test('physics restPose: aligned to a slope; the first contact under the footprint wins', () => {
  const r = restPose({ origin: [0, 0, 100], angles: [0, 0, 0], lo: [-8, -8, 0], hi: [8, 8, 32] }, slope);
  assert.ok(near(r.origin, [0, 0, 0]), 'on the plane straight below its origin');
  assert.deepEqual(r.angles, [-26.565, 0, 0]);
  const ledge = o => (o[0] > 4 ? { dist: o[2] - 20, n: [0, 0, 1], point: [o[0], o[1], 20] } : floor(o));
  assert.ok(near(restPose({ origin: [0, 0, 100], angles: [0, 0, 0], lo: [-8, -8, 0], hi: [8, 8, 32] }, ledge).origin, [0, 0, 20]), 'caught by a ledge under one side');
  const wall = () => ({ dist: 10, n: [1, 0, 0], point: [0, 0, 6] });
  assert.deepEqual(restPose({ origin: [0, 0, 0], angles: [0, 0, 0], lo: [-8, -8, 0], hi: [8, 8, 32] }, wall).angles, [0, 0, 0], 'steep contact: stays upright');
});

test('sprinkle: weighted pick, model list, scatter disc, preset from props', () => {
  const ms = [{ model: 'a', weight: 1 }, { model: 'b', weight: 3 }];
  assert.deepEqual([0, 0.2, 0.25, 0.99].map(x => SP.pickWeighted(ms, x)), ['a', 'a', 'b', 'b']);
  assert.deepEqual(SP.parseModels('props/rock01 2; models\\x\\y.mdl\n\nfoo 0'), [
    { model: 'models/props/rock01.mdl', weight: 2 }, { model: 'models/x/y.mdl', weight: 1 }, { model: 'models/foo.mdl', weight: 1 }]);
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (const n of [[0, 0, 1], [1, 0, 0], D.unit([1, 1, 1])]) {
    const pts = SP.scatter([10, 20, 30], n, 50, 200, rand);
    assert.equal(pts.length, 200);
    assert.ok(pts.every(p => Math.hypot(p[0] - 10, p[1] - 20, p[2] - 30) <= 50 + 1e-9), 'inside the radius');
    assert.ok(pts.every(p => Math.abs(D.dot(p.map((x, k) => x - [10, 20, 30][k]), n)) < 1e-9), 'across the normal');
  }
  const e = (cls, model, s) => ({ name: 'entity', kv: [['classname', cls], ...(model ? [['model', model]] : []), ...(s ? [['modelscale', s]] : [])], children: [] });
  const p = SP.presetFrom([e('prop_static', 'models/A.mdl', '0.5'), e('prop_static', 'models/a.mdl'), e('prop_dynamic', 'models/b.mdl', '1.5'), e('info_target')], { ...SP.DEF, radius: 64 });
  assert.deepEqual(p, { ...SP.DEF, radius: 64, classname: 'prop_static', models: [{ model: 'models/a.mdl', weight: 2 }, { model: 'models/b.mdl', weight: 1 }], scale: [0.5, 1.5] });
  assert.equal(SP.presetFrom([e('info_target')]), null);
});

test('propper smd: triangles wound with their normals, turned -90 about z round the origin, UVs from the axes', () => {
  let id = 0;
  const fs = V.faces(V.block([0, 0, 0], [64, 32, 16], 'DEV/X', () => String(++id))), o = [32, 16, 0];
  const lines = PR.smd(fs, o, () => 'mat', () => ({ w: 64, h: 64 })).split('\n');
  assert.deepEqual(lines.slice(0, 9), ['version 1', 'nodes', '0 "root" -1', 'end', 'skeleton', 'time 0', '0 0 0 0 0 0 0', 'end', 'triangles']);
  const tris = [];
  for (let i = 9; lines[i] === 'mat'; i += 4) tris.push(lines.slice(i + 1, i + 4).map(l => l.split(' ').map(Number)));
  assert.equal(tris.length, 12);
  assert.deepEqual(lines.slice(9 + 48), ['end', '']);
  const all = tris.flat(), span = k => [Math.min(...all.map(v => v[k])), Math.max(...all.map(v => v[k]))];
  assert.deepEqual([span(1), span(2), span(3)], [[-16, 16], [-32, 32], [0, 16]], 'world x runs along -y, y along x');
  for (const t of tris) {
    const [a, b, c] = t.map(v => v.slice(1, 4)), n = t[0].slice(4, 7);
    assert.ok(D.dot(D.cross(b.map((x, k) => x - a[k]), c.map((x, k) => x - a[k])), n) > 0, 'counter-clockwise seen from outside');
  }
  const top = fs.find(f => f.n[2] > 0.99), uv = V.uv(top, 64, 64), i = lines.indexOf('mat', 9 + 4 * fs.indexOf(top) * 2);
  const v0 = lines[i + 1].split(' ').map(Number);
  assert.ok(near(v0.slice(1, 4), [top.pts[0][1] - 16, 32 - top.pts[0][0], 16]));
  assert.ok(near(v0.slice(7), [uv[0][0], 1 - uv[0][1]]), 'v counts up in an SMD');
  assert.equal(PR.smd(fs, o, f => (f.n[2] > 0.99 ? null : 'mat'), () => null).split('\n').filter(l => l === 'mat').length, 10, 'faces without a material are left out');
});

test('propper physSmd, qc, vmt, turnOf', () => {
  let id = 0;
  const fs = V.faces(V.block([0, 0, 0], [64, 32, 16], 'DEV/X', () => String(++id)));
  const vs = PR.physSmd([fs], [32, 16, 0]).split('\n').filter(l => l.startsWith('0 ') && l.split(' ').length === 9).map(l => l.split(' ').map(Number));
  assert.equal(vs.length, 36);
  assert.ok(vs.every(v => Math.abs(v[1]) === 16 && Math.abs(v[2]) === 32), 'corners where the brush has them');
  assert.ok(vs.every(v => near(v.slice(4, 7), D.unit([v[1], v[2], v[3] - 8]), 1e-5)), 'normals point away from the middle, so a corner is the same on every face');
  const q = PR.qc('crate', 'mymap', 'wood', 3);
  for (const s of ['$modelname "mymap/crate.mdl"', '$staticprop', '$surfaceprop "wood"', '$cdmaterials "models/mymap/propper"', '$body body "crate.smd"', '$sequence idle "crate.smd" fps 30', '$collisionmodel "crate_phys.smd"', '\t$concave']) assert.ok(q.split('\n').includes(s), s);
  assert.ok(!q.includes('$maxconvexpieces') && PR.qc('a', 'b', 'c', 25).includes('$maxconvexpieces 25'));
  const t = PR.vmt('dev/x', { kv: new Map([['$basetexture', 'dev/x_color'], ['$surfaceprop', 'metal'], ['%keywords', 'tf2']]) });
  assert.equal(t, '"VertexLitGeneric"\r\n{\r\n\t"$basetexture" "dev/x_color"\r\n\t"$surfaceprop" "metal"\r\n}\r\n');
  assert.ok(PR.vmt('a/b', null).includes('"$basetexture" "a/b"'));
  const a = [[0, 0, 0], [64, 32, 8]];
  assert.equal(PR.turnOf(a, a), 0);
  assert.equal(PR.turnOf(a, [[-32, 0, 0], [0, 64, 8]]), 90);
  assert.equal(PR.turnOf(a, [[-64, -32, 0], [0, 0, 8]]), 180);
  assert.equal(PR.turnOf(a, [[0, -64, 0], [32, 0, 8]]), 270);
});
