// Live mirror (terrain): while it is on, an edit to a world or func_detail brush on one side of the mirror plane
// rebuilds the brush's twin on the other side as its reflection, in the same undo step (state.js edit hook). Decor
// point entities (DECOR: lights, sprites, prop_static, cubemaps, particles) are mirrored the same way while M.ents is
// on; every other entity (pickups, doors, triggers, spawn rooms, lockers, the control point, logic, prop_dynamic,
// light_environment, overlays) is left to Rebuild RED from BLU (mirrorAll), which rebuilds the other half's from the
// base half's, team swapped; the live mirror never touches them, but for the twin of a decor entity whose class an
// edit changed. A model cannot be reflected, only turned: a twin with a model is moved so its model box is the
// reflection of the source's (fitModel). BLU
// is the base half: the negative side of the plane, or the positive one when the map says so; where both twins change
// in one edit the base one wins. Twins pair by geometry
// (mirrorgeo.js); a brush or entity without a twin first looks for its reflection among the unpaired ones (pairs an
// undo took apart come back). Per-map settings live in the sidecar; hidden brushes and entities are left out.
import * as THREE from 'three';
import * as V from '../vmf.js';
import * as G from './mirrorgeo.js';
import { on, emit } from './bus.js';
import { S, doc, cache, sel, nextId, setEditHook, change, groups, selBox, boxOf, setCursor, sideData, saveSidecar, sideUsers } from './state.js';
import { register } from './commands.js';
import { ask } from './dialog.js';
import * as view2d from './view2d.js';
import * as view3d from './view3d.js';

// on, axis (0: x, 1: y), at (the plane: axis = at), base (-1 | 1: the BLU side), asked ('mirror' | 'keep' | null:
// the answer to the first-time question), ents (decor entities are mirrored too).
const DEFAULT = { on: false, axis: 0, at: 0, base: -1, asked: null, ents: true };
export const M = { ...DEFAULT };
// The point entity classes mirrored with the terrain. prop_dynamic (lockers, the control point model) stays out.
export const DECOR = ['light', 'light_spot', 'light_dynamic', 'point_spotlight', 'env_sprite', 'env_lightglow', 'prop_static', 'env_cubemap', 'info_particle_system'];
// solid or decor entity -> its twin, both ways. Undo and redo do not update it, so only live() pairs count; weak, so
// the entries of nodes gone from the document and the undo history go with them, and an undone delete finds its pair
// again.
let twin = new WeakMap();
let busy = false;
// n -> the world corners of its loaded model box, or null (models.js modelCorners; set by app.js, none in tests).
let corners = () => null;
export const setModelCorners = fn => { corners = fn; };

const clsOf = e => (V.get(e, 'classname') || '').toLowerCase();
const isDetail = e => clsOf(e) === 'func_detail';
const solidBox = s => { const c = cache.get(s); return c ? [c.min, c.max] : V.bounds(V.faces(s)); };
const sideOf = b => G.sideOf(b, M.axis, M.at);
const originOf = e => V.nums(V.get(e, 'origin'));
// The side of a solid or a point entity (0: across the plane, or an origin within 1 unit of it).
const nodeSide = n => (n.name === 'solid' ? sideOf(V.bounds(V.faces(n))) : G.originSide(originOf(n), M.axis, M.at));
const gidOf = o => { const e = V.kids(o, 'editor')[0]; return e && V.get(e, 'groupid'); };
const solidsOf = o => (o.name === 'solid' ? [o] : V.kids(o, 'solid'));
// What a top-level object mirrors as: its solids, or a point entity itself.
const unitsOf = o => (o.name === 'entity' && !V.kids(o, 'solid').length ? [o] : solidsOf(o));
const sameKv = (a, b) => a.length === b.length && a.every((p, i) => p[0] === b[i][0] && p[1] === b[i][1]);
const AX = 'xy';
const editor = () => ({ name: 'editor', kv: [['color', '220 220 220'], ['visgroupshown', '1'], ['visgroupautoshown', '1']], children: [] });
export const statusText = () => (M.on ? `mirror ${AX[M.axis]}=${M.at}` : '');
// The reflection of p across the plane while the mirror is on, else null (disp.js paints the twin with it).
export const mirrorPoint = p => (M.on ? G.reflectPoint(p, M.axis, M.at) : null);
export const twinOf = n => (M.on && live(n, cache)) || null; // outside an edit the cache holds every solid

