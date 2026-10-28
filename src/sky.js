// Sky and fog in the 3D view (Hammer++'s skybox and fog preview), and depth select.
// 2D sky (view.sky2d, on by default): worldspawn's skyname -> materials/skybox/<skyname>{rt,lf,bk,ft,up,dn}.vmt, their
// $basetexture as a cube map background in the textured and lit modes. 3D sky (view.sky3d): the objects in the
// toolsskybox room round the first sky_camera drawn behind the map, scaled by its scale with the sky_camera at the
// map's origin (as Source does), and toolsskybox faces hidden. Fog (view.fog): the first env_fog_controller, or the
// one view.fogFromSelection picked, as Source's linear fog. Depth select: Shift+middle click in the 3D view.
import * as THREE from 'three';
import * as V from '../vmf.js';
import { on, emit } from './bus.js';
import { S, doc, sel, cache, clickSelect, withGroup, setCursor } from './state.js';
import { register } from './commands.js';
import { cfg, setCfg } from './settings.js';
import { getMaterial, textureSize, clean } from './materials.js';
import { decodeRGBA } from './vtf.js';
import { scene, cam, rayAt, mousePos, addHelper, invalidate, renderMode } from './view3d.js';

// ---------- pure ----------
// three's cube faces px, nx, py, ny, pz, nz as seen with scene.backgroundRotation x = 90 degrees (z up): the Source
// face drawn there and its quarter turns clockwise. Source's faces (the engine's st_to_vec): rt +x, lf -x, bk +y,
// ft -y, up +z, dn -z, with image right and up along -y +z (rt), +y +z (lf), +x +z (bk), -x +z (ft), -y -x (up),
// -y +x (dn).
export const CUBE = [['lf', 0], ['rt', 0], ['up', 1], ['dn', -1], ['ft', 0], ['bk', 0]];

// The 3D skybox room round point o: on each axis, both ways, the nearest of boxes (the toolsskybox brushes) lying
// straight along that axis from o (o within its extent on the other two axes). null when a side has none.
// ponytail: axis lines only; a room whose wall misses o's axis lines (stepped, round) is not found.
export function skyRoom(o, boxes) {
  const mn = [-Infinity, -Infinity, -Infinity], mx = [Infinity, Infinity, Infinity];
  for (const [a, b] of boxes) {
    const out = [0, 1, 2].filter(k => o[k] < a[k] || o[k] > b[k]);
    if (out.length !== 1) continue;
    const k = out[0];
    if (o[k] < a[k]) mx[k] = Math.min(mx[k], a[k]);
    else mn[k] = Math.max(mn[k], b[k]);
  }
  return [...mn, ...mx].every(Number.isFinite) ? [mn, mx] : null;
}

// An env_fog_controller's fog { color: [r, g, b] 0-1, start, end, max } with Hammer's defaults for missing keys; null
// when fogenable is not 1 or the density cap is 0.
export function fogOf(n) {
  const num = (k, d) => { const x = parseFloat(V.get(n, k)); return Number.isFinite(x) ? x : d; };
  if (!n || num('fogenable', 0) !== 1 || !(num('fogmaxdensity', 1) > 0)) return null;
  const c = V.nums(V.get(n, 'fogcolor')), start = num('fogstart', 500);
  return { color: [0, 1, 2].map(k => (Number.isFinite(c[k]) ? c[k] : 255) / 255), start, end: Math.max(num('fogend', 2000), start + 1), max: Math.min(num('fogmaxdensity', 1), 1) };
}

// three's linear fog has only the fogNear and fogFar uniforms: fogNear carries the start in its whole part and the
// density cap in its fraction (cap / 2; 0 for a cap of 1), which the chunk below reads back.
export const fogNear = (start, max) => Math.floor(start) + (max < 1 ? Math.max(max, 0.01) / 2 : 0);
// Source's fog (CalcRangeFog): linear in view depth from fogstart to fogend, capped at fogmaxdensity. three's is a
// smoothstep without a cap. Nothing else in the editor uses fog.
THREE.ShaderChunk.fog_fragment = THREE.ShaderChunk.fog_fragment.replace('float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );',
  'float skyFogFrom = floor( fogNear ), skyFogMax = fract( fogNear ) > 0.0 ? 2.0 * fract( fogNear ) : 1.0;\n\t\tfloat fogFactor = min( skyFogMax, clamp( ( vFogDepth - skyFogFrom ) / ( fogFar - skyFogFrom ), 0.0, 1.0 ) );');

