// node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../vmf.js';

let id = 0;
const next = () => String(++id);
const block = (mn = [0, 0, 0], mx = [64, 32, 16]) => V.block(mn, mx, 'DEV/X', next);
const box = s => V.bounds(V.faces(s));
const close = (a, b, eps = 1e-6) => assert.ok(a.flat().every((x, i) => Math.abs(x - b.flat()[i]) < eps), `${a} != ${b}`);
// Texture coordinate (texels) at point p on a side.
const texel = (side, p) => V.uv({ side, pts: [p] }, 1, 1)[0];

test('rotate 90 about Z four times restores the brush exactly', () => {
  const b = block(), before = V.serialize(b), pivot = [10, 20, 0];
  V.rotate(b, pivot, 2, 90);
  assert.deepEqual(box(b), [[-2, 10, 0], [30, 74, 16]]);
  for (const s of V.kids(b, 'side')) {
    assert.match(V.get(s, 'plane'), /^(\(-?\d+ -?\d+ -?\d+\) ?){3}$/, 'integer plane points');
    assert.match(V.get(s, 'uaxis'), /^\[-?\d+ -?\d+ -?\d+ -?\d+\] 0\.25$/, 'exact texture axis');
  }
  V.rotate(b, pivot, 2, 90);
  V.rotate(b, pivot, 2, 90);
  V.rotate(b, pivot, 2, 90);
  assert.equal(V.serialize(b), before);
});

test('rotate keeps texture lock and outward normals', () => {
  const b = block(), pivot = [5, 7, 3];
  const was = V.faces(b).map(f => ({ side: f.side, uv: f.pts.map(p => texel(f.side, p)) }));
  V.rotate(b, pivot, [1, 1, 1], 37);
  assert.ok(V.valid(b));
  const now = V.faces(b), all = now.flatMap(f => f.pts), mid = p => p.reduce((s, q) => s.map((x, k) => x + q[k] / p.length), [0, 0, 0]);
  const c = mid(all);
  assert.equal(now.length, 6);
  for (const w of was) {
    const f = now.find(x => x.side === w.side), fc = mid(f.pts);
    assert.ok(f.n.reduce((s, x, k) => s + x * (fc[k] - c[k]), 0) > 0, 'normal points outward');
    // Each original vertex texel still exists on the rotated face.
    for (const t of w.uv) assert.ok(f.pts.some(p => Math.hypot(...texel(f.side, p).map((x, k) => x - t[k])) < 1e-3), 'texture stays attached');
  }
});

test('rotate without texture lock leaves uaxis/vaxis as written', () => {
  const b = block(), axes = () => V.kids(b, 'side').map(s => [V.get(s, 'uaxis'), V.get(s, 'vaxis')]), was = axes();
  V.rotate(b, [5, 7, 3], 2, 90, false);
  assert.deepEqual(axes(), was);
});

test('rotate 45 keeps the brush valid; snapVertices puts it back on the grid', () => {
  const b = block([0, 0, 0], [64, 64, 64]);
  V.rotate(b, [32, 32, 32], 2, 45);
  assert.ok(V.valid(b));
  const [mn, mx] = box(b);
  close([mn, mx], [[32 - 32 * Math.SQRT2, 32 - 32 * Math.SQRT2, 0], [32 + 32 * Math.SQRT2, 32 + 32 * Math.SQRT2, 64]], 1e-5);
  assert.equal(V.snapVertices(b, 8), true);
  assert.ok(V.valid(b));
  for (const f of V.faces(b)) for (const p of f.pts) assert.ok(p.every(x => x % 8 === 0), `${p} on grid`);
});

test('snapVertices refuses to collapse a brush', () => {
  const b = block([0, 0, 0], [3, 3, 3]);
  V.rotate(b, [0, 0, 0], 2, 30);
  const before = V.serialize(b);
  assert.equal(V.snapVertices(b, 64), false);
  assert.equal(V.serialize(b), before);
});

