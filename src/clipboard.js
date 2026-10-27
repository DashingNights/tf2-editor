// Copy, cut, paste: the selection as a VMF snippet (versioninfo, the visgroups it names, world with its solids, its
// entities) on the system clipboard, and kept here for when the clipboard holds something else. Paste in place, Paste
// at cursor (bounds corner at the last 2D pointer position or 3D surface point, grid-snapped) and Paste special.
import * as V from '../vmf.js';
import { S, doc, sel, cache, EMPTY, nextId, addObjects, deleteSel, setCursor, groupOf } from './state.js';
import { register } from './commands.js';
import { cfg } from './settings.js';
import { visgroups } from './outliner.js';
import { viewByName, toWorld } from './view2d.js';
import { onHover } from './view3d.js';
import { notice } from './dialog.js';
import { form } from './report.js';

// ---------- pure ----------
// VMF text as the bytes main.js writes for .vmf files: latin1, characters above U+00FF as UTF-8.
export const latin1 = s => Uint8Array.from(s.replace(/[^\x00-\xff]+/g, c => unescape(encodeURIComponent(c))), c => c.charCodeAt(0));

const editorsIn = n => (n.name === 'editor' ? [n] : n.children.flatMap(editorsIn));
const unwrap = (n, name) => n.children.flatMap(c => (c.name === name ? [c] : c.name === 'hidden' ? V.kids(c, name) : []));

// The visgroup ids named in objs.
export const vgIdsIn = objs => [...new Set(objs.flatMap(o => editorsIn(o).flatMap(e => e.kv.filter(p => p[0] === 'visgroupid').map(p => p[1]))))];

// VMF text of objs (top-level solids and entities; not changed). vgs: [{ id, name, color }], written as a flat visgroups
// block so a paste can map the ids by name. prefab: the versioninfo prefab flag.
export function snippet(objs, vgs = [], prefab = false) {
  const root = V.parse(EMPTY.replace('"prefab" "0"', `"prefab" "${prefab ? 1 : 0}"`)), world = V.kids(root, 'world')[0];
  if (vgs.length) root.children.splice(1, 0, { name: 'visgroups', kv: [], children: vgs.map(g => ({ name: 'visgroup', kv: [['name', g.name], ['visgroupid', g.id], ['color', g.color ?? '220 220 220']], children: [] })) });
  world.children.push(...objs.filter(o => o.name === 'solid'));
  root.children.push(...objs.filter(o => o.name === 'entity'));
  root.eol = '\r\n';
  return V.serialize(root);
}

