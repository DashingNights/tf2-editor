// Texture browser panel (#textures): search, filter, folder tree and a virtualised thumbnail grid over every material
// (materials.js listMaterials). Click picks the current material (cfg.material), double-click applies it to the
// selection, a tile dragged onto the 3D view applies it to a face (Shift: the brush), right-click for the rest.
// Also find and replace, and select by material. Names here are clean lower-case paths; the VMF gets upper case.
import * as V from '../vmf.js';
import { on } from './bus.js';
import { S, sel, faceSel, cache, edit, mergeUndo, setSelection, setFaceSelection, setMode, setCursor, objects } from './state.js';
import { register, fuzzy } from './commands.js';
import { cfg, setCfg } from './settings.js';
import { listMaterials, customMaterials, thumbnail, flatColor, clean, getVmt, forget, matCache } from './materials.js';
import { pick } from './view3d.js';
import { show, pane } from './layout.js';
import { el } from './dom.js';

export const MIME = 'application/x-tf2-material';
// Drag data of a model tile (modelbrowser.js): a drop places a prop, and the image import (import.js) leaves it alone.
export const MODEL_MIME = 'application/x-tf2-model';

// ---------- pure helpers ----------
// Rank of a material path for query q, higher is better; -1 when a word of q does not match. Each word is scored
// by commands.js fuzzy: prefix > word start (after / _ - .) > substring > scattered letters.
export function score(q, name) {
  let s = 0;
  for (const w of q.split(/\s+/)) {
    if (!w) continue;
    const x = fuzzy(w, name);
    if (x < 0) return -1;
    s += x;
  }
  return s;
}

// The names matching q, best first (stable: ties keep their order).
export const search = (q, names) => names.map(n => [n, score(q, n)]).filter(x => x[1] >= 0).sort((a, b) => b[1] - a[1]).map(x => x[0]);

// Folder tree of material paths: { name, path: 'dev/', count, kids: Map<name, node> }; count includes subfolders.
export function buildTree(names) {
  const root = { name: '', path: '', count: names.length, kids: new Map() };
  for (const n of names) {
    let t = root;
    for (const p of n.split('/').slice(0, -1)) {
      let k = t.kids.get(p);
      if (!k) t.kids.set(p, (k = { name: p, path: `${t.path}${p}/`, count: 0, kids: new Map() }));
      k.count++;
      t = k;
    }
  }
  return root;
}

// [label, (name, ctx) => bool]. ctx: { used, recent, favs, custom } Sets of names.
export const FILTERS = {
  all: ['All', () => true],
  used: ['Used in map', (n, c) => c.used.has(n)],
  recent: ['Recent', (n, c) => c.recent.has(n)],
  favs: ['Favourites', (n, c) => c.favs.has(n)],
  tools: ['Tools', n => n.startsWith('tools/')],
  custom: ['Custom (tf/custom)', (n, c) => c.custom.has(n)],
  dev: ['Dev', n => n.startsWith('dev/')],
};

// ---------- document ----------
const mat = s => (V.get(s, 'material') ?? '').toLowerCase();
const solids = () => [...cache.values()].filter(c => !c.point);
// Overlays and decals name their material in a key: [entity, key] for each.
const decalKey = e => { const c = V.get(e, 'classname') ?? ''; return c.startsWith('info_overlay') ? 'material' : c === 'infodecal' ? 'texture' : null; };
const decals = () => objects().filter(e => e.name === 'entity').map(e => [e, decalKey(e)]).filter(x => x[1] && V.get(...x));
const selSides = () => [...sel].filter(n => n.name === 'solid').flatMap(n => V.kids(n, 'side'));
const plural = (n, w, ws = w + 's') => `${n} ${n === 1 ? w : ws}`;
const recent = () => cfg.recentMaterials ?? [];
const favs = () => cfg.favourites ?? [];

// Most recent first, at most 30.
export function remember(name) {
  name = clean(name);
  if (name && recent()[0] !== name) setCfg('recentMaterials', [name, ...recent().filter(x => x !== name)].slice(0, 30));
}

