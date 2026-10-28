// Decal and overlay tools (Hammer's): a click on a brush face in the 3D view places an infodecal of the current
// material (Details: New objects) at the point (tool.decal, Shift+D), or an info_overlay on that face the size of the
// texture, scaled down to fit the face (tool.overlay, Shift+O). One undo step each; the new entity is selected.
import * as V from '../vmf.js';
import { S, doc, edit, nextId, setSelection, setTool, setCursor } from './state.js';
import { registerTool } from './view3d.js';
import { register } from './commands.js';
import { cfg } from './settings.js';
import { overlay } from './import.js';
import { textureSize } from './materials.js';

// An infodecal of material m at point p (vbsp projects it onto the nearest face). Keys in Hammer's order.
export function decal(p, m, next) {
  const e = V.entity('infodecal', p, next), [id, cls, origin] = e.kv;
  e.kv = [id, cls, ['texture', m], origin];
  return e;
}

// e after the last world or entity block (where image import puts overlays), selected.
function add(e) {
  const r = doc.root;
  edit([], [r], () => r.children.splice(r.children.findLastIndex(c => c.name === 'entity' || c.name === 'world') + 1, 0, e));
  setSelection([e]);
}

const tool = kind => ({
  activate: () => setCursor(`${kind}: click a brush face to place ${cfg.material}; Esc: select tool`),
  down(e, hit) {
    if (!hit?.face || hit.node?.name !== 'solid') return false; // brush faces only, not entity boxes
    const m = cfg.material, p = hit.point.toArray();
    if (kind === 'decal') add(decal(p, m, nextId));
    else textureSize(m).then(sz => add(overlay(hit.face, p, sz?.w ?? 128, sz?.h ?? 128, m, nextId)));
    return true;
  },
  key(e) {
    if (e.key !== 'Escape') return false;
    setTool('select');
    return true;
  },
});

const TOOLS = [
  ['tool.decal', 'decal', 'shift+d', 'infodecal'],
  ['tool.overlay', 'overlay', 'shift+o', 'info_overlay'],
];
export function mount() {
  for (const [id, kind, key, what] of TOOLS) {
    registerTool(kind, tool(kind));
    register(id, { title: `Tool: ${kind} (click a face: ${what} of the current material)`, keys: [key], run: () => setTool(S.tool === kind ? 'select' : kind), on: () => S.tool === kind });
  }
}