// { objs, names: Map<visgroup id, name> } from snippet (or map) text; null when the text is not one or holds nothing.
export function readSnippet(text) {
  if (typeof text !== 'string' || !/^\s*(versioninfo|visgroups|world|entity)\s*\{/.test(text)) return null;
  const root = V.parse(text), world = V.kids(root, 'world')[0], objs = [...(world ? unwrap(world, 'solid') : []), ...unwrap(root, 'entity')];
  if (!objs.length) return null;
  const names = new Map();
  (function walk(n) { for (const g of V.kids(n, 'visgroup')) { names.set(V.get(g, 'visgroupid'), V.get(g, 'name')); walk(g); } })(V.kids(root, 'visgroups')[0] ?? { children: [] });
  return { objs, names };
}

// Copies of objs with new ids and visgroup ids mapped by name (ids: name -> id in this map; unknown names are dropped).
// tag goes on group ids, so each Paste special copy forms its own groups (state.addObjects makes new groups). Copied
// overlays name the copied faces (faces that were not copied stay named, as in Hammer).
export function prepare(objs, names, ids, nextId, tag = '') {
  const sides = new Map(), out = objs.map(o => {
    const c = V.clone(o, nextId, sides);
    for (const e of editorsIn(c)) e.kv = e.kv.flatMap(([k, v]) => (k === 'visgroupid' ? (ids.has(names.get(v)) ? [[k, ids.get(names.get(v))]] : []) : [[k, k === 'groupid' ? v + tag : v]]));
    return c;
  });
  out.forEach(c => V.remapSides(c, sides));
  return out;
}

// [min, max] of objects: their solids' faces and point entity origins.
export const boundsOf = objs => V.bounds(objs.flatMap(o => (o.name === 'solid' ? [o] : V.kids(o, 'solid').length ? V.kids(o, 'solid') : [o]))
  .flatMap(n => (n.name === 'solid' ? V.faces(n) : [{ pts: [V.nums(V.get(n, 'origin'))].filter(p => p.length === 3) }])));

// ---------- copy ----------
let buffer = null; // the last snippet copied here
let at = null; // the pointer: { v, w } in a 2D view, or { p } on a 3D surface

// The selection as top-level objects: world solids, point entities, brush entities with only their selected solids.
function selObjects() {
  const out = [], parts = new Map();
  for (const n of sel) {
    const o = cache.get(n)?.owner;
    if (o === doc.world || o === n) out.push(n);
    else if (o) (parts.get(o) ?? parts.set(o, new Set()).get(o)).add(n);
  }
  for (const [e, ss] of parts) out.push({ ...e, children: e.children.filter(c => !/^(solid|hidden)$/.test(c.name) || ss.has(c)) });
  return out;
}

// A group member carries its group's visgroups in the snippet (state.addObjects moves them to the pasted group).
function withGroupVgs(o) {
  const add = vgIdsIn([groupOf(o)].filter(Boolean));
  if (!add.length) return o;
  return { ...o, children: o.children.map(c => {
    if (c.name !== 'editor') return c;
    const kv = c.kv.filter(p => p[0] !== 'visgroupid' || !add.includes(p[1])), i = kv.findIndex(p => p[0] === 'visgroupshown');
    kv.splice(i < 0 ? kv.length : i, 0, ...add.map(id => ['visgroupid', id]));
    return { ...c, kv };
  }) };
}

export function copyText(prefab = false) {
  const objs = selObjects().map(withGroupVgs), ids = new Set(vgIdsIn(objs));
  return { text: snippet(objs, visgroups().filter(g => ids.has(g.id)).map(g => ({ id: g.id, name: g.name, color: V.get(g.node, 'color') })), prefab), count: objs.length };
}

function copy() {
  const { text, count } = copyText();
  buffer = text;
  navigator.clipboard?.writeText(text).catch(() => {});
  setCursor(`copied ${count} object(s)`);
}

// ---------- paste ----------
const snap = x => (cfg.snapGrid ? Math.round(x / S.grid) * S.grid : Math.round(x));
// The move that puts box's min corner at the pointer (2D: the view's two axes only), or null when it is unknown.
function toCursor([mn]) {
  if (!mn.every(Number.isFinite)) return null;
  if (at?.p) return at.p.map((x, k) => snap(x) - mn[k]);
  if (!at?.v) return null;
  const t = [0, 0, 0];
  at.v.ax.forEach((k, i) => { t[k] = snap(at.w[i]) - mn[k]; });
  return t;
}
const idsByName = () => new Map(visgroups().map(g => [g.name, g.id]));
const lock = () => cfg.texLock !== false;

async function clipText() {
  let t = null;
  try { t = await navigator.clipboard.readText(); } catch {}
  return readSnippet(t) ? t : buffer;
}

// Pastes snippet text in place or with its bounds corner at the cursor. False when the text is not a snippet.
export function pasteText(text, atCursor = false) {
  const d = readSnippet(text);
  if (!d) return false;
  const objs = prepare(d.objs, d.names, idsByName(), nextId), t = atCursor && toCursor(boundsOf(objs));
  if (t) objs.forEach(o => V.transform(o, [1, 1, 1], t, lock()));
  addObjects(objs);
  setCursor(`pasted ${objs.length} object(s)${atCursor && !t ? ' in place (move the mouse over a view first)' : ''}`);
  return true;
}

async function paste(atCursor) {
  if (!pasteText(await clipText(), atCursor)) setCursor('Nothing to paste: copy objects first');
}

// Hammer's Paste special: copies 1..n each offset and rotated (about its own centre) by i times the step, starting
// from the original position or from the cursor. One undo step; each copy gets its own groups.
async function pasteSpecial() {
  const d = readSnippet(await clipText());
  if (!d) return setCursor('Nothing to paste: copy objects first');
  const r = await form('Paste special', [
    { key: 'n', label: 'Number of copies', value: '1' },
    { key: 'off', label: 'Offset per copy (x y z)', value: '0 0 0' },
    { key: 'rot', label: 'Rotation per copy (x y z degrees)', value: '0 0 0' },
    { key: 'centre', label: 'Start at centre of original', type: 'checkbox', value: true },
  ]);
  if (!r) return;
  const n = Math.round(+r.n), off = V.nums(r.off), rot = V.nums(r.rot);
  if (!(n >= 1 && n <= 500) || off.length !== 3 || rot.length !== 3) return notice('Paste special: copies must be 1 to 500; offset and rotation take three numbers (x y z).');
  const ids = idsByName(), objs = [];
  for (let i = 1; i <= n; i++) {
    const c = prepare(d.objs, d.names, ids, nextId, `#${i}`), base = (!r.centre && toCursor(boundsOf(c))) || [0, 0, 0];
    c.forEach(o => V.transform(o, [1, 1, 1], base.map((x, k) => x + off[k] * i), lock()));
    if (rot.some(Boolean)) {
      const [mn, mx] = boundsOf(c), p = mn.map((x, k) => (x + mx[k]) / 2);
      [0, 1, 2].forEach(k => rot[k] && c.forEach(o => V.rotate(o, p, k, rot[k] * i, lock())));
    }
    objs.push(...c);
  }
  addObjects(objs);
  setCursor(`pasted ${n} cop${n === 1 ? 'y' : 'ies'}`);
}

export function mount() {
  for (const name of ['top', 'front', 'side']) document.querySelector(`#v-${name} canvas`)?.addEventListener('pointermove', e => {
    const v = viewByName(name);
    if (v) at = { v, w: toWorld(v, e.offsetX, e.offsetY) };
  });
  onHover(h => { if (h) at = { p: h.point.toArray() }; });
  const any = () => sel.size > 0;
  register('edit.copy', { title: 'Copy', keys: ['ctrl+c'], when: any, run: copy });
  register('edit.cut', { title: 'Cut', keys: ['ctrl+x'], when: any, run: () => { copy(); deleteSel(); } });
  register('edit.paste', { title: 'Paste (in place)', keys: ['ctrl+v'], run: () => paste(false) });
  register('edit.pasteAtCursor', { title: 'Paste at cursor', keys: ['ctrl+shift+v'], run: () => paste(true) });
  register('edit.pasteSpecial', { title: 'Paste special...', run: pasteSpecial });
}
