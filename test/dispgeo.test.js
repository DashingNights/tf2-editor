import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../vmf.js';
import * as D from '../src/dispgeo.js';

let id = 0;
const next = () => String(++id);
const top = solid => V.faces(solid).find(f => f.n[2] > 0.99);
const ser = n => V.serialize({ name: '', kv: [], children: [n], eol: '\n' });
const near = (a, b, msg, eps = 1e-6) => a.forEach((x, k) => assert.ok(Math.abs(x - b[k]) < eps, `${msg}: ${a} vs ${b}`));

test('fmt writes numbers like printf %g', () => {
  const cases = [[0, '0'], [1, '1'], [255, '255'], [0.5, '0.5'], [87.9185, '87.9185'], [-0.0266039, '-0.0266039'],
    [6.20149e-05, '6.20149e-05'], [1 / 3, '0.333333'], [123456789, '1.23457e+08'], [1e6, '1e+06'], [999999.5, '1e+06'], [100000, '100000']];
  for (const [x, s] of cases) assert.equal(D.fmt(x), s);
});

test('power 2 on a unit square: Hammer vertex layout and a flat block', () => {
  const b = V.block([0, 0, -1], [1, 1, 0], 'DEV/X', next), f = top(b);
  const g = D.create(f.side, f.pts, 2);
  const di = V.kids(f.side, 'dispinfo')[0];
  assert.equal(V.get(di, 'startposition'), '[0 0 0]'); // the corner nearest the face's minimum
  assert.deepEqual(di.kv.map(p => p[0]), ['power', 'startposition', 'flags', 'elevation', 'subdiv']);
  assert.deepEqual(di.children.map(c => c.name), ['normals', 'distances', 'offsets', 'offset_normals', 'alphas', 'triangle_tags', 'allowed_verts']);
  assert.equal(V.get(V.kids(di, 'offset_normals')[0], 'row0'), '0 0 1 0 0 1 0 0 1 0 0 1 0 0 1');
  assert.equal(V.get(V.kids(di, 'triangle_tags')[0], 'row3'), '9 9 9 9 9 9 9 9'); // flat floor: walkable + buildable
  // Row i runs from p0 along p0 -> p3 at p0 + (p1 - p0) i / 4; p1 follows p0 clockwise seen from above (+y here).
  const r = D.build(f.side, f.pts);
  assert.equal(r.rows, 5);
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) near(r.positions.slice((i * 5 + j) * 3, (i * 5 + j) * 3 + 3), [j / 4, i / 4, 0], `vertex ${i},${j}`);
  // Counter-clockwise seen from the front, as three.js wants.
  for (let t = 0; t < r.indices.length; t += 3) {
    const [a, b2, c] = [0, 1, 2].map(k => r.positions.slice(r.indices[t + k] * 3, r.indices[t + k] * 3 + 3));
    assert.ok((b2[0] - a[0]) * (c[1] - a[1]) - (b2[1] - a[1]) * (c[0] - a[0]) > 0);
  }
  assert.equal(r.indices.length, 32 * 3);
  assert.ok(g && D.destroy(f.side) && !V.kids(f.side, 'dispinfo').length);
});

// A Hammer-written block on the top of a 0..256 box: vertex row 1, column 2 raised 16, one exponent value, alphas.
const SAMPLE = `side
{
	"id" "1"
	"plane" "(0 256 0) (256 256 0) (256 0 0)"
	"material" "NATURE/BLENDGRASSGRAVEL001A"
	"uaxis" "[1 0 0 0] 0.25"
	"vaxis" "[0 -1 0 0] 0.25"
	"rotation" "0"
	"lightmapscale" "16"
	"smoothing_groups" "0"
	dispinfo
	{
		"power" "2"
		"startposition" "[0 0 0]"
		"flags" "0"
		"elevation" "0"
		"subdiv" "0"
		normals
		{
			"row0" "0 0 0 0 0 0 0 0 0 0 0 0 0 0 0"
			"row1" "0 0 0 0 0 0 0 0 1 0 0 0 0 0 0"
			"row2" "0 0 0 0 0 0 6.20149e-05 -0.0303731 0.999539 0 0 0 0 0 0"
			"row3" "0 0 0 0 0 0 0 0 0 0 0 0 0 0 0"
			"row4" "0 0 0 0 0 0 0 0 0 0 0 0 0 0 0"
		}
		distances
		{
			"row0" "0 0 0 0 0"
			"row1" "0 0 16 0 0"
			"row2" "0 0 2.41596 0 0"
			"row3" "0 0 0 0 0"
			"row4" "0 0 0 0 0"
		}
		offsets
		{
			"row0" "0 0 0 0 0 0 0 0 0 0 0 0 0 0 0"
			"row1" "0 0 0 0 0 0 0 0 0 0 0 0 0 0 0"
			"row2" "0 0 0 0 0 0 0 0 0 0 0 0 0 0 0"
			"row3" "0 0 0 0 0 0 0 0 0 0 0 0 0 0 0"
			"row4" "0 0 0 0 0 0 0 0 0 0 0 0 0 0 0"
		}
		offset_normals
		{
			"row0" "0 0 1 0 0 1 0 0 1 0 0 1 0 0 1"
			"row1" "0 0 1 0 0 1 0 0 1 0 0 1 0 0 1"
			"row2" "0 0 1 0 0 1 0 0 1 0 0 1 0 0 1"
			"row3" "0 0 1 0 0 1 0 0 1 0 0 1 0 0 1"
			"row4" "0 0 1 0 0 1 0 0 1 0 0 1 0 0 1"
		}
		alphas
		{
			"row0" "0 0 0 0 0"
			"row1" "0 233.938 255 0 0"
			"row2" "0 0 0 0 0"
			"row3" "0 0 0 0 0"
			"row4" "0 0 0 0 0"
		}
		triangle_tags
		{
			"row0" "9 9 9 1 9 9 9 9"
			"row1" "9 9 9 9 9 9 9 9"
			"row2" "9 9 9 9 9 9 9 9"
			"row3" "9 9 9 9 9 9 9 9"
		}
		allowed_verts
		{
			"10" "-1 -1 -1 -1 -1 -1 -1 -1 -1 -1"
		}
	}
}
`;

