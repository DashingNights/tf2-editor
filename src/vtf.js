// VTF (Valve texture) header, mip extraction and CPU decoding to RGBA. Pure.
export const FORMAT = {
  RGBA8888: 0, ABGR8888: 1, RGB888: 2, BGR888: 3, RGB565: 4, I8: 5, IA88: 6, P8: 7, A8: 8, RGB888_BLUESCREEN: 9, BGR888_BLUESCREEN: 10,
  ARGB8888: 11, BGRA8888: 12, DXT1: 13, DXT3: 14, DXT5: 15, BGRX8888: 16, BGR565: 17, BGRX5551: 18, BGRA4444: 19, DXT1_ONEBITALPHA: 20,
  BGRA5551: 21, UV88: 22, UVWQ8888: 23, RGBA16161616F: 24, RGBA16161616: 25, UVLX8888: 26,
};
const F = FORMAT;
const BPP = [4, 4, 3, 3, 2, 1, 2, 1, 1, 3, 3, 4, 4, 0, 0, 0, 4, 2, 2, 2, 0, 2, 2, 4, 8, 8, 4];
const BLOCK = { [F.DXT1]: 8, [F.DXT1_ONEBITALPHA]: 8, [F.DXT3]: 16, [F.DXT5]: 16 };
// Byte index of R, G, B, A in a pixel; -1: missing (colour 0, alpha 255).
const CH = {
  [F.RGBA8888]: [0, 1, 2, 3], [F.ABGR8888]: [3, 2, 1, 0], [F.RGB888]: [0, 1, 2, -1], [F.BGR888]: [2, 1, 0, -1], [F.ARGB8888]: [1, 2, 3, 0],
  [F.BGRA8888]: [2, 1, 0, 3], [F.BGRX8888]: [2, 1, 0, -1], [F.I8]: [0, 0, 0, -1], [F.IA88]: [0, 0, 0, 1], [F.A8]: [-1, -1, -1, 0], [F.UV88]: [0, 1, -1, -1],
};

const u8 = b => (b instanceof Uint8Array ? b : new Uint8Array(b));
export const mipBytes = (f, w, h) => (BLOCK[f] ? Math.ceil(w / 4) * Math.ceil(h / 4) * BLOCK[f] : w * h * (BPP[f] ?? 0));
const dim = (x, level) => Math.max(1, x >> level);

export function parseHeader(buf) {
  const b = u8(buf), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 64 || dv.getUint32(0, true) !== 0x00465456) throw new Error('not a VTF');
  const minor = dv.getUint32(8, true), headerSize = dv.getUint32(12, true), flags = dv.getUint32(20, true), firstFrame = dv.getUint16(26, true);
  const lowFormat = dv.getInt32(57, true);
  const h = {
    width: dv.getUint16(16, true), height: dv.getUint16(18, true), format: dv.getInt32(52, true), mipCount: b[56] || 1,
    frames: dv.getUint16(24, true) || 1, flags, version: dv.getUint32(4, true) + minor / 10,
    depth: minor >= 2 ? dv.getUint16(63, true) || 1 : 1,
    // Envmaps: 6 faces, plus a sphere map before 7.5 unless firstFrame is -1 (VTFLib's rule).
    faces: flags & 0x4000 ? (minor < 5 && firstFrame !== 0xffff ? 7 : 6) : 1,
    // Before 7.3 the low-res thumbnail sits between header and image data; from 7.3 a resource entry (tag 0x30) points at it.
    dataOffset: headerSize + (lowFormat >= 0 ? mipBytes(lowFormat, b[61], b[62]) : 0),
  };
  if (minor >= 3) for (let i = 0, n = dv.getUint32(68, true); i < n; i++) {
    const o = 80 + i * 8;
    if (b[o] === 0x30 && b[o + 1] === 0 && b[o + 2] === 0) h.dataOffset = dv.getUint32(o + 4, true);
  }
  return h;
}

