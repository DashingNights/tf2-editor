// Physics drop (Hammer++'s physics tool, quick and dirty): the selected props fall straight down onto brushes and the
// boxes of other props and come to rest with their up axis along the face they land on. A downward sweep of the box's
// footprint, no tumbling or sliding; the lowest prop falls first, so props stack. One undo step.
import * as V from '../vmf.js';
import { cache, sel, edit, setCursor } from './state.js';
import { register } from './commands.js';
import { cfg, setCfg } from './settings.js';
import { getModel, modelPath } from './models.js';
import { cast, anglesFor, worldBox, vec } from './droptools.js';

// Where a prop comes to rest. p: { origin, angles, lo, hi } (lo, hi: its model box, scaled); hit(o, d) -> { point, n,
// dist } | null casts a ray. Rays go down from a 3 x 3 grid over the footprint of its world box, from the box's middle
// height (a prop sunk into the floor comes up onto it); the highest hit is the contact. The prop turns its up axis to
// that face's normal (stays upright on faces steeper than 84 degrees), adds yaw degrees to its heading and sits on the
// face's plane with the bottom of its box, straight below its origin. { origin, angles, box } or null: nothing below.
// ponytail: one contact, no tipping off edges or sliding down slopes; a real rigid-body step if props need to topple.
export function restPose(p, hit, yaw = 0) {
  const [mn, mx] = worldBox(p.lo, p.hi, p.origin, p.angles), z = (mn[2] + mx[2]) / 2;
  const at = k => (mx[k] - mn[k] > 2 ? [mn[k] + 1, (mn[k] + mx[k]) / 2, mx[k] - 1] : [(mn[k] + mx[k]) / 2]);
  let best = null;
  for (const x of at(0)) for (const y of at(1)) {
    const h = hit([x, y, z], [0, 0, -1]);
    if (h && (!best || h.dist < best.dist)) best = h;
  }
  if (!best) return null;
  const n = best.n[2] > 0.1 ? best.n : [0, 0, 1], P = best.point, o = p.origin, angles = anglesFor(n, (p.angles[1] || 0) + yaw);
  const origin = [o[0], o[1], P[2] + (-p.lo[2] - n[0] * (o[0] - P[0]) - n[1] * (o[1] - P[1])) / n[2]];
  return { origin, angles, box: worldBox(p.lo, p.hi, origin, angles) };
}

// Prop n as restPose takes it: its model's box times modelscale (the cache box round the origin until the model loads).
function poseOf(n) {
  const o = V.nums(V.get(n, 'origin')), a = V.nums(V.get(n, 'angles') ?? ''), s = +V.get(n, 'modelscale') || 1;
  const b = getModel(modelPath(n), +V.get(n, 'skin') || 0).bbox, c = cache.get(n);
  const [lo, hi] = b ? b.map(q => q.map(x => x * s)) : [c.min.map((x, k) => x - o[k]), c.max.map((x, k) => x - o[k])];
  return { origin: o, angles: [a[0] || 0, a[1] || 0, a[2] || 0], lo, hi };
}

// Random yaw (cfg.physicsRandomYaw): up to cfg.physicsYaw degrees either way.
const yaw = () => (cfg.physicsRandomYaw ? (Math.random() * 2 - 1) * (+cfg.physicsYaw || 15) : 0);

// The selected entities with a .mdl model, lowest first; a prop with nothing below stays where it is.
function drop() {
  const props = [...sel].filter(n => cache.get(n)?.point && /\.mdl$/i.test(V.get(n, 'model') ?? '') && V.nums(V.get(n, 'origin')).length === 3);
  if (!props.length) return setCursor('Physics: select props first');
  props.sort((a, b) => cache.get(a).min[2] - cache.get(b).min[2]);
  const moving = new Set(props), boxes = [], out = [], hit = (o, d) => cast(o, d, { skip: n => moving.has(n), boxes });
  for (const n of props) {
    const p = poseOf(n), r = restPose(p, hit, yaw());
    boxes.push(r ? r.box : worldBox(p.lo, p.hi, p.origin, p.angles)); // the ones that settled are in the way of the rest
    if (r) out.push([n, r]);
  }
  if (!out.length) return setCursor('Physics: nothing below the selected props');
  edit(out.map(x => x[0]), [], () => out.forEach(([n, r]) => { V.set(n, 'origin', vec(r.origin)); V.set(n, 'angles', vec(r.angles)); }));
  setCursor(`Physics: ${out.length} prop(s) dropped${out.length < props.length ? `, ${props.length - out.length} with nothing below` : ''}`);
}

export function mount() {
  register('physics.drop', { title: 'Physics: drop the selected props onto what is below them', run: drop });
  register('physics.randomYaw', {
    title: 'Physics: random yaw when dropping props (toggle)', on: () => !!cfg.physicsRandomYaw,
    run: () => { setCfg('physicsRandomYaw', !cfg.physicsRandomYaw); setCursor(`Physics: random yaw ${cfg.physicsRandomYaw ? `on (up to ${+cfg.physicsYaw || 15} degrees)` : 'off'}`); },
  });
}
