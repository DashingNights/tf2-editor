// node --test "test/*.test.js"
// mdl.js against real TF2 models (skipped without the game), and the Source angle convention models.js places with.
import test from 'node:test';
import assert from 'node:assert/strict';
import { open, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import * as V from '../vmf.js';
import { openVpk, readFile } from '../src/vpk.js';
import * as M from '../src/mdl.js';

const TF2 = 'D:\\SteamLibrary\\steamapps\\common\\Team Fortress 2', MISC = `${TF2}\\tf\\tf2_misc_dir.vpk`;
const skip = !existsSync(MISC) && 'TF2 not installed';
async function readBytes(p, offset, length) {
  const fh = await open(p);
  try { const b = Buffer.alloc(length); const { bytesRead } = await fh.read(b, 0, length, offset); return b.subarray(0, bytesRead); }
  finally { await fh.close(); }
}

test('cap_point_base: geometry, indices in range, skins, materials resolve to a VMT', { skip }, async () => {
  const vpk = await openVpk(MISC, readBytes, 'models/'), read = async k => (vpk.has(k) ? readFile(vpk.get(k)) : null);
  const m = await M.load('Models\\Props_Gameplay\\cap_point_base.mdl', read);
  assert.ok(m.meshes.length > 0);
  for (const s of m.meshes) {
    const n = s.positions.length / 3;
    assert.ok(n > 0 && s.normals.length === n * 3 && s.uvs.length === n * 2);
    assert.ok(s.indices.length > 0 && s.indices.length % 3 === 0 && s.indices.every(i => i < n), 'triangles index the mesh vertices');
    assert.ok(s.materialIndex >= 0 && s.materialIndex < m.skins[0].length);
    // Counter-clockwise seen from outside: the triangle's normal agrees with its vertex normals.
    const P = i => new THREE.Vector3().fromArray(s.positions, i * 3), [a, b, c] = [0, 1, 2].map(k => s.indices[k]);
    const face = P(b).sub(P(a)).cross(P(c).sub(P(a)));
    assert.ok(face.dot(new THREE.Vector3().fromArray(s.normals, a * 3)) > 0, 'winding');
  }
  assert.deepEqual(m.materials[0], ['models/props_gameplay/cap_point_base']);
  assert.equal(m.skins.length, 3, 'neutral, red and blue skins');
  assert.notDeepEqual(m.skins[1], m.skins[0]);
  const [mn, mx] = m.bbox;
  assert.ok(mx[0] - mn[0] > 150 && mx[2] - mn[2] < 32, 'a wide flat disc');
  assert.equal(await M.load('models/nothing/here.mdl', read), null);
  assert.throws(() => M.parseMdl(new Uint8Array(256)), /not a studio model/);

  // materials.js finds the VMT (fake window.api over the real game folder).
  const ls = async p => (await readdir(p, { withFileTypes: true }).catch(() => null))?.map(d => ({ name: d.name, isDirectory: d.isDirectory() })) ?? null;
  globalThis.window = { api: {
    settingsPath: 'X:\\none\\settings.json', read: async p => (p.endsWith('settings.json') ? JSON.stringify({ tf2: TF2 }) : null), write: async () => {}, exists: async () => false,
    readBytes, stat: async p => stat(p).then(s => ({ size: s.size, isDirectory: s.isDirectory() }), () => null), listDir: ls,
  } };
  const mats = await import('../src/materials.js');
  const vmt = await mats.getVmt(m.materials[m.skins[0][m.meshes[0].materialIndex]][0]);
  assert.match(vmt?.shader ?? '', /vertexlitgeneric/);
  assert.ok(vmt.basetexture);
});

test('every 25th TF2 model with vertex data parses', { skip }, async () => {
  const vpk = await openVpk(MISC, readBytes, 'models/'), read = async k => (vpk.has(k) ? readFile(vpk.get(k)) : null);
  const paths = [...vpk.keys()].filter(k => k.endsWith('.mdl') && vpk.has(k.slice(0, -4) + '.vvd')).filter((_, i) => i % 25 === 0);
  let ok = 0;
  for (const p of paths) if ((await M.load(p, read))?.meshes.length) ok++;
  assert.ok(ok >= paths.length * 0.99, `${ok} of ${paths.length}`);
});

test('angles: Euler(roll, pitch, yaw, ZYX) is the rotation vmf.js rotate writes as pitch yaw roll', () => {
  const e = V.entity('prop_static', [0, 0, 0], () => '1');
  V.set(e, 'angles', '0 0 0');
  V.rotate(e, [0, 0, 0], 2, 30); // yaw 30
  V.rotate(e, [0, 0, 0], [0, 1, 0], -20); // then about world Y
  V.rotate(e, [0, 0, 0], 0, 45); // then about world X
  const [p, y, r] = V.nums(V.get(e, 'angles')).map(a => (a * Math.PI) / 180);
  const placed = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(r, p, y, 'ZYX'));
  const want = new THREE.Matrix4().makeRotationX(Math.PI / 4).multiply(new THREE.Matrix4().makeRotationY(-Math.PI / 9)).multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 6));
  placed.elements.forEach((x, i) => assert.ok(Math.abs(x - want.elements[i]) < 1e-4, `element ${i}: ${x} vs ${want.elements[i]}`));
});