const sample = () => {
  const s = V.parse(SAMPLE).children[0], b = V.block([0, 0, -64], [256, 256, 0], 'DEV/X', next);
  b.children.splice(V.kids(b, 'side').indexOf(top(b).side), 1, s);
  return [s, top(b).pts];
};

test('write(parse(x)) gives back a Hammer block byte for byte', () => {
  const [s, pts] = sample(), text = ser(s), g = D.parse(s, pts);
  assert.equal(g.n, 5);
  const P = D.positions(g);
  near(P[1 * 5 + 2], [128, 64, 16], 'raised vertex');
  D.write(s, g);
  assert.equal(ser(s), text);
});

test('paint raises inside the radius only and retags, paintAlpha clamps', () => {
  const [s, pts] = sample(), g = D.parse(s, pts), c = D.positions(g)[2 * 5 + 2];
  assert.ok(D.paint(g, c, 70, 64, 'raise', 'z'));
  const P = D.positions(g);
  near(P[2 * 5 + 2], [c[0], c[1], c[2] + 64], 'centre');
  near(P[0], [0, 0, 0], 'corner untouched');
  assert.ok(g.tags.some(t => t === 1), 'steep triangles: walkable, not buildable');
  D.paint(g, P[2 * 5 + 2], 70, 5, 'raiseTo', 'z');
  assert.ok(Math.abs(D.positions(g)[2 * 5 + 2][2] - 5) < 1e-6, 'raise to 5 at the centre');
  D.paintAlpha(g, [64, 64, 0], 10, 100, 'raise');
  assert.equal(g.alpha[1 * 5 + 1], 255);
  D.paintAlpha(g, [64, 64, 0], 10, 500, 'lower');
  assert.equal(g.alpha[1 * 5 + 1], 0);
});

test('sew makes shared edges equal', () => {
  const a = V.block([0, 0, -16], [64, 64, 0], 'DEV/X', next), b = V.block([64, 0, -16], [128, 64, 0], 'DEV/X', next);
  const fa = top(a), fb = top(b), ga = D.create(fa.side, fa.pts, 2), gb = D.create(fb.side, fb.pts, 3);
  D.paint(ga, [64, 32, 0], 40, 20, 'raise', 'z');
  // The 5 vertices of a's x = 64 edge meet 5 of b's 9 (both move); b's 4 in between go onto a's edge, as vbsp puts them.
  assert.equal(D.sew(ga, gb), 14);
  const PA = D.positions(ga), PB = D.positions(gb), edge = ga.flat.map((f, i) => [f, PA[i]]).filter(([f]) => f[0] === 64);
  let shared = 0;
  gb.flat.forEach((h, j) => {
    if (h[0] !== 64) return;
    const lo = edge.findLast(([f]) => f[1] <= h[1]), hi = edge.find(([f]) => f[1] >= h[1]), t = hi === lo ? 0 : (h[1] - lo[0][1]) / (hi[0][1] - lo[0][1]);
    near(PB[j], lo[1].map((x, k) => x + (hi[1][k] - x) * t), 'seam');
    shared += hi === lo;
  });
  assert.equal(shared, 5);
  assert.ok(PA.some(p => p[2] > 1), 'the seam keeps half the height');
  D.write(fa.side, ga);
  const back = D.parse(fa.side, fa.pts);
  D.positions(back).forEach((p, i) => near(p, PA[i], 'written', 1e-3));
});
