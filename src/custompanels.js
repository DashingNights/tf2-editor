// Custom panels (Window: new custom panel): dockable panels you fill with whatever you want, in sections that fold.
// Put in buttons for any command (right-click any button anywhere: Add to panel; drag a button in; or + Command in
// edit mode), copies of the Tools panel's rollouts, and the tools' option bars (moved here from the Tools panel: one
// place at a time). Edit (in the panel's header) renames the panel and its sections and buttons, drags to reorder,
// removes. Under the sections each custom panel has a dock of its own: drag any panel's tab into it (shown in edit mode
// while it is empty) and it stacks and splits there as in the main window; click its tab to bring it up, drag it out
// to put it back. Kept in cfg.customPanels (its dock as p.dock); each is a dock panel like the others.
import { cfg, setCfg, saveCfg } from './settings.js';
import { registerPanel, unregisterPanel, renamePanel, pane, show, mainApi, setNestedLocator, PANELS } from './layout.js';
import { register, list, fuzzy, get } from './commands.js';
import { ROLLOUTS, rowsOf, addRoot, removeRoot, refresh, setSlotHost, slotEl, slotList, returnSlot } from './tools.js';
import { ask } from './dialog.js';
import { on } from './bus.js';
import { el } from './dom.js';

// ---------- the data: [{ id, title, sections: [{ title, folded, items: [{ cmd, label } | { rollout } | { slot }] }] }] ----------
// A short button label from a command title: 'Mirror: plane through the selection centre' -> 'Plane through the
// selection centre'; '(toggle)' and the like go.
export function shortLabel(title) {
  const t = title.replace(/^[^:]{1,30}:\s+/, '').replace(/\s*\((toggle|again[^)]*)\)\s*$/i, '').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : title;
}
const clone = ps => structuredClone(ps);
// Moves the item at from = [panel id, section, index] to to = [panel id, section, index] (index past the end appends);
// from null inserts item instead. Returns the new list.
export function moveItem(ps, from, to, item) {
  ps = clone(ps);
  const sec = ([p, s]) => ps.find(x => x.id === p)?.sections[s];
  let [tp, ts, ti] = to;
  if (from) {
    const src = sec(from);
    if (!src) return ps;
    [item] = src.items.splice(from[2], 1);
    if (from[0] === tp && from[1] === ts && from[2] < ti) ti--;
  }
  const dst = sec([tp, ts]);
  if (!dst || !item) return ps;
  // a tool's option bar lives in one place: it leaves any other section that holds it
  if (item.slot) for (const p of ps) for (const s of p.sections) s.items = s.items.filter(x => x.slot !== item.slot);
  dst.items.splice(Math.min(ti, dst.items.length), 0, item);
  return ps;
}
export function removeItem(ps, [p, s, i]) { ps = clone(ps); ps.find(x => x.id === p)?.sections[s]?.items.splice(i, 1); return ps; }
export const newId = ps => String(Math.max(0, ...ps.map(p => +p.id || 0)) + 1);

// ---------- panels ----------
const all = () => cfg.customPanels ?? [];
// A Window: <panel> command put in a custom panel brings that panel in as a tab of the custom panel's own dock
// instead of a button (asTabs takes those items out and queues the moves).
const embeds = [];
const dockable = cmd => { const id = cmd?.startsWith('panel.') && cmd.slice(6); return id && !id.startsWith('custom-') && PANELS.some(x => x.id === id) ? id : null; };
export function asTabs(ps, queue = []) {
  for (const p of ps) for (const s of p.sections) s.items = s.items.filter(it => { const id = dockable(it.cmd); if (id) queue.push([p.id, id]); return !id; });
  return ps;
}
const save = ps => { setCfg('customPanels', asTabs(clone(ps), embeds)); flushEmbeds(); };
const pid = id => 'custom-' + id;
const editing = new Set(), hosts = new Map(); // panel ids in edit mode; slot id -> its host element in a custom panel
const kids = (...xs) => xs.filter(x => x != null && x !== false && x !== '');
const labelOf = it => it.label || shortLabel(get(it.cmd)?.title ?? it.cmd);
const change = (id, fn) => { const ps = clone(all()), p = ps.find(x => x.id === id); if (p) { fn(p); save(ps); } };

