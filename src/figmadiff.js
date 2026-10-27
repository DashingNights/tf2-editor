// Three-way diff for "Update from Figma" (figmaui.js), like a git merge: BASE is what the importer made last time (kept
// in the map's sidecar), THEIRS what it makes from the new SVG, OURS the map now. A unit is one keyed piece of the
// import (figmaimport.js key): a solid, or a gameplay or pickup entity with its solids. Generated output is compared,
// not the SVG, so a change that moves a neighbour's piece shows there too. Pure.
import * as V from '../vmf.js';

const r2 = x => Math.round(x * 100) / 100 || 0; // || 0: no -0
const nums = s => s.replace(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi, m => String(r2(+m)));
// cyrb53: a 53-bit string hash, base 36
function hash(s) {
  let a = 0xdeadbeef, b = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 2654435761); b = Math.imul(b ^ c, 1597334677); }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  return (4294967296 * (2097151 & b) + (a >>> 0)).toString(36);
}

// A solid's face corners (rounded; corners and faces in any order), with each face's material when mat. Texture axes
// are left out: they follow the geometry, and an importer version that lays them out differently made no edit.
const solidText = (s, mat) => V.faces(s).map(f => (mat ? `${(V.get(f.side, 'material') || '').toUpperCase()}:` : '') + f.pts.map(p => p.map(r2).join(' ')).sort().join(',')).sort().join(';');
// An entity: its keyvalues but the id (numbers rounded), its outputs and its solids; never its editor block.
const entText = e => [...e.kv.filter(p => p[0] !== 'id').map(([k, v]) => `${k}=${nums(v)}`), ...V.kids(e, 'connections').flatMap(c => c.kv.map(p => `>${p.join(',')}`)), ...V.kids(e, 'solid').map(s => solidText(s, true))].sort().join('|');
// What the diff compares: geometry, materials and keyvalues.
export const hashNode = n => hash(n.name === 'solid' ? solidText(n, true) : entText(n));
// Geometry only, for matching a map made before keys existed (adopt).
export const shapeHash = n => hash(n.name === 'solid' ? solidText(n, false) : `${V.get(n, 'classname')}|${nums(V.get(n, 'origin') ?? '')}|${V.kids(n, 'solid').map(s => solidText(s, false)).sort().join('|')}`);

// base: Map key -> { h, id, area, kind }; theirs: Map key -> { h, area, kind, ... }; ours(b) -> the hash of base entry
// b's object in the map now, or null when it is gone. Returns rows { key, type, base, theirs, ours } with type:
//   same      theirs == base: the map keeps its own (ours != base: a local edit; ours null: deleted here), or
//             ours == theirs (the same edit on both sides)
//   change    ours == base, theirs != base: an incoming change
//   conflict  ours != base and theirs != base (or one side deleted, the other changed)
//   add       new in theirs; remove: gone from theirs, untouched here; gone: gone from both
// A layer renamed or renumbered (keys change, pieces do not) is no change: a theirs key whose own base differs takes
// over a base entry of its hash whose key changed or went.
export function classify(base, theirs, ours) {
  const loose = new Map(), from = new Map(), used = new Set(), rows = [];
  for (const [k, b] of base) if (theirs.get(k)?.h !== b.h && !loose.has(b.h)) loose.set(b.h, k);
  for (const [k, t] of theirs) if (base.get(k)?.h !== t.h && loose.has(t.h)) { from.set(k, loose.get(t.h)); loose.delete(t.h); }
  const taken = new Set(from.values());
  for (const [key, t] of theirs) {
    const bk = from.get(key) ?? (base.has(key) && !taken.has(key) ? key : null);
    if (bk === null) { rows.push({ key, type: 'add', theirs: t, ours: null }); continue; }
    used.add(bk);
    const b = base.get(bk), o = ours(b);
    rows.push({ key, bk, type: t.h === b.h || t.h === o ? 'same' : o === b.h ? 'change' : 'conflict', base: b, theirs: t, ours: o });
  }
  for (const [bk, b] of base) if (!used.has(bk)) {
    const o = ours(b);
    rows.push({ key: bk, bk, type: o === null ? 'gone' : o === b.h ? 'remove' : 'conflict', base: b, theirs: null, ours: o });
  }
  return rows;
}

