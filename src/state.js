// Document, selection, undo/redo, geometry cache, show filters, grid, tool. No DOM, no three.js:
// view3d fills cache entries' `mesh` on 'doc'.
import * as V from '../vmf.js';
import { merge } from './hullgeo.js';
import { devMaterials } from './primitives.js';
import { emit } from './bus.js';
import { cfg, saveCfg } from './settings.js';
import { ask, notice } from './dialog.js';

const api = window.api;

// fly: 3D fly mode is active (keybindings are off). preview: { s, t, yaw } transform shown on the selection while
// dragging (see transformSel), or { r } a rotation. lin: leak line points. last: extents of the last block, reused for the depth axis of 2D block drags.
// lastDup: translation of the last move that directly followed a clone (repeat duplicate), or null.
// cursor: the last status message; coords: the 2D views' mouse position (its own status slot, so moving the mouse does
// not wipe the message). showWorld: the details panel shows worldspawn (Map properties) until the selection changes.
// pivot: a custom rotate / scale pivot (setPivot), or null. The grid goes from 1024 down to 0.125 (Hammer++'s microgrid).
const gridOf = g => Math.min(1024, Math.max(0.125, +g || 64));
export const S = { file: null, dirty: false, grid: gridOf(cfg.grid), tool: 'select', mode: 'object', cursor: '', coords: '', fly: false, preview: null, lin: null, last: [[0, 0, 0], [128, 128, 128]], lastDup: null, showWorld: false, history: null, gizmo: 'translate', pivot: null };
export const doc = { root: null, world: null };
export const sel = new Set(), faceSel = new Set(), cache = new Map();
export const filters = {
  world: true, detail: true, entities: true, triggers: true, clips: true, skybox: true, tools: true, displacements: true, models: true,
  hiddenVisgroups: new Set(), hidden: new Set(),
};

let maxId = 0;
export const nextId = () => String(++maxId);
const dirty = new Set(), undos = [], redos = [];
let edits = 0; // undo steps added so far (editCount)
let dropped = 0; // undo steps dropped past the limit (depth())
let dupArm = null; // the clones of the last cloneSel, until the next edit

// ---------- cache ----------
// Hammer saves hidden objects wrapped in place: world > hidden > solid, root > hidden > entity, entity > hidden > solid.
// [child, hidden] for the children of n named name, each wrapper's children in its place.
const unwrap = (n, name) => n.children.flatMap(c => (c.name === name ? [[c, false]] : c.name === 'hidden' ? V.kids(c, name).map(x => [x, true]) : []));
// [cache node, owner, hidden] for every solid and point entity.
function* items() {
  const { root, world } = doc;
  for (const [s, h] of unwrap(world, 'solid')) yield [s, world, h];
  for (const [e, eh] of unwrap(root, 'entity')) {
    const ss = unwrap(e, 'solid');
    if (ss.length) for (const [s, h] of ss) yield [s, e, eh || h];
    else if (V.get(e, 'origin') !== undefined) yield [e, e, eh];
  }
}
// Top-level objects: world solids and entities, hidden ones included.
export const objects = () => [...unwrap(doc.world, 'solid'), ...unwrap(doc.root, 'entity')].map(x => x[0]);

const hash = s => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };

// Show-filter categories that depend on the node itself (owner-based ones are checked in isVisible).
function kinds(n) {
  if (n.name === 'entity') return V.get(n, 'model') ? ['models'] : [];
  const sides = V.kids(n, 'side'), mats = sides.map(s => (V.get(s, 'material') || '').toLowerCase()), k = [];
  if (mats.length && mats.every(m => m.startsWith('tools/'))) {
    k.push('tools');
    if (mats.some(m => /^tools\/tools(player|npc)?clip$/.test(m))) k.push('clips');
    if (mats.some(m => m.startsWith('tools/toolsskybox'))) k.push('skybox');
  }
  if (sides.some(s => V.kids(s, 'dispinfo').length)) k.push('displacements');
  return k;
}

// fn(node) -> { box: [min, max], color } | null, either part optional: a point entity's box and 2D colour (FGD size()
// and color(), model or instance bounds). The first box and the first colour win; else a 16-unit box and a hashed hue.
const looks = [];
export function registerPointLook(fn) { looks.push(fn); return () => looks.includes(fn) && looks.splice(looks.indexOf(fn), 1); }
// A box at least 2 units thick on every axis (V.block needs volume).
const thick = ([mn, mx]) => [mn.map((x, k) => Math.min(x, (x + mx[k]) / 2 - 1)), mx.map((x, k) => Math.max(x, (mn[k] + x) / 2 + 1))];

function build(n, owner) {
  let faces, color2d;
  if (n.name === 'solid') {
    faces = V.faces(n);
    const ec = V.get(V.kids(n, 'editor')[0] ?? { kv: [] }, 'color');
    color2d = ec ? `rgb(${V.nums(ec).join(',')})` : '#c8c8c8';
  } else {
    const o = V.nums(V.get(n, 'origin'));
    let box, color;
    for (const f of looks) {
      let r = null;
      try { r = f(n); } catch (e) { console.error(e); }
      if (r?.box?.flat().every(Number.isFinite)) box ??= r.box;
      color ??= r?.color;
    }
    faces = V.faces(V.block(...(box ? thick(box) : [o.map(x => x - 8), o.map(x => x + 8)]), '', () => '0'));
    color2d = color ?? `hsl(${hash(V.get(n, 'classname') || '') % 360}, 70%, 55%)`;
  }
  const [min, max] = V.bounds(faces);
  cache.set(n, { node: n, owner, faces, min, max, color2d, mesh: null, point: n.name === 'entity', kinds: kinds(n), visible: true });
}

const vgroups = n => V.kids(n, 'editor').flatMap(e => e.kv.filter(p => p[0] === 'visgroupid').map(p => p[1]));
let groupVgs = new Map(); // group id -> the visgroups of its block (Hammer keeps a group's visgroups there), per applyVisibility

// Show-filter category of an entry's owner: 'world' | 'detail' | 'entities'.
export const category = c => (c.owner === doc.world ? 'world' : V.get(c.owner, 'classname') === 'func_detail' ? 'detail' : 'entities');

// Hidden when hidden with H, in a hidden visgroup, or in any category whose filter is off.
export function isVisible(c) {
  const o = c.owner, inWorld = o === doc.world, cls = inWorld ? '' : V.get(o, 'classname') || '';
  if (filters.hidden.has(c.node)) return false;
  if (filters.hiddenVisgroups.size && [...vgroups(c.node), ...(inWorld ? [] : vgroups(o)), ...(groupVgs.get(gid(top(c))) ?? [])].some(id => filters.hiddenVisgroups.has(id))) return false;
  if (!filters[category(c)]) return false;
  if (!filters.triggers && cls.startsWith('trigger_')) return false;
  return c.kinds.every(k => filters[k]);
}