// Puts material name on the given side nodes as one undo step. Returns how many faces changed.
export function setSides(sides, name) {
  name = clean(name);
  const want = new Set(sides), N = name.toUpperCase(), hit = s => want.has(s) && mat(s) !== name;
  const ns = solids().map(c => c.node).filter(n => V.kids(n, 'side').some(hit));
  let count = 0;
  if (name && ns.length) edit(ns, [], () => ns.forEach(n => V.kids(n, 'side').filter(hit).forEach(s => { V.set(s, 'material', N); count++; })));
  if (count) remember(name);
  return count;
}

// setSides with the outcome in the status bar.
function apply(sides, name, none = 'Nothing to apply to: select brushes or faces') {
  const n = setSides(sides, name);
  setCursor(n ? `${clean(name)} applied to ${plural(n, 'face')}` : sides.length ? `${clean(name)} is already on ${sides.length > 1 ? 'those faces' : 'that face'}` : none);
  return n;
}

// Faces in face mode, else every face of the selected brushes.
export const applySel = name => apply(S.mode === 'face' ? [...faceSel] : selSides(), name);

// Selects the visible faces (face mode) or brushes (object mode) that use name.
export function selectUsing(name, faces = S.mode === 'face') {
  name = clean(name);
  const cs = solids().filter(c => c.visible);
  if (faces) {
    const ss = cs.flatMap(c => V.kids(c.node, 'side')).filter(s => mat(s) === name);
    if (S.mode !== 'face') setMode('face');
    setFaceSelection(ss);
    return setCursor(`${plural(ss.length, 'face')} use ${name}`);
  }
  const ns = cs.filter(c => V.kids(c.node, 'side').some(s => mat(s) === name)).map(c => c.node);
  if (S.mode === 'face') setMode('object');
  setSelection(ns);
  setCursor(`${plural(ns.length, 'brush', 'brushes')} use ${name}`);
}

// Replaces from with to on every face of the map (and its overlays and decals), or (scope 'sel') of the selected
// brushes and selected faces. One undo step.
export function replaceMaterial(from, to, scope = 'map') {
  [from, to] = [clean(from), clean(to)];
  if (!from || !to) return 0;
  const sides = scope === 'map' ? solids().flatMap(c => V.kids(c.node, 'side')) : [...selSides(), ...(S.mode === 'face' ? faceSel : [])];
  const n = setSides(sides.filter(s => mat(s) === from), to), ds = scope === 'map' ? decals().filter(([e, k]) => clean(V.get(e, k)) === from) : [];
  if (ds.length) {
    edit(ds.map(d => d[0]), [], () => ds.forEach(([e, k]) => V.set(e, k, to.toUpperCase())));
    if (n) mergeUndo();
  }
  const also = ds.length ? ` and ${plural(ds.length, 'overlay or decal', 'overlays or decals')}` : '';
  setCursor(`Replaced ${from} with ${to} on ${plural(n, 'face')}${also}${names.length && !names.includes(to) ? ` (${to} is not in the game files)` : ''}`);
  return n + ds.length;
}

// ---------- panel ----------
const GAP = 6, LABEL = 28; // LABEL: two caption lines
let host, q, fsel, slider, treeEl, grid, sizer, empty, foot, menu, dlg;
const thumbSize = () => Math.min(160, Math.max(48, +cfg.textureThumbSize || 64));
let names = [], custom = new Set(), base = [], view = [], root = null, folder = '', loading = false;
let size = thumbSize(), cols = 1, cellW = 1, rowH = 1, busy = 0, timer = 0;
const opened = new Set(), shown = new Map(), queue = []; // shown: view index -> tile
const cur = () => clean(cfg.material);
const px = () => (size <= 64 ? 64 : 128); // thumbnail size: two buckets, so the slider does not refetch every step
// Alpha display (Textures: alpha, cfg.textureAlpha): a checkerboard behind the thumbnails of translucent, alpha-tested
// and additive materials (their thumbnails keep the texture's alpha).
const alphaOn = () => cfg.textureAlpha !== false;

