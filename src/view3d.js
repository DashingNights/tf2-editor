// 3D viewport: scene, fly/orbit camera, picking, gizmo, selection modes, push/pull, on-demand rendering.
// Builds the meshes for state's cache entries.
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import * as V from '../vmf.js';
import { on, emit } from './bus.js';
import { S, doc, sel, faceSel, cache, selBox, selPivot, selYaw, selFrame, setGizmoMode, snapRef, boxOf, edit, setSelection, clickSelect, setFaceSelection, setMode, setTool, setPreview, setCursor, transformSel, rotateSel, createBlock, createEntity, applyMaterial } from './state.js';
import { register, held } from './commands.js';
import { cfg, setCfg } from './settings.js';
import { getMaterial, flatColor, clean } from './materials.js';
import { el } from './dom.js';
import { extract, atten, reach, luxels, densityHue, renderFx } from './lighting.js';
import * as snap from './snap.js';
import * as texdrag from './texdrag.js';

THREE.ColorManagement.enabled = false;
let canvas, renderer, tc, marqueeEl, hud, snapEl, over3d = false, mouse = null;
export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x15171c);
export const cam = new THREE.PerspectiveCamera(75, 1, 2, 60000);
cam.up.set(0, 0, 1);
const fly = { pos: new THREE.Vector3(), yaw: Math.PI / 4, pitch: -0.5 };
const dir = () => [Math.cos(fly.pitch) * Math.cos(fly.yaw), Math.cos(fly.pitch) * Math.sin(fly.yaw), Math.sin(fly.pitch)];
const MAT = new THREE.MeshBasicMaterial({ vertexColors: true }); // point entities: colour in the vertex colours
const D2R = Math.PI / 180, fmt = x => String(Math.round(x * 1e6) / 1e6);
const centre = b => b[0].map((x, k) => (x + b[1][k]) / 2);
const sn = (x, g) => Math.round(x / g) * g;

// ---------- render modes and brush meshes ----------
// textured: materials.js materials (flat colour until the VTF loads). flat / wireframe: one flat colour per material.
// lit: a Lambert copy of each textured material (flat shaded, no vertex colour shade) lit by the map's lights.
// lightmap: Hammer's lightmap grid, a checker cell per luxel tinted by the side's lightmap scale (LMAP).
const RMODES = ['textured', 'flat', 'wireframe', 'lit', 'lightmap'];
let rmode = RMODES.includes(cfg.renderMode) ? cfg.renderMode : 'textured';
const flats = new Map(), lits = new Map();
const flatMat = name => flats.get(name) ?? flats.set(name, new THREE.MeshBasicMaterial({ color: flatColor(name), vertexColors: true, wireframe: rmode === 'wireframe' })).get(name);
// onBeforeRender: materials.js proxies animate the copy while it is drawn.
function copyLit(b, l) {
  for (const k of ['map', 'transparent', 'depthWrite', 'alphaTest', 'blending', 'side', 'onBeforeRender']) l[k] = b[k];
  l.color.copy(b.color);
  l.needsUpdate = true;
  fxSync(l);
}
function litMat(name) {
  let l = lits.get(name);
  if (!l) { lits.set(name, (l = new THREE.MeshLambertMaterial({ flatShading: true }))); l.onBeforeCompile = litShader; copyLit(getMaterial(name), l); }
  return l;
}
// Brush entity render effects (lighting.js renderFx: rendercolor, renderamt) in the textured and lit modes: a copy of
// the mode's material per effect, kept in step with it. View: render effects (cfg.renderFx) turns them off.
const fxs = new Map(), fxTint = new THREE.Color(); // material -> Map(effect key -> [copy, effect])
function fxMat(b, fx) {
  if (!fx || cfg.renderFx === false) return b;
  const by = fxs.get(b) ?? fxs.set(b, new Map()).get(b);
  let e = by.get(fx.key);
  if (!e) { by.set(fx.key, (e = [b.clone(), fx])); fxCopy(b, ...e); }
  return e[0];
}
function fxCopy(b, f, fx) {
  f.copy(b);
  Object.assign(f, { onBeforeRender: b.onBeforeRender, onBeforeCompile: b.onBeforeCompile });
  f.color.multiply(fxTint.setRGB(...fx.tint));
  if (fx.alpha < 1 || fx.add) Object.assign(f, { transparent: true, depthWrite: false, opacity: fx.alpha, blending: fx.add ? THREE.AdditiveBlending : THREE.NormalBlending });
  f.needsUpdate = true;
}
const fxSync = b => fxs.get(b)?.forEach(([f, fx]) => fxCopy(b, f, fx));
// Lightmap density: a 2 x 2 checker, one texel per luxel (makeMesh puts luxel coordinates in the uvs and the scale's
// tint in the vertex colours). Tool faces have no lightmap and stay flat.
const checker = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255, 150, 150, 150, 255, 150, 150, 150, 255, 255, 255, 255, 255]), 2, 2);
Object.assign(checker, { wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, magFilter: THREE.NearestFilter, minFilter: THREE.LinearMipmapLinearFilter, generateMipmaps: true, needsUpdate: true });
checker.repeat.set(0.5, 0.5);
const LMAP = new THREE.MeshBasicMaterial({ map: checker, vertexColors: true });
function matFor(m, n) {
  if (rmode === 'textured') return fxMat(getMaterial(n), m.userData.fx);
  if (rmode === 'lit') return fxMat(litMat(n), m.userData.fx);
  return rmode === 'lightmap' && m.userData.lm && !n.startsWith('tools/') ? LMAP : flatMat(n);
}
const matsOf = m => m.userData.mats?.map(n => matFor(m, n)) ?? MAT;
// Builder meshes: userData.mats (material names per geometry group) get the brush materials; the others keep their
// own material when textured or lit and a flat stand-in of its colour otherwise.
const stand = new WeakMap();
function modeMat(m) {
  if (rmode === 'textured' || rmode === 'lit') return m;
  let f = stand.get(m);
  if (!f) stand.set(m, (f = new THREE.MeshBasicMaterial({ color: m.color ?? 0xc8c8c8, vertexColors: m.vertexColors, side: m.side })));
  f.wireframe = rmode === 'wireframe';
  return f;
}
// Dimmed visuals (setDimmer: outside the cordon) are a faint grey in every render mode.
const dimMat = c => new THREE.MeshBasicMaterial({ color: 0x6a7284, vertexColors: c, transparent: true, opacity: 0.1, depthWrite: false });
const DIM = [dimMat(false), dimMat(true)];
function applyMode(o) {
  const dim = o.userData.dim;
  o.traverse(x => {
    if (!x.isMesh) return;
    if (dim) return void (x.material = DIM[+!!x.geometry.attributes.color]);
    if ('mats' in x.userData) return void (x.material = matsOf(x));
    x.userData.orig ??= x.material;
    x.material = Array.isArray(x.userData.orig) ? x.userData.orig.map(modeMat) : modeMat(x.userData.orig);
  });
}
let slopes = !!cfg.slopeTint; // tint faces too steep to walk on (0 < normal z < 0.7, steeper than 45.57 degrees) red

