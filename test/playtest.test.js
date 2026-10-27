import test from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../vmf.js';
import * as D from '../src/dispgeo.js';
import { CLASSES, BLU, RED, TICK, MINS, STAND, buildWorld, trace, newPlayer, unstick, tick, spawnPoints } from '../src/playmove.js';

let id = 0;
const next = () => String(++id);
const box = (mn, mx, mat = 'DEV/DEV_MEASUREGENERIC01') => V.block(mn, mx, mat, next);
const FLOOR = () => box([-4096, -4096, -64], [4096, 4096, 0]);
const map = (solids, ents = []) => ({ name: '', kv: [], children: [{ name: 'world', kv: [['classname', 'worldspawn']], children: solids }, ...ents] });
const ent = (classname, kv, solids = []) => ({ name: 'entity', kv: [['id', next()], ['classname', classname], ...kv], children: solids });
// A wedge rising along +x from (x0, z0) by `deg` degrees, y from -512 to 512, from z0 - 16 up.
function ramp(x0, z0, len, deg, mat = 'DEV/DEV_MEASUREGENERIC01') {
  const x1 = x0 + len, z1 = z0 + len * Math.tan(deg * Math.PI / 180), b = z0 - 16, y = [-512, 512];
  const P = (x, yy, z) => [x, yy, z];
  return V.brush([
    [P(x0, y[0], b), P(x1, y[0], b), P(x1, y[1], b), P(x0, y[1], b)],
    [P(x0, y[0], z0), P(x0, y[1], z0), P(x1, y[1], z1), P(x1, y[0], z1)],
    [P(x1, y[0], b), P(x1, y[0], z1), P(x1, y[1], z1), P(x1, y[1], b)],
    [P(x0, y[0], b), P(x0, y[1], b), P(x0, y[1], z0), P(x0, y[0], z0)],
    [P(x0, y[0], b), P(x0, y[0], z0), P(x1, y[0], z1), P(x1, y[0], b)],
    [P(x0, y[1], b), P(x1, y[1], b), P(x1, y[1], z1), P(x0, y[1], z0)],
  ], mat, next);
}
const spawn = (w, cls, at, teamNum = BLU) => { const p = newPlayer(cls, teamNum, at); assert.ok(unstick(w, p)); return p; };
// Runs n ticks of input (or input(i)); returns the origins after each tick.
function run(w, p, input, n) {
  const out = [];
  for (let i = 0; i < n; i++) { tick(w, p, typeof input === 'function' ? input(i) : input); out.push([...p.o]); }
  return out;
}
const hspeed = p => Math.hypot(p.v[0], p.v[1]);
const settle = (w, p) => run(w, p, {}, 120);

test('every class runs at its own speed and no faster; backwards at 0.9, diagonals no faster, crouched a third', () => {
  const w = buildWorld(map([FLOOR()]));
  CLASSES.forEach((c, cls) => {
    const p = spawn(w, cls, [0, 0, 1]);
    settle(w, p);
    let top = 0;
    for (let i = 0; i < 150; i++) { tick(w, p, { fwd: 1 }); top = Math.max(top, hspeed(p)); }
    assert.ok(Math.abs(hspeed(p) - c.speed) < 0.01, `${c.name} forward ${hspeed(p)}`);
    assert.ok(top <= c.speed + 1e-9, `${c.name} never above ${c.speed}: ${top}`);
    run(w, p, { fwd: 1, side: 1, yaw: 30 }, 150);
    assert.ok(Math.abs(hspeed(p) - c.speed) < 0.01, `${c.name} diagonal ${hspeed(p)}`);
    run(w, p, { fwd: -1 }, 150);
    assert.ok(Math.abs(hspeed(p) - c.speed * 0.9) < 0.01, `${c.name} backwards ${hspeed(p)}`);
    run(w, p, { fwd: 1, duck: true }, 150);
    assert.ok(Math.abs(hspeed(p) - c.speed / 3) < 0.01, `${c.name} crouched ${hspeed(p)}`);
    assert.ok(p.ducked && p.eye === 45);
    run(w, p, { fwd: -1, duck: true }, 150);
    assert.ok(Math.abs(hspeed(p) - c.speed / 3) < 0.01, `${c.name} crouched backwards ${hspeed(p)}`);
    run(w, p, {}, 150);
    assert.ok(!p.ducked && p.eye === c.eye && hspeed(p) === 0, `${c.name} stands up and stops`);
  });
});

