// Source studio models (.mdl v44-49 + .vvd + .dx90.vtx, as TF2 ships them). Pure, node-testable.
// load(path, read) -> { meshes: [{ positions, normals, uvs, indices, materialIndex }], materials, skins, bbox } or null.
// The model is posed as the game draws it at rest (frame 0 of sequence 0), LOD 0, body group 0 of every body part.

const view = b => new DataView(b.buffer, b.byteOffset, b.byteLength);
const cstr = (b, o) => { let e = o; while (e < b.length && b[e]) e++; return new TextDecoder().decode(b.subarray(o, e)); };
const slash = s => s.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();

// Header fields used here sit at the same offsets in every version from 44 to 49.
export function parseMdl(b) {
  const d = view(b), i = o => d.getInt32(o, true);
  if (cstr(b, 0).slice(0, 4) !== 'IDST') throw new Error('not a studio model');
  const version = i(4), textures = [], cdmaterials = [], skins = [], bodyparts = [];
  for (let k = 0, o = i(208); k < i(204); k++, o += 64) textures.push(slash(cstr(b, o + i(o))));
  for (let k = 0; k < i(212); k++) cdmaterials.push(slash(cstr(b, i(i(216) + k * 4))));
  for (let f = 0, o = i(228); f < i(224); f++) for (let r = 0; r < i(220); r++, o += 2) (skins[f] ??= []).push(d.getInt16(o, true));
  // mstudiobodyparts_t (16 bytes) > mstudiomodel_t (148) > mstudiomesh_t (116); offsets are relative to each struct.
  for (let p = 0, bo = i(236); p < i(232); p++, bo += 16) {
    const models = [];
    for (let m = 0, mo = bo + i(bo + 12); m < i(bo + 4); m++, mo += 148) {
      const meshes = [];
      for (let s = 0, so = mo + i(mo + 76); s < i(mo + 72); s++, so += 116) meshes.push({ material: i(so), vertexoffset: i(so + 12), numvertices: i(so + 8) });
      models.push({ name: cstr(b, mo).slice(0, 64), start: i(mo + 84) / 48, meshes }); // vertexindex is in bytes (48 per vertex)
    }
    bodyparts.push(models);
  }
  const f = o => d.getFloat32(o, true), fs = (o, n) => Array.from({ length: n }, (_, k) => f(o + k * 4));
  const bones = Array.from({ length: i(156) }, (_, k) => { // mstudiobone_t, 216 bytes
    const o = i(160) + k * 216;
    return { parent: i(o + 4), pos: fs(o + 32, 3), quat: fs(o + 44, 4), rot: fs(o + 60, 3), posscale: fs(o + 72, 3), rotscale: fs(o + 84, 3), poseToBone: fs(o + 96, 12) };
  });
  return { version, textures, cdmaterials, skins, bodyparts, bones, skin: skin(bones, frame0(b, d, i, bones)) };
}

// ---------- frame 0 of sequence 0 ----------
// Most animated models store their mesh turned 90 degrees from how the game draws them: the root bone of the first
// sequence turns it back. Matrices are Source matrix3x4_t, 12 numbers row by row.
const mat = ([x, y, z, w], p) => [
  1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y), p[0],
  2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x), p[1],
  2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y), p[2]];
const mul = (a, b) => [0, 1, 2].flatMap(r => [0, 1, 2, 3].map(c => a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + (c === 3 ? a[r * 4 + 3] : 0)));
// Source AngleQuaternion: radians [roll, pitch, yaw] -> [x, y, z, w].
function eulerQuat(a) {
  const [sr, cr, sp, cp, sy, cy] = a.flatMap(x => [Math.sin(x / 2), Math.cos(x / 2)]);
  return [sr * cp * cy - cr * sp * sy, cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy, cr * cp * cy + sr * sp * sy];
}
const wq = (v, neg) => [...v, Math.sqrt(Math.max(0, 1 - v[0] ** 2 - v[1] ** 2 - v[2] ** 2)) * (neg ? -1 : 1)];
const quat48 = (d, o) => { const u = k => d.getUint16(o + k * 2, true), z = u(2); return wq([(u(0) - 32768) / 32768, (u(1) - 32768) / 32768, ((z & 0x7fff) - 16384) / 16384], z >> 15); };
function quat64(d, o) {
  const lo = d.getUint32(o, true), hi = d.getUint32(o + 4, true), c = v => (v - 1048576) / 1048576.5;
  return wq([c(lo & 0x1fffff), c(((lo >>> 21) | (hi << 11)) & 0x1fffff), c((hi >>> 10) & 0x1fffff)], hi >>> 31);
}
const half = h => { const e = (h >> 10) & 31, m = h & 1023; return (h >> 15 ? -1 : 1) * (e ? 2 ** (e - 15) * (1 + m / 1024) : 2 ** -14 * (m / 1024)); };

