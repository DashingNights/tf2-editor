// Poly tool (3ds Max Editable Poly on brushes): sub-object levels Vertex (1), Edge (2), Face (3); 4, Escape or the
// same key again go back to objects (Shift+V toggles the vertex level, the old vertex tool). Works on every selected
// brush at once. Click selects, Ctrl+click adds, Alt+click removes; a drag on empty space box-selects (left to right:
// elements wholly inside, right to left: elements touching the box; Ctrl adds, Ctrl+Alt removes, Alt alone orbits as
// everywhere in 3D). With Sticky on the same element of a touching brush (same spot) is selected along, so touching
// brushes stay together. The gizmo (W move, E rotate, R scale, Q select only; Ctrl+` local / world) moves, turns and
// scales the selection about its centre or the brushes' centre, snapped like objects; with a gizmo mode, dragging an
// element moves it (a face along its normal; Ctrl or Shift drag extrudes faces). Every edit is one undo step through
// polygeo.build: bent faces split, concave shapes become grouped convex pieces, and a shape without volume or with
// crossing faces is refused (red preview).
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import * as V from '../vmf.js';
import * as P from './polygeo.js';
import { on, emit } from './bus.js';
import { S, sel, faceSel, cache, nextId, setTool, setMode, setCursor, setSelection, setFaceSelection, clickSelect, replaceSolids, undo, redo, depth, setSelExtra, selTouched } from './state.js';
import { register, run as runCmd } from './commands.js';
import { cfg, setCfg } from './settings.js';
import * as view3d from './view3d.js';
import * as view2d from './view2d.js';
import { registerSection } from './details.js';
import { activeView } from './brushtools.js';
import { segCross, segDist, inside } from './poly2d.js';
import { el } from './dom.js';
import { slot } from './tools.js';
import * as osnap from './snap.js';
import { ask } from './dialog.js';

const ID = 'poly', LEVELS = ['vertex', 'edge', 'face'], D2R = Math.PI / 180;
const OPTS = { sticky: true, pivot: 'selection', extrude: 64, extrudeType: 'group', inset: 16, bevelHeight: 32, bevelOutline: -16, chamfer: 16, segments: 1, connect: 1, weld: 8, detach: 16 };
const opt = () => ({ ...OPTS, ...cfg.poly });
const setOpt = (k, v) => setCfg('poly', { ...cfg.poly, [k]: v });
const lock = () => cfg.texLock !== false;
let shift = false;
const step = () => (cfg.snapGrid === false ? 1 : shift ? Math.max(1, S.grid / 4) : S.grid);
const rstep = () => (!cfg.snapRotation ? 0.5 : shift ? +cfg.rotationStepFine || 5 : +cfg.rotationStep || 15);
const sn = (x, g = step()) => Math.round(x / g) * g + 0;
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = a => { const l = Math.hypot(...a); return l > 1e-9 ? mul(a, 1 / l) : [0, 0, 0]; };
const mid = ps => mul(ps.reduce(add, [0, 0, 0]), 1 / ps.length);
const V3 = p => new THREE.Vector3(p[0], p[1], p[2]);
const box = ps => [[0, 1, 2].map(k => Math.min(...ps.map(p => p[k]))), [0, 1, 2].map(k => Math.max(...ps.map(p => p[k])))];
const plural = (n, w) => `${n} ${n === 1 ? w : { vertex: 'vertices', brush: 'brushes' }[w] ?? w + 's'}`;

// ---------- state ----------
// edit: the brushes being edited [{ s, src, own (selected; else a sticky neighbour), m (mesh), el (elements) }]; src:
// the solids the mesh covers (the convex pieces of a concave edit, s the first), so the shape stays one mesh.
// picked: per level the selected elements as 'brush uid#position key'. session: solid -> the edit meshes kept for it
// [{ pieces, sigs, m }], newest last. One holds while each of its pieces is as that edit left it (same planes): the
// pieces of a concave edit stay one shape, an inset or a connect keeps the faces it split (the brush cannot hold
// them), and an undone edit finds the mesh from before it again.
// prev: the preview of an edit in progress { items: [{ b, mm, r }], fn, keys, faces }.
let level = 'face', edit = [], hov = null, drag = null, gz = null, prev = null, committing = false; // the gizmo mode is S.gizmo, its space cfg.gizmoSpace
let tc, canvas, boxEl, panel;
const picked = { vertex: new Set(), edge: new Set(), face: new Set() }, extra = new Set(), session = new Map();
// hist: the selection before and after each edit, so undo and redo bring it back (positions change, so ids do too).
// topo: edits that changed only edit meshes (inset, connect: the brushes stay as they were, so the map's undo has no
// step for them) [{ at: depth() then, xs: the session meshes it added, l, before, after }]. Undo takes the last one
// when no map step came after it, so both undo in the order they were made.
const hist = [], topo = { undo: [], redo: [] };
const uids = new WeakMap();
let uidN = 0;
const uid = s => uids.get(s) ?? (uids.set(s, ++uidN), uidN);
const idOf = e => `${uid(e.b.s)}#${e.k}`;
const sigOf = s => V.kids(s, 'side').map(x => V.get(x, 'plane')).join();
const holds = x => x.pieces.every((p, i) => cache.has(p) && sigOf(p) === x.sigs[i]);
// The edit entry of solid s: the newest kept mesh that holds, else the solid's own.
function entry(s, own) {
  const x = session.get(s)?.findLast(holds);
  return x ? { s: x.pieces[0], src: x.pieces, own, m: x.m } : { s, src: [s], own, m: P.meshOf(s) };
}
const keep = x => x.pieces.forEach(p => { const l = session.get(p) ?? session.set(p, []).get(p); l.push(x); if (l.length > 32) l.shift(); });
const unkeep = x => x.pieces.forEach(p => { const l = session.get(p) ?? [], i = l.lastIndexOf(x); if (i >= 0) l.splice(i, 1); });
const hasDisp = s => V.kids(s, 'side').some(x => V.kids(x, 'dispinfo').length);
const dispN = ss => ss.reduce((a, s) => a + V.kids(s, 'side').filter(x => V.kids(x, 'dispinfo').length).length, 0);

function elements(b) {
  if (b.el) return b.el;
  const m = b.m, used = [...new Set(m.f.flatMap(f => f.vs))];
  return (b.el = {
    vertex: used.map(i => ({ b, i, vs: [i], k: P.vertexKey(m, i), pts: [m.v[i]] })),
    edge: [...P.edgeMap(m).values()].map(e => ({ b, i: P.ek(e.a, e.b), vs: [e.a, e.b], k: P.edgeKey(m, e.a, e.b), pts: [m.v[e.a], m.v[e.b]] })),
    face: m.f.map((f, i) => ({ b, i, vs: f.vs, k: P.faceKey(m, f), pts: f.vs.map(j => m.v[j]), n: P.normal(m, f), side: f.side })),
  });
}
const els = b => elements(b)[level];
const byKey = b => ((b.at ??= {})[level] ??= Map.groupBy(els(b), o => o.k));
const isSel = e => picked[level].has(idOf(e));
const selEls = () => edit.flatMap(b => els(b).filter(isSel));
// [entry, Set of element indices] per brush with a selection (own: selected brushes only, for face operations)
const selBy = own => edit.filter(b => !own || b.own).map(b => [b, new Set(els(b).filter(isSel).map(e => e.i))]).filter(x => x[1].size);
// Snapping skips the brushes being edited: their moving points would snap onto themselves.
const snapSkip = () => { const s = new Set(edit.flatMap(b => b.src)); return n => s.has(n); };
const selPts = () => { const m = new Map(); for (const e of selEls()) for (const p of e.pts) m.set(P.key(p), p); return [...m.values()]; };

function say(text) {
  setCursor(`poly ${level}: ${text}`);
  if (panel) panel.msg.textContent = text;
}

// The selected brushes plus sticky neighbours that hold selected elements; selections of elements gone are dropped.
function rebuild() {
  if (S.tool !== ID) { edit = []; hov = null; return changed(); }
  const covered = new Set(), mk = (s, own) => { if (covered.has(s) || !cache.get(s)?.visible) return []; const b = entry(s, own); b.src.forEach(p => covered.add(p)); return [b]; };
  edit = [...[...sel].filter(n => n.name === 'solid').flatMap(s => mk(s, true)), ...[...extra].flatMap(s => mk(s, false))];
  extra.clear();
  for (const b of edit) if (!b.own) extra.add(b.s);
  for (const l of LEVELS) {
    const live = new Set(edit.flatMap(b => elements(b)[l].map(idOf))), had = picked[l].size;
    for (const id of picked[l]) if (!live.has(id)) picked[l].delete(id);
    if (!had || picked[l].size || committing) continue;
    const all = s => s.size && [...s].every(id => live.has(id)), h = hist.findLast(x => x.l === l && (all(x.after) || all(x.before)));
    if (h) picked[l] = new Set(all(h.after) ? h.after : h.before);
  }
  if (!committing) {
    const held = new Set(LEVELS.flatMap(l => [...picked[l]].map(id => +id.split('#')[0])));
    edit = edit.filter(b => b.own || held.has(uid(b.s)));
    for (const s of extra) if (!held.has(uid(s))) extra.delete(s);
  }
  hov = null;
  mirror();
  changed();
}

