import test from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../vmf.js';
import { readSvg } from '../src/svgread.js';
import { importLayout, readName, wallPieces, wallRuns } from '../src/figmaimport.js';
import { area, ccw, clipConvex, isConvex } from '../src/poly2d.js';

let id = 0;
const next = () => String(++id);
const run = (body, opts) => importLayout(readSvg(`<svg fill="none">${body}</svg>`), opts, next);
const rect = (name, x, y, w, h, fill = '#808080') => `<path id="${name}" d="M${x} ${y}H${x + w}V${y + h}H${x}Z" fill="${fill}"/>`;
const line = (name, d, w = 19) => `<path id="${name}" d="${d}" stroke="#3D5288" stroke-width="${w}"/>`;
const span = s => { const fs = V.faces(s), z = fs.flatMap(f => f.pts.map(p => p[2])); return [Math.min(...z), Math.max(...z)]; };
const plan = s => Math.abs(area(V.faces(s).find(f => f.n[2] < -0.99).pts));
const of = (r, kind) => r.solids.filter(s => s.kind === kind).map(s => s.solid);
const total = (r, kind) => of(r, kind).reduce((a, s) => a + plan(s), 0);
// the drawing's own floors (not the slab under a flight: obj "flight ... base"); the slabs under flights
const drawn = (r, kind) => r.solids.filter(s => s.kind === kind && !/ base$/.test(s.obj)).map(s => s.solid);
const footing = r => r.solids.filter(s => / base$/.test(s.obj)).map(s => s.solid);
// a face's narrowest width and shortest side
const width = pts => Math.min(...pts.map((a, i) => { const b = pts[(i + 1) % pts.length], e = [0, 1, 2].map(k => b[k] - a[k]), l = Math.hypot(...e); return l < 1e-9 ? Infinity : Math.max(...pts.map(p => { const d = [0, 1, 2].map(k => p[k] - a[k]); return Math.hypot(d[1] * e[2] - d[2] * e[1], d[2] * e[0] - d[0] * e[2], d[0] * e[1] - d[1] * e[0]) / l; })); }));
const shortest = pts => Math.min(...pts.map((p, i) => Math.hypot(...[0, 1, 2].map(k => p[k] - pts[(i + 1) % pts.length][k]))));

test('layer names: heights, wall heights, blocks, mirrors and roles', () => {
  assert.deepEqual(readName('Zone1 z-86'), { z: -86, role: undefined });
  assert.deepEqual(readName('Spawn_z-43_roofed'), { z: -43, roofed: true, spawn: true, role: undefined });
  assert.equal(readName('Half mirror-left').mirror, 'left');
  assert.equal(readName('Roof block').block, true);
  assert.equal(readName('walls h448').h, 448);
  assert.equal(readName('floor_2').role, 'floor');
  assert.equal(readName('Stair Midprogress Flat platform').role, 'landing');
  assert.equal(readName('landing z96').z, 96);
  assert.equal(readName('Elevation').role, 'floor');
  assert.equal(readName('ignore').role, 'ignore');
});

test('walls follow their line: one brush per straight piece, mitred corners, diagonals stay diagonal', () => {
  const [straight] = wallPieces([[0, 0], [100, 0]], false, 16);
  assert.equal(Math.abs(area(straight)), 1600);
  const diag = wallPieces([[0, 0], [300, 300]], false, 16);
  assert.equal(diag.length, 1); // one slanted brush, not a staircase of boxes
  assert.ok(Math.abs(Math.abs(area(diag[0])) - 300 * Math.SQRT2 * 16) < 1e-6);
  const corner = wallPieces([[0, 0], [100, 0], [100, 100]], false, 16);
  assert.equal(corner.length, 2);
  assert.equal(corner.reduce((a, q) => a + Math.abs(area(q)), 0), 3200); // mitred: no gap, no overlap
  for (const q of corner) for (const m of [[92, 8], [108, -8]]) assert.ok(q.some(p => Math.hypot(p[0] - m[0], p[1] - m[1]) < 1e-6), `${q}`);
  const square = wallPieces([[0, 0], [100, 0], [100, 100], [0, 100]], true, 16);
  assert.equal(square.length, 4);
  assert.equal(square.reduce((a, q) => a + Math.abs(area(q)), 0), 6400);
  assert.equal(wallPieces([[0, 0], [200, 0], [0, 35]], false, 16).length, 3); // a sharp corner gets a corner piece
  const arc = Array.from({ length: 33 }, (_, k) => [200 * Math.cos((Math.PI * k) / 32), 200 * Math.sin((Math.PI * k) / 32)]);
  const curved = wallPieces(arc, false, 16);
  assert.equal(curved.length, 32);
  assert.ok(curved.every(q => isConvex(q)));
  assert.ok(Math.abs(curved.reduce((a, q) => a + Math.abs(area(q)), 0) - Math.PI * 200 * 16) < Math.PI * 200 * 16 * 0.01);
});

test('a wall line is one wall per stretch between corners; a curve stays one wall', () => {
  const runs = (pts, closed = false) => wallRuns(pts, closed, 16).map(r => r.length);
  assert.deepEqual(runs([[0, 0], [100, 0], [100, 100]]), [1, 1]);
  assert.deepEqual(runs([[0, 0], [100, 0], [100, 100], [0, 100]], true), [1, 1, 1, 1]);
  assert.deepEqual(runs([[0, 0], [200, 0], [0, 35]]), [2, 1]); // the corner piece goes with the first wall
  const arc = Array.from({ length: 33 }, (_, k) => [200 * Math.cos((Math.PI * k) / 32), 200 * Math.sin((Math.PI * k) / 32)]);
  assert.deepEqual(runs(arc), [32]);
  assert.deepEqual(runs([[200, -300], ...arc]), [33]); // a straight wall running on into the curve
  assert.deepEqual(runs([...arc.slice(16), ...arc.slice(0, 16)], true), [1, 32]); // a closed D drawn from mid-curve
});