// Terrain: solids of the world and of func_detail entities (not hidden ones). solid -> its holder (world or entity).
function terrain() {
  const m = new Map();
  for (const s of V.kids(doc.world, 'solid')) m.set(s, doc.world);
  for (const e of V.kids(doc.root, 'entity')) if (isDetail(e)) for (const s of V.kids(e, 'solid')) m.set(s, e);
  return m;
}
// Decor entities: point entities of the DECOR classes at the root (not hidden), while M.ents is on.
const decor = () => new Set(M.ents ? V.kids(doc.root, 'entity').filter(e => DECOR.includes(clsOf(e)) && !V.kids(e, 'solid').length && originOf(e).length === 3) : []);
// Every solid and entity in the document: hidden ones and the solids of other entities too.
function allSolids() {
  const out = new Set();
  (function walk(n) { for (const c of n.children) if (c.name === 'solid') out.add(c); else if (/^(world|entity|hidden)$/.test(c.name)) { if (c.name === 'entity') out.add(c); walk(c); } })(doc.root);
  return out;
}
// x's twin when the pair holds both ways and the twin is in the document (all: allSolids(), or anything with has()).
function live(x, all) { const t = twin.get(x); return t && twin.get(t) === x && all.has(t) ? t : null; }
// x's twin when the pair holds but the twin is out of the document (taken out when x went onto the plane): it goes
// back in when x leaves the plane, so the pair an undo restores stays the same pair.
function dead(x, all) { const t = twin.get(x); return t && twin.get(t) === x && !all.has(t) ? t : null; }

// ---------- keeping twins in step ----------
// What an edit changed, from its snapshots: touched (solids and point entities changed or added; every solid of a
// func_detail whose own keys or editor changed), pre (solid or point entity -> a copy of it as it was, for its side
// ids or origin), the group blocks changed, removed (solids and point entities taken out of a child list: deleted, or
// moved or hidden) and unhid (those whose hidden block went).
function changes(snaps, same) {
  const touched = new Set(), pre = new Map(), blocks = new Set(), removed = new Set(), unhid = new Set();
  const copy = x => ({ name: 'solid', kv: x.kv, children: x.kids.map(k => ({ name: k.n.name, kv: k.kv, children: [] })) });
  const solid = k => { if (!same(k)) { touched.add(k.n); pre.set(k.n, copy(k)); } };
  const point = x => { touched.add(x.n); pre.set(x.n, { name: 'entity', kv: x.kv, children: [] }); };
  const isPoint = n => n.name === 'entity' && !V.kids(n, 'solid').length;
  const inside = o => (o.name === 'hidden' ? o.children.flatMap(inside) : unitsOf(o));
  const left = (n, olds) => { const now = new Set(n.children); for (const o of olds) if (!now.has(o)) inside(o).forEach(s => (o.name === 'hidden' ? unhid : removed).add(s)); };
  for (const x of snaps) {
    const n = x.n;
    if (x.deep && n.name === 'solid') solid(x);
    else if (x.deep && n.name === 'entity') {
      let own = !sameKv(x.kv, n.kv) || x.kids.length !== n.children.length || x.kids.some((k, i) => k.n !== n.children[i]);
      for (const k of x.kids) if (k.n.name === 'solid') solid(k); else own ||= !same(k);
      if (own) (isPoint(n) ? point(x) : V.kids(n, 'solid').forEach(s => touched.add(s)));
      left(n, x.kids.map(k => k.n));
    } else if (x.deep && n.name === 'group') { if (!same(x)) blocks.add(n); }
    else if (!x.deep && n.name === 'connections') { // outputs edited in Details: the entity holding them
      const e = !same(x) && V.kids(doc.root, 'entity').find(o => o.children.includes(n));
      if (e && isPoint(e)) touched.add(e);
    } else if (!x.deep) {
      const old = new Set(x.kids.map(k => k.n));
      for (const c of n.children) if (!old.has(c) && (c.name === 'entity' || c.name === 'solid')) unitsOf(c).forEach(s => touched.add(s));
      if (isPoint(n) && !same(x)) point(x);
      else if (n.name === 'entity' && !sameKv(x.kv, n.kv)) V.kids(n, 'solid').forEach(s => touched.add(s));
      left(n, old);
    }
  }
  return { touched, pre, blocks, removed, unhid };
}

// Sources whose twin changed too: the base side's wins.
function winners(touched, all) {
  const base = s => nodeSide(s) === M.base;
  return [...touched].filter(x => { const p = live(x, all); return !(p && touched.has(p) && base(p) && !base(x)); });
}

