// Map dialogs: Entity report (Hammer's), Go to (coordinates or an id), Map properties (worldspawn in the details
// panel), Select same visgroup, Check for problems and Weld planes, and form(), a small modal form the other organise
// modules share.
import * as V from '../vmf.js';
import * as W from './weldgeo.js';
import { on } from './bus.js';
import { doc, sel, cache, objects, nodesOf, boxOf, setSelection, deleteSel, showWorld, setCursor, groupOf, change } from './state.js';
import { register } from './commands.js';
import { focus } from './view3d.js';
import { show } from './layout.js';
import { vgIds } from './outliner.js';
import { ask, notice } from './dialog.js';
import { el } from './dom.js';

// Modal form: fields [{ key, label, value, type: 'text' | 'checkbox' }]. Resolves { key: value } on OK (Enter), null
// on Cancel (Escape).
export function form(title, fields, ok = 'OK') {
  const d = document.body.appendChild(el('dialog', { className: 'org-form' }));
  const inputs = fields.map(f => el('input', f.type === 'checkbox' ? { type: 'checkbox', checked: !!f.value } : { value: f.value ?? '', spellcheck: false }));
  d.append(el('form', { method: 'dialog' }, el('p', { textContent: title }),
    ...fields.map((f, i) => el('label', {}, el('span', { textContent: f.label }), inputs[i])),
    el('div', { className: 'row' }, el('button', { className: 'primary', value: 'ok', textContent: ok }), el('button', { type: 'button', textContent: 'Cancel', onclick: () => d.close() }))));
  d.returnValue = '';
  d.showModal();
  inputs[0]?.select?.();
  return new Promise(res => {
    d.onclose = () => {
      d.remove();
      res(d.returnValue === 'ok' ? Object.fromEntries(fields.map((f, i) => [f.key, f.type === 'checkbox' ? inputs[i].checked : inputs[i].value])) : null);
    };
  });
}

// Selects an object's visible nodes and frames the object (hidden too).
function goTo(o) {
  const cs = nodesOf(o).map(n => cache.get(n)).filter(Boolean);
  if (!cs.length) return;
  setSelection(cs.filter(c => c.visible).map(c => c.node));
  focus(boxOf(cs));
  if (!cs.some(c => c.visible)) setCursor('That object is hidden (Unhide all: U)');
}

// ---------- entity report ----------
// Rows: { e, cls, name, id, brush }. Filters: class and name substrings, kind 'all' | 'point' | 'brush', and Hammer's
// By key/value: a key (whole name) and a value (substring, or the whole value with exact), either may be empty.
export const entityRows = ents => ents.map(e => ({ e, cls: V.get(e, 'classname') ?? '', name: V.get(e, 'targetname') ?? '', id: V.get(e, 'id') ?? '', brush: V.kids(e, 'solid').length > 0 }));
const lc = s => s.toLowerCase();
const kvMatch = (e, key, value, exact) => (!key && !value) || e.kv.some(([k, v]) => (!key || lc(k) === lc(key)) && (exact ? lc(v) === lc(value) : lc(v).includes(lc(value))));
export const filterRows = (rows, { cls = '', name = '', kind = 'all', key = '', value = '', exact = false }) => rows.filter(r => lc(r.cls).includes(lc(cls))
  && lc(r.name).includes(lc(name)) && (kind === 'all' || r.brush === (kind === 'brush')) && kvMatch(r.e, key.trim(), value, exact));

let rep = null; // the open report: { d, refresh }
function report() {
  if (rep) return rep.d.querySelector('input').focus();
  const cls = el('input', { placeholder: 'Class contains' }), name = el('input', { placeholder: 'Name contains' });
  const kind = el('select', {}, ...[['all', 'All'], ['point', 'Point'], ['brush', 'Brush']].map(([value, textContent]) => el('option', { value, textContent })));
  const key = el('input', { placeholder: 'Key' }), value = el('input', { placeholder: 'Value contains' }), exact = el('input', { type: 'checkbox' });
  const body = el('tbody'), count = el('small'), picked = new Set();
  const del = () => {
    const es = [...picked];
    if (!es.length) return;
    setSelection(es.flatMap(nodesOf));
    deleteSel();
    picked.clear();
  };
  const props = () => { setSelection([...picked].flatMap(nodesOf)); show('details'); };
  const refresh = () => {
    value.placeholder = exact.checked ? 'Value is' : 'Value contains';
    const rows = filterRows(entityRows(objects().filter(n => n.name === 'entity')), { cls: cls.value, name: name.value, kind: kind.value, key: key.value, value: value.value, exact: exact.checked });
    for (const e of picked) if (!rows.some(r => r.e === e)) picked.delete(e);
    count.textContent = `${rows.length} entities`;
    body.replaceChildren(...rows.map(r => {
      const tr = el('tr', { className: picked.has(r.e) ? 'on' : '' }, el('td', { textContent: r.cls }), el('td', { textContent: r.name }), el('td', { textContent: r.id }));
      tr.onclick = ev => {
        if (!ev.ctrlKey) picked.clear();
        picked.has(r.e) && ev.ctrlKey ? picked.delete(r.e) : picked.add(r.e);
        goTo(r.e);
        refresh();
      };
      return tr;
    }));
  };
  const d = document.body.appendChild(el('dialog', { className: 'org-report' },
    el('p', {}, el('b', { textContent: 'Entity report ' }), count),
    el('div', { className: 'row' }, cls, name, kind),
    el('div', { className: 'row' }, key, value, el('label', { title: 'The value must match whole' }, exact, ' Exact')),
    el('div', { className: 'org-table' }, el('table', {}, el('thead', {}, el('tr', {}, ...['Class', 'Name', 'ID'].map(t => el('th', { textContent: t })))), body)),
    el('div', { className: 'row' }, el('button', { textContent: 'Delete', title: 'Delete the picked entities (Delete)', onclick: del }),
      el('button', { textContent: 'Properties', title: 'Select the picked entities and show the Details panel', onclick: props }),
      el('button', { className: 'primary', textContent: 'Close', onclick: () => d.close() }))));
  cls.oninput = name.oninput = key.oninput = value.oninput = kind.onchange = exact.onchange = refresh;
  // Not modal, so the views stay usable; its keys stay here.
  d.onkeydown = e => {
    e.stopPropagation();
    if (e.key === 'Escape') d.close();
    else if (e.key === 'Delete' && !e.target.matches('input')) del();
  };
  const off = on('doc', refresh);
  d.onclose = () => { off(); d.remove(); rep = null; };
  rep = { d, refresh };
  refresh();
  d.show();
  cls.focus();
}

