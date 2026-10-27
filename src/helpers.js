// Entity visuals like Hammer draws them, from the FGD helpers (fgd.js resolve().helpers):
// - info_overlay and infodecal as textured quads on their face (a builder registered at import, so it comes before
//   builders that would draw their helper models);
// - every other point entity, when no other builder took it: iconsprite / sprite() as camera-facing sprites, else the
//   size() box in the FGD colour (registered once the FGD has loaded, so it comes after the other builders);
// - for the selection: sphere(), lightcone(), frustum(), wirebox(), sidelist(), origin(), axis() as lines;
// - entity lines (target, parentname, outputs, line(), cylinder(), keyframe(), vecline()) in 3D and in the 2D views,
//   toggled by 'view.entityLines' (cfg.entityLines); the sun's direction arrow on light_environment, always.
import * as THREE from 'three';
import * as V from '../vmf.js';
import * as F from './fgd.js';
import { on } from './bus.js';
import { cache, sel, setCursor, registerPointLook, touch } from './state.js';
import { cfg, setCfg } from './settings.js';
import { register } from './commands.js';
import { getMaterial, getVmt, clean } from './materials.js';
import { registerBuilder, refreshEntry, addHelper, invalidate } from './view3d.js';
import { registerOverlay, invalidate as invalidate2d } from './view2d.js';
import { lightDir } from './lighting.js';

const api = window.api, D2R = Math.PI / 180, LIFT = 0.25; // quads sit LIFT units off their face
const add = (a, b, k = 1) => a.map((x, i) => x + b[i] * k);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = a => { const l = Math.hypot(...a); return l > 1e-9 ? a.map(x => x / l) : null; };
const rgb = c => `rgb(${c.slice(0, 3).join(',')})`;

// ---------- pure helpers ----------
// Keyvalue by case-insensitive key (FGD helper arguments name keys in any case).
export const kv = (n, k) => n.kv.find(p => p[0].toLowerCase() === k.toLowerCase())?.[1];
const vec = (n, k) => { const v = V.nums(kv(n, k)); return v.length >= 3 ? v.slice(0, 3) : null; };
const num = (n, k, d = 0) => { const v = parseFloat(kv(n, k)); return Number.isFinite(v) ? v : d; };

// Source angles (pitch yaw roll): yaw about z, then pitch about y, then roll about x. Columns: forward, left, up.
export const angleMatrix = a => new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler((a[2] || 0) * D2R, (a[0] || 0) * D2R, (a[1] || 0) * D2R, 'ZYX'));

// info_overlay corners: BasisOrigin + uv_i.x * BasisU + uv_i.y * BasisV, lifted off the face, with the texture
// coordinates the engine gives them: (StartU, StartV), (StartU, EndV), (EndU, EndV), (EndU, StartV). null when a key
// is missing.
export function overlayQuad(n) {
  const o = vec(n, 'BasisOrigin'), u = vec(n, 'BasisU'), v = vec(n, 'BasisV'), nn = vec(n, 'BasisNormal'), uvs = [0, 1, 2, 3].map(i => vec(n, 'uv' + i));
  if (!o || !u || !v || !nn || uvs.some(q => !q)) return null;
  const [su, eu, sv, ev] = [['StartU', 0], ['EndU', 1], ['StartV', 0], ['EndV', 1]].map(([k, d]) => num(n, k, d));
  return { pts: uvs.map(q => add(add(add(o, u, q[0]), v, q[1]), nn, LIFT)), uv: [[su, sv], [su, ev], [eu, ev], [eu, sv]] };
}

// p lies inside the convex polygon f (vmf.js faces entry) once projected onto its plane.
function inside(p, f) {
  const s = f.pts.map((a, i) => dot(cross(add(f.pts[(i + 1) % f.pts.length], a, -1), add(p, a, -1)), f.n));
  return s.every(x => x >= -1e-6) || s.every(x => x <= 1e-6);
}
// The brush face an infodecal at o lands on: the nearest within 4 units whose polygon contains o. null when none.
export function decalFace(o, entries) {
  let best = null, bd = 4;
  for (const c of entries) {
    if (c.point || o.some((x, k) => x < c.min[k] - 4 || x > c.max[k] + 4)) continue;
    for (const f of c.faces) {
      const d = Math.abs(dot(o, f.n) - dot(f.pts[0], f.n));
      if (d < bd && inside(o, f)) [best, bd] = [f, d];
    }
  }
  return best;
}
// A w x h quad centred on o's projection onto face f, along the face's texture axes (as the engine places decals).
export function decalQuad(o, f, w, h) {
  const flat = a => unit(add(a, f.n, -dot(a, f.n))), ax = k => V.nums(V.get(f.side, k)).slice(0, 3);
  const u = flat(ax('uaxis')) ?? flat([1, 0, 0]) ?? flat([0, 1, 0]), v = flat(ax('vaxis')) ?? cross(f.n, u);
  const p = add(o, f.n, LIFT - (dot(o, f.n) - dot(f.pts[0], f.n)));
  return { pts: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => add(add(p, u, (i * w) / 2), v, (j * h) / 2)), uv: [[0, 0], [1, 0], [1, 1], [0, 1]] };
}

