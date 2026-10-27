// Roof tool (Shift+R): click a face on one wall (its inner side or its top), then one on the wall across the gap. After
// the first pick the tool suggests the wall face straight across the gap: click it (or any spot that gives no roof)
// or press Enter to take it, or click another face. The roof previews in every view; Enter or Create builds it as one
// undo step. Escape drops the picks (again: back to Select), Backspace drops the last pick. Geometry: roofgeo.js.
import * as THREE from 'three';
import * as V from '../vmf.js';
import { on } from './bus.js';
import { S, cache, nextId, setTool, setCursor, addObjects, groupSel, mergeUndo } from './state.js';
import { register } from './commands.js';
import { cfg, setCfg } from './settings.js';
import { el } from './dom.js';
import { slot } from './tools.js';
import * as view3d from './view3d.js';
import * as view2d from './view2d.js';
import { build, across, DEFAULTS } from './roofgeo.js';
import { NONSOLID } from './stairtool.js';

const ID = 'roof';
const opts = () => ({ ...DEFAULTS, ...cfg.roof });
// picked: up to two walls { node, face, faces }; hover: the wall face under the pointer; guess: the face across the
// gap from the first pick; other: the second wall the preview uses; result: build() of the pair.
let picked = [], hover = null, guess = null, other = null, result = null, preview = [], panel = null;

const wallAt = hit => { const c = hit?.face && cache.get(hit.node); return c && !c.point ? { node: hit.node, face: hit.face, faces: c.faces } : null; };
const same = (x, y) => !!x && !!y && x.face.side === y.face.side;
// Faces of the brushes players collide with (as the Stairs tool's walls), but the first wall's.
const solidFaces = skip => [...cache.values()].filter(c => !c.point && c.visible && c.node !== skip && !c.kinds?.includes('tools')
  && !(c.owner?.name === 'entity' && NONSOLID.test(V.get(c.owner, 'classname') || ''))).flatMap(c => c.faces.map(f => ({ ...f, node: c.node })));
function suggest(w) { const g = across(w, solidFaces(w.node)); return g && { node: g.node, face: g, faces: cache.get(g.node).faces }; }
// A wall again from the cache after undo, redo or another edit: null once its brush or the face's side is gone.
function relink(w) {
  const c = w && cache.get(w.node), face = c && !c.point && c.faces.find(f => f.side === w.face.side);
  return face ? { node: w.node, face, faces: c.faces } : null;
}
const compute = (a, b, ids) => build(a, b, opts(), ids);

// ---------- preview ----------
const lmat = color => new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
const fillM = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0xff8a1f, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide }));
const outL = new THREE.LineSegments(new THREE.BufferGeometry(), lmat(0xffd0a0));
const pickL = new THREE.LineSegments(new THREE.BufferGeometry(), lmat(0xff8a1f));
const guessL = new THREE.LineSegments(new THREE.BufferGeometry(), lmat(0x4dd8ff));
const hoverL = new THREE.LineSegments(new THREE.BufferGeometry(), lmat(0xffe14d));
const group = new THREE.Group().add(fillM, outL, pickL, guessL, hoverL);
group.traverse(o => { o.renderOrder = 4; o.frustumCulled = false; });
function setPts(o, pts) {
  o.geometry.dispose();
  o.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts.flat(), 3));
}
const loops = fs => fs.flatMap(f => f.pts.flatMap((p, i) => [p, f.pts[(i + 1) % f.pts.length]]));

function refresh() {
  result = null;
  other = picked[1] ?? null;
  if (picked.length === 1) {
    // the face under the pointer when it gives a roof, else the suggestion
    const h = hover && hover.node !== picked[0].node ? compute(picked[0], hover) : null;
    if (h && !h.error) { other = hover; result = h; } else other = guess;
  }
  if (other && !result) result = compute(picked[0], other);
  preview = result?.solids?.map(V.faces) ?? [];
  const fs = preview.flat();
  setPts(fillM, fs.flatMap(f => f.pts.slice(1, -1).flatMap((p, i) => [f.pts[0], p, f.pts[i + 2]])));
  setPts(outL, loops(fs));
  setPts(pickL, loops(picked.map(w => w.face)));
  setPts(guessL, other && !picked.includes(other) ? loops([other.face]) : []);
  setPts(hoverL, hover && ![...picked, other].some(w => same(w, hover)) ? loops([hover.face]) : []);
  message();
  view3d.invalidate();
  view2d.invalidate();
}

function message() {
  let text, bad = false;
  if (!picked.length) text = 'click a face on one wall (its inner side or its top)';
  else if (!result) text = 'click a face on the wall across the gap';
  else if (result.error) { text = result.error; bad = true; }
  else {
    const next = picked.length === 2 ? ' - Enter builds' : other === guess ? ' - Enter or a click takes the face across the gap (blue), or click another face' : ' - click to take this face';
    text = `${result.info}${result.warnings.length ? '; ' + result.warnings.join('; ') : ''}${next}`;
  }
  if (panel) { panel.msg.textContent = text; panel.msg.classList.toggle('bad', bad); }
  setCursor(`roof: ${text}`);
}

