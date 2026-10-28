// Propper (Hammer++): propper.compile turns the selected brushes into a static prop. It writes them as an SMD (triangles,
// UVs from the texture axes) and a QC under tf/custom/<project>/modelsrc/<name>/, VertexLitGeneric copies of their
// materials under tf/custom/<project>/materials/models/<project>/propper/ (a LightmappedGeneric material is not lit on
// a model), runs TF2's studiomdl, moves the model from tf/models/ to tf/custom/<project>/models/<project>/ and replaces
// the brushes with a prop_static (one undo step).
import * as V from '../vmf.js';
import { S, sel, cache, boxOf, nextId, setSelection, deleteSel, addObjects, editCount, mergeUndo, setCursor } from './state.js';
import { register } from './commands.js';
import { cfg } from './settings.js';
import { ask, notice } from './dialog.js';
import { form } from './report.js';
import { show } from './layout.js';
import { getVmt, textureSize, addLoose, clean } from './materials.js';
import { assets, readAsset, fgdDefaults } from './models.js';
import { load as loadMdl } from './mdl.js';

const api = window.api;
const slug = s => s.toLowerCase().trim().replace(/[\\/\s]+/g, '_').replace(/[^a-z0-9_-]/g, '');
const n6 = x => (Math.abs(x) < 5e-7 ? 0 : x).toFixed(6);
const EXTS = ['.mdl', '.vvd', '.phy', '.dx90.vtx', '.dx80.vtx', '.sw.vtx', '.xbox.vtx', '.vtx'];
const isTool = f => /^tools\//i.test(V.get(f.side, 'material') ?? '');

// ---------- files (pure) ----------
// SMD text: one root bone, each face (vmf.js faces() entry) a fan of triangles. Points move by -o and turn -90 degrees
// about z, because studiomdl turns SMD data +90 (checked with TF2's studiomdl; turnOf catches it if not). mat(f): the
// face's material in the model, or null to leave it out; size(f): { w, h } of its texture for the UVs (vmf.js uv; v
// flipped, as SMD counts it up), or null for UVs of 0; normal(f, p): the normal written at corner p.
export function smd(faces, o, mat, size, normal = f => f.n) {
  const t = p => [p[1] - o[1], o[0] - p[0], p[2] - o[2]], out = ['version 1', 'nodes', '0 "root" -1', 'end', 'skeleton', 'time 0', '0 0 0 0 0 0 0', 'end', 'triangles'];
  for (const f of faces) {
    const m = mat(f);
    if (!m) continue;
    const s = size(f), uv = s ? V.uv(f, s.w, s.h) : f.pts.map(() => [0, 0]), n = p => { const v = normal(f, p); return [v[1], -v[0], v[2]]; };
    for (let i = 1; i + 1 < f.pts.length; i++) {
      out.push(m);
      for (const j of [0, i, i + 1]) out.push(`0 ${[...t(f.pts[j]), ...n(f.pts[j])].map(n6).join(' ')} ${n6(uv[j][0] || 0)} ${n6(1 - (uv[j][1] || 0))}`);
    }
  }
  out.push('end', '');
  return out.join('\n');
}

// Collision SMD: every face of every solid (lists of faces), tool faces too. studiomdl joins collision triangles into
// pieces where corners match in position and normal (face normals left each face a flat piece of its own), so each
// corner's normal points away from its solid's middle: a solid's faces join, touching solids stay apart, and $concave
// makes a convex piece of each solid.
export function physSmd(solids, o) {
  const mid = new Map();
  for (const fs of solids) {
    const ps = fs.flatMap(f => f.pts), c = [0, 1, 2].map(k => ps.reduce((s, p) => s + p[k], 0) / ps.length);
    for (const f of fs) mid.set(f, c);
  }
  const away = (f, p) => { const d = p.map((x, k) => x - mid.get(f)[k]), l = Math.hypot(...d) || 1; return d.map(x => x / l); };
  return smd(solids.flat(), o, () => 'phys', () => null, away);
}

