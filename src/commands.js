// Command registry. Toolbar buttons (data-cmd), keybindings and the Ctrl+K palette all read from it.
import * as V from '../vmf.js';
import { cfg, setCfg, keepRecent } from './settings.js';
import * as st from './state.js';
import * as layout from './layout.js';
import { el } from './dom.js';
import { notice } from './dialog.js';
import { emit } from './bus.js';

const cmds = new Map();
export const held = new Set(); // KeyboardEvent.code of keys held down (fly, Space pan)

// Canonical key string: modifiers in ctrl, shift, alt order, then the lower-cased key ('ctrl+shift+s'). The '+' key is
// 'plus'; an empty last part is a '+' saved before that ('shift++').
export function norm(k) {
  const p = k.toLowerCase().split('+'), key = p.pop() || 'plus';
  return [...['ctrl', 'shift', 'alt'].filter(m => p.includes(m)), key].join('+');
}
export const keyOf = e => [e.ctrlKey && 'ctrl', e.shiftKey && 'shift', e.altKey && 'alt', e.key === '+' ? 'plus' : e.key.toLowerCase()].filter(Boolean).join('+');

// keys: default bindings; cfg.keys[id] replaces them. when: the command is available only while it returns true.
// on: a toggle's state (true: on), for the buttons that show it (Tools panel).
export function register(id, { title, run, keys = [], when, on }) { cmds.set(id, { id, title, run, keys, when, on }); }
export const unregister = id => cmds.delete(id);

export const list = () => [...cmds.values()].map(c => ({ ...c, keys: (cfg.keys[c.id] ?? c.keys).map(norm) }));
export const ready = c => !c.when || c.when();
export const get = id => cmds.get(id);
// Runs c and tells listeners ('cmd': the Tools panel shows toggles and availability).
const exec = c => { const r = c.run(); emit('cmd', c.id); return r; };

// A command whose `when` fails says so in the status bar (a toolbar click would otherwise do nothing).
export function run(id) {
  const c = cmds.get(id);
  if (c && !ready(c)) return st.setCursor(`${c.title}: not available now (select something first)`);
  if (c) return exec(c);
}

const typing = e => e.target?.closest?.('textarea, select, [contenteditable], input:not([type=checkbox]):not([type=radio]):not([type=button])');

// Runs the command bound to a keydown. A matching command with `when` wins over one without.
export function dispatch(e) {
  held.add(e.code);
  // A modal dialog or a context menu (popover: Escape closes it) is open.
  if (st.S.fly || typing(e) || globalThis.document?.querySelector('dialog:modal, :popover-open')) return false;
  const k = keyOf(e), hits = list().filter(c => c.keys.includes(k) && ready(c));
  const c = hits.find(c => c.when) ?? hits[0];
  if (!c) return false;
  e.preventDefault();
  exec(c);
  return true;
}

// Higher is better, -1 is no match. Tiers: title prefix > substring at a word start > substring (earlier wins)
// > scattered letters (consecutive and word-start letters score more). Shorter titles win ties.
export function fuzzy(q, s) {
  q = q.toLowerCase();
  s = s.toLowerCase();
  const start = i => i === 0 || ' ./-_:('.includes(s[i - 1]);
  let i = s.indexOf(q);
  while (i > 0 && !start(i)) i = s.indexOf(q, i + 1);
  if (i >= 0) return (i ? 2000 : 3000) - i - s.length / 1000;
  if ((i = s.indexOf(q)) > 0) return 1000 - i - s.length / 1000;
  let score = 0, at = 0, prev = -2;
  for (const ch of q) {
    const j = s.indexOf(ch, at);
    if (j < 0) return -1;
    score += j === prev + 1 ? 3 : start(j) ? 2 : 1;
    prev = j;
    at = j + 1;
  }
  return score - s.length / 1000;
}

// ---------- palette ----------
let pal, input, ul, shown = [], cur = 0;

// 'Open recent: <name>' palette entries for cfg.recentFiles. Not registered, so the Keys settings do not list them.
const recentFiles = () => (cfg.recentFiles ?? []).map(f => ({ id: 'recent:' + f, title: 'Open recent: ' + f.split(/[\\/]/).pop(), keys: [], run: () => openRecent(f) }));

// Palette rows for query q (a leading '>' is ignored): { c, ok: when() passes, recent }. With an empty query the
// last 5 commands run from the palette come first, then the recent files. Available commands sort before
// unavailable (greyed) ones.
export function paletteItems(q) {
  q = q.replace(/^\s*>/, '').trim();
  const files = recentFiles(), cs = [...list(), ...files], recent = (cfg.recent ?? []).map(id => cs.find(c => c.id === id)).filter(Boolean);
  const items = q
    ? cs.map(c => ({ c, s: fuzzy(q, c.title) })).filter(x => x.s >= 0).sort((a, b) => b.s - a.s)
    : [...new Set([...recent, ...files, ...cs])].map(c => ({ c, recent: recent.includes(c) }));
  return items.map(x => ({ ...x, ok: ready(x.c) })).sort((a, b) => b.ok - a.ok);
}