// Rebuilds the twin of each source (solid or decor entity) as its reflection (where it has none: the unpaired one that
// is its reflection, else a new one; a source across the plane loses its twin), removes the twins of the removed ones
// (gone from the document) and those in drop, and keeps the twins' func_detail, group and visgroups those of the
// source's counterparts. take: state.js snapshots, taken before a node changes. pre: source -> copy from before the
// edit. blocks: group blocks whose editor changed (visgroups). Overlays on a removed twin's faces move to the new twins'.
function apply(sources, take, { pre = new Map(), drop = [], blocks = [], removed = [] } = {}) {
  const { world, root } = doc, T = terrain(), D = decor(), all = allSolids(), ax = M.axis, c = M.at;
  const emptied = new Set(), oldGids = new Set(), groupMemo = new Map(), entMemo = new Map(), srcSet = new Set(sources);
  const gone = [], made = [];
  let members = null, cands = null, ents = null;
  const topOf = (s, h) => (h === world ? s : h);
  const topTwin = p => (T.has(p) ? topOf(p, T.get(p)) : D.has(p) ? p : null); // the object holding twin p, if mirrored
  const note = s => { const h = T.get(s); if (h) oldGids.add(gidOf(topOf(s, h))); };
  const unlink = s => {
    const h = T.get(s);
    note(s);
    take(h, false);
    h.children.splice(h.children.indexOf(s), 1);
    T.delete(s);
    if (h !== world) emptied.add(h);
  };
  // the group the twins of group g's members are in: one group holding all of them and no twin of anything else; else
  // a new group block with g's visgroups
  const groupTwin = (g, make = true) => {
    if (!g) return null;
    if (groupMemo.has(g)) return groupMemo.get(g);
    members ??= groups();
    const mine = members.get(g) ?? [], units = new Set(mine.flatMap(unitsOf)), tops = new Set();
    for (const s of units) { const o = twin.get(s) && topTwin(twin.get(s)); if (o) tops.add(o); }
    const ids = new Set([...tops].map(gidOf));
    let h = ids.size === 1 ? [...ids][0] : null;
    if (h && (members.get(h) ?? []).some(o => unitsOf(o).some(s => { const p = twin.get(s); return p && topTwin(p) && !units.has(p); }))) h = null;
    if (!h && !make) return null;
    if (!h) {
      const blk = V.kids(world, 'group').find(b => V.get(b, 'id') === g);
      h = nextId();
      take(world, false);
      world.children.push({ name: 'group', kv: [['id', h]], children: blk ? structuredClone(V.kids(blk, 'editor')) : [editor()] });
    }
    groupMemo.set(g, h);
    return h;
  };
  const setGid = (o, id) => {
    let e = V.kids(o, 'editor')[0];
    if (!e) { if (!id) return; o.children.push((e = editor())); }
    e.kv = e.kv.filter(p => p[0] !== 'groupid');
    if (id) e.kv.splice(e.kv.findIndex(p => p[0] === 'color') + 1, 0, ['groupid', id]);
  };
  // the func_detail for the twins of func_detail e's solids: the one holding most of their twins, else a new one
  const detailTwin = e => {
    if (entMemo.has(e)) return entMemo.get(e);
    const votes = new Map();
    for (const s of V.kids(e, 'solid')) { const h = T.get(twin.get(s)); if (h && h !== world) votes.set(h, (votes.get(h) ?? 0) + 1); }
    let best = null;
    for (const [h, k] of votes) if (!best || k > votes.get(best)) best = h;
    if (!best) {
      take(root, false);
      best = { name: 'entity', kv: e.kv.map(p => (p[0] === 'id' ? ['id', nextId()] : [...p])), children: [] };
      root.children.splice(root.children.indexOf(e) + 1, 0, best);
    }
    entMemo.set(e, best);
    return best;
  };
  // a func_detail twin gets e's keys and editor block (its group mapped)
  const syncEntity = (t, e) => {
    if (t === e) return;
    const kv = e.kv.map(p => (p[0] === 'id' ? ['id', V.get(t, 'id')] : [...p])), ed = structuredClone(V.kids(e, 'editor')[0] ?? null);
    if (ed) setGid({ children: [ed] }, groupTwin(gidOf(e)));
    const old = V.kids(t, 'editor')[0];
    if (sameKv(kv, t.kv) && JSON.stringify(old ?? null) === JSON.stringify(ed)) return;
    oldGids.add(gidOf(t));
    take(t, false);
    t.kv = kv;
    t.children = t.children.filter(x => x.name !== 'editor');
    if (ed) t.children.push(ed);
  };
  // where t goes (want) and its group (gid), worked out before the twins change
  const place = (t, x, want, gid) => {
    const hx = T.get(x), ht = T.get(t);
    if (ht !== want) {
      if (ht) unlink(t);
      take(want, false);
      want.children.splice(want.children.findLastIndex(n => n.name === 'solid' || n.name === 'hidden') + 1, 0, t);
      T.set(t, want);
    }
    setGid(t, gid);
    if (want !== world) syncEntity(want, hx);
  };

  // the unpaired terrain brush that is x's reflection, as x was before the edit or as it is now (one across the plane
  // is no twin)
  const box = s => (pre.has(s) ? V.bounds(V.faces(s)) : solidBox(s));
  const findTwin = x => {
    cands ??= [...T.keys()].filter(s => !srcSet.has(s) && !live(s, all) && sideOf(solidBox(s)));
    for (const a of new Set([pre.get(x) ?? x, x])) {
      const t = G.pairUp([a], cands, ax, c, box).get(a);
      if (t) return cands.splice(cands.indexOf(t), 1)[0];
    }
    return null;
  };

  // decor entities: the unpaired one that is x's reflection (as x was or is; not one on the plane); out takes twin t
  // out of the map
  const findEnt = x => {
    ents ??= [...D].filter(e => !srcSet.has(e) && !live(e, all) && G.originSide(originOf(e), ax, c));
    for (const a of new Set([pre.get(x) ?? x, x])) {
      const t = G.pairEnts([a], ents, ax, c).get(a);
      if (t) return ents.splice(ents.indexOf(t), 1)[0];
    }
    return null;
  };
  const out = t => { oldGids.add(gidOf(t)); take(root, false); root.children.splice(root.children.indexOf(t), 1); D.delete(t); };
  // env_cubemap sides: the twin faces of terrain faces that have twins, the rest dropped
  let faceOf = null;
  const twinSides = v => {
    if (!faceOf) { faceOf = new Map(); for (const s of T.keys()) for (const f of V.kids(s, 'side')) faceOf.set(V.get(f, 'id'), s); }
    const memo = new Map(), ids = v.split(/\s+/).filter(Boolean).map(id => {
      const s = faceOf.get(id), t = s && live(s, T); // T: twins made above count
      if (!t) return null;
      if (!memo.has(s)) memo.set(s, G.sidePairs(s, t, ax, c));
      return memo.get(s).get(id);
    });
    return ids.filter(Boolean).join(' ');
  };

  for (const s of drop) if (T.has(s)) { gone.push(s); unlink(s); } else if (D.has(s)) out(s);
  for (const r of removed) {
    const t = live(r, all);
    if (!t || srcSet.has(t)) continue;
    if (T.has(t)) { gone.push(t); unlink(t); } else if (D.has(t)) out(t);
  }
  for (const x of sources) {
    if (!T.has(x)) continue;
    let t = live(x, all);
    if (t && !T.has(t)) continue; // the twin is hidden or no longer terrain: the pair is left alone
    if (!sideOf(V.bounds(V.faces(x)))) { // across the plane: its own mirror (the pair stays, for an undo)
      if (t) unlink(t);
      continue;
    }
    t ??= findTwin(x) ?? dead(x, all);
    const fresh = G.reflect(x, ax, c), hx = T.get(x), want = hx === world ? world : detailTwin(hx), gid = groupTwin(gidOf(x));
    if (t) {
      note(t);
      take(t, true);
      G.adopt(t, fresh, G.sidePairs(pre.get(x) ?? x, pre.get(t) ?? t, ax, c), nextId);
    } else made.push((t = V.clone(fresh, nextId)));
    twin.set(x, t).set(t, x);
    place(t, x, want, gid);
  }
  // a visible point entity of any class: one of a pair whose class left DECOR (Details) passes the change to the other
  // once, then neither is mirrored
  const point = e => e.name === 'entity' && !V.kids(e, 'solid').length && originOf(e).length === 3 && root.children.includes(e);
  for (const x of sources) { // decor entities, after the terrain: an env_cubemap names its twins' faces
    let t = live(x, all);
    if (!D.has(x) && !(D.has(t) && point(x))) continue;
    if (t && !D.has(t) && !point(t)) continue; // the twin is hidden: the pair is left alone
    if (!G.originSide(originOf(x), ax, c)) { // on the plane: its own mirror (the pair stays, for an undo)
      if (t) out(t);
      continue;
    }
    t ??= findEnt(x) ?? dead(x, all);
    const fresh = fitModel(x, G.reflectEntity(x, ax, c));
    for (const p of fresh.kv) if (/^sides$/i.test(p[0])) p[1] = twinSides(p[1]);
    setGid(fresh, groupTwin(gidOf(x)));
    if (t) {
      const kv = fresh.kv.map(p => (p[0] === 'id' ? ['id', V.get(t, 'id')] : p));
      if (JSON.stringify([kv, fresh.children]) !== JSON.stringify([t.kv, t.children])) {
        oldGids.add(gidOf(t));
        take(t, true);
        [t.kv, t.children] = [kv, fresh.children];
      }
    } else t = V.clone(fresh, nextId);
    if (!all.has(t)) {
      take(root, false);
      root.children.splice(root.children.findLastIndex(n => /^(world|entity|hidden)$/.test(n.name)) + 1, 0, t);
      D.add(t);
    }
    twin.set(x, t).set(t, x);
  }
  if (gone.length && made.length) { // overlays (info_overlay, env_cubemap) on a removed twin's faces go to the new twins'
    const ids = new Map(gone.flatMap(g => V.kids(g, 'side').map(s => [V.get(s, 'id'), []]))), users = sideUsers(ids);
    if (users.length) {
      const named = new Set(users.flatMap(e => e.kv.filter(p => /^sides2?$/i.test(p[0])).flatMap(p => p[1].split(/\s+/))));
      for (const g of gone) if (V.kids(g, 'side').some(s => named.has(V.get(s, 'id')))) for (const m of made) for (const [a, b] of G.sharedSides(g, m)) ids.get(a).push(...b);
      for (const [k, v] of ids) if (!v.length) ids.delete(k); // a face with no piece keeps its id, as on a delete
      for (const e of users) { take(e, false); V.remapSides(e, ids); }
    }
  }
  for (const b of blocks) {
    const g = V.get(b, 'id'), h = groupTwin(g, false), hb = V.kids(world, 'group').find(x => V.get(x, 'id') === h);
    if (!hb || hb === b) continue;
    const ed = structuredClone(V.kids(b, 'editor'));
    if (JSON.stringify(V.kids(hb, 'editor')) === JSON.stringify(ed)) continue;
    take(hb, false);
    hb.children = [...hb.children.filter(x => x.name !== 'editor'), ...ed];
  }
  for (const e of emptied) if (!e.children.some(x => x.name === 'solid' || x.name === 'hidden') && root.children.includes(e)) {
    oldGids.add(gidOf(e));
    take(root, false);
    root.children.splice(root.children.indexOf(e), 1);
  }
  oldGids.delete(undefined);
  if (oldGids.size) {
    const used = groups(), empty = [...oldGids].filter(id => !used.get(id)?.length);
    if (empty.length) { take(world, false); world.children = world.children.filter(x => x.name !== 'group' || !empty.includes(V.get(x, 'id'))); }
  }
}

