// node --test "test/*.test.js"
// Render features: vrad falloff, lightmap luxels, density hue and brush entity render keys (lighting.js); material
// proxies, VTF frames and forget() against an in-memory game folder (materials.js); the lit shader patch, render
// effects and the lightmap density mesh (view3d.js).
import test from 'node:test';
import assert from 'node:assert/strict';

// 4x4 RGBA8888 VTF 7.2: mips stored smallest first, each holding every frame; segment j is filled with first + j.
function vtf(frames, mips = 1, first = 1) {
  const b = Buffer.alloc(80), segs = [];
  b.write('VTF\0', 0, 'latin1');
  [7, 2, 80].forEach((v, i) => b.writeUInt32LE(v, 4 + i * 4));
  b.writeUInt16LE(4, 16); b.writeUInt16LE(4, 18); b.writeUInt16LE(frames, 24); b.writeInt32LE(0, 52); // RGBA8888
  b[56] = mips; b.writeInt32LE(-1, 57); b.writeUInt16LE(1, 63);
  for (let l = mips - 1; l >= 0; l--) for (let f = 0; f < frames; f++) segs.push(Buffer.alloc((4 >> l) ** 2 * 4, first + segs.length));
  return Buffer.concat([b, ...segs]);
}

const G = 'X:\\game', MATS = `${G}\\tf\\materials`, files = new Map(Object.entries({
  [`${MATS}\\anim\\water.vmt`]: `"UnlitGeneric" { "$basetexture" "anim/water" "Proxies" {
    "AnimatedTexture" { "animatedtexturevar" "$basetexture" "animatedtextureframenumvar" "$frame" "animatedtextureframerate" 10 }
    "TextureScroll" { "texturescrollvar" "$basetexturetransform" "texturescrollrate" .5 "texturescrollangle" 90 } } }`,
  [`${MATS}\\anim\\water.vtf`]: vtf(3),
  [`${MATS}\\dev\\plain.vmt`]: '"LightmappedGeneric" { "$basetexture" "dev/plain" }',
  [`${MATS}\\dev\\plain.vtf`]: vtf(1, 1, 7),
}).map(([k, v]) => [k, Buffer.from(v)]));
const listDir = async p => {
  const out = new Map();
  for (const f of files.keys()) if (f.startsWith(p + '\\')) { const rest = f.slice(p.length + 1).split('\\'); out.set(rest[0], rest.length > 1); }
  return out.size ? [...out].map(([name, isDirectory]) => ({ name, isDirectory })) : null;
};
globalThis.window = { api: {
  settingsPath: 'X:\\ud\\settings.json', read: async p => (p === 'X:\\ud\\settings.json' ? JSON.stringify({ tf2: G }) : null), write: async () => {}, exists: async () => false,
  readBytes: async (p, o, l) => files.get(p)?.subarray(o, o + l) ?? null, stat: async p => (files.has(p) ? { size: files.get(p).length, isDirectory: false } : null), listDir,
} };
globalThis.requestAnimationFrame ??= () => 0;
console.warn = () => {}; // the fake game has no VPKs
const THREE = await import('three');
const V = await import('../vmf.js');
const L = await import('../src/lighting.js');
const M = await import('../src/materials.js');
const { on } = await import('../src/bus.js');
const { setCfg } = await import('../src/settings.js');
const { parseHeader } = await import('../src/vtf.js');
const { makeMesh, litShader, setRenderMode } = await import('../src/view3d.js');

const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;
const ent = kv => ({ name: 'entity', kv: Object.entries(kv), children: [] });
const loaded = name => new Promise(r => { const off = on('material', d => { if (d.name === name) { off(); r(d.material); } }); });