// 'ctrl+shift+arrowleft' -> 'Ctrl+Shift+Left'
const KEY = { ' ': 'Space', arrowleft: 'Left', arrowright: 'Right', arrowup: 'Up', arrowdown: 'Down', pageup: 'PgUp', pagedown: 'PgDn', escape: 'Esc', delete: 'Del', plus: 'Plus' };
export const chord = k => k.split('+').map(p => KEY[p] ?? p[0].toUpperCase() + p.slice(1)).join('+');

function render() {
  shown = paletteItems(input.value);
  cur = Math.min(cur, Math.max(0, shown.length - 1));
  ul.replaceChildren(...shown.map(({ c, ok, recent }, i) => {
    const li = el('li', { className: [i === cur && 'on', !ok && 'off', recent && 'recent'].filter(Boolean).join(' '), title: c.id },
      el('span', { textContent: c.title }), el('kbd', { textContent: c.keys.map(chord).join(', ') }));
    li.onmousedown = e => { e.preventDefault(); pick(i); };
    return li;
  }));
  ul.children[cur]?.scrollIntoView({ block: 'nearest' });
}

export function openPalette() {
  pal.hidden = false;
  input.value = '';
  cur = 0;
  render();
  input.focus();
}
const close = () => { pal.hidden = true; input.blur(); };
function pick(i) {
  const x = shown[i];
  if (!x?.ok) return;
  close();
  setCfg('recent', [x.c.id, ...(cfg.recent ?? []).filter(id => id !== x.c.id)].slice(0, 5));
  exec(x.c);
}

