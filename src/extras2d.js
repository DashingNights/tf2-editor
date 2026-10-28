// 2D view extras: props as their model's wireframe (models.js), textured FGD icon sprites on point entities, the 3D
// camera as a glyph that drags (body: move, tip: turn), and a background image per view saved in the map's sidecar.
// Toggles: cfg.models2d, cfg.icons2d, cfg.camera2d (all on by default).
import * as THREE from 'three';
import * as V from '../vmf.js';
import * as F from './fgd.js';
import { on } from './bus.js';
import { cfg, setCfg } from './settings.js';
import { cache, sideData, saveSidecar, setCursor } from './state.js';
import { register } from './commands.js';
import { notice } from './dialog.js';
import { thumbnail } from './materials.js';
import { getModel, modelPath, place } from './models.js';
import { flyView, setFlyView, addHelper } from './view3d.js';
import { setOutline, registerLayer, registerOverlay, registerPress, relayer, invalidate, hovered, viewByName, toScreen, toWorld, s2 } from './view2d.js';
import { form } from './report.js';

const api = window.api, AX = 'XYZ';
const shown = k => cfg[k] ?? true;

// ---------- model wireframes ----------
// Per model geometry: its edges (three's EdgesGeometry: all but those between coplanar triangles), and its outline for
// each pair of matrix rows a view sees, so entities with the same model, angles and scale share one path.
const edges = new WeakMap(), wires = new WeakMap();

// The rows of 4x4 matrix elements e (column-major) that give view axes [a, b], translation left out.
export const rows = (e, [a, b]) => [e[a], e[a + 4], e[a + 8], e[b], e[b + 4], e[b + 8]];
// Points pos [x, y, z, ...] through rows r (rows()) as flat [x, y, ...].
export function project(pos, r) {
  const out = new Float32Array((pos.length / 3) * 2);
  for (let i = 0, j = 0; i < pos.length; i += 3, j += 2) {
    out[j] = r[0] * pos[i] + r[1] * pos[i + 1] + r[2] * pos[i + 2];
    out[j + 1] = r[3] * pos[i] + r[4] * pos[i + 1] + r[5] * pos[i + 2];
  }
  return out;
}
// Path2D of segments s [x0, y0, x1, y1, ...] (those seen end on left out), in pieces joined with addPath: lineTo slows
// down as one Path2D grows.
function wirePath(s) {
  const p = new Path2D();
  for (let i = 0; i < s.length; i += 2048) {
    const q = new Path2D();
    for (let j = i; j < Math.min(i + 2048, s.length); j += 4) if (s[j] !== s[j + 2] || s[j + 1] !== s[j + 3]) { q.moveTo(s[j], s[j + 1]); q.lineTo(s[j + 2], s[j + 3]); }
    p.addPath(q);
  }
  return p;
}
// view2d setOutline hook: a point entity's loaded model in view v, placed like the 3D one (origin, angles, modelscale),
// in world units; null (its box) until the model has loaded (models.js then touches the entity, which redraws it).
function modelOutline(v, c) {
  const path = c.point && modelPath(c.node), m = path && getModel(path, +V.get(c.node, 'skin') || 0), g = m?.geometry;
  if (!g) return null;
  const e = place(new THREE.Object3D(), c.node).matrixWorld.elements, r = rows(e, v.ax), key = r.map(x => Math.round(x * 1e5)).join();
  const byRows = wires.get(g) ?? wires.set(g, new Map()).get(g);
  let shape = byRows.get(key);
  if (!shape) {
    const pos = edges.get(g) ?? edges.set(g, new THREE.EdgesGeometry(g).attributes.position.array).get(g);
    byRows.set(key, (shape = wirePath(project(pos, r))));
  }
  const p = new Path2D();
  p.addPath(shape, new DOMMatrix([1, 0, 0, 1, e[12 + v.ax[0]], e[12 + v.ax[1]]]));
  return p;
}

