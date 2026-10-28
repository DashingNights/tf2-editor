// Hammer's brush commands: carve (Ctrl+Shift+C), hollow dialog, transform dialog (Ctrl+M), flip (Ctrl+L / Ctrl+I),
// align to the selection bounds, snap selection to grid, Hammer++'s merge, the path node auto-link toggle. Flip and
// align work on the axes of the 2D view under the pointer last (X / Z after the 3D view).
import * as V from '../vmf.js';
import { S, doc, sel, cache, edit, nextId, selBox, setCursor, transformSel, rotateSel, hollowSel, mergeUndo, movable, sideUsers, mergeSel } from './state.js';
import { register } from './commands.js';
import { cfg, setCfg } from './settings.js';
import { el } from './dom.js';
import { viewByName } from './view2d.js';

let active = null; // 'top' | 'front' | 'side', null after the 3D view
// The 2D view the pointer was over last, or null after the 3D view.
export const activeView = () => active && viewByName(active);
const axes = () => activeView()?.ax ?? [0, 2];
const lock = () => cfg.texLock !== false;
const centre = b => b[0].map((x, k) => (x + b[1][k]) / 2);


// ---------- carve ----------
// The selected brushes cut every visible brush they overlap that is not selected (displacements excepted). Overlays on
// the cut faces move to the pieces' faces.
function carveSel() {
  const cutters = [...sel].filter(n => n.name === 'solid').map(n => cache.get(n));
  const hit = c => cutters.some(b => [0, 1, 2].every(k => c.min[k] < b.max[k] && c.max[k] > b.min[k]));
  const out = new Map(), ids = new Map();
  for (const c of cache.values()) {
    if (!c.visible || c.point || sel.has(c.node) || c.kinds.includes('displacements') || !hit(c)) continue;
    let ps = [c.node], cut = false;
    for (const k of cutters) ps = ps.flatMap(p => { const r = V.carve(p, k.node, nextId, ids); cut ||= !!r; return r ?? [p]; });
    if (cut) out.set(c, ps);
  }
  if (!out.size) return setCursor('carve: the selection overlaps no other brush');
  const { root, world } = doc, owners = [...new Set([...out.keys()].map(c => c.owner))], users = sideUsers(ids, [...out.values()].flat());
  edit([], [...owners, root, ...users], () => {
    users.forEach(e => V.remapSides(e, ids));
    for (const [c, ps] of out) { const l = c.owner.children; l.splice(l.indexOf(c.node), 1, ...ps); }
    for (const o of owners) if (o !== world && !o.children.some(x => x.name === 'solid' || x.name === 'hidden')) root.children.splice(root.children.indexOf(o), 1);
  });
  setCursor(`carved ${out.size} brush(es) into ${[...out.values()].flat().length} piece(s)`);
}

// ---------- dialogs ----------
let dlg;
// A modal form; resolves with read() on OK, null on Cancel or Escape.
function modal(title, body, read) {
  dlg ??= document.body.appendChild(el('dialog', { className: 'bt-dialog' }));
  dlg.replaceChildren(el('form', { method: 'dialog' }, el('h3', { textContent: title }), ...body,
    el('div', { className: 'row' },
      el('button', { className: 'primary', value: 'ok', textContent: 'OK' }),
      el('button', { type: 'button', textContent: 'Cancel', onclick: () => dlg.close() }))));
  dlg.returnValue = '';
  dlg.showModal();
  dlg.querySelector('input[type=number]')?.select();
  return new Promise(res => { dlg.onclose = () => res(dlg.returnValue === 'ok' ? read() : null); });
}
const num = value => el('input', { type: 'number', step: 'any', required: true, value });
const field = (label, input) => el('label', { className: 'bt-field' }, el('span', { textContent: label }), input);

async function hollowDialog() {
  const t = num(S.grid), v = await modal('Make hollow', [field('Wall thickness', t), el('small', { textContent: 'Negative: the walls grow outward.' })], () => +t.value);
  if (!v) return;
  const solids = [...sel].filter(n => n.name === 'solid'), disp = solids.filter(n => cache.get(n)?.kinds.includes('displacements')).length;
  const ok = hollowSel(v), skip = disp ? `; ${disp} displacement brush(es) left as they were` : '';
  setCursor(ok ? `hollowed, walls ${v} thick${skip}` : disp === solids.length ? 'hollow: displacement brushes are not hollowed' : `hollow: the brushes are too thin for that thickness${skip}`);
}

