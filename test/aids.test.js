import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false } };
const { bandHeights, measureText, snapOnSurface, standOn } = await import('../src/aids.js');

test('jump bands: walk, crouch, and unreachable at 1.5x crouch', () => {
  assert.deepEqual(bandHeights(64, 72).map(b => b[0]), [64, 72, 108]);
  assert.deepEqual(bandHeights(50, 80).map(b => b[0]), [50, 80, 120]);
});

test('measurement label: total and absolute deltas, one decimal', () => {
  assert.equal(measureText([0, 0, 0], [128, 128, 0]), '181 u   dx 128  dy 128  dz 0');
  assert.equal(measureText([64, 0, 72], [0, 0, 0]), '96.3 u   dx 64  dy 0  dz 72');
  assert.equal(measureText([1, 2, 3], [1, 2, 3]), '0 u   dx 0  dy 0  dz 0');
});

test('hover point snaps to the grid without leaving the surface', () => {
  assert.deepEqual(snapOnSurface([37, -70, 16], [0, 0, 1], 16), [32, -64, 16], 'floor: x and y snap, z stays');
  assert.deepEqual(snapOnSurface([128, 37, 41], [-1, 0, 0], 32), [128, 32, 32], 'wall: y and z snap, x stays');
  // 45 degree ramp z = x: the snapped x moves z along the slope.
  const s = Math.SQRT1_2, q = snapOnSurface([70, 10, 70], [-s, 0, s], 64);
  assert.deepEqual(q.slice(0, 2), [64, 0]);
  assert.ok(Math.abs(q[2] - 64) < 1e-9);
});

test('player hull stands on floors and clears walls and ceilings', () => {
  assert.deepEqual(standOn([32, 64, 16], [0, 0, 1]), [32, 64, 16]);
  assert.deepEqual(standOn([128, 32, 0], [-1, 0, 0]), [104, 32, 0]);
  assert.deepEqual(standOn([0, 0, 256], [0, 0, -1]), [0, 0, 174]);
});
