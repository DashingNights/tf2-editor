// func_instance (Hammer instances): the instance VMF drawn in place (origin + angles) as one tinted mesh that selects
// the func_instance, its outlines in the 2D views, and Collapse (the contents merged into the map with vbsp's name
// fixups). Files are read once and cached; 'instances.reload' reads them again.
import * as THREE from 'three';
import * as V from '../vmf.js';
import * as F from './fgd.js';
import { S, sel, cache, nextId, addObjects, open, setCursor, registerPointLook, touch } from './state.js';
import { register } from './commands.js';
import { cfg } from './settings.js';
import { on } from './bus.js';
import { registerBuilder, fan } from './view3d.js';
import { registerOverlay, invalidate as redraw2d } from './view2d.js';
import { ask, notice } from './dialog.js';

const api = window.api;

// ---------- pure ----------
// Where vbsp looks for an instance file: next to the map, then under the nearest 'maps' folder above it, then in the
// game's InstancePath folders (dirs, each ending in a backslash; mount() finds them).
let instanceDirs = [];
export function candidates(mapFile, file, dirs = instanceDirs) {
  if (!mapFile || !file) return [];
  const f = file.replace(/\//g, '\\').replace(/\.vmf$/i, '') + '.vmf', dir = mapFile.replace(/\//g, '\\').replace(/\\[^\\]*$/, '') + '\\';
  const i = dir.toLowerCase().indexOf('\\maps\\'), out = [dir + f];
  if (i >= 0 && dir.slice(0, i + 6) !== dir) out.push(dir.slice(0, i + 6) + f);
  return [...out, ...dirs.map(d => d + f)];
}

// abs as a path relative to folder dir (forward slashes, '..' where needed); abs itself on another drive.
export function relTo(dir, abs) {
  const a = dir.replace(/\//g, '\\').split('\\').filter(Boolean), b = abs.replace(/\//g, '\\').split('\\').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i].toLowerCase() === b[i].toLowerCase()) i++;
  return i ? [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/') : abs;
}

// Rotation rows for Source angles "pitch yaw roll": roll about x, then pitch about y, then yaw about z.
const mm = (a, b) => a.map(r => [0, 1, 2].map(j => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]));
export const angleRows = ([p = 0, y = 0, r = 0]) => mm(V.rotation(2, y), mm(V.rotation(1, p), V.rotation(0, r)));
// Instance space -> map space for a func_instance node.
export function placer(e) {
  const m = angleRows(V.nums(V.get(e, 'angles') ?? '0 0 0')), o = V.nums(V.get(e, 'origin') ?? '0 0 0');
  return p => m.map((row, i) => row[0] * p[0] + row[1] * p[1] + row[2] * p[2] + (o[i] || 0));
}

// vbsp's name fixup: style 0 prefixes "<name>-", 1 appends "-<name>", 2 keeps names. Names starting with @ or ! (and
// empty values) never change.
export const fixName = (v, name, style) => (!v || /^[@!]/.test(v) || style === 2 ? v : style === 1 ? `${v}-${name}` : `${name}-${v}`);
const NAME_KEYS = new Set(['targetname', 'parentname', 'target', 'filtername', 'damagefilter']);

// The objects a func_instance stands for (Hammer's Collapse): the instance's world solids and entities with new ids,
// $variables from replace01.. replaced, names fixed up like vbsp (name keys, values naming an instance entity, output
// targets), moved to the func_instance's origin and angles; func_instance_parms and visgroup / group ids dropped.
// Hidden objects stay out (vbsp skips them). Like vbsp's merge, keys of FGD type angle turn with the instance,
// vecline / origin keys move with it, a brush entity whose class has an origin key but no value gets the instance
// origin (its hinge or axis), and side lists name the copied faces. keyTypes(classname) -> Map<lower-case key, type>.
export function collapse(inst, e, nextId, texLock = true, keyTypes = () => null) {
  const style = +(V.get(e, 'fixup_style') ?? 0), name = V.get(e, 'targetname') || `InstanceAuto${V.get(e, 'id') ?? ''}`;
  const vars = e.kv.filter(([k]) => /^replace\d+$/i.test(k)).map(([, v]) => v.match(/^(\$\S+)\s*(.*)$/)).filter(Boolean).sort((a, b) => b[1].length - a[1].length);
  const sub = s => vars.reduce((t, m) => t.split(m[1]).join(m[2]), s);
  const world = V.kids(inst, 'world')[0], ents = V.kids(inst, 'entity').filter(x => V.get(x, 'classname') !== 'func_instance_parms');
  const names = new Set(ents.map(x => sub(V.get(x, 'targetname') ?? '')).filter(Boolean)), ids = new Map(), place = placer(e);
  const fix = v => fixName(v, name, style), at = V.nums(V.get(e, 'origin') ?? '0 0 0'), [p, y, r] = V.nums(V.get(e, 'angles') ?? '0 0 0');
  const turn = n => [[0, r], [1, p], [2, y]].forEach(([k, deg]) => deg && V.rotate(n, [0, 0, 0], k, deg, texLock));
  const out = [...(world ? V.kids(world, 'solid') : []), ...ents].map(o => {
    const c = V.clone(o, nextId, ids);
    (function strip(n) { for (const x of n.children) { if (x.name === 'editor') x.kv = x.kv.filter(q => q[0] !== 'visgroupid' && q[0] !== 'groupid'); strip(x); } })(c);
    if (c.name === 'entity') {
      for (const q of c.kv) if (q[0] !== 'id') { q[1] = sub(q[1]); if (NAME_KEYS.has(q[0].toLowerCase()) || names.has(q[1])) q[1] = fix(q[1]); }
      for (const q of V.kids(c, 'connections').flatMap(x => x.kv)) {
        const sep = q[1].includes('\x1b') ? '\x1b' : ',', f = sub(q[1]).split(sep);
        f[0] = fix(f[0]);
        q[1] = f.join(sep);
      }
      const types = keyTypes(V.get(c, 'classname'));
      for (const q of c.kv) {
        const t = types?.get(q[0].toLowerCase()), v = V.nums(q[1]);
        if (v.length !== 3 || /^(origin|angles)$/i.test(q[0])) continue; // V.rotate and V.transform do those
        if (t === 'angle') { const a = { name: 'entity', kv: [['angles', q[1]]], children: [] }; turn(a); q[1] = V.get(a, 'angles'); }
        else if (t === 'vecline' || t === 'origin') q[1] = place(v).map(x => String(Math.round(x * 1e6) / 1e6 + 0)).join(' ');
      }
      if (types?.get('origin') === 'origin' && V.kids(c, 'solid').length && V.get(c, 'origin') === undefined) c.kv.push(['origin', '0 0 0']);
    }
    turn(c);
    if (at.some(Boolean)) V.transform(c, [1, 1, 1], at.map(x => x || 0), texLock);
    return c;
  });
  out.forEach(c => V.remapSides(c, ids, true));
  return out;
}

// ---------- loaded files ----------
// key (first candidate, lower case) -> { path, root, geo, faces } (path null while loading or when missing)
const files = new Map();
const isInst = c => c.point && V.get(c.node, 'classname') === 'func_instance';
const keyOf = n => candidates(S.file, V.get(n, 'file'))[0]?.toLowerCase();

// Faces (instance space) of the instance's solids and a 16-unit box per point entity, and their tinted geometry.
// Hidden objects are left out, as vbsp does.
function shapes(root) {
  const solids = [], points = [];
  (function walk(n) { for (const c of n.children) { if (c.name === 'solid') solids.push(c); else if (c.name === 'entity' && !V.kids(c, 'solid').length) points.push(c); if (/^(world|entity)$/.test(c.name)) walk(c); } })(root);
  const faces = [...solids.flatMap(V.faces), ...points.map(e => V.nums(V.get(e, 'origin'))).filter(o => o.length === 3).flatMap(o => V.faces(V.block(o.map(x => x - 8), o.map(x => x + 8), '', () => '0')))];
  const col = faces.flatMap(f => { const k = 0.72 + 0.2 * f.n[2] + 0.08 * f.n[0]; return Array((f.pts.length - 2) * 3).fill([k, k, k]).flat(); });
  const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(fan(faces), 3)).setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return { faces, geo, box: faces.length ? V.bounds(faces) : null };
}

function fileOf(n) {
  const cs = candidates(S.file, V.get(n, 'file')), key = cs[0]?.toLowerCase();
  if (!key) return null;
  let f = files.get(key);
  if (!f) {
    files.set(key, (f = { path: null }));
    f.ready = (async () => {
      for (const p of cs) {
        const t = await api.read(p);
        if (typeof t === 'string') { const root = V.parse(t); Object.assign(f, { path: p, root }, shapes(root)); break; }
      }
      if (files.get(key) !== f) return;
      touch([...cache.values()].filter(c => isInst(c) && keyOf(c.node) === key).map(c => c.node)); // new box and visual
      redraw2d();
    })();
  }
  return f;
}
// The loaded instance of func_instance n, or null when its file is missing.
async function loaded(n) {
  const f = n && fileOf(n);
  await f?.ready;
  return f?.path ? f : null;
}

// ---------- drawing ----------
const MAT = new THREE.MeshBasicMaterial({ color: 0x9cc0ff, vertexColors: true });
const M = new THREE.Matrix4();
function build(c) {
  if (!isInst(c)) return null;
  const f = fileOf(c.node);
  if (!f?.geo) return null;
  const m = new THREE.Mesh(f.geo, MAT), r = angleRows(V.nums(V.get(c.node, 'angles') ?? '0 0 0')), o = V.nums(V.get(c.node, 'origin'));
  m.matrixAutoUpdate = false;
  m.matrix.copy(M.set(...r[0], o[0], ...r[1], o[1], ...r[2], o[2], 0, 0, 0, 1));
  return m;
}

// 2D: the instance outlines of every visible func_instance, following a drag of the selected ones.
function overlay(ctx, v, { toScreen, previewFn }) {
  const xf = previewFn(S.preview);
  ctx.strokeStyle = '#9cc0ff';
  ctx.globalAlpha = 0.8;
  ctx.beginPath();
  for (const c of cache.values()) {
    const f = c.visible && isInst(c) && files.get(keyOf(c.node));
    if (!f?.faces) continue;
    const at = placer(c.node), moved = sel.has(c.node);
    for (const fc of f.faces) fc.pts.forEach((p, i) => { const s = toScreen(v, moved ? xf(at(p)) : at(p)); i ? ctx.lineTo(...s) : ctx.moveTo(...s); });
  }
  ctx.stroke();
}

// ---------- commands ----------
const selInst = () => [...sel].map(n => cache.get(n)).filter(c => c && isInst(c)).map(c => c.node);

// A func_instance's box (2D views, selection box, cordon tests): its contents' bounds placed by origin and angles.
function look(n) {
  const f = V.get(n, 'classname') === 'func_instance' && files.get(keyOf(n));
  if (!f?.box) return null;
  const at = placer(n), ps = [0, 1, 2, 3, 4, 5, 6, 7].map(i => at([0, 1, 2].map(k => f.box[(i >> k) & 1][k])));
  return { box: [0, 1].map(j => [0, 1, 2].map(k => (j ? Math.max : Math.min)(...ps.map(p => p[k])))) };
}

function reload() {
  for (const f of files.values()) f.geo?.dispose();
  files.clear();
  touch([...cache.values()].filter(isInst).map(c => c.node));
  redraw2d();
  setCursor('instances reloaded');
}

// One document at a time: the instance replaces the map (Save / Discard / Cancel when it has changes).
async function editInstance() {
  const [e] = selInst(), f = await loaded(e);
  if (!f) return notice(`Instance file not found: ${V.get(e, 'file') || '(no file key)'}${S.file ? '' : ' (save the map first: the path is relative to it)'}`);
  if ((await ask(`Open ${f.path}? It replaces the map in the editor (one document at a time).`, ['Open', 'Cancel'])) === 0) open(f.path);
}

// A nested func_instance's file is relative to its instance file (vbsp): it is written relative to the map instead,
// unless only the InstancePath folders have it (they serve the map too).
async function refile(objs, instPath) {
  for (const o of objs.filter(o => V.get(o, 'classname') === 'func_instance' && V.get(o, 'file'))) {
    const cs = candidates(instPath, V.get(o, 'file'), []);
    for (const p of cs) if (await api.exists(p)) { V.set(o, 'file', relTo(S.file.replace(/[\\/][^\\/]*$/, ''), p)); break; }
  }
}

async function collapseSel() {
  const es = selInst(), objs = [], done = [], fgd = cfg.tf2 ? await F.shared(`${cfg.tf2}\\bin\\tf.fgd`, api.read).catch(() => null) : null;
  const keyTypes = cls => fgd && new Map(F.resolve(fgd, cls)?.keys.map(k => [k.name.toLowerCase(), k.type]));
  for (const e of es) {
    const f = await loaded(e);
    if (!f) { setCursor(`Instance file not found: ${V.get(e, 'file')}`); continue; }
    const os = collapse(f.root, e, nextId, true, keyTypes);
    await refile(os, f.path);
    objs.push(...os);
    done.push(e);
  }
  if (done.length) addObjects(objs, done);
  if (done.length) setCursor(`collapsed ${done.length} instance(s) into ${objs.length} object(s)`);
}

// InstancePath from gameinfo.txt ("maps/instances/" in TF2) in tf/custom/* and tf, the order of the GAME search paths.
async function findDirs() {
  const tf = cfg.tf2 && `${cfg.tf2}\\tf`, info = tf && (await api.read(`${tf}\\gameinfo.txt`).catch(() => null));
  const rel = (info?.match(/^\s*InstancePath\s+"([^"]*)"/im)?.[1] ?? '').replace(/\//g, '\\').replace(/\\?$/, '\\').replace(/^\\/, '');
  if (!tf || !rel) return void (instanceDirs = []);
  const custom = ((await api.listDir(`${tf}\\custom`).catch(() => null)) ?? []).filter(d => d.isDirectory).map(d => `${tf}\\custom\\${d.name}\\`);
  instanceDirs = [...custom, `${tf}\\`].map(d => d + rel);
  for (const [k, f] of files) if (!f.path) files.delete(k); // look for the missing ones again
  touch([...cache.values()].filter(isInst).map(c => c.node));
}

export function mount() {
  findDirs();
  on('cfg', ({ key }) => { if (key === 'tf2') findDirs(); });
  registerBuilder(build);
  registerPointLook(look);
  registerOverlay(overlay);
  const any = () => selInst().length > 0;
  register('instances.reload', { title: 'Instances: reload files', run: reload });
  register('instances.edit', { title: 'Instances: open the selected instance file', when: any, run: editInstance });
  register('instances.collapse', { title: 'Instances: collapse selected (merge into the map)', when: any, run: collapseSel });
}
