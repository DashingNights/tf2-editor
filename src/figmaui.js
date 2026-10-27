// Figma layout import (figmaimport.js does the geometry): drop an .svg exported from Figma ("Include id attribute")
// on the window, or run "Import Figma layout (SVG)...". The new blockout replaces the last one (everything in the
// "Figma" visgroup) as one undo step. Each floor, landing, block and wall (between corners) is one object, a group
// where it takes several brushes; each flight and each roof is one func_detail; each area is a visgroup inside the
// Figma visgroup.
// "Update from Figma (SVG)..." merges a new export instead: a three-way diff (figmadiff.js) of the base (what the last
// import or update made, per key, in the sidecar: state.extra), the new layout and the map, reviewed in the Figma
// changes panel (figmareview.js) and applied as one undo step. Hand-made objects (no key) are never touched.
import { readSvg } from './svgread.js';
import { importLayout } from './figmaimport.js';
import { hashNode, classify, match, layerOf } from './figmadiff.js';
import * as review from './figmareview.js';
import { bulk } from './mirror.js';
import { doc, cache, objects, nodesOf, setSelection, addObjects, groupEach, groupOf, groups, mergeUndo, nextId, boxOf, edit, extra, editCount, setCursor } from './state.js';
import { visgroups, createVisgroup, deleteVisgroup, assign, vgIds } from './outliner.js';
import { register, run } from './commands.js';
import { ask, notice } from './dialog.js';
import { cfg } from './settings.js';
import * as view3d from './view3d.js';
import * as V from '../vmf.js';

