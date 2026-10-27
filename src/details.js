// Details panel (Unreal-style): selection header with search, Transform, Brush, Face, Entity (built from the FGD),
// Outputs/Inputs, and the defaults for new objects. Every change is one state.edit(), so one undo step.
import * as V from '../vmf.js';
import * as F from './fgd.js';
import { on } from './bus.js';
import { S, doc, sel, faceSel, cache, edit, setSelection, setPreview, applyMaterial, matName, selBox, selFrame, turnZ, rotateSel, tieSel, objects, groupOf } from './state.js';
import { register } from './commands.js';
import { cfg, setCfg } from './settings.js';
import { el } from './dom.js';

const api = window.api;

// ---------- pure helpers ----------
// + - * / and parentheses. NaN when s is not a valid expression.
export function calc(s) {
  const t = s.match(/\d+\.?\d*|\.\d+|\S/g) ?? [];
  let i = 0;
  const atom = () => {
    const x = t[i++];
    if (x === '(') { const v = sum(); return t[i++] === ')' ? v : NaN; }
    if (x === '-') return -atom();
    if (x === '+') return atom();
    return /^[\d.]/.test(x ?? '') ? +x : NaN;
  };
  const prod = () => { let v = atom(); while (t[i] === '*' || t[i] === '/') v = t[i++] === '*' ? v * atom() : v / atom(); return v; };
  const sum = () => { let v = prod(); while (t[i] === '+' || t[i] === '-') v = t[i++] === '+' ? v + prod() : v - prod(); return v; };
  const v = sum();
  return i === t.length && Number.isFinite(v) ? v : NaN;
}

// Field text -> (old => new). '+64' adds, '*2' and '/2' scale, '=128*3' or '384' set. null when invalid.
export function parseVal(s) {
  s = s.trim();
  const op = s[0], rel = s.length > 1 && '+*/'.includes(op), v = calc(rel || op === '=' ? s.slice(1) : s);
  if (!s || Number.isNaN(v)) return null;
  return op === '+' && rel ? x => x + v : op === '*' ? x => x * v : op === '/' ? x => x / v : () => v;
}

// The point of a box that stays fixed while resizing: 'center', 'min' or 'bottom' (bottom center).
export const anchorOf = (mn, mx, a) => mn.map((x, k) => (a === 'min' || (a === 'bottom' && k === 2) ? x : (x + mx[k]) / 2));

// Scale and translate that give the box [mn, mx] the sizes `size`, keeping its anchor point fixed.
export function resizeXf(mn, mx, size, anchor) {
  const a = anchorOf(mn, mx, anchor), s = size.map((x, k) => x / (mx[k] - mn[k]));
  return { s, t: a.map((x, k) => x * (1 - s[k])) };
}

// Connection value 'target,input,param,delay,times' (newer Hammer separates with ESC). The parameter may hold commas.
export function parseConn([out, v]) {
  const sep = v.includes('\x1b') ? '\x1b' : ',', p = v.split(sep);
  const times = p.length > 4 ? p.pop() : '-1', delay = p.length > 3 ? p.pop() : '0', [target = '', input = '', ...param] = p;
  return { out, target, input, param: param.join(sep), delay, times, sep };
}
export const joinConn = c => [c.target, c.input, c.param, c.delay, c.times].join(c.sep);

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = a => { const l = Math.hypot(...a) || 1; return a.map(x => x / l); };
// Rodrigues: v turned deg degrees about the unit axis k.
const turn = (v, k, deg) => {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r), d = dot(k, v), x = cross(k, v);
  return v.map((vi, i) => vi * c + x[i] * s + k[i] * d * (1 - c));
};

// Texture justify on one axis {v, shift, scale}. pts: face polygon; size: texture size in texels on that axis.
export function fitAxis(a, pts, size, mode, lo, hi) {
  if (![lo, hi, 'fit', 'center'].includes(mode)) return;
  const w = pts.map(p => dot(p, a.v));
  if (mode === 'fit') a.scale = Math.sign(a.scale || 1) * (Math.max(...w) - Math.min(...w)) / size || a.scale;
  const t = w.map(x => x / a.scale), mn = Math.min(...t), mx = Math.max(...t);
  const sh = mode === hi ? size - mx : mode === 'center' ? (size - mn - mx) / 2 : -mn;
  a.shift = ((sh % size) + size) % size;
}

// ---------- module state ----------
const HTML = `
<div class="dt-head"><div class="selinfo"></div><input class="search" type="search" placeholder="Search properties" spellcheck="false"></div>
<div class="dt-body"></div>
<datalist id="mats"></datalist><datalist id="classes"></datalist><datalist id="d-targets"></datalist>`;

const MIX = '\0mixed', ANCHORS = [['center', 'Center'], ['min', 'Min corner'], ['bottom', 'Bottom center']];
const COMMON = ['func_detail', 'func_brush', 'func_door', 'func_illusionary', 'func_nobuild', 'func_respawnroom', 'func_regenerate', 'trigger_multiple', 'trigger_once', 'trigger_hurt', 'trigger_push', 'trigger_capture_area'];
const TARGET = new Set(['target_destination', 'target_name_or_class', 'filterclass']), SKIP = new Set(['id', 'classname', 'origin']);
// Field steps [normal, Shift, Ctrl]. Snapping off: 1 unit or 1 degree.
const GRID = () => (cfg.snapGrid ? [S.grid, 1, S.grid * 4] : [1, 1, S.grid]);
const DEG = () => (cfg.snapRotation ? [+cfg.rotationStep || 15, +cfg.rotationStepFine || 5, 45] : [1, 1, 15]);

