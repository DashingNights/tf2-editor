// Model entity extras (models.js draws them): a Model section in Details for animated props (prop_dynamic and the other
// model entities that are not prop_static) with DefaultAnim picked from the model's sequences and one dropdown per body
// part writing the body group combination (models.js bodyKey), one undo step each; Ctrl+wheel over the 3D view scales
// the selected props' modelscale by 10% a notch, a burst of notches being one undo step.
import * as V from '../vmf.js';
import { emit } from './bus.js';
import { S, sel, cache, edit, mergeUndo, editCount, setCursor } from './state.js';
import { register } from './commands.js';
import { registerSection } from './details.js';
import { modelPath, modelOf, modelInfo, bodyKey, bodyOf, fgdHas } from './models.js';
import { bodyIndex, setBody } from './mdl.js';

const same = a => (a.every(x => x === a[0]) ? a[0] : undefined);
const kvi = (n, k) => n.kv.find(p => p[0].toLowerCase() === k.toLowerCase());
const cls = n => V.get(n, 'classname') ?? '';
// Selected point entities that show a model; animated: not prop_static (no sequences or body groups in the game).
const props = () => [...sel].filter(n => cache.get(n)?.point && modelPath(n));
const animated = () => props().filter(n => cls(n).toLowerCase() !== 'prop_static');
// Has a DefaultAnim key, or its FGD class does (prop_dynamic and kin); without the FGD, prop_dynamic*.
const takesAnim = n => !!kvi(n, 'defaultanim') || (fgdHas(cls(n), 'defaultanim') ?? /^prop_dynamic/i.test(cls(n)));
// Has a modelscale key, or its FGD class does (TF2's prop_static has none); without the FGD, every prop.
const scalable = n => !!kvi(n, 'modelscale') || (fgdHas(cls(n), 'modelscale') ?? true);

// Sets keys in one undo step: fn(entity) -> [key, value]; an entity keeps its own spelling of a key it has.
function setKeys(ents, fn) {
  const ch = ents.map(e => { const [k, v] = fn(e); return [e, kvi(e, k)?.[0] ?? k, v]; }).filter(([e, k, v]) => V.get(e, k) !== v);
  if (ch.length) edit([], ch.map(x => x[0]), () => ch.forEach(([e, k, v]) => V.set(e, k, v)));
}

// ---------- Details: Model section ----------
// 'parts/dmx/x_scout.dmx' -> 'x_scout'
const label = m => m.replace(/^.*[\\/]/, '').replace(/\.\w+$/, '') || 'blank';
// The model's info, or null after starting its load (a Details redraw follows when it has loaded).
function info(n) {
  const i = modelInfo(modelPath(n)), r = !i && modelOf(n);
  if (r && !r.failed) r.ready.then(() => modelInfo(modelPath(n)) && emit('details'));
  return i;
}

// The selection's sequences and body parts once its model has loaded. Several entities share the section when they
// show the same model; values that differ show as '--'.
function section({ section, row, dropdown }) {
  const ents = animated(), path = ents.length ? same(ents.map(modelPath)) : undefined, mi = path && info(ents[0]);
  if (!mi) return null;
  const rows = [], { sequences, parts } = mi;
  if (sequences.length && ents.every(takesAnim)) rows.push(row('Default anim', 'DefaultAnim: the sequence the prop plays (the editor draws its bind pose)',
    dropdown('m:anim', [['', '(none)'], ...sequences.map(s => [s])], same(ents.map(e => kvi(e, 'defaultanim')?.[1] ?? '')), v => setKeys(ents, () => ['DefaultAnim', v]))));
  parts.forEach((p, i) => {
    if (p.models.length < 2) return;
    rows.push(row(p.name || `Body part ${i}`, `Body part "${p.name}": sets the ${bodyKey(ents[0])} key (the body group combination)`,
      dropdown('m:part' + i, p.models.map((m, j) => [String(j), label(m)]), same(ents.map(e => String(bodyIndex(bodyOf(e), p)))),
        v => setKeys(ents, e => [bodyKey(e), String(setBody(bodyOf(e), p, +v))]))));
  });
  return rows.length ? section('Model', ...rows) : null;
}

// Every body group combination in turn (body + 1, back to 0 after the last) on the selected props with the first one's
// model.
function nextBody() {
  const first = animated()[0], mi = first && info(first);
  if (!mi) return setCursor(first ? 'The model has not loaded yet' : 'Select a prop with body groups');
  const total = mi.parts.reduce((a, p) => a * Math.max(1, p.models.length), 1), ents = animated().filter(e => modelPath(e) === modelPath(first));
  if (total < 2) return setCursor('This model has no body groups');
  setKeys(ents, e => [bodyKey(e), String((bodyOf(e) + 1) % total)]);
  setCursor(`body group combination ${bodyOf(first)} of ${total}`);
}

// ---------- modelscale ----------
// One notch from modelscale s: x1.1 up or /1.1 down, to 2 decimals, at least 0.01 apart, within 0.01..100.
export function scaleStep(s, up) {
  let v = Math.round(s * (up ? 110 : 100 / 1.1)) / 100;
  if (v === s) v = Math.round(s * 100 + (up ? 1 : -1)) / 100;
  return Math.min(100, Math.max(0.01, v));
}

// One notch on the selected props that take a modelscale: a new undo step, or (wheel) joined to the burst's step while
// notches come less than 400 ms apart and nothing else was edited in between.
let burst = null;
function scaleBy(up, wheel = false) {
  const all = props(), ents = all.filter(scalable);
  if (!ents.length) return setCursor(all.length ? `${cls(all[0])} has no modelscale key` : 'Select props to scale');
  const t = performance.now(), before = editCount(), join = wheel && burst?.made && t - burst.t < 400 && before === burst.n;
  setKeys(ents, e => ['modelscale', String(scaleStep(parseFloat(kvi(e, 'modelscale')?.[1]) || 1, up))]);
  const made = editCount() > before;
  if (join && made) mergeUndo();
  burst = wheel ? { t, n: editCount(), made: made || join } : null;
  setCursor(`modelscale ${same(ents.map(e => kvi(e, 'modelscale')?.[1])) ?? `of ${ents.length} props`}`);
}
// Capture phase on the 3D pane, before the view's wheel dolly: Ctrl+wheel with props selected scales them instead.
function wheel(e) {
  if (!e.ctrlKey || e.altKey || e.shiftKey || S.fly || !e.deltaY || !props().length) return;
  e.preventDefault();
  e.stopPropagation();
  scaleBy(e.deltaY < 0, true);
}

export function mount() {
  registerSection(section);
  document.getElementById('v-3d')?.addEventListener('wheel', wheel, { capture: true, passive: false });
  register('models.nextBody', { title: 'Models: next body group combination (selected props)', run: nextBody });
  register('models.scaleUp', { title: 'Models: scale the selected props up 10% (modelscale; Ctrl+wheel up in 3D)', run: () => scaleBy(true) });
  register('models.scaleDown', { title: 'Models: scale the selected props down 10% (modelscale; Ctrl+wheel down in 3D)', run: () => scaleBy(false) });
}
