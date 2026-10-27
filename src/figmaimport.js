// Builds a blockout from a Figma layout exported as SVG ("Include id attribute"; shapes from svgread.js). Pure.
// Layer names carry the plan. Case does not matter; spaces or underscores separate words:
//   z<n>       on a group: an area whose floor is n units up (z-86, z0, z192); nested layers inherit it
//   h<n>       wall height above the area's floor (default wallHeight)
//   block      a solid mass up to its walls' top; floors and stairs under it are cut through, clearance high
//   roofed     the area gets a ceiling at its walls' top
//   mirror-left|right|top|bottom   the group is one half of the map; a mirrored copy is added across its right
//              (left, bottom, top) edge
//   ignore     skipped
//   spawn      a spawn room (spawn points, respawn room, resupply, no-entry walls at its stairs): the half as drawn is
//              BLU and its mirror RED, unless a layer says red or blu
//   control    (or capture, cp) the control point: the capture zone over its floors, the point and the KOTH logic
// In a spawn's group, markers place its parts (else they are placed for it): "door" lines (a door that slides up for
// the team, with a no-entry wall), "locker" shapes (a resupply locker facing away from the nearest wall) and
// "spawnpoint" shapes (a spawn point each, facing the doors). Anywhere: a "controlpoint" shape (the point stands at its
// middle) and "capturezone" shapes (the capture zone).
// Inside an area: "floor" fills are floors; "walls" strokes are walls, built along the line (one brush per straight
// piece, mitred at the corners; the stroke width is ignored); "stairs" (or "ramp") lines mark the two ends of each
// flight, built by the Stairs tool; "landing" lines or shapes are landings, at their own z or the area's. Unnamed
// shapes in an area go by paint: fills are floors, strokes 6 wide or more walls, thinner ones stair ends. A floor
// without a z takes it from its fill: grey lightness L% = 50 + z / 8.
import * as V from '../vmf.js';
import { build as buildStairs, DEFAULTS as STAIRS } from './stairgeo.js';
import { lightness } from './svgread.js';
import { sub, cross, dot, area, hull, convexParts, clipConvex, clipHalf, subtractConvex, inside, segCross, segDist, isConvex, ccw, simplify, rayHits, partition, narrowest, boxes } from './poly2d.js';

// thickness: how thick floors, landings and roofs are (walls and blocks reach the floors beside them, thickness under);
// skyHeight: the sky's ceiling over the highest brush; slab: the layout's own spacing (headroom, bridges, stair pairing)
export const DEFAULTS = {
  wallHeight: 192, wallThickness: 16, clearance: 160, slab: 16, thickness: 16, grid: 64, skyHeight: 512,
  // floors, landings and stairs white, walls grey, roofs orange (a block: its top and bottom roof, its sides wall)
  materials: { floor: 'DEV/REFLECTIVITY_90', wall: 'DEV/DEV_MEASUREWALL01D', roof: 'DEV/DEV_MEASUREGENERIC01' },
  // gameplay: spawn rooms, the control point, a sky box around the map, the sun and lights under roofs
  gameplay: true,
};
const len = a => Math.hypot(a[0], a[1]);
const unit = a => { const l = len(a); return l > 1e-12 ? [a[0] / l, a[1] / l] : [0, 0]; };
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const lerp2 = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
const tidy = x => (Math.abs(x - Math.round(x)) < 0.01 ? Math.round(x) : Math.round(x * 1000) / 1000);
const fmt = x => String(tidy(x));

// ---------- names ----------
const MARKERS = new Set(['controlpoint', 'capturezone', 'door', 'locker', 'spawnpoint', 'pickup']);
const ROLES = [['ignore', /^ignore$/], ['controlpoint', /^(controlpoint|cappoint)$/], ['capturezone', /^(capturezone|capzone)$/], ['door', /^doors?$/], ['locker', /^(lockers?|resupply)$/], ['spawnpoint', /^(spawnpoints?|teamspawn)$/], ['landing', /^(landings?|platforms?)$/], ['floor', /^(floors?|elevation)$/], ['walls', /^walls?$/], ['ramp', /^ramps?$/], ['stairs', /^(stairs?|steps?)$/], ['pickup', /^(health|healthkit|hp|ammo|ammopack)$/]];
// What a layer name says: { z, h, block, roofed, mirror, spawn, team, capture, role }.
export function readName(name) {
  const o = {}, found = new Set();
  for (const w of String(name).toLowerCase().split(/[\s_]+/).filter(Boolean)) {
    let m;
    if ((m = /^z(-?\d+(?:\.\d+)?)$/.exec(w))) o.z = +m[1];
    else if ((m = /^h(\d+(?:\.\d+)?)$/.exec(w))) o.h = +m[1];
    else if ((m = /^mirror-(left|right|top|bottom)$/.exec(w))) o.mirror = m[1];
    else if (w === 'block') o.block = true;
    else if (w === 'roofed') o.roofed = true;
    else if (w === 'spawn') o.spawn = true;
    else if (w === 'red' || w === 'blu' || w === 'blue') o.team = w === 'red' ? 'red' : 'blu';
    else if (w === 'capture' || w === 'control' || w === 'cp') o.capture = true;
    else if ((m = /^(small|medium|large|full)$/.exec(w))) o.size = m[1] === 'large' ? 'full' : m[1];
    else for (const [role, re] of ROLES) if (re.test(w)) { found.add(role); if (role === 'pickup') o.pickup = /^ammo/.test(w) ? 'ammo' : 'health'; }
  }
  o.role = ROLES.map(r => r[0]).find(r => found.has(r)); // the first in ROLES wins: "Stair ... platform" is a landing
  return o;
}
// A layer name as keys use it (figmadiff.js): without Figma's _2 suffix and the settings an edit changes (z, h, roofed,
// size), so "walls h32" and "walls h48" are one layer and a new height shows as a change, not a removal and an addition.
const keyName = n => n.replace(/_\d+$/, '').split(/\s+/).filter(w => w && !['z', 'h', 'roofed', 'size'].some(k => readName(w)[k] !== undefined)).join(' ');

// ---------- walls ----------
// Convex pieces of a wall t thick along a polyline: one per straight piece, its ends mitred so neighbours meet
// face to face; corners sharper than about 30 degrees (or too tight for a short piece) get square ends plus a convex
// corner piece. Open ends are square at the end points. Returned as runs of { poly, dir (along the line) }, one run per
// wall as drawn: the line splits where it turns by more than `corner` degrees, so a curve (short chords) stays one wall.
export function wallRuns(points, closed, t, corner = 35) {
  let pts = points.filter((p, i) => !i || len(sub(p, points[i - 1])) > 0.01);
  if (closed && pts.length > 2 && len(sub(pts[0], pts.at(-1))) <= 0.01) pts.pop();
  // drop points on a straight line between their neighbours
  for (let changed = true; changed && pts.length > 2;) {
    changed = false;
    for (let i = closed ? 0 : 1; i < (closed ? pts.length : pts.length - 1); i++) {
      const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length], l = len(sub(c, a));
      if (l > 1e-9 && Math.abs(cross(sub(b, a), sub(c, a))) / l < 0.01 && dot(sub(b, a), sub(c, b)) > 0) { pts.splice(i, 1); changed = true; break; }
    }
  }
  const n = pts.length, h = t / 2, segs = closed && n > 2 ? n : n - 1;
  if (segs < 1) return [];
  const d = i => unit(sub(pts[(i + 1) % n], pts[i])), left = v => [-v[1], v[0]];
  const add = (p, v, s) => [p[0] + v[0] * s, p[1] + v[1] * s];
  // mitre offset at vertex i (unit direction scaled to the mitre length), or null where it needs a square end
  const mitre = i => {
    if (!closed && (i === 0 || i === n - 1)) return null;
    const n0 = left(d((i - 1 + n) % n)), n1 = left(d(i)), m = unit([n0[0] + n1[0], n0[1] + n1[1]]), c = dot(m, n1);
    return c > 0.26 ? [m[0] / c, m[1] / c] : null; // 0.26: about 30 degrees between the pieces
  };
  const turn = i => (Math.acos(Math.max(-1, Math.min(1, dot(d((i - 1 + n) % n), d(i))))) * 180) / Math.PI;
  const bend = i => (closed || (i > 0 && i < n - 1)) && turn(i) > corner;
  const runOf = [], start = closed ? Math.max(0, pts.findIndex((_, i) => bend(i))) : 0;
  for (let k = 0, r = 0; k < segs; k++) { const s = (start + k) % segs; if (k && bend(s)) r++; runOf[s] = r; }
  const mts = pts.map((_, i) => mitre(i)), out = [], corners = new Set();
  for (let s = 0; s < segs; s++) {
    const a = pts[s], b = pts[(s + 1) % n], nl = left(d(s)), dir = d(s);
    const ends = (p, m) => (m ? [add(p, m, h), add(p, m, -h)] : [add(p, nl, h), add(p, nl, -h)]);
    let [ls, rs] = ends(a, mts[s]), [le, re] = ends(b, mts[(s + 1) % n]);
    // a mitre longer than the piece folds it: square ends there, and a corner piece
    if (dot(sub(le, ls), dir) <= 0.01 || dot(sub(re, rs), dir) <= 0.01) {
      [ls, rs] = ends(a, null); [le, re] = ends(b, null);
      corners.add(s); corners.add((s + 1) % n);
    }
    if (!mts[s] && (closed || s > 0)) corners.add(s);
    if (!mts[(s + 1) % n] && (closed || s + 1 < n - 1)) corners.add((s + 1) % n);
    out.push([[ls, le, re, rs], runOf[s], dir]);
  }
  // corner pieces fill the wedge between two square ends
  for (const i of corners) {
    if (!closed && (i === 0 || i === n - 1)) continue;
    const p = pts[i], a = left(d((i - 1 + n) % n)), b = left(d(i)), poly = hull([p, add(p, a, h), add(p, a, -h), add(p, b, h), add(p, b, -h)]);
    if (poly.length >= 3 && Math.abs(area(poly)) > 0.5) out.push([poly, runOf[(i - 1 + segs) % segs], d((i - 1 + n) % n)]);
  }
  const runs = [];
  for (const [q, r, dir] of out.map(([q, r, dir]) => [ccw(q), r, dir])) if (Math.abs(area(q)) > 0.5 && isConvex(q)) (runs[r] ??= []).push({ poly: q, dir });
  return runs.filter(Boolean);
}
export const wallPieces = (points, closed, t) => wallRuns(points, closed, t).flat().map(p => p.poly);

// The walking line between two flight ends (its ends left out) runs through convex poly.
const across = (poly, e, f) => {
  const a = lerp2(mid(e.a, e.b), mid(f.a, f.b), 0.1), b = lerp2(mid(e.a, e.b), mid(f.a, f.b), 0.9);
  return inside(a, poly) || inside(b, poly) || poly.some((p, i) => segCross(a, b, p, poly[(i + 1) % poly.length]));
};

