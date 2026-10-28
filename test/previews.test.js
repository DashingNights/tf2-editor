// node --test "test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false } };
const { pcfNames } = await import('../src/pcf.js');
const P = await import('../src/previews.js');

const near = (a, b, eps, msg) => assert.ok(a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < eps), `${msg}: ${a} != ${b}`);
const dist = (a, b) => Math.hypot(...a.map((x, k) => x - b[k]));
const ent = kv => ({ name: 'entity', kv: Object.entries(kv), children: [] });

// A binary DMX file of encoding version ver with elements [type, name]: header, string table, element index, then
// stand-in attribute bytes (pcfNames stops after the index).
function dmx(ver, els) {
  const parts = [], enc = new TextEncoder();
  const str = s => parts.push(enc.encode(s + '\0'));
  const int = (w, v) => { const b = new Uint8Array(w), d = new DataView(b.buffer); if (w === 4) d.setInt32(0, v, true); else d.setUint16(0, v, true); parts.push(b); };
  str(`<!-- dmx encoding binary ${ver} format pcf 1 -->\n`);
  const table = [...new Set(els.flatMap(([t, n]) => (ver >= 4 ? [t, n] : [t])))];
  if (ver >= 2) { int(ver >= 4 ? 4 : 2, table.length); table.forEach(str); }
  const ref = s => (ver >= 2 ? int(ver >= 5 ? 4 : 2, table.indexOf(s)) : str(s));
  int(4, els.length);
  for (const [t, n] of els) { ref(t); if (ver >= 4) ref(n); else str(n); parts.push(new Uint8Array(16).fill(7)); }
  parts.push(new Uint8Array([3, 0, 0, 0, 1, 2]));
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  parts.reduce((at, b) => (out.set(b, at), at + b.length), 0);
  return out;
}

test('pcfNames lists the particle system definitions of binary DMX versions 1 to 5', () => {
  const els = [['DmElement', 'untitled'], ['DmeParticleSystemDefinition', 'rain_storm'], ['DmeParticleOperator', 'Movement Basic'], ['DmeParticleSystemDefinition', 'rain_mist'], ['DmeParticleChild', 'rain_mist']];
  for (const ver of [1, 2, 3, 4, 5]) assert.deepEqual(pcfNames(dmx(ver, els)), ['rain_storm', 'rain_mist'], `version ${ver}`);
  assert.deepEqual(pcfNames(dmx(2, els).buffer), ['rain_storm', 'rain_mist'], 'an ArrayBuffer');
  assert.deepEqual(pcfNames(new TextEncoder().encode('<!-- dmx encoding keyvalues2 1 format pcf 1 -->\n\0')), []);
  assert.throws(() => pcfNames(dmx(2, els).subarray(0, 60)));
});

test('a rope hangs as a catenary as long as its ends apart plus the slack', () => {
  const a = [0, 0, 128], b = [256, 128, 64], pts = P.catenary(a, b, 25, 400);
  near(pts[0], a, 1e-6, 'start');
  near(pts.at(-1), b, 1e-6, 'end');
  const len = pts.slice(1).reduce((s, p, i) => s + dist(p, pts[i]), 0);
  assert.ok(Math.abs(len - (dist(a, b) + 25)) < 0.05, `length ${len}`);
  assert.ok(Math.min(...pts.map(p => p[2])) < 64, 'sags below the lower end');
  pts.forEach((p, i) => near(p.slice(0, 2), [(256 * i) / 400, (128 * i) / 400], 1e-6, 'stays in the vertical plane'));
  // A level rope sags most in the middle, by c (cosh(h / 2c) - 1).
  const level = P.catenary([0, 0, 0], [200, 0, 0], 25, 2);
  assert.ok(level[1][2] < -40 && level[1][2] > -60, `level sag ${level[1][2]}`);
  near(P.catenary([0, 0, 0], [100, 0, 50], 0, 2)[1], [50, 0, 25], 1e-9, 'no slack: straight');
  near(P.catenary([0, 0, 0], [0, 0, -100], 25, 2)[1], [0, 0, -50], 1e-9, 'vertical: straight');
});

test('trigger_catapult arcs land on the launch target or fall along the launch direction', () => {
  const s = [0, 0, 0], t = [800, 0, 200], arc = P.launchArc(s, 450, { target: t });
  near(arc[0], s, 1e-9, 'start');
  near(arc.at(-1), t, 1e-6, 'lands on the target');
  assert.ok(Math.max(...arc.map(p => p[2])) > 200, 'rises above the target');
  const flat = P.launchArc(s, 450, { dir: [1, 0, 0] }), T = Math.sqrt(1024 / 800);
  near(flat.at(-1), [450 * T, 0, -512], 1e-6, 'ends 512 below the start');
  near(P.launchArc(s, 450, { dir: [0, 0, 1] }).at(-1), [0, 0, -512], 1e-6, 'thrown up, ends 512 below the start');
  assert.deepEqual(P.launchArc(s, 0, { dir: [1, 0, 0] }), []);
  assert.deepEqual(P.launchArc(s, 450, { target: s }), []);
});

test('env_sun points at its target or against its light direction; Source angles turn forward', () => {
  near(P.sunDir(ent({ use_angles: '0' }), [0, 0, 100], [0, -100, 0]), [0, Math.SQRT1_2, Math.SQRT1_2], 1e-9, 'from the target');
  near(P.sunDir(ent({ use_angles: '1', angles: '-45 90 0' }), [0, 0, 0], [0, -100, 0]), [0, -Math.SQRT1_2, Math.SQRT1_2], 1e-9, 'use_angles wins');
  near(P.sunDir(ent({ angles: '0 180 0', pitch: '-30' }), [0, 0, 0], null), [Math.cos(Math.PI / 6), 0, 0.5], 1e-9, 'pitch key');
  const f = a => { const m = P.turn(a).elements; return [m[0], m[1], m[2]]; };
  near(f([0, 90, 0]), [0, 1, 0], 1e-9, 'yaw 90');
  near(f([90, 0, 0]), [0, 0, -1], 1e-9, 'pitch 90 looks down');
  assert.equal(P.kv(ent({ NextKey: 'k2' }), 'nextkey'), 'k2');
});
