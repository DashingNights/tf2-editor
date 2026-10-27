// Models panel: folder tree, search, filter (all, recent, favourites, used in map) and a virtualised grid of rendered
// thumbnails over every model (models.js listModels). Click sets the model of the selected point entities (one undo
// step), or with none selected arms the entity tool to place a prop with it; double-click opens a large preview;
// right-click for favourites. Names are 'props_gameplay/cap_point_base' (the VMF gets models/<name>.mdl).
import * as THREE from 'three';
import * as V from '../vmf.js';
import { on } from './bus.js';
import { S, sel, cache, edit, mergeUndo, setTool, setCursor, createEntity } from './state.js';
import { pick } from './view3d.js';
import { register } from './commands.js';
import { cfg, setCfg } from './settings.js';
import { search, buildTree, MODEL_MIME } from './texbrowser.js';
import { listModels, getModel, modelPath, fgdDefaults, takesModel } from './models.js';
import { registerPanel, show, pane } from './layout.js';
import { el } from './dom.js';

registerPanel({ id: 'models', title: 'Models', near: 'textures' });

const D2R = Math.PI / 180, TILE = 96, GAP = 6, LABEL = 28, THUMB = 128;
export const pathOf = name => `models/${name}.mdl`;
const nameOf = path => path.replace(/^models\//, '').replace(/\.mdl$/, '');
const recent = () => cfg.recentModels ?? [];
const favs = () => cfg.favouriteModels ?? [];

// ---------- offscreen rendering ----------
let rnd = null;
const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(30, 1, 1, 1e5);
cam.up.set(0, 0, 1);

// Renders a loaded model (getModel) framed from yaw/pitch (radians, 0 = looking at its front, +X) into the shared
// size x size canvas and returns it: read it (toDataURL, drawImage) before the next snapshot.
export function snapshot(r, size, yaw = -0.6, pitch = 0.35) {
  if (!rnd) {
    rnd = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    rnd.outputColorSpace = THREE.LinearSRGBColorSpace; // as view3d: colours as authored
    rnd.setPixelRatio(1);
  }
  rnd.setSize(size, size, false);
  const [mn, mx] = r.bbox.map(p => new THREE.Vector3(...p)), c = mn.clone().add(mx).multiplyScalar(0.5);
  const rad = Math.max(1, mx.distanceTo(mn) / 2), d = rad / Math.sin((cam.fov / 2) * D2R);
  cam.position.set(c.x + d * Math.cos(pitch) * Math.cos(yaw), c.y + d * Math.cos(pitch) * Math.sin(yaw), c.z + d * Math.sin(pitch));
  [cam.near, cam.far] = [Math.max(0.1, d - rad * 1.5), d + rad * 1.5];
  cam.updateProjectionMatrix();
  cam.lookAt(c);
  scene.add(r.object3d);
  rnd.render(scene, cam);
  scene.remove(r.object3d);
  return rnd.domElement;
}

// PNG data URL of a model, or null when it does not load. The last THUMBS stay in memory.
// ponytail: memory only, and the textures loaded for thumbnails stay in materials.js; cache on disk like
// materials.thumbnail once browsing many models gets slow or heavy.
const thumbs = new Map(), THUMBS = 1000;
export function thumbnail(name) {
  let p = thumbs.get(name);
  if (p) thumbs.delete(name);
  else if (thumbs.size >= THUMBS) thumbs.delete(thumbs.keys().next().value);
  thumbs.set(name, (p ??= getModel(pathOf(name)).ready.then(r => (r.geometry ? snapshot(r, THUMB).toDataURL() : null))));
  return p;
}

// ---------- document ----------
const points = () => [...sel].filter(n => cache.get(n)?.point);
// Selected point entities that take a model (the FGD says so, or they have one).
const modelled = () => points().filter(n => V.get(n, 'model') !== undefined || takesModel(V.get(n, 'classname')));
const used = () => new Set([...cache.values()].map(c => c.point && modelPath(c.node)).filter(Boolean).map(nameOf));
function remember(name) {
  if (recent()[0] !== name) setCfg('recentModels', [name, ...recent().filter(x => x !== name)].slice(0, 30));
}

// Sets the model of the selected entities that take one (not while the entity tool is placing: the prop it just placed
// is selected), or arms the entity tool to place a prop with it. replace: set the selection's model anyway.
let pending = null, created = null;
export function choose(name, replace = S.tool !== 'entity') {
  const path = pathOf(name), ents = replace ? modelled() : [], ch = ents.filter(e => V.get(e, 'model') !== path);
  remember(name);
  if (ents.length) {
    if (ch.length) edit([], ch, () => ch.forEach(e => V.set(e, 'model', path)));
    return setCursor(`${name}: model of ${ents.length} ${ents.length === 1 ? 'entity' : 'entities'}`);
  }
  if (!cfg.cls?.startsWith('prop_')) setCfg('cls', 'prop_static');
  setTool('entity');
  pending = path;
  footer();
  setCursor(`Click in a view to place ${cfg.cls} with ${name}`);
}

// A prop with model name at origin, in one undo step (a tile dropped on the 3D view).
function place(name, origin) {
  const path = pathOf(name);
  if (!cfg.cls?.startsWith('prop_')) setCfg('cls', 'prop_static');
  remember(name);
  const n = createEntity(origin), cls = V.get(n, 'classname');
  edit([], [n], () => {
    V.set(n, 'model', path);
    for (const [k, v] of fgdDefaults(cls)) if (V.get(n, k) === undefined) V.set(n, k, v);
  });
  mergeUndo();
  setCursor(`Placed ${cls} with ${name}`);
}

// The entity tool just created an entity while armed: give it the model and its FGD defaults, in the same undo step.
function placed() {
  const n = sel.size === 1 && sel.values().next().value;
  if (!pending || !created?.has(n) || n.name !== 'entity' || V.get(n, 'model') !== undefined) return;
  created = null;
  const cls = V.get(n, 'classname'), path = pending;
  edit([], [n], () => {
    V.set(n, 'model', path);
    for (const [k, v] of fgdDefaults(cls)) if (V.get(n, k) === undefined) V.set(n, k, v);
  });
  mergeUndo();
}

// ---------- panel ----------
let host, q, fsel, treeEl, grid, sizer, empty, foot, menu, dlg;
let names = [], base = [], view = [], root = null, folder = '', loading = false, cols = 1, cellW = 1, busy = 0;
const opened = new Set(), shown = new Map(), queue = [];
const FILTERS = { all: 'All', recent: 'Recent', favs: 'Favourites', used: 'Used in map' };

function rebase(keep = false) {
  const f = fsel.value, only = f === 'favs' ? new Set(favs()) : f === 'used' ? used() : null;
  base = f === 'recent' ? recent().filter(n => names.includes(n)) : only ? names.filter(n => only.has(n)) : names;
  root = buildTree(base);
  if (folder && !base.some(n => n.startsWith(folder))) folder = '';
  renderTree(treeEl, root, folder, opened);
  refilter(keep);
}

const footer = () => (foot.textContent = loading ? 'Loading models...' : !names.length ? 'No models: set the TF2 folder in Settings (Ctrl+,)'
  : `${view.length} of ${names.length}${pending ? '  |  placing ' + nameOf(pending) : ''}`);

function refilter(keep = false) {
  const inFolder = folder ? base.filter(n => n.startsWith(folder)) : base, s = q.value.trim().toLowerCase();
  view = s ? search(s, inFolder) : inFolder;
  footer();
  empty.hidden = loading || !names.length || view.length > 0;
  empty.textContent = s ? `No models match "${s}"` : 'No models here';
  if (!keep) grid.scrollTop = 0;
  clear();
  draw();
}

// Folder tree rows (texbrowser.buildTree); the triangle or a double-click folds a folder. Shared with the sound browser.
export function renderTree(into, t0, cur, open) {
  const rows = [], add = (t, depth) => {
    const kids = [...t.kids.values()].sort((a, b) => (a.name < b.name ? -1 : 1)), isOpen = !depth || open.has(t.path);
    const r = el('div', { className: `mb-f${t.path === cur ? ' on' : ''}${kids.length ? (isOpen ? ' open' : ' shut') : ''}`, title: t.path || 'All' },
      el('i'), el('span', { textContent: t.name || 'All' }), el('small', { textContent: t.count }));
    r.dataset.p = t.path;
    r.style.paddingLeft = `${4 + depth * 10}px`;
    rows.push(r);
    if (isOpen) kids.forEach(k => add(k, depth + 1));
  };
  if (t0) add(t0, 0);
  into.replaceChildren(...rows);
}
// Click handler for a renderTree host: fold (triangle, double-click) or pick(path). Returns true when folded.
export function treeClick(e, open, pick) {
  const r = e.target.closest('.mb-f'), p = r?.dataset.p;
  if (!r) return;
  if (p && (e.target.tagName === 'I' || e.type === 'dblclick')) open.has(p) ? open.delete(p) : open.add(p);
  else pick(p);
}

// ---------- virtualised grid ----------
function measure() {
  const w = grid.clientWidth;
  if (!w) return false;
  const c = Math.max(1, Math.floor((w - GAP) / (TILE + GAP))), cw = (w - GAP) / c;
  if (c !== cols || cw !== cellW) clear();
  [cols, cellW] = [c, cw];
  sizer.style.height = `${Math.ceil(view.length / cols) * (TILE + LABEL + GAP) + GAP}px`;
  return true;
}
function clear() { shown.forEach(t => t.remove()); shown.clear(); }
function draw() {
  if (!measure()) return;
  const rowH = TILE + LABEL + GAP, top = grid.scrollTop, lo = Math.max(0, Math.floor(top / rowH) - 1) * cols;
  const hi = Math.min(view.length, (Math.ceil((top + grid.clientHeight) / rowH) + 1) * cols);
  for (const [i, t] of shown) if (i < lo || i >= hi) { t.remove(); shown.delete(i); }
  for (let i = lo; i < hi; i++) if (!shown.has(i)) shown.set(i, sizer.appendChild(tile(i)));
  pump();
}
function tile(i) {
  const n = view[i], t = el('div', { className: 'mb-tile', title: n, draggable: true }, el('img', { className: 'mb-img', alt: '', draggable: false }), el('span', { textContent: n.slice(n.lastIndexOf('/') + 1) }));
  t.dataset.n = n;
  t.style.cssText = `left:${GAP + (i % cols) * cellW + (cellW - GAP - TILE) / 2}px;top:${GAP + Math.floor(i / cols) * (TILE + LABEL + GAP)}px;width:${TILE}px`;
  queue.push(t);
  return t;
}
// A few thumbnails at a time, for tiles still on screen.
function pump() {
  while (busy < 4 && queue.length) {
    const t = queue.shift();
    if (!t.isConnected) continue;
    busy++;
    thumbnail(t.dataset.n).then(u => { if (u) t.firstChild.src = u; else t.classList.add('bad'); }, () => {}).finally(() => { busy--; pump(); });
  }
}
const tileOf = e => e.target.closest?.('.mb-tile')?.dataset.n;

// ---------- large preview (drag to turn) ----------
function preview(name) {
  dlg ??= document.body.appendChild(el('dialog', { id: 'mb-preview' }));
  const c = el('canvas', { width: 512, height: 512 }), g = c.getContext('2d'), info = el('p', { textContent: 'Loading...' });
  let yaw = -0.6, pitch = 0.35, r = null;
  const paint = () => { if (r?.geometry) { g.clearRect(0, 0, 512, 512); g.drawImage(snapshot(r, 512, yaw, pitch), 0, 0); } };
  c.onpointerdown = e => c.setPointerCapture(e.pointerId);
  c.onpointermove = e => {
    if (!c.hasPointerCapture(e.pointerId)) return;
    yaw -= e.movementX * 0.01;
    pitch = Math.max(-1.5, Math.min(1.5, pitch + e.movementY * 0.01));
    paint();
  };
  dlg.replaceChildren(el('h3', { textContent: name }), c, info, el('div', { className: 'row' },
    el('button', { className: 'primary', textContent: 'Use', onclick: () => { dlg.close(); choose(name); } }),
    el('button', { textContent: 'Close', onclick: () => dlg.close() })));
  dlg.showModal();
  getModel(pathOf(name)).ready.then(x => {
    r = x;
    info.textContent = !r.geometry ? 'This model has no geometry the editor can read.'
      : `${r.bbox[1].map((v, k) => Math.round(v - r.bbox[0][k])).join(' x ')} units  |  ${r.mats.join(', ')}  |  drag to turn`;
    paint();
  });
}

function openMenu(e, n) {
  const fav = favs().includes(n), items = [
    ['Use', () => choose(n)],
    ...(modelled().length ? [[`Set as the model of the ${modelled().length} selected ${modelled().length === 1 ? 'entity' : 'entities'}`, () => choose(n, true)]] : []),
    ['Preview', () => preview(n)],
    [fav ? 'Remove from favourites' : 'Add to favourites', () => setCfg('favouriteModels', fav ? favs().filter(x => x !== n) : [...favs(), n].sort())],
    ['Copy path', () => navigator.clipboard.writeText(pathOf(n))],
  ];
  menu.replaceChildren(...items.map(([textContent, fn]) => el('button', { textContent, onclick: () => { menu.hidePopover(); fn(); } })));
  menu.showPopover();
  menu.style.left = `${Math.min(e.clientX, innerWidth - menu.offsetWidth - 4)}px`;
  menu.style.top = `${Math.min(e.clientY, innerHeight - menu.offsetHeight - 4)}px`;
}

// Shows the panel searching for name (default: the model of the selected entity).
export function browse(name = nameOf(modelPath(points()[0]) ?? '')) {
  show('models');
  q.value = name;
  fsel.value = 'all';
  folder = '';
  rebase();
  q.focus();
  q.select();
}

async function load() {
  loading = true;
  refilter();
  names = await listModels().catch(e => (console.warn(e), []));
  loading = false;
  rebase();
}

const HTML = `
<div class="mb-bar"><input class="mb-q" type="search" placeholder="Search models" spellcheck="false" title="Words match anywhere in the path; Enter uses the first"><select class="mb-filter" title="Filter"></select></div>
<div class="mb-main"><div class="mb-tree"></div><div class="mb-grid"><div class="mb-sizer"></div><div class="mb-empty" hidden></div></div></div>
<div class="mb-foot"></div>`;

export function mount() {
  host = pane('models');
  host.classList.add('mb');
  host.innerHTML = HTML;
  [q, fsel, treeEl, grid, sizer, empty, foot] = ['.mb-q', '.mb-filter', '.mb-tree', '.mb-grid', '.mb-sizer', '.mb-empty', '.mb-foot'].map(s => host.querySelector(s));
  fsel.append(...Object.entries(FILTERS).map(([value, textContent]) => el('option', { value, textContent })));
  menu = document.body.appendChild(el('div', { className: 'mb-menu', popover: 'auto' }));
  let t = 0;
  q.oninput = () => { clearTimeout(t); t = setTimeout(() => refilter(), 60); };
  q.onkeydown = e => {
    if (e.key === 'Enter' && view.length) choose(view[0]);
    else if (e.key === 'Escape' && q.value) { q.value = ''; refilter(); }
    else if (e.key === 'Escape') q.blur();
    else return;
    e.preventDefault();
  };
  fsel.onchange = () => rebase();
  treeEl.onclick = treeEl.ondblclick = e => {
    treeClick(e, opened, p => { if (folder !== p) { folder = p; refilter(); } });
    renderTree(treeEl, root, folder, opened);
  };
  grid.onscroll = draw;
  new ResizeObserver(() => { clear(); draw(); }).observe(grid);
  grid.onclick = e => { const n = tileOf(e); if (n) choose(n); };
  grid.ondblclick = e => { const n = tileOf(e); if (n) preview(n); };
  grid.oncontextmenu = e => { const n = tileOf(e); if (!n) return; e.preventDefault(); openMenu(e, n); };
  // drag a tile onto the 3D view: a prop there
  grid.ondragstart = e => {
    const n = tileOf(e);
    if (!n) return;
    e.dataTransfer.setData(MODEL_MIME, n);
    e.dataTransfer.setData('text/plain', pathOf(n));
    e.dataTransfer.effectAllowed = 'copy';
  };
  const v3 = pane('3d');
  v3.addEventListener('dragover', e => { if (e.dataTransfer.types.includes(MODEL_MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  v3.addEventListener('drop', e => {
    const n = e.dataTransfer.getData(MODEL_MIME);
    if (!n) return;
    e.preventDefault();
    const r = v3.querySelector('canvas').getBoundingClientRect(), hit = pick(e.clientX - r.left, e.clientY - r.top);
    if (!hit) return setCursor('Drop the model on a surface in the 3D view');
    place(n, hit.point.toArray().map(Math.round));
  });

  on('doc', ch => { created = pending && S.tool === 'entity' ? ch : null; });
  on('selection', placed);
  on('tool', () => { if (S.tool !== 'entity' && pending) { pending = null; footer(); } });
  on('cfg', ({ key }) => {
    if (key === 'tf2') { thumbs.clear(); load(); }
    else if ((key === 'favouriteModels' && fsel.value === 'favs') || (key === 'recentModels' && fsel.value === 'recent')) rebase(true);
  });
  on('file', () => fsel.value === 'used' && rebase(true));
  register('models.show', { title: 'Models: show browser', run: () => show('models') });
  register('models.find', { title: 'Models: search (the selected entity\'s model)', run: () => browse() });
  load();
}