// The custom pivot belongs to the selection it was placed for (pivotSel): a different selection drops it.
let pivotSel = new Set();
const samePivotSel = () => sel.size === pivotSel.size && [...sel].every(n => pivotSel.has(n));
const selChanged = () => { S.showWorld = false; if (S.pivot && !samePivotSel()) S.pivot = null; selTouched(); emit('selection', { sel, faceSel }); };
// Map properties: nothing selected, the details panel shows worldspawn.
export function showWorld() { sel.clear(); faceSel.clear(); S.showWorld = true; emit('selection', { sel, faceSel }); }

// Sets entry.visible and drops hidden nodes from the selection. Returns true when the selection changed.
function applyVisibility() {
  groupVgs = new Map(V.kids(doc.world, 'group').map(g => [V.get(g, 'id'), vgroups(g)]));
  for (const c of cache.values()) c.visible = isVisible(c);
  const n0 = sel.size + faceSel.size;
  for (const n of sel) if (!cache.get(n)?.visible) sel.delete(n);
  if (faceSel.size) {
    const live = new Set();
    for (const c of cache.values()) if (c.visible) for (const f of c.faces) live.add(f.side);
    for (const s of faceSel) if (!live.has(s)) faceSel.delete(s);
  }
  return sel.size + faceSel.size !== n0;
}

// Nodes inside hidden wrappers: kept in filters.hidden next to the ones hidden for this session only (isolate).
let wrapped = new Set();
export const inHiddenBlock = n => wrapped.has(n);
export function sync() {
  const changed = new Set(dirty), seen = new Set(), hid = new Set();
  for (const [n, o, h] of items()) {
    seen.add(n);
    if (h) hid.add(n);
    const c = cache.get(n);
    if (!c || dirty.has(n)) { build(n, o); changed.add(n); } else c.owner = o;
  }
  for (const n of cache.keys()) if (!seen.has(n)) { cache.delete(n); changed.add(n); }
  dirty.clear();
  for (const n of wrapped) if (!hid.has(n)) filters.hidden.delete(n);
  hid.forEach(n => filters.hidden.add(n));
  wrapped = hid;
  const lost = applyVisibility();
  emit('doc', changed);
  if (lost) selChanged();
}

// Rebuilds the cache entries of nodes on the next tick (one sync for every touch until then), e.g. once a model they
// show has loaded and their box changed.
let touchTimer = 0;
export function touch(nodes) {
  for (const n of nodes) if (cache.has(n)) dirty.add(n);
  touchTimer ||= setTimeout(() => { touchTimer = 0; if (dirty.size) sync(); });
}

export function applyFilters() {
  const lost = applyVisibility();
  emit('filters', filters);
  if (lost) selChanged();
  saveSidecar();
}

// Editor-only view state (visgroup and show-filter toggles) lives next to the map in <map>.vmf.editor.json,
// never in the VMF, so the file stays byte-identical for Hammer++.
const SHOW = ['world', 'detail', 'entities', 'triggers', 'clips', 'skybox', 'tools', 'displacements', 'models'];
const sidecar = f => f + '.editor.json';
// Other modules' editor-only data (key -> JSON value), saved with the sidecar. Cleared on load; 'sidecar' fires once
// an opened map's sidecar has been read into it.
export const sideData = {};
// Editor-only data that belongs to the map (the Figma import's base): [key, value] pairs on this node, outside the
// document. Change them with edit([], [extra], fn), so undo restores them, and replace values, never change them in
// place. The sidecar gets them when the map is saved, so it always matches the VMF on disk.
export const extra = { name: 'extra', kv: [], children: [] };
let savedExtra = {}, sideTimer;
export function saveSidecar() {
  if (!S.file) return;
  clearTimeout(sideTimer);
  const data = { hiddenVisgroups: [...filters.hiddenVisgroups], show: Object.fromEntries(SHOW.map(k => [k, filters[k]])), ...sideData, ...(Object.keys(savedExtra).length && { extra: savedExtra }) };
  sideTimer = setTimeout(() => api.write(sidecar(S.file), JSON.stringify(data, null, 2)).catch(() => {}), 300);
}
async function loadSidecar(file) {
  let d;
  try { d = JSON.parse((await api.read(sidecar(file))) || 'null'); } catch { return; }
  if (!d) return;
  savedExtra = d.extra ?? {};
  extra.kv = Object.entries(savedExtra);
  filters.hiddenVisgroups.clear();
  for (const id of d.hiddenVisgroups ?? []) filters.hiddenVisgroups.add(String(id));
  for (const k of SHOW) if (typeof d.show?.[k] === 'boolean') filters[k] = d.show[k];
  for (const [k, v] of Object.entries(d)) if (!['hiddenVisgroups', 'show', 'extra'].includes(k)) sideData[k] = v;
  applyFilters();
  emit('sidecar', d);
}

export function setFilter(key, on) { filters[key] = on; applyFilters(); }

// Hides nodes the way Hammer saves them, as one undo step: each wrapped in place in its own hidden block; a brush
// entity whose solids are all given is wrapped whole.
export function hide(nodes) {
  const ns = movable(new Set([...nodes].filter(n => cache.has(n) && !wrapped.has(n))));
  if (!ns.length) return;
  const parent = n => (n.name === 'entity' ? doc.root : owner(n));
  edit([], [...new Set(ns.map(parent))], () => ns.forEach(n => { const l = parent(n).children; l.splice(l.indexOf(n), 1, { name: 'hidden', kv: [], children: [n] }); }));
  applyFilters();
}
export const hideSel = () => hide(sel);

// Unwraps every hidden block in place (one undo step) and clears the session-only hides. Objects Hammer hid through a
// visgroup ("visgroupshown" "0") get their shown flags back, or Hammer would load them hidden again.
const flags = o => [o, ...V.kids(o, 'solid')].flatMap(x => V.kids(x, 'editor')).flatMap(e => e.kv.filter(p => /^visgroup(auto)?shown$/.test(p[0]) && p[1] !== '1'));
export function unhideAll() {
  const { root, world } = doc, cs = [world, root, ...unwrap(root, 'entity').map(x => x[0])].filter(c => c.children.some(x => x.name === 'hidden'));
  const objs = cs.flatMap(c => V.kids(c, 'hidden').flatMap(h => h.children)).filter(o => flags(o).length);
  if (cs.length) edit(objs, cs, () => cs.forEach(c => {
    c.children = c.children.flatMap(x => (x.name === 'hidden' ? x.children : [x]));
    objs.forEach(o => flags(o).forEach(p => { p[1] = '1'; }));
  }));
  filters.hidden.clear();
  applyFilters();
}

