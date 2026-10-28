// Portal file viewer (Hammer's Load Portal File): map.loadPortals reads the <map>.prt vbsp writes next to the open map
// and draws every vis portal's outline in the 3D view and the 2D views; map.clearPortals (and loading a map) drops them.
import * as THREE from 'three';
import { on } from './bus.js';
import { S, setCursor } from './state.js';
import { register } from './commands.js';
import { addHelper, removeHelper } from './view3d.js';
import { registerOverlay, invalidate as redraw2d } from './view2d.js';

// PRT1 text -> { leafs, portals: [[[x, y, z], ...], ...] }, or null when it is not PRT1. vbsp writes 'PRT1', the
// cluster and portal counts, then a line per portal: '<points> <leaf> <leaf> (x y z ) (x y z ) ...'. Lines that are not
// a whole portal are skipped.
export function parsePrt(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== 'PRT1') return null;
  const portals = [];
  for (const l of lines.slice(3)) {
    const m = l.match(/^\s*(\d+)\s+-?\d+\s+-?\d+\s*\(/), pts = [...l.matchAll(/\(([^)]*)\)/g)].map(x => x[1].trim().split(/\s+/).map(Number));
    if (m && pts.length >= 3 && pts.length === +m[1] && pts.every(p => p.length === 3 && p.every(Number.isFinite))) portals.push(pts);
  }
  return { leafs: parseInt(lines[1]) || 0, portals };
}

// Every portal's edges as line segment end points, flat.
export const edges = portals => portals.flatMap(p => p.flatMap((q, i) => [...q, ...p[(i + 1) % p.length]]));

const COLOR = 0x4da6ff;
const lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: COLOR, transparent: true, opacity: 0.8 }));
let portals = null; // the loaded portals, or null
const paths = new Map(); // 2D view name -> Path2D of the outlines in world units on its axes

function show(list) {
  if (!list && !portals) return;
  portals = list;
  paths.clear();
  lines.geometry.dispose();
  lines.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(list ? edges(list) : [], 3));
  if (list) addHelper(lines); else removeHelper(lines);
  redraw2d();
}

async function load() {
  if (!S.file) return setCursor('portals: save the map first (vbsp writes <map>.prt next to it)');
  const f = S.file.replace(/\.vmf$/i, '') + '.prt', text = await window.api.read(f), r = text && parsePrt(text);
  if (!r) return setCursor(text ? `portals: ${f} is not a PRT1 file` : `portals: no ${f} (compile the map with VBSP first)`);
  show(r.portals);
  setCursor(`portals: ${r.portals.length} portals between ${r.leafs} leafs (${f.split(/[\\/]/).pop()})`);
}

// 2D: the outlines through the view's world -> screen transform, so a frame only strokes the cached path.
function overlay(ctx, v) {
  if (!portals) return;
  let p = paths.get(v.name);
  if (!p) {
    const [a, b] = v.ax;
    p = new Path2D();
    for (const q of portals) {
      q.forEach((pt, i) => (i ? p.lineTo(pt[a], pt[b]) : p.moveTo(pt[a], pt[b])));
      p.closePath();
    }
    paths.set(v.name, p);
  }
  ctx.transform(v.z, 0, 0, -v.z, v.w / 2 - v.c[0] * v.z, v.h / 2 + v.c[1] * v.z);
  ctx.lineWidth = 1 / v.z;
  ctx.strokeStyle = 'rgba(77, 166, 255, 0.7)';
  ctx.stroke(p);
}

export function mount() {
  registerOverlay(overlay);
  on('file', d => { if (d.op === 'load') show(null); });
  register('map.loadPortals', { title: 'Map: load portal file (<map>.prt from VBSP, vis portals in 3D and 2D)', run: load });
  register('map.clearPortals', { title: 'Map: clear portal file', when: () => !!portals, run: () => { show(null); setCursor('portals cleared'); } });
}