function create() {
  if (picked.length === 1 && other) picked.push(other);
  if (picked.length < 2) return setCursor('roof: pick a face on each wall first');
  const r = compute(picked[0], picked[1], nextId);
  if (r.error || !r.solids.length) return refresh(), setCursor(`roof: ${r.error ?? 'nothing to build'}`);
  if (opts().detail) {
    const e = V.entity('func_detail', [0, 0, 0], nextId);
    e.kv = e.kv.filter(([k]) => k !== 'origin');
    e.children.unshift(...r.solids);
    addObjects([e]);
  } else {
    addObjects(r.solids);
    if (r.solids.length > 1) { groupSel(); mergeUndo(); }
  }
  setTool('select');
  setCursor(`roof: built ${r.info}`);
}

function overlay(ctx, v, { toScreen }) {
  if (S.tool !== ID) return;
  const draw = (fs, col, w) => {
    ctx.strokeStyle = col;
    ctx.lineWidth = w;
    ctx.beginPath();
    for (const f of fs) { f.pts.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](...toScreen(v, p))); ctx.closePath(); }
    ctx.stroke();
  };
  draw(preview.flat(), '#ffb060', 1);
  draw(picked.map(w => w.face), '#ff8a1f', 2.5);
  if (other && !picked.includes(other)) draw([other.face], '#4dd8ff', 2);
}

// ---------- panel ----------
function makePanel(host) {
  const set = (k, v) => { setCfg('roof', { ...cfg.roof, [k]: v }); refresh(); };
  const o = opts();
  const check = (k, label, title) => {
    const c = el('input', { type: 'checkbox', checked: !!o[k], onchange: () => set(k, c.checked) });
    c.dataset.key = k;
    return el('label', { title }, c, ' ' + label);
  };
  const height = el('select', { title: 'Where the roof sits when the wall tops differ', onchange: () => set('height', height.value) },
    el('option', { value: 'flush', textContent: 'Flush (lower top)' }), el('option', { value: 'flat', textContent: 'Flat (higher top)' }), el('option', { value: 'slope', textContent: 'Slope' }));
  height.value = o.height;
  const thick = el('input', { type: 'number', min: 1, max: 512, value: o.thickness, title: 'Thickness in units', onchange: () => set('thickness', Math.max(1, Math.round(+thick.value) || 16)) });
  const msg = el('div', { className: 'msg' });
  // Shows the saved options again (they can change in settings.json or another window between uses).
  const sync = () => {
    const p = opts();
    height.value = p.height;
    thick.value = p.thickness;
    div.querySelectorAll('input[type=checkbox]').forEach(c => { c.checked = !!p[c.dataset.key]; });
  };
  const div = el('div', { className: 'stairs-panel', hidden: true },
    el('b', { className: 'chip', textContent: 'ROOF' }), height,
    el('label', { title: thick.title }, 'Thick ', thick),
    check('tops', 'Wall tops', 'Cover the wall tops out to their outer faces (off: stop at the inner faces)'),
    check('extend', 'Extend', 'Run on to the ends of the longer wall (off: only where the faces overlap)'),
    check('detail', 'func_detail', 'Make the roof a func_detail (off: world brushes, grouped)'),
    el('button', { className: 'primary', textContent: 'Create', title: 'Build the roof (Enter)', onclick: create }),
    msg);
  host.append(div);
  return Object.assign(div, { msg, sync });
}

// ---------- tool ----------
const tool3d = {
  activate() { picked = []; hover = guess = null; panel.sync(); panel.hidden = false; view3d.addHelper(group); refresh(); },
  deactivate() { picked = []; hover = guess = other = result = null; preview = []; panel.hidden = true; view3d.removeHelper(group); view2d.invalidate(); },
  move(e, hit) {
    const w = wallAt(hit);
    if (!same(w, hover) && (w || hover)) { hover = w; refresh(); }
    return true;
  },
  down(e, hit) {
    if (e.altKey) return false;
    const w = wallAt(hit);
    if (picked.length === 1 && !(w && w.node === picked[0].node)) { if (other || w) picked.push(other ?? w); }
    else if (w) { picked = [w]; guess = suggest(w); }
    hover = null;
    refresh();
    return true;
  },
  up() { return true; },
  key(e) {
    if (e.ctrlKey || e.altKey || e.metaKey) return false;
    if (e.key === 'Enter') create();
    else if (e.key === 'Escape') { if (picked.length) { picked = []; guess = null; refresh(); } else setTool('select'); }
    else if (e.key === 'Backspace') { picked.pop(); if (!picked.length) guess = null; refresh(); }
    else return false;
    return true;
  },
};

export function mount(el3d) {
  panel = makePanel(slot('roof', 'Roof'));
  view3d.registerTool(ID, tool3d);
  view2d.registerOverlay(overlay);
  on('doc', () => {
    if (S.tool !== ID) return;
    picked = picked.map(relink).filter(Boolean);
    hover = relink(hover);
    guess = picked.length ? suggest(picked[0]) : null;
    refresh();
  });
  on('filters', () => { if (S.tool === ID) refresh(); });
  register('tool.roof', { title: 'Tool: roof between two walls', keys: ['shift+r'], run: () => setTool(ID), on: () => S.tool === ID });
}
