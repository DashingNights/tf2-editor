// Displacements in the editor (Hammer's face edit Displacement tab): the subdivided surface in 3D (a view3d builder;
// the other faces of a displacement brush are not drawn, as in Hammer, and vbsp drops them), the displaced outline in
// the 2D views, the Displacement panel (create, destroy, sew, subdivide, noise, power, invert alpha, attributes, select
// all, paint settings), the paint tool and the walkable / buildable tag tools with their tag view.
// Blend materials ($basetexture2, WorldVertexTransition) draw a second layer over the first with the vertex alpha as
// its opacity.
import * as THREE from 'three';
import * as V from '../vmf.js';
import * as D from './dispgeo.js';
import * as M from './materials.js';
import { registerBuilder, registerTool, refreshEntry, addHelper, removeHelper, invalidate, onHover, rayAt } from './view3d.js';
import * as view2d from './view2d.js';
import { registerPanel, pane } from './layout.js';
import { S, cache, sel, faceSel, edit, setSelection, setFaceSelection, setTool, setCursor } from './state.js';
import { register } from './commands.js';
import { cfg, setCfg } from './settings.js';
import { on } from './bus.js';
import { el } from './dom.js';
import { ask } from './dialog.js';
import { form } from './report.js';
import { mirrorPoint, twinOf } from './mirror.js';

registerPanel({ id: 'displacement', title: 'Displacement', near: 'details' });

// Settings (stateRequests: add these to settings.js DEFAULTS).
const DEF = { dispPower: 3, dispTarget: 'geometry', dispEffect: 'raise', dispAxis: 'normal', dispRadius: 96, dispStrength: 8 };
const opt = k => cfg[k] ?? DEF[k];
const isDisp = side => V.kids(side, 'dispinfo').length > 0;

// ---------- 3D: the builder ----------
// side -> { node, side, grid, mat, P (positions), geo, over (blend layer geometry or null) } of every built
// displacement; the paint tool edits these grids and previews them through refresh().
const live = new Map(), owned = new Map(); // owned: node -> geometries made for it, disposed when it is rebuilt or gone
let gen2 = 0; // bumped when a displaced outline changes (2D path cache)

// $basetexture2 of a material once its VMT is read (null: none). Entries built before that are rebuilt when it is.
const second = new Map(), waiting = new Map();
function tex2(name, node) {
  if (second.has(name)) return second.get(name);
  if (!waiting.has(name)) {
    waiting.set(name, new Set());
    M.getVmt(name).then(p => {
      const ns = waiting.get(name), t = p?.basetexture2 ?? null;
      second.set(name, t);
      waiting.delete(name);
      if (t) ns.forEach(n => cache.has(n) && refreshEntry(n));
    });
  }
  waiting.get(name).add(node);
  return null;
}
// The blend layer's material for texture path: the texture from materials.js getTexture(path) when it exports one,
// else the texture of the material named like it (Valve names most materials after their texture). Hidden until loaded.
// ponytail: the layer tiles by its own texture size; Source maps both layers by the base texture's size.
const blends = new Map();
function blendMat(path) {
  let m = blends.get(path);
  if (m) return m;
  blends.set(path, (m = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, visible: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })));
  const use = t => { if (t) Object.assign(m, { map: t, visible: true, needsUpdate: true }); invalidate(); }, key = M.clean(path);
  if (typeof M.getTexture === 'function') M.getTexture(path).then(use);
  else { use(M.getMaterial(key).map); on('material', e => e.name === key && use(e.material.map)); }
  return m;
}
const blendShown = () => !cfg.renderMode || cfg.renderMode === 'textured'; // flat, wireframe and lit draw one layer

// Vertex colours: makeMesh's shade of the flat face (so an undisplaced surface matches the brushes around it) plus a
// light from LIGHT on the smooth normals, which shows the relief; steep slopes red with cfg.slopeTint. withAlpha: the
// blend layer's colours, alpha as the fourth component.
const LIGHT = (l => l.map(x => x / Math.hypot(...l)))([0.6, 0.35, 0.7]);
function colours(r, n0, withAlpha) {
  const out = [], k0 = 0.72 + 0.2 * n0[2] + 0.08 * n0[0], l0 = n0[0] * LIGHT[0] + n0[1] * LIGHT[1] + n0[2] * LIGHT[2];
  for (let i = 0; i < r.alphas.length; i++) {
    const [nx, ny, nz] = r.normals.slice(i * 3, i * 3 + 3), a = r.alphas[i] / 255;
    const k = Math.min(1.1, Math.max(0.3, k0 + (nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2] - l0)));
    const red = cfg.slopeTint && nz > 1e-3 && nz < 0.7 ? 0.3 : 1;
    out.push(k, k * red, k * red, ...(withAlpha ? [a] : []));
  }
  return out;
}