test('rotate a point entity: origin and angles', () => {
  const e = V.entity('info_player_teamspawn', [64, 0, 0], next);
  e.kv.push(['angles', '-50 30 0']);
  V.rotate(e, [0, 0, 0], 2, 90);
  assert.equal(V.get(e, 'origin'), '0 64 0');
  assert.equal(V.get(e, 'angles'), '-50 120 0');
  for (let i = 0; i < 3; i++) V.rotate(e, [0, 0, 0], 2, 90);
  assert.equal(V.get(e, 'angles'), '-50 30 0');
  assert.equal(V.get(e, 'origin'), '64 0 0');
});

test('valid rejects an open brush', () => {
  const b = block();
  assert.ok(V.valid(b));
  b.children.splice(5, 1);
  assert.equal(V.valid(b), false);
});

test('uv of a 64x64 face at scale 0.25 spans 4 repeats of a 64 texture', () => {
  const f = V.faces(block([0, 0, 0], [64, 64, 64])).find(f => f.n[2] > 0.99);
  const uv = V.uv(f, 64, 64), span = k => Math.max(...uv.map(c => c[k])) - Math.min(...uv.map(c => c[k]));
  assert.equal(span(0), 4);
  assert.equal(span(1), 4);
});

test('transform scale keeps the texture attached', () => {
  const b = block();
  const was = V.faces(b).map(f => f.pts.map(p => texel(f.side, p)));
  V.transform(b, [2, 0.5, 3], [16, -8, 4]);
  V.faces(b).forEach((f, i) => close(f.pts.map(p => texel(f.side, p)), was[i], 1e-4));
  for (const s of V.kids(b, 'side')) assert.ok(Math.abs(Math.hypot(...V.nums(V.get(s, 'uaxis')).slice(0, 3)) - 1) < 1e-6, 'unit axis');
});

test('new walls read the right way round from outside: u points right (Hammer mirrors it on the -x and +y faces)', () => {
  const right = f => { const u = V.nums(V.get(f.side, 'uaxis')); return u[0] * -f.n[1] + u[1] * f.n[0]; };
  for (const s of [block([0, 0, 0], [64, 64, 32]), V.brush([[[0, 0, 0], [64, 64, 0], [64, 64, 128], [0, 0, 128]], [[0, 0, 0], [0, 0, 128], [-64, 64, 128], [-64, 64, 0]], [[-64, 64, 0], [-64, 64, 128], [0, 128, 128], [0, 128, 0]], [[0, 128, 0], [0, 128, 128], [64, 64, 128], [64, 64, 0]], [[0, 0, 0], [-64, 64, 0], [0, 128, 0], [64, 64, 0]], [[0, 0, 128], [64, 64, 128], [0, 128, 128], [-64, 64, 128]]], 'DEV/WALL', next)])
    for (const f of V.faces(s)) if (Math.abs(f.n[2]) < 0.7) {
      assert.ok(right(f) > 0.999, `${f.n} ${V.get(f.side, 'uaxis')}`); // flat on the face, pointing right: no stretch on diagonals
      const v = V.nums(V.get(f.side, 'vaxis'));
      assert.ok(Math.abs(v[0] * f.n[0] + v[1] * f.n[1] + v[2] * f.n[2]) < 1e-5 && v[2] < -0.999, `${f.n} ${V.get(f.side, 'vaxis')}`); // down the face
    }
});

