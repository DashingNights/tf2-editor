// Polygon tool (tool.polygon): click points in a 2D view (on the grid); Enter or a double click builds one brush, the
// convex hull of the points extruded along the view's depth over the selection's depth (0 to 64 without one), in the
// current material. Backspace drops the last point, Escape all of them (again: back to Select). Clicks in another 2D
// view start over there.
import * as V from '../vmf.js';
import { on } from './bus.js';
import { S, selBox, addSolids, nextId, setTool, setCursor } from './state.js';
import { register } from './commands.js';
import { cfg } from './settings.js';
import * as view2d from './view2d.js';
import { prism } from './hullgeo.js';

const ID = 'polygon';
let pts = [], view = null, hover = null, ghost = null, last = null; // ghost: the brush it would build; last: the last press
const sn = x => { const g = cfg.snapGrid ? S.grid : 1; return Math.round(x / g) * g; };

// [lo, hi] along the depth axis of view v: the selection's, else 0 to 64.
function depth(v) {
  const k = 3 - v.ax[0] - v.ax[1], b = selBox();
  return b && b[1][k] > b[0][k] ? [b[0][k], b[1][k]] : [0, 64];
}
const solid = id => { const v = view2d.viewByName(view); return v && pts.length > 2 ? prism(pts, v.ax, ...depth(v), cfg.material, id) : null; };
function changed() { ghost = solid(() => '0'); view2d.invalidate(); }
function clear() { pts = []; hover = null; changed(); }

function build() {
  const s = solid(nextId);
  if (!s) return setCursor(pts.length < 3 ? 'polygon: click at least three points' : 'polygon: the points are in a line');
  clear();
  addSolids([s]);
  setCursor(`polygon: built a brush with ${s.children.filter(c => c.name === 'side').length} sides`);
}

function overlay(ctx, v, { toScreen, s2 }) {
  if (S.tool !== ID) return;
  ctx.strokeStyle = '#ffffff';
  ctx.setLineDash([4, 3]);
  if (ghost) for (const f of V.faces(ghost)) { ctx.beginPath(); f.pts.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](...toScreen(v, p))); ctx.closePath(); ctx.stroke(); }
  ctx.setLineDash([]);
  if (v.name !== view || !pts.length) return;
  const at = p => s2(v, ...p);
  ctx.strokeStyle = ctx.fillStyle = '#4fd0ff';
  ctx.beginPath();
  [...pts, ...(hover ? [hover] : [])].forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](...at(p)));
  ctx.stroke();
  for (const p of pts) { const [x, y] = at(p); ctx.fillRect(x - 3, y - 3, 6, 6); }
}

const tool2d = {
  down(v, e, w) {
    const t = performance.now(), dbl = last && t - last.t < 400 && Math.hypot(e.offsetX - last.x, e.offsetY - last.y) < 5;
    last = dbl ? null : { t, x: e.offsetX, y: e.offsetY };
    if (dbl) return build(), true;
    if (view !== v.name) { pts = []; view = v.name; }
    const p = w.map(sn);
    if (pts.at(-1)?.join() !== p.join()) pts.push(p);
    changed();
    return true;
  },
  move(v, e, w) {
    hover = v.name === view ? w.map(sn) : null;
    return true;
  },
  key(e) {
    if (e.ctrlKey || e.altKey) return false;
    if (e.key === 'Enter') build();
    else if (e.key === 'Backspace') { pts.pop(); changed(); }
    else if (e.key === 'Escape') { if (pts.length) clear(); else setTool('select'); }
    else return false;
    return true;
  },
};

export function mount() {
  view2d.registerTool(ID, tool2d);
  view2d.registerOverlay(overlay);
  on('tool', () => {
    if (S.tool === ID) setCursor('polygon: click points in a 2D view; Enter or double click builds, Backspace drops one, Escape cancels');
    else if (pts.length) clear();
  });
  on('selection', () => { if (S.tool === ID && pts.length) changed(); }); // the depth follows the selection
  register('tool.polygon', { title: 'Tool: polygon brush (click points in a 2D view, Enter builds)', run: () => setTool(ID), on: () => S.tool === ID });
}
