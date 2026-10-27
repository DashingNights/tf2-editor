// Drag and drop onto the window: a .vmf opens; an .svg is a Figma layout (figmaui.js); an image becomes a VTF + VMT
// under tf/custom/<project>/materials/.
// Over a brush face in the 3D view the image is imported with the defaults and applied to that face (Alt: an
// info_overlay on it instead); anywhere else the import dialog comes first.
import * as V from '../vmf.js';
import { emit } from './bus.js';
import { cfg, setCfg } from './settings.js';
import { S, sel, doc, open, edit, nextId, applyMaterial, setSelection, setCursor } from './state.js';
import { register } from './commands.js';
import { pick } from './view3d.js';
import { ask, notice } from './dialog.js';
import { el } from './dom.js';
import { addLoose } from './materials.js';
import { MIME, MODEL_MIME, applySel } from './texbrowser.js';
import { encode, decodeTga, pow2, alphaKind } from './vtfwrite.js';
import { dropped } from './figmaui.js';

const api = window.api;
const EXTS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tga'], IMAGE = new RegExp(`\\.(${EXTS.join('|')})$`, 'i');
const SHADERS = ['LightmappedGeneric', 'UnlitGeneric', 'VertexLitGeneric'];
const SURFACES = ['default', 'concrete', 'metal', 'wood', 'dirt', 'grass', 'glass', 'tile', 'brick', 'sand', 'rock', 'snow', 'water'];
const ALPHA = [['none', 'None'], ['$alphatest', 'Alpha test ($alphatest)'], ['$translucent', 'Translucent ($translucent)']];
const FORMATS = [['DXT1', 'DXT1 (no alpha)'], ['DXT5', 'DXT5 (alpha)'], ['BGRA8888', 'BGRA8888 (uncompressed)']];
const SIZES = Array.from({ length: 12 }, (_, i) => 2 ** i);
const fmt = x => String(Math.round(x * 1e6) / 1e6);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const slug = s => s.toLowerCase().trim().replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, '');
// Files from outside. A texture tile (an <img>) carries its image as a file too: not ours.
const fromOutside = e => e.dataTransfer?.types.includes('Files') && !e.dataTransfer.types.includes(MIME) && !e.dataTransfer.types.includes(MODEL_MIME);