// ---------- undo: snapshot touched nodes (deep = every descendant too, shallow = the node's kv and child list) ----------
// Snapshots keep node identity, so selections and older undo steps keep pointing at live nodes.
const snap = (n, deep) => ({ n, deep, kv: n.kv.map(p => [...p]), kids: n.children.map(c => (deep ? snap(c, true) : { n: c })) });
const put = s => { s.n.kv = s.kv; s.n.children = s.kids.map(k => (k.kv && put(k), k.n)); };
const same = s => s.kv.length === s.n.kv.length && s.kv.every((p, i) => p[0] === s.n.kv[i][0] && p[1] === s.n.kv[i][1])
  && s.kids.length === s.n.children.length && s.kids.every((k, i) => k.n === s.n.children[i] && (!k.kv || same(k)));
const mark = (n, deep) => { dirty.add(n); if (deep) V.kids(n, 'solid').forEach(s => dirty.add(s)); };
function restore(snaps) {
  const back = snaps.map(s => snap(s.n, s.deep));
  for (const s of snaps) { put(s); mark(s.n, s.deep); }
  return back;
}

// light_spot, light_environment: vrad takes the light's pitch from the 'pitch' key when it is set (z = sin(pitch):
// negative is down), and Hammer keeps that key equal to the angles pitch (for these lights negative down too: vmf.js
// LIGHT). An edit to one sets the other, so turning the light in the editor turns it in Hammer and in the game.
const tidyNum = x => String(Math.round(x * 1000) / 1000 || 0);
function syncLights(s) {
  for (const x of s) {
    const n = x.n;
    if (n.name !== 'entity' || !V.LIGHT.test(V.get(n, 'classname') ?? '')) continue;
    const was = k => x.kv.find(p => p[0] === k)?.[1], a = V.nums(V.get(n, 'angles') ?? '0 0 0');
    const turned = (V.nums(was('angles') ?? '0 0 0')[0] ?? 0) !== (a[0] ?? 0), pitched = was('pitch') !== V.get(n, 'pitch');
    if (turned && !pitched) V.set(n, 'pitch', tidyNum(a[0] ?? 0));
    else if (pitched && !turned && a.length === 3) V.set(n, 'angles', [+V.get(n, 'pitch') || 0, a[1], a[2]].map(tidyNum).join(' '));
  }
}
// fn(snaps, take, same) runs after every edit() that changed something, before its undo step is stored (mirror.js keeps
// twins in step): take(node, deep) snapshots a node it is about to change, so the change joins the same step.
let editHook = null;
export const setEditHook = fn => { editHook = fn; };
// take(node, deep) for a list of snapshots: each node once, the first snapshot wins.
const taker = list => { const seen = new Set(); return (n, deep) => { if (!seen.has(n)) { seen.add(n); list.push(snap(n, deep)); } }; };

// An fn that changes nothing in the snapshots adds no undo step and leaves the document clean.
export function edit(deep, shallow, fn) {
  dupArm = null;
  settle(); // a selection change made before it is a step of its own, and the step's selection before is current
  const s = [...deep.map(n => snap(n, true)), ...shallow.map(n => snap(n, false))];
  fn();
  syncLights(s);
  if (s.every(same)) return;
  const extra = [];
  try { editHook?.(s, taker(extra), same); } catch (e) { console.error(e); }
  commit([...extra, ...s]); // the user's snapshots (taken before fn) go last, so they win where both took a node
}
// One undo step from fn(take), take(node, deep) snapshotting each node before fn changes it. No edit hook.
export function change(fn) {
  dupArm = null;
  settle();
  const s = [];
  fn(taker(s));
  if (!s.every(same)) commit(s);
}
function commit(s) {
  s.forEach(x => mark(x.n, x.deep));
  s.selBefore = selMark;
  pending = s; // its selection after it is taken when the selection settles (settle)
  selTouched();
  undos.push(s);
  edits++;
  if (undos.length > 300) { undos.shift(); dropped++; }
  redos.length = 0;
  S.dirty = true;
  S.history = 'edit';
  sync();
  S.history = null;
}
// S.history is 'edit', 'undo' or 'redo' during the 'doc' event they cause (polyedit.js keeps its own steps in order
// with the map's: depth() counts the steps made and not undone, old ones dropped past the limit included).
export const depth = () => dropped + undos.length;
export function undo() { step(undos, redos, 'undo'); }
export function redo() { step(redos, undos, 'redo'); }
// Moves one step from list a to list b: the nodes back as they were, then the selection the step had before (undo) or
// after it (redo). A selection step changes only the selection: the map stays clean.
function step(a, b, dir) {
  settle();
  const s = a.pop();
  if (!s) return;
  b.push(Object.assign(restore(s), { selBefore: s.selBefore, selAfter: s.selAfter, selOnly: s.selOnly }));
  if (!s.selOnly) { S.dirty = true; S.history = dir; sync(); S.history = null; }
  applySel(dir === 'undo' ? s.selBefore : s.selAfter, s.selOnly);
}
// Undo steps added since the start: an operation made of several edits merges the steps it added (mergeUndo).
export const editCount = () => edits;
// Joins the last two edits into one step. The older snapshots go last so they win when both touched a node.
export function mergeUndo() {
  if (undos.length < 2 || undos.at(-2).selOnly || undos.at(-1).selOnly) return;
  const b = undos.pop(), a = undos.pop(), m = Object.assign([...b, ...a], { selBefore: a.selBefore, selAfter: b.selAfter });
  if (pending === b) pending = m;
  undos.push(m);
}

// ---------- the selection in the undo history ----------
// A selection change the user makes is an undo step of its own (3ds Max, Unreal); one an edit makes (the new pieces
// selected) joins that edit's step. Every step keeps the selection before and after it, so undo and redo put it back.
// Changes in one task settle as one step (a click that clears and then selects). selExtra: { get(), set(v), same(a, b) }
// for selection kept elsewhere (poly edit's vertices, edges, faces); its changes call selTouched().
let selExtra = null, selMark = null, pending = null, settling = false, quiet = false;
export function setSelExtra(x) { selExtra = x; selMark = selSnap(); }
const selSnap = () => ({ sel: [...sel], face: [...faceSel], extra: selExtra?.get() ?? null });
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameSel = (a, b) => sameList(a.sel, b.sel) && sameList(a.face, b.face) && (!selExtra || selExtra.same(a.extra, b.extra));
export function selTouched() { if (!settling) { settling = true; queueMicrotask(settle); } }
function settle() {
  settling = false;
  const cur = selSnap();
  if (pending) pending.selAfter = cur;
  else if (selMark && !quiet && !sameSel(selMark, cur)) {
    undos.push(Object.assign([], { selOnly: true, selBefore: selMark, selAfter: cur }));
    if (undos.length > 300) { undos.shift(); dropped++; }
    redos.length = 0;
    emit('step', 'selection');
  }
  pending = null;
  quiet = false;
  selMark = cur;
}
// Puts a step's selection back (nodes no longer in the map are left out); extra only for selection steps (poly edit
// puts its own elements back after an edit).
function applySel(x, extra) {
  if (!x) return;
  sel.clear();
  x.sel.forEach(n => cache.has(n) && sel.add(n));
  faceSel.clear();
  x.face.forEach(s => faceSel.add(s));
  if (extra && selExtra && x.extra) selExtra.set(x.extra);
  selChanged();
  selMark = selSnap(); // the restored selection is no new step
}

