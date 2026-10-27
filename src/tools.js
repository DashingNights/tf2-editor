// Tool panels, after 3ds Max's command panel. Tool options (panel id 'tools'): the active tool's options (poly edit,
// stairs, chamfer, roof and blockout put their option bars there through slot()). Then one dock panel per section of
// ROLLOUTS (id 'tools-<section>'): the main buttons (the top toolbar's, off unless cfg.showToolbar), gizmo and
// snapping, then command buttons for features that had only keys or palette entries. Each is a panel of its own, so
// it goes anywhere in the dock and a mode change never moves another. Buttons show an icon (ICONS) and their name, as
// wide as that, and wrap at the panel's width; the tooltip is the command's title and keys. A command not available now is greyed
// (a click says why in the status bar), a toggle shows its state (the command's `on`). Option bars fold; the folded
// ones are kept in cfg.toolsClosed.
import { registerPanel, pane, reveal, renamePanel } from './layout.js';
import { get, ready, list, chord } from './commands.js';
import { cfg, setCfg, saveCfg } from './settings.js';
import { S } from './state.js';
import { on } from './bus.js';
import { el } from './dom.js';
import { icon, has } from './icons.js';

// The icon of each command's button (icons.js); a command without one keeps a text button.
export const ICONS = {
  newMap: 'file-plus', open: 'folder-open', save: 'save', saveAs: 'save-all', 'settings.open': 'settings',
  compile: 'hammer', playtest: 'play', undo: 'undo-2', redo: 'redo-2',
  select: 'mouse-pointer-2', block: 'square-plus', entity: 'map-pin', 'tool.clip': 'slice', 'tool.stairs': 'chart-no-axes-column-increasing', 'stairs.clip': 'chart-no-axes-column-increasing', 'stairs.ramp': 'triangle',
  'tool.chamfer': 'octagon', 'tool.roof': 'house', 'tool.cordon': 'scan',
  'mode.vertex': 'circle-dot', 'mode.edge': 'slash', 'mode.face': 'square', 'mode.object': 'box', gridDown: 'minus', gridUp: 'plus',
  'gizmo.move': 'move', 'gizmo.rotate': 'rotate-3d', 'gizmo.scale': 'scale-3d', 'gizmo.none': 'mouse-pointer', 'gizmo.world': 'globe', 'gizmo.local': 'axis-3d',
  'snap.grid': 'grid-3x3', 'snap.vertex': 'dot', 'snap.edge': 'git-commit-horizontal', 'snap.intersection': 'crosshair', 'snap.face': 'square-dashed', 'snap.rotation': 'rotate-cw',
  'select.all': 'check-check', 'select.invert': 'arrow-left-right', 'select.sameMaterial': 'palette', 'select.sameClass': 'tag',
  'select.sameVisgroup': 'layers', 'select.byMaterial': 'paintbrush', 'hide.selected': 'eye-off', 'hide.isolate': 'focus', 'hide.unhideAll': 'eye',
  group: 'group', ungroup: 'ungroup', 'select.ignoreGroups': 'unlink', 'visgroup.create': 'list-plus',
  'brush.carve': 'scissors-line-dashed', 'brush.hollow': 'package-open', 'brush.transform': 'move-3d', 'brush.flipH': 'flip-horizontal',
  'brush.flipV': 'flip-vertical', drop: 'arrow-down-to-line', 'brush.snapToGrid': 'magnet', 'brush.snapSelection': 'grid-2x2-check',
  'align.left': 'align-start-vertical', 'align.right': 'align-end-vertical', 'align.top': 'align-start-horizontal', 'align.bottom': 'align-end-horizontal',
  'align.center': 'align-center-vertical', 'tie.detail': 'component', 'tie.world': 'earth', 'blockout.nodraw': 'square-x',
  'edit.copy': 'copy', 'edit.cut': 'scissors', 'edit.paste': 'clipboard-paste', 'edit.pasteAtCursor': 'mouse-pointer-click',
  'edit.pasteSpecial': 'clipboard-list', 'blockout.repeat': 'copy-plus',
  'mirror.toggle': 'flip-horizontal-2', 'mirror.ents': 'lamp', 'mirror.fromSelection': 'crosshair', 'mirror.axis': 'repeat',
  'mirror.base': 'arrow-right-left', 'mirror.selection': 'copy-check', 'mirror.blueToRed': 'refresh-cw',
  'cordon.toggle': 'scan-eye', 'cordon.fromSelection': 'scan-line', 'select.inside': 'square-dashed-bottom', 'select.touching': 'blend',
  renderTextured: 'image', renderFlat: 'paint-bucket', renderWireframe: 'shapes', 'view.renderLit': 'sun',
  'view.entityLines': 'waypoints', 'view.slopeTint': 'mountain', 'blockout.toggle': 'blocks',
  'aids.player': 'person-standing', 'aids.measure': 'ruler', 'aids.jump': 'arrow-up-from-line', 'aids.sentry': 'radar', 'aids.clearMeasures': 'eraser',
  focus: 'scan-search', 'layout.toggle2d': 'layout-grid', 'view.maximize': 'maximize-2', 'layout.reset': 'rotate-ccw', 'panel.custom.new': 'app-window',
  'map.goto': 'navigation', 'map.entityReport': 'list', 'map.properties': 'sliders-horizontal', 'material.replace': 'replace',
  'import.image': 'image-plus', 'prefab.save': 'package-plus', 'instances.reload': 'refresh-ccw', 'instances.edit': 'external-link',
  'instances.collapse': 'merge', 'figma.import': 'file-input', 'figma.update': 'file-diff', 'figma.adopt': 'file-check',
  'poly.selectAll': 'check-check', 'poly.grow': 'expand', 'poly.shrink': 'shrink', 'poly.weld': 'combine', 'poly.collapse': 'minimize-2',
  'poly.chamfer': 'octagon', 'poly.snap': 'magnet', 'poly.remove': 'trash-2', 'poly.slice': 'slice', 'poly.connect': 'cable',
  'poly.loop': 'infinity', 'poly.ring': 'circle-dashed', 'poly.extrude': 'move-up', 'poly.inset': 'frame', 'poly.bevel': 'triangle',
  'poly.delete': 'trash', 'poly.detach': 'split',
};
// A command button with its icon before its name (the tooltip comes from the command, sync()).
export function iconize(b) {
  const id = b.dataset.cmd ?? b.dataset.cmd2, name = ICONS[id];
  if (!name || !has(name) || b.querySelector(':scope > .ico')) return;
  const t = b.textContent.trim();
  b.replaceChildren(icon(name), ...(t ? [el('span', { textContent: t })] : []));
  b.classList.add('ib');
}
// { id, title, rows }: a row is [caption, ...[label, command id]] (caption '' for none; it is the row's tooltip).
export const ROLLOUTS = [
  { id: 'file', title: 'File', rows: [
    ['File', ['New', 'newMap'], ['Open', 'open'], ['Save', 'save'], ['Save as', 'saveAs'], ['Settings', 'settings.open']],
    ['Run', ['Compile', 'compile'], ['Playtest', 'playtest']],
  ] },
  { id: 'undo', title: 'Undo', rows: [['', ['Undo', 'undo'], ['Redo', 'redo']]] },
  // id 'main': the panel of the former Main section (a saved layout keeps where it is)
  { id: 'main', title: 'Tools', rows: [
    ['Tool', ['Select', 'select'], ['Block', 'block'], ['Entity', 'entity'], ['Clip', 'tool.clip'], ['Stairs / ramp', 'tool.stairs'], ['Chamfer', 'tool.chamfer'], ['Roof', 'tool.roof'], ['Cordon', 'tool.cordon']],
  ] },
  { id: 'level', title: 'Edit mode', rows: [['Edit', ['Vertex', 'mode.vertex'], ['Edge', 'mode.edge'], ['Face', 'mode.face'], ['Object', 'mode.object']]] },
  { id: 'grid', title: 'Grid', rows: [['Grid', ['Grid smaller', 'gridDown'], ['Grid larger', 'gridUp']]] },
  { id: 'gizmo', title: 'Gizmo and snapping', rows: [
    ['Gizmo', ['Move', 'gizmo.move'], ['Rotate', 'gizmo.rotate'], ['Scale', 'gizmo.scale'], ['None', 'gizmo.none']],
    ['Axes', ['World axes', 'gizmo.world'], ['Local axes', 'gizmo.local']],
    ['Snap', ['Grid snap', 'snap.grid'], ['Vertex snap', 'snap.vertex'], ['Edge snap', 'snap.edge'], ['Intersection snap', 'snap.intersection'], ['Face snap', 'snap.face']],
    ['Rotate', ['Rotation snap', 'snap.rotation']],
  ] },
  { id: 'select', title: 'Selection', rows: [
    ['', ['All', 'select.all'], ['Invert', 'select.invert'], ['Same material', 'select.sameMaterial'], ['Same class', 'select.sameClass'], ['Same visgroup', 'select.sameVisgroup'], ['By current material', 'select.byMaterial']],
    ['', ['Hide', 'hide.selected'], ['Isolate', 'hide.isolate'], ['Unhide all', 'hide.unhideAll']],
    ['', ['Group', 'group'], ['Ungroup', 'ungroup'], ['Ignore groups', 'select.ignoreGroups'], ['Visgroup from selection', 'visgroup.create']],
  ] },
  { id: 'brush', title: 'Brushes', rows: [
    ['', ['Carve', 'brush.carve'], ['Hollow...', 'brush.hollow'], ['Transform...', 'brush.transform']],
    ['', ['Flip H', 'brush.flipH'], ['Flip V', 'brush.flipV'], ['Drop to surface', 'drop']],
    ['Snap', ['Snap each to grid', 'brush.snapToGrid'], ['Snap as one', 'brush.snapSelection']],
    ['Align', ['Align left', 'align.left'], ['Align right', 'align.right'], ['Align top', 'align.top'], ['Align bottom', 'align.bottom'], ['Align center', 'align.center']],
    ['Tie', ['To func_detail', 'tie.detail'], ['To world', 'tie.world'], ['Nodraw hidden faces', 'blockout.nodraw']],
    ['Clip', ['Clip stairs', 'stairs.clip']],
  ] },
  { id: 'edit', title: 'Clipboard', rows: [
    ['', ['Copy', 'edit.copy'], ['Cut', 'edit.cut'], ['Paste', 'edit.paste'], ['Paste at cursor', 'edit.pasteAtCursor'], ['Paste special...', 'edit.pasteSpecial'], ['Repeat duplicate', 'blockout.repeat']],
  ] },
  { id: 'mirror', title: 'Mirror', rows: [
    ['', ['Live mirror', 'mirror.toggle'], ['Decor entities', 'mirror.ents']],
    ['Plane', ['Plane at selection', 'mirror.fromSelection'], ['Switch axis', 'mirror.axis'], ['Swap BLU side', 'mirror.base']],
    ['Now', ['Mirror selection', 'mirror.selection'], ['Rebuild RED from BLU', 'mirror.blueToRed']],
  ] },
  { id: 'cordon', title: 'Cordon', rows: [
    ['', ['Draw', 'tool.cordon'], ['Cordon on', 'cordon.toggle'], ['From selection', 'cordon.fromSelection']],
    ['Select', ['Select inside', 'select.inside'], ['Select touching', 'select.touching']],
  ] },
  { id: 'view', title: 'View', rows: [
    ['Render', ['Textured', 'renderTextured'], ['Flat', 'renderFlat'], ['Wireframe', 'renderWireframe'], ['Lit', 'view.renderLit']],
    ['Show', ['Entity lines', 'view.entityLines'], ['Slope tint', 'view.slopeTint'], ['Blockout mode', 'blockout.toggle']],
    ['Aids', ['Player box', 'aids.player'], ['Measure', 'aids.measure'], ['Jump bands', 'aids.jump'], ['Sentry range', 'aids.sentry'], ['Clear measures', 'aids.clearMeasures']],
    ['Layout', ['Focus', 'focus'], ['2D views', 'layout.toggle2d'], ['Maximize view', 'view.maximize'], ['Reset layout', 'layout.reset'], ['New custom panel', 'panel.custom.new']],
  ] },
  { id: 'map', title: 'Map', rows: [
    ['', ['Go to...', 'map.goto'], ['Entity report', 'map.entityReport'], ['Properties', 'map.properties']],
    ['', ['Replace material...', 'material.replace'], ['Import image...', 'import.image'], ['Save prefab...', 'prefab.save']],
    ['Instances', ['Reload instances', 'instances.reload'], ['Open instance', 'instances.edit'], ['Collapse instances', 'instances.collapse']],
    ['Figma', ['Figma import...', 'figma.import'], ['Figma update...', 'figma.update'], ['Figma adopt...', 'figma.adopt']],
  ] },
];
// Where a section panel opens the first time: below the tool options Tools (File, Undo, Edit mode and Grid as tabs
// beside it), then Gizmo and snapping, then Selection with the other sections as tabs beside it (a split's height comes
// from the groups below it, so Selection gives it up). Registered in this order, so an anchor is open before what it
// anchors.
const NEAR = [['select', 'tools', 'bottom'], ['main', 'tools', 'bottom', 160], ['gizmo', 'tools-select', 'top', 190],
  ...['file', 'undo', 'level', 'grid'].map(id => [id, 'tools-main', 'center'])];