test('each floor, flight and wall between corners is one object', () => {
  const r = run(`<g id="Room z0">${rect('floor', 0, 0, 512, 512)}${line('walls', 'M0 512V0H512V512')}${line('walls_2', 'M100 100C200 100 300 150 300 250')}</g>
    <g id="Up z64">${rect('floor', 0, 640, 512, 256)}${line('stairs', 'M0 512H512M0 640H512', 2)}</g>`);
  const objs = kind => [...new Set(r.solids.filter(s => s.kind === kind).map(s => s.obj))];
  assert.equal(objs('wall').length, 4); // three sides and the curve
  const curve = r.solids.filter(s => s.kind === 'wall' && s.obj === objs('wall').find(o => r.solids.filter(s => s.obj === o).length > 1));
  assert.ok(curve.length > 3);
  assert.equal(objs('floor').length, 3); // the two floors and the slab under the flight
  assert.equal(objs('stairs').length, 1);
  assert.ok(r.solids.every(s => s.obj && s.area));
});

test('two floors, walls along their lines and the stairs between them', () => {
  const r = run(`<g id="Low z0">${rect('floor', 0, 0, 512, 256)}${line('walls', 'M0 0L0 256')}${line('walls_2', 'M512 0L812 300')}</g>
    <g id="High z64">${rect('floor', 0, 384, 512, 256)}${line('stairs', 'M0 256H512M0 384H512', 2)}</g>`);
  assert.ok(!r.error, r.error);
  assert.deepEqual(r.warnings, []);
  const tops = of(r, 'floor').map(s => span(s)[1]);
  assert.ok(tops.includes(0) && tops.includes(64));
  const walls = of(r, 'wall');
  assert.equal(walls.length, 2);
  assert.ok(walls.every(s => span(s)[1] === 192));
  assert.ok(walls.some(s => V.faces(s).some(f => Math.abs(Math.abs(f.n[0]) - Math.SQRT1_2) < 1e-6 && Math.abs(Math.abs(f.n[1]) - Math.SQRT1_2) < 1e-6)));
  const steps = of(r, 'stairs');
  assert.equal(steps.length, 4); // 5 risers up 64 over a 128 run
  assert.deepEqual(steps.map(s => span(s)[1]).sort((a, b) => a - b), [13, 26, 39, 52]);
});

test('a floor drawn on under a flight: the stairs still pair and cut the floor away there', () => {
  const r = run(`<g id="Low z0">${rect('floor', 0, 0, 512, 256)}${line('stairs', 'M0 256H512', 2)}</g>
    <g id="High z64">${rect('floor', 0, 288, 512, 256)}${line('stairs', 'M0 384H512', 2)}</g>`);
  assert.deepEqual(r.warnings, []);
  assert.equal(of(r, 'stairs').length, 4);
  assert.equal(drawn(r, 'floor').filter(s => span(s)[1] === 64).reduce((a, s) => a + plan(s), 0), 512 * (256 - 96)); // less the 96 under the flight
  assert.equal(drawn(r, 'floor').filter(s => span(s)[1] === 0).reduce((a, s) => a + plan(s), 0), 512 * 256); // the floor below stays
  assert.deepEqual(footing(r).map(s => [span(s)[1], plan(s)]), [[0, 512 * 128]]); // and the flight stands on a slab at its foot
});

test('a flight under a much higher area: its walls neither block the flight nor stand in it', () => {
  const r = run(`<g id="High z0">${rect('floor', 0, 0, 512, 256)}${line('stairs', 'M0 256H512', 2)}</g>
    <g id="Low z-86">${rect('floor', 0, 512, 512, 256)}${line('stairs', 'M0 512H512', 2)}</g>
    <g id="Tower z192">${line('walls', 'M-64 384H576')}</g>`);
  assert.deepEqual(r.warnings, []);
  assert.ok(of(r, 'stairs').length > 0);
  const walls = of(r, 'wall').map(span);
  assert.ok(walls.some(([b, t]) => t === 384 && b === 176)); // over the flight: at the top of the room over it
  assert.ok(walls.some(([b]) => b === r.base)); // past the flight's ends nothing is beside it: down to the bottom
});

test('a wall gives way to a floor running under it past both faces with 160 to spare, else stands', () => {
  const r = run(`<g id="Ground z0">${rect('floor', 0, 0, 512, 512)}</g>
    <g id="Tower z192">${rect('floor', 512, 0, 256, 512)}${line('walls', 'M256 0V512')}${line('walls_2', 'M512 0V512')}</g>
    <g id="Rail z64">${line('walls', 'M0 128H512')}</g>`);
  const walls = of(r, 'wall').map(span);
  assert.ok(walls.some(([b, t]) => b === 176 && t === 384)); // over the ground: out of its room (192 high), 16 under the tower's floor
  assert.ok(walls.some(([b, t]) => b === -16 && t === 384)); // the tower's edge: ground on one side only, down to a slab under it
  assert.ok(walls.every(([b, t]) => t !== 256 || b === r.base)); // only 64 above the ground: stands (its ends at the drawing's edge: on the bottom)
});

