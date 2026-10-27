// Side panel: compile steps, TF2 path, log, leak line, content check.
import * as V from '../vmf.js';
import { on } from './bus.js';
import { S, doc, objects, nextId, save, setLin } from './state.js';
import { register } from './commands.js';
import { cfg, saveCfg, setCfg, MODES } from './settings.js';
import { notice } from './dialog.js';
import { el } from './dom.js';
import { show } from './layout.js';

const api = window.api;

const HTML = `
<details open>
  <summary>Compile</summary>
  <div class="row">TF2 <input class="tf2"></div>
  <div class="row">Mode <select class="mode"></select></div>
  <div class="flags"></div>
  <div class="steps"></div>
  <div class="row"><button data-cmd="addStep">+ Step</button><button data-cmd="cancel">Cancel</button><button data-cmd="compile.checkContent">Check content</button><button data-cmd="compile.logFolder">Open log folder</button></div>
  <small>Vars: $tf2 $gamedir $bin $vmf $mapbase $mapname, and the mode's $vbspflags $vvisflags $vradflags. A step '@pack' packs custom content into the BSP.</small>
  <pre id="log"></pre>
</details>`;

const loadPack = () => import('./pack.js');

// Command lines of the enabled steps with $vars filled in. An '@pack' step becomes the commands that
// pack.prepare(mapbase) returns: a list, or { cmds, files, missing }. log(text) gets the pack result; without pack.js
// the step is skipped. A step that uses a var set to false is skipped too (a compile mode that does not run VVIS).
export async function resolve(steps, vars, log, load = loadPack) {
  const out = [], off = s => [...s.cmd.matchAll(/\$(\w+)/g)].some(m => vars[m[1]] === false);
  for (const s of steps.filter(s => s.on && s.cmd.trim() && !off(s))) {
    if (s.cmd.trim() !== '@pack') { out.push(s.cmd.replace(/\$(\w+)/g, (m, k) => vars[k] ?? m)); continue; }
    let pack;
    try { pack = await load(); } catch { log('pack: module missing\n'); continue; }
    try {
      const r = await pack.prepare(vars.mapbase), { cmds = [], files, missing = [] } = Array.isArray(r) ? { cmds: r } : r ?? {};
      const what = files?.length ? `${files.length} file(s)` : cmds.length ? `${cmds.length} command(s)` : 'nothing to pack';
      log(`pack: ${what}${missing.length ? `, missing: ${missing.join(', ')}` : ''}\n`);
      out.push(...cmds);
    } catch (e) { log(`pack: ${e.message}; step skipped\n`); }
  }
  return out;
}

// A step that runs a Hammer++ compiler ("<dir>\vbsp++.exe" ...) that is not installed runs the stock tool of the same
// name that TF2 ships in that folder instead. exists(path) checks a file.
export const stockTools = (cmds, exists, log) => Promise.all(cmds.map(async c => {
  const [, exe, rest] = c.match(/^"([^"]+)\+\+\.exe"(.*)$/is) ?? [];
  if (!exe || (await exists(`${exe}++.exe`)) || !(await exists(`${exe}.exe`))) return c;
  const name = exe.split('\\').pop();
  log(`${name}++.exe not found: using ${name}.exe\n`);
  return `"${exe}.exe"${rest}`;
}));

let steps, log, running = false;

function stepsPanel() {
  steps.replaceChildren(...cfg.steps.map((s, i) => {
    const on = el('input', { type: 'checkbox', checked: s.on });
    const name = el('input', { value: s.name, style: 'flex:0 0 64px' });
    const cmd = el('input', { value: s.cmd, title: s.cmd });
    const del = el('button', { textContent: 'x', title: 'Remove step' });
    on.onchange = () => { s.on = on.checked; saveCfg(); };
    name.onchange = () => { s.name = name.value; saveCfg(); };
    cmd.onchange = () => { s.cmd = cmd.title = cmd.value; saveCfg(); };
    del.onclick = () => { cfg.steps.splice(i, 1); stepsPanel(); saveCfg(); };
    return el('div', { className: 'row' }, on, name, cmd, del);
  }));
}