// ---------- image ----------
// File -> ImageBitmap at its own size: TGA through vtfwrite.js, the rest through the browser's decoders.
async function decode(file) {
  let src = file;
  if (/\.tga$/i.test(file.name)) {
    const t = decodeTga(await file.arrayBuffer());
    src = new ImageData(new Uint8ClampedArray(t.rgba.buffer), t.width, t.height);
  }
  return createImageBitmap(src, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

// RGBA pixels of bmp scaled to w x h.
function pixels(bmp, w, h) {
  const g = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, 0, 0, w, h);
  return new Uint8Array(g.getImageData(0, 0, w, h).data.buffer);
}

function defaults(file, bmp) {
  const width = pow2(bmp.width), height = pow2(bmp.height), a = alphaKind(pixels(bmp, bmp.width, bmp.height)); // before resizing blurs 0/255 edges
  return {
    name: slug(file.name.replace(/\.[^.]*$/, '')) || 'image', folder: 'custom', project: cfg.project ?? 'mymap',
    shader: 'LightmappedGeneric', surfaceprop: 'default', alpha: { none: 'none', binary: '$alphatest', soft: '$translucent' }[a],
    format: a === 'none' ? 'DXT1' : 'DXT5', width, height, mips: true,
  };
}

const vmt = o => [`"${o.shader}"`, '{', `\t"$basetexture" "${o.folder}/${o.name}"`, `\t"$surfaceprop" "${o.surfaceprop}"`,
  ...(o.alpha === 'none' ? [] : [`\t"${o.alpha}" "1"`]), '\t"%keywords" "tf2editor"', '}', ''].join('\r\n');

// ---------- dialog ----------
let dlg;
// Edits o in place. Resolves true on Import.
function dialog(o, bmp, file) {
  dlg ??= document.body.appendChild(el('dialog', { id: 'import' }));
  const f = {}, NAME = '[\\w\\- ]+';
  const input = (k, pattern) => (f[k] = el('input', { value: o[k], required: true, pattern, spellcheck: false }));
  const select = (k, opts) => (f[k] = el('select', {}, ...opts.map(x => {
    const [v, t] = Array.isArray(x) ? x : [x, x];
    return el('option', { value: v, textContent: t, selected: String(v) === String(o[k]) });
  })));
  const row = (label, ...c) => el('label', {}, el('span', { textContent: label }), ...c);
  const preview = el('canvas'), size = el('small'), dest = el('small', { className: 'im-dest' });
  f.mips = el('input', { type: 'checkbox', checked: o.mips });
  const form = el('form', { method: 'dialog' },
    el('h3', { textContent: `Import ${file.name}` }),
    el('div', { className: 'im-body' },
      el('div', { className: 'im-preview' }, preview, size),
      el('div', { className: 'im-fields' },
        row('Name', input('name', NAME)), row('Folder', input('folder', `${NAME}(/${NAME})*`)), row('Project', input('project', NAME)),
        row('Shader', select('shader', SHADERS)), row('Surface', select('surfaceprop', SURFACES)), row('Transparency', select('alpha', ALPHA)),
        row('Format', select('format', FORMATS)), row('Size', el('span', { className: 'im-size' }, select('width', SIZES), 'x', select('height', SIZES))),
        row('Mipmaps', f.mips))),
    dest,
    el('div', { className: 'row' },
      el('button', { className: 'primary', value: 'ok', textContent: 'Import' }),
      el('button', { type: 'button', textContent: 'Cancel', onclick: () => dlg.close() })));
  const read = () => Object.assign(o, {
    name: slug(f.name.value), folder: f.folder.value.split('/').map(slug).join('/'), project: slug(f.project.value),
    shader: f.shader.value, surfaceprop: f.surfaceprop.value, alpha: f.alpha.value, format: f.format.value,
    width: +f.width.value, height: +f.height.value, mips: f.mips.checked,
  });
  const update = () => {
    read();
    [preview.width, preview.height] = [o.width, o.height];
    preview.getContext('2d').drawImage(bmp, 0, 0, o.width, o.height);
    const k = 200 / Math.max(o.width, o.height); // fit 200 px; small textures scale up with visible pixels
    Object.assign(preview.style, { width: `${o.width * k}px`, height: `${o.height * k}px`, imageRendering: k > 1 ? 'pixelated' : 'auto' });
    size.textContent = `${bmp.width} x ${bmp.height} -> ${o.width} x ${o.height}`;
    dest.textContent = `tf\\custom\\${o.project}\\materials\\${o.folder.replaceAll('/', '\\')}\\${o.name}.vtf / .vmt`;
  };
  f.alpha.onchange = () => { if (f.alpha.value !== 'none' && f.format.value === 'DXT1') f.format.value = 'DXT5'; };
  form.oninput = form.onchange = update;
  dlg.replaceChildren(form);
  update();
  dlg.returnValue = '';
  dlg.showModal();
  f.name.select();
  return new Promise(res => { dlg.onclose = () => res(dlg.returnValue === 'ok' && !!read()); });
}

// ---------- writing ----------
// New files under tf/custom: into the material index (the VTF first: adding the VMT reloads the material), then the
// texture browser re-lists.
function loaded(rel, base) {
  for (const ext of ['vtf', 'vmt']) addLoose(`materials/${rel}.${ext}`, `${base}.${ext}`);
  emit('materials', { added: [rel] });
}

// Writes the VTF and VMT. Returns the material name ('CUSTOM/FOO', upper case like Hammer) or null when cancelled.
async function save(o, bmp) {
  const rel = `${o.folder}/${o.name}`, base = `${cfg.tf2}\\tf\\custom\\${o.project}\\materials\\${rel.replaceAll('/', '\\')}`;
  if ((await api.stat(`${base}.vmt`)) && (await ask(`${rel} already exists in tf\\custom\\${o.project}. Replace it?`, ['Replace', 'Cancel'])) !== 0) return null;
  const vtf = encode({ width: o.width, height: o.height, rgba: pixels(bmp, o.width, o.height), mips: o.mips, format: o.format });
  await api.writeBinary(`${base}.vtf`, vtf);
  await api.writeBinary(`${base}.vmt`, new TextEncoder().encode(vmt(o)));
  const moved = o.project !== (cfg.project ?? 'mymap');
  if (moved) setCfg('project', o.project);
  loaded(rel, base);
  setCursor(`imported ${rel} into tf\\custom\\${o.project}${moved ? ` (later imports go there too: Settings > General > Project name)` : ''}`);
  return rel.toUpperCase();
}

// ---------- info_overlay ----------
// Unit vector of d flattened onto the plane with normal n; null when d is along n.
const flat = (d, n) => { const s = dot(d, n), r = d.map((x, k) => x - n[k] * s), l = Math.hypot(...r); return l > 1e-6 ? r.map(x => x / l) : null; };

// An info_overlay on face f (a vmf.js faces() entry) centred on point p: w x h units, scaled down to fit the face.
// BasisU is image right: Z x N on walls (so the image stands upright on every wall; a face's texture u axis points
// left on half of them), the face's texture u axis on floors and ceilings. BasisV = N x U (image up, read with
// StartV 1 / EndV 0 as Hammer writes them). Keys in Hammer's order.
export function overlay(f, p, w, h, material, nextId) {
  const n = f.n, a = V.nums(V.get(f.side, 'uaxis'));
  p = p.map((x, k) => x - n[k] * (dot(p, n) - dot(f.pts[0], n)));
  const u = (Math.abs(n[2]) < 0.7 && flat([-n[1], n[0], 0], n)) || flat(a.slice(0, 3).map(x => x * Math.sign(a[4] || 1)), n) || flat([1, 0, 0], n) || flat([0, 1, 0], n);
  const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  const span = d => { const t = f.pts.map(q => dot(q, d)); return Math.max(...t) - Math.min(...t); };
  const k = Math.min(1, span(u) / w, span(v) / h), x = (w * k) / 2, y = (h * k) / 2, vec = q => q.map(fmt).join(' ');
  const e = V.entity('info_overlay', p, nextId), [id, , origin] = e.kv;
  e.kv = [id, ['classname', 'info_overlay'], ['angles', '0 0 0'], ['BasisNormal', vec(n)], ['BasisOrigin', vec(p)], ['BasisU', vec(u)],
    ['BasisV', vec(v)], ['EndU', '1'], ['EndV', '0'], ['fademindist', '-1'], ['material', material], ['sides', V.get(f.side, 'id')],
    ['StartU', '0'], ['StartV', '1'], ['uv0', vec([-x, -y, 0])], ['uv1', vec([-x, y, 0])], ['uv2', vec([x, y, 0])], ['uv3', vec([x, -y, 0])], origin];
  return e;
}

function addOverlay(hit, material, w, h) {
  const r = doc.root, e = overlay(hit.face, [hit.point.x, hit.point.y, hit.point.z], w, h, material, nextId);
  edit([], [r], () => r.children.splice(r.children.findLastIndex(c => c.name === 'entity' || c.name === 'world') + 1, 0, e));
  setSelection([e]);
}

// ---------- import ----------
// to: { hit, overlay }: import with the defaults onto that face; { sel: true }: onto every face of the selected brushes
// (as the texture browser's apply). Without it the dialog comes first. Imports run one at a time (one dialog; a drop
// while it is open waits its turn).
let queue = Promise.resolve();
const importFile = (file, to) => (queue = queue.then(() => importOne(file, to)));
async function importOne(file, to) {
  if (!cfg.tf2) return notice('Set the TF2 folder in Settings first.');
  try {
    const bmp = await decode(file), o = defaults(file, bmp);
    if (!to && !(await dialog(o, bmp, file))) return;
    const mat = await save(o, bmp);
    if (!mat || !to) return;
    if (to.sel) applySel(mat);
    else if (to.overlay) addOverlay(to.hit, mat, bmp.width, bmp.height);
    else applyMaterial(mat, { solid: to.hit.node, side: to.hit.side });
  } catch (e) { notice(`Could not import ${file.name}: ${e.message}`); }
}

async function drop(e) {
  if (!fromOutside(e)) return; // texture thumbnails, dock tabs: not ours
  e.preventDefault(); // Electron would navigate to the file
  const files = [...e.dataTransfer.files], vmf = files.find(f => /\.vmf$/i.test(f.name)), images = files.filter(f => IMAGE.test(f.name));
  if (vmf) return api.pathFor(vmf) && open(api.pathFor(vmf));
  const svg = files.find(f => /\.svg$/i.test(f.name));
  if (svg) return dropped(await svg.text(), svg.name);
  if (!images.length) return notice(`Drop a .vmf to open it, a Figma .svg to build its layout, or an image (${EXTS.join(', ')}) to import it as a material.`);
  const canvas = e.target.closest?.('#v-3d')?.querySelector('canvas'), r = canvas?.getBoundingClientRect();
  const hit = r && pick(e.clientX - r.left, e.clientY - r.top);
  // On the 3D view with brushes selected (object mode, not an Alt overlay drop) the first image goes on every face of
  // them; else over a face only on that face. The other images get the dialog.
  const onSel = !!r && S.mode !== 'face' && !e.altKey && [...sel].some(n => n.name === 'solid');
  if (onSel) importFile(images[0], { sel: true });
  else if (hit?.node.name === 'solid') importFile(images[0], { hit, overlay: e.altKey });
  images.slice(onSel || hit?.node.name === 'solid' ? 1 : 0).forEach(f => importFile(f));

}

async function pickFiles() {
  for (const p of await api.openFiles([{ name: 'Images', extensions: EXTS }])) {
    const st = await api.stat(p);
    await importFile(new File([await api.readBytes(p, 0, st.size)], p.split(/[\\/]/).pop()));
  }
}

export function mount() {
  addEventListener('dragover', e => {
    if (!fromOutside(e)) return;

    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  addEventListener('drop', drop);
  register('import.image', { title: 'Import image as material...', run: pickFiles });
}