function layers(L, fi) {
  const r = D.mesh(L.grid), geo = new THREE.BufferGeometry(), tri = new Array(r.indices.length / 3).fill(fi);
  const uv = V.uv({ side: L.side, pts: L.grid.flat }, 1, 1).flat().map(x => x || 0); // texels, as makeMesh; flat: Source maps the base face
  geo.setAttribute('position', new THREE.Float32BufferAttribute(r.positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(r.normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colours(r, L.grid.normal), 3));
  geo.setIndex(r.indices);
  geo.addGroup(0, r.indices.length, 0);
  const base = new THREE.Mesh(geo);
  Object.assign(base.userData, { mats: [L.mat], tri });
  base.castShadow = base.receiveShadow = true;
  L.geo = geo;
  L.P = D.positions(L.grid);
  if (!L.blend) return [base];
  const over = new THREE.BufferGeometry();
  for (const k of ['position', 'normal', 'uv']) over.setAttribute(k, geo.attributes[k]);
  over.setAttribute('color', new THREE.Float32BufferAttribute(colours(r, L.grid.normal, true), 4));
  over.setIndex(geo.index);
  L.over = over;
  const m = new THREE.Mesh(over, blendMat(L.blend));
  Object.assign(m.userData, { tri, blend: true });
  m.renderOrder = 1;
  m.visible = blendShown();
  return [base, m];
}

// Drops what was built for node (its geometries and live entries).
function drop(node) {
  for (const g of owned.get(node) ?? []) g.dispose();
  owned.delete(node);
  for (const [s, L] of live) if (L.node === node) live.delete(s);
}

// Displacement sides as their subdivided surfaces; the brush's other faces are not drawn. null (the default brush)
// when no side has a displacement that parses. A brush that lost its displacements (clip, vertex edit) drops them.
function builder(c) {
  if (c.point) return null;
  if (owned.has(c.node)) { drop(c.node); gen2++; }
  if (!c.kinds?.includes('displacements')) return null;
  const g = new THREE.Group(), geos = [];
  c.faces.forEach((f, fi) => {
    const grid = isDisp(f.side) && D.parse(f.side, f.pts);
    if (!grid) return;
    const mat = M.clean(V.get(f.side, 'material')), L = { node: c.node, side: f.side, grid, mat, blend: tex2(mat, c.node), over: null };
    g.add(...layers(L, fi));
    geos.push(L.geo, ...(L.over ? [L.over] : []));
    live.set(f.side, L);
  });
  owned.set(c.node, geos);
  gen2++;
  return g.children.length ? g : null;
}

// After a paint dab: new positions, normals and colours in place.
function refresh(L) {
  const r = D.mesh(L.grid), a = L.geo.attributes;
  a.position.array.set(r.positions);
  a.normal.array.set(r.normals);
  a.color.array.set(colours(r, L.grid.normal));
  for (const x of [a.position, a.normal, a.color]) x.needsUpdate = true;
  L.geo.computeBoundingSphere();
  L.geo.boundingBox = null;
  if (L.over) {
    L.over.attributes.color.array.set(colours(r, L.grid.normal, true));
    L.over.attributes.color.needsUpdate = true;
    L.over.computeBoundingSphere();
  }
  L.P = D.positions(L.grid);
  gen2++;
}

// ---------- 2D: displaced outlines (all), grid lines (selected) ----------
const paths = new Map(); // view name -> { gen, path } of every visible displacement's border in view coordinates
function borderPath(v) {
  const p = paths.get(v.name);
  if (p?.gen === gen2) return p.path;
  const path = new Path2D(), [a, b] = v.ax;
  for (const L of live.values()) {
    if (!cache.get(L.node)?.visible) continue;
    D.border(L.grid.n).forEach((i, k) => (k ? path.lineTo(L.P[i][a], L.P[i][b]) : path.moveTo(L.P[i][a], L.P[i][b])));
    path.closePath();
  }
  paths.set(v.name, { gen: gen2, path });
  return path;
}

function overlay2d(ctx, v, { toScreen, previewFn }) {
  if (!live.size) return;
  ctx.save();
  ctx.transform(v.z, 0, 0, -v.z, v.w / 2 - v.c[0] * v.z, v.h / 2 + v.c[1] * v.z);
  ctx.lineWidth = 1 / v.z;
  ctx.strokeStyle = '#d9c06a';
  ctx.stroke(borderPath(v));
  ctx.restore();
  const xf = previewFn(S.preview), grid = new Path2D();
  for (const L of live.values()) {
    const moving = S.mode !== 'face' && sel.has(L.node);
    if ((!moving && !faceSel.has(L.side)) || !cache.get(L.node)?.visible) continue;
    const n = L.grid.n, q = L.P.map(p => toScreen(v, moving ? xf(p) : p));
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      j ? grid.lineTo(...q[i * n + j]) : grid.moveTo(...q[i * n]);
    }
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      i ? grid.lineTo(...q[i * n + j]) : grid.moveTo(...q[j]);
    }
  }
  ctx.strokeStyle = '#ff6a6a';
  ctx.globalAlpha = 0.7;
  ctx.stroke(grid);
}

