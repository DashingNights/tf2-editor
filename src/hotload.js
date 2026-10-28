// Asset hotload: main.js watches the TF2 folder's tf\custom, tf\materials and tf\models and sends the files that
// changed; the materials and models made from them load again (materials.forget(name), models.forget(path)).
// assets.reload reloads every asset, as a new TF2 folder does.
import { on } from './bus.js';
import { cfg, setCfg } from './settings.js';
import { register } from './commands.js';
import { setCursor } from './state.js';

const api = window.api;

// A changed file under tf\ (tf\custom\<mod>\ counts as tf\) -> { material: 'foo/bar' } for a .vmt or .vtf (a texture
// goes by its own name), { model: 'models/x/y.mdl' } for a model's .mdl, .vvd, .vtx or .phy, else null.
export function assetOf(p) {
  const k = String(p).replace(/\\/g, '/').toLowerCase().match(/\/tf\/(?:custom\/[^/]+\/)?((?:materials|models)\/.+)$/)?.[1] ?? '';
  if (/^materials\/.+\.(vmt|vtf)$/.test(k)) return { material: k.slice(10, -4) };
  const m = k.match(/^(models\/.+?)(\.(dx80|dx90|sw|xbox))?\.(mdl|vvd|vtx|phy)$/);
  return m ? { model: m[1] + '.mdl' } : null;
}

// Each changed asset once. forget comes from materials.js and models.js when they have it.
async function changed(paths) {
  const [M, Mo] = await Promise.all([import('./materials.js'), import('./models.js')]);
  let n = 0;
  for (const a of new Map(paths.map(assetOf).filter(Boolean).map(a => [a.material ?? a.model, a])).values()) {
    const forget = a.material ? M.forget : Mo.forget;
    if (forget) { forget(a.material ?? a.model); n++; }
  }
  if (n) setCursor(`Hotload: ${n} changed material(s) and model(s) reloaded`);
}

export function mount() {
  const watch = () => api.watchAssets?.(cfg.tf2 || '');
  api.onAssetsChanged?.(ps => changed(ps).catch(e => console.error('hotload', e)));
  on('cfg', ({ key }) => key === 'tf2' && watch());
  watch();
  // every module reloads its assets when the TF2 folder is set, also to the same folder
  register('assets.reload', { title: 'Assets: reload every material and model (after changing game files)', run: () => setCfg('tf2', cfg.tf2) });
}