// ---------- pieces: { poly (convex, ccw), bottom, top, rank, ... } ----------
const box2 = poly => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of poly) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); } return [x0, y0, x1, y1]; };
const boxesMeet = (a, b) => a[0] < b[2] - 0.01 && b[0] < a[2] - 0.01 && a[1] < b[3] - 0.01 && b[1] < a[3] - 0.01;
// Whether q is on piece x ({ poly, b: its box }) or within half a unit of it (a point on an outline counts either way
// in inside(), and not alike in the two halves of a mirrored map).
const onto = (q, x) => q[0] > x.b[0] - 0.5 && q[0] < x.b[2] + 0.5 && q[1] > x.b[1] - 0.5 && q[1] < x.b[3] + 0.5 && (inside(q, x.poly) || x.poly.some((a, i) => segDist(q, a, x.poly[(i + 1) % x.poly.length]) < 0.5));
// Points o past each side of convex ccw poly, at the middles of 16-unit stretches, and o out from each corner.
const past = (poly, o) => poly.flatMap((a, i) => {
  const n = poly.length, e = sub(poly[(i + 1) % n], a), l = len(e), d = unit(e), k = Math.ceil(l / 16), f = unit(sub(a, poly[(i + n - 1) % n])), m = unit([d[1] + f[1], -d[0] - f[0]]);
  return [[a[0] + m[0] * o, a[1] + m[1] * o], ...Array.from({ length: k }, (_, j) => { const t = (l * (j + 0.5)) / k; return [a[0] + d[0] * t + d[1] * o, a[1] + d[1] * t - d[0] * o]; })];
});
const overlap = (a, b) => boxesMeet(box2(a), box2(b)) && Math.abs(area(clipConvex(a, b))) > 0.5;

// Pieces of similar height (closer than gap) must not overlap: the higher-ranked keeps the footprint.
function paint(pieces, gap) {
  const placed = [];
  for (const p of [...pieces].sort((a, b) => b.rank - a.rank)) {
    let parts = [p.poly];
    for (const q of placed) {
      if (Math.abs(q.top - p.top) >= gap) continue;
      parts = parts.flatMap(r => (overlap(r, q.poly) ? subtractConvex(r, q.poly) : [r]));
      if (!parts.length) break;
    }
    placed.push(...parts.map(poly => ({ ...p, poly })));
  }
  return placed;
}

// Piece p split by convex polygon c: { over (the part over c), rest }, or null where they do not meet. A wall (p.dir) is
// split square across, between the points where c crosses its middle line: a slanted edge of c would leave a wedge.
function split(p, c) {
  if (!p.dir) {
    const over = clipConvex(p.poly, c);
    return Math.abs(area(over)) > 0.5 ? { over, rest: subtractConvex(p.poly, c) } : null;
  }
  const cen = p.poly.reduce((m, q) => [m[0] + q[0] / p.poly.length, m[1] + q[1] / p.poly.length], [0, 0]), at = q => dot(sub(q, cen), p.dir);
  const h = rayHits([cen[0] - p.dir[0] * 1e5, cen[1] - p.dir[1] * 1e5], p.dir, c), ext = p.poly.map(at);
  if (h.length < 2) return null;
  const a = Math.max(h[0] - 1e5, Math.min(...ext)), b = Math.min(h.at(-1) - 1e5, Math.max(...ext));
  if (b - a < 0.5) return null;
  const over = clipHalf(clipHalf(p.poly, q => at(q) - a), q => b - at(q)), rest = [clipHalf(p.poly, q => a - at(q)), clipHalf(p.poly, q => at(q) - b)];
  return over.length >= 3 && Math.abs(area(over)) > 0.5 ? { over, rest: rest.filter(q => q.length >= 3 && Math.abs(area(q)) > 0.5) } : null;
}

// Where a piece stands at least minGap above a cutter (by its level if it has one, else its top), it starts clear above
// the cutter's top instead of lower down (a bridge over a passage, a block over a tunnel, a wall over a passage), or
// at floor(p, c) where that is higher (out of another area's room), where the overlap passes test. keep: the piece
// keeps at least that much under its top (a floor stays, if with less headroom). Parts left thinner than 1 unit go.
function carve(pieces, cutters, { clear, minGap, test = () => true, floor = () => -Infinity, keep = 0 }) {
  let out = pieces;
  for (const c of cutters) {
    const cb = box2(c.poly);
    out = out.flatMap(p => {
      if ((p.level ?? p.top) - c.top < minGap || !boxesMeet(box2(p.poly), cb)) return [p];
      const cut = split(p, c.poly);
      if (!cut || !test(p, c, cut.over)) return [p];
      let bottom = Math.max(p.bottom, c.top + clear, floor(p, c));
      if (keep) bottom = Math.max(p.bottom, Math.min(bottom, p.top - keep));
      const rest = cut.rest.map(poly => ({ ...p, poly }));
      return p.top - bottom >= 1 ? [...rest, { ...p, poly: cut.over, bottom }] : rest;
    });
  }
  return out;
}

// Pieces a flight runs up through (their top above its foot and at most a riser above its top) lose its footprint: the
// floor of either end drawn on under the flight. A floor higher than that is a bridge over it (carve).
function cutAway(pieces, feet, riser) {
  let out = pieces;
  for (const f of feet) {
    const fb = box2(f.poly);
    out = out.flatMap(p => (p.top > f.bottom + 0.5 && p.top <= f.top + riser && boxesMeet(box2(p.poly), fb) && overlap(p.poly, f.poly) ? subtractConvex(p.poly, f.poly).map(poly => ({ ...p, poly })) : [p]));
  }
  return out;
}

// Where a cutter's walking height is at least clear above a piece's level, the piece is left out under it (the cutter is
// the ceiling there) where the overlap passes test: a roof under a floor, flight or block of a higher level.
function capTop(pieces, cutters, clear, test) {
  let out = pieces;
  for (const c of cutters) {
    const cb = box2(c.poly), walk = c.flight ? c.bottom : c.top;
    out = out.flatMap(p => {
      if (p.level == null || walk - p.level < clear || !boxesMeet(box2(p.poly), cb)) return [p];
      const over = clipConvex(p.poly, c.poly);
      if (Math.abs(area(over)) <= 0.5 || !test(p, c, over)) return [p];
      return subtractConvex(p.poly, c.poly).map(poly => ({ ...p, poly }));
    });
  }
  return out;
}

// The lowest floor under a piece, else its level: where a wall stands.
function footOf(p, walks) {
  const under = walks.filter(c => boxesMeet(box2(p.poly), box2(c.poly)) && overlap(p.poly, c.poly)).map(c => c.top);
  return under.length ? Math.min(...under) : p.level;
}

// Where a floor or flight of another area runs over a piece above its foot there (the lowest of floors under the part
// it crosses; and the overlap passes test), the piece loses the band from that walking height to clear above the
// cutter's top; what is below and above it stays. A wall that runs on from a lower floor onto the cutter stands on it.
function cutBand(pieces, cutters, clear, test, floors) {
  let out = pieces;
  for (const c of cutters) {
    const cb = box2(c.poly), lo = c.flight ? c.bottom : c.top, hi = c.top + clear;
    out = out.flatMap(p => {
      if (p.foot == null || c.area === p.area || lo <= p.foot + 1 || p.top <= lo || p.bottom >= hi || !boxesMeet(box2(p.poly), cb)) return [p];
      const cut = split(p, c.poly);
      if (!cut || lo <= (footOf({ ...p, poly: cut.over }, floors) ?? p.foot) + 1 || !test(p, c, cut.over)) return [p];
      const rest = cut.rest.map(poly => ({ ...p, poly }));
      const below = { ...p, poly: cut.over, top: Math.min(p.top, lo) }, above = { ...p, poly: cut.over, bottom: Math.max(p.bottom, hi) };
      return [...rest, ...[below, above].filter(q => q.top - q.bottom >= 1)];
    });
  }
  return out;
}

// The surface (highest-ranked) whose outline runs along segment a-b: the floor a stairs line was drawn on.
function drawnOn(surfaces, a, b) {
  const m = mid(a, b), d = unit(sub(b, a));
  return surfaces.filter(s => s.poly.some((p, i) => { const q = s.poly[(i + 1) % s.poly.length]; return segDist(m, p, q) < 4 && Math.abs(cross(unit(sub(q, p)), d)) < 0.1; })).sort((x, y) => y.rank - x.rank)[0];
}

// Convex pieces of the closed outlines of one shape; outlines inside an odd number of others are holes.
function fillPieces(polys) {
  const rings = polys.filter(p => p.length >= 3 && Math.abs(area(p)) > 0.5);
  const depth = r => rings.filter(o => o !== r && inside(r[0], o)).length;
  const outer = rings.filter(r => depth(r) % 2 === 0), holes = rings.filter(r => depth(r) % 2 === 1);
  let pieces = outer.flatMap(r => convexParts(r));
  for (const hole of holes) for (const cut of convexParts(hole)) pieces = pieces.flatMap(p => (overlap(p, cut) ? subtractConvex(p, cut) : [p]));
  return pieces;
}

// Pieces of one object at the same heights (loose: at the same top, where their bottoms came from the thickness rule).
function sameHeights(pieces, loose) {
  const groups = new Map();
  for (const p of pieces) { const k = `${p.kind ?? ''}\u0001${p.area}\u0001${p.obj}\u0001${loose && p.settled ? '' : tidy(p.bottom)}\u0001${tidy(p.top)}`; (groups.get(k) ?? groups.set(k, []).get(k)).push(p); }
  return [...groups.values()];
}
// Pieces of one object at the same heights that share a side become one where together they are convex (the hull of
// the two adds no area): the cutting above leaves many pieces that need not be apart, and fewer brushes compile and
// draw faster. loose: pieces whose bottoms came from the thickness rule merge at the lower bottom (a wall running past
// floors of two heights).
function merge(pieces, loose = false) {
  const out = [];
  for (const list of sameHeights(pieces, loose)) {
    const ps = list.map(p => ({ ...p, a: Math.abs(area(p.poly)), b: box2(p.poly) }));
    for (let again = true; again;) {
      again = false;
      for (let i = 0; i < ps.length && !again; i++) for (let j = i + 1; j < ps.length && !again; j++) {
        const p = ps[i], q = ps[j], bi = p.b, bj = q.b;
        if (bi[0] > bj[2] + 0.01 || bj[0] > bi[2] + 0.01 || bi[1] > bj[3] + 0.01 || bj[1] > bi[3] + 0.01) continue;
        const h = ccw(simplify(hull([...p.poly, ...q.poly]), 0.01)), ha = Math.abs(area(h));
        if (h.length < 3 || Math.abs(ha - p.a - q.a) > 0.5) continue;
        ps[i] = { ...p, poly: h, a: ha, b: box2(h), bottom: Math.min(p.bottom, q.bottom) };
        ps.splice(j, 1);
        again = true;
      }
    }
    out.push(...ps.map(({ a, b, ...p }) => p));
  }
  return out;
}
// A floor's, block's or roof's pieces at the same heights cut again from the outline they make together (poly2d.partition)
// and then blocked out as a mapper does (poly2d.boxes): the biggest box that fits, its corners clipped to the outline,
// stopping under the walls standing on it and at doorways, then the next; whole faces in Hammer, not the fans of thin
// triangles the cutting above leaves. cover: walls and blocks; where one stands over the outline (from a slab under its
// top up past it), the outline may run anywhere under it. The other half of a mirrored object takes the mirror image of
// the first half's pieces where its outline is that half's mirrored (flips: the mirror lines, { k: axis, m }), so the
// halves stay mirrors brush for brush (twin: the piece it mirrors).
function regroup(pieces, flips, cover = []) {
  const done = new Map(), out = [];
  for (const list of sameHeights(pieces)) {
    const p0 = list[0], key = `${p0.kind}\u0001${p0.obj.replace(/ \(mirror\)/g, '')}\u0001${tidy(p0.bottom)}\u0001${tidy(p0.top)}`, was = done.get(key);
    const a = list.reduce((s, p) => s + Math.abs(area(p.poly)), 0), b = box2(list.flatMap(p => p.poly));
    const flip = was && was.obj !== p0.obj && Math.abs(a - was.a) < 1 + a * 1e-6 && flips.find(({ k, m }) => [0, 1, 2, 3].every(i => Math.abs((i % 2 === k ? 2 * m - was.b[(i + 2) % 4] : was.b[i]) - b[i]) < 0.05));
    if (flip) {
      out.push(...was.out.map(q => ({ ...p0, poly: q.poly.map(pt => (flip.k ? [pt[0], 2 * flip.m - pt[1]] : [2 * flip.m - pt[0], pt[1]])).reverse(), twin: q })));
      continue;
    }
    const near = w => boxesMeet(box2(w.poly), [b[0] - 1, b[1] - 1, b[2] + 1, b[3] + 1]);
    const slack = cover.filter(w => w.bottom <= p0.top - 15.5 && w.top >= p0.top - 0.5 && near(w)).map(w => w.poly);
    // (the middle lines of the walls standing on it: of an area at its height)
    const walls = cover.filter(w => w.dir && w.level != null && Math.abs(w.level - p0.top) < 1 && w.bottom <= p0.top + 0.5 && w.top >= p0.top + 32 && near(w)).map(w => {
      const c = w.poly.reduce((m, q) => [m[0] + q[0] / w.poly.length, m[1] + q[1] / w.poly.length], [0, 0]), t = w.poly.map(q => dot(sub(q, c), w.dir));
      return [Math.min(...t), Math.max(...t)].map(s => [c[0] + w.dir[0] * s, c[1] + w.dir[1] * s]);
    });
    const cut = partition(list.map(p => p.poly), { slack });
    const ps = cut ? (boxes(cut, { walls }) ?? cut).map(poly => ({ ...p0, poly })) : merge(list);
    if (!was) done.set(key, { obj: p0.obj, a, b, out: ps });
    out.push(...ps);
  }
  return out;
}