// c: a cache entry, or { node, faces, point } for previews. Brushes get one geometry group per material with texel
// UVs (vmf.js uv; materials.js sets texture.repeat to 1/size) and the face shade as vertex colour. Point entities
// get their 2D colour in the vertex colours. userData.tri maps each triangle, in emitted order, to its face index.
// Lightmap mode (userData.lm): luxel UVs and the lightmap scale's tint instead. userData.fx: the brush entity's
// render effect.
export function makeMesh(c) {
  const pos = [], uv = [], col = [], tri = [], g = new THREE.BufferGeometry(), tint = new THREE.Color(c.point ? c.color2d : 0xffffff);
  const byMat = Map.groupBy(c.faces.map((f, fi) => [f, fi]), ([f]) => (c.point ? '' : clean(V.get(f.side, 'material'))));
  const lm = rmode === 'lightmap' && !c.point, lc = new THREE.Color(1, 1, 1);
  for (const [name, fs] of byMat) {
    const start = pos.length / 3;
    for (const [f, fi] of fs) {
      const t = c.point ? null : lm ? luxels(f) : V.uv(f, 1, 1), k = 0.72 + 0.2 * f.n[2] + 0.08 * f.n[0];
      const red = slopes && !c.point && f.n[2] > 1e-3 && f.n[2] < 0.7 ? 0.3 : 1;
      if (lm && !name.startsWith('tools/')) lc.setHSL(densityHue(V.get(f.side, 'lightmapscale')), 0.75, 0.55);
      else lc.setRGB(1, 1, 1);
      for (let i = 1; i < f.pts.length - 1; i++) {
        for (const j of [0, i, i + 1]) {
          pos.push(...f.pts[j]);
          uv.push(...(t ? t[j].map(x => x || 0) : [0, 0])); // || 0: a malformed uaxis gives NaN
          col.push(tint.r * k * lc.r, tint.g * k * red * lc.g, tint.b * k * red * lc.b);
        }
        tri.push(fi);
      }
    }
    g.addGroup(start, pos.length / 3 - start, g.groups.length);
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const m = new THREE.Mesh(g, MAT), ent = !c.point && c.owner?.name === 'entity' ? c.owner : null;
  m.userData = { node: c.node, tri, mats: c.point ? null : [...byMat.keys()], lm, fx: ent && renderFx(ent) };
  m.material = matsOf(m);
  // Lit mode: the sun's shadow. Tool brushes cast none except nodraw and blocklight (opaque to vrad too), brush
  // entities none but func_detail (or with vrad_brush_cast_shadows, as vrad).
  const casts = !ent || V.get(ent, 'classname') === 'func_detail' || V.get(ent, 'vrad_brush_cast_shadows') === '1';
  m.castShadow = !c.point && casts && m.userData.mats.some(n => !n.startsWith('tools/') || /^tools\/tools(nodraw|blocklight)$/.test(n));
  m.receiveShadow = !c.point;
  m.matrixAutoUpdate = false; // identity except while a drag previews the selection (see render)
  return m;
}

// ---------- overlays: selection, selected faces, hover, vertex dots, drag ghost ----------
export const fan = faces => faces.flatMap(f => f.pts.slice(1, -1).flatMap((p, i) => [...f.pts[0], ...p, ...f.pts[i + 2]]));
const tint = (color, opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
const FACE = tint(0xff2020, 0.55); // red like Hammer: dev textures are orange and grey
const faceHi = new THREE.Mesh(new THREE.BufferGeometry(), FACE), hovHi = new THREE.Mesh(new THREE.BufferGeometry(), tint(0xffffff, 0.2));
const selHi = new THREE.Mesh(new THREE.BufferGeometry(), tint(0xff2a2a, 0.45)); // follows the drag preview (see render)
const selBoxes = new THREE.Group(); // bounding boxes and tints of selected builder visuals, also following the preview
selHi.matrixAutoUpdate = selBoxes.matrixAutoUpdate = false;
scene.add(selBoxes);
const dots = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xffffff, size: 6, sizeAttenuation: false, depthTest: false }));
dots.renderOrder = 2;
scene.add(selHi, faceHi, hovHi, dots);
const geo = pos => new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
function setGeo(o, pos) {
  o.geometry.dispose();
  o.geometry = geo(pos);
  invalidate();
}

// Builder visuals get the tint on their own meshes (c.faces is only their box): the whole visual when selected, or in
// face mode the triangles whose userData.tri face is selected.
const SEL = tint(0xff2a2a, 0.45), inv = new THREE.Matrix4();
function tintInto(group, c, mat, faces) {
  c.mesh.updateMatrixWorld(true);
  inv.copy(c.mesh.matrixWorld).invert();
  c.mesh.traverse(x => {
    if (!x.isMesh || !x.visible || x.userData.blend) return;
    let g = x.geometry;
    if (faces) {
      const keep = x.userData.tri?.map(fi => faces.has(c.faces[fi]?.side));
      if (!keep?.some(Boolean)) return;
      if (!keep.every(Boolean)) {
        const p = g.attributes.position, ix = g.index, out = [];
        keep.forEach((k, t) => { if (k) for (let j = t * 3; j < t * 3 + 3; j++) { const i = ix ? ix.getX(j) : j; out.push(p.getX(i), p.getY(i), p.getZ(i)); } });
        g = geo(out);
      }
    }
    const m = new THREE.Mesh(g, mat);
    m.matrixAutoUpdate = false;
    m.matrix.multiplyMatrices(inv, x.matrixWorld);
    m.userData.shared = g === x.geometry; // the builder's geometry: not ours to dispose
    group.add(m);
  });
}

// In face mode the object selection is not drawn, so the face highlight stays readable. A tool with drawsSelection
// (polyedit.js) draws its own: no tint, face highlight or vertex dots then.
function overlays() {
  const fs = [], ss = [], pts = new Map(), own = !!tool()?.drawsSelection;
  for (const b of selBoxes.children) { if (!b.userData.shared) b.geometry.dispose(); if (b.isBox3Helper) b.material.dispose(); }
  selBoxes.clear();
  for (const c of cache.values()) {
    if (!c.visible || own) continue;
    const built = c.mesh?.userData.built;
    if (S.mode !== 'face' && sel.has(c.node)) {
      if (!built) ss.push(...c.faces);
      else { selBoxes.add(new THREE.Box3Helper(new THREE.Box3().setFromObject(c.mesh), 0xff2a2a)); tintInto(selBoxes, c, SEL); }
    }
    if (S.mode === 'face') {
      if (built) tintInto(selBoxes, c, FACE, faceSel);
      else for (const f of c.faces) if (faceSel.has(f.side)) fs.push(f);
    }
    if (S.mode === 'vertex' && !c.point && sel.has(c.node)) for (const f of c.faces) for (const p of f.pts) pts.set(p.join(), p);
  }
  setGeo(selHi, fan(ss));
  setGeo(faceHi, fan(fs));
  setGeo(dots, [...pts.values()].flat());
}

let ghost = null;
function setGhost(m) {
  if (ghost) { scene.remove(ghost); ghost.geometry.dispose(); }
  ghost = m;
  if (m) scene.add(m);
  paint();
}

// ---------- meshes for cache entries ----------
// fn(entry) -> Object3D or null replaces the entry's default visual (registerBuilder; the first non-null result wins).
// The object goes into a container that previews drags like a brush mesh; every descendant gets userData.node, so picks
// map back to the entry. Builders own their geometry and materials: the editor never disposes them.
const builders = [];
export function registerBuilder(fn) {
  builders.push(fn);
  rebuildAll();
  return () => { builders.splice(builders.indexOf(fn), 1); rebuildAll(); };
}
function rebuildAll() {
  if (!renderer) return; // before mount: the first load builds them
  for (const c of cache.values()) c.mesh = null;
  syncMeshes();
  overlays();
}
// Rebuilds one entry's visual, e.g. once a builder's async model load has finished. Calls in one task are batched.
let refreshing = false;
export function refreshEntry(node) {
  const c = cache.get(node);
  if (!c || !renderer) return;
  c.mesh = null;
  if (refreshing) return;
  refreshing = true;
  queueMicrotask(() => { refreshing = false; syncMeshes(); overlays(); });
}
// fn(entry) -> true dims that entry's visual (cordon.js: outside the cordon). Callers refresh the entries that change.
// Returns the dimmer it replaces, so a module can dim on top of it for a while and put it back.
let dimmer = null;
export function setDimmer(fn) { const was = dimmer; dimmer = fn; return was; }
function visual(c) {
  let o = null;
  for (const b of builders) {
    try { o = b(c); } catch (e) { console.error(e); }
    if (o) break;
  }
  if (o) {
    o = new THREE.Group().add(o);
    o.matrixAutoUpdate = false;
    o.traverse(x => { x.userData.node = c.node; });
    o.userData.built = true;
  } else o = makeMesh(c);
  o.userData.dim = !!dimmer?.(c);
  if (o.userData.built || o.userData.dim) applyMode(o);
  return o;
}

const meshes = new Map(), moved = new Set();
function syncMeshes() {
  for (const [n, m] of meshes) if (cache.get(n)?.mesh !== m) { scene.remove(m); m.geometry?.dispose(); meshes.delete(n); moved.delete(m); }
  for (const c of cache.values()) if (!c.mesh) { c.mesh = visual(c); scene.add(c.mesh); meshes.set(c.node, c.mesh); }
  paint();
}
let hov = null; // { node, face } under the mouse
function paint() {
  const hide = drag?.kind === 'push' && ghost ? drag.hit.node : null;
  for (const c of cache.values()) if (c.mesh) c.mesh.visible = c.visible && c.node !== hide;
  invalidate();
}

let leak = null;
function setLeak(pts) {
  if (leak) { scene.remove(leak); leak.geometry.dispose(); leak = null; }
  if (pts) {
    leak = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts.map(p => new THREE.Vector3(...p))), new THREE.LineBasicMaterial({ color: 0xff2020, depthTest: false }));
    leak.renderOrder = 1;
    scene.add(leak);
  }
  invalidate();
}

// ---------- lit mode: the map's lights (lighting.js) ----------
// Point and spot lights live in fixed pools (a new light count recompiles every lit material), filled with the lights
// nearest the camera and refilled after it moves REFILL units; their falloff is vrad's (litShader). light_environment
// casts the sun's shadow (one shadow map over the brushes that cast them, redrawn on edits only: a sky box around the
// map would stretch its texels past the thickness of walls and floors, and light leaks through them). The first slots
// of each pool cast shadows too (SHADOWS in all, cfg.lightShadows): they hold the lights brightest at the camera, and
// a slot's shadow is redrawn when its light changes. Three's Lambert divides by pi, so PI * brightness gives Source's
// value at 100 units; LIT_SCALE tones down maps whose lights add up past white.
const MAX_LIGHTS = 64, MAX_SPOTS = 16, REFILL = 256, LIT_SCALE = 0.6, SHADOWS = 4;
const rig = new THREE.Group(), sun = new THREE.DirectionalLight(), sky = new THREE.HemisphereLight();
const pools = { point: [], spot: [] };
let lights = [], litAt = null;
const lv = new THREE.Vector3();
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0002;
sun.shadow.normalBias = 2;
sun.shadow.autoUpdate = false;
rig.add(sun, sun.target, sky);

