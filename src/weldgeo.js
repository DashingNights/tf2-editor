// Brush sides on almost, but not exactly, the same plane. Figma imports leave many: corners written with decimals a few
// hundredths apart. vbsp merges planes that close and can give a face the plane that faces into its own brush; VRAD then
// lights it from behind and it comes out black in game. weld() puts each group on one exact plane.
import * as V from '../vmf.js';

// Degrees and units. One imported map's worst case was a wall kink of 0.116 degrees, its faces 0.705 units apart.
export const ANGLE = 0.15, DIST = 0.75;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const area = pts => {
  const s = [0, 0, 0];
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = pts[0], u = pts[i].map((x, k) => x - a[k]), v = pts[i + 1].map((x, k) => x - a[k]);
    s[0] += u[1] * v[2] - u[2] * v[1]; s[1] += u[2] * v[0] - u[0] * v[2]; s[2] += u[0] * v[1] - u[1] * v[0];
  }
  return Math.hypot(...s) / 2;
};
// The same plane, either way round.
const same = (a, b) => { const c = dot(a.n, b.n); return Math.abs(Math.abs(c) - 1) < 1e-12 && Math.abs(a.d - Math.sign(c) * b.d) < 1e-6; };

// { solid, side, n, d, pts, area } for every side with a face; displacement sides are left as they are.
function sidesOf(solids) {
  const out = [];
  for (const solid of solids) {
    const fs = V.faces(solid);
    for (const side of V.kids(solid, 'side')) {
      const f = fs.find(f => f.side === side), p = V.plane(side);
      if (f && p.ok && !V.kids(side, 'dispinfo').length) out.push({ solid, side, n: p.n, d: p.d, pts: f.pts, area: area(f.pts) });
    }
  }
  return out;
}

// Groups of sides within angle and dist of each other (either way round), not already on one exact plane. Two sides are
// close when their normals are within angle and each face lies within dist of the other's plane.
// ponytail: all pairs, about a second for 9,500 sides; bucket by normal if maps get much bigger.
function groupsOf(sides, { angle = ANGLE, dist = DIST } = {}) {
  const cos = Math.cos((angle * Math.PI) / 180);
  const close = (a, b) => Math.abs(dot(a.n, b.n)) >= cos && b.pts.every(v => Math.abs(dot(a.n, v) - a.d) < dist) && a.pts.every(v => Math.abs(dot(b.n, v) - b.d) < dist);
  const up = sides.map((_, i) => i), find = i => (up[i] === i ? i : (up[i] = find(up[i])));
  for (let i = 0; i < sides.length; i++) for (let j = i + 1; j < sides.length; j++) if (close(sides[i], sides[j])) up[find(i)] = find(j);
  const g = new Map();
  sides.forEach((s, i) => { const r = find(i); if (!g.has(r)) g.set(r, []); g.get(r).push(s); });
  return { close, groups: [...g.values()].filter(m => m.length > 1 && !m.every(s => same(s, m[0]))) };
}

// For Check for problems: the near-coplanar groups ({ sides: [{ solid, side }] }) and the sides that repeat another
// side's plane in the same brush (vbsp: "duplicate plane").
export function check(solids, opt) {
  return { groups: groupsOf(sidesOf(solids), opt).groups.map(m => ({ sides: m.map(({ solid, side }) => ({ solid, side })) })), duplicates: duplicates(solids) };
}

// Per brush, sides on the same plane as an earlier, larger side: [{ solid, side }].
function duplicates(solids) {
  const out = [];
  for (const solid of solids) {
    const fs = V.faces(solid), size = side => { const f = fs.find(f => f.side === side); return f ? area(f.pts) : 0; };
    const ss = V.kids(solid, 'side').map(side => ({ side, ...V.plane(side), a: size(side) })).filter(s => s.ok);
    const gone = new Set();
    for (let i = 0; i < ss.length; i++) for (let j = i + 1; j < ss.length; j++) {
      const p = ss[i], q = ss[j];
      if (gone.has(p) || gone.has(q) || dot(p.n, q.n) < 1 - 1e-12 || Math.abs(p.d - q.d) > 1e-6) continue;
      const drop = p.a >= q.a ? q : p;
      gone.add(drop);
      out.push({ solid, side: drop.side });
    }
  }
  return out;
}

const reversed = t => t.match(/\([^)]*\)/g).reverse().join(' ');

// Puts each group on its plane with the most face area: every side takes that plane's text, its 3 points reversed for a
// side facing the other way, so vbsp sees exactly one plane pair. A brush that would lose a face, flatten one, or move
// more than a unit keeps its planes. Then drops the sides that now repeat a plane in their brush. take(solid) runs before a brush first
// changes (undo snapshots). Returns { groups, moved, maxMove, kept, dropped }.
export function weld(solids, take = () => {}, opt) {
  const taken = new Set(), touch = s => { if (!taken.has(s)) { taken.add(s); take(s); } };
  const r = { groups: 0, moved: 0, maxMove: 0, kept: 0, dropped: 0 }, kept = new Set();
  for (let pass = 0; pass < 4; pass++) { // a moved side can bring the next group within reach
    const sides = sidesOf(solids), { close, groups } = groupsOf(sides, opt), old = new Map();
    for (const g of groups) {
      const planes = [];
      for (const s of g) { const p = planes.find(p => same(p.s, s)); if (p) p.area += s.area; else planes.push({ s, area: s.area }); }
      const c = planes.sort((a, b) => b.area - a.area)[0].s, text = V.get(c.side, 'plane');
      let any = false;
      for (const s of g) {
        if (same(s, c) || !close(c, s)) continue;
        touch(s.solid);
        old.set(s.side, { plane: V.get(s.side, 'plane'), children: s.side.children, move: Math.max(...s.pts.map(v => Math.abs(dot(c.n, v) - c.d))) });
        V.set(s.side, 'plane', dot(s.n, c.n) > 0 ? text : reversed(text)); // drops vertices_plus, now stale
        any = true;
      }
      if (any) r.groups++;
    }
    for (const solid of new Set(sides.filter(s => old.has(s.side)).map(s => s.solid))) {
      const was = V.bounds(sides.filter(s => s.solid === solid)), f = V.faces(solid), now = V.bounds(f);
      const bad = f.length !== V.kids(solid, 'side').length || f.some(x => area(x.pts) < 0.01) || now.some((m, i) => m.some((x, k) => Math.abs(x - was[i][k]) > 1));
      for (const side of V.kids(solid, 'side')) {
        const o = old.get(side);
        if (!o) continue;
        if (bad) { V.set(side, 'plane', o.plane); side.children = o.children; old.delete(side); } else r.maxMove = Math.max(r.maxMove, o.move);
      }
      if (bad) kept.add(solid);
    }
    r.moved += old.size;
    if (!old.size) break;
  }
  for (const { solid, side } of duplicates(solids)) { touch(solid); solid.children = solid.children.filter(c => c !== side); r.dropped++; }
  r.kept = kept.size;
  return r;
}