// Unpaired solids (and decor entities, apart) an edit added or changed on both halves (a Figma import, a paste of both
// halves): they pair up where one is the other's reflection, and the rest get no twin, so nothing is doubled.
function pairNew(touched, all) {
  const T = terrain(), D = decor();
  for (const [has, pair] of [[s => T.has(s), G.pairUp], [s => D.has(s), G.pairEnts]]) {
    const loose = [...touched].filter(s => has(s) && !live(s, all)), side = new Map(loose.map(s => [s, nodeSide(s)]));
    const a = loose.filter(s => side.get(s) === M.base), b = loose.filter(s => side.get(s) === -M.base);
    if (!a.length || !b.length) continue;
    const p = pair(a, b, M.axis, M.at), keep = new Set([...p.keys(), ...p.values()]);
    for (const [x, y] of p) twin.set(x, y).set(y, x);
    touched = new Set([...touched].filter(s => !loose.includes(s) || keep.has(s)));
  }
  return touched;
}

setEditHook((snaps, take, same) => {
  if (!M.on || busy) return;
  const { touched, pre, blocks, removed, unhid } = changes(snaps, same), all = allSolids();
  // an unhidden brush or entity is no edit: its visible twin (maybe edited while it was hidden) is mirrored onto it
  for (const s of unhid) { touched.delete(s); const p = live(s, all); if (p && !unhid.has(p)) touched.add(p); }
  apply(winners(pairNew(touched, all), all), take, { pre, blocks: [...blocks], removed: [...removed].filter(s => !all.has(s)) });
});

