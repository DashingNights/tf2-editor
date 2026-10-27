// node --test "test/*.test.js"
// vtfwrite.js output read back with vtf.js; TGA decoding; helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encode, decodeTga, half, pow2, alphaKind, FLAGS } from '../src/vtfwrite.js';
import { FORMAT as F, parseHeader, getMip, decodeRGBA } from '../src/vtf.js';

// 64 x 32: red across, green down, blue fixed, alpha across (0..252).
const W = 64, H = 32, img = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) img.set([x * 4, y * 8, 128, x * 4], (y * W + x) * 4);
const meanErr = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;
const maxErr = (a, b, ch) => a.reduce((m, v, i) => (ch.includes(i & 3) ? Math.max(m, Math.abs(v - b[i])) : m), 0);

test('DXT5 round trip: header, every mip present smallest first, gradient within DXT tolerance', () => {
  const buf = encode({ width: W, height: H, rgba: img, format: 'DXT5' }), h = parseHeader(buf);
  assert.deepEqual([h.width, h.height, h.format, h.mipCount, h.version, h.frames, h.depth], [W, H, F.DXT5, 7, 7.2, 1, 1]);
  assert.ok(h.flags & FLAGS.EIGHTBITALPHA && !(h.flags & FLAGS.NOMIP));
  // 80-byte header + 16x8 DXT1 low-res image (8 blocks x 8 bytes) + mips 64x32 .. 1x1
  const mipSum = [[64, 32], [32, 16], [16, 8], [8, 4], [4, 2], [2, 1], [1, 1]].reduce((s, [w, hh]) => s + Math.ceil(w / 4) * Math.ceil(hh / 4) * 16, 0);
  assert.equal(buf.byteLength, 80 + 64 + mipSum);
  const out = decodeRGBA(getMip(buf, h, 0));
  // A 2D gradient inside a 4x4 block is off the single DXT colour line: up to ~10 per channel, ~4 on average.
  assert.ok(maxErr(out, img, [0, 1, 2]) <= 12, `colour error ${maxErr(out, img, [0, 1, 2])}`);
  assert.ok(meanErr(out, img) <= 4, `mean error ${meanErr(out, img)}`);
  assert.ok(maxErr(out, img, [3]) <= 3, `alpha error ${maxErr(out, img, [3])}`);
  const m1 = getMip(buf, h, 1), ref = half({ width: W, height: H, rgba: img }).rgba;
  assert.deepEqual([m1.width, m1.height], [32, 16]);
  assert.ok(meanErr(decodeRGBA(m1), ref) <= 6, "mip 1 is the box-filtered level 0");
  // Red is weighted by alpha (= red here): sum(r^2) / sum(r) = 4 * 127 / 3.
  assert.ok(maxErr(decodeRGBA(getMip(buf, h, 6)), [169, 124, 128, 126], [0, 1, 2, 3]) <= 6, '1x1 mip is the alpha-weighted mean');
});

test('mips: transparent texels (0,0,0,0) do not darken the colour', () => {
  const fence = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; i++) fence.set(i % 2 ? [0, 0, 0, 0] : [255, 255, 255, 255], i * 4);
  assert.deepEqual([...half({ width: 4, height: 4, rgba: fence }).rgba.slice(0, 4)], [255, 255, 255, 128]);
  assert.deepEqual([...half({ width: 2, height: 1, rgba: new Uint8Array(8) }).rgba], [0, 0, 0, 0], 'all transparent: plain mean');
});

test('DXT1: opaque, no alpha flag; flat blocks are exact', () => {
  const flat = new Uint8Array(8 * 8 * 4).fill(255);
  const buf = encode({ width: 8, height: 8, rgba: flat, format: 'DXT1', mips: false }), h = parseHeader(buf);
  assert.deepEqual([h.format, h.mipCount], [F.DXT1, 1]);
  assert.ok(h.flags & FLAGS.NOMIP && h.flags & FLAGS.NOLOD && !(h.flags & FLAGS.EIGHTBITALPHA));
  assert.deepEqual(decodeRGBA(getMip(buf, h)), flat);
  const g = encode({ width: W, height: H, rgba: img, format: 'DXT1' }), gh = parseHeader(g), out = decodeRGBA(getMip(g, gh));
  assert.ok(maxErr(out, img, [0, 1, 2]) <= 12);
  assert.ok(out.every((v, i) => (i & 3) < 3 || v === 255));
});

test('BGRA8888 round trip is exact on every mip', () => {
  const buf = encode({ width: W, height: H, rgba: img, format: 'BGRA8888' }), h = parseHeader(buf);
  assert.equal(h.format, F.BGRA8888);
  assert.deepEqual(decodeRGBA(getMip(buf, h, 0)), img);
  assert.deepEqual(decodeRGBA(getMip(buf, h, 1)), half({ width: W, height: H, rgba: img }).rgba);
});

test('TGA: raw bottom-up 24-bit and RLE top-down 32-bit', () => {
  const head = (type, bits, desc) => [0, 0, type, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 2, 0, bits, desc];
  // bottom row first, BGR
  const raw = decodeTga(new Uint8Array([...head(2, 24, 0), 3, 2, 1, 6, 5, 4, 9, 8, 7, 12, 11, 10]));
  assert.deepEqual([...raw.rgba], [7, 8, 9, 255, 10, 11, 12, 255, 1, 2, 3, 255, 4, 5, 6, 255]);
  // run of 3 x (BGRA 1 2 3 4), then 1 raw pixel
  const rle = decodeTga(new Uint8Array([...head(10, 32, 0x28), 0x82, 1, 2, 3, 4, 0x00, 5, 6, 7, 8]));
  assert.deepEqual([...rle.rgba], [3, 2, 1, 4, 3, 2, 1, 4, 3, 2, 1, 4, 7, 6, 5, 8]);
  assert.throws(() => decodeTga(new Uint8Array([...head(1, 8, 0)])), /unsupported/);
  // 32 bits with 0 alpha bits in the descriptor (Valve's vtf2tga): the 4th byte is alpha unless it is 0 everywhere.
  const one = (desc, a) => [...decodeTga(new Uint8Array([...head(2, 32, desc).slice(0, 12), 1, 0, 1, 0, 32, desc, 1, 2, 3, a])).rgba];
  assert.deepEqual(one(0x20, 128), [3, 2, 1, 128]);
  assert.deepEqual(one(0x20, 0), [3, 2, 1, 255], 'all zero: padding');
});

test('pow2 and alphaKind', () => {
  assert.deepEqual([1, 3, 300, 384, 1000, 5000].map(pow2), [1, 4, 256, 512, 1024, 2048]);
  assert.deepEqual([[1, 2, 3, 255], [0, 0, 0, 0, 9, 9, 9, 255], [0, 0, 0, 128]].map(a => alphaKind(new Uint8Array(a))), ['none', 'binary', 'soft']);
});