// Depth select: index into hits (the objects along the ray, nearest first) of the next one behind cur (a Set: the
// selection, or the front object's group): the first after the last hit in cur that is not in cur, round to the
// front again; -1 when every hit is in cur.
export function nextBehind(hits, cur) {
  const k = hits.findLastIndex(n => cur.has(n));
  for (let i = 1; i <= hits.length; i++) { const j = (k + i) % hits.length; if (!cur.has(hits[j])) return j; }
  return -1;
}

// ---------- 2D sky ----------
const FACES = ['rt', 'lf', 'bk', 'ft', 'up', 'dn'], BGCOLOR = '#15171c'; // view3d's background
// RGBA pixels of a material's $basetexture as materials.js loaded it ({ w, h, rgba }), or null. getMaterial first:
// its load sets the map before textureSize resolves.
async function faceImage(name) {
  const m = getMaterial(name), size = await textureSize(name), t = m.map;
  if (!size || !t) return null;
  return { w: t.image.width, h: t.image.height, rgba: t.isCompressedTexture ? decodeRGBA(t.mipmaps[0]) : t.image.data };
}

// A Source sky face as an n x n canvas turned q quarter turns clockwise (missing: the background colour). A face less
// tall than wide (Source's half-height sides) fills the top and its bottom row repeats below.
function faceCanvas(img, n, q) {
  const c = Object.assign(document.createElement('canvas'), { width: n, height: n }), g = c.getContext('2d');
  g.fillStyle = BGCOLOR;
  g.fillRect(0, 0, n, n);
  if (!img) return c;
  const px = new Uint8ClampedArray(img.rgba), src = new OffscreenCanvas(img.w, img.h);
  for (let i = 3; i < px.length; i += 4) px[i] = 255; // DXT1 black can come out transparent
  src.getContext('2d').putImageData(new ImageData(px, img.w, img.h), 0, 0);
  const h = Math.min(n, Math.round((n * img.h) / img.w));
  g.translate(n / 2, n / 2);
  g.rotate((q * Math.PI) / 2);
  g.translate(-n / 2, -n / 2);
  g.drawImage(src, 0, 0, n, h);
  if (h < n) g.drawImage(src, 0, img.h - 1, img.w, 1, 0, h, n, n - h);
  return c;
}

// The cube texture of sky name (faces at the largest face's width, at most 2048), or null when no face loads.
async function skyCube(name) {
  const imgs = Object.fromEntries(await Promise.all(FACES.map(async f => [f, await faceImage(`skybox/${name}${f}`)])));
  const n = Math.min(2048, Math.max(0, ...FACES.map(f => imgs[f]?.w ?? 0)));
  if (!n) return null;
  const t = new THREE.CubeTexture(CUBE.map(([f, q]) => faceCanvas(imgs[f], n, q)));
  t.needsUpdate = true;
  return t;
}

let cube = null, cubeFor = null; // the cube texture and the sky name it is for ('': none)
function syncSky() {
  const name = (cfg.sky2d ?? true) && doc.world ? (V.get(doc.world, 'skyname') ?? '').trim() : '';
  if (name === cubeFor) return;
  cubeFor = name;
  cube?.dispose();
  cube = null;
  invalidate();
  if (name) skyCube(name).then(t => {
    if (cubeFor !== name) return t?.dispose();
    cube = t;
    if (!t) setCursor(`sky: no materials/skybox/${name}*.vmt textures found`);
    invalidate();
  }, e => console.warn(name, e));
}

// ---------- 3D sky ----------
// While view.sky3d is on the toolsskybox materials draw nothing (alphaTest above any alpha; view3d's lit copies follow
// through 'material'). In the textured and lit modes copies of the room's objects (sky3d) are drawn first, then a
// depth reset, so the map always draws over the 3D sky and the 2D sky shows where neither is.
// ponytail: hidden sky faces let through what lies outside the map (Source draws sky there); depth-only windows would
// hide the whole map from outside a shell with toolsskybox on its outer faces.
const SKY = new Set(['tools/toolsskybox', 'tools/toolsskybox2d']), HIDE = 2, kept = new Map();
function hideSky(name, m) {
  const want = !!cfg.sky3d;
  if (want === (m.alphaTest === HIDE)) return;
  if (want) kept.set(name, m.alphaTest);
  m.alphaTest = want ? HIDE : kept.get(name) ?? 0;
  m.needsUpdate = true;
  emit('material', { name, material: m });
}