test('jump 50, crouch jump 72, jump then duck 70, Scout air jump +47; no jump while crouched', () => {
  const w = buildWorld(map([FLOOR()])), apex = zs => Math.max(...zs.map(o => o[2]));
  const jumpWith = (cls, input) => { const p = spawn(w, cls, [0, 0, 1]); settle(w, p); const z0 = p.o[2]; return { p, h: apex(run(w, p, input, 80)) - z0 }; };
  const soldier = jumpWith(1, { jump: true });
  assert.ok(Math.abs(soldier.h - 50) < 1, `jump ${soldier.h}`);
  assert.ok(soldier.p.ground, 'lands again');
  const crouch = jumpWith(1, { jump: true, duck: true });
  assert.ok(Math.abs(crouch.h - 72) < 1, `crouch jump ${crouch.h}`);
  const late = jumpWith(1, i => ({ jump: true, duck: i > 0 }));
  assert.ok(Math.abs(late.h - 70) < 1, `jump then duck ${late.h}`);
  const ducked = jumpWith(1, i => ({ duck: true, jump: i > 30 }));
  assert.ok(ducked.h < 1, `no jump while fully crouched: ${ducked.h}`);
  // Scout: jump, let go, jump again at the top
  const p = spawn(w, 0, [0, 0, 1]);
  settle(w, p);
  const z0 = p.o[2], zs = run(w, p, i => ({ jump: i === 0 || i === 25 }), 120), first = apex(zs.slice(0, 25));
  assert.ok(Math.abs(first - z0 - 50) < 1);
  assert.ok(Math.abs(apex(zs) - zs[24][2] - 47) < 1, `air jump gain ${apex(zs) - zs[24][2]}`);
  const sol = spawn(w, 1, [0, 0, 1]);
  settle(w, sol);
  const zs2 = run(w, sol, i => ({ jump: i === 0 || i === 25 }), 120);
  assert.ok(apex(zs2) - zs2[0][2] < 51, 'no air jump for other classes');
});

test('an 18 unit step is climbed, a 19 unit one blocks', () => {
  for (const [h, up] of [[18, true], [19, false]]) {
    const w = buildWorld(map([FLOOR(), box([64, -512, 0], [1024, 512, h])]));
    const p = spawn(w, 1, [0, 0, 1]);
    settle(w, p);
    run(w, p, { fwd: 1 }, 100);
    if (up) assert.ok(p.o[0] > 200 && Math.abs(p.o[2] - h) < 0.1 && p.ground, `climbs ${h}: ${p.o}`);
    else assert.ok(p.o[0] < 40 && p.o[2] < 0.1, `blocked by ${h}: ${p.o}`);
  }
});

test('a 45 degree ramp is walkable, a 50 degree one slides', () => {
  const at = (x0, deg, x) => Math.tan(deg * Math.PI / 180) * (x - x0);
  const w45 = buildWorld(map([FLOOR(), ramp(0, 0, 512, 45)]));
  const p = spawn(w45, 1, [256, 0, at(0, 45, 256) + 40]);
  run(w45, p, {}, 200);
  const o = [...p.o];
  run(w45, p, {}, 100);
  assert.ok(p.ground && Math.hypot(p.o[0] - o[0], p.o[2] - o[2]) < 0.01, `stands on 45: ${o} -> ${p.o}`);
  run(w45, p, { fwd: 1 }, 60);
  assert.ok(p.o[0] > o[0] + 100 && p.o[2] > o[2] + 100, `walks up 45: ${p.o}`);
  const w50 = buildWorld(map([FLOOR(), ramp(0, 0, 512, 50)]));
  const q = spawn(w50, 1, [256, 0, at(0, 50, 256) + 40]);
  run(w50, q, {}, 30);
  const o2 = [...q.o];
  run(w50, q, { fwd: 1 }, 30);
  assert.ok(!q.ground && q.o[2] < o2[2] - 20 && q.o[0] < o2[0], `slides down 50 even walking up: ${o2} -> ${q.o}`);
});

