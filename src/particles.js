// Particles. In 3D each info_particle_system shows a placeholder, a spinning star with its effect_name above it (no
// particle simulation), toggled by 'view.particles' (cfg.particles). The Particles panel lists the particle systems of
// the game's particles/*.pcf files (pcf.js) with a search box; a click sets effect_name on the selected
// info_particle_system entities (one undo step), or copies the name when none is selected.
import * as THREE from 'three';
import * as V from '../vmf.js';
import { on } from './bus.js';
import { cache, sel, edit, setCursor } from './state.js';
import { cfg, setCfg } from './settings.js';
import { register } from './commands.js';
import { addHelper, invalidate, cam } from './view3d.js';
import { registerPanel, show, pane } from './layout.js';
import { openVpk, readFile } from './vpk.js';
import { el } from './dom.js';
import { pcfNames } from './pcf.js';
import { textTexture, text } from './previews.js';

registerPanel({ id: 'particles', title: 'Particles', near: 'models' });

const api = window.api, CAP = 500; // ponytail: rows past CAP are not drawn (search narrows); a virtual list if that bites
const on3d = () => cfg.particles ?? true;

// ---------- 3D placeholders ----------
const root = new THREE.Group(), LABEL = new THREE.Color(0xffd8a0);
let star = null, timer = 0; // star: the sprite material all placeholders share (the animation turns it)
// Label textures, kept while a rebuild still asks for them (every 'doc' rebuilds all placeholders).
const labels = new Map();
let asked = new Set();
const label = s => { asked.add(s); return labels.get(s) ?? labels.set(s, textTexture(s)).get(s); };
function sweep() {
  for (const [s, t] of labels) if (!asked.has(s)) { t.dispose(); labels.delete(s); }
  asked = new Set();
}

// A white star (four lines through a soft dot) on transparent, as one shared additive sprite material.
function starMat() {
  if (star) return star;
  const c = document.createElement('canvas'), x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  c.width = c.height = 64;
  [[0, 1], [0.3, 0.5], [1, 0]].forEach(([t, a]) => g.addColorStop(t, `rgba(255,255,255,${a})`));
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  x.strokeStyle = '#fff';
  x.lineWidth = 3;
  x.beginPath();
  for (let i = 0; i < 4; i++) { const t = (i * Math.PI) / 4, dx = 30 * Math.cos(t), dy = 30 * Math.sin(t); x.moveTo(32 - dx, 32 - dy); x.lineTo(32 + dx, 32 + dy); }
  x.stroke();
  return (star = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), color: 0xffa040, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
}

// Placeholders for the visible info_particle_system entities, then the animation on or off.
function rebuild() {
  root.traverse(x => x.material && x.material !== star && x.material.dispose());
  root.clear();
  if (on3d()) for (const c of cache.values()) {
    if (!c.point || !c.visible || V.get(c.node, 'classname') !== 'info_particle_system') continue;
    const o = V.nums(V.get(c.node, 'origin')), s = new THREE.Sprite(starMat());
    s.position.set(...o);
    s.scale.set(24, 24, 1);
    root.add(s, text(label(V.get(c.node, 'effect_name') || '(no effect_name)'), 5, LABEL, [o[0], o[1], o[2] + 20]));
  }
  sweep();
  animate();
  invalidate();
}

