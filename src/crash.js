// Crash recovery. An uncaught error or rejected promise in the page writes an emergency autosave of a map with unsaved
// changes (<map>.vmf.autosave, the file the timed autosave writes, or untitled.autosave.vmf in the settings folder), at
// most every 30 s. main.js names that file when the page itself dies. At start an autosave newer than its map is
// offered back; an untitled one is offered once (then kept as untitled.autosave.old.vmf).
import * as V from '../vmf.js';
import { on } from './bus.js';
import { S, doc, change, load, nextId, serialize, setCursor, confirmDiscard } from './state.js';
import { register } from './commands.js';
import { ask, notice } from './dialog.js';

const api = window.api;
export const untitled = () => api.settingsPath.replace(/[\\/][^\\/]*$/, '') + '\\untitled.autosave.vmf';
const where = () => (S.file ? S.file + '.autosave' : untitled());
const when = ms => new Date(ms).toLocaleString();

let last = -Infinity;
function emergency() {
  if (!doc.root || !S.dirty || Date.now() - last < 30000) return;
  last = Date.now();
  const p = where();
  let text;
  try { text = serialize(); } catch (e) { return console.error('emergency autosave failed', e); } // the document itself is broken
  api.write(p, text).then(() => setCursor(`An error occurred: the unsaved changes were written to ${p}`), e => console.error('emergency autosave failed', e));
}

// The autosave in place of the open map as one undo step: Ctrl+Z gives back the map as saved, Ctrl+S saves the
// recovered one over it. The map's sidecar (visgroups shown, the Figma base) stays as open() read it. False when the
// text holds no map.
export function recover(text) {
  const r = V.parse(text ?? ''), w = V.kids(r, 'world')[0];
  if (!w) return false;
  change(take => {
    take(doc.root, false);
    take(doc.world, false);
    [doc.world.kv, doc.world.children] = [w.kv, w.children];
    doc.root.children = r.children.map(c => (c === w ? doc.world : c));
  });
  // state.js keeps its id counter to itself: draw ids until it passes the recovered map's highest (the ids added since
  // the map was saved, so few; a million at most, past that Check for problems renumbers duplicates)
  let top = 0;
  (function scan(n) { for (const [k, v] of n.kv) if (k === 'id') top = Math.max(top, +v || 0); n.children.forEach(scan); })(r);
  for (let i = 0; i < 1e6 && +nextId() < top; i++);
  return true;
}

// Offers file's autosave: at start only when it is newer than the map (any: always, the command).
async function offerMap(file, any) {
  const [m, a] = await Promise.all([api.stat(file), api.stat(file + '.autosave')]);
  if (!a || (!any && !(m && a.mtimeMs > m.mtimeMs))) return any && notice(`${file}.autosave does not exist.`);
  const name = file.split(/[\\/]/).pop(), age = m && a.mtimeMs <= m.mtimeMs ? 'older' : 'newer';
  if ((await ask(`${name} has an autosave from ${when(a.mtimeMs)}, ${age} than the map: changes that were not saved. Recover it? Undo gives back the map as saved.`, ['Recover', 'Ignore'])) !== 0) return;
  if (recover(await api.read(file + '.autosave'))) setCursor(`Recovered ${name}.autosave: Ctrl+S saves it over the map, Ctrl+Z gives back the map as saved`);
  else notice(`${file}.autosave holds no map.`);
}

// At start, after the first map has loaded.
async function offer(file) {
  if (file) await offerMap(file);
  const u = untitled(), st = await api.stat(u);
  if (!st) return;
  const text = await api.read(u);
  await api.rename(u, u.replace(/\.vmf$/, '.old.vmf')).catch(e => console.error(e));
  if ((await ask(`An untitled map from ${when(st.mtimeMs)} was not saved. Open it? It is kept as untitled.autosave.old.vmf in the settings folder.`, ['Open', 'Ignore'])) !== 0 || !(await confirmDiscard())) return;
  load(text, null);
  S.dirty = true;
  setCursor('Recovered the untitled map: Ctrl+S saves it');
}

export function mount() {
  addEventListener('error', emergency);
  addEventListener('unhandledrejection', emergency);
  const tell = () => api.setAutosave?.(where());
  let first = true;
  on('file', d => {
    tell();
    if (d.op === 'load' && first) { first = false; offer(d.file); }
  });
  tell();
  register('file.recoverAutosave', { title: 'File: recover the autosave of this map (<map>.vmf.autosave)', run: () => (S.file ? offerMap(S.file, true) : notice('Untitled maps have no autosave of their own: untitled.autosave.vmf is offered at start.')) });
}