// VertexLitGeneric copy of a brush material: its base texture and the parameters that work on models. p: materials.js
// getVmt result (null: the base texture is taken to have the material's name).
const KEEP = ['$basetexture', '$bumpmap', '$translucent', '$alphatest', '$nocull', '$color', '$surfaceprop'];
export function vmt(name, p) {
  const kv = new Map([['$basetexture', name], ...[...(p?.kv ?? [])].filter(([k]) => KEEP.includes(k))]);
  return ['"VertexLitGeneric"', '{', ...[...kv].map(([k, v]) => `\t"${k}" "${v}"`), '}', ''].join('\r\n');
}

// pieces: the number of brushes (convex pieces of the collision model; studiomdl allows 20 unless told more).
export const qc = (name, project, surfaceprop, pieces) => [
  `$modelname "${project}/${name}.mdl"`, '$staticprop', `$surfaceprop "${surfaceprop}"`, `$cdmaterials "models/${project}/propper"`,
  `$body body "${name}.smd"`, `$sequence idle "${name}.smd" fps 30`, `$collisionmodel "${name}_phys.smd"`, '{', '\t$concave',
  ...(pieces > 20 ? [`\t$maxconvexpieces ${pieces}`] : []), '}', ''].join('\n');

// The turn about z (0, 90, 180 or 270 degrees; the smallest that fits best) that takes box a ([min, max]) to box b, in x
// and y.
export function turnOf(a, b) {
  const turn = r => {
    const c = [[a[0][0], a[0][1]], [a[1][0], a[1][1]]].map(([x, y]) => [[x, y], [-y, x], [-x, -y], [y, -x]][r / 90]);
    return [0, 1].map(k => [Math.min(c[0][k], c[1][k]), Math.max(c[0][k], c[1][k])]);
  };
  let best = 0, err = Infinity;
  for (const r of [0, 90, 180, 270]) {
    const t = turn(r), e = [0, 1].reduce((s, k) => s + Math.abs(t[k][0] - b[0][k]) + Math.abs(t[k][1] - b[1][k]), 0);
    if (e < err - 1e-3) { best = r; err = e; }
  }
  return best;
}

// ---------- compile ----------
const write = (path, text) => api.writeBinary(path, new TextEncoder().encode(text));