// Lit materials (onBeforeCompile) light with vrad's falloff instead of three's inverse square: a pool light's decay
// is its slot in VRAD, which holds (c, l, q, fade start) of lighting.js falloff, and its distance the fade end. The
// GLSL is lighting.js atten.
const VRAD = { value: Array.from({ length: MAX_LIGHTS + MAX_SPOTS }, () => new THREE.Vector4()) };
const PARS = THREE.ShaderChunk.lights_pars_begin.replace(/float getDistanceAttenuation[\s\S]*?\n}\n/, `uniform vec4 vradK[ ${MAX_LIGHTS + MAX_SPOTS} ];
float getDistanceAttenuation( const in float d, const in float end, const in float slot ) {
	vec4 k = vradK[ int( slot + 0.5 ) ];
	float e = k.z < 0.0 ? min( d, k.w ) : d;
	float f = 1.0 / max( k.x + e * ( k.y + e * k.z ), 1e-4 );
	if ( end > k.w ) f *= saturate( ( end - d ) / ( end - k.w ) );
	else if ( end > 0.0 && d > end ) f = 0.0;
	return f;
}
`);
if (PARS === THREE.ShaderChunk.lights_pars_begin) console.warn('lit mode: the vrad falloff did not fit this three.js version');
export function litShader(s) {
  s.uniforms.vradK = VRAD;
  s.fragmentShader = s.fragmentShader.replace('#include <lights_pars_begin>', PARS);
}

function resizePool(kind, n) {
  const p = pools[kind];
  while (p.length > n) { const l = p.pop(); rig.remove(l, l.target ?? l); l.dispose(); }
  while (p.length < n) {
    // bias 0: their depth is perspective, where -0.0005 is some 40 units at 200; the normal bias keeps faces off acne
    const l = kind === 'spot' ? new THREE.SpotLight() : new THREE.PointLight();
    Object.assign(l.shadow, { autoUpdate: false, bias: 0, normalBias: 2 });
    l.shadow.mapSize.set(512, 512);
    p.push(l);
    rig.add(l);
    if (l.target) rig.add(l.target);
  }
}
// slot: the light's VRAD entry. A shadow slot's camera reaches as far as the light does.
function setLight(L, l, slot) {
  const a = l.att;
  L.position.set(...l.origin);
  L.color.setRGB(...l.color);
  L.intensity = Math.PI * LIT_SCALE;
  L.decay = slot;
  L.distance = a.end;
  VRAD.value[slot].set(a.c, a.l, a.q, a.start);
  if (L.castShadow) { L.shadow.camera.far = reach(a, Math.max(...l.color) * LIT_SCALE); L.shadow.camera.updateProjectionMatrix(); }
  if (l.kind !== 'spot') return;
  L.angle = Math.min(l.cone, 89) * D2R;
  L.penumbra = Math.min(1, Math.max(0, 1 - l.inner / l.cone));
  L.target.position.set(...l.origin.map((x, k) => x + l.dir[k] * 64));
}
// all: redraw every light's shadow (the map changed).
function fillPools(all = false) {
  litAt = cam.position.clone(); // the fly camera, or the playtest's
  const d2 = l => litAt.distanceToSquared(lv.set(...l.origin)), at = l => Math.max(...l.color) * atten(l.att, Math.sqrt(d2(l)));
  let redraw = all;
  for (const kind of ['point', 'spot']) {
    const pool = pools[kind], ls = lights.filter(l => l.kind === kind), n = pool.filter(L => L.castShadow).length;
    const strong = n ? [...ls].sort((a, b) => at(b) - at(a)).slice(0, n) : [];
    const order = [...strong, ...ls.filter(l => !strong.includes(l)).sort((a, b) => d2(a) - d2(b))];
    pool.forEach((L, i) => {
      if (L.castShadow && (all || L.userData.light !== order[i])) L.shadow.needsUpdate = redraw = true;
      L.userData.light = order[i];
      setLight(L, order[i], (kind === 'spot' ? MAX_LIGHTS : 0) + i);
    });
  }
  if (redraw && renderer) renderer.shadowMap.needsUpdate = true;
}
// The first n slots of a pool cast shadows; a slot that stops frees its shadow map.
function shadowSlots(pool, n) {
  pool.forEach((L, i) => {
    L.castShadow = i < n;
    if (!L.castShadow && L.shadow.map) { L.shadow.map.dispose(); L.shadow.map = null; }
  });
}
// Sun and sky from light_environment (the sun shines along lighting.js lightDir); without one a dim white sky, bright
// when the map has no lights at all (Source draws such maps fullbright).
function buildRig() {
  lights = extract(doc.root);
  const count = k => lights.filter(l => l.kind === k).length, spots = Math.min(count('spot'), MAX_SPOTS), points = Math.min(count('point'), MAX_LIGHTS - spots);
  resizePool('spot', spots);
  resizePool('point', points);
  // shadow slots: SHADOWS in all, half of them spots while there are points enough
  const on = cfg.lightShadows !== false, sp = on ? Math.min(spots, SHADOWS - Math.min(points, SHADOWS / 2)) : 0;
  shadowSlots(pools.spot, sp);
  shadowSlots(pools.point, on ? Math.min(points, SHADOWS - sp) : 0);
  fillPools(true);
  sun.shadow.needsUpdate = true;
  const env = lights.find(l => l.kind === 'sun'), casters = [...cache.values()].filter(c => c.mesh?.castShadow), [mn, mx] = boxOf(casters.length ? casters : cache.values());
  sun.visible = !!env && mn.every(Number.isFinite);
  sky.intensity = Math.PI * (env ? 1 : lights.length ? 0.15 : 0.8);
  sky.color.setRGB(...(env?.ambient.map(x => Math.max(x, 0.05)) ?? [1, 1, 1]));
  sky.groundColor.copy(sky.color).multiplyScalar(0.5);
  if (sun.visible) {
    const c = new THREE.Vector3(...centre([mn, mx])), r = Math.hypot(...mx.map((x, k) => x - mn[k])) / 2, cam = sun.shadow.camera;
    sun.color.setRGB(...env.color);
    sun.intensity = Math.PI;
    sun.target.position.copy(c);
    sun.position.copy(c).addScaledVector(new THREE.Vector3(...env.dir), -2 * r);
    Object.assign(cam, { left: -r, right: r, top: r, bottom: -r, near: r * 0.5, far: r * 3.5 });
    cam.updateProjectionMatrix();
  }
  if (renderer) renderer.shadowMap.needsUpdate = true;
  invalidate();
}

// ---------- API ----------
const ray = new THREE.Raycaster();
const ndc = (x, y) => new THREE.Vector2((x / canvas.clientWidth) * 2 - 1, 1 - (y / canvas.clientHeight) * 2);
const visibleMeshes = () => [...cache.values()].filter(c => c.visible && c.mesh).map(c => c.mesh);
// x, y: CSS pixels in the 3D canvas. Returns { node, side, point, face } for the nearest visible object, or null.
export function pick(x, y) {
  ray.setFromCamera(ndc(x, y), cam);
  return hitOf(ray.intersectObjects(visibleMeshes(), true)[0]);
}
// A raycast hit as pick() reports it. userData.tri maps triangles to face indices; a builder object without it reports
// the entry face whose normal is closest to the hit's.
const nv = new THREE.Vector3(), fv = new THREE.Vector3();
function hitOf(h) {
  const c = h && cache.get(h.object.userData.node);
  if (!c) return null;
  let face = h.object.userData.tri && c.faces[h.object.userData.tri[h.faceIndex]];
  if (!face && c.faces.length) {
    if (h.face) nv.copy(h.face.normal).transformDirection(h.object.matrixWorld); else nv.set(0, 0, 1);
    face = c.faces.reduce((a, f) => (nv.dot(fv.set(...f.n)) > nv.dot(fv.set(...a.n)) ? f : a));
  }
  return { node: c.node, side: face?.side ?? null, point: h.point, face: face ?? null };
}

// Mouse ray through canvas pixel x, y (a copy).
export function rayAt(x, y) { ray.setFromCamera(ndc(x, y), cam); return ray.ray.clone(); }
// For snapping (snap.js): the canvas pixel of world point p (null behind the camera or off the canvas), the ray through
// a pixel as arrays, the face under a pixel of the entries skip() does not exclude, the last pointer position.
const pv = new THREE.Vector3();
export function screenOf(p) {
  pv.set(...p).project(cam);
  if (pv.z < -1 || pv.z > 1) return null;
  return [((pv.x + 1) / 2) * canvas.clientWidth, ((1 - pv.y) / 2) * canvas.clientHeight];
}
export const rayArr = s => { const r = rayAt(...s); return { o: r.origin.toArray(), d: r.direction.toArray() }; };
export function hitExcept(s, skip) {
  ray.setFromCamera(ndc(...s), cam);
  const h = hitOf(ray.intersectObjects([...cache.values()].filter(c => c.visible && c.mesh && !skip(c.node)).map(c => c.mesh), true)[0]);
  return h?.face ? { point: h.point.toArray(), n: h.face.n } : null;
}
export const mousePos = () => mouse;
// The snap target marker (null: none), in the 3D view and the 2D views.
export function snapMark(at) {
  snap.mark.at = at;
  const s = at && screenOf(at);
  snapEl.hidden = !s;
  if (s) snapEl.style.transform = `translate(${s[0] - 6}px, ${s[1] - 6}px)`;
}