// t, the reflection of x, with its model where x's model is reflected: an arrow model upside down (its arrow then
// points the reflected way), and moved so the model box's centre is the reflection of x's (a model whose origin is off
// its centre would land elsewhere). Without a loaded model only the arrow turn.
const mid = cs => [0, 1, 2].map(k => cs.reduce((s, p) => s + p[k], 0) / cs.length);
function fitModel(x, t) {
  if (G.isArrow(x) && V.get(t, 'angles') !== undefined) V.set(t, 'angles', G.flipRoll(V.get(t, 'angles')));
  const a = corners(x), b = a && corners(t);
  if (!b) return t;
  const want = G.reflectPoint(mid(a), M.axis, M.at), d = want.map((v, k) => v - mid(b)[k]);
  // under a unit off: the plain reflection stays (whole numbers stay whole)
  if (Math.hypot(...d) >= 1) V.set(t, 'origin', originOf(t).map((v, k) => String(Math.round((v + d[k]) * 1000) / 1000)).join(' '));
  return t;
}

// ---------- gameplay entities: Rebuild RED from BLU ----------
// The entities on a half that are neither terrain nor decor: pickups, spawn points, spawn rooms, doors and their
// triggers, resupply lockers, other brush and point entities. Hidden ones, overlays and the map's one-of-a-kind
// entities (game rules, KOTH logic, the control point master, light_environment) stay out.
const ONCE = /^(func_detail|info_overlay|info_overlay_accessor|tf_gamerules|tf_logic_|team_control_point_master|team_round_timer|logic_auto|light_environment|env_sun|env_fog_controller|env_tonemap_controller|shadow_control|water_lod_control|sky_camera)/;
export function gameplay() {
  const out = { base: [], other: [] };
  for (const e of V.kids(doc.root, 'entity')) {
    const k = clsOf(e);
    if (ONCE.test(k) || DECOR.includes(k)) continue;
    const ss = V.kids(e, 'solid'), o = originOf(e);
    const side = ss.length ? sideOf(V.bounds(ss.flatMap(V.faces))) : o.length === 3 ? G.originSide(o, M.axis, M.at) : 0;
    if (side) out[side === M.base ? 'base' : 'other'].push(e);
  }
  return out;
}
// The other half's gameplay entities replaced by the base half's reflected and team swapped (new ids, no group);
// nothing changes while the base half has none.
function rebuildGameplay(take) {
  const { base, other } = gameplay(), root = doc.root;
  if (!base.length) return;
  const made = base.map(e => {
    const r = fitModel(e, G.swapTeam(G.reflectEntity(e, M.axis, M.at)));
    r.children = r.children.map((ch, i) => (ch.name === 'solid' ? G.reflect(e.children[i], M.axis, M.at) : ch));
    for (const ed of V.kids(r, 'editor')) ed.kv = ed.kv.filter(p => p[0] !== 'groupid');
    return V.clone(r, nextId);
  });
  take(root, false);
  root.children = root.children.filter(n => !other.includes(n));
  root.children.splice(root.children.findLastIndex(n => /^(world|entity|hidden)$/.test(n.name)) + 1, 0, ...made);
}

