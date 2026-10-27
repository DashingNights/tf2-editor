// Live mirror geometry: a solid's reflection across the plane x = c (axis 0) or y = c (axis 1) with readable
// textures, which side of the plane a solid lies on, and pairing solids with their reflections; the same for point
// entities (origin, angles). Pure, node-testable.
import * as V from '../vmf.js';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const neg = x => String(-x + 0); // no -0

export const reflectPoint = (p, ax, c) => p.map((x, k) => (k === ax ? 2 * c - x : x));

// Text on a texture reads the right way round when, seen from outside, u runs right and v down: (u x v) . n < 0.
// A reflection turns every face's texture over, so a face that now reads backwards gets one axis flipped back (the
// texel grid stays where the reflection put it): on a wall the axis that runs sideways when it points left (else the
// other one), on a floor or ceiling the one along the mirror axis. A face that read backwards before the reflection
// reads the right way after it and is left alone.
export function readable(side, ax) {
  const u = V.nums(V.get(side, 'uaxis')), v = V.nums(V.get(side, 'vaxis')), { n, ok } = V.plane(side);
  if (u.length !== 5 || v.length !== 5 || !ok || dot(cross(u, v), n) <= 1e-9) return false;
  let flipU;
  if (Math.abs(n[2]) < 0.7) {
    const right = [-n[1], n[0], 0], side = Math.abs(dot(u, right)) >= Math.abs(dot(v, right));
    flipU = dot(side ? u : v, right) < 0 ? side : !side;
  } else flipU = Math.abs(u[ax]) >= Math.abs(v[ax]);
  const a = flipU ? u : v;
  V.set(side, flipU ? 'uaxis' : 'vaxis', `[${a.slice(0, 3).map(neg).join(' ')} ${neg(a[3])}] ${a[4]}`);
  return true;
}

// A copy of the solid reflected across the plane (same ids): planes, texture axes (texture lock), displacements
// re-indexed (vmf.js transform), then readable textures. A reflection turns a texture the other way: rotation r -> -r.
export function reflect(solid, ax, c) {
  const r = structuredClone(solid), s = [1, 1, 1], t = [0, 0, 0];
  s[ax] = -1;
  t[ax] = 2 * c;
  V.transform(r, s, t, true);
  for (const side of V.kids(r, 'side')) {
    readable(side, ax);
    const rot = +V.get(side, 'rotation');
    if (rot) V.set(side, 'rotation', String(Math.round((((-rot % 360) + 360) % 360) * 1e6) / 1e6));
  }
  return r;
}

// -1: wholly on the negative side of the plane (touching it counts), 1: wholly on the positive side, 0: across it.
export const sideOf = ([mn, mx], ax, c, eps = 0.01) => (mx[ax] <= c + eps ? -1 : mn[ax] >= c - eps ? 1 : 0);

// Planes { n, d, m (material) } of a solid's sides, as written (no face clipping).
const planes = s => V.kids(s, 'side').map(x => ({ ...V.plane(x), m: (V.get(x, 'material') || '').toUpperCase(), id: V.get(x, 'id') }));
const mirrored = (p, ax, c) => { const n = [...p.n]; n[ax] = -n[ax]; return { ...p, n, d: p.d + 2 * c * n[ax] }; };
const samePlane = (p, q, tol) => dot(p.n, q.n) > 1 - 1e-6 && Math.abs(p.d - q.d) < tol;

// For each side of a (as planes) the index of b's side on its reflected plane, or -1.
function match(pa, pb, ax, c, tol) {
  const used = new Set();
  return pa.map(p => {
    const r = mirrored(p, ax, c), j = pb.findIndex((q, k) => !used.has(k) && samePlane(r, q, tol));
    if (j >= 0) used.add(j);
    return j;
  });
}

// True when b is a's reflection: the same planes (within tol) with the same materials, in any order.
export function isTwin(a, b, ax, c, tol = 0.05) {
  const pa = planes(a), pb = planes(b);
  if (pa.length !== pb.length) return false;
  const m = match(pa, pb, ax, c, tol);
  return m.every((j, i) => j >= 0 && pa[i].m === pb[j].m);
}

// Side id of a -> side id of its twin b, by reflected plane; sides without a match pair by position when the
// counts agree. a and b are solids (or { kv, children } copies of them as they were before an edit).
export function sidePairs(a, b, ax, c, tol = 0.05) {
  const pa = planes(a), pb = planes(b), m = match(pa, pb, ax, c, tol), out = new Map();
  pa.forEach((p, i) => { const j = m[i] >= 0 ? m[i] : pa.length === pb.length && !m.includes(i) ? i : -1; if (j >= 0) out.set(p.id, pb[j].id); });
  return out;
}

