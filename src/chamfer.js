// Chamfer tool (Shift+C): point at a brush edge in the 3D view or a 2D view, click to pick that corner, Shift+click adds
// another (or drops a picked one). In cuts an outside corner off, Out fills an inside corner with a wedge (the corner
// decides). The bar over the 3D view sets the size (wheel over it, Ctrl+wheel over a view or drag its label: grid
// steps, halving below one), the segments (more than 1: a round fillet) and whether new faces take the adjacent faces'
// material. The result previews in every view; Enter applies it as one undo step, Escape drops the picks (again: back
// to Select), Backspace drops the last pick. Geometry: chamfergeo.js.
import * as THREE from 'three';
import * as V from '../vmf.js';
import { on } from './bus.js';
import { S, doc, cache, edit, nextId, setTool, setCursor, setSelection, sideUsers, matName } from './state.js';
import { register } from './commands.js';
import { cfg, setCfg } from './settings.js';
import { el } from './dom.js';
import { slot } from './tools.js';
import * as view3d from './view3d.js';
import * as view2d from './view2d.js';
import { segDist } from './poly2d.js';
import { corner, chamfer, near } from './chamfergeo.js';

const ID = 'chamfer', DEFAULTS = { size: 16, segments: 1, adjacent: true };
const opts = () => ({ ...DEFAULTS, ...cfg.chamfer });
const step = () => (cfg.snapGrid === false ? 1 : S.grid);
// The size n wheel steps on: whole grid steps, halving (doubling) at and below one grid step, at least 1.
const bump = (s, n) => {
  for (const g = step(); n; n -= Math.sign(n)) s = n > 0 ? (s < g ? Math.min(g, s * 2) : (Math.floor(s / g) + 1) * g) : s <= g ? Math.max(1, Math.floor(s / 2)) : (Math.ceil(s / g) - 1) * g;
  return s;
};
const sub = (a, b) => a.map((x, k) => x - b[k]), add = (a, b, s = 1) => a.map((x, k) => x + b[k] * s);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = a => { const l = Math.hypot(...a); return a.map(x => x / l); };
// picks: { edge: { a, b, at, face }, c: corner() }; hover: the same for the edge under the pointer.
let picks = [], hover = null, result = null, preview = [], bar = null, list = null;

// Brushes players collide with: tool brushes and triggers do not count. Rebuilt after document or filter changes.
const solids = () => (list ??= [...cache.values()].filter(c => !c.point && c.visible && c.faces.length && !c.kinds.includes('tools')
  && !(c.owner !== doc.world && /^trigger_/.test(V.get(c.owner, 'classname') || ''))));

function analyse(edge) {
  return { edge, c: corner(near(solids(), edge.a, unit(sub(edge.b, edge.a)), 2), edge.a, edge.b, edge.at, edge.face) };
}
// The corner's run along the line: as absolute positions along d, as end points.
const run = c => c.run.map(t => t + dot(c.p, c.d)), line = ({ c }) => c.run.map(t => add(c.p, c.d, t));
// One corner: the same line, overlapping runs (coincident edges of several brushes).
function same(x, y) {
  if (x.error || y.error || Math.abs(Math.abs(dot(x.d, y.d)) - 1) > 1e-6) return false;
  const w = sub(y.p, x.p), off = sub(w, x.d.map(k => k * dot(w, x.d)));
  const [a, b] = run(x), [c, d] = run(y).map(t => t * Math.sign(dot(x.d, y.d))).sort((p, q) => p - q);
  return Math.hypot(...off) < 0.01 && a <= d && c <= b;
}
const sameEdge = (x, y) => !!x && !!y && [x.a, x.b].map(String).sort().join() === [y.a, y.b].map(String).sort().join();

function compute(ps, ids, map) {
  const o = opts(), all = solids(), ss = [...new Set(ps.flatMap(p => (p.c.error ? [] : near(all, p.c.p, p.c.d, o.size * 2 + 2))))];
  return chamfer(ss, ps.map(p => p.c), { size: o.size, segments: o.segments, material: o.adjacent ? null : matName(cfg.material) }, ids, map);
}

// ---------- picking ----------
const v3 = new THREE.Vector3();
const screen = (p, w, h) => { v3.set(p[0], p[1], p[2]).project(view3d.cam); return [((v3.x + 1) / 2) * w, ((1 - v3.y) / 2) * h]; };