// The face of brush s looking along plan direction o shows the 256x256 no-entry sign fitted to it (Hammer's Justify
// Fit), reading left to right from outside.
function noEntry(s, o) {
  const f = V.faces(s).find(q => q.n[0] * o[0] + q.n[1] * o[1] > 0.99);
  if (!f) return;
  const u = [-f.n[1], f.n[0]], us = f.pts.map(p => p[0] * u[0] + p[1] * u[1]), zs = f.pts.map(p => p[2]), mod = x => ((x % 256) + 256) % 256;
  const su = (Math.max(...us) - Math.min(...us)) / 256, sv = (Math.max(...zs) - Math.min(...zs)) / 256;
  V.set(f.side, 'material', 'OVERLAYS/NO_ENTRY');
  V.set(f.side, 'uaxis', `[${fmt(u[0])} ${fmt(u[1])} 0 ${fmt(mod(-Math.min(...us) / su))}] ${fmt(su)}`);
  V.set(f.side, 'vaxis', `[0 0 -1 ${fmt(mod(Math.max(...zs) / sv))}] ${fmt(sv)}`);
}

// Faces of the upright prism over poly from z0 up to z1.
const prism = (poly, z0, z1) => { const up = poly.map(p => [p[0], p[1], z1]), dn = poly.map(p => [p[0], p[1], z0]); return [dn, up, ...poly.map((_, i) => { const j = (i + 1) % poly.length; return [dn[i], dn[j], up[j], up[i]]; })]; };