// ---------- go to ----------
// "x y z" frames that point; one number selects and frames the solid, entity or face (its solid) with that id.
async function goto() {
  const r = await form('Go to: coordinates (x y z) or a brush, entity or face id', [{ key: 'q', label: 'Go to', value: '' }]);
  const n = r && V.nums(r.q);
  if (!n) return;
  if (n.length === 3) return focus([n.map(x => x - 64), n.map(x => x + 64)]);
  if (n.length !== 1) return notice('Enter three coordinates (x y z) or one id.');
  // a point entity's faces are its generated box (side ids '0')
  const id = String(n[0]), face = c => !c.point && c.faces.some(f => V.get(f.side, 'id') === id);
  const c = [...cache.values()].find(c => V.get(c.node, 'id') === id || (c.owner !== doc.world && V.get(c.owner, 'id') === id) || face(c));
  if (!c) return notice(`No brush, entity or face has id ${id}.`);
  goTo(c.owner === doc.world || V.get(c.node, 'id') === id || face(c) ? c.node : c.owner);
}

// ---------- selection ----------
// Every visible object in a visgroup of a selected object (an entity counts with its solids).
function sameVisgroup() {
  const objOf = c => (c.owner === doc.world ? c.node : c.owner), ids = o => [o, ...V.kids(o, 'solid'), groupOf(o)].filter(Boolean).flatMap(vgIds);
  const want = new Set([...sel].flatMap(n => ids(objOf(cache.get(n)))));
  if (!want.size) return setCursor('The selection is in no visgroup');
  setSelection([...cache.values()].filter(c => c.visible && ids(objOf(c)).some(id => want.has(id))).map(c => c.node));
}

// ---------- check for problems ----------
// Hammer's Check for problems (Alt+P). So far the plane checks of weldgeo.js: brush sides on almost the same plane (black
// faces in game) and sides that repeat their brush's plane (vbsp: "duplicate plane"). Weld planes fixes both. Hidden
// objects count too: they compile once shown.
const solidsIn = n => n.children.flatMap(c => (c.name === 'solid' ? [c] : ['world', 'entity', 'hidden'].includes(c.name) ? solidsIn(c) : []));

async function checkProblems() {
  const { groups, duplicates } = W.check(solidsIn(doc.root));
  const brushes = new Set([...groups.flatMap(g => g.sides.map(s => s.solid)), ...duplicates.map(d => d.solid)]);
  if (!brushes.size) return notice('No problems found.');
  const found = [
    groups.length && `${groups.length} groups of brush sides lie on almost, but not exactly, the same plane (${groups.reduce((n, g) => n + g.sides.length, 0)} sides). vbsp can light such a face from behind, and it comes out black in game.`,
    duplicates.length && `${duplicates.length} brush sides repeat another side of their brush (vbsp: duplicate plane).`,
  ].filter(Boolean);
  const a = await ask(`${found.join(' ')} Weld planes moves each group onto one plane and removes the repeated sides, as one undo step.`, ['Weld planes', `Select ${brushes.size} brushes`, 'Close']);
  if (a === 0) weldPlanes();
  else if (a === 1) setSelection(brushes);
}

function weldPlanes() {
  let r;
  change(take => { r = W.weld(solidsIn(doc.root), s => take(s, true)); });
  const kept = r.kept ? ` ${r.kept} brushes kept their planes: welding them would lose or flatten a face. Fix those by hand (Check for problems, Select brushes).` : '';
  if (!r.moved && !r.dropped) return notice(kept ? kept.trim() : 'No brush sides to weld.');
  notice(`Welded ${r.groups} groups: ${r.moved} sides moved (at most ${r.maxMove.toFixed(2)} units), ${r.dropped} repeated sides removed.${kept} Undo puts it back.`);
}

export function mount() {
  register('map.checkProblems', { title: 'Map: check for problems', keys: ['alt+p'], run: checkProblems });
  register('map.weldPlanes', { title: 'Map: weld planes (brush sides on almost the same plane, black faces in game)', run: weldPlanes });
  register('map.entityReport', { title: 'Map: entity report', run: report });
  register('map.goto', { title: 'Map: go to coordinates or id...', keys: ['ctrl+shift+g'], run: goto });
  register('map.properties', { title: 'Map: properties (worldspawn)', run: () => { showWorld(); show('details'); } });
  register('select.sameVisgroup', { title: 'Select same visgroup', when: () => sel.size > 0, run: sameVisgroup });
}