function mountPanel(p) {
  registerPanel({ id: pid(p.id), title: p.title, near: 'details' });
  const e = pane(pid(p.id)), top = el('div', { className: 'cp-top' }), body = el('div', { className: 'cp-body' }), host = el('div', { className: 'cp-dock' });
  e.classList.add('cmdpanel', 'cpanel');
  e.dataset.panel = pid(p.id);
  e.replaceChildren(top, host, body); // the dock's tabs right under the panel's header, the sections below
  body.ondragover = ev => { if (dragKind(ev)) ev.preventDefault(); };
  body.ondrop = ev => dropOn(ev, [p.id, Math.max(0, (all().find(x => x.id === p.id)?.sections.length ?? 1) - 1), Infinity]);
  addRoot(e);
  nest(p, host);
}

// ---------- each custom panel's own dock ----------
const docks = new Map(); // custom panel id -> its DockviewApi
let main = null; // the main dock (after layout.mount: dock())
const DIR = { top: 'above', bottom: 'below', left: 'left', right: 'right', center: 'within' };
function nest(p, host) {
  const dv = globalThis['dockview-core'];
  if (!dv) return;
  const api = dv.createDockview(host, {
    theme: dv.themeDark,
    createComponent: ({ name }) => ({ element: pane(name), init() {} }),
    createWatermarkComponent: () => ({ element: el('div', { className: 'cp-water', textContent: 'Drag panel tabs here. They stack and split as in the main window; drag a tab out to put the panel back.' }), init() {} }),
  });
  docks.set(p.id, api);
  new ResizeObserver(() => api.layout(host.clientWidth, host.clientHeight)).observe(host);
  if (p.dock) try { api.fromJSON(p.dock); } catch (err) { console.warn('custom panel dock rejected:', err); }
  api.onDidLayoutChange(() => { const q = all().find(x => x.id === p.id); if (q) { q.dock = api.toJSON(); saveCfg(); } dockShow(p.id); });
  api.onUnhandledDragOver(ev => { const d = ev.getData(); if (d?.panelId && d.viewId !== api.id && sourceOf(d.viewId) && !d.panelId.startsWith('custom-')) ev.accept(); });
  api.onDidDrop(ev => { const d = ev.getData(), src = d && sourceOf(d.viewId); if (src && src !== api && d.panelId) movePanel(d.panelId, src, api, ev); });
  // An empty dock refuses another dock's panels (dockview takes them only over a group): the first one is dropped here.
  const foreign = () => { const d = dv.getPanelData?.(); return d?.panelId && d.viewId !== api.id && sourceOf(d.viewId) && !d.panelId.startsWith('custom-') ? d : null; };
  host.addEventListener('dragover', ev => { if (!api.totalPanels && foreign()) { ev.preventDefault(); host.classList.add('cp-drop'); } }, true);
  host.addEventListener('dragleave', ev => { if (!host.contains(ev.relatedTarget)) host.classList.remove('cp-drop'); });
  host.addEventListener('drop', ev => {
    host.classList.remove('cp-drop');
    const d = !api.totalPanels && foreign();
    if (!d) return;
    ev.preventDefault();
    ev.stopPropagation();
    movePanel(d.panelId, sourceOf(d.viewId), api);
  }, true);
  dockShow(p.id);
}
const sourceOf = viewId => (main?.id === viewId ? main : [...docks.values()].find(a => a.id === viewId) ?? null);
// The dock shows while it holds panels, and in edit mode (to drop into).
function dockShow(id) {
  const api = docks.get(id), host = pane(pid(id)).querySelector(':scope > .cp-dock');
  if (api && host) host.hidden = !(api.totalPanels || editing.has(id));
}
// Moves panel id from dock from to dock to, where ev (a drop) points, or as a new tab / group.
function movePanel(id, from, to, ev = {}) {
  const p = from.getPanel(id);
  if (!p) return;
  const title = p.title ?? id;
  from.removePanel(p);
  const position = ev.group ? { referenceGroup: ev.group, direction: DIR[ev.position] ?? 'within' } : ev.position && ev.position !== 'center' ? { direction: DIR[ev.position] } : undefined;
  to.addPanel({ id, component: id, title, position });
  to.getPanel(id)?.api.setActive();
}
// Puts panel id into custom panel cp's dock as a tab, from wherever it is (the main dock, another custom panel, closed).
function embed(cp, id) {
  const to = docks.get(cp);
  if (!to) return;
  if (!to.getPanel(id)) {
    const from = main?.getPanel(id) ? main : [...docks.values()].find(a => a.getPanel(id));
    if (from) movePanel(id, from, to);
    else to.addPanel({ id, component: id, title: PANELS.find(x => x.id === id)?.title ?? id });
  }
  to.getPanel(id)?.api.setActive();
  const q = all().find(x => x.id === cp);
  if (q) render(q); // its hint goes, the dock shows
}
function flushEmbeds() { if (main) while (embeds.length) embed(...embeds.shift()); }