// Display-only objects (scale aids, previews): drawn, never hit by pick() (it tests cache meshes only).
export function addHelper(o) { scene.add(o); invalidate(); }
export function removeHelper(o) { scene.remove(o); invalidate(); }
// The render mode now (playtest's unsaved switch included): sky.js reads it before every frame for the sky and fog.
export const renderMode = () => rmode;

// fn(hit, x, y) after the pointer moves over the 3D view, at most once per animation frame. hit is pick()'s result;
// x, y and hit are null once the pointer leaves. Returns the unsubscribe function.
const hoverFns = new Set();
let hoverAt = null, hoverRaf = 0;
export function onHover(fn) { hoverFns.add(fn); return () => hoverFns.delete(fn); }
function reportHover(xy) {
  hoverAt = xy;
  if (!hoverFns.size || hoverRaf) return;
  hoverRaf = requestAnimationFrame(() => {
    hoverRaf = 0;
    const h = hoverAt && pick(...hoverAt);
    for (const fn of hoverFns) try { fn(h, ...(hoverAt ?? [null, null])); } catch (e) { console.error(e); }
  });
}

// Draw tool hook (blockout.js): { start(hit, x, y) -> true to take the drag, move(x, y), up(x, y), press(x, y),
// cancel(), busy }. A left drag that starts on a surface in object mode (no Ctrl) goes to start/move/up instead of the
// marquee; while busy, pointer moves go to move, a left press (no Alt) to press, and Escape to cancel.
let hook = null;
export function setDrawHook(h) { hook = h; }
export const drawBusy = () => !!hook?.busy; // a drawn primitive waits for its height click

// 'textured' | 'flat' | 'wireframe' | 'lit' | 'lightmap'. Saved as cfg.renderMode unless save is false. Returns the
// mode it replaces.
export function setRenderMode(mode, save = true) {
  const was = rmode;
  rmode = mode;
  for (const m of [MAT, ...flats.values()]) m.wireframe = mode === 'wireframe';
  if (mode === 'lit') { scene.add(rig); buildRig(); } else scene.remove(rig);
  // luxel uvs and tints are in the geometry: brush meshes are made again into and out of the lightmap mode
  if ((was === 'lightmap') !== (mode === 'lightmap')) { for (const c of cache.values()) if (c.mesh && !c.mesh.userData.built) c.mesh = null; syncMeshes(); }
  for (const c of cache.values()) if (c.mesh) applyMode(c.mesh);
  if (save && cfg.renderMode !== mode) setCfg('renderMode', mode);
  hudText();
  invalidate();
  return was;
}

// Frames box in every view. inside: put the 3D camera in a top corner looking at the center (maps are wrapped in skybox brushes).
export function focus(box, inside = false) {
  if (!box?.[0].every(Number.isFinite)) box = [[-512, -512, -128], [512, 512, 128]];
  emit('focus', { box, inside });
}

let focusPt = null; // orbit pivot when nothing is selected
// Puts the camera at p looking at t.
function lookAt(p, t) {
  const d = t.map((x, k) => x - p[k]);
  fly.pos.set(...p);
  fly.yaw = Math.atan2(d[1], d[0]);
  fly.pitch = Math.atan2(d[2], Math.hypot(d[0], d[1]));
}
function fit({ box: [mn, mx], inside }) {
  const c = centre([mn, mx]), size = Math.max(64, ...mx.map((x, k) => x - mn[k]));
  focusPt = new THREE.Vector3(...c);
  if (inside) lookAt([mn[0] + (mx[0] - mn[0]) * 0.1, mn[1] + (mx[1] - mn[1]) * 0.1, mx[2] - (mx[2] - mn[2]) * 0.1], c);
  else {
    const f = dir();
    fly.pos.set(c[0] - f[0] * size * 0.8, c[1] - f[1] * size * 0.8, c[2] - f[2] * size * 0.8);
  }
  invalidate();
}

// Above the first info_player_teamspawn's player model (72 units tall), facing its angles (Source pitch is positive
// looking down). Leaves the camera when the map has none.
function spawnView() {
  const e = V.kids(doc.root, 'entity').find(n => V.get(n, 'classname') === 'info_player_teamspawn');
  const o = e && V.nums(V.get(e, 'origin')), a = e && V.nums(V.get(e, 'angles') ?? '0 0 0');
  if (o?.length !== 3) return;
  fly.pos.set(o[0], o[1], o[2] + 96);
  fly.yaw = (a[1] || 0) * D2R;
  fly.pitch = -(a[0] || 0) * D2R;
  invalidate();
}

// ---------- render loop (on demand) ----------
// Playtest (playtest.js): fn(cam, now) places the camera every frame instead of the fly camera (left as it was), frames
// run continuously and the editor overlays are not drawn. null gives the view back with the 3D view's fov.
let camHook = null;
export function setCamHook(fn) {
  camHook = fn;
  if (!fn) { cam.fov = +cfg.fov || 75; cam.updateProjectionMatrix(); }
  invalidate();
}
// The fly camera: { pos: [x, y, z], yaw, pitch } in radians.
export const flyView = () => ({ pos: fly.pos.toArray(), yaw: fly.yaw, pitch: fly.pitch });
export function setFlyView({ pos, yaw, pitch }) {
  if (pos?.length === 3 && pos.every(Number.isFinite)) fly.pos.set(...pos);
  if (Number.isFinite(yaw)) fly.yaw = yaw;
  if (Number.isFinite(pitch)) fly.pitch = pitch;
  invalidate();
}
let raf = 0, last = 0;
export function invalidate() { raf ||= requestAnimationFrame(frame); }
function frame(now) {
  raf = 0;
  if (camHook) { invalidate(); return render(now); }
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  if (S.fly) {
    const f = dir(), r = [Math.sin(fly.yaw), -Math.cos(fly.yaw)], k = c => (held.has(c) ? 1 : 0);
    const sp = (cfg.flySpeed || 900) * (held.has('ShiftLeft') ? +cfg.flySpeedBoost || 3.3 : 1) * dt, fw = k('KeyW') - k('KeyS'), rt = k('KeyD') - k('KeyA'), up = k('KeyE') - k('KeyQ');
    fly.pos.x += (f[0] * fw + r[0] * rt) * sp;
    fly.pos.y += (f[1] * fw + r[1] * rt) * sp;
    fly.pos.z += (f[2] * fw + up) * sp;
    invalidate();
  }
  render();
}

// Matrix that previews the drag on the selected meshes: S.preview p' = p * s + t (in the frame turned by yaw about z),
// or a rotation r about r.pivot.
const M = new THREE.Matrix4(), Mz = new THREE.Matrix4(), tmp = new THREE.Vector3();
function previewMatrix() {
  const xf = S.preview;
  if (!xf) return null;
  if (!xf.r) {
    M.makeScale(...xf.s).setPosition(...xf.t);
    return xf.yaw ? M.premultiply(Mz.makeRotationZ(xf.yaw * D2R)).multiply(Mz.makeRotationZ(-xf.yaw * D2R)) : M;
  }
  const { axis, deg, pivot: p } = xf.r, ax = typeof axis === 'number' ? tmp.set(0, 0, 0).setComponent(axis, 1) : tmp.set(...axis).normalize();
  M.makeRotationAxis(ax, deg * D2R);
  tmp.set(...p).applyMatrix4(M);
  return M.setPosition(p[0] - tmp.x, p[1] - tmp.y, p[2] - tmp.z);
}
function render(now) {
  for (const m of moved) { m.matrix.identity(); m.matrixWorldNeedsUpdate = true; }
  moved.clear();
  const P = previewMatrix();
  if (P) for (const n of sel) {
    const m = cache.get(n)?.mesh;
    if (m) { m.matrix.copy(P); m.matrixWorldNeedsUpdate = true; moved.add(m); }
  }
  for (const o of [selHi, selBoxes]) {
    if (P) o.matrix.copy(P);
    else o.matrix.identity();
    o.matrixWorldNeedsUpdate = true;
  }
  const f = dir();
  cam.position.copy(fly.pos);
  cam.lookAt(fly.pos.x + f[0], fly.pos.y + f[1], fly.pos.z + f[2]);
  let hid = [];
  if (camHook) { // only the map's visuals: no selection, gizmo, grid, helpers or previews
    const keep = new Set(meshes.values()).add(rig);
    hid = scene.children.filter(o => o.visible && !keep.has(o));
    camHook(cam, now);
    hid.forEach(o => { o.visible = false; });
  }
  if (rmode === 'lit' && litAt && cam.position.distanceTo(litAt) > REFILL) fillPools();
  cam.updateMatrixWorld();
  renderer.render(scene, cam);
  hid.forEach(o => { o.visible = true; });
}
function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setPixelRatio(devicePixelRatio);
  renderer.setSize(w, h, false);
  cam.aspect = w / Math.max(h, 1);
  cam.updateProjectionMatrix();
  invalidate();
}