const VG = 'Figma';
const memberOf = (o, ids) => [o, ...V.kids(o, 'solid'), groupOf(o)].filter(Boolean).some(x => vgIds(x).some(id => ids.includes(id)));
// The Figma visgroup and the visgroups inside it (tree order: parents first).
function figmaTree() {
  const all = visgroups(), top = all.find(g => g.name === VG && !g.depth), out = top ? [top] : [];
  for (const g of all) if (g.depth && out.some(p => p.node === g.parent)) out.push(g);
  return out;
}
const byKey = (list, key) => { const m = new Map(); for (const x of list) (m.get(key(x)) ?? m.set(key(x), []).get(key(x))).push(x); return m; };
// a mirrored half shares its area's visgroup; visgroup names cannot hold quotes
const areaName = a => a.replace(/ \(mirror\)$/, '').replace(/"/g, '').trim();
// stairs and roofs go in as func_detail, one per object: they need not seal the map, and kept out of the BSP's
// visibility split the map stays light to draw
const isDetail = s => s.kind === 'stairs' || s.kind === 'ceiling';
const funcDetail = solids => {
  const e = V.entity('func_detail', [0, 0, 0], nextId);
  e.kv = e.kv.filter(([k]) => k !== 'origin');
  e.children.unshift(...solids);
  return e;
};
// Puts top-level objects in their area's visgroup inside the Figma visgroup (areas: Map area -> objects, in Figma's
// order); dropEmpty: areas no longer in the layout lose their visgroup once it is empty.
function intoAreas(areas, dropEmpty) {
  let top = figmaTree()[0]?.id;
  if (!top) { setSelection([]); top = createVisgroup(VG); }
  const kids = () => figmaTree().filter(g => g.depth === 1);
  for (const [area, list] of areas) {
    setSelection(list.flatMap(nodesOf));
    const g = kids().find(k => k.name === area);
    if (g) assign(g.id, true); else createVisgroup(area, top);
  }
  if (dropEmpty) for (const g of kids()) if (!areas.has(g.name) && !objects().some(o => memberOf(o, [g.id]))) deleteVisgroup(g.id);
}
// Merges the undo steps added since editCount() was n0 into one.
const oneStep = n0 => { for (let k = editCount() - n0; k > 1; k--) mergeUndo(); };

// ---------- the base: { svg, offset, zbase, keys: { key: [hash, id, area, kind] } } (id 's<solid id>' / 'e<entity id>') ----------
export const baseOf = () => extra.kv.find(p => p[0] === 'figma')?.[1] ?? null;
const setBase = b => edit([], [extra], () => { extra.kv = [...extra.kv.filter(p => p[0] !== 'figma'), ['figma', b]]; });
const uid = n => (n.name === 'solid' ? 's' : 'e') + V.get(n, 'id');
// The import's units: { key, node, area, kind, obj, detail, h } per keyed solid and entity.
const unitsOf = r => [...r.solids.map(s => ({ ...s, node: s.solid, detail: isDetail(s) })), ...r.entities.map(e => ({ ...e, node: e.entity }))].map(u => ({ ...u, h: hashNode(u.node) }));
const baseFrom = (svg, r, keys) => ({ svg, offset: r.offset, zbase: r.base, keys: Object.fromEntries(keys) });
const entry = (u, n) => [u.key, [u.h, n ? uid(n) : null, areaName(u.area), u.kind]];
// An update keeps the base's offset and floor bottom, so the drawing growing or shrinking moves nothing. Thickness and
// sky height come from Settings: Figma import.
const generate = (text, pin) => importLayout(readSvg(text), { ...(cfg.figma ?? {}), thickness: cfg.figmaThickness, skyHeight: cfg.figmaSkyHeight, ...(pin && { offset: pin.offset, base: pin.zbase }) }, nextId);
// 's<id>' / 'e<id>' -> the map's solid or entity.
function index() {
  const m = new Map();
  for (const c of cache.values()) {
    if (c.node.name === 'solid') m.set('s' + V.get(c.node, 'id'), c.node);
    if (c.owner !== doc.world) m.set('e' + V.get(c.owner, 'id'), c.owner);
  }
  return m;
}

export async function importText(text, name = 'layout.svg') {
  let r;
  try { r = generate(text); } catch (e) { return notice(`Could not read ${name}: ${e.message}`); }
  if (r.error) return notice(`${name}: ${r.error}`);
  if (!r.solids.length) return notice(`${name}: no brushes came out of the layout.\n\n${r.warnings.join('\n')}`);
  // the last import: the Figma visgroups, and what the base names (brush entities of older imports have no visgroup)
  const tree = figmaTree(), keyed = new Set(Object.values(baseOf()?.keys ?? {}).map(v => v[1]));
  const old = objects().filter(o => memberOf(o, tree.map(g => g.id)) || [o, ...V.kids(o, 'solid')].some(x => keyed.has(uid(x))));
  const c = r.counts, parts = ['floor', 'landing', 'stairs', 'wall', 'block', 'ceiling'].filter(k => c[k]).map(k => `${c[k]} ${k}${k === 'stairs' ? '' : ' pieces'}`);
  const order = [...new Set(r.areas.map(a => areaName(a.name)))]; // areas keep their Figma order
  const world = r.solids.filter(s => !isDetail(s));
  const details = [...byKey(r.solids.filter(isDetail), s => s.obj).values()].map(list => ({ entity: funcDetail(list.map(s => s.solid)), area: list[0].area, kind: list[0].kind, obj: list[0].obj }));
  const ents = [...(r.entities ?? []), ...details];
  // world brushes and entities alike: .node is what goes in the map
  const parts2 = [...world.map(s => ({ ...s, node: s.solid })), ...ents.map(e => ({ ...e, node: e.entity }))];
  const objs = byKey(r.solids, s => s.obj), areas = new Map([...byKey(parts2, s => areaName(s.area))].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])));
  const lines = [
    `${name}: ${r.solids.length} brushes (${parts.join(', ')}) in ${objs.size} objects, ${areas.size} areas${c.pickup ? `, ${c.pickup} pickups` : ''}${c.spawn ? `, ${c.spawn} spawn points` : ''}${c.point ? ', the control point' : ''}${c.sky ? ', a sky box' : ''}.`,
    `Heights: ${r.areas.filter(a => !/\(mirror\)$/.test(a.name) && a.z !== null).map(a => `${a.name.replace(/\s*z-?\d+(\.\d+)?/i, '')} ${a.z}`).join(', ')}.`,
    `Floors, landings and roofs are ${cfg.figmaThickness} thick, with a slab under each flight; walls and blocks reach down to the lowest floor beside them, and pieces at the map's edge or beside a gap in the floors down to the bottom of the map${c.sky ? `; the sky is ${cfg.figmaSkyHeight} over the highest brush` : ''} (Settings: Figma import).`,
    ...(r.warnings.length ? [`Notes:\n- ${r.warnings.slice(0, 12).join('\n- ')}${r.warnings.length > 12 ? `\n- and ${r.warnings.length - 12} more` : ''}`] : []),
    old.length ? `This replaces the ${old.length} objects of the last import (the ${VG} visgroup).` : `Each area becomes a visgroup in a new ${VG} visgroup.`,
  ];
  if ((await ask(lines.join('\n\n'), ['Import', 'Cancel'])) !== 0) return;
  // every call below adds undo steps; all of them merge into one
  const n0 = editCount();
  if (old.length) { const pm = parents(); edit([], ancestors(pm, old), () => takeOut(pm, old)); }
  const all = parts2.map(p => p.node);
  addObjects(all); // (not addSolids: blockout mode would retexture the brushes)
  // one group per object of several world brushes, so a click picks one wall or floor (a flight is one func_detail)
  groupEach([...byKey(world, s => s.obj).values()].filter(l => l.length > 1).map(l => l.map(s => s.solid)));
  // one visgroup per area inside the Figma visgroup; emptied visgroups of areas no longer in the layout go
  intoAreas(new Map([...areas].map(([a, l]) => [a, l.map(p => p.node)])), true);
  setBase(baseFrom(name, r, unitsOf(r).map(u => entry(u, u.node))));
  oneStep(n0);
  setSelection(all.flatMap(nodesOf));
  view3d.focus(boxOf(all.flatMap(nodesOf).map(n => cache.get(n)).filter(Boolean)));
}

