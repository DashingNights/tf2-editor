// node --test test/details2.test.js: Details panel additions (key reset, colour picker maths, smoothing groups, hotspot).
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false } };
const D = await import('../src/details.js');
const C = await import('../src/colorpick.js');
const H = await import('../src/hotspot.js');

test('key reset: FGD defaults, flags as the sum of their default bits, unset empty keys stay unset', () => {
  const flags = { name: 'spawnflags', type: 'flags', default: '', flags: [{ bit: 1, default: true }, { bit: 2, default: false }, { bit: 4, default: true }] };
  assert.equal(D.defaultOf(flags), '5');
  assert.equal(D.defaultOf({ name: '_light', type: 'color255', default: '255 255 255 200', flags: [] }), '255 255 255 200');
  const name = { name: 'targetname', type: 'target_source', default: '', flags: [] };
  assert.equal(D.resetTo({ kv: [] }, name), undefined, 'no key added');
  assert.equal(D.resetTo({ kv: [['targetname', 'door1']] }, name), '');
  assert.equal(D.resetTo({ kv: [] }, flags), '5');
});

test('colour: RGB to HSV and back', () => {
  assert.deepEqual(C.rgbToHsv([255, 0, 0]), [0, 100, 100]);
  assert.deepEqual(C.hsvToRgb([120, 100, 100]), [0, 255, 0]);
  assert.deepEqual(C.hsvToRgb([240, 50, 100]), [128, 128, 255]);
  assert.deepEqual(C.hsvToRgb([-120, 100, 100]), [0, 0, 255], 'hue wraps');
  assert.deepEqual(C.hsvToRgb([0, 150, 100]), [255, 0, 0], 'saturation clamps');
  for (const c of [[12, 200, 77], [255, 255, 255], [0, 0, 0], [90, 40, 220], [255, 128, 0]]) assert.deepEqual(C.hsvToRgb(C.rgbToHsv(c)), c);
});

test('smoothing groups: one bit per group, other bits kept; the lowest free group', () => {
  assert.equal(D.setBit(0, 1, true), 1);
  assert.equal(D.setBit(5, 3, false), 1);
  assert.equal(D.setBit(0x80000000, 24, true), 0x80800000);
  assert.equal(D.setBit(0xffffffff, 1, false), 0xfffffffe);
  assert.equal(D.freeGroup([1, 2, 8]), 3);
  assert.equal(D.freeGroup([]), 1);
  assert.equal(D.freeGroup([0xffffff]), 0);
});

// The VDC example (developer.valvesoftware.com/wiki/Hotspot_texturing) with a rotate and an alt rectangle added.
const RECT = `Rectangles
{
	rectangle
	{
		min		"0 0"
		max		"512 32"
	}
	rectangle
	{
		min		"512 0"
		max		"768 32"
		reflect 1
	}
	rectangle
	{
		min "0 256"
		max "256 512"
		rotate 1
		alt 1
	}
	rectangle { min "8 8" max "8 64" }
}
`;

test('hotspot: .rect parse', () => {
  const r = H.parseRect(RECT);
  assert.deepEqual(r.map(x => [x.min, x.max]), [[[0, 0], [512, 32]], [[512, 0], [768, 32]], [[0, 256], [256, 512]]], 'the empty one is left out');
  assert.deepEqual(r.map(x => [x.rotate, x.reflect, x.alt]), [[false, false, false], [false, true, false], [true, false, true]]);
  assert.deepEqual(H.parseRect(''), []);
});

// texels a face's corners get on axis a: dot(p, a.v) / scale + shift
const range = (a, pts) => { const t = pts.map(p => (p[0] * a.v[0] + p[1] * a.v[1] + p[2] * a.v[2]) / a.scale + a.shift); return [Math.min(...t), Math.max(...t)].map(x => Math.round(x * 1e6) / 1e6); };
const ax = (v, scale = 0.25) => ({ v, shift: 0, scale });
// a wall facing -y, w wide along x and h high, u = +x, v = -z
const wall = (w, h) => [[0, 0, 0], [w, 0, 0], [w, 0, h], [0, 0, h]];

test('hotspot: the closest aspect ratio, spanned once', () => {
  const rects = H.parseRect(RECT), pts = wall(256, 16); // 16:1 -> the 512 x 32 strip, not the 256 x 32 one (8:1)
  const u = ax([1, 0, 0]), v = ax([0, 0, -1]);
  const r = H.fit(u, v, pts, rects, { rnd: () => 0.9 });
  assert.deepEqual([r.rect.max, r.rot], [[512, 32], false]);
  assert.deepEqual(range(u, pts), [0, 512]);
  assert.deepEqual(range(v, pts), [0, 32]);
  assert.equal(u.scale, 0.5);
  // 8:1 takes the 256 x 32 strip; reflect at random (rnd < 0.5) mirrors U: the left end at 768
  const u2 = ax([1, 0, 0]), v2 = ax([0, 0, -1]), p2 = wall(128, 16);
  H.fit(u2, v2, p2, rects, { rnd: () => 0 });
  assert.deepEqual(range(u2, p2), [512, 768]);
  assert.ok(u2.scale < 0);
  assert.equal(p2[0][0] / u2.scale + u2.shift, 768, 'x = 0 sits on the right edge');
});