// After layout.mount: panels dragged out of a custom panel land in the main dock; Window: commands find nested panels.
export function dock() {
  main = mainApi();
  if (!main) return;
  main.onUnhandledDragOver(ev => { const d = ev.getData(); if (d?.panelId && d.viewId !== main.id && sourceOf(d.viewId)) ev.accept(); });
  main.onDidDrop(ev => { const d = ev.getData(), src = d && sourceOf(d.viewId); if (src && src !== main && d.panelId) movePanel(d.panelId, src, main, ev); });
  // over a custom panel's own dock the drop is that dock's, not the main group's around it
  main.onWillShowOverlay(ev => { if (ev.nativeEvent?.target?.closest?.('.cp-dock')) ev.preventDefault(); });
  const holder = id => [...docks].find(([, a]) => a.getPanel(id));
  for (const p of [...main.panels]) if (holder(p.id)) main.removePanel(p); // a layout saved before the panel moved
  setNestedLocator(id => { const h = holder(id); return h && (() => { show(pid(h[0])); h[1].getPanel(id)?.api.setActive(); }); });
  if (all().some(p => p.sections.some(s => s.items.some(it => dockable(it.cmd))))) save(all()); // Window: buttons saved before: tabs now
  flushEmbeds();
}

function render(p) {
  const root = pane(pid(p.id)), e = root.querySelector(':scope > .cp-body'), ed = editing.has(p.id);
  for (const [id, h] of hosts) if (e.contains(h)) hosts.delete(id);
  const head = el('div', { className: 'cp-head' }, ...kids(
    ed ? el('input', { className: 'cp-title', value: p.title, title: 'Panel name', onchange: ev => change(p.id, q => { q.title = ev.target.value.trim() || q.title; }) }) : el('b', { textContent: p.title }),
    el('button', { textContent: ed ? 'Done' : 'Edit', title: ed ? 'Leave edit mode' : 'Edit this panel: add, rename, reorder, remove', onclick: () => { ed ? editing.delete(p.id) : editing.add(p.id); render(p); } }),
    ed && el('button', { textContent: '+ Section', onclick: () => change(p.id, q => q.sections.push({ title: 'Section', items: [] })) }),
    ed && el('button', { textContent: 'Delete panel', onclick: () => remove(p.id) })));
  const empty = !p.sections.some(s => s.items.length), tabs = docks.get(p.id)?.totalPanels;
  root.querySelector(':scope > .cp-top').replaceChildren(head);
  e.replaceChildren(...p.sections.map((s, si) => (ed || s.items.length) && section(p, s, si, ed)).filter(Boolean),
    ...kids(empty && !ed && !tabs && el('p', { className: 'cp-hint', textContent: 'Right-click any button and choose Add to panel, drag buttons or panel tabs here, or press Edit.' })));
  // the tools' option bars come back into their hosts (they are module elements, moved, never copied)
  for (const [id, h] of hosts) { const r = slotEl(id); if (r && e.contains(h) && r.parentElement !== h) h.append(r); }
  dockShow(p.id);
  refresh();
}