// $vbspflags $vvisflags $vradflags of compile mode m (settings.js MODES).
export const modeVars = m => ({ vbspflags: m?.vbsp ?? '', vvisflags: m?.vvis ?? '', vradflags: m?.vrad ?? '' });

// The mode list and, per tool, a Run box and the flags of the current mode.
let modeSel, flags;
function modePanel() {
  const m = cfg.compileModes[cfg.compileMode];
  modeSel.replaceChildren(...Object.entries(cfg.compileModes).map(([k, v]) => el('option', { value: k, textContent: v.name, selected: k === cfg.compileMode })));
  flags.replaceChildren(...(m ? ['vbsp', 'vvis', 'vrad'] : []).map(t => {
    const on = el('input', { type: 'checkbox', checked: m[t] !== false, title: `Run ${t.toUpperCase()} in this mode` });
    const f = el('input', { value: m[t] || '', disabled: m[t] === false, placeholder: 'no flags', spellcheck: false });
    on.onchange = () => { m[t] = on.checked ? f.value : false; f.disabled = !on.checked; saveCfg(); };
    f.onchange = () => { m[t] = f.value.trim(); saveCfg(); };
    return el('div', { className: 'row' }, on, el('span', { textContent: t.toUpperCase(), style: 'flex:0 0 40px' }), f);
  }));
}

const setRunning = on => { running = on; document.querySelectorAll('[data-cmd=compile]').forEach(b => { b.disabled = on; }); };