test('hotspot: alternate rectangles, rotation, ties at random, faces without extent', () => {
  const rects = H.parseRect(RECT);
  // Alt: only the alt square; a 64 x 64 face fits it
  const u = ax([1, 0, 0]), v = ax([0, 0, -1]), sq = wall(64, 64);
  assert.equal(H.fit(u, v, sq, rects, { alt: true, rnd: () => 0 }).rect.min[1], 256);
  assert.deepEqual([range(u, sq), range(v, sq)], [[0, 256], [256, 512]]);
  // a tall face fits a rotate rectangle turned: u takes the old v, v the old -u
  const tall = [{ min: [0, 0], max: [512, 32], rotate: true }], ut = ax([1, 0, 0]), vt = ax([0, 0, -1]), pt = wall(16, 256);
  assert.equal(H.fit(ut, vt, pt, tall, { rnd: () => 0 }).rot, true);
  assert.deepEqual([ut.v, vt.v], [[0, 0, -1], [-1, -0, -0]]);
  assert.deepEqual([range(ut, pt), range(vt, pt)], [[0, 512], [0, 32]]);
  // equal matches: rnd picks
  const two = [{ min: [0, 0], max: [64, 64] }, { min: [64, 0], max: [128, 64] }];
  assert.equal(H.fit(ax([1, 0, 0]), ax([0, 0, -1]), sq, two, { rnd: () => 0 }).rect, two[0]);
  assert.equal(H.fit(ax([1, 0, 0]), ax([0, 0, -1]), sq, two, { rnd: () => 0.99 }).rect, two[1]);
  // an axis square to the face, or no rectangles: nothing
  assert.equal(H.fit(ax([0, 1, 0]), ax([0, 0, -1]), sq, two), null);
  assert.equal(H.fit(ax([1, 0, 0]), ax([0, 0, -1]), sq, []), null);
});

// A VPK v1 directory file holding one file, its bytes as preload data.
function vpk(dir, name, ext, text) {
  const data = new TextEncoder().encode(text), z = s => [...new TextEncoder().encode(s), 0], entry = new Uint8Array(18), dv = new DataView(entry.buffer);
  dv.setUint16(4, data.length, true);
  dv.setUint16(6, 0x7fff, true);
  dv.setUint16(16, 0xffff, true);
  const tree = Uint8Array.from([...z(ext), ...z(dir), ...z(name), ...entry, ...data, 0, 0, 0]), head = new DataView(new ArrayBuffer(12));
  head.setUint32(0, 0x55aa1234, true);
  head.setUint32(4, 1, true);
  head.setUint32(8, tree.length, true);
  return Uint8Array.from([...new Uint8Array(head.buffer), ...tree]);
}

test('hotspot: .rect lookup in a custom VPK, %rectanglemap first, loose files last', async () => {
  const { cfg } = await import('../src/settings.js'), api = globalThis.window.api, was = { ...api }, tf2 = cfg.tf2;
  const pack = vpk('materials/hs', 'trim', 'rect', 'Rectangles { rectangle { min "0 0" max "64 32" } }'), reads = [];
  Object.assign(api, {
    listDir: async p => (p === 'X:\\tf2\\tf\\custom' ? [{ name: 'b_loose', isDirectory: true }, { name: 'a_pack.vpk', isDirectory: false }] : null),
    readBytes: async (p, at, n) => pack.slice(at, at + n),
    read: async p => { reads.push(p); return p === 'X:\\tf2\\tf\\materials\\dev\\wall.rect' ? 'Rectangles { rectangle { min "0 0" max "16 16" } }' : null; },
  });
  cfg.tf2 = 'X:\\tf2';
  try {
    const vmt = async () => ({ kv: new Map([['%rectanglemap', 'HS/Trim']]) });
    assert.deepEqual((await H.rectsFor('DEV/WALL', vmt)).map(r => r.max), [[64, 32]], 'the VMT names the file in the VPK');
    assert.deepEqual((await H.rectsFor('DEV/WALL')).map(r => r.max), [[16, 16]], 'materials/<name>.rect, loose');
    assert.ok(reads.indexOf('X:\\tf2\\tf\\custom\\b_loose\\materials\\dev\\wall.rect') < reads.indexOf('X:\\tf2\\tf\\materials\\dev\\wall.rect'), 'custom folders first');
    assert.deepEqual(await H.rectsFor('DEV/NONE'), []);
  } finally {
    Object.assign(api, was);
    cfg.tf2 = tf2;
  }
});
