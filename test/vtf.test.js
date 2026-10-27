// node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { openVpk, readFile } from '../src/vpk.js';
import { FORMAT as F, parseHeader, getMip, decodeRGBA } from '../src/vtf.js';

const px = (rgba, i) => [...rgba.subarray(i * 4, i * 4 + 4)];
const block = (...bytes) => new Uint8Array(bytes);

test('DXT1: c0 > c1 gives 4 colours, c0 <= c1 gives 3 colours + transparent black', () => {
  // indices 0,1,2,3 for the first four pixels (0xe4), rest index 0
  const three = decodeRGBA({ width: 4, height: 4, format: F.DXT1, data: block(0x1f, 0x00, 0x00, 0xf8, 0xe4, 0, 0, 0) });
  assert.deepEqual([0, 1, 2, 3].map(i => px(three, i)), [[0, 0, 255, 255], [255, 0, 0, 255], [128, 0, 128, 255], [0, 0, 0, 0]]);
  const four = decodeRGBA({ width: 4, height: 4, format: F.DXT1_ONEBITALPHA, data: block(0x00, 0xf8, 0x1f, 0x00, 0xe4, 0, 0, 0) });
  assert.deepEqual([2, 3].map(i => px(four, i)), [[170, 0, 85, 255], [85, 0, 170, 255]]);
  const small = decodeRGBA({ width: 2, height: 2, format: F.DXT1, data: block(0x1f, 0x00, 0x00, 0xf8, 0xe4, 0, 0, 0) });
  assert.deepEqual(px(small, 1), [255, 0, 0, 255], 'blocks are clipped to small mips');
});

test('DXT3/DXT5: explicit and interpolated alpha, colour always 4-colour mode', () => {
  const colour = [0x1f, 0x00, 0x00, 0xf8, 0xe4, 0, 0, 0]; // c0 <= c1: would be 3-colour mode in DXT1
  const d3 = decodeRGBA({ width: 4, height: 4, format: F.DXT3, data: block(0xf0, 0, 0, 0, 0, 0, 0, 0, ...colour) });
  assert.deepEqual([0, 1, 3].map(i => px(d3, i)), [[0, 0, 255, 0], [255, 0, 0, 255], [170, 0, 85, 0]]);
  // a0 <= a1: 6 values + 0 + 255. pixel indices 6, 7, 2 -> 6 | 7 << 3 | 2 << 6 = 190
  const six = decodeRGBA({ width: 4, height: 4, format: F.DXT5, data: block(16, 128, 190, 0, 0, 0, 0, 0, ...colour) });
  assert.deepEqual([0, 1, 2].map(i => six[i * 4 + 3]), [0, 255, 38]);
  const eight = decodeRGBA({ width: 4, height: 4, format: F.DXT5, data: block(200, 100, 190, 0, 0, 0, 0, 0, ...colour) });
  // a0 > a1: 8 values; index j + 1 = ((7 - j) * a0 + j * a1) / 7
  assert.deepEqual([0, 1, 2].map(i => eight[i * 4 + 3]), [129, 114, 186]);
});

test('byte formats and unknown formats', () => {
  const d = block(10, 20, 30, 40);
  assert.deepEqual(px(decodeRGBA({ width: 1, height: 1, format: F.BGRA8888, data: d }), 0), [30, 20, 10, 40]);
  assert.deepEqual(px(decodeRGBA({ width: 1, height: 1, format: F.ABGR8888, data: d }), 0), [40, 30, 20, 10]);
  assert.deepEqual(px(decodeRGBA({ width: 1, height: 1, format: F.BGRX8888, data: d }), 0), [30, 20, 10, 255]);
  assert.deepEqual(px(decodeRGBA({ width: 2, height: 1, format: F.IA88, data: d }), 1), [30, 30, 30, 40]);
  assert.deepEqual(px(decodeRGBA({ width: 1, height: 1, format: F.UV88, data: d }), 0), [10, 20, 0, 255]);
  assert.deepEqual(px(decodeRGBA({ width: 1, height: 1, format: F.RGBA16161616F, data: new Uint8Array(8) }), 0), [255, 0, 255, 255]);
});