// Face level: the selected faces are the editor's face selection too (Details Face section, textures).
function mirror() {
  if (S.tool !== ID || level !== 'face') return;
  const sides = new Set(selEls().filter(e => e.b.own).map(e => e.side));
  if (sides.size !== faceSel.size || [...sides].some(s => !faceSel.has(s))) setFaceSelection(sides);
}

function changed() {
  redraw();
  placeGizmo();
  emit('details');
  if (panel) panel.sync();
}

// ---------- selection ----------
const CELL = 256;
// Sticky lookup for one pick: the edited brushes' elements by position key, the other visible solids by 256-unit cell
// (displacement brushes left out: a changed face would lose its displacement).
function stickyIndex() {
  const keys = new Map(), cells = new Map(), big = [], done = new Set(edit.flatMap(b => b.src));
  for (const b of edit) for (const [k, os] of byKey(b)) (keys.get(k) ?? keys.set(k, []).get(k)).push(...os);
  for (const c of cache.values()) {
    if (c.point || !c.visible || c.node.name !== 'solid' || done.has(c.node) || hasDisp(c.node)) continue;
    const lo = c.min.map(x => Math.floor(x / CELL)), hi = c.max.map(x => Math.floor(x / CELL));
    if ((hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1) > 64) { big.push(c); continue; }
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) { const k = `${x} ${y} ${z}`; (cells.get(k) ?? cells.set(k, []).get(k)).push(c); }
  }
  return { keys, cells, big, memo: new Map() };
}
// Elements on the same spot as e in other brushes: the edited ones and visible solids touching e (they join the edit
// set).
function coincident(e, ix) {
  const out = (ix.keys.get(e.k) ?? []).filter(o => o.b !== e.b), [lo, hi] = box(e.pts), cs = new Set(ix.big);
  const a = lo.map(x => Math.floor((x - 0.01) / CELL)), z = hi.map(x => Math.floor((x + 0.01) / CELL));
  for (let x = a[0]; x <= z[0]; x++) for (let y = a[1]; y <= z[1]; y++) for (let w = a[2]; w <= z[2]; w++) ix.cells.get(`${x} ${y} ${w}`)?.forEach(c => cs.add(c));
  for (const c of cs) {
    if ([0, 1, 2].some(k => c.max[k] < lo[k] - 0.01 || c.min[k] > hi[k] + 0.01)) continue;
    let b = ix.memo.get(c.node);
    if (!b) { b = entry(c.node, false); b.src.forEach(p => ix.memo.set(p, b)); b.skip = b.src.some(hasDisp); }
    const hit = !b.skip && byKey(b).get(e.k);
    if (hit) { extra.add(b.s); out.push(...hit); }
  }
  return out;
}
// how: 'set' | 'add' | 'remove'
function pick(es, how) {
  const ids = new Set(es.map(idOf)), ix = opt().sticky && es.length && stickyIndex();
  if (ix) for (const e of es) for (const o of coincident(e, ix)) ids.add(idOf(o));
  const p = picked[level];
  if (how === 'set') p.clear();
  for (const id of ids) how === 'remove' ? p.delete(id) : p.add(id);
  rebuild();
  selTouched(); // a selection step in the undo history
}
function selectAll() { pick(edit.filter(b => b.own).flatMap(els), 'set'); }

// Neighbours of the selection (vertex: along edges, edge: sharing a vertex, face: sharing an edge).
function around(b, ids) {
  const m = b.m, em = P.edgeMap(m), E = els(b), out = new Set();
  if (level === 'vertex') for (const e of em.values()) { if (ids.has(e.a)) out.add(e.b); if (ids.has(e.b)) out.add(e.a); }
  if (level === 'edge') for (const e of E) if (!ids.has(e.i) && e.vs.some(v => E.some(x => ids.has(x.i) && x.vs.includes(v)))) out.add(e.i);
  if (level === 'face') for (const e of em.values()) if (e.f.some(f => ids.has(f))) e.f.forEach(f => out.add(f));
  return E.filter(e => out.has(e.i) && !ids.has(e.i));
}
function grow() { pick(selBy(true).flatMap(([b, ids]) => around(b, ids)), 'add'); }
function shrink() {
  const drop = [];
  for (const [b, ids] of selBy(true)) {
    const out = new Set(els(b).filter(e => !ids.has(e.i)).map(e => e.i));
    for (const e of els(b)) if (ids.has(e.i) && around(b, new Set([e.i])).some(x => out.has(x.i))) drop.push(e);
  }
  pick(drop, 'remove');
}
function loopRing(fn) {
  if (level !== 'edge') return say('loop and ring work on edges (2)');
  pick(selBy(true).flatMap(([b, ids]) => { const ks = new Set([...ids].flatMap(k => [...fn(b.m, k)])); return els(b).filter(e => ks.has(e.i)); }), 'add');
}

// ---------- picking ----------
const v3 = new THREE.Vector3();
const scr = p => { v3.set(p[0], p[1], p[2]).project(view3d.cam); return [((v3.x + 1) / 2) * canvas.clientWidth, ((1 - v3.y) / 2) * canvas.clientHeight, v3.z]; };
// The element under canvas pixel x, y: the nearest face along the ray (unless another brush is in front), or the
// vertex / edge within 8 / 6 px (nearest, then nearer the camera).
function at3d(x, y, hit) {
  const own = edit.filter(b => b.own);
  if (level === 'face') {
    const r = view3d.rayAt(x, y), t = new THREE.Vector3();
    let best = null, bd = Infinity;
    for (const b of own) for (const e of els(b)) for (let i = 1; i + 1 < e.pts.length; i++) {
      if (r.intersectTriangle(V3(e.pts[0]), V3(e.pts[i]), V3(e.pts[i + 1]), false, t)) { const d = t.distanceTo(r.origin); if (d < bd) { bd = d; best = e; } }
    }
    if (best && hit && !edit.some(b => b.src.includes(hit.node)) && hit.point.distanceTo(r.origin) < bd - 0.5) return null;
    return best;
  }
  const cand = [];
  for (const b of own) for (const e of els(b)) {
    const q = e.pts.map(scr);
    if (q.some(s => s[2] >= 1)) continue;
    cand.push([e, level === 'vertex' ? Math.hypot(q[0][0] - x, q[0][1] - y) : segDist([x, y], q[0], q[1]), mid(q)[2]]);
  }
  const lim = level === 'vertex' ? 8 : 6;
  return cand.filter(c => c[1] <= lim).sort((a, b) => Math.round(a[1] / 2) - Math.round(b[1] / 2) || a[2] - b[2])[0]?.[0] ?? null;
}
// 2D: every element stacked on the spot nearest to x, y (within 7 px; faces by their centre, the one facing the view).
function at2d(v, x, y) {
  const ts = p => view2d.toScreen(v, p), cand = [];
  for (const b of edit.filter(b => b.own)) for (const e of els(b)) {
    const q = e.pts.map(ts), c = level === 'face' ? ts(mid(e.pts)) : q[0];
    cand.push([e, level === 'edge' ? segDist([x, y], q[0], q[1]) : Math.hypot(c[0] - x, c[1] - y)]);
  }
  const m = Math.min(...cand.map(c => c[1]));
  if (!(m <= 7)) return [];
  const hits = cand.filter(c => c[1] <= m + 1).map(c => c[0]), d = 3 - v.ax[0] - v.ax[1];
  return level === 'face' ? [hits.sort((a, b) => b.n[d] - a.n[d])[0]] : hits;
}
// Elements in a screen rectangle [x0, y0, x1, y1] through project(p) -> [x, y] | null. crossing: touching it is enough.
function inRect(r, project, crossing) {
  const [x0, y0, x1, y1] = r, inR = q => q[0] >= x0 && q[0] <= x1 && q[1] >= y0 && q[1] <= y1;
  const cs = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  return edit.filter(b => b.own).flatMap(els).filter(e => {
    const q = e.pts.map(project);
    if (q.some(x => !x)) return false;
    if (!crossing || level === 'vertex') return q.every(inR);
    if (q.some(inR)) return true;
    const segs = level === 'edge' ? [[q[0], q[1]]] : q.map((a, i) => [a, q[(i + 1) % q.length]]);
    return segs.some(([a, b]) => cs.some((c, i) => segCross(a, b, c, cs[(i + 1) % 4], 0))) || (level === 'face' && inside(cs[0], q));
  });
}