// Filter -> base and the folder tree. Recent sorts by recency. keep: stay at the scroll position (the list changed
// under the user, not by their choice).
function rebase(keep = false) {
  const f = fsel.value, ctx = { used: new Set(), recent: new Set(recent()), favs: new Set(favs()), custom };
  if (f === 'used') {
    for (const c of solids()) for (const s of V.kids(c.node, 'side')) ctx.used.add(mat(s));
    for (const [e, k] of decals()) ctx.used.add(clean(V.get(e, k)));
  }
  base = names.filter(n => FILTERS[f][1](n, ctx));
  if (f === 'recent') base.sort((a, b) => recent().indexOf(a) - recent().indexOf(b));
  root = buildTree(base);
  if (folder && !base.some(n => n.startsWith(folder))) folder = '';
  renderTree();
  refilter(keep);
}

// Folder and search -> view, then redraw the grid (from the top unless keep).
function refilter(keep = false) {
  const inFolder = folder ? base.filter(n => n.startsWith(folder)) : base, s = q.value.trim().toLowerCase();
  view = s ? search(s, inFolder) : inFolder;
  footer();
  empty.hidden = loading || !names.length || view.length > 0;
  empty.textContent = s ? `No materials match "${s}"` : EMPTY[fsel.value] ?? 'No materials here';
  if (!keep) grid.scrollTop = 0;
  clearTiles();
  draw();
}

const EMPTY = { favs: 'No favourites yet: right-click a texture > Add to favourites', recent: 'Nothing applied yet', custom: 'Nothing in tf/custom yet: drop an image here to import it' };
const footer = () => (foot.textContent = loading ? 'Loading materials...' : !names.length ? 'No materials: set the TF2 folder in Settings (Ctrl+,)'
  : `${view.length} of ${names.length}  |  current: ${cur()}`);

function renderTree() {
  const rows = [], add = (t, depth) => {
    const kids = [...t.kids.values()].sort((a, b) => (a.name < b.name ? -1 : 1)), open = !depth || opened.has(t.path);
    const r = el('div', { className: `tb-f${t.path === folder ? ' on' : ''}${kids.length ? (open ? ' open' : ' shut') : ''}`, title: t.path || 'All materials' },
      el('i'), el('span', { textContent: t.name || 'All' }), el('small', { textContent: t.count }));
    r.dataset.p = t.path;
    r.style.paddingLeft = `${4 + depth * 10}px`;
    rows.push(r);
    if (open) kids.forEach(k => add(k, depth + 1));
  };
  if (root) add(root, 0);
  treeEl.replaceChildren(...rows);
}

function onTree(e) {
  const r = e.target.closest('.tb-f');
  if (!r) return;
  const p = r.dataset.p;
  if (p && (e.target.tagName === 'I' || e.type === 'dblclick')) opened.has(p) ? opened.delete(p) : opened.add(p);
  else if (folder !== p) { folder = p; refilter(); }
  renderTree();
}

// ---------- virtualised grid: only the visible rows (plus one above and below) have tiles ----------
function measure() {
  const w = grid.clientWidth;
  if (!w) return false;
  // The spare width is spread over the columns (tiles centred in their cells), not left as a strip on the right.
  const c = Math.max(1, Math.floor((w - GAP) / (size + GAP))), cw = (w - GAP) / c;
  if (c !== cols || cw !== cellW || rowH !== size + LABEL + GAP) clearTiles();
  [cols, cellW, rowH] = [c, cw, size + LABEL + GAP];
  sizer.style.height = `${Math.ceil(view.length / cols) * rowH + GAP}px`;
  return true;
}

function clearTiles() {
  shown.forEach(t => t.remove());
  shown.clear();
}