test('clip through the middle gives two valid halves', () => {
  const b = block([0, 0, 0], [64, 64, 32]);
  V.set(V.kids(b, 'side')[0], 'material', 'DEV/WALL'); // x = 0, 64x32, crossed by the cut
  V.set(V.kids(b, 'side')[2], 'material', 'DEV/PARALLEL'); // y = 0, not crossed
  V.set(V.kids(b, 'side')[4], 'material', 'DEV/BIG'); // z = 0, 64x64, the largest crossed side
  const [front, back] = V.clip(b, [[1, 32, 0], [0, 32, 1], [0, 32, 0]], next);
  assert.ok(V.valid(front) && V.valid(back));
  assert.deepEqual(box(front), [[0, 32, 0], [64, 64, 32]], 'front is where the plane normal points (+y)');
  assert.deepEqual(box(back), [[0, 0, 0], [64, 32, 32]]);
  for (const s of [front, back]) {
    assert.equal(V.kids(s, 'side').length, 6);
    const cut = V.faces(s).find(f => Math.abs(f.n[1]) > 0.99 && f.pts.every(p => p[1] === 32));
    assert.equal(V.get(cut.side, 'material'), 'DEV/BIG');
    assert.equal(V.get(cut.side, 'uaxis'), cut.n[1] < 0 ? '[1 0 0 0] 0.25' : '[-1 0 0 0] 0.25'); // reads the right way round from outside
  }
  assert.notEqual(V.get(front, 'id'), V.get(b, 'id'));
  const [f2, b2] = V.clip(b, [[1, 100, 0], [0, 100, 1], [0, 100, 0]], next);
  assert.equal(f2, null);
  assert.deepEqual(box(b2), box(b));
});

test('hollow(block, 16) gives 6 walls that fill the shell', () => {
  const b = block([0, 0, 0], [128, 128, 128]);
  V.set(V.kids(b, 'side')[5], 'material', 'DEV/TOP');
  const walls = V.hollow(b, 16, next);
  assert.equal(walls.length, 6);
  assert.ok(walls.every(V.valid));
  const vol = s => { const [mn, mx] = box(s); return (mx[0] - mn[0]) * (mx[1] - mn[1]) * (mx[2] - mn[2]); };
  assert.equal(walls.reduce((a, w) => a + vol(w), 0), 128 ** 3 - 96 ** 3);
  const top = walls.find(w => box(w)[0][2] === 112 && box(w)[1][2] === 128);
  assert.ok(V.faces(top).some(f => f.n[2] < -0.99 && V.get(f.side, 'material') === 'DEV/TOP'), 'inner face copies the outer texture');
  assert.deepEqual(V.hollow(b, 64, next), [], 'too thick');
  assert.equal(V.hollow(b, -16, next).length, 6, 'outward walls');
});

test('tie and untie round trip', () => {
  const root = V.parse('versioninfo\n{\n}\nworld\n{\n\t"id" "1"\n}\n');
  const world = V.kids(root, 'world')[0], a = block(), c = block();
  world.children.push(a, c);
  const point = V.entity('info_target', [0, 0, 0], next);
  root.children.push(point, V.parse('cameras\n{\n}\n').children[0]);
  const before = V.serialize(root), ids = [a, c].map(s => V.get(s, 'id'));

  const e = V.tie(root, world, [c], 'func_detail', next);
  assert.deepEqual(root.children.map(n => n.name), ['versioninfo', 'world', 'entity', 'entity', 'cameras']);
  assert.equal(root.children[3], e);
  assert.deepEqual(e.children.map(n => n.name), ['solid', 'editor']);
  assert.deepEqual(V.kids(world, 'solid'), [a]);

  const e2 = V.tie(root, world, [c], 'func_brush', next);
  assert.ok(!root.children.includes(e), 'emptied entity removed');
  assert.ok(root.children.includes(point), 'point entity kept');

  assert.deepEqual(V.untie(root, world, e2), [c]);
  assert.deepEqual([a, c].map(s => V.get(s, 'id')), ids);
  assert.equal(V.serialize(root), before);
});

test('transform without texture lock leaves the texture axes as written', () => {
  const b = block(), axes = () => V.kids(b, 'side').map(s => [V.get(s, 'uaxis'), V.get(s, 'vaxis')]), before = axes();
  V.transform(b, [2, 1, 1], [16, 0, 0], false);
  assert.deepEqual(axes(), before);
  assert.deepEqual(box(b), [[16, 0, 0], [144, 32, 16]]);
});