// Entity links as [from node, to node | point, css colour]: target, parentname, connections (outputs), keyframe() /
// animator() NextKey, FGD line(colour, key1, value1[, key2, value2]) and cylinder() pairs, vecline(key) points.
// Targetnames match case-insensitively, with a trailing * as a wildcard. defOf(classname) -> resolved FGD class | null.
export const TARGET = '#e6e6a0', OUTPUT = '#6cb8ff';
export function links(ents, defOf) {
  const named = new Map(), out = [], seen = new Set(), idx = new Map(ents.map((e, i) => [e, i]));
  for (const e of ents) { const t = kv(e, 'targetname')?.toLowerCase(); if (t) (named.get(t) ?? named.set(t, []).get(t)).push(e); }
  const find = (key, value) => {
    const s = value?.toLowerCase();
    if (!s || s.startsWith('!')) return [];
    if (key.toLowerCase() !== 'targetname') return ents.filter(e => kv(e, key)?.toLowerCase() === s);
    return s.endsWith('*') ? [...named].filter(([k]) => k.startsWith(s.slice(0, -1))).flatMap(x => x[1]) : named.get(s) ?? [];
  };
  const link = (a, b, col) => {
    const k = idx.get(a) < idx.get(b) ? `${idx.get(a)} ${idx.get(b)}` : `${idx.get(b)} ${idx.get(a)}`;
    if (a !== b && !seen.has(k)) { seen.add(k); out.push([a, b, col]); }
  };
  const pairs = (from, to, col) => from.forEach(a => to.forEach(b => link(a, b, col)));
  for (const e of ents) {
    for (const k of ['target', 'parentname']) pairs([e], find('targetname', kv(e, k)), TARGET);
    for (const c of V.kids(e, 'connections')) for (const [, v] of c.kv) pairs([e], find('targetname', v.split(/[,\x1b]/)[0]), OUTPUT);
    for (const { name, args: a } of defOf(kv(e, 'classname') ?? '')?.helpers ?? []) {
      if (name === 'keyframe' || name === 'animator') pairs([e], find('targetname', kv(e, 'NextKey')), TARGET);
      else if (name === 'vecline') { const p = vec(e, a[0] ?? ''); if (p) out.push([e, p, TARGET]); }
      else if ((name === 'line' || name === 'cylinder') && a.length >= 3) {
        const col = rgb(V.nums(a[0])), [k2, v2] = name === 'line' ? [a[3], a[4]] : [a[4], a[5]];
        pairs(k2 && v2 ? find(a[1], kv(e, a[2])) : [e], find(k2 && v2 ? k2 : a[1], kv(e, k2 && v2 ? v2 : a[2])), col);
      }
    }
  }
  return out;
}