// The edge of the face under the pointer nearest to it on screen (within 48 px), looked at where the pointer is.
function edge3d(e, hit) {
  const f = hit?.face;
  if (!f || cache.get(hit.node)?.point) return null;
  const cv = e.target, w = cv.clientWidth, h = cv.clientHeight, m = [e.offsetX, e.offsetY];
  let best = null, bd = 48;
  f.pts.forEach((a, i) => {
    const b = f.pts[(i + 1) % f.pts.length], d = segDist(m, screen(a, w, h), screen(b, w, h));
    if (d < bd) { bd = d; best = { a, b }; }
  });
  if (!best) return null;
  const ab = sub(best.b, best.a), t = Math.max(0.02, Math.min(0.98, dot(sub(hit.point.toArray(), best.a), ab) / dot(ab, ab)));
  return { ...best, at: add(best.a, ab, t), face: f };
}

// The brush edge nearest the pointer in a 2D view (within 10 px). Edges seen end on (wall corners in the top view)
// win over edges passing near them; of those stacked, the one nearest the viewer.
function edge2d(v, e) {
  const m = [e.offsetX, e.offsetY], dep = 3 - v.ax[0] - v.ax[1], ts = p => view2d.toScreen(v, p);
  let best = null, bd = 10;
  for (const c of solids()) {
    const [lo, hi] = [ts(c.min), ts(c.max)];
    if (m[0] < Math.min(lo[0], hi[0]) - 10 || m[0] > Math.max(lo[0], hi[0]) + 10 || m[1] < Math.min(lo[1], hi[1]) - 10 || m[1] > Math.max(lo[1], hi[1]) + 10) continue;
    for (const f of c.faces) f.pts.forEach((a, i) => {
      const b = f.pts[(i + 1) % f.pts.length], sa = ts(a), sb = ts(b), top = Math.max(a[dep], b[dep]);
      const d = segDist(m, sa, sb) - (Math.hypot(sa[0] - sb[0], sa[1] - sb[1]) < 1 ? 4 : 0);
      if (d < bd - 1e-6 || (best && Math.abs(d - bd) < 1e-6 && top > best.top)) { bd = d; best = { a, b, top }; }
    });
  }
  return best && { a: best.a, b: best.b, at: add(best.a, sub(best.b, best.a), 0.5), face: null };
}

function setHover(edge) {
  if (sameEdge(edge, hover?.edge) || (!edge && !hover)) return;
  hover = edge && analyse(edge);
  refresh();
}

function choose(edge, more) {
  if (!edge) return;
  const p = analyse(edge);
  if (p.c.error) return setCursor(`chamfer: ${p.c.error}`);
  const i = picks.findIndex(q => same(q.c, p.c));
  if (!more) picks = [p]; else if (i >= 0) picks.splice(i, 1); else picks.push(p);
  hover = null;
  refresh();
}

// ---------- preview ----------
const lmat = color => new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
const fillM = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0xff8a1f, transparent: true, opacity: 0.45, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
const outL = new THREE.LineSegments(new THREE.BufferGeometry(), lmat(0xffd0a0));
const pickL = new THREE.LineSegments(new THREE.BufferGeometry(), lmat(0xff8a1f));
const hoverL = new THREE.LineSegments(new THREE.BufferGeometry(), lmat(0xffe14d));
const group = new THREE.Group().add(fillM, outL, pickL, hoverL);
group.traverse(o => { o.renderOrder = 4; o.frustumCulled = false; });
function setPts(o, pts) {
  o.geometry.dispose();
  o.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts.flat(), 3));
}

function refresh() {
  const extra = hover && !hover.c.error && !picks.some(p => same(p.c, hover.c)), ps = extra ? [...picks, hover] : picks;
  let note = '';
  result = ps.length ? compute(ps) : null;
  if (result?.error && extra) { note = result.error; result = picks.length ? compute(picks) : null; }
  const pieces = result && !result.error ? [...result.cuts.flatMap(x => x[1]), ...result.adds.map(a => a.solid)] : [];
  preview = pieces.flatMap(V.faces);
  setPts(fillM, preview.filter(f => V.get(f.side, 'id') === '0').flatMap(f => f.pts.slice(1, -1).flatMap((p, i) => [f.pts[0], p, f.pts[i + 2]])));
  setPts(outL, preview.flatMap(f => f.pts.flatMap((p, i) => [p, f.pts[(i + 1) % f.pts.length]])));
  setPts(pickL, picks.flatMap(line));
  setPts(hoverL, hover ? [hover.edge.a, hover.edge.b] : []);
  message(note);
  sync();
  view3d.invalidate();
  view2d.invalidate();
}