// ---------- preview and commit ----------
const prevGroup = new THREE.Group();
function clearPreview() {
  if (!prev) return;
  for (const it of prev.items) for (const s of it.b.src) { const c = cache.get(s); if (c?.mesh) c.mesh.visible = c.visible; }
  prev = null;
  for (const o of prevGroup.children) o.geometry.dispose();
  prevGroup.clear();
  redraw();
}
// items: [{ b, mm }] mesh edits (built here) or [{ b, solids }]. keys: the selection after it (position keys).
function showPreview(items, keys, fn = null, faces = null) {
  clearPreview();
  for (const it of items) it.r ??= it.solids ? { solids: it.solids } : P.build(it.mm, it.b.src, { texLock: lock() });
  prev = { items, keys, fn, faces };
  for (const it of items) {
    for (const s of it.b.src) { const c = cache.get(s); if (c?.mesh) c.mesh.visible = false; }
    if (!it.r.error) for (const s of it.r.solids) prevGroup.add(view3d.makeMesh({ node: it.b.s, faces: V.faces(s), point: false }));
  }
  const bad = items.find(it => it.r.error), n = items.reduce((a, it) => a + (it.r.solids?.length ?? 0), 0);
  say(bad ? `${bad.r.error} (release to cancel)` : `${plural(items.length, 'brush')} -> ${plural(n, 'brush')}${n > items.length ? ' (convex pieces, grouped)' : ''}`);
  redraw();
}
// Whether face element e lies in polygon ps (same plane, same way, its middle inside): a face cut into pieces stays
// selected.
function within(e, ps) {
  const n = unit(ps.reduce((s, a, i) => { const b = ps[(i + 1) % ps.length]; return add(s, [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]); }, [0, 0, 0])), d = dot(n, ps[0]);
  if (dot(n, e.n) < 0.999 || e.pts.some(p => Math.abs(dot(n, p) - d) > 0.05)) return false;
  const a = n.map(Math.abs), k = a.indexOf(Math.max(...a)), [i, j] = [0, 1, 2].filter(x => x !== k), c = mid(e.pts);
  return inside([c[i], c[j]], ps.map(p => [p[i], p[j]]));
}
// A new map step: redo steps of edit meshes go, and ones made past it (the map was undone under them).
const newStep = () => { topo.redo.length = 0; topo.undo = topo.undo.filter(t => t.at < depth()); };
// The preview into the map as one undo step. keys (and faces: polygons) give the selection after it. False (and nothing
// changes) when a brush in it is refused. An edit that would remove displacements asks first (disp: asked).
function commit(items = prev?.items, keys = prev?.keys, opts = {}) {
  const { group = true, ids, msg, faces = prev?.faces, disp = false } = opts;
  if (!items?.length) return clearPreview(), false;
  const done = [];
  for (const it of items) {
    const r = it.solids ? { solids: it.solids } : P.build(it.mm, it.b.src, { nextId, texLock: lock() });
    if (r.error) { clearPreview(); say(`${r.error} - nothing changed`); return false; }
    done.push({ b: it.b, ...r });
  }
  clearPreview();
  const lost = done.reduce((a, d) => a + Math.max(0, dispN(d.b.src) - dispN(d.solids)), 0);
  if (lost && !disp) {
    if (done.some(d => !d.b.own && dispN(d.b.src) > dispN(d.solids))) return say('a touching brush would lose its displacement - nothing changed (turn Sticky off)'), false;
    say('waiting for an answer about the displacement');
    ask(`This edit changes the shape of ${lost === 1 ? 'a displacement face, which loses its displacement' : `${lost} displacement faces, which lose their displacements`}.`, ['Change it', 'Cancel'])
      .then(i => (i ? say('nothing changed') : commit(items, keys, { ...opts, faces, disp: true })));
    return false;
  }
  // the old solids keep their nodes (piece k goes into old solid k), pieces past them are new
  const xs = [];
  for (const d of done) {
    d.nodes = d.solids.map((s, k) => d.b.src[k] ?? s);
    if (d.mesh) xs.push({ pieces: d.nodes, sigs: d.solids.map(sigOf), m: d.mesh });
  }
  xs.forEach(keep);
  const more = done.flatMap(d => (d.b.own ? d.nodes.slice(d.b.src.length) : [])), before = new Set(picked[level]), at = depth();
  committing = true;
  try {
    replaceSolids(done.map(d => [d.b.src, d.solids]), { group, ids });
    if (more.length) setSelection([...sel, ...more]);
    rebuild();
    if (keys) {
      const touched = new Set(done.map(d => d.b.s));
      picked[level] = new Set(edit.filter(b => opt().sticky || touched.has(b.s)).flatMap(b => els(b).filter(e => keys.has(e.k) || (level === 'face' && faces?.some(ps => within(e, ps)))).map(idOf)));
    }
  } finally { committing = false; }
  rebuild();
  hist.push({ l: level, before, after: new Set(picked[level]), sel: [...sel] });
  if (hist.length > 100) hist.shift();
  // no map step (the brushes came out as they were): an edit-mesh step of its own
  if (depth() !== at) newStep();
  else if (xs.length) { topo.undo.push({ at, xs, l: level, before, after: new Set(picked[level]) }); topo.redo.length = 0; }
  const n = done.reduce((a, d) => a + d.solids.length, 0), m = done.reduce((a, d) => a + d.b.src.length, 0);
  say(typeof msg === 'function' ? msg(n) : msg ?? `${plural(done.length, 'brush')} edited${n > done.length ? `, now ${n} convex pieces (grouped)` : n < m ? `, now ${plural(n, 'brush')}` : ''}${lost ? `, ${lost} displacement${lost === 1 ? '' : 's'} removed` : ''}`);
  return true;
}

// Undo or redo of the last edit-mesh-only edit, when no map step came after it (undo) or is due before it (redo);
// false otherwise (the map's own undo or redo runs then).
function topoStep(dir) {
  const u = dir === 'undo', t = (u ? topo.undo : topo.redo).at(-1);
  if (!t || (u ? t.at < depth() : t.at > depth())) return false;
  (u ? topo.undo : topo.redo).pop();
  t.xs.forEach(u ? unkeep : keep);
  (u ? topo.redo : topo.undo).push(t);
  rebuild();
  picked[t.l] = new Set(dir === 'undo' ? t.before : t.after);
  rebuild();
  say(`${dir === 'undo' ? 'undid' : 'redid'} a face split (the brush itself did not change)`);
  return true;
}

// The selected vertices moved by fn (point -> point), previewed; keys follow the moved elements.
function previewXf(fn) {
  const keyAfter = e => { const ps = e.pts.map(fn).map(P.key); return level === 'vertex' ? ps[0] : ps.sort().join(level === 'edge' ? '|' : ';'); };
  const items = edit.map(b => [b, new Set(els(b).filter(isSel).flatMap(e => e.vs))]).filter(x => x[1].size)
    .map(([b, vs]) => ({ b, mm: P.moved(b.m, (p, i) => (vs.has(i) ? fn(p) : undefined)) }));
  showPreview(items, new Set(selEls().map(keyAfter)), fn, level === 'face' ? selEls().map(e => e.pts.map(fn)) : null);
}
const applyXf = fn => { previewXf(fn); commit(); };

// ---------- pivot and frame ----------
function pivot() {
  if (opt().pivot === 'brush') { const cs = edit.filter(b => b.own).flatMap(b => b.src.map(s => cache.get(s))); if (cs.length) return mid(box(cs.flatMap(c => [c.min, c.max]))); }
  const ps = selPts();
  return ps.length ? mid(box(ps)) : [0, 0, 0];
}
// Local space: z along the selection's normal (faces' normals, or the faces round the selected edges / vertices),
// x along the first selected edge or the world x / y axis.
function frame() {
  const q = new THREE.Quaternion();
  if (cfg.gizmoSpace !== 'local') return q;
  const es = selEls();
  let z = [0, 0, 0];
  for (const e of es) {
    if (e.n) z = add(z, e.n);
    else for (const f of e.b.m.f) if (e.vs.every(v => f.vs.includes(v))) z = add(z, P.normal(e.b.m, f));
  }
  z = unit(z);
  if (!z.some(Boolean)) return q;
  let x = level === 'edge' && es.length ? unit(sub(es[0].pts[1], es[0].pts[0])) : [1, 0, 0];
  x = unit(sub(x, mul(z, dot(x, z))));
  if (Math.hypot(...x) < 0.5) x = unit(sub([0, 1, 0], mul(z, z[1])));
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(V3(x), V3(y), V3(z)));
}