// ---------- pairing, BLU to RED, mirror now ----------
// The terrain solids wholly on each side of the plane: { base, other, across }; ents: the decor entities the same way
// (across: on the plane).
export function halves(ents = false) {
  const out = { base: [], other: [], across: [] };
  for (const s of ents ? decor() : terrain().keys()) { const k = ents ? nodeSide(s) : sideOf(solidBox(s)); out[k === M.base ? 'base' : k ? 'other' : 'across'].push(s); }
  return out;
}
const linked = () => `${halves().base.filter(s => live(s, cache)).length} brush pairs${M.ents ? `, ${halves(true).base.filter(s => live(s, cache)).length} entity pairs` : ''}`;
// Pairs the halves by geometry (a brush with its reflection, a decor entity with the one of its class at its
// reflected origin). Returns the number of brush pairs.
export function link() {
  const { base, other } = halves(), p = G.pairUp(base, other, M.axis, M.at, solidBox), e = halves(true);
  twin = new WeakMap();
  for (const [a, b] of [...p, ...G.pairEnts(e.base, e.other, M.axis, M.at)]) twin.set(a, b).set(b, a);
  return p.size;
}
const run = fn => change(take => { busy = true; try { fn(take); } finally { busy = false; } });
// Rebuilds the other half's terrain, decor and gameplay entities as the reflection of the base half's, as one undo
// step: paired terrain and decor keep their ids, the rest of the other half goes, every base brush or decor entity
// without a twin gets one; the gameplay entities are made again, team swapped. Brushes across the plane and entities
// on it stay. ents false: the terrain only.
export function mirrorAll(ents = true) {
  link();
  const { base, other } = halves(), e = ents ? halves(true) : { base: [], other: [] };
  run(take => {
    apply([...base, ...e.base], take, { drop: [...other, ...e.other].filter(s => !twin.has(s)) });
    if (ents) rebuildGameplay(take);
  });
}
// An edit that rewrites both halves at once (a Figma update): the live mirror stays out of it, then the other half's
// terrain is rebuilt from the base half, as Mirror BLU to RED does. Decor entities are left as they are (Figma writes
// both halves of its lights, not quite symmetric). Two undo steps; the caller joins them.
export function bulk(fn) {
  if (!M.on) return fn();
  busy = true;
  try { fn(); } finally { busy = false; }
  mirrorAll(false);
}
// Creates or updates the twins of the selected terrain brushes and decor entities (one undo step). With the live
// mirror off the pairs are found again first: nothing keeps them current while it is off.
export function mirrorSelection() {
  if (!M.on) link();
  run(take => apply(winners(new Set(mirrored(sel)), allSolids()), take));
}