// The $vars of a compile of file, as Windows paths: cmd's copy reads the '/' in a path like D:/maps/a.bsp as a switch.
export function varsFor(file, tf2) {
  const win = p => p.replace(/\//g, '\\'), vmf = win(file), base = vmf.replace(/\.vmf$/i, ''), t = win(tf2);
  return { tf2: t, gamedir: t + '\\tf', bin: t + '\\bin\\x64', vmf, mapbase: base, mapname: base.split('\\').pop() };
}

async function compile() {
  if (running) return;
  if ((S.dirty || !S.file) && !(await save())) return;
  const mode = cfg.compileModes[cfg.compileMode], vars = { ...varsFor(S.file, cfg.tf2), ...modeVars(mode) };
  log.textContent = '';
  log.closest('details').open = true;
  show('compile'); // a closed or hidden Compile panel would leave the log out of sight
  setLin(null);
  setRunning(true);
  const hidden = [doc.world, doc.root, ...V.kids(doc.root, 'entity')].reduce((n, c) => n + V.kids(c, 'hidden').length, 0);
  append(`mode: ${mode?.name ?? cfg.compileMode}\n`);
  if (hidden) append(`note: ${hidden} hidden object(s) are not compiled (Unhide all: U)\n`);
  let r, v = vars; // r: { code, leaked }; main writes the Done/FAILED line
  try { v = await cordoned(vars); r = await api.run(await stockTools(await resolve(cfg.steps, v, append), api.exists, append)); } catch (e) { append(`\n${e.message}\n`); } finally { setRunning(false); }
  if (r?.leaked) {
    const n = V.nums(await api.read(v.mapbase + '.lin'));
    if (n.length >= 6) setLin(Array.from({ length: (n.length / 3) | 0 }, (_, i) => n.slice(i * 3, i * 3 + 3)));
  }
}

// Cordons on (cordon.js): the steps compile <map folder>\cordon_compile\<mapname>.vmf, the map cut to the active boxes
// and sealed, with $vmf and $mapbase pointing there, so VVIS, VRAD, Pack and Copy use that BSP, still named
// <mapname>.bsp (a renamed BSP would keep the wrong name in its cubemap material paths). vbsp looks for instance files
// next to the VMF, then under the nearest 'maps' folder: a func_instance whose file is next to the map gets '../'
// (vbsp reads backslashes in values as escapes).
async function cordoned(vars) {
  const C = await import('./cordon.js'), boxes = C.activeBoxes(doc.root);
  if (!boxes.length) return vars;
  const dir = vars.mapbase.replace(/[\\/][^\\/]*$/, ''), out = `${dir}\\cordon_compile\\${vars.mapname}.vmf`, root = C.cordonRoot(doc.root, boxes, nextId);
  root.children = await Promise.all(root.children.map(async e => {
    const f = e.name === 'entity' && V.get(e, 'classname') === 'func_instance' && V.get(e, 'file');
    return f && (await api.exists(`${dir}\\${f.replace(/\.vmf$/i, '')}.vmf`)) ? { ...e, kv: e.kv.map(p => (p[0] === 'file' ? ['file', `../${f}`] : p)) } : e;
  }));
  const kept = V.kids(root, 'entity').length + V.kids(V.kids(root, 'world')[0], 'solid').length - 6 * boxes.length;
  await api.writeBinary(out, (await import('./clipboard.js')).latin1(V.serialize(root)));
  append(`cordon: ${kept} of ${objects().length} objects in ${boxes.length} box(es), compiling ${out}\n`);
  return { ...vars, vmf: out, mapbase: out.slice(0, -4) };
}

// Tool output comes in many small chunks: append them in batches (each append lays out the whole log) and keep only
// the end of a very long log.
let buf = '';
function flush() {
  log.append(buf.replace(/\r\n?/g, '\n'));
  buf = '';
  if (log.textContent.length > 500000) log.textContent = log.textContent.slice(-250000);
  log.scrollTop = log.scrollHeight;
}
function append(s) {
  if (!buf) setTimeout(flush, 50);
  buf += s;
}

// Modal with a scrollable list that can be selected and copied.
function listDialog(title, lines) {
  const d = document.body.appendChild(el('dialog', {}, el('p', { textContent: title }),
    el('pre', { textContent: lines.join('\n'), style: 'max-height:50vh;overflow:auto;margin:0 0 14px;font:11px Consolas,monospace' }),
    el('div', { className: 'row' }, el('button', { className: 'primary', textContent: 'OK', onclick: () => d.close() }))));
  d.onclose = () => d.remove();
  d.showModal();
}

// pack.check(mapbase | null) lists the content the map uses but the game cannot find: a list, or { missing }.
async function checkContent() {
  let pack, r;
  try { pack = await loadPack(); } catch { return notice('pack: module missing (src/pack.js).'); }
  try { r = await pack.check(S.file?.replace(/\.vmf$/i, '') ?? null); } catch (e) { return notice(`Check content failed: ${e.message}`); }
  const missing = Array.isArray(r) ? r : r?.missing ?? [];
  if (missing.length) listDialog(`Missing content (${missing.length}): not in the game's VPKs, tf\\custom or tf\\.`, missing.map(String));
  else notice('All content the map uses was found.');
}

// There is no API to open Explorer: show where the compile tools write their logs.
const logFolder = () => notice(S.file
  ? `Compile logs are in ${S.file.replace(/[\\/][^\\/]*$/, '')} (${S.file.split(/[\\/]/).pop().replace(/\.vmf$/i, '.log')}).`
  : 'Save the map first: the compile tools write their logs next to it.');

export function mount(host) {
  host.innerHTML = HTML;
  steps = host.querySelector('.steps');
  log = host.querySelector('#log');
  const tf2 = host.querySelector('.tf2');
  tf2.value = cfg.tf2;
  tf2.onchange = () => setCfg('tf2', tf2.value);
  api.onLog(append);
  stepsPanel();
  modeSel = host.querySelector('.mode');
  flags = host.querySelector('.flags');
  modeSel.onchange = () => setCfg('compileMode', modeSel.value);
  modePanel();
  // The Settings dialog and the palette edit the same values.
  on('cfg', ({ key }) => { if (key === 'steps') stepsPanel(); else if (key === 'tf2') tf2.value = cfg.tf2; else if (/^compileMode/.test(key)) modePanel(); });
  for (const [k, m] of Object.entries(MODES)) register(`compile.mode.${k}`, { title: `Compile mode: ${m.name}`, run: () => setCfg('compileMode', k) });
  register('compile', { title: 'Compile and run', keys: ['f9'], run: compile });
  register('cancel', { title: 'Cancel compile', run: () => api.cancel() });
  register('addStep', { title: 'Add compile step', run: () => { cfg.steps.push({ on: true, name: 'Step', cmd: '' }); stepsPanel(); saveCfg(); } });
  register('compile.checkContent', { title: 'Compile: check content (list missing materials, models, sounds)', run: checkContent });
  register('compile.logFolder', { title: 'Compile: open log folder', run: logFolder });
}