// ---------- gizmo ----------
const proxy = new THREE.Object3D();
function placeGizmo() {
  if (!tc || gz) return;
  if (S.tool !== ID || !S.gizmo || drag?.moved || prev || !selEls().length) { if (tc.object) tc.detach(); return view3d.invalidate(); }
  proxy.position.fromArray(pivot());
  proxy.quaternion.copy(frame());
  proxy.scale.set(1, 1, 1);
  tc.setMode(S.gizmo);
  tc.setRotationSnap(rstep() * D2R);
  tc.setSpace('local');
  tc.attach(proxy);
  view3d.invalidate();
}
function gizmoStart() {
  const q0 = proxy.quaternion.clone(), qi = q0.clone().invert(), p0 = proxy.position.clone(), ps = selPts();
  const [lo, hi] = box(ps.map(p => V3(p).sub(p0).applyQuaternion(qi).toArray()));
  gz = { mode: tc.mode, axis: tc.axis, p0, q0, qi, ext: hi.map((x, k) => x - lo[k]), ref: box(ps)[0], sig: '' };
  const skip = snapSkip();
  // the edited brushes stay targets (their other vertices, the neighbours' corners): only the moving points are left out
  gz.snap = tc.mode === 'translate' && osnap.any() && osnap.snapper({ proj: view3d.screenOf, ray: view3d.rayArr, hit: s => view3d.hitExcept(s, skip), moving: ps, own: true });
  hov = null;
}
function gizmoMove() {
  if (!gz) return;
  const act = k => gz.axis?.includes('XYZ'[k]), g = step(), o = gz.p0.toArray(), world = Math.abs(gz.q0.w) > 1 - 1e-9;
  let fn = null, sig = '';
  if (gz.mode === 'translate') {
    const d = proxy.position.clone().sub(gz.p0).applyQuaternion(gz.qi).toArray(), r = world ? gz.ref : [0, 0, 0];
    let t = V3(d.map((x, k) => (act(k) ? sn(r[k] + x, g) - r[k] : 0))).applyQuaternion(gz.q0).toArray();
    if (gz.snap) {
      const hit = gz.snap(t, a => V3(V3(a).applyQuaternion(gz.qi).toArray().map((x, k) => (act(k) ? x : 0))).applyQuaternion(gz.q0).toArray(), view3d.mousePos());
      if (hit) t = hit.t;
      view3d.snapMark(hit?.at ?? null);
    }
    proxy.position.copy(gz.p0).add(V3(t));
    if (t.some(x => Math.abs(x) > 1e-9)) { fn = p => add(p, t); sig = 't' + t.map(x => x.toFixed(4)); }
  } else if (gz.mode === 'scale') {
    const s = [0, 1, 2].map(k => { const e = gz.ext[k], f = proxy.scale.getComponent(k); return !act(k) || e < 1e-6 ? 1 : Math.max(0, cfg.snapGrid === false ? e * f : sn(e * f, g)) / e; });
    const R = new THREE.Matrix4().makeRotationFromQuaternion(gz.q0), X = R.clone().multiply(new THREE.Matrix4().makeScale(...s)).multiply(R.clone().invert());
    if (s.some(x => Math.abs(x - 1) > 1e-9)) { fn = p => V3(sub(p, o)).applyMatrix4(X).toArray().map((x, k) => x + o[k]); sig = 's' + s.map(x => x.toFixed(4)); }
  } else {
    const rot = view3d.rotOf(proxy.quaternion.clone().multiply(gz.qi), rstep());
    if (rot) { const m = V.rotation(rot.axis, rot.deg); fn = p => { const q = sub(p, o); return m.map(r => dot(r, q) + 0).map((x, k) => x + o[k]); }; sig = 'r' + rot.deg + String(rot.axis); }
  }
  if (sig === gz.sig) return;
  gz.sig = sig;
  if (fn) previewXf(fn); else clearPreview();
}
function gizmoEnd() {
  const g = gz;
  gz = null;
  if (osnap.mark.at) view3d.snapMark(null);
  if (g && prev) { const bad = prev.items.find(it => it.r.error); if (bad) { clearPreview(); say(`${bad.r.error} - not applied`); } else commit(); }
  placeGizmo();
}

// ---------- operations ----------
const many = l => (l === 'vertex' ? 'vertices' : l + 's');
function need(l, what) {
  if (level !== l) return say(`${what} works on ${many(l)} (press ${LEVELS.indexOf(l) + 1})`), false;
  if (!picked[l].size) return say(`select ${many(l)} first`), false;
  return true;
}
// Mesh edits per brush: fn(entry, Set of element indices) -> { mm, keys } | { error }; previewed, then committed.
function meshOp(fn, own, msg) {
  const items = [], keys = new Set(), faces = [];
  for (const [b, ids] of selBy(own)) {
    const r = fn(b, ids);
    if (r?.error) return say(r.error);
    if (!r) continue;
    items.push({ b, mm: r.mm });
    r.keys?.forEach(k => keys.add(k));
    if (r.faces) faces.push(...r.faces);
  }
  if (!items.length) return say(`${msg}: nothing to do here`);
  commit(items, keys, { faces, msg: n => `${msg}: ${plural(items.length, 'brush')}${n > items.length ? `, now ${n} convex pieces (grouped)` : ''}` });
}
const faceKeys = (mm, fis) => [...fis].map(i => P.faceKey(mm, mm.f[i])), facePolys = (mm, fis) => [...fis].map(i => mm.f[i].vs.map(j => mm.v[j]));
function extrude(h = opt().extrude) {
  if (!need('face', 'extrude')) return;
  if (!(h > 0)) return say('the extrude height must be more than 0 (move the faces in with the gizmo)');
  meshOp((b, fs) => { const mm = P.extrude(b.m, fs, h, opt().extrudeType); return { mm, keys: faceKeys(mm, fs), faces: facePolys(mm, fs) }; }, true, `extruded by ${h}`);
}
function inset() {
  if (!need('face', 'inset')) return;
  meshOp((b, fs) => { const r = P.inset(b.m, fs, opt().inset); return r.error ? r : { mm: r.mesh, keys: faceKeys(r.mesh, r.faces), faces: facePolys(r.mesh, r.faces) }; }, true, `inset by ${opt().inset}`);
}
function bevel() {
  if (!need('face', 'bevel')) return;
  const { bevelHeight: h, bevelOutline: o } = opt();
  meshOp((b, fs) => { const r = P.bevel(b.m, fs, h, o); return r.error ? r : { mm: r.mesh, keys: faceKeys(r.mesh, fs), faces: facePolys(r.mesh, fs) }; }, true, `bevelled (height ${h}, outline ${o})`);
}
// Plane edits cut convex brushes: the pieces of a concave edit each get the elements of their own under the selected
// ones (a vertex on the spot, an edge along a convex one, a face inside one).
function pieces(b, ids) {
  if (b.src.length === 1) return [[b, ids]];
  const chosen = els(b).filter(e => ids.has(e.i)), em = P.edgeMap(b.m);
  const onSeg = (p, [a, c]) => { const d = sub(c, a), t = Math.max(0, Math.min(1, dot(sub(p, a), d) / dot(d, d))); return Math.hypot(...sub(p, add(a, mul(d, t)))) < 0.01; };
  const convex = c => { const [f, g] = em.get(c.i).f.map(i => b.m.f[i]), n = P.normal(b.m, f), o = b.m.v[f.vs[0]]; return g.vs.every(i => dot(n, sub(b.m.v[i], o)) < 0.01); };
  const under = (e, c) => (level === 'vertex' ? e.k === c.k : level === 'edge' ? e.pts.every(p => onSeg(p, c.pts)) && convex(c) : within(e, c.pts));
  return b.src.map(s => { const p = { s, src: [s], own: b.own, m: P.meshOf(s) }; return [p, new Set(els(p).filter(e => chosen.some(c => under(e, c))).map(e => e.i))]; });
}
// Plane edits per brush: fn(entry, ids) -> solids | null (unchanged) | string (refused). all: every piece of a concave
// edit gets fn, not only those under the selection.
function planeOp(fn, own, msg, opts = {}) {
  const items = [];
  for (const [b, ids] of selBy(own)) {
    const res = [];
    for (const [p, pids] of pieces(b, ids)) {
      const r = pids.size || opts.all ? fn(p, pids) : null;
      if (typeof r === 'string') return say(r);
      res.push(r ?? [p.s]);
    }
    // each piece's first result goes into it, the rest after
    if (res.some((r, k) => r.length > 1 || r[0] !== b.src[k])) items.push({ b, solids: [...res.map(r => r[0]), ...res.flatMap(r => r.slice(1))] });
  }
  if (!items.length) return say(`${msg}: nothing to do here`);
  commit(items, null, { ...opts, msg: `${msg}: ${plural(items.length, 'brush')}` });
}
function deleteFaces() {
  if (!need('face', 'delete')) return;
  planeOp((b, fs) => { const s = P.withoutSides(b.s, [...new Set([...fs].map(i => b.m.f[i].side))]); return s ? [s] : 'the other faces would not close the brush (try a chamfer face or a cut corner)'; }, true, 'deleted faces');
}
const oriented = (q, n) => (dot(V.planeOf(q).n, n) < 0 ? [...q].reverse() : q);
// Detach: a slab t thick under each face becomes a brush of its own (the brush is cut along the face, t in).
function detach() {
  if (!need('face', 'detach')) return;
  const t = opt().detach, ids = new Map();
  planeOp((b, fs) => {
    let rest = b.s;
    const out = [];
    for (const i of fs) {
      const fc = b.m.f[i], n = P.normal(b.m, fc), q = oriented(V.best3(fc.vs.map(j => b.m.v[j])), n).map(p => sub(p, mul(n, t)));
      const [front, back] = V.clip(rest, q, nextId, ids);
      if (!front || !back) return `the brush is not thicker than ${t} under that face`;
      out.push(front);
      rest = back;
    }
    V.set(rest, 'id', V.get(b.s, 'id'));
    return [rest, ...out];
  }, true, `detached slabs ${t} thick`, { group: false, ids });
}
// Slice: the brushes holding the selection cut by the plane through the selected vertices or edges (one edge or two
// vertices: the plane through them along the view).
function slice() {
  if (level === 'face') return say('slice works on vertices (1) or edges (2): a plane through them');
  const ps = selPts();
  if (ps.length < 2) return say('slice: select an edge, two vertices or more');
  let q = ps.length >= 3 ? V.best3(ps) : null;
  if (q) { const { n, d } = V.planeOf(q); if (!ps.every(p => Math.abs(dot(n, p) - d) < 0.5)) return say('slice: the selection is not in one plane'); }
  else {
    const f = view3d.cam.getWorldDirection(new THREE.Vector3()).toArray();
    q = [ps[0], ps[1], add(ps[0], mul(f, 64))];
    if (!V.planeOf(q).ok) return say('slice: you are looking along the edge');
  }
  const ids = new Map();
  planeOp(b => { const [f, k] = V.clip(b.s, q, nextId, ids); if (!f || !k) return null; V.set(k, 'id', V.get(b.s, 'id')); return [k, f]; }, false, 'sliced', { group: false, ids, all: true });
}
function chamfer() {
  if (level === 'face') return say('chamfer works on vertices (1) or edges (2)');
  if (!picked[level].size) return say(`select ${many(level)} first`);
  const { chamfer: d, segments } = opt();
  planeOp((b, ids) => {
    const s = level === 'edge' ? P.chamferEdges(b.s, b.m, ids, d, segments, nextId) : P.chamferVerts(b.s, b.m, ids, d, nextId);
    return s ? [s] : 'chamfer: nothing valid would be left (a smaller amount?)';
  }, false, `chamfered by ${d}`);
}
// Max's Connect: new edges between the selected edges (segments of them; the new edges are selected after) or between
// the selected vertices on each face (they stay selected).
function connect() {
  if (level === 'face') return say('connect works on vertices (1) or edges (2)');
  if (!picked[level].size) return say(`select ${many(level)} first`);
  meshOp((b, ids) => {
    const c = level === 'edge' ? P.connect(b.m, ids, opt().connect) : P.connectVerts(b.m, ids);
    return c.edges.length ? { mm: c.mesh, keys: level === 'edge' ? c.edges.map(([x, y]) => P.edgeKey(c.mesh, x, y)) : [...ids].map(i => P.vertexKey(b.m, i)) } : null;
  }, false, 'connected');
}
function remove() {
  if (level === 'face') return deleteFaces();
  if (!picked[level].size) return say(`select ${many(level)} first`);
  meshOp((b, ids) => ({ mm: level === 'edge' ? P.removeEdges(b.m, ids) : P.removeVerts(b.m, ids) }), false, 'removed');
}
// Groups of selected elements that share a corner (all: one group), each with its centre: position key -> centre.
function centres(all) {
  const es = selEls(), parent = es.map((_, i) => (all ? 0 : i)), find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  if (!all) {
    const at = new Map();
    es.forEach((e, i) => e.pts.forEach(p => { const k = P.key(p); if (at.has(k)) parent[find(i)] = find(at.get(k)); else at.set(k, i); }));
  }
  const groups = new Map();
  es.forEach((e, i) => { const g = groups.get(find(i)) ?? groups.set(find(i), new Map()).get(find(i)); e.pts.forEach(p => g.set(P.key(p), p)); });
  const out = new Map();
  for (const g of groups.values()) { const c = mid([...g.values()]); for (const k of g.keys()) out.set(k, c); }
  return out;
}
function collapse() {
  if (!picked[level].size) return say(`select ${many(level)} first`);
  const at = centres(level === 'vertex');
  previewXf(p => at.get(P.key(p)) ?? p);
  if (level === 'vertex') prev.keys = new Set([...at.values()].map(P.key));
  commit(undefined, undefined, { msg: 'collapsed' });
}
// Weld: selected vertices within the threshold of each other meet at their centre.
function weld() {
  if (!need('vertex', 'weld')) return;
  const ps = selPts(), t = opt().weld, at = new Map(), left = [...ps];
  while (left.length) {
    const seed = left.shift(), g = [seed, ...left.filter(p => Math.hypot(...sub(p, seed)) <= t)];
    for (const p of g.slice(1)) left.splice(left.indexOf(p), 1);
    const c = mid(g);
    for (const p of g) at.set(P.key(p), c);
  }
  previewXf(p => at.get(P.key(p)) ?? p);
  prev.keys = new Set([...at.values()].map(P.key));
  commit(undefined, undefined, { msg: `welded within ${t}` });
}
function snap() {
  if (!picked[level].size) return say(`select ${many(level)} first`);
  applyXf(p => p.map(x => Math.round(x / S.grid) * S.grid + 0));
}
const nudge = t => applyXf(p => add(p, t));
function turn(k, deg) { if (!deg) return; const m = V.rotation(k, deg), o = pivot(); applyXf(p => { const q = sub(p, o); return m.map(r => dot(r, q)).map((x, j) => x + o[j]); }); }
function scaleBy(k, f) { if (!(f >= 0) || f === 1) return; const o = pivot(); applyXf(p => p.map((x, j) => (j === k ? o[j] + (x - o[j]) * f : x))); }