// ---------- on / off, settings ----------
// The first-time answer as the saved map knows it: 'keep' counts at once, 'mirror' (a change to the map) once the map
// is saved, so a discarded BLU to RED asks again on the next open (the sidecar keeps the mirror off until then).
let saved = null;
function changed() {
  sideData.mirror = { ...M, asked: saved, on: M.on && M.asked === saved };
  saveSidecar();
  emit('mirror', M);
  drawPlane();
  if (mounted) view2d.invalidate();
}
const half = sgn => `${AX[M.axis]} ${sgn < 0 ? '<' : '>'} ${M.at}`;
// On: the first time for a map asks whether to rebuild RED from BLU or keep RED and link the halves as they are.
export async function toggle() {
  if (M.on) { M.on = false; changed(); return setCursor('mirror off'); }
  let r = 1;
  if (!M.asked) {
    const h = halves(), e = halves(true);
    const g = gameplay(), play = `The ${g.base.length} BLU gameplay entities (spawn rooms, doors and their triggers, resupply lockers, pickups, spawn points) replace the ${g.other.length} RED ones, reflected and team swapped (TeamNum, blu/red in names and outputs).`;
    const ents = M.ents ? `${e.base.length} BLU decor entities (lights, sprites, prop_static, cubemaps, particles) will be mirrored onto RED the same way, replacing the ${e.other.length} RED ones; ${e.across.length} on the plane stay. ${play}` : play;
    r = await ask(`Mirror the existing BLU half onto RED now?\n\n${h.base.length} BLU terrain brushes (${half(M.base)}) will be mirrored onto RED, and the ${h.other.length} RED terrain brushes (${half(-M.base)}) will be replaced by their reflections, as one undo step. ${h.across.length} brushes across the plane stay as they are. ${ents}\n\nKeep RED: the halves are linked as they are. Brushes and entities that already match their reflection are paired; after that an edit on either side updates the other.`,
      ['Mirror BLU to RED', 'Keep RED, just link the halves', 'Cancel']);
    if (r === 2) return;
    M.asked = r === 0 ? 'mirror' : 'keep';
    if (r === 1) saved = 'keep';
  }
  M.on = true;
  if (r === 0) mirrorAll(); else link();
  changed();
  setCursor(`mirror on: ${linked()} linked`);
}

// Decor entities on or off (the pairs are found again).
export function toggleEnts() {
  M.ents = !M.ents;
  if (M.on) link();
  changed();
  setCursor(`mirror: decor entities ${M.ents ? 'on' : 'off'}${M.on ? `, ${linked()} linked` : ''}`);
}

function setPlane(axis, at) {
  Object.assign(M, { axis, at: Math.round(at * 1000) / 1000 });
  if (M.on) link();
  changed();
  setCursor(`mirror plane ${AX[axis]} = ${M.at}${M.on ? `: ${linked()} linked` : ''}`);
}

on('file', e => {
  if (e.op === 'load') { Object.assign(M, DEFAULT); saved = null; twin = new WeakMap(); drawPlane(); emit('mirror', M); }
  if (e.op === 'save' && saved !== M.asked) { saved = M.asked; changed(); }
});
on('sidecar', () => {
  const d = sideData.mirror;
  if (!d) return;
  Object.assign(M, DEFAULT, d);
  saved = M.asked;
  if (M.on) link();
  emit('mirror', M);
  drawPlane();
  if (mounted) view2d.invalidate();
});

// ---------- drawing: the plane (3D and 2D), the twins of a drag ----------
const planeMat = new THREE.MeshBasicMaterial({ color: 0xc070ff, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false });
const sheet = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), planeMat);
const ghost = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xc070ff, transparent: true, opacity: 0.9, depthTest: false }));
sheet.renderOrder = 2;
ghost.renderOrder = 3;
ghost.matrixAutoUpdate = false;
ghost.frustumCulled = false;
let mounted = false, sheetShown = false, ghostShown = false, ghostOf = [];

function drawPlane() {
  if (!mounted) return;
  const es = [...cache.values()];
  if (M.on && es.length) {
    const [mn, mx] = boxOf(es), mid = mn.map((x, k) => (x + mx[k]) / 2), o = 1 - M.axis;
    sheet.position.set(...mid.map((x, k) => (k === M.axis ? M.at : x)));
    sheet.rotation.set(M.axis === 1 ? Math.PI / 2 : 0, M.axis === 0 ? Math.PI / 2 : 0, 0);
    sheet.scale.set(...(M.axis === 0 ? [mx[2] - mn[2] + 512, mx[o] - mn[o] + 512, 1] : [mx[o] - mn[o] + 512, mx[2] - mn[2] + 512, 1]));
  }
  if (M.on !== sheetShown) (sheetShown = M.on) ? view3d.addHelper(sheet) : view3d.removeHelper(sheet);
  else view3d.invalidate();
}