function draw() {
  if (!measure()) return;
  const top = grid.scrollTop, lo = Math.max(0, Math.floor(top / rowH) - 1) * cols;
  const hi = Math.min(view.length, (Math.ceil((top + grid.clientHeight) / rowH) + 1) * cols);
  for (const [i, t] of shown) if (i < lo || i >= hi) { t.remove(); shown.delete(i); }
  const c = cur();
  for (let i = lo; i < hi; i++) if (!shown.has(i)) shown.set(i, sizer.appendChild(tile(i, c)));
  pump();
}

function tile(i, c) {
  const n = view[i], t = el('div', { className: n === c ? 'tb-tile on' : 'tb-tile', draggable: true, title: n });
  // An <img>: Chromium starts a drag on Shift+press only over an image or a link (a div would extend a text selection).
  const img = el('img', { className: 'tb-img', alt: '' });
  t.dataset.n = n;
  t.style.cssText = `left:${GAP + (i % cols) * cellW + (cellW - GAP - size) / 2}px;top:${GAP + Math.floor(i / cols) * rowH}px;width:${size}px`;
  img.style.cssText = `width:${size}px;height:${size}px;background-color:#${flatColor(n).getHexString()}`;
  t.append(img, el('span', { textContent: n.slice(n.lastIndexOf('/') + 1) }));
  queue.push(t);
  return t;
}

// Loads thumbnails for tiles still on screen, a few at a time; tiles scrolled away before their turn are skipped.
// Cached ones resolve in a microtask, so they show without a placeholder frame.
function pump() {
  while (busy < 8 && queue.length) {
    const t = queue.shift();
    if (!t.isConnected) continue;
    busy++;
    thumbnail(t.dataset.n, px())
      .then(u => { t.firstChild.src = u; t.firstChild.style.backgroundColor = 'transparent'; }, () => {})
      .finally(() => { busy--; pump(); });
    if (alphaOn()) getVmt(t.dataset.n).then(p => t.classList.toggle('alpha', !!(p?.translucent || p?.alphatest || p?.additive)), () => {});
  }
}

const tileOf = e => e.target.closest?.('.tb-tile')?.dataset.n;
const pickMat = n => setCfg('material', n.toUpperCase());

// Picks name and scrolls its tile into view when it is in the list.
function reveal(name) {
  const n = clean(name), i = view.indexOf(n);
  pickMat(n);
  if (i < 0 || !measure()) return;
  const y = GAP + Math.floor(i / cols) * rowH;
  if (y < grid.scrollTop || y + rowH > grid.scrollTop + grid.clientHeight) grid.scrollTop = y - GAP;
  draw();
}

// ---------- context menu (a popover: light dismiss and Escape for free) ----------
function openMenu(e, n) {
  const fav = favs().includes(n), items = [
    ['Apply to selection', () => apply(selSides(), n), [...sel].some(x => x.name === 'solid')],
    ['Apply to selected faces', () => apply([...faceSel], n), S.mode === 'face' && faceSel.size > 0],
    ['Select all faces using it', () => selectUsing(n, true)],
    ['Select all brushes using it', () => selectUsing(n, false)],
    ['Find and replace...', () => replaceDialog(n)],
    [fav ? 'Remove from favourites' : 'Add to favourites', () => setCfg('favourites', fav ? favs().filter(x => x !== n) : [...favs(), n].sort())],
    ['Copy name', () => navigator.clipboard.writeText(n)],
  ];
  menu.replaceChildren(...items.map(([textContent, fn, ok = true]) => el('button', { textContent, disabled: !ok, onclick: () => { menu.hidePopover(); fn(); } })));
  menu.showPopover();
  menu.style.left = `${Math.min(e.clientX, innerWidth - menu.offsetWidth - 4)}px`;
  menu.style.top = `${Math.min(e.clientY, innerHeight - menu.offsetHeight - 4)}px`;
}