// ---------- levels ----------
function setLevel(l) {
  const from = S.tool !== ID, faces = from && S.mode === 'face' ? [...faceSel] : null;
  level = l;
  hov = null;
  if (S.mode !== l) setMode(l);
  if (from) setTool(ID);
  if (l !== 'face' && faceSel.size) setFaceSelection([]);
  if (faces?.length) adopt(faces);
  rebuild();
  say(`${edit.filter(b => b.own).length ? 'click to select, W/E/R move, rotate, scale' : 'select brushes to edit (click them)'}; 4 or Escape: objects`);
}
// Coming from face mode: the faces selected there (and their brushes) become the selection.
function adopt(sides) {
  const want = new Set(sides), solids = [...cache.values()].filter(c => c.node.name === 'solid' && c.faces.some(f => want.has(f.side))).map(c => c.node);
  setSelection([...new Set([...sel, ...solids])]);
  rebuild();
  picked.face = new Set(edit.flatMap(b => elements(b).face.filter(e => want.has(e.side)).map(idOf)));
}
// A click on a brush not being edited selects it (Ctrl at the face level: adds just it); at the face level the face
// under the cursor (find()) is picked in the same click.
function clickBrush(n, ctrl, find) {
  if (level === 'face' && ctrl) setSelection([...sel, n]); else clickSelect(n, ctrl);
  const h = level === 'face' && find();
  if (h) pick([h], ctrl ? 'add' : 'set');
}
const toggleLevel = l => (S.tool === ID && level === l ? exit() : setLevel(l));
function exit() { cancel(); setTool('select'); setMode('object'); }
function cancel() {
  if (gz) { gz = null; tc.dragging = false; tc.axis = null; }
  drag = null;
  if (boxEl) boxEl.hidden = true;
  clearPreview();
  placeGizmo();
}

// ---------- drawing ----------
const lm = (color, opacity = 1) => new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity });
const pm = (color, size) => new THREE.PointsMaterial({ color, size, sizeAttenuation: false, depthTest: false });
const fm = (color, opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
const wire = new THREE.LineSegments(new THREE.BufferGeometry(), lm(0x8fb0ff, 0.6)), selL = new THREE.LineSegments(new THREE.BufferGeometry(), lm(0xff3030));
const hovL = new THREE.LineSegments(new THREE.BufferGeometry(), lm(0xffffff)), okL = new THREE.LineSegments(new THREE.BufferGeometry(), lm(0xffd040));
const badL = new THREE.LineSegments(new THREE.BufferGeometry(), lm(0xff3030)), dots = new THREE.Points(new THREE.BufferGeometry(), pm(0xffd040, 6));
const selP = new THREE.Points(new THREE.BufferGeometry(), pm(0xff3030, 8)), hovP = new THREE.Points(new THREE.BufferGeometry(), pm(0xffffff, 10));
const selF = new THREE.Mesh(new THREE.BufferGeometry(), fm(0xff2020, 0.45)), hovF = new THREE.Mesh(new THREE.BufferGeometry(), fm(0xffffff, 0.22));
const badF = new THREE.Mesh(new THREE.BufferGeometry(), fm(0xff2020, 0.5));
const group = new THREE.Group().add(selF, hovF, badF, wire, okL, badL, selL, hovL, dots, selP, hovP);
group.traverse(o => { o.renderOrder = 3; o.frustumCulled = false; });
selF.material.depthTest = hovF.material.depthTest = true;
function setPts(o, pts) {
  o.geometry.dispose();
  o.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts.flat(), 3));
}
const loops = polys => polys.flatMap(ps => ps.flatMap((p, i) => [p, ps[(i + 1) % ps.length]]));
const fans = polys => polys.flatMap(ps => ps.slice(1, -1).flatMap((p, i) => [ps[0], p, ps[i + 2]]));
const prevPolys = it => (it.r.error ? it.r.mesh.f.map(f => f.vs.map(i => it.r.mesh.v[i])) : it.r.solids.flatMap(s => V.faces(s).map(f => f.pts)));

