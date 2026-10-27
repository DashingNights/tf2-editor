// The Figma changes panel: the rows of an update (figmaui.js diff), grouped by area, each accepted or rejected, and
// drawn in the 3D and 2D views while the review is open: the rest of the map dimmed (Changes only: hidden), added
// pieces as green ghosts, removed ones red, a changed one as the map's piece in red wireframe with the incoming one as
// a green ghost, conflicts orange; rejected ones faint. N / P go to the next / previous change (the views fly there),
// A accepts, R rejects, B flips the focused change between before and after. Apply is one undo step.
import * as THREE from 'three';
import * as V from '../vmf.js';
import { on } from './bus.js';
import { cache, filters, applyFilters, nodesOf } from './state.js';
import { register } from './commands.js';
import { registerPanel, pane, show } from './layout.js';
import { addHelper, removeHelper, setDimmer, refreshEntry, focus, fan, invalidate as redraw3d } from './view3d.js';
import { registerOverlay, invalidate as redraw2d } from './view2d.js';
import { describe } from './figmadiff.js';
import { el, scrollToShow } from './dom.js';

const SHOWN = ['change', 'conflict', 'add', 'remove'], LABEL = { change: 'incoming', conflict: 'conflict', add: 'added', remove: 'removed' };
const COLOR = { add: 0x3ad46a, theirs: 0x3ad46a, ours: 0xff4a4a, conflict: 0xffa020, focus: 0xffe14a };
const css = c => `#${c.toString(16).padStart(6, '0')}`;
// R: { d, rows (the changes), at (focused row), flip (null | 'before' | 'after'), only, hid (nodes hidden by Changes
// only), byNode (cache node -> row), prev (the dimmer before), cb: { apply, refresh } } while a review is open.
let R = null, list = null, timer = 0;

// The faces of a generated node: a solid's, a brush entity's solids', a point entity's 16-unit box.
function facesOf(n) {
  if (n.name === 'solid') return V.faces(n);
  const ss = V.kids(n, 'solid');
  if (ss.length) return ss.flatMap(V.faces);
  const o = V.nums(V.get(n, 'origin') ?? '0 0 0');
  return V.faces(V.block(o.map(x => x - 8), o.map(x => x + 8), '', () => '0'));
}
const box = bs => (bs.length ? [[0, 1, 2].map(k => Math.min(...bs.map(b => b[0][k]))), [0, 1, 2].map(k => Math.max(...bs.map(b => b[1][k])))] : null);
// Fills in what the views and the list need: ours / theirs faces and boxes, the description.
function prepare() {
  // grouped by area (in the order they first come), so N / P walk the list as shown; the rows of an object that are one
  // choice (x.unit, figmaui.refresh) are one row, its members
  const areas = new Map(), units = new Map();
  for (const x of R.d.rows) {
    if (!SHOWN.includes(x.type)) continue;
    if (x.unit && units.has(x.unit)) { units.get(x.unit).members.push(x); continue; }
    const row = x.unit ? { ...x, key: x.unit, members: [x] } : x;
    if (x.unit) units.set(x.unit, row);
    (areas.get(x.area) ?? areas.set(x.area, []).get(x.area)).push(row);
  }
  for (const u of units.values()) {
    const ts = u.members.map(m => m.type);
    Object.assign(u, { type: ts.includes('conflict') ? 'conflict' : ts.every(t => t === 'add') ? 'add' : ts.every(t => t === 'remove') ? 'remove' : 'change', theirs: u.members.find(m => m.theirs)?.theirs ?? null });
  }
  R.rows = [...areas.values()].flat();
  R.byNode = new Map();
  for (const x of R.rows) {
    const ms = x.members ?? [x];
    x.ns = ms.flatMap(m => (m.node ? nodesOf(m.node).filter(n => cache.has(n)) : []));
    x.ns.forEach(n => R.byNode.set(n, x));
    x.of = x.ns.flatMap(n => cache.get(n).faces);
    x.tf = ms.flatMap(m => (m.theirs ? facesOf(m.theirs.node) : []));
    x.ob = box(ms.filter(m => m.node).map(m => V.boundsOf(m.node)));
    x.tb = box(ms.filter(m => m.theirs).map(m => V.boundsOf(m.theirs.node)));
    x.desc = describe(x, x.ob, x.tb) + (x.members ? ` (${ms.filter(m => m.node).length} pieces in the map, ${ms.filter(m => m.theirs).length} in the layout: taken or kept together)` : '');
  }
  R.at = Math.max(0, Math.min(R.at, R.rows.length - 1));
}

