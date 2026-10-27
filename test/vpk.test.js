// node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { openVpk, readFile } from '../src/vpk.js';

const TF2 = 'D:/SteamLibrary/steamapps/common/Team Fortress 2';
async function readBytes(p, offset, length) {
  const fh = await open(p);
  try { const b = Buffer.alloc(length); const { bytesRead } = await fh.read(b, 0, length, offset); return b.subarray(0, bytesRead); }
  finally { await fh.close(); }
}

// v1 VPK in memory. files: [ext, dir, name, preload, archiveIndex, offset, length]; inline data follows the tree.
function build(files, inline) {
  const parts = [], str = s => parts.push(Buffer.from(s + '\0', 'latin1'));
  for (const [ext, dir, name, preload, archive, offset, length] of files) {
    str(ext); str(dir); str(name);
    const e = Buffer.alloc(18);
    e.writeUInt16LE(preload.length, 4); e.writeUInt16LE(archive, 6); e.writeUInt32LE(offset, 8); e.writeUInt32LE(length, 12); e.writeUInt16LE(0xffff, 16);
    parts.push(e, Buffer.from(preload, 'latin1'), Buffer.alloc(2));
  }
  parts.push(Buffer.alloc(1));
  const tree = Buffer.concat(parts), head = Buffer.alloc(12);
  head.writeUInt32LE(0x55aa1234, 0); head.writeUInt32LE(1, 4); head.writeUInt32LE(tree.length, 8);
  const all = Buffer.concat([head, tree, Buffer.from(inline, 'latin1')]);
  return async (_, offset, length) => all.subarray(offset, offset + length);
}

test('synthetic VPK: prefix filter, preload + in-dir data, root dir', async () => {
  const rb = build([
    ['vmt', 'Materials/A', 'B', 'AB', 0x7fff, 0, 3],
    ['vtf', 'materials/a', 'c', 'XYZ', 0x7fff, 3, 0],
    ['mdl', 'models', 'x', '', 0, 0, 10],
    ['txt', ' ', 'readme', '', 0x7fff, 3, 2],
  ], 'CDEhi');
  const m = await openVpk('x_dir.vpk', rb);
  assert.deepEqual([...m.keys()].sort(), ['materials/a/b.vmt', 'materials/a/c.vtf']);
  assert.equal(Buffer.from(await readFile(m.get('materials/a/b.vmt'))).toString(), 'ABCDE');
  assert.equal(Buffer.from(await readFile(m.get('materials/a/c.vtf'))).toString(), 'XYZ');
  const all = await openVpk('x_dir.vpk', rb, '');
  assert.equal(Buffer.from(await readFile(all.get('readme.txt'))).toString(), 'hi');
  assert.ok(all.has('models/x.mdl'));
});

// dev/dev_measuregeneric01b lives in the hl2 VPKs (TF2 mounts them after its own); tf2_* has customdev/*.
test('TF2 VPKs: dev_measuregeneric01b vtf and vmt', { skip: !existsSync(TF2) && 'TF2 not installed' }, async () => {
  const names = ['tf/tf2_textures', 'tf/tf2_misc', 'hl2/hl2_textures', 'hl2/hl2_misc'];
  const vpks = await Promise.all(names.map(n => openVpk(`${TF2}/${n}_dir.vpk`, readBytes)));
  const find = k => vpks.map(m => m.get(k)).find(Boolean);
  const vtf = find('materials/dev/dev_measuregeneric01b.vtf'), vmt = find('materials/dev/dev_measuregeneric01b.vmt');
  assert.ok(vtf && vmt, 'both found');
  assert.ok(vpks[1].has('materials/customdev/dev_measuregeneric01red.vmt'), 'tf2_misc has customdev materials');
  const v = await readFile(vtf);
  assert.equal(v.length, vtf.preloadBytes.length + vtf.length);
  assert.equal(Buffer.from(v.subarray(0, 4)).toString('latin1'), 'VTF\0');
  assert.match(Buffer.from(await readFile(vmt)).toString(), /\$basetexture/i);
  assert.ok(vpks.every(m => [...m.keys()].every(k => k.startsWith('materials/'))));
});
