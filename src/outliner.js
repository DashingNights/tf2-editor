// Side panel: object tree (World by visgroup, Entities by class), show filters, visgroups.
import * as V from '../vmf.js';
import { on } from './bus.js';
import { doc, sel, cache, filters, edit, setSelection as setSel, setFilter, applyFilters, boxOf, category, objects, groupSel, ungroupSel, setCursor, groupOf } from './state.js';
import { register, run } from './commands.js';
import { cfg, setCfg } from './settings.js';
import { el, scrollToShow } from './dom.js';

// ---------- visgroups in the VMF ----------
const block = () => V.kids(doc.root, 'visgroups')[0];
const editorOf = n => V.kids(n, 'editor')[0];
export const vgIds = n => editorOf(n)?.kv.filter(p => p[0] === 'visgroupid').map(p => p[1]) ?? [];
// Visgroups hold top-level objects: world solids and whole entities (hidden ones too), or for a group member, its
// group block (Hammer drops visgroups from members of a group when it loads a map).
const tops = objects;
const objOf = n => { const o = cache.get(n)?.owner; return !o || o === doc.world ? n : o; };
const holder = n => groupOf(n) ?? n;
const selObjects = () => [...new Set([...sel].map(objOf))];
const selHolders = () => [...new Set(selObjects().map(holder))];
// The visgroups object n is in: its own, its solids' and its group's.
const idsOf = n => [n, ...V.kids(n, 'solid'), groupOf(n)].filter(Boolean).flatMap(vgIds);
const holds = (n, ids) => idsOf(n).some(id => ids.includes(id));

// Every visgroup in tree order: { node, parent, id, name, depth, path }.
export function visgroups() {
  const out = [];
  const walk = (parent, depth, pre) => V.kids(parent, 'visgroup').forEach(node => {
    const name = V.get(node, 'name') || '';
    out.push({ node, parent, id: V.get(node, 'visgroupid'), name, depth, path: pre + name });
    walk(node, depth + 1, `${pre}${name} / `);
  });
  if (block()) walk(block(), 0, '');
  return out;
}
const find = id => visgroups().find(g => g.id === id);
// The visgroup's id and the ids of every visgroup nested in it.
const subtree = id => { const ids = [], w = n => { ids.push(V.get(n, 'visgroupid')); V.kids(n, 'visgroup').forEach(w); }; w(find(id).node); return ids; };

function addTo(n, id) {
  let e = editorOf(n);
  if (!e) n.children.push((e = { name: 'editor', kv: [['color', '220 30 220'], ['visgroupshown', '1'], ['visgroupautoshown', '1']], children: [] }));
  if (vgIds(n).includes(id)) return;
  const i = e.kv.findIndex(p => p[0] === 'visgroupshown');
  e.kv.splice(i < 0 ? e.kv.length : i, 0, ['visgroupid', id]);
}
// id null: every visgroup. Also clears the solids of an entity.
const removeFrom = (n, id) => [n, ...V.kids(n, 'solid')].forEach(x => {
  const e = editorOf(x);
  if (e) e.kv = e.kv.filter(p => p[0] !== 'visgroupid' || (id !== null && p[1] !== id));
});

