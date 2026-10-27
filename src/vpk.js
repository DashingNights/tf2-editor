// VPK (Valve pak) v1/v2 reader. Pure: the caller supplies readBytes(path, offset, length) -> ArrayBuffer | Uint8Array.
const u8 = b => (b instanceof Uint8Array ? b : new Uint8Array(b));
const NONE = new Uint8Array(0);
const IN_DIR = 0x7fff;

// Parses the '_dir.vpk' tree. Returns Map<lower-cased path, entry> for paths starting with prefix ('' keeps all).
export async function openVpk(dirPath, readBytes, prefix = 'materials/') {
  const h = u8(await readBytes(dirPath, 0, 28)), hv = new DataView(h.buffer, h.byteOffset, h.byteLength);
  if (h.length < 12 || hv.getUint32(0, true) !== 0x55aa1234) throw new Error(`not a VPK: ${dirPath}`);
  const version = hv.getUint32(4, true), treeSize = hv.getUint32(8, true), headerSize = { 1: 12, 2: 28 }[version];
  if (!headerSize) throw new Error(`VPK version ${version} unsupported: ${dirPath}`);
  const t = u8(await readBytes(dirPath, headerSize, treeSize)), tv = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const vpk = { path: dirPath, readBytes, dataStart: headerSize + treeSize }, out = new Map(), dec = new TextDecoder();
  let pos = 0;
  const str = () => {
    const end = t.indexOf(0, pos);
    if (end < 0) throw new Error(`truncated VPK tree: ${dirPath}`);
    const s = dec.decode(t.subarray(pos, end));
    pos = end + 1;
    return s;
  };
  // Tree: extension { directory { filename + 18-byte entry + preload } }, each level ends with an empty string.
  for (let ext; (ext = str()); ) {
    for (let dir; (dir = str()); ) {
      const base = dir === ' ' ? '' : dir.toLowerCase() + '/', keep = base.startsWith(prefix);
      for (let name; (name = str()); ) {
        const preload = tv.getUint16(pos + 4, true), start = pos + 18;
        if (keep) out.set(base + name.toLowerCase() + (ext === ' ' ? '' : '.' + ext.toLowerCase()), {
          vpk, archiveIndex: tv.getUint16(pos + 6, true), offset: tv.getUint32(pos + 8, true), length: tv.getUint32(pos + 12, true),
          preloadBytes: preload ? t.subarray(start, start + preload) : NONE,
        });
        pos = start + preload;
      }
    }
  }
  return out;
}

// File bytes: preload data followed by the archive slice (archive 0x7fff = data stored after the tree in the dir file).
export async function readFile(e) {
  if (!e.length) return e.preloadBytes;
  const v = e.vpk, inDir = e.archiveIndex === IN_DIR;
  const path = inDir ? v.path : v.path.replace(/_dir\.vpk$/i, `_${String(e.archiveIndex).padStart(3, '0')}.vpk`);
  const data = u8(await v.readBytes(path, e.offset + (inDir ? v.dataStart : 0), e.length));
  if (!e.preloadBytes.length) return data;
  const out = new Uint8Array(e.preloadBytes.length + data.length);
  out.set(e.preloadBytes);
  out.set(data, e.preloadBytes.length);
  return out;
}
