// Top/front/side views: grid, wireframes, select, marquee, move, scale handles, block, entity, pan, zoom.
import { rotation } from '../vmf.js';
import { on } from './bus.js';
import * as snap from './snap.js';
import { S, sel, cache, selBox, selFrame, turnZ, snapRef, setSelection, clickSelect, transformSel, cloneSel, mergeUndo, createBlock, createEntity, setCoords, setPreview } from './state.js';
import { register, held } from './commands.js';
import { cfg } from './settings.js';

let views = [], hover = null, drag = null;

// v: a view { name, ax: [world axis shown left-right, world axis shown bottom-top], c: centre, z: px per unit, w, h }.
// World points in a view are [p[v.ax[0]], p[v.ax[1]]]; the depth axis is 3 - ax[0] - ax[1].
export const toWorld = (v, x, y) => [v.c[0] + (x - v.w / 2) / v.z, v.c[1] - (y - v.h / 2) / v.z];
export const s2 = (v, a, b) => [(a - v.c[0]) * v.z + v.w / 2, v.h / 2 - (b - v.c[1]) * v.z];
export const toScreen = (v, p) => s2(v, p[v.ax[0]], p[v.ax[1]]);
export const viewByName = name => views.find(v => v.name === name);
const step = () => (cfg.snapGrid ? S.grid : 1); // grid snapping off: 1 unit
const sn = x => Math.round(x / step()) * step();
// The drag preview as a point function: p * s + t (in the frame turned by yaw about z), or a rotation r about r.pivot.
export function previewFn(xf) {
  if (!xf) return p => p;
  if (!xf.r) {
    const f = p => p.map((x, k) => x * xf.s[k] + xf.t[k]);
    return xf.yaw ? p => turnZ(f(turnZ(p, -xf.yaw)), xf.yaw) : f;
  }
  const m = rotation(xf.r.axis, xf.r.deg), o = xf.r.pivot;
  return p => m.map(r => r.reduce((a, x, k) => a + x * (p[k] - o[k]), 0)).map((x, k) => x + o[k]);
}
// The drag preview then world -> screen as one 2D matrix [a, b, c, d, e, f] for view v, or null when the preview
// leaves the view plane (a rotation about an axis other than the view's depth): then points are projected one by one.
export function screenMatrix(v, xf) {
  const [a, b] = v.ax, d = 3 - a - b, { z, w, h, c } = v;
  let A = [[1, 0], [0, 1]], t = [0, 0];
  if (xf?.r) {
    const m = rotation(xf.r.axis, xf.r.deg), o = xf.r.pivot;
    if (Math.abs(m[a][d]) + Math.abs(m[b][d]) > 1e-9) return null;
    A = [[m[a][a], m[a][b]], [m[b][a], m[b][b]]];
    t = A.map((r, i) => o[v.ax[i]] - r[0] * o[a] - r[1] * o[b]);
  } else if (xf?.yaw) {
    if (d !== 2) return null; // a turned frame stays in the plane of the top view only
    const f = previewFn(xf), o = f([0, 0, 0]), ex = f([1, 0, 0]), ey = f([0, 1, 0]);
    [A, t] = [[[ex[0] - o[0], ey[0] - o[0]], [ex[1] - o[1], ey[1] - o[1]]], [o[0], o[1]]];
  } else if (xf) [A, t] = [[[xf.s[a], 0], [0, xf.s[b]]], [xf.t[a], xf.t[b]]];
  return [z * A[0][0], -z * A[1][0], z * A[0][1], -z * A[1][1], z * (t[0] - c[0]) + w / 2, h / 2 - z * (t[1] - c[1])];
}

// ---------- render loop (on demand) ----------
const need = new Set();
let raf = 0;
// Redraws the given views (none: all) on the next frame. Overlays only change through this.
export function invalidate(...vs) {
  for (const v of vs.length ? vs : views) need.add(v);
  raf ||= requestAnimationFrame(() => {
    raf = 0;
    const todo = [...need];
    need.clear();
    todo.forEach(draw);
  });
}