function section(p, s, si, ed) {
  const body = el('div', { className: 'tb' }), at = i => [p.id, si, i];
  let row = null;
  s.items.forEach((it, i) => {
    const node = item(p, it, at(i), ed);
    if (it.cmd && !ed) { (row ??= body.appendChild(el('div', { className: 'row' }))).append(node); return; }
    row = null;
    body.append(node);
  });
  if (ed) body.append(adder(p, si));
  body.ondragover = ev => { if (dragKind(ev)) ev.preventDefault(); };
  body.ondrop = ev => dropOn(ev, at(Infinity));
  if (ed) {
    const move = d => change(p.id, q => { const [x] = q.sections.splice(si, 1); q.sections.splice(Math.max(0, si + d), 0, x); });
    return el('div', { className: 'cs edit' }, el('div', { className: 'cs-head' },
      el('input', { value: s.title, title: 'Section name', onchange: ev => change(p.id, q => { q.sections[si].title = ev.target.value.trim() || 'Section'; }) }),
      el('button', { textContent: 'Up', disabled: si === 0, onclick: () => move(-1) }),
      el('button', { textContent: 'Down', disabled: si === p.sections.length - 1, onclick: () => move(1) }),
      el('button', { textContent: 'Remove', title: 'Remove this section and what is in it', onclick: () => { s.items.forEach(x => x.slot && returnSlot(x.slot)); change(p.id, q => q.sections.splice(si, 1)); } })), body);
  }
  const d = el('details', { className: 'cs', open: !s.folded }, el('summary', { textContent: s.title }), body);
  d.ontoggle = () => { const q = all().find(x => x.id === p.id); if (q?.sections[si]) { q.sections[si].folded = !d.open; saveCfg(); } };
  return d;
}

function item(p, it, at, ed) {
  if (ed) {
    const name = it.cmd ? labelOf(it) : it.rollout ? `Rollout: ${ROLLOUTS.find(r => r.id === it.rollout)?.title ?? it.rollout}` : `Tool options: ${slotList().find(([id]) => id === it.slot)?.[1] ?? it.slot}`;
    const lab = el('span', { className: 'ci-label', textContent: name, title: it.cmd ? 'Double-click to rename' : '' });
    if (it.cmd) lab.ondblclick = () => {
      const inp = el('input', { value: labelOf(it), onchange: () => change(p.id, q => { q.sections[at[1]].items[at[2]].label = inp.value.trim(); }), onblur: () => inp.replaceWith(lab) });
      lab.replaceWith(inp);
      inp.focus();
      inp.select();
    };
    const c = el('span', { className: 'ci', draggable: true, title: 'Drag to move' }, lab,
      el('button', { textContent: 'x', title: 'Remove', onclick: () => { if (it.slot) returnSlot(it.slot); save(removeItem(all(), at)); } }));
    c.ondragstart = ev => { ev.dataTransfer.setData('application/x-ci', JSON.stringify(at)); ev.stopPropagation(); };
    c.ondragover = ev => { if (dragKind(ev)) ev.preventDefault(); };
    c.ondrop = ev => dropOn(ev, at);
    if (it.slot) { const h = el('div', { className: 'slothost' }); hosts.set(it.slot, h); return el('div', {}, c, h); }
    return c;
  }
  if (it.cmd) { const b = el('button', { textContent: labelOf(it) }); b.dataset.cmd = it.cmd; return b; }
  if (it.rollout) {
    const r = ROLLOUTS.find(x => x.id === it.rollout);
    return r ? el('div', { className: 'cp-roll' }, el('div', { className: 'cp-cap', textContent: r.title }), ...rowsOf(r)) : el('span');
  }
  const h = el('div', { className: 'slothost' });
  hosts.set(it.slot, h);
  return h;
}

