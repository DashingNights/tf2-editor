// Colour picker popover for color255 keys ('r g b', or 'r g b brightness' as _light): RGB and HSV fields, the brightness,
// a system colour well and the map's palette (sidecar key 'colorPalette', saved per map): a swatch click applies its
// colour, + adds the current one, right-click on a swatch removes it. Each change is one undo step through set().
import * as V from '../vmf.js';
import { sideData, saveSidecar } from './state.js';
import { el } from './dom.js';

const clamp = (x, hi = 255) => Math.max(0, Math.min(hi, Math.round(x) || 0));
const fmt = x => String(Math.round(x * 1000) / 1000);

// [r, g, b] 0-255 -> [h 0-360, s 0-100, v 0-100], unrounded.
export function rgbToHsv([r, g, b]) {
  [r, g, b] = [r, g, b].map(x => x / 255);
  const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
  const h = !d ? 0 : mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, mx ? (d / mx) * 100 : 0, mx * 100];
}

// [h, s, v] -> [r, g, b] whole numbers 0-255. The hue wraps, s and v are clamped to 0-100.
export function hsvToRgb([h, s, v]) {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(100, s)) / 100;
  v = Math.max(0, Math.min(100, v)) / 100;
  const f = n => { const k = (n + h / 60) % 6; return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1)))); };
  return [f(5), f(3), f(1)];
}

const CSS = `
.cpick { inset: auto; margin: 0; padding: 8px; width: 230px; background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 5px; box-shadow: 0 6px 24px #000a; }
.cpick .cp-head { color: var(--dim); margin-bottom: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cpick input[type=color] { display: block; width: 100%; height: 28px; padding: 0 2px; background: #121419; border: 1px solid var(--line); border-radius: 3px; }
.cpick .cp-row { display: flex; gap: 4px; align-items: center; margin: 5px 0; }
.cpick .cp-row > span { flex: 0 0 34px; color: var(--dim); }
.cpick .cp-row input { flex: 1 1 0; width: 100%; min-width: 0; text-align: right; }
.cpick .cp-sub { color: var(--dim); margin: 8px 0 4px; }
.cpick .cp-pal { display: flex; flex-wrap: wrap; gap: 3px; }
.cpick .cp-pal button { width: 22px; height: 22px; padding: 0; }`;

// The popover (made on first use) and the last pointer position: the C key opens the picker there.
let pop = null, px = 200, py = 200;
globalThis.document?.addEventListener('pointermove', e => { px = e.clientX; py = e.clientY; }, { capture: true, passive: true });

const palette = () => (Array.isArray(sideData.colorPalette) ? sideData.colorPalette.filter(c => typeof c === 'string') : []);
function setPalette(p) { sideData.colorPalette = p; saveSidecar(); }

// Opens the picker for key on the entities in list (the first one's colour shows). get(e): an entity's value (its FGD
// default when unset); set(fn): one undo step giving each entity fn(e) (details.js setKey). An RGB change keeps each
// entity's brightness, a brightness change its colour. anchor: the element it opens under, else at the pointer.
export function pickColor({ list, key, get, set, anchor }) {
  if (!pop) {
    document.head.append(el('style', { textContent: CSS }));
    pop = document.body.appendChild(el('div', { className: 'cpick', popover: 'auto' }));
  }
  const cur = () => V.nums(get(list[0])), rgbOf = o => [0, 1, 2].map(i => clamp(o[i] ?? 255));
  // A brightness change leaves the colour numbers as they are (_lightHDR's -1 -1 -1 means "as LDR").
  const apply = (rgb, b) => {
    set(e => {
      const o = V.nums(get(e)), c = rgb ? rgb.map(x => clamp(x)) : o.length >= 3 ? o.slice(0, 3) : rgbOf(o);
      return [...c, ...(b === undefined ? o.slice(3) : [b, ...o.slice(4)])].join(' ');
    });
    fill();
  };
  // A number field; Enter commits (change), an empty or invalid value puts the current one back.
  const num = (title, max, onset) => {
    const i = el('input', { type: 'number', min: 0, step: 1, title, onkeydown: e => { if (e.key === 'Enter') i.blur(); } });
    if (max) i.max = max;
    i.onchange = () => (i.value !== '' && Number.isFinite(+i.value) ? onset(+i.value) : fill());
    return i;
  };
  const rgbF = ['Red', 'Green', 'Blue'].map((t, k) => num(t, 255, x => apply(rgbOf(cur()).map((y, j) => (j === k ? x : y)))));
  const hsvF = ['Hue', 'Saturation', 'Value'].map((t, k) => num(t, k ? 100 : 360, x => apply(hsvToRgb(rgbToHsv(rgbOf(cur())).map((y, j) => (j === k ? x : y))))));
  const bF = num('Brightness', 0, x => apply(undefined, x));
  const well = el('input', { type: 'color', title: 'System colour dialog', onchange: () => apply(well.value.match(/\w\w/g).map(h => parseInt(h, 16))) });
  const pal = el('div', { className: 'cp-pal' });
  const swatch = c => el('button', {
    title: `${c} (right-click: remove from the palette)`, style: `background: rgb(${V.nums(c).join(',')})`, onclick: () => apply(V.nums(c)),
    oncontextmenu: e => { e.preventDefault(); setPalette(palette().filter(x => x !== c)); fill(); },
  });
  function fill() {
    const o = cur(), rgb = rgbOf(o), hsv = rgbToHsv(rgb);
    rgbF.forEach((i, k) => { i.value = rgb[k]; });
    hsvF.forEach((i, k) => { i.value = Math.round(hsv[k]); });
    bF.value = o.length > 3 ? fmt(o[3]) : '';
    well.value = '#' + rgb.map(x => x.toString(16).padStart(2, '0')).join('');
    pal.replaceChildren(...palette().map(swatch), el('button', { textContent: '+', title: 'Add the current colour to the map palette',
      onclick: () => { setPalette([...new Set([...palette(), rgb.join(' ')])]); fill(); } }));
  }
  const line = (t, ...kids) => el('div', { className: 'cp-row' }, el('span', { textContent: t }), ...kids);
  const who = list.length > 1 ? `${list.length} entities` : V.get(list[0], 'targetname') || V.get(list[0], 'classname');
  pop.replaceChildren(el('div', { className: 'cp-head', textContent: `${key} - ${who}` }), well, line('RGB', ...rgbF), line('HSV', ...hsvF),
    cur().length > 3 || /^_(light|ambient)$/i.test(key) ? line('Bright', bF) : '', el('div', { className: 'cp-sub', textContent: 'Map palette' }), pal);
  fill();
  const r = anchor?.getBoundingClientRect(), at = r?.width ? [r.left, r.bottom + 4] : [px + 8, py + 8];
  Object.assign(pop.style, { left: `${at[0]}px`, top: `${at[1]}px` });
  if (!pop.matches(':popover-open')) pop.showPopover();
  const b = pop.getBoundingClientRect(); // kept inside the window
  Object.assign(pop.style, { left: `${Math.max(4, Math.min(at[0], innerWidth - b.width - 4))}px`, top: `${Math.max(4, Math.min(at[1], innerHeight - b.height - 4))}px` });
  rgbF[0].focus();
}
