// Texture drag in the 3D view (face mode): a middle-drag on a face moves the texture of the selected faces with the
// cursor, Ctrl+middle-drag turns it about the face's centre. Shown live; one undo step on release, Escape puts it back.
import * as V from '../vmf.js';
import { faceSel, cache, edit, touch, setFaceSelection, setCursor } from './state.js';
import { cfg } from './settings.js';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a, b) => a.map((x, i) => x - b[i]);
const unit = a => { const l = Math.hypot(...a) || 1; return a.map(x => x / l); };
const f6 = x => String(Math.round(x * 1e6) / 1e6);

// "[x y z shift] scale" <-> { v, shift, scale }
export const parseAxis = s => { const a = V.nums(s ?? ''); return { v: a.slice(0, 3), shift: a[3] ?? 0, scale: a[4] || 0.25 }; };
export const axisText = a => `[${[...a.v, a.shift].map(f6).join(' ')}] ${f6(a.scale)}`;
// Rodrigues: v turned deg degrees about the unit axis k.
export const turn = (v, k, deg) => {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r), d = dot(k, v), x = cross(k, v);
  return v.map((vi, i) => vi * c + x[i] * s + k[i] * d * (1 - c));
};
// The texture moved by the world offset d: the texel that was under p is under p + d. whole: shift in whole texels.
export const moved = (a, d, whole) => { const s = a.shift - dot(d, a.v) / a.scale; return { ...a, shift: whole ? Math.round(s) : s }; };
// The texture turned deg degrees about the unit axis n through point c: the texel under c stays.
export function turned(a, n, deg, c) {
  const v = turn(a.v, n, deg);
  return { ...a, v, shift: a.shift + (dot(c, a.v) - dot(c, v)) / a.scale };
}
// The angle in degrees from a to b about the unit axis n (counter-clockwise looking against n).
export const angle = (a, b, n) => (Math.atan2(dot(n, cross(a, b)), dot(a, b)) * 180) / Math.PI;

const KEYS = ['uaxis', 'vaxis', 'rotation'];
let D = null;
export const active = () => !!D;

// h: the face hit ({ node, side, point, face }); turning: rotate instead of move.
export function start(h, turning) {
  if (!faceSel.has(h.side)) setFaceSelection([h.side]);
  const faces = [];
  for (const c of cache.values()) for (const f of c.faces) if (faceSel.has(f.side)) faces.push({ solid: c.node, side: f.side, n: f.n, old: KEYS.map(k => V.get(f.side, k)) });
  const pts = h.face.pts, c = [0, 1, 2].map(k => pts.reduce((s, p) => s + p[k], 0) / pts.length);
  D = { turning, faces, n: h.face.n, p0: h.point.toArray?.() ?? h.point, c, last: null };
}

// The point where ray { o, d } meets the plane of the face the drag started on.
function onPlane(r) {
  const den = dot(r.d, D.n);
  if (Math.abs(den) < 1e-6) return null;
  const t = dot(sub(D.p0, r.o), D.n) / den;
  return t > 0 ? r.o.map((x, i) => x + r.d[i] * t) : null;
}

export function drag(r) {
  const p = D && onPlane(r);
  if (!p) return;
  let deg = 0, d = null;
  if (D.turning) {
    deg = angle(sub(D.p0, D.c), sub(p, D.c), D.n);
    if (cfg.snapRotation) { const st = +cfg.rotationStep || 15; deg = Math.round(deg / st) * st; }
  } else d = sub(p, D.p0);
  const key = D.turning ? deg : d.map(x => Math.round(x * 1000)).join();
  if (key === D.last) return;
  D.last = key;
  for (const f of D.faces) {
    let u = parseAxis(f.old[0]), v = parseAxis(f.old[1]);
    if (D.turning) {
      const sign = Math.sign(dot(unit(cross(u.v, v.v)), f.n)) || 1;
      u = turned(u, f.n, deg, D.c);
      v = turned(v, f.n, deg, D.c);
      V.set(f.side, 'rotation', f6((+f.old[2] || 0) + sign * deg));
    } else {
      u = moved(u, d, cfg.snapGrid);
      v = moved(v, d, cfg.snapGrid);
    }
    V.set(f.side, 'uaxis', axisText(u));
    V.set(f.side, 'vaxis', axisText(v));
  }
  touch(new Set(D.faces.map(f => f.solid)));
  const a = D.faces[0] && [parseAxis(V.get(D.faces[0].side, 'uaxis')).shift, parseAxis(V.get(D.faces[0].side, 'vaxis')).shift].map(f6);
  setCursor(D.turning ? `texture: turn ${f6(deg)} deg` : `texture: shift ${a.join(', ')}`);
}

const unset = (n, k) => { const i = n.kv.findIndex(p => p[0] === k); if (i >= 0) n.kv.splice(i, 1); };
const put = vals => D.faces.forEach((f, i) => KEYS.forEach((k, j) => (vals[i][j] === undefined ? unset(f.side, k) : V.set(f.side, k, vals[i][j]))));
// Release: one undo step from the values before the drag to the values now.
export function end() {
  if (!D) return;
  const now = D.faces.map(f => KEYS.map(k => V.get(f.side, k))), solids = [...new Set(D.faces.map(f => f.solid))];
  const changed = now.some((vals, i) => vals.some((x, j) => x !== D.faces[i].old[j]));
  if (changed) {
    put(D.faces.map(f => f.old));
    edit(solids, [], () => put(now));
  }
  D = null;
}
export function cancel() {
  if (!D) return;
  put(D.faces.map(f => f.old));
  touch(new Set(D.faces.map(f => f.solid)));
  D = null;
  setCursor('texture drag cancelled');
}