test('pickups: health and ammo markers become entities on the floor under them', () => {
  const r = run(`<g id="Room z32">${rect('floor', 0, 0, 512, 512)}</g>
    <g id="Pickups">${rect('Small Health', 100, 100, 32, 32)}${rect('Medium Ammo_2', 300, 100, 32, 32)}${rect('Large Health', 900, 900, 32, 32)}</g>`);
  const kv = e => Object.fromEntries(e.entity.kv);
  assert.deepEqual(r.entities.filter(e => e.kind === 'pickup').map(e => kv(e).classname), ['item_healthkit_small', 'item_ammopack_medium']);
  assert.ok(r.entities.filter(e => e.kind === 'pickup').every(e => kv(e).origin.endsWith(' 32') && e.area === 'Pickups'));
  assert.ok(r.warnings.some(w => /no floor under it/.test(w))); // the one off the map
});

test('a roofed area of stairs only gets a ceiling over its flight, at its walls\' top', () => {
  const r = run(`<g id="Low z0">${rect('floor', 0, 0, 512, 256)}</g><g id="High z64">${rect('floor', 0, 384, 512, 256)}</g>
    <g id="Hall roofed">${line('stairs', 'M0 256H512M0 384H512', 2)}</g>`);
  assert.ok(of(r, 'stairs').length);
  assert.ok(of(r, 'ceiling').some(s => span(s)[0] === 64 + 192)); // the hall's level is the highest floor its lines are on
});

test('a roof fits the stairs: over steps that climb high it rises to stay 160 above them', () => {
  const r = run(`<g id="Tunnel z-150 roofed">${rect('floor', 0, 0, 512, 256)}${line('stairs', 'M0 256H512', 2)}</g>
    <g id="Out z0">${rect('floor', 0, 512, 512, 256)}${line('stairs', 'M0 512H512', 2)}</g>`);
  const bottoms = of(r, 'ceiling').map(s => span(s)[0]);
  assert.ok(bottoms.includes(42)); // over the tunnel floor: its walls' top
  const steps = of(r, 'stairs').map(s => span(s)[1]), top = Math.max(...steps);
  assert.ok(bottoms.includes(top + 160)); // over the last step: clear above it
  assert.ok(bottoms.every(b => b >= 42));
});

test('a roof over a floor drawn under its own flight still stays 160 above every step', () => {
  const r = run(`<g id="Top z0">${rect('floor', 0, -256, 512, 256)}</g>
    <g id="Pit z-86 roofed">${rect('floor', 0, 0, 512, 256)}${rect('floor_2', 0, 256, 512, 256)}${line('stairs', 'M0 0H512M0 256H512', 2)}</g>`);
  assert.deepEqual(r.warnings, []);
  const foot = s => ccw(V.faces(s).find(f => f.n[2] < -0.99).pts.map(p => [p[0], p[1]])), steps = of(r, 'stairs');
  assert.ok(steps.length && of(r, 'ceiling').length);
  for (const c of of(r, 'ceiling')) for (const s of steps) {
    if (Math.abs(area(clipConvex(foot(c), foot(s)))) > 1) assert.ok(span(c)[0] - span(s)[1] >= 160, `roof ${span(c)[0]} over a step at ${span(s)[1]}`);
  }
});