function paletteKey(e) {
  if (e.key === 'Escape') close();
  else if (e.key === 'Enter') pick(cur);
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { cur = (cur + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % Math.max(1, shown.length); render(); }
  else return;
  e.preventDefault();
}

// Builds the palette in `el` and starts listening for keys and data-cmd clicks.
export function mount(host) {
  pal = host;
  pal.classList.add('palette');
  pal.hidden = true;
  input = el('input', { placeholder: 'Type a command', spellcheck: false, oninput: () => { cur = 0; render(); }, onkeydown: paletteKey, onblur: () => { pal.hidden = true; } });
  ul = el('ul');
  pal.replaceChildren(input, ul);
  addEventListener('keydown', dispatch);
  addEventListener('keyup', e => held.delete(e.code));
  addEventListener('blur', () => held.clear());
  document.addEventListener('click', e => {
    const b = e.target.closest?.('[data-cmd]');
    if (b) { b.blur(); run(b.dataset.cmd); }
  });
  // Buttons without their own tooltip show the command's title and keys.
  document.addEventListener('mouseover', e => {
    const b = e.target.closest?.('[data-cmd]:not([title])'), c = b && list().find(x => x.id === b.dataset.cmd);
    if (c) b.title = c.title + (c.keys.length ? ` (${c.keys.map(chord).join(', ')})` : '');
  });

}

// ---------- selection and visibility helpers ----------
const visible = () => [...st.cache.values()].filter(c => c.visible);
const clsOf = c => (c.owner === st.doc.world ? 'worldspawn' : V.get(c.owner, 'classname'));
const mat = side => (V.get(side, 'material') || '').toLowerCase();

function invert() { st.setSelection(visible().map(c => c.node).filter(n => !st.sel.has(n))); }

function sameClass() {
  const want = new Set([...st.sel].map(n => clsOf(st.cache.get(n))));
  st.setSelection(visible().filter(c => want.has(clsOf(c))).map(c => c.node));
}

// Face selection: every visible face with one of the selected faces' materials. Objects: every visible solid using
// one of the selected solids' materials; tools/* (nodraw on hidden faces) counts only when nothing else is used.
function sameMaterial() {
  const solids = visible().filter(c => !c.point);
  if (st.faceSel.size) {
    const want = new Set([...st.faceSel].map(mat));
    return st.setFaceSelection(solids.flatMap(c => c.faces.map(f => f.side)).filter(s => want.has(mat(s))));
  }
  const all = [...new Set([...st.sel].filter(n => n.name === 'solid').flatMap(n => V.kids(n, 'side').map(mat)))];
  const real = all.filter(m => !m.startsWith('tools/')), want = new Set(real.length ? real : all);
  st.setSelection(solids.filter(c => V.kids(c.node, 'side').some(s => want.has(mat(s)))).map(c => c.node));
}

// Hides every visible object outside the selection, saved like Hammer's H (one undo step; Unhide all restores it).
const isolate = () => st.hide(visible().filter(c => !st.sel.has(c.node)).map(c => c.node));

// ---------- recent files ----------
export async function openRecent(f) {
  if (await keepRecent(f)) return st.open(f);
  notice(`${f} was not found. It was removed from the recent files.`);
}

// A small modal list of the recent files; Escape cancels.
let picker;
function pickRecent() {
  const files = cfg.recentFiles ?? [];
  if (!files.length) return notice('No recent files yet.');
  picker ??= document.body.appendChild(el('dialog', { id: 'recent' }));
  const item = f => el('button', { textContent: f, style: 'display:block;width:100%;text-align:left;margin:0 0 4px', onclick: () => { picker.close(); openRecent(f); } });
  picker.replaceChildren(el('p', { textContent: 'Open recent' }), ...files.map(item),
    el('div', { className: 'row' }, el('button', { textContent: 'Cancel', onclick: () => picker.close() })));
  picker.showModal();
}

// ---------- core commands ----------
const any = () => st.sel.size > 0;
const zstep = () => (cfg.snapGrid ? st.S.grid : 1); // like the arrow-key nudge in the 2D views
const core = [
  ['palette', 'Command palette', openPalette, ['ctrl+k']],
  ['newMap', 'New map', st.newMap, ['ctrl+n']],
  ['open', 'Open map...', () => st.open(), ['ctrl+o']],
  ['save', 'Save', () => st.save(false), ['ctrl+s']],
  ['saveAs', 'Save as...', () => st.save(true), ['ctrl+shift+s']],
  ['file.openRecent', 'Open recent...', pickRecent, []],
  ['quit', 'Quit', () => window.api.closeWindow(), ['ctrl+q']],
  ['undo', 'Undo', st.undo, ['ctrl+z']],
  ['redo', 'Redo', st.redo, ['ctrl+y', 'ctrl+shift+z']],
  ['delete', 'Delete selection', st.deleteSel, ['delete']],
  ['deselect', 'Select none', st.clearSelection, ['escape']],
  ['select.all', 'Select all', () => st.setSelection(visible().map(c => c.node)), ['ctrl+a']],
  ['select.invert', 'Select inverse', invert, []],
  ['select.sameMaterial', 'Select same material', sameMaterial, [], () => st.sel.size + st.faceSel.size > 0],
  ['select.sameClass', 'Select same class', sameClass, [], any],
  ['hide.selected', 'Hide selection', st.hideSel, ['h'], any],
  ['hide.isolate', 'Isolate selection (hide the rest)', isolate, ['ctrl+h'], any],
  ['hide.unhideAll', 'Unhide all', st.unhideAll, ['u']],
  ['select', 'Tool: select', () => st.setTool('select'), ['v'], undefined, () => st.S.tool === 'select' && st.S.mode === 'object'],
  ['block', 'Tool: block', () => st.setTool('block'), ['b'], undefined, () => st.S.tool === 'block'],
  ['entity', 'Tool: entity', () => st.setTool('entity'), ['shift+e'], undefined, () => st.S.tool === 'entity'],
  ['gridDown', 'Grid: smaller', () => st.setGrid(st.S.grid / 2), ['[']],
  ['gridUp', 'Grid: larger', () => st.setGrid(st.S.grid * 2), [']']],
  ['raise', 'Nudge selection up (Z)', () => st.transformSel([1, 1, 1], [0, 0, zstep()]), ['pageup']],
  ['lower', 'Nudge selection down (Z)', () => st.transformSel([1, 1, 1], [0, 0, -zstep()]), ['pagedown']],
  ['tie.detail', 'Tie selection to func_detail', () => st.tieSel('func_detail'), ['ctrl+t'], any],
  ['tie.world', 'Move selection to world (untie)', st.untieSel, ['ctrl+shift+w'], any],
  ['snapVertices', 'Snap vertices to grid', () => { const n = st.snapSel(); st.setCursor(n ? `snap: ${n} brush(es) left as they were (would become invalid or stay off the grid)` : 'snapped to grid'); }, [], any],
  ['layout.reset', 'Layout: reset to default', layout.reset, []],
  ['layout.toggle2d', 'Layout: toggle 2D views', layout.toggle2d, []],
  ['view.maximize', 'View: maximize active pane (toggle)', layout.maximize, ['alt+enter']],
  ...layout.PANELS.map(p => [`panel.${p.id}`, `Window: ${p.title}`, () => layout.show(p.id), []]),
];
for (const [id, title, fn, keys, when, on] of core) register(id, { title, run: fn, keys, when, on });