test('falloff: the attenuation keys, normalised to the brightness at 100 units; _distance cuts off', () => {
  const q = L.falloff(ent({ _quadratic_attn: '1' })), l = L.falloff(ent({ _linear_attn: '1' })), c = L.falloff(ent({}));
  assert.ok(near(L.atten(q, 100), 1) && near(L.atten(q, 200), 0.25), 'quadratic');
  assert.ok(near(L.atten(l, 100), 1) && near(L.atten(l, 200), 0.5), 'linear');
  assert.ok(near(L.atten(c, 5), 1) && near(L.atten(c, 5000), 1), 'no keys: constant');
  const mix = L.falloff(ent({ _constant_attn: '1', _linear_attn: '0.01' }));
  assert.ok(near(L.atten(mix, 0), 2) && near(L.atten(mix, 100), 1), 'mixed keys: twice as bright at the centre');
  assert.ok(near(L.atten(L.falloff(ent({ _quadratic_attn: '0.0005' })), 1000), 1), 'under 0.001 counts as 0 (vrad EQUAL_EPSILON)');
  const cut = L.falloff(ent({ _quadratic_attn: '1', _distance: '256' }));
  assert.ok(L.atten(cut, 255) > 0 && L.atten(cut, 257) === 0);
  assert.equal(L.reach(cut, 1), 256);
  assert.equal(L.reach(q, 0.6), 2048, '0.6 * 100^2 / d^2 drops under 1/255 past 1237');
});

test('falloff: _fifty_percent_distance as vrad fits it, half at the 50 percent distance', () => {
  const far = L.falloff(ent({ _fifty_percent_distance: '100', _zero_percent_distance: '2000' }));
  assert.ok(near(L.atten(far, 0), 1) && near(L.atten(far, 100), 0.5) && near(L.atten(far, 2000), 1 / 256), 'through 1, 1/2, 1/256');
  // _zero_percent_distance unset is twice the 50: vrad's monotonic fit moves the middle point, then scales to 1/2 there
  const def = L.falloff(ent({ _fifty_percent_distance: '256' }));
  assert.ok(near(L.atten(def, 256), 0.5));
  assert.ok([0, 128, 256, 512, 1024].map(d => L.atten(def, d)).every((v, i, a) => !i || v < a[i - 1]), 'falls off all the way');
  const hard = L.falloff(ent({ _fifty_percent_distance: '100', _zero_percent_distance: '2000', _hardfalloff: '1' }));
  assert.deepEqual([hard.start, hard.end], [1525, 2000], 'fades from 3/4 of the way to the zero percent distance');
  assert.ok(near(L.atten(hard, 1525), L.atten(far, 1525)) && L.atten(hard, 2000) === 0);
  const lights = L.extract(V.parse('entity\n{\n"classname" "light_spot"\n"_quadratic_attn" "1"\n"origin" "0 0 0"\n}\n'));
  assert.ok(near(L.atten(lights[0].att, 100), 1), 'extract gives point and spot lights their falloff');
});

test('lightmap density: luxels along the unit texture axes, lightmapscale apart; hue from red to blue', () => {
  let id = 0;
  const b = V.block([0, 0, 0], [64, 64, 64], 'DEV/X', () => String(++id)), top = V.faces(b).find(f => f.n[2] > 0.99);
  V.set(top.side, 'uaxis', '[2 0 0 0] 0.25');
  V.set(top.side, 'vaxis', '[0 -1 0 5] 0.25');
  V.set(top.side, 'lightmapscale', '32');
  L.luxels(top).forEach(([u, v], i) => assert.ok(near(u, top.pts[i][0] / 32) && near(v, -top.pts[i][1] / 32), `corner ${i}`));
  top.side.kv = top.side.kv.filter(([k]) => !/^(uaxis|vaxis|lightmapscale)$/.test(k));
  const [a, c] = L.luxels(top), [p, r] = top.pts;
  assert.ok(near(Math.hypot(a[0] - c[0], a[1] - c[1]), Math.hypot(...p.map((x, k) => x - r[k])) / 16), 'no axes: in-plane axes, 16 units');
  assert.equal(L.densityHue(1), 0);
  assert.equal(L.densityHue(128), 2 / 3);
  assert.equal(L.densityHue(4096), 2 / 3);
  assert.ok(L.densityHue(4) < L.densityHue(16) && L.densityHue(16) < L.densityHue(64));
});