// About 15 frames a second while placeholders exist (the 3D view draws on demand), drawn only when one is in view.
const fr = new THREE.Frustum(), pm = new THREE.Matrix4();
function animate() {
  if (root.children.length && !timer) timer = setInterval(tick, 66);
  else if (!root.children.length && timer) { clearInterval(timer); timer = 0; }
}
function tick() {
  const t = performance.now();
  star.rotation = (t / 700) % (2 * Math.PI);
  star.opacity = 0.75 + 0.25 * Math.sin(t / 200);
  fr.setFromProjectionMatrix(pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  if (root.children.some(s => fr.containsPoint(s.position))) invalidate();
}

// ---------- the game's particle systems ----------
// particles/*.pcf in the game's search order (tf/custom folders and VPKs, the tf and hl2 misc VPKs, loose tf and hl2),
// 'particles/x.pcf' -> VPK entry | absolute path, the first source winning: models.js's index keeps models/ and sound/
// only, so this is its walk for particles/.
async function pcfFiles() {
  const m = new Map(), tf = `${cfg.tf2}\\tf`, hl2 = `${cfg.tf2}\\hl2`;
  if (!cfg.tf2) return m;
  const add = (k, v) => k.endsWith('.pcf') && !m.has(k) && m.set(k, v);
  const vpk = p => openVpk(p, api.readBytes, 'particles/').then(es => es.forEach((v, k) => add(k, v)), e => console.warn(e.message));
  const loose = async dir => { for (const d of (await api.listDir(`${dir}\\particles`)) ?? []) if (!d.isDirectory) add(`particles/${d.name.toLowerCase()}`, `${dir}\\particles\\${d.name}`); };
  for (const c of ((await api.listDir(`${tf}\\custom`)) ?? []).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (c.isDirectory) await loose(`${tf}\\custom\\${c.name}`);
    else if (/\.vpk$/i.test(c.name) && !/_\d{3}\.vpk$/i.test(c.name)) await vpk(`${tf}\\custom\\${c.name}`);
  }
  await vpk(`${tf}\\tf2_misc_dir.vpk`);
  await vpk(`${hl2}\\hl2_misc_dir.vpk`);
  await loose(tf);
  await loose(hl2);
  return m;
}

// [{ name, file, key }] sorted by name: each particle system once (the first file that has it), key for the search.
async function loadSystems() {
  const read = async e => { if (typeof e !== 'string') return readFile(e); const st = await api.stat(e); return st && new Uint8Array(await api.readBytes(e, 0, st.size)); };
  const files = [...(await pcfFiles())], names = await Promise.all(files.map(([k, e]) => read(e).then(b => (b ? pcfNames(b) : []), err => (console.warn(k, err.message), []))));
  const seen = new Set(), out = [];
  names.forEach((ns, i) => ns.forEach(name => {
    if (seen.has(name)) return;
    seen.add(name);
    const file = files[i][0].slice(10, -4);
    out.push({ name, file, key: `${name} ${file}`.toLowerCase() });
  }));
  return out.sort((a, b) => (a.key < b.key ? -1 : 1));
}

// ---------- document ----------
// Sets effect_name on the selected info_particle_system entities (one undo step); with none selected copies the name.
export function choose(name) {
  const ents = [...sel].filter(n => cache.get(n)?.point && V.get(n, 'classname') === 'info_particle_system'), ch = ents.filter(e => V.get(e, 'effect_name') !== name);
  if (ch.length) edit([], ch, () => ch.forEach(e => V.set(e, 'effect_name', name)));
  if (ents.length) return setCursor(`${name}: effect of ${ents.length} info_particle_system`);
  navigator.clipboard.writeText(name).catch(() => {});
  setCursor(`${name} copied (select info_particle_system entities to set their effect)`);
}

// ---------- panel ----------
let host, q, list, foot, systems = null, loading = null, hits = [];

function refilter() {
  if (!systems) return;
  const ws = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  hits = ws.length ? systems.filter(s => ws.every(w => s.key.includes(w))) : systems;
  list.replaceChildren(...hits.slice(0, CAP).map(s => {
    const r = el('div', { className: 'pc-row', title: `${s.name}  (particles/${s.file}.pcf)` }, el('span', { textContent: s.name }), el('small', { textContent: s.file }));
    r.dataset.n = s.name;
    return r;
  }));
  foot.textContent = !systems.length ? 'No particle systems: set the TF2 folder in Settings (Ctrl+,)' : `${hits.length} of ${systems.length}${hits.length > CAP ? ` (first ${CAP} shown: type to narrow)` : ''}`;
}

// Reads the list the first time the panel shows (or after the TF2 folder changed).
function load() {
  if (systems || loading) return;
  foot.textContent = 'Loading particle systems...';
  loading = loadSystems().catch(e => (console.warn(e), [])).then(s => { systems = s; loading = null; refilter(); });
}

const CSS = `
.pc-list { flex: 1; min-height: 0; overflow-y: auto; scrollbar-width: thin; padding: 2px 0; }
.pc-row { display: flex; gap: 8px; align-items: baseline; padding: 2px 8px; cursor: pointer; font-size: 12px; white-space: nowrap; }
.pc-row:hover { background: #2a2e37; }
.pc-row span { overflow: hidden; text-overflow: ellipsis; }
.pc-row small { margin-left: auto; color: var(--dim); font-size: 10px; }`;

export function mount() {
  document.head.append(el('style', { textContent: CSS }));
  host = pane('particles');
  host.classList.add('mb'); // bar and footer styles from modelbrowser.css
  host.innerHTML = '<div class="mb-bar"><input class="pc-q" type="search" placeholder="Search particle systems" spellcheck="false" title="Words match the name or the file; Enter sets the first"></div><div class="pc-list"></div><div class="mb-foot"></div>';
  [q, list, foot] = ['.pc-q', '.pc-list', '.mb-foot'].map(s => host.querySelector(s));
  let t = 0;
  q.oninput = () => { clearTimeout(t); t = setTimeout(refilter, 60); };
  q.onkeydown = e => {
    if (e.key === 'Enter' && hits.length) choose(hits[0].name);
    else if (e.key === 'Escape' && q.value) { q.value = ''; refilter(); }
    else return;
    e.preventDefault();
  };
  list.onclick = e => { const n = e.target.closest('.pc-row')?.dataset.n; if (n) choose(n); };
  new ResizeObserver(() => host.clientWidth && load()).observe(host);
  addHelper(root);
  on('doc', rebuild);
  on('filters', rebuild);
  on('cfg', ({ key }) => {
    if (key === 'particles') rebuild();
    if (key === 'tf2') { systems = null; if (host.clientWidth) load(); }
  });
  register('view.particles', { title: 'View: particle placeholders (info_particle_system) (toggle)', on: on3d, run: () => { setCfg('particles', !on3d()); setCursor(`particle placeholders ${on3d() ? 'on' : 'off'}`); } });
  register('particles.show', { title: 'Particles: show browser', run: () => { show('particles'); q.focus(); } });
  rebuild();
}