// ---------- gameplay ----------
// What makes the layout play as KOTH: for each area named "spawn", spawn points (up to 16, spread out, facing its
// stairs out), a respawn room and resupply over its floors and no-entry walls on its stairs out; for the areas named
// "capture", the capture zone over their floors, the control point with its base, the point master, the KOTH logic,
// the game rules and the logic_auto that sets them; a sky box around everything, the sun, and lights under the roofs.
const TRIGGER = 'TOOLS/TOOLSTRIGGER';
function gameplay({ items, floors, flights, walls, blocks, roomTop, roofs, solids, skyHeight, nextId, warn }) {
  const ents = [], sky = [], at = p => p.map(tidy);
  // (gameplay entities are keyed by role: their area and class, numbered in order)
  const point = (cls, o, kv, area, kind) => { const e = V.entity(cls, at(o), nextId); e.kv.push(...kv); ents.push({ entity: e, area, kind, obj: `${keyName(area)}/${cls}` }); return e; };
  const brushes = (pieces, mat) => pieces.map(p => V.brush(prism(p.poly.map(q => q.map(tidy)), tidy(p.bottom), tidy(p.top)), mat, nextId)).filter(V.valid);
  const brushEnt = (cls, kv, sols, area) => {
    const e = V.entity(cls, [0, 0, 0], nextId);
    e.kv = e.kv.filter(([k]) => k !== 'origin');
    e.kv.push(...kv);
    e.children.unshift(...sols);
    ents.push({ entity: e, area, kind: 'trigger', obj: `${keyName(area)}/${cls}` });
    return e;
  };
  const centroid = ps => { let a = 0, x = 0, y = 0; for (const p of ps) { const w = Math.abs(area(p.poly)), c = p.poly.reduce((m, q) => [m[0] + q[0] / p.poly.length, m[1] + q[1] / p.poly.length], [0, 0]); a += w; x += c[0] * w; y += c[1] * w; } return [x / a, y / a]; };
  const label = a => a.split(/\s+/).filter(w => !/^(z-?\d|h\d|mirror-|roofed$|block$|red$|blue?$|\(mirror\)$)/i.test(w)).join(' ');
  // ---- spawn rooms ----
  const spawnAreas = new Map();
  for (const it of items) if (it.spawn && !spawnAreas.has(it.area)) {
    const team = it.team ? (it.team === 'red') !== !!it.mirrored : !!it.mirrored; // true: RED
    spawnAreas.set(it.area, team ? 2 : 3);
  }
  const used = new Map(), filters = new Set();
  for (const [a, team] of spawnAreas) {
    const room = floors.filter(p => p.area === a);
    if (!room.length) { warn(`${a}: a spawn room without a floor was left out`); continue; }
    const t = team === 2 ? 'red' : 'blu', n = (used.get(t) ?? 0) + 1, name = n > 1 ? `spawnroom_${t}${n}` : `spawnroom_${t}`;
    used.set(t, n);
    const vol = room.map(p => ({ poly: p.poly, bottom: p.top, top: roomTop({ area: a, top: p.top }) })), sfx = n > 1 ? String(n) : '';
    brushEnt('func_respawnroom', [['targetname', name], ['TeamNum', String(team)], ['StartDisabled', '0']], brushes(vol, TRIGGER), a);
    // markers drawn in the spawn's group: door lines, locker and spawnpoint shapes; without them all is placed for it
    const marks = role => items.filter(it => it.role === role && it.area === a);
    const centre = it => { const ps = it.lines.flatMap(l => l.pts), m = k => (Math.min(...ps.map(p => p[k])) + Math.max(...ps.map(p => p[k]))) / 2; return [m(0), m(1)]; };
    const middle = centroid(room), floorAt = q => (room.find(p => inside(q, p.poly)) ?? room.reduce((m, p) => (len(sub(centroid([p]), q)) < len(sub(centroid([m]), q)) ? p : m))).top;
    // doors: on each door line, else on the room's end of each flight out (a flight with one end in the room)
    const doorLines = marks('door').flatMap(it => it.lines.flatMap(l => l.pts.slice(0, l.closed ? l.pts.length : l.pts.length - 1).map((p, i) => [p, l.pts[(i + 1) % l.pts.length]])));
    const doors = doorLines.length
      ? doorLines.map(([p, q]) => { const m = mid(p, q), d = unit(sub(q, p)), n = [-d[1], d[0]], o = dot(n, sub(m, middle)) >= 0 ? n : [-n[0], -n[1]]; return { a: p, b: q, z: floorAt([m[0] - o[0] * 24, m[1] - o[1] * 24]), o }; })
      : flights.map(fl => { const k = fl.edges.findIndex(e => e.area === a); if (k < 0 || fl.edges[1 - k].area === a) return null; const e = fl.edges[k], f = fl.edges[1 - k], d = unit(sub(e.b, e.a)), n = [-d[1], d[0]]; return { a: e.a, b: e.b, z: e.z, o: dot(n, sub(mid(f.a, f.b), mid(e.a, e.b))) >= 0 ? n : [-n[0], -n[1]] }; }).filter(Boolean);
    const filter = `filter_${t}`, keepOut = [];
    if (doors.length && !filters.has(filter)) { filters.add(filter); point('filter_activator_tfteam', [...middle, room[0].top + 64], [['targetname', filter], ['TeamNum', String(team)], ['Negated', '0']], a, 'point'); }
    // on each: a no-entry wall (nodraw but the sign on its face out of the room), then a door that slides down for the
    // team (a trigger around it, filtered to the team); spawn points keep out of the trigger
    doors.forEach(({ a: p0, b: p1, z, o }, k) => {
      // the band along the door from s0 to s1 out of the room
      const band = (s0, s1) => { const at = (p, sv) => [p[0] + o[0] * sv, p[1] + o[1] * sv]; return ccw([at(p0, s0), at(p1, s0), at(p1, s1), at(p0, s1)]); };
      const top = roomTop({ area: a, top: z }), door = `door_${t}${sfx}_${k + 1}`;
      const blocker = brushes([{ poly: band(-4, 4), bottom: z, top }], 'TOOLS/TOOLSNODRAW');
      blocker.forEach(s => noEntry(s, o));
      brushEnt('func_respawnroomvisualizer', [['respawnroomname', name], ['solid_to_enemies', '1'], ['rendermode', '0'], ['Solidity', '1']], blocker, a);
      keepOut.push({ p0, d: unit(sub(p1, p0)), L: len(sub(p1, p0)), o });
      brushEnt('func_door', [['targetname', door], ['speed', '500'], ['movedir', '90 0 0'], ['lip', '0'], ['wait', '-1'], ['spawnflags', '0'], ['forceclosed', '0'], ['ignoredebris', '1'], ['spawnpos', '0'], ['dmg', '0'], ['rendercolor', '255 255 255']], brushes([{ poly: band(6, 14), bottom: z - 16, top }], 'DEV/DEV_MEASUREDOOR01'), a);
      const trig = brushEnt('trigger_multiple', [['filtername', filter], ['spawnflags', '1'], ['wait', '0'], ['StartDisabled', '0']], brushes([{ poly: band(-96, 96), bottom: z - 16, top: z + 128 }], TRIGGER), a);
      trig.children.unshift({ name: 'connections', kv: [['OnStartTouchAll', `${door},Open,,0,-1`], ['OnEndTouchAll', `${door},Close,,0,-1`]], children: [] });
    });
    if (!doors.length) warn(`${a}: no door lines and no stairs out of the spawn room, so no doors`);
    // where spawn points face: the doors
    const out = doors.length ? doors.reduce((m, dr) => [m[0] + (dr.a[0] + dr.b[0]) / 2 / doors.length, m[1] + (dr.a[1] + dr.b[1]) / 2 / doors.length], [0, 0]) : middle;
    // spawn point spots: a 64 grid inside the room, 32 clear of walls and of its edges, and out of the door triggers
    // (96 each side of a door) by a player's half width: one spawning there would hold the door open
    const inRoom = q => room.some(p => inside(q, p.poly)) && !walls.some(w => inside(q, w.poly));
    const byDoor = q => keepOut.some(k => { const v = sub(q, k.p0), s = dot(v, k.d); return s > -24 && s < k.L + 24 && Math.abs(dot(v, k.o)) < 120; });
    const pts = [], b = box2(room.flatMap(p => p.poly));
    for (let x = Math.ceil(b[0] / 64) * 64; x <= b[2]; x += 64) for (let y = Math.ceil(b[1] / 64) * 64; y <= b[3]; y += 64) {
      const q = [x, y];
      if (!byDoor(q) && [[0, 0], [32, 0], [-32, 0], [0, 32], [0, -32], [23, 23], [-23, 23], [23, -23], [-23, -23]].every(([dx, dy]) => inRoom([x + dx, y + dy]))) pts.push({ q, z: room.find(p => inside(q, p.poly)).top });
    }
    const nearWall = q => {
      let best = null;
      for (const w of walls) w.poly.forEach((p, i) => {
        const r2 = w.poly[(i + 1) % w.poly.length], e = sub(r2, p), t2 = Math.max(0, Math.min(1, dot(sub(q, p), e) / (dot(e, e) || 1))), c = [p[0] + e[0] * t2, p[1] + e[1] * t2], dd = len(sub(q, c));
        if (dd < (best?.d ?? 160)) best = { c, d: dd };
      });
      return best;
    };
    // resupply lockers: at each locker marker, facing away from the nearest wall; else one against the wall nearest the
    // back of the room (of the third farthest from the doors, the spot nearest a wall). Resupply in front of each;
    // without any the whole room resupplies
    const lockers = marks('locker').map(it => { const c = centre(it), w = nearWall(c); return { o: c, z: floorAt(c), dir: w ? unit(sub(c, w.c)) : unit(sub(out, c)) }; });
    if (!lockers.length) {
      const backs = [...pts].sort((p, q) => len(sub(q.q, out)) - len(sub(p.q, out))).slice(0, Math.max(1, Math.ceil(pts.length / 3))).map(p => ({ p, w: nearWall(p.q) })).filter(x => x.w);
      const best = backs.reduce((m, x) => (!m || x.w.d < m.w.d ? x : m), null);
      if (best) { const dir = unit(sub(best.p.q, best.w.c)); lockers.push({ o: [best.w.c[0] + dir[0] * 17, best.w.c[1] + dir[1] * 17], z: best.p.z, dir }); }
    }
    lockers.forEach(({ o, z, dir }, k) => {
      const locker = `resupply_locker_${t}${sfx}${lockers.length > 1 ? `_${k + 1}` : ''}`;
      point('prop_dynamic', [o[0], o[1], z], [['angles', `0 ${tidy(((Math.atan2(dir[1], dir[0]) * 180) / Math.PI + 360) % 360)} 0`], ['model', 'models/props_gameplay/resupply_locker.mdl'], ['targetname', locker], ['solid', '6'], ['skin', '0']], a, 'point'); // the model has one skin
      // the resupply volume holds the locker (17 deep behind its origin) and the space in front of it
      const sd = [-dir[1], dir[0]], at = (along, side) => [o[0] + dir[0] * along + sd[0] * side, o[1] + dir[1] * along + sd[1] * side];
      brushEnt('func_regenerate', [['TeamNum', String(team)], ['StartDisabled', '0'], ['associatedmodel', locker]], brushes([{ poly: ccw([at(-17, -48), at(104, -48), at(104, 48), at(-17, 48)]), bottom: z, top: z + 128 }], TRIGGER), a);
      // spawn points keep clear of the locker and the space in front of it
      for (let i = pts.length - 1; i >= 0; i--) if (len(sub(pts[i].q, o)) < 128) pts.splice(i, 1);
    });
    if (!lockers.length) brushEnt('func_regenerate', [['TeamNum', String(team)], ['StartDisabled', '0']], brushes(vol, TRIGGER), a);
    // spawn points: at each spawnpoint marker, else up to 16 spread over the grid from the back; all face the doors
    let pick = marks('spawnpoint').map(it => { const c = centre(it); return { q: c, z: floorAt(c) }; });
    if (!pick.length) {
      if (pts.length) pick.push(pts.reduce((m, p) => (len(sub(p.q, out)) > len(sub(m.q, out)) ? p : m)));
      while (pick.length < Math.min(16, pts.length)) pick.push(pts.filter(p => !pick.includes(p)).reduce((m, p) => { const d = Math.min(...pick.map(k => len(sub(k.q, p.q)))); return d > m.d ? { p, d } : m; }, { p: null, d: -1 }).p);
      if (pick.length < 8) warn(`${a}: room for only ${pick.length} spawn points`);
    }
    // each faces its nearest door (the doors' average can lie behind a wall); class flags all on, as Hammer writes them
    const exits = doors.map(dr => mid(dr.a, dr.b));
    for (const p of pick) {
      const to = exits.length ? exits.reduce((m, c) => (len(sub(c, p.q)) < len(sub(m, p.q)) ? c : m)) : out, yaw = (Math.atan2(to[1] - p.q[1], to[0] - p.q[0]) * 180) / Math.PI;
      point('info_player_teamspawn', [p.q[0], p.q[1], p.z + 8], [['angles', `0 ${tidy((yaw + 360) % 360)} 0`], ['TeamNum', String(team)], ['StartDisabled', '0'], ['SpawnMode', '0'], ['spawnflags', '511']], a, 'spawn');
    }
  }
  // ---- the control point ----
  // (the zone: "capturezone" shapes, else the floors of the areas named capture; the point: a "controlpoint" shape,
  // else the middle of the zone. A marker on the mirror line and its copy are one)
  const capAreas = new Set(items.filter(it => it.capture).map(it => it.area)), standOn = q => floors.filter(p => inside(q, p.poly)).sort((x, y) => y.top - x.top)[0]?.top;
  const zoneMarks = items.filter(it => it.role === 'capturezone').flatMap(it => fillPieces(it.lines.filter(l => l.closed && l.pts.length >= 3).map(l => l.pts)).map(poly => ({ poly, area: it.area })));
  const cap = zoneMarks.length ? zoneMarks.map(z => ({ ...z, top: standOn(centroid([z])) ?? standOn(z.poly[0]) ?? 0 })) : floors.filter(p => capAreas.has(p.area));
  const pointMarks = [];
  for (const it of items.filter(i => i.role === 'controlpoint')) {
    const ps = it.lines.flatMap(l => l.pts), m = k => (Math.min(...ps.map(p => p[k])) + Math.max(...ps.map(p => p[k]))) / 2, c = [m(0), m(1)];
    if (!pointMarks.some(p => len(sub(p.c, c)) < 16)) pointMarks.push({ c, area: it.area });
  }
  if (pointMarks.length > 1) warn(`${pointMarks.length} controlpoint markers: the first is the point`);
  if (!cap.length && pointMarks.length) warn('a controlpoint marker without a capture zone (a capturezone shape or an area named capture): no point');
  if (cap.length) {
    const a = pointMarks[0]?.area ?? [...capAreas][0] ?? cap[0].area, c = pointMarks[0]?.c ?? centroid(cap), top = standOn(c) ?? Math.max(...cap.map(p => p.top)), name = 'cp_koth';
    // one brush where the zone's pieces (a half and its mirror) make one convex shape at one height: no seam inside it
    const whole = ccw(simplify(hull(cap.flatMap(p => p.poly)), 0.01)), convex = cap.every(p => p.top === cap[0].top) && Math.abs(Math.abs(area(whole)) - cap.reduce((s, p) => s + Math.abs(area(p.poly)), 0)) < 0.5;
    const zone = convex ? [{ poly: whole, top: cap[0].top }] : cap;
    const zoneEnt = brushEnt('trigger_capture_area', [['area_cap_point', name], ['area_time_to_cap', '10'], ['team_cancap_2', '1'], ['team_cancap_3', '1'], ['team_numcap_2', '1'], ['team_numcap_3', '1'], ['team_startcap_2', '1'], ['team_startcap_3', '1'], ['spawnflags', '1'], ['StartDisabled', '0']], brushes(zone.map(p => ({ poly: p.poly, bottom: p.top, top: p.top + 160 })), TRIGGER), a);
    // a cap runs the capping team's KOTH clock, colours the base, and the holders respawn slower (8 s) than the others (4 s)
    zoneEnt.children.unshift({ name: 'connections', kv: [
      ['OnCapTeam1', 'cp_koth_prop,Skin,1,0,-1'], ['OnCapTeam1', 'koth_gamerules,SetRedKothClockActive,,0,-1'], ['OnCapTeam1', 'koth_gamerules,SetRedTeamRespawnWaveTime,8,0,-1'], ['OnCapTeam1', 'koth_gamerules,SetBlueTeamRespawnWaveTime,4,0,-1'],
      ['OnCapTeam2', 'cp_koth_prop,Skin,2,0,-1'], ['OnCapTeam2', 'koth_gamerules,SetBlueKothClockActive,,0,-1'], ['OnCapTeam2', 'koth_gamerules,SetBlueTeamRespawnWaveTime,8,0,-1'], ['OnCapTeam2', 'koth_gamerules,SetRedTeamRespawnWaveTime,4,0,-1']], children: [] });
    // the hologram stands 4 over the base (at the same origin its foot sinks into the disc)
    point('team_control_point', [c[0], c[1], top + 4], [['angles', '0 0 0'], ['targetname', name], ['point_printname', `the ${label(a) || 'point'}`], ['spawnflags', '4'], ['point_warn_sound', 'ControlPoint.CaptureWarn'], ['point_index', '0'], ['point_default_owner', '0'], ['point_start_locked', '0'], ['point_group', '0'], ['point_warn_on_cap', '0'],
      ['team_icon_0', 'sprites/obj_icons/icon_obj_neutral'], ['team_icon_2', 'sprites/obj_icons/icon_obj_red'], ['team_icon_3', 'sprites/obj_icons/icon_obj_blu'], ['team_model_0', 'models/effects/cappoint_hologram.mdl'], ['team_model_2', 'models/effects/cappoint_hologram.mdl'], ['team_model_3', 'models/effects/cappoint_hologram.mdl'],
      ['team_bodygroup_0', '3'], ['team_bodygroup_2', '1'], ['team_bodygroup_3', '1'], ['StartDisabled', '0']], a, 'point');
    point('prop_dynamic', [c[0], c[1], top], [['angles', '0 0 0'], ['model', 'models/props_gameplay/cap_point_base.mdl'], ['targetname', 'cp_koth_prop'], ['solid', '6'], ['skin', '0'], ['disableshadows', '1']], a, 'point');
    point('team_control_point_master', [c[0], c[1], top + 256], [['targetname', 'master_cp'], ['team_base_icon_2', 'sprites/obj_icons/icon_base_red'], ['team_base_icon_3', 'sprites/obj_icons/icon_base_blu'], ['cpm_restrict_team_cap_win', '0'], ['switch_teams', '0'], ['score_style', '0'], ['play_all_rounds', '0'], ['partial_cap_points_rate', '0'], ['custom_position_x', '-1'], ['custom_position_y', '-1'], ['StartDisabled', '0']], a, 'point');
    point('tf_logic_koth', [c[0], c[1] + 64, top + 256], [['timer_length', '180'], ['unlock_point', '30']], a, 'point');
    point('tf_gamerules', [c[0], c[1] + 128, top + 256], [['targetname', 'koth_gamerules'], ['ctf_overtime', '1'], ['hud_type', '0'], ['ropes_holiday_lights_allowed', '1']], a, 'point');
    // each round: 6 s respawn waves and the KOTH goal on the HUD
    point('logic_auto', [c[0], c[1] + 192, top + 256], [['spawnflags', '1']], a, 'point').children.unshift({ name: 'connections', kv: [
      ['OnMultiNewRound', 'koth_gamerules,SetBlueTeamRespawnWaveTime,6,0,-1'], ['OnMultiNewRound', 'koth_gamerules,SetRedTeamRespawnWaveTime,6,0,-1'],
      ['OnMultiNewRound', 'koth_gamerules,SetRedTeamGoalString,#koth_setup_goal,0,-1'], ['OnMultiNewRound', 'koth_gamerules,SetBlueTeamGoalString,#koth_setup_goal,0,-1']], children: [] });
  } else if (spawnAreas.size) warn('no area named capture (or cp): the map has no control point');
  // ---- sky box, sun, lights under roofs ----
  if (solids.length) {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const s of solids) for (const f of V.faces(s.solid)) for (const p of f.pts) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); }
    const lo = [mn[0] - 64, mn[1] - 64, mn[2] - 16].map(v => Math.floor(v / 16) * 16), hi = [mx[0] + 64, mx[1] + 64, mx[2] + 256].map(v => Math.ceil(v / 16) * 16);
    // (the sun over the middle, under the sky's ceiling)
    point('light_environment', [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, Math.min(hi[2] - 64, mx[2] + skyHeight / 2)], [['angles', '-50 30 0'], ['pitch', '-50'], ['_light', '255 238 214 450'], ['_ambient', '150 170 200 120'], ['_lightHDR', '-1 -1 -1 1'], ['_ambientHDR', '-1 -1 -1 1'], ['_lightscaleHDR', '1'], ['_AmbientScaleHDR', '1'], ['SunSpreadAngle', '5']], 'Sky', 'light');
    // lights on a 256 grid over every floor (symmetric across the middle), one per level where floors stack, 128 up or
    // under what is above: bright under a roof (a roofed area's, a floor or a block above), a soft fill in the open, so
    // no corner the sun misses is black
    const lit = [];
    const lamp = (q, only) => {
      if (walls.some(w => inside(q, w.poly))) return;
      const here = floors.filter(p => inside(q, p.poly)).sort((p, r) => p.top - r.top);
      here.forEach((p, k) => {
        const over = blocks.filter(b => b.bottom >= p.top - 0.5 && inside(q, b.poly)).map(b => b.bottom);
        const above = Math.min(k + 1 < here.length ? here[k + 1].bottom : roomTop({ area: p.area, top: p.top }), ...over), room = above - p.top;
        if ((only && p !== only) || room < 64) return;
        const roofed = roofs.has(p.area) || k + 1 < here.length || over.length > 0;
        lit.push({ q, z: p.top, area: p.area });
        point('light', [q[0], q[1], p.top + Math.min(128, room - 24)], [['_light', roofed ? '255 236 210 200' : '255 240 225 90'], ['_lightHDR', '-1 -1 -1 1'], ['_fifty_percent_distance', roofed ? '160' : '224'], ['_zero_percent_distance', roofed ? '420' : '560']], p.area, 'light');
      });
    };
    for (let x = Math.floor(lo[0] / 256) * 256 + 128; x <= hi[0]; x += 256) for (let y = Math.floor(lo[1] / 256) * 256 + 128; y <= hi[1]; y += 256) lamp([x, y]);
    // a floor the grid misses (a narrow passage, a small room) gets one in its middle, unless its area has one within 192
    for (const p of [...floors].sort((x, y) => Math.abs(area(y.poly)) - Math.abs(area(x.poly)))) {
      const c = centroid([p]);
      if (Math.abs(area(p.poly)) >= 64 * 64 && inside(c, p.poly) && !lit.some(l => l.area === p.area && Math.abs(l.z - p.top) < 64 && len(sub(l.q, c)) < 192)) lamp(c, p);
    }
    // a covered flight (a roofed area's, or under a floor or a block) gets one over its middle: no light comes down a
    // stairwell from its ends
    for (const fl of flights) {
      const ps = fl.edges.flatMap(e => [e.a, e.b]), c = [ps.reduce((m, p) => m + p[0] / 4, 0), ps.reduce((m, p) => m + p[1] / 4, 0)], z0 = Math.min(...fl.edges.map(e => e.z)), z1 = Math.max(...fl.edges.map(e => e.z));
      const over = [...blocks, ...floors].filter(b => b.bottom >= z1 - 0.5 && inside(c, b.poly)).map(b => b.bottom), roof = Math.min(roomTop({ area: fl.area, top: z1 }), ...over);
      if ((!roofs.has(fl.area) && !over.length) || walls.some(w => inside(c, w.poly)) || lit.some(l => l.area === fl.area && Math.abs(l.z - z1) < 160 && len(sub(l.q, c)) < 192)) continue;
      lit.push({ q: c, z: z1, area: fl.area });
      point('light', [c[0], c[1], Math.min((z0 + z1) / 2 + 128, roof - 24)], [['_light', '255 236 210 200'], ['_lightHDR', '-1 -1 -1 1'], ['_fifty_percent_distance', '160'], ['_zero_percent_distance', '420']], fl.area, 'light');
    }
    // the sky: a shell tight round the brushes, its ceiling skyHeight over the highest, and 16 clear of every entity
    // (one outside it leaks)
    const os = ents.map(e => V.nums(V.get(e.entity, 'origin'))).filter(o => o.length === 3), T = 16;
    const s0 = mn.map((v, k) => Math.floor(Math.min(v, ...os.map(o => o[k] - 16)) / 16) * 16), s1 = [mx[0], mx[1], mx[2] + skyHeight].map((v, k) => Math.ceil(Math.max(v, ...os.map(o => o[k] + 16)) / 16) * 16);
    for (let k = 0; k < 3; k++) for (const side of [0, 1]) {
      const a0 = [...s0], a1 = [...s1];
      if (side) { a0[k] = s1[k]; a1[k] = s1[k] + T; } else { a0[k] = s0[k] - T; a1[k] = s0[k]; }
      for (const j of [0, 1, 2]) if (j !== k) { a0[j] -= T; a1[j] += T; }
      sky.push({ solid: V.block(a0, a1, 'TOOLS/TOOLSSKYBOX', nextId), area: 'Sky', kind: 'sky', obj: 'sky' });
    }
  }
  return { solids: sky, entities: ents };
}