// ---------- commands ----------
// side -> [entry, face] for every visible solid.
function facesBy() {
  const m = new Map();
  for (const c of cache.values()) if (c.visible && !c.point) for (const f of c.faces) m.set(f.side, [c, f]);
  return m;
}
// [entry, face] of the selected faces, or of every face of the selected solids when no face is selected.
function picked() {
  const at = facesBy(), sides = faceSel.size ? [...faceSel] : [...sel].flatMap(n => cache.get(n)?.faces.map(f => f.side) ?? []);
  return sides.filter(s => at.has(s)).map(s => at.get(s));
}
// Runs fn(side, pts) on each item as one undo step; returns how many it changed (fn returned something truthy).
function change(items, fn) {
  let k = 0;
  if (items.length) edit([...new Set(items.map(([c]) => c.node))], [], () => { for (const [, f] of items) if (fn(f.side, f.pts)) k++; });
  return k;
}

function createSel() {
  if (!faceSel.size) return setCursor('Create displacement: select faces first (face mode, 2)');
  const items = picked(), power = +opt('dispPower'), k = change(items, (s, pts) => D.create(s, pts, power));
  setCursor(`Created ${k} displacement(s) of power ${power}${k < items.length ? `; ${items.length - k} face(s) skipped: a displacement needs a 4-sided face` : ''}`);
}

function destroySel() {
  const items = picked().filter(([, f]) => isDisp(f.side));
  setCursor(`Destroyed ${change(items, s => D.destroy(s))} displacement(s)`);
}

// Sews every pair of the selected displacements that share an edge or corner, as one undo step.
function sewSel() {
  const gs = picked().filter(([, f]) => isDisp(f.side)).map(([c, f]) => ({ c, f, g: D.parse(f.side, f.pts) })).filter(x => x.g);
  const used = new Set();
  let k = 0;
  for (let i = 0; i < gs.length; i++) for (let j = i + 1; j < gs.length; j++) {
    const n = D.sew(gs[i].g, gs[j].g);
    if (n) { k += n; used.add(gs[i]); used.add(gs[j]); }
  }
  if (!k) return setCursor('Sew: the selected displacements share no edge (select two or more)');
  edit([...new Set([...used].map(x => x.c.node))], [], () => used.forEach(x => D.write(x.f.side, x.g)));
  setCursor(`Sewed ${used.size} displacements (${k} vertices)`);
}

// Face mode: every visible displacement face; otherwise every visible brush with one.
function selectAll() {
  const cs = [...cache.values()].filter(c => c.visible && c.kinds?.includes('displacements'));
  if (S.mode === 'face') setFaceSelection(cs.flatMap(c => c.faces.filter(f => isDisp(f.side)).map(f => f.side)));
  else setSelection(cs.map(c => c.node));
  setCursor(`${cs.length} displacement brush(es) selected`);
}