// Edit mode's adders at the end of a section: a command search, a Tools rollout or a tool's option bar.
function adder(p, si) {
  const add = it => save(moveItem(all(), null, [p.id, si, Infinity], it));
  const inp = el('input', { placeholder: '+ Command (type to search)', className: 'cp-search' });
  const ul = el('div', { className: 'cp-results' });
  const results = () => {
    const q = inp.value.trim();
    ul.replaceChildren(...(q ? list().map(c => [c, fuzzy(q, c.title)]).filter(x => x[1] >= 0).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([c]) =>
      el('button', { textContent: c.title, onmousedown: ev => { ev.preventDefault(); add({ cmd: c.id }); } })) : []));
  };
  inp.oninput = results;
  inp.onkeydown = ev => { if (ev.key === 'Enter') ul.querySelector('button')?.dispatchEvent(new MouseEvent('mousedown')); if (ev.key === 'Escape') inp.blur(); ev.stopPropagation(); };
  inp.onblur = () => setTimeout(() => ul.replaceChildren(), 150);
  const pick = el('select', { onchange: () => { const [k, v] = pick.value.split(':'); pick.selectedIndex = 0; if (k === 'rollout') add({ rollout: v }); else if (k === 'slot') add({ slot: v }); } },
    el('option', { textContent: '+ Rollout or tool options...', value: '' }),
    ...ROLLOUTS.map(r => el('option', { value: `rollout:${r.id}`, textContent: `Rollout: ${r.title}` })),
    ...slotList().map(([id, t]) => el('option', { value: `slot:${id}`, textContent: `Tool options: ${t} (moves here)` })));
  return el('div', { className: 'cp-add' }, inp, pick, ul);
}

// ---------- drag and drop: items between sections and panels, any command button from anywhere ----------
const dragKind = ev => ev.dataTransfer.types.includes('application/x-ci') ? 'ci' : ev.dataTransfer.types.includes('application/x-cmd') ? 'cmd' : null;
function dropOn(ev, to) {
  const k = dragKind(ev);
  if (!k) return;
  ev.preventDefault();
  ev.stopPropagation();
  if (k === 'ci') save(moveItem(all(), JSON.parse(ev.dataTransfer.getData('application/x-ci')), to));
  else save(moveItem(all(), null, to, { cmd: ev.dataTransfer.getData('application/x-cmd') }));
}