// Asks for the model name and surface property, writes the files, runs studiomdl, places the prop.
async function compile() {
  if (!cfg.tf2) return notice('Set the TF2 folder in Settings first.');
  const solids = [...sel].filter(n => n.name === 'solid'), es = solids.map(s => cache.get(s));
  if (!solids.length) return setCursor('Propper: select brushes first');
  if (es.some(c => c.kinds.includes('displacements'))) return notice('Propper: displacements cannot go into a model. Leave them out of the selection.');
  const vis = es.flatMap(c => c.faces).filter(f => !isTool(f)), matOf = f => clean(V.get(f.side, 'material') ?? '');
  if (!vis.length) return notice('Propper: the selected brushes have only tool faces (nothing to draw).');
  const mats = [...new Set(vis.map(matOf))], map = slug(S.file?.split(/[\\/]/).pop().replace(/\.vmf$/i, '') ?? '') || 'map';
  const r = await form('Propper: compile the selected brushes into a static prop', [
    { key: 'name', label: 'Model name', value: `${map}_${V.get(solids[0], 'id')}` },
    { key: 'surfaceprop', label: 'Surface property', value: (await getVmt(mats[0]))?.kv.get('$surfaceprop') ?? 'default' },
  ], 'Compile');
  const name = r && slug(r.name);
  if (!name) return;
  const project = slug(cfg.project ?? 'mymap') || 'mymap', tf = `${cfg.tf2}\\tf`, custom = `${tf}\\custom\\${project}`, rel = `models/${project}/${name}`;
  const dst = `${custom}\\models\\${project}\\${name}`, src = `${custom}\\modelsrc\\${name}\\${name}`;
  if ((await api.exists(dst + '.mdl')) && (await ask(`${rel}.mdl already exists in tf\\custom\\${project}. Replace it?`, ['Replace', 'Cancel'])) !== 0) return;
  // bin\x64 only with its own mdllib.dll: TF2 ships that in bin alone, and the x64 studiomdl stops without it
  const x64 = `${cfg.tf2}\\bin\\x64\\`, exe = (await api.exists(x64 + 'mdllib.dll')) && (await api.exists(x64 + 'studiomdl.exe')) ? x64 + 'studiomdl.exe' : `${cfg.tf2}\\bin\\studiomdl.exe`;
  if (!(await api.exists(exe))) return notice(`studiomdl.exe is not in ${cfg.tf2}\\bin.`);
  try {
    setCursor(`Propper: compiling ${rel}.mdl`);
    const sizes = new Map();
    for (const m of mats) {
      const key = `materials/models/${project}/propper/${slug(m)}.vmt`, path = `${custom}\\${key.replaceAll('/', '\\')}`, p = await getVmt(m);
      await write(path, vmt(p?.basetexture ?? m, p));
      addLoose(key, path);
      sizes.set(m, (await textureSize(m)) ?? { w: 512, h: 512 });
    }
    const [mn, mx] = boxOf(es), o = [Math.round((mn[0] + mx[0]) / 2), Math.round((mn[1] + mx[1]) / 2), Math.round(mn[2])];
    await write(`${src}.smd`, smd(vis, o, f => slug(matOf(f)), f => sizes.get(matOf(f))));
    await write(`${src}_phys.smd`, physSmd(es.map(c => c.faces), o));
    await write(`${src}.qc`, qc(name, project, slug(r.surfaceprop) || 'default', solids.length));
    show('compile'); // studiomdl's output goes to the compile log
    const res = await api.run([`"${exe}" -game "${tf}" -nop4 "${src}.qc"`]);
    if (res?.code !== 0) return notice('Propper: studiomdl failed. Its output is in the Compile panel.');
    // studiomdl writes to tf/models: move the model next to the materials, into the model index.
    // ponytail: the emptied tf/models/<project> folder stays (api.remove takes files only), and a model compiled again
    // under the same name shows the old one until restart (models.js caches by path)
    const out = `${tf}\\models\\${project}\\${name}`, idx = await assets();
    for (const ext of EXTS) {
      const st = await api.stat(out + ext);
      if (!st) continue;
      await api.writeBinary(dst + ext, await api.readBytes(out + ext, 0, st.size));
      await api.remove(out + ext);
      idx.set(rel + ext, dst + ext);
    }
    if (!idx.has(rel + '.mdl')) return notice(`Propper: studiomdl wrote no ${rel}.mdl. Its output is in the Compile panel.`);
    // the turn studiomdl gave the model (expected: none), undone by the prop's yaw
    const m = await loadMdl(`${rel}.mdl`, readAsset).catch(() => null);
    const want = V.bounds(vis.map(f => ({ pts: f.pts.map(p => p.map((x, k) => x - o[k])) }))), yaw = m?.bbox ? (360 - turnOf(want, m.bbox)) % 360 : 0;
    place(solids.filter(s => cache.has(s)), o, yaw, `${rel}.mdl`);
  } catch (e) { notice(`Propper failed: ${e.message}`); }
}

// The brushes out, a prop_static with model at o in: one undo step, the prop selected.
function place(solids, o, yaw, model) {
  if (!solids.length) return setCursor(`Propper: ${model} compiled; its brushes are gone, so no prop was placed`);
  const e = V.entity('prop_static', o, nextId);
  e.kv.splice(2, 0, ...fgdDefaults('prop_static').filter(([k]) => !['id', 'classname', 'origin'].includes(k)).map(x => [...x]));
  V.set(e, 'angles', `0 ${yaw} 0`);
  V.set(e, 'model', model);
  setSelection(solids);
  const k = editCount();
  deleteSel();
  addObjects([e]);
  if (editCount() - k === 2) mergeUndo();
  setCursor(`Propper: ${model} compiled, ${solids.length} brush(es) replaced`);
}

export function mount() {
  register('propper.compile', { title: 'Propper: compile the selected brushes into a static prop', run: compile });
}