test('gaps: 83 high passes standing and 82 does not; crouched 63 passes and 62 does not (hull + 1)', () => {
  const through = (h, duck) => {
    const w = buildWorld(map([FLOOR(), box([128, -512, h], [512, 512, h + 64])]));
    const p = spawn(w, 1, [0, 0, 1]);
    settle(w, p);
    run(w, p, { fwd: 1, duck }, 400);
    return p.o[0] > 200;
  };
  assert.equal(through(83, false), true);
  assert.equal(through(82, false), false);
  assert.equal(through(63, true), true);
  assert.equal(through(62, true), false);
  // under a 70 high ceiling there is no room to stand: the player stays ducked until out from under it
  const w = buildWorld(map([FLOOR(), box([128, -512, 70], [512, 512, 134])]));
  const p = spawn(w, 1, [0, 0, 1]);
  settle(w, p);
  run(w, p, { fwd: 1, duck: true }, 200);
  assert.ok(p.ducked && p.o[0] > 200 && p.o[0] < 400);
  run(w, p, {}, 60);
  assert.ok(p.ducked, 'cannot stand under it');
  run(w, p, { fwd: 1 }, 400);
  assert.ok(p.o[0] > 540 && !p.ducked, `stands up past it: ${p.o}`);
});

test('walls stop the player and it slides along them', () => {
  const w = buildWorld(map([FLOOR(), box([256, -2048, 0], [320, 2048, 256])]));
  const p = spawn(w, 1, [0, 0, 1]);
  settle(w, p);
  run(w, p, { fwd: 1, yaw: 45 }, 200);
  assert.ok(Math.abs(p.o[0] - (256 - 24 - 0.03125)) < 0.01, `stops at the wall: ${p.o}`);
  assert.ok(p.o[1] > 300 && hspeed(p) > 150, `slides along it: ${p.o} at ${hspeed(p)}`);
});

test('landing on and walking up a slanted blockbullets clip over stairs is smooth', () => {
  // 8 steps of 16 x 32 from x = 64; the clip runs over their nosings, from (32, 0) to (288, 128)
  const steps = Array.from({ length: 8 }, (_, i) => box([64 + i * 32, -256, 0], [96 + i * 32, 256, 16 * (i + 1)]));
  const clip = V.brush([
    [[32, -256, 0], [288, -256, 128], [288, 256, 128], [32, 256, 0]], [[32, -256, 0], [288, -256, 0], [288, 256, 0], [32, 256, 0]],
    [[32, -256, 0], [288, -256, 0], [288, -256, 128]], [[32, 256, 0], [288, 256, 128], [288, 256, 0]],
    [[288, -256, 0], [288, 256, 0], [288, 256, 128], [288, -256, 128]],
  ], 'TOOLS/TOOLSBLOCKBULLETS', next);
  const w = buildWorld(map([FLOOR(), ...steps, clip, box([320, -256, 0], [1024, 256, 128])]));
  const p = spawn(w, 2, [100, 0, 60]), zs = [p.o[2]];
  let landed = -1;
  for (let i = 0; i < 160; i++) { tick(w, p, { fwd: 1 }); zs.push(p.o[2]); if (p.ground && landed < 0) landed = i; }
  assert.ok(landed > 0 && zs[landed + 1] > 40, `lands on the clip: ${zs[landed + 1]}`);
  const dz = zs.map((z, i) => (i ? Math.abs(z - zs[i - 1]) : 0));
  assert.ok(Math.max(...dz) < 3, `no pops landing or walking up: ${Math.max(...dz)}`);
  assert.ok(Math.abs(p.o[2] - 128) < 0.1 && p.o[0] > 400, `walks up onto the top: ${p.o}`);
});