// ---------- subdivide, noise, power, invert alpha, attributes ----------
const dispItems = () => picked().filter(([, f]) => isDisp(f.side));
const none = what => setCursor(`${what}: select displacements first (their faces, or their brushes)`);
// Runs fn(grid) on each picked displacement as one undo step and writes the grids it changed (fn returned true).
// Returns how many, or null when none is picked (and says so).
function eachGrid(what, fn) {
  const items = dispItems();
  if (!items.length) { none(what); return null; }
  return change(items, (s, pts) => { const g = D.parse(s, pts); return g && fn(g) && (D.write(s, g), true); });
}

// The picked displacements smoothed together as one surface (dispgeo subdivide), one undo step.
function subdivideSel() {
  const xs = dispItems().map(([c, f]) => ({ c, f, g: D.parse(f.side, f.pts) })).filter(x => x.g);
  if (!xs.length) return none('Subdivide');
  const k = D.subdivide(xs.map(x => x.g));
  if (k) edit([...new Set(xs.map(x => x.c.node))], [], () => xs.forEach(x => D.write(x.f.side, x.g)));
  setCursor(k ? `Subdivided ${xs.length} displacement(s): ${k} vertices smoothed (run it again to smooth more)` : 'Subdivide: nothing to smooth');
}

let noiseMin = -8, noiseMax = 8; // the Noise dialog's last values
async function noiseSel() {
  if (!dispItems().length) return none('Noise');
  const r = await form('Noise: every vertex moves along the face normal by a random distance from Min to Max.', [{ key: 'min', label: 'Min', value: String(noiseMin) }, { key: 'max', label: 'Max', value: String(noiseMax) }], 'Apply');
  if (!r) return;
  const a = +r.min, b = +r.max, seed = (Math.random() * 2 ** 32) >>> 0; // one seed: shared edges move alike
  if (!Number.isFinite(a) || !Number.isFinite(b)) return setCursor('Noise: Min and Max must be numbers');
  [noiseMin, noiseMax] = [Math.min(a, b), Math.max(a, b)];
  const k = eachGrid('Noise', g => D.noise(g, noiseMin, noiseMax, seed));
  setCursor(`Noise ${noiseMin} to ${noiseMax} on ${k} displacement(s)`);
}

// Power p (2-4) on the picked displacements, resampled; without p it asks.
async function powerSel(p) {
  if (!dispItems().length) return none('Power');
  if (!(p >= 2 && p <= 4)) {
    const i = await ask('Power of the selected displacements? Distances, offsets and alphas are resampled.', ['2 (5 x 5)', '3 (9 x 9)', '4 (17 x 17)', 'Cancel']);
    if (i > 2) return;
    p = i + 2;
  }
  const k = eachGrid('Power', g => D.setPower(g, p));
  setCursor(`Power ${p}: ${k} displacement(s) resampled`);
}

function invertSel() {
  const k = eachGrid('Invert alpha', D.invertAlpha);
  if (k !== null) setCursor(`Inverted the alpha of ${k} displacement(s)`);
}

// Hammer's attributes: dispinfo flags bits (CCoreDispInfo SURF_*) [command, bit, name, button]; playmove.js honours no hull.
const FLAGS = [
  ['disp.noPhysics', 2, 'No physics collision', 'No physics'],
  ['disp.noHull', 4, 'No hull collision', 'No hull'],
  ['disp.noRay', 8, 'No ray collision', 'No ray'],
];
const flagsOf = side => +V.get(V.kids(side, 'dispinfo')[0], 'flags') || 0;
const allHave = (items, bit) => items.length > 0 && items.every(([, f]) => flagsOf(f.side) & bit);
// Sets bit on every picked displacement, or clears it when all have it; one undo step.
function toggleFlag(bit, name) {
  const items = dispItems(), on = !allHave(items, bit);
  if (!items.length) return none(name);
  change(items, s => V.set(V.kids(s, 'dispinfo')[0], 'flags', String((flagsOf(s) & ~bit) | (on ? bit : 0))));
  setCursor(`${name} ${on ? 'on' : 'off'} for ${items.length} displacement(s)`);
}

// ---------- the paint tool ----------
const Z = new THREE.Vector3(0, 0, 1), tv = new THREE.Vector3();
const ring = new THREE.LineLoop(
  new THREE.BufferGeometry().setFromPoints(Array.from({ length: 48 }, (_, i) => new THREE.Vector3(Math.cos(i / 48 * Math.PI * 2), Math.sin(i / 48 * Math.PI * 2), 0))),
  new THREE.LineBasicMaterial({ color: 0xffd040, depthTest: false, transparent: true }));