const sky3d = new THREE.Group(); // a group's renderOrder sorts all of it first
sky3d.renderOrder = -2;
sky3d.matrixAutoUpdate = false;
const reset = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  vertexShader: 'void main() { gl_Position = vec4(position.xy, 1.0, 1.0); }', // the whole view, on the far plane
  fragmentShader: 'void main() { gl_FragColor = vec4(0.0); }',
  colorWrite: false, depthFunc: THREE.AlwaysDepth,
}));
reset.frustumCulled = false;
reset.renderOrder = -1;

const isSky = c => !c.point && c.faces.some(f => SKY.has(clean(V.get(f.side, 'material'))));
const mid = (c, k) => (c.min[k] + c.max[k]) / 2;
// In the 3D sky: what the game draws (no tool brushes or entity boxes): brushes, models, overlays.
const drawn = c => !c.kinds.includes('tools') && (!c.point || c.kinds.includes('models') || /^(info_overlay|infodecal)$/.test(V.get(c.node, 'classname')));
let built = [], builtMode = null, stale = true; // [entry, its visual] copied, for the render mode builtMode

// Rebuilds the room's copies for render mode `mode`; returns a status line.
function build3d(mode) {
  stale = false;
  builtMode = mode;
  built = [];
  sky3d.clear(); // the copies share the map's geometry and materials
  const skies = [...cache.values()].filter(isSky);
  const camNode = doc.root && V.kids(doc.root, 'entity').find(n => V.get(n, 'classname') === 'sky_camera');
  const o = V.nums(camNode && V.get(camNode, 'origin')), s = parseFloat(camNode && V.get(camNode, 'scale')) || 16;
  if (o.length !== 3) return '3D sky: no sky_camera (toolsskybox faces show the 2D sky)';
  const room = skyRoom(o, skies.map(c => [c.min, c.max]));
  if (!room) return '3D sky: no toolsskybox room found round the sky_camera';
  sky3d.matrix.makeScale(s, s, s).multiply(new THREE.Matrix4().makeTranslation(-o[0], -o[1], -o[2]));
  for (const c of cache.values()) {
    if (!c.visible || !c.mesh || c.node === camNode || !drawn(c) || ![0, 1, 2].every(k => mid(c, k) > room[0][k] && mid(c, k) < room[1][k])) continue;
    built.push([c, c.mesh]);
    c.mesh.updateMatrixWorld(true);
    c.mesh.traverse(x => {
      if (!x.isMesh || !x.visible) return;
      const m = new THREE.Mesh(x.geometry, x.material);
      m.matrixAutoUpdate = false;
      m.matrix.copy(x.matrixWorld);
      sky3d.add(m);
    });
  }
  sky3d.matrixWorldNeedsUpdate = true;
  sky3d.updateMatrixWorld(true);
  return `3D sky: ${built.length} objects round the sky_camera, scale ${s}`;
}

// ---------- fog ----------
const FOG = new THREE.Fog();
const isFogCtl = n => n?.name === 'entity' && V.get(n, 'classname') === 'env_fog_controller';
let fog = null, fogNode = null; // scene.fog in the textured and lit modes; the controller view.fogFromSelection picked
// Sets fog from the picked controller (while it exists) or the map's first; returns a status line.
function syncFog() {
  const n = (cache.has(fogNode) && fogNode) || (doc.root && V.kids(doc.root, 'entity').find(isFogCtl)), f = cfg.fog && fogOf(n);
  fog = f ? FOG : null;
  if (f) {
    FOG.color.setRGB(...f.color);
    FOG.near = fogNear(f.start, f.max);
    FOG.far = f.end;
  }
  invalidate();
  return !n ? 'fog: no env_fog_controller' : f ? `fog: ${f.start} to ${f.end}, max density ${f.max}` : 'fog: off (the env_fog_controller has fogenable 0)';
}