// Minimal VTF: 4x4 RGBA8888, mips stored smallest first, each holding every frame. Segment j is filled with j + 1.
function vtf(minor, { frames = 1, mips = 1, low = false, gap = 0 } = {}) {
  const hs = minor >= 3 ? 96 : 80, b = Buffer.alloc(hs), lowBytes = low ? 128 : 0, segs = [];
  b.write('VTF\0', 0, 'latin1');
  [7, minor, hs].forEach((v, i) => b.writeUInt32LE(v, 4 + i * 4));
  b.writeUInt16LE(4, 16); b.writeUInt16LE(4, 18); b.writeUInt16LE(frames, 24); b.writeInt32LE(F.RGBA8888, 52);
  b[56] = mips; b.writeInt32LE(low ? F.DXT1 : -1, 57); b[61] = b[62] = low ? 16 : 0; b.writeUInt16LE(1, 63);
  if (minor >= 3) { b.writeUInt32LE(1, 68); b.set([0x30, 0, 0, 0], 80); b.writeUInt32LE(hs + lowBytes + gap, 84); }
  for (let l = mips - 1; l >= 0; l--) for (let f = 0; f < frames; f++) segs.push(Buffer.alloc((4 >> l) ** 2 * 4, segs.length + 1));
  return Buffer.concat([b, Buffer.alloc(lowBytes + gap, 0xee), ...segs]);
}

test('getMip: 7.2 low-res thumbnail, 7.3 resource offset, frames per mip', () => {
  const a = vtf(2, { low: true }), ha = parseHeader(a);
  assert.equal(ha.dataOffset, 80 + 128);
  assert.deepEqual(getMip(a, ha).data, Buffer.alloc(64, 1));
  const b = vtf(3, { frames: 2, mips: 3, gap: 16 }), hb = parseHeader(b);
  assert.deepEqual([hb.width, hb.height, hb.frames, hb.mipCount, hb.version], [4, 4, 2, 3, 7.3]);
  assert.deepEqual(getMip(b, hb).data, Buffer.alloc(64, 5));
  assert.deepEqual(getMip(b, hb, 1).data, Buffer.alloc(16, 3));
  assert.deepEqual(getMip(b, hb, 2), { width: 1, height: 1, format: F.RGBA8888, data: Buffer.alloc(4, 1) });
});

// dev_measuregeneric01b is the grey grid, dev_measuregeneric01 the orange one (both DXT1, in the hl2 VPK).
const TF2 = 'D:/SteamLibrary/steamapps/common/Team Fortress 2';
test('dev_measuregeneric01/01b decode to orange and grey grids', { skip: !existsSync(TF2) && 'TF2 not installed' }, async () => {
  const readBytes = async (p, offset, length) => {
    const fh = await open(p);
    try { const b = Buffer.alloc(length); await fh.read(b, 0, length, offset); return b; } finally { await fh.close(); }
  };
  const vpk = await openVpk(`${TF2}/hl2/hl2_textures_dir.vpk`, readBytes);
  const pow2 = n => n > 0 && (n & (n - 1)) === 0;
  const load = async name => {
    const buf = await readFile(vpk.get(`materials/dev/${name}.vtf`)), h = parseHeader(buf);
    assert.ok(pow2(h.width) && pow2(h.height), `${h.width}x${h.height}`);
    for (let l = 1; l < h.mipCount; l++) assert.equal(getMip(buf, h, l).width, Math.max(1, h.width >> l));
    const rgba = decodeRGBA(getMip(buf, h));
    assert.equal(rgba.length, h.width * h.height * 4);
    return rgba;
  };
  const count = (rgba, f) => { let n = 0; for (let i = 0; i < rgba.length; i += 4) if (f(rgba[i], rgba[i + 1], rgba[i + 2])) n++; return n; };
  const orange = await load('dev_measuregeneric01'), grey = await load('dev_measuregeneric01b');
  assert.ok(count(orange, (r, g, b) => r > b + 100 && g > b) > orange.length / 8, 'orange');
  assert.equal(count(grey, (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b) > 8), 0, '01b is grey (565 rounding aside)');
  assert.ok(count(grey, r => r > 100) > 100, '01b has lighter grid lines');
});