test('gameplay: a spawn room for each half (BLU as drawn, RED mirrored), the KOTH point, a sky box and the sun', () => {
  const r = run(`<g id="Half mirror-left"><g id="Spawn z0">${rect('floor', 0, 0, 512, 512)}${line('stairs', 'M512 128V384', 2)}${line('walls', 'M0 0H512')}</g>
    <g id="Yard z-64">${rect('floor', 640, 0, 384, 512)}${line('stairs', 'M640 128V384', 2)}</g>
    <g id="Capture Point z-64">${rect('floor', 1024, 128, 128, 256)}</g></g>`);
  assert.deepEqual(r.warnings, []);
  const kv = e => Object.fromEntries(e.entity.kv), ents = r.entities.map(kv), cls = c => ents.filter(e => e.classname === c);
  const spawns = cls('info_player_teamspawn'), blu = spawns.filter(e => e.TeamNum === '3'), red = spawns.filter(e => e.TeamNum === '2');
  assert.equal(blu.length, 16);
  assert.equal(red.length, 16);
  assert.ok(Math.max(...blu.map(e => +e.origin.split(' ')[0])) < Math.min(...red.map(e => +e.origin.split(' ')[0])));
  assert.deepEqual(cls('func_respawnroom').map(e => `${e.targetname} ${e.TeamNum}`).sort(), ['spawnroom_blu 3', 'spawnroom_red 2']);
  assert.equal(cls('func_respawnroomvisualizer').length, 2); // one stairs out each
  const lockers = cls('prop_dynamic').filter(e => /resupply_locker/.test(e.model));
  assert.equal(lockers.length, 2);
  assert.deepEqual(cls('func_regenerate').map(e => e.associatedmodel).sort(), lockers.map(e => e.targetname).sort()); // resupply in front of each
  assert.equal(cls('func_door').length, 2); // a door on each way out, opened by a trigger for the team only
  const doors = r.entities.filter(e => kv(e).classname === 'trigger_multiple');
  assert.ok(doors.every(e => /^filter_(blu|red)$/.test(kv(e).filtername) && V.kids(e.entity, 'connections')[0].kv.some(([k, v]) => k === 'OnStartTouchAll' && /^door_/.test(v))));
  assert.deepEqual(cls('filter_activator_tfteam').map(e => e.TeamNum).sort(), ['2', '3']);
  assert.equal(cls('trigger_capture_area')[0].area_cap_point, 'cp_koth');
  const cp = r.entities.find(e => kv(e).classname === 'team_control_point');
  assert.equal(kv(cp).point_printname, 'the Capture Point');
  // doors open down at 500; blockers are nodraw but for the sign on their face out of the room; spawns keep out of
  // the door triggers and face a door
  assert.ok(cls('func_door').every(e => e.speed === '500' && e.movedir === '90 0 0'));
  for (const v of r.entities.filter(e => kv(e).classname === 'func_respawnroomvisualizer')) {
    const mats = V.kids(v.entity, 'solid').flatMap(s => V.kids(s, 'side').map(sd => V.get(sd, 'material')));
    assert.equal(mats.filter(m => m === 'OVERLAYS/NO_ENTRY').length, 1);
    assert.equal(mats.filter(m => m === 'TOOLS/TOOLSNODRAW').length, mats.length - 1);
  }
  const trigs = r.entities.filter(e => kv(e).classname === 'trigger_multiple').map(e => V.bounds(V.kids(e.entity, 'solid').flatMap(s => V.faces(s))));
  assert.ok(spawns.every(e => { const [x, y] = e.origin.split(' ').map(Number); return trigs.every(([mn, mx]) => x + 24 <= mn[0] || x - 24 >= mx[0] || y + 24 <= mn[1] || y - 24 >= mx[1]); }));
  assert.ok(spawns.every(e => e.spawnflags === '511'));
  assert.equal(+kv(cp).origin.split(' ')[0], 0); // on the mirror line, the middle of the map
  const capOut = V.kids(r.entities.find(e => kv(e).classname === 'trigger_capture_area').entity, 'connections')[0].kv;
  assert.ok(capOut.some(([k, v]) => k === 'OnCapTeam1' && v === 'koth_gamerules,SetRedKothClockActive,,0,-1'));
  assert.ok(capOut.some(([k, v]) => k === 'OnCapTeam2' && v === 'cp_koth_prop,Skin,2,0,-1'));
  assert.ok(cls('prop_dynamic').some(e => e.targetname === 'cp_koth_prop'));
  assert.equal(cls('tf_gamerules')[0]?.targetname, 'koth_gamerules');
  for (const c of ['tf_logic_koth', 'team_control_point_master', 'tf_gamerules', 'logic_auto', 'light_environment']) assert.equal(cls(c).length, 1, c);
  assert.equal(of(r, 'sky').length, 6);
  const mats = kind => new Set(of(r, kind).flatMap(s => V.kids(s, 'side').map(sd => V.get(sd, 'material'))));
  assert.deepEqual([...mats('floor')], ['DEV/REFLECTIVITY_90']);
  assert.deepEqual([...mats('wall')], ['DEV/DEV_MEASUREWALL01D']);
});

test('a wall corner less than 32 short of another wall is bridged to it; a small roofed room still gets a light', () => {
  const at = (r, x, y) => of(r, 'wall').some(s => { const f = V.faces(s).find(q => q.n[2] < -0.99).pts.map(p => [p[0], p[1]]), q = [x - r.offset[0], r.offset[1] - y]; return Math.abs(area(clipConvex(ccw(f), [[q[0] - 1, q[1] - 1], [q[0] + 1, q[1] - 1], [q[0] + 1, q[1] + 1], [q[0] - 1, q[1] + 1]]))) > 3.9; });
  const room = x => run(`<g id="Room z0 roofed">${rect('floor', -200, -100, 400, 300)}${line('walls', 'M0 0H200V200')}${line('walls', `M${x} -100V100`)}</g>`);
  assert.ok(at(room(224), 212, 0)); // the 8 gap between the corner and the wall is filled
  assert.ok(!at(room(264), 232, 0)); // a 48 gap stays
  const small = run(`<g id="Big z0">${rect('floor', 0, 0, 1024, 1024)}</g><g id="Closet z0 roofed">${rect('floor', 1100, 40, 80, 120)}${line('walls', 'M1092 32H1188V168H1092Z')}</g>`);
  assert.ok(small.entities.some(e => e.area === 'Closet z0 roofed' && Object.fromEntries(e.entity.kv).classname === 'light'));
});

test('shapes drawn a hair apart meet exactly: no crack between their brushes', () => {
  const r = run(`<g id="A z0">${rect('floor', 0, 0, 100.06, 100)}</g><g id="B z0">${rect('floor', 99.93, 0.08, 100, 99.9)}</g><g id="C z0">${rect('floor', 200.2, 0, 100, 100)}</g>`);
  const xs = [...new Set(of(r, 'floor').flatMap(s => V.faces(s).flatMap(f => f.pts.map(p => Math.round(p[0] * 100) / 100))))].sort((a, b) => a - b);
  assert.ok(xs.every((x, i) => !i || x - xs[i - 1] > 0.5), `${xs}`); // A and B share x 100, B and C x 200
  assert.equal(xs.length, 4);
});

test('a roof block over floors drawn a unit apart leaves no wall in the gap between them', () => {
  const r = run(`<g id="A z0">${rect('floor', 0, 0, 100, 100)}</g><g id="B z0">${rect('floor', 101, 0, 100, 100)}</g><g id="Roof block z0 h208">${rect('floor', 0, 0, 201, 100)}</g>`);
  assert.ok(of(r, 'block').length > 0);
  assert.ok(of(r, 'block').every(s => span(s)[0] >= 160), `${of(r, 'block').map(span)}`); // nothing hangs below the room top
});