const describe = p => `${p.c.convex ? 'outside' : 'inside'} corner ${Math.round(p.c.angle)} deg, ${p.c.convex ? 'In cuts it off' : 'Out fills it'}`;
function message(note) {
  const last = hover ?? picks.at(-1);
  let text, bad = true;
  if (!last) { text = 'point at a corner edge, click to pick it (Shift+click: more corners)'; bad = false; }
  else if (hover?.c.error) text = hover.c.error;
  else if (note) text = `${describe(hover)}: ${note}`;
  else if (result?.error) text = result.error;
  else {
    const r = result, what = [r.cuts.length && `cuts ${r.cuts.length} brush(es)`, r.adds.length && `adds ${r.adds.length} wedge(s)`].filter(Boolean).join(', ');
    text = `${describe(last)}${picks.length > 1 ? ` (${picks.length} corners)` : ''}: ${what}${picks.length ? ' - Enter applies' : ' - click to pick'}`;
    bad = false;
  }
  if (bar) { bar.msg.textContent = text; bar.msg.classList.toggle('bad', bad); }
  setCursor(`chamfer: ${text}`);
}

function apply() {
  if (!picks.length) return setCursor('chamfer: pick a corner edge first');
  const ids = new Map(), r = compute(picks, nextId, ids);
  if (r.error) return setCursor(`chamfer: ${r.error}`);
  const { root, world } = doc, kept = r.cuts.flatMap(x => x[1]), users = sideUsers(ids, kept);
  const owners = [...new Set([...r.cuts.map(([n]) => cache.get(n).owner), ...r.adds.map(a => a.owner ?? world)])];
  picks = [];
  hover = null;
  edit([], [...new Set([root, ...owners, ...users])], () => {
    for (const [n, x] of r.cuts) { const l = cache.get(n).owner.children; l.splice(l.indexOf(n), 1, ...x); }
    for (const { solid, owner } of r.adds) { const l = (owner ?? world).children; l.splice(l.findLastIndex(c => c.name === 'solid') + 1, 0, solid); }
    for (const o of owners) if (o !== world && !o.children.some(c => c.name === 'solid' || c.name === 'hidden')) root.children.splice(root.children.indexOf(o), 1);
    users.forEach(e => V.remapSides(e, ids));
  });
  setSelection([...kept, ...r.adds.map(a => a.solid)]);
  refresh();
  setCursor(`chamfer: cut ${r.cuts.length} brush(es), added ${r.adds.length} wedge(s)`);
}

function overlay(ctx, v, { toScreen }) {
  if (S.tool !== ID) return;
  ctx.strokeStyle = '#ffb060';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const f of preview) { f.pts.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](...toScreen(v, p))); ctx.closePath(); }
  ctx.stroke();
  ctx.lineWidth = 2.5;
  for (const [[a, b], col] of [...picks.map(p => [line(p), '#ff8a1f']), ...(hover ? [[[hover.edge.a, hover.edge.b], '#ffe14d']] : [])]) {
    const [sa, sb] = [toScreen(v, a), toScreen(v, b)];
    ctx.strokeStyle = ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(...sa);
    ctx.lineTo(...sb);
    ctx.stroke();
    if (Math.hypot(sa[0] - sb[0], sa[1] - sb[1]) < 2) ctx.fillRect(sa[0] - 4, sa[1] - 4, 8, 8); // seen end on
  }
}

