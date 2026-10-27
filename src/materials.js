// Material lookup (VPKs + loose files in game search-path order), VMT parsing, three.js textures, thumbnails.
// Emits 'material' { name, material } when a material's texture is in place.
import * as THREE from 'three';
import * as V from '../vmf.js';
import { openVpk, readFile } from './vpk.js';
import { FORMAT as F, parseHeader, getMip, decodeRGBA } from './vtf.js';
import { on, emit } from './bus.js';
import { cfg } from './settings.js';

const api = window.api;
// 'DEV\Foo.vmt', 'materials/dev/foo' -> 'dev/foo'
export const clean = (n = '') => n.toLowerCase().replace(/\\/g, '/').replace(/^\/+/, '').replace(/^materials\//, '').replace(/\.(vmt|vtf)$/, '');

// ---------- flat colours (same as the untextured 3D view) ----------
const TOOL = { nodraw: 0xc9b23c, skybox: 0x5fb0e0, skip: 0x6a6a6a, hint: 0x8a8a8a, trigger: 0xe0892c, clip: 0x9a4fd0, playerclip: 0xb34fd0, npcclip: 0x4f7ad0, areaportal: 0xd04f8a, blocklight: 0x2a2a2a, blockbullets: 0x7a4a20, blockbullets2: 0x7a4a20, invisible: 0x9a9a9a, occluder: 0x505050 };
const hash = s => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };
export function flatColor(name) {
  const m = clean(name), t = m.startsWith('tools/tools') && TOOL[m.slice(11)];
  return t ? new THREE.Color(t) : new THREE.Color().setHSL((hash(m) % 360) / 360, 0.25, 0.5);
}

// ---------- file index: 'materials/...' -> VPK entry | absolute path. First source wins (gameinfo.txt order). ----------
let index = null, names = null, custom = null, gen = 0;
const vmts = new Map(), loaded = new Map(), textures = new Map(), sizes = new Map(), thumbs = new Map();
export const matCache = new Map();
// A new TF2 path: drop everything loaded from the old one. Materials already handed out go back to their flat colour
// and load again.
on('cfg', ({ key }) => {
  if (key !== 'tf2') return;
  gen++;
  for (const p of textures.values()) p.then(t => t?.dispose());
  index = names = custom = null;
  [vmts, loaded, textures, sizes, thumbs].forEach(m => m.clear());
  for (const [k, m] of matCache) {
    Object.assign(m, { map: null, transparent: false, depthWrite: true, alphaTest: 0, blending: THREE.NormalBlending, side: THREE.FrontSide, needsUpdate: true });
    m.color.copy(flatColor(k));
    emit('material', { name: k, material: m });
    attach(k, m);
  }
});

const getIndex = () => (index ??= buildIndex());
async function buildIndex() {
  const m = new Map(), tf = `${cfg.tf2}\\tf`, hl2 = `${cfg.tf2}\\hl2`;
  if (!cfg.tf2) return m;
  const add = (k, v) => m.has(k) || m.set(k, v);
  const vpk = p => openVpk(p, api.readBytes).then(es => es.forEach((v, k) => add(k, v)), e => console.warn(e.message));
  async function loose(dir, rel = 'materials/') {
    const items = (await api.listDir(dir)) ?? [];
    for (const d of items) if (!d.isDirectory) add(rel + d.name.toLowerCase(), `${dir}\\${d.name}`);
    await Promise.all(items.filter(d => d.isDirectory).map(d => loose(`${dir}\\${d.name}`, `${rel}${d.name.toLowerCase()}/`)));
  }
  for (const c of ((await api.listDir(`${tf}\\custom`)) ?? []).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (c.isDirectory) await loose(`${tf}\\custom\\${c.name}\\materials`);
    else if (/\.vpk$/i.test(c.name) && !/_\d{3}\.vpk$/i.test(c.name)) await vpk(`${tf}\\custom\\${c.name}`);
  }
  for (const p of [`${tf}\\tf2_textures_dir.vpk`, `${tf}\\tf2_misc_dir.vpk`, `${hl2}\\hl2_textures_dir.vpk`, `${hl2}\\hl2_misc_dir.vpk`]) await vpk(p);
  await loose(`${tf}\\materials`);
  await loose(`${hl2}\\materials`);
  return m;
}

async function readAsset(key) {
  const e = (await getIndex()).get(key);
  if (!e) return null;
  if (typeof e !== 'string') return readFile(e);
  const st = await api.stat(e);
  return st && new Uint8Array(await api.readBytes(e, 0, st.size));
}

