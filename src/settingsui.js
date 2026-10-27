// Settings dialog (Ctrl+,): categories on the left, a form built from settings.SCHEMA on the right, and a search box
// across categories. Changes apply live through setCfg. Also keeps cfg.recentFiles and the autosave timer.
import { on } from './bus.js';
import { cfg, setCfg, DEFAULTS, SCHEMA, addRecent } from './settings.js';
import { register, run, list, keyOf, chord } from './commands.js';
import { S, serialize } from './state.js';
import { ask } from './dialog.js';
import { el } from './dom.js';

let dlg, search, nav, form, cat = SCHEMA[0].id;

// ---------- pure helpers ----------
// q (lower case) found in any of the texts.
export const has = (q, ...texts) => texts.some(t => String(t ?? '').toLowerCase().includes(q));

// id -> titles of the other commands bound to one of its chords. Commands with `when` are contextual (Escape cancels
// whatever is active), so only commands without one conflict.
export function conflicts(cmds) {
  const by = new Map(), out = new Map();
  for (const c of cmds) if (!c.when) for (const k of c.keys) by.set(k, [...(by.get(k) ?? []), c]);
  for (const cs of by.values()) for (const c of cs) if (cs.length > 1) out.set(c.id, [...new Set([...(out.get(c.id) ?? []), ...cs.filter(x => x !== c).map(x => x.title)])]);
  return out;
}


// ---------- controls ----------
function control(r) {
  const v = cfg[r.key], id = 'st-' + r.key;
  if (r.type === 'bool') return el('input', { id, type: 'checkbox', checked: !!v, onchange: e => setCfg(r.key, e.target.checked) });
  if (r.type === 'color') return el('input', { id, type: 'color', value: v, oninput: e => setCfg(r.key, e.target.value) });
  if (r.type === 'select') {
    const s = el('select', { id }, ...r.options.map(([val, text], i) => el('option', { value: i, textContent: text ?? val })));
    s.value = r.options.findIndex(o => o[0] === v);
    s.onchange = () => setCfg(r.key, r.options[+s.value][0]);
    return s;
  }
  if (r.type === 'number') {
    const i = el('input', { id, type: 'number', min: r.min, max: r.max, step: r.step, value: v });
    // Live while typing when valid (range and step); on commit the value clamps and rounds to the step, garbage reverts.
    i.oninput = () => { if (i.value !== '' && i.validity.valid) setCfg(r.key, +i.value); };
    i.onchange = () => {
      if (i.value === '') return void (i.value = cfg[r.key]);
      const x = Math.min(r.max, Math.max(r.min, +(Math.round((i.value - r.min) / r.step) * r.step + r.min).toFixed(6)));
      i.value = x;
      setCfg(r.key, x);
    };
    return i;
  }
  // text, path. ponytail: path is a plain field; api.openDialog only picks .vmf files, add a folder picker in main.js if needed.
  return el('input', { id, type: 'text', value: v ?? '', spellcheck: false, onchange: e => setCfg(r.key, e.target.value.trim()) });
}

function row(label, title, ctl, hint, bad) {
  const lab = el('label', { textContent: label, title });
  if (ctl.id) lab.htmlFor = ctl.id;
  return el('div', { className: 'st-row' }, lab, ctl, hint ? el('small', { className: bad ? 'st-bad' : '', textContent: hint }) : '');
}

// ---------- keys ----------
const MODS = ['Control', 'Shift', 'Alt', 'Meta'];
function setKeys(id, keys) {
  const k = { ...cfg.keys };
  if (keys) k[id] = keys; else delete k[id];
  setCfg('keys', k);
  draw();
  form.querySelector(`[data-cmd-id="${CSS.escape(id)}"]`)?.focus();
}

// Click the chord, then press the new one: Escape cancels, Backspace unbinds.
function chordButton(c) {
  const text = c.keys.map(chord).join(', ') || 'Unbound';
  const b = el('button', { className: 'st-chord', textContent: text, title: 'Click, then press the new shortcut (Esc cancels, Backspace unbinds)' });
  b.dataset.cmdId = c.id;
  b.onclick = () => { b.classList.add('on'); b.textContent = 'Press a key...'; };
  b.onblur = () => { b.classList.remove('on'); b.textContent = text; };
  b.onkeydown = e => {
    if (!b.classList.contains('on') || MODS.includes(e.key)) return;
    e.preventDefault(); // also keeps Escape from closing the dialog
    if (e.key === 'Escape') b.onblur();
    else setKeys(c.id, e.key === 'Backspace' ? [] : [keyOf(e)]);
  };
  return b;
}

function keyRows(q, all) {
  const cmds = list().sort((a, b) => a.title.localeCompare(b.title)), bad = conflicts(cmds);
  return cmds.filter(c => all || has(q, c.title, c.id, c.keys.map(chord).join(' '))).map(c => {
    const reset = el('button', { className: 'st-reset', innerHTML: '&#8634;', title: 'Reset to the default shortcut', disabled: !(c.id in cfg.keys), onclick: () => setKeys(c.id, null) });
    const clash = bad.get(c.id);
    return row(c.title, c.id, el('div', { className: 'st-ctl' }, chordButton(c), reset), clash && `Also bound to: ${clash.join(', ')}`, true);
  });
}