// ---------- selection, tool, grid ----------
// Nodes without a cache entry (deleted, or not in the document) are ignored.
export function setSelection(nodes) { const a = [...nodes].filter(n => cache.has(n)); sel.clear(); a.forEach(n => sel.add(n)); selChanged(); }
export function toggle(n) { if (sel.has(n)) sel.delete(n); else if (cache.has(n)) sel.add(n); selChanged(); }
export function setFaceSelection(sides) { const a = [...sides]; faceSel.clear(); a.forEach(s => faceSel.add(s)); selChanged(); }
// The gizmo mode shared by object and poly editing: 'translate', 'rotate', 'scale' or null (none: drags select).
export function setGizmoMode(m) { S.gizmo = m; emit('gizmo', m); }
export function clearSelection() { sel.clear(); faceSel.clear(); selChanged(); }

export function setTool(t) { S.tool = t; emit('tool', { tool: S.tool, mode: S.mode }); }
export function setMode(m) { S.mode = m; emit('tool', { tool: S.tool, mode: S.mode }); }
// Kept in settings (cfg.grid), so the next session starts on the same grid.
export function setGrid(g) { S.grid = cfg.grid = gridOf(g); saveCfg(); emit('grid', S.grid); }
export function setCursor(text) { S.cursor = text; emit('cursor', text); }
export function setCoords(text) { S.coords = text; emit('cursor', text); }
export function setPreview(xf) { S.preview = xf; emit('preview', xf); }
export function setLin(pts) { S.lin = pts; emit('lin', pts); }

export function boxOf(entries) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const c of entries) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], c.min[k]); mx[k] = Math.max(mx[k], c.max[k]); }
  return [mn, mx];
}
// Point entities pivot and snap at their origin: a model or FGD box need not be centred on it.
const origin = n => V.nums(V.get(n, 'origin'));
const points = () => sel.size > 0 && [...sel].every(n => cache.get(n)?.point);
// The selection's bounds. Next to solids a point entity counts as its origin, so moves, scales and pivots keep the
// brushes on the grid (a model or instance box is rarely on it).
export function selBox() {
  if (!sel.size) return null;
  const es = [...sel].map(n => cache.get(n)), mixed = !points();
  return boxOf(es.map(c => { const o = mixed && c.point && origin(c.node); return o?.length === 3 ? { min: o, max: o } : c; }));
}
// Gizmo and rotation pivot: the custom pivot (setPivot), else a lone point entity's origin, else the centre of the
// selection's own box. null without a selection.
export function selPivot() {
  const f = selFrame();
  return !f ? null : S.pivot ? [...S.pivot] : sel.size === 1 && points() ? origin([...sel][0]) : turnZ(f.box[0].map((x, k) => (x + f.box[1][k]) / 2), f.yaw);
}
// Hammer++'s movable pivot: p ([x, y, z]; null: back to the default) is what selPivot returns for the selection now,
// until the selection changes. A move takes it along (transformSel). The gizmo goes to it.
export function setPivot(p) {
  S.pivot = p && sel.size ? [...p] : null;
  pivotSel = new Set(sel);
  emit('gizmo', S.gizmo);
}

// ---------- the selection's own angle ----------
const D2R = Math.PI / 180;
// p turned by deg about the z axis through the origin.
export const turnZ = (p, deg) => { const c = Math.cos(deg * D2R), s = Math.sin(deg * D2R); return [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]]; };
const fold = a => ((a % 90) + 135) % 90 - 45; // an angle in degrees to -45 up to 45 (a box looks the same every 90)
const faceArea = pts => {
  const n = [0, 0, 0];
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = pts[i].map((x, k) => x - pts[0][k]), b = pts[i + 1].map((x, k) => x - pts[0][k]);
    n[0] += a[1] * b[2] - a[2] * b[1]; n[1] += a[2] * b[0] - a[0] * b[2]; n[2] += a[0] * b[1] - a[1] * b[0];
  }
  return Math.hypot(...n) / 2;
};
// The angle about z (degrees, -45 up to 45) the selected brushes' upright faces mostly run at, by area; 0 where the
// world axes do as well. A diagonal wall or a slanted flight keeps its own angle: the gizmo's local space, the top
// view's box and the scale handles line up with it. Kept until the selected entries change; a turn about z (rotateSel)
// sets it to the angle before plus the turn (any angle).
let yawMemo = null;
export function selYaw() {
  const es = [...sel].map(n => cache.get(n)).filter(c => c && !c.point);
  if (yawMemo?.es.length === es.length && yawMemo.es.every((c, i) => c === es[i])) return yawMemo.yaw;
  const fs = [];
  for (const c of es) for (const f of c.faces) if (Math.abs(f.n[2]) < 0.01) fs.push([fold(Math.atan2(f.n[1], f.n[0]) / D2R), faceArea(f.pts)]);
  // half-degree bins round the 90-degree circle, each with its neighbours; the world axes win a tie
  const bins = new Map(), bin = a => (Math.round(a * 2) + 180) % 180;
  for (const [a, w] of fs) bins.set(bin(a), (bins.get(bin(a)) ?? 0) + w);
  const score = k => (bins.get((k + 179) % 180) ?? 0) + (bins.get(k) ?? 0) + (bins.get((k + 1) % 180) ?? 0);
  let best = 0, yaw = 0;
  for (const k of bins.keys()) if (score(k) > score(best)) best = k;
  if (best) {
    const c = fold(best / 2);
    let sw = 0, sd = 0;
    for (const [a, w] of fs) { const d = fold(a - c); if (Math.abs(d) <= 1) { sw += w; sd += d * w; } }
    yaw = fold(Math.round((c + sd / sw) * 1e4) / 1e4); // rounded, so noise cannot tip -45 to 45 (the box's axes swapped)
    if (Math.abs(yaw) < 0.01) yaw = 0;
  }
  yawMemo = { es, yaw };
  return yaw;
}
// { yaw, box }: the selection's box in its own frame, [lo, hi] of its points turned by -yaw about z (yaw 0: selBox()).
// The own frame only in local gizmo space (cfg.gizmoSpace); in world space the box is axis aligned. null without a
// selection.
export function selFrame() {
  const box = selBox();
  if (!box) return null;
  const yaw = cfg.gizmoSpace === 'local' ? selYaw() : 0;
  if (!yaw) return { yaw, box };
  const lo = [Infinity, Infinity, box[0][2]], hi = [-Infinity, -Infinity, box[1][2]], mixed = !points();
  const add = p => { const q = turnZ(p, -yaw); for (const k of [0, 1]) { lo[k] = Math.min(lo[k], q[k]); hi[k] = Math.max(hi[k], q[k]); } };
  for (const n of sel) {
    const c = cache.get(n), o = mixed && c.point && origin(n);
    if (o?.length === 3) add(o);
    else for (const f of c.faces) f.pts.forEach(add);
  }
  return { yaw, box: [lo, hi] };
}
// The point a move puts on the grid: the first point entity's origin, else the selection box's min corner.
export const snapRef = () => (points() ? origin([...sel][0]) : selBox()?.[0]);