// ---------- bar ----------
function makeBar(host) {
  const set = (k, v) => { setCfg('chamfer', { ...cfg.chamfer, [k]: v }); refresh(); };
  const size = el('input', { type: 'number', min: 1, title: 'Distance along each face from the corner (wheel here or Ctrl+wheel over a view: grid steps)', onchange: () => set('size', Math.max(1, +size.value || 1)) });
  size.onwheel = e => { e.preventDefault(); set('size', bump(opts().size, e.deltaY < 0 ? 1 : -1)); };
  const sizeL = el('label', { title: 'Drag sideways: size in grid steps' }, 'Size ', size);
  sizeL.onpointerdown = e => {
    if (e.target === size) return;
    e.preventDefault();
    sizeL.setPointerCapture(e.pointerId);
    const x0 = e.clientX, s0 = opts().size;
    sizeL.onpointermove = m => { const v = bump(s0, Math.round((m.clientX - x0) / 8)); if (v !== opts().size) set('size', v); };
    sizeL.onpointerup = () => { sizeL.onpointermove = sizeL.onpointerup = null; };
  };
  const segs = el('input', { type: 'number', min: 1, max: 32, title: 'Facets: 1 is a flat chamfer, more make a round fillet', onchange: () => set('segments', Math.max(1, Math.min(32, Math.round(+segs.value) || 1))) });
  const adj = el('input', { type: 'checkbox', onchange: () => set('adjacent', adj.checked) });
  const msg = el('div', { className: 'msg' });
  const div = el('div', { className: 'stairs-panel', hidden: true }, // the stairs tool's bar style (stairs.css)
    el('b', { className: 'chip', textContent: 'CHAMFER' }), sizeL,
    el('label', { title: segs.title }, 'Segments ', segs),
    el('label', { title: 'New faces take the material and alignment of the faces beside them; off: the current material' }, adj, ' Adjacent material'),
    el('button', { className: 'primary', textContent: 'Apply', title: 'Chamfer the picked corners (Enter)', onclick: e => { e.currentTarget.blur(); apply(); } }),
    msg);
  host.append(div);
  // Ctrl+wheel over a view sets the size too (before the view's own wheel: zoom or dolly)
  addEventListener('wheel', e => {
    if (S.tool !== ID || !e.ctrlKey || !e.target.closest?.('#v-3d, #v-top, #v-front, #v-side') || bar.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    set('size', bump(opts().size, e.deltaY < 0 ? 1 : -1));
  }, { capture: true, passive: false });
  return Object.assign(div, { msg, size, segs, adj });
}

// Shows the saved options (they can change in settings.json between uses).
function sync() {
  if (!bar) return;
  const o = opts();
  if (document.activeElement !== bar.size) bar.size.value = o.size;
  if (document.activeElement !== bar.segs) bar.segs.value = o.segments;
  bar.adj.checked = !!o.adjacent;
}

// ---------- tool ----------
const tool3d = {
  activate() { picks = []; hover = null; list = null; bar.hidden = false; view3d.addHelper(group); refresh(); },
  deactivate() { picks = []; hover = null; result = null; preview = []; bar.hidden = true; view3d.removeHelper(group); view2d.invalidate(); },
  move(e, hit) { setHover(edge3d(e, hit)); return true; },
  down(e, hit) { if (e.altKey) return false; choose(edge3d(e, hit), e.shiftKey); return true; },
  up() { return true; },
  key(e) {
    if (e.ctrlKey || e.altKey || e.metaKey) return false;
    if (e.key === 'Enter') apply();
    else if (e.key === 'Escape') { if (picks.length) { picks = []; refresh(); } else setTool('select'); }
    else if (e.key === 'Backspace') { picks.pop(); refresh(); }
    else return false;
    return true;
  },
};
const tool2d = {
  move(v, e) { setHover(edge2d(v, e)); return true; },
  down(v, e) { choose(edge2d(v, e), e.shiftKey); return true; },
  up() { return true; },
};

export function mount(el3d) {
  bar = makeBar(slot('chamfer', 'Chamfer'));
  view3d.registerTool(ID, tool3d);
  view2d.registerTool(ID, tool2d);
  view2d.registerOverlay(overlay);
  for (const t of ['doc', 'filters']) on(t, () => {
    list = null;
    if (S.tool !== ID) return;
    picks = picks.map(p => analyse(p.edge)).filter(p => !p.c.error);
    hover = null;
    refresh();
  });
  register('tool.chamfer', { title: 'Tool: chamfer or fill a corner', keys: ['shift+c'], run: () => setTool(ID), on: () => S.tool === ID });
}