test('render effects: rendercolor tints, renderamt fades rendermode 1, 2 and 5 (added)', () => {
  assert.equal(L.renderFx(ent({ classname: 'func_brush' })), null);
  assert.equal(L.renderFx(ent({ rendercolor: '255 255 255', renderamt: '100' })), null, 'normal mode ignores renderamt');
  const red = L.renderFx(ent({ rendercolor: '255 0 0' })), glass = L.renderFx(ent({ rendermode: '2', renderamt: '51' }));
  assert.deepEqual([red.tint, red.alpha, red.add], [[1, 0, 0], 1, false]);
  assert.deepEqual([glass.tint, glass.alpha, glass.add], [[1, 1, 1], 0.2, false]);
  assert.equal(L.renderFx(ent({ rendermode: '5', renderamt: '255' })).add, true);
  assert.notEqual(red.key, glass.key);
});

test('VTF frames: frameMip steps over the frames inside a mip level', () => {
  const b = vtf(3, 2), h = parseHeader(b);
  assert.deepEqual([...new Set(M.frameMip(b, h, 0, 1).data)], [5], 'mip 1 holds frames 1-3, mip 0 frames 4-6');
  assert.deepEqual([...new Set(M.frameMip(b, h, 1, 2).data)], [3]);
  assert.equal(M.frameMip(b, h, 0, 0).data.length, 64);
});

test('proxies: AnimatedTexture cycles the frames, TextureScroll moves the offset, only while on', async () => {
  assert.equal(M.proxyAnim([]), null);
  assert.equal(M.proxyAnim([{ name: 'texturescroll', kv: new Map([['texturescrollvar', '$bumptransform']]) }]), null, 'only $basetexture');
  const a = M.proxyAnim((await M.getVmt('anim/water')).proxies);
  assert.ok(a.fps === 10 && near(a.scroll[0], 0) && near(a.scroll[1], 0.5));
  assert.equal(M.animAt(a, 3, 0.25).frame, 2);
  assert.equal(M.animAt(a, 3, 0.35).frame, 0, 'wraps round');
  assert.ok(near(M.animAt(a, 3, 0.25).offset[1], 0.125) && near(M.animAt({ fps: 0, scroll: [-0.5, 0] }, 1, 0.5).offset[0], 0.75));

  const m = M.getMaterial('anim/water');
  await loaded('anim/water');
  const now = performance.now;
  try {
    performance.now = () => 250;
    m.onBeforeRender();
    assert.equal(m.map.image.data[0], 3, 'frame 2 at 0.25 s');
    assert.ok(near(m.map.offset.y, 0.125));
    performance.now = () => 100;
    m.onBeforeRender();
    assert.equal(m.map.image.data[0], 2, 'frame 1 at 0.1 s');
    setCfg('proxies', false);
    assert.equal(m.map.image.data[0], 1, 'off: back to frame 0');
    m.onBeforeRender();
    assert.ok(m.map.image.data[0] === 1 && m.map.offset.y === 0);
  } finally {
    performance.now = now;
    setCfg('proxies', true);
  }
});

test('forget: a changed VTF or VMT loads again for the materials that use it', async () => {
  const m = M.getMaterial('DEV/PLAIN');
  await loaded('dev/plain');
  const old = m.map;
  assert.equal(old.image.data[0], 7);
  files.set(`${MATS}\\dev\\plain.vtf`, vtf(1, 1, 9));
  assert.deepEqual(M.forget(`${MATS}\\dev\\plain.vtf`), ['dev/plain'], 'a .vtf names the materials using it');
  await loaded('dev/plain');
  assert.ok(m.map !== old && m.map.image.data[0] === 9);
  files.set(`${MATS}\\dev\\plain.vmt`, Buffer.from('"LightmappedGeneric" { "$surfaceprop" "metal" }'));
  assert.deepEqual(M.forget('materials/Dev/Plain.vmt'), ['dev/plain']);
  await loaded('dev/plain');
  assert.ok(m.map === null && m.color.equals(M.flatColor('dev/plain')), 'no texture now: the flat colour');
});

