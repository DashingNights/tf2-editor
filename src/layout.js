// Dockable panel layout: one dockview-core component between the toolbar and the status bar. Panel contents are the
// existing #v-3d, #v-top, #v-front, #v-side, #details, #outliner and #compile elements: the view and panel modules
// mount into them first, then mount() hands them to dockview. A panel without an element in index.html (#textures)
// gets one from pane(). dockview-core is loaded by index.html as a classic script (its ESM build carries no CSS) and
// read from globalThis['dockview-core'] here.
import { cfg, saveCfg } from './settings.js';
import { $, el } from './dom.js';
import { emit } from './bus.js';
import { DEFAULT_LAYOUT } from './defaultlayout.js';

// Details: the narrowest its rows fit without cutting off values (see the .dr comment in details.css).
const VIEW = { minimumWidth: 200, minimumHeight: 150 }, SIDE = { minimumWidth: 260, minimumHeight: 120 }, DETAILS = 344;

// near: where show() puts a closed panel back, [anchor panel, side of the anchor's group].
export const PANELS = [
  { id: '3d', title: '3D', ...VIEW, near: ['top', 'left'] },
  { id: 'top', title: 'Top', ...VIEW, near: ['3d', 'right'] },
  { id: 'front', title: 'Front', ...VIEW, near: ['3d', 'bottom'] },
  { id: 'side', title: 'Side', ...VIEW, near: ['top', 'bottom'] },
  { id: 'details', title: 'Details', ...SIDE, minimumWidth: DETAILS, near: ['outliner', 'top'] },
  { id: 'outliner', title: 'Outliner', ...SIDE, near: ['details', 'bottom'] },
  { id: 'compile', title: 'Compile', ...SIDE, near: ['outliner', 'center'] },
  { id: 'textures', title: 'Textures', ...SIDE, near: ['outliner', 'center'] },
];
const VIEWS2D = ['top', 'front', 'side'], VIEWS = ['3d', ...VIEWS2D];

// The default layout as dockview JSON (defaultlayout.js: the tool panels round the viewports, outliner left, details
// right): a copy, laid out by dockview at the workspace's real size (the viewports take the difference).
export const defaultLayout = () => structuredClone(DEFAULT_LAYOUT.dock);

let api = null, els = {}, timer = 0, known = DEFAULT_LAYOUT.panels;

// a: a DockviewApi (or anything with fromJSON).
export const buildDefault = (a = api) => a.fromJSON(defaultLayout());

// Restores a saved toJSON() layout as it was: panels the user closed stay closed. One that throws or has no viewport
// falls back to the default. True when restored.
export function restore(a, saved) {
  if (saved) {
    try {
      a.fromJSON(saved);
      if (VIEWS.some(id => a.getPanel(id))) return true;
    } catch (e) { console.warn('Saved layout rejected, using the default:', e); }
  }
  buildDefault(a);
  return false;
}

const unmax = () => api.hasMaximizedGroup() && api.exitMaximizedGroup();

// Toggles the maximized group; panel defaults to the active one, or, when that is a panel of command buttons (a button
// in it was clicked: the Tools panels, custom panels), the last other panel that was active (a viewport at first).
let work = null;
const cmdPanel = p => !!els[p?.id]?.classList.contains('cmdpanel');
const target = () => { const a = api.activePanel; return !a || !cmdPanel(a) ? a : (work && api.getPanel(work)) ?? api.getPanel('3d') ?? a; };
export function maximize(panel = target()) {
  if (api.hasMaximizedGroup()) api.exitMaximizedGroup();
  else if (panel) api.maximizeGroup(panel);
}

// Brings a panel to the front, or puts a closed one back beside its anchor (a tab in the active group when the anchor
// is closed too). moveTo splits only the anchor's group, as a drop does; addPanel next to it would even out the row.
// front = false adds a closed panel as a background tab.
export function show(id, front = true) {
  const n = nestedOf(id); // a panel in a custom panel's own dock: show that custom panel and the panel in it
  if (n) return front && n();
  unmax();
  const open = api.getPanel(id);
  if (open) return front && open.api.setActive();
  const { near: [ref, side], size, ...o } = PANELS.find(x => x.id === id), anchor = api.getPanel(ref);
  const p = api.addPanel({ ...o, component: id, inactive: true, position: anchor && { referencePanel: anchor, direction: 'within' } });
  if (anchor && side !== 'center') {
    p.api.moveTo({ group: anchor.group, position: side });
    if (size) p.group.api.setSize(side === 'top' || side === 'bottom' ? { height: size } : { width: size }); // else half the anchor's
  }
  if (front) p.api.setActive();
}