// Frame 0, face 0, slice 0 of one mip level (0 = largest). Mips are stored smallest first, each holding frames x faces x slices.
export function getMip(buf, h, level = 0) {
  let off = h.dataOffset;
  for (let l = h.mipCount - 1; l > level; l--) off += mipBytes(h.format, dim(h.width, l), dim(h.height, l)) * dim(h.depth, l) * h.frames * h.faces;
  const width = dim(h.width, level), height = dim(h.height, level);
  return { width, height, format: h.format, data: u8(buf).subarray(off, off + mipBytes(h.format, width, height)) };
}

// RGBA8 pixels, rows top to bottom. Unknown formats and truncated data come out magenta.
export function decodeRGBA({ width: w, height: h, data: d, format: f }) {
  const out = new Uint8Array(w * h * 4);
  if (d.length < mipBytes(f, w, h) || !(BLOCK[f] || CH[f])) {
    for (let i = 0; i < out.length; i += 4) out.set([255, 0, 255, 255], i);
    return out;
  }
  if (BLOCK[f]) return dxt(d, w, h, f, out);
  const ch = CH[f], n = BPP[f];
  for (let i = 0, p = 0; i < out.length; i += 4, p += n) for (let c = 0; c < 4; c++) out[i + c] = ch[c] < 0 ? (c === 3 ? 255 : 0) : d[p + ch[c]];
  return out;
}

function rgb565(c, pal, i) {
  const r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31;
  pal[i] = (r << 3) | (r >> 2);
  pal[i + 1] = (g << 2) | (g >> 4);
  pal[i + 2] = (b << 3) | (b >> 2);
  pal[i + 3] = 255;
}

// Colour block at o -> 4 RGBA palette entries. DXT1 with c0 <= c1: 3 colours + transparent black; DXT3/5 always use 4 colours.
function colours(d, o, pal, dxt1) {
  const c0 = d[o] | (d[o + 1] << 8), c1 = d[o + 2] | (d[o + 3] << 8), four = !dxt1 || c0 > c1;
  rgb565(c0, pal, 0);
  rgb565(c1, pal, 4);
  for (let k = 0; k < 3; k++) {
    const a = pal[k], b = pal[4 + k];
    pal[8 + k] = four ? Math.round((2 * a + b) / 3) : Math.round((a + b) / 2);
    pal[12 + k] = four ? Math.round((a + 2 * b) / 3) : 0;
  }
  pal[11] = 255;
  pal[15] = four ? 255 : 0;
}

// DXT5 alpha: a0 > a1 gives 8 interpolated values, otherwise 6 plus 0 and 255.
function alphas(d, o, al) {
  const a0 = d[o], a1 = d[o + 1], n = a0 > a1 ? 7 : 5;
  al[0] = a0;
  al[1] = a1;
  for (let j = 1; j < n; j++) al[j + 1] = Math.round(((n - j) * a0 + j * a1) / n);
  if (n === 5) { al[6] = 0; al[7] = 255; }
}

function dxt(d, w, h, f, out) {
  const bs = BLOCK[f], bw = Math.ceil(w / 4), pal = new Uint8Array(16), al = new Uint8Array(8);
  for (let blk = 0, nb = bw * Math.ceil(h / 4); blk < nb; blk++) {
    const o = blk * bs, c = o + bs - 8, bx = (blk % bw) * 4, by = Math.floor(blk / bw) * 4;
    colours(d, c, pal, bs === 8);
    if (f === F.DXT5) alphas(d, o, al);
    const idx = (d[c + 4] | (d[c + 5] << 8) | (d[c + 6] << 16) | (d[c + 7] << 24)) >>> 0;
    const alo = d[o + 2] | (d[o + 3] << 8) | (d[o + 4] << 16), ahi = d[o + 5] | (d[o + 6] << 8) | (d[o + 7] << 16);
    for (let i = 0; i < 16; i++) {
      const x = bx + (i & 3), y = by + (i >> 2);
      if (x >= w || y >= h) continue;
      const p = (y * w + x) * 4, k = ((idx >>> (2 * i)) & 3) * 4;
      out[p] = pal[k];
      out[p + 1] = pal[k + 1];
      out[p + 2] = pal[k + 2];
      out[p + 3] = f === F.DXT3 ? ((d[o + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17
        : f === F.DXT5 ? al[((i < 8 ? alo : ahi) >> (3 * (i & 7))) & 7]
        : pal[k + 3];
    }
  }
  return out;
}
