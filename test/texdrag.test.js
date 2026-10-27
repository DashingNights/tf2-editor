// Texture drag (src/texdrag.js): moving keeps the texel under the cursor, turning keeps the texel at the centre.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false } };
const T = await import('../src/texdrag.js');
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const texel = (a, p) => dot(p, a.v) / a.scale + a.shift;
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);

test('moving: the texel under p ends up under p + d; whole texels when asked', () => {
  const a = T.parseAxis('[1 0 0 7] 0.25'), p = [10, 4, 0], d = [6.3, 2, 0];
  near(texel(T.moved(a, d), [16.3, 6, 0]), texel(a, p));
  assert.equal(T.moved(a, d, true).shift, Math.round(7 - 6.3 / 0.25));
  assert.equal(T.axisText(T.parseAxis('[0 -1 0 12.5] 0.5')), '[0 -1 0 12.5] 0.5');
});

test('turning about the face normal through c keeps the texel at c, the axis stays in the face', () => {
  const a = T.parseAxis('[1 0 0 3] 0.25'), n = [0, 0, 1], c = [40, 24, 64];
  const b = T.turned(a, n, 90, c);
  near(texel(b, c), texel(a, c));
  near(dot(b.v, n), 0);
  near(b.v[1], 1); // x turned 90 degrees counter-clockwise about +z is +y
  near(T.angle([1, 0, 0], [0, 1, 0], n), 90);
  near(T.angle([1, 0, 0], [0, -1, 0], n), -90);
});
