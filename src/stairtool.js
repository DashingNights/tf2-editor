// Stairs tool (Shift+S): stairs or a ramp between two edges. Click two horizontal brush edges in the 3D view, the
// lower and the upper floor's edge in any order. With one edge picked, a floor away from its edges offers a start line through the pointer, parallel to the
// first edge. The stairs (or a ramp) preview in every view while you pick; Enter or Create builds them as one undo
// step. Escape drops the picks (again: back to Select), Backspace drops the last pick. Geometry: stairgeo.js.
import * as THREE from 'three';
import * as V from '../vmf.js';
import { on } from './bus.js';
import { S, sel, cache, nextId, setTool, setCursor, addSolids, groupSel, mergeUndo, filters, setFilter } from './state.js';
import { clipStairs } from './stairclip.js';
import { register } from './commands.js';
import { cfg, setCfg } from './settings.js';
import { el } from './dom.js';
import { slot } from './tools.js';
import * as view3d from './view3d.js';
import * as view2d from './view2d.js';
import { build, DEFAULTS } from './stairgeo.js';
import { hull } from './poly2d.js';

const ID = 'stairs';
const opts = () => ({ ...DEFAULTS, ...cfg.stairs });
// picked: up to two edges { a, b, node, virtual }; hover: the edge under the pointer; result: build() of the pair.
let picked = [], hover = null, result = null, preview = [], panel = null;

// ---------- walls the stairs fit to ----------
// Brushes players collide with, as plan hulls with their height range. Rebuilt after document or filter changes.
export const NONSOLID = /^(trigger_|func_(respawnroom|regenerate|nobuild|illusionary|occluder|areaportal|viscluster|capturezone|dustmotes|smokevolume|precipitation|ladder))/;
let walls = null;
function wallList() {
  if (walls) return walls;
  walls = [];
  for (const c of cache.values()) {
    if (c.point || !c.visible || !c.faces.length || c.kinds?.includes('tools')) continue;
    if (c.owner?.name === 'entity' && NONSOLID.test(V.get(c.owner, 'classname') || '')) continue;
    walls.push({ node: c.node, poly: hull(c.faces.flatMap(f => f.pts.map(p => [p[0], p[1]]))), z0: c.min[2], z1: c.max[2] });
  }
  return walls;
}

// ---------- picking ----------
const v3 = new THREE.Vector3();
const screen = (p, w, h) => { v3.set(p[0], p[1], p[2]).project(view3d.cam); return [((v3.x + 1) / 2) * w, ((1 - v3.y) / 2) * h]; };
function segDist(m, a, b) {
  const d = [b[0] - a[0], b[1] - a[1]], l2 = d[0] * d[0] + d[1] * d[1];
  const t = l2 ? Math.max(0, Math.min(1, ((m[0] - a[0]) * d[0] + (m[1] - a[1]) * d[1]) / l2)) : 0;
  return Math.hypot(m[0] - a[0] - d[0] * t, m[1] - a[1] - d[1] * t);
}
const same = (x, y) => !!x && !!y && [x.a, x.b].map(String).sort().join() === [y.a, y.b].map(String).sort().join();