test('rotate gives a point entity without angles a facing; brush entity angles stay', () => {
  const e = V.entity('info_player_teamspawn', [64, 0, 0], next);
  V.rotate(e, [0, 0, 0], 2, 90);
  assert.equal(V.get(e, 'angles'), '0 90 0');
  const d = V.entity('func_door_rotating', [0, 0, 0], next);
  d.kv.push(['angles', '0 0 0']);
  d.children.push(block());
  V.rotate(d, [0, 0, 0], 2, 90);
  assert.equal(V.get(d, 'angles'), '0 0 0', 'the game turns the compiled brushes by these angles');
});

test('snapVertices refuses a brush it cannot put fully on the grid', () => {
  const b = block([0, 0, 0], [128, 64, 32]);
  V.rotate(b, [0, 0, 0], [1, 2, 3], 10);
  const before = V.serialize(b);
  assert.equal(V.snapVertices(b, 1), false, 'snapped face vertices are not coplanar');
  assert.equal(V.serialize(b), before);
});

test('serialize drops double quotes, which VMF cannot escape', () => {
  const r = V.parse('entity\n{\n\t"id" "1"\n}\n');
  V.set(r.children[0], 'targetname', 'door_12"');
  const t = V.serialize(r), back = V.parse(t);
  assert.equal(back.children.length, 1);
  assert.equal(V.get(back.children[0], 'targetname'), 'door_12');
  assert.equal(V.serialize(back), t);
});

test('Hammer++ vertices_plus between plane and material round-trips and goes when the plane changes', () => {
  const side = ['side', '{', '\t"id" "1"', '\t"plane" "(0 0 0) (0 1 0) (1 1 0)"', '\tvertices_plus', '\t{', '\t\t"v" "0 0 0"', '\t}',
    '\t"material" "DEV/X"', '\t"smoothing_groups" "0"', '\tdispinfo', '\t{', '\t\t"power" "2"', '\t}', '}', ''].join('\r\n');
  const r = V.parse(side);
  assert.equal(V.serialize(r), side);
  const s = r.children[0];
  V.set(s, 'plane', V.get(s, 'plane'));
  assert.equal(V.serialize(r), side, 'the same plane keeps it');
  V.set(s, 'plane', '(0 0 1) (0 1 1) (1 1 1)');
  assert.deepEqual(s.children.map(c => c.name), ['dispinfo']);
  assert.match(V.serialize(r), /"smoothing_groups" "0"\r\n\tdispinfo/);
  const b = block([0, 0, 0], [128, 64, 32]);
  V.rotate(b, [0, 0, 0], [1, 2, 3], 10);
  V.kids(b, 'side').forEach(x => x.children.push({ name: 'vertices_plus', kv: [['v', '0 0 0']], children: [] }));
  const before = V.serialize(b);
  assert.equal(V.snapVertices(b, 1), false);
  assert.equal(V.serialize(b), before, 'a refused snap keeps them');
  V.rotate(b, [0, 0, 0], [1, 2, 3], -10);
  assert.ok(!V.serialize(b).includes('vertices_plus'), 'rotating changes every plane');
});

// ---------- displacements, hidden solids, overlays (Hammer parity fixes) ----------
const D = await import('../src/dispgeo.js');
const dispBlock = (mn, mx, power = 3) => {
  const b = block(mn, mx), f = V.faces(b).find(x => x.n[2] > 0.9), g = D.create(f.side, f.pts, power);
  D.paint(g, f.pts[0], 96, 24);
  D.write(f.side, g);
  return b;
};
const dispFaces = s => V.faces(s).filter(f => V.kids(f.side, 'dispinfo').length);
const corners = pts => pts.filter((p, i) => !pts.slice(0, i).some(q => Math.hypot(...p.map((x, k) => x - q[k])) < 0.01)).length;