// ---------- gizmo ----------
// The gizmo drives a proxy at the selection box centre. The drag previews on the meshes; release applies one state edit.
const proxy = new THREE.Object3D(), MODES = ['translate', 'rotate', 'scale'], NAMES = { translate: 'move', rotate: 'rotate', scale: 'scale' };
let gz = null, shift = false; // the gizmo mode is S.gizmo (shared with poly edit), its space cfg.gizmoSpace
// Snap steps: grid (Shift: a quarter, at least 1 unit), 1 unit with grid snapping off; rotation in degrees, 0.5 with
// snapping off.
const step = () => (!cfg.snapGrid ? 1 : shift ? Math.min(S.grid, Math.max(1, S.grid / 4)) : S.grid);
const rstep = () => (!cfg.snapRotation ? 0.5 : shift ? +cfg.rotationStepFine || 5 : +cfg.rotationStep || 15);
const pointOnly = () => [...sel].every(n => cache.get(n)?.point);

// Local space follows the angles of a single selected point entity (Source: yaw about z, pitch about y, roll about x),
// else the selection's own angle about z (a diagonal wall's, a slanted flight's: selYaw).
function localQuat() {
  if (cfg.gizmoSpace !== 'local') return new THREE.Quaternion();
  const n = sel.size === 1 && sel.values().next().value, a = n?.name === 'entity' ? V.nums(V.get(n, 'angles')) : [];
  return a.length === 3 ? new THREE.Quaternion().setFromEuler(new THREE.Euler(a[2] * D2R, a[0] * D2R, a[1] * D2R, 'ZYX')) : new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), selYaw() * D2R);
}

function placeGizmo() {
  hudText();
  if (gz) return;
  const b = selBox();
  if (!b || !S.gizmo || S.mode !== 'object' || S.tool !== 'select' || (S.gizmo === 'scale' && pointOnly())) { tc.detach(); return invalidate(); }
  proxy.position.fromArray(selPivot());
  proxy.quaternion.copy(localQuat());
  proxy.scale.set(1, 1, 1);
  tc.setMode(S.gizmo);
  tc.setSpace(cfg.gizmoSpace === 'local' ? 'local' : 'world');
  tc.attach(proxy);
  invalidate();
}

// World rotation q as { axis: 0|1|2 or unit vector, deg } with deg snapped to st; null when it snaps to nothing.
export function rotOf(q, st) {
  const s = Math.sign(q.w) || 1, deg = sn((2 * Math.acos(Math.min(1, Math.abs(q.w)))) / D2R, st);
  const ax = [q.x * s, q.y * s, q.z * s], l = Math.hypot(...ax), k = ax.findIndex(x => Math.abs(x) > 0.999 * l);
  if (!deg || !l) return null;
  return k < 0 ? { axis: ax.map(x => x / l), deg } : { axis: k, deg: deg * Math.sign(ax[k]) };
}

// New [lo, hi] when the gizmo scales an extent by f: the size snaps to the grid g, never below min(size, g).
// Only the dragged face moves (like Hammer's resize handles): a handle on the + side moves hi, one on the - side (neg)
// moves lo. centered splits the change between both ends in grid steps instead.
export function scaleExtent(lo, hi, f, g, centered = false, neg = false) {
  const size = hi - lo, ns = Math.max(sn(size * f, g), Math.min(size, g)), a = centered ? Math.floor((ns - size) / 2 / g) * g : 0;
  return neg && !centered ? [hi - ns, hi] : [lo - a, lo - a + ns];
}

function gizmoStart() {
  // scaling works in the gizmo's frame: the selection's own box and angle in local space
  const f = selFrame(); // its own box and angle in local space, the world box in world space
  // neg: which handles were grabbed on the - side of the gizmo (the press point, relative to it, per axis of its frame)
  const ps = tc.pointStart.clone().applyQuaternion(proxy.quaternion.clone().invert()), neg = [0, 1, 2].map(k => ps.getComponent(k) < 0);
  gz = { mode: tc.mode, axis: tc.axis, box: f.box, yaw: f.yaw, ref: snapRef(), p0: proxy.position.clone(), q0: proxy.quaternion.clone(), xf: null, rot: null, neg };
  const skip = n => sel.has(n);
  gz.snap = tc.mode === 'translate' && snap.any() && snap.snapper({ proj: screenOf, ray: rayArr, hit: s => hitExcept(s, skip), moving: snap.movingOf(sel), skip });
}

function gizmoMove() {
  if (!gz) return;
  const g = step(), act = k => gz.axis.includes('XYZ'[k]);
  if (gz.mode === 'translate') {
    // Snap the box corner (point entities: origin) to the grid like the 2D views; in a rotated local frame snap the offset.
    const local = Math.abs(gz.q0.w) < 1 - 1e-9, r = local ? [0, 0, 0] : gz.ref;
    const d = proxy.position.clone().sub(gz.p0).applyQuaternion(gz.q0.clone().invert()).toArray();
    const t = new THREE.Vector3(...d.map((x, k) => (act(k) ? sn(r[k] + x, g) - r[k] : 0))).applyQuaternion(gz.q0);
    if (gz.snap) {
      // a point of the selection onto unselected geometry, along the gizmo's axes
      const qi = gz.q0.clone().invert(), allow = a => new THREE.Vector3(...a).applyQuaternion(qi).toArray().map((x, k) => (act(k) ? x : 0));
      // object snaps test the unsnapped offset, so a target near the pointer counts even off the grid
      const raw = new THREE.Vector3(...d.map((x, k) => (act(k) ? x : 0))).applyQuaternion(gz.q0).toArray();
      const hit = gz.snap(raw, a => new THREE.Vector3(...allow(a)).applyQuaternion(gz.q0).toArray(), mouse);
      if (hit) t.set(...hit.t);
      snapMark(hit?.at ?? null);
    }
    proxy.position.copy(gz.p0).add(t);
    gz.xf = { s: [1, 1, 1], t: t.toArray() };
    setPreview(gz.xf);
  } else if (gz.mode === 'scale') {
    const s = [1, 1, 1], t = [0, 0, 0], [lo, hi] = gz.box;
    for (let k = 0; k < 3; k++) {
      if (!act(k) || hi[k] === lo[k]) continue;
      const [a, b] = scaleExtent(lo[k], hi[k], proxy.scale.getComponent(k), g, gz.axis === 'XYZ', gz.neg[k]);
      s[k] = (b - a) / (hi[k] - lo[k]);
      t[k] = a - lo[k] * s[k];
    }
    gz.xf = { s, t, yaw: gz.yaw };
    setPreview(gz.xf);
  } else {
    gz.rot = rotOf(proxy.quaternion.clone().multiply(gz.q0.clone().invert()), rstep());
    setPreview(gz.rot && { s: [1, 1, 1], t: [0, 0, 0], r: { ...gz.rot, pivot: gz.p0.toArray() } });
  }
}

function gizmoEnd() {
  const g = gz;
  gz = null;
  if (snap.mark.at) snapMark(null);
  if (S.preview) setPreview(null);
  if (g?.rot) rotateSel(g.rot.axis, g.rot.deg, g.p0.toArray());
  else if (g?.xf && (g.xf.t.some(Boolean) || g.xf.s.some(x => x !== 1))) transformSel(g.xf.s, g.xf.t, g.xf.yaw);
  placeGizmo();
}

function cancel() {
  if (gz) { gz = null; tc.dragging = false; tc.axis = null; setPreview(null); snapMark(null); placeGizmo(); }
  if (drag?.kind === 'hook' || hook?.busy) hook?.cancel();
  if (drag?.kind === 'tex') texdrag.cancel();
  if (drag) { drag = null; endDrag(); }
}

const setGizmo = m => { setGizmoMode(m); setCursor(`gizmo: ${m ? NAMES[m] : 'none'}`); };
const setSpace = v => { setCfg('gizmoSpace', v); setCursor(`gizmo space: ${v}`); };
export const toggleSpace = () => setSpace(cfg.gizmoSpace === 'local' ? 'world' : 'local');
// 'snap: grid 64 | rot 15', 'snap: off | rot free'. Also for the status bar.
export const snapText = () => `snap: ${[cfg.snapGrid ? 'grid ' + S.grid : 'grid off', ...['vertex', 'edge', 'face'].filter(k => cfg['snap' + k[0].toUpperCase() + k.slice(1)])].join(' + ')} | rot ${cfg.snapRotation ? cfg.rotationStep : 'free'}`;
// The gizmo part is a link: a click switches world and local space.
function hudText() {
  if (!hud) return;
  const [a, g, b] = hud.children;
  a.textContent = `${S.mode} | `;
  g.textContent = `gizmo: ${S.gizmo ? NAMES[S.gizmo] : 'none'} (${cfg.gizmoSpace === 'local' ? 'local' : 'world'})`;
  b.textContent = ` | ${rmode} | ${snapText()}`;
}

