// VTF 7.2 writer (box-filtered mip chain, DXT1/DXT5 block compression, BGRA8888) and the image helpers import needs:
// TGA decoding, power-of-two sizes. Pure.
import { FORMAT as F } from './vtf.js';

export const FLAGS = { NOMIP: 0x100, NOLOD: 0x200, EIGHTBITALPHA: 0x2000 };
const u8 = b => (b instanceof Uint8Array ? b : new Uint8Array(b));

// Nearest power of two (in log scale), 1..2048.
export const pow2 = n => Math.min(2048, 2 ** Math.round(Math.log2(Math.max(1, n))));

// 'none' | 'binary' (only 0 or 255) | 'soft'.
export function alphaKind(rgba) {
  let k = 'none';
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 255) { if (rgba[i] > 0) return 'soft'; k = 'binary'; }
  return k;
}

// Next mip level: 2x2 box filter (a side already 1 pixel wide is averaged along the other axis only). Colour is
// weighted by alpha, so transparent texels (a canvas returns them as 0,0,0,0) do not darken the mips.
export function half({ width: w, height: h, rgba }) {
  const W = Math.max(1, w >> 1), H = Math.max(1, h >> 1), sx = w > 1 ? 2 : 1, sy = h > 1 ? 2 : 1, n = sx * sy, out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const s = [0, 0, 0, 0], sa = [0, 0, 0], o = (y * W + x) * 4;
    for (let j = 0; j < sy; j++) for (let i = 0; i < sx; i++) {
      const p = ((y * sy + j) * w + x * sx + i) * 4;
      for (let c = 0; c < 4; c++) s[c] += rgba[p + c];
      for (let c = 0; c < 3; c++) sa[c] += rgba[p + c] * rgba[p + 3];
    }
    for (let c = 0; c < 3; c++) out[o + c] = Math.round(s[3] ? sa[c] / s[3] : s[c] / n);
    out[o + 3] = Math.round(s[3] / n);
  }
  return { width: W, height: H, rgba: out };
}

// ---------- DXT ----------
// Flat scratch arrays: this runs once per 4x4 block (256k blocks for 2048 x 2048).
const px = new Uint8Array(64), pal = new Int32Array(12), t = new Float64Array(16);
const expand = (c, o) => { const r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31; pal[o] = (r << 3) | (r >> 2); pal[o + 1] = (g << 2) | (g >> 4); pal[o + 2] = (b << 3) | (b >> 2); }; // as vtf.js
const to565 = (r, g, b) => (Math.round((r * 31) / 255) << 11) | (Math.round((g * 63) / 255) << 5) | Math.round((b * 31) / 255);
const clamp = x => Math.min(255, Math.max(0, x));

// The 4x4 block at bx, by into px; pixels past the image edge repeat the last row or column.
function blockPixels({ width: w, height: h, rgba }, bx, by) {
  for (let i = 0; i < 16; i++) {
    const o = (Math.min(by + (i >> 2), h - 1) * w + Math.min(bx + (i & 3), w - 1)) * 4;
    for (let c = 0; c < 4; c++) px[i * 4 + c] = rgba[o + c];
  }
}