// ---------- every frame ----------
// Background, fog and the 3D sky for the render mode, before each frame (scene.onBeforeRender: after the matrices
// are updated, before anything is drawn). Only the textured and lit modes show them.
let bg = null; // view3d's own background
function frame() {
  const mode = renderMode(), tex = mode === 'textured' || mode === 'lit', on3d = tex && !!cfg.sky3d;
  if (!scene.background?.isCubeTexture) bg = scene.background;
  scene.background = (tex && cube) || bg;
  scene.fog = tex ? fog : null;
  if (on3d && (stale || mode !== builtMode || built.some(([c, m]) => c.mesh !== m))) build3d(mode);
  sky3d.visible = reset.visible = on3d;
}

// ---------- depth select ----------
// Shift+middle click: the visible objects along the ray through canvas pixel x, y; selects the next one behind the
// selected one (else behind the front one), round to the front again, groups as a click selects them.
function depthSelect(x, y) {
  const r = rayAt(x, y), rc = new THREE.Raycaster(r.origin, r.direction);
  rc.camera = cam; // sprites need it
  const meshes = [...cache.values()].filter(c => c.visible && c.mesh).map(c => c.mesh);
  const hits = [...new Set(rc.intersectObjects(meshes, true).map(h => h.object.userData.node).filter(n => cache.has(n)))];
  if (!hits.length) return setCursor('depth select: nothing under the cursor');
  const i = nextBehind(hits, hits.some(n => sel.has(n)) ? sel : new Set(withGroup(hits[0])));
  if (i < 0) return setCursor('depth select: nothing behind it');
  clickSelect(hits[i], false);
  setCursor(`depth select: object ${i + 1} of ${hits.length} along the ray`);
}

// ---------- mount ----------
const only = () => (['textured', 'lit'].includes(renderMode()) ? '' : ' (shows in the textured and lit modes)');
function toggle(key, def) {
  setCfg(key, !(cfg[key] ?? def));
  return cfg[key] ? 'on' : 'off';
}

// el3d: the 3D pane (Shift+middle click goes to its canvas).
export function mount(el3d = document.querySelector('#v-3d')) {
  scene.backgroundRotation.set(Math.PI / 2, 0, 0); // z up (CUBE)
  const was = scene.onBeforeRender;
  scene.onBeforeRender = function (...a) { was.apply(this, a); frame(); };
  addHelper(sky3d);
  addHelper(reset);
  el3d.querySelector('canvas').addEventListener('pointerdown', e => {
    if (e.button !== 1 || !e.shiftKey || S.mode !== 'object' || S.tool !== 'select') return;
    e.preventDefault();
    depthSelect(e.offsetX, e.offsetY);
  });
  on('doc', () => { stale = true; syncSky(); syncFog(); });
  on('filters', () => { stale = true; invalidate(); });
  on('file', d => { if (d.op === 'load') { fogNode = null; syncFog(); } });
  on('material', ({ name, material }) => { if (SKY.has(name)) hideSky(name, material); });
  on('cfg', ({ key }) => {
    if (key === 'tf2') { cubeFor = null; syncSky(); }
    if (key === 'sky2d') syncSky();
    if (key === 'sky3d') { stale = true; for (const n of SKY) hideSky(n, getMaterial(n)); invalidate(); }
    if (key === 'fog') syncFog();
  });

  register('view.sky2d', { title: 'View: 2D skybox background from the skyname (toggle)', on: () => cfg.sky2d ?? true,
    run: () => setCursor(`2D sky ${toggle('sky2d', true)}${only()}`) });
  register('view.sky3d', { title: 'View: 3D skybox preview round the sky_camera, toolsskybox hidden (toggle)', on: () => !!cfg.sky3d,
    run: () => setCursor(toggle('sky3d', false) === 'on' ? build3d(renderMode()) + only() : '3D sky off') });
  register('view.fog', { title: 'View: fog preview from the env_fog_controller (toggle)', on: () => !!cfg.fog,
    run: () => { toggle('fog', false); setCursor((cfg.fog ? syncFog() : 'fog off') + only()); } });
  register('view.fogFromSelection', { title: 'View: fog preview from the selected env_fog_controller', when: () => [...sel].some(isFogCtl),
    run: () => { fogNode = [...sel].find(isFogCtl); if (!cfg.fog) setCfg('fog', true); setCursor(syncFog() + only()); } });
  register('select.behind', { title: 'Select: next object behind the one under the cursor (Shift+middle click in 3D)', when: () => !!mousePos(),
    run: () => depthSelect(...mousePos()) });
  syncSky();
  syncFog();
  for (const n of SKY) hideSky(n, getMaterial(n));
}