const rgb = () => [0, 0, 0].map(() => 100 + Math.floor(Math.random() * 156)).join(' ');
const clean = s => s.replace(/"/g, '').trim(); // VMF strings cannot hold quotes

// Creates a visgroup holding the selected objects (none selected: an empty one), inside visgroup parent if given.
// Returns its id.
export function createVisgroup(name, parent) {
  const r = doc.root, b = block(), objs = selHolders(), up = parent && find(parent);
  const id = String(Math.max(0, ...visgroups().map(g => +g.id || 0)) + 1);
  const g = { name: 'visgroup', kv: [['name', clean(name ?? '') || `Visgroup ${id}`], ['visgroupid', id], ['color', rgb()]], children: [] };
  edit(b ? [b, ...objs] : objs, b ? [] : [r], () => {
    let into = b;
    if (!into) r.children.splice(r.children.findIndex(c => c.name === 'versioninfo') + 1, 0, (into = { name: 'visgroups', kv: [], children: [] }));
    (up?.node ?? into).children.push(g);
    objs.forEach(n => addTo(n, id));
  });
  return id;
}

export function renameVisgroup(id, name) {
  const g = find(id);
  name = clean(name);
  if (g && name && name !== g.name) edit([block()], [], () => V.set(g.node, 'name', name));
}

// Removes the visgroup; nested visgroups move up to its parent. Members lose only this id.
export function deleteVisgroup(id) {
  const g = find(id);
  if (!g) return;
  const objs = [...tops(), ...V.kids(doc.world, 'group')].filter(n => vgIds(n).includes(id) || V.kids(n, 'solid').some(x => vgIds(x).includes(id)));
  filters.hiddenVisgroups.delete(id);
  edit([block(), ...objs], [], () => {
    const kids = g.parent.children;
    kids.splice(kids.indexOf(g.node), 1, ...V.kids(g.node, 'visgroup'));
    objs.forEach(n => removeFrom(n, id));
  });
}

// Adds the selected objects to visgroup id, or removes them (id null: from every visgroup).
export function assign(id, add) {
  const inAny = n => [n, ...V.kids(n, 'solid')].some(x => vgIds(x).length), mine = n => [n, ...V.kids(n, 'solid')].some(x => vgIds(x).includes(id));
  const objs = selHolders().filter(n => (add ? !vgIds(n).includes(id) : id === null ? inAny(n) : mine(n)));
  if (objs.length) edit(objs, [], () => objs.forEach(n => (add ? addTo(n, id) : removeFrom(n, id))));
}

const visible = n => cache.get(n)?.visible;
const members = id => { const ids = subtree(id); return [...cache.values()].filter(c => holds(objOf(c.node), ids)).map(c => c.node); };

// ---------- tree model ----------
// Group: { key, label, count, kids: [group], items: [item], vg: visgroup id | undefined }. Item: { label, extra, text, nodes }.
export function buildTree() {
  const vgs = visgroups(), known = new Set(vgs.map(g => g.id)), byVg = new Map(), ungrouped = [], classes = new Map(), ents = new Map();
  const push = (m, k, it) => (m.get(k) ?? m.set(k, []).get(k)).push(it);
  let solids = 0;
  for (const c of cache.values()) {
    const n = c.node;
    if (c.owner === doc.world) {
      solids++;
      const mat = (V.get(V.kids(n, 'side')[0] ?? n, 'material') || '').toLowerCase(), id = V.get(n, 'id');
      const it = { label: `solid ${id}`, extra: mat, text: `solid ${id} ${mat}`, nodes: [n] }, ids = [...new Set(idsOf(n))].filter(x => known.has(x));
      if (!ids.length) ungrouped.push(it);
      for (const x of ids) push(byVg, x, it);
      continue;
    }
    let it = ents.get(c.owner);
    if (!it) {
      const e = c.owner, cls = V.get(e, 'classname') || '?', name = V.get(e, 'targetname') || '', id = V.get(e, 'id');
      ents.set(e, (it = { label: name || cls, extra: `#${id}`, text: `${cls} ${name} ${id}`.toLowerCase(), nodes: [] }));
      push(classes, cls, it);
    }
    it.nodes.push(n);
    if (!c.point) it.extra = `${it.nodes.length} solid${it.nodes.length > 1 ? 's' : ''}`;
  }
  const leaf = (key, label, items, vg) => ({ key, label, items, kids: [], count: items.length, vg });
  const world = vgs.filter(g => byVg.has(g.id)).map(g => leaf(`w/${g.id}`, g.path, byVg.get(g.id), g.id));
  if (ungrouped.length) world.push(leaf('w/', 'Ungrouped', ungrouped));
  return [
    { key: 'w', label: 'World', count: solids, items: [], kids: world },
    { key: 'e', label: 'Entities', count: ents.size, items: [], kids: [...classes.keys()].sort().map(k => leaf(`e/${k}`, k, classes.get(k))) },
  ];
}

// Flattens the open groups into rows ({ g, d } for a group header, { it, g, d } for an item). A search query
// q (lower case) keeps matching items only, opens every group and counts matches.
export function flatten(model, open, q) {
  const rows = [];
  const count = g => {
    g.shown = q ? g.items.filter(it => it.text.includes(q)) : g.items;
    const k = g.kids.reduce((s, x) => s + count(x), 0);
    return (g.n = q ? g.shown.length + k : g.count);
  };
  const walk = (g, d) => {
    if (q && !g.n) return;
    rows.push({ g, d });
    if (!q && !open.has(g.key)) return;
    g.kids.forEach(k => walk(k, d + 1));
    g.shown.forEach(it => rows.push({ it, g, d: d + 1 }));
  };
  model.forEach(g => { count(g); walk(g, 0); });
  return rows;
}
const nodesOf = g => [...g.shown.flatMap(it => it.nodes), ...g.kids.flatMap(nodesOf)];

// ---------- panel ----------
const ROW = 20; // px, fixed so the tree can be virtualised
const FILTERS = { world: 'World brushes', detail: 'func_detail', entities: 'Entities', triggers: 'Triggers', clips: 'Clips', skybox: 'Skybox', tools: 'Tools', displacements: 'Displacements', models: 'Models' };
const HTML = `
<details open>
  <summary>Outliner</summary>
  <input class="search" type="search" placeholder="Search name, class, id, material" spellcheck="false">
  <small class="summary"></small>
  <div class="tree"><div class="spacer"><div class="win"></div></div></div>
</details>
<details open>
  <summary>Show</summary>
  <div class="filters"></div>
</details>
<details open>
  <summary>Visgroups</summary>
  <div class="row"><button data-cmd="visgroup.create">New from selection</button></div>
  <div class="visgroups"></div>
</details>`;

let $, tree, win, menu, model = [], rows = [], q = '', anchor = null;
const open = new Set(['w', 'e']);

function refresh() {
  rows = flatten(model, open, q);
  $('.spacer').style.height = `${rows.length * ROW}px`;
  renderRows();
}

function renderRows() {
  const a = Math.floor(tree.scrollTop / ROW), b = Math.min(rows.length, a + Math.ceil(tree.clientHeight / ROW) + 1), out = [];
  for (let i = a; i < b; i++) {
    const r = rows[i], grp = !r.it;
    const d = el('div', { className: grp ? `r grp${q || open.has(r.g.key) ? ' open' : ''}` : 'r' }, el('span', { textContent: grp ? r.g.label : r.it.label }), el('small', { textContent: grp ? r.g.n : r.it.extra }));
    d.style.paddingLeft = `${4 + r.d * 12 + (grp ? 0 : 10)}px`;
    d.dataset.i = i;
    out.push(d);
  }
  win.style.transform = `translateY(${a * ROW}px)`;
  win.replaceChildren(...out);
  paint();
}

// Highlights and dimming only: no rebuild.
function paint() {
  for (const d of win.children) {
    const it = rows[d.dataset.i].it;
    if (!it) continue;
    d.classList.toggle('on', it.nodes.some(n => sel.has(n)));
    d.classList.toggle('dim', !it.nodes.some(visible));
  }
  let hidden = 0;
  for (const c of cache.values()) hidden += !c.visible;
  $('.summary').textContent = `${cache.size} objects, ${sel.size} selected, ${hidden} hidden`;
}

const rowOf = e => rows[e.target.closest('.r')?.dataset.i];

// Selections made in this panel do not scroll the tree; the ones from the viewports (and anywhere else) do.
let local = false;
const setSelection = ns => { local = true; try { setSel(ns); } finally { local = false; } };

// Keys of the groups down to the first group with an item holding node n.
export function pathTo(groups, n) {
  for (const g of groups) {
    if (g.items.some(it => it.nodes.includes(n))) return [g.key];
    const p = pathTo(g.kids, n);
    if (p) return [g.key, ...p];
  }
}

// Opens the groups holding the first selected object and scrolls its row into view (centred when it was off screen).
// While the panel is hidden (another tab in front) the scroll waits until the tree is shown again.
let pending = false;
function reveal() {
  const n = sel.values().next().value, keys = !local && n && pathTo(model, n), h = tree.clientHeight;
  pending = !!keys && !h;
  if (!keys || !h) return;
  if (!q && keys.some(k => !open.has(k))) { keys.forEach(k => open.add(k)); refresh(); }
  const i = rows.findIndex(r => r.it?.nodes.includes(n)), top = i * ROW;
  if (i < 0) return;
  if (top < tree.scrollTop || top + ROW > tree.scrollTop + h) { tree.scrollTop = top - (h - ROW) / 2; renderRows(); }
  scrollToShow(win, win.querySelector(`[data-i="${i}"]`)); // the panel around the tree may scroll too (it only)
}

// Click selects, Ctrl toggles, Shift selects the range from the last clicked item in the same group.
function clickItem({ it, g }, e) {
  let ns = it.nodes;
  if (e.shiftKey && anchor?.g === g) {
    const a = g.shown.indexOf(anchor.it), b = g.shown.indexOf(it);
    ns = g.shown.slice(Math.min(a, b), Math.max(a, b) + 1).flatMap(x => x.nodes);
  } else anchor = { g, it };
  ns = ns.filter(visible);
  if (e.ctrlKey && !e.shiftKey && it.nodes.some(n => sel.has(n))) setSelection([...sel].filter(n => !it.nodes.includes(n)));
  else setSelection(e.ctrlKey ? [...sel, ...ns] : ns);
}

async function focusNodes(ns) {
  const es = ns.map(n => cache.get(n)).filter(Boolean);
  if (!es.length) return;
  const { focus } = await import('./view3d.js'); // dynamic so node tests of this module do not load three.js
  focus(boxOf(es));
}

// entries: [label, command id | function | null (disabled)] or null for a separator.
function showMenu(e, entries) {
  menu.replaceChildren(...entries.map(x => (x ? el('button', {
    textContent: x[0], disabled: !x[1],
    onclick: () => { menu.hidePopover(); typeof x[1] === 'string' ? run(x[1]) : x[1](); },
  }) : el('hr'))));
  Object.assign(menu.style, { left: `${e.clientX}px`, top: `${e.clientY}px` });
  menu.showPopover();
  const r = menu.getBoundingClientRect();
  Object.assign(menu.style, { left: `${Math.min(e.clientX, innerWidth - r.width - 4)}px`, top: `${Math.min(e.clientY, innerHeight - r.height - 4)}px` });
  menu.querySelector('button:enabled')?.focus();
}

const vgEntries = vg => [
  ['Create visgroup from selection', 'visgroup.create'],
  ['Add selection to visgroup', vg && (() => assign(vg, true))],
  ['Remove from visgroup', sel.size ? () => assign(vg ?? null, false) : null],
  ['Select visgroup members', vg && (() => setSelection(members(vg).filter(visible)))],
  ['Rename visgroup', vg && (() => rename(vg))],
  ['Delete visgroup', vg && (() => deleteVisgroup(vg))],
];

function treeMenu(e) {
  e.preventDefault();
  const r = rowOf(e);
  if (!r) return;
  if (!r.it) setSelection(nodesOf(r.g).filter(visible));
  else if (!r.it.nodes.some(n => sel.has(n))) clickItem(r, {});
  showMenu(e, [['Hide', 'hide.selected'], ['Isolate', 'hide.isolate'], ['Unhide all', 'hide.unhideAll'], null, ...vgEntries(r.g.vg)]);
}

// ---------- show filters ----------
function filterCounts() {
  const n = Object.fromEntries(Object.keys(FILTERS).map(k => [k, 0]));
  for (const c of cache.values()) {
    n[category(c)]++;
    if (c.owner !== doc.world && (V.get(c.owner, 'classname') || '').startsWith('trigger_')) n.triggers++;
    c.kinds.forEach(k => n[k]++);
  }
  for (const [k, v] of Object.entries(n)) $(`.filters [data-k=${k}] small`).textContent = v;
}

function syncChecks() {
  for (const l of $('.filters').children) l.querySelector('input').checked = filters[l.dataset.k];
  for (const d of $('.visgroups').querySelectorAll('.vg')) d.querySelector('input').checked = !filters.hiddenVisgroups.has(d.dataset.id);
}

// ---------- visgroups list ----------
function visgroupsUI() {
  const counts = new Map();
  for (const n of tops()) for (const id of new Set(idsOf(n))) counts.set(id, (counts.get(id) ?? 0) + 1);
  const out = visgroups().map(g => {
    const cb = el('input', { type: 'checkbox', checked: !filters.hiddenVisgroups.has(g.id), title: 'Visible' });
    cb.onchange = () => { subtree(g.id).forEach(id => (cb.checked ? filters.hiddenVisgroups.delete(id) : filters.hiddenVisgroups.add(id))); applyFilters(); };
    const d = el('div', { className: 'vg row' }, cb, el('span', { className: 'swatch', style: `background:rgb(${V.nums(V.get(g.node, 'color')).join(',')})` }),
      el('span', { className: 'nm', textContent: g.name || g.id, title: 'Click: select members. Double-click: rename' }), el('small', { textContent: counts.get(g.id) ?? 0 }));
    d.style.paddingLeft = `${g.depth * 14}px`;
    d.dataset.id = g.id;
    return d;
  });
  $('.visgroups').replaceChildren(...(out.length ? out : [el('small', { textContent: 'No visgroups' })]));
}

// Inline rename in the visgroups list. Enter or blur saves, Escape cancels.
function rename(id) {
  const nm = $(`.visgroups [data-id="${CSS.escape(id)}"] .nm`);
  if (!nm) return;
  nm.closest('details').open = true;
  const inp = el('input', { value: nm.textContent, className: 'nm' });
  let done = false;
  const finish = ok => { if (done) return; done = true; if (ok) renameVisgroup(id, inp.value); visgroupsUI(); };
  inp.onkeydown = e => { if (e.key === 'Enter' || e.key === 'Escape') finish(e.key === 'Enter'); };
  inp.onblur = () => setTimeout(() => finish(true));
  nm.replaceWith(inp);
  inp.focus();
  inp.select();
}

function rebuild() {
  model = buildTree();
  refresh();
  filterCounts();
  visgroupsUI();
}

export function mount(host) {
  host.innerHTML = HTML;
  $ = s => host.querySelector(s);
  tree = $('.tree');
  win = $('.win');
  menu = el('div', { className: 'ctxmenu', popover: 'auto' });
  menu.onkeydown = e => e.stopPropagation(); // keep Escape for the popover, not the deselect binding
  host.append(menu);

  const search = $('.search');
  search.oninput = () => { q = search.value.trim().toLowerCase(); tree.scrollTop = 0; refresh(); };
  tree.onscroll = renderRows;
  new ResizeObserver(() => { if (pending) reveal(); renderRows(); }).observe(tree);
  tree.onclick = e => {
    const r = rowOf(e);
    if (r?.it) clickItem(r, e);
    else if (r) { open.has(r.g.key) ? open.delete(r.g.key) : open.add(r.g.key); refresh(); }
  };
  tree.ondblclick = e => { const r = rowOf(e); if (r) focusNodes(r.it ? r.it.nodes : nodesOf(r.g)); };
  tree.oncontextmenu = treeMenu;

  $('.filters').replaceChildren(...Object.entries(FILTERS).map(([k, label]) => {
    const cb = el('input', { type: 'checkbox', checked: filters[k], onchange: () => setFilter(k, cb.checked) });
    const l = el('label', { className: 'row' }, cb, el('span', { textContent: label }), el('small'));
    l.dataset.k = k;
    return l;
  }));

  const vgRow = e => e.target.closest('.vg')?.dataset.id;
  const vgBox = $('.visgroups');
  vgBox.onclick = e => {
    const id = e.target.matches('span.nm') && vgRow(e);
    if (id) { const ns = members(id).filter(visible); setSelection(e.ctrlKey ? [...sel, ...ns] : ns); }
  };
  vgBox.ondblclick = e => { if (e.target.matches('span.nm')) rename(vgRow(e)); };
  vgBox.oncontextmenu = e => { e.preventDefault(); const id = vgRow(e); if (id) showMenu(e, vgEntries(id)); };

  on('doc', rebuild);
  on('selection', () => { reveal(); paint(); });
  on('filters', () => { paint(); syncChecks(); });
  on('file', d => { if (d.op === 'load') anchor = null; });

  register('visgroup.create', { title: 'Visgroup: create from selection', run: () => rename(createVisgroup()) });
  const any = () => sel.size > 0;
  register('group', { title: 'Group selection', keys: ['ctrl+g'], when: any, run: groupSel });
  register('ungroup', { title: 'Ungroup selection', keys: ['ctrl+u'], when: any, run: ungroupSel });
  register('select.ignoreGroups', { title: 'Select: ignore groups (toggle)', on: () => !!cfg.ignoreGroups, run: () => {
    setCfg('ignoreGroups', !cfg.ignoreGroups);
    setCursor(`ignore groups ${cfg.ignoreGroups ? 'on: clicks select single objects' : 'off: clicks select whole groups'}`);
  } });
}