test('lit shader: three\'s distance falloff swapped for vrad\'s', () => {
  const s = { uniforms: {}, fragmentShader: THREE.ShaderLib.lambert.fragmentShader };
  litShader(s);
  assert.ok(!s.fragmentShader.includes('#include <lights_pars_begin>') && s.fragmentShader.includes('vradK[ int( slot + 0.5 ) ]'));
  assert.ok(!s.fragmentShader.includes('pow( lightDistance, decayExponent )'));
  assert.equal(s.uniforms.vradK.value.length, 80);
});

test('brush meshes: render effects of the brush entity, vrad shadows, lightmap density', () => {
  let id = 0;
  const b = V.block([0, 0, 0], [64, 64, 64], 'DEV/A', () => String(++id)), faces = V.faces(b);
  const glass = { name: 'entity', kv: [['classname', 'func_brush'], ['rendermode', '2'], ['renderamt', '128'], ['rendercolor', '255 128 0']], children: [b] };
  const m = makeMesh({ node: b, faces, point: false, owner: glass }), base = M.getMaterial('dev/a'), f = m.material[0];
  assert.ok(f !== base && f.transparent && !f.depthWrite && near(f.opacity, 128 / 255));
  assert.ok(near(f.color.g, base.color.g * (128 / 255), 1e-6) && f.color.b === 0, 'tinted');
  assert.equal(makeMesh({ node: b, faces, point: false, owner: glass }).material[0], f, 'one copy per material and effect');
  assert.equal(m.castShadow, false, 'brush entities cast no vrad shadow');
  const detail = makeMesh({ node: b, faces, point: false, owner: { name: 'entity', kv: [['classname', 'func_detail']], children: [b] } });
  assert.ok(detail.castShadow && detail.material[0] === base);

  const top = faces.find(x => x.n[2] > 0.99), side = faces.find(x => x.n[0] > 0.99);
  V.set(top.side, 'lightmapscale', '4');
  V.set(side.side, 'material', 'TOOLS/TOOLSNODRAW');
  setRenderMode('lightmap', false);
  try {
    const lm = makeMesh({ node: b, faces, point: false }), uv = lm.geometry.getAttribute('uv'), col = lm.geometry.getAttribute('color');
    const dev = lm.userData.mats.indexOf('dev/a'), tool = lm.userData.mats.indexOf('tools/toolsnodraw');
    assert.ok(lm.userData.lm && lm.material[dev].map.image.width === 2, 'the checker');
    assert.ok(!lm.material[tool].map, 'tool faces have no lightmap');
    const at = i => new THREE.Color(col.getX(i), col.getY(i), col.getZ(i)).getHSL({}), tops = [];
    for (let i = 0; i < col.count; i++) if (faces[lm.userData.tri[Math.floor(i / 3)]] === top) tops.push(i);
    assert.ok(tops.length === 6 && tops.every(i => near(at(i).h, L.densityHue(4), 1e-4)), 'the top face: scale 4');
    const other = [...Array(col.count).keys()].find(i => ![top, side].includes(faces[lm.userData.tri[Math.floor(i / 3)]]));
    assert.ok(near(at(other).h, L.densityHue(16), 1e-4), 'the others: 16');
    const lx = L.luxels(top);
    assert.ok(near(uv.getX(tops[0]), lx[0][0], 1e-6) && near(uv.getY(tops[0]), lx[0][1], 1e-6), 'luxel uvs');
    assert.ok(near(at(lm.geometry.groups[tool].start).s, 0), 'tool faces untinted');
  } finally {
    setRenderMode('textured', false);
  }
});
