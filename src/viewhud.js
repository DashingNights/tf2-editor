// The editing state in every viewport's top right corner, as small labels: the edit level or tool, the gizmo (3D view),
// the snapping, blockout and mirror when they are on, and the selection count. Display only (no pointer events).
import { S, sel } from './state.js';
import { cfg } from './settings.js';
import { on } from './bus.js';
import { el } from './dom.js';

const TOOLS = { select: 'Object', block: 'Block', entity: 'Entity', clip: 'Clip', stairs: 'Stairs / ramp', chamfer: 'Chamfer', roof: 'Roof', cordon: 'Cordon' };
const GIZMO = { translate: 'Move', rotate: 'Rotate', scale: 'Scale' };
const cap = s => s[0].toUpperCase() + s.slice(1);

// [text, class] labels for a view (gizmo only in 3D). mirror: whether live mirror is on.
export function labels(is3d, mirror = false) {
  const out = [[S.tool === 'poly' ? cap(S.mode) : TOOLS[S.tool] ?? cap(S.tool ?? 'select'), 'mode']];
  if (is3d) out.push([S.gizmo ? `${GIZMO[S.gizmo]} ${cfg.gizmoSpace === 'local' ? 'local' : 'world'}` : 'No gizmo', '']);
  out.push([cfg.snapGrid ? `Grid ${S.grid}` : 'Grid off', 'snap']);
  for (const k of ['Vertex', 'Edge', 'Intersection', 'Face']) if (cfg['snap' + k]) out.push([`${k} snap`, 'snap']);
  if (cfg.blockout) out.push(['Blockout', 'on']);
  if (mirror) out.push(['Mirror', 'on']);
  if (sel.size) out.push([`${sel.size} selected`, '']);
  return out;
}

let huds = [], mirrorOn = () => false;
function render() {
  for (const [h, is3d] of huds) h.replaceChildren(...labels(is3d, mirrorOn()).map(([t, c]) => el('span', { className: c, textContent: t })));
}
let queued = false;
const later = () => { if (!queued) { queued = true; queueMicrotask(() => { queued = false; render(); }); } };

// mirror: () => live mirror on (mirror.js), passed in so this module stays small.
export function mount(mirror) {
  if (mirror) mirrorOn = mirror;
  for (const id of ['v-3d', 'v-top', 'v-front', 'v-side']) {
    const v = document.getElementById(id);
    if (v) huds.push([v.appendChild(el('div', { className: 'vhud' })), id === 'v-3d']);
  }
  for (const t of ['tool', 'cfg', 'grid', 'gizmo', 'selection', 'file', 'mirror', 'cmd']) on(t, later);
  render();
}