// The terrain brushes and decor entities of ns.
const mirrored = ns => { const T = terrain(), D = decor(); return [...ns].filter(n => T.has(n) || D.has(n)); };
// The selected ones a drag would mirror (at most 400; an entity's ghost is its box).
const dragged = () => mirrored(sel).slice(0, 400);
// The drag preview as a Matrix4 (affine; from view2d's point function).
function previewMatrix(xf) {
  const f = view2d.previewFn(xf), o = f([0, 0, 0]), e = [0, 1, 2].map(k => f([0, 1, 2].map(i => +(i === k))).map((x, i) => x - o[i]));
  return new THREE.Matrix4().set(e[0][0], e[1][0], e[2][0], o[0], e[0][1], e[1][1], e[2][1], o[1], e[0][2], e[1][2], e[2][2], o[2], 0, 0, 0, 1);
}
function drawGhost() {
  const show = M.on && !!S.preview;
  if (show) {
    const ns = dragged();
    if (ns.length !== ghostOf.length || ns.some((n, i) => n !== ghostOf[i])) {
      ghostOf = ns;
      const pts = ns.flatMap(n => (cache.get(n)?.faces ?? []).flatMap(f => f.pts.flatMap((p, i) => [...p, ...f.pts[(i + 1) % f.pts.length]])));
      ghost.geometry.dispose();
      ghost.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    }
    const R = new THREE.Matrix4().makeScale(...[0, 1, 2].map(k => (k === M.axis ? -1 : 1))).setPosition(...[0, 1, 2].map(k => (k === M.axis ? 2 * M.at : 0)));
    ghost.matrix.copy(R.multiply(previewMatrix(S.preview)));
    ghost.matrixWorldNeedsUpdate = true;
  } else ghostOf = [];
  if (show !== ghostShown) (ghostShown = show) ? view3d.addHelper(ghost) : view3d.removeHelper(ghost);
  else view3d.invalidate();
}

function overlay(ctx, v, { s2, toScreen, previewFn }) {
  if (!M.on) return;
  const [i, j] = v.ax, a = M.axis;
  ctx.strokeStyle = '#c070ff';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([10, 5]);
  ctx.beginPath();
  if (i === a) { const x = s2(v, M.at, 0)[0]; ctx.moveTo(x, 0); ctx.lineTo(x, v.h); }
  else if (j === a) { const y = s2(v, 0, M.at)[1]; ctx.moveTo(0, y); ctx.lineTo(v.w, y); }
  ctx.stroke();
  ctx.setLineDash([]);
  if (!S.preview) return;
  const f = previewFn(S.preview);
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const n of dragged()) for (const fc of cache.get(n)?.faces ?? []) fc.pts.forEach((p, k) => {
    const [x, y] = toScreen(v, G.reflectPoint(f(p), a, M.at));
    k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
}

export function mount() {
  mounted = true;
  view2d.registerOverlay(overlay);
  on('preview', () => { drawGhost(); if (M.on) view2d.invalidate(); });
  on('doc', () => { if (M.on) drawPlane(); });
  register('mirror.toggle', { title: 'Mirror: live mirror on/off (terrain and decor entities; BLU is the base half)', keys: ['ctrl+shift+m'], run: toggle, on: () => M.on });
  register('mirror.fromSelection', { title: 'Mirror: plane through the selection centre', when: () => !!selBox(), run: () => { const b = selBox(); setPlane(M.axis, (b[0][M.axis] + b[1][M.axis]) / 2); } });
  register('mirror.axis', { title: 'Mirror: switch the axis (X / Y)', run: () => setPlane(1 - M.axis, M.at) });
  register('mirror.base', { title: 'Mirror: switch the base (BLU) half to the other side', run: () => { M.base = -M.base; changed(); setCursor(`mirror: BLU is the half at ${half(M.base)}`); } });
  register('mirror.selection', { title: 'Mirror: mirror the selection now (create or update its twins)', when: () => sel.size > 0, run: mirrorSelection });
  register('mirror.blueToRed', { title: 'Mirror: rebuild RED from BLU now: terrain, decor, spawn rooms, doors, pickups (one undo step)', run: () => { mirrorAll(); setCursor(`mirror: RED rebuilt from BLU, ${linked()}, ${gameplay().other.length} gameplay entities`); } });
  register('mirror.ents', { title: 'Mirror: decor entities on/off', run: toggleEnts, on: () => !!M.ents });
}
