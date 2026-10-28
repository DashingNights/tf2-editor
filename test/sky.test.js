// node --test "test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false } };
const THREE = await import('three');
const { CUBE, skyRoom, fogOf, fogNear, nextBehind } = await import('../src/sky.js');
const { parsePrt, edges } = await import('../src/prt.js');

test('sky faces: three\'s cube lookup of every Source face direction lands on its face at the turned image point', () => {
  // Source (engine st_to_vec): world direction of image point s (right), t (up), both in -1..1.
  const SRC = { rt: (s, t) => [1, -s, t], lf: (s, t) => [-1, s, t], bk: (s, t) => [s, 1, t], ft: (s, t) => [-s, -1, t], up: (s, t) => [-t, -s, 1], dn: (s, t) => [t, -s, -1] };
  // three's background: lookup = diag(-1, 1, 1) * rotation(scene.backgroundRotation)^T * direction (WebGLBackground).
  const m = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(Math.PI / 2, 0, 0))).transpose();
  m.premultiply(new THREE.Matrix3().set(-1, 0, 0, 0, 1, 0, 0, 0, 1));
  // OpenGL's cube map table: face index and (sc, tc) / |major|; t grows down the image (CubeTexture: flipY false).
  function lookup(w) {
    const L = new THREE.Vector3(...w).applyMatrix3(m).toArray(), k = [0, 1, 2].reduce((a, i) => (Math.abs(L[i]) > Math.abs(L[a]) ? i : a), 0), neg = L[k] < 0, a = Math.abs(L[k]);
    const [x, y, z] = L, st = [[neg ? z : -z, -y], [x, neg ? -z : z], [neg ? -x : x, -y]][k];
    return [2 * k + neg, st[0] / a, st[1] / a];
  }
  const turn = ([x, y], q) => (q === 1 ? [-y, x] : q === -1 ? [y, -x] : [x, y]); // canvas rotate, y down
  CUBE.forEach(([f, q], i) => {
    for (const [s, t] of [[0.5, 0.25], [-0.6, 0.3], [0.2, -0.7], [-0.3, -0.4]]) {
      const [face, sc, tc] = lookup(SRC[f](s, t)), [x, y] = turn([s, -t], q);
      assert.equal(face, i, `${f} is cube face ${i}`);
      assert.ok(Math.abs(sc - x) < 1e-9 && Math.abs(tc - y) < 1e-9, `${f} at ${s},${t}: image point ${[x, y]} vs ${[sc, tc]}`);
    }
  });
});

test('3D skybox room: the nearest toolsskybox brush along each axis from the sky_camera', () => {
  const o = [0, 0, 0], W = 100, T = 120;
  const walls = [
    [[-W, -W, -T], [W, W, -W]], [[-W, -W, W], [W, W, T]], // floor, ceiling
    [[W, -W, -W], [T, W, W]], [[-T, -W, -W], [-W, W, W]], [[-W, W, -W], [W, T, W]], [[-W, -T, -W], [W, -W, W]],
  ];
  assert.deepEqual(skyRoom(o, walls), [[-W, -W, -W], [W, W, W]]);
  const extra = [[[500, -W, -W], [520, W, W]], [[-10, -10, -10], [10, 10, 10]], [[200, 200, -W], [220, 220, W]]];
  assert.deepEqual(skyRoom(o, [...extra, ...walls]), [[-W, -W, -W], [W, W, W]], 'farther walls, a box round o and one off the axes are ignored');
  assert.equal(skyRoom(o, walls.filter((w, i) => i !== 1)), null, 'no ceiling: no room');
});

test('fog: env_fog_controller keys with Hammer defaults, cap carried in fogNear', () => {
  const ent = kv => ({ name: 'entity', kv: [['classname', 'env_fog_controller'], ...Object.entries(kv)], children: [] });
  assert.deepEqual(fogOf(ent({ fogenable: '1', fogcolor: '255 128 0', fogstart: '512', fogend: '4000', fogmaxdensity: '.6' })), { color: [1, 128 / 255, 0], start: 512, end: 4000, max: 0.6 });
  assert.deepEqual(fogOf(ent({ fogenable: '1' })), { color: [1, 1, 1], start: 500, end: 2000, max: 1 });
  assert.equal(fogOf(ent({ fogenable: '0' })), null);
  assert.equal(fogOf(ent({})), null, 'fogenable defaults to 0');
  assert.equal(fogOf(ent({ fogenable: '1', fogmaxdensity: '0' })), null);
  assert.equal(fogOf(ent({ fogenable: '1', fogstart: '900', fogend: '100' })).end, 901, 'end after start');
  assert.equal(fogOf(null), null);
  // The patched chunk reads float32 fogNear back: start = floor, cap = 2 * fract (0: 1).
  for (const [start, max] of [[500, 1], [500, 0.6], [4096.7, 0.25], [-64, 0.5], [12000, 0.01]]) {
    const v = Math.fround(fogNear(start, max)), from = Math.floor(v), fr = v - from;
    assert.equal(from, Math.floor(start));
    assert.ok(Math.abs((fr > 0 ? 2 * fr : 1) - max) < 0.005, `cap ${max} read as ${fr > 0 ? 2 * fr : 1}`);
  }
  assert.match(THREE.ShaderChunk.fog_fragment, /skyFogMax/, 'three\'s fog chunk is patched');
  assert.doesNotMatch(THREE.ShaderChunk.fog_fragment, /smoothstep/);
});

test('depth select cycles through the hits along the ray', () => {
  const hits = ['a', 'b', 'c'], S = (...x) => new Set(x);
  assert.equal(nextBehind(hits, S('a')), 1, 'behind the front one');
  assert.equal(nextBehind(hits, S('b')), 2);
  assert.equal(nextBehind(hits, S('c')), 0, 'round to the front');
  assert.equal(nextBehind(hits, S('a', 'b')), 2, 'a group counts as one');
  assert.equal(nextBehind(hits, S('a', 'c')), 1);
  assert.equal(nextBehind(hits, S()), 0);
  assert.equal(nextBehind(hits, S('a', 'b', 'c')), -1);
});

test('portal file: PRT1 portals, malformed lines skipped, outlines closed', () => {
  const text = 'PRT1\n3\n2\n4 0 1 (0 0 0 ) (0 64 0 ) (0 64 64 ) (0 0 64 ) \r\n3 1 2 (64 0 0.5 ) (64 64 0 ) (64 0 64 ) \nnot a portal\n2 1 2 (0 0 0 ) (1 1 1 )\n3 1 2 (0 0 0 ) (1 1 1 )\n';
  const r = parsePrt(text);
  assert.equal(r.leafs, 3);
  assert.deepEqual(r.portals, [[[0, 0, 0], [0, 64, 0], [0, 64, 64], [0, 0, 64]], [[64, 0, 0.5], [64, 64, 0], [64, 0, 64]]]);
  assert.equal(parsePrt('PRT2\n1\n0\n'), null);
  const e = edges([r.portals[1]]);
  assert.equal(e.length, 3 * 2 * 3);
  assert.deepEqual(e.slice(-6), [64, 0, 64, 64, 0, 0.5], 'the last edge closes the outline');
});