test('a roof block in a spawn\'s group: a roof on its walls, not part of the spawn, indoor light under it', () => {
  const r = run(`<g id="Half mirror-left"><g id="Spawn z0">${rect('floor', 0, 0, 512, 512)}${line('stairs', 'M512 128V384', 2)}${line('walls', 'M0 0H512')}<g id="Roof block h208">${rect('floor', 0, 0, 512, 512)}</g></g>
    <g id="Yard z-64">${rect('floor', 640, 0, 384, 512)}${line('stairs', 'M640 128V384', 2)}</g>
    <g id="Capture Point z-64">${rect('floor', 1024, 128, 128, 256)}</g></g>`);
  assert.deepEqual(r.warnings, []);
  assert.ok(of(r, 'block').every(s => span(s).join() === '192,208')); // on the walls' top (z0 + 192)
  const kv = e => Object.fromEntries(e.entity.kv), lights = r.entities.filter(e => kv(e).classname === 'light');
  const inSpawn = lights.filter(e => e.area.startsWith('Spawn'));
  assert.ok(inSpawn.length && inSpawn.every(e => kv(e)._light === '255 236 210 200' && +kv(e).origin.split(' ')[2] < 192));
  assert.ok(lights.some(e => e.area.startsWith('Yard') && kv(e)._light === '255 240 225 90'));
});

test('markers in a spawn\'s group place its door, locker and spawn points, mirrored with it', () => {
  const r = run(`<g id="Half mirror-left"><g id="Spawn z0">${rect('floor', 0, 0, 512, 512)}${line('walls', 'M0 0H512')}${line('door', 'M512 0V512', 6)}
    ${rect('locker', 200, 8, 32, 32)}${rect('spawnpoint', 100, 300, 32, 32)}${rect('spawnpoint_2', 300, 300, 32, 32)}</g>
    <g id="Capture Point z0">${rect('floor', 960, 128, 128, 256)}</g></g>`);
  const kv = e => Object.fromEntries(e.entity.kv), ents = r.entities.map(kv), cls = c => ents.filter(e => e.classname === c);
  assert.deepEqual(cls('info_player_teamspawn').map(e => e.TeamNum).sort(), ['2', '2', '3', '3']); // the two markers, and their mirror
  assert.equal(cls('func_door').length, 2);
  const lockers = cls('prop_dynamic').filter(e => /resupply_locker/.test(e.model));
  assert.equal(lockers.length, 2);
  assert.equal(lockers.find(e => /_blu/.test(e.targetname)).angles, '0 270 0'); // faces away from the wall it stands at (the drawing's top: south)
  assert.ok(lockers.every(e => e.skin === '0')); // the model has one skin
  assert.equal(of(r, 'wall').length, 2); // the one wall and its mirror: a door line is no wall
});

test('controlpoint and capturezone markers: one point on the mirror line, the half zone mirrored into the whole', () => {
  const r = run(`<g id="Half mirror-left"><g id="Mid z32">${rect('floor', 0, 0, 512, 512)}${rect('capturezone', 256, 128, 256, 256)}
    <rect id="controlpoint" x="488" y="232" width="48" height="48" fill="#FFD400"/></g></g>`);
  const kv = e => Object.fromEntries(e.entity.kv), ents = r.entities.map(kv);
  const cps = ents.filter(e => e.classname === 'team_control_point');
  assert.equal(cps.length, 1);
  assert.deepEqual(cps[0].origin.split(' ').map(Number), [0, 0, 36]); // on the mirror line, 4 over the base on the floor
  const zone = r.entities.find(e => kv(e).classname === 'trigger_capture_area').entity;
  const xs = V.kids(zone, 'solid').flatMap(sd => V.faces(sd).flatMap(fc => fc.pts.map(p => p[0])));
  assert.deepEqual([Math.min(...xs), Math.max(...xs)], [-256, 256]); // the half drawn and its mirror
  assert.equal(V.kids(zone, 'solid').length, 1); // together convex: one brush, no seam on the mirror line
});

test('nothing of a higher area hangs down into a lower area\'s room: it starts at the room\'s top', () => {
  const r = run(`<g id="Under z-86 roofed">${rect('floor', 0, 0, 512, 256)}${line('walls', 'M0 0H512M0 256H512')}</g>
    <g id="Tower z176">${rect('floor', 128, -128, 256, 512)}${line('walls', 'M256 -128V384')}</g>`);
  assert.deepEqual(r.warnings, []);
  const tower = r.solids.filter(s => s.area === 'Tower z176').map(s => ({ s, span: span(s.solid), ys: V.faces(s.solid).flatMap(f => f.pts.map(p => p[1])) }));
  assert.ok(tower.some(t => t.s.kind === 'floor' && t.span[0] === 106 && t.span[1] === 176)); // on the underpass's walls' top
  assert.ok(tower.some(t => t.s.kind === 'wall' && t.span[0] === 106 && t.span[1] === 368));
  // what stands lower (down to the base beside the underpass, map y beyond +-128) stays out of it, but for its walls
  assert.ok(tower.filter(t => t.span[0] < 106).every(t => Math.max(...t.ys) <= -120 || Math.min(...t.ys) >= 120));
  assert.equal(total(r, 'ceiling'), 512 * 256 - 256 * 256); // the tower's floor is the underpass's roof under it
});

