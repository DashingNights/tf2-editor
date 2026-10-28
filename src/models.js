// Studio models in the 3D view. getModel(path, skin, body) loads a .mdl (mdl.js) into a cached THREE.Group; a view3d
// builder draws every point entity with a .mdl 'model' key (prop_static, prop_dynamic, prop_physics, ...) or an FGD
// studio("...")/studioprop("...") helper at its origin, angles and modelscale, with its body groups, rendercolor /
// renderamt effects and, while selected, a yellow edge glow. The default box shows while loading.
// Also the 'models/' and 'sound/' file index (VPKs + loose files) the model and sound browsers list.
import * as THREE from 'three';
import * as V from '../vmf.js';
import * as F from './fgd.js';
import { load as loadMdl } from './mdl.js';
import { openVpk, readFile } from './vpk.js';
import { on, emit } from './bus.js';
import { cfg, setCfg } from './settings.js';
import { cache, sel, registerPointLook, touch, setEntityDefaults, setCursor } from './state.js';
import { getVmt, getMaterial, getTextureSize, clean } from './materials.js';
import { registerBuilder, refreshEntry, invalidate } from './view3d.js';
import { register } from './commands.js';

const api = window.api, D2R = Math.PI / 180;
// 'Models\Props\X.MDL' -> 'models/props/x.mdl'
export const norm = p => (p ?? '').trim().toLowerCase().replace(/\\/g, '/').replace(/^\/+/, '');

// ---------- file index: 'models/...' and 'sound/...' -> VPK entry | absolute path. First source wins, in the game's
// search order: tf/custom, the tf VPKs, the hl2 VPKs, loose tf, loose hl2. ----------
let index = null;
export const assets = () => (index ??= buildIndex());
const KEEP = /^(models|sound)\//;
async function buildIndex() {
  const m = new Map(), tf = `${cfg.tf2}\\tf`, hl2 = `${cfg.tf2}\\hl2`;
  if (!cfg.tf2) return m;
  const add = (k, v) => m.has(k) || m.set(k, v);
  const vpk = p => openVpk(p, api.readBytes, '').then(es => es.forEach((v, k) => KEEP.test(k) && add(k, v)), e => console.warn(e.message));
  async function loose(dir, rel) {
    const items = (await api.listDir(dir)) ?? [];
    for (const d of items) if (!d.isDirectory) add(rel + d.name.toLowerCase(), `${dir}\\${d.name}`);
    await Promise.all(items.filter(d => d.isDirectory).map(d => loose(`${dir}\\${d.name}`, `${rel}${d.name.toLowerCase()}/`)));
  }
  const both = dir => Promise.all(['models', 'sound'].map(s => loose(`${dir}\\${s}`, s + '/')));
  for (const c of ((await api.listDir(`${tf}\\custom`)) ?? []).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (c.isDirectory) await both(`${tf}\\custom\\${c.name}`);
    else if (/\.vpk$/i.test(c.name) && !/_\d{3}\.vpk$/i.test(c.name)) await vpk(`${tf}\\custom\\${c.name}`);
  }
  for (const p of ['tf2_misc', 'tf2_sound_misc', 'tf2_sound_vo_english']) await vpk(`${tf}\\${p}_dir.vpk`);
  for (const p of ['hl2_misc', 'hl2_sound_misc', 'hl2_sound_vo_english']) await vpk(`${hl2}\\${p}_dir.vpk`);
  await both(tf);
  await both(hl2);
  return m;
}

// Bytes of an indexed file ('models/x.mdl', 'sound/x.wav'), or null.
export async function readAsset(key) {
  const e = (await assets()).get(norm(key));
  if (!e) return null;
  if (typeof e !== 'string') return readFile(e);
  const st = await api.stat(e);
  return st && new Uint8Array(await api.readBytes(e, 0, st.size));
}

// Sorted model paths without 'models/' and '.mdl' (only those with vertex data: animation-only .mdl files have none).
export const listModels = () => assets().then(m => [...m.keys()].filter(k => k.startsWith('models/') && k.endsWith('.mdl') && m.has(k.slice(0, -4) + '.vvd')).map(k => k.slice(7, -4)).sort());
// Sorted .wav / .mp3 paths without 'sound/' (what ambient_generic's message takes).
export const listSounds = () => assets().then(m => [...m.keys()].filter(k => k.startsWith('sound/') && /\.(wav|mp3)$/.test(k)).map(k => k.slice(6)).sort());