// ---------- 3D ----------
const group = new THREE.Group();
const meshMat = (color, opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
const edges = fs => fs.flatMap(f => f.pts.flatMap((p, i) => [...p, ...f.pts[(i + 1) % f.pts.length]]));
const geo = pos => new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
// The map's piece of a change is dimmed (its wireframe shows it), unless the focused one shows before; a removed one
// stays as it is, unless the focused one shows after. Everything else is dimmed.
function dimmed(c) {
  const x = R?.byNode.get(c.node);
  if (!R || !x) return !!R;
  const f = x === R.rows[R.at];
  return !x.theirs ? f && R.flip === 'after' : !(f && R.flip === 'before');
}
function draw3d() {
  for (const o of group.children) { o.geometry.dispose(); o.material.dispose(); }
  group.clear();
  if (!R) return redraw3d();
  const meshes = new Map(), lines = new Map(), put = (m, k, pos) => (m.get(k) ?? m.set(k, []).get(k)).push(...pos);
  R.rows.forEach((x, i) => {
    const f = i === R.at, a = x.accept ? 1 : 0.35, c = x.type === 'conflict' ? COLOR.conflict : null;
    if (x.tf.length && !(f && R.flip === 'before')) put(meshes, `${c ?? COLOR.theirs}|${(f ? 0.55 : 0.3) * a}`, fan(x.tf));
    if (x.of.length && !(f && R.flip === 'after')) {
      if (!x.theirs) put(meshes, `${c ?? COLOR.ours}|${(f ? 0.6 : 0.4) * a}`, fan(x.of));
      else if (!(f && R.flip === 'before')) put(lines, c ?? COLOR.ours, edges(x.of));
    }
    if (f) put(lines, COLOR.focus, edges([...(R.flip === 'after' ? [] : x.of), ...(R.flip === 'before' ? [] : x.tf)]));
  });
  for (const [k, pos] of meshes) { const [c, o] = k.split('|').map(Number); group.add(new THREE.Mesh(geo(pos), meshMat(c, o))); }
  for (const [c, pos] of lines) {
    const l = new THREE.LineSegments(geo(pos), new THREE.LineBasicMaterial({ color: c, depthTest: c !== COLOR.focus, transparent: true }));
    l.renderOrder = c === COLOR.focus ? 3 : 1;
    group.add(l);
  }
  redraw3d();
}
const refreshDims = rows => rows.forEach(x => x?.ns.forEach(refreshEntry));

// ---------- 2D ----------
// The rest dimmed (unless hidden), then each change's faces in its colours; the focused one thicker, in yellow.
function overlay(ctx, v, { toScreen }) {
  if (!R) return;
  if (!R.only) { ctx.fillStyle = 'rgba(8, 9, 12, 0.6)'; ctx.fillRect(0, 0, v.w, v.h); }
  const stroke = (fs, color, w) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.beginPath();
    for (const f of fs) {
      f.pts.forEach((p, i) => { const [x, y] = toScreen(v, p); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.closePath();
    }
    ctx.stroke();
  };
  R.rows.forEach((x, i) => {
    if (i === R.at) return;
    ctx.globalAlpha = x.accept ? 0.9 : 0.35;
    const c = x.type === 'conflict' ? COLOR.conflict : null;
    stroke(x.of, css(c ?? COLOR.ours), 1);
    stroke(x.tf, css(c ?? COLOR.theirs), 1);
  });
  const x = R.rows[R.at];
  ctx.globalAlpha = 1;
  if (x && R.flip !== 'after') stroke(x.of, css(COLOR.focus), 2);
  if (x && R.flip !== 'before') stroke(x.tf, css(x.type === 'conflict' ? COLOR.conflict : COLOR.theirs), 2);
}

// ---------- panel ----------
const counts = () => {
  const n = Object.fromEntries([...SHOWN, 'same'].map(t => [t, R.d.rows.filter(x => x.type === t).length]));
  n.local = R.d.rows.filter(x => x.type === 'same' && x.ours !== null && x.ours !== x.base.h).length;
  n.deleted = R.d.rows.filter(x => x.type === 'same' && x.ours === null).length;
  return n;
};
function render() {
  const p = pane('figmadiff');
  if (!R) return p.replaceChildren(el('small', { className: 'fd-empty', textContent: 'Run "Update from Figma (SVG)..." (or drop an .svg on a map imported from Figma) to review the changes of a new export here.' }));
  const n = counts(), all = accept => el('button', { textContent: accept ? 'Accept all' : 'Reject all', onclick: () => choose(R.rows, accept) });
  const only = el('input', { type: 'checkbox', checked: R.only, onchange: () => setOnly(only.checked) });
  list ??= el('div', { className: 'fd-list' });
  p.replaceChildren(el('div', { className: 'fd-head' },
    el('b', { textContent: `Update from ${R.d.name}` }),
    el('small', { textContent: `${n.change} incoming, ${n.conflict} conflicts, ${n.add} added, ${n.remove} removed; ${n.same} unchanged (kept as they are in the map: ${n.local} with local edits, ${n.deleted} deleted here). ${R.rows.filter(x => x.accept).length} of ${R.rows.length} accepted.` }),
    el('div', { className: 'row' }, all(true), all(false), el('label', {}, only, ' Changes only'), el('span', { className: 'fd-end' }),
      el('button', { className: 'primary', textContent: 'Apply', onclick: applyNow }), el('button', { textContent: 'Cancel', onclick: close })),
    el('small', { textContent: 'N / P next / previous, A accept, R reject, B before / after. Green: incoming, red: the map now, orange: conflict (edited here too).' })), list);
  const areas = new Map();
  R.rows.forEach((x, i) => (areas.get(x.area) ?? areas.set(x.area, []).get(x.area)).push([x, i]));
  list.replaceChildren(...[...areas].map(([area, rows]) => el('div', { className: 'fd-group' },
    el('div', { className: 'fd-gh' }, el('b', { textContent: `${area} (${rows.length})` }), el('span', { className: 'fd-end' }),
      el('button', { textContent: 'Accept all', onclick: () => choose(rows.map(r => r[0]), true) }), el('button', { textContent: 'Reject all', onclick: () => choose(rows.map(r => r[0]), false) })),
    ...rows.map(([x, i]) => el('div', { className: `fd-row${i === R.at ? ' on' : ''}${x.accept ? '' : ' no'}`, onclick: () => go(i) },
      el('span', { className: `fd-t fd-${x.type}`, textContent: LABEL[x.type] }),
      el('span', { className: 'fd-l', textContent: x.layer, title: x.key }),
      el('span', { className: 'fd-d', textContent: x.desc, title: x.desc }),
      el('button', { textContent: 'Accept', className: x.accept ? 'on' : '', onclick: e => { e.stopPropagation(); choose([x], true); } }),
      el('button', { textContent: 'Reject', className: x.accept ? '' : 'on', onclick: e => { e.stopPropagation(); choose([x], false); } }))))));
  scrollToShow(list, list.querySelector('.fd-row.on'));
}

function choose(rows, accept) {
  if (!R) return;
  rows.forEach(x => { x.accept = accept; x.members?.forEach(m => { m.accept = accept; }); });
  draw3d();
  redraw2d();
  render();
}
// Focuses row i: the views frame it (its piece now and the incoming one).
function go(i) {
  if (!R?.rows.length) return;
  const was = R.rows[R.at];
  R.at = (i + R.rows.length) % R.rows.length;
  R.flip = null;
  const x = R.rows[R.at], bs = [x.ob, x.tb].filter(Boolean);
  refreshDims([was, x]);
  focus([[0, 1, 2].map(k => Math.min(...bs.map(b => b[0][k])) - 64), [0, 1, 2].map(k => Math.max(...bs.map(b => b[1][k])) + 64)]);
  draw3d();
  redraw2d();
  render();
}
function flip() {
  if (!R?.rows.length) return;
  R.flip = R.flip === 'before' ? 'after' : 'before';
  refreshDims([R.rows[R.at]]);
  draw3d();
  redraw2d();
}
function setOnly(on) {
  R.only = on;
  if (on) for (const c of cache.values()) { if (!R.byNode.has(c.node) && !filters.hidden.has(c.node)) { filters.hidden.add(c.node); R.hid.add(c.node); } }
  else { R.hid.forEach(n => filters.hidden.delete(n)); R.hid.clear(); }
  applyFilters();
  redraw2d();
}

// Opens the review of d (figmaui.js diff); cb: { apply() (after the review closes), refresh() (re-diff against the map) }.
export function open(d, cb) {
  if (R) close();
  R = { d, cb, at: 0, flip: null, only: false, hid: new Set() };
  prepare();
  const prev = (R.prev = setDimmer(c => dimmed(c) || !!prev?.(c)));
  for (const c of cache.values()) refreshEntry(c.node);
  addHelper(group);
  show('figmadiff');
  go(0);
  render();
}
export function close() {
  if (!R) return;
  if (R.only) setOnly(false);
  setDimmer(R.prev);
  R = null;
  removeHelper(group);
  draw3d();
  for (const c of cache.values()) refreshEntry(c.node);
  redraw2d();
  render();
}
function applyNow() {
  const cb = R?.cb;
  close();
  cb?.apply();
}

export function mount() {
  registerPanel({ id: 'figmadiff', title: 'Figma changes', near: 'details' });
  render();
  registerOverlay(overlay);
  on('file', e => e?.op === 'load' && close()); // (a save keeps the review)
  // the map changed during the review (an edit, undo): diff again, keeping the choices
  on('doc', () => {
    if (!R) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!R) return;
      const was = R.rows;
      R.cb.refresh();
      prepare();
      refreshDims([...was, ...R.rows]);
      draw3d();
      redraw2d();
      render();
    }, 300);
  });
  const when = () => !!R;
  register('figma.review.next', { title: 'Figma changes: next', keys: ['n'], when, run: () => go(R.at + 1) });
  register('figma.review.prev', { title: 'Figma changes: previous', keys: ['p'], when, run: () => go(R.at - 1) });
  register('figma.review.accept', { title: 'Figma changes: accept the focused change', keys: ['a'], when, run: () => { const x = R.rows[R.at]; if (x) { choose([x], true); go(R.at + 1); } } });
  register('figma.review.reject', { title: 'Figma changes: reject the focused change', keys: ['r'], when, run: () => { const x = R.rows[R.at]; if (x) { choose([x], false); go(R.at + 1); } } });
  register('figma.review.flip', { title: 'Figma changes: before / after of the focused change', keys: ['b'], when, run: flip });
  register('figma.review.apply', { title: 'Figma changes: apply the accepted changes', when, run: applyNow });
  register('figma.review.cancel', { title: 'Figma changes: cancel the review', when, run: close });
}