// The horizontal edge of the face under the pointer nearest to it on screen (within 48 px). With one edge picked, a
// floor face away from its edges gives a start line through the pointer parallel to that edge (snapped to the grid).
function edgeAt(e, hit) {
  const f = hit?.face;
  if (!f || cache.get(hit.node)?.point) return null;
  const cv = e.target, w = cv.clientWidth, h = cv.clientHeight, m = [e.offsetX, e.offsetY];
  let best = null, bd = Infinity;
  f.pts.forEach((a, i) => {
    const b = f.pts[(i + 1) % f.pts.length];
    if (Math.abs(a[2] - b[2]) > 0.5 || Math.hypot(b[0] - a[0], b[1] - a[1]) < 1) return;
    const d = segDist(m, screen(a, w, h), screen(b, w, h));
    if (d < bd) { bd = d; best = { a, b, node: hit.node }; }
  });
  if (picked.length === 1 && f.n[2] > 0.99 && bd > 16) {
    const [a, b] = [picked[0].a, picked[0].b], u = [b[0] - a[0], b[1] - a[1]], l = Math.hypot(...u), nrm = [-u[1] / l, u[0] / l];
    const step = cfg.snapGrid === false ? 1 : S.grid, z = f.pts[0][2];
    const t = Math.round(((hit.point.x - a[0]) * nrm[0] + (hit.point.y - a[1]) * nrm[1]) / step) * step;
    if (Math.abs(t) >= 1) return { a: [a[0] + nrm[0] * t, a[1] + nrm[1] * t, z], b: [b[0] + nrm[0] * t, b[1] + nrm[1] * t, z], node: hit.node, virtual: true };
  }
  return bd <= 48 ? best : null;
}

// ---------- preview ----------
function compute(pair, ids = () => '0') {
  const skip = new Set(pair.map(p => p.node));
  return build([pair[0].a, pair[0].b], [pair[1].a, pair[1].b], opts(), wallList().filter(w => !skip.has(w.node)), cfg.material || 'DEV/DEV_MEASUREGENERIC01B', ids);
}

const lmat = color => new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
const fillM = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0xff8a1f, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide }));
const outL = new THREE.LineSegments(new THREE.BufferGeometry(), lmat(0xffd0a0));
const pickL = new THREE.LineSegments(new THREE.BufferGeometry(), lmat(0xff8a1f));
const hoverL = new THREE.LineSegments(new THREE.BufferGeometry(), lmat(0xffe14d));
const ends = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xff8a1f, size: 7, sizeAttenuation: false, depthTest: false }));
const group = new THREE.Group().add(fillM, outL, pickL, hoverL, ends);
group.traverse(o => { o.renderOrder = 4; o.frustumCulled = false; });
function setPts(o, pts) {
  o.geometry.dispose();
  o.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts.flat(), 3));
}

function refresh() {
  const pair = picked.length === 2 ? picked : picked.length === 1 && hover && !same(hover, picked[0]) ? [picked[0], hover] : null;
  result = pair ? compute(pair) : null;
  preview = result?.solids?.map(V.faces) ?? [];
  const fs = preview.flat();
  setPts(fillM, fs.flatMap(f => f.pts.slice(1, -1).flatMap((p, i) => [f.pts[0], p, f.pts[i + 2]])));
  setPts(outL, fs.flatMap(f => f.pts.flatMap((p, i) => [p, f.pts[(i + 1) % f.pts.length]])));
  setPts(pickL, picked.flatMap(p => [p.a, p.b]));
  setPts(hoverL, hover && !picked.some(p => same(p, hover)) ? [hover.a, hover.b] : []);
  setPts(ends, picked.flatMap(p => [p.a, p.b]));
  message();
  view3d.invalidate();
  view2d.invalidate();
}

function message() {
  let text, bad = false;
  if (!picked.length) text = 'click a floor edge where the stairs start or end';
  else if (!result) text = 'click the other edge (or a spot on the lower floor to start the stairs there)';
  else if (result.error) { text = result.error; bad = true; }
  else text = `${result.info}${result.warnings.length ? '; ' + result.warnings.join('; ') : ''}${picked.length === 2 ? ' - Enter builds' : ''}`;
  if (panel) { panel.msg.textContent = text; panel.msg.classList.toggle('bad', bad); }
  setCursor(`stairs: ${text}`);
}

function create() {
  if (picked.length < 2) return setCursor('stairs: pick two edges first');
  const r = compute(picked, nextId);
  if (r.error || !r.solids.length) return setCursor(`stairs: ${r.error ?? 'nothing to build'}`);
  const clip = opts().clip && opts().type === 'stairs' ? clipStairs(r.solids, { nextId, context: around(r.solids), material: RAMP[opts().clip === 'all' ? 'all' : 'players'] }) : null;
  addSolids([...r.solids, ...(clip?.solids ?? [])]);
  if (clip?.solids.length) showClips();
  if (opts().group && r.solids.length > 1) { groupSel(); mergeUndo(); }
  setTool('select');
  setCursor(`stairs: built ${r.solids.length} brushes - ${r.info}`);
}