// Outlines are Path2D in world units, one per object per view, grouped by colour. Pan and zoom are a canvas
// transform, so a frame never touches the 50k points of a full map: building Path2D is the slow part (~300 ms),
// stroking is not. 'doc' drops only the changed objects' paths; 'filters' regroups; selection draws on top.
let gen = 0;
// One object's faces through f(point) -> [x, y]. Keep paths per object and join them with addPath: lineTo slows
// down as a single Path2D grows (39k points in one path: ~180 ms; the same points per object: ~4 ms).
function facePath(faces, f) {
  const p = new Path2D();
  for (const fc of faces) { fc.pts.forEach((q, i) => { const s = f(q); i ? p.lineTo(s[0], s[1]) : p.moveTo(s[0], s[1]); }); p.closePath(); }
  return p;
}
function outline(v, c) {
  const [a, b] = v.ax;
  let p = (v.np ??= new Map()).get(c.node);
  if (!p) v.np.set(c.node, (p = facePath(c.faces, q => [q[a], q[b]])));
  return p;
}
function groups(v) {
  if (v.gen === gen) return v.groups;
  const out = new Map();
  for (const c of cache.values()) {
    if (!c.visible) continue;
    const key = c.color2d + (c.point ? '|' : '');
    (out.get(key) || out.set(key, new Path2D()).get(key)).addPath(outline(v, c));
  }
  for (const n of v.np?.keys() ?? []) if (!cache.has(n)) v.np.delete(n);
  v.gen = gen;
  return (v.groups = out);
}

// Background, grid and all outlines rendered once into an offscreen canvas: stroking a full map costs ~25 ms per
// view, so a frame only blits it. While panning or zooming (v.hold set) the old bitmap is reused, scaled and
// shifted, and the crisp version is rendered once the view is at rest. The key holds every input, settings too.
const SETTLE = 90;
const look = () => [cfg.showGrid2d, cfg.grid2dMajor, cfg.gridMinorColor, cfg.gridMajorColor, cfg.gridAxisColor, cfg.fillPointEntities].join();
function staticLayer(v) {
  const { w, h, z } = v, dpr = devicePixelRatio, key = `${gen}|${v.c}|${z}|${w}|${h}|${S.grid}|${dpr}|${look()}`;
  const L = (v.layer ??= document.createElement('canvas'));
  if (L.key === key) return L;
  if (L.key && v.hold > performance.now() && L.gen === gen && L.w === w && L.h === h) {
    clearTimeout(v.settle);
    v.settle = setTimeout(() => invalidate(v), v.hold - performance.now());
    return L;
  }
  L.width = w * dpr; L.height = h * dpr;
  Object.assign(L, { key, gen, w, h, c: [...v.c], z });
  const ctx = L.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#101216';
  ctx.fillRect(0, 0, w, h);
  const [x0, y1] = toWorld(v, 0, 0), [x1, y0] = toWorld(v, w, h);

  if (cfg.showGrid2d !== false) {
    let g = S.grid;
    while (g * z < 6) g *= 2;
    const major = +cfg.grid2dMajor || 1024, grid = [new Path2D(), new Path2D(), new Path2D()]; // minor, major, axis
    for (let x = Math.ceil(x0 / g) * g; x <= x1; x += g) {
      const s = Math.round(s2(v, x, 0)[0]) + 0.5, p = grid[x === 0 ? 2 : x % major ? 0 : 1];
      p.moveTo(s, 0); p.lineTo(s, h);
    }
    for (let y = Math.ceil(y0 / g) * g; y <= y1; y += g) {
      const s = Math.round(s2(v, 0, y)[1]) + 0.5, p = grid[y === 0 ? 2 : y % major ? 0 : 1];
      p.moveTo(0, s); p.lineTo(w, s);
    }
    [cfg.gridMinorColor, cfg.gridMajorColor, cfg.gridAxisColor].forEach((c, i) => { ctx.strokeStyle = c; ctx.stroke(grid[i]); });
  }

  // world -> screen: x' = (x - c0) z + w/2, y' = h/2 - (y - c1) z
  ctx.setTransform(dpr * z, 0, 0, -dpr * z, dpr * (w / 2 - v.c[0] * z), dpr * (h / 2 + v.c[1] * z));
  ctx.lineWidth = 1 / z;
  for (const [key, p] of groups(v)) {
    const col = key.replace('|', '');
    ctx.strokeStyle = col;
    ctx.stroke(p);
    if (key.endsWith('|') && cfg.fillPointEntities !== false) { ctx.globalAlpha = 0.35; ctx.fillStyle = col; ctx.fill(p); ctx.globalAlpha = 1; }
  }
  return L;
}

// Pan or zoom in progress: keep reusing the last rendered bitmap until the view rests for SETTLE ms.
const holdView = v => { v.hold = performance.now() + SETTLE; };

