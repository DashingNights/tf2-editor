// Hammer's clipping tool (Shift+X): a line dragged in a 2D view (grid points) defines a plane perpendicular to that
// view; in 3D two surface clicks do, the plane standing on the first surface. The cut previews in every view (kept
// pieces white, dropped ones grey). X or Shift+X cycles keep both / front / back, Enter clips the selected brushes the
// plane crosses as one edit, Escape cancels (a second Escape leaves the tool). The 2D line ends can be dragged.
import * as THREE from 'three';
import * as V from '../vmf.js';
import { on } from './bus.js';
import { S, sel, cache, edit, nextId, selBox, setSelection, setTool, setCursor, sideUsers } from './state.js';
import { register } from './commands.js';
import { cfg } from './settings.js';
import * as view3d from './view3d.js';
import * as view2d from './view2d.js';
import { snapOnSurface } from './aids.js';

const ID = 'clip', MODES = ['both pieces', 'the front piece', 'the back piece'];
const step = () => (cfg.snapGrid === false ? 1 : S.grid);
const sn = x => Math.round(x / step()) * step();
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a, b) => a.map((x, k) => x - b[k]);

// line: { a, b, up }, the plane holds a, b and a + up. waiting: 3D, a is placed and b follows the hover.
// cuts: the selected solids the plane crosses, { s, ps: [front, back], fs: their faces }. drag: a 2D line end.
let line = null, waiting = false, mode = 0, cuts = [], drag = null;
const keeps = i => mode === 0 || mode === i + 1;

// The 3 plane points (vmf.js clip), or null without a plane.
function points() {
  if (!line?.b) return null;
  const { a, b, up } = line;
  return Math.hypot(...cross(sub(b, a), up)) > 1e-6 ? [a, b, a.map((x, k) => x + up[k] * 64)] : null;
}

function update() {
  const q = S.tool === ID && points();
  cuts = !q ? [] : [...sel].filter(n => n.name === 'solid' && cache.get(n)?.visible)
    .map(s => ({ s, ps: V.clip(s, q, () => '0') })).filter(c => c.ps[0] && c.ps[1]).map(c => ({ ...c, fs: c.ps.map(V.faces) }));
  redraw();
}

function cycle() {
  mode = (mode + 1) % 3;
  setCursor(`clip: keep ${MODES[mode]}`);
  redraw();
}

function cancel() {
  line = null;
  waiting = false;
  drag = null;
  update();
}

// True when the plane through q cuts a displaced face of solid s (vmf.js clip removes that displacement).
function cutsDisp(s, q) {
  const n = cross(sub(q[0], q[1]), sub(q[2], q[1])), l = Math.hypot(...n), at = p => n.reduce((a, x, k) => a + x * (p[k] - q[0][k]), 0) / l;
  return cache.get(s).faces.some(f => V.kids(f.side, 'dispinfo').length && Math.max(...f.pts.map(at)) > 0.01 && Math.min(...f.pts.map(at)) < -0.01);
}

function apply() {
  const q = points();
  if (!q || !cuts.length) return setCursor('clip: the plane crosses no selected brush');
  const ids = new Map(), out = cuts.map(({ s }) => [s, V.clip(s, q, nextId, ids).filter((p, i) => p && keeps(i))]);
  const owners = [...new Set(out.map(([s]) => cache.get(s).owner))], rest = [...sel].filter(n => !out.some(([s]) => s === n));
  const users = sideUsers(ids, out.flatMap(x => x[1])), lost = cuts.some(c => cutsDisp(c.s, q));
  edit([], [...owners, ...users], () => {
    out.forEach(([s, ps]) => { const l = cache.get(s).owner.children; l.splice(l.indexOf(s), 1, ...ps); });
    users.forEach(e => V.remapSides(e, ids));
  });
  setSelection([...rest, ...out.flatMap(x => x[1])]);
  setCursor(`clip: cut ${out.length} brush(es), kept ${MODES[mode]}${lost ? '; cut displacements were removed (Hammer keeps only uncut ones)' : ''}`);
  cancel();
}

// ---------- drawing ----------
const lmat = (color, opacity = 1) => new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, depthTest: false });
const keepL = new THREE.LineSegments(new THREE.BufferGeometry(), lmat(0xffffff)), dropL = new THREE.LineSegments(new THREE.BufferGeometry(), lmat(0x8a90a0));
const abL = new THREE.LineSegments(new THREE.BufferGeometry(), lmat(0x4fd0ff));
const ends = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0x4fd0ff, size: 7, sizeAttenuation: false, depthTest: false }));
const sheet = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x4fd0ff, transparent: true, opacity: 0.15, side: THREE.DoubleSide, depthWrite: false }));
const group = new THREE.Group().add(sheet, dropL, keepL, abL, ends);
group.traverse(o => { o.renderOrder = 3; o.frustumCulled = false; });
function setPts(o, pts) {
  o.geometry.dispose();
  o.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts.flat(), 3));
}
const segs = fs => fs.flatMap(f => f.pts.flatMap((p, i) => [p, f.pts[(i + 1) % f.pts.length]]));
const pieces = keep => cuts.flatMap(c => c.fs.filter((_, i) => keeps(i) === keep).flat());