function overlay(ctx, v, { toScreen }) {
  if (S.tool !== ID) return;
  ctx.strokeStyle = '#ffb060';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const f of preview.flat()) { f.pts.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](...toScreen(v, p))); ctx.closePath(); }
  ctx.stroke();
  ctx.lineWidth = 2.5;
  for (const [ed, col] of [...picked.map(p => [p, '#ff8a1f']), ...(hover ? [[hover, '#ffe14d']] : [])]) {
    ctx.strokeStyle = col;
    ctx.beginPath();
    ctx.moveTo(...toScreen(v, ed.a));
    ctx.lineTo(...toScreen(v, ed.b));
    ctx.stroke();
  }
}

// ---------- panel ----------
function makePanel(host) {
  const set = (k, v) => { setCfg('stairs', { ...cfg.stairs, [k]: v }); refresh(); };
  const o = opts();
  const check = (k, label, title) => {
    const c = el('input', { type: 'checkbox', checked: !!o[k], onchange: () => set(k, c.checked) });
    c.dataset.key = k;
    return el('label', { title }, c, ' ' + label);
  };
  const type = el('select', { title: 'Stairs or a ramp', onchange: () => set('type', type.value) },
    el('option', { value: 'stairs', textContent: 'Stairs' }), el('option', { value: 'ramp', textContent: 'Ramp' }));
  type.value = o.type;
  const count = el('input', { type: 'number', min: 0, max: 64, value: o.count, title: 'Risers; 0 makes steps of at most 16 units', onchange: () => set('count', Math.max(0, Math.round(+count.value) || 0)) });
  const coll = el('select', { title: 'What players and shots collide with on the stairs: the steps, or a smooth ramp on the nosings (a player clip: players only, projectiles and bullets still hit the steps; or Block Bullets 2: players, projectiles, bullets and splash all meet the ramp)', onchange: () => set('clip', coll.value === 'steps' ? false : coll.value) },
    el('option', { value: 'steps', textContent: 'Steps collide' }), el('option', { value: 'players', textContent: 'Player clip ramp' }), el('option', { value: 'all', textContent: 'Ramp for everything' }));
  const collOf = p => (p.clip === 'all' ? 'all' : p.clip ? 'players' : 'steps');
  coll.value = collOf(o);
  const msg = el('div', { className: 'msg' });
  // Shows the saved options again (they can change in settings.json or another window between uses).
  const sync = () => {
    const p = opts();
    type.value = p.type;
    count.value = p.count;
    coll.value = collOf(p);
    div.querySelectorAll('input[type=checkbox]').forEach(c => { c.checked = !!p[c.dataset.key]; });
  };
  const div = el('div', { className: 'stairs-panel', hidden: true },
    el('b', { className: 'chip', textContent: 'STAIRS' }), type,
    el('label', { title: count.title }, 'Steps ', count),
    check('fit', 'Fit walls', 'Grow or cut the stairs to the nearest walls'),
    check('longWay', 'Long way', 'Curved stairs turn the long way round, more than half a turn (a spiral)'),
    check('solid', 'Solid', 'Treads reach down to the lower floor'),
    coll,
    check('group', 'Group', 'Group the result (Ctrl+U ungroups)'),
    el('button', { className: 'primary', textContent: 'Create', title: 'Build the stairs (Enter)', onclick: create }),
    msg);
  host.append(div);
  return Object.assign(div, { msg, sync });
}