const near = id => NEAR.find(n => n[0] === id)?.slice(1) ?? ['tools-select', 'center'];
const rank = r => { const i = NEAR.findIndex(n => n[0] === r.id); return i < 0 ? NEAR.length : i; };

// The panels are built on first use (a tool's slot() at mount, or mount()), not at import: tests import the tools.
let root = null, slots;
function init() {
  if (root) return;
  registerPanel({ id: 'tools', title: 'Tool options', near: 'details', side: 'bottom', minimumWidth: 160, minimumHeight: 60 });
  root = panel('tools');
  slots = root.appendChild(el('div', { className: 'slots', title: '' }));
  for (const r of [...ROLLOUTS].sort((a, b) => rank(a) - rank(b))) {
    const id = 'tools-' + r.id, [n, side, size] = near(r.id);
    registerPanel({ id, title: r.title, near: n, side, size, minimumWidth: 160, minimumHeight: 60 });
    panel(id).append(el('div', { className: 'tb' }, ...rowsOf(r)));
  }
}
function panel(id) {
  const e = pane(id);
  e.classList.add('cmdpanel');
  e.dataset.panel = id;
  roots.add(e);
  return e;
}
const closed = () => new Set(cfg.toolsClosed ?? []);
function rollout(id, title, kids) {
  const d = el('details', { className: 'tr', open: !closed().has(id) }, el('summary', { textContent: title }), el('div', { className: 'tb' }, ...kids));
  d.dataset.id = id;
  d.ontoggle = () => {
    const c = closed();
    if (d.open) c.delete(id); else c.add(id);
    cfg.toolsClosed = [...c];
    saveCfg();
  };
  return d;
}

