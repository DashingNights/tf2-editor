// Blockout mode (Ctrl+B): toolbar over the 3D view, draw primitives in 3D (drag a footprint on a surface, move the
// mouse for the height, click), presets, repeat duplicate, nodraw on hidden faces. Stairs or a ramp between two
// picked edges is a tool of its own (stairtool.js). Dev textures for new brushes are
// applied by state.js while cfg.blockout is on.
import * as THREE from 'three';
import * as V from '../vmf.js';
import * as P from './primitives.js';
import { rayAt, setDrawHook, addHelper, removeHelper, invalidate, fan } from './view3d.js';
import { on } from './bus.js';
import { S, doc, sel, cache, edit, nextId, cloneSel, transformSel, mergeUndo, addSolids, setCursor } from './state.js';
import { register } from './commands.js';
import { cfg, setCfg } from './settings.js';
import { el } from './dom.js';
import { slot } from './tools.js';
import { ask } from './dialog.js';
import { getVmt } from './materials.js';

export const PRESETS = [
  { name: 'Box', type: 'box' },
  { name: 'Ramp, rising along the drag', type: 'ramp', dir: 'auto' },
  { name: 'Stairs, 16 high steps', type: 'stairs', count: 0, step: 16, solid: true, dir: 'auto' },
  { name: 'Stairs, 8 steps', type: 'stairs', count: 8, step: 16, solid: true, dir: 'auto' },
  { name: 'Cylinder, 16 sides', type: 'cylinder', sides: 16 },
  { name: 'Pillar, 8 sides', type: 'cylinder', sides: 8 },
  { name: 'Arch, 8 segments', type: 'arch', segments: 8, thickness: 16 },
  { name: 'Doorway 96 x 128', type: 'doorway', width: 96, height: 128, thickness: 16 },
  { name: 'Room, 16 thick walls', type: 'room', thickness: 16 },
];
const presets = () => cfg.blockoutPresets ?? PRESETS;
const NAMES = { box: 'Box', ramp: 'Ramp', stairs: 'Stairs', cylinder: 'Cylinder', arch: 'Arch', doorway: 'Doorway', room: 'Room' };
const LABELS = { dir: 'Rises toward', count: 'Steps (0: from step height)', step: 'Step height', solid: 'Solid back', sides: 'Sides',
  segments: 'Segments', thickness: 'Thickness', width: 'Opening width (0: from thickness)', height: 'Opening height (0: from thickness)' };
let cur = PRESETS[0], bar = null, presetSel = null;