test('what blocks: world and detail by texture, clips, team visualizers and doors; not triggers, illusionary, hints', () => {
  const tall = mat => box([96, -64, 0], [128, 64, 256], mat);
  const blocked = (root, teamNum = BLU) => trace(buildWorld(root), [0, 0, 1], [256, 0, 1], MINS, STAND, teamNum).fraction < 1;
  assert.ok(blocked(map([tall('DEV/DEV_MEASUREWALL01D')])));
  for (const m of ['TOOLS/TOOLSPLAYERCLIP', 'TOOLS/TOOLSCLIP', 'TOOLS/TOOLSNODRAW', 'TOOLS/TOOLSBLOCKBULLETS', 'TOOLS/TOOLSSKYBOX', 'TOOLS/TOOLSINVISIBLE']) assert.ok(blocked(map([tall(m)])), m);
  for (const m of ['TOOLS/TOOLSNPCCLIP', 'TOOLS/TOOLSHINT', 'TOOLS/TOOLSSKIP', 'TOOLS/TOOLSBLOCKLIGHT', 'TOOLS/TOOLSORIGIN']) assert.ok(!blocked(map([tall(m)])), m);
  assert.ok(blocked(map([], [ent('func_detail', [], [tall('DEV/X')])])));
  for (const c of ['trigger_multiple', 'func_respawnroom', 'func_illusionary', 'func_areaportal', 'func_regenerate']) assert.ok(!blocked(map([], [ent(c, [], [tall('TOOLS/TOOLSTRIGGER')])])), c);
  assert.ok(!blocked(map([{ name: 'hidden', kv: [], children: [tall('DEV/X')] }])), 'hidden objects are not compiled');
  assert.ok(!blocked(map([], [ent('func_brush', [['Solidity', '1']], [tall('DEV/X')])])));
  assert.ok(blocked(map([], [ent('func_brush', [['Solidity', '2'], ['StartDisabled', '1']], [tall('DEV/X')])])));
  // a BLU respawn room's visualizer stops RED only
  const room = ent('func_respawnroom', [['targetname', 'room_blu'], ['TeamNum', '3']], [box([-512, -512, 0], [100, 512, 256], 'TOOLS/TOOLSTRIGGER')]);
  const vis = ent('func_respawnroomvisualizer', [['respawnroomname', 'room_blu'], ['solid_to_enemies', '1']], [tall('TOOLS/TOOLSNODRAW')]);
  assert.ok(!blocked(map([], [room, vis]), BLU));
  assert.ok(blocked(map([], [room, vis]), RED));
  const unnamed = ent('func_respawnroom', [['targetname', 'room_blu']], [box([-512, -512, 0], [100, 512, 256], 'TOOLS/TOOLSTRIGGER')]);
  const sp = ent('info_player_teamspawn', [['origin', '0 0 8'], ['TeamNum', '3']]);
  assert.ok(blocked(map([], [unnamed, vis, sp]), RED), 'room team from the spawn point inside it');
  assert.ok(!blocked(map([], [unnamed, vis]), RED), 'no team: never solid');
  // a spawn door opens for BLU standing in its trigger, never for RED
  const parts = () => [
    ent('func_door', [['targetname', 'd1'], ['spawnflags', '0']], [tall('METAL/METALDOOR001')]),
    ent('filter_activator_tfteam', [['targetname', 'f_blu'], ['TeamNum', '3'], ['Negated', '0'], ['origin', '0 0 0']]),
    ent('trigger_multiple', [['filtername', 'f_blu'], ['spawnflags', '1']], [box([-64, -64, 0], [192, 64, 128], 'TOOLS/TOOLSTRIGGER'), { name: 'connections', kv: [['OnStartTouchAll', 'd1,Open,,0,-1'], ['OnEndTouchAll', 'd1,Close,,0,-1']], children: [] }]),
  ];
  const walk = teamNum => { const w = buildWorld(map([FLOOR()], parts())), p = spawn(w, 1, [-200, 0, 1], teamNum); run(w, p, { fwd: 1 }, 150); return p.o[0]; };
  assert.ok(walk(BLU) > 300, 'BLU walks through');
  assert.ok(walk(RED) < 96, 'RED is stopped');
  assert.ok(!blocked(map([], [ent('func_door', [['spawnflags', '8']], [tall('DEV/X')])])), 'passable door');
  assert.ok(!blocked(map([], [ent('func_door', [['spawnpos', '1']], [tall('DEV/X')])])), 'door that spawns open');
  assert.ok(blocked(map([], [ent('func_door', [['spawnpos', '0']], [tall('DEV/X')])])), 'closed door');
});