// ---------- push/pull and extrude (face mode) ----------
// Moves a side's plane by dist along its unit normal n.
export function movePlane(side, n, dist) {
  const p = V.nums(V.get(side, 'plane'));
  V.set(side, 'plane', [0, 3, 6].map(i => `(${p.slice(i, i + 3).map((x, k) => fmt(x + n[k] * dist)).join(' ')})`).join(' '));
}

// Faces of solid with side pushed by dist, or null when the brush would become invalid.
export function pushed(solid, side, n, dist) {
  const c = structuredClone(solid), s = c.children[solid.children.indexOf(side)];
  movePlane(s, n, dist);
  return V.valid(c) ? { faces: V.faces(c), side: s } : null;
}

// Box grown from an axis-aligned face by dist along its normal (negative: into the brush), or null.
export function extrudeBox(face, dist) {
  const k = face.n.findIndex(x => Math.abs(x) > 0.999);
  if (k < 0 || !dist) return null;
  const [mn, mx] = V.bounds([face]), c = face.pts[0][k], e = c + dist * Math.sign(face.n[k]);
  mn[k] = Math.min(c, e);
  mx[k] = Math.max(c, e);
  return [mn, mx];
}

// Distance along the face normal of the point on that line closest to the mouse ray; null when looking along it.
function along(d, x, y) {
  ray.setFromCamera(ndc(x, y), cam);
  const { origin, direction } = ray.ray, w = d.p0.clone().sub(origin), b = d.n.dot(direction), den = 1 - b * b;
  return den < 1e-4 ? null : (b * direction.dot(w) - d.n.dot(w)) / den;
}

function pushMove(d, x, y) {
  const s = along(d, x, y);
  if (s === null) return;
  const dist = sn(s, step());
  if (dist === d.dist) return;
  if (d.kind === 'push') {
    const r = dist ? pushed(d.hit.node, d.hit.side, d.hit.face.n, dist) : null;
    if (dist && !r) return; // invalid: keep the last valid preview
    d.dist = dist;
    if (!r) { d.res = null; setGhost(null); return overlays(); }
    d.res = r;
    setGhost(makeMesh({ node: d.hit.node, faces: r.faces, point: false }));
    setGeo(faceHi, fan(r.faces.filter(f => f.side === r.side)));
  } else {
    d.dist = dist;
    d.res = extrudeBox(d.hit.face, dist);
    setGhost(d.res && new THREE.Mesh(geo(fan(V.faces(V.block(...d.res, '', () => '0')))), FACE));
  }
  setCursor(`${d.kind} ${dist}`);
}

function pushEnd(d) {
  if (!d.res) return;
  if (d.kind === 'push') return edit([d.hit.node], [], () => movePlane(d.hit.side, d.hit.face.n, d.dist));
  const b = createBlock(...d.res), n = d.hit.face.n;
  const f = b && cache.get(b).faces.find(f => f.n.every((x, k) => Math.abs(x - n[k]) < 1e-6));
  if (f) setFaceSelection([f.side]); // the new outer face, ready for the next pull
}

// ---------- camera ----------
const sens = () => +cfg.mouseSensitivity || 1;
function pivot() {
  const b = selBox();
  if (b) return new THREE.Vector3(...centre(b));
  return focusPt?.clone() ?? fly.pos.clone().add(new THREE.Vector3(...dir()).multiplyScalar(512));
}

// Rotates the camera position and view direction around p: dx turns about world Z, dy pitches about the camera right axis.
function orbit(dx, dy, p) {
  const k = 0.005 * sens(), v = fly.pos.clone().sub(p), yaw = -dx * k, pitch = Math.max(-1.55, Math.min(1.55, fly.pitch - dy * k));
  v.applyAxisAngle(new THREE.Vector3(0, 0, 1), yaw);
  fly.yaw += yaw;
  v.applyAxisAngle(new THREE.Vector3(Math.sin(fly.yaw), -Math.cos(fly.yaw), 0), pitch - fly.pitch);
  fly.pitch = pitch;
  fly.pos.copy(p).add(v);
  invalidate();
}

