// Sprinkle tool (Hammer++): click or drag in the 3D view to scatter entities from the preset in cfg.sprinkle over the
// surfaces round the pointer; Ctrl+drag removes the preset's entities within the radius. One undo step per stroke.
// Preset: { classname, models: [{ model, weight }], yaw (random yaw range, degrees), scale: [min, max], radius,
// density (entities per dab), align (up axis along the surface) }.
import * as THREE from 'three';
import * as V from '../vmf.js';
import { S, doc, sel, cache, edit, editCount, mergeUndo, nextId, setTool, setCursor } from './state.js';
import { registerTool, addHelper, removeHelper, invalidate, onHover } from './view3d.js';
import { register } from './commands.js';
import { cfg, setCfg } from './settings.js';
import { fgdDefaults, norm } from './models.js';
import { form } from './report.js';
import { cast, anglesFor, cross, unit, fmt, vec } from './droptools.js';

export const DEF = { classname: 'prop_static', models: [], yaw: 360, scale: [1, 1], radius: 128, density: 4, align: false };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const origin = n => V.nums(V.get(n, 'origin'));

// The preset; without models, the model picked last in the Models panel.
function preset() {
  const p = { ...DEF, ...cfg.sprinkle };
  if (!p.models?.length && cfg.recentModels?.[0]) p.models = [{ model: `models/${cfg.recentModels[0]}.mdl`, weight: 1 }];
  return p;
}