// Side id of a -> the ids of b's sides on the same plane whose faces overlap a's face (b a piece of a, or a solid
// made where a was), for overlays on a's faces.
export function sharedSides(a, b, tol = 0.05) {
  const box = f => V.bounds([f]), out = new Map(), fb = V.faces(b).map(f => ({ ...V.plane(f.side), box: box(f), id: V.get(f.side, 'id') }));
  for (const f of V.faces(a)) {
    const p = V.plane(f.side), [mn, mx] = box(f);
    const ids = fb.filter(g => {
      if (!samePlane(p, g, tol)) return false;
      const o = [0, 1, 2].map(k => Math.min(mx[k], g.box[1][k]) - Math.max(mn[k], g.box[0][k]));
      return o.every(x => x > -tol) && o.filter(x => x > tol).length >= 2; // an area in common, not an edge
    }).map(g => g.id);
    if (ids.length) out.set(V.get(f.side, 'id'), ids);
  }
  return out;
}

const boxOf = s => V.bounds(V.faces(s));
const near = (a, b, tol) => a.every((x, k) => Math.abs(x - b[k]) < tol);

// Pairs each solid of as with an unpaired solid of bs that is its reflection (isTwin), in order. box(solid) gives
// its bounds (default: from its faces). Returns Map a -> b.
// ponytail: compares every a with every b by bounds first (600 x 600 for a map half); a spatial grid if maps grow.
export function pairUp(as, bs, ax, c, box = boxOf, tol = 0.05) {
  const out = new Map(), taken = new Set(), bb = bs.map(box);
  for (const a of as) {
    const [mn, mx] = box(a), rmn = [...mn], rmx = [...mx];
    rmn[ax] = 2 * c - mx[ax];
    rmx[ax] = 2 * c - mn[ax];
    const j = bs.findIndex((b, k) => !taken.has(k) && near(bb[k][0], rmn, tol) && near(bb[k][1], rmx, tol) && isTwin(a, b, ax, c, tol));
    if (j >= 0) { taken.add(j); out.set(a, bs[j]); }
  }
  return out;
}

// Turns twin (a solid node, kept: its object, id and the side nodes in sidesOf) into fresh (the source's reflection),
// keeping twin side ids where ids maps the source side id to one of them; other sides get nextId(). Children
// other than sides (editor) come from fresh.
export function adopt(twin, fresh, ids, nextId) {
  const id = V.get(twin, 'id'), byId = new Map(V.kids(twin, 'side').map(s => [V.get(s, 'id'), s])), used = new Set();
  twin.kv = fresh.kv.map(p => (p[0] === 'id' ? ['id', id] : p));
  twin.children = fresh.children.map(ch => {
    if (ch.name !== 'side') return ch;
    let t = byId.get(ids.get(V.get(ch, 'id')));
    const sid = t && !used.has(t) ? V.get(t, 'id') : nextId();
    if (!t || used.has(t)) t = ch;
    used.add(t);
    t.kv = ch.kv.map(p => (p[0] === 'id' ? ['id', sid] : p));
    t.children = ch.children;
    if (t !== ch) t.at = ch.at;
    return t;
  });
}

// ---------- point entities (lights, props, sprites, cubemaps, particles) ----------
const num = x => String(Math.round(x * 1e6) / 1e6);
const deg = x => num((((Math.round(x * 1e6) / 1e6) % 360) + 360) % 360);
const cls = e => (V.get(e, 'classname') || '').toLowerCase();
const org = e => V.nums(V.get(e, 'origin'));

// -1 | 1: the side of the plane an entity's origin is on; 0 within 1 unit of the plane (its own mirror).
export const originSide = (o, ax, c) => (Math.abs(o[ax] - c) <= 1 ? 0 : o[ax] < c ? -1 : 1);