// Hammer's Transform dialog: move (offset, or absolute position of the selection centre), rotate (degrees about X, Y,
// Z through the centre), scale (factors, or absolute size) about the centre. A placed pivot (pivot.place) stands in for
// the centre in rotate and scale. One undo step.
let tmode = 'move';
async function transformDialog() {
  const box = selBox();
  if (!box) return;
  const c = centre(box), o = S.pivot ?? c, size = box[1].map((x, k) => x - box[0][k]), xyz = [0, 1, 2].map(() => num(0)), abs = el('input', { type: 'checkbox' });
  const radios = ['move', 'rotate', 'scale'].map(m => el('input', { type: 'radio', name: 'bt-mode', value: m, checked: m === tmode }));
  const fill = () => {
    tmode = radios.find(r => r.checked).value;
    abs.disabled = tmode === 'rotate';
    const a = abs.checked && !abs.disabled, v = tmode === 'move' ? (a ? c : [0, 0, 0]) : tmode === 'rotate' ? [0, 0, 0] : a ? size : [1, 1, 1];
    xyz.forEach((f, k) => { f.value = +v[k].toFixed(3); });
  };
  [...radios, abs].forEach(r => { r.onchange = fill; });
  fill();
  const v = await modal('Transform', [
    el('div', { className: 'row bt-modes' }, ...radios.map(r => el('label', {}, r, ' ' + r.value[0].toUpperCase() + r.value.slice(1)))),
    ...xyz.map((f, k) => field('XYZ'[k], f)),
    el('label', { className: 'bt-check' }, abs, ' Absolute (position of the centre, size)'),
  ], () => ({ v: xyz.map(f => +f.value), a: abs.checked && !abs.disabled }));
  if (!v) return;
  if (tmode === 'move') return transformSel([1, 1, 1], v.a ? v.v.map((x, k) => x - c[k]) : v.v);
  if (tmode === 'rotate') {
    let n = 0;
    v.v.forEach((deg, k) => { if (deg % 360) { rotateSel(k, deg, o); if (n++) mergeUndo(); } });
    return;
  }
  const s = v.a ? v.v.map((x, k) => (size[k] ? x / size[k] : 1)) : v.v;
  if (s.some(x => !(x > 0))) return setCursor('transform: scale needs positive values');
  transformSel(s, o.map((x, k) => x - x * s[k]));
}

// ---------- merge ----------
// Hammer++'s Merge: the selected brushes become one, their convex hull, in the first one's place.
function merge() {
  const n = [...sel].filter(x => x.name === 'solid').length;
  setCursor(mergeSel() ? `merged ${n} brushes into their convex hull` : n > 1 ? 'merge: the brushes have no volume together' : 'merge: select two or more brushes');
}

// ---------- flip, align, snap ----------
// i: 0 horizontal, 1 vertical on the active 2D view. Mirrors about the selection centre.
function flip(i) {
  const box = selBox(), k = axes()[i], s = [1, 1, 1], t = [0, 0, 0];
  s[k] = -1;
  t[k] = box[0][k] + box[1][k];
  transformSel(s, t);
}

// side: 'min' | 'max' | 'center'; i: the view axis (0 horizontal, 1 vertical), both for center.
function align(side, ...is) {
  const objs = movable();
  if (objs.length < 2) return setCursor('align: select two or more objects');
  edit(objs, [], () => is.forEach(i => V.alignTo(objs, side, axes()[i], lock())));
}

// Hammer's Snap selected to grid individually (each object moves) and Snap selected to grid (one move for all).
function snapGrid() {
  const objs = movable();
  edit(objs, [], () => V.snapToGrid(objs, S.grid, lock()));
  setCursor(`snapped each object to grid ${S.grid}`);
}
function snapAll() {
  const bs = movable().map(V.boundsOf), t = [0, 1, 2].map(k => { const x = Math.min(...bs.map(b => b[0][k])); return Math.round(x / S.grid) * S.grid - x; });
  if (t.some(Boolean)) transformSel([1, 1, 1], t);
  setCursor(`snapped the selection to grid ${S.grid}`);
}

export function mount() {
  addEventListener('pointerover', e => {
    const p = e.target.closest?.('#v-top, #v-front, #v-side, #v-3d');
    if (p) active = p.id === 'v-3d' ? null : p.id.slice(2);
  });
  const any = () => sel.size > 0, solids = () => [...sel].some(n => n.name === 'solid');
  const cmds = [
    ['brush.carve', 'Carve with selection', carveSel, ['ctrl+shift+c'], solids],
    ['brush.hollow', 'Make hollow...', hollowDialog, [], solids],
    ['brush.transform', 'Transform...', transformDialog, ['ctrl+m'], any],
    ['brush.flipH', 'Flip horizontal', () => flip(0), ['ctrl+l'], any],
    ['brush.flipV', 'Flip vertical', () => flip(1), ['ctrl+i'], any],
    ['align.left', 'Align: left', () => align('min', 0), [], any],
    ['align.right', 'Align: right', () => align('max', 0), [], any],
    ['align.top', 'Align: top', () => align('max', 1), [], any],
    ['align.bottom', 'Align: bottom', () => align('min', 1), [], any],
    ['align.center', 'Align: center', () => align('center', 0, 1), [], any],
    ['brush.snapToGrid', 'Snap selection to grid individually', snapGrid, ['ctrl+shift+b'], any],
    ['brush.snapSelection', 'Snap selection to grid (as one)', snapAll, [], any],
    ['brush.merge', 'Brush: merge into one (convex hull)', merge, [], () => [...sel].filter(n => n.name === 'solid').length > 1],
  ];
  for (const [id, title, run, keys, when] of cmds) register(id, { title, run, keys, when });
  // state cloneSel reads it: a lone path_track / path_corner clone goes into its path
  register('path.autoLink', {
    title: 'Paths: link cloned path nodes into the path (toggle)',
    run: () => { setCfg('pathAutoLink', cfg.pathAutoLink === false); setCursor(`path node clones ${cfg.pathAutoLink ? 'go into the path' : 'stay unlinked'}`); },
    on: () => cfg.pathAutoLink !== false,
  });
}