// A browser search: the plain words (for texbrowser.search's fuzzy ranking) and the filters, every one of which a path
// must pass: a word with * (any run of characters) or ? (one) matches anywhere in the path, !word drops the paths that
// contain it (wildcards allowed). -> { words, test: path -> bool | null }
export function query(q) {
  const words = [], tests = [];
  for (const w of q.trim().toLowerCase().split(/\s+/)) {
    const neg = w.startsWith('!'), t = neg ? w.slice(1) : w;
    if (!t) continue;
    if (!neg && !/[*?]/.test(t)) { words.push(t); continue; }
    const re = new RegExp(t.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.'));
    tests.push(n => re.test(n) !== neg);
  }
  return { words: words.join(' '), test: tests.length ? n => tests.every(f => f(n)) : null };
}

// ---------- models ----------
// key 'path#skin#body' -> { path, skin, body, object3d, ready, geometry, mats, bbox, info, edges, failed }; least
// recently used first. info: { sequences, parts, attachments } (mdl.js), also when the body shows no geometry; infos
// keeps it per path (every skin and body has the same).
const models = new Map(), infos = new Map(), CAP = 200;
// A model's { sequences, parts, attachments } once any skin or body of it has loaded, else null.
export const modelInfo = path => infos.get(norm(path)) ?? null;

// The cached model; ready resolves with it once its geometry and textures are in place (geometry stays null when the
// files are missing or broken: failed). object3d is a template: clone it to show it somewhere.
export function getModel(path, skin = 0, body = 0) {
  path = norm(path);
  const key = `${path}#${skin}#${body}`;
  let r = models.get(key);
  if (r) models.delete(key); // re-inserted: most recently used last
  else {
    r = { key, path, skin, body, object3d: new THREE.Group(), geometry: null, mats: null, bbox: null, info: null, edges: null, failed: false };
    r.ready = make(r).catch(e => { console.warn(path, e); r.failed = true; return r; });
    trim();
  }
  models.set(key, r);
  return r;
}

// The first cdmaterials candidate that has a VMT (else the first one: it shows as a flat colour).
async function resolveMat(cands) {
  for (const c of cands) if (await getVmt(c)) return clean(c);
  return clean(cands[0] ?? '');
}

// { w, h } of a material's base texture once materials.js has loaded it (getMaterial starts the load); null when it
// has none. Model UVs are 0..1 but materials.js textures expect texels (texture.repeat = 1 / size), as brushes use.
// ponytail: a texture that fails to load is waited for 10 s; materials.js could report failures instead.
async function texSize(name) {
  getMaterial(name);
  const p = await getVmt(name);
  if (!p?.basetexture || getTextureSize(name)) return getTextureSize(name);
  return new Promise(res => {
    const done = () => { off(); clearTimeout(t); res(getTextureSize(name)); };
    const off = on('material', d => d.name === name && done()), t = setTimeout(done, 10000);
  });
}

async function make(r) {
  const m = await loadMdl(r.path, readAsset, r.body);
  r.info = m && { sequences: m.sequences, parts: m.parts, attachments: m.attachments };
  if (m) infos.set(r.path, r.info);
  if (!m?.meshes.length) { r.failed = true; return r; }
  const fam = m.skins[r.skin] ?? m.skins[0], names = await Promise.all(m.materials.map(resolveMat));
  const byMat = Map.groupBy(m.meshes, s => names[fam[s.materialIndex]] ?? names[0] ?? '');
  const mats = [...byMat.keys()], sizes = await Promise.all(mats.map(texSize));
  r.geometry = geometry([...byMat.values()], sizes);
  r.mats = mats;
  r.bbox = m.bbox;
  const mesh = new THREE.Mesh(r.geometry, mats.map(n => getMaterial(n)));
  mesh.userData.mats = mats; // view3d swaps in the brush materials per render mode
  r.object3d.add(mesh);
  return r;
}

// One geometry, one group per material. UVs in texels; the brush shade (0.72 + 0.2 nz + 0.08 nx) as vertex colour.
function geometry(groups, sizes) {
  const n = groups.flat().reduce((a, s) => a + s.positions.length / 3, 0), pos = new Float32Array(n * 3), col = new Float32Array(n * 3), uv = new Float32Array(n * 2), idx = [];
  const g = new THREE.BufferGeometry();
  let v = 0;
  groups.forEach((meshes, gi) => {
    const start = idx.length, [w, h] = [sizes[gi]?.w ?? 1, sizes[gi]?.h ?? 1];
    for (const s of meshes) {
      const c = s.positions.length / 3;
      pos.set(s.positions, v * 3);
      for (let k = 0; k < c; k++) {
        col.fill(0.72 + 0.2 * s.normals[k * 3 + 2] + 0.08 * s.normals[k * 3], (v + k) * 3, (v + k) * 3 + 3);
        uv[(v + k) * 2] = s.uvs[k * 2] * w;
        uv[(v + k) * 2 + 1] = s.uvs[k * 2 + 1] * h;
      }
      for (const i of s.indices) idx.push(i + v);
      v += c;
    }
    g.addGroup(start, idx.length - start, gi);
  });
  g.setIndex(idx);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.computeBoundingSphere();
  return g;
}

// Drops least recently used models no entity shows while there are more than CAP.
function trim() {
  if (models.size <= CAP) return;
  const used = new Set([...cache.values()].map(c => keyOf(c.node)));
  for (const [k, r] of models) {
    if (models.size <= CAP) break;
    if (used.has(k) || (!r.geometry && !r.failed)) continue; // in use, or still loading
    r.geometry?.dispose();
    r.edges?.dispose();
    models.delete(k);
  }
}

// Drops a cached model (every skin and body; a .vvd / .dx90.vtx / .phy path means its .mdl) so it is read from disk
// again, e.g. after it was recompiled, and rebuilds the entities that show it. Emits 'modelForget' with the path (the
// Models panel drops its thumbnail).
export function forget(path) {
  path = norm(path).replace(/\.(vvd|dx90\.vtx|phy)$/, '.mdl');
  for (const [k, r] of models) if (r.path === path) { r.geometry?.dispose(); r.edges?.dispose(); models.delete(k); }
  infos.delete(path);
  touch([...cache.values()].filter(c => c.point && modelPath(c.node) === path).map(c => c.node));
  emit('modelForget', path);
}

// ---------- entities ----------
let studio = new Map(); // lower-case classname -> the model of its FGD studio("...") / studioprop("...") / lightprop("...") helper
let flipped = new Set(); // lightprop classes: Hammer reverses their pitch (the model points along vrad's light direction)

// The model a point entity shows: its 'model' key when that is a .mdl, else its class's FGD helper model.
export function modelPath(n) {
  if (n?.name !== 'entity') return null;
  const m = norm(V.get(n, 'model'));
  return m.endsWith('.mdl') ? m : studio.get((V.get(n, 'classname') ?? '').toLowerCase()) ?? null;
}
// The key that holds an entity's body group combination: the last of 'body' and prop_dynamic's 'SetBodyGroup' it has
// (both set the game's m_nBody, the later one wins), else 'body'. bodyOf: its value.
export const bodyKey = n => n.kv.findLast(p => /^(body|setbodygroup)$/i.test(p[0]))?.[0] ?? 'body';
export const bodyOf = n => Math.max(0, parseInt(V.get(n, bodyKey(n))) || 0);
const skinOf = n => +V.get(n, 'skin') || 0;
const keyOf = n => { const p = modelPath(n); return p && `${p}#${skinOf(n)}#${bodyOf(n)}`; };
// The cached model an entity shows (its skin and body), or null when it shows none.
export const modelOf = n => { const p = modelPath(n); return p && getModel(p, skinOf(n), bodyOf(n)); };

// Source angles 'pitch yaw roll': R = Rz(yaw) Ry(pitch) Rx(roll), as in vmf.js angleMatrix.
export function place(o, n) {
  const p = V.nums(V.get(n, 'origin')), a = V.nums(V.get(n, 'angles') ?? ''), s = +V.get(n, 'modelscale') || 1;
  const pitch = (a[0] || 0) * (flipped.has((V.get(n, 'classname') ?? '').toLowerCase()) ? -1 : 1);
  o.position.set(p[0] || 0, p[1] || 0, p[2] || 0);
  o.rotation.set((a[2] || 0) * D2R, pitch * D2R, (a[1] || 0) * D2R, 'ZYX');
  o.scale.setScalar(s);
  o.updateMatrixWorld(true);
  return o;
}

// World-space corners of an entity's loaded model box (corner i is at the max on axis k when bit k of i is set), or
// null (not a model, or not loaded yet).
export function modelCorners(n) {
  const k = keyOf(n), r = k && models.get(k);
  if (!r?.geometry) return null;
  const m = place(new THREE.Object3D(), n).matrixWorld;
  return [0, 1, 2, 3, 4, 5, 6, 7].map(i => new THREE.Vector3(...[0, 1, 2].map(a => r.bbox[(i >> a) & 1][a])).applyMatrix4(m).toArray());
}
// World-space [min, max] of an entity's loaded model, or null.
export function modelBounds(n) {
  const c = modelCorners(n);
  return c && [Math.min, Math.max].map(f => [0, 1, 2].map(k => f(...c.map(p => p[k]))));
}

// ---------- render effects and the selection glow ----------
const kvi = (n, k) => n.kv.find(p => p[0].toLowerCase() === k)?.[1];
const fxOn = () => cfg.propEffects ?? true, glowOn = () => cfg.propGlow ?? true;

// How the game draws a model with rendercolor, renderamt and rendermode: { tint: [r, g, b] 0..1, alpha 0..1, add }, or
// null when it draws as usual. Normal (0) ignores renderamt; Glow (3), Additive (5, 7) and World Space Glow (9) add;
// Don't Render (10) shows faint here, so it can still be seen and picked.
export function renderFx(n) {
  const c = V.nums(kvi(n, 'rendercolor') ?? ''), mode = +kvi(n, 'rendermode') || 0, amt = parseFloat(kvi(n, 'renderamt'));
  const tint = c.length >= 3 ? c.slice(0, 3).map(x => Math.min(1, Math.max(0, x / 255))) : [1, 1, 1];
  const alpha = mode === 10 ? 0.1 : mode && Number.isFinite(amt) ? Math.min(1, Math.max(0, amt / 255)) : 1, add = [3, 5, 7, 9].includes(mode);
  return tint.every(x => x === 1) && alpha === 1 && !add ? null : { tint, alpha, add };
}

// A model material with an effect: a copy shared by the props with the same one, refilled when the base material's
// texture arrives. view3d keeps it in textured and lit mode (unlit there) and shows its colour flat otherwise.
// ponytail: lit mode draws effect props fullbright; give them Lambert copies if that shows.
const fxMats = new Map();
function fxMat(name, fx) {
  const key = `${name}|${fx.tint}|${fx.alpha}|${fx.add}`;
  let m = fxMats.get(key);
  if (!m) {
    fxMats.set(key, (m = new THREE.MeshBasicMaterial({ vertexColors: true })));
    m.userData.fx = [name, fx];
    fillFx(m, getMaterial(name));
  }
  return m;
}
function fillFx(m, b) {
  const fx = m.userData.fx[1];
  for (const k of ['map', 'alphaTest', 'side']) m[k] = b[k];
  m.color.copy(b.color).multiply(new THREE.Color(...fx.tint));
  m.opacity = fx.alpha;
  m.transparent = b.transparent || fx.alpha < 1 || fx.add;
  m.depthWrite = !m.transparent;
  m.blending = fx.add ? THREE.AdditiveBlending : b.blending;
  m.needsUpdate = true;
}

// The model's edges in yellow over everything, on selected props; hidden while playtesting (playtest.js puts .playing
// on the 3D pane).
const GLOW = new THREE.LineBasicMaterial({ color: 0xffd040, transparent: true, opacity: 0.6, depthTest: false, depthWrite: false });
Object.defineProperty(GLOW, 'visible', { get: () => !document.querySelector('#v-3d.playing'), set() {} });
function glow(r) {
  const l = new THREE.LineSegments((r.edges ??= new THREE.EdgesGeometry(r.geometry, 30)), GLOW);
  l.raycast = () => {}; // never picked
  l.renderOrder = 3;
  return l;
}
// Rebuilds the props whose glow changes with the selection.
let glowing = new Set();
function reglow() {
  const now = new Set(glowOn() ? [...sel].filter(n => cache.get(n)?.point && modelPath(n)) : []);
  for (const n of new Set([...glowing, ...now])) if (glowing.has(n) !== now.has(n)) refreshEntry(n);
  glowing = now;
}

function builder(c) {
  const n = c.node, r = c.point && modelOf(n);
  if (!r) return null;
  if (!r.geometry) {
    if (!r.failed) r.ready.then(x => x.geometry && touch([n])); // its box (modelBounds) and its visual
    return null;
  }
  const o = place(r.object3d.clone(), n), fx = fxOn() && renderFx(n);
  if (fx) o.traverse(x => { if (x.userData.mats) { x.material = x.userData.mats.map(m => fxMat(m, fx)); delete x.userData.mats; } });
  if (glowOn() && sel.has(n)) o.add(glow(r));
  return o;
}

const refreshAll = () => touch([...cache.values()].filter(c => c.point && modelPath(c.node)).map(c => c.node));

let fgd = null; // tf.fgd classes
// [key, default] for the FGD keys of cls that have a default, as Hammer writes them on a new entity (fgd.js defaults).
export const fgdDefaults = cls => (fgd && F.defaults(F.resolve(fgd, cls))) ?? [];
// True when cls has a studio 'model' key (prop_static, prop_dynamic, ...); without the FGD, the prop_ classes.
export const takesModel = cls => (fgd ? !!F.resolve(fgd, cls)?.keys.some(k => k.name === 'model' && k.type === 'studio') : /^prop_/.test(cls ?? ''));
// True when cls has the FGD key (lower-case name, any case in the FGD), false when not, null without the FGD.
export const fgdHas = (cls, key) => (fgd ? !!F.resolve(fgd, cls)?.keys.some(k => k.name.toLowerCase() === key) : null);

// Classes with a fixed helper model, the class's own helper winning over its bases' (studio() without a path uses the
// model key).
async function loadFgd() {
  fgd = cfg.tf2 ? await F.shared(`${cfg.tf2}\\bin\\tf.fgd`, api.read).catch(() => null) : null;
  studio = new Map();
  flipped = new Set();
  for (const name of fgd?.keys() ?? []) {
    const h = F.resolve(fgd, name)?.helpers.findLast(h => /^(studio|studioprop|lightprop)$/.test(h.name));
    if (h?.args[0]) studio.set(name.toLowerCase(), norm(h.args[0]));
    if (h?.args[0] && h.name === 'lightprop') flipped.add(name.toLowerCase());
  }
  refreshAll();
}

export function mount() {
  registerBuilder(builder);
  registerPointLook(n => { const box = modelBounds(n); return box && { box }; });
  setEntityDefaults(fgdDefaults);
  on('doc', trim);
  on('selection', reglow);
  on('material', ({ name, material }) => {
    for (const m of fxMats.values()) if (m.userData.fx[0] === name) fillFx(m, material);
    invalidate();
  });
  on('cfg', ({ key }) => {
    if (key !== 'tf2') return;
    index = null;
    for (const r of models.values()) { r.geometry?.dispose(); r.edges?.dispose(); }
    models.clear();
    infos.clear();
    loadFgd();
  });
  const flip = (key, what, get) => { setCfg(key, !get()); setCursor(`${what} ${get() ? 'on' : 'off'}`); };
  register('view.propEffects', { title: 'View: prop render effects (rendercolor, renderamt) (toggle)', on: fxOn, run: () => {
    flip('propEffects', 'prop render effects', fxOn);
    for (const c of cache.values()) if (c.point && modelPath(c.node)) refreshEntry(c.node);
  } });
  register('view.propGlow', { title: 'View: selection glow on props (toggle)', on: glowOn, run: () => { flip('propGlow', 'selection glow', glowOn); reglow(); } });
  register('models.reload', { title: 'Models: reload every model from disk', run: () => {
    const paths = new Set([...models.values()].map(r => r.path));
    paths.forEach(forget);
    setCursor(`reloading ${paths.size} model${paths.size === 1 ? '' : 's'}`);
  } });
  loadFgd();
}