ring.renderOrder = 3;
let stroke = null; // { alpha, op, touched: Set of live entries, last: [x, y, z] }

const dispHit = hit => (hit?.side && live.get(hit.side)) || null;
function showRing(hit) {
  const L = dispHit(hit);
  if (!L) { if (ring.parent) removeHelper(ring); return; }
  ring.material.color.set(opt('dispTarget') === 'alpha' ? 0x60d0ff : 0xffd040);
  ring.position.copy(hit.point);
  ring.quaternion.setFromUnitVectors(Z, tv.set(...(opt('dispAxis') === 'z' ? [0, 0, 1] : L.grid.normal)));
  ring.scale.setScalar(+opt('dispRadius'));
  if (!ring.parent) addHelper(ring); else invalidate();
}

// One dab on every visible displacement within reach of p; with the live mirror on, the twins also get one at p's
// reflection (the edit then rebuilds them from their source anyway).
function dab(p) {
  const r = +opt('dispRadius'), s = +opt('dispStrength'), axis = opt('dispAxis'), m = mirrorPoint(p), two = m?.some((x, k) => x !== p[k]);
  for (const L of live.values()) for (const q of two && twinOf(L.node) ? [p, m] : [p]) {
    const bs = L.geo.boundingSphere;
    if (!cache.get(L.node)?.visible || (bs && bs.center.distanceTo(tv.set(...q)) > bs.radius + r)) continue;
    if (stroke.alpha ? D.paintAlpha(L.grid, q, r, s, stroke.op) : D.paint(L.grid, q, r, s, stroke.op, axis)) {
      stroke.touched.add(L);
      refresh(L);
    }
  }
  stroke.last = p;
  invalidate();
  view2d.invalidate();
}

// One undo step per stroke: the grids changed live; the VMF changes once, here.
function finish() {
  const s = stroke;
  stroke = null;
  if (!s?.touched.size) return;
  const ls = [...s.touched];
  edit([...new Set(ls.map(L => L.node))], [], () => ls.forEach(L => D.write(L.side, L.grid)));
}
function cancelStroke() {
  const s = stroke;
  stroke = null;
  for (const n of new Set([...s.touched].map(L => L.node))) refreshEntry(n); // rebuilt from the unchanged VMF
  view2d.invalidate();
}

// Ctrl swaps raise and lower, Shift smooths.
function opFor(e) {
  const m = opt('dispEffect');
  if (e.shiftKey) return 'smooth';
  if (e.ctrlKey && (m === 'raise' || m === 'lower')) return m === 'raise' ? 'lower' : 'raise';
  return m;
}

const TOOL = {
  activate: () => setCursor('Paint displacements: hold the left button on a displacement. Ctrl inverts, Shift smooths, Esc stops.'),
  deactivate() { if (stroke) finish(); if (ring.parent) removeHelper(ring); },
  down(e, hit) {
    if (!dispHit(hit)) return false;
    stroke = { alpha: opt('dispTarget') === 'alpha', op: opFor(e), touched: new Set(), last: null };
    dab(hit.point.toArray());
    return true;
  },
  move(e, hit) {
    showRing(hit);
    if (stroke && dispHit(hit)) {
      const p = hit.point.toArray(), d = Math.hypot(...p.map((x, k) => x - stroke.last[k]));
      if (d >= +opt('dispRadius') / 4) dab(p);
    }
    return true;
  },
  up() { if (!stroke) return false; finish(); return true; }, // false: a default press (a click on a brush) goes on
  key(e) {
    if (e.key !== 'Escape') return false;
    if (stroke) cancelStroke(); else setTool('select');
    return true;
  },
};