function draw(v) {
  const { ctx, w, h, z, ax } = v, xfp = previewFn(S.preview), dpr = devicePixelRatio;
  if (!w || !h) return; // hidden (an inactive dock tab): a 0-size layer cannot be drawn
  const L = staticLayer(v), k = z / L.z;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (k !== 1 || L.c[0] !== v.c[0] || L.c[1] !== v.c[1]) { ctx.fillStyle = '#101216'; ctx.fillRect(0, 0, w, h); }
  // old screen point s0 -> new: (s0 - centre) * k + centre + (c_old - c_new) * z, y flipped
  ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * (w / 2 - (w / 2) * k + (L.c[0] - v.c[0]) * z), dpr * (h / 2 - (h / 2) * k - (L.c[1] - v.c[1]) * z));
  ctx.drawImage(L, 0, 0, w, h);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // The selection reuses the cached world outlines through one matrix while the preview stays in the view plane.
  const selPath = new Path2D(), m = screenMatrix(v, S.preview), M = m && new DOMMatrix(m);
  for (const n of sel) {
    const c = cache.get(n);
    if (c?.visible) selPath.addPath(M ? outline(v, c) : facePath(c.faces, q => toScreen(v, xfp(q))), M || undefined);
  }
  ctx.strokeStyle = '#ff4646';
  ctx.stroke(selPath);

  // The selection's box (frameIn) with its handles and sizes, following the preview. A rotation, or the scaling of a
  // turned frame seen from the side, previews on the outlines only.
  const fr = !S.preview?.r && frameIn(v);
  if (fr && !(S.preview?.yaw && !fr.yaw)) {
    // (i, j): 0 low, 1 middle, 2 high along the view's axes, as a world point after the preview
    const P = (i, j) => {
      const q = [...fr.box[0]];
      ax.forEach((k, n) => { q[k] = fr.box[0][k] + ((fr.box[1][k] - fr.box[0][k]) * [i, j][n]) / 2; });
      return xfp(fr.yaw ? turnZ(q, fr.yaw) : q);
    };
    const at = (i, j) => toScreen(v, P(i, j));
    ctx.strokeStyle = ctx.fillStyle = '#ffb0b0';
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    [[0, 0], [2, 0], [2, 2], [0, 2]].forEach(([i, j], n) => (n ? ctx.lineTo(...at(i, j)) : ctx.moveTo(...at(i, j))));
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    if (!tools.has(S.tool)) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (i !== 1 || j !== 1) { const [x, y] = at(i, j); ctx.fillRect(x - 3, y - 3, 6, 6); } // a tool draws its own handles
    if (cfg.showDimensions !== false) {
      const size = (a, b) => { const p = P(...a), q = P(...b); return String(+Math.hypot(...p.map((x, k) => q[k] - x)).toFixed(2)); };
      const top = at(1, 2), right = at(2, 1);
      ctx.font = '11px system-ui';
      ctx.fillText(size([0, 2], [2, 2]), top[0] - 10, top[1] - 8);
      ctx.fillText(size([2, 0], [2, 2]), right[0] + 8, right[1] + 4);
    }
  }

  const d = drag;
  if (d?.v === v && (d.mode === 'block' || d.mode === 'marquee')) {
    const a = s2(v, ...d.a), b = s2(v, ...d.b);
    ctx.strokeStyle = d.mode === 'block' ? '#ffffff' : '#4f8cff';
    ctx.setLineDash(d.mode === 'block' ? [] : [4, 3]);
    ctx.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
    ctx.setLineDash([]);
  }
  if (S.lin) {
    ctx.strokeStyle = '#ff2020';
    ctx.lineWidth = 2;
    ctx.beginPath();
    S.lin.forEach((p, i) => { const s = toScreen(v, p); i ? ctx.lineTo(...s) : ctx.moveTo(...s); });
    ctx.stroke();
    ctx.lineWidth = 1;
  }
  for (const fn of overlays) {
    ctx.save();
    try { fn(ctx, v, HELPERS); } catch (err) { console.error(err); }
    ctx.restore();
  }
  if (snap.mark.at) { const s = toScreen(v, snap.mark.at); ctx.strokeStyle = '#33ccff'; ctx.lineWidth = 2; ctx.strokeRect(s[0] - 5, s[1] - 5, 10, 10); ctx.lineWidth = 1; }
}

// ---------- extension hooks (ROADMAP "Extension hooks") ----------
// fn(ctx, v, helpers) draws on top of every 2D view after the selection, in CSS pixels. Returns the unregister function.
const overlays = new Set(), HELPERS = { toScreen, toWorld, s2, previewFn };
export function registerOverlay(fn) { overlays.add(fn); invalidate(); return () => { overlays.delete(fn); invalidate(); }; }