// Brings an open panel that is a background tab to the front of its group (a closed one stays closed).
export function reveal(id) {
  const p = api?.getPanel(id);
  if (p && p.group.activePanel !== p) p.api.setActive();
}

// Removes the three 2D viewports, or brings them back when none is open. The details column keeps its width
// (closing a group evens out the rest of its row).
export function toggle2d() {
  unmax();
  const g = api.getPanel('details')?.group, w = g?.width;
  const open = VIEWS2D.map(id => api.getPanel(id)).filter(Boolean);
  if (open.length) open.forEach(p => api.removePanel(p));
  else VIEWS2D.forEach(show);
  if (w) g.api.setSize({ width: w });
}

export function reset() {
  unmax();
  buildDefault();
  for (const p of [...api.panels]) if (nestedOf(p.id)) api.removePanel(p); // they stay where the user put them
  known = DEFAULT_LAYOUT.panels;
  PANELS.forEach(p => known.includes(p.id) || show(p.id, false)); // closed in the default stay closed
}

// A panel from a feature module: { id, title, element, near = 'outliner', side = 'center', size, minimumWidth = 260,
// minimumHeight = 120 }. Before or after mount(); it opens the first time as a background tab in near's group (side
// 'center'), or splits that group (side 'top', 'bottom', 'left', 'right'; size: the new group's height or width in px),
// then the saved layout keeps it (closed stays closed). element defaults to pane(id). Adds the panel.<id> command.
export function registerPanel({ id, title, element, near = 'outliner', side = 'center', size, minimumWidth = SIDE.minimumWidth, minimumHeight = SIDE.minimumHeight }) {
  const p = { id, title, minimumWidth, minimumHeight, near: [near, side], ...(size && { size }) }, i = PANELS.findIndex(x => x.id === id);
  if (i < 0) PANELS.push(p); else PANELS[i] = p;
  MIN[id] = p;
  // A saved layout restored before this call holds a placeholder (see mount): the content goes inside it.
  if (element && els[id] && els[id] !== element) els[id].replaceChildren(element);
  else if (element) els[id] = element;
  else pane(id);
  applyZoom(id);
  import('./commands.js').then(C => C.register(`panel.${id}`, { title: `Window: ${title}`, run: () => show(id) }));
  if (api && !known.includes(id) && !api.getPanel(id)) show(id, false);
}

// Panels can sit in a custom panel's own dock (custompanels.js): fn(id) returns a function that shows such a panel, or
// null when the main dock has it.
let nestedOf = () => null;
export const setNestedLocator = fn => { nestedOf = fn; };
export const mainApi = () => api;

// Removes a registered panel for good (a deleted custom panel): from the dock, the panel list and the stash.
export function unregisterPanel(id) {
  const p = api?.getPanel(id);
  if (p) api.removePanel(p);
  const i = PANELS.findIndex(x => x.id === id);
  if (i >= 0) PANELS.splice(i, 1);
  delete MIN[id];
  els[id]?.remove();
  delete els[id];
  import('./commands.js').then(C => C.unregister(`panel.${id}`));
}
// A new title for a registered panel: its tab and its Window: command.
export function renamePanel(id, title) {
  const p = PANELS.find(x => x.id === id);
  if (!p) return;
  p.title = title;
  api?.getPanel(id)?.api.setTitle(title);
  import('./commands.js').then(C => C.register(`panel.${id}`, { title: `Window: ${title}`, run: () => show(id) }));
}

// Zoom: - and = (Ctrl too; Ctrl+0 resets) scale the focused panel's contents (the panel last clicked, not a viewport), kept per panel in
// cfg.panelZoom. nextZoom: z one step d further, 60 % to 200 %.
let focused = null;
export const nextZoom = (z, d) => Math.round(Math.min(2, Math.max(0.6, z + d)) * 10) / 10;
const zoomOf = id => cfg.panelZoom?.[id] ?? 1;
const applyZoom = id => { const s = els[id]?.style; if (s) s.zoom = zoomOf(id) === 1 ? '' : zoomOf(id); };
const canZoom = () => !!focused && !VIEWS.includes(focused) && !!els[focused];
function zoom(z) {
  if (!canZoom()) return;
  cfg.panelZoom = { ...cfg.panelZoom, [focused]: z };
  saveCfg();
  applyZoom(focused);
}
// The panel whose content holds element n (the innermost: a custom panel's own dock holds panels too), or null.
function panelOf(n) {
  for (; n; n = n.parentElement) for (const id in els) if (els[id] === n) return id;
  return null;
}

