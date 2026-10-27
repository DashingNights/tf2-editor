// Cordons (Hammer++): root block cordons { "active" "0|1" cordon { "name", "active", box { "mins" "(x y z)" "maxs" } } }.
// The Cordon tool draws, moves and resizes the first cordon's box in the 2D views. While cordons are on, everything
// outside the active boxes is dimmed (2D overlay, 3D builder) and the compile exports only the objects that touch a
// box, sealed by a shell of tools/toolsskybox brushes (cordonRoot, used by compile.js).
import * as THREE from 'three';
import * as V from '../vmf.js';
import { on } from './bus.js';
import { S, doc, cache, edit, setSelection, setTool, setCursor, selBox, boxOf } from './state.js';
import { register } from './commands.js';
import { cfg } from './settings.js';
import { registerTool, registerOverlay, invalidate as redraw2d, s2 } from './view2d.js';
import { setDimmer, refreshEntry, addHelper, removeHelper, invalidate as redraw3d } from './view3d.js';
import { $, el } from './dom.js';

// ---------- pure ----------
const fmt = x => String(Math.round(x * 1e6) / 1e6);
const vecText = p => `(${p.map(fmt).join(' ')})`;

// { block, on, list: [{ node, name, on, box: [mins, maxs] | null }] }: the cordons of a parsed root (none before a load).
export function cordons(root) {
  const block = root && V.kids(root, 'cordons')[0];
  const list = (block ? V.kids(block, 'cordon') : []).map(node => {
    const b = V.kids(node, 'box')[0], a = V.nums(b && V.get(b, 'mins')), c = V.nums(b && V.get(b, 'maxs'));
    const box = a.length === 3 && c.length === 3 ? [a.map((x, k) => Math.min(x, c[k])), a.map((x, k) => Math.max(x, c[k]))] : null;
    return { node, name: V.get(node, 'name') ?? '', on: V.get(node, 'active') !== '0', box };
  });
  return { block, on: V.get(block ?? { kv: [] }, 'active') === '1', list };
}
// The boxes that cut the map: the active cordons while cordons are on.
export const activeBoxes = root => { const c = cordons(root); return c.on ? c.list.filter(x => x.on && x.box).map(x => x.box) : []; };
export const touches = (mn, mx, [a, b]) => mn.every((x, k) => x <= b[k] && mx[k] >= a[k]);
export const within = (mn, mx, [a, b]) => mn.every((x, k) => x >= a[k] && mx[k] <= b[k]);

// Six brushes of thickness t just outside the box that seal it (Hammer's cordon brushes). Walls on x span the outer
// extent, walls on y the inner x extent, floor and ceiling the inner x and y: they meet without overlapping.
export function shell([a, b], t, material, nextId) {
  const out = [];
  for (let k = 0; k < 3; k++) for (const hi of [false, true]) {
    const mn = a.map((x, j) => (j === k ? (hi ? b[j] : x - t) : j < k ? x : x - t));
    const mx = b.map((x, j) => (j === k ? (hi ? x + t : a[j]) : j < k ? x : x + t));
    out.push(V.block(mn, mx, material, nextId));
  }
  return out;
}

// The map cut to the boxes, as a new root that shares the kept nodes: world solids and entities touching a box (a brush
// entity whole), every other block as it is, hidden objects dropped (vbsp skips them anyway), and a sealing shell per
// box at the end of the world.
export function cordonRoot(root, boxes, nextId, t = 16) {
  const hit = (mn, mx) => boxes.some(b => touches(mn, mx, b));
  const solidIn = s => hit(...V.bounds(V.faces(s)));
  const entIn = e => {
    const ss = V.kids(e, 'solid'), o = V.nums(V.get(e, 'origin'));
    return ss.length ? ss.some(solidIn) : o.length !== 3 || hit(o, o);
  };
  const keep = c => c.name !== 'hidden' && (c.name !== 'entity' || entIn(c));
  return { ...root, children: root.children.filter(keep).map(c => (c.name !== 'world' ? c : {
    ...c, children: [...c.children.filter(x => x.name !== 'hidden' && (x.name !== 'solid' || solidIn(x))), ...boxes.flatMap(b => shell(b, t, 'TOOLS/TOOLSSKYBOX', nextId))],
  })) };
}

// ---------- editing the first cordon ----------
const first = () => cordons(doc.root).list[0];
export const editBox = () => first()?.box ?? null;

