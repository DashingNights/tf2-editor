// PCF particle files: the element names of a binary DMX file, read from its element index (no attributes parsed).
// Pure, node-testable.
const dec = new TextDecoder();

// Names of the elements of type `type` (DmeParticleSystemDefinition: the particle systems effect_name takes), in file
// order. Binary DMX: a '<!-- dmx encoding binary N format pcf M -->' header line ending in a 0 byte; from version 2 a
// string table (count int16, int32 from v4); an int32 element count; each element's type (a table index: int16, int32
// from v5; v1 an inline string), name (inline, a table index from v4) and 16-byte id. [] for text (keyvalues2) DMX.
export function pcfNames(bytes, type = 'DmeParticleSystemDefinition') {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  let p = 0;
  const str = () => {
    const e = u.indexOf(0, p);
    if (e < 0) throw new Error('truncated DMX');
    const s = dec.decode(u.subarray(p, e));
    p = e + 1;
    return s;
  };
  const int = w => { const v = w === 4 ? dv.getInt32(p, true) : dv.getUint16(p, true); p += w; return v; };
  const ver = +(/^<!-- dmx encoding binary (\d+)/.exec(str())?.[1] ?? 0);
  if (!ver) return [];
  const table = [];
  if (ver >= 2) for (let n = int(ver >= 4 ? 4 : 2); n > 0; n--) table.push(str());
  const ref = () => (ver >= 2 ? table[int(ver >= 5 ? 4 : 2)] : str());
  const out = [];
  for (let n = int(4); n > 0; n--) {
    const t = ref(), name = ver >= 4 ? ref() : str();
    p += 16;
    if (t === type) out.push(name);
  }
  return out;
}