// handlers: { down(v, e, w), move(v, e, w), up(v, e, w), key(e) } for tool id (state.setTool); w = toWorld at the
// pointer. A handler returning true consumes the event. Returns the unregister function.
const tools = new Map();
export function registerTool(id, handlers) { tools.set(id, handlers); return () => tools.get(id) === handlers && tools.delete(id); }
// Calls the active tool's handler fn; true when it consumed the event. Redraws v (tools draw through overlays).
function use(fn, v, e) {
  const h = tools.get(S.tool)?.[fn];
  if (!h) return false;
  invalidate(v);
  return h(v, e, toWorld(v, e.offsetX, e.offsetY)) === true;
}
const typing = e => e.target?.closest?.('input:not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable]') || document.querySelector('dialog:modal');
function toolKey(e) {
  const h = tools.get(S.tool)?.key;
  if (!h || S.fly || typing(e) || h(e) !== true) return;
  e.preventDefault();
  e.stopImmediatePropagation(); // no command runs for it
  invalidate();
}

// The visible object under w (view coordinates) in view v, smallest box first; null when none.
export const pickAt = (v, w) => pick2d(v, w);

// ---------- picking ----------
function pick2d(v, w, selOnly) {
  const [a, b] = v.ax, tol = 4 / v.z;
  let best = null, area = Infinity;
  for (const c of cache.values()) {
    if (!c.visible || (selOnly && !sel.has(c.node))) continue;
    if (w[0] < c.min[a] - tol || w[0] > c.max[a] + tol || w[1] < c.min[b] - tol || w[1] > c.max[b] + tol) continue;
    const ar = (c.max[a] - c.min[a]) * (c.max[b] - c.min[b]);
    if (ar < area) { area = ar; best = c.node; }
  }
  return best;
}

// The selection's { yaw, box } for view v: along its own axes in the top view (selFrame), else the world box; null
// without a selection.
const frameIn = v => (v.ax[0] === 0 && v.ax[1] === 1 ? selFrame() : (b => b && { yaw: 0, box: b })(selBox()));

// Resize handle under the cursor: [-1|0|1, -1|0|1] along the box's axes in view v (fr: frameIn). Axes too small on
// screen get none, so tiny boxes move instead.
function handleAt(v, fr, x, y) {
  if ([...sel].every(n => n.name === 'entity')) return null;
  const r = 6 / v.z, w = toWorld(v, x, y), q = fr.yaw ? turnZ([w[0], w[1], 0], -fr.yaw) : w;
  const lo = v.ax.map(k => fr.box[0][k]), hi = v.ax.map(k => fr.box[1][k]);
  if ([0, 1].some(i => q[i] < lo[i] - r || q[i] > hi[i] + r)) return null;
  const h = [0, 1].map(i => (hi[i] - lo[i] < 3 * r ? 0 : Math.abs(q[i] - lo[i]) < r ? -1 : Math.abs(q[i] - hi[i]) < r ? 1 : 0));
  return h[0] || h[1] ? h : null;
}
// The resize cursor for handle h of a box turned by yaw degrees: the way the handle drags on screen.
function resizeCursor(h, yaw) {
  const d = turnZ([h[0], h[1], 0], yaw), a = ((Math.atan2(d[1], d[0]) * 180) / Math.PI + 360) % 180;
  return ['ew-resize', 'nesw-resize', 'ns-resize', 'nwse-resize'][Math.round(a / 45) % 4];
}

// ---------- mouse ----------
function down(v, e) {
  v.cv.setPointerCapture(e.pointerId);
  const w = toWorld(v, e.offsetX, e.offsetY), at = { v, sx: e.offsetX, sy: e.offsetY, a: w, b: w };
  if (e.button !== 0 || held.has('Space')) return void (drag = { ...at, mode: 'pan', c0: [...v.c] });
  if (use('down', v, e)) return void (drag = { ...at, mode: 'tool' });
  if (S.tool === 'block') return void (drag = { ...at, mode: 'block', a: w.map(sn), b: w.map(sn) });
  if (S.tool === 'entity') {
    const o = [0, 0, 0]; // ponytail: depth axis is 0 in 2D; click a surface in 3D for exact placement
    v.ax.forEach((k, i) => { o[k] = sn(w[i]); });
    return void createEntity(o);
  }
  const fr = !tools.has(S.tool) && frameIn(v), hnd = fr && handleAt(v, fr, e.offsetX, e.offsetY);
  if (hnd) return void (drag = { ...at, mode: 'scale', box: fr.box, yaw: fr.yaw, hnd });
  if (fr && pick2d(v, w, true)) {
    // Snap the box corner like Hammer; point entities snap their origin, as the 3D gizmo does.
    const skip = n => sel.has(n);
    return void (drag = { ...at, mode: 'move', ref: snapRef(), clone: e.shiftKey, snap: snap.any() && snap.snapper({ proj: p => toScreen(v, p), moving: snap.movingOf(sel), skip }) });
  }
  drag = { ...at, mode: 'marquee' };
}

