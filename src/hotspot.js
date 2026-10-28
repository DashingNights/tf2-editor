// Hotspot texturing (Hammer++, Strata Hammer): a material's .rect file lists rectangles of its texture, and a face is
// fitted to the rectangle whose aspect ratio is closest to its own. Format (developer.valvesoftware.com/wiki/
// Hotspot_texturing), in texels from the texture's top left; flags rotate, reflect, alt:
//   Rectangles { rectangle { min "0 0" max "512 32" } rectangle { min "512 0" max "768 32" reflect 1 } }
// The file sits beside the VMT, or the VMT names it with %rectanglemap (relative to materials/, no extension).
import * as V from '../vmf.js';
import { openVpk, readFile } from './vpk.js';
import { cfg } from './settings.js';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// .rect text -> [{ min: [x, y], max: [x, y], rotate, reflect, alt }]; empty rectangles are left out.
export function parseRect(text) {
  const out = [];
  (function walk(n) {
    for (const c of n.children) {
      if (!/^rectangle$/i.test(c.name)) { walk(c); continue; }
      const g = k => c.kv.find(p => p[0].toLowerCase() === k)?.[1], a = V.nums(g('min')), b = V.nums(g('max'));
      if (a.length < 2 || b.length < 2) continue;
      const r = { min: [Math.min(a[0], b[0]), Math.min(a[1], b[1])], max: [Math.max(a[0], b[0]), Math.max(a[1], b[1])], rotate: !!+g('rotate'), reflect: !!+g('reflect'), alt: !!+g('alt') };
      if (r.max[0] > r.min[0] && r.max[1] > r.min[1]) out.push(r);
    }
  })(V.parse(text ?? ''));
  return out;
}

// Fits the texture axes u and v of a face ({ v: [x, y, z], shift, scale } as details.js reads uaxis / vaxis; changed in
// place) to the rectangle closest to the face's aspect ratio (pts: its corners): scale and shift so the face spans the
// rectangle once, on the axes it has. Rectangles within 5 % of the best are picked at random, as Hammer++ does. A
// rotate rectangle may turn the texture 90 degrees (u becomes v, v becomes -u); a reflect one flips U half the time.
// alt: only the alternate rectangles (without alt they are skipped while there are others).
// Returns { rect, rot } or null (no rectangles, or the face has no extent along an axis).
export function fit(u, v, pts, rects, { alt = false, rnd = Math.random } = {}) {
  const ext = a => { const w = pts.map(p => dot(p, a.v)); return (Math.max(...w) - Math.min(...w)) / (Math.hypot(...a.v) || 1); };
  const fa = ext(u) / ext(v), pool = rects.filter(r => !!r.alt === alt);
  if (!(fa > 0 && Number.isFinite(fa))) return null;
  const cs = (pool.length ? pool : rects).flatMap(rect => {
    const a = (rect.max[0] - rect.min[0]) / (rect.max[1] - rect.min[1]);
    return [{ rect, rot: false, e: Math.abs(Math.log(fa / a)) }, ...(rect.rotate ? [{ rect, rot: true, e: Math.abs(Math.log(fa * a)) }] : [])];
  });
  if (!cs.length) return null;
  const best = Math.min(...cs.map(c => c.e)), near = cs.filter(c => c.e <= best + 0.05);
  const { rect: r, rot } = near[Math.min(near.length - 1, Math.floor(rnd() * near.length))];
  if (rot) [u.v, v.v] = [v.v, u.v.map(x => -x)];
  // the face's texels along axis a run from lo to hi (flip: hi to lo)
  const span = (a, lo, hi, flip) => {
    const w = pts.map(p => dot(p, a.v)), s = (flip ? -1 : 1) * Math.sign(a.scale || 1) * (Math.max(...w) - Math.min(...w)) / (hi - lo);
    a.scale = s;
    a.shift = lo - Math.min(...w.map(x => x / s));
  };
  span(u, r.min[0], r.max[0], r.reflect && rnd() < 0.5);
  span(v, r.min[1], r.max[1], false);
  return { rect: r, rot };
}

// 'DEV\Foo.vmt', 'materials/dev/foo' -> 'dev/foo'
const clean = n => n.toLowerCase().replace(/\\/g, '/').replace(/^\/+/, '').replace(/^materials\//, '').replace(/\.(vmt|vtf|rect)$/, '');

// Text of a game file ('materials/x/y.rect') in TF2's search order: tf/custom folders and VPKs by name, then loose tf
// and hl2 files; null when none has it. The stock VPKs are skipped: they hold no .rect files.
// ponytail: custom VPK trees are read once per session; a VPK rebuilt while the editor runs is not seen until restart.
const vpks = new Map();
async function readGame(key) {
  const api = window.api, root = cfg.tf2, tf = `${root}\\tf`, rel = key.replaceAll('/', '\\');
  if (!root) return null;
  for (const c of ((await api.listDir(`${tf}\\custom`)) ?? []).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    let t = null;
    if (c.isDirectory) t = await api.read(`${tf}\\custom\\${c.name}\\${rel}`);
    else if (/\.vpk$/i.test(c.name) && !/_\d{3}\.vpk$/i.test(c.name)) {
      const p = `${tf}\\custom\\${c.name}`;
      if (!vpks.has(p)) vpks.set(p, openVpk(p, api.readBytes).catch(() => new Map()));
      const e = (await vpks.get(p)).get(key);
      t = e && new TextDecoder().decode(await readFile(e));
    }
    if (t) return t;
  }
  for (const d of [tf, `${root}\\hl2`]) { const t = await api.read(`${d}\\${rel}`); if (t) return t; }
  return null;
}

// The rectangles of material name ([] without a .rect): the file its VMT names with %rectanglemap, else
// materials/<name>.rect. getVmt: materials.js getVmt, or nothing to skip the VMT.
export async function rectsFor(name, getVmt) {
  const vmt = getVmt ? await getVmt(name).catch(() => null) : null;
  for (const n of new Set([vmt?.kv?.get('%rectanglemap'), name].filter(Boolean).map(clean))) {
    const t = await readGame(`materials/${n}.rect`);
    if (t) return parseRect(t);
  }
  return [];
}