// ---------- main ----------
// shapes: readSvg output. Returns { solids: [{ solid, area, kind, obj, key }], entities: [{ entity, area, kind, obj, key }]
// (pickups, gameplay), areas: [{ name, z, count }], warnings, counts, offset, base } where offset is what was subtracted
// from the SVG x and added to the flipped y (y up in the map) and base the floors' bottom; opts.offset and opts.base
// keep those of an earlier import (base only where it is lower), so an update compares like with like.
// obj names the object a brush belongs to: one floor, landing or block shape, one wall between corners, one flight.
// key is stable from one export to the next: the layer path (see items), the object and the piece's number in it.
export function importLayout(shapes, opts = {}, nextId = () => '0') {
  const o = { ...DEFAULTS, ...opts }, warnings = [], warn = w => warnings.includes(w) || warnings.push(w);
  // ---- classify ----
  const items = [], paths = new Map();
  for (const s of shapes) {
    const parsed = s.names.map(readName);
    if (parsed.some(p => p.role === 'ignore')) continue;
    const inner = k => { for (let i = parsed.length - 1; i >= 0; i--) if (parsed[i][k] !== undefined) return { v: parsed[i][k], i }; return null; };
    const z = inner('z'), block = inner('block'), mirror = inner('mirror'), roleAt = inner('role');
    const inLayout = z || block || mirror || roleAt;
    if (!inLayout) continue;
    let role = roleAt?.v;
    if (!role) {
      if (!z && !block) continue;
      role = s.fill ? 'floor' : s.stroke ? (s.strokeWidth >= 6 ? 'walls' : 'stairs') : null;
      if (!role) continue;
    }
    // the area: the innermost layer with a z or block (else the layer holding the shape)
    const own = parsed.length - 1, anc = k => { for (let i = own - 1; i >= 0; i--) if (parsed[i][k] !== undefined) return i; return -1; };
    const ai = Math.max(anc('z'), anc('block')), areaIdx = ai >= 0 ? ai : Math.max(0, own - 1);
    // key: the layer path (keyName: Figma numbers repeated names across the whole file, so a new layer would rename
    // others), then the shape's place among shapes on the same path
    const path = s.names.map(keyName).join('/'), seen = paths.get(path) ?? 0;
    paths.set(path, seen + 1);
    items.push({
      key: seen ? `${path}[${seen + 1}]` : path, shape: s, role, z: z?.v ?? null, h: inner('h')?.v ?? o.wallHeight, block: !!block, roofed: !!inner('roofed'),
      pickup: inner('pickup')?.v, size: inner('size')?.v ?? 'medium', spawn: !block && !!inner('spawn'), team: inner('team')?.v ?? null, capture: !block && !!inner('capture'), area: role === 'pickup' ? 'Pickups' : s.names[areaIdx] ?? 'layout', mirror: mirror ? { side: mirror.v, key: s.names.slice(0, mirror.i + 1).join('\u0001') } : null,
    });
  }
  if (!items.length) return { error: 'nothing to import: name the layers (an area group with z<height> holding floor, walls, stairs and landing layers)' };
  // ---- mirror (SVG coordinates) ----
  const groups = new Map(), lines = [];
  for (const it of items) if (it.mirror) (groups.get(it.mirror.key) ?? groups.set(it.mirror.key, []).get(it.mirror.key)).push(it);
  for (const list of groups.values()) {
    // (the edge of the half's geometry: a marker on the mirror line does not move it)
    const geo = list.filter(it => !MARKERS.has(it.role)), pts = (geo.length ? geo : list).flatMap(it => it.shape.polylines.flatMap(l => l.pts)), xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const side = list[0].mirror.side, line = side === 'left' ? Math.max(...xs) : side === 'right' ? Math.min(...xs) : side === 'top' ? Math.max(...ys) : Math.min(...ys);
    const flip = side === 'left' || side === 'right' ? p => [2 * line - p[0], p[1]] : p => [p[0], 2 * line - p[1]];
    lines.push({ k: side === 'left' || side === 'right' ? 0 : 1, line });
    for (const it of list) items.push({ ...it, key: `${it.key} (mirror)`, mirrored: true, area: `${it.area} (mirror)`, shape: { ...it.shape, polylines: it.shape.polylines.map(l => ({ pts: l.pts.map(flip).reverse(), closed: l.closed })) } });
  }
  // ---- map coordinates: x right, y up, centred on the grid; the drawing's own grid offset (often .5) is kept ----
  const all = items.flatMap(it => it.shape.polylines.flatMap(l => l.pts));
  const frac = k => { const half = all.filter(p => Math.abs((p[k] % 1 + 1) % 1 - 0.5) < 0.01).length, whole = all.filter(p => Math.abs(Math.round(p[k]) - p[k]) < 0.01).length; return half > whole ? 0.5 : 0; };
  const xs = all.map(p => p[0]), ys = all.map(p => p[1]);
  const [cx, cy] = o.offset ?? [Math.round((Math.min(...xs) + Math.max(...xs)) / 2 / o.grid) * o.grid + frac(0), Math.round((Math.min(...ys) + Math.max(...ys)) / 2 / o.grid) * o.grid + frac(1)];
  // (points of different shapes drawn on one spot are one point: Figma leaves them a tenth apart, and two faces a hair
  // apart leave a crack that the compiler lights black. A point within 0.15 of a whole unit is that unit; then each
  // point joins the first one kept within 0.35 of it)
  const kept = new Map(), cell = (x, y) => `${Math.floor(x)},${Math.floor(y)}`;
  const weld = q => {
    const [x, y] = q.map(v => (Math.abs(v - Math.round(v)) < 0.15 ? Math.round(v) : v));
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const c of kept.get(cell(x + i, y + j)) ?? []) if (Math.hypot(c[0] - x, c[1] - y) < 0.35) return [...c];
    (kept.get(cell(x, y)) ?? kept.set(cell(x, y), []).get(cell(x, y))).push([x, y]);
    return [x, y];
  };
  const map = p => weld([tidy(p[0] - cx), tidy(cy - p[1])]), flips = lines.map(({ k, line }) => ({ k, m: k ? cy - line : line - cx }));
  const once = (ps, closed) => { const out = ps.filter((p, i) => !i || p[0] !== ps[i - 1][0] || p[1] !== ps[i - 1][1]); if (closed && out.length > 1 && out[0][0] === out.at(-1)[0] && out[0][1] === out.at(-1)[1]) out.pop(); return out; };
  // (and a corner of an outline less than 0.3 off the line through its neighbours is no corner: it would bend a face a hair
  // off another shape's edge along the same line)
  for (const it of items) it.lines = it.shape.polylines.map(l => { const pts = once(l.pts.map(map), l.closed); return { pts: l.closed && pts.length > 3 ? simplify(pts, 0.3) : pts, closed: l.closed }; }).filter(l => l.pts.length >= 2);
  // ---- heights ----
  for (const it of items) {
    if (it.z === null && it.role === 'floor' && it.shape.fill && /^#/.test(it.shape.fill) && !it.block) {
      it.z = Math.round(8 * (lightness(it.shape.fill) - 50));
      warn(`${it.area}: no z in the layer names, height ${it.z} read from the fill colour`);
    }
  }
  const zs = items.map(it => it.z).filter(z => z !== null);
  if (!zs.length) return { error: 'no heights: give the area groups a z<height> (z0 is the ground)' };
  const base = Math.min(o.base ?? Infinity, Math.floor((Math.min(...zs) - 32) / 16) * 16), clear = o.clearance, slab = o.slab, riser = STAIRS.step;
  // ---- floors and landings ----
  const floorPieces = [], surfaces = [], landingHulls = [];
  items.forEach((it, k) => {
    if (it.role === 'floor' && !it.block) {
      if (it.z === null) return warn(`${it.area}: a floor without a height was left out`);
      const pieces = fillPieces(it.lines.map(l => l.pts));
      if (!pieces.length) warn(`${it.area}: a floor outline could not be split into convex pieces (does it cross itself?)`);
      for (const poly of pieces) floorPieces.push({ poly, top: it.z, bottom: base, rank: k, area: it.area, kind: 'floor', item: it, obj: it.key });
    } else if (it.role === 'landing') {
      if (it.z === null) return warn(`${it.area}: a landing without a height (name it landing z<height>) was left out`);
      const closed = it.lines.filter(l => l.closed && l.pts.length >= 3), outline = closed.length ? closed.map(l => l.pts) : [hull(it.lines.flatMap(l => l.pts))];
      for (const poly of fillPieces(outline)) floorPieces.push({ poly, top: it.z, bottom: base, rank: 1e6 + k, area: it.area, kind: 'landing', item: it, obj: it.key });
      landingHulls.push(it);
    }
  });
  for (const p of floorPieces) surfaces.push(p);
  // ---- levels: an area's z, or for one without (a passage of stairs and landings) the highest of its landings and of
  // the floors its stairs lines are drawn along ----
  const derived = new Map(), raise = (a, z) => derived.set(a, Math.max(derived.get(a) ?? -Infinity, z));
  for (const it of items) {
    if (it.role === 'landing' && it.z !== null) raise(it.area, it.z);
    if (it.role === 'stairs' || it.role === 'ramp') for (const l of it.lines) for (let i = 0; i + 1 < l.pts.length; i++) {
      const fl = drawnOn(surfaces, l.pts[i], l.pts[i + 1]);
      if (fl) raise(it.area, fl.top);
    }
  }
  const levelOf = it => it.z ?? derived.get(it.area) ?? null;
  // ---- rooms: over each floor, landing and flight, an area's room reaches up to its walls' top (without walls: its
  // layers' top), and at least clear above the floor or the flight's top. A floor, wall or block of another area over
  // it starts at the room's top, so nothing hangs down into it; one whose own floor is lower is a slab under that floor.
  const wallTop = new Map(), layerTop = new Map(), up = (m, a, z) => m.set(a, Math.max(m.get(a) ?? -Infinity, z));
  for (const it of items) {
    const lv = levelOf(it);
    if (lv === null) continue;
    up(layerTop, it.area, lv + it.h);
    if (it.role === 'walls') up(wallTop, it.area, lv + it.h);
  }
  const roomTop = c => Math.max(wallTop.get(c.area) ?? layerTop.get(c.area) ?? -Infinity, c.top + clear);
  const outOfRoom = (p, c) => (c.area !== p.area ? Math.min(roomTop(c), (p.level ?? p.top) - slab) : -Infinity);
  // ---- walls ----
  const wallPolys = [], wallLines = [], gap = clear + slab, ends = [], joints = [];
  for (const it of items) {
    if (it.role !== 'walls' || it.block) continue;
    const level = levelOf(it), top = (level ?? 0) + it.h;
    it.lines.forEach((l, li) => {
      const runs = wallRuns(l.pts, l.closed, o.wallThickness), w = { bottom: base, top, level, area: it.area };
      wallLines.push({ ...l, level });
      runs.forEach((run, r) => { for (const { poly, dir } of run) wallPolys.push({ ...w, poly, dir, obj: `${it.key}.${li}.${r}` }); });
      const open = !l.closed && l.pts.length >= 2;
      if (!runs.length) return;
      if (open) ends.push({ ...w, p: l.pts[0], next: l.pts[1], line: wallLines.length - 1, obj: `${it.key}.${li}.0` }, { ...w, p: l.pts.at(-1), next: l.pts.at(-2), line: wallLines.length - 1, obj: `${it.key}.${li}.${runs.length - 1}` });
      l.pts.forEach((p, k) => { if (!open || (k > 0 && k < l.pts.length - 1)) ends.push({ ...w, p, corner: true, line: wallLines.length - 1, obj: `${it.key}.${li}.c${k}` }); });
    });
  }
  // an open end meeting another wall gets a post as wide as the wall (the drawing's round cap): two square ends that
  // meet at an angle would leave a slit. An end or a corner less than 32 short of another wall is bridged to it: no
  // player fits through, and the gap shows as a black slit
  const h2 = o.wallThickness / 2;
  for (const e of ends) {
    let near = null;
    wallLines.forEach((l, i) => {
      if (i === e.line) return;
      for (let k = 0; k + 1 < l.pts.length + (l.closed ? 1 : 0); k++) {
        const p = l.pts[k], q = l.pts[(k + 1) % l.pts.length], d = sub(q, p), t = Math.max(0, Math.min(1, dot(sub(e.p, p), d) / (dot(d, d) || 1))), c = [p[0] + d[0] * t, p[1] + d[1] * t], dist = len(sub(e.p, c));
        if (dist < (near?.dist ?? Infinity)) near = { c, dist };
      }
    });
    const post = c => [0, 1, 2, 3, 4, 5, 6, 7].map(k => [c[0] + Math.cos((k * Math.PI) / 4) * h2, c[1] + Math.sin((k * Math.PI) / 4) * h2]);
    if (near && near.dist <= o.wallThickness) { if (!e.corner) joints.push({ ...e, poly: post(e.p), dir: unit(sub(e.p, e.next)), to: near.c }); }
    else if (near && near.dist < o.wallThickness + 32) joints.push({ ...e, poly: ccw(hull([...post(e.p), ...post(near.c)])), dir: unit(sub(near.c, e.p)), to: near.c });
  }
  const obstacles = wallPolys.map(w => ({ poly: w.poly, z0: w.bottom, z1: w.top, level: w.level }));
  // ---- stairs: pair the end lines, then build each flight with the Stairs tool ----
  const flights = pairEdges(items, surfaces, wallLines, warn, clear, gap);
  const stairSolids = [], fillers = [];
  flights.forEach((f, k) => {
    const [e1, e2] = f.edges, obj = `flight ${f.key}`, hi = Math.max(e1.z, e2.z), lo = Math.min(e1.z, e2.z);
    if (Math.abs(e1.z - e2.z) < 0.5) return void fillers.push({ poly: ccw(hull([e1.a, e1.b, e2.a, e2.b])), top: e1.z, bottom: base, rank: 2e6, area: f.area, kind: 'landing', obj });
    const r = buildStairs([[...e1.a, e1.z], [...e1.b, e1.z]], [[...e2.a, e2.z], [...e2.b, e2.z]], { type: f.ramp ? 'ramp' : 'stairs', fit: true, group: false }, obstacles.filter(w => !(w.level !== null && (w.level >= hi + clear || w.level + 16 <= lo) && across(w.poly, e1, e2))), o.materials.floor, nextId);
    if (r.error) return void warn(`stairs near ${fmt(f.at[0])} ${fmt(f.at[1])}: ${r.error}`);
    for (const w of r.warnings) if (/treads only|steep|degenerate|across/.test(w)) warn(`stairs near ${fmt(f.at[0])} ${fmt(f.at[1])}: ${w}`);
    for (const solid of r.solids) stairSolids.push({ solid, area: f.area, obj });
  });
  // ---- resolve floors: similar heights paint over each other; much higher ones leave headroom. A floor drawn on
  // across a flight is cut away over it; one well above a flight leaves headroom ----
  const stairFoot = stairSolids.map(({ solid, obj, area: a }) => {
    const fs = V.faces(solid), zs = fs.flatMap(f => f.pts.map(p => p[2])), bot = fs.find(f => f.n[2] < -0.99);
    return bot ? { poly: ccw(bot.pts.map(p => [p[0], p[1]])), top: Math.max(...zs), bottom: Math.min(...zs), obj, area: a } : null;
  }).filter(Boolean);
  // a flight's footprint as one piece where it is convex (a straight flight), else its steps' (fewer cuts in the floors),
  // with its highest step's top: what stands over a flight is flat over all of it (no saw-tooth undersides)
  const flightFoot = [...stairFoot.reduce((m, f) => m.set(f.obj, [...(m.get(f.obj) ?? []), f]), new Map()).values()].flatMap(list => {
    const top = Math.max(...list.map(f => f.top)), bottom = Math.min(...list.map(f => f.bottom)), h = ccw(hull(list.flatMap(f => f.poly))), obj = list[0].obj, a = list[0].area;
    const sum = list.reduce((a, f) => a + Math.abs(area(f.poly)), 0);
    return Math.abs(area(h)) <= sum * 1.02 ? [{ poly: h, top, bottom, obj, area: a }] : list.map(f => ({ poly: f.poly, top, bottom, obj, area: a }));
  });
  let floors = paint([...floorPieces, ...fillers.map(f => ({ ...f, poly: f.poly }))].filter(p => p.poly.length >= 3), gap);
  floors = carve(floors, floors.filter(p => p.top < Infinity).map(p => ({ poly: p.poly, top: p.top, area: p.area })), { clear, minGap: gap, floor: outOfRoom });
  floors = cutAway(floors, flightFoot, riser);
  floors = carve(floors, flightFoot, { clear, minGap: riser, floor: outOfRoom, keep: slab });
  // a floor kept over stairs with less than clear over them: the drawing asks for both (one note per floor and flight)
  const tight = new Map();
  for (const st of stairFoot) for (const p of floors) {
    if (p.top <= st.top + riser || p.bottom - st.top >= clear - 0.5 || !boxesMeet(box2(p.poly), box2(st.poly)) || !overlap(p.poly, st.poly)) continue;
    const k = `${p.area}\u0001${p.kind}\u0001${p.top}\u0001${st.obj}`, room = p.bottom - st.top;
    if (room < (tight.get(k)?.room ?? Infinity)) tight.set(k, { p, st, room, at: clipConvex(p.poly, st.poly).reduce((m, q, i, a) => [m[0] + q[0] / a.length, m[1] + q[1] / a.length], [0, 0]) });
  }
  for (const { p, st, room, at } of tight.values()) warn(`${p.area}: its ${p.kind} at z${fmt(p.top)} is only ${fmt(room)} over the stairs of ${st.area} near ${fmt(at[0])} ${fmt(at[1])} (${clear} wanted)`);
  // walls give way where floors or flights at least clear below their area's floor run on past both faces (a passage
  // under a tower): there they start at the top of the room under them. Closer below, or only beyond one face (the edge
  // of an area, a flight's side wall), they stand down to the ground.
  const feet = flightFoot.map(f => ({ ...f, flight: true })), walks = [...floors, ...feet];
  // 4 beyond each face of a wall's middle line, at three spots along its overlap with cutter c: where both of those
  // lines run over c, if they do for a wall's thickness (past a slanted edge of c), else along the overlap; null for a
  // sliver at a corner
  const besides = (w, over, c) => {
    const n = [-w.dir[1], w.dir[0]], cen = w.poly.reduce((a, p) => [a[0] + p[0] / w.poly.length, a[1] + p[1] / w.poly.length], [0, 0]), d = o.wallThickness / 2 + 4;
    const at = (s, k) => [cen[0] + w.dir[0] * s + n[0] * k * d, cen[1] + w.dir[1] * s + n[1] * k * d];
    const ext = poly => { const a = poly.map(p => dot(sub(p, cen), w.dir)); return [Math.min(...a), Math.max(...a)]; };
    const probe = k => { const h = rayHits(at(-1e5, k), w.dir, c.poly); return h.length ? [h[0] - 1e5, h.at(-1) - 1e5] : [Infinity, -Infinity]; };
    const [wl, wh] = ext(w.poly), [a1, b1] = probe(1), [a2, b2] = probe(-1), cl = Math.max(a1, a2, wl), ch = Math.min(b1, b2, wh);
    const [lo, hi] = ch - cl >= o.wallThickness ? [cl, ch] : ext(over);
    if (hi - lo < o.wallThickness) return null;
    return [0.2, 0.5, 0.8].flatMap(t => [1, -1].map(k => at(lo + (hi - lo) * t, k)));
  };
  // the cutter's own surface beyond both faces
  const under = (w, c, over) => w.level !== null && !!besides(w, over, c)?.every(q => (c.flight ? feet.some(f => f.obj === c.obj && inside(q, f.poly)) : floors.some(f => Math.abs(f.top - c.top) < 1 && inside(q, f.poly))));
  // some floor or flight at least clear below the wall's level beyond both faces: a room under it
  const overRoom = (w, c, over) => w.level !== null && !!besides(w, over, c)?.every(q => walks.some(x => x.top <= w.level - clear + 0.5 && inside(q, x.poly)));
  // ... and never poke up through a floor, landing or flight of another area running over them, on past both faces,
  // above their foot (an underpass's wall under a tower's stairs): there they are cut from that surface to clear above it
  const walls = cutBand(carve(wallPolys, walks, { clear, minGap: clear, test: overRoom, floor: outOfRoom }).map(w => ({ ...w, foot: footOf(w, floors) })), walks, clear, under, floors);
  // posts and bridges stand only at the heights where both walls they join stand: a wall cut back over a room, or a
  // lower wall beside a taller one, leaves no pillar
  const spans = q => { const out = []; for (const [a, b] of walls.filter(w => Math.min(...w.poly.map((p, i) => segDist(q, p, w.poly[(i + 1) % w.poly.length]))) < 1 || inside(q, w.poly)).map(w => [w.bottom, w.top]).sort((x, y) => x[0] - y[0])) { if (out.length && a <= out.at(-1)[1]) out.at(-1)[1] = Math.max(out.at(-1)[1], b); else out.push([a, b]); } return out; };
  for (const j of joints) { const at = spans(j.to); for (const [a0, a1] of spans(j.p)) for (const [b0, b1] of at) { const lo = Math.max(a0, b0), hi = Math.min(a1, b1); if (hi - lo >= 1) walls.push({ ...j, bottom: lo, top: hi }); } }
  // ---- blocks: solid to their walls' top, cut through where a floor or a flight runs under them ----
  let blocks = [];
  items.forEach((it, k) => {
    if (!it.block || it.role !== 'floor') return;
    const top = (it.z ?? 0) + it.h;
    for (const poly of fillPieces(it.lines.map(l => l.pts))) blocks.push({ poly, top, bottom: base, ground: it.z ?? 0, rank: k, area: it.area, kind: 'block', obj: it.key });
  });
  // (a flight also cuts as drawn, from end line to end line: its steps can stop a hair short of its landing, and the block
  // would stand in that gap from the ground up, a wall across the way)
  const drawn = flights.map(f => ({ poly: ccw(hull(f.edges.flatMap(e => [e.a, e.b]))), top: Math.max(...f.edges.map(e => e.z)), area: f.area }));
  blocks = carve(blocks, [...floors.map(p => ({ poly: p.poly, top: p.top, area: p.area })), ...flightFoot, ...drawn], { clear, minGap: -Infinity, floor: outOfRoom });
  // (and a strip under 3 wide left between parts cut back, two floors drawn a unit apart, starts as low as the lowest part
  // beside it: a sliver against solid mass stays, one between two rooms rises with them)
  const width = p => (2 * Math.abs(area(p.poly))) / p.poly.reduce((m, q, i) => m + len(sub(p.poly[(i + 1) % p.poly.length], q)), 0);
  const near = (a, b) => a[0] <= b[2] + 0.5 && b[0] <= a[2] + 0.5 && a[1] <= b[3] + 0.5 && b[1] <= a[3] + 0.5;
  const touch = (p, q) => near(box2(p.poly), box2(q.poly)) && Math.min(...p.poly.map((a, i) => Math.min(...q.poly.map((b, j) => Math.min(segDist(a, b, q.poly[(j + 1) % q.poly.length]), segDist(b, a, p.poly[(i + 1) % p.poly.length])))))) < 0.5;
  blocks = blocks.map(p => { if (width(p) >= 3) return p; const by = blocks.filter(q => q !== p && width(q) >= 3 && touch(p, q)).map(q => q.bottom); return by.length ? { ...p, bottom: Math.max(p.bottom, Math.min(...by)) } : p; }).filter(p => p.top - p.bottom >= 1);
  // ---- ceilings over roofed areas ----
  // (over its floors, landings and steps, at its room's top: its walls' top, raised to stay clear above a step or
  // landing that climbs higher, so the roof fits the stairs; a floor, flight or block of another area running over it,
  // at least clear above, is its ceiling there)
  const roofs = new Map(items.filter(it => it.roofed).map(it => [it.area, it]));
  const lid = (poly, a, walk) => {
    const lv = levelOf(roofs.get(a)) ?? 0, z = roomTop({ area: a, top: walk });
    return { poly, area: a, level: lv, bottom: z, top: z + o.thickness, obj: `${a} ceiling` };
  };
  // (a step's roof clears every step of its flight it overlaps: curved steps reach a little over their neighbours)
  const stepTop = p => Math.max(...stairFoot.filter(q => q.obj === p.obj && boxesMeet(box2(p.poly), box2(q.poly)) && overlap(p.poly, q.poly)).map(q => q.top), p.top);
  // (a floor or landing's roof leaves out its area's flights standing on it: their steps have their own, fitted roof)
  const bare = p => flightFoot.filter(f => f.area === p.area).reduce((parts, f) => parts.flatMap(r => (overlap(r, f.poly) ? subtractConvex(r, f.poly) : [r])), [p.poly]);
  // (pieces at one height that overlap, a landing drawn over a floor, become one: no two faces fight for one spot)
  const ceilings = capTop(paint([
    ...floorPieces.filter(p => roofs.has(p.area)).flatMap(p => bare(p).map(poly => lid(poly, p.area, p.top))),
    ...stairFoot.filter(p => roofs.has(p.area)).map(p => lid(p.poly, p.area, stepTop(p))),
  ].map((p, k) => ({ ...p, rank: -k })), 1), [...floors, ...feet, ...blocks], clear, (p, c) => c.area !== p.area);
  // ---- pickups: an entity on the floor under the middle of each marker ----
  const entities = [];
  for (const it of items) {
    if (it.role !== 'pickup') continue;
    const pts = it.lines.flatMap(l => l.pts), mx = k => (Math.min(...pts.map(p => p[k])) + Math.max(...pts.map(p => p[k]))) / 2, c = [mx(0), mx(1)];
    const on = floors.filter(p => inside(c, p.poly)).sort((a, b) => b.top - a.top)[0];
    if (!on) { warn(`${it.shape.names.at(-1)} at ${fmt(c[0])} ${fmt(c[1])}: no floor under it, left out`); continue; }
    const cls = `item_${it.pickup === 'ammo' ? 'ammopack' : 'healthkit'}_${it.size}`;
    entities.push({ entity: V.entity(cls, [tidy(c[0]), tidy(c[1]), tidy(on.top)], nextId), area: it.area, kind: 'pickup', obj: it.key });
  }
  // ---- solids ----
  const solids = [], M = o.materials;
  const material = { floor: M.floor, landing: M.floor, wall: M.wall, ceiling: M.roof, block: n => (Math.abs(n[2]) > 0.7 ? M.roof : M.wall) };
  const emit = (p, kind) => {
    // rounding can leave two corners a hair apart (one side face of no width, a duplicate plane for vbsp) or a corner a
    // hair inside the line through its neighbours (a side plane that cuts the brush): simplified, then the hull
    const poly = hull(simplify(p.poly.map(q => [tidy(q[0]), tidy(q[1])]), 0.05));
    // (and a sliver under half a unit wide, a carve's leftover or a hair of overlap in the drawing, is no brush: vbsp
    // cannot bound it)
    if (p.top - p.bottom < 1 || poly.length < 3 || Math.abs(area(poly)) < 1 || narrowest(poly) < 0.5) return;
    const s = V.brush(prism(poly, tidy(p.bottom), tidy(p.top)), material[kind] ?? M.floor, nextId);
    if (V.valid(s)) solids.push({ solid: s, area: p.area, kind, obj: p.obj });
  };
  // ---- thickness: a piece that still reaches the base (nothing under it) stops thickness under the lowest floor or
  // step under it or just past its sides (where no wall or block reaching as low closes them), else thickness under its
  // own level: floors and landings are slabs under their top, walls and blocks reach the lower floor on either side, so
  // they seal both. A piece with nothing past a side (the map's edge, a pit drawn without a floor) stays on the base:
  // the hollow under the slabs stays closed, so the compiler fills it, and a pit's bottom is the sky. A flight's steps
  // are solid down to its foot but func_detail, which closes nothing: a slab under it at its foot (not over a floor or
  // wall under the flight, a passage under a bridge; down to the bottom only where nothing is beside it), and what
  // stands beside it reaches down to that ----
  const th = o.thickness, grounds = [...floors, ...stairFoot.map(s => ({ ...s, top: s.bottom }))].map(s => ({ poly: s.poly, top: s.top, b: box2(s.poly) }));
  const footing = flightFoot.flatMap(f => [...floors, ...walls].filter(g => g.top < f.bottom - 0.5).reduce((parts, g) => parts.flatMap(r => (overlap(r, g.poly) ? subtractConvex(r, g.poly) : [r])), [f.poly]).map(poly => ({ poly, top: f.bottom, bottom: base, area: f.area, kind: 'floor', obj: `${f.obj} base` })));
  const settle = (pieces, own, closers, deep = true) => {
    const shut = closers.map(w => ({ ...w, b: box2(w.poly) })), done = new Map();
    return pieces.map(p => {
      if (p.bottom > base + 0.01) return p;
      if (done.has(p.twin)) return { ...p, bottom: done.get(p.twin), settled: true };
      const b = box2(p.poly);
      let foot = own(p);
      if (deep) for (const g of [...grounds, ...shut]) if (g.top < foot && boxesMeet(b, g.b) && overlap(p.poly, g.poly)) foot = g.top;
      for (const q of [...past(p.poly, 1), ...past(p.poly, 4)]) {
        if (shut.some(w => w.bottom <= Math.min(foot, p.top) - th && onto(q, w))) continue;
        const on = grounds.filter(g => onto(q, g));
        if (!on.length) { foot = -Infinity; break; }
        if (deep) foot = Math.min(foot, ...on.map(g => g.top));
      }
      done.set(p, Math.max(p.bottom, Math.min(foot, p.top) - th));
      return { ...p, bottom: done.get(p), settled: true };
    });
  };
  const wallsOut = merge(settle(merge(walls), p => p.level ?? p.top, walls), true), blocksOut = settle(regroup(blocks, flips), p => p.ground, wallsOut);
  settle(regroup(floors, flips, [...wallsOut, ...blocksOut]), p => p.top, [...wallsOut, ...blocksOut]).forEach(p => emit(p, p.kind));
  settle(regroup(footing, flips), p => p.top, [...wallsOut, ...blocksOut], false).forEach(p => emit(p, p.kind));
  blocksOut.forEach(p => emit(p, 'block'));
  wallsOut.forEach(p => emit(p, 'wall'));
  regroup(ceilings, flips).forEach(p => emit(p, 'ceiling'));
  solids.push(...stairSolids.map(s => ({ ...s, kind: 'stairs' })));
  if (o.gameplay) {
    const g = gameplay({ items, floors, flights, walls, blocks, roomTop, roofs, solids, skyHeight: o.skyHeight, nextId, warn });
    solids.push(...g.solids);
    entities.push(...g.entities);
  }
  const counts = {}, nth = new Map();
  for (const s of [...solids, ...entities]) {
    counts[s.kind] = (counts[s.kind] ?? 0) + 1;
    const n = nth.get(s.obj) ?? 0;
    nth.set(s.obj, n + 1);
    s.key = `${s.obj}#${n}`;
  }
  const areas = new Map();
  for (const it of items) if (!areas.has(it.area)) areas.set(it.area, { name: it.area, z: it.z, count: 0 });
  for (const s of [...solids, ...entities]) (areas.get(s.area) ?? areas.set(s.area, { name: s.area, z: null, count: 0 }).get(s.area)).count++;
  return { solids, entities, areas: [...areas.values()].filter(a => a.count), warnings, counts, offset: [cx, cy], base };
}