function redraw() {
  const on3 = S.tool === ID, own = on3 ? edit.filter(b => b.own) : [], fn = prev?.fn, mp = e => (fn ? e.pts.map(fn) : e.pts);
  const chosen = on3 ? selEls() : [], free = own.flatMap(els).filter(e => !isSel(e)), h = hov && on3 ? [hov] : [];
  setPts(wire, own.flatMap(b => elements(b).edge.flatMap(e => e.pts)));
  setPts(dots, level === 'vertex' ? free.map(e => e.pts[0]) : []);
  setPts(selP, level === 'face' ? [] : chosen.flatMap(mp));
  setPts(selL, level === 'vertex' ? [] : level === 'edge' ? chosen.flatMap(mp) : loops(chosen.map(mp)));
  setPts(selF, level === 'face' ? fans(chosen.map(mp)) : []);
  setPts(hovP, h.flatMap(e => (level === 'face' ? [] : e.pts)));
  setPts(hovL, level === 'face' ? loops(h.map(e => e.pts)) : level === 'edge' ? h.flatMap(e => e.pts) : []);
  setPts(hovF, level === 'face' ? fans(h.map(e => e.pts)) : []);
  const its = prev?.items ?? [];
  setPts(okL, loops(its.filter(it => !it.r.error).flatMap(prevPolys)));
  setPts(badL, loops(its.filter(it => it.r.error).flatMap(prevPolys)));
  setPts(badF, fans(its.filter(it => it.r.error).flatMap(prevPolys)));
  view3d.invalidate();
  view2d.invalidate();
}

function overlay(ctx, v, { toScreen }) {
  if (S.tool !== ID) return;
  const ts = p => toScreen(v, p), own = edit.filter(b => b.own), fn = prev?.fn, mp = e => (fn ? e.pts.map(fn) : e.pts);
  const line = (ps, close) => { ps.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](...ts(p))); if (close) ctx.closePath(); };
  const sq = (p, r, c) => { const [x, y] = ts(p); ctx.fillStyle = c; ctx.fillRect(x - r, y - r, 2 * r, 2 * r); };
  ctx.strokeStyle = '#6f86b8';
  ctx.beginPath();
  for (const b of own) for (const e of elements(b).edge) line(e.pts);
  ctx.stroke();
  for (const it of prev?.items ?? []) { ctx.strokeStyle = it.r.error ? '#ff3030' : '#ffd040'; ctx.beginPath(); prevPolys(it).forEach(ps => line(ps, true)); ctx.stroke(); }
  const chosen = selEls(), free = own.flatMap(els).filter(e => !isSel(e));
  if (level === 'vertex') { free.forEach(e => sq(e.pts[0], 3, '#ffd040')); chosen.forEach(e => sq(mp(e)[0], 3.5, '#ff3030')); }
  else {
    free.forEach(e => sq(mid(e.pts), 2, level === 'edge' ? '#ffffff' : '#8fd0ff'));
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ff3030';
    ctx.beginPath();
    chosen.forEach(e => line(mp(e), level === 'face'));
    ctx.stroke();
    chosen.forEach(e => sq(mid(mp(e)), 2.5, '#ff3030'));
  }
  if (hov) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    if (level === 'vertex') sq(hov.pts[0], 4, '#ffffff');
    else { ctx.beginPath(); line(hov.pts, level === 'face'); ctx.stroke(); }
  }
  if (drag?.v === v && drag.b) {
    const a = view2d.s2(v, ...drag.w0), b = view2d.s2(v, ...drag.b);
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#4f8cff';
    ctx.setLineDash(drag.b[0] < drag.w0[0] ? [2, 3] : [6, 3]); // right to left: crossing
    ctx.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
  }
}

// ---------- 3D input ----------
const onPlane = (x, y, pl) => view3d.rayAt(x, y).intersectPlane(pl, new THREE.Vector3())?.toArray();
// The axis plane through p facing the camera most.
function plane3d(p) {
  const f = view3d.cam.getWorldDirection(new THREE.Vector3()).toArray().map(Math.abs), k = f.indexOf(Math.max(...f));
  return { k, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3().setComponent(k, 1), V3(p)) };
}
// Distance along d.n from d.p0 of the point on that line nearest the mouse ray; null when looking along it.
function along(d, x, y) {
  const r = view3d.rayAt(x, y), n = V3(d.n), w = V3(d.p0).sub(r.origin), b = n.dot(r.direction), den = 1 - b * b;
  return den < 1e-4 ? null : (b * r.direction.dot(w) - n.dot(w)) / den;
}
function marquee3d(d, x, y) {
  const r = [Math.min(d.x, x), Math.min(d.y, y), Math.max(d.x, x), Math.max(d.y, y)];
  return inRect(r, p => { const q = scr(p); return q[2] < 1 ? q : null; }, x < d.x);
}
function dragElement(d, x, y) {
  if (level === 'face') {
    const s = along(d, x, y);
    if (s === null) return;
    const dist = sn(s);
    if (dist === d.dist) return;
    d.dist = dist;
    if (!dist) return clearPreview();
    if (!d.extrude) return previewXf(p => add(p, mul(d.n, dist)));
    if (dist < 0) return clearPreview(), say('extrude: drag outward');
    const items = selBy(true).map(([b, fs]) => ({ b, mm: P.extrude(b.m, fs, dist, opt().extrudeType), fs }));
    return showPreview(items, new Set(items.flatMap(it => faceKeys(it.mm, it.fs))), null, items.flatMap(it => facePolys(it.mm, it.fs)));
  }
  const p = onPlane(x, y, d.plane);
  if (!p) return;
  const t = d.ref.map((r, k) => (k === d.k ? 0 : sn(r + p[k] - d.p0[k]) - r)), sig = t.join();
  if (sig === d.sig) return;
  d.sig = sig;
  if (t.some(Boolean)) previewXf(q => add(q, t)); else clearPreview();
}

const tool3d = {
  drawsSelection: true,
  activate() { view3d.addHelper(group); view3d.addHelper(prevGroup); panel.hidden = false; rebuild(); },
  deactivate() {
    cancel();
    if (tc.object) tc.detach();
    view3d.removeHelper(group);
    view3d.removeHelper(prevGroup);
    panel.hidden = true;
    edit = [];
    extra.clear();
    hov = null;
    redraw();
    queueMicrotask(() => { if (S.tool !== ID && LEVELS.includes(S.mode)) setMode('object'); if (S.tool !== ID && faceSel.size) setFaceSelection([]); });
  },
  down(e, hit) {
    shift = e.shiftKey;
    if (tc.object && tc.axis && !e.altKey) return true; // the gizmo takes it (Alt turns it off: a click removes)
    const x = e.offsetX, y = e.offsetY;
    if (e.altKey && !e.ctrlKey) { drag = { alt: true, x, y }; return false; } // Alt+drag orbits; an Alt click removes (up)
    drag = { x, y, hit, el: S.gizmo ? at3d(x, y, hit) : null, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, moved: false };
    return true;
  },
  move(e, hit) {
    shift = e.shiftKey;
    tc.setRotationSnap(rstep() * D2R);
    const x = e.offsetX, y = e.offsetY, d = drag?.v ? null : drag; // drag.v: a 2D drag
    if (gz || tc.dragging) return true;
    if (!d || d.alt) { const h = tc.object && tc.axis ? null : at3d(x, y, hit); if (h !== hov) { hov = h; redraw(); } return true; }
    if (!d.moved) {
      if (Math.hypot(x - d.x, y - d.y) < 4) return true;
      d.moved = true;
      hov = null;
      if (tc.object) tc.detach();
      if (d.el) {
        if (!isSel(d.el)) pick([d.el], d.ctrl ? 'add' : 'set');
        if (level === 'face') {
          const r = view3d.rayAt(d.x, d.y), p = r.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(V3(d.el.n), V3(d.el.pts[0])), new THREE.Vector3());
          Object.assign(d, { n: d.el.n, p0: p?.toArray() ?? mid(d.el.pts), dist: 0, extrude: d.ctrl || d.shift });
        } else Object.assign(d, plane3d(d.el.pts[0]), { ref: d.el.pts[0], p0: onPlane(d.x, d.y, plane3d(d.el.pts[0]).plane) });
      }
    }
    if (d.el) { if (level === 'face' || d.p0) dragElement(d, x, y); }
    else {
      Object.assign(boxEl.style, { left: `${Math.min(x, d.x)}px`, top: `${Math.min(y, d.y)}px`, width: `${Math.abs(x - d.x)}px`, height: `${Math.abs(y - d.y)}px` });
      boxEl.hidden = false;
      boxEl.classList.toggle('crossing', x < d.x); // right to left: elements touching the box
    }
    return true;
  },
  up(e, hit) {
    if (drag?.v) return true;
    const d = drag, x = e.offsetX, y = e.offsetY;
    drag = null;
    boxEl.hidden = true;
    if (!d) return true;
    if (d.alt) {
      if (Math.hypot(x - d.x, y - d.y) >= 4) return false; // it orbited
      const h = at3d(x, y, hit);
      if (h) pick([h], 'remove');
      return true;
    }
    if (!d.moved) {
      const h = at3d(x, y, d.hit);
      if (h) pick([h], d.ctrl ? 'add' : 'set');
      else if (d.hit && d.hit.node.name === 'solid' && !sel.has(d.hit.node)) clickBrush(d.hit.node, d.ctrl, () => at3d(x, y, d.hit)); // another brush
      else if (!d.ctrl) { picked[level].clear(); rebuild(); selTouched(); }
    } else if (d.el) { if (prev) { const bad = prev.items.find(it => it.r.error); if (bad) { clearPreview(); say(`${bad.r.error} - not applied`); } else commit(); } }
    else pick(marquee3d(d, x, y), d.ctrl && d.alt ? 'remove' : d.ctrl ? 'add' : 'set');
    placeGizmo();
    return true;
  },
  dblclick(e, hit) {
    const h = at3d(e.offsetX, e.offsetY, hit);
    if (!h) return;
    if (level === 'edge') pick([...P.loopOf(h.b.m, h.i)].map(k => els(h.b).find(x => x.i === k)).filter(Boolean), 'add');
    else pick(els(h.b), 'add'); // the whole brush (Max's element)
  },
  key(e) {
    if (e.key === 'Escape') { if (drag || gz || prev) cancel(); else exit(); return true; }
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return false; // Q W E R, Ctrl+`: the gizmo commands (view3d.js)
    const dir = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [1, 1], ArrowDown: [1, -1] }[e.key];
    if (!dir || !picked[level].size || drag) return false;
    const t = [0, 0, 0];
    t[(activeView() ?? view2d.viewByName('top')).ax[dir[0]]] = dir[1] * step();
    nudge(t);
    return true;
  },
};

