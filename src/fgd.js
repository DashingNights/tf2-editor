// FGD (Hammer game data) parser. Pure, node-testable.
// parse(text, map) adds the classes in text to map; load(path, read) also follows @include; resolve(map, name) merges bases.

const TOKEN = /\/\/[^\n]*|"([^"]*)"|([@=:\[\](),+])|([^\s"@=:\[\](),+]+)/g;
const PUNCT = new Set(['@', '=', ':', '[', ']', '(', ')', ',', '+']);
const word = x => typeof x === 'string' && !PUNCT.has(x);
const val = x => (typeof x === 'object' ? x.s : x);

// Quoted strings become { s }; words and punctuation stay plain strings. Comments are dropped.
const lex = text => [...text.matchAll(TOKEN)].filter(m => !m[0].startsWith('//')).map(m => (m[1] !== undefined ? { s: m[1] } : m[0]));

export function parse(text, map = new Map()) {
  const t = lex(text);
  let i = 0;
  // A string (strings joined with +) or a bare word. FGD descriptions spell newlines as \n.
  const str = () => {
    let v = val(t[i++]) ?? '';
    while (t[i] === '+') { i++; v += val(t[i++]) ?? ''; }
    return v.replace(/\\n/g, '\n');
  };
  // The next token starts a new key line: `name(` or `input Name`.
  const fresh = j => word(t[j]) && (t[j + 1] === '(' || (/^(input|output)$/i.test(t[j]) && word(t[j + 1])));
  const field = () => (t[i] === ':' || t[i] === '=' || t[i] === ']' || fresh(i) ? '' : str());
  const colons = () => { const out = []; while (t[i] === ':') { i++; out.push(field()); } return out; };
  const skip = (open, close) => { for (let d = 0; i < t.length; i++) if (t[i] === open) d++; else if (t[i] === close && --d === 0) return void i++; };
  // (a b, c) -> ['a b', 'c']
  const args = () => {
    const out = [[]];
    for (i++; i < t.length && t[i] !== ')'; i++) t[i] === ',' ? out.push([]) : out.at(-1).push(val(t[i]));
    i++;
    return out.map(a => a.join(' ')).filter(Boolean);
  };

  function key(c) {
    const k = { name: val(t[i++]), type: '', displayName: '', default: '', description: '', readonly: false, choices: [], flags: [] };
    if (t[i] === '(') k.type = (args()[0] ?? '').toLowerCase();
    for (; /^(readonly|report)$/i.test(t[i]); i++) if (/^readonly$/i.test(t[i])) k.readonly = true;
    [k.displayName = '', k.default = '', k.description = ''] = colons();
    if (t[i] === '=' && t[i + 1] === '[') {
      i += 2;
      const list = [];
      while (i < t.length && t[i] !== ']') {
        const v = val(t[i++]);
        if (v !== undefined && !PUNCT.has(v)) list.push([v, ...colons()]);
      }
      i++;
      if (k.type === 'flags') k.flags = list.map(([b, label = '', d = '0']) => ({ bit: +b, label, default: d === '1' }));
      else k.choices = list.map(([value, label = '']) => ({ value, label }));
    }
    c.keys.push(k);
  }

  function body(c) {
    while (i < t.length && t[i] !== ']') {
      const w = t[i];
      if (!word(w)) { i++; continue; }
      if (/^(input|output)$/i.test(w) && word(t[i + 1])) {
        i++;
        const io = { name: val(t[i++]), type: t[i] === '(' ? (args()[0] ?? '') : '', description: '' };
        io.description = colons()[0] ?? '';
        c[w.toLowerCase() + 's'].push(io);
      } else key(c);
    }
    i++;
  }

  function cls(type) {
    const c = { type, name: '', bases: [], size: null, color: null, description: '', helpers: [], keys: [], inputs: [], outputs: [] };
    while (i < t.length && t[i] !== '=') {
      const h = String(val(t[i++])).toLowerCase(), a = t[i] === '(' ? args() : [];
      if (h === 'base') { c.bases.push(...a); continue; }
      c.helpers.push({ name: h, args: a });
      if (h === 'size') c.size = size(a);
      else if (h === 'color') c.color = (a[0] ?? '').split(/\s+/).map(Number);
    }
    i++;
    c.name = val(t[i++]);
    if (t[i] === ':') { i++; c.description = str(); }
    if (t[i] === '[') { i++; body(c); }
    if (c.name) map.set(c.name, c);
  }

  while (i < t.length) {
    if (t[i++] !== '@') continue;
    const kind = String(val(t[i++]));
    if (/class$/i.test(kind)) cls(kind);
    else if (/^include$/i.test(kind)) i++;
    else {
      // @mapsize(...), @MaterialExclusion [...], @AutoVisGroup = "name" [...]
      if (t[i] === '(') skip('(', ')');
      if (t[i] === '=') { i++; str(); }
      if (t[i] === '[') skip('[', ']');
    }
  }
  return map;
}

// size(mins, maxs) -> [mins, maxs]; size(x y z) is a box of that size centred on the origin.
function size(a) {
  const v = a.map(s => s.split(/\s+/).map(Number));
  return v.length === 1 ? [v[0].map(x => -x / 2), v[0].map(x => x / 2)] : v;
}

// Reads path with read(path) -> text|null, loading @include files (relative to it) first.
export async function load(path, read, map = new Map(), seen = new Set()) {
  if (seen.has(path)) return map;
  seen.add(path);
  const text = await read(path);
  if (!text) return map;
  const dir = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  for (const m of text.matchAll(/^\s*@include\s+"([^"]+)"/gim)) await load(dir + m[1], read, map, seen);
  return parse(text, map);
}

// load() once per path: details.js, models.js and helpers.js share one parse of tf.fgd. Treat the map as read-only.
const loaded = new Map();
export const shared = (path, read) => loaded.get(path) ?? loaded.set(path, load(path, read)).get(path);

// Later items replace earlier ones with the same name (a class overrides its bases).
function merge(a, b) {
  const out = [...a];
  for (const x of b) { const j = out.findIndex(y => y.name === x.name); j < 0 ? out.push(x) : (out[j] = x); }
  return out;
}

// The class with the keys, inputs and outputs of all its bases merged in. null when unknown.
// helpers: [{ name, args }] of the bases, then the class's own, in FGD order (size and color included).
export function resolve(map, name, seen = new Set()) {
  const c = map.get(name);
  if (!c || seen.has(name)) return null;
  seen.add(name);
  const r = { ...c, keys: [], inputs: [], outputs: [], helpers: [] };
  for (const b of [...c.bases.map(n => resolve(map, n, seen)).filter(Boolean), c]) {
    for (const k of ['keys', 'inputs', 'outputs']) r[k] = merge(r[k], b[k]);
    r.helpers.push(...b.helpers);
    r.size ??= b.size;
    r.color ??= b.color;
  }
  return r;
}

// [key, default] for the keys of a resolved class that have a default, as Hammer writes them on a new entity: flags
// as the sum of the bits that default on (when not 0), an origin key (a brush entity's hinge or axis) as [name, ''].
export function defaults(c) {
  return (c?.keys ?? []).flatMap(k => {
    if (k.type === 'flags') { const v = k.flags.reduce((s, f) => s + (f.default ? f.bit : 0), 0); return v ? [[k.name, String(v)]] : []; }
    return k.type === 'origin' || k.default !== '' ? [[k.name, k.default]] : [];
  });
}