// Line segments [a, b, css colour] for the helpers Hammer draws on a selected point entity n of class d.
// sides: side id -> vmf.js faces entry, for sidelist().
export function shapes(n, d, sides = new Map()) {
  const o = vec(n, 'origin'), col = d?.color ? rgb(d.color) : '#c8d0ff', out = [];
  if (!o || !d) return out;
  const seg = (a, b, c = col) => out.push([a, b, c]);
  const ring = (c, r, u, w, cl, k = 48) => { for (let i = 0; i < k; i++) { const p = t => add(add(c, u, r * Math.cos(t)), w, r * Math.sin(t)); seg(p((i / k) * 2 * Math.PI), p(((i + 1) / k) * 2 * Math.PI), cl); } };
  const basis = dir => { const u = unit(cross(dir, Math.abs(dir[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0])); return [u, cross(dir, u)]; };
  const cross3 = (p, s, c) => [0, 1, 2].forEach(k => { const e = [0, 0, 0]; e[k] = s; seg(add(p, e, -1), add(p, e), c); });
  const m = angleMatrix(V.nums(kv(n, 'angles'))).elements, fwd = [m[0], m[1], m[2]], left = [m[4], m[5], m[6]], up = [m[8], m[9], m[10]];
  for (const { name, args: a } of d.helpers) {
    if (name === 'sphere') {
      const r = num(n, a[0] || 'radius');
      if (r > 0) for (const [u, w] of [[[1, 0, 0], [0, 1, 0]], [[1, 0, 0], [0, 0, 1]], [[0, 1, 0], [0, 0, 1]]]) ring(o, r, u, w);
    } else if (name === 'lightcone') {
      const dir = lightDir(kv(n, 'angles'), num(n, 'pitch'), num(n, 'angle')), [u, w] = basis(dir);
      const len = num(n, '_zero_percent_distance') || num(n, '_fifty_percent_distance') || num(n, '_distance') || 128;
      for (const [deg, cl] of [[num(n, '_cone', 45), col], [num(n, '_inner_cone', 30), '#ffffff']]) {
        const t = Math.min(deg, 89) * D2R, c = add(o, dir, len * Math.cos(t)), r = len * Math.sin(t);
        ring(c, r, u, w, cl, 32);
        for (const [x, y] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) seg(o, add(add(c, u, r * x), w, r * y), cl);
      }
    } else if (name === 'frustum') {
      const fov = num(n, a[0] || 'lightfov', 90), near = num(n, a[1] || 'nearz', 4), far = num(n, a[2] || 'farz', 750), lc = V.nums(kv(n, a[3] || 'lightcolor'));
      const t = Math.tan((Math.min(fov, 170) * D2R) / 2), cl = lc.length >= 3 ? rgb(lc) : col;
      const rect = z => [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([i, j]) => add(add(add(o, fwd, z), left, z * t * i), up, z * t * j));
      const [A, B] = [rect(near), rect(far)];
      for (let i = 0; i < 4; i++) { seg(A[i], A[(i + 1) % 4], cl); seg(B[i], B[(i + 1) % 4], cl); seg(o, B[i], cl); }
    } else if (name === 'wirebox') {
      const lo = vec(n, a[0] ?? ''), hi = vec(n, a[1] ?? '');
      if (lo && hi) for (let i = 0; i < 8; i++) for (const k of [0, 1, 2]) if (!(i & (1 << k))) {
        const p = j => [0, 1, 2].map(q => o[q] + (j & (1 << q) ? hi : lo)[q]);
        seg(p(i), p(i | (1 << k)));
      }
    } else if (name === 'sidelist') {
      for (const id of (kv(n, a[0] || 'sides') ?? '').split(/\s+/)) { const f = sides.get(id); if (f) f.pts.forEach((p, i) => seg(p, f.pts[(i + 1) % f.pts.length], '#ffd040')); }
    } else if (name === 'origin') {
      const p = vec(n, a[0] || 'origin');
      if (p) cross3(p, 8, '#ffd040');
    } else if (name === 'axis') {
      const v = V.nums(kv(n, a[0] || 'axis'));
      if (v.length >= 6) { seg(v.slice(0, 3), v.slice(3, 6), '#ffd040'); cross3(v.slice(0, 3), 4, '#ffd040'); cross3(v.slice(3, 6), 4, '#ffd040'); }
    }
  }
  return out;
}

// ---------- FGD ----------
let fgd = null, fallback = null;
const defs = new Map();
const defOf = cls => (defs.has(cls) ? defs.get(cls) : defs.set(cls, fgd && F.resolve(fgd, cls)).get(cls));
const helper = (d, name) => d?.helpers.findLast(h => h.name === name) ?? null;

// The first load registers the fallback builder (after every builder registered at mount); later loads rebuild.
async function loadFgd() {
  const map = cfg.tf2 ? await F.shared(`${cfg.tf2}\\bin\\tf.fgd`, api.read).catch(() => null) : null;
  fgd = map?.size ? map : null;
  defs.clear();
  if (!fallback) fallback = registerBuilder(visual);
  touch([...cache.values()].filter(c => c.point).map(c => c.node)); // FGD boxes and colours (look)
  relink();
}

// ---------- materials with 0..1 UVs (materials.js textures repeat per texel) ----------
// kind: 'q' quad, 's' icon sprite, 'a' additive sprite (env_sprite glows have black, not transparent, backgrounds).
const units = new Map(); // 'name|kind' -> material
function unitMat(name, kind = 'q') {
  const key = `${clean(name)}|${kind}`;
  let m = units.get(key);
  if (!m) {
    m = kind !== 'q' ? new THREE.SpriteMaterial({ alphaTest: 0.05 })
      : new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 });
    m.userData.kind = kind;
    units.set(key, m);
    fill(m, getMaterial(name));
  }
  return m;
}
function fill(m, b) {
  m.color.copy(b.color);
  if (b.map) {
    m.map?.dispose();
    m.map = b.map.clone();
    m.map.repeat.set(1, 1);
    // Sprite UVs have v up; the textures are not flipped (v = 0 is the top row).
    if (m.isSpriteMaterial) { m.map.repeat.y = -1; m.map.offset.y = 1; }
  }
  m.blending = m.userData.kind === 'a' ? THREE.AdditiveBlending : b.blending;
  m.alphaTest = Math.max(b.alphaTest, 0.05);
  m.needsUpdate = true;
  invalidate();
}