// ---------- compile steps ----------
// Edits the step objects in place (the Compile panel holds the same ones); add and remove steps there.
function stepRows(q, all) {
  const save = () => setCfg('steps', cfg.steps);
  const rows = cfg.steps.filter(s => all || has(q, s.name, s.cmd)).map(s => {
    const on = el('input', { type: 'checkbox', checked: s.on, title: 'Run this step', onchange: () => { s.on = on.checked; save(); } });
    const cmd = el('input', { type: 'text', value: s.cmd, title: s.cmd, spellcheck: false, onchange: () => { s.cmd = cmd.title = cmd.value; save(); } });
    return el('div', { className: 'st-row' }, el('label', { className: 'st-step', title: s.name }, on, ' ' + s.name), cmd);
  });
  return [...rows, el('small', { className: 'st-note', textContent: 'Vars: $tf2 $gamedir $bin $vmf $mapbase $mapname, and the compile mode\'s $vbspflags $vvisflags $vradflags (pick the mode in the Compile panel). @pack packs custom content into the BSP. Add, rename or remove steps in the Compile panel.' })];
}

// ---------- dialog ----------
const rowsOf = (c, q) => {
  const all = !q || has(q, c.title);
  if (c.id === 'keys') return keyRows(q, all);
  if (c.id === 'compile') return stepRows(q, all);
  return c.rows.filter(r => all || has(q, r.label, r.key, r.hint)).map(r => row(r.label, r.key, control(r), r.hint));
};

async function resetCat(c) {
  if ((await ask(`Reset all ${c.title} settings to their defaults?`, ['Reset', 'Cancel'])) !== 0) return;
  if (c.id === 'keys') setCfg('keys', {});
  else if (c.id === 'compile') for (const k of ['steps', 'compileModes', 'compileMode']) setCfg(k, structuredClone(DEFAULTS[k]));
  else for (const r of c.rows) if (r.key !== 'tf2') setCfg(r.key, structuredClone(DEFAULTS[r.key])); // tf2: detected once, or pasted
  draw();
}

// With a search query every category with matching rows is shown under its heading.
function draw() {
  const q = search.value.trim().toLowerCase();
  for (const b of nav.children) b.classList.toggle('on', !q && b.dataset.id === cat);
  const parts = (q ? SCHEMA : SCHEMA.filter(c => c.id === cat)).flatMap(c => {
    const rows = rowsOf(c, q);
    if (q && !rows.some(r => r.classList.contains('st-row'))) return [];
    const head = el('div', { className: 'st-head' }, el('h3', { textContent: c.title }));
    if (!q) head.append(el('button', { textContent: 'Reset to defaults', onclick: () => resetCat(c) }));
    return [head, ...rows];
  });
  form.replaceChildren(...(parts.length ? parts : [el('p', { className: 'st-note', textContent: 'No settings match.' })]));
  form.scrollTop = 0;
}

// Editor keys are off under a modal (commands.dispatch); the save chord saves and the settings chord closes. Escape
// closes even from a filled search box (which would only clear it). A chord button that is recording a shortcut has
// already handled the key (defaultPrevented).
function dialogKey(e) {
  if (e.defaultPrevented) return;
  const k = keyOf(e), bound = id => list().find(c => c.id === id)?.keys.includes(k);
  if (bound('save')) run('save');
  else if (k === 'escape' || bound('settings.open')) dlg.close();
  else return;
  e.preventDefault();
}

function build() {
  search = el('input', { type: 'search', placeholder: 'Search settings', spellcheck: false, oninput: draw });
  nav = el('nav', {}, ...SCHEMA.map(c => {
    const b = el('button', { textContent: c.title, onclick: () => { cat = c.id; search.value = ''; draw(); } });
    b.dataset.id = c.id;
    return b;
  }));
  form = el('div', { className: 'st-form' });
  dlg = document.body.appendChild(el('dialog', { id: 'settings' },
    el('div', { className: 'st-side' }, search, nav), form,
    el('button', { className: 'st-close', innerHTML: '&#10005;', title: 'Close (Esc)', onclick: () => dlg.close() })));
  dlg.onkeydown = dialogKey;
}

// category: a SCHEMA id ('general', 'snapping', 'view3d', 'view2d', 'blockout', 'keys', 'compile').
export function open(category) {
  if (!dlg) build();
  if (category) cat = category;
  search.value = '';
  draw();
  if (!dlg.open) dlg.showModal();
  search.focus();
}

// ---------- autosave ----------
let timer = 0, changed = false;
function autosave() {
  clearInterval(timer);
  const m = +cfg.autosaveMinutes;
  if (m > 0) timer = setInterval(() => {
    if (!changed || !S.dirty || !S.file) return;
    changed = false;
    window.api.write(S.file + '.autosave', serialize()).catch(e => console.error('autosave failed', e));
  }, m * 60000);
}

export function mount() {
  register('settings.open', { title: 'Settings', keys: ['ctrl+,'], run: () => open() });
  for (const c of SCHEMA) register('settings.' + c.id, { title: `Settings: ${c.title}`, run: () => open(c.id) });
  on('file', d => d.file && addRecent(d.file));
  on('doc', () => { changed = true; });
  on('cfg', ({ key }) => key === 'autosaveMinutes' && autosave());
  autosave();
}
