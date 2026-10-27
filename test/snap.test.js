// Object snapping (src/snap.js): vertex, edge and face targets, axis limits, the drag's own brushes skipped.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false } };
const st = await import('../src/state.js');
const snap = await import('../src/snap.js');
const { cfg } = await import('../src/settings.js');

// a top view at 1 pixel per unit
const proj = p => [p[0], -p[1]];
const free = a => [a[0], a[1], 0], xOnly = a => [a[0], 0, 0]; // a top view drag keeps z (its depth axis)
function scene() {
  st.load(st.EMPTY, null);
  const a = st.createBlock([0, 0, 0], [64, 64, 64]), b = st.createBlock([100, 0, 0], [164, 64, 64]);
  return { a, b, moving: snap.movingOf([a]), skip: n => n === a };
}
const off = () => { cfg.snapVertex = cfg.snapEdge = cfg.snapFace = false; };

test('vertex snap: the nearest moving corner lands on the other brush, within 10 pixels only', () => {
  const { moving, skip } = scene();
  off(); cfg.snapVertex = true;
  const s = snap.snapper({ proj, moving, skip });
  assert.deepEqual(s([33, 2, 0], free).t, [36, 0, 0]); // corner (64, 0) is 3.6 px from (100, 0)
  assert.equal(s([20, 2, 0], free), null); // 16 px away: the grid keeps it
  assert.deepEqual(s([33, 5, 0], xOnly).t, [36, 0, 0]); // an x-only drag keeps y
  off();
});

test('edge snap: onto the nearest point of an edge; the dragged brush is never a target', () => {
  const { moving, skip } = scene();
  off(); cfg.snapEdge = true;
  const s = snap.snapper({ proj, moving, skip });
  const r = s([34, 20, 0], free); // corner (64, 0) moved to (98, 20): 2 px from b's west edge x = 100
  assert.deepEqual(r.t, [36, 20, 0]);
  assert.deepEqual(r.at, [100, 20, 0]);
  assert.equal(snap.snapper({ proj, moving, skip: () => false })([0, 0, 0], free).t.every(x => x === 0), true); // own edges: stuck
  off();
});

test('face snap: the moving point nearest the plane under the cursor goes onto it, along the allowed axes', () => {
  const { moving, skip } = scene();
  off(); cfg.snapFace = true;
  const hit = () => ({ point: [100, 30, 10], n: [-1, 0, 0] }); // b's west face, x = 100
  const r = snap.snapper({ proj, hit, moving, skip })([20, 7, 0], free, [0, 0]);
  assert.deepEqual(r.t, [36, 7, 0]); // x of the nearest corner (64 + 20 = 84) to 100; y kept
  assert.equal(snap.snapper({ proj, hit, moving, skip })([20, 7, 0], a => [0, a[1], 0], [0, 0]), null); // no x allowed
  off();
});

test('rayToSegment: the closest point of a segment to a ray, clamped to its ends', () => {
  assert.deepEqual(snap.rayToSegment([0, 0, 10], [0, 0, -1], [-5, 0, 0], [5, 0, 0]), [0, 0, 0]);
  assert.deepEqual(snap.rayToSegment([9, 0, 10], [0, 0, -1], [-5, 0, 0], [5, 0, 0]), [5, 0, 0]);
});

test('poly edit: the brush being edited stays a target, only the moving points are left out; the target nearest the cursor wins', () => {
  st.load(st.EMPTY, null);
  st.createBlock([0, 0, 0], [64, 64, 64]); st.createBlock([67, 2, 0], [131, 66, 64]);
  off(); cfg.snapVertex = true;
  const moving = [[64, 0, 64]]; // one corner of a, dragged along x only
  const s = snap.snapper({ proj, moving, own: true });
  // the cursor at b's corner (67, 2): the corner slides along x onto x = 67, y stays (an x-only drag)
  assert.deepEqual(s([1, 0, 0], xOnly, proj([67, 2, 0])).t, [3, 0, 0]);
  // a free (x and y) drag puts it right on b's corner
  assert.deepEqual(s([1, 0, 0], free, proj([67, 2, 0])).t, [3, 2, 0]);
  // a's own other corners are targets too
  assert.deepEqual(s([0, 0, 0], free, proj([64, 64, 64])).at.slice(0, 2), [64, 64]); // (a top view: either depth)
  off();
});