// Colour half of a block (8 bytes at o): the end points are the extremes of the pixels along the principal axis
// (power iteration on the covariance), quantised to 565; each pixel takes the nearest of the 4 palette colours.
function colourBlock(out, o) {
  const m = [0, 0, 0], C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 64; i += 4) for (let c = 0; c < 3; c++) m[c] += px[i + c] / 16;
  for (let i = 0; i < 64; i += 4) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a * 3 + b] += (px[i + a] - m[a]) * (px[i + b] - m[b]);
  const k = C[0] >= C[4] && C[0] >= C[8] ? 0 : C[4] >= C[8] ? 1 : 2;
  let v = [C[k * 3], C[k * 3 + 1], C[k * 3 + 2]];
  for (let it = 0; it < 6; it++) {
    const w = [0, 1, 2].map(r => C[r * 3] * v[0] + C[r * 3 + 1] * v[1] + C[r * 3 + 2] * v[2]), l = Math.hypot(...w);
    if (!(l > 1e-9)) break;
    v = w.map(x => x / l);
  }
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 16; i++) {
    t[i] = (px[i * 4] - m[0]) * v[0] + (px[i * 4 + 1] - m[1]) * v[1] + (px[i * 4 + 2] - m[2]) * v[2];
    lo = Math.min(lo, t[i]);
    hi = Math.max(hi, t[i]);
  }
  let c0 = to565(...m.map((x, c) => clamp(x + v[c] * hi))), c1 = to565(...m.map((x, c) => clamp(x + v[c] * lo)));
  if (c0 < c1) [c0, c1] = [c1, c0]; // c0 > c1: 4-colour mode in DXT1 too
  let idx = 0;
  if (c0 !== c1) {
    expand(c0, 0);
    expand(c1, 3);
    for (let c = 0; c < 3; c++) { pal[6 + c] = Math.round((2 * pal[c] + pal[3 + c]) / 3); pal[9 + c] = Math.round((pal[c] + 2 * pal[3 + c]) / 3); }
    for (let i = 0; i < 16; i++) {
      let best = 0, bd = Infinity;
      for (let q = 0; q < 4; q++) {
        const d = (pal[q * 3] - px[i * 4]) ** 2 + (pal[q * 3 + 1] - px[i * 4 + 1]) ** 2 + (pal[q * 3 + 2] - px[i * 4 + 2]) ** 2;
        if (d < bd) { bd = d; best = q; }
      }
      idx |= best << (2 * i);
    }
  }
  out.set([c0 & 255, c0 >> 8, c1 & 255, c1 >> 8, idx & 255, (idx >>> 8) & 255, (idx >>> 16) & 255, idx >>> 24], o);
}

// DXT5 alpha half (8 bytes at o): a0 = max > a1 = min selects the 8-value ramp; 3-bit index per pixel.
function alphaBlock(out, o) {
  let a0 = 0, a1 = 255;
  for (let i = 3; i < 64; i += 4) { a0 = Math.max(a0, px[i]); a1 = Math.min(a1, px[i]); }
  const ramp = [a0, a1, ...[1, 2, 3, 4, 5, 6].map(j => Math.round(((7 - j) * a0 + j * a1) / 7))], bits = [0, 0];
  if (a0 > a1) for (let i = 0; i < 16; i++) {
    let best = 0;
    for (let q = 1; q < 8; q++) if (Math.abs(ramp[q] - px[i * 4 + 3]) < Math.abs(ramp[best] - px[i * 4 + 3])) best = q;
    bits[i >> 3] |= best << (3 * (i & 7));
  }
  out.set([a0, a1, bits[0] & 255, (bits[0] >> 8) & 255, bits[0] >> 16, bits[1] & 255, (bits[1] >> 8) & 255, bits[1] >> 16], o);
}

function dxt(img, f) {
  const bs = f === F.DXT5 ? 16 : 8, bw = Math.ceil(img.width / 4), bh = Math.ceil(img.height / 4), out = new Uint8Array(bw * bh * bs);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const o = (by * bw + bx) * bs;
    blockPixels(img, bx * 4, by * 4);
    if (bs === 16) alphaBlock(out, o);
    colourBlock(out, o + bs - 8);
  }
  return out;
}

function pixels(img, f) {
  if (f !== F.BGRA8888) return dxt(img, f);
  const s = img.rgba, out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 4) out.set([s[i + 2], s[i + 1], s[i], s[i + 3]], i);
  return out;
}

// ---------- VTF ----------
const LIN = Array.from({ length: 256 }, (_, i) => (i / 255) ** 2.2);