// Drops the selection onto the first visible surface below the bottom centre of its box (point entities: origin).
function drop() {
  const es = [...sel].map(n => cache.get(n)).filter(Boolean);
  if (!es.length) return;
  const [mn, mx] = boxOf(es);
  const z = Math.min(...es.map(c => (c.point ? V.nums(V.get(c.node, 'origin'))[2] : c.min[2])));
  ray.set(new THREE.Vector3((mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, z), new THREE.Vector3(0, 0, -1));
  ray.camera = cam; // sprites need it
  const h = ray.intersectObjects(visibleMeshes().filter(m => !sel.has(m.userData.node)), true)[0];
  const dz = h && Math.round(h.distance * 1000) / 1000;
  if (dz) transformSel([1, 1, 1], [0, 0, -dz]);
}

// Camera bookmarks live in the VMF cameras block, which Hammer reads: bookmark i is its i-th camera.
const camsOf = () => V.kids(V.kids(doc.root, 'cameras')[0] ?? { children: [] }, 'camera');
const bracket = a => `[${a.map(fmt).join(' ')}]`;
function saveCam(i) {
  const r = doc.root, b = V.kids(r, 'cameras')[0], p = fly.pos.toArray(), f = dir();
  const c = { name: 'camera', kv: [['position', bracket(p)], ['look', bracket(p.map((x, k) => x + f[k] * 256))]], children: [] };
  edit([], [b ?? r], () => {
    const into = b ?? { name: 'cameras', kv: [['activecamera', '-1']], children: [] }, cs = into.children;
    if (!b) r.children.splice(r.children.findLastIndex(n => /^(world|entity|hidden)$/.test(n.name)) + 1, 0, into);
    while (cs.length < i) cs.push(structuredClone(c)); // empty slots before i get this view too
    cs[i - 1] = c;
    V.set(into, 'activecamera', String(i - 1)); // -1 only while there is no camera
  });
  setCursor(`camera ${i} saved`);
}
function gotoCam(i) {
  const c = camsOf()[i - 1], p = c && V.nums(V.get(c, 'position')), t = c && V.nums(V.get(c, 'look'));
  if (p?.length !== 3 || t.length !== 3) return setCursor(`no camera ${i} (Ctrl+${i} saves one)`);
  lookAt(p, t);
  invalidate();
}

// ---------- settings and the 3D grid ----------
// Grid on z = 0 over the map's footprint at the editor grid, doubled until at most ~256 cells across.
let grid3d = null;
function buildGrid() {
  if (grid3d) { scene.remove(grid3d); grid3d.geometry.dispose(); grid3d.material.dispose(); }
  let [mn, mx] = boxOf(cache.values()), st = S.grid;
  if (!mn.every(Number.isFinite)) [mn, mx] = [[-1024, -1024, 0], [1024, 1024, 0]];
  const ext = Math.max(1024, mx[0] - mn[0], mx[1] - mn[1]);
  while (ext / st > 256) st *= 2;
  const n = 2 * Math.ceil(ext / 2 / st) + 2; // even, so the lines stay on multiples of st around a snapped centre
  grid3d = new THREE.GridHelper(n * st, n, 0x2d3442, 0x2d3442);
  grid3d.rotation.x = Math.PI / 2;
  grid3d.position.set(sn((mn[0] + mx[0]) / 2, st), sn((mn[1] + mx[1]) / 2, st), 0);
  grid3d.visible = cfg.showGrid3d !== false;
  scene.add(grid3d);
  invalidate();
}

// Applies the 3D view settings; runs on every 'cfg' event (all cheap except a render mode change).
function applyCfg() {
  cam.fov = +cfg.fov || 75;
  cam.far = +cfg.farClip || 60000;
  cam.updateProjectionMatrix();
  tc.setSize(+cfg.gizmoSize || 1);
  tc.setRotationSnap(rstep() * D2R);
  if (grid3d) grid3d.visible = cfg.showGrid3d !== false;
  if (cfg.renderMode !== rmode && RMODES.includes(cfg.renderMode)) setRenderMode(cfg.renderMode);
  if (!!cfg.slopeTint !== slopes) {
    slopes = !!cfg.slopeTint;
    for (const c of cache.values()) c.mesh = null; // the tint is in the vertex colours: rebuild
    syncMeshes();
  }
  hudText();
  invalidate();
}

// ---------- tools (ROADMAP "Extension hooks") ----------
// handlers: { activate(), deactivate(), down(e, hit), move(e, hit), up(e, hit), key(e), dblclick(e, hit) } for tool id
// (state.setTool); hit is pick() at the pointer. A handler returning true consumes the event. Returns the unregister function.
const tools = new Map();
let toolOn = null; // the id whose activate() ran last
export function registerTool(id, handlers) {
  tools.set(id, handlers);
  if (S.tool === id) { toolOn = id; handlers.activate?.(); }
  return () => {
    if (tools.get(id) !== handlers) return;
    if (toolOn === id) { handlers.deactivate?.(); toolOn = null; }
    tools.delete(id);
  };
}
const tool = () => tools.get(S.tool);
function switchTool() {
  if (toolOn === S.tool) return;
  tools.get(toolOn)?.deactivate?.();
  toolOn = S.tool;
  tool()?.activate?.();
}
const typing = e => e.target?.closest?.('input:not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable]') || document.querySelector('dialog:modal');
function toolKey(e) {
  const h = tool()?.key;
  if (!h || S.fly || typing(e) || h(e) !== true) return;
  e.preventDefault();
  e.stopImmediatePropagation(); // no command runs for it
}

// ---------- input ----------
// drag: a left press in the canvas. kind is null until the mouse moves 4px, then orbit | marquee | push | extrude | none;
// 'tool' when the active tool took the press.
let drag = null;

// x === null clears the hover.
function hover(x, y) {
  const h = x === null || drag || tc.dragging || tc.axis ? null : pick(x, y);
  const built = h && cache.get(h.node)?.mesh?.userData.built; // builder visuals: their box would cover them
  const face = S.mode === 'face' && !built && h?.node.name === 'solid' ? h.face : null, node = S.mode === 'face' || built ? null : h?.node ?? null;
  if (hov && face === hov.face && node === hov.node) return;
  hov = { face, node };
  setGeo(hovHi, fan(face ? [face] : node ? cache.get(node).faces : []));
}

// cfg.material on the face of hit, and into the Textures panel's Recent list.
function applyHere(h) {
  applyMaterial(cfg.material, { solid: h.node, side: h.side });
  import('./texbrowser.js').then(T => T.remember(cfg.material), () => {});
}

function down(e) {
  shift = e.shiftKey;
  const x = e.offsetX, y = e.offsetY;
  if (e.button === 2 && e.altKey) { // Hammer's texture application click
    const h = pick(x, y);
    if (h?.node.name === 'solid') applyHere(h);
    return;
  }
  if (e.button === 1) { // face mode: middle-drag moves the texture, Ctrl+middle-drag turns it (texdrag.js)
    e.preventDefault();
    const h = S.mode === 'face' && pick(x, y);
    if (!h || h.node.name !== 'solid') return; // h is false outside face mode
    texdrag.start(h, e.ctrlKey);
    canvas.setPointerCapture(e.pointerId);
    drag = { kind: 'tex' };
    return;
  }
  if (e.button === 2) { S.fly = true; canvas.requestPointerLock(); invalidate(); return; }
  if (e.button !== 0 || tc.dragging) return; // the gizmo took it
  if (hook?.busy && !e.altKey) return hook.press(x, y); // before the tool: the drawn primitive is placed first
  const hit = pick(x, y);
  if (tool()?.down?.(e, hit) === true) { canvas.setPointerCapture(e.pointerId); drag = { kind: 'tool' }; return; }
  if (S.tool === 'entity') { if (hit) createEntity(hit.point.toArray().map(Math.round)); return; }
  canvas.setPointerCapture(e.pointerId);
  drag = { x, y, sx: x, sy: y, hit, ctrl: e.ctrlKey, alt: e.altKey, kind: null };
}

function startDrag(d) {
  const solid = d.hit?.node.name === 'solid';
  const draw = !d.alt && !d.ctrl && S.mode === 'object' && d.hit && hook?.start(d.hit, d.sx, d.sy);
  d.kind = d.alt && !d.ctrl ? 'orbit' : draw ? 'hook' : S.mode !== 'face' ? 'marquee' : !solid ? 'none' : d.ctrl ? 'extrude' : 'push';
  if (d.kind === 'orbit') d.pivot = pivot();
  if (d.kind === 'push' || d.kind === 'extrude') {
    Object.assign(d, { n: new THREE.Vector3(...d.hit.face.n), p0: d.hit.point.clone(), dist: 0, res: null });
    if (d.kind === 'push' && !faceSel.has(d.hit.side)) setFaceSelection([d.hit.side]);
    if (d.kind === 'extrude' && !d.hit.face.n.some(x => Math.abs(x) > 0.999)) { d.kind = 'none'; setCursor('extrude: axis-aligned faces only'); }
  }
  hover(null);
}

function move(e) {
  shift = e.shiftKey;
  mouse = [e.offsetX, e.offsetY];
  tc.setRotationSnap(rstep() * D2R);
  if (S.fly) {
    const k = 0.0025 * sens();
    fly.yaw -= e.movementX * k;
    fly.pitch = Math.max(-1.55, Math.min(1.55, fly.pitch - e.movementY * k));
    return;
  }
  const d = drag, x = e.offsetX, y = e.offsetY;
  reportHover([x, y]);
  if (d?.kind === 'tex') return texdrag.drag(rayArr([x, y]));
  if (!d && hook?.busy) return hook.move(x, y);
  if ((!d || d.kind === 'tool') && (tool()?.move?.(e, pick(x, y)) === true || d)) return hover(null);
  if (!d) return hook?.busy ? hook.move(x, y) : hover(x, y);
  if (!d.kind) {
    if (Math.hypot(x - d.sx, y - d.sy) < 4) return;
    startDrag(d);
  }
  if (d.kind === 'orbit') orbit(x - d.x, y - d.y, d.pivot);
  else if (d.kind === 'hook') hook?.move(x, y);
  else if (d.kind === 'marquee') {
    Object.assign(marqueeEl.style, { left: `${Math.min(x, d.sx)}px`, top: `${Math.min(y, d.sy)}px`, width: `${Math.abs(x - d.sx)}px`, height: `${Math.abs(y - d.sy)}px` });
    marqueeEl.hidden = false;
  } else if (d.kind !== 'none') pushMove(d, x, y);
  d.x = x;
  d.y = y;
}

function click({ hit, ctrl, alt }) {
  if (alt) {
    if (hit?.node.name === 'solid') ctrl ? applyHere(hit) : setCfg('material', V.get(hit.side, 'material'));
    return;
  }
  if (S.mode === 'face') {
    const s = hit?.node.name === 'solid' ? hit.side : null;
    if (s) setFaceSelection(!ctrl ? [s] : faceSel.has(s) ? [...faceSel].filter(x => x !== s) : [...faceSel, s]);
    else if (!ctrl) setFaceSelection([]);
    return;
  }
  clickSelect(hit?.node ?? null, ctrl);
}

// Selects the visible entries whose projected bounding box lies inside the marquee. Ctrl adds, Ctrl+Alt removes.
function marquee(d) {
  const r = [Math.min(d.sx, d.x), Math.min(d.sy, d.y), Math.max(d.sx, d.x), Math.max(d.sy, d.y)], w = canvas.clientWidth, h = canvas.clientHeight, v = new THREE.Vector3();
  const inside = c => {
    for (let i = 0; i < 8; i++) {
      v.set((i & 1 ? c.max : c.min)[0], (i & 2 ? c.max : c.min)[1], (i & 4 ? c.max : c.min)[2]).project(cam);
      const x = ((v.x + 1) / 2) * w, y = ((1 - v.y) / 2) * h;
      if (Math.abs(v.z) > 1 || x < r[0] || x > r[2] || y < r[1] || y > r[3]) return false;
    }
    return true;
  };
  const hits = new Set([...cache.values()].filter(c => c.visible && inside(c)).map(c => c.node));
  setSelection(d.ctrl && d.alt ? [...sel].filter(n => !hits.has(n)) : d.ctrl ? [...sel, ...hits] : hits);
}

function endDrag() {
  marqueeEl.hidden = true;
  setGhost(null);
  overlays();
}

function up(e) {
  tc.enabled = true; // off during an Alt press (see mount)
  if (e.button === 2) { if (S.fly) { S.fly = false; document.exitPointerLock(); } return; }
  const d = drag;
  if (d?.kind === 'tex') { if (e.button === 1) { drag = null; texdrag.end(); } return; }
  if (e.button !== 0 || !d) return;
  drag = null;
  if (d.kind === 'tool') return void tool()?.up?.(e, pick(e.offsetX, e.offsetY));
  if (tool()?.up?.(e, pick(e.offsetX, e.offsetY)) === true) return endDrag();
  if (!d.kind) click(d);
  else if (d.kind === 'marquee') marquee(d);
  else if (d.kind === 'hook') hook?.up(e.offsetX, e.offsetY);
  else if (d.kind === 'push' || d.kind === 'extrude') pushEnd(d);
  endDrag();
}

// Wheel dollies; while flying it changes the fly speed (saved in settings). The dolly step follows the fly speed, 128
// units at the default 900: flying slowly means working close up.
function wheel(e) {
  if (S.fly) {
    const v = Math.round(Math.min(20000, Math.max(10, (cfg.flySpeed || 900) * (e.deltaY < 0 ? 1.25 : 0.8))));
    setCfg('flySpeed', v);
    setCursor(`fly speed ${v}`);
    return;
  }
  const f = dir(), s = (e.deltaY < 0 ? 128 : -128) * (cfg.flySpeed || 900) / 900;
  fly.pos.add(new THREE.Vector3(f[0] * s, f[1] * s, f[2] * s));
  invalidate();
}

// el: the 3D pane containing the canvas.
export function mount(el3d) {
  canvas = el3d.querySelector('canvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.autoUpdate = false; // lit mode: buildRig asks for one shadow pass per edit
  // Created before our pointerdown listener so a press on a handle sets tc.dragging before down() runs.
  tc = new TransformControls(cam, canvas);
  tc.showE = tc.showXYZE = false; // free rotation would put brushes off the grid
  tc.addEventListener('change', invalidate);
  tc.addEventListener('mouseDown', gizmoStart);
  tc.addEventListener('objectChange', gizmoMove);
  tc.addEventListener('mouseUp', gizmoEnd);
  scene.add(proxy, tc.getHelper());
  marqueeEl = el('div', { className: 'marquee', hidden: true });
  snapEl = el('div', { className: 'snapmark', hidden: true });
  hud = el('div', { className: 'hud' }, el('span'), el('span', { className: 'gz', title: 'Click: world or local gizmo axes (Ctrl+`)', onclick: toggleSpace }), el('span'));
  el3d.append(marqueeEl, snapEl, hud);

  canvas.addEventListener('contextmenu', e => e.preventDefault());
  // Alt+drag orbits even when it starts on a gizmo handle: the gizmo ignores Alt presses (capture runs before it).
  el3d.addEventListener('pointerdown', e => { tc.enabled = !e.altKey; }, true);
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); }); // no middle-click autoscroll
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerenter', () => { over3d = true; });
  canvas.addEventListener('pointerleave', () => { over3d = false; reportHover(null); if (!drag) hover(null); });
  canvas.addEventListener('wheel', wheel, { passive: true });
  canvas.addEventListener('dblclick', e => tool()?.dblclick?.(e, pick(e.offsetX, e.offsetY)));
  addEventListener('keydown', toolKey, true); // before the command keybindings
  addEventListener('pointerup', up);
  document.addEventListener('pointerlockchange', () => { if (!document.pointerLockElement) S.fly = false; });
  new ResizeObserver(resize).observe(canvas);
  resize();
  if (rmode === 'lit') scene.add(rig);
  applyCfg();

  on('doc', () => { syncMeshes(); hover(null); overlays(); placeGizmo(); if (rmode === 'lit') buildRig(); });
  on('selection', () => { paint(); overlays(); placeGizmo(); });
  on('filters', () => { paint(); overlays(); });
  on('tool', () => { switchTool(); hov = null; setGeo(hovHi, []); paint(); overlays(); placeGizmo(); });
  on('material', ({ name, material }) => { fxSync(material); if (lits.has(name)) copyLit(material, lits.get(name)); invalidate(); });
  on('proxies', invalidate); // animated materials were drawn: the next frame
  on('cfg', ({ key }) => {
    if (key === 'renderFx') { for (const c of cache.values()) if (c.mesh) applyMode(c.mesh); invalidate(); }
    if (key === 'lightShadows' && rmode === 'lit') buildRig();
  });
  on('preview', invalidate);
  on('lin', setLeak);
  on('focus', fit);
  on('cfg', applyCfg);
  on('grid', () => { buildGrid(); hudText(); });
  on('gizmo', placeGizmo);
  on('cfg', ({ key }) => { if (key === 'gizmoSpace') placeGizmo(); });
  on('file', d => {
    if (d.op !== 'load') return;
    buildGrid();
    drag = gz = hov = null;
    endDrag();
    placeGizmo();
    focus(boxOf(cache.values()), true); // fits the 2D views too
    spawnView(); // inside the playable space instead of the clip and skybox shell
  });

  register('focus', { title: 'Focus selection (or whole map)', keys: ['f'], run: () => (sel.size ? focus(selBox()) : focus(boxOf(cache.values()), true)) });
  register('renderTextured', { title: 'Render: textured', run: () => setRenderMode('textured'), on: () => rmode === 'textured' });
  register('renderFlat', { title: 'Render: flat', run: () => setRenderMode('flat'), on: () => rmode === 'flat' });
  register('renderWireframe', { title: 'Render: wireframe', run: () => setRenderMode('wireframe'), on: () => rmode === 'wireframe' });
  register('view.renderLit', { title: 'Render: lit (lighting preview from the map lights)', run: () => setRenderMode('lit'), on: () => rmode === 'lit' });
  register('view.renderLightmap', { title: 'Render: lightmap density (a checker cell per luxel, red fine to blue coarse)', run: () => setRenderMode('lightmap'), on: () => rmode === 'lightmap' });
  const flipOn = (key, what) => { setCfg(key, cfg[key] === false); setCursor(`${what} ${cfg[key] !== false ? 'on' : 'off'}`); }; // on by default
  register('view.proxies', { title: 'View: animate materials (AnimatedTexture, TextureScroll proxies) (toggle)', run: () => flipOn('proxies', 'material proxies'), on: () => cfg.proxies !== false });
  register('view.renderFx', { title: 'View: render effects of brush entities (rendercolor, renderamt) (toggle)', run: () => flipOn('renderFx', 'render effects'), on: () => cfg.renderFx !== false });
  register('view.lightShadows', { title: 'Render: lit shadows of the lights brightest at the camera (toggle)', run: () => flipOn('lightShadows', 'light shadows'), on: () => cfg.lightShadows !== false });
  register('gizmo.move', { title: 'Gizmo: move', keys: ['w'], run: () => setGizmo('translate'), on: () => S.gizmo === 'translate' });
  register('gizmo.rotate', { title: 'Gizmo: rotate', keys: ['e'], run: () => setGizmo('rotate'), on: () => S.gizmo === 'rotate' });
  register('gizmo.scale', { title: 'Gizmo: scale (resize brushes)', keys: ['r'], run: () => setGizmo('scale'), on: () => S.gizmo === 'scale' });
  register('gizmo.none', { title: 'Gizmo: none (drags select)', keys: ['q'], run: () => setGizmo(null), on: () => !S.gizmo });
  register('gizmo.cycle', { title: 'Gizmo: next mode', keys: [' '], when: () => over3d, run: () => setGizmo(MODES[(MODES.indexOf(S.gizmo) + 1) % 3]) });
  register('gizmo.space', { title: 'Gizmo: toggle local/world', keys: ['ctrl+`'], run: toggleSpace, on: () => cfg.gizmoSpace === 'local' });
  register('gizmo.world', { title: 'Gizmo: world axes (axis-aligned selection box)', run: () => setSpace('world'), on: () => cfg.gizmoSpace !== 'local' });
  register('gizmo.local', { title: "Gizmo: local axes (the selection's own angle)", run: () => setSpace('local'), on: () => cfg.gizmoSpace === 'local' });
  // 1, 2, 3: vertex, edge and face levels (polyedit.js)
  register('mode.object', { title: 'Select mode: object', keys: ['4'], run: () => { if (S.tool !== 'select') setTool('select'); setMode('object'); } });
  register('drop', { title: 'Drop selection to the surface below', keys: ['end'], run: drop });
  register('cancel3d', { title: 'Cancel 3D drag', keys: ['escape'], when: () => !!(gz || drag?.kind || hook?.busy), run: cancel });
  const flip = (key, what) => { setCfg(key, !cfg[key]); setCursor(`${what} ${cfg[key] ? 'on' : 'off'}`); }, STEPS = [5, 15, 45, 90];
  register('snap.grid', { title: 'Snap: toggle grid snapping', keys: ['shift+w'], run: () => flip('snapGrid', 'grid snapping'), on: () => !!cfg.snapGrid });
  register('view.slopeTint', { title: 'View: tint steep slopes red (toggle)', run: () => flip('slopeTint', 'slope tint'), on: () => !!cfg.slopeTint });
  register('snap.vertex', { title: 'Snap: to vertices of unselected brushes (toggle)', run: () => flip('snapVertex', 'vertex snapping'), on: () => !!cfg.snapVertex });
  register('snap.edge', { title: 'Snap: to edges of unselected brushes (toggle)', run: () => flip('snapEdge', 'edge snapping'), on: () => !!cfg.snapEdge });
  register('snap.intersection', { title: 'Snap: to where edges of unselected brushes cross (toggle)', run: () => flip('snapIntersection', 'intersection snapping'), on: () => !!cfg.snapIntersection });
  register('snap.face', { title: 'Snap: onto the face under the cursor, 3D (toggle)', run: () => flip('snapFace', 'face snapping'), on: () => !!cfg.snapFace });
  register('snap.rotation', { title: 'Snap: toggle rotation snapping', run: () => flip('snapRotation', 'rotation snapping'), on: () => !!cfg.snapRotation });
  register('snap.rotationStep', { title: 'Snap: next rotation step (5/15/45/90)', run: () => {
    setCfg('rotationStep', STEPS[(STEPS.indexOf(+cfg.rotationStep) + 1) % STEPS.length]);
    setCursor(`rotation step ${cfg.rotationStep}`);
  } });
  for (let i = 1; i <= 9; i++) {
    register(`camera.save${i}`, { title: `Camera: save bookmark ${i}`, keys: [`ctrl+${i}`], run: () => saveCam(i) });
    register(`camera.goto${i}`, { title: `Camera: go to bookmark ${i}`, keys: [`alt+${i}`], run: () => gotoCam(i) });
  }
  hudText();
}
