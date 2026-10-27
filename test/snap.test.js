// Object snapping (src/snap.js): vertex, edge, intersection and face targets, axis limits, the drag's own brushes skipped.
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
const off = () => { cfg.snapVertex = cfg.snapEdge = cfg.snapIntersection = cfg.snapFace = false; };

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

// hand-made targets: a north-south and an east-west edge crossing at the origin
const NS = [[0, -50, 0], [0, 50, 0]], EW = [[-50, 0, 0], [50, 0, 0]];

test('intersection snap: the moving point goes onto the crossing of two edges and beats plain edge snapping', () => {
  off(); cfg.snapIntersection = true;
  assert.equal(snap.any(), true);
  const geo = { pts: [], edges: [NS, EW] };
  const r = snap.snapper({ proj, moving: [[3, 2, 0]], geo })([0, 0, 0], free); // (3, 2) is 3.6 px from the crossing
  assert.deepEqual(r.t, [-3, -2, 0]);
  assert.deepEqual(r.at, [0, 0, 0]);
  assert.equal(snap.snapper({ proj, moving: [[9, 8, 0]], geo })([0, 0, 0], free), null); // 12 px away
  assert.equal(snap.snapper({ proj, moving: [[1, 0, 0]], geo: { pts: [], edges: [NS] } })([0, 0, 0], free), null); // one edge: no plain edge snap
  cfg.snapEdge = true; // (2, 4) is 2 px from NS but 4.5 px from the crossing: the crossing still wins
  assert.deepEqual(snap.snapper({ proj, moving: [[2, 4, 0]], geo })([0, 0, 0], free).at, [0, 0, 0]);
  cfg.snapEdge = false;
  // own (poly edit): the crossing nearest the cursor; the moving point goes onto it
  assert.deepEqual(snap.snapper({ proj, moving: [[10, 10, 0]], own: true, geo })([0, 0, 0], free, proj([1, 1, 0])).t, [-10, -10, 0]);
  // a block corner (view2d.js): one moving point at the origin, the offset is the point under the cursor
  assert.deepEqual(snap.snapper({ proj, moving: [[0, 0, 0]], geo })([4, -3, 0], free).at, [0, 0, 0]);
  off();
});

test('intersection snap: parallel, collinear and end-on edges, and lines that cross off the segments, give nothing', () => {
  off(); cfg.snapIntersection = true;
  const none = (edges, p) => assert.equal(snap.snapper({ proj, moving: [p], geo: { pts: [], edges } })([0, 0, 0], free), null);
  none([NS, [[5, -50, 0], [5, 50, 0]]], [2, 1, 0]); // parallel
  none([[[0, -50, 0], [0, 10, 0]], [[0, -10, 0], [0, 50, 0]]], [1, 1, 0]); // collinear, overlapping
  none([EW, [[-50, 0, 64], [50, 0, 64]], [[3, 0, 0], [3, 0, 64]]], [3, 1, 0]); // a top view: top and bottom edges overlap, a depth edge is a point
  none([NS, [[5, 0, 0], [50, 0, 0]]], [2, 1, 0]); // the lines cross at the origin, off the second edge
  off();
});

test('intersection snap in 3D: a crossing on screen counts only where the edges nearly meet, at their midpoint', () => {
  off(); cfg.snapIntersection = true;
  const ray = s => ({ o: [s[0], -s[1], 1000], d: [0, 0, -1] }), all = a => a; // looking down, the screen as in proj
  const at = z => snap.snapper({ proj, ray, moving: [[3, 2, 0]], geo: { pts: [], edges: [NS, EW.map(p => [p[0], p[1], z])] } })([0, 0, 0], all);
  assert.equal(at(20), null); // EW passes 20 units above NS: they only cross on screen
  assert.deepEqual(at(0.5), { t: [-3, -2, 0.25], at: [0, 0, 0.25] });
  off();
});

test('intersection snap: the nearest of many crossings wins; edge snap alone gives a crossing no bonus', () => {
  off(); cfg.snapIntersection = true;
  const edges = [];
  for (let k = 0; k <= 40; k += 4) edges.push([[k, 0, 0], [k, 64, 0]], [[0, k, 0], [64, k, 0]]); // lines 4 units apart
  const go = p => snap.snapper({ proj, moving: [p], geo: { pts: [], edges } })([0, 0, 0], free).at;
  assert.deepEqual(go([9.25, 13.125, 0]), [8, 12, 0]);
  cfg.snapEdge = true; // 1.1 px from the line y = 12, 1.7 px from the crossing: the crossing still wins
  assert.deepEqual(go([9.25, 13.125, 0]), [8, 12, 0]);
  cfg.snapIntersection = false; // edge snap alone: the nearest line
  assert.deepEqual(go([9.25, 13.125, 0]), [9.25, 12, 0]);
  off();
});

