// node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false } };
const { rotation } = await import('../vmf.js');
const { screenMatrix, previewFn } = await import('../src/view2d.js');

const views = [['top', [0, 1]], ['front', [1, 2]], ['side', [0, 2]]].map(([name, ax]) => ({ name, ax, c: [100, -40], z: 0.37, w: 613, h: 424 }));
// Reference: the preview applied to the 3D point, then the view's projection (what draw did per point).
function expected(v, xf, p) {
  if (xf?.r) { const m = rotation(xf.r.axis, xf.r.deg), o = xf.r.pivot; p = m.map((r, i) => r.reduce((a, x, k) => a + x * (p[k] - o[k]), 0) + o[i]); }
  else if (xf) p = p.map((x, k) => x * xf.s[k] + xf.t[k]);
  return [(p[v.ax[0]] - v.c[0]) * v.z + v.w / 2, v.h / 2 - (p[v.ax[1]] - v.c[1]) * v.z];
}
const apply = ([a, b, c, d, e, f], p, v) => [a * p[v.ax[0]] + c * p[v.ax[1]] + e, b * p[v.ax[0]] + d * p[v.ax[1]] + f];
const pts = [[0, 0, 0], [128, -64, 32], [-1000, 512, 777], [3.5, 9.25, -12]];
const close = (a, b) => assert.ok(a.every((x, i) => Math.abs(x - b[i]) < 1e-6), `${a} vs ${b}`);

test('screenMatrix matches the per-point projection for no preview, move/scale and in-plane rotations', () => {
  const xfs = [null, { s: [1, 1, 1], t: [64, -128, 32] }, { s: [2, 0.5, 3], t: [-10, 20, 5] }];
  for (const v of views) {
    const depth = 3 - v.ax[0] - v.ax[1];
    for (const xf of [...xfs, { s: [1, 1, 1], t: [0, 0, 0], r: { axis: depth, deg: 37, pivot: [10, 20, 30] } }]) {
      const m = screenMatrix(v, xf);
      for (const p of pts) close(apply(m, p, v), expected(v, xf, p));
    }
  }
});

test('screenMatrix is null for a rotation that leaves the view plane, except a half turn', () => {
  const v = views[0], r = (axis, deg) => ({ s: [1, 1, 1], t: [0, 0, 0], r: { axis, deg, pivot: [5, 6, 7] } });
  assert.equal(screenMatrix(v, r(0, 30)), null);
  assert.equal(screenMatrix(v, r([1, 1, 1], 30)), null);
  const m = screenMatrix(v, r(0, 180)); // a mirror in the view plane
  for (const p of pts) close(apply(m, p, v), expected(v, r(0, 180), p));
});

test('a scale in a turned frame: one matrix in the top view, point by point in the others', () => {
  const xf = { s: [2, 0.5, 3], t: [-10, 20, 5], yaw: 30 }, f = previewFn(xf);
  const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
  // along the frame's own x a point moves twice as far out
  close(f([c * 10, s * 10, 0]), [c * 20 + c * -10 - s * 20, s * 20 + s * -10 + c * 20, 5]);
  for (const v of views) {
    const m = screenMatrix(v, xf);
    if (v.name !== 'top') { assert.equal(m, null); continue; }
    for (const p of pts) { const q = f(p); close(apply(m, p, v), [(q[0] - v.c[0]) * v.z + v.w / 2, v.h / 2 - (q[1] - v.c[1]) * v.z]); }
  }
});