test('a floor of another area just above stairs stays whole, a slab over them, and the import says so', () => {
  const r = run(`<g id="Low z-86">${rect('floor', 0, 0, 512, 256)}${line('stairs', 'M0 256H512', 2)}</g>
    <g id="Mid z0">${rect('floor', 0, 384, 512, 256)}${line('stairs', 'M0 384H512', 2)}</g>
    <g id="Deck z129">${rect('floor', 0, 200, 512, 128)}</g>`);
  assert.ok(of(r, 'stairs').length);
  const deck = of(r, 'floor').filter(s => span(s)[1] === 129);
  assert.equal(deck.reduce((a, s) => a + plan(s), 0), 512 * 128); // no hole over the flight
  assert.ok(deck.every(s => span(s)[0] >= 106 && span(s)[0] <= 113));
  assert.ok(r.warnings.some(w => /Deck z129: its floor at z129 is only \d+ over the stairs of Low z-86/.test(w)), r.warnings.join('\n'));
});

test('a wall over a room is cut square across it, even where the room\'s edge is slanted', () => {
  const r = run(`<g id="Low z-86">${rect('floor', 0, 0, 512, 64)}<path id="floor_2" d="M0 64H512L384 256H0Z" fill="#808080"/></g>
    <g id="Tower z176">${line('walls', 'M-64 128H576')}</g>`);
  const walls = of(r, 'wall');
  assert.ok(walls.some(s => span(s)[0] > 0) && walls.some(s => span(s)[0] === r.base)); // over the room, and beside it (nothing past it: to the bottom)
  for (const s of walls) {
    const f = V.faces(s).find(q => q.n[2] < -0.99).pts;
    assert.ok(f.every((p, i) => { const q = f[(i + 1) % f.length]; return Math.abs(p[0] - q[0]) < 1e-6 || Math.abs(p[1] - q[1]) < 1e-6; }), JSON.stringify(f));
  }
});

test('a wall well below a flight running over it does not block it, and stops under it', () => {
  const r = run(`<g id="A z200">${rect('floor', 0, 0, 512, 256)}${line('stairs', 'M0 256H512', 2)}</g>
    <g id="B z264">${rect('floor', 0, 384, 512, 256)}${line('stairs', 'M0 384H512', 2)}</g>
    <g id="Ground z0">${line('walls h256', 'M-64 320H576')}</g>`);
  assert.deepEqual(r.warnings, []);
  assert.ok(of(r, 'stairs').length);
  const walls = of(r, 'wall').map(span);
  assert.ok(walls.some(([, t]) => t === 200)); // under the flight
  assert.ok(walls.some(([, t]) => t === 256)); // beside it
});

test('a stairs line running on along a landing edge is one edge, at the landing\'s height', () => {
  const r = run(`<g id="Low z0">${rect('floor', 0, 0, 512, 256)}${line('stairs', 'M0 256H512', 2)}</g>
    <g id="Up z0">${line('landing z64', 'M0 384H256V640H0Z', 2)}${line('stairs', 'M0 384H512', 2)}</g>`);
  const xs = of(r, 'stairs').flatMap(s => V.faces(s).flatMap(f => f.pts.map(p => p[0])));
  assert.equal(Math.max(...xs) - Math.min(...xs), 512); // the whole stairs line, not the landing's 256
});

test('a wall never pokes up through another area\'s stairs crossing it above its foot', () => {
  const r = run(`<g id="Pit z-86">${rect('floor', -64, 280, 640, 80)}${line('walls', 'M-64 320H576')}</g>
    <g id="A z0">${rect('floor', 0, 0, 512, 256)}${line('stairs', 'M0 256H512', 2)}</g>
    <g id="B z64">${rect('floor', 0, 384, 512, 256)}${line('stairs', 'M0 384H512', 2)}</g>`);
  assert.ok(of(r, 'stairs').length);
  const steps = of(r, 'stairs').map(span), walls = of(r, 'wall').map(span);
  assert.ok(walls.every(([, t]) => t <= Math.min(...steps.map(s => s[0])) || t === 106)); // under the flight: below its foot
  assert.ok(walls.some(([, t]) => t === 106)); // beside it: the pit's full wall
});

test('a wall running from a low floor onto a higher one keeps its full height where it stands on the higher floor', () => {
  const r = run(`<g id="Low z-86">${rect('floor', 0, 0, 256, 256)}</g><g id="High z0">${rect('floor', 256, 0, 256, 256)}</g>
    <g id="Path z0">${line('walls', 'M64 128H384')}</g>`);
  const walls = of(r, 'wall').map(span), bottom = Math.min(...walls.map(s => s[0])), top = Math.max(...walls.map(s => s[1]));
  assert.ok(walls.every(([b, t]) => b === bottom && t === top), JSON.stringify(walls)); // no passage cut through it
});

test('a stairs line with a wall drawn along it takes no flight', () => {
  const r = run(`<g id="Low z0">${rect('floor', 0, 0, 512, 256)}${line('stairs', 'M0 256H512', 2)}${line('walls', 'M0 256H512')}</g>
    <g id="High z64">${rect('floor', 0, 384, 512, 256)}${line('stairs', 'M0 384H512', 2)}</g>`);
  assert.equal(of(r, 'stairs').length, 0);
  assert.ok(r.warnings.some(w => /wall drawn along it/.test(w)));
});