test('intersection snap: degenerate edges (a point, NaN, behind the camera) give nothing; a point on the crossing stays', () => {
  off(); cfg.snapIntersection = true;
  const pz = p => (p[2] > 100 ? null : proj(p)); // above z = 100: behind the camera
  for (const e of [[[0, 0, 0], [0, 0, 0]], [[0, NaN, 0], [0, 50, 0]], [[0, -50, 0], [0, 50, 200]]])
    assert.equal(snap.snapper({ proj: pz, moving: [[1, 1, 0]], geo: { pts: [], edges: [EW, e] } })([0, 0, 0], free), null);
  assert.deepEqual(snap.snapper({ proj, moving: [[0, 0, 0]], geo: { pts: [], edges: [NS, EW] } })([0, 0, 0], free), { t: [0, 0, 0], at: [0, 0, 0] });
  off();
});

test('intersection snap in 3D, in perspective: edges that meet (a cross, a T) pull; edges that only cross on screen do not', () => {
  off(); cfg.snapIntersection = true;
  // a camera at (0, 0, 1000) looking down, 800 px focal length, the screen centre at (400, 300)
  const pp = p => { const z = 1000 - p[2]; return z > 1 ? [400 + (800 * p[0]) / z, 300 - (800 * p[1]) / z] : null; };
  const ray = s => ({ o: [0, 0, 1000], d: [(s[0] - 400) / 800, -(s[1] - 300) / 800, -1] }), all = a => a;
  const A = [[-90, 20, 0], [110, 20, 0]], B = [[10, -80, 0], [10, 120, 0]];
  const go = (edges, p, cursor, own = false) => snap.snapper({ proj: pp, ray, moving: [p], own, geo: { pts: [], edges } })([0, 0, 0], all, cursor);
  assert.deepEqual(go([A, B], [13, 22, 0]), { t: [-3, -2, 0], at: [10, 20, 0] });
  assert.equal(go([A, B.map(p => [p[0], p[1], 200])], [12.5, 20, 0]), null); // B lifted 200 units crosses A on screen at (12.5, 20, 0)
  assert.deepEqual(go([A, [[10, 20, 0], [10, 120, 0]]], [12, 22, 0]).at, [10, 20, 0]); // a T: B ends on A
  assert.deepEqual(go([A, B], [50, 50, 0], pp([11, 21, 0]), true).t, [-40, -30, 0]); // own (poly gizmo): the crossing nearest the cursor
  off();
});

test('intersection snap on brushes: outlines crossing in the top and front views; the snapped move undoes and redoes', () => {
  st.load(st.EMPTY, null);
  st.createBlock([0, 0, 0], [64, 64, 64]); st.createBlock([32, 32, 0], [96, 96, 128]);
  const c = st.createBlock([200, 200, 0], [264, 264, 64]);
  off(); cfg.snapIntersection = true;
  const go = t => snap.snapper({ proj, moving: snap.movingOf([c]), skip: n => n === c })(t, free);
  // top view: the first box's east edge x = 64 crosses the second's south edge y = 32; c's corner (200, 200) at (66, 35)
  const r = go([-134, -165, 0]);
  assert.deepEqual([r.t, r.at.slice(0, 2)], [[-136, -168, 0], [64, 32]]);
  st.setSelection([c]);
  st.transformSel([1, 1, 1], r.t);
  st.undo();
  assert.deepEqual(st.cache.get(c).min, [200, 200, 0]);
  assert.deepEqual(go([-134, -165, 0]).t, r.t); // a new drag after the undo: the same target
  st.redo();
  assert.deepEqual(st.cache.get(c).min, [64, 32, 0]);
  assert.deepEqual(go([0, 0, 0]).t, [0, 0, 0]); // already on it
  // front view (y right, z up): the first box's top z = 64 crosses the second's west side y = 32; a block corner there
  assert.deepEqual(snap.snapper({ proj: p => [p[1], -p[2]], moving: [[0, 0, 0]], skip: n => n === c })([0, 33, 65], a => a).at.slice(1), [32, 64]);
  off();
});

test('a 2D drag snapper keeps its targets when the wheel zooms the view during the drag (view2d projNow)', async () => {
  const { projNow, toScreen, toWorld } = await import('../src/view2d.js');
  st.load(st.EMPTY, null);
  st.createBlock([0, 0, 0], [64, 64, 64]); st.createBlock([32, 32, 0], [96, 96, 128]); // a crossing at (64, 32)
  st.createBlock([512, 0, 0], [576, 64, 64]); st.createBlock([544, 32, 0], [608, 96, 128]); // and at (576, 32)
  off(); cfg.snapIntersection = true;
  const v = { name: 'top', ax: [0, 1], c: [0, 0], z: 0.5, w: 800, h: 600 }, s = snap.snapper({ proj: projNow(v), moving: [[0, 0, 0]] });
  const corner = (x, y) => { const w = toWorld(v, x, y); return s([w[0], w[1], 0], a => a)?.at.slice(0, 2) ?? null; }; // view2d corner()
  v.z *= 2.5; // zoomed in about the screen centre after the drag began
  const q = toScreen(v, [576, 32, 0]);
  assert.deepEqual(corner(q[0] + 3, q[1]), [576, 32]); // 3 px from the crossing now: it pulls
  const old = projNow({ ...v, z: 0.5 })([576, 32, 0]);
  assert.equal(corner(old[0], old[1]), null); // where it was on screen before the zoom: nothing there now
  off();
});
