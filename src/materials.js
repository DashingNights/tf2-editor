// Material lookup (VPKs + loose files in game search-path order), VMT parsing, three.js textures, thumbnails, the
// AnimatedTexture and TextureScroll proxies, hotload (forget). Emits 'material' { name, material } when a material's
// texture is in place, 'proxies' while animated materials are drawn, 'forget' { names } when materials load again.
import * as THREE from 'three';
import * as V from '../vmf.js';
import { openVpk, readFile } from './vpk.js';
import { FORMAT as F, parseHeader, getMip, decodeRGBA, mipBytes } from './vtf.js';
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
  for (const p of textures.values()) p.then(drop);
  index = names = custom = null;
  [vmts, loaded, textures, sizes, thumbs].forEach(m => m.clear());
  for (const [k, m] of matCache) {
    flat(k, m);
    emit('material', { name: k, material: m });
    attach(k, m);
  }
});
// Back to the flat colour without a texture (a new TF2 path, or forget() found no texture any more).
function flat(k, m) {
  Object.assign(m, { map: null, transparent: false, depthWrite: true, alphaTest: 0, blending: THREE.NormalBlending, side: THREE.FrontSide, needsUpdate: true });
  m.color.copy(flatColor(k));
  unanimate(k, m);
}

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
// { shader, basetexture, basetexture2, translucent, alphatest, additive, nocull, color: [r, g, b], kv: Map,
// proxies: [{ name, kv: Map }] } or null. Names and keys are lower case.
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
  const kv = lower(sh.kv);
  if (sh.name.toLowerCase() !== 'patch') return { shader: sh.name.toLowerCase(), kv, proxies: proxiesOf(sh) };
  const base = await loadVmt(clean(kv.get('include')), depth + 1);
  for (const c of sh.children) if (base && /^(insert|replace)$/i.test(c.name)) {
    for (const [k, v] of c.kv) base.kv.set(k.toLowerCase(), v);
    base.proxies.push(...proxiesOf(c));
  }
  return base;
}
const lower = kv => new Map(kv.map(([k, v]) => [k.toLowerCase(), v]));
const proxiesOf = n => n.children.filter(c => /^proxies$/i.test(c.name)).flatMap(p => p.children.map(c => ({ name: c.name.toLowerCase(), kv: lower(c.kv) })));

function vmtParams(v) {
  if (!v) return null;
  const { kv } = v, flag = k => !!parseFloat(kv.get(k)), c = kv.get('$color');
  const color = c ? V.nums(c).map(x => (c.includes('{') ? x / 255 : x)) : [];
  return {
    shader: v.shader, kv, basetexture: kv.get('$basetexture'), basetexture2: kv.get('$basetexture2'),
    translucent: flag('$translucent'), alphatest: flag('$alphatest'), additive: flag('$additive'), nocull: flag('$nocull'),
    color: color.length >= 3 ? color.slice(0, 3) : [1, 1, 1], proxies: v.proxies,
  };
}

// ---------- proxies ----------
const num = (s, d) => (s === undefined || s === '' || !Number.isFinite(+s) ? d : +s), fract = x => x - Math.floor(x);
// What the AnimatedTexture and TextureScroll proxies do to $basetexture: { fps, scroll: [u, v] texture widths per
// second or null }, or null when they leave it alone. The engine's defaults: 15 frames a second, rate 1, angle 0.
export function proxyAnim(proxies = []) {
  let fps = 0, scroll = null;
  for (const { name, kv } of proxies) {
    const is = (k, v) => (kv.get(k) ?? '').toLowerCase() === v;
    if (name === 'animatedtexture' && is('animatedtexturevar', '$basetexture')) fps = Math.max(0, num(kv.get('animatedtextureframerate'), 15));
    if (name === 'texturescroll' && is('texturescrollvar', '$basetexturetransform')) {
      const r = num(kv.get('texturescrollrate'), 1), a = num(kv.get('texturescrollangle'), 0) * (Math.PI / 180);
      scroll = r ? [Math.cos(a) * r, Math.sin(a) * r] : null;
    }
  }
  return fps || scroll ? { fps, scroll } : null;
}
// Frame index and texture offset at time t (seconds): CBaseAnimatedTextureProxy's frame wraps round the n frames,
// CTextureScrollProxy's offset is the fraction of t * rate on each axis.
export const animAt = (a, n, t) => ({ frame: n > 1 && a.fps ? Math.floor(t * a.fps) % n : 0, offset: a.scroll ? a.scroll.map(x => fract(t * x)) : [0, 0] });

// m.onBeforeRender sets the frame and offset of the material being drawn (lit and render effect copies share it), so
// a material animates only while it is drawn, and a frame that drew one asks for the next ('proxies'), at the
// animation's own rate (30 a second for a scroll). View: material proxies (cfg.proxies) stops them on frame 0.
const anims = new Map(); // name -> { m, a, frames }; frames are copies of the material's own when it scrolls
let proxiesOn = cfg.proxies !== false, wake = 0, wakeAt = 0;
function animator(a, frames) {
  return function () {
    if (!proxiesOn) return;
    const now = performance.now(), s = animAt(a, frames.length, now / 1000);
    this.map = frames[s.frame];
    if (a.scroll) this.map.offset.set(...s.offset);
    const at = now + (a.scroll ? 33 : 1000 / a.fps);
    if (wake && wakeAt <= at) return;
    clearTimeout(wake);
    wakeAt = at;
    wake = setTimeout(() => { wake = 0; emit('proxies'); }, at - now);
  };
}
function unanimate(k, m) {
  const r = anims.get(k);
  if (r?.a.scroll) r.frames.forEach(t => t.dispose());
  anims.delete(k);
  delete m.onBeforeRender;
}
on('cfg', ({ key }) => {
  if (key !== 'proxies') return;
  proxiesOn = cfg.proxies !== false;
  for (const [name, r] of anims) {
    if (!proxiesOn) { r.m.map = r.frames[0]; r.frames.forEach(t => t.offset.set(0, 0)); }
    emit('material', { name, material: r.m }); // the lit and render effect copies follow
  }
});

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

