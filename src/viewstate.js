// The views as you left them: the 3D camera and each 2D view's centre and zoom are kept per map file (cfg.views, the
// 20 maps opened last) and come back when that map opens again, the editor restarted or not.
import { cfg, saveCfg } from './settings.js';
import { S } from './state.js';
import { on } from './bus.js';
import * as view3d from './view3d.js';
import * as view2d from './view2d.js';

const NAMES = ['top', 'front', 'side'], KEEP = 20, r3 = x => Math.round(x * 1000) / 1000;
export function current() {
  const f = view3d.flyView();
  return {
    cam: { pos: f.pos.map(r3), yaw: r3(f.yaw), pitch: r3(f.pitch) },
    v2: Object.fromEntries(NAMES.map(n => view2d.viewByName(n)).filter(Boolean).map(v => [v.name, { c: v.c.map(r3), z: v.z }])),
  };
}
// views: cfg.views; the map's entry goes last (the newest), the oldest past KEEP go.
export function remember(views, file, s) {
  const out = { ...views };
  delete out[file];
  out[file] = s;
  const ks = Object.keys(out);
  for (const k of ks.slice(0, Math.max(0, ks.length - KEEP))) delete out[k];
  return out;
}
let last = '';
function store() {
  if (!S.file) return;
  const s = current(), j = JSON.stringify(s);
  if (j === last) return;
  last = j;
  cfg.views = remember(cfg.views ?? {}, S.file, s);
  saveCfg();
}
function restore() {
  const s = S.file && cfg.views?.[S.file];
  if (!s) return;
  view3d.setFlyView(s.cam ?? {});
  for (const n of NAMES) { const v = view2d.viewByName(n), x = s.v2?.[n]; if (v && x?.c?.length === 2 && x.z > 0) { v.c = [...x.c]; v.z = x.z; } }
  view2d.invalidate();
  last = JSON.stringify(current());
}
// After view3d and view2d: their own load handlers frame the map first, this puts the saved views over them.
export function mount() {
  on('file', d => { if (d.op === 'load') restore(); });
  setInterval(store, 2000);
  addEventListener('beforeunload', store);
}