// ---------- stair ends ----------
// Every stairs and landing line as an edge { a, b, landing z or null }, paired with the edge across each flight.
// Pairs: parallel lines that overlap, lines meeting at a corner (a winding flight), or lines at an angle that the
// Stairs tool can join; nearest first, one partner per side, the line between their middles crossing no wall and no
// other edge and not running over a floor. An edge's height is the floor on its side away from the partner (a
// landing's own), or, between two flights, the height part way along them.
function pairEdges(items, surfaces, wallLines, warn, clear, gap) {
  let edges = [];
  for (const it of items) {
    if (it.role !== 'stairs' && it.role !== 'ramp' && it.role !== 'landing') continue;
    it.lines.forEach((l, li) => {
      const pts = l.pts, k = l.closed ? pts.length : pts.length - 1;
      for (let i = 0; i < k; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        if (len(sub(b, a)) >= 4) edges.push({ a, b, z: it.role === 'landing' ? it.z : null, landing: it.role === 'landing', ramp: it.role === 'ramp', area: it.area, key: `${it.key}.${li}.${i}` });
      }
    });
  }
  // the same line twice (a landing outline and a stairs line on it): keep one, the landing's height
  const near = (p, q) => len(sub(p, q)) < 3;
  edges = edges.filter((e, i) => !edges.some((f, j) => j !== i && ((near(e.a, f.a) && near(e.b, f.b)) || (near(e.a, f.b) && near(e.b, f.a))) && (f.landing > e.landing || (f.landing === e.landing && j < i))));
  // collinear lines end to end (the two halves of a mirrored flight) become one, and so does a stairs line running on
  // along a landing edge (the landing's, at its height)
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < edges.length && !merged; i++) for (let j = i + 1; j < edges.length && !merged; j++) {
      const e = edges[i], f = edges[j], d = unit(sub(e.b, e.a)), mixed = e.landing !== f.landing;
      if ((!mixed && e.z !== f.z) || Math.abs(cross(d, unit(sub(f.b, f.a)))) > 0.01) continue;
      const off = q => Math.abs(cross(d, sub(q, e.a)));
      if (off(f.a) > 0.5 || off(f.b) > 0.5) continue;
      const tf = [dot(sub(f.a, e.a), d), dot(sub(f.b, e.a), d)].sort((x, y) => x - y), ov = Math.min(len(sub(e.b, e.a)), tf[1]) - Math.max(0, tf[0]);
      if (mixed ? ov <= 1 : !(near(e.a, f.a) || near(e.a, f.b) || near(e.b, f.a) || near(e.b, f.b))) continue;
      const ts = [e.a, e.b, f.a, f.b].map(q => [dot(sub(q, e.a), d), q]).sort((x, y) => x[0] - y[0]);
      edges[i] = { ...(f.landing ? f : e), a: ts[0][1], b: ts[3][1], key: [e.key, f.key].sort().join(' + ') };
      edges.splice(j, 1);
      merged = true;
    }
  }
  const wallSegs = wallLines.flatMap(l => l.pts.map((p, i) => [p, l.pts[(i + 1) % l.pts.length], l.level]).slice(0, l.closed ? l.pts.length : l.pts.length - 1));
  const sideOf = (e, p) => Math.sign(cross(sub(e.b, e.a), sub(p, e.a)));
  // The top of the floor just beside edge e on side `away` (+1 left of a -> b), or null (also where a flight already
  // placed lies there: a floor drawn on under it does not count, unless it is well above or below the flight).
  const placed = []; // { poly, lo, hi: the flight's ends }
  const probe = (e, away) => {
    const n = unit([-(e.b[1] - e.a[1]), e.b[0] - e.a[0]]), m = mid(e.a, e.b);
    for (const dist of [4, 8, 16, 32]) {
      const q = [m[0] + n[0] * away * dist, m[1] + n[1] * away * dist];
      const hits = surfaces.filter(s => inside(q, s.poly)), drawn = drawnOn(hits, e.a, e.b), hit = drawn ?? hits.sort((x, y) => y.rank - x.rank)[0];
      if (placed.some(r => inside(q, r.poly) && !(hit && (hit.top >= r.hi + gap || hit.top <= r.lo - gap)))) return null;
      if (hit) return hit.top;
    }
    return null;
  };
  // an edge with a wall drawn along most of it is closed: no flight crosses it
  edges = edges.filter(e => {
    let n = 0;
    for (let k = 0; k <= 10; k++) { const p = lerp2(e.a, e.b, k / 10); if (wallSegs.some(([c, d]) => segDist(p, c, d) < 2)) n++; }
    if (n <= 5) return true;
    if (!e.landing) { const m = mid(e.a, e.b); warn(`stairs line at ${fmt(m[0])} ${fmt(m[1])} has a wall drawn along it`); }
    return false;
  });
  // ---- candidates ----
  const cands = [];
  for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
    const e = edges[i], f = edges[j], me = mid(e.a, e.b), mf = mid(f.a, f.b), dist = len(sub(mf, me));
    if (dist > 1024 || dist < 2) continue;
    if (e.landing && f.landing && e.z === f.z) continue;
    const de = unit(sub(e.b, e.a)), df = unit(sub(f.b, f.a)), sin = Math.abs(cross(de, df));
    const shared = [e.a, e.b].some(p => near(p, f.a) || near(p, f.b));
    let ok = false;
    if (sin < Math.sin((12 * Math.PI) / 180)) {
      // parallel: they must overlap along their direction and stand apart
      const ta = [dot(sub(f.a, e.a), de), dot(sub(f.b, e.a), de)].sort((x, y) => x - y), le = len(sub(e.b, e.a));
      const ov = Math.min(le, ta[1]) - Math.max(0, ta[0]);
      ok = ov >= 0.3 * Math.min(le, len(sub(f.b, f.a))) && Math.abs(cross(de, sub(f.a, e.a))) >= 2;
    } else if (shared) ok = sin > Math.sin((10 * Math.PI) / 180);
    else {
      const r = buildStairs([[...e.a, 0], [...e.b, 0]], [[...f.a, 64], [...f.b, 64]], { fit: false }, [], 'X', () => '0');
      ok = !r.error && +(r.info.match(/run ([0-9.]+)/)?.[1] ?? Infinity) <= 2.5 * dist;
    }
    if (!ok) continue;
    // the line between their middles (its ends left out: a wall drawn along a stairs line does not count) crosses no
    // other edge, and no wall (checked below, once the heights are known)
    const c0 = lerp2(me, mf, 0.1), c1 = lerp2(me, mf, 0.9), se = sideOf(e, mf), sf = sideOf(f, me);
    if (edges.some((g, k) => k !== i && k !== j && segCross(c0, c1, g.a, g.b))) continue;
    cands.push({ i, j, dist, se, sf, m: mid(me, mf), c0, c1 });
  }
  cands.sort((x, y) => x.dist - y.dist);
  // ---- match: one partner per side, nearest first. The line between the two crosses no wall, except walls of an
  // area at least clear above both ends (they give way over the flight) or below both (they stop under it). It runs
  // over no floor within the flight's heights: a floor well below (as under a bridge) is fine, so is one more than a
  // riser above its high end (a bridge over it), and so is the floor of either end drawn on under the flight (the
  // flight cuts it away) ----
  const used = edges.map(() => new Map()), flights = [];
  for (const c of cands) {
    if (!c.se || !c.sf || used[c.i].has(c.se) || used[c.j].has(c.sf)) continue;
    const e = edges[c.i], f = edges[c.j];
    const ze = e.landing ? e.z : probe(e, -c.se), zf = f.landing ? f.z : probe(f, -c.sf), low = ze === null || zf === null ? -Infinity : Math.min(ze, zf);
    const endFloor = s => low > -Infinity && (Math.abs(s.top - ze) < 0.5 || Math.abs(s.top - zf) < 0.5);
    const hi = low > -Infinity ? Math.max(ze, zf) : Infinity;
    if (wallSegs.some(([p, q, level]) => !(level !== null && (level >= hi + clear || (low > -Infinity && level + 16 <= low))) && segCross(c.c0, c.c1, p, q))) continue;
    if (surfaces.some(s => inside(c.m, s.poly) && s.top > low - clear / 2 && s.top <= hi + STAIRS.step && !endFloor(s))) continue;
    used[c.i].set(c.se, c.j);
    used[c.j].set(c.sf, c.i);
    flights.push(c);
    placed.push({ poly: hull([e.a, e.b, f.a, f.b]), lo: low, hi: low > -Infinity ? Math.max(ze, zf) : Infinity });
  }
  // ---- heights ----
  edges.forEach((e, k) => {
    if (e.landing) return;
    if (used[k].size === 1) e.z = probe(e, -[...used[k].keys()][0]);
  });
  // between two flights: part way, by distance
  for (let pass = 0; pass < 4; pass++) edges.forEach((e, k) => {
    if (e.z !== null || used[k].size !== 2) return;
    const [p, q] = [...used[k].values()].map(j => edges[j]);
    if (p.z === null || q.z === null) return;
    const dp = len(sub(mid(p.a, p.b), mid(e.a, e.b))), dq = len(sub(mid(q.a, q.b), mid(e.a, e.b)));
    e.z = Math.round(p.z + ((q.z - p.z) * dp) / (dp + dq));
  });
  const out = [];
  for (const c of flights) {
    const e = edges[c.i], f = edges[c.j], at = mid(mid(e.a, e.b), mid(f.a, f.b));
    if (e.z === null || f.z === null) { warn(`stairs near ${fmt(at[0])} ${fmt(at[1])}: no floor found at one end`); continue; }
    out.push({ edges: [e, f], ramp: e.ramp || f.ramp, area: e.landing ? f.area : e.area, at, key: [e.key, f.key].sort().join(' to ') });
  }
  edges.forEach((e, k) => { if (!e.landing && !used[k].size) { const m = mid(e.a, e.b); warn(`stairs line at ${fmt(m[0])} ${fmt(m[1])} has no line to pair with`); } });
  return out;
}
