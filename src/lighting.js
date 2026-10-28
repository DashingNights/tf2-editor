// Lights, lightmap luxels and brush entity render keys of a VMF as plain data for the 3D view's lit and lightmap
// density modes (view3d). Pure, node-testable.
import * as V from '../vmf.js';

const D2R = Math.PI / 180;

// "_light" "r g b brightness" (vrad LightForString): colour 0..1 scaled by brightness / 255. One number is grey;
// three numbers have no brightness (full). Linear-gamma conversion is left out: the preview is not tone mapped.
export function lightColor(s) {
  const v = V.nums(s);
  if (!v.length) return [1, 1, 1];
  const [r, g = r, b = r] = v, k = v.length >= 4 ? v[3] / 255 : 1;
  return [r, g, b].map(x => (x / 255) * k);
}

// Unit vector the light shines along, as vrad's SetupLightNormalFromProps: yaw from "angle" (-1 up, -2 down) or
// angles, pitch from the "pitch" key or angles, z = sin(pitch) (so pitch -90 points straight down).
export function lightDir(angles, pitch = 0, angle = 0) {
  const a = V.nums(angles);
  if (angle === -1 || angle === -2) return [0, 0, angle === -1 ? 1 : -1];
  const yaw = (angle || a[1] || 0) * D2R, p = (pitch || a[0] || 0) * D2R;
  return [Math.cos(yaw) * Math.cos(p), Math.sin(yaw) * Math.cos(p), Math.sin(p)];
}

// ---------- falloff (vrad SetLightFalloffParams) ----------
// mathlib SolveInverseQuadratic: [a, b, c] of y = a x^2 + b x + c through three points, or null.
function solveIQ(x1, y1, x2, y2, x3, y3) {
  const det = (x1 - x2) * (x1 - x3) * (x2 - x3);
  if (!det) return null;
  return [
    (x3 * (-y1 + y2) + x2 * (y1 - y3) + x1 * (-y2 + y3)) / det,
    (x3 * x3 * (y1 - y2) + x1 * x1 * (y2 - y3) + x2 * x2 * (-y1 + y3)) / det,
    (x1 * x3 * (-x1 + x3) * y2 + x2 * x2 * (x3 * y1 - x1 * y3) + x2 * (-(x3 * x3 * y1) + x1 * x1 * y3)) / det,
  ];
}
// SolveInverseQuadraticMonotonic for x1 < x2 < x3: while the curve does not rise (mathlib tests 2a + b, the slope at
// x = 1), the middle point moves toward the line through the outer two in steps of 0.05.
function solveIQMono(x1, y1, x2, y2, x3, y3) {
  let r = null;
  for (let t = 0; t <= 1; t += 0.05) {
    r = solveIQ(x1, y1, x2, (1 - t) * y2 + t * (y1 + ((y3 - y1) * (x2 - x1)) / (x3 - x1)), x3, y3);
    if (!r || 2 * r[0] + r[1] >= 0) return r;
  }
  return r;
}

// A light's falloff as vrad computes it, brightness / (c + l d + q d^2), divided through so that 1 is the light's own
// brightness: at 100 units with the _constant / _linear / _quadratic_attn keys, at the centre with
// _fifty_percent_distance (vrad fits the curve through 1 there, 2 at the 50 and 256 at the zero percent distance, and
// scales it to be half at the 50). Faded out linearly from start to end (end === start: cut off there, _distance; 0:
// never); while q < 0 the distance stops at start (vrad's cap where the curve would turn up again).
export function falloff(n) {
  const num = k => +V.get(n, k) || 0, d50 = num('_fifty_percent_distance');
  if (d50 > 0) {
    let d0 = num('_zero_percent_distance');
    if (d0 < d50) d0 = 2 * d50;
    const [a, b, c] = solveIQMono(0, 1, d50, 2, d0, 256) ?? [0, 1, 0], s = 2 / (c + d50 * (b + d50 * a));
    const f = { c: c * s, l: b * s, q: a * s, start: 0, end: 0 }, top = a ? b / (-2 * a) : 0;
    if (num('_hardfalloff')) Object.assign(f, { start: 0.75 * d0 + 0.25 * d50, end: d0 });
    else if (top > 0) Object.assign(f, { start: top, end: 10 * top });
    return f;
  }
  let [c, l, q] = ['_constant_attn', '_linear_attn', '_quadratic_attn'].map(k => (num(k) < 1e-3 ? 0 : num(k)));
  if (!c && !l && !q) c = 1;
  const k = c + 100 * l + 1e4 * q, r = num('_distance');
  return { c: c / k, l: l / k, q: q / k, start: r, end: r };
}