// ---------- icon sprites ----------
let fgd = null;
const sprites = new Map(), imgs = new Map(); // classname -> FGD iconsprite | null; sprite -> Image | null (loading, failed)
const spriteOf = cls => {
  if (!sprites.has(cls)) sprites.set(cls, (fgd && F.resolve(fgd, cls)?.helpers.findLast(h => h.name === 'iconsprite')?.args[0]) || null);
  return sprites.get(cls);
};
// tf.fgd (the parse details.js, models.js and helpers.js share); a new TF2 folder loads the icons again.
async function loadFgd() {
  fgd = cfg.tf2 ? await F.shared(`${cfg.tf2}\\bin\\tf.fgd`, api.read).catch(() => null) : null;
  sprites.clear();
  imgs.clear();
  relayer();
}
// The loaded icon of point entity n (none while a model draws it, as in 3D), else null; starts its load.
function iconOf(n) {
  const name = spriteOf(V.get(n, 'classname') ?? '');
  if (!name || modelPath(n)) return null;
  if (!imgs.has(name)) {
    imgs.set(name, null);
    thumbnail(name, 64).then(url => { const im = new Image(); im.onload = () => { imgs.set(name, im); relayer(); }; im.src = url; }, () => {});
  }
  return imgs.get(name);
}
// Static layer: each visible point entity's icon, 16 units wide as in 3D, on its box centre, once that is 6 px or more.
function drawIcons(ctx, v) {
  const k = 16 * v.z, [a, b] = v.ax;
  if (!shown('icons2d') || k < 6) return;
  ctx.globalCompositeOperation = 'lighter'; // editor icons are Sprite materials: black, not see-through, round the picture
  for (const c of cache.values()) {
    if (!c.point || !c.visible) continue;
    const [x, y] = s2(v, (c.min[a] + c.max[a]) / 2, (c.min[b] + c.max[b]) / 2), im = x > -k && y > -k && x < v.w + k && y < v.h + k && iconOf(c.node);
    if (im) ctx.drawImage(im, x - k / 2, y - k / 2, k, k);
  }
}

// ---------- the 3D camera ----------
const dirOf = f => [Math.cos(f.pitch) * Math.cos(f.yaw), Math.cos(f.pitch) * Math.sin(f.yaw), Math.sin(f.pitch)];
// The camera in view v: its fly view f and, on screen, its body and the tip 32 px along its direction as v sees it.
function glyph(v) {
  const f = flyView(), d = dirOf(f), body = toScreen(v, f.pos);
  return { f, body, tip: [body[0] + 32 * d[v.ax[0]], body[1] - 32 * d[v.ax[1]]] };
}
// Overlay: a dot on the camera, a line along its direction to a smaller dot (the tip).
function drawCam(ctx, v) {
  if (!shown('camera2d')) return;
  const { body, tip } = glyph(v);
  ctx.strokeStyle = ctx.fillStyle = '#40e0d0';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(...body);
  ctx.lineTo(...tip);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(...body, 5, 0, 2 * Math.PI);
  ctx.moveTo(tip[0] + 3, tip[1]);
  ctx.arc(...tip, 3, 0, 2 * Math.PI);
  ctx.fill();
}
// { yaw, pitch } of fly view f turned in the plane of a view with axes ax toward view point w: the direction's part
// in that plane points at w, its part along the depth axis stays; straight up or down keeps the yaw. null when w is on
// the camera.
export function aim(f, ax, w) {
  const d = dirOf(f), [a, b] = ax, u = [w[0] - f.pos[a], w[1] - f.pos[b]], l = Math.hypot(...u);
  if (!l) return null;
  const s = Math.hypot(d[a], d[b]) / l, n = [...d];
  [n[a], n[b]] = [u[0] * s, u[1] * s];
  const flat = Math.hypot(n[0], n[1]);
  return { yaw: flat > 1e-9 ? Math.atan2(n[1], n[0]) : f.yaw, pitch: Math.max(-1.55, Math.min(1.55, Math.atan2(n[2], flat))) };
}
// view2d registerPress: a press on the glyph's body moves the camera across the view, on its tip turns it; Escape puts
// it back.
function camPress(v, x, y) {
  if (!shown('camera2d')) return null;
  const g = glyph(v), f0 = g.f, near = (p, r) => Math.hypot(p[0] - x, p[1] - y) <= r, cancel = () => setFlyView(f0);
  if (near(g.body, 7)) {
    const w0 = toWorld(v, x, y);
    return { cursor: 'move', cancel, move: (_, e, w) => { const pos = [...f0.pos]; v.ax.forEach((k, i) => { pos[k] += w[i] - w0[i]; }); setFlyView({ pos }); } };
  }
  if (near(g.tip, 6)) return { cursor: 'crosshair', cancel, move: (_, e, w) => { const r = aim(f0, v.ax, w); if (r) setFlyView(r); } };
  return null;
}
// Redraws the 2D views when the 3D camera moved: a point that draws nothing, never culled, sees every 3D frame.
const watch = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3)), new THREE.PointsMaterial({ size: 0, colorWrite: false, depthWrite: false, depthTest: false }));
watch.frustumCulled = false;
let seen = '';
watch.onBeforeRender = () => {
  const f = flyView(), k = `${f.pos} ${f.yaw} ${f.pitch}`;
  if (k !== seen && shown('camera2d')) invalidate();
  seen = k;
};