// 80-byte 7.2 header. reflectivity: mean linear colour (VRAD bounce light). Low-res image: DXT1, <= 16 px.
function header(w, h, flags, f, mips, low, refl) {
  const b = new Uint8Array(80), dv = new DataView(b.buffer);
  [0x00465456, 7, 2, 80].forEach((v, i) => dv.setUint32(i * 4, v, true)); // 'VTF\0', version 7.2, header size
  dv.setUint16(16, w, true);
  dv.setUint16(18, h, true);
  dv.setUint32(20, flags, true);
  dv.setUint16(24, 1, true); // frames
  refl.forEach((v, i) => dv.setFloat32(32 + i * 4, v, true));
  dv.setFloat32(48, 1, true); // bumpmap scale
  dv.setInt32(52, f, true);
  b[56] = mips;
  dv.setInt32(57, F.DXT1, true);
  b[61] = low.width;
  b[62] = low.height;
  dv.setUint16(63, 1, true); // depth
  return b;
}

// { width, height, rgba (top row first), mips, format: 'DXT1' | 'DXT5' | 'BGRA8888', flags } -> ArrayBuffer of a VTF 7.2.
// DXT1 drops alpha. Mips are stored smallest first.
export function encode({ width, height, rgba, mips = true, format = 'DXT1', flags = 0 }) {
  const f = F[format], chain = [{ width, height, rgba: u8(rgba) }];
  if (![F.DXT1, F.DXT5, F.BGRA8888].includes(f)) throw new Error(`unsupported VTF format ${format}`);
  while (chain.at(-1).width > 1 || chain.at(-1).height > 1) chain.push(half(chain.at(-1)));
  const levels = mips ? chain.length : 1, n = width * height, refl = [0, 0, 0];
  for (let i = 0; i < n * 4; i++) if ((i & 3) < 3) refl[i & 3] += LIN[chain[0].rgba[i]] / n;
  flags |= (mips ? 0 : FLAGS.NOMIP | FLAGS.NOLOD) | (f !== F.DXT1 && alphaKind(chain[0].rgba) !== 'none' ? FLAGS.EIGHTBITALPHA : 0);
  const low = chain.find(m => Math.max(m.width, m.height) <= 16);
  const parts = [header(width, height, flags, f, levels, low, refl), dxt(low, F.DXT1), ...chain.slice(0, levels).reverse().map(m => pixels(m, f))];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  parts.reduce((o, p) => (out.set(p, o), o + p.length), 0);
  return out.buffer;
}

// ---------- TGA ----------
// Types 2/3 (true colour / grey) and 10/11 (the same, RLE); 8, 16 (grey + alpha), 24 or 32 bits. -> { width, height, rgba }.
export function decodeTga(buf) {
  const b = u8(buf), type = b[2], w = b[12] | (b[13] << 8), h = b[14] | (b[15] << 8), n = b[16] >> 3, desc = b[17];
  const grey = (type & 7) === 3;
  if (![2, 3, 10, 11].includes(type) || ![1, 2, 3, 4].includes(n) || grey !== n < 3 || !w || !h) throw new Error('unsupported TGA');
  let p = 18 + b[0] + (b[1] ? (b[5] | (b[6] << 8)) * Math.ceil(b[7] / 8) : 0); // skip the id and any colour map
  const px = new Uint8Array(w * h * n);
  if (type < 9) px.set(b.subarray(p, p + px.length));
  else for (let i = 0; i < px.length;) {
    const c = b[p++], k = (c & 127) + 1;
    if (c & 128) { for (let j = 0; j < k; j++, i += n) px.set(b.subarray(p, p + n), i); p += n; }
    else { px.set(b.subarray(p, p + k * n), i); p += k * n; i += k * n; }
  }
  // Alpha bits 0 with 32 bits (as Valve's vtf2tga writes): the 4th byte is still alpha, unless it is 0 everywhere (padding).
  const out = new Uint8Array(w * h * 4), top = desc & 0x20, alpha = (desc & 15) > 0 || px.some((v, i) => i % n === n - 1 && v);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = ((top ? y : h - 1 - y) * w + x) * n, a = n === 2 || n === 4 ? (alpha ? px[s + n - 1] : 255) : 255;
    out.set(grey ? [px[s], px[s], px[s], a] : [px[s + 2], px[s + 1], px[s], a], (y * w + x) * 4);
  }
  return { width: w, height: h, rgba: out };
}