// ---------- 2D input ----------
const tool2d = {
  down(v, e, w) {
    shift = e.shiftKey;
    const hs = at2d(v, e.offsetX, e.offsetY);
    drag = { v, w0: w, hs, ctrl: e.ctrlKey, alt: e.altKey, sx: e.offsetX, sy: e.offsetY, moved: false };
    return true;
  },
  move(v, e, w) {
    shift = e.shiftKey;
    const d = drag;
    if (d && d.v !== v) return true; // a drag started in another view
    if (!d) { const h = at2d(v, e.offsetX, e.offsetY)[0] ?? null; if (h !== hov) { hov = h; redraw(); } return true; }
    if (!d.moved && Math.hypot(e.offsetX - d.sx, e.offsetY - d.sy) < 4) return true;
    if (!d.moved) {
      d.moved = true;
      hov = null;
      if (d.hs.length && !d.alt) { if (!d.hs.some(isSel)) pick(d.hs, d.ctrl ? 'add' : 'set'); d.ref = d.hs[0].pts[0]; }
      else d.hs = [];
    }
    if (!d.hs.length) { d.b = w; return true; }
    let t = [0, 0, 0];
    v.ax.forEach((k, i) => { t[k] = sn(d.ref[k] + w[i] - d.w0[i]) - d.ref[k]; });
    if (d.snap === undefined) d.snap = osnap.any() && osnap.snapper({ proj: p => view2d.toScreen(v, p), moving: selPts(), own: true });
    const hit = d.snap && d.snap(t, a => a.map((x, k) => (v.ax.includes(k) ? x : 0)), [e.offsetX, e.offsetY]);
    if (hit) t = hit.t;
    osnap.mark.at = hit?.at ?? null;
    if (t.join() !== d.sig) { d.sig = t.join(); if (t.some(Boolean)) previewXf(p => add(p, t)); else clearPreview(); }
    return true;
  },
  up(v, e) {
    const d = drag;
    if (d && d.v !== v) return true;
    drag = null;
    osnap.mark.at = null;
    if (!d) return true;
    if (!d.moved) {
      if (d.hs.length) pick(d.hs, d.alt ? 'remove' : d.ctrl ? 'add' : 'set');
      else { const n = view2d.pickAt(v, d.w0); if (n?.name === 'solid' && !sel.has(n)) clickBrush(n, d.ctrl, () => at2d(v, d.sx, d.sy)[0]); else if (!d.ctrl && !d.alt) { picked[level].clear(); rebuild(); selTouched(); } }
    } else if (d.hs.length) { if (prev) { const bad = prev.items.find(it => it.r.error); if (bad) { clearPreview(); say(`${bad.r.error} - not applied`); } else commit(); } }
    else if (d.b) {
      const a = view2d.s2(v, ...d.w0), b = view2d.s2(v, ...d.b), r = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
      pick(inRect(r, p => view2d.toScreen(v, p), d.b[0] < d.w0[0]), d.alt ? 'remove' : d.ctrl ? 'add' : 'set');
    }
    placeGizmo();
    return true;
  },
};

// ---------- Details panel: numeric entry ----------
function details(H) {
  if (S.tool !== ID) return null;
  const es = selEls(), ps = selPts();
  if (!ps.length) return H.section('Poly selection', el('small', { textContent: `No ${plural(2, level).slice(2)} selected: click, Ctrl+click or drag a box in the 3D or 2D views.` }));
  const c = mid(box(ps)), ax = k => [0, 1, 2].map(j => (j === k ? 1 : 0)), n = new Set(es.flatMap(e => e.b.src)).size;
  return H.section(`Poly: ${plural(es.length, level)} on ${plural(n, 'brush')}`,
    H.row('Center', 'Centre of the selection; a value moves it there', ...[0, 1, 2].map(k => H.num('pc' + k, [c[k]], f => nudge(mul(ax(k), f(c[k]) - c[k])), { axis: k }))),
    H.row('Move by', 'Moves the selection by this much', ...[0, 1, 2].map(k => H.num('po' + k, [0], f => nudge(mul(ax(k), f(0))), { axis: k }))),
    H.row('Rotate', 'Turns the selection this many degrees about the pivot (world axes)', ...[0, 1, 2].map(k => H.num('pr' + k, [0], f => turn(k, f(0)), { axis: k, steps: H.DEG }))),
    H.row('Scale %', 'Scales the selection about the pivot', ...[0, 1, 2].map(k => H.num('ps' + k, [100], f => scaleBy(k, f(100) / 100), { axis: k, steps: () => [10, 1, 50] }))));
}

// ---------- panel over the 3D view ----------
function makePanel(host) {
  const o = opt(), inputs = [];
  // Enter applies and hands the keys back to the editor (Escape: back to the saved value)
  const num = (k, title) => {
    const i = el('input', { type: 'number', step: 'any', value: o[k], title, onchange: () => { const x = +i.value; if (Number.isFinite(x)) setOpt(k, x); } });
    i.onkeydown = e => { if (e.key === 'Escape') i.value = opt()[k]; if (e.key === 'Enter' || e.key === 'Escape') i.blur(); };
    i.dataset.key = k;
    inputs.push(i);
    return i;
  };
  const lab = (text, ...kids) => el('label', { title: kids[0]?.title ?? '' }, text + ' ', ...kids);
  const btn = (text, cmd) => { const b = el('button', { textContent: text, onclick: () => runCmd(cmd) }); b.dataset.cmd2 = cmd; return b; };
  const lv = [...LEVELS, 'object'].map((l, i) => { const b = el('button', { textContent: `${l[0].toUpperCase()}${l.slice(1)} ${i + 1}`, title: l === 'object' ? 'Back to objects (4, Escape)' : `Edit ${many(l)} (${i + 1})`, onclick: () => (l === 'object' ? exit() : setLevel(l)) }); b.dataset.level = l; b.dataset.cmd2 = `mode.${l}`; return b; });
  const sticky = el('input', { type: 'checkbox', title: 'Select the same element of touching brushes too, so they stay together', onchange: () => setOpt('sticky', sticky.checked) });
  const pv = el('select', { title: 'Pivot for rotate and scale', onchange: () => { setOpt('pivot', pv.value); placeGizmo(); } }, el('option', { value: 'selection', textContent: 'Selection centre' }), el('option', { value: 'brush', textContent: 'Brush centre' }));
  const type = el('select', { title: 'Group: each patch along its mean normal. Local normal: every face along its own. By face: each face apart.', onchange: () => setOpt('extrudeType', type.value) },
    ...[['group', 'Group'], ['local', 'Local normal'], ['poly', 'By face']].map(([v, t]) => el('option', { value: v, textContent: t })));
  const ops = {
    vertex: [lab('Weld', num('weld', 'Weld distance')), btn('Weld', 'poly.weld'), btn('Collapse', 'poly.collapse'), lab('Chamfer', num('chamfer', 'Chamfer distance along each edge')), btn('Chamfer', 'poly.chamfer'),
      btn('Connect', 'poly.connect'), btn('Snap to grid', 'poly.snap'), btn('Remove', 'poly.remove'), btn('Slice', 'poly.slice')],
    edge: [lab('Chamfer', num('chamfer', 'Chamfer distance along both faces')), lab('segments', num('segments', 'Strips round the chamfer')), btn('Chamfer', 'poly.chamfer'), lab('Connect', num('connect', 'Edges between the selected edges')), btn('Connect', 'poly.connect'),
      btn('Remove', 'poly.remove'), btn('Collapse', 'poly.collapse'), btn('Split', 'poly.slice'), btn('Loop', 'poly.loop'), btn('Ring', 'poly.ring')],
    face: [lab('Extrude', num('extrude', 'Extrude height')), type, btn('Extrude', 'poly.extrude'), lab('Inset', num('inset', 'Inset amount')), btn('Inset', 'poly.inset'),
      lab('Bevel', num('bevelHeight', 'Bevel height')), lab('outline', num('bevelOutline', 'Outline: more than 0 grows the face, less shrinks it')), btn('Bevel', 'poly.bevel'),
      btn('Delete', 'poly.delete'), lab('Detach', num('detach', 'Slab thickness')), btn('Detach', 'poly.detach')],
  };
  const row2 = el('div', { className: 'ops' }), msg = el('div', { className: 'msg' });
  const div = el('div', { className: 'poly-panel', hidden: true },
    el('div', { className: 'ops' }, ...lv, el('label', { title: sticky.title }, sticky, ' Sticky'), el('label', { title: pv.title }, 'Pivot ', pv),
      btn('All', 'poly.selectAll'), btn('Grow', 'poly.grow'), btn('Shrink', 'poly.shrink')),
    row2, msg);
  host.append(div);
  const sync = () => {
    const p = opt();
    lv.forEach(b => b.classList.toggle('on', S.tool === ID && b.dataset.level === level));
    sticky.checked = !!p.sticky;
    pv.value = p.pivot;
    type.value = p.extrudeType;
    inputs.forEach(i => { if (document.activeElement !== i) i.value = p[i.dataset.key]; });
    if (row2.dataset.level !== level) { row2.dataset.level = level; row2.replaceChildren(...ops[level]); }
  };
  return Object.assign(div, { msg, sync });
}