// ---------- pure helpers ----------
// The model of the first entry whose running weight passes x times the total (x in [0, 1)).
export function pickWeighted(ms, x) {
  let t = x * ms.reduce((s, m) => s + (+m.weight || 0), 0);
  for (const m of ms) if ((t -= +m.weight || 0) < 0) return m.model;
  return ms.at(-1)?.model;
}
// n points spread evenly over the disc of radius r round p, across normal nrm (unit); rand() in [0, 1).
export function scatter(p, nrm, r, n, rand = Math.random) {
  const u = unit(cross(Math.abs(nrm[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], nrm)), v = cross(nrm, u);
  return Array.from({ length: n }, () => {
    const a = rand() * 2 * Math.PI, d = r * Math.sqrt(rand());
    return p.map((x, k) => x + (u[k] * Math.cos(a) + v[k] * Math.sin(a)) * d);
  });
}
// 'props/rock01 2; models/x/y.mdl' -> [{ model: 'models/props/rock01.mdl', weight: 2 }, { model: 'models/x/y.mdl', weight: 1 }]
export const parseModels = s => s.split(/[;\n]/).map(x => x.trim().split(/\s+/)).filter(x => x[0]).map(([m, w]) => ({
  model: `${/^models[\\/]/i.test(m) ? '' : 'models/'}${m.replace(/\\/g, '/')}${/\.mdl$/i.test(m) ? '' : '.mdl'}`,
  weight: +w > 0 ? +w : 1,
}));
// A preset from entities with a .mdl model: each model weighted by how often it is used, the commonest class, the range
// of their modelscale; the rest from base. null when none has a model.
export function presetFrom(ents, base = DEF) {
  const w = new Map(), cls = new Map(), sc = [];
  for (const e of ents) {
    const m = V.get(e, 'model'), c = V.get(e, 'classname');
    if (!/\.mdl$/i.test(m ?? '')) continue;
    const k = m.toLowerCase().replace(/\\/g, '/');
    w.set(k, (w.get(k) ?? 0) + 1);
    cls.set(c, (cls.get(c) ?? 0) + 1);
    sc.push(+V.get(e, 'modelscale') || 1);
  }
  if (!w.size) return null;
  return { ...base, classname: [...cls].sort((a, b) => b[1] - a[1])[0][0], models: [...w].map(([model, weight]) => ({ model, weight })), scale: [Math.min(...sc), Math.max(...sc)] };
}

// ---------- strokes ----------
let stroke = null; // { remove, steps, last }

// fn changes the root's child list; the step joins the stroke's earlier ones.
function step(fn) {
  const k = editCount();
  edit([], [doc.root], fn);
  if (editCount() > k && stroke.steps++) mergeUndo();
}

// A new entity of preset p at q on a face with normal n: FGD defaults as the entity tool writes them, a random model by
// weight, yaw and scale.
function make(p, q, n) {
  const cls = p.classname || 'prop_static', e = V.entity(cls, q, nextId), y = Math.random() * (+p.yaw || 0);
  const s = +p.scale[0] + Math.random() * (+p.scale[1] - +p.scale[0]) || 1;
  e.kv.splice(2, 0, ...fgdDefaults(cls).filter(([k]) => !['id', 'classname', 'origin'].includes(k)).map(x => [...x]));
  V.set(e, 'model', pickWeighted(p.models, Math.random()));
  V.set(e, 'angles', vec(p.align && n[2] > 0.1 ? anglesFor(n, y) : [0, y, 0]));
  if (s !== 1 || V.get(e, 'modelscale') !== undefined) V.set(e, 'modelscale', fmt(s));
  return e;
}

// One dab at P on a face with normal n. Adds up to density entities on the surfaces under the disc round P (rays along
// -n from r above it), each at least gap from the preset's entities already there; remove: the preset's entities within
// the radius go instead.
function dab(P, n) {
  const p = preset(), r = +p.radius || 128, mine = new Set(p.models.map(m => norm(m.model)));
  const ours = [...cache.values()].filter(c => c.visible && c.point && mine.has(norm(V.get(c.node, 'model'))) && dist(origin(c.node), P) <= 2 * r);
  if (stroke.remove) {
    const gone = new Set(ours.filter(c => dist(origin(c.node), P) <= r).map(c => c.node));
    if (gone.size) step(() => { doc.root.children = doc.root.children.filter(x => !gone.has(x)); });
    return;
  }
  // ponytail: spacing from the density alone, so big models overlap; take the model boxes into account if that bothers
  const gap = 0.5 * r * Math.sqrt(Math.PI / Math.max(1, +p.density || 1)), taken = ours.map(c => origin(c.node)), add = [];
  for (const q of scatter(P, n, r, 3 * (+p.density || 1))) {
    if (add.length >= (+p.density || 1)) break;
    const h = cast(q.map((x, k) => x + n[k] * r), n.map(x => -x), { far: 2 * r, props: false });
    if (!h || taken.some(t => dist(t, h.point) < gap)) continue;
    taken.push(h.point);
    add.push(make(p, h.point, h.n));
  }
  const r0 = doc.root.children;
  if (add.length) step(() => r0.splice(r0.findLastIndex(c => /^(world|entity|hidden)$/.test(c.name)) + 1, 0, ...add));
}

// ---------- the tool ----------
const Z = new THREE.Vector3(0, 0, 1), tv = new THREE.Vector3();
const ring = new THREE.LineLoop(
  new THREE.BufferGeometry().setFromPoints(Array.from({ length: 48 }, (_, i) => new THREE.Vector3(Math.cos((i / 48) * Math.PI * 2), Math.sin((i / 48) * Math.PI * 2), 0))),
  new THREE.LineBasicMaterial({ color: 0x60e070, depthTest: false, transparent: true }));
ring.renderOrder = 3;
const normalOf = hit => hit.face?.n ?? [0, 0, 1];
// The radius ring on the surface under the pointer (red while removing); none off the map.
function showRing(hit, remove) {
  if (!hit) { if (ring.parent) removeHelper(ring); return; }
  ring.material.color.set(remove ? 0xff5050 : 0x60e070);
  ring.position.copy(hit.point);
  ring.quaternion.setFromUnitVectors(Z, tv.set(...normalOf(hit)));
  ring.scale.setScalar(+preset().radius || 128);
  if (!ring.parent) addHelper(ring); else invalidate();
}

// A press on a surface starts a stroke (Ctrl: removing); dragging dabs again every half radius; Esc ends the stroke,
// then the tool.
const TOOL = {
  activate: () => setCursor('Sprinkle: click or drag on surfaces; Ctrl+drag removes the preset\'s props; Esc stops. Sprinkle: edit preset sets models, radius and density.'),
  deactivate() { stroke = null; if (ring.parent) removeHelper(ring); },
  down(e, hit) {
    if (!hit) return false;
    if (!e.ctrlKey && !preset().models.length) { setCursor('Sprinkle: no models in the preset (Sprinkle: preset from the selected props, or pick a model in the Models panel)'); return true; }
    stroke = { remove: e.ctrlKey, steps: 0, last: hit.point.toArray() };
    dab(stroke.last, normalOf(hit));
    return true;
  },
  move(e, hit) {
    showRing(hit, stroke ? stroke.remove : e.ctrlKey);
    const q = stroke && hit?.point.toArray();
    if (q && dist(q, stroke.last) >= (+preset().radius || 128) / 2) { stroke.last = q; dab(q, normalOf(hit)); }
    return true;
  },
  up() { if (!stroke) return false; stroke = null; return true; },
  key(e) {
    if (e.key !== 'Escape') return false;
    if (stroke) stroke = null; else setTool('select');
    return true;
  },
};

// ---------- preset commands ----------
// The selected props' models, class and scale range replace the preset's; radius, density, yaw and align stay.
function fromSel() {
  const p = presetFrom([...sel].filter(n => cache.get(n)?.point), { ...DEF, ...cfg.sprinkle });
  if (!p) return setCursor('Sprinkle: select props with models first');
  setCfg('sprinkle', p);
  setCursor(`Sprinkle: preset of ${p.models.length} model(s), class ${p.classname}`);
}

// The preset in a form (report.js); numbers out of range fall back to the defaults.
async function editPreset() {
  const p = preset(), r = await form('Sprinkle preset', [
    { key: 'models', label: 'Models (path weight; ...)', value: p.models.map(m => `${m.model} ${m.weight}`).join('; ') },
    { key: 'classname', label: 'Class', value: p.classname },
    { key: 'radius', label: 'Radius', value: p.radius },
    { key: 'density', label: 'Entities per dab', value: p.density },
    { key: 'yaw', label: 'Random yaw (degrees)', value: p.yaw },
    { key: 'smin', label: 'Scale min', value: p.scale[0] },
    { key: 'smax', label: 'Scale max', value: p.scale[1] },
    { key: 'align', label: 'Align to the surface', type: 'checkbox', value: p.align },
  ], 'Save');
  if (!r) return;
  const num = (v, d, lo = 0) => (Number.isFinite(+v) && +v >= lo && String(v).trim() !== '' ? +v : d), smin = num(r.smin, 1, 0.01);
  setCfg('sprinkle', {
    classname: r.classname.trim() || DEF.classname, models: parseModels(r.models), radius: num(r.radius, DEF.radius, 1),
    density: Math.round(num(r.density, DEF.density, 1)), yaw: num(r.yaw, DEF.yaw), scale: [smin, Math.max(smin, num(r.smax, smin, 0.01))], align: r.align,
  });
}

export function mount() {
  registerTool('sprinkle', TOOL);
  onHover((hit, x) => { if (x === null && ring.parent) removeHelper(ring); }); // the pointer left the 3D view
  register('tool.sprinkle', { title: 'Tool: sprinkle props on surfaces (Ctrl+drag removes)', run: () => setTool(S.tool === 'sprinkle' ? 'select' : 'sprinkle'), on: () => S.tool === 'sprinkle' });
  register('sprinkle.presetFromSelection', { title: 'Sprinkle: preset from the selected props', run: fromSel });
  register('sprinkle.edit', { title: 'Sprinkle: edit preset (models, radius, density, yaw, scale)', run: editPreset });
}