// ---------- tag tools (Hammer's Walkable / Buildable) and the tag view ----------
// While the tag tool is on (tagKind 'walkable' or 'buildable') the tag view tints the triangles of every visible
// displacement: not walkable (buildable) red, forced off blue, forced on green. A click flips the triangle under the
// pointer (dispgeo toggleTag: the triangle_tags force bits), one undo step each.
let tagKind = null;
const TINT = { off: [1, 0.3, 0.25], 'forced off': [0.3, 0.5, 1], 'forced on': [0.3, 1, 0.45] };
const tagMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 }));
tagMesh.renderOrder = 2;
function tagView() {
  if (!tagKind && !tagMesh.parent) return;
  const pos = [], col = [];
  if (tagKind) for (const L of live.values()) {
    if (!cache.get(L.node)?.visible) continue;
    D.triangles(L.grid.n).forEach((t, i) => {
      const c = TINT[D.tagState(L.grid.tags[i], tagKind)];
      if (c) for (const v of t) { pos.push(...L.P[v]); col.push(...c); }
    });
  }
  tagMesh.geometry.dispose();
  tagMesh.geometry = new THREE.BufferGeometry();
  tagMesh.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  tagMesh.geometry.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  if (tagKind && !tagMesh.parent) addHelper(tagMesh);
  else if (!tagKind) removeHelper(tagMesh);
  else invalidate();
}

const TAG_TOOL = {
  activate() {
    tagKind ??= 'walkable';
    tagView();
    setCursor(`Tag ${tagKind}: click a displacement triangle to flip it. Red: not ${tagKind}, blue: forced not ${tagKind}, green: forced ${tagKind}. Esc stops.`);
  },
  deactivate() { tagKind = null; tagView(); },
  down(e, hit) {
    const L = dispHit(hit);
    if (!L) return false;
    const r = rayAt(e.offsetX, e.offsetY), i = D.rayTri(L.grid, r.origin.toArray(), r.direction.toArray()), g = L.grid;
    if (i < 0) return true;
    D.toggleTag(g, i, tagKind);
    edit([L.node], [], () => D.write(L.side, g));
    const s = D.tagState(g.tags[i], tagKind);
    setCursor(`Triangle ${i} is now ${s.endsWith('on') ? '' : 'not '}${tagKind}${s.startsWith('forced') ? ' (forced)' : ' (from its slope)'}`);
    return true;
  },
  key(e) {
    if (e.key !== 'Escape') return false;
    setTool('select');
    return true;
  },
};
const tagOn = kind => S.tool === 'disp.tag' && tagKind === kind;
// The tag tool for kind; again: back to Select.
function tagTool(kind) {
  if (tagOn(kind)) return setTool('select');
  tagKind = kind;
  if (S.tool !== 'disp.tag') return setTool('disp.tag');
  TAG_TOOL.activate();
  status();
}

// ---------- panel ----------
const controls = new Map(); // cfg key -> its input, kept in step with 'cfg'
// Numeric settings (DEF is a number) are stored as numbers, clamped to the input's min and max.
function field(key, input) {
  input.value = String(opt(key));
  input.addEventListener('change', () => {
    const n = input.value === '' ? NaN : +input.value;
    setCfg(key, typeof DEF[key] !== 'number' ? input.value : Number.isFinite(n) ? Math.min(+input.max || Infinity, Math.max(+input.min || 0, n)) : DEF[key]);
  });
  controls.set(key, input);
  return input;
}
const choice = (key, options) => field(key, el('select', {}, ...options.map(([value, textContent]) => el('option', { value, textContent }))));
const number = (key, min, max, step) => field(key, el('input', { type: 'number', min, max, step, className: 'num' }));
const row = (label, ...kids) => el('div', { className: 'dp-row' }, el('label', { textContent: label }), el('div', { className: 'dp-c' }, ...kids));
const cmdBtn = (text, cmd) => { const b = el('button', { textContent: text }); b.dataset.cmd = cmd; return b; };

let info, paintBtn, flagBtns, tagBtns;
function status() {
  const items = picked(), ds = items.filter(([, f]) => isDisp(f.side));
  info.textContent = items.length ? `${items.length} face(s) picked, ${ds.length} displacement(s)` : 'Select faces (face mode, 2) to create; brushes or faces to sew or destroy.';
  paintBtn.classList.toggle('on', S.tool === 'disp.paint');
  FLAGS.forEach(([, bit], k) => flagBtns[k].classList.toggle('on', allHave(ds, bit)));
  for (const k in tagBtns) tagBtns[k].classList.toggle('on', tagOn(k));
}