function move(v, e) {
  const w = toWorld(v, e.offsetX, e.offsetY), d = drag;
  setCoords(`${v.name} ${Math.round(w[0])} ${Math.round(w[1])}`);
  if ((!d || d.mode === 'tool') && (use('move', v, e) || d)) return;
  if (!d || d.v !== v) {
    const fr = S.tool === 'select' && frameIn(v), h = fr && handleAt(v, fr, e.offsetX, e.offsetY);
    v.cv.style.cursor = h ? resizeCursor(h, fr.yaw) : '';
    return;
  }
  if (d.mode === 'pan') { v.c = [d.c0[0] - (e.offsetX - d.sx) / v.z, d.c0[1] + (e.offsetY - d.sy) / v.z]; holdView(v); }
  else if (d.mode === 'block') d.b = w.map(sn);
  else if (d.mode === 'marquee') d.b = w;
  else if (d.mode === 'move') {
    const t = [0, 0, 0];
    v.ax.forEach((k, i) => { t[k] = sn(d.ref[k] + w[i] - d.a[i]) - d.ref[k]; });
    const hit = d.snap && d.snap(t, a => a.map((x, k) => (v.ax.includes(k) ? x : 0)));
    if (hit) t.splice(0, 3, ...hit.t);
    snap.mark.at = hit?.at ?? null;
    d.xf = { s: [1, 1, 1], t };
  } else if (d.mode === 'scale') {
    const s = [1, 1, 1], t = [0, 0, 0], q = d.yaw ? turnZ([w[0], w[1], 0], -d.yaw) : w;
    d.hnd.forEach((h, i) => {
      const k = v.ax[i], lo = d.box[0][k], hi = d.box[1][k];
      if (!h || hi === lo) return;
      let nlo = lo, nhi = hi;
      if (d.yaw) {
        // a turned box is rarely on the grid: its size snaps, the other side stays
        const size = Math.max(sn(h > 0 ? q[i] - lo : hi - q[i]), Math.min(hi - lo, step()));
        if (h > 0) nhi = lo + size; else nlo = hi - size;
      } else {
        const p = sn(w[i]);
        nlo = h < 0 ? Math.min(p, hi - 1) : lo;
        nhi = h > 0 ? Math.max(p, lo + 1) : hi;
      }
      s[k] = (nhi - nlo) / (hi - lo);
      t[k] = nlo - lo * s[k];
    });
    d.xf = { s, t, yaw: d.yaw };
  }
  if (d.xf) setPreview(d.xf); else invalidate(v);
}

function up(v, e) {
  const d = drag;
  if (!d || d.v !== v) return;
  drag = null;
  snap.mark.at = null;
  if (d.xf) setPreview(null);
  if (d.mode === 'tool') return void use('up', v, e);
  if (d.mode !== 'pan' && use('up', v, e)) return invalidate();
  if (d.mode === 'block' && d.a[0] !== d.b[0] && d.a[1] !== d.b[1]) {
    const mn = [...S.last[0]], mx = [...S.last[1]]; // depth axis reuses the last block's extent
    v.ax.forEach((k, i) => { mn[k] = Math.min(d.a[i], d.b[i]); mx[k] = Math.max(d.a[i], d.b[i]); });
    createBlock(mn, mx);
  } else if (d.mode === 'marquee') {
    if (Math.hypot(e.offsetX - d.sx, e.offsetY - d.sy) < 4) {
      clickSelect(pick2d(v, d.a), e.ctrlKey);
    } else {
      const [a, b] = v.ax, lo = d.a.map((x, i) => Math.min(x, d.b[i])), hi = d.a.map((x, i) => Math.max(x, d.b[i]));
      const hits = [...cache.values()].filter(c => c.visible && c.min[a] >= lo[0] && c.max[a] <= hi[0] && c.min[b] >= lo[1] && c.max[b] <= hi[1]).map(c => c.node);
      setSelection(e.ctrlKey ? [...sel, ...hits] : hits);
    }
  } else if (d.xf && (d.xf.t.some(Boolean) || d.xf.s.some(x => x !== 1))) {
    if (d.clone) { cloneSel(); transformSel(d.xf.s, d.xf.t, d.xf.yaw); mergeUndo(); } else transformSel(d.xf.s, d.xf.t, d.xf.yaw);
  }
  invalidate();
}