// The falloff at distance d (view3d's lit shader computes the same).
export function atten(f, d) {
  const e = f.q < 0 ? Math.min(d, f.start) : d;
  let v = 1 / Math.max(f.c + e * (f.l + e * f.q), 1e-4);
  if (f.end > f.start) v *= Math.min(1, Math.max(0, (f.end - d) / (f.end - f.start)));
  else if (f.end > 0 && d > f.end) v = 0;
  return v;
}

// How far a light of brightness b reaches before it falls below t: its end, else the first power of two past that
// (16384 at most). The far plane of its shadow camera.
export function reach(f, b, t = 1 / 255) {
  if (f.end > 0) return f.end;
  let d = 64;
  while (d < 16384 && b * atten(f, d) > t) d *= 2;
  return d;
}

// Lights in the map, hidden ones skipped (vbsp++ skips them too):
// { kind: 'point' | 'spot' | 'sun', node, origin, color, distance, fifty, zero, att, dir, cone, inner, ambient }.
// distance / fifty / zero are 0 when unset; att is falloff() (point and spot); cone and inner are half angles in
// degrees; ambient is the sun's sky colour.
export function extract(root) {
  const out = [], num = (n, k) => +V.get(n, k) || 0;
  for (const n of V.kids(root, 'entity')) {
    const cls = V.get(n, 'classname'), kind = { light: 'point', light_spot: 'spot', light_environment: 'sun' }[cls];
    const origin = V.nums(V.get(n, 'origin'));
    if (!kind || origin.length !== 3) continue;
    const l = { kind, node: n, origin, color: lightColor(V.get(n, '_light')), distance: num(n, '_distance'), fifty: num(n, '_fifty_percent_distance'), zero: num(n, '_zero_percent_distance') };
    if (kind !== 'sun') l.att = falloff(n);
    if (kind !== 'point') l.dir = lightDir(V.get(n, 'angles'), num(n, 'pitch'), num(n, 'angle'));
    if (kind === 'spot') Object.assign(l, { cone: num(n, '_cone') || 45, inner: num(n, '_inner_cone') || 30 });
    if (kind === 'sun') l.ambient = lightColor(V.get(n, '_ambient') ?? '0 0 0 0');
    out.push(l);
  }
  return out;
}

// ---------- lightmap density ----------
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = a => { const l = Math.hypot(...a); return a.length === 3 && l > 1e-9 ? a.map(x => x / l) : null; };
// Luxel coordinates of a face's points: vbsp lays luxels along the side's texture axes made unit length, lightmapscale
// units apart (16 when unset). Missing or zero axes give two axes in the face's plane.
export function luxels(f) {
  const s = +V.get(f.side, 'lightmapscale') || 16, n = f.n;
  let [u, v] = ['uaxis', 'vaxis'].map(k => unit(V.nums(V.get(f.side, k)).slice(0, 3)));
  if (!u || !v) {
    u = unit(Math.abs(n[2]) < 0.9 ? [-n[1], n[0], 0] : [0, -n[2], n[1]]);
    v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  }
  return f.pts.map(p => [dot(p, u) / s, dot(p, v) / s]);
}

// Hue (0 red to 2/3 blue) of a lightmap scale on a log scale: 1 unit per luxel red, 16 (the default) green, 128 and
// coarser blue.
export const densityHue = s => (2 / 3) * Math.min(1, Math.max(0, Math.log2(+s || 16) / 7));

// ---------- brush entity render keys ----------
// rendercolor as a tint and renderamt as the opacity in rendermode 1 and 2 (Color, Texture) and 5 (Additive, added
// on top): { tint: [r, g, b] 0..1, alpha, add, key }, or null when the entity draws as normal.
export function renderFx(e) {
  const mode = +V.get(e, 'rendermode') || 0, c = V.nums(V.get(e, 'rendercolor')), amt = V.get(e, 'renderamt');
  const tint = c.length >= 3 ? c.slice(0, 3).map(x => Math.min(255, Math.max(0, x)) / 255) : [1, 1, 1];
  const alpha = [1, 2, 5].includes(mode) && amt !== undefined ? Math.min(255, Math.max(0, +amt || 0)) / 255 : 1, add = mode === 5;
  return alpha < 1 || add || tint.some(x => x < 1) ? { tint, alpha, add, key: `${tint.join()}|${alpha}|${add}` } : null;
}