// ---------- nodraw on hidden faces (pure) ----------
const flat = (pts, k) => pts.map(p => [p[(k + 1) % 3], p[(k + 2) % 3]]);
const area = poly => poly.reduce((s, p, i) => { const q = poly[(i + 1) % poly.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
// The part of convex poly left of a->b (side 1) or right of it (side -1).
function half(poly, a, b, side) {
  const out = [], f = p => side * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
  poly.forEach((p, i) => {
    const q = poly[(i + 1) % poly.length], fp = f(p), fq = f(q);
    if (fp >= 0) out.push(p);
    if (fp * fq < 0) { const t = fp / (fp - fq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
  });
  return out;
}
// Convex pieces of convex polygon p outside convex polygon g.
function minus(p, g) {
  if (area(g) < 0) g = [...g].reverse();
  const out = [];
  for (let i = 0; i < g.length && p.length > 2; i++) {
    const a = g[i], b = g[(i + 1) % g.length], o = half(p, a, b, -1);
    if (Math.abs(area(o)) > 1e-3) out.push(o);
    p = half(p, a, b, 1);
  }
  return out;
}
const planeKey = (k, s, c) => `${k}${s}${Math.round(c * 100)}`;
const axisOf = f => f.n.findIndex(x => Math.abs(x) > 0.999);

const disp = s => V.kids(s, 'dispinfo').length > 0;
// 2D bounds [u0, v0, u1, v1] of flat points; apart: the bounds overlap by no more than an edge.
const box2 = ps => [0, 1, 0, 1].map((i, j) => (j < 2 ? Math.min : Math.max)(...ps.map(p => p[i])));
const apart = (a, b) => a[0] >= b[2] - 1e-3 || b[0] >= a[2] - 1e-3 || a[1] >= b[3] - 1e-3 || b[1] >= a[3] - 1e-3;

// Sides of the targets' axis-aligned faces that coplanar, opposite-facing faces of other solids cover completely.
// targets, others: { node, faces } (cache entries). covers(solid): whether that solid hides what is behind it.
// Displacements neither cover (vbsp drops the other sides of a displacement brush) nor get covered.
export function hiddenSides(targets, others, covers = () => true) {
  const idx = new Map();
  for (const c of others) if (covers(c.node) && !V.kids(c.node, 'side').some(disp)) for (const f of c.faces) {
    const k = axisOf(f), id = k >= 0 && planeKey(k, Math.sign(f.n[k]), f.pts[0][k]), g = id && flat(f.pts, k);
    if (id) (idx.get(id) ?? idx.set(id, []).get(id)).push([c.node, g, box2(g)]);
  }
  const out = [];
  for (const c of targets) for (const f of c.faces) {
    const k = axisOf(f);
    if (k < 0 || disp(f.side)) continue;
    let rest = [flat(f.pts, k)];
    for (const [n, g, gb] of idx.get(planeKey(k, -Math.sign(f.n[k]), f.pts[0][k])) ?? []) {
      if (n !== c.node && rest.length) rest = rest.flatMap(p => (apart(box2(p), gb) ? [p] : minus(p, g)));
    }

    if (!rest.length) out.push(f.side);
  }
  return out;
}

const NODRAW = 'TOOLS/TOOLSNODRAW';
const SEE_THROUGH = /^tools\/tools(trigger|\w*clip|skip|hint|invisible|areaportal|occluder|fog|blockbullets|blocklight|block_los|\w*ladder)/;
const matOf = s => (V.get(s, 'material') || '').toLowerCase().replace(/\\/g, '/');

// Whether a face with material name (lower case) and VMT params p (materials.js getVmt; null when unknown) lets the
// view through: see-through tools, water, glass and other refracting, translucent, alpha-tested or faded materials.
export const seeThrough = (name, p) => SEE_THROUGH.test(name) || (!!p && (/^(water|refract)$/.test(p.shader)
  || p.translucent || p.alphatest || p.additive || parseFloat(p.kv?.get('$alpha') ?? 1) < 1));

// Selected brushes: nodraw on faces that world or func_detail brushes cover. A brush with any see-through face covers
// nothing (a water brush has nodraw on its other sides). One undo step.
async function nodrawHidden() {
  const solid = c => c && !c.point, targets = [...sel].map(n => cache.get(n)).filter(solid);
  const near = c => targets.some(t => [0, 1, 2].every(k => c.min[k] <= t.max[k] && t.min[k] <= c.max[k]));
  const others = [...cache.values()].filter(c => solid(c) && near(c) && (c.owner === doc.world || V.get(c.owner, 'classname') === 'func_detail'));
  const names = [...new Set(others.flatMap(c => V.kids(c.node, 'side').map(matOf)))];
  const vmt = new Map(await Promise.all(names.map(async n => [n, await getVmt(n).catch(() => null)])));
  const opaque = n => !V.kids(n, 'side').some(s => seeThrough(matOf(s), vmt.get(matOf(s))));
  const sides = hiddenSides(targets, others, opaque).filter(s => matOf(s) !== 'tools/toolsnodraw');
  if (sides.length) edit(targets.map(c => c.node), [], () => sides.forEach(s => V.set(s, 'material', NODRAW)));
  setCursor(`nodraw: ${sides.length} hidden face(s)`);
}

// Clone the selection and move it by the offset of the last move that followed a clone (in place when there is none).
function repeatDup() {
  const t = S.lastDup;
  cloneSel();
  if (t) { transformSel([1, 1, 1], t); mergeUndo(); }
  setCursor(t ? `duplicated, offset ${t.join(' ')}` : 'duplicated in place (move the copy to set the repeat offset)');
}

// ---------- draw in 3D ----------
// draw: footprint corners a, b on the plane where axis k = c; h: height along +k; busy: the footprint is down and the
// mouse sets the height.
let draw = null, ghost = null;
const step = () => (cfg.snapGrid === false ? 1 : S.grid);
const sn = (x, g) => Math.round(x / g) * g;
const GHOST = new THREE.MeshBasicMaterial({ color: 0x4f8cff, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
const EDGE = new THREE.LineBasicMaterial({ color: 0x9cc0ff });

function showGhost(faces) {
  if (ghost) { removeHelper(ghost); ghost.children.forEach(o => o.geometry.dispose()); }
  ghost = null;
  if (!faces) return invalidate();
  const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(fan(faces), 3));
  addHelper((ghost = new THREE.Group().add(new THREE.Mesh(g, GHOST), new THREE.LineSegments(new THREE.EdgesGeometry(g, 1), EDGE))));
}

function rect() {
  const { a, b, k } = draw, i = (k + 1) % 3, j = (k + 2) % 3, at = (u, v) => { const p = [...a]; p[i] = u; p[j] = v; return p; };
  return [at(a[i], a[j]), at(b[i], a[j]), at(b[i], b[j]), at(a[i], b[j])];
}

function region() {
  const { a, b, k, c, h } = draw, mn = a.map((x, i) => Math.min(x, b[i])), mx = a.map((x, i) => Math.max(x, b[i]));
  [mn[k], mx[k]] = [Math.min(c, c + h), Math.max(c, c + h)];
  return [mn, mx];
}

// The current primitive in the drawn box. 'auto' ramps and stairs rise in the drag direction along the longer
// horizontal axis (drawn on a wall: toward the wall).
function pieces(ids) {
  const [mn, mx] = region(), o = { ...P.TYPES[cur.type], ...cur, grid: step() };
  if (o.dir === 'auto') {
    const ax = mx[0] - mn[0] >= mx[1] - mn[1] ? 0 : 1, s = Math.sign(draw.b[ax] - draw.a[ax]) || -Math.sign(draw.h) || 1;
    o.dir = (s > 0 ? '+' : '-') + 'xy'[ax];
  }
  return P.make(cur.type, mn, mx, o, cfg.material, ids);
}

function preview() {
  const [mn, mx] = region(), size = mx.map((x, i) => x - mn[i]).filter((_, i) => i !== draw.k || draw.busy);
  const ps = draw.busy && draw.h ? pieces(() => '0') : [];
  showGhost(ps.length ? ps.flatMap(V.faces) : [{ pts: rect() }]);
  setCursor(draw.busy ? `${cur.name} ${size.join(' x ')} - click to place, Esc cancels` : `footprint ${size.join(' x ')}`);
}

function cancelDraw(msg) {
  draw = null;
  showGhost(null);
  if (msg) setCursor(msg);
}

// The footprint lies on the axis plane closest to the hit face: at the face itself when it is axis-aligned, else at
// the snapped hit point.
function start(hit) {
  const n = hit.face.n, k = [0, 1, 2].reduce((a, i) => (Math.abs(n[i]) > Math.abs(n[a]) ? i : a), 0), g = step();
  const c = Math.abs(n[k]) > 0.999 ? Math.round(hit.face.pts[0][k] * 1000) / 1000 : sn(hit.point.getComponent(k), g);
  const a = hit.point.toArray().map((x, i) => (i === k ? c : sn(x, g)));
  draw = { k, c, a, b: [...a], h: 0, busy: false };
  preview();
  return true;
}

function footMove(x, y) {
  const r = rayAt(x, y), d = draw, dk = r.direction.getComponent(d.k), t = (d.c - r.origin.getComponent(d.k)) / dk;
  if (!Number.isFinite(t) || t <= 0) return;
  d.b = r.at(t, new THREE.Vector3()).toArray().map((v, i) => (i === d.k ? d.c : sn(v, step())));
  preview();
}

// Height: the point on the line through b along axis k closest to the mouse ray (as push/pull in view3d).
function heightMove(x, y) {
  const r = rayAt(x, y), n = new THREE.Vector3().setComponent(draw.k, 1), w = new THREE.Vector3(...draw.b).sub(r.origin);
  const bd = n.dot(r.direction), den = 1 - bd * bd;
  if (den < 1e-4) return;
  const h = sn((bd * r.direction.dot(w) - n.dot(w)) / den, step());
  if (h !== draw.h) { draw.h = h; preview(); }
}

function up() {
  if (!draw) return;
  const { a, b, k } = draw;
  if ([0, 1, 2].some(i => i !== k && a[i] === b[i])) return cancelDraw('footprint too small');
  draw.busy = true;
  preview();
}

function press() {
  if (!draw.h) return cancelDraw('blockout: no height, nothing placed');
  const test = pieces(() => '0');
  if (!test.length || !test.every(V.valid)) return setCursor(`${cur.name} does not fit in this box - change the height or Esc`);
  const ps = pieces(nextId), name = cur.name;
  cancelDraw();
  addSolids(ps);
  setCursor(`${name}: ${ps.length} brush(es)`);
}

const hook = {
  start, up, press, cancel: () => cancelDraw('blockout: cancelled'),
  move: (x, y) => (draw?.busy ? heightMove(x, y) : draw && footMove(x, y)),
  get busy() { return !!draw?.busy; },
};

// ---------- toolbar and presets ----------
function choose(p) {
  cur = p;
  if (draw?.busy) preview();
  refresh();
}
const chooseType = t => choose(presets().find(p => p.type === t) ?? { name: NAMES[t], type: t });

function refresh() {
  if (!bar) return;
  bar.hidden = !cfg.blockout;
  for (const b of bar.querySelectorAll('[data-type]')) b.classList.toggle('on', b.dataset.type === cur.type);
  presetSel.replaceChildren(...presets().map((p, i) => el('option', { value: i, textContent: p.name })));
  presetSel.selectedIndex = presets().indexOf(cur);
}

function apply() {
  setDrawHook(cfg.blockout ? hook : null);
  if (!cfg.blockout && draw) cancelDraw();
  refresh();
}

function toggle() {
  setCfg('blockout', !cfg.blockout);
  setCursor(`blockout ${cfg.blockout ? 'on: drag on a surface to draw' : 'off'}`);
}

// Edits the current preset: Save replaces it (or adds it when it is not in the list), Save as new adds a copy.
function editPreset() {
  const list = presets(), i = list.indexOf(cur), name = el('input', { value: cur.name, placeholder: 'Name' }), fields = el('div', { className: 'bo-fields' });
  const type = el('select', {}, ...Object.keys(P.TYPES).map(t => el('option', { value: t, textContent: NAMES[t] })));
  type.value = cur.type;
  const fill = () => fields.replaceChildren(...Object.entries(P.TYPES[type.value]).map(([k, v]) => {
    const val = type.value === cur.type ? cur[k] ?? v : v;
    const input = typeof v === 'boolean' ? el('input', { type: 'checkbox', checked: !!val })
      : k === 'dir' ? el('select', {}, ...P.DIRS.map(d => el('option', { value: d, textContent: d })))
        : el('input', { type: 'number', min: 0, step: 1, value: val });
    input.value = typeof v === 'boolean' ? 'on' : val;
    input.name = k;
    return el('label', {}, el('span', { textContent: LABELS[k] ?? k }), input);
  }));
  type.onchange = fill;
  fill();
  const read = () => {
    const p = { name: name.value.trim() || NAMES[type.value], type: type.value };
    for (const f of fields.querySelectorAll('[name]')) p[f.name] = f.type === 'checkbox' ? f.checked : f.type === 'number' ? Math.max(0, +f.value || 0) : f.value;
    return p;
  };
  const save = (l, p) => { setCfg('blockoutPresets', l); choose(p); dlg.close(); };
  const btn = (text, fn, cls = '') => el('button', { textContent: text, className: cls, onclick: fn });
  const dlg = document.body.appendChild(el('dialog', { className: 'bo-presets' }, el('h3', { textContent: 'Blockout preset' }),
    el('div', { className: 'bo-fields' }, el('label', {}, el('span', { textContent: 'Name' }), name), el('label', {}, el('span', { textContent: 'Primitive' }), type)), fields,
    el('div', { className: 'row' },
      btn('Save', () => { const p = read(); save(i < 0 ? [...list, p] : list.map((x, j) => (j === i ? p : x)), p); }, 'primary'),
      btn('Save as new', () => { const p = read(); save([...list, p], p); }),
      btn('Delete', async () => {
        if ((await ask(`Delete the preset ${cur.name}?`, ['Delete', 'Cancel'])) !== 0) return;
        const l = list.filter((_, j) => j !== i);
        save(l, l[0] ?? { name: 'Box', type: 'box' });
      }),
      btn('Reset all', async () => { if ((await ask('Reset all blockout presets to the built-in ones?', ['Reset', 'Cancel'])) === 0) save(null, PRESETS[0]); }),
      btn('Cancel', () => dlg.close()))));
  dlg.querySelector('.row button:nth-child(3)').disabled = i < 0;
  dlg.onclose = () => dlg.remove();
  dlg.showModal();
}

// el3d: the 3D pane (#v-3d). Mount after view3d.
export function mount(el3d) {
  const cmdBtn = (text, cmd, title) => { const b = el('button', { textContent: text, title }); b.dataset.cmd = cmd; return b; };
  presetSel = el('select', { title: 'Preset', onchange: () => { choose(presets()[presetSel.selectedIndex] ?? cur); presetSel.blur(); } });
  bar = el('div', { className: 'blockout', hidden: true },
    el('span', { className: 'chip', textContent: 'BLOCKOUT', title: 'Blockout mode (Ctrl+B). Drag on a surface, move the mouse for the height, click to place.' }),
    ...Object.keys(P.TYPES).map(t => {
      const b = el('button', { textContent: NAMES[t], title: `Draw ${NAMES[t].toLowerCase()}: drag a footprint, release, move for the height, click`, onclick: () => { chooseType(t); b.blur(); } });
      b.dataset.type = t;
      return b;
    }),
    presetSel, el('button', { textContent: 'Edit', title: 'Edit the current preset', onclick: e => { e.currentTarget.blur(); editPreset(); } }),
    cmdBtn('Repeat', 'blockout.repeat', 'Clone the selection with the offset of the last moved copy (Ctrl+D)'),
    cmdBtn('func_detail', 'tie.detail', 'Tie the selection to func_detail (Ctrl+T)'),
    cmdBtn('Nodraw', 'blockout.nodraw', 'Nodraw on faces of the selected brushes that other brushes cover'));
  slot('blockout', 'Blockout').append(bar);
  cur = presets()[0] ?? cur;
  apply();
  // Every path that changes blockout mode (Ctrl+B, Settings, Reset to defaults) turns the slope tint on or off with it;
  // view.slopeTint flips it in between.
  on('cfg', ({ key }) => {
    if (key === 'blockout') { setCfg('slopeTint', !!cfg.blockout); apply(); }
    else if (key === 'blockoutPresets') refresh();
  });
  on('file', () => draw && cancelDraw());

  const any = () => sel.size > 0;
  register('blockout.toggle', { title: 'Blockout mode (toggle)', keys: ['ctrl+b'], run: toggle, on: () => !!cfg.blockout });
  register('blockout.repeat', { title: 'Repeat duplicate (clone with the last offset)', keys: ['ctrl+d'], when: any, run: repeatDup });
  register('blockout.nodraw', { title: 'Nodraw on hidden faces of the selection', when: any, run: nodrawHidden });
  for (const t of Object.keys(P.TYPES)) register(`blockout.${t}`, { title: `Blockout: draw ${NAMES[t].toLowerCase()}`, run: () => { chooseType(t); if (!cfg.blockout) toggle(); } });
}