// infodecal size: the texture size times $decalscale, known once the texture has loaded; until then 32 x 32.
const decalSize = new Map(), decalWait = new Map();
function decalDims(name, node) {
  const key = clean(name);
  if (decalSize.has(key)) return decalSize.get(key);
  const w = decalWait.get(key) ?? decalWait.set(key, new Set()).get(key);
  w.add(node);
  if (w.size === 1) measured(key, getMaterial(key));
  return [32, 32];
}
function measured(key, m) {
  const size = m.map?.userData.size, nodes = decalWait.get(key);
  if (!size || !nodes) return;
  decalWait.delete(key);
  getVmt(key).then(p => {
    const k = parseFloat(p?.kv.get('$decalscale')) || 1;
    decalSize.set(key, [size.w * k, size.h * k]);
    nodes.forEach(refreshEntry);
  });
}

// ---------- builders ----------
// Builders own their geometry: the previous build's geometry of a node goes when it is rebuilt or deleted.
const owned = new Map();
function own(node, o) {
  o.traverse(x => x.geometry && !x.isSprite && (owned.get(node) ?? owned.set(node, []).get(node)).push(x.geometry));
  return o;
}
function free(node) { owned.get(node)?.forEach(g => g.dispose()); owned.delete(node); }

function quadMesh(q, mat) {
  const g = new THREE.BufferGeometry(), ix = [0, 1, 2, 0, 2, 3];
  g.setAttribute('position', new THREE.Float32BufferAttribute(ix.flatMap(i => q.pts[i]), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(ix.flatMap(i => q.uv[i]), 2));
  return new THREE.Mesh(g, mat);
}

// info_overlay / infodecal: the quad with its material (null without one: the next builder draws the entity).
function decals(c) {
  if (!c.point) return null;
  const n = c.node, cls = kv(n, 'classname');
  if (cls !== 'info_overlay' && cls !== 'infodecal') return null;
  free(n);
  const mat = kv(n, cls === 'infodecal' ? 'texture' : 'material'), o = vec(n, 'origin');
  if (!mat || !o) return null;
  let q = null;
  if (cls === 'info_overlay') q = overlayQuad(n);
  else { const f = decalFace(o, cache.values()); q = f && decalQuad(o, f, ...decalDims(mat, n)); }
  return q && own(n, quadMesh(q, unitMat(mat)));
}

// A point entity's box and colour from its FGD size() and color() (state's cache entry, so the 2D views, the selection
// box and the default 3D box agree); model bounds (models.js) win over size().
function look(n) {
  const d = defOf(kv(n, 'classname') ?? ''), o = vec(n, 'origin');
  return d && o && { box: d.size?.map(v => v.map((x, k) => o[k] + x)), color: d.color && rgb(d.color) };
}

// Every other point entity: its icon (iconsprite, or the sprite() entity's own sprite); null leaves the default box.
function visual(c) {
  if (!c.point) return null;
  const n = c.node, d = defOf(kv(n, 'classname') ?? ''), o = vec(n, 'origin');
  free(n);
  if (!o) return null;
  const icon = helper(d, 'iconsprite'), spr = helper(d, 'sprite');
  if (icon || spr) {
    const name = (icon?.args[0] || kv(n, 'model') || '').replace(/\.spr$/i, '');
    if (name) {
      const s = new THREE.Sprite(unitMat(name, icon ? 's' : 'a')), k = icon ? 16 : Math.max(8, 32 * num(n, 'scale', 1));
      s.position.set(...o);
      s.scale.set(k, k, 1);
      return s;
    }
  }
  return null;
}

// ---------- lines: entity links (always, when on) and the selection's helper shapes ----------
const lineMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 });
const linkObj = new THREE.LineSegments(new THREE.BufferGeometry(), lineMat), selObj = new THREE.LineSegments(new THREE.BufferGeometry(), lineMat);
let linkSegs = new Map(), selSegs = new Map(); // css colour -> [[a, b]], for the 2D overlay
const linesOn = () => cfg.entityLines ?? true;

