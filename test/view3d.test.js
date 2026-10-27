// node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false } };
const THREE = await import('three');
const V = await import('../vmf.js');
const { scaleExtent, rotOf, pushed, extrudeBox, movePlane } = await import('../src/view3d.js');

test('gizmo scale snaps the size to the grid and keeps on-grid corners on the grid', () => {
  assert.deepEqual(scaleExtent(0, 64, 2, 64), [0, 128], 'the - face stays, only the dragged + face moves');
  assert.deepEqual(scaleExtent(0, 64, 3, 64), [0, 192]);
  assert.deepEqual(scaleExtent(0, 64, 0.4, 64), [0, 64], 'never below one grid step');
  assert.deepEqual(scaleExtent(0, 64, 0.5, 16), [0, 32]);
  assert.deepEqual(scaleExtent(0, 16, 1.2, 64), [0, 16], 'small brush keeps its size until a grid step fits');
  assert.deepEqual(scaleExtent(0, 64, 3, 64, true), [-64, 128], 'centered (XYZ cube) grows both ends');
  assert.deepEqual(scaleExtent(0, 64, 0.5, 16, true), [16, 48]);
  assert.deepEqual(scaleExtent(0, 64, 0.5, 16, false, true), [32, 64], 'a - side handle moves the - face, the + face stays');
  assert.deepEqual(scaleExtent(0, 64, 2, 64, false, true), [-64, 64]);
});

test('gizmo rotation becomes a snapped axis/angle for vmf.rotate', () => {
  const q = (ax, deg) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...ax).normalize(), (deg * Math.PI) / 180);
  assert.deepEqual(rotOf(q([0, 0, 1], 90), 15), { axis: 2, deg: 90 });
  assert.deepEqual(rotOf(q([0, 0, -1], 90), 15), { axis: 2, deg: -90 });
  assert.deepEqual(rotOf(q([1, 0, 0], 14), 15), { axis: 0, deg: 15 });
  assert.deepEqual(rotOf(q([0, 1, 0], 270), 15), { axis: 1, deg: -90 });
  assert.equal(rotOf(q([0, 0, 1], 2), 15), null);
  const r = rotOf(q([1, 1, 0], 30), 15);
  assert.equal(r.deg, 30);
  assert.ok(Math.abs(r.axis[0] - Math.SQRT1_2) < 1e-9 && Math.abs(r.axis[1] - Math.SQRT1_2) < 1e-9);

  let id = 0;
  const b = V.block([0, 0, 0], [64, 32, 16], 'DEV/X', () => String(++id));
  V.rotate(b, [0, 0, 0], 2, 90);
  assert.deepEqual(V.bounds(V.faces(b)), [[-32, 0, 0], [0, 64, 16]], 'vmf.rotate takes an axis index, right-handed');
});

test('push/pull moves one plane; invalid results are refused', () => {
  let id = 0;
  const b = V.block([0, 0, 0], [64, 64, 64], 'DEV/X', () => String(++id)), top = V.faces(b).find(f => f.n[2] > 0.99);
  const r = pushed(b, top.side, top.n, 32);
  assert.deepEqual(V.bounds(r.faces), [[0, 0, 0], [64, 64, 96]]);
  assert.deepEqual(V.bounds(V.faces(b)), [[0, 0, 0], [64, 64, 64]], 'pushed() leaves the brush alone');
  assert.equal(pushed(b, top.side, top.n, -64), null, 'zero thickness');
  assert.equal(pushed(b, top.side, top.n, -96), null, 'through the far side');
  movePlane(top.side, top.n, -16);
  assert.deepEqual(V.bounds(V.faces(b)), [[0, 0, 0], [64, 64, 48]]);
});

test('extrude builds a box on an axis-aligned face', () => {
  let id = 0;
  const fs = V.faces(V.block([0, 0, 0], [64, 64, 64], 'DEV/X', () => String(++id)));
  const top = fs.find(f => f.n[2] > 0.99), bottom = fs.find(f => f.n[2] < -0.99);
  assert.deepEqual(extrudeBox(top, 32), [[0, 0, 64], [64, 64, 96]]);
  assert.deepEqual(extrudeBox(bottom, 32), [[0, 0, -32], [64, 64, 0]]);
  assert.deepEqual(extrudeBox(top, -16), [[0, 0, 48], [64, 64, 64]]);
  assert.equal(extrudeBox(top, 0), null);
  assert.equal(extrudeBox({ n: [Math.SQRT1_2, 0, Math.SQRT1_2], pts: [] }, 16), null, 'slanted face');
});

test('textured mesh: one group per material, texel UVs, picking maps a hit to its face', async () => {
  const { makeMesh } = await import('../src/view3d.js');
  let id = 0;
  const b = V.block([0, 0, 0], [64, 64, 64], 'DEV/A', () => String(++id)), faces = V.faces(b);
  const top = faces.find(f => f.n[2] > 0.99);
  V.set(top.side, 'material', 'DEV/B');
  const m = makeMesh({ node: b, faces, point: false });
  assert.deepEqual(m.userData.mats, ['dev/a', 'dev/b']);
  assert.deepEqual(m.geometry.groups.map(g => [g.start, g.count, g.materialIndex]), [[0, 30, 0], [30, 6, 1]]);
  assert.ok(Array.isArray(m.material) && m.material.length === 2);
  const uv = m.geometry.getAttribute('uv'), want = V.uv(top, 1, 1);
  assert.deepEqual([uv.getX(30), uv.getY(30)], want[0], 'uv of the first top vertex');
  m.updateMatrixWorld();
  const ray = new THREE.Raycaster(new THREE.Vector3(10, 20, 200), new THREE.Vector3(0, 0, -1));
  const h = ray.intersectObject(m)[0];
  assert.equal(faces[m.userData.tri[h.faceIndex]].side, top.side);
  const side = new THREE.Raycaster(new THREE.Vector3(200, 20, 30), new THREE.Vector3(-1, 0, 0)).intersectObject(m)[0];
  assert.ok(faces[m.userData.tri[side.faceIndex]].n[0] > 0.99, '+X face');
});