function redraw() {
  const q = S.tool === ID && points(), ab = line?.b ? [line.a, line.b] : line ? [line.a] : [];
  setPts(keepL, segs(pieces(true)));
  setPts(dropL, segs(pieces(false)));
  setPts(abL, ab.length === 2 ? ab : []);
  setPts(ends, ab);
  sheet.visible = !!q;
  if (q) {
    // A square on the plane around the selection centre (projected onto the plane), large enough to cover it.
    const n = new THREE.Vector3(...cross(sub(q[0], q[1]), sub(q[2], q[1]))).normalize(), box = selBox() ?? [line.a, line.b];
    const c = new THREE.Vector3(...box[0].map((x, k) => (x + box[1][k]) / 2)), size = 2 * Math.max(256, c.distanceTo(new THREE.Vector3(...box[1])) * 2, Math.hypot(...sub(line.b, line.a)));
    c.addScaledVector(n, n.dot(new THREE.Vector3(...q[0])) - n.dot(c));
    sheet.position.copy(c);
    sheet.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    sheet.scale.set(size, size, 1);
  }
  view3d.invalidate();
  view2d.invalidate();
}

function overlay(ctx, v, { toScreen }) {
  if (S.tool !== ID || !line) return;
  const poly = (fs, color, dash) => {
    ctx.strokeStyle = color;
    ctx.setLineDash(dash);
    ctx.beginPath();
    for (const f of fs) { f.pts.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](...toScreen(v, p))); ctx.closePath(); }
    ctx.stroke();
  };
  poly(pieces(false), '#8a90a0', [4, 3]);
  poly(pieces(true), '#ffffff', []);
  ctx.setLineDash([]);
  ctx.strokeStyle = ctx.fillStyle = '#4fd0ff';
  ctx.lineWidth = 1.5;
  const [a, b] = [line.a, line.b ?? line.a].map(p => toScreen(v, p));
  ctx.beginPath();
  ctx.moveTo(...a);
  ctx.lineTo(...b);
  ctx.stroke();
  for (const [x, y] of [a, b]) ctx.fillRect(x - 3, y - 3, 6, 6);
}

// ---------- tools ----------
const surface = hit => hit?.face && snapOnSurface(hit.point.toArray(), hit.face.n, step());

const tool3d = {
  activate() {
    mode = 0;
    view3d.addHelper(group);
    cancel();
    setCursor('clip tool: drag a line in a 2D view or click two points in 3D; X keeps both/front/back, Enter clips, Escape cancels');
  },
  deactivate() { view3d.removeHelper(group); cancel(); },
  down(e, hit) {
    if (e.altKey) return false;
    const p = surface(hit);
    if (!p) return true;
    if (!waiting) { line = { a: p, b: null, up: hit.face.n }; waiting = true; }
    else {
      line.b = p;
      waiting = false;
      if (!points()) { line = null; setCursor('clip: click two different points'); }
    }
    update();
    return true;
  },
  move(e, hit) {
    const p = waiting && surface(hit);
    if (p && line.b?.join() !== p.join()) { line.b = p; update(); }
    return false;
  },
  key(e) {
    if (e.ctrlKey || e.altKey) return false;
    if (e.key === 'x' || (e.key === 'X' && !e.shiftKey)) cycle();
    else if (e.key === 'Enter') apply();
    else if (e.key === 'Escape') { if (line) cancel(); else setTool('select'); }
    else return false;
    return true;
  },
};

const tool2d = {
  down(v, e, w) {
    const end = line?.b && ['a', 'b'].find(k => Math.hypot(...sub(view2d.toScreen(v, line[k]), [e.offsetX, e.offsetY])) < 7);
    if (end) { drag = { end }; return true; }
    // A new line: its points sit at the selection's depth centre, the plane runs along the view's depth axis.
    const dep = 3 - v.ax[0] - v.ax[1], box = selBox(), p = [0, 0, 0], up = [0, 0, 0];
    p[dep] = box ? (box[0][dep] + box[1][dep]) / 2 : 0;
    up[dep] = 1;
    v.ax.forEach((k, i) => { p[k] = sn(w[i]); });
    line = { a: p, b: [...p], up };
    waiting = false;
    drag = { end: 'b' };
    update();
    return true;
  },
  move(v, e, w) {
    if (!drag) return false;
    const p = [...line[drag.end]];
    v.ax.forEach((k, i) => { p[k] = sn(w[i]); });
    if (p.join() !== line[drag.end].join()) { line[drag.end] = p; update(); }
    return true;
  },
  up() {
    if (!drag) return false;
    drag = null;
    if (!points()) line = null;
    update();
    return true;
  },
};

export function mount() {
  view3d.registerTool(ID, tool3d);
  view2d.registerTool(ID, tool2d);
  view2d.registerOverlay(overlay);
  for (const t of ['doc', 'selection']) on(t, () => { if (S.tool === ID) update(); });
  register('tool.clip', { title: 'Tool: clipping (again: cycle kept pieces)', keys: ['shift+x'], run: () => (S.tool === ID ? cycle() : setTool(ID)), on: () => S.tool === ID });
}