// ---------- find and replace ----------
function replaceDialog(from = cur()) {
  dlg ??= document.body.appendChild(el('dialog', { id: 'tb-replace' }));
  const list = document.getElementById('tb-names') ?? document.body.appendChild(el('datalist', { id: 'tb-names' }));
  if (list.childElementCount !== names.length) list.replaceChildren(...names.map(value => el('option', { value })));
  const f = el('input', { value: from, required: true, spellcheck: false }), t = el('input', { required: true, spellcheck: false, placeholder: 'new material' });
  const scope = el('select', {}, el('option', { value: 'map', textContent: 'Whole map' }), el('option', { value: 'sel', textContent: 'Selection (brushes and selected faces)' }));
  [f, t].forEach(i => i.setAttribute('list', 'tb-names'));
  dlg.replaceChildren(el('form', { method: 'dialog' },
    el('h3', { textContent: 'Find and replace material' }),
    el('label', {}, el('span', { textContent: 'From' }), f), el('label', {}, el('span', { textContent: 'To' }), t), el('label', {}, el('span', { textContent: 'In' }), scope),
    el('div', { className: 'row' }, el('button', { className: 'primary', value: 'ok', textContent: 'Replace' }), el('button', { value: '', textContent: 'Cancel', formNoValidate: true }))));
  dlg.returnValue = '';
  dlg.onclose = () => dlg.returnValue === 'ok' && replaceMaterial(f.value, t.value, scope.value);
  dlg.showModal();
  t.focus();
}