test('a floor well above another leaves headroom; a block is cut through over a tunnel', () => {
  const r = run(`<g id="Ground z0">${rect('floor', 0, 0, 512, 512)}</g><g id="Bridge z192">${rect('floor', 0, 192, 512, 128)}</g>
    <g id="Tunnel z-86">${rect('floor', 0, 600, 512, 100)}</g><g id="Roof block">${rect('floor', 200, 500, 100, 300)}</g>`);
  const floors = of(r, 'floor');
  assert.ok(floors.some(s => span(s)[0] === 176 && span(s)[1] === 192)); // over the ground's room (192 high): a slab
  assert.equal(floors.filter(s => span(s)[1] === 0).reduce((a, s) => a + plan(s), 0), 512 * 512);
  const blocks = of(r, 'block');
  assert.ok(blocks.every(s => span(s)[1] === 192));
  assert.ok(blocks.some(s => span(s)[0] === 106)); // over the tunnel: at its room's top, -86 + 192
  assert.ok(blocks.some(s => span(s)[0] === r.base)); // beside the tunnel, at the drawing's edge: to the bottom
});

test('overlapping floors of similar height: the layer higher in Figma keeps the overlap', () => {
  const r = run(`<g id="A z0">${rect('floor', 0, 0, 400, 400)}</g><g id="B z32">${rect('floor', 200, 0, 400, 400)}</g>`);
  assert.equal(total(r, 'floor'), 600 * 400);
  assert.equal(of(r, 'floor').filter(s => span(s)[1] === 32).reduce((a, s) => a + plan(s), 0), 400 * 400);
});

test('a mirror group adds a mirrored copy across its edge; heights fall back to the fill colour', () => {
  const r = run(`<g id="Half mirror-left"><g id="Room z0">${rect('floor', 0, 0, 100, 100)}</g></g>`);
  assert.equal(of(r, 'floor').length, 2);
  assert.equal(total(r, 'floor'), 20000);
  const xs = of(r, 'floor').flatMap(s => V.faces(s).flatMap(f => f.pts.map(p => p[0])));
  assert.equal(Math.max(...xs) - Math.min(...xs), 200);
  const c = run(`<g id="Hill">${rect('floor', 0, 0, 100, 100, '#9B9B9B')}</g>`);
  assert.equal(span(of(c, 'floor')[0])[1], 86); // lightness 60.8%: z = 8 * (60.8 - 50)
  assert.ok(c.warnings.some(w => /fill colour/.test(w)));
});

test('stairs up to a landing and on: the landing at its own height', () => {
  const r = run(`<g id="Low z0">${rect('floor', 0, 0, 512, 256)}${line('stairs', 'M0 256H512', 2)}</g>
    <g id="High z128">${rect('floor', 0, 576, 512, 256)}${line('stairs', 'M0 576H512', 2)}${line('landing z64', 'M0 352H512M0 480H512', 2)}</g>`);
  assert.deepEqual(r.warnings, []);
  assert.ok(of(r, 'landing').every(s => span(s)[1] === 64));
  assert.equal(total(r, 'landing'), 512 * 128);
  const tops = of(r, 'stairs').map(s => span(s)[1]);
  assert.ok(tops.some(t => t > 0 && t < 64) && tops.some(t => t > 64 && t < 128));
});

// (a wall round the drawing: past it is nothing, so the wall stands on the bottom and what is inside it is closed)
const ring = (x0, y0, x1, y1) => `<g id="Edge z0">${line('walls', `M${x0} ${y0}H${x1}V${y1}H${x0}Z`)}</g>`;
test('thickness: floors are slabs under their top, a floor beside a lower one reaches down to it, a wall between two heights seals both', () => {
  const svg = `<g id="A z0">${rect('floor', 0, 0, 512, 256)}${line('walls', 'M0 256H512')}</g><g id="B z-86">${rect('floor', 0, 256, 512, 256)}</g>
    <g id="C z32">${rect('floor', 0, -256, 512, 256)}</g>${ring(0, -256, 512, 512)}`, r = run(svg, { gameplay: false });
  const at = top => of(r, 'floor').filter(s => span(s)[1] === top).map(span);
  assert.deepEqual(at(0), [[-16, 0]]); // its other side has the wall: a slab
  assert.deepEqual(at(-86), [[-102, -86]]);
  assert.deepEqual(at(32), [[-16, 32]]); // its side face reaches the slab of the floor below it
  const walls = r.solids.filter(s => s.kind === 'wall'), mid = walls.filter(s => !/Edge/.test(s.obj)).map(s => span(s.solid));
  assert.deepEqual(mid.filter(([b]) => b > r.base), [[-102, 192]]); // down to the lower floor's slab (its posts at the outer wall: on the bottom)
  assert.ok(walls.filter(s => /Edge/.test(s.obj)).every(s => span(s.solid)[0] === r.base)); // nothing past them: on the bottom, as before
  const thick = run(svg, { gameplay: false, thickness: 8 });
  assert.deepEqual(of(thick, 'floor').map(span).sort((a, b) => a[1] - b[1]), [[-94, -86], [-8, 0], [-8, 32]]); // (the setting)
});

test('a gap in the floors (a pit drawn without a floor): what stands beside it reaches the bottom of the map', () => {
  // a hall walled along its edge, and a landing 24 past the wall's face with no floor between them
  const r = run(`<g id="Hall z0">${rect('floor', 0, 0, 512, 256)}${line('walls', 'M0 256H512')}</g><g id="Ledge">${rect('landing z-43', 0, 288, 512, 96)}</g>${ring(0, 0, 512, 384)}`, { gameplay: false });
  const piece = re => r.solids.filter(s => re.test(s.obj)).map(s => span(s.solid));
  assert.deepEqual(piece(/Hall\/floor/), [[-16, 0]]);
  assert.ok(piece(/Hall\/walls/).every(([b, t]) => b === r.base && t === 192)); // no bottom above the landing: nothing under the wall shows
  assert.deepEqual(piece(/Ledge/), [[r.base, -43]]);
});