function panel() {
  info = el('small', { className: 'dp-info' });
  paintBtn = cmdBtn('Paint', 'disp.paint');
  flagBtns = FLAGS.map(([id, , , text]) => cmdBtn(text, id));
  tagBtns = { walkable: cmdBtn('Walkable', 'disp.tagWalkable'), buildable: cmdBtn('Buildable', 'disp.tagBuildable') };
  const powerBtn = el('button', { textContent: 'Set', title: 'Set the selected displacements to this power (resampled)', onclick: () => powerSel(+opt('dispPower')) });
  pane('displacement').append(el('div', { className: 'dp' },
    info,
    row('Power', choice('dispPower', [['2', '2 (5 x 5)'], ['3', '3 (9 x 9)'], ['4', '4 (17 x 17)']]), powerBtn, cmdBtn('Create', 'disp.create'), cmdBtn('Destroy', 'disp.destroy')),
    row('', cmdBtn('Sew', 'disp.sew'), cmdBtn('Select all', 'disp.selectAll')),
    row('Shape', cmdBtn('Subdivide', 'disp.subdivide'), cmdBtn('Noise', 'disp.noise'), cmdBtn('Invert alpha', 'disp.invertAlpha')),
    row('Flags', ...flagBtns),
    row('Tags', ...Object.values(tagBtns)),
    el('hr'),
    row('Tool', paintBtn),
    row('Paint', choice('dispTarget', [['geometry', 'Geometry'], ['alpha', 'Alpha (blend)']])),
    row('Effect', choice('dispEffect', [['raise', 'Raise'], ['lower', 'Lower'], ['raiseTo', 'Raise to'], ['smooth', 'Smooth']])),
    row('Axis', choice('dispAxis', [['normal', 'Face normal'], ['z', 'Z']])),
    row('Radius', number('dispRadius', 4, 4096, 8)),
    row('Strength', number('dispStrength', 0, 1024, 1)),
    el('small', { textContent: 'Strength: units (alpha: 0-255) per dab; Raise to: the distance or alpha to reach. Hold the left button on a displacement; Ctrl swaps raise and lower, Shift smooths, Esc stops.' }),
  ));
  status();
}

export function mount() {
  registerBuilder(builder);
  registerTool('disp.paint', TOOL);
  view2d.registerOverlay(overlay2d);
  onHover((hit, x) => { if (x === null && ring.parent) removeHelper(ring); }); // the pointer left the 3D view
  registerTool('disp.tag', TAG_TOOL);
  panel();
  on('doc', () => { for (const n of owned.keys()) if (!cache.has(n)) drop(n); gen2++; status(); tagView(); });
  on('filters', () => { gen2++; view2d.invalidate(); tagView(); });
  for (const t of ['selection', 'tool']) on(t, status);
  on('cfg', ({ key }) => {
    if (controls.has(key)) controls.get(key).value = String(opt(key));
    if (key !== 'renderMode') return;
    for (const L of live.values()) cache.get(L.node)?.mesh?.traverse(x => { if (x.userData.blend) x.visible = blendShown(); });
    invalidate();
  });
  register('disp.create', { title: 'Displacement: create on the selected faces', run: createSel });
  register('disp.destroy', { title: 'Displacement: destroy', run: destroySel });
  register('disp.sew', { title: 'Displacement: sew the selected', run: sewSel });
  register('disp.selectAll', { title: 'Select all displacements', run: selectAll });
  register('disp.paint', { title: 'Tool: paint displacements', run: () => setTool(S.tool === 'disp.paint' ? 'select' : 'disp.paint') });
  register('disp.subdivide', { title: 'Displacement: subdivide (smooth the selected as one surface)', run: subdivideSel });
  register('disp.noise', { title: 'Displacement: noise on the selected...', run: noiseSel });
  register('disp.power', { title: 'Displacement: change power of the selected...', run: () => powerSel() });
  register('disp.invertAlpha', { title: 'Displacement: invert alpha of the selected', run: invertSel });
  for (const [id, bit, name] of FLAGS) register(id, { title: `Displacement: ${name.toLowerCase()} on the selected (toggle)`, run: () => toggleFlag(bit, name), on: () => allHave(dispItems(), bit) });
  register('disp.tagWalkable', { title: 'Tool: tag displacement triangles walkable', run: () => tagTool('walkable'), on: () => tagOn('walkable') });
  register('disp.tagBuildable', { title: 'Tool: tag displacement triangles buildable', run: () => tagTool('buildable'), on: () => tagOn('buildable') });
}
