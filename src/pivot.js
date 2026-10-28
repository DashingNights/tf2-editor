// Hammer++'s movable pivot: pivot.place (Ctrl+P), then a click in a 2D view puts the rotate and scale pivot there
// (state setPivot; selPivot returns it, so the gizmo turns about it) until the selection changes or Escape
// (pivot.clear). The other coordinate stays the pivot's. Drawn as a yellow cross in the 3D and 2D views.
import * as THREE from 'three';
import { on } from './bus.js';
import { S, sel, selPivot, setPivot, setTool, setCursor } from './state.js';
import { register } from './commands.js';
import { cfg } from './settings.js';
import * as view3d from './view3d.js';
import * as view2d from './view2d.js';

const ID = 'pivot';
const sn = x => { const g = cfg.snapGrid ? S.grid : 1; return Math.round(x / g) * g; };
const cross3 = new THREE.LineSegments(
  new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, -1, 0, 0, 1].map(x => x * 24), 3)),
  new THREE.LineBasicMaterial({ color: 0xffd040, depthTest: false }));
cross3.renderOrder = 3;
cross3.visible = false;

// The cross follows S.pivot (a move takes it along, a new selection drops it).
function show() {
  cross3.visible = !!S.pivot;
  if (S.pivot) cross3.position.set(...S.pivot);
  view3d.invalidate();
  view2d.invalidate();
}

function overlay(ctx, v, { toScreen }) {
  if (!S.pivot) return;
  const [x, y] = toScreen(v, S.pivot);
  ctx.strokeStyle = '#ffd040';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x - 8, y); ctx.lineTo(x + 8, y);
  ctx.moveTo(x, y - 8); ctx.lineTo(x, y + 8);
  ctx.stroke();
  ctx.strokeRect(x - 3, y - 3, 6, 6);
}

let back = 'select'; // the tool to go back to after the click
const tool2d = {
  down(v, e, w) {
    const p = selPivot();
    if (p) {
      v.ax.forEach((k, i) => { p[k] = sn(w[i]); });
      setPivot(p);
      setCursor(`pivot at ${p.map(x => +x.toFixed(3)).join(' ')} (Escape: back to the centre)`);
    }
    setTool(back);
    return true;
  },
  key(e) {
    if (e.key !== 'Escape') return false;
    setTool(back);
    setCursor('pivot: not moved');
    return true;
  },
};

function place() {
  if (S.tool !== ID) back = S.tool;
  setTool(ID);
  setCursor('pivot: click in a 2D view to put it there (Escape cancels)');
}

export function mount() {
  view3d.addHelper(cross3);
  view2d.registerTool(ID, tool2d);
  view2d.registerOverlay(overlay);
  for (const t of ['selection', 'doc', 'gizmo', 'file']) on(t, show);
  const any = () => sel.size > 0;
  register('pivot.place', { title: 'Pivot: place (then click in a 2D view)', keys: ['ctrl+p'], when: any, run: place, on: () => S.tool === ID });
  register('pivot.clear', { title: 'Pivot: back to the selection centre', keys: ['escape'], when: () => !!S.pivot, run: () => { setPivot(null); setCursor('pivot: back to the selection centre'); } });
}