// Window resizes go to the viewports: in a split that holds a viewport, the other panes keep their size and the
// viewports share the change. dockview's proportional layout keeps the size of a pane whose proportion is unset, so
// after it saves the proportions (a split added or removed, a sash dragged), the panes without a viewport get none.
// keepSizes(proportions, flex): flex[i] is true where pane i holds a viewport; no viewport in the split: unchanged.
export const keepSizes = (ps, flex) => (ps && flex.some(Boolean) ? ps.map((p, i) => (flex[i] ? p : undefined)) : ps);
const hasView = n => (n?.children ? n.children.some(hasView) : !!n?.view?.panels?.some(p => VIEWS.includes(p.id)));
function pinSizes(root) {
  const proto = root?.splitview && Object.getPrototypeOf(root.splitview);
  if (!proto?.saveProportions || proto.saveProportions.pinned) return;
  const save = proto.saveProportions;
  proto.saveProportions = function () {
    save.call(this);
    this._proportions = keepSizes(this._proportions, this.viewItems.map(i => hasView(i.view)));
  };
  proto.saveProportions.pinned = true;
  // A pane removed (closed, its last tab moved away): dockview evens out all the panes left in its split. Instead its
  // space goes to one pane: a viewport's in that split, else the pane before it (after it when it was first); the
  // others keep their edges. When the removal folds a split into its parent, dockview removes the split and adds what
  // was left of it at the same place: that add takes the space back from the same pane (refill), so nothing moves.
  const remove = proto.removeView, add = proto.addView;
  proto.removeView = function (index, sizing, skipLayout) {
    this.refill = null;
    const item = this.viewItems[index];
    if (sizing?.type !== 'distribute' || skipLayout || !item) return remove.call(this, index, sizing, skipLayout);
    const freed = item.size, view = remove.call(this, index, undefined, true), items = this.viewItems;
    if (items.length) {
      const hi = items.findIndex(i => i.priority === 'high'), t = hi >= 0 ? hi : Math.max(0, index - 1);
      items[t].size += freed;
      this.refill = { index, target: t, left: freed }; // for the very next adds only
    }
    this.relayout();
    return view;
  };
  proto.addView = function (view, size, index = this.viewItems.length, skipLayout) {
    const r = this.refill;
    this.refill = null;
    if (r && typeof size === 'number' && index === r.index && !skipLayout && this.viewItems[r.target]) {
      const take = Math.min(size, r.left);
      this.viewItems[r.target].size -= take;
      if (r.left > take) this.refill = { index: index + 1, target: r.target >= index ? r.target + 1 : r.target, left: r.left - take };
    }
    return add.call(this, view, size, index, skipLayout);
  };
}
// Space a pane leaves (closed, moved, the 2D views off) goes to the viewports first: dockview gives it to the panes of
// high priority, so a group holding a viewport has that (on the groups' prototype, also those made later).
function viewsFirst(group) {
  const proto = group && Object.getPrototypeOf(group);
  if (!proto || Object.getOwnPropertyDescriptor(proto, 'priority')?.get?.views) return;
  const get = function () { return this.panels?.some(p => VIEWS.includes(p.id)) ? 'high' : 'normal'; };
  get.views = true;
  Object.defineProperty(proto, 'priority', { get, configurable: true });
}
// After a viewport moved to another group: the proportions and the splits' cached priorities again (they follow the
// panes that hold viewports).
let viewGroups = '';
function repin(root) {
  const key = VIEWS.map(id => api.getPanel(id)?.group.id).join();
  if (key === viewGroups || !root) return;
  viewGroups = key;
  const walk = n => { if (n.splitview) { n.invalidateCachedSizes?.(); n.splitview.saveProportions(); n.children.forEach(walk); } };
  walk(root);
}

// panels: the panel ids this editor had when it saved, so a panel added later is not taken for one the user closed.
const save = () => { cfg.layout = { dock: api.toJSON(), panels: PANELS.map(p => p.id) }; saveCfg(); };

// A floating group is laid out at its minimum even when its overlay is smaller, which clips it: grow the overlay.
// setSize on a floating group sets the overlay to that content size (plus the title bar); b is the overlay border.
function fitFloat(g, w, h) {
  const v = g.element.closest('.dv-grid-view'), b = v.parentElement.offsetWidth - v.offsetWidth;
  if (v.offsetWidth < w || v.offsetHeight < h) g.api.setSize({ width: Math.max(v.offsetWidth, w) + b, height: Math.max(v.offsetHeight, h) + b });
}

