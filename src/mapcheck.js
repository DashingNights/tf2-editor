// Hammer's Check for problems, the checks besides the plane checks of weldgeo.js. Pure: problems(root, opt) walks the
// whole map, hidden objects included (they compile once shown), and returns [{ kind, objs, text, fix, keys }]. objs:
// the solids and entities to select. fix(take), where set, repairs the problem; take(node, deep) snapshots a node
// before it changes, as state.change() hands it over. keys: the keyvalues an FGD problem names (the dialog's Ignore).
import * as V from '../vmf.js';
import * as F from './fgd.js';

const lc = s => (s ?? '').toLowerCase();
const LIMIT = 16384; // vbsp's MAX_COORD_INTEGER: nothing may lie further out on any axis

// [solid, owner] for every solid, hidden ones too; owner: the world or the entity the solid is in.
function* solidsOf(n, owner = null) {
  for (const c of n.children) {
    if (c.name === 'solid') yield [c, owner];
    else if (c.name === 'hidden') yield* solidsOf(c, owner);
    else if (c.name === 'world' || c.name === 'entity') yield* solidsOf(c, c);
  }
}
const entsOf = root => root.children.flatMap(c => (c.name === 'entity' ? [c] : c.name === 'hidden' ? V.kids(c, 'entity') : []));
const hasSolids = e => e.children.some(c => c.name === 'solid' || c.name === 'hidden');

// 'prop_static "door" (id 12)', 'solid (id 34)': an object in the dialog's list.
export function label(n) {
  const id = ` (id ${V.get(n, 'id') ?? '?'})`;
  if (n.name !== 'entity') return n.name + id;
  const t = V.get(n, 'targetname');
  return (V.get(n, 'classname') ?? 'entity') + (t ? ` "${t}"` : '') + id;
}

// The contents vbsp gives a face, from its material's VMT keys (a Map with lower-case keys, or null): the %compile
// flags that set contents, sorted and joined ('' is solid). Hint and skip faces are 'empty'. Water and slime are left
// out: vbsp adds those to the whole brush, so a water brush with nodraw sides is fine.
const CONTENTS = ['areaportal', 'blocklight', 'blocklos', 'clip', 'detail', 'fog', 'grenadeclip', 'ladder', 'nonsolid', 'npcclip', 'origin', 'passbullets', 'playerclip', 'playercontrolclip', 'team'];
const yes = v => /^(1|true)$/i.test((v ?? '').trim());
export function contentsOf(kv) {
  const on = k => yes(kv?.get('%compile' + k)) || (k === 'playerclip' && yes(kv?.get('%playerclip')));
  return [...CONTENTS.filter(on), ...(on('hint') || on('skip') ? ['empty'] : [])].join('+');
}

// An output's target: the first field of 'target,input,param,delay,times' (newer Hammer separates them with ESC).
const outTarget = v => v.split(v.includes('\x1b') ? '\x1b' : ',')[0].trim();
// Classes the game makes itself, so outputs can name them without the map having one.
const RUNTIME = new Set(['player', 'worldspawn', 'tf_gamerules', 'tf_objective_resource', 'tf_player_manager', 'tf_team', 'obj_sentrygun', 'obj_dispenser', 'obj_teleporter']);