// Local [pos, quat] per bone in frame 0 of sequence 0 (blend 0); bones the animation leaves out keep their rest pose.
// ponytail: delta animations and .ani animation blocks are read as plain ones (TF2 ships no animation blocks).
function frame0(b, d, i, bones) {
  const pose = bones.map(x => [x.pos, x.quat]), s16 = o => d.getInt16(o, true);
  if (!i(188) || !i(180)) return pose;
  const seq = i(192), ad = i(184) + s16(seq + i(seq + 60)) * 100; // mstudioseqdesc_t -> mstudioanimdesc_t (100 bytes)
  if (i(ad + 52)) return pose;
  let o = ad + (i(ad + 84) ? i(ad + i(ad + 80) + 4) : i(ad + 56)); // a sectioned animation starts at section 0
  // Animated values: { valid, total } then the values; frame 0 is the first one. Offsets are from the valueptr.
  const anim = (vp, j) => { const off = s16(vp + j * 2); return off ? s16(vp + off + 2) : 0; };
  for (let n = 0; n < 256; n++) { // mstudioanim_t: bone, flags, offset to the next, then the data the flags announce
    const B = bones[b[o]], fl = b[o + 1], next = s16(o + 2), at = o + 4;
    if (B) {
      let q = B.quat, p = B.pos;
      if (fl & 0x20) q = quat64(d, at);
      else if (fl & 0x02) q = quat48(d, at);
      else if (fl & 0x08) q = eulerQuat(B.rot.map((r, j) => r + anim(at, j) * B.rotscale[j]));
      const raw = at + (fl & 0x02 ? 6 : 0) + (fl & 0x20 ? 8 : 0), vp = at + (fl & 0x08 ? 6 : 0);
      if (fl & 0x01) p = [0, 1, 2].map(j => half(d.getUint16(raw + j * 2, true)));
      else if (fl & 0x04) p = B.pos.map((x, j) => x + anim(vp, j) * B.posscale[j]);
      pose[b[o]] = [p, q];
    }
    if (!next) break;
    o += next;
  }
  return pose;
}

// Per bone: the matrix that takes reference-mesh points to the pose (bone to model in the pose, times pose to bone).
function skin(bones, pose) {
  const toModel = [];
  return bones.map((B, k) => {
    const local = mat(pose[k][1], pose[k][0]);
    toModel[k] = B.parent >= 0 ? mul(toModel[B.parent], local) : local;
    return mul(toModel[k], B.poseToBone);
  });
}

// LOD 0 vertices (fixups applied): { positions, normals, uvs, weights, bones } as flat arrays (3 bone weights a vertex).
export function parseVvd(b) {
  const d = view(b), i = o => d.getInt32(o, true);
  if (cstr(b, 0).slice(0, 4) !== 'IDSV') throw new Error('not a VVD file');
  const fixups = i(48), table = i(52), data = i(56);
  // [first vertex, count] runs: every fixup belongs to LOD 0 (lod >= 0), or the whole LOD 0 list when there are none.
  const runs = fixups ? Array.from({ length: fixups }, (_, k) => [i(table + k * 12 + 4), i(table + k * 12 + 8)]) : [[0, i(16)]];
  const n = runs.reduce((a, r) => a + r[1], 0), positions = new Float32Array(n * 3), normals = new Float32Array(n * 3), uvs = new Float32Array(n * 2);
  const weights = new Float32Array(n * 3), bones = new Uint8Array(n * 3);
  let v = 0;
  for (const [first, count] of runs) for (let k = 0; k < count; k++, v++) {
    const o = data + (first + k) * 48; // mstudiovertex_t: bone weights (16), position, normal, uv
    for (let c = 0; c < 3; c++) {
      positions[v * 3 + c] = d.getFloat32(o + 16 + c * 4, true);
      normals[v * 3 + c] = d.getFloat32(o + 28 + c * 4, true);
      if (c < b[o + 15]) { weights[v * 3 + c] = d.getFloat32(o + c * 4, true); bones[v * 3 + c] = b[o + 12 + c]; }
    }
    uvs[v * 2] = d.getFloat32(o + 40, true);
    uvs[v * 2 + 1] = d.getFloat32(o + 44, true);
  }
  return { positions, normals, uvs, weights, bones };
}