test('displacements collide as their surface, not their brush; no hull collision flag lets players through', () => {
  const make = flags => {
    const s = box([-512, -512, -64], [512, 512, 16]), top = V.faces(s).find(f => f.n[2] > 0.99);
    const g = D.create(top.side, top.pts, 2);
    g.dist = g.dist.map(() => 24); // raised 24 everywhere: the surface is at 40
    g.field = g.field.map(() => [0, 0, 1]);
    g.flags = String(flags);
    D.write(top.side, g);
    return buildWorld(map([FLOOR(), s]));
  };
  const w0 = make(0), p = spawn(w0, 1, [0, 0, 100]);
  run(w0, p, {}, 100);
  assert.ok(Math.abs(p.o[2] - 40) < 0.1 && p.ground, `stands on the displaced surface: ${p.o}`);
  const w4 = make(4), q = spawn(w4, 1, [0, 0, 100]);
  run(w4, q, {}, 100);
  assert.ok(Math.abs(q.o[2]) < 0.1, `falls through to the floor: ${q.o}`);
});

test('crouch again while standing up: the view never stays above the crouched hull (the quantum crouch fix)', () => {
  // Heavy crouches, lets go, presses again while standing up and walks under a block 64 above the floor
  const w = buildWorld(map([FLOOR(), box([200, -512, 64], [1024, 512, 128])]));
  const p = spawn(w, 4, [0, 0, 1]);
  settle(w, p);
  for (const [n, input] of [[30, { duck: true }], [12, {}], [200, { duck: true, fwd: 1 }]]) for (let i = 0; i < n; i++) {
    tick(w, p, input);
    assert.ok(p.o[0] < 176 || p.o[2] + p.eye < 64, `the eye inside the block: ${p.o}, eye ${p.eye}`);
    assert.ok(p.ducking || !p.ducked || p.eye === 45, `crouched with the eye at ${p.eye}`);
  }
  assert.ok(p.ducked && p.eye === 45 && p.o[0] > 200, `crouched under the block: ${p.o}, eye ${p.eye}`);
  // let go under a 64 high block (no room to stand), walk out: it stands up there; crouch again 10 ticks into that
  // and walk back under: the press waits for the stand-up to finish
  const w2 = buildWorld(map([FLOOR(), box([128, -512, 64], [512, 512, 128])])), h = spawn(w2, 4, [0, 0, 1]);
  settle(w2, h);
  run(w2, h, { duck: true, fwd: 1 }, 300);
  assert.ok(h.ducked && h.o[0] > 200 && h.o[0] < 400);
  let n = 0;
  while (!h.ducking && n++ < 400) tick(w2, h, { fwd: 1 });
  assert.ok(h.ducked && h.ducking && h.o[0] > 512, `standing up past the block: ${h.o}`);
  run(w2, h, { fwd: 1 }, 9);
  for (let i = 0; i < 300; i++) {
    tick(w2, h, { duck: true, fwd: -1 });
    assert.ok(h.o[0] > 536 || h.o[2] + h.eye < 64, `the eye inside the block: ${h.o}, eye ${h.eye}`);
  }
  assert.ok(h.ducked && h.o[0] < 400, `back under it: ${h.o}`);
  // a press within 0.3 s of letting go on the ground does nothing; held, it crouches after that
  const q = spawn(w, 1, [0, 0, 1]);
  settle(w, q);
  run(w, q, { duck: true }, 30);
  run(w, q, {}, 15);
  assert.ok(!q.ducked && !q.ducking);
  run(w, q, { duck: true }, 3);
  assert.ok(!q.ducking && !q.ducked, 'ignored right after letting go');
  run(w, q, { duck: true }, 30);
  assert.ok(q.ducked, 'crouches once the wait is over');
});