// [min, max] of a solid or entity (a point entity: its origin twice).
const boxOf = n => V.boundsOf(n);
const vol = ([a, b]) => (b[0] - a[0]) * (b[1] - a[1]) * (b[2] - a[2]);
// How well two boxes match, 0 to 1: their overlap over their union, both from the higher bottom up (importers differ in
// how far down a piece reaches: to one base under the map, or a slab under its floor); points (no volume) by
// distance, 0 from 64 apart.
function fit(a, b) {
  if (!(vol(a) > 0) || !(vol(b) > 0)) { const d = Math.hypot(...[0, 1, 2].map(k => (a[0][k] + a[1][k] - b[0][k] - b[1][k]) / 2)); return Math.max(0, 1 - d / 64); }
  const z = Math.max(a[0][2], b[0][2]);
  if (z >= Math.min(a[1][2], b[1][2])) return 0;
  [a, b] = [a, b].map(([lo, hi]) => [[lo[0], lo[1], z], hi]);
  const i = [0, 1, 2].map(k => Math.min(a[1][k], b[1][k]) - Math.max(a[0][k], b[0][k]));
  if (!i.every(x => x > 0)) return 0;
  const v = i[0] * i[1] * i[2];
  return v / (vol(a) + vol(b) - v);
}
const sort = n => (n.name === 'solid' ? 'solid' : V.get(n, 'classname'));
// For a map imported before keys existed: which map object each generated unit ({ key, node }) is. The same shape
// first (any map object: it is the import's own piece), then the rest by box overlap (at least min of the union) with
// the loose objects (only those that came from the import: a hand edit moved or reshaped them), best first, one each.
export function match(units, nodes, loose = nodes, min = 0.3) {
  const out = new Map(), free = new Set(nodes);
  let rest = units;
  // (an exact copy first, so of two pieces of one shape the one as imported is taken)
  for (const h of [hashNode, shapeHash]) {
    const by = new Map(), left = [];
    for (const n of nodes) if (free.has(n)) (by.get(h(n)) ?? by.set(h(n), []).get(h(n))).push(n);
    for (const u of rest) {
      const n = by.get(h(u.node))?.find(x => free.has(x) && sort(x) === sort(u.node));
      if (n) { out.set(u.key, n); free.delete(n); } else left.push(u);
    }
    rest = left;
  }
  const cands = new Map();
  for (const n of loose) if (free.has(n)) (cands.get(sort(n)) ?? cands.set(sort(n), []).get(sort(n))).push({ n, b: boxOf(n) });
  const pairs = [];
  for (const u of rest) {
    const b = boxOf(u.node);
    for (const c of cands.get(sort(u.node)) ?? []) { const s = fit(b, c.b); if (s >= min) pairs.push({ u, n: c.n, s }); }
  }
  pairs.sort((p, q) => q.s - p.s);
  for (const p of pairs) if (!out.has(p.u.key) && free.has(p.n)) { out.set(p.u.key, p.n); free.delete(p.n); }
  return out;
}

// The Figma layer a key came from, for the review list: the shape's own layer name ("walls h160 (mirror)"), a flight's
// first stairs or landing layer, a gameplay entity's class.
export function layerOf(key) {
  let k = key.replace(/#\d+$/, '');
  if (k.startsWith('flight ')) k = k.slice(7).split(/ to | \+ /)[0];
  return k.split('/').at(-1).replace(/(\.c?\d+)+$/, '');
}

const KIND = { ceiling: 'roof', stairs: 'stairs piece', sky: 'sky brush', trigger: 'trigger', point: 'entity', spawn: 'spawn point', light: 'light', pickup: 'pickup' };
const size = ([a, b]) => [0, 1, 2].map(k => r2(b[k] - a[k])).join(' x ');
const mid = ([a, b]) => [0, 1, 2].map(k => r2((a[k] + b[k]) / 2));
// One line on what a row changes; ob, tb: the boxes of ours and theirs (or null).
export function describe(row, ob, tb) {
  const u = row.theirs ?? row.base, what = KIND[u.kind] ?? (u.kind ? `${u.kind} piece` : 'object'), at = b => `at ${mid(b).join(' ')}`;
  if (row.type === 'add') return `new ${what} ${vol(tb) > 0 ? `${size(tb)} ` : ''}${at(tb)}`;
  if (!row.theirs) return `${what} removed from the layout${row.type === 'conflict' ? ', edited here' : ''}`;
  if (!ob) return `${what} deleted here, changed in the layout`;
  const d = mid(tb).map((x, k) => r2(x - mid(ob)[k])), moved = d.some(Boolean), resized = size(ob) !== size(tb);
  const text = resized ? `${size(ob)} -> ${size(tb)}${moved ? ` (centre ${d.join(' ')})` : ''}` : moved ? `moved ${d.join(' ')}` : 'changed in place';
  return `${what} ${text}${row.type === 'conflict' ? ', edited here too' : ''}`;
}