test('clip and hollow never leave a displacement on a face the cut changed (vbsp: non-quad displacement)', () => {
  const b = dispBlock([0, 0, 0], [256, 256, 64]);
  const diag = V.clip(b, [[0, 0, 0], [256, 256, 0], [0, 0, 64]], next);
  assert.equal(diag.filter(Boolean).length, 2);
  assert.deepEqual(diag.flatMap(dispFaces), [], 'a diagonal cut leaves triangles: their displacement goes');
  const half = V.clip(b, [[128, 0, 0], [128, 256, 0], [128, 0, 64]], next);
  assert.deepEqual(half.flatMap(dispFaces), [], 'a straight cut changes the face too');
  const side = V.clip(b, [[0, 0, 32], [256, 0, 32], [0, 256, 32]], next).filter(Boolean);
  assert.deepEqual(side.flatMap(dispFaces).map(f => corners(f.pts)), [4], 'a cut below the displaced face keeps it on its piece');
  for (const p of [...diag, ...half, ...side].filter(Boolean)) for (const f of dispFaces(p)) assert.equal(corners(f.pts), 4);
  for (const w of V.hollow(b, 16, next)) for (const f of dispFaces(w)) assert.equal(corners(f.pts), 4, 'hollow walls: only whole quads keep one');
});

test('vertex edit: a displaced face that keeps 4 corners keeps its displacement, a merged one loses it', () => {
  const moved = (s, sel, d) => { const fs = V.faces(s); return V.kids(s, 'side').map(side => fs.find(f => f.side === side)?.pts.map(p => (sel(p) ? p.map((x, k) => x + d[k]) : p)) ?? null); };
  const a = dispBlock([0, 0, 0], [256, 256, 64]);
  assert.equal(V.fromPoints(a, moved(a, p => p[0] === 256, [64, 0, 0])), true, 'the +x edge slides out: still a quad');
  assert.equal(dispFaces(a).length, 1);
  assert.equal(D.parse(dispFaces(a)[0].side, dispFaces(a)[0].pts).corners.some(c => c[0] === 320), true, 'the grid spans the new corners');
  const b = dispBlock([0, 0, 0], [256, 256, 64]);
  assert.equal(V.fromPoints(b, moved(b, p => p[0] === 256 && p[1] === 256, [-256, 0, 0])), true, 'two corners merge');
  assert.deepEqual(dispFaces(b), [], 'the top is a triangle now');
  // the start corner follows its vertex
  const c = dispBlock([0, 0, 0], [256, 256, 64]), start = () => V.nums(V.get(V.kids(dispFaces(c)[0].side, 'dispinfo')[0], 'startposition'));
  assert.deepEqual(start(), [0, 0, 64]);
  assert.equal(V.fromPoints(c, moved(c, p => p[0] === 0, [-64, 0, 0])), true);
  assert.deepEqual(start(), [-64, 0, 64]);
});

test('fromPoints refuses a face that would bend, however little (no vertex off its requested spot)', () => {
  const moved = (s, sel, d) => { const fs = V.faces(s); return V.kids(s, 'side').map(side => fs.find(f => f.side === side)?.pts.map(p => (sel(p) ? p.map((x, k) => x + d[k]) : p)) ?? null); };
  const b = block([0, 0, 0], [256, 128, 128]);
  assert.equal(V.fromPoints(b, moved(b, p => p[1] === 0 && p[2] === 0, [0, -64, 0])), true);
  assert.equal(V.fromPoints(b, moved(b, p => p[0] === 0 && p[2] === 0, [0, 0, -1])), false, 'the bottom would bend by 0.5');
});

test('a mirror re-indexes the displacement grid: the surface is the mirror image', () => {
  const b = dispBlock([0, 0, 0], [256, 256, 64]), pos = s => { const f = dispFaces(s)[0]; return D.positions(D.parse(f.side, f.pts)); };
  const before = pos(b).map(p => [512 - p[0], p[1], p[2]]);
  V.transform(b, [-1, 1, 1], [512, 0, 0]);
  const after = pos(b);
  for (const p of before) assert.ok(after.some(q => Math.hypot(...p.map((x, k) => x - q[k])) < 1e-3), `${p} on the mirrored surface`);
  V.transform(b, [1, 1, -1], [0, 0, 64]);
  assert.ok(pos(b).every(p => p[2] <= 1e-6), 'a mirror in z turns the bumps down with the face');
});

