// Prefabs: the selection saved as a VMF (versioninfo prefab 1) in cfg.prefabDir (default <userData>\prefabs) and a
// Prefabs panel that lists them: Insert places a copy with its bounds corner at the cursor, plus Rename and Delete.
import { sel, setCursor } from './state.js';
import { register } from './commands.js';
import { cfg } from './settings.js';
import { registerPanel, pane } from './layout.js';
import { copyText, pasteText, latin1 } from './clipboard.js';
import { form } from './report.js';
import { ask, notice } from './dialog.js';
import { el } from './dom.js';

const api = window.api;
registerPanel({ id: 'prefabs', title: 'Prefabs', near: 'textures' });

const dir = () => cfg.prefabDir || api.settingsPath.replace(/[\\/][^\\/]*$/, '') + '\\prefabs';
const path = name => `${dir()}\\${name}.vmf`;
const clean = s => (s ?? '').replace(/[\\/:*?"<>|]/g, '').trim();
let list;

async function refresh() {
  const names = ((await api.listDir(dir())) ?? []).filter(d => !d.isDirectory && /\.vmf$/i.test(d.name)).map(d => d.name.slice(0, -4)).sort();
  list.replaceChildren(...(names.length ? names.map(row) : [el('small', { textContent: 'No prefabs yet: select objects and press Save selection.' })]));
}

const row = name => el('div', { className: 'row pf-row' }, el('span', { textContent: name, title: path(name) }),
  el('button', { textContent: 'Insert', title: 'Insert at the cursor (last mouse position in a view)', onclick: () => insert(name) }),
  el('button', { textContent: 'Rename', onclick: () => rename(name) }),
  el('button', { textContent: 'Delete', onclick: () => remove(name) }));

async function insert(name) {
  if (!pasteText(await api.read(path(name)), true)) notice(`${name} is not a map or prefab VMF with objects in it.`);
}

async function save() {
  const r = await form('Save the selection as a prefab', [{ key: 'name', label: 'Name', value: '' }], 'Save');
  const name = clean(r?.name);
  if (!name) return;
  if ((await api.exists(path(name))) && (await ask(`Replace the prefab ${name}?`, ['Replace', 'Cancel'])) !== 0) return;
  await api.writeBinary(path(name), latin1(copyText(true).text)); // makes the folder too
  setCursor(`prefab saved: ${path(name)}`);
  refresh();
}

async function rename(name) {
  const to = clean((await form(`Rename the prefab ${name}`, [{ key: 'name', label: 'New name', value: name }], 'Rename'))?.name);
  if (!to || to === name) return;
  if (await api.exists(path(to))) return notice(`A prefab named ${to} exists already.`);
  await api.rename(path(name), path(to));
  refresh();
}

async function remove(name) {
  if ((await ask(`Delete the prefab ${name}? This removes ${path(name)}.`, ['Delete', 'Cancel'])) !== 0) return;
  await api.remove(path(name));
  refresh();
}

export function mount() {
  const p = pane('prefabs');
  list = el('div', { className: 'pf-list' });
  p.append(el('div', { className: 'row pf-head' }, el('button', { textContent: 'Save selection', onclick: () => (sel.size ? save() : notice('Select the objects to save first.')) }),
    el('button', { textContent: 'Refresh', onclick: refresh })), list);
  register('prefab.save', { title: 'Prefab: save selection...', when: () => sel.size > 0, run: save });
  register('prefab.refresh', { title: 'Prefab: refresh list', run: refresh });
  refresh();
}