// ---------- right-click any command button: add it to a panel ----------
let menu = null;
function contextMenu(ev) {
  const b = ev.target.closest?.('button[data-cmd]');
  if (!b || !get(b.dataset.cmd)) return;
  ev.preventDefault();
  const cmd = b.dataset.cmd, mine = b.closest('.cpanel'), ps = all();
  const go = fn => () => { menu.hidePopover(); fn(); };
  const into = p => moveItem(all(), null, [p.id, Math.max(0, p.sections.length - 1), Infinity], { cmd });
  const entries = [
    el('div', { className: 'cp-menu-cap', textContent: `Add "${b.textContent}" to` }),
    ...ps.map(p => el('button', { textContent: p.title, onclick: go(() => { let q = p; if (!q.sections.length) { change(p.id, x => x.sections.push({ title: 'Commands', items: [] })); q = all().find(x => x.id === p.id); } save(into(q)); show(pid(p.id)); }) })),
    el('button', { textContent: 'New panel...', onclick: go(() => create({ cmd })) }),
  ];
  if (mine) {
    const p = ps.find(x => pid(x.id) === mine.dataset.panel), at = p && locate(p, b);
    entries.push(el('hr'), el('button', { textContent: 'Edit this panel', onclick: go(() => { editing.add(p.id); render(p); }) }));
    if (at) entries.push(el('button', { textContent: 'Remove from this panel', onclick: go(() => save(removeItem(all(), at))) }));
  }
  menu.replaceChildren(...entries);
  Object.assign(menu.style, { left: `${ev.clientX}px`, top: `${ev.clientY}px` });
  menu.showPopover();
  const r = menu.getBoundingClientRect();
  Object.assign(menu.style, { left: `${Math.min(ev.clientX, innerWidth - r.width - 4)}px`, top: `${Math.min(ev.clientY, innerHeight - r.height - 4)}px` });
}
// Where a command button of panel p sits: [panel id, section, index] (the n-th button with that command).
function locate(p, b) {
  const same = [...b.closest('.cpanel').querySelectorAll(`button[data-cmd="${CSS.escape(b.dataset.cmd)}"]`)], n = same.indexOf(b);
  let k = 0;
  for (const [si, s] of p.sections.entries()) for (const [i, it] of s.items.entries()) if (it.cmd === b.dataset.cmd && k++ === n) return [p.id, si, i];
  return null;
}

async function create(first) {
  const ps = clone(all()), id = newId(ps);
  ps.push({ id, title: `Panel ${id}`, sections: [{ title: 'Commands', items: first ? [first] : [] }] });
  if (!first) editing.add(id);
  save(ps);
  show(pid(id));
}
async function remove(id) {
  const p = all().find(x => x.id === id);
  if (!p || (await ask(`Delete the panel "${p.title}"?`, ['Delete', 'Cancel'])) !== 0) return;
  p.sections.forEach(s => s.items.forEach(x => x.slot && returnSlot(x.slot)));
  const d = docks.get(id);
  if (d && main) for (const q of [...d.panels]) movePanel(q.id, d, main); // its panels go back to the main dock
  editing.delete(id);
  save(all().filter(x => x.id !== id));
}

// Mount before the tools' slot() calls (so their option bars can start in a custom panel) and before layout.mount
// (so the saved layout puts the panels back where they were).
let shown = new Map(); // id -> title of the panels mounted
function syncPanels() {
  const ps = all();
  for (const [id] of shown) if (!ps.some(p => p.id === id)) { removeRoot(pane(pid(id))); docks.get(id)?.dispose(); docks.delete(id); unregisterPanel(pid(id)); shown.delete(id); }
  for (const p of ps) {
    if (!shown.has(p.id)) mountPanel(p);
    else if (shown.get(p.id) !== p.title) renamePanel(pid(p.id), p.title);
    shown.set(p.id, p.title);
    render(p);
  }
}
export function mount() {
  setSlotHost(id => hosts.get(id) ?? null);
  syncPanels();
  on('cfg', ({ key }) => { if (key === 'customPanels') syncPanels(); });
  register('panel.custom.new', { title: 'Window: new custom panel', run: () => create() });
  menu = document.body.appendChild(el('div', { className: 'ctxmenu cp-menu', popover: 'auto' }));
  document.addEventListener('contextmenu', contextMenu);
  // any command button can be dragged into a custom panel
  document.addEventListener('pointerdown', ev => { const b = ev.target.closest?.('button[data-cmd]'); if (b && !b.draggable) b.draggable = true; }, true);
  document.addEventListener('dragstart', ev => {
    const b = ev.target.closest?.('button[data-cmd]');
    if (b && !ev.dataTransfer.types.includes('application/x-ci')) { ev.dataTransfer.setData('application/x-cmd', b.dataset.cmd); ev.dataTransfer.setData('text/plain', b.textContent); }
  });
}