// Source angles "pitch yaw roll" of a reflected entity: the turn whose forward and up are the reflections of the
// entity's (a reflection is no turn, so left points the other way). x = c: pitch, 180 - yaw, -roll; y = c: pitch,
// -yaw, -roll. The pitch stays as written. An "angle" (yaw only) the same way; -1 and -2 (up, down) stay, and so does 0
// (vrad reads it as unset and takes the angles yaw), so a yaw that comes out 0 is written 360.
export function reflectAngles(text, ax) {
  const t = (text ?? '').trim().split(/\s+/);
  if (t.length !== 3 || t.some(x => !Number.isFinite(+x))) return text;
  return [t[0], deg(ax ? -t[1] : 180 - t[1]), deg(-t[2])].join(' ');
}
export const reflectYaw = (text, ax) => (!Number.isFinite(+text) || [0, -1, -2].includes(+text) ? text : deg(ax ? -text : 180 - text).replace(/^0$/, '360'));

// A copy of a point entity reflected across the plane (same id): origin, angles, angle, movedir (a door's). Every other
// key (light_spot's pitch, _light, model, targetname) and the children (outputs, editor) are copied as they are.
export function reflectEntity(e, ax, c) {
  const r = structuredClone(e), o = org(r);
  if (o.length === 3) V.set(r, 'origin', reflectPoint(o, ax, c).map(num).join(' '));
  for (const k of ['angles', 'movedir']) if (V.get(r, k) !== undefined) V.set(r, k, reflectAngles(V.get(r, k), ax));
  if (V.get(r, 'angle') !== undefined) V.set(r, 'angle', reflectYaw(V.get(r, 'angle'), ax));
  return r;
}
// Angles "pitch yaw roll" turned upside down about the forward axis (roll + 180). A reflected arrow model points the
// reflected way so: its arrow runs sideways, which a reflection turns round and a turn cannot.
export function flipRoll(text) {
  const t = (text ?? '').trim().split(/\s+/);
  return t.length === 3 && t.every(x => Number.isFinite(+x)) ? [t[0], t[1], deg(+t[2] + 180)].join(' ') : text;
}
export const isArrow = e => /arrow/i.test(V.get(e, 'model') ?? '');

// ---------- team swap (gameplay entities rebuilt on the other half) ----------
// blu / blue <-> red where a name part starts with it (spawnroom_blu, bluspawn, door_red_1), in the same case.
const TEAM = { blu: 'red', blue: 'red', red: 'blu' };
const like = (w, s) => (w === w.toUpperCase() ? s.toUpperCase() : w[0] === w[0].toUpperCase() ? s[0].toUpperCase() + s.slice(1) : s);
export const swapNames = s => s.replace(/(^|[^a-z])(blue|blu|red)/gi, (m, pre, w) => pre + like(w, TEAM[w.toLowerCase()]));
const TEAMKEY = /^(teamnum|point_default_owner)$/i, FIXED = new Set(['id', 'classname', 'origin', 'angles', 'angle', 'movedir', 'model']);
// e (changed) for the other team: TeamNum and a control point's owner 2 <-> 3, names in its keys and outputs swapped.
export function swapTeam(e) {
  for (const p of e.kv) {
    if (TEAMKEY.test(p[0])) p[1] = { 2: '3', 3: '2' }[p[1]] ?? p[1];
    else if (!FIXED.has(p[0].toLowerCase())) p[1] = swapNames(p[1]);
  }
  for (const c of V.kids(e, 'connections')) for (const p of c.kv) p[1] = swapNames(p[1]);
  return e;
}

// Pairs each entity of as with an unpaired entity of bs of the same class whose origin is within tol of its reflected
// origin, in order; then the rest with a model: one with the same model and the reflected angles (an arrow's flipped
// too) within near of it (a twin moved so its model box lines up, mirror.js). Returns Map a -> b.
export function pairEnts(as, bs, ax, c, tol = 0.5, near = 256) {
  const out = new Map(), taken = new Set(), bo = bs.map(org);
  const find = (a, ok, d) => {
    const r = reflectPoint(org(a), ax, c), k = cls(a);
    const j = bs.findIndex((b, i) => !taken.has(i) && cls(b) === k && bo[i].length === 3 && Math.hypot(...bo[i].map((x, n) => x - r[n])) <= d && ok(b));
    if (j >= 0) { taken.add(j); out.set(a, bs[j]); }
  };
  for (const a of as) find(a, () => true, tol);
  for (const a of as) {
    const m = V.get(a, 'model'), ang = reflectAngles(V.get(a, 'angles'), ax);
    if (out.has(a) || !m || ang === undefined) continue;
    find(a, b => V.get(b, 'model') === m && (V.get(b, 'angles') === ang || V.get(b, 'angles') === flipRoll(ang)), near);
  }
  return out;
}