// ---------- background images ----------
// sideData.bg2d: view name -> { file, x, y, scale, opacity }: the image's centre in the view's coordinates, units per
// image pixel, 0..1. Saved in the map's sidecar; replaced, never changed in place.
const bgImgs = new Map(); // view name -> ImageBitmap
// An image file as an ImageBitmap, or null.
async function readImage(file) {
  try {
    const st = await api.stat(file), bytes = st && (await api.readBytes(file, 0, st.size));
    return bytes ? await createImageBitmap(new Blob([bytes])) : null;
  } catch { return null; }
}
// Static layer, under the grid.
function drawBg(ctx, v) {
  const b = sideData.bg2d?.[v.name], im = bgImgs.get(v.name);
  if (!b || !im) return;
  const w = im.width * b.scale * v.z, h = im.height * b.scale * v.z, [x, y] = s2(v, b.x, b.y);
  ctx.globalAlpha = b.opacity;
  ctx.drawImage(im, x - w / 2, y - h / 2, w, h);
}
// view.backgroundImage: an image file, then its centre, scale and opacity, for the 2D view under the pointer (top when
// none). Cancelling the file dialog edits the view's current one.
async function pickBg() {
  const v = hovered() ?? viewByName('top'), old = sideData.bg2d?.[v.name];
  const [file] = (await api.openFiles([{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp'] }])) ?? [];
  if (!file && !old) return;
  const f = file || old.file, im = await readImage(f);
  if (!im) return notice(`Could not read ${f} as an image.`);
  const r = await form(`Background image of the ${v.name} view: ${f.split(/[\\/]/).pop()} (${im.width} x ${im.height})`, [
    { key: 'x', label: `Centre ${AX[v.ax[0]]}`, value: old?.x ?? Math.round(v.c[0]) },
    { key: 'y', label: `Centre ${AX[v.ax[1]]}`, value: old?.y ?? Math.round(v.c[1]) },
    { key: 'scale', label: 'Units per image pixel', value: old?.scale ?? 1 },
    { key: 'opacity', label: 'Opacity (0 to 1)', value: old?.opacity ?? 0.5 },
  ]);
  if (!r) return;
  const num = (s, d) => (s.trim() !== '' && Number.isFinite(+s) ? +s : d);
  const b = { file: f, x: num(r.x, 0), y: num(r.y, 0), scale: Math.abs(num(r.scale, 1)) || 1, opacity: Math.min(1, Math.max(0, num(r.opacity, 0.5))) };
  sideData.bg2d = { ...sideData.bg2d, [v.name]: b };
  bgImgs.set(v.name, im);
  saveSidecar();
  relayer();
}
// view.backgroundClear: the background of the 2D view under the pointer, or every one when that view has none.
function clearBg() {
  const all = sideData.bg2d ?? {}, n = hovered()?.name ?? 'top', drop = all[n] ? [n] : Object.keys(all);
  if (!drop.length) return setCursor('no background image');
  sideData.bg2d = Object.fromEntries(Object.entries(all).filter(([k]) => !drop.includes(k)));
  drop.forEach(k => bgImgs.delete(k));
  saveSidecar();
  relayer();
  setCursor(`background image cleared: ${drop.join(', ')}`);
}

// After view3d.mount (the camera watcher is a 3D helper) and helpers.mount (the glyph draws over the entity lines).
export function mount() {
  if (shown('models2d')) setOutline(modelOutline);
  registerLayer(drawBg, true);
  registerLayer(drawIcons);
  registerOverlay(drawCam);
  registerPress(camPress);
  addHelper(watch);
  on('cfg', ({ key }) => {
    if (key === 'models2d') setOutline(shown('models2d') ? modelOutline : null);
    if (key === 'icons2d') relayer();
    if (key === 'tf2') loadFgd();
  });
  on('file', d => { if (d.op === 'load') { bgImgs.clear(); relayer(); } });
  // An opened map's backgrounds, unless one was replaced or another map opened while its file loaded.
  on('sidecar', () => {
    for (const [n, b] of Object.entries(sideData.bg2d ?? {})) readImage(b.file).then(im => {
      if (im && sideData.bg2d?.[n] === b) { bgImgs.set(n, im); relayer(); } else if (!im) setCursor(`background image not found: ${b.file}`);
    });
  });
  const toggles = [
    ['view.models2d', 'models2d', 'model wireframes'],
    ['view.icons2d', 'icons2d', 'entity icons'],
    ['view.camera2d', 'camera2d', '3D camera'],
  ];
  for (const [id, k, what] of toggles) {
    register(id, { title: `View: ${what} in 2D views (toggle)`, on: () => shown(k), run: () => { setCfg(k, !shown(k)); setCursor(`${what} in 2D views ${shown(k) ? 'on' : 'off'}`); } });
  }
  register('view.backgroundImage', { title: 'View: background image of the 2D view under the pointer...', run: pickBg });
  register('view.backgroundClear', { title: 'View: clear the 2D background image', run: clearBg });
  loadFgd();
}