// ---------- update: diff, review, apply ----------
const CHANGES = new Set(['change', 'conflict', 'add', 'remove']);
// (Re)classifies d against the map as it is now; rows keep their choice while their kind of change stays. The changes
// of one object (a floor, wall, flight...: the key less its #n) are one choice, x.unit: part of its new pieces beside
// part of its old ones would leave holes and overlaps where the pieces are cut differently. One edited here keeps its
// old pieces unless accepted.
export function refresh(d) {
  const idx = index(), was = new Map((d.rows ?? []).map(x => [x.key, x]));
  d.rows = classify(d.baseMap, d.theirs, b => { const n = b.id && idx.get(b.id); return n ? hashNode(n) : null; });
  for (const x of d.rows) {
    const w = was.get(x.key);
    Object.assign(x, { node: (x.base?.id && idx.get(x.base.id)) ?? null, area: areaName((x.theirs ?? x.base).area ?? ''), layer: layerOf(x.key), accept: w?.type === x.type ? w.accept : x.type !== 'conflict' });
  }
  for (const [unit, rows] of byKey(d.rows.filter(x => CHANGES.has(x.type)), x => x.key.replace(/#\d+$/, ''))) {
    if (rows.length < 2) continue;
    const accept = rows.every(x => x.accept);
    for (const x of rows) Object.assign(x, { unit, accept });
  }
  return d;
}
// The diff of the map against a new export: { name, r, base, baseMap, theirs, rows } (figmadiff.classify rows plus
// node: the map's object, area, layer, accept), or { error }.
export function diff(text, name) {
  const b = baseOf();
  if (!b) return { error: 'the map has no Figma base yet (import the layout, or adopt the map as the base)' };
  const r = generate(text, b);
  if (r.error) return r;
  const baseMap = new Map(Object.entries(b.keys).map(([k, [h, id, area, kind]]) => [k, { h, id, area, kind }]));
  return refresh({ name, r, base: b, baseMap, theirs: new Map(unitsOf(r).map(u => [u.key, u])) });
}

// Every solid, entity and hidden block of the map -> the node holding it.
function parents() {
  const m = new Map();
  (function walk(n) { for (const c of n.children) if (/^(world|solid|entity|hidden)$/.test(c.name)) { m.set(c, n); walk(c); } })(doc.root);
  return m;
}
const gidOf = n => V.get(V.kids(n, 'editor')[0] ?? { kv: [] }, 'groupid');
const ancestors = (pm, ns) => [...new Set(ns.flatMap(n => { const a = []; for (let p = pm.get(n); p; p = pm.get(p)) a.push(p); return a; }))];
// Inside edit() with ancestors(pm, nodes) snapshotted: takes nodes out of the map (pm: parents()), with the hidden
// blocks and brush entities they leave empty and the groups they leave without members (hidden ones too, unlike
// deleteSel, which works on the selection).
function takeOut(pm, nodes) {
  const ids = new Set(), cut = n => {
    const p = pm.get(n), l = p.children;
    l.splice(l.indexOf(n), 1);
    ids.add(gidOf(n));
    if ((p.name === 'hidden' && !l.length) || (p.name === 'entity' && !l.some(c => c.name === 'solid' || c.name === 'hidden'))) cut(p);
  };
  nodes.forEach(cut);
  const used = groups();
  doc.world.children = doc.world.children.filter(c => c.name !== 'group' || !ids.has(V.get(c, 'id')) || used.get(V.get(c, 'id'))?.length);
}

// Applies the accepted changes of d as one undo step and makes the new layout the base for every key: a changed piece
// takes the old one's place and editor block (visgroups, group, colour), a removed one goes (with a func_detail or
// group it leaves empty), added ones go in like an import (stairs and roof pieces into their object's func_detail).
export function apply(d) {
  refresh(d); // the map may have changed during the review
  const n0 = editCount(), { world } = doc, take = new Set(d.rows.filter(x => x.accept && CHANGES.has(x.type)));
  const put = [...take].filter(x => x.theirs && x.node), add = [...take].filter(x => x.theirs && !x.node), drop = [...take].filter(x => !x.theirs && x.node);
  const final = x => (take.has(x) ? x.theirs?.node ?? null : x.node); // the node a key ends up with
  // with the live mirror on, RED is rebuilt from BLU afterwards (the update rewrites both halves at once)
  bulk(() => {
    if (put.length || drop.length) {
      const pm = parents();
      edit([], ancestors(pm, [...put, ...drop].map(x => x.node)), () => {
        for (const x of put) {
          const l = pm.get(x.node).children, nu = x.theirs.node, ed = V.kids(x.node, 'editor')[0];
          if (ed) nu.children = [...nu.children.filter(c => c.name !== 'editor'), structuredClone(ed)];
          l.splice(l.indexOf(x.node), 1, nu);
        }
        takeOut(pm, drop.map(x => x.node));
      });
    }
    // stairs and roof pieces join the func_detail their object has in the map, else a new one per object
    const pm = parents(), fds = new Map(), joins = new Map(), fresh = new Map(), objs = [];
    for (const x of d.rows) {
      const n = x.theirs?.detail && final(x), p = n && pm.get(n), e = p?.name === 'hidden' ? pm.get(p) : p;
      if (e?.name === 'entity') fds.set(x.theirs.obj, e);
    }
    for (const { theirs: u } of add) {
      if (!u.detail) objs.push(u.node);
      else if (fds.has(u.obj)) (joins.get(fds.get(u.obj)) ?? joins.set(fds.get(u.obj), []).get(fds.get(u.obj))).push(u.node);
      else (fresh.get(u.obj) ?? fresh.set(u.obj, []).get(u.obj)).push(u);
    }
    const details = [...fresh.values()].map(list => ({ node: funcDetail(list.map(u => u.node)), area: list[0].area }));
    addObjects([...objs, ...details.map(x => x.node)]);
    if (joins.size) edit([], [...joins.keys()], () => { for (const [e, ss] of joins) e.children.splice(e.children.findLastIndex(c => c.name === 'solid' || c.name === 'hidden') + 1, 0, ...ss); });
    // an object of several world brushes that got a new one is one group again
    const grow = new Set(add.filter(x => !x.theirs.detail && x.theirs.node.name === 'solid').map(x => x.theirs.obj));
    groupEach([...grow].map(obj => d.rows.filter(x => x.theirs?.obj === obj).map(final).filter(n => n && cache.get(n)?.owner === world)).filter(l => l.length > 1));
    const tops = [...add.filter(x => !x.theirs.detail).map(x => ({ node: x.theirs.node, area: x.theirs.area })), ...details];
    if (tops.length) intoAreas(new Map([...byKey(tops, t => areaName(t.area))].map(([a, l]) => [a, l.map(t => t.node)])), false);
  });
  const inMap = parents(), kept = x => (inMap.has(final(x)) ? final(x) : null); // (a RED piece the rebuild replaced is gone)
  setBase(baseFrom(d.name, d.r, d.rows.filter(x => x.theirs).map(x => entry(x.theirs, kept(x)))));
  oneStep(n0);
  setSelection([...take].map(kept).filter(Boolean).flatMap(nodesOf));
  const n = t => [...take].filter(x => x.type === t).length;
  setCursor(`Figma update: ${n('change') + n('conflict')} changed, ${n('add')} added, ${n('remove')} removed, ${d.rows.filter(x => CHANGES.has(x.type)).length - take.size} rejected`);
  return { changed: n('change') + n('conflict'), added: n('add'), removed: n('remove') };
}

// Runs the update with the review panel; without a base it offers the adoption first.
export async function update(text, name) {
  if (!baseOf()) {
    if ((await ask(`${name}: this map has no Figma base yet, so there is nothing to compare the new layout with. Adopt the map as it is now as the base first, with the SVG it was imported from?`, ['Adopt...', 'Cancel'])) === 0) run('figma.adopt');
    return;
  }
  let d;
  try { d = diff(text, name); } catch (e) { return notice(`Could not read ${name}: ${e.message}`); }
  if (d.error) return notice(`${name}: ${d.error}`);
  const changes = d.rows.filter(x => CHANGES.has(x.type)).length;
  if (!changes) {
    const renamed = d.rows.some(x => x.type === 'gone' || (x.bk !== undefined && x.bk !== x.key));
    if (renamed) apply(d); // layers renamed: the base follows
    return notice(`${name}: nothing changed against the map's Figma base (${d.rows.filter(x => x.type === 'same').length} pieces).`);
  }
  review.open(d, { apply: () => { apply(d); }, refresh: () => refresh(d) });
}

// ---------- adopting a map imported before keys existed ----------
// Imports the SVG in memory and takes the map's objects that match generated pieces (the same shape, else the best
// box overlap among the Figma visgroups' objects and brush entities without a visgroup) as the base. A matched piece
// whose geometry, materials or keyvalues differ is a local edit; a piece with no match counts as deleted here.
export function adopt(text, name) {
  const r = generate(text);
  if (r.error) return r;
  const us = unitsOf(r), ids = figmaTree().map(g => g.id), nodes = [], loose = [];
  for (const o of objects()) {
    const ss = o.name === 'entity' && V.get(o, 'classname') === 'func_detail' ? nodesOf(o).filter(n => n !== o) : [o];
    nodes.push(...ss);
    if (memberOf(o, ids) || (o.name === 'entity' && V.kids(o, 'solid').length && ![o, ...V.kids(o, 'solid')].some(x => vgIds(x).length))) loose.push(...ss);
  }
  const m = match(us, nodes, loose), matched = new Set(m.values());
  setBase(baseFrom(name, r, us.map(u => entry(u, m.get(u.key)))));
  const same = us.filter(u => m.has(u.key) && hashNode(m.get(u.key)) === u.h).length;
  return { units: us.length, same, local: m.size - same, missing: us.length - m.size, unmatched: loose.filter(n => !matched.has(n)).length };
}

async function pick() {
  const [p] = await api.openFiles([{ name: 'Figma SVG export', extensions: ['svg'] }]);
  if (!p) return null;
  const text = await api.read(p);
  if (text == null) { notice(`Could not read ${p}`); return null; }
  return { text, name: p.split(/[\\/]/).pop() };
}

// A dropped .svg: on a map with a base, update (diff) or replace; else import.
export async function dropped(text, name) {
  if (!baseOf()) return importText(text, name);
  const k = await ask(`${name}: update the map from this layout (review the changes, keep hand edits) or replace the last import with it?`, ['Update (diff)', 'Replace', 'Cancel']);
  if (k === 0) return update(text, name);
  if (k === 1) return importText(text, name);
}

export function mount() {
  review.mount();
  register('figma.import', { title: 'Import Figma layout (SVG)...', run: async () => { const f = await pick(); if (f) await importText(f.text, f.name); } });
  register('figma.update', { title: 'Update from Figma (SVG)...', run: async () => { const f = await pick(); if (f) await update(f.text, f.name); } });
  register('figma.adopt', {
    title: 'Figma: adopt current map as base (SVG it was imported from)...',
    run: async () => {
      const f = await pick();
      if (!f) return;
      let a;
      try { a = adopt(f.text, f.name); } catch (e) { return notice(`Could not read ${f.name}: ${e.message}`); }
      if (a.error) return notice(`${f.name}: ${a.error}`);
      notice(`${f.name} is now the map's Figma base (saved with the map): of ${a.units} generated pieces, ${a.same} match the map exactly, ${a.local} match with local edits (kept on updates), ${a.missing} are not in the map (they count as deleted here). ${a.unmatched} Figma objects matched nothing and count as hand-made from now on.`);
    },
  });
}