// One mip level of animation frame f: getMip's frame 0 moved on by f frames (a mip level holds frames x faces x slices).
export function frameMip(buf, h, level = 0, f = 0) {
  const m = getMip(buf, h, level);
  if (!f) return m;
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf), n = mipBytes(h.format, m.width, m.height);
  const o = m.data.byteOffset - b.byteOffset + f * h.faces * Math.max(1, h.depth >> level) * n;
  return { ...m, data: b.subarray(o, o + n) };
}

// UVs are expected in texels (vmf.js uv(face, 1, 1)): texture.repeat = 1 / size maps them to 0..1, so geometry never waits for the size.
// f: the animation frame. Frame 0 of a multi-frame VTF keeps its file for framesOf.
const srcs = new WeakMap(), frameSets = new WeakMap();
function makeTexture(buf, h, f = 0) {
  const full = Math.floor(Math.log2(Math.max(h.width, h.height))) + 1;
  let t;
  if (S3TC[h.format] !== undefined && hasS3tc() && h.width % 4 === 0 && h.height % 4 === 0) {
    const mips = Array.from({ length: h.mipCount === full ? full : 1 }, (_, l) => frameMip(buf, h, l, f));
    t = new THREE.CompressedTexture(mips, h.width, h.height, S3TC[h.format]);
    t.minFilter = mips.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  } else {
    t = new THREE.DataTexture(decodeRGBA(frameMip(buf, h, 0, f)), h.width, h.height);
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
  if (!f && h.frames > 1) srcs.set(t, { buf, h });
  return t;
}
// Every frame of tex as a texture (frame 0 is tex), made on first use; frames the file cuts short are left out. own:
// copies for one material, as its scroll moves their offset (the copies share the uploaded image).
function framesOf(tex, own) {
  let fs = frameSets.get(tex);
  if (!fs) {
    const s = srcs.get(tex);
    let n = s?.h.frames ?? 1;
    while (n > 1 && frameMip(s.buf, s.h, 0, n - 1).data.length < mipBytes(s.h.format, s.h.width, s.h.height)) n--;
    frameSets.set(tex, (fs = Array.from({ length: n }, (_, f) => (f ? makeTexture(s.buf, s.h, f) : tex))));
  }
  return own ? fs.map(t => t.clone()) : fs;
}
const drop = t => { t?.dispose(); frameSets.get(t)?.forEach(x => x.dispose()); };

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
  if (g !== gen) return; // the TF2 path changed while loading
  if (!tex) return void (m.map && (flat(key, m), emit('material', { name: key, material: m }))); // forget(): gone now
  let a = proxyAnim(p.proxies), frames = a && framesOf(tex, !!a.scroll);
  if (a && !a.scroll && frames.length < 2) a = frames = null; // AnimatedTexture on a one-frame VTF: nothing moves
  unanimate(key, m);
  if (a) { anims.set(key, { m, a, frames }); m.onBeforeRender = animator(a, frames); }
  m.map = frames?.[0] ?? tex;
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
// ponytail: the disk cache is made again only for materials forget() named this session; key it on the VTF's mtime
// if files changed while the editor was closed matter.
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
  const file = `${thumbDir}\\${hex}.png`, st = !stale.has(name) && (await api.stat(file));
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

// ---------- hotload ----------
// Drops what is cached for a material, named ('DEV/FOO') or by a file under materials/ ('materials/dev/foo.vmt', an
// absolute path to a .vtf): its VMT and $basetexture, or for a .vtf every material that uses it as $basetexture.
// Materials in use load again ('material' redraws their faces; old textures are freed once the new ones are in) and
// thumbnails are made again, over the disk cache too. Emits 'forget' { names }; returns the names.
const stale = new Set(); // names whose thumbnail on disk is out of date
export function forget(name) {
  let p = String(name ?? '').toLowerCase().replace(/\\/g, '/');
  const at = /(?:^|\/)materials\//.exec(p);
  if (at) p = p.slice(at.index + at[0].length);
  const key = clean(p), names = new Set(), texs = new Set();
  if (/\.vtf$/.test(p)) texs.add(key);
  else {
    names.add(key);
    if (loaded.get(key)?.basetexture) texs.add(clean(loaded.get(key).basetexture));
  }
  for (const [n, v] of loaded) if (v?.basetexture && texs.has(clean(v.basetexture))) names.add(n);
  const old = [...texs].map(t => textures.get(t)).filter(Boolean);
  texs.forEach(t => textures.delete(t));
  for (const n of names) {
    [vmts, loaded, sizes].forEach(m => m.delete(n));
    for (const k of thumbs.keys()) if (k.startsWith(n + '@')) thumbs.delete(k);
    stale.add(n);
  }
  const back = [...names].filter(n => matCache.has(n)).map(n => attach(n, matCache.get(n)));
  Promise.all(back).then(() => old.forEach(t => t.then(drop)));
  emit('forget', { names: [...names] });
  return [...names];
}