test('a flight stands on a slab at its foot (its steps are func_detail and close nothing); the floor at its top reaches down to it', () => {
  const r = run(`<g id="Low z0">${rect('floor', 0, 0, 512, 256)}${line('stairs', 'M0 256H512', 2)}</g>
    <g id="High z64">${rect('floor', 0, 384, 512, 256)}${line('stairs', 'M0 384H512', 2)}</g>${ring(0, 0, 512, 640)}`, { gameplay: false });
  assert.ok(of(r, 'stairs').length);
  assert.deepEqual(footing(r).map(span), [[-16, 0]]);
  assert.deepEqual(drawn(r, 'floor').map(span).sort((a, b) => a[1] - b[1]), [[-16, 0], [-16, 64]]);
});

test('no fans of triangles: an L, a U and a round floor are 2, 3 and 1 brushes, no face thinner or side shorter than half a unit', () => {
  const floors = svg => of(run(`<g id="Room z0">${svg}</g>`, { gameplay: false }), 'floor');
  const L = floors('<path id="floor" d="M0 0H300V100H100V300H0Z" fill="#808080"/>');
  const U = floors('<path id="floor" d="M0 0H300V300H200V100H100V300H0Z" fill="#808080"/>');
  const O = floors('<circle id="floor" cx="0" cy="0" r="256" fill="#808080"/>');
  assert.deepEqual([L.length, U.length, O.length], [2, 3, 1]);
  for (const s of [...L, ...U, ...O]) for (const f of V.faces(s)) {
    assert.ok(width(f.pts) >= 0.5 && shortest(f.pts) >= 0.5);
    if (f.n[2] > 0.99) assert.ok(f.pts.length >= 4); // no triangle tops
  }
  // a floor with another painted out of its middle: a ring of four pieces
  const ring = run(`<g id="Low z0">${rect('floor', 0, 0, 512, 512)}</g><g id="Pad z16">${rect('floor', 200, 200, 100, 100)}</g>`, { gameplay: false });
  assert.equal(of(ring, 'floor').filter(s => span(s)[1] === 0).length, 4);
});

test('the sky is a shell tight round the brushes, its ceiling skyHeight over the highest and over every entity', () => {
  const r = run(`<g id="Room z0">${rect('floor', 0, 0, 512, 256)}${line('walls', 'M0 0H512')}</g>`);
  const sky = of(r, 'sky'), box = V.bounds(r.solids.filter(s => s.kind !== 'sky').flatMap(s => V.faces(s.solid))), all = V.bounds(sky.flatMap(s => V.faces(s)));
  assert.equal(sky.length, 6);
  // (16 thick; inside: round the brushes, at most 32 out (16 clear of a light at the floor's edge), the ceiling 512 over)
  const inner = [all[0].map(v => v + 16), all[1].map(v => v - 16)];
  assert.ok([0, 1].every(k => inner[0][k] <= box[0][k] && box[0][k] - inner[0][k] <= 32 && inner[1][k] >= box[1][k] && inner[1][k] - box[1][k] <= 32), JSON.stringify([inner, box]));
  assert.ok(inner[0][2] <= box[0][2] && inner[0][2] > box[0][2] - 16 && inner[1][2] >= box[1][2] + 512 && inner[1][2] < box[1][2] + 512 + 16);
  const mats = sky.map(s => [...new Set(V.kids(s, 'side').map(sd => V.get(sd, 'material')))].join());
  assert.deepEqual(mats, Array(6).fill('TOOLS/TOOLSSKYBOX')); // (a pit's bottom is the sky)
  const low = V.bounds(of(run(`<g id="Room z0">${rect('floor', 0, 0, 512, 256)}</g>`, { skyHeight: 128 }), 'sky').flatMap(s => V.faces(s)));
  assert.equal(low[1][2], 144 + 16); // (the setting, raised to 16 over the light 128 over the floor)
  // the sun and the point's logic (256 over it) stay inside, however low the sky: one outside it leaks
  for (const skyHeight of [16, 512]) {
    const g = run(`<g id="Spawn z0">${rect('floor', 0, 0, 512, 512)}${line('walls', 'M0 0H512V512H0Z')}</g><g id="CP z0">${rect('floor', 1024, 0, 256, 256)}</g>`, { skyHeight });
    const b = V.bounds(of(g, 'sky').flatMap(s => V.faces(s))), ents = g.entities.filter(e => V.get(e.entity, 'origin'));
    assert.ok(ents.some(e => V.get(e.entity, 'classname') === 'light_environment') && ents.some(e => V.get(e.entity, 'classname') === 'team_control_point_master'));
    for (const e of ents) assert.ok(V.nums(V.get(e.entity, 'origin')).every((v, k) => v > b[0][k] + 16 && v < b[1][k] - 16), `${skyHeight}: ${e.key}`);
  }
});

test('nothing named, or no heights, is refused', () => {
  assert.match(run(rect('Rectangle 1', 0, 0, 10, 10)).error, /nothing to import/);
  assert.match(run(`<g id="Room">${rect('floor', 0, 0, 10, 10, 'url(#g)')}</g>`).error, /no heights/);
});
