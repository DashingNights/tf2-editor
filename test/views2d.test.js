// node --test "test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false } };
const THREE = await import('three');
const { gridStep, coord } = await import('../src/view2d.js');
const { rows, project, aim } = await import('../src/extras2d.js');

const near = (a, b, msg) => assert.ok(a.every((x, i) => Math.abs(x - b[i]) < 1e-6), `${msg}: ${[...a]} != ${b}`);

test('grid step: sub-unit grids, lines at least 6 px apart, the grid times a power of two', () => {
  assert.equal(gridStep(0.125, 50), 0.125, '6.25 px apart: drawn as it is');
  assert.equal(gridStep(0.125, 10), 1, 'levels denser than 6 px are skipped');
  assert.equal(gridStep(64, 0.05), 128);
  assert.equal(gridStep(0, 1), 8, 'no grid: from 1 unit');
  for (const g of [0.125, 0.25, 0.5, 1, 8, 64, 1024]) for (const z of [0.002, 0.03, 0.4, 1, 7, 50]) {
    const s = gridStep(g, z), k = Math.log2(s / g);
    assert.ok(s * z >= 6 && (s === g || s * z < 12), `grid ${g} at zoom ${z}: ${s}`);
    assert.equal(k, Math.round(k), `grid ${g} at zoom ${z}: ${s} is not the grid doubled`);
  }
});

test('status bar coordinates: whole units, or on a sub-unit grid with its decimals', () => {
  assert.equal(coord(12.37, 8), 12);
  assert.equal(coord(12.37, 1), 12);
  assert.equal(coord(12.37, 0.5), 12.5);
  assert.equal(coord(12.37, 0.125), 12.375);
  assert.equal(coord(0.1, 0.125), 0.125);
  assert.equal(coord(-3.06, 0.25), -3);
});

test('model edges project like the placed model: yaw, pitch and modelscale', () => {
  const pts = [10, 0, 0, 0, 0, 5]; // a point on the model's x axis, one on its z axis
  const place = (pitch, yaw, s) => new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0, pitch, yaw, 'ZYX')).scale(new THREE.Vector3(s, s, s)).elements;
  const yaw90 = place(0, Math.PI / 2, 2);
  near(project(pts, rows(yaw90, [0, 1])), [0, 20, 0, 0], 'top: the model x axis points along world y, twice as long');
  near(project(pts, rows(yaw90, [1, 2])), [20, 0, 0, 10], 'front (y, z)');
  near(project(pts, rows(yaw90, [0, 2])), [0, 0, 0, 10], 'side (x, z): the x axis seen end on');
  const pitch = place(Math.PI / 2, 0, 1); // Source pitch 90: nose down
  near(project(pts, rows(pitch, [0, 2])), [0, -10, 5, 0], 'side: pitched down');
  const e = new THREE.Matrix4().compose(new THREE.Vector3(100, 200, 300), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1)).elements;
  near(project(pts, rows(e, [0, 1])), [10, 0, 0, 0], 'the origin is left out (the outline is moved there by a matrix)');
});

test('turning the camera from a 2D view keeps the part of its direction along the view depth', () => {
  const f = { pos: [0, 0, 64], yaw: 0, pitch: -0.5 };
  const top = aim(f, [0, 1], [0, 10]);
  near([top.yaw, top.pitch], [Math.PI / 2, -0.5], 'top view: yaw follows the pointer, pitch stays');
  const g = { pos: [0, 0, 0], yaw: Math.PI / 4, pitch: 0 };
  const front = aim(g, [1, 2], [0, 10]); // front view (y, z): pointer straight above
  near([front.yaw, front.pitch], [0, Math.PI / 4], 'front view: the y part turns up, the x part stays');
  const along = aim({ pos: [0, 0, 0], yaw: 0, pitch: 0 }, [1, 2], [5, 5]);
  near([along.yaw, along.pitch], [0, 0], 'looking along the depth axis: no change');
  assert.equal(aim(f, [0, 1], [0, 0]), null, 'pointer on the camera');
  const side = aim({ pos: [0, 0, 0], yaw: 1, pitch: 0 }, [0, 2], [0, 10]); // side view (x, z): pointer straight above
  near([side.yaw, side.pitch], [Math.PI / 2, Math.atan2(Math.cos(1), Math.sin(1))], 'side view: the x part turns up, the y part stays');
  const up = aim({ pos: [0, 0, 0], yaw: Math.PI, pitch: 0 }, [0, 2], [0, 10]);
  near([up.yaw, up.pitch], [Math.PI, 1.55], 'straight up: pitch clamped as the fly camera does, yaw kept');
});