// The rows of rollout r (an entry of ROLLOUTS): the Tools panel's, and the copies custom panels show.
export function rowsOf(r) {
  const rows = r.rows.map(([cap, ...bs]) => el('div', { className: 'row', title: cap }, cap ? el('span', { className: 'cap', textContent: cap }) : '', ...bs.map(button)));
  if (r.id === 'gizmo') rows.at(-1).append(rotStep());
  if (r.id === 'grid') rows.at(-1).append(el('b', { className: 'gridval', title: 'Grid size' }));
  if (r.id === 'brush') rows.at(-1).append(clipKind());
  return rows;
}

// A rollout for a tool's option bar: the module appends its bar to the returned element. The rollout shows while the
// bar does (the module hides the bar while its tool is off); a bar that shows brings its panel to the front. It sits
// in the Tools panel unless a custom panel holds it (setSlotHost).
const slotEls = new Map();
let hostFor = () => null;
export function slot(id, title) {
  init();
  const r = rollout(id, title, []);
  r.dataset.title = title;
  slotEls.set(id, r);
  (hostFor(id) ?? slots).append(r);
  new MutationObserver(ms => { if (ms.some(m => !m.target.hidden && m.target.parentElement === r.lastChild)) reveal(r.closest('[data-panel]')?.dataset.panel ?? 'tools'); })
    .observe(r, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
  return r.lastChild;
}
// host(id): the element a custom panel keeps for slot id, or null.
export const setSlotHost = host => { hostFor = host; };
export const slotEl = id => slotEls.get(id) ?? null;
export const slotList = () => [...slotEls].map(([id, r]) => [id, r.dataset.title]);
export function returnSlot(id) { const r = slotEls.get(id); if (r && root) slots.append(r); }

const button = ([label, id]) => { const b = el('button', { textContent: label }); b.dataset.cmd = id; iconize(b); return b; };
// Clip stairs: what the ramp blocks (cfg.stairClip): players only (a player clip), or everything (Block Bullets 2).
const clipKind = () => {
  const s = el('select', { className: 'clipkind', title: 'What the stairs ramp blocks: players only (a player clip: projectiles and bullets hit the steps), or everything (Block Bullets 2: players, projectiles, bullets and splash)', onchange: () => setCfg('stairClip', s.value) },
    el('option', { value: 'players', textContent: 'Players' }), el('option', { value: 'all', textContent: 'Everything' }));
  return s;
};
const rotStep = () => { const s = el('select', { className: 'rotstep', title: 'Rotation snap step (degrees)', onchange: () => setCfg('rotationStep', +s.value) }); return s; };

// Panels whose command buttons show availability and toggle state: the Tools panel and the custom panels.
const roots = new Set();
export function addRoot(e) { roots.add(e); later(); }
export const removeRoot = e => roots.delete(e);

const tip = c => c.title + (c.keys.length ? ` (${c.keys.map(chord).join(', ')})` : '');
function sync() {
  const keys = new Map(list().map(c => [c.id, c]));
  const steps = [...new Set([5, 15, 45, 90, +cfg.rotationStep || 15])].sort((a, b) => a - b);
  for (const r of roots) {
    for (const b of r.querySelectorAll('button[data-cmd2]')) { iconize(b); const c = keys.get(b.dataset.cmd2); if (c && !b.title) b.title = tip(c); }
    for (const b of r.querySelectorAll('button[data-cmd]')) {
      iconize(b);
      const c = get(b.dataset.cmd);
      b.hidden = !c;
      if (!c) continue;
      b.classList.toggle('on', !!c.on?.());
      b.classList.toggle('na', !ready(c));
      b.title = tip(keys.get(c.id) ?? c);
    }
    for (const g of r.querySelectorAll('.gridval')) g.textContent = S.grid;
    for (const s of r.querySelectorAll('select.clipkind')) s.value = cfg.stairClip === 'all' ? 'all' : 'players';
    for (const s of r.querySelectorAll('select.rotstep')) {
      if (s.options.length !== steps.length) s.replaceChildren(...steps.map(x => el('option', { value: x, textContent: `${x} deg` })));
      s.value = +cfg.rotationStep || 15;
    }
  }
}
let queued = false;
const later = () => { if (!queued) { queued = true; queueMicrotask(() => { queued = false; sync(); }); } };
export const refresh = later;

// After the feature modules registered their commands.
export function mount() {
  init();
  // a layout saved before keeps the old titles
  for (const [id, t] of [['tools', 'Tool options'], ...ROLLOUTS.map(r => ['tools-' + r.id, r.title])]) renamePanel(id, t);
  for (const t of ['cmd', 'tool', 'selection', 'cfg', 'mirror', 'gizmo', 'doc', 'file', 'filters', 'grid']) on(t, later);
  sync();
}