// One undo step: creates the cordons block and a cordon when missing, then sets the first cordon's box (when given)
// and the cordons' on/off state (when given).
function update(box, active) {
  const r = doc.root, old = V.kids(r, 'cordons')[0];
  edit(old ? [old] : [], [r], () => {
    let b = old;
    if (!b) r.children.push((b = { name: 'cordons', kv: [['active', '0']], children: [] }));
    if (box) {
      let c = V.kids(b, 'cordon')[0];
      if (!c) b.children.push((c = { name: 'cordon', kv: [['name', 'cordon'], ['active', '1']], children: [] }));
      let x = V.kids(c, 'box')[0];
      if (!x) c.children.push((x = { name: 'box', kv: [], children: [] }));
      V.set(x, 'mins', vecText(box[0]));
      V.set(x, 'maxs', vecText(box[1]));
    }
    if (active !== undefined) V.set(b, 'active', active ? '1' : '0');
  });
}

function toggle() {
  const c = cordons(doc.root);
  if (!c.on && !c.list.some(x => x.box)) { setTool('cordon'); return setCursor('cordon: drag a box in a 2D view first'); }
  update(null, !c.on);
  setCursor(`cordon ${c.on ? 'off' : 'on'}`);
}

function fromSelection() {
  const b = selBox();
  if (!b) return;
  update(b.map(p => p.map(x => Math.round(x))), true);
  setCursor('cordon on: the selection bounds');
}

// Hammer's Select touching / Select inside, against the first cordon's box.
function selectBy(test) {
  const b = editBox();
  if (!b) return setCursor('No cordon box: draw one with the Cordon tool');
  setSelection([...cache.values()].filter(c => c.visible && test(c.min, c.max, b)).map(c => c.node));
}

// ---------- Cordon tool (2D) ----------
let drag = null; // { mode: 'new' | 'move' | 'resize', a: start w, box0, box, h: handle }
const step = () => (cfg.snapGrid ? S.grid : 1);
const sn = x => Math.round(x / step()) * step();

// Resize handle of box under screen x, y in view v: [-1|0|1, -1|0|1] per view axis, or null.
function handleAt(v, [a, b], x, y) {
  const [i, j] = v.ax, L = s2(v, a[i], a[j]), H = s2(v, b[i], b[j]), r = 6;
  if (x < L[0] - r || x > H[0] + r || y < H[1] - r || y > L[1] + r) return null;
  const hx = Math.abs(x - L[0]) < r ? -1 : Math.abs(x - H[0]) < r ? 1 : 0, hy = Math.abs(y - L[1]) < r ? -1 : Math.abs(y - H[1]) < r ? 1 : 0;
  return hx || hy ? [hx, hy] : null;
}

// A new box spans the whole map in the view's depth axis (or keeps the current box's depth).
function depth(v) {
  const d = 3 - v.ax[0] - v.ax[1], b = editBox() ?? boxOf(cache.values());
  return Number.isFinite(b[0][d]) && b[1][d] > b[0][d] ? [sn(b[0][d] - step() / 2), sn(b[1][d] + step() / 2)] : [-1024, 1024];
}

function dragTo(v, w) {
  const d = drag, [mn, mx] = d.box0.map(p => [...p]);
  v.ax.forEach((k, i) => {
    const p = sn(w[i]);
    if (d.mode === 'new') { mn[k] = Math.min(d.a[i], p); mx[k] = Math.max(d.a[i], p); }
    else if (d.mode === 'move') { const t = sn(d.box0[0][k] + w[i] - d.a[i]) - d.box0[0][k]; mn[k] += t; mx[k] += t; }
    else if (d.h[i] < 0) mn[k] = Math.min(p, mx[k] - step());
    else if (d.h[i] > 0) mx[k] = Math.max(p, mn[k] + step());
  });
  d.box = [mn, mx];
}

const TOOL = {
  down(v, e, w) {
    const b = editBox(), h = b && handleAt(v, b, e.offsetX, e.offsetY), [i, j] = v.ax;
    if (h) drag = { mode: 'resize', h, box0: b, box: b };
    else if (b && w[0] >= b[0][i] && w[0] <= b[1][i] && w[1] >= b[0][j] && w[1] <= b[1][j]) drag = { mode: 'move', a: w, box0: b, box: b };
    else {
      const a = w.map(sn), [lo, hi] = depth(v), d = 3 - i - j, mn = [0, 0, 0], mx = [0, 0, 0];
      mn[d] = lo; mx[d] = hi;
      drag = { mode: 'new', a, box0: [mn, mx], box: null };
    }
    return true;
  },
  move(v, e, w) {
    if (!drag) {
      const b = editBox(), h = b && handleAt(v, b, e.offsetX, e.offsetY);
      e.target.style.cursor = h ? (h[0] && h[1] ? (h[0] === h[1] ? 'nesw-resize' : 'nwse-resize') : h[0] ? 'ew-resize' : 'ns-resize') : 'crosshair';
      return true;
    }
    dragTo(v, w);
    wire();
    return true;
  },
  up() {
    const b = drag?.box;
    drag = null;
    if (b && b[0].every((x, k) => x < b[1][k])) update(b, cordons(doc.root).on || undefined);
    redraw2d();
    wire();
    return true;
  },
  key(e) {
    if (e.key !== 'Escape') return false;
    if (drag) drag = null; else setTool('select');
    redraw2d();
    wire();
    return true;
  },
};