// dockview limits a group by its active tab only; use the largest minimum of all its tabs, so switching tabs never
// squeezes a panel. Taken from PANELS, which also replaces the minimums stored in an older saved layout.
const MIN = Object.fromEntries(PANELS.map(p => [p.id, p]));
export function constrain(a = api) {
  let changed = false;
  for (const g of a.groups) {
    const ps = g.panels.map(p => MIN[p.id]).filter(Boolean);
    if (!ps.length) continue;
    const minimumWidth = Math.max(...ps.map(p => p.minimumWidth)), minimumHeight = Math.max(...ps.map(p => p.minimumHeight));
    if (g.minimumWidth !== minimumWidth || g.minimumHeight !== minimumHeight) {
      // Twice: dockview re-caches the row's minimum before the group stores the new constraint, so the first is lost.
      g.api.setConstraints({ minimumWidth, minimumHeight });
      g.api.setConstraints({ minimumWidth, minimumHeight });
      changed = true;
    }
    if (g.api.location.type === 'floating') fitFloat(g, minimumWidth, minimumHeight);
    else if (g.width < minimumWidth || g.height < minimumHeight) changed = true; // e.g. a new split placed at 100 px
  }
  if (changed) a.layout(a.width, a.height, true); // grows a group that is below its minimum
}

// The content element of panel id: #v-<id> or #<id>, else a new .panel in the #panels stash. Kept in els: a hidden
// tab's or closed panel's element is out of the document, so modules that mount after the layout ask here.
export const pane = id => (els[id] ??= document.getElementById('v-' + id) ?? document.getElementById(id) ?? $('#panels').appendChild(el('div', { className: 'panel', id })));

export function mount(host) {
  const dv = globalThis['dockview-core'];
  PANELS.forEach(p => pane(p.id));
  api = dv.createDockview(host, {
    theme: dv.themeDark,
    floatingGroupBounds: 'boundedWithinViewport',
    // A saved panel not registered yet (registerPanel after mount) gets a placeholder that receives its content.
    createComponent: ({ name }) => ({ element: pane(name), init() {} }),
  });
  const grid = () => api.component?.gridview?.root; // dockview internals; without them resizes stay proportional
  pinSizes(grid());
  api.layout(host.clientWidth, host.clientHeight); // the default layout is sized from api.width/height
  // The window may not get smaller than the dock's panel minimums (plus the toolbar and status bar). While a group is
  // maximized the minimum stays the whole grid's, so leaving it never clips the layout.
  const fit = () => api.hasMaximizedGroup() || window.api.setMinSize(api.minimumWidth, api.minimumHeight + innerHeight - host.clientHeight);
  // 'layout': the panels moved or resized (the 2D views redraw: a canvas that changed group may not get a resize)
  api.onDidLayoutChange(() => { repin(grid()); constrain(); fit(); emit('layout'); clearTimeout(timer); timer = setTimeout(save, 300); }); // first: a fallback is saved too
  api.onDidMaximizedGroupChange(fit);
  if (restore(api, cfg.layout?.dock)) known = cfg.layout.panels ?? Object.keys(cfg.layout.dock.panels ?? {});
  viewsFirst(api.groups[0]);
  repin(grid());
  for (const p of PANELS) if (!known.includes(p.id)) show(p.id, false); // new since the layout was saved
  constrain();
  fit();
  // The dock's own containers never scroll (a scrollIntoView, a focus or a wheel can scroll an overflow: hidden box):
  // one that did would shift the panels in it, the views included.
  host.addEventListener('scroll', e => { const t = e.target; if (t.className?.startsWith?.('dv-') && (t.scrollTop || t.scrollLeft)) { t.scrollTop = 0; t.scrollLeft = 0; } }, true);
  for (const [id, e] of Object.entries(els)) e.querySelector(':scope > label')?.addEventListener('dblclick', () => maximize(api.getPanel(id)));
  // the focused panel (zoom): the one clicked in, or whose tab was clicked
  host.addEventListener('pointerdown', e => { focused = panelOf(e.target) ?? focused; }, true);
  api.onDidActivePanelChange(e => { if (e?.panel) { focused = e.panel.id; if (!cmdPanel(e.panel)) work = e.panel.id; } }); // { panel, origin }
  Object.keys(els).forEach(applyZoom);
  import('./commands.js').then(C => {
    C.register('panel.zoomIn', { title: 'Panel: larger (the focused panel, not viewports)', keys: ['=', 'plus', 'shift+plus', 'ctrl+=', 'ctrl+plus', 'ctrl+shift+plus'], when: canZoom, run: () => zoom(nextZoom(zoomOf(focused), 0.1)) });
    C.register('panel.zoomOut', { title: 'Panel: smaller (the focused panel, not viewports)', keys: ['-', 'ctrl+-'], when: canZoom, run: () => zoom(nextZoom(zoomOf(focused), -0.1)) });
    C.register('panel.zoomReset', { title: 'Panel: normal size (the focused panel)', keys: ['ctrl+0'], when: canZoom, run: () => zoom(1) });
  });
}