test('in the air: 2 crouches, counted when let go', () => {
  const w = buildWorld(map([FLOOR()])), p = spawn(w, 1, [0, 0, 1]);
  settle(w, p);
  const ducks = [];
  // held on ticks 3-5, 9-11, 15-17: only the first two presses crouch
  for (let i = 0; i < 24; i++) { tick(w, p, { jump: i === 0, duck: i % 6 >= 3 }); ducks.push(p.ducked); }
  assert.deepEqual([4, 10, 16].map(i => ducks[i]), [true, true, false]);
});

test('a player inside a brush (an edit while playing) is moved out; a start point deep inside one is reported', () => {
  const p = spawn(buildWorld(map([FLOOR()])), 1, [0, 0, 1]);
  const w = buildWorld(map([FLOOR(), box([-16, -16, 0], [16, 16, 256])]));
  const o = [...p.o];
  run(w, p, { fwd: 1, jump: true }, 100);
  assert.ok(Math.hypot(p.o[0] - o[0], p.o[1] - o[1]) > 100, `gets out and walks: ${p.o}`);
  assert.equal(unstick(buildWorld(map([box([-4096, -4096, -512], [4096, 4096, 0])])), newPlayer(1, BLU, [0, 0, -300])), false);
});

test('solid props block as their model box (turned with it); solid 0 props and water brushes do not', () => {
  // a 64 cube turned 45 degrees about z at (128, 0): its corners reach x = 128 +- 45.25
  const r = Math.SQRT1_2, corners = [0, 1, 2, 3, 4, 5, 6, 7].map(i => {
    const x = i & 1 ? 32 : -32, y = i & 2 ? 32 : -32, z = i & 4 ? 64 : 0;
    return [128 + (x - y) * r, (x + y) * r, z];
  });
  const prop = solid => ent('prop_dynamic', [['origin', '128 0 0'], ['model', 'models/x.mdl'], ...(solid ? [['solid', solid]] : [])]);
  const at = (root, s, e) => trace(buildWorld(root, undefined, { prop: () => corners }), s, e, MINS, STAND, BLU);
  assert.ok(at(map([], [prop('6')]), [0, 0, 1], [256, 0, 1]).fraction < 1, 'blocks');
  assert.ok(at(map([], [prop()]), [0, 0, 1], [256, 0, 1]).fraction < 1, 'solid 6 is the default');
  assert.ok(at(map([], [prop('0')]), [0, 0, 1], [256, 0, 1]).fraction === 1, 'solid 0');
  // past the corner of its unturned bounds (x, y both 45 from the centre) but clear of the turned box
  assert.ok(at(map([], [prop('6')]), [128 + 52, -200, 1], [128 + 52, 200, 1]).fraction < 1, 'the box edge');
  assert.ok(at(map([], [prop('6')]), [128 + 46 + 24, -60 - 24, 1], [128 + 60 + 24, -46 - 24, 1]).fraction === 1, 'not its unturned bounds');
  const water = box([-512, -512, -64], [512, 512, 0], 'WATER/WATER_WELL');
  const w = buildWorld(map([box([-512, -512, -256], [512, 512, -192]), water]), undefined, { water: m => m.startsWith('water/') });
  const p = spawn(w, 1, [0, 0, 1]);
  run(w, p, {}, 100);
  assert.ok(Math.abs(p.o[2] + 192) < 0.1, `falls through the water to the bottom: ${p.o}`);
});