let host, body, search, fgd = null, raw = false, tab = 'out', picking = null, raf = 0, ents = [];
const defs = new Map(), closed = new Set();
const def = cls => { if (fgd && cls && !defs.has(cls)) defs.set(cls, F.resolve(fgd, cls)); return defs.get(cls) ?? null; };
const later = () => { raf ||= requestAnimationFrame(() => { raf = 0; render(); }); };
// Map properties (state.showWorld): worldspawn's keys while nothing is selected.
const world = () => S.showWorld && !sel.size && !!doc.world;
const mats = () => import('./materials.js').catch(() => null);
// The Textures panel (searching for name), and its Recent list.
const browse = name => import('./texbrowser.js').then(T => T.browse(name));
const remember = name => import('./texbrowser.js').then(T => T.remember(name)).catch(() => {});
const applyMat = name => { if ([...sel].some(x => x.name === 'solid')) { applyMaterial(name); remember(name); } };
// 22 px thumbnail of material m (none while m is undefined: a mixed selection).
function thumbOf(m) {
  const t = el('img', { className: 'thumb', alt: '' });
  if (m) mats().then(M => M?.thumbnail?.(m, 32)).then(u => u && (t.src = u)).catch(() => {});
  return t;
}

const fmt = x => String(Math.round(x * 1000) / 1000);
const f6 = x => String(Math.round(x * 1e6) / 1e6);
const snap = x => Math.round(x / S.grid) * S.grid;
const same = vals => (vals.length && vals.every(v => v === vals[0]) ? vals[0] : undefined);
const stepOf = (e, [n, fine, coarse]) => (e.shiftKey ? fine : e.ctrlKey ? coarse : n);
const axisVec = (k, d) => [0, 1, 2].map(j => (j === k ? d : 0));
const angs = (e, key) => { const a = V.nums(V.get(e, key) ?? ''); return [0, 1, 2].map(i => a[i] || 0); };
// Keys every entity in the list has, in the first entity's order.
const sharedKeys = list => list.reduce((ns, e) => ns.filter(n => e.kv.some(p => p[0] === n)), [...new Set(list[0].kv.map(p => p[0]))]);

// Entity names are case-insensitive; 'name*' matches a prefix; a classname also works as a target.
function hits(t, e) {
  t = t.toLowerCase();
  const n = (V.get(e, 'targetname') || '').toLowerCase();
  return t.endsWith('*') ? !!n && n.startsWith(t.slice(0, -1)) : t === n || t === (V.get(e, 'classname') || '').toLowerCase();
}
const broken = t => !!t && !t.startsWith('!') && !ents.some(e => hits(t, e));

// ---------- edits (each is one undo step) ----------
// fn(entity) -> new value, or undefined to leave it.
function setKey(list, key, fn) {
  const ch = list.map(e => [e, fn(e)]).filter(([e, v]) => v !== undefined && V.get(e, key) !== v);
  if (ch.length) edit([], ch.map(x => x[0]), () => ch.forEach(([e, v]) => V.set(e, key, v)));
}
function delKey(list, key) {
  const ch = list.filter(e => V.get(e, key) !== undefined);
  if (ch.length) edit([], ch, () => ch.forEach(e => e.kv.splice(e.kv.findIndex(p => p[0] === key), 1)));
}

// items: [node, {s, t}]. Skips invalid and no-op transforms.
// items: [node, { s, t, yaw }]: p' = p * s + t, in the frame turned by yaw degrees about z when yaw is set (local axes).
function xform(items) {
  items = items.filter(([, { s, t }]) => [...s, ...t].every(Number.isFinite) && s.every(x => x > 0) && (s.some(x => x !== 1) || t.some(x => x !== 0)));
  const lock = cfg.texLock !== false, O = [0, 0, 0];
  if (items.length) edit(items.map(x => x[0]), [], () => items.forEach(([n, { s, t, yaw }]) => {
    if (yaw) V.rotate(n, O, 2, -yaw, lock);
    V.transform(n, s, t, lock);
    if (yaw) V.rotate(n, O, 2, yaw, lock);
  }));
}

// About axis k through the anchor point: the world axes, or the selection's own (local axes: x and y turned by its yaw).
function rotate(k, deg) {
  if (!deg || !Number.isFinite(deg)) return;
  const { yaw, box } = selFrame();
  rotateSel(yaw && k < 2 ? turnZ(axisVec(k, 1), yaw) : k, deg, turnZ(anchorOf(box[0], box[1], cfg.anchor || 'center'), yaw));
}

const connsOf = e => V.kids(e, 'connections')[0];
function setConn(ent, i, k, v) {
  const conn = connsOf(ent), p = conn?.kv[i];
  if (!p) return;
  const c = parseConn(p);
  if (c[k] === v) return;
  c[k] = v;
  edit([], [conn], () => { p[0] = c.out; p[1] = joinConn(c); });
}
function addConn(ent, out) {
  const conn = connsOf(ent);
  tab = 'out';
  edit([], [conn ?? ent], () => {
    if (conn) conn.kv.push([out, ',,,0,-1']);
    else ent.children.unshift({ name: 'connections', kv: [[out, ',,,0,-1']], children: [] });
  });
}
function delConn(ent, i) {
  const conn = connsOf(ent);
  edit([], [ent, conn], () => { conn.kv.splice(i, 1); if (!conn.kv.length) ent.children.splice(ent.children.indexOf(conn), 1); });
}