// ---------- operations ----------
const owner = n => cache.get(n).owner;
const listOf = n => (owner(n) === n ? doc.root : owner(n)).children;

// The selection (or the set ns), with each brush entity whose solids are all in it standing in for them, so its
// origin (the hinge or pivot of func_door_rotating, func_rotating, ...) moves with the brushes.
export function movable(ns = sel) {
  const all = o => o !== doc.world && V.kids(o, 'solid').every(s => ns.has(s));
  return [...new Set([...ns].map(n => (n.name === 'solid' && all(owner(n)) ? owner(n) : n)))];
}

// p' = p * s + t, in the frame turned by yaw degrees about z when yaw is set (the selection's own axes: selFrame).
// A move of exactly the clones made by the previous edit is remembered as S.lastDup. A move takes the custom pivot along.
export function transformSel(s, t, yaw = 0) {
  const ns = movable(), arm = dupArm, lock = cfg.texLock !== false, O = [0, 0, 0];
  dupArm = null;
  if (!ns.length) return;
  if (S.pivot && s.every(x => x === 1)) { const T = turnZ(t, yaw); S.pivot = S.pivot.map((x, k) => x + T[k]); }
  edit(ns, [], () => ns.forEach(n => {
    if (yaw) V.rotate(n, O, 2, -yaw, lock);
    V.transform(n, s, t, lock);
    if (yaw) V.rotate(n, O, 2, yaw, lock);
  }));
  if (arm?.size === sel.size && [...sel].every(n => arm.has(n)) && s.every(x => x === 1)) S.lastDup = turnZ(t, yaw);
}

// A turn about z keeps the selection's own angle going (selYaw + degrees), so its local axes stay with it past 45
// degrees instead of folding back onto its other sides.
export function rotateSel(axis, degrees, pivot) {
  if (!sel.size) return;
  const p = pivot ?? selPivot(), ns = movable(), up = axis === 2 ? 1 : Array.isArray(axis) && Math.abs(axis[2]) > 0.9999 * Math.hypot(...axis) ? Math.sign(axis[2]) : 0;
  const yaw = up && selYaw();
  edit(ns, [], () => ns.forEach(n => V.rotate(n, p, axis, degrees, cfg.texLock !== false)));
  if (up) yawMemo = { es: [...sel].map(n => cache.get(n)).filter(c => c && !c.point), yaw: ((((yaw + up * degrees) % 360) + 540) % 360) - 180 };
}

// Group blocks left without members go too, and brush entities left without solids (hidden ones count).
export function deleteSel() {
  if (!sel.size) return;
  const { root, world } = doc, owners = [...new Set([...sel].map(owner))], ids = new Set([...sel].map(n => gid(top(cache.get(n)))).filter(Boolean));
  edit([], [...new Set([...owners, root, world])], () => {
    for (const n of sel) { const l = listOf(n); l.splice(l.indexOf(n), 1); }
    for (const o of owners) if (o !== world && !sel.has(o) && !o.children.some(x => x.name === 'solid' || x.name === 'hidden')) root.children.splice(root.children.indexOf(o), 1);
    prune(ids);
  });
}

// Clones of group members go into new groups (one per original group), so they select apart from the originals.
// Cloned overlays name the cloned faces. A lone path node's clone goes into its path (linkPath).
export function cloneSel() {
  if (!sel.size) return;
  const owners = [...new Set([...sel].map(owner))], clones = [], fresh = new Map(), ids = new Map();
  edit([], [...new Set([...owners, doc.root, doc.world])], () => {
    for (const n of sel) {
      const l = listOf(n), c = V.clone(n, nextId, ids), id = gid(c);
      l.splice(l.indexOf(n) + 1, 0, c);
      clones.push(c);
      if (id) setGid(c, fresh.get(id) ?? fresh.set(id, V.get(newGroup(vgroups(groupOf(n) ?? { children: [] })), 'id')).get(id));
    }
    clones.forEach(c => V.remapSides(c, ids));
    if (clones.length === 1 && cfg.pathAutoLink !== false) linkPath([...sel][0], clones[0]);
  });
  setSelection(clones);
  dupArm = new Set(clones);
}

// Hammer's path node clone: the clone c of a lone path_track or path_corner o goes into the path after o. It gets a
// new unique targetname (o's with its number counted up, 'path1' when o has none) and keeps o's target; o targets it.
function linkPath(o, c) {
  if (!/^path_(track|corner)$/i.test(V.get(o, 'classname') ?? '')) return;
  const names = new Set(unwrap(doc.root, 'entity').map(([e]) => V.get(e, 'targetname'))), [, base, num] = (V.get(o, 'targetname') || 'path').match(/^(.*?)(\d*)$/);
  let i = +num, name;
  do name = base + String(++i).padStart(num.length, '0'); while (names.has(name));
  V.set(c, 'targetname', name);
  V.set(o, 'target', name);
}