// Sorted material names ('dev/dev_measuregeneric01b'), without 'materials/' and '.vmt'.
const vmtNames = m => [...m.keys()].filter(k => k.endsWith('.vmt')).map(k => k.slice(10, -4));
export const listMaterials = () => (names ??= getIndex().then(m => vmtNames(m).sort()));
// Set of the material names that come from tf/custom (a folder or a VPK there).
export const customMaterials = () => (custom ??= getIndex().then(m => {
  const dir = `${cfg.tf2}\\tf\\custom\\`.toLowerCase(), from = e => (typeof e === 'string' ? e : e.vpk.path).toLowerCase();
  return new Set(vmtNames(m).filter(n => from(m.get(`materials/${n}.vmt`)).startsWith(dir)));
}));

// A loose file written after indexing ('materials/foo/bar.vmt', absolute path), e.g. an imported image under
// tf/custom: it wins over the indexed entry, and what was loaded for that name loads again.
export function addLoose(key, path) {
  key = key.toLowerCase();
  const name = clean(key);
  index = getIndex().then(m => m.set(key, path));
  names = custom = null;
  vmts.delete(name);
  textures.delete(name);
  for (const k of thumbs.keys()) if (k.startsWith(name + '@')) thumbs.delete(k);
  if (matCache.has(name)) attach(name, matCache.get(name));
}

// ---------- VMT ----------
// { shader, basetexture, basetexture2, translucent, alphatest, additive, nocull, color: [r, g, b], kv: Map } or null.
export function getVmt(name) {
  const key = clean(name);
  if (!vmts.has(key)) vmts.set(key, loadVmt(key).then(vmtParams).catch(e => (console.warn(key, e), null)).then(p => (loaded.set(key, p), p)));
  return vmts.get(key);
}
// The same once loaded (getMaterial loads it), else undefined.
export const vmtNow = name => loaded.get(clean(name));

async function loadVmt(key, depth = 0) {
  const bytes = depth < 8 && (await readAsset(`materials/${key}.vmt`));
  if (!bytes) return null;
  // Drop platform conditionals such as [$X360] outside quotes; vmf.js parse reads the rest (same KeyValues syntax).
  const text = new TextDecoder().decode(bytes).replace(/("[^"]*")|\[[^\]"\n]*\]/g, (m, q) => q ?? '');
  const sh = V.parse(text).children[0];
  if (!sh) return null;
  const kv = new Map(sh.kv.map(([k, v]) => [k.toLowerCase(), v]));
  if (sh.name.toLowerCase() !== 'patch') return { shader: sh.name.toLowerCase(), kv };
  const base = await loadVmt(clean(kv.get('include')), depth + 1);
  for (const c of sh.children) if (base && /^(insert|replace)$/i.test(c.name)) for (const [k, v] of c.kv) base.kv.set(k.toLowerCase(), v);
  return base;
}

function vmtParams(v) {
  if (!v) return null;
  const { kv } = v, flag = k => !!parseFloat(kv.get(k)), c = kv.get('$color');
  const color = c ? V.nums(c).map(x => (c.includes('{') ? x / 255 : x)) : [];
  return {
    shader: v.shader, kv, basetexture: kv.get('$basetexture'), basetexture2: kv.get('$basetexture2'),
    translucent: flag('$translucent'), alphatest: flag('$alphatest'), additive: flag('$additive'), nocull: flag('$nocull'),
    color: color.length >= 3 ? color.slice(0, 3) : [1, 1, 1],
  };
}

// ---------- textures ----------
const S3TC = { [F.DXT1]: THREE.RGBA_S3TC_DXT1_Format, [F.DXT1_ONEBITALPHA]: THREE.RGBA_S3TC_DXT1_Format, [F.DXT3]: THREE.RGBA_S3TC_DXT3_Format, [F.DXT5]: THREE.RGBA_S3TC_DXT5_Format };
let s3tc;
function hasS3tc() {
  if (s3tc === undefined) {
    const gl = document.createElement('canvas').getContext('webgl2');
    s3tc = !!gl?.getExtension('WEBGL_compressed_texture_s3tc');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  }
  return s3tc;
}

// UVs are expected in texels (vmf.js uv(face, 1, 1)): texture.repeat = 1 / size maps them to 0..1, so geometry never waits for the size.
function makeTexture(buf, h) {
  const full = Math.floor(Math.log2(Math.max(h.width, h.height))) + 1;
  let t;
  if (S3TC[h.format] !== undefined && hasS3tc() && h.width % 4 === 0 && h.height % 4 === 0) {
    const mips = Array.from({ length: h.mipCount === full ? full : 1 }, (_, l) => getMip(buf, h, l));
    t = new THREE.CompressedTexture(mips, h.width, h.height, S3TC[h.format]);
    t.minFilter = mips.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  } else {
    t = new THREE.DataTexture(decodeRGBA(getMip(buf, h)), h.width, h.height);
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
  }
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.flipY = false;
  t.anisotropy = 4;
  t.repeat.set(1 / h.width, 1 / h.height);
  t.userData.size = { w: h.width, h: h.height };
  t.needsUpdate = true;
  return t;
}

