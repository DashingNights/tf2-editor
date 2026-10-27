// Light entities of a VMF as plain descriptors for the lit preview (view3d). Pure, node-testable.
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

// Lights in the map, hidden ones skipped (vbsp++ skips them too):
// { kind: 'point' | 'spot' | 'sun', node, origin, color, distance, fifty, zero, dir, cone, inner, ambient }.
// distance / fifty / zero are 0 when unset; cone and inner are half angles in degrees; ambient is the sun's sky colour.
export function extract(root) {
  const out = [], num = (n, k) => +V.get(n, k) || 0;
  for (const n of V.kids(root, 'entity')) {
    const cls = V.get(n, 'classname'), kind = { light: 'point', light_spot: 'spot', light_environment: 'sun' }[cls];
    const origin = V.nums(V.get(n, 'origin'));
    if (!kind || origin.length !== 3) continue;
    const l = { kind, node: n, origin, color: lightColor(V.get(n, '_light')), distance: num(n, '_distance'), fifty: num(n, '_fifty_percent_distance'), zero: num(n, '_zero_percent_distance') };
    if (kind !== 'point') l.dir = lightDir(V.get(n, 'angles'), num(n, 'pitch'), num(n, 'angle'));
    if (kind === 'spot') Object.assign(l, { cone: num(n, '_cone') || 45, inner: num(n, '_inner_cone') || 30 });
    if (kind === 'sun') l.ambient = lightColor(V.get(n, '_ambient') ?? '0 0 0 0');
    out.push(l);
  }
  return out;
}