// Blockout mode: new brushes get dev textures by face direction and join the visgroup of the first selected object
// that has one, taking its colour as their editor colour.
function prepNew(solids) {
  if (!cfg.blockout) return;
  const id = [...sel].flatMap(n => [...vgroups(n), ...vgroups(owner(n))])[0];
  let color;
  (function walk(n) { for (const g of V.kids(n, 'visgroup')) { if (V.get(g, 'visgroupid') === id) color ??= V.get(g, 'color'); walk(g); } })(V.kids(doc.root, 'visgroups')[0] ?? { children: [] });
  for (const s of solids) {
    if (!V.kids(s, 'side').every(x => /^TOOLS\//i.test(V.get(x, 'material') ?? ''))) devMaterials(s); // a clip stays a clip
    const ed = V.kids(s, 'editor')[0];
    if (!id || !ed) continue;
    if (color) V.set(ed, 'color', color);
    const i = ed.kv.findIndex(p => p[0] === 'visgroupshown');
    ed.kv.splice(i < 0 ? ed.kv.length : i, 0, ['visgroupid', id]);
  }
}

// Adds solids to the world as one undo step and selects them.
export function addSolids(solids) {
  if (!solids.length) return;
  prepNew(solids);
  edit([], [doc.world], () => doc.world.children.push(...solids));
  setSelection(solids);
}

export function createBlock(mn, mx) {
  if ([0, 1, 2].some(k => mn[k] >= mx[k])) return null;
  S.last = [mn, mx];
  const b = V.block(mn, mx, cfg.material, nextId);
  prepNew([b]);
  edit([], [doc.world], () => doc.world.children.push(b));
  setSelection([b]);
  return b;
}

// fn(classname) -> [[key, value]]: the keyvalues a new entity gets besides id, classname and origin (Hammer writes the
// FGD defaults); set by models.js once the FGD has loaded. An origin key with value '' marks a class with an origin
// helper (func_door_rotating's hinge).
let newKeys = () => [];
export const setEntityDefaults = fn => { newKeys = fn; };

export function createEntity(origin) {
  const r = doc.root, e = V.entity(cfg.cls, origin, nextId);
  e.kv.splice(2, 0, ...newKeys(cfg.cls).filter(([k]) => !['id', 'classname', 'origin'].includes(k)).map(p => [...p]));
  edit([], [r], () => r.children.splice(r.children.findLastIndex(c => /^(world|entity|hidden)$/.test(c.name)) + 1, 0, e));
  setSelection([e]);
  return e;
}

const selSolids = () => [...sel].filter(n => n.name === 'solid');

// ---------- groups ----------
// Hammer groups: world > group { "id", editor { color, visgroupid.., visgroupshown, visgroupautoshown } }; a member
// (world solid or entity) names its group in its editor block, "groupid" right after "color". The group's visgroups sit
// on its block: Hammer drops visgroups from members of a group when it loads a map. A group block can name a parent
// group; a click selects the outermost one (withGroup).
const editorOf = n => V.kids(n, 'editor')[0];
const gid = n => { const e = editorOf(n); return e && V.get(e, 'groupid'); };
const top = c => (c.owner === doc.world ? c.node : c.owner); // the object a cache entry belongs to
const EDITOR = () => [['color', '220 220 220'], ['visgroupshown', '1'], ['visgroupautoshown', '1']];
function setGid(o, id) {
  let e = editorOf(o);
  if (!e && id) o.children.push((e = { name: 'editor', kv: EDITOR(), children: [] }));
  if (!e) return;
  e.kv = e.kv.filter(p => p[0] !== 'groupid');
  if (id) e.kv.splice(e.kv.findIndex(p => p[0] === 'color') + 1, 0, ['groupid', id]);
}
// visgroupid entries go before "visgroupshown", as Hammer writes them; take drops them all first.
function setVgs(o, ids, take = false) {
  let e = editorOf(o);
  if (!e && ids.length) o.children.push((e = { name: 'editor', kv: EDITOR(), children: [] }));
  if (!e) return;
  if (take) e.kv = e.kv.filter(p => p[0] !== 'visgroupid');
  for (const id of ids) {
    if (e.kv.some(p => p[0] === 'visgroupid' && p[1] === id)) continue;
    const i = e.kv.findIndex(p => p[0] === 'visgroupshown');
    e.kv.splice(i < 0 ? e.kv.length : i, 0, ['visgroupid', id]);
  }
}
// A new group block (in visgroups vgs) at the end of the world. Only inside edit() with the world snapshotted.
function newGroup(vgs = []) {
  const g = { name: 'group', kv: [['id', nextId()]], children: [{ name: 'editor', kv: EDITOR(), children: [] }] };
  setVgs(g, vgs);
  doc.world.children.push(g);
  return g;
}
// The group block of top-level object o, or null.
export const groupOf = o => { const id = o && gid(o); return (id && V.kids(doc.world, 'group').find(g => V.get(g, 'id') === id)) || null; };
// Group id -> its member objects (world solids and entities, hidden ones too). Groups without members are listed.
export function groups() {
  const m = new Map(V.kids(doc.world, 'group').map(g => [V.get(g, 'id'), []]));
  for (const o of objects()) { const id = gid(o); if (id) (m.get(id) ?? m.set(id, []).get(id)).push(o); }
  return m;
}
// Drops the group blocks of ids that no object names any more.
function prune(ids) {
  const used = groups();
  doc.world.children = doc.world.children.filter(c => c.name !== 'group' || !ids.has(V.get(c, 'id')) || used.get(V.get(c, 'id')).length);
}

// The cache nodes a click on n selects: every visible node of its outermost group (a group block can name a parent
// group, as Hammer nests them), or of its brush entity (as in Hammer), or n alone (neither, or cfg.ignoreGroups).
export function withGroup(n) {
  const c = cache.get(n);
  if (!c || cfg.ignoreGroups) return [n];
  const up = new Map(V.kids(doc.world, 'group').map(g => [V.get(g, 'id'), gid(g)]));
  const outer = id => { for (let k = 0; up.get(id) && k < 64; k++) id = up.get(id); return id; };
  const id = outer(gid(top(c))), o = top(c);
  if (!id && o === n) return [n];
  return [...cache.values()].filter(x => x.visible && (id ? outer(gid(top(x))) === id : x.owner === o)).map(x => x.node);
}
// A click in a viewport on n (null: empty space): selects n's group; ctrl adds it, or removes it when n is selected.
export function clickSelect(n, ctrl) {
  if (!n) return void (ctrl || setSelection([]));
  const ns = withGroup(n);
  setSelection(!ctrl ? ns : sel.has(n) ? [...sel].filter(x => !ns.includes(x)) : [...sel, ...ns]);
}

// Ctrl+G: one new group holding the selected objects (taken out of their old groups). Their visgroups (and those of
// their old groups) move to the new group block. Returns its id.
export function groupSel() { return groupEach([[...sel].map(n => top(cache.get(n)))])[0] ?? null; }

// One new group per list of top-level objects, as groupSel makes them, in one undo step. Returns their ids.
export function groupEach(lists) {
  lists = lists.map(l => [...new Set(l)]).filter(l => l.length);
  const objs = lists.flat(), old = new Set(objs.map(gid).filter(Boolean)), ids = [];
  if (!objs.length) return ids;
  const vgs = lists.map(l => [...new Set(l.flatMap(o => [...vgroups(o), ...vgroups(groupOf(o) ?? { children: [] })]))]);
  edit(objs, [doc.world], () => {
    lists.forEach((l, k) => {
      const id = V.get(newGroup(vgs[k]), 'id');
      l.forEach(o => { setGid(o, id); setVgs(o, [], true); });
      ids.push(id);
    });
    prune(old);
  });
  return ids;
}

// Ctrl+U: dissolves every group that has a selected member; the members get the group's visgroups back.
export function ungroupSel() {
  const ids = new Set([...sel].map(n => gid(top(cache.get(n)))).filter(Boolean)), objs = objects().filter(o => ids.has(gid(o)));
  const vgs = new Map(objs.map(o => [o, vgroups(groupOf(o) ?? { children: [] })]));
  if (ids.size) edit(objs, [doc.world], () => { objs.forEach(o => { setVgs(o, vgs.get(o)); setGid(o, null); }); prune(ids); });
}

// The cache nodes of a top-level object: a solid, a brush entity's solids, or a point entity.
export const nodesOf = o => (o.name === 'solid' ? [o] : V.kids(o, 'solid').length ? V.kids(o, 'solid') : [o]);

// Inserts top-level objects (world solids, entities; paste, prefabs, instance collapse) as one undo step and selects
// them: solids after the world's last solid, entities after the last entity. Each group id they name becomes one new
// group, so copies select apart from the originals. remove: objects taken out in the same step.
export function addObjects(objs, remove = []) {
  const { root, world } = doc, fresh = new Map(), at = (l, re) => l.findLastIndex(c => re.test(c.name)) + 1;
  if (!objs.length && !remove.length) return;
  edit([], [root, world], () => {
    for (const n of remove) { const l = (n.name === 'entity' ? root : world).children, i = l.indexOf(n); if (i >= 0) l.splice(i, 1); }
    // a pasted group gets the visgroups its members carry in the snippet (clipboard.js puts the group's there)
    const vgs = new Map();
    for (const o of objs) { const id = gid(o); if (id) vgs.set(id, [...new Set([...(vgs.get(id) ?? []), ...vgroups(o)])]); }
    for (const o of objs) { const id = gid(o); if (id) { setGid(o, fresh.get(id) ?? fresh.set(id, V.get(newGroup(vgs.get(id)), 'id')).get(id)); setVgs(o, [], true); } }
    world.children.splice(at(world.children, /^(solid|hidden)$/), 0, ...objs.filter(o => o.name === 'solid'));
    root.children.splice(at(root.children, /^(world|entity|hidden)$/), 0, ...objs.filter(o => o.name === 'entity'));
  });
  setSelection(objs.flatMap(nodesOf));
}

// Entities whose side lists (info_overlay, env_cubemap) name an old side id of ids (old id -> new ids, from V.clone).
// keep (the solids that stay): ids then lead to their sides only.
export function sideUsers(ids, keep) {
  if (keep) { // a piece cut again (carve with several cutters) passes its sides on to its own pieces
    const live = new Set(keep.flatMap(s => V.kids(s, 'side').map(x => V.get(x, 'id')))), all = x => (ids.has(x) ? ids.get(x).flatMap(all) : [x]);
    for (const k of [...ids.keys()]) ids.set(k, ids.get(k).flatMap(all).filter(x => live.has(x)));
  }
  return unwrap(doc.root, 'entity').map(x => x[0]).filter(e => V.namesSides(e, ids));
}

// Replaces each selected solid with fn(solid, ids) -> solids (an empty result keeps the solid) and selects the pieces.
// Overlays on the old faces move to the pieces' faces (ids: old side id -> new ids).
function replaceSel(fn) {
  const solids = selSolids(), ids = new Map(), out = solids.map(s => fn(s, ids));
  if (!out.some(x => x.length)) return false;
  const users = sideUsers(ids, out.flat());
  edit([], [...new Set([...solids.map(owner), ...users])], () => {
    solids.forEach((s, i) => { const l = listOf(s); if (out[i].length) l.splice(l.indexOf(s), 1, ...out[i]); });
    users.forEach(e => V.remapSides(e, ids));
  });
  setSelection(out.flatMap((x, i) => (x.length ? x : [solids[i]])));
  return true;
}
// Poly edits: each [solids, pieces] in place as one undo step (solids: one solid or the pieces of an earlier edit).
// Solid k takes piece k's keys and children; solids left over go, pieces left over follow the last kept solid in the
// same list (world or brush entity, so func_detail and visgroups stay). group: a world solid outside any group that
// becomes several pieces gets a new group holding them. ids (old side id -> new ids, as V.clone records them):
// overlays on the old faces follow.
export function replaceSolids(list, { group = true, ids } = {}) {
  list = list.map(([s, ps]) => [[s].flat(), ps]);
  const users = ids ? sideUsers(ids, list.flatMap(x => x[1])) : [];
  edit(list.flatMap(x => x[0]), [...new Set([...list.flatMap(x => x[0].map(owner)), doc.world, ...users])], () => {
    for (const [olds, news] of list) {
      const s = olds[0], data = news.map(n => [n.kv, n.children]), keep = olds.slice(0, news.length), rest = news.slice(olds.length);
      const was = gid(s); // pieces merged back into one brush leave the group their split made, if nothing else is in it
      for (const o of olds.slice(news.length)) { const l = listOf(o); l.splice(l.indexOf(o), 1); }
      keep.forEach((o, k) => { [o.kv, o.children] = data[k]; });
      const l = listOf(keep.at(-1));
      l.splice(l.indexOf(keep.at(-1)) + 1, 0, ...rest);
      if (news.length === 1 && olds.length > 1 && was && (groups().get(was)?.length ?? 0) <= 1) { setGid(s, null); prune(new Set([was])); }
      if (!group || !rest.length || owner(s) !== doc.world || gid(s)) continue;
      const id = V.get(newGroup(vgroups(s)), 'id');
      for (const p of [...keep, ...rest]) { setGid(p, id); setVgs(p, [], true); }
    }
    users.forEach(e => V.remapSides(e, ids));
  });
}

// Hammer++'s Merge: the selected solids become one, the convex hull of their corners (hullgeo merge), in the first
// one's place: its id, owner and editor block (group, visgroups). The others go, and so do brush entities and groups
// they leave empty; overlays on their faces move to the hull's faces on the same planes. One undo step. False when
// fewer than two solids are selected or their corners span no volume.
export function mergeSel() {
  const solids = selSolids(), ids = new Map(), h = solids.length > 1 && merge(solids, nextId, ids);
  if (!h) return false;
  const { root, world } = doc, [s, ...rest] = solids, owners = [...new Set(rest.map(owner))], gs = new Set(rest.map(n => gid(top(cache.get(n)))).filter(Boolean));
  const users = sideUsers(ids, [h]);
  edit([s], [...new Set([...owners, root, world, ...users])], () => {
    [s.kv, s.children] = [h.kv, h.children];
    for (const o of rest) { const l = listOf(o); l.splice(l.indexOf(o), 1); }
    for (const o of owners) if (o !== world && !o.children.some(x => x.name === 'solid' || x.name === 'hidden')) root.children.splice(root.children.indexOf(o), 1);
    prune(gs);
    users.forEach(e => V.remapSides(e, ids));
  });
  setSelection([s]);
  return true;
}

// points: 3 points on the plane (vmf.js clip). Keeps both pieces.
export const clipSel = points => replaceSel((s, ids) => V.clip(s, points, nextId, ids).filter(Boolean));
// Walls of thickness t (default: the grid). Displacement brushes stay as they are (like carve; their walls would cut
// the displaced face). False when no brush was hollowed.
export const hollowSel = (t = S.grid) => replaceSel((s, ids) => (cache.get(s).kinds.includes('displacements') ? [] : V.hollow(s, t, nextId, ids)));

// Adds the FGD defaults of class cls that brush entity e lacks after its classname; an origin key starts at the centre
// of its solids (Hammer's Center Origins). Only inside edit().
function brushDefaults(e, cls) {
  const has = new Set(e.kv.map(p => p[0].toLowerCase())), [mn, mx] = V.bounds(V.kids(e, 'solid').flatMap(V.faces));
  const mid = mn.map((x, k) => String(Math.round(((x + mx[k]) / 2) * 1e6) / 1e6)).join(' ');
  const add = newKeys(cls).filter(([k]) => !has.has(k.toLowerCase()) && k !== 'id' && (k !== 'origin' || mn.every(Number.isFinite)));
  e.kv.splice(e.kv.findIndex(p => p[0] === 'classname') + 1, 0, ...add.map(([k, v]) => [k, k === 'origin' ? mid : v]));
}

// Snaps the vertices of the selected solids to the grid. Returns the number of brushes left unchanged because they
// would become invalid.
export function snapSel() {
  const solids = selSolids();
  let bad = 0;
  if (solids.length) edit(solids, [], () => { bad = solids.filter(s => !V.snapVertices(s, S.grid)).length; });
  return bad;
}

// Moves the selected solids into a new brush entity of class cls, or back to the world when cls is ''.
// A brush entity whose solids are all selected only changes its class.
export function tieSel(cls) {
  const solids = selSolids(), { root, world } = doc, owners = [...new Set(solids.map(owner))], [o] = owners;
  if (!solids.length) return;
  edit([], [...new Set([root, world, ...owners])], () => {
    if (cls && owners.length === 1 && o !== world && V.kids(o, 'solid').every(s => sel.has(s))) return V.set(o, 'classname', cls), brushDefaults(o, cls);
    if (cls) return brushDefaults(V.tie(root, world, solids, cls, nextId), cls);
    for (const e of owners.filter(x => x !== world)) {
      const mine = solids.filter(s => e.children.includes(s));
      if (mine.length === V.kids(e, 'solid').length) V.untie(root, world, e);
      else {
        e.children = e.children.filter(c => !mine.includes(c));
        world.children.splice(world.children.findLastIndex(c => c.name === 'solid') + 1, 0, ...mine);
      }
    }
  });
}
export const untieSel = () => tieSel('');

// 'materials/dev/foo.vmt', 'dev\foo' -> 'DEV/FOO': material names go into the VMF the way Hammer writes them.
export const matName = (n = '') => n.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^materials\//i, '').replace(/\.(vmt|vtf)$/i, '').toUpperCase();

// Without solid: every face of every selected solid. With side: that face only.
export function applyMaterial(name, { solid, side } = {}) {
  const solids = solid ? [solid] : selSolids();
  name = matName(name);

  if (!name || !solids.length) return;
  edit(solids, [], () => (side ? [side] : solids.flatMap(s => V.kids(s, 'side'))).forEach(sd => V.set(sd, 'material', name)));
}

// ---------- files ----------
export const EMPTY = 'versioninfo\n{\n\t"editorversion" "400"\n\t"editorbuild" "8864"\n\t"mapversion" "1"\n\t"formatversion" "100"\n\t"prefab" "0"\n}\nworld\n{\n\t"id" "1"\n\t"mapversion" "1"\n\t"classname" "worldspawn"\n\t"skyname" "sky_day01_01"\n}\n';
// Save / Discard / Cancel when the map has unsaved changes. Resolves true when it is fine to drop the document.
export async function confirmDiscard() {
  if (!S.dirty) return true;
  const name = S.file ? S.file.split(/[\\/]/).pop() : 'untitled';
  const r = await ask(`Save changes to ${name}?`, ['Save', 'Discard', 'Cancel']);
  return r === 0 ? save() : r === 1;
}

export const serialize = () => V.serialize(doc.root);

export function load(text, file) {
  const root = V.parse(text);
  let world = V.kids(root, 'world')[0];
  if (!world) { world = V.parse(EMPTY).children[1]; root.children.push(world); }
  Object.assign(doc, { root, world });
  maxId = 0;
  (function scan(n) { for (const [k, v] of n.kv) if (k === 'id') maxId = Math.max(maxId, +v || 0); n.children.forEach(scan); })(root);
  Object.assign(S, { file, dirty: false, preview: null, lastDup: null, pivot: null });
  dupArm = null;
  sel.clear();
  faceSel.clear();
  filters.hidden.clear();
  filters.hiddenVisgroups.clear();
  for (const k of Object.keys(sideData)) delete sideData[k];
  wrapped = new Set();
  undos.length = redos.length = 0;
  pending = null;
  quiet = true; // the new map's selection is no step
  selTouched();
  extra.kv = [];
  savedExtra = {};
  cache.clear();
  dirty.clear();
  setLin(null);
  sync();
  selChanged();
  setCursor(''); // (a message about the last map)
  if (file) { cfg.lastFile = file; saveCfg(); }
  emit('file', { op: 'load', file });
}

export async function newMap() { if (await confirmDiscard()) load(EMPTY, null); }

// No path: show the open dialog.
export async function open(path) {
  if (!(await confirmDiscard())) return;
  const r = path ? { path, text: await api.read(path) } : await api.openDialog();
  if (typeof r?.text === 'string') { load(r.text, r.path); await loadSidecar(r.path); }
  else if (path) notice(`Could not read ${path}`);
}

export async function save(as) {
  let f = S.file;
  if (as || !f) f = await api.saveDialog(f || 'untitled.vmf');
  if (!f) return false;
  try { await api.write(f, serialize()); } catch (err) { notice('Save failed: ' + err.message); return false; }
  Object.assign(S, { file: f, dirty: false });
  cfg.lastFile = f;
  saveCfg();
  savedExtra = Object.fromEntries(extra.kv);
  saveSidecar();
  emit('file', { op: 'save', file: f });
  return true;
}