// ---------- drawing ----------
// 2D: every cordon box (dashed; yellow when it cuts the map), the area outside the active boxes darkened, and the
// first box's handles while the tool is active.
function overlay(ctx, v) {
  const c = cordons(doc.root), boxes = c.list.map((x, i) => ({ box: i === 0 && drag?.box ? drag.box : x.box, cut: c.on && x.on })).filter(x => x.box);
  if (drag?.box && !c.list.length) boxes.push({ box: drag.box, cut: false });
  const [i, j] = v.ax, rect = ([a, b]) => { const L = s2(v, a[i], a[j]), H = s2(v, b[i], b[j]); return [L[0], H[1], H[0] - L[0], L[1] - H[1]]; };
  const cut = boxes.filter(x => x.cut);
  if (cut.length) {
    ctx.beginPath();
    ctx.rect(0, 0, v.w, v.h);
    cut.forEach(x => ctx.rect(...rect(x.box)));
    ctx.fillStyle = 'rgba(8, 9, 12, 0.62)';
    ctx.fill('evenodd');
  }
  ctx.setLineDash([6, 4]);
  for (const x of boxes) { ctx.strokeStyle = x.cut ? '#ffd040' : '#a08a40'; ctx.strokeRect(...rect(x.box)); }
  ctx.setLineDash([]);
  if (S.tool !== 'cordon' || !boxes.length) return;
  const [x, y, w, h] = rect(boxes[0].box);
  ctx.fillStyle = '#ffd040';
  for (const px of [x, x + w / 2, x + w]) for (const py of [y, y + h / 2, y + h]) if (px !== x + w / 2 || py !== y + h / 2) ctx.fillRect(px - 3, py - 3, 6, 6);
}

// 3D: a wire box per cordon while cordons are on or the tool is active.
const wires = new THREE.Group();
let wiresShown = false;
function wire() {
  wires.children.forEach(h => { h.geometry.dispose(); h.material.dispose(); });
  wires.clear();
  const c = cordons(doc.root), show = c.on || S.tool === 'cordon';
  c.list.forEach((x, i) => {
    const b = i === 0 && drag?.box ? drag.box : x.box;
    if (b) wires.add(new THREE.Box3Helper(new THREE.Box3(new THREE.Vector3(...b[0]), new THREE.Vector3(...b[1])), c.on && x.on ? 0xffd040 : 0xa08a40));
  });
  if (show !== wiresShown) (wiresShown = show) ? addHelper(wires) : removeHelper(wires);
  else redraw3d();
}

// 3D dimming: view3d dims the visual of every entry outside all active boxes (setDimmer), whatever builder made it.
let cut = []; // the active boxes the visuals were dimmed for
export const outside = c => cut.length > 0 && !cut.some(b => touches(c.min, c.max, b));
// After a document change: rebuild the entries whose side of the cordon changed (view3d batches the refreshes).
function recut() {
  const now = activeBoxes(doc.root);
  if (JSON.stringify(now) === JSON.stringify(cut)) return;
  const was = [...cache.values()].map(outside);
  cut = now;
  [...cache.values()].filter((c, i) => outside(c) !== was[i]).forEach(c => refreshEntry(c.node));
}

function syncButton(b) {
  const onNow = cordons(doc.root).on;
  b.classList.toggle('on', onNow);
  b.textContent = `Cordon ${onNow ? 'on' : 'off'}`;
}

export function mount() {
  registerTool('cordon', TOOL);
  registerOverlay(overlay);
  setDimmer(outside);
  const onBtn = $('.cordon-toggle') ?? el('button'); // the toolbar's on/off button (index.html)
  on('doc', () => { recut(); wire(); syncButton(onBtn); });
  on('tool', () => { if (S.tool !== 'cordon') drag = null; wire(); redraw2d(); });
  syncButton(onBtn);

  register('tool.cordon', { title: 'Tool: cordon (drag a box in a 2D view)', run: () => setTool('cordon') , on: () => S.tool === 'cordon' });
  register('cordon.toggle', { title: 'Cordon: on/off (compile and show only what is inside)', run: toggle, on: () => !!doc.root && cordons(doc.root).on });
  register('cordon.fromSelection', { title: 'Cordon: from selection bounds', when: () => !!selBox(), run: fromSelection });
  register('select.touching', { title: 'Select touching the cordon box', run: () => selectBy(touches) });
  register('select.inside', { title: 'Select inside the cordon box', run: () => selectBy(within) });
}