// LOD 0 triangle lists per [bodypart][model][mesh]: indices into the mesh's own vertices (origMeshVertID).
// ponytail: strips are read as triangle lists (TF2's dx90 files have no tristrips); StripGroupHeader is the 25-byte
// TF2 layout, not the 33-byte CS:GO one.
export function parseVtx(b) {
  const d = view(b), i = o => d.getInt32(o, true), out = [];
  if (i(0) !== 7) throw new Error('VTX version ' + i(0) + ' unsupported');
  for (let p = 0, bo = i(32); p < i(28); p++, bo += 8) {
    const models = [];
    for (let m = 0, mo = bo + i(bo + 4); m < i(bo); m++, mo += 8) {
      const lod = mo + i(mo + 4), meshes = []; // first ModelLODHeader (12 bytes each)
      for (let s = 0, so = lod + i(lod + 4); s < i(lod); s++, so += 9) {
        const idx = [];
        for (let g = 0, go = so + i(so + 4); g < i(so); g++, go += 25) {
          const verts = go + i(go + 4), ind = go + i(go + 12);
          for (let k = 0; k < i(go + 8); k++) idx.push(d.getUint16(verts + d.getUint16(ind + k * 2, true) * 9 + 4, true)); // Vertex_t (9 bytes): origMeshVertID at 4
        }
        meshes.push(idx);
      }
      models.push(meshes);
    }
    out.push(models);
  }
  return out;
}

// Material name candidates per texture: each cdmaterials folder + the texture name, in search order.
export const candidates = mdl => mdl.textures.map(t => (mdl.cdmaterials.length ? mdl.cdmaterials : ['']).map(cd => slash(cd + (cd && !cd.endsWith('/') ? '/' : '') + t)));

// Meshes of body group 0 of each body part, triangles counter-clockwise seen from outside (Source winds them clockwise).
// materialIndex is the skin reference: skins[skin][materialIndex] -> texture.
export function build(mdl, vvd, vtx) {
  const meshes = [], mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  mdl.bodyparts.forEach((models, p) => {
    const m = models[0], tris = vtx[p]?.[0];
    m?.meshes.forEach((s, k) => {
      const first = m.start + s.vertexoffset, n = s.numvertices, idx = tris?.[k] ?? [];
      if (!idx.length || idx.length % 3 || idx.some(x => x >= n) || (first + n) * 3 > vvd.positions.length) return;
      const { positions, normals } = posed(vvd, mdl.skin, first, n);
      for (let v = 0; v < positions.length; v++) { mn[v % 3] = Math.min(mn[v % 3], positions[v]); mx[v % 3] = Math.max(mx[v % 3], positions[v]); }
      meshes.push({ positions, normals, uvs: vvd.uvs.slice(first * 2, (first + n) * 2), indices: Uint32Array.from(idx, (_, k) => idx[k + [0, 1, -1][k % 3]]), materialIndex: s.material });
    });
  });
  return { meshes, materials: candidates(mdl), skins: mdl.skins.length ? mdl.skins : [mdl.textures.map((_, k) => k)], bbox: meshes.length ? [mn, mx] : null };
}

// Vertices first..first+n blended by their bone weights through the skin matrices (unweighted ones stay as stored).
function posed(vvd, sk, first, n) {
  const positions = vvd.positions.slice(first * 3, (first + n) * 3), normals = vvd.normals.slice(first * 3, (first + n) * 3);
  for (let v = 0; v < n; v++) {
    const s = (first + v) * 3, p = positions.slice(v * 3, v * 3 + 3), q = normals.slice(v * 3, v * 3 + 3), P = [0, 0, 0], N = [0, 0, 0];
    let total = 0;
    for (let k = 0; k < 3; k++) {
      const w = vvd.weights[s + k], m = w && sk[vvd.bones[s + k]];
      if (!m) continue;
      total += w;
      for (let r = 0; r < 3; r++) {
        P[r] += w * (m[r * 4] * p[0] + m[r * 4 + 1] * p[1] + m[r * 4 + 2] * p[2] + m[r * 4 + 3]);
        N[r] += w * (m[r * 4] * q[0] + m[r * 4 + 1] * q[1] + m[r * 4 + 2] * q[2]);
      }
    }
    if (total) { positions.set(P, v * 3); normals.set(N, v * 3); }
  }
  return { positions, normals };
}

// read(relative path like 'models/x.vvd') -> Uint8Array | null. null when a file is missing or broken.
export async function load(path, read) {
  const base = slash(path).replace(/\.mdl$/, '');
  const [m, v, t] = await Promise.all(['.mdl', '.vvd', '.dx90.vtx'].map(e => read(base + e)));
  if (!m || !v || !t) return null;
  return build(parseMdl(m), parseVvd(v), parseVtx(t));
}