// ---------- tool ----------
const tool3d = {
  activate() { picked = []; hover = null; panel.sync(); panel.hidden = false; view3d.addHelper(group); refresh(); },
  deactivate() { picked = []; hover = null; result = null; preview = []; panel.hidden = true; view3d.removeHelper(group); view2d.invalidate(); },
  move(e, hit) {
    const ed = edgeAt(e, hit);
    if (!same(ed, hover) || ed?.a[2] !== hover?.a[2]) { hover = ed; refresh(); }
    return true;
  },
  down(e, hit) {
    if (e.altKey) return false;
    const ed = edgeAt(e, hit);
    if (ed && !(ed.virtual && picked.length !== 1)) {
      picked = picked.length >= 2 ? [ed] : [...picked.filter(p => !same(p, ed)), ed];
      hover = null;
      refresh();
    }
    return true;
  },
  up() { return true; },
  key(e) {
    if (e.ctrlKey || e.altKey || e.metaKey || view3d.drawBusy()) return false;
    if (e.key === 'Enter') create();
    else if (e.key === 'Escape') { if (picked.length) { picked = []; refresh(); } else setTool('select'); }
    else if (e.key === 'Backspace') { picked.pop(); refresh(); }
    else return false;
    return true;
  },
};

// The brushes near the steps players stand on or run into (no tool brushes): the floor in front, the ledge the
// steps lead to, walls and ledges beside them (stairclip.js context).
function around(steps) {
  const mine = new Set(steps), [mn, mx] = V.bounds(steps.flatMap(s => V.faces(s))), R = 128;
  return [...cache.values()].filter(c => c.node.name === 'solid' && c.visible && !mine.has(c.node)
    && c.max[0] >= mn[0] - R && c.min[0] <= mx[0] + R && c.max[1] >= mn[1] - R && c.min[1] <= mx[1] + R && c.max[2] >= mn[2] - 64 && c.min[2] <= mx[2] + 128
    && !V.kids(c.node, 'side').every(x => /^TOOLS\//i.test(V.get(x, 'material') ?? ''))).map(c => c.node);
}
// The ramp's material: a player clip (players only; rockets, stickies and bullets pass it and hit the steps), or Block
// Bullets 2 for everything (solid to players, projectiles, bullets and splash line of sight, so explosions on the
// stairs act as on a slope; TF2's detail variant: it cuts no visleaves). TOOLSINVISIBLE would let bullets and splash
// line of sight through to the step corners.
const RAMP = { players: 'TOOLS/TOOLSPLAYERCLIP', all: 'TOOLS/TOOLSBLOCKBULLETS2' };
// New clips stay in sight: the Clips and Tools filters go on with them.
const showClips = () => { for (const k of ['clips', 'tools']) if (!filters[k]) setFilter(k, true); };
// Clip stairs / Ramp stairs: a ramp over the selected steps of a flight (stairclip.js), grouped and selected afterwards.
function clipSelected(kind = 'players') {
  const steps = [...sel].flatMap(n => (n.name === 'solid' ? [n] : V.kids(n, 'solid')));
  const r = clipStairs(steps, { nextId, context: around(steps), material: RAMP[kind] });
  if (r.error) return setCursor(`clip stairs: ${r.error}`);
  addSolids(r.solids);
  if (r.solids.length > 1) { groupSel(); mergeUndo(); } // one group, one undo step
  showClips();
  setCursor(`clip stairs: ${r.info}`);
}

export function mount(el3d) {
  panel = makePanel(slot('stairs', 'Stairs'));
  view3d.registerTool(ID, tool3d);
  view2d.registerOverlay(overlay);
  for (const t of ['doc', 'filters']) on(t, () => { walls = null; if (S.tool === ID) refresh(); });
  // what the ramp blocks: the choice beside the Clip stairs button (cfg.stairClip)
  register('stairs.clip', { title: 'Stairs: ramp clip over the selected steps (blocks players, or everything: the choice beside the button)', when: () => sel.size > 0, run: () => clipSelected(cfg.stairClip === 'all' ? 'all' : 'players') });
  register('tool.stairs', { title: 'Tool: stairs or a ramp between two edges', keys: ['shift+s'], run: () => setTool(ID), on: () => S.tool === ID });
}
