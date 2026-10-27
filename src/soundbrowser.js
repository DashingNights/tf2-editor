// Sounds panel: folder tree, search and a virtualised list of every .wav / .mp3 under sound/ (models.js listSounds).
// The button plays or stops a sound; clicking a name sets the 'message' of the selected ambient_generic entities (one
// undo step) or, with none selected, copies the path. Names are what ambient_generic takes ('ambient/x.wav').
import * as V from '../vmf.js';
import { on } from './bus.js';
import { sel, cache, edit, setCursor } from './state.js';
import { register } from './commands.js';
import { search, buildTree } from './texbrowser.js';
import { listSounds, readAsset } from './models.js';
import { renderTree, treeClick } from './modelbrowser.js';
import { registerPanel, show, pane } from './layout.js';
import { el } from './dom.js';

registerPanel({ id: 'sounds', title: 'Sounds', near: 'models' });

const ROW = 22;
let host, q, treeEl, list, sizer, empty, foot;
let names = [], view = [], root = null, folder = '', loading = false;
const opened = new Set(), shown = new Map();

// ---------- playback ----------
// One sound at a time through Web Audio: the page's CSP (default-src 'self') blocks blob: URLs for <audio>.
export const player = { name: null, source: null, ctx: null };
export function stop() {
  const src = player.source;
  player.source = player.name = null;
  if (src) { src.onended = null; src.stop(); }
  mark();
}
export async function play(name) {
  stop();
  player.name = name; // the button shows stop while the file loads
  mark();
  const bytes = await readAsset(`sound/${name}`);
  const ctx = (player.ctx ??= new AudioContext());
  const buf = bytes && (await ctx.decodeAudioData(bytes.slice().buffer).catch(e => (setCursor(`${name}: cannot play (${e.message})`), null)));
  if (player.name !== name) return; // stopped, or another sound started meanwhile
  if (!buf) { if (!bytes) setCursor(`${name}: not found in the game files`); return stop(); }
  const src = (player.source = ctx.createBufferSource());
  src.buffer = buf;
  src.connect(ctx.destination);
  src.onended = () => player.source === src && stop();
  src.start();
}
const mark = () => shown.forEach(r => r.classList.toggle('on', r.dataset.n === player.name));

// ---------- document ----------
const ambients = () => [...sel].filter(n => cache.get(n)?.point && V.get(n, 'classname') === 'ambient_generic');
export function choose(name) {
  const ents = ambients(), ch = ents.filter(e => V.get(e, 'message') !== name);
  if (ch.length) edit([], ch, () => ch.forEach(e => V.set(e, 'message', name)));
  if (ents.length) return setCursor(`${name}: sound of ${ents.length} ambient_generic`);
  navigator.clipboard.writeText(name).catch(() => {});
  setCursor(`${name} copied (select ambient_generic entities to set their sound)`);
}

// ---------- panel ----------
function refilter() {
  const inFolder = folder ? names.filter(n => n.startsWith(folder)) : names, s = q.value.trim().toLowerCase();
  view = s ? search(s, inFolder) : inFolder;
  foot.textContent = loading ? 'Loading sounds...' : !names.length ? 'No sounds: set the TF2 folder in Settings (Ctrl+,)' : `${view.length} of ${names.length}`;
  empty.hidden = loading || !names.length || view.length > 0;
  empty.textContent = s ? `No sounds match "${s}"` : 'No sounds here';
  list.scrollTop = 0;
  shown.forEach(r => r.remove());
  shown.clear();
  draw();
}

function draw() {
  sizer.style.height = `${view.length * ROW}px`;
  const lo = Math.max(0, Math.floor(list.scrollTop / ROW) - 2), hi = Math.min(view.length, Math.ceil((list.scrollTop + list.clientHeight) / ROW) + 2);
  for (const [i, r] of shown) if (i < lo || i >= hi) { r.remove(); shown.delete(i); }
  for (let i = lo; i < hi; i++) if (!shown.has(i)) shown.set(i, sizer.appendChild(row(i)));
}
function row(i) {
  const n = view[i], r = el('div', { className: `sb-row${n === player.name ? ' on' : ''}`, title: n },
    el('button', { className: 'sb-play', title: 'Play / stop' }), el('span', { textContent: n }));
  r.dataset.n = n;
  r.style.top = `${i * ROW}px`;
  return r;
}

export function browse(name = '') {
  show('sounds');
  q.value = name;
  folder = '';
  refilter();
  q.focus();
}

async function load() {
  loading = true;
  refilter();
  names = await listSounds().catch(e => (console.warn(e), []));
  loading = false;
  root = buildTree(names);
  renderTree(treeEl, root, folder, opened);
  refilter();
}

const HTML = `
<div class="mb-bar"><input class="sb-q" type="search" placeholder="Search sounds" spellcheck="false" title="Words match anywhere in the path; Enter plays the first"></div>
<div class="mb-main"><div class="mb-tree"></div><div class="sb-list"><div class="sb-sizer"></div><div class="mb-empty" hidden></div></div></div>
<div class="mb-foot"></div>`;

export function mount() {
  host = pane('sounds');
  host.classList.add('mb');
  host.innerHTML = HTML;
  [q, treeEl, list, sizer, empty, foot] = ['.sb-q', '.mb-tree', '.sb-list', '.sb-sizer', '.mb-empty', '.mb-foot'].map(s => host.querySelector(s));
  let t = 0;
  q.oninput = () => { clearTimeout(t); t = setTimeout(refilter, 60); };
  q.onkeydown = e => {
    if (e.key === 'Enter' && view.length) play(view[0]);
    else if (e.key === 'Escape' && q.value) { q.value = ''; refilter(); }
    else if (e.key === 'Escape') q.blur();
    else return;
    e.preventDefault();
  };
  treeEl.onclick = treeEl.ondblclick = e => {
    treeClick(e, opened, p => { if (folder !== p) { folder = p; refilter(); } });
    renderTree(treeEl, root, folder, opened);
  };
  list.onscroll = draw;
  new ResizeObserver(draw).observe(list);
  list.onclick = e => {
    const n = e.target.closest('.sb-row')?.dataset.n;
    if (!n) return;
    if (e.target.closest('.sb-play')) player.name === n ? stop() : play(n);
    else choose(n);
  };
  on('cfg', ({ key }) => key === 'tf2' && (stop(), load()));
  register('sounds.show', { title: 'Sounds: show browser', run: () => show('sounds') });
  register('sounds.stop', { title: 'Sounds: stop playing', run: stop });
  load();
}