// opt: fgd (fgd.js classes, or null: no FGD check), contents(material) -> contentsOf() of its VMT, hasModel(path) and
// hasMaterial(name) (null: not checked), nextId() (the duplicate id fix), ignoreKeys (lower-case keys the FGD check skips).
export function problems(root, { fgd = null, contents = () => '', hasModel = null, hasMaterial = null, nextId = null, ignoreKeys = new Set() } = {}) {
  const out = [], add = (kind, objs, text, more) => out.push({ kind, objs, text, ...more });
  const solids = [...solidsOf(root)], ents = entsOf(root), world = V.kids(root, 'world')[0], wf = []; // wf: faces of the valid world solids

  for (const [s, owner] of solids) {
    const sides = V.kids(s, 'side');
    if (sides.length < 4) add('solid', [s], `Invalid solid: ${sides.length} sides, a brush needs 4 or more`);
    else if (!V.valid(s)) add('solid', [s], 'Invalid solid: not closed, or a side has no face');
    else if (owner === world) wf.push(...V.faces(s));
    const cs = [...new Set(sides.map(x => contents(V.get(x, 'material') ?? '')))];
    if (cs.length > 1) add('contents', [s], `Mixed face contents (${cs.map(c => c || 'solid').join(', ')}): vbsp gives the whole brush the contents of its first side`);
    if (owner?.name === 'entity' && sides.some(x => V.kids(x, 'dispinfo').length)) add('disp', [s], `Displacement on a brush entity (${V.get(owner, 'classname')}): vbsp takes displacements on world brushes only`);
  }

  // The world, solids and entities share one id series and faces have their own (groups are left out: their members
  // name them). Each id after the first gets a new one; an overlay on a renumbered face keeps the first face.
  const ids = new Map();
  (function walk(n, up) {
    const id = V.get(n, 'id');
    if (id !== undefined && /^(world|solid|entity|side)$/.test(n.name)) {
      const k = `${n.name === 'side' ? 'face' : 'object'} ${id}`;
      ids.set(k, [...(ids.get(k) ?? []), [n, up]]);
    }
    for (const c of n.children) walk(c, n);
  })(root, null);
  for (const [k, ns] of ids) {
    if (ns.length < 2) continue;
    const [what, id] = k.split(' '), obj = ([n, up]) => (n.name === 'side' ? up : n);
    add('id', [...new Set(ns.map(obj))].filter(n => n.name === 'solid' || n.name === 'entity'), `Duplicate ${what} id ${id} (${ns.length} ${what}s)`,
      nextId && { fix: take => { for (const x of ns.slice(1)) { take(obj(x), obj(x).name !== 'world'); V.set(x[0], 'id', nextId()); } } });
  }

  const names = new Set(ents.map(e => lc(V.get(e, 'targetname'))).filter(Boolean)), classes = new Set(ents.map(e => lc(V.get(e, 'classname'))));
  const inst = ents.filter(e => lc(V.get(e, 'classname')) === 'func_instance'), instNames = inst.map(e => lc(V.get(e, 'targetname'))).filter(Boolean);
  // vbsp puts an instance's name before (or after) the names inside it, except '@' names, which cannot be checked here.
  // ponytail: names inside instances are not read from their files; read them if instance outputs need checking.
  const known = t => {
    t = lc(t).trim();
    if (!t || '!$'.includes(t[0]) || names.has(t) || classes.has(t) || RUNTIME.has(t)) return true;
    if (t.endsWith('*')) return [...names, ...classes].some(n => n.startsWith(t.slice(0, -1)));
    return inst.length > 0 && (t[0] === '@' || instNames.some(i => t.startsWith(i + '-') || t.endsWith('-' + i)));
  };
  const sideIds = new Set(solids.flatMap(([s]) => V.kids(s, 'side').map(x => V.get(x, 'id'))));
  const [mn, mx] = V.bounds(wf), box = mn.every(Number.isFinite) && [mn, mx];
  const fgdOf = new Map(), classOf = cls => (fgdOf.has(cls) ? fgdOf : fgdOf.set(cls, fgd && F.resolve(fgd, cls))).get(cls);

  for (const e of ents) {
    const cls = V.get(e, 'classname') ?? '', l = lc(cls);
    // The game reads the keys in order, so the last of a repeated key counts.
    const last = new Map(e.kv.map(p => [lc(p[0]), p])), dups = e.kv.filter(p => last.get(lc(p[0])) !== p);
    if (dups.length) add('key', [e], `Duplicate keyvalues: ${[...new Set(dups.map(p => p[0]))].join(', ')} (the last one counts)`, { fix: take => { take(e, true); e.kv = e.kv.filter(p => !dups.includes(p)); } });

    const c = classOf(cls);
    if (c) {
      const ok = new Set(['id', 'classname', 'origin', ...c.keys.map(k => lc(k.name))]);
      const keys = [...new Set(e.kv.map(p => p[0]).filter(k => !ok.has(lc(k)) && !ignoreKeys.has(lc(k))))];
      if (keys.length) add('fgd', [e], `Keyvalues not in the FGD for ${cls}: ${keys.join(', ')}`, { keys });
    }

    const bad = [['target', V.get(e, 'target')], ['parentname', V.get(e, 'parentname')?.split(',')[0]]].filter(([, v]) => v && !known(v));
    if (bad.length) add('target', [e], `Missing target: ${bad.map(([k, v]) => `${k} "${v}"`).join(', ')} (no entity has that name)`);
    const outs = V.kids(e, 'connections').flatMap(cn => cn.kv.filter(p => !known(outTarget(p[1]))).map(p => [cn, p]));
    if (outs.length) add('output', [e], `Outputs to missing targets: ${outs.map(([, p]) => `${p[0]} > ${outTarget(p[1])}`).join(', ')}`, { fix: take => { take(e, true); for (const [cn, p] of outs) cn.kv = cn.kv.filter(x => x !== p); } });

    if (l === 'info_overlay') {
      const fs = (V.get(e, 'sides') ?? '').split(/\s+/).filter(Boolean), gone = fs.filter(x => !sideIds.has(x)), m = V.get(e, 'material') ?? '';
      const why = [!fs.length && 'no faces', gone.length && `faces not in the map (${gone.join(' ')})`, !m ? 'no material' : hasMaterial && !hasMaterial(m) && `material ${m} not found`].filter(Boolean);
      if (why.length) add('overlay', [e], `info_overlay: ${why.join('; ')}`);
    }

    const m = V.get(e, 'model') ?? '';
    if (l.startsWith('prop_') && !m) add('model', [e], `${cls} has no model`);
    else if (hasModel && /\.mdl$/i.test(m) && !hasModel(m)) add('model', [e], `Model not found: ${m}`);

    const o = !hasSolids(e) && V.nums(V.get(e, 'origin'));
    if (o?.length !== 3) continue;
    if (o.some(x => Math.abs(x) > LIMIT)) add('bounds', [e], `Outside the map: (${o.join(' ')}) is beyond +-${LIMIT}`);
    else if (box && o.some((x, k) => x < box[0][k] - 1 || x > box[1][k] + 1)) add('bounds', [e], `Outside the world brushes at (${o.join(' ')}): in the void, where it leaks`);
  }
  return out;
}