function setSegs(o, segs) {
  const pos = [], col = [], c = new THREE.Color(), by = new Map();
  for (const [a, b, css] of segs) {
    pos.push(...a, ...b);
    c.set(css);
    col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    (by.get(css) ?? by.set(css, []).get(css)).push([a, b]);
  }
  o.geometry.dispose();
  o.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)).setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return by;
}

// Visible entities with their centres: point entities at their box centre, brush entities at their solids' centre.
function centres() {
  const box = new Map();
  for (const c of cache.values()) {
    const e = c.point ? c.node : c.owner;
    if (!c.visible || e.name !== 'entity') continue;
    const b = box.get(e);
    box.set(e, b ? [b[0].map((x, k) => Math.min(x, c.min[k])), b[1].map((x, k) => Math.max(x, c.max[k]))] : [c.min, c.max]);
  }
  return new Map([...box].map(([e, [a, b]]) => [e, a.map((x, k) => (x + b[k]) / 2)]));
}

// The way each light_environment's sunlight goes (as vrad reads it: lighting.js lightDir) as a 256-unit arrow from
// it, always drawn.
export function sunArrow(o, d, len = 256, col = '#ffd040') {
  const tip = add(o, d, len), u = unit(cross(d, Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0])), w = cross(d, u);
  return [[o, tip, col], ...[u, w].flatMap(v => [1, -1].map(s => [tip, add(add(tip, d, -len / 6), v, (s * len) / 16), col]))];
}

function relink() {
  const at = centres(), segs = [];
  for (const c of cache.values()) {
    const n = c.node, o = c.point && c.visible && kv(n, 'classname') === 'light_environment' && vec(n, 'origin');
    if (o) segs.push(...sunArrow(o, lightDir(kv(n, 'angles'), num(n, 'pitch'), num(n, 'angle'))));
  }
  if (linesOn()) for (const [a, b, col] of links([...at.keys()], defOf)) { const p = at.get(a), q = Array.isArray(b) ? b : at.get(b); if (p && q) segs.push([p, q, col]); }
  linkSegs = setSegs(linkObj, segs);
  reshape();
}

function reshape() {
  const sides = new Map(), es = [...sel].filter(n => n.name === 'entity');
  if (es.some(n => helper(defOf(kv(n, 'classname') ?? ''), 'sidelist'))) for (const c of cache.values()) for (const f of c.faces) sides.set(V.get(f.side, 'id'), f);
  selSegs = setSegs(selObj, es.flatMap(n => shapes(n, defOf(kv(n, 'classname') ?? ''), sides)));
  invalidate();
  invalidate2d();
}

function overlay2d(ctx, v, { toScreen }) {
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.85;
  for (const [col, ss] of [...linkSegs, ...selSegs]) {
    ctx.strokeStyle = col;
    ctx.beginPath();
    for (const [a, b] of ss) { ctx.moveTo(...toScreen(v, a)); ctx.lineTo(...toScreen(v, b)); }
    ctx.stroke();
  }
}

// ---------- mount ----------
// At import: the decal builder goes before the builders that modules register at mount (models.js would draw the
// overlay's helper model instead of the overlay).
registerBuilder(decals);

on('material', ({ name, material }) => {
  for (const t of 'qsa') { const m = units.get(`${name}|${t}`); if (m) fill(m, material); }
  measured(name, material);
});

export function mount() {
  registerPointLook(look);
  addHelper(linkObj);
  addHelper(selObj);
  registerOverlay(overlay2d);
  on('doc', () => {
    for (const n of owned.keys()) if (!cache.has(n)) free(n);
    relink();
  });
  on('filters', relink);
  on('selection', reshape);
  on('cfg', ({ key }) => {
    if (key === 'entityLines') relink();
    if (key === 'tf2') { decalSize.clear(); loadFgd(); }
  });
  register('view.entityLines', { title: 'View: entity lines (targets, parents, outputs) (toggle)', on: linesOn, run: () => {
    setCfg('entityLines', !linesOn());
    setCursor(`entity lines ${linesOn() ? 'on' : 'off'}`);
  } });
  loadFgd();
}