// ---------- faces ----------
const tex = (s, k) => { const a = V.nums(V.get(s, k)); return { v: a.slice(0, 3), shift: a[3] ?? 0, scale: a[4] || 0.25 }; };
const setTex = (s, k, a) => V.set(s, k, `[${[...a.v, a.shift].map(f6).join(' ')}] ${f6(a.scale)}`);
const worldAxes = n => { const [x, y, z] = n.map(Math.abs); return z >= x && z >= y ? [[1, 0, 0], [0, -1, 0]] : x >= y ? [[0, 1, 0], [0, 0, -1]] : [[1, 0, 0], [0, 0, -1]]; };
const faceAxes = n => { const u = unit(cross(Math.abs(n[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1], n)); return [u, cross(u, n)]; };

// side -> { solid, face } for the selected faces.
function facesOf() {
  const m = new Map();
  for (const c of cache.values()) for (const f of c.faces) if (faceSel.has(f.side)) m.set(f.side, { solid: c.node, face: f });
  return m;
}
function editFaces(fn) {
  const m = facesOf();
  if (m.size) edit([...new Set([...m.values()].map(h => h.solid))], [], () => m.forEach((h, s) => fn(s, h.face)));
}

// Every face of the given brushes, as facesOf() gives the selected faces.
const facesOfSolids = solids => { const m = new Map(); for (const n of solids) for (const f of cache.get(n)?.faces ?? []) m.set(f.side, { solid: n, face: f }); return m; };
// Justifies faces ({ side, pts, n }) in sets, each set as one surface (Hammer's Treat as one): faces of one unit
// (unitOf: their group, the whole selection, or the face itself) with the same material, texture axes and scale,
// facing the same way, get one fit or alignment over all their corners, so the texture runs on across them.
// sizeOf(material) -> { w, h } in texels.
export function justifyFaces(faces, mode, sizeOf, unitOf = f => f.side) {
  const units = new Map(), sets = new Map(), r = (a, d = 3) => a.map(x => (Math.round(x * 10 ** d) / 10 ** d || 0)).join(',');
  for (const f of faces) {
    const u = tex(f.side, 'uaxis'), v = tex(f.side, 'vaxis'), unit = unitOf(f);
    if (!units.has(unit)) units.set(unit, units.size);
    const k = [units.get(unit), V.get(f.side, 'material'), r(u.v), r(v.v), r([u.scale, v.scale], 5), r(f.n, 2)].join('|');
    (sets.get(k) ?? sets.set(k, []).get(k)).push(f);
  }
  for (const list of sets.values()) {
    const sz = sizeOf(V.get(list[0].side, 'material')), pts = list.flatMap(f => f.pts), u = tex(list[0].side, 'uaxis'), v = tex(list[0].side, 'vaxis');
    fitAxis(u, pts, sz.w, mode, 'left', 'right');
    fitAxis(v, pts, sz.h, mode, 'top', 'bottom');
    for (const f of list) {
      setTex(f.side, 'uaxis', { ...tex(f.side, 'uaxis'), shift: u.shift, scale: u.scale });
      setTex(f.side, 'vaxis', { ...tex(f.side, 'vaxis'), shift: v.shift, scale: v.scale });
    }
  }
}
// The selected faces, or with hits every face of some brushes. Faces of one group justify as one surface; with Treat
// as one (cfg.justifyAsOne), so do all the selected faces. Texture sizes are loaded first (512x512 when a material
// has no texture).
async function justify(mode, hits = facesOf(), all = cfg.justifyAsOne) {
  const M = await mats(), names = [...new Set([...hits.keys()].map(s => V.get(s, 'material')))];
  const sizes = new Map(await Promise.all(names.map(async n => [n, (await M?.textureSize?.(n).catch(() => null)) ?? M?.getTextureSize?.(n) ?? { w: 512, h: 512 }])));
  if (!hits.size) return;
  const faces = [...hits].map(([side, h]) => ({ side, pts: h.face.pts, n: h.face.n, solid: h.solid }));
  edit([...new Set([...hits.values()].map(h => h.solid))], [], () => justifyFaces(faces, mode, m => sizes.get(m), f => (all ? 'all' : groupOf(f.solid) ?? f.side)));
}
function align(mode) {
  editFaces(s => {
    const u = tex(s, 'uaxis'), v = tex(s, 'vaxis');
    [u.v, v.v] = (mode === 'world' ? worldAxes : faceAxes)(V.plane(s).n);
    setTex(s, 'uaxis', u);
    setTex(s, 'vaxis', v);
    V.set(s, 'rotation', '0');
  });
}

// ---------- controls ----------
function input(id, value, { list, cls = '' } = {}) {
  const i = el('input', { className: cls, value: value ?? '', placeholder: value === undefined ? '--' : '', spellcheck: false });
  i.dataset.f = id;
  if (list) i.setAttribute('list', list);
  if (list) i.title = value ?? ''; // material and class names are often longer than the field
  // VMF strings cannot hold quotes. Added before the caller's onchange, so it runs first.
  i.addEventListener('change', () => { i.value = i.value.replaceAll('"', ''); });
  // Enter commits (change fires on blur) and hands the keyboard back to the editor, so Ctrl+Z undoes the edit.
  i.onkeydown = e => {
    if (e.key === 'Escape') i.value = value ?? '';
    if (e.key === 'Escape' || e.key === 'Enter') i.blur();
  };
  return i;
}

function dropdown(id, opts, cur, set) {
  if (cur !== undefined && !opts.some(o => o[0] === cur)) opts = [[cur], ...opts];
  const s = el('select', {}, ...(cur === undefined ? [[MIX, '--'], ...opts] : opts).map(([v, t]) => el('option', { value: v, textContent: t ?? v })));
  s.value = cur ?? MIX;
  s.dataset.f = id;
  s.onchange = () => s.value !== MIX && set(s.value);
  return s;
}

const button = (text, title, onclick, cls = 'ib') => el('button', { className: cls, textContent: text, title, onclick });
const reset = (title, fn) => el('button', { className: 'ib', innerHTML: '&#8634;', title, onclick: fn });
const check = (id, checked, title, onchange) => { const c = el('input', { type: 'checkbox', checked, title, onchange }); c.dataset.f = id; return c; };
// Treat as one: Justify takes all the faces it works on as one surface (Hammer's Face Edit option), not only a group's.
const asOne = () => el('label', { className: 'asone', title: 'Treat as one: justify all these faces as one surface, not only the faces of each group' }, check('asone', !!cfg.justifyAsOne, 'Treat as one', () => setCfg('justifyAsOne', !cfg.justifyAsOne)), el('small', { textContent: 'as one' }));

// Numeric field over several targets: vals are the current numbers, apply(f) sets each target to f(old).
// axis: 0|1|2 adds a coloured label that scrubs the value; without one, the row's label does when the field is the
// row's only number (row()). preview(d) -> {s, t} shows a drag live.
function num(id, vals, apply, { axis, label, steps = GRID, preview } = {}) {
  const v = same(vals.map(fmt)), inp = input(id, v, { cls: 'num' }), esc = inp.onkeydown;
  inp.onchange = () => { const f = parseVal(inp.value); if (f) apply(f); later(); };
  inp.onkeydown = e => {
    esc(e);
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const d = stepOf(e, steps()) * (e.key === 'ArrowUp' ? 1 : -1);
    apply(x => x + d);
  };
  if (axis === undefined) { inp.scrubBy = lab => scrub(lab, inp, v, apply, steps, preview); return inp; }
  const lab = el('span', { className: 'ax ax' + axis, textContent: label ?? 'XYZ'[axis], title: 'Drag: change in steps (Shift fine, Ctrl coarse)' });
  scrub(lab, inp, v, apply, steps, preview);
  return el('span', { className: 'axf' }, lab, inp);
}

// Drag a label sideways: the field shows the value live, the edit is applied once on release.
function scrub(lab, inp, v, apply, steps, preview) {
  lab.onpointerdown = e => {
    if (e.button) return;
    e.preventDefault();
    lab.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    let d = 0;
    lab.onpointermove = e => {
      d = Math.round((e.clientX - x0) / 6) * stepOf(e, steps());
      inp.value = v === undefined ? (d < 0 ? '' : '+') + fmt(d) : fmt(+v + d);
      if (preview) setPreview((d && preview(d)) || null);
    };
    lab.onpointerup = lab.onpointercancel = e => {
      lab.onpointermove = lab.onpointerup = lab.onpointercancel = null;
      if (preview) setPreview(null);
      if (d && e.type === 'pointerup') apply(x => x + d);
      else inp.value = v ?? '';
    };
  };
}

function row(label, tip, ...ctl) {
  const lab = el('label', { textContent: label, title: tip || label }), nums = ctl.filter(c => c?.scrubBy);
  if (nums.length === 1) { nums[0].scrubBy(lab); lab.classList.add('scrub'); lab.title += ' (drag sideways: change in steps, Shift fine, Ctrl coarse)'; }
  const r = el('div', { className: 'dr' }, lab, el('div', { className: 'dc' }, ...ctl.filter(Boolean)));
  r.dataset.q = label.toLowerCase();
  return r;
}

function section(title, ...kids) {
  const d = el('details', { className: 'ds', open: !closed.has(title) }, el('summary', { textContent: title }), ...kids.filter(Boolean));
  d.ontoggle = () => (d.open ? closed.delete(title) : closed.add(title));
  return d;
}

// ---------- sections ----------
function header(cs) {
  const info = host.querySelector('.selinfo'), n = cs.length, faces = S.mode === 'face' ? `, ${faceSel.size} face${faceSel.size === 1 ? '' : 's'}` : '';
  if (world()) return info.replaceChildren(el('b', { textContent: 'World' }), ` (worldspawn), id ${V.get(doc.world, 'id')}`);
  const o = same(cs.map(c => c.owner)), cls = o && o !== doc.world && V.get(o, 'classname'), name = cls && V.get(o, 'targetname');
  if (cls) {
    const what = cs[0].point ? 'point entity' : n > 1 ? `${n} brushes` : 'brush';
    return info.replaceChildren(el('b', { textContent: name || cls }), ` ${name ? cls + ', ' : ''}${what}, id ${V.get(o, 'id')}${faces}`);
  }
  if (n === 1) return info.replaceChildren(el('b', { textContent: 'World brush' }), `, id ${V.get(cs[0].node, 'id')}${faces}`);
  const b = cs.filter(c => !c.point).length, k = same(cs.map(c => (c.owner === doc.world ? 'world brushes' : V.get(c.owner, 'classname'))));
  info.textContent = !n ? 'Nothing selected' + faces : `${n} selected: ${k ?? `${b} brushes, ${n - b} point entities`}${faces}`;
}

// Local axes (cfg.gizmoSpace, as the gizmo): sizes and the anchor in the selection's own frame (turned by its yaw about
// z: selFrame), resizes and rotations along its own axes; Location stays in world coordinates.
function transform(cs) {
  if (!cs.length) return null;
  const anchor = cfg.anchor || 'center', lock = !!cfg.sizeLock, solids = cs.filter(c => !c.point), points = cs.filter(c => c.point).map(c => c.node);
  const yaw = selFrame()?.yaw ?? 0;
  // an entry's box in the selection's frame: [min, max] turned by -yaw (yaw 0: its world box)
  const own = c => {
    if (!yaw) return [c.min, c.max];
    const lo = [Infinity, Infinity, c.min[2]], hi = [-Infinity, -Infinity, c.max[2]];
    for (const f of c.faces) for (const p of f.pts) { const q = turnZ(p, -yaw); for (const k of [0, 1]) { lo[k] = Math.min(lo[k], q[k]); hi[k] = Math.max(hi[k], q[k]); } }
    return [lo, hi];
  };
  const loc = c => (c.point ? V.nums(V.get(c.node, 'origin')) : turnZ(anchorOf(...own(c), anchor), yaw));
  const move = (k, f) => xform(cs.map(c => [c.node, { s: [1, 1, 1], t: axisVec(k, f(loc(c)[k]) - loc(c)[k]) }]));
  const rows = [row('Location', 'Anchor point of each object (origin for point entities)',
    ...[0, 1, 2].map(k => num('loc' + k, cs.map(c => loc(c)[k]), f => move(k, f), { axis: k, preview: d => ({ s: [1, 1, 1], t: axisVec(k, d) }) })),
    reset('Snap to grid', () => xform(cs.map(c => [c.node, { s: [1, 1, 1], t: loc(c).map(x => snap(x) - x) }]))))];

  rows.push(points.length === cs.length
    ? row('Rotation', 'angles key: X roll, Y pitch, Z yaw', ...[2, 0, 1].map((j, k) => angNum('rot' + k, points, 'angles', j, k)),
      reset('Reset to 0 0 0', () => setKey(points, 'angles', () => '0 0 0')))
    : row('Rotation', yaw ? 'Rotates the selection by this many degrees about its own axes through the anchor point' : 'Rotates the selection by this many degrees about the anchor point',
      ...[0, 1, 2].map(k => num('rot' + k, [0], f => rotate(k, f(0)), { axis: k, steps: DEG }))));

  if (solids.length) {
    const boxes = new Map(solids.map(c => [c, own(c)])), size = c => { const [lo, hi] = boxes.get(c); return hi.map((x, k) => x - lo[k]); };
    const sized = (c, k, v) => size(c).map((x, j) => (j === k ? v : lock ? (x * v) / size(c)[k] : x));
    const fit = (c, sz) => ({ ...resizeXf(...boxes.get(c), sz, anchor), yaw });
    const resize = (k, f) => xform(solids.map(c => [c.node, fit(c, sized(c, k, f(size(c)[k])))]));
    const one = cs.length === 1 && solids[0];
    rows.push(row('Size', yaw ? `Size along the selection's own axes (turned ${fmt(yaw)} degrees); the anchor point stays fixed` : 'Bounding box size; the anchor point stays fixed',
      ...[0, 1, 2].map(k => num('size' + k, solids.map(c => size(c)[k]), f => resize(k, f),
        { axis: k, preview: one && (d => size(one)[k] + d > 0 && fit(one, sized(one, k, size(one)[k] + d))) })),
      reset('Snap size to grid', () => xform(solids.map(c => [c.node, fit(c, size(c).map(x => Math.max(S.grid, snap(x))))])))));
  }
  const space = cfg.gizmoSpace === 'local' ? 'local' : 'world';
  const r = row('Anchor', 'The point that stays fixed when resizing; Location is measured there. Axes: world, or the selection\'s own (as the gizmo)',
    dropdown('anchor', ANCHORS, anchor, v => setCfg('anchor', v)),
    dropdown('space', [['world', 'World axes'], ['local', yaw ? `Local axes (${fmt(yaw)} deg)` : 'Local axes']], space, v => setCfg('gizmoSpace', v)),
    el('label', { className: 'lock', title: 'Size: keep proportions' }, check('lock', lock, '', () => setCfg('sizeLock', !lock)), ' Lock size'));
  r.dataset.q += ' lock size axes world local';
  return section('Transform', ...rows, r);
}

// One component j of an angle key ('pitch yaw roll').
const angNum = (id, list, key, j, axis, label) => num(id, list.map(e => angs(e, key)[j]), f => setKey(list, key, e => {
  const a = angs(e, key);
  a[j] = f(a[j]);
  return a.every(Number.isFinite) ? a.map(fmt).join(' ') : undefined;
}), { axis, label, steps: DEG });

function brush(solids) {
  if (!solids.length) return null;
  const m = same(solids.flatMap(n => V.kids(n, 'side').map(s => matName(V.get(s, 'material'))))), mi = input('mat', m, { list: 'mats' });
  const apply = () => mi.value && mi.value !== m && applyMat(mi.value);
  mi.onchange = apply;
  const thumb = thumbOf(m);

  const { world } = doc, owners = [...new Set(solids.map(n => cache.get(n).owner))];
  const cur = same(owners.map(o => (o === world ? '' : V.get(o, 'classname') || '')));
  const all = fgd ? [...fgd.values()].filter(c => /^solidclass$/i.test(c.type) && c.name !== 'worldspawn').map(c => c.name).sort() : [];
  const types = [['', 'World'], ...[...new Set([...COMMON, ...all])].map(n => [n])];

  const names = new Map();
  (function walk(n) { for (const g of V.kids(n, 'visgroup')) { names.set(V.get(g, 'visgroupid'), V.get(g, 'name')); walk(g); } })(V.kids(doc.root, 'visgroups')[0] ?? { children: [] });
  // a group member's visgroups sit on its group block
  const holders = [...solids, ...owners.filter(o => o !== world)];
  const ids = [...new Set([...holders, ...holders.map(groupOf).filter(Boolean)].flatMap(n => V.kids(n, 'editor').flatMap(e => e.kv.filter(p => p[0] === 'visgroupid').map(p => p[1]))))];

  return section('Brush',
    row('Material', 'Material of every face; Apply sets it on all faces of the selected brushes', thumb, mi, button('Apply', 'Apply to all faces', apply, ''),
      button('Browse', 'Find this material in the Textures panel', () => browse(mi.value || m), '')),
    row('Justify', 'On every face of the selected brushes: fit the texture once, or align an edge or the centre (the faces of a group as one surface)', ...['fit', 'left', 'right', 'top', 'bottom', 'center'].map(j => button(j[0].toUpperCase() + j.slice(1), 'Justify ' + j + ' on every face', () => justify(j, facesOfSolids(solids)))), asOne()),
    row('Type', 'World brush or brush entity class (ties or unties the brushes)', dropdown('type', types, cur, tieSel)),
    row('Visgroups', 'Read-only for now', ...(ids.length ? ids.map(id => el('span', { className: 'tag', textContent: names.get(id) ?? id })) : [el('small', { textContent: 'none' })])));
}

function face() {
  const sides = [...facesOf().keys()];
  if (!sides.length) return section('Face', el('small', { textContent: 'No faces selected (click faces in the 3D view)' }));
  const SCALE = () => [0.05, 0.01, 0.25], SHIFT = () => [16, 1, 64];
  const axNum = (k, p, steps) => num(`f${k}${p}`, sides.map(s => tex(s, k)[p]), f => editFaces(s => {
    const a = tex(s, k);
    a[p] = f(a[p]);
    if (Number.isFinite(a[p]) && (p !== 'scale' || a[p])) setTex(s, k, a);
  }), { axis: k === 'uaxis' ? 0 : 1, label: k[0].toUpperCase(), steps });
  const rot = num('frot', sides.map(s => +V.get(s, 'rotation') || 0), f => editFaces(s => {
    const r0 = +V.get(s, 'rotation') || 0, r = f(r0), u = tex(s, 'uaxis'), v = tex(s, 'vaxis'), n = unit(cross(u.v, v.v));
    if (!Number.isFinite(r) || r === r0) return;
    u.v = turn(u.v, n, r - r0);
    v.v = turn(v.v, n, r - r0);
    setTex(s, 'uaxis', u);
    setTex(s, 'vaxis', v);
    V.set(s, 'rotation', f6(r));
  }), { steps: DEG });
  const lm = num('flm', sides.map(s => +V.get(s, 'lightmapscale') || 16), f => editFaces(s => {
    const x = Math.round(f(+V.get(s, 'lightmapscale') || 16));
    if (x >= 1) V.set(s, 'lightmapscale', String(x));
  }), { steps: () => [8, 1, 32] });
  const fmv = same(sides.map(s => matName(V.get(s, 'material')))), lockOn = cfg.texLock !== false, fm = input('fmat', fmv, { list: 'mats' });
  const setMat = name => { name = matName(name); editFaces(s => V.set(s, 'material', name)); remember(name); };
  fm.onchange = () => fm.value && setMat(fm.value);
  return section('Face',
    row('Material', 'Material of the selected faces', thumbOf(fmv), fm, button('Apply current', `Apply the current material (${cfg.material}) to the selected faces`, () => setMat(cfg.material), ''),
      button('Browse', 'Find this material in the Textures panel', () => browse(fm.value || cfg.material), '')),
    row('Scale', 'Texture scale (units per texel) on U and V', axNum('uaxis', 'scale', SCALE), axNum('vaxis', 'scale', SCALE)),
    row('Shift', 'Texture shift in texels on U and V', axNum('uaxis', 'shift', SHIFT), axNum('vaxis', 'shift', SHIFT)),
    row('Rotation', 'Texture rotation in degrees', rot),
    row('Lightmap scale', 'Units per luxel (smaller is sharper and costs more)', lm),
    row('Justify', 'Fit the texture once, or align an edge or the centre (the faces of a group as one surface)', ...['fit', 'left', 'right', 'top', 'bottom', 'center'].map(j => button(j[0].toUpperCase() + j.slice(1), 'Justify ' + j, () => justify(j))), asOne()),
    row('Align', 'Reset the texture axes', button('World', 'Axes from the nearest world plane', () => align('world')), button('Face', 'Axes in the face plane', () => align('face'))),
    row('Texture lock', 'Textures follow brushes when they move or rotate', check('texlock', lockOn, 'Texture lock', () => setCfg('texLock', !lockOn))),
    row('In 3D', 'Drag on a face in the 3D view', el('small', { textContent: 'middle-drag: move texture, Ctrl+middle-drag: rotate it' })));
}

function entity(list) {
  if (!list.length) return null;
  const cls = same(list.map(e => V.get(e, 'classname') || '')), ds = list.map(e => def(V.get(e, 'classname')));
  const keys = ds.every(Boolean) ? ds.reduce((ks, d) => ks.filter(k => d.keys.some(x => x.name === k.name)), ds[0].keys) : null;
  const ci = input('class', cls, { list: 'classes' });
  ci.onchange = () => ci.value && setKey(list, 'classname', () => ci.value);
  const rows = [row('Class', ds[0]?.description || 'classname', ci),
    row('Raw keyvalues', keys ? 'Show every keyvalue as text' : 'Class not in the FGD', check('raw', raw || !keys, '', () => { raw = !raw; later(); }))];
  rows.at(-1).querySelector('input').disabled = !keys;
  if (raw || !keys) return section('Entity', ...rows, ...rawRows(list));
  const extra = sharedKeys(list).filter(n => !keys.some(k => k.name === n))
    .map(name => ({ name, type: 'string', displayName: name, default: '', description: 'Not in the FGD', choices: [], flags: [] }));
  return section('Entity', ...rows, ...[...keys, ...extra].filter(k => !SKIP.has(k.name)).map(k => kvRow(list, k)));
}

function kvRow(list, k) {
  const get = e => V.get(e, k.name) ?? k.default ?? '', v = same(list.map(get)), id = 'kv:' + k.name;
  const set = val => (v !== undefined || val !== '') && setKey(list, k.name, () => val);
  const r = row(k.displayName || (k.type === 'flags' ? 'Flags' : k.name), `${k.description ? k.description + '\n\n' : ''}${k.name} (${k.type})`, ...control(list, k, v, get, set, id));
  r.dataset.q += ` ${k.name.toLowerCase()}${k.flags.map(f => ' ' + f.label.toLowerCase()).join('')}`;
  return r;
}

function control(list, k, v, get, set, id) {
  if (k.readonly) { const i = input(id, v); i.disabled = true; return [i]; }
  if (k.choices.length) return [dropdown(id, k.choices.map(c => [c.value, c.label]), v, set)];
  if (k.type === 'flags') return [flags(list, k)];
  if (k.type === 'color255') return color(list, k, v, get);
  if (k.type === 'angle') return angle(list, k.name, id);
  const tgt = TARGET.has(k.type), i = input(id, v, tgt ? { list: 'd-targets', cls: broken(v ?? '') ? 'bad' : '' } : {});
  i.onchange = () => set(i.value);
  // The Models / Sounds panel, searching for the value; clicking a result there sets the key on the selection.
  if (k.type === 'studio') return [i, button('Browse', 'Find this model in the Models panel', () => import('./modelbrowser.js').then(B => B.browse(i.value)), '')];
  if (k.type === 'sound') return [i, button('Browse', 'Find this sound in the Sounds panel', () => import('./soundbrowser.js').then(B => B.browse(i.value)), '')];
  if (!tgt) return [i];
  const pick = button('Pick', 'Pick the target in a viewport (Esc cancels)', () => { picking = { list, key: k.name, prev: [...sel] }; later(); }, picking?.key === k.name ? 'ib on' : 'ib');
  return [i, pick];
}

function flags(list, k) {
  const bits = e => { const x = V.get(e, k.name); return x === undefined ? k.flags.reduce((a, f) => a | (f.default ? f.bit : 0), 0) : +x || 0; };
  return el('div', { className: 'flags' }, ...k.flags.map(f => {
    const on = list.map(e => (bits(e) & f.bit) !== 0);
    const cb = check(`flag:${k.name}:${f.bit}`, on.every(Boolean), `bit ${f.bit}`, () => setKey(list, k.name, e => String(cb.checked ? bits(e) | f.bit : bits(e) & ~f.bit)));
    cb.indeterminate = on.some(Boolean) && !on.every(Boolean);
    return el('label', { title: `${f.label} (bit ${f.bit})` }, cb, ' ' + f.label);
  }));
}

// 'r g b [brightness]'
function color(list, k, v, get) {
  const c = V.nums(v ?? ''), hex = '#' + [0, 1, 2].map(i => Math.max(0, Math.min(255, Math.round(c[i] ?? 0))).toString(16).padStart(2, '0')).join('');
  const ci = el('input', { type: 'color', value: hex, title: v ?? 'Values differ' }), bi = input(`kv:${k.name}:b`, v === undefined ? undefined : c.length > 3 ? fmt(c[3]) : '', { cls: 'num' });
  ci.dataset.f = 'kv:' + k.name;
  bi.title = 'Brightness';
  const rgb = () => ci.value.match(/\w\w/g).map(h => parseInt(h, 16));
  ci.onchange = () => setKey(list, k.name, e => [...rgb(), ...V.nums(get(e)).slice(3)].join(' '));
  bi.onchange = () => {
    const b = bi.value.trim(), n = calc(b);
    if (b && Number.isNaN(n)) return later();
    setKey(list, k.name, e => { const o = V.nums(get(e)), base = o.length >= 3 ? o.slice(0, 3) : rgb(); return (b ? [...base, n, ...o.slice(4)] : base).join(' '); });
  };
  return [ci, bi];
}

function angle(list, key, id) {
  const fs = [[0, 1, 'P'], [1, 2, 'Y'], [2, 0, 'R']].map(([j, axis, label]) => angNum(`${id}:${j}`, list, key, j, axis, label));
  const yaw = same(list.map(e => fmt(angs(e, key)[1])));
  return [...fs, dial(list, key, yaw === undefined ? undefined : +yaw, fs[1].querySelector('input'))];
}

// Yaw dial: 0 points along +X (right), 90 along +Y (up), as in the top view. Applied once on release.
function dial(list, key, yaw, field) {
  const c = el('canvas', { className: 'dial', width: 64, height: 64, title: 'Yaw: drag to set (rotation step, Shift 1 degree)' }), g = c.getContext('2d');
  const draw = a => {
    g.clearRect(0, 0, 64, 64);
    g.lineWidth = 4;
    g.strokeStyle = '#2c3039';
    g.beginPath(); g.arc(32, 32, 26, 0, 7); g.stroke();
    if (a === undefined) return;
    const r = (a * Math.PI) / 180;
    g.strokeStyle = '#4f8cff';
    g.beginPath(); g.moveTo(32, 32); g.lineTo(32 + 26 * Math.cos(r), 32 - 26 * Math.sin(r)); g.stroke();
  };
  draw(yaw);
  c.onpointerdown = e => {
    c.setPointerCapture(e.pointerId);
    let a;
    const at = e => {
      const b = c.getBoundingClientRect(), st = e.shiftKey ? 1 : DEG()[0];
      const deg = (Math.atan2(b.top + b.height / 2 - e.clientY, e.clientX - b.left - b.width / 2) * 180) / Math.PI;
      a = (((Math.round(deg / st) * st) % 360) + 360) % 360;
      draw(a);
      field.value = a;
    };
    at(e);
    c.onpointermove = at;
    c.onpointerup = () => { c.onpointermove = c.onpointerup = null; setKey(list, key, en => { const v = angs(en, key); v[1] = a; return v.map(fmt).join(' '); }); };
  };
  return c;
}

function rawRows(list) {
  const names = sharedKeys(list).filter(n => n !== 'id');
  const rows = names.map(n => {
    const v = same(list.map(e => V.get(e, n) ?? '')), i = input('raw:' + n, v);
    i.onchange = () => (v !== undefined || i.value) && setKey(list, n, () => i.value);
    return row(n, n, i, button('x', 'Remove key', () => delKey(list, n)));
  });
  const k = input('rawk', ''), val = input('rawv', '');
  k.placeholder = 'key';
  val.placeholder = 'value';
  return [...rows, row('Add key', 'Add a keyvalue to the selected entities', k, val, button('Add', '', () => k.value && setKey(list, k.value, () => val.value), ''))];
}

function io(ent) {
  const d = def(V.get(ent, 'classname')), pairs = connsOf(ent)?.kv ?? [];
  const incoming = ents.flatMap(e => (connsOf(e)?.kv ?? []).map(parseConn).filter(c => hits(c.target, ent)).map(c => [e, c]));
  const tabs = el('div', { className: 'tabs' }, ...[['out', `Outputs (${pairs.length})`], ['in', `Inputs (${incoming.length})`]]
    .map(([t, label]) => button(label, '', () => { tab = t; later(); }, tab === t ? 'on' : '')));
  if (tab === 'in') {
    const rows = incoming.map(([e, c]) => el('div', { className: 'inrow', title: 'Select this entity', onclick: () => setSelection(V.kids(e, 'solid').length ? V.kids(e, 'solid') : [e]) },
      el('b', { textContent: V.get(e, 'targetname') || V.get(e, 'classname') }), ` ${c.out} > ${c.input}${c.param ? ` (${c.param})` : ''}${+c.delay ? ` after ${c.delay}s` : ''}`));
    return section('Outputs', tabs, ...(rows.length ? rows : [el('small', { textContent: 'No entity targets this one' })]));
  }
  const outs = el('datalist', { id: 'd-outs' }, ...(d?.outputs ?? []).map(o => el('option', { value: o.name })));
  const head = el('div', { className: 'conn head' }, ...['Output', 'Target', 'Input', 'Parameter', 'Delay', 'Once', ''].map(t => el('span', { textContent: t })));
  const rows = pairs.map((p, i) => connRow(ent, i, parseConn(p)));
  return section('Outputs', tabs, outs, pairs.length ? head : null, ...rows, button('+ Output', 'Add a connection', () => addConn(ent, (d?.outputs.find(o => !/^OnUser\d$/.test(o.name)) ?? d?.outputs[0])?.name ?? 'OnUser1'), ''));
}

function connRow(ent, i, c) {
  const f = (k, opts) => { const x = input(`c${i}:${k}`, c[k], opts); x.title = c[k]; x.onchange = () => setConn(ent, i, k, x.value); return x; };
  const inputs = [...new Set(ents.filter(e => c.target && hits(c.target, e)).flatMap(e => def(V.get(e, 'classname'))?.inputs.map(x => x.name) ?? []))];
  const once = check(`c${i}:once`, c.times === '1', 'Fire once', () => setConn(ent, i, 'times', once.checked ? '1' : '-1'));
  return el('div', { className: 'conn' }, f('out', { list: 'd-outs' }), f('target', { list: 'd-targets', cls: broken(c.target) ? 'bad' : '' }),
    f('input', { list: `d-in${i}` }), el('datalist', { id: `d-in${i}` }, ...inputs.map(n => el('option', { value: n }))),
    f('param'), f('delay', { cls: 'num' }), once, button('x', 'Remove', () => delConn(ent, i)));
}

function defaults() {
  const m = input('dmat', cfg.material, { list: 'mats', cls: 'mat' }), c = input('dcls', cfg.cls, { list: 'classes', cls: 'cls' });
  m.onchange = () => setCfg('material', matName(m.value));

  c.onchange = () => setCfg('cls', c.value);
  const apply = button('Apply', 'Apply to every face of the selected brushes (Ctrl+Alt+click a face in 3D: that face)', null, '');
  apply.dataset.cmd = 'applyMat';
  return section('New objects',
    row('Material', 'Material for new blocks and Apply. Alt+click a face in 3D or click one in the Textures panel to pick it.', m, apply,
      button('Browse', 'Find this material in the Textures panel', () => browse(m.value || cfg.material), '')),
    row('Entity class', 'Class placed by the entity tool', c));
}

// ---------- extra sections ----------
// fn(helpers) -> a section element or null, drawn after the Face section (polyedit.js: the selected vertices, edges or
// faces). helpers: { section, row, num, button, check, dropdown, DEG, GRID }. emit('details') asks for a redraw.
const extra = [], HELP = { section, row, num, button, check, dropdown, DEG, GRID };
export function registerSection(fn) { extra.push(fn); later(); return () => { extra.splice(extra.indexOf(fn), 1); later(); }; }
const extras = () => extra.map(fn => { try { return fn(HELP); } catch (e) { console.error(e); return null; } });

// ---------- render ----------
function filter() {
  const q = search.value.trim().toLowerCase();
  for (const d of body.querySelectorAll('details')) {
    const all = !q || d.querySelector('summary').textContent.toLowerCase().includes(q);
    let any = false;
    for (const r of d.querySelectorAll('.dr')) any = !(r.hidden = !all && !r.dataset.q.includes(q)) || any;
    d.hidden = !all && !any;
  }
}

// Rebuilds the panel; the focused field keeps focus and caret across the rebuild.
function render() {
  const a = document.activeElement, f = body.contains(a) ? a.dataset.f : null, s0 = a?.selectionStart, s1 = a?.selectionEnd;
  const cs = [...sel].map(n => cache.get(n)).filter(Boolean), solids = cs.filter(c => !c.point).map(c => c.node);
  const owners = [...new Set(cs.map(c => c.owner))].filter(o => o !== doc.world);
  ents = doc.root ? objects().filter(n => n.name === 'entity') : [];
  host.classList.toggle('picking', !!picking);
  header(cs);
  host.querySelector('#d-targets').replaceChildren(...[...new Set(ents.map(e => V.get(e, 'targetname')).filter(Boolean))].sort().map(n => el('option', { value: n })));
  const parts = world() ? [entity([doc.world])] : [transform(cs), brush(solids), S.mode === 'face' && face(), ...extras(), entity(owners), owners.length === 1 && io(owners[0])];
  body.replaceChildren(...[...parts, defaults()].filter(Boolean));
  filter();
  const n = f && body.querySelector(`[data-f="${CSS.escape(f)}"]`);
  if (!n) return;
  n.focus();
  try { if (s0 != null) n.setSelectionRange(s0, s1); } catch {}
}

// Eyedropper: the next selection names the target, then the previous selection comes back.
function onSelection() {
  if (!picking) return later();
  const p = picking, n = sel.values().next().value, name = n && V.get(cache.get(n)?.owner ?? n, 'targetname');
  picking = null;
  setSelection(p.prev);
  if (name) setKey(p.list, p.key, () => name);
}

function materials() {
  const names = new Set([...cache.values()].flatMap(c => c.faces.map(f => V.get(f.side, 'material')).filter(Boolean)));
  host.querySelector('#mats').replaceChildren(...[...names].sort().map(m => el('option', { value: m })));
}

async function loadFgd() {
  const map = cfg.tf2 ? await F.shared(`${cfg.tf2}\\bin\\tf.fgd`, api.read) : null;
  fgd = map?.size ? map : null;
  defs.clear();
  const pts = fgd ? [...fgd.values()].filter(c => !/^(base|solid)class$/i.test(c.type)).map(c => c.name).sort() : [];
  host.querySelector('#classes').replaceChildren(...pts.map(n => el('option', { value: n })));
  later();
}

export function mount(h) {
  host = h;
  host.innerHTML = HTML;
  body = host.querySelector('.dt-body');
  search = host.querySelector('.search');
  search.oninput = filter;
  on('doc', later);
  // the Material fields suggest the materials in the map: a dropped or imported one joins the list at once
  let matsTimer = 0;
  on('doc', () => { clearTimeout(matsTimer); matsTimer = setTimeout(materials, 300); });
  on('selection', onSelection);
  on('tool', later);
  on('details', later);
  on('file', d => { if (d.op === 'load') { picking = null; materials(); later(); } });
  on('cfg', ({ key }) => (key === 'tf2' ? loadFgd() : later()));
  register('applyMat', { title: 'Apply material to selection', run: () => applyMat(cfg.material) });
  register('cancelPick', { title: 'Cancel target pick', keys: ['escape'], when: () => !!picking, run: () => { picking = null; later(); } });
  loadFgd();
  later();
}