// ---------- mount ----------
const want = l => () => S.tool === ID && (!l || level === l);
export function mount(el3d) {
  canvas = el3d.querySelector('canvas');
  boxEl = el3d.appendChild(el('div', { className: 'marquee', hidden: true }));
  panel = makePanel(slot('poly', 'Edit poly'));
  tc = new TransformControls(view3d.cam, canvas);
  tc.showE = tc.showXYZE = false;
  tc.setSize(+cfg.gizmoSize || 1);
  tc.addEventListener('change', view3d.invalidate);
  tc.addEventListener('mouseDown', gizmoStart);
  tc.addEventListener('objectChange', gizmoMove);
  tc.addEventListener('mouseUp', gizmoEnd);
  view3d.addHelper(proxy);
  view3d.addHelper(tc.getHelper());
  el3d.addEventListener('pointerdown', e => { tc.enabled = !e.altKey; }, true);
  addEventListener('pointerup', () => { tc.enabled = true; });
  view3d.registerTool(ID, tool3d);
  view2d.registerTool(ID, tool2d);
  view2d.registerOverlay(overlay);
  registerSection(details);
  // the picked elements are part of the selection in the undo history (state.js)
  setSelExtra({
    get: () => LEVELS.map(l => [...picked[l]].sort()),
    set: v => { LEVELS.forEach((l, i) => { picked[l] = new Set(v[i]); }); rebuild(); placeGizmo(); },
    same: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  });
  on('step', () => { topo.redo.length = 0; }); // a selection step: what was undone is gone, as after an edit
  on('doc', changed => {
    if (prev && !committing) clearPreview();
    if (S.history === 'edit' && !committing) newStep();
    if (S.tool !== ID) return;
    // redo of an edit that made pieces: they come back selected
    const h = hist.at(-1), redo = S.history === 'redo' && !committing;
    if (redo && h?.sel.some(s => !sel.has(s) && changed?.has?.(s)) && h.sel.every(s => cache.has(s)) && [...sel].every(s => h.sel.includes(s))) setSelection(h.sel);
    else rebuild();
    if (!redo) return;
    // redo: the elements selected after that edit again (the ones selected before may still be there)
    const p = picked[level], live = new Set(edit.flatMap(b => els(b).map(idOf)));
    const fits = x => x?.l === level && x.after.size && [...x.after].some(id => !p.has(id)) && [...x.after].every(id => live.has(id));
    const r = [hist.at(-1)].find(fits) ?? hist.findLast(x => fits(x) && x.before.size === p.size && [...p].every(id => x.before.has(id)));
    if (r) { picked[level] = new Set(r.after); rebuild(); }
  });
  on('selection', () => { if (S.tool === ID && !committing) rebuild(); });
  on('tool', () => {
    if (S.tool === ID && S.mode !== level) { if (LEVELS.includes(S.mode)) { level = S.mode; rebuild(); } else queueMicrotask(() => S.tool === ID && !LEVELS.includes(S.mode) && setTool('select')); }
    document.querySelectorAll('header [data-level]').forEach(b => b.classList.toggle('on', S.tool === ID && b.dataset.level === level));
    panel.sync();
  });
  on('cfg', ({ key }) => { if (key === 'gizmoSize') tc.setSize(+cfg.gizmoSize || 1); if (key === 'poly') panel.sync(); if (key === 'poly' || key === 'gizmoSpace') placeGizmo(); });
  on('gizmo', placeGizmo);
  on('file', () => { session.clear(); extra.clear(); hist.length = topo.undo.length = topo.redo.length = 0; LEVELS.forEach(l => picked[l].clear()); prev = null; });

  // undo and redo take the edit-mesh-only steps in their place among the map's (Max undoes an inset like anything else)
  register('undo', { title: 'Undo', keys: ['ctrl+z'], run: () => topoStep('undo') || undo() });
  register('redo', { title: 'Redo', keys: ['ctrl+y', 'ctrl+shift+z'], run: () => topoStep('redo') || redo() });
  const atLevel = l => () => S.tool === ID && level === l;
  register('mode.vertex', { title: 'Poly: edit vertices (again: objects)', keys: ['1'], run: () => toggleLevel('vertex'), on: atLevel('vertex') });
  register('mode.edge', { title: 'Poly: edit edges (again: objects)', keys: ['2'], run: () => toggleLevel('edge'), on: atLevel('edge') });
  register('mode.face', { title: 'Poly: edit faces (again: objects)', keys: ['3'], run: () => toggleLevel('face'), on: atLevel('face') });
  register('tool.vertex', { title: 'Tool: vertex edit (poly vertices, toggle)', keys: ['shift+v'], run: () => toggleLevel('vertex') });
  const ops = [
    ['poly.selectAll', 'Poly: select all', selectAll, ['ctrl+a'], want()],
    ['poly.grow', 'Poly: grow selection', grow, ['ctrl+pageup'], want()],
    ['poly.shrink', 'Poly: shrink selection', shrink, ['ctrl+pagedown'], want()],
    ['poly.loop', 'Poly: select edge loop', () => loopRing(P.loopOf), ['alt+l'], want()],
    ['poly.ring', 'Poly: select edge ring', () => loopRing(P.ringOf), ['alt+r'], want()],
    ['poly.sticky', 'Poly: sticky selection of touching brushes (toggle)', () => { setOpt('sticky', !opt().sticky); say(`sticky ${opt().sticky ? 'on' : 'off'}`); }, [], want()],
    ['poly.pivot', 'Poly: pivot selection centre / brush centre (toggle)', () => { setOpt('pivot', opt().pivot === 'brush' ? 'selection' : 'brush'); say(`pivot: ${opt().pivot} centre`); }, [], want()],
    ['poly.extrude', 'Poly: extrude faces', () => extrude(), ['shift+e'], want()],
    ['poly.inset', 'Poly: inset faces', inset, ['shift+i'], want()],
    ['poly.bevel', 'Poly: bevel faces (extrude and outline)', bevel, ['shift+b'], want()],
    ['poly.delete', 'Poly: delete faces (the neighbours close the brush)', deleteFaces, [], want()],
    ['poly.detach', 'Poly: detach faces to new brushes (slabs)', detach, [], want()],
    ['poly.slice', 'Poly: slice brushes through the selected vertices or edges (split along a loop)', slice, [], want()],
    ['poly.chamfer', 'Poly: chamfer edges or vertices', chamfer, ['shift+c'], want()],
    ['poly.connect', 'Poly: connect edges or vertices (split faces between them)', connect, ['ctrl+shift+e'], want()],
    ['poly.remove', 'Poly: remove vertices or edges (delete faces)', remove, ['backspace', 'delete'], want()],
    ['poly.collapse', 'Poly: collapse the selection to its centre', collapse, ['ctrl+alt+c'], want()],
    ['poly.weld', 'Poly: weld vertices within the weld distance', weld, [], want()],
    ['poly.snap', 'Poly: snap the selection to the grid', snap, [], want()],
  ];
  for (const [id, title, run, keys, when] of ops) register(id, { title, run, keys, when });
}