function getTexture(name) {
  const key = clean(name);
  if (!textures.has(key)) textures.set(key, readAsset(`materials/${key}.vtf`).then(b => b && makeTexture(b, parseHeader(b))).catch(e => (console.warn(key, e), null)));
  return textures.get(key);
}

// ---------- materials ----------
// MeshBasicMaterial with the flat colour now; map, $color, blending and culling are filled in once the VTF loads.
// vertexColors is on: geometry needs a 'color' attribute (the per-face shade, as in the flat view).
export function getMaterial(name) {
  const key = clean(name);
  let m = matCache.get(key);
  if (!m) {
    matCache.set(key, (m = new THREE.MeshBasicMaterial({ color: flatColor(key), vertexColors: true })));
    attach(key, m);
  }
  return m;
}

async function attach(key, m) {
  const g = gen, p = await getVmt(key), tex = p?.basetexture && (await getTexture(p.basetexture));
  if (!tex || g !== gen) return; // g !== gen: the TF2 path changed while loading
  m.map = tex;
  m.color.setRGB(...p.color);
  m.transparent = p.translucent || p.additive;
  m.depthWrite = !m.transparent;
  m.alphaTest = p.alphatest ? 0.5 : 0;
  m.blending = p.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
  m.side = p.nocull ? THREE.DoubleSide : THREE.FrontSide;
  m.needsUpdate = true;
  sizes.set(key, tex.userData.size);
  emit('material', { name: key, material: m });
}

// { w, h } of the material's $basetexture once getMaterial(name) has loaded it; null before, or when it has none.
export const getTextureSize = name => sizes.get(clean(name)) ?? null;
// The same, loading the texture first when needed (null when the material has no $basetexture).
export async function textureSize(name) {
  const p = await getVmt(name), tex = p?.basetexture && (await getTexture(p.basetexture));
  return tex?.userData.size ?? null;
}

// ---------- thumbnails ----------
const thumbDir = api.settingsPath.replace(/[\\/][^\\/]*$/, '') + '\\thumbs';
const dataURL = bytes => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = rej;
  r.readAsDataURL(new Blob([bytes], { type: 'image/png' }));
});

// PNG data URL, size x size, aspect kept. Cached in memory (the last THUMBS) and in userData/thumbs (a missing texture
// gets a flat swatch, not cached on disk).
// ponytail: disk cache is never invalidated; key it on the VTF's mtime once custom textures can change.
const THUMBS = 3000;
export function thumbnail(name, size = 64) {
  const key = `${clean(name)}@${size}`;
  let p = thumbs.get(key);
  if (p) thumbs.delete(key); // re-inserted below: the Map's order is least recently used first
  else if (thumbs.size >= THUMBS) thumbs.delete(thumbs.keys().next().value);
  thumbs.set(key, (p ??= makeThumb(clean(name), size, key)));
  return p;
}

async function makeThumb(name, size, key) {
  const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(key)))].map(b => b.toString(16).padStart(2, '0')).join('');
  const file = `${thumbDir}\\${hex}.png`, st = await api.stat(file);
  if (st) return dataURL(await api.readBytes(file, 0, st.size));
  const c = new OffscreenCanvas(size, size), g = c.getContext('2d');
  const ok = await drawTexture(g, name, size).catch(e => console.warn(name, e));
  if (!ok) {
    g.fillStyle = '#' + flatColor(name).getHexString();
    g.fillRect(0, 0, size, size);
  }
  const bytes = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
  if (ok) api.writeBinary(file, bytes).catch(e => console.warn(file, e));
  return dataURL(bytes);
}

// Draws the smallest mip that still covers size, centred. Opaque materials ignore texture alpha (DXT1 black is transparent).
async function drawTexture(g, name, size) {
  const p = await getVmt(name), buf = p?.basetexture && (await readAsset(`materials/${clean(p.basetexture)}.vtf`));
  if (!buf) return false;
  const h = parseHeader(buf);
  let l = 0;
  while (l + 1 < h.mipCount && Math.max(h.width, h.height) >> (l + 1) >= size) l++;
  const mip = getMip(buf, h, l), rgba = decodeRGBA(mip), k = size / Math.max(mip.width, mip.height);
  if (!p.translucent && !p.alphatest && !p.additive) for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  const src = new OffscreenCanvas(mip.width, mip.height);
  src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer), mip.width, mip.height), 0, 0);
  g.drawImage(src, (size - mip.width * k) / 2, (size - mip.height * k) / 2, mip.width * k, mip.height * k);
  return true;
}
