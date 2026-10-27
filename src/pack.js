// Custom content for bspzip: the materials, models and sounds the map references, resolved against the game's search
// paths. A file found loose under tf/custom/*/ or tf/ and in no VPK is custom: it gets packed. The compile step
// '@pack' calls prepare(); check() lists what the game cannot find.
import * as V from '../vmf.js';
import { openVpk } from './vpk.js';
import { getVmt, clean } from './materials.js';
import { cfg } from './settings.js';
import { doc } from './state.js';

const api = window.api;
const lower = (s = '') => s.toLowerCase().replace(/\\/g, '/').replace(/^\/+/, '');

// { materials: Set of names ('custom/foo'), models: Set of 'models/....mdl', sounds: Set of 'sound/....wav' }.
export function refs(root) {
  const materials = new Set(), models = new Set(), sounds = new Set(), mat = m => m && materials.add(clean(m));
  (function walk(n) {
    if (n.name === 'side') mat(V.get(n, 'material'));
    if (n.name === 'world' && V.get(n, 'skyname')) for (const f of ['bk', 'dn', 'ft', 'lf', 'rt', 'up']) mat(`skybox/${V.get(n, 'skyname')}${f}`);
    if (n.name === 'entity') {
      const cls = V.get(n, 'classname') ?? '', model = lower(V.get(n, 'model'));
      if (cls.startsWith('info_overlay')) mat(V.get(n, 'material'));
      if (cls === 'infodecal') mat(V.get(n, 'texture'));
      mat(V.get(n, 'RopeMaterial'));
      if (model.endsWith('.mdl')) models.add(model);
      else if (/\.(vmt|spr)$/.test(model)) mat(model.replace(/\.spr$/, '')); // sprites: the .spr name is a material
      // Leading characters are sound flags (')' spatial, '#' music, ...); a name without an extension is a soundscript.
      const s = cls === 'ambient_generic' ? lower(V.get(n, 'message')).replace(/^[*#@<>^)}$!?&~]+/, '') : '';
      if (/\.(wav|mp3|ogg)$/.test(s)) sounds.add(`sound/${s}`);
    }
    n.children.forEach(walk);
  })(root);
  return { materials, models, sounds };
}

// Materials a .mdl uses: per texture, its name under each $cdmaterials folder (the game takes the first that exists).
export function mdlMaterials(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), i32 = o => dv.getInt32(o, true);
  const str = o => { let e = o; while (e < b.length && b[e]) e++; return new TextDecoder().decode(b.subarray(o, e)); };
  if (b.length < 220 || i32(0) !== 0x54534449) return []; // 'IDST'
  const dirs = Array.from({ length: i32(212) }, (_, k) => lower(str(i32(i32(216) + k * 4))).replace(/\/?$/, '/'));
  return Array.from({ length: i32(204) }, (_, k) => { const t = i32(208) + k * 64; return dirs.map(d => clean(d + str(t + i32(t)))); });
}

const TEXKEY = /^\$\w+$/, NEEDED = /^\$(basetexture2?|bumpmap2?|normalmap|detail|envmapmask|blendmodulatetexture|selfillummask|phongexponenttexture|lightwarptexture)$/;
const MODEL_FILES = ['.vvd', '.dx90.vtx', '.dx80.vtx', '.sw.vtx', '.phy'];

// io: locate(rel) -> absolute path (a loose custom file: pack it) | true (elsewhere in the game) | null (missing);
// vmt(name) -> Map of lower-cased VMT keys | null; read(path) -> Uint8Array.
// -> { pack: Map<'materials/x.vtf', absolute path>, missing: sorted game-relative paths }
export async function resolve(root, io) {
  const { materials, models, sounds } = refs(root), pack = new Map(), missing = new Set(), seen = new Set();
  const want = async (rel, needed = true) => {
    const r = await io.locate(rel);
    if (typeof r === 'string') pack.set(rel, r);
    else if (!r && needed) missing.add(rel);
    return r;
  };
  // Stock and VPK materials come with their textures: only custom VMTs are read.
  async function material(m) {
    if (seen.has(m)) return;
    seen.add(m);
    if (typeof (await want(`materials/${m}.vmt`)) !== 'string') return;
    for (const [k, v] of (await io.vmt(m)) ?? []) {
      if (TEXKEY.test(k) && /^[\w\-./\\]+$/.test(v) && /[a-z_]/i.test(v)) await want(`materials/${clean(v)}.vtf`, NEEDED.test(k));
    }
  }
  for (const m of materials) await material(m);
  for (const p of models) {
    const r = await want(p);
    if (typeof r !== 'string') continue;
    for (const ext of MODEL_FILES) await want(p.replace(/\.mdl$/, ext), false);
    let texs = [];
    try { texs = mdlMaterials(await io.read(r)); } catch (e) { console.warn(p, e); }
    for (const names of texs) {
      let hit = null;
      for (const n of names) if (await io.locate(`materials/${n}.vmt`)) { hit = n; break; }
      if (hit) await material(hit);
      else if (names.length) missing.add(`materials/${names[0]}.vmt`);
    }
  }
  for (const s of sounds) await want(s);
  return { pack, missing: [...missing].sort() };
}

// bspzip -addlist: the path inside the BSP, then the file on disk, one per line.
export const addlist = pack => [...pack].map(([rel, abs]) => `${rel}\r\n${abs}\r\n`).join('');

// ---------- game files ----------
const STOCK = ['tf\\tf2_textures', 'tf\\tf2_misc', 'tf\\tf2_sound_misc', 'tf\\tf2_sound_vo_english', 'hl2\\hl2_textures', 'hl2\\hl2_misc',
  'hl2\\hl2_sound_misc', 'hl2\\hl2_sound_vo_english', 'platform\\platform_misc'];
let vpkFor = null, vpkSet = null;

// Every path in the game's VPKs and in VPKs under tf/custom (those cannot be packed from a loose file either).
// ponytail: read once per TF2 path; a VPK added to tf/custom later needs a restart.
async function vpkPaths(tf2) {
  const custom = ((await api.listDir(`${tf2}\\tf\\custom`)) ?? []).filter(d => !d.isDirectory && /\.vpk$/i.test(d.name) && !/_\d{3}\.vpk$/i.test(d.name));
  const all = [...STOCK.map(p => `${tf2}\\${p}_dir.vpk`), ...custom.map(d => `${tf2}\\tf\\custom\\${d.name}`)];
  const keys = await Promise.all(all.map(p => openVpk(p, api.readBytes, '').then(m => [...m.keys()], e => (console.warn(e.message), []))));
  return new Set(keys.flat());
}

async function scan(root) {
  const tf2 = cfg.tf2, tf = `${tf2}\\tf`;
  if (!tf2) throw new Error('set the TF2 folder in Settings first');
  if (vpkFor !== tf2) [vpkFor, vpkSet] = [tf2, vpkPaths(tf2)];
  const inVpk = await vpkSet, file = p => api.stat(p).then(s => !!s && !s.isDirectory);
  // Search order as the game: tf/custom/* (by name), then tf/.
  const roots = [...((await api.listDir(`${tf}\\custom`)) ?? []).filter(d => d.isDirectory).map(d => d.name).sort().map(n => `${tf}\\custom\\${n}`), tf];
  async function locate(rel) {
    if (inVpk.has(rel)) return true;
    const w = rel.replaceAll('/', '\\');
    for (const r of roots) if (await file(`${r}\\${w}`)) return `${r}\\${w}`;
    return (await file(`${tf2}\\hl2\\${w}`)) || (await file(`${tf2}\\platform\\${w}`)) || null;
  }
  const read = async p => new Uint8Array(await api.readBytes(p, 0, (await api.stat(p)).size));
  return resolve(root, { locate, vmt: async m => (await getVmt(m))?.kv ?? null, read });
}

// Compile step '@pack': writes <mapBase>.pack.txt. { cmds: the bspzip command, or [] when nothing needs packing,
// files: the game paths it packs, missing }.
export async function prepare(mapBase) {
  const { pack, missing } = await scan(doc.root), files = [...pack.keys()];
  if (!pack.size) return { cmds: [], files, missing };
  const list = `${mapBase}.pack.txt`;
  await api.write(list, addlist(pack));
  // -game: bspzip will not start without a gameinfo.txt. It keeps what vbsp packed (the default cubemaps).
  const cmd = `"${cfg.tf2}\\bin\\x64\\bspzip.exe" -game "${cfg.tf2}\\tf" -addlist "${mapBase}.bsp" "${list}" "${mapBase}.bsp"`;
  return { cmds: [cmd], files, missing };
}

// d: a { root } document (default: the open one; compile.js passes the map base name, which also means the open one).
export const check = async d => ({ missing: (await scan(d?.root ?? doc.root)).missing });