function cancelDrag() {
  const d = drag;
  drag = null;
  if (d?.xf) setPreview(null);
  invalidate();
}

// Arrow keys move the selection one snap step along the axes of the 2D view under the mouse (top when none).
function nudge(i, sgn) {
  const v = hover || views[0], t = [0, 0, 0];
  t[v.ax[i]] = sgn * step();
  transformSel([1, 1, 1], t);
}

// A view hidden by a maximised pane has no size: it is fitted to the last focus box once it is shown again.
let focusBox = null;
function fitView(v) {
  if (!v.w || !v.h) return void (v.stale = true);
  const [mn, mx] = focusBox, [a, b] = v.ax;
  v.stale = false;
  v.c = [(mn[a] + mx[a]) / 2, (mn[b] + mx[b]) / 2];
  v.z = Math.max(0.002, 0.85 * Math.min(v.w / Math.max(64, mx[a] - mn[a]), v.h / Math.max(64, mx[b] - mn[b])));
}

function fit({ box }) {
  focusBox = box;
  views.forEach(fitView);
  invalidate();
}

function resize() {
  for (const v of views) {
    v.w = v.cv.clientWidth; v.h = v.cv.clientHeight;
    v.cv.width = v.w * devicePixelRatio; v.cv.height = v.h * devicePixelRatio;
    if (v.stale) fitView(v);
  }
  invalidate();
}

// el: the element holding #v-top, #v-front, #v-side (and #v-3d, which resets the nudge view).
export function mount(el) {
  views = [['top', [0, 1]], ['front', [1, 2]], ['side', [0, 2]]].map(([name, ax]) => {
    const cv = el.querySelector(`#v-${name} canvas`);
    return { name, ax, cv, ctx: cv.getContext('2d'), c: [0, 0], z: 0.1, w: 1, h: 1 };
  });
  const ro = new ResizeObserver(resize);
  on('layout', () => requestAnimationFrame(resize));
  for (const v of views) {
    const cv = v.cv;
    cv.addEventListener('pointerdown', e => down(v, e));
    cv.addEventListener('pointermove', e => move(v, e));
    cv.addEventListener('pointerup', e => up(v, e));
    cv.addEventListener('pointerenter', () => { hover = v; });
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('wheel', e => {
      const a = toWorld(v, e.offsetX, e.offsetY);
      const zs = Math.max(1.01, +cfg.zoomSpeed || 1.2);
      v.z = Math.min(Math.max(v.z * (e.deltaY < 0 ? zs : 1 / zs), 0.002), 50);
      const b = toWorld(v, e.offsetX, e.offsetY);
      v.c[0] += a[0] - b[0];
      v.c[1] += a[1] - b[1];
      holdView(v);
      invalidate(v);
    }, { passive: true });
    ro.observe(cv);
  }
  el.querySelector('#v-3d')?.addEventListener('pointerenter', () => { hover = null; });
  addEventListener('keydown', toolKey, true); // before the command keybindings
  resize();

  on('doc', changed => {
    for (const v of views) changed instanceof Set ? changed.forEach(n => v.np?.delete(n)) : (v.np = null);
    gen++;
    invalidate();
  });
  on('filters', () => { gen++; invalidate(); });
  for (const t of ['selection', 'grid', 'preview', 'lin', 'cfg']) on(t, () => invalidate());
  on('focus', fit);
  on('file', d => { if (d.op === 'load') drag = null; });

  register('cancelDrag', { title: 'Cancel drag', keys: ['escape'], when: () => !!drag, run: cancelDrag });
  register('nudgeLeft', { title: 'Nudge selection left', keys: ['arrowleft'], run: () => nudge(0, -1) });
  register('nudgeRight', { title: 'Nudge selection right', keys: ['arrowright'], run: () => nudge(0, 1) });
  register('nudgeUp', { title: 'Nudge selection up', keys: ['arrowup'], run: () => nudge(1, 1) });
  register('nudgeDown', { title: 'Nudge selection down', keys: ['arrowdown'], run: () => nudge(1, -1) });
}