test('tie and untie keep the hidden solids of a brush entity', () => {
  const root = V.parse('world\n{\n"id" "1"\n}\n'), world = V.kids(root, 'world')[0];
  const a = block(), h = block([0, 0, 32], [64, 32, 48]);
  const e = { name: 'entity', kv: [['id', next()], ['classname', 'func_detail']], children: [a, { name: 'hidden', kv: [], children: [h] }] };
  root.children.push(e);
  V.tie(root, world, [a], 'func_brush', next);
  assert.ok(root.children.includes(e), 'the entity still holds its hidden solid');
  const e2 = { name: 'entity', kv: [['id', next()], ['classname', 'func_detail']], children: [block(), { name: 'hidden', kv: [], children: [block([0, 0, 64], [8, 8, 72])] }] };
  root.children.push(e2);
  V.untie(root, world, e2);
  assert.equal(V.kids(world, 'hidden').length, 1, 'the hidden solid moves to the world, still wrapped');
});

test('clone records side ids; remapSides points overlays at the copies and keeps faces outside the batch', () => {
  const b = block(), ids = new Map(), c = V.clone(b, next, ids), [s0, s1] = V.kids(b, 'side').map(s => V.get(s, 'id'));
  const ov = { name: 'entity', kv: [['classname', 'info_overlay'], ['sides', `${s0} ${s1} 99999`]], children: [] };
  assert.equal(V.remapSides(ov, ids), true);
  assert.equal(V.get(ov, 'sides'), `${V.get(V.kids(c, 'side')[0], 'id')} ${V.get(V.kids(c, 'side')[1], 'id')} 99999`);
  const ids2 = new Map(), pieces = V.clip(block([0, 0, 0], [64, 64, 64]), [[32, 0, 0], [32, 64, 0], [32, 0, 64]], next, ids2);
  assert.ok([...ids2.values()].every(v => v.length >= 1) && pieces.every(Boolean));
});

test('moving, mirroring and turning an info_overlay carries its basis', () => {
  const ov = () => ({ name: 'entity', kv: [['classname', 'info_overlay'], ['BasisNormal', '0 0 1'], ['BasisOrigin', '128 128 64'], ['BasisU', '1 0 0'], ['BasisV', '0 1 0'], ['origin', '128 128 64'], ['uv0', '-32 -16 0'], ['uv1', '-32 16 0'], ['uv2', '32 16 0'], ['uv3', '32 -16 0']], children: [] });
  const corners = o => [0, 1, 2, 3].map(i => { const [u, v] = V.nums(V.get(o, 'uv' + i)), [O, U, W] = ['BasisOrigin', 'BasisU', 'BasisV'].map(k => V.nums(V.get(o, k))); return O.map((x, k) => x + u * U[k] + v * W[k]); });
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const a = ov(), before = corners(a);
  V.transform(a, [1, 1, 1], [64, 0, 0]);
  assert.equal(V.get(a, 'BasisOrigin'), '192 128 64');
  assert.equal(V.get(a, 'BasisU'), '1 0 0', 'a move keeps the axes as written');
  const m = ov();
  V.transform(m, [-1, 1, 1], [0, 0, 0]);
  close(corners(m), before.map(p => [-p[0], p[1], p[2]]));
  close([cross(V.nums(V.get(m, 'BasisU')), V.nums(V.get(m, 'BasisV')))], [V.nums(V.get(m, 'BasisNormal'))]); // still right-handed
  const r = ov();
  V.rotate(r, [0, 0, 0], 2, 90);
  close(corners(r), before.map(p => [-p[1], p[0], p[2]]));
});