// ---------- drop on the 3D view ----------
function dragOver(e) {
  if (!e.dataTransfer.types.includes(MIME)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
}

// Brushes selected (object mode): every face of them, wherever it lands. Else the face under the cursor; Shift: its whole
// brush; a face among several selected faces (face mode): all of them.
function drop3d(e) {
  const n = e.dataTransfer.getData(MIME), r = e.currentTarget.querySelector('canvas').getBoundingClientRect();
  if (!n) return;
  e.preventDefault();
  if (S.mode !== 'face' && selSides().length) return void apply(selSides(), n);
  const hit = pick(e.clientX - r.left, e.clientY - r.top);
  if (hit?.node.name !== 'solid') return setCursor('Drop the material on a brush face, or select brushes first');
  apply(e.shiftKey ? V.kids(hit.node, 'side') : S.mode === 'face' && faceSel.has(hit.side) ? [...faceSel] : [hit.side], n);
}

// ---------- API ----------
// Shows the panel and searches for name (the current material by default) across all materials.
export function browse(name = cfg.material) {
  show('textures');
  q.value = clean(name);
  fsel.value = 'all';
  folder = '';
  rebase();
  q.focus();
  q.select();
}

// keep: stay at the scroll position (a material was added while the user browses).
async function load(keep = false) {
  loading = true;
  refilter(keep);
  [names, custom] = await Promise.all([listMaterials(), customMaterials()]).catch(e => (console.warn(e), [[], new Set()]));
  loading = false;
  rebase(keep);
}

const HTML = `
<div class="tb-bar"><input class="tb-q" type="search" placeholder="Search materials" title="Search (Ctrl+Shift+T). Words match anywhere in the path; Enter picks the first" spellcheck="false">
<select class="tb-filter" title="Filter"></select><input class="tb-size" type="range" min="48" max="160" step="8" title="Thumbnail size"></div>
<div class="tb-main"><div class="tb-tree"></div><div class="tb-grid"><div class="tb-sizer"></div><div class="tb-empty" hidden></div></div></div>
<div class="tb-foot"></div>`;

export function mount() {
  host = pane('textures');
  host.classList.add('tb');
  host.classList.toggle('alpha', alphaOn());
  host.innerHTML = HTML;
  [q, fsel, slider, treeEl, grid, sizer, empty, foot] = ['.tb-q', '.tb-filter', '.tb-size', '.tb-tree', '.tb-grid', '.tb-sizer', '.tb-empty', '.tb-foot'].map(s => host.querySelector(s));
  fsel.append(...Object.entries(FILTERS).map(([value, [textContent]]) => el('option', { value, textContent })));
  menu = document.body.appendChild(el('div', { className: 'tb-menu', popover: 'auto' }));

  let t = 0;
  q.oninput = () => { clearTimeout(t); t = setTimeout(() => refilter(), 60); };
  // Enter picks the best match; Escape clears the search, then hands the keyboard back to the editor.
  q.onkeydown = e => {
    if (e.key === 'Enter' && view.length) pickMat(view[0]);
    else if (e.key === 'Escape' && q.value) { q.value = ''; refilter(); }
    else if (e.key === 'Escape') q.blur();
    else return;
    e.preventDefault();
  };
  fsel.onchange = () => rebase();
  slider.value = size;
  slider.oninput = () => { size = +slider.value; draw(); };
  slider.onchange = () => setCfg('textureThumbSize', size);
  treeEl.onclick = treeEl.ondblclick = onTree;
  grid.onscroll = draw;
  // Also fires when the tab is hidden (0 x 0) or shown again: tiles left without a thumbnail while hidden are rebuilt.
  new ResizeObserver(() => { clearTiles(); draw(); }).observe(grid);
  grid.onclick = e => { const n = tileOf(e); if (n) pickMat(n); };
  grid.ondblclick = e => { const n = tileOf(e); if (n) applySel(n); };
  grid.oncontextmenu = e => { const n = tileOf(e); if (!n) return; e.preventDefault(); pickMat(n); openMenu(e, n); };
  grid.ondragstart = e => {
    const n = tileOf(e);
    if (!n) return;
    e.dataTransfer.setData(MIME, n);
    e.dataTransfer.setData('text/plain', n.toUpperCase()); // a drop on a text field types the name
    e.dataTransfer.effectAllowed = 'copy';
  };
  const v3 = pane('3d');
  v3.addEventListener('dragover', dragOver);
  v3.addEventListener('drop', drop3d);

  // 'Used in map' follows edits, debounced: an edit can come every frame while dragging a field.
  const usedChanged = () => { if (fsel.value === 'used') { clearTimeout(timer); timer = setTimeout(() => rebase(true), 250); } };
  on('doc', usedChanged);
  on('file', usedChanged);
  // Materials added after indexing (image import): the list keeps its place and the new one becomes current.
  on('materials', d => load(true).then(() => d?.added?.[0] && reveal(d.added[0])));
  on('cfg', ({ key }) => {
    if (key === 'tf2') load();
    else if (key === 'material') { shown.forEach(t => t.classList.toggle('on', t.dataset.n === cur())); footer(); }
    else if ((key === 'favourites' && fsel.value === 'favs') || (key === 'recentMaterials' && fsel.value === 'recent')) rebase(true);
    else if (key === 'textureThumbSize') { size = thumbSize(); slider.value = size; draw(); }
    else if (key === 'textureAlpha') { host.classList.toggle('alpha', alphaOn()); clearTiles(); draw(); }
  });
  // Materials loaded again (materials.js forget): their tiles make their thumbnails again.
  on('forget', ({ names: ns }) => { const s = new Set(ns); shown.forEach(t => s.has(t.dataset.n) && queue.push(t)); pump(); });

  register('textures.show', { title: 'Textures: show browser', keys: ['shift+t'], run: () => show('textures') });
  register('textures.find', { title: 'Textures: search', keys: ['ctrl+shift+t'], run: () => { show('textures'); q.focus(); q.select(); } });
  register('material.replace', { title: 'Find and replace material...', keys: ['ctrl+shift+r'], run: () => replaceDialog() });
  register('select.byMaterial', { title: 'Select by current material (faces in face mode)', run: () => selectUsing(cur()) });
  register('textures.alpha', { title: 'Textures: checkerboard behind translucent textures (toggle)', run: () => setCfg('textureAlpha', !alphaOn()), on: alphaOn });
  register('textures.reload', { title: 'Textures: reload the loaded materials from disk', run: () => {
    const ns = [...matCache.keys()];
    for (const n of ns) forget(n);
    setCursor(`Reloading ${plural(ns.length, 'material')}`);
  } });
  load();
}
