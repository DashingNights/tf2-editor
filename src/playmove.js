// Playtest movement: a TF2 player walking the map's brushes. Pure (VMF nodes in, numbers out), node-testable.
// A port of Source SDK 2013's CGameMovement / CTFGameMovement (gamemovement.cpp, tf_gamemovement.cpp) for walking:
// the same tick order, constants and box traces. No swimming, ladders, weapons, fall damage or instances; props are boxes.
// As a port of Valve's code this file is under the Source 1 SDK License (licenses/source-sdk-2013), not the MIT License:
// Copyright (c) Valve Corporation. All rights reserved. It may only be distributed free of charge.
import * as V from '../vmf.js';
import * as D from './dispgeo.js';

// speed_max (u/s) and standing eye height (g_TFClassViewVectors), in the game's 1-9 order.
export const CLASSES = [
  { name: 'Scout', speed: 400, eye: 65 }, { name: 'Soldier', speed: 240, eye: 68 }, { name: 'Pyro', speed: 300, eye: 68 },
  { name: 'Demoman', speed: 280, eye: 68 }, { name: 'Heavy', speed: 230, eye: 75 }, { name: 'Engineer', speed: 300, eye: 68 },
  { name: 'Medic', speed: 320, eye: 75 }, { name: 'Sniper', speed: 300, eye: 75 }, { name: 'Spy', speed: 320, eye: 75 },
];
export const RED = 2, BLU = 3, TICK = 0.015; // DEFAULT_TICK_INTERVAL: TF ignores -tickrate
// Player hull, origin at the feet: 48 x 48 x 82 standing, 62 ducked.
export const MINS = [-24, -24, 0], STAND = [24, 24, 82], DUCKED = [24, 24, 62];
const GRAVITY = 800, FRICTION = 4, STOPSPEED = 100, ACCEL = 10, AIRACCEL = 10, AIRCAP = 30, STEP = 18, MAXVEL = 3500;
const JUMP = 289, DASH = 268.3281572999747, BUNNY = 1.2, CMDSPEED = 450, WALK = 0.3, BACK = 0.9, BACK_MIN = 100;
const DUCK_EYE = 45, DUCK_TIME = 0.2, DUCK_WAIT = 0.3, DUCK_SHIFT = STAND[2] - DUCKED[2], AIRDUCKS = 2, EPS = 0.03125, WALKABLE = 0.7;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// ---------- the collision world ----------
// A convex shape as support planes [nx, ny, nz, h] (n.x <= h holds on the shape): its face normals, the 6 axes and
// edge x axis for every edge. Those are all the face normals of its Minkowski sum with any axis-aligned box, so a box
// trace is a point trace against the planes moved out by the box (CM_ClipBoxToBrush with exact bevels).
const AXES = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0], [0, -1, 0], [0, 0, -1]];
function convex(pts, normals, edges) {
  const dirs = [], keys = new Set();
  const add = n => {
    const l = Math.hypot(...n);
    if (l < 1e-9) return;
    const u = n.map(x => x / l), k = u.map(x => Math.round(x * 1e5)).join();
    if (!keys.has(k)) { keys.add(k); dirs.push(u); }
  };
  normals.forEach(add);
  AXES.forEach(add);
  for (const e of edges) for (const a of AXES.slice(0, 3)) { const c = cross(e, a); add(c); add(c.map(x => -x)); }
  const planes = new Float64Array(dirs.length * 4), min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  dirs.forEach((n, i) => { planes.set(n, i * 4); planes[i * 4 + 3] = Math.max(...pts.map(p => dot(n, p))); });
  for (const p of pts) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
  return { planes, min, max, only: 0, door: null, seen: 0 };
}
const edgesOf = polys => polys.flatMap(ps => ps.map((p, i) => ps[(i + 1) % ps.length].map((x, k) => x - p[k])));
const brushShape = faces => convex(faces.flatMap(f => f.pts), faces.map(f => f.n), edgesOf(faces.map(f => f.pts)));
// A turned box from its 8 corners (corner i is at the max on axis k when bit k of i is set).
const boxShape = c => { const ax = [1, 2, 4].map(i => c[i].map((x, k) => x - c[0][k])); return convex(c, [...ax, ...ax.map(a => a.map(x => -x))], ax); };

// Tool textures that never block players (VDC Tool textures; vbsp textures.cpp). Every other material does, the
// entity-only ones (trigger, areaportal, occluder) too when they are on a world brush. A brush with a water face is
// water (vbsp BrushContents drops CONTENTS_SOLID): not solid.
const PASS = /^tools\/tools(hint|skip|npcclip|blocklight|block_?los|origin|fog(volume)?)$/;
const mat = f => (V.get(f.side, 'material') || '').toLowerCase();
const blocks = (faces, water) => !faces.some(f => water(mat(f))) && faces.some(f => !PASS.test(mat(f)));

// Shapes of a solid that block players. A displacement brush is only its displacement surfaces (vbsp drops the
// brush), as triangles, both sides solid, unless its dispinfo flags say no hull collision (4).
function solidShapes(solid, facesOf, water) {
  const faces = facesOf(solid), disp = faces.filter(f => V.kids(f.side, 'dispinfo').length);
  if (!disp.length) return faces.length && blocks(faces, water) ? [brushShape(faces)] : [];
  return disp.flatMap(f => {
    const r = +V.get(V.kids(f.side, 'dispinfo')[0], 'flags') & 4 ? null : D.build(f.side, f.pts), out = [];
    for (let i = 0; r && i < r.indices.length; i += 3) {
      const t = [0, 1, 2].map(j => r.positions.slice(r.indices[i + j] * 3, r.indices[i + j] * 3 + 3)), n = cross(t[1].map((x, k) => x - t[0][k]), t[2].map((x, k) => x - t[0][k]));
      if (Math.hypot(...n) > 1e-6) out.push(convex(t, [n, n.map(x => -x)], edgesOf([t])));
    }
    return out;
  });
}

// Brush entities that block players (by their brushes' textures, like world brushes). Triggers, func_respawnroom,
// func_illusionary, func_areaportal, func_occluder, func_clip_vphysics and the rest never do.
const SOLID = new Set(['func_detail', 'func_wall', 'func_wall_toggle', 'func_brush', 'func_door', 'func_door_rotating', 'func_breakable',
  'func_breakable_surf', 'func_movelinear', 'func_tracktrain', 'func_rotating', 'func_physbox', 'func_physbox_multiplayer', 'func_button',
  'func_rot_button', 'func_lod', 'func_reflective_glass', 'func_monitor', 'func_conveyor', 'func_plat', 'func_platrot', 'func_pushable',
  'func_tanktrain', 'func_trackchange', 'func_trackautochange', 'func_guntarget', 'func_respawnroomvisualizer', 'func_forcefield']);
const team = x => (+x === RED || +x === BLU ? +x : 0);
const enemy = t => (t === RED ? BLU : t === BLU ? RED : 0);
const outputs = e => V.kids(e, 'connections').flatMap(c => c.kv.map(([o, v]) => [o, ...v.split(/[,\x1b]/)]));
const inside = (c, o, mins = [0, 0, 0], maxs = mins) => overlaps(c, o, mins, maxs);

// Everything that blocks players, as the game compiles the map: world and brush entity solids (not the ones hidden
// in Hammer's hidden blocks, which vbsp skips; visgroups and show filters do not matter). Spawn doors a team trigger
// opens (func_door targeted by a trigger's Open output) are open while the player touches such a trigger
// (OnStartTouchAll Open / OnEndTouchAll Close); other doors stay closed. A func_respawnroomvisualizer blocks the enemy
// of its func_respawnroom's team, a func_forcefield the enemy of its TeamNum. Props that are solid (solid not 0, not
// StartDisabled) block as their model's box, prop(entity) -> its 8 corners or null (not loaded): the game uses the
// model's collision mesh, which the editor does not read. facesOf: solid -> vmf.js faces (a cache); water(material)
// -> true for water and slime (the VMT's %compilewater): those brushes are not solid.
const PROP = /^prop_(static|dynamic(_override)?|physics(_override)?)$/;
export function buildWorld(root, facesOf = V.faces, { prop = () => null, water = () => false } = {}) {
  const w = { shapes: [], cells: new Map(), doors: [], stamp: 0 }, ents = V.kids(root, 'entity');
  const cls = e => (V.get(e, 'classname') || '').toLowerCase(), named = n => ents.filter(e => n && V.get(e, 'targetname') === n);
  const shapesOf = e => V.kids(e, 'solid').flatMap(s => solidShapes(s, facesOf, water));
  const anyShapes = e => V.kids(e, 'solid').map(s => facesOf(s)).filter(f => f.length).map(brushShape);
  for (const s of V.kids(V.kids(root, 'world')[0] ?? { children: [] }, 'solid')) w.shapes.push(...solidShapes(s, facesOf, water));
  // Team of a respawn room: its TeamNum, else the team of an enabled spawn point inside it.
  const roomTeam = room => {
    if (team(V.get(room, 'TeamNum'))) return team(V.get(room, 'TeamNum'));
    const rs = anyShapes(room), sp = ents.find(e => cls(e) === 'info_player_teamspawn' && V.get(e, 'StartDisabled') !== '1' && team(V.get(e, 'TeamNum')) && rs.some(c => inside(c, V.nums(V.get(e, 'origin')))));
    return sp ? team(V.get(sp, 'TeamNum')) : 0;
  };
  const doors = new Map();
  for (const e of ents) {
    const c = cls(e), flags = +V.get(e, 'spawnflags') || 0;
    if (PROP.test(c) && V.get(e, 'solid') !== '0' && V.get(e, 'StartDisabled') !== '1') { const b = prop(e); if (b) w.shapes.push(boxShape(b)); }
    if (!SOLID.has(c)) continue;
    if (c === 'func_brush' && (V.get(e, 'Solidity') === '1' || (V.get(e, 'Solidity') !== '2' && V.get(e, 'StartDisabled') === '1'))) continue;
    if (c === 'func_wall_toggle' && flags & 1) continue;
    if (c.startsWith('func_door') && (flags & (1 | 4 | 8) || V.get(e, 'spawnpos') === '1')) continue; // starts open, non-solid to players, passable
    let only = 0;
    if (c === 'func_respawnroomvisualizer') {
      const room = named(V.get(e, 'respawnroomname')).find(r => cls(r) === 'func_respawnroom');
      if (V.get(e, 'solid_to_enemies') === '0' || !room || !(only = enemy(roomTeam(room)))) continue;
    }
    if (c === 'func_forcefield' && !(only = enemy(team(V.get(e, 'TeamNum'))))) continue;
    const ss = shapesOf(e), name = V.get(e, 'targetname');
    if (c.startsWith('func_door') && name) {
      const d = doors.get(name) ?? doors.set(name, { open: false, shapes: [], triggers: [], nodes: [] }).get(name);
      ss.forEach(s => { s.door = d; d.shapes.push(s); });
      d.nodes.push(...V.kids(e, 'solid'));
    }
    ss.forEach(s => { s.only = only; w.shapes.push(s); });
  }
  for (const e of ents) {
    if (!cls(e).startsWith('trigger_') || V.get(e, 'StartDisabled') === '1' || !((+V.get(e, 'spawnflags') || 0) & 1)) continue;
    const opens = outputs(e).filter(o => (o[2] || '').toLowerCase() === 'open' && doors.has(o[1])).map(o => doors.get(o[1]));
    if (!opens.length) continue;
    const f = named(V.get(e, 'filtername')).find(x => cls(x) === 'filter_activator_tfteam');
    const t = { shapes: anyShapes(e), team: f ? team(V.get(f, 'TeamNum')) : 0, negated: f ? V.get(f, 'Negated') === '1' : false };
    for (const d of new Set(opens)) d.triggers.push(t);
  }
  w.doors = [...doors.values()].filter(d => d.triggers.length);
  for (const s of w.shapes) for (let x = cell(s.min[0]); x <= cell(s.max[0]); x++) for (let y = cell(s.min[1]); y <= cell(s.max[1]); y++) {
    const k = x * 65536 + y;
    (w.cells.get(k) ?? w.cells.set(k, []).get(k)).push(s);
  }
  return w;
}
const CELL = 256, cell = x => Math.floor(x / CELL);

// Point o moved out by the box [mins, maxs]: inside every plane (touching counts).
function overlaps(c, o, mins, maxs) {
  const P = c.planes;
  for (let i = 0; i < P.length; i += 4) {
    const n0 = P[i], n1 = P[i + 1], n2 = P[i + 2];
    const dist = P[i + 3] - (n0 * (n0 > 0 ? mins[0] : maxs[0]) + n1 * (n1 > 0 ? mins[1] : maxs[1]) + n2 * (n2 > 0 ? mins[2] : maxs[2]));
    if (n0 * o[0] + n1 * o[1] + n2 * o[2] - dist > 0) return false;
  }
  return true;
}

// CM_ClipBoxToBrush: the box stops DIST_EPSILON short of the surface it enters.
function clip(c, s, e, mins, maxs, tr) {
  const P = c.planes;
  let enter = -1, leave = 1, at = -1, startout = false, getout = false;
  for (let i = 0; i < P.length; i += 4) {
    const n0 = P[i], n1 = P[i + 1], n2 = P[i + 2];
    const dist = P[i + 3] - (n0 * (n0 > 0 ? mins[0] : maxs[0]) + n1 * (n1 > 0 ? mins[1] : maxs[1]) + n2 * (n2 > 0 ? mins[2] : maxs[2]));
    const d1 = n0 * s[0] + n1 * s[1] + n2 * s[2] - dist, d2 = n0 * e[0] + n1 * e[1] + n2 * e[2] - dist;
    if (d2 > 0) getout = true;
    if (d1 > 0) startout = true;
    if (d1 > 0 && (d2 >= EPS - 1e-6 || d2 >= d1 - 1e-9)) return; // in front of this plane all the way (moving along it counts)
    if (d1 <= 0 && d2 <= 0) continue;
    if (d1 > d2) { const f = Math.max(0, (d1 - EPS) / (d1 - d2)); if (f > enter) { enter = f; at = i; } }
    else { const f = Math.min(1, (d1 + EPS) / (d1 - d2)); if (f < leave) leave = f; }
  }
  if (!startout) { // started inside: stuck only when it never gets out, else this shape lets it go
    tr.startsolid = true;
    if (!getout) { tr.allsolid = true; tr.fraction = 0; }
    return;
  }
  if (enter < leave && enter > -1 && enter < tr.fraction) { tr.fraction = enter; tr.normal = [P[at], P[at + 1], P[at + 2]]; }
}

// Sweeps the box [mins, maxs] at the origin from s to e: { fraction, end, normal (null: no hit), startsolid, allsolid }.
// team: the player's team (shapes for the other team only and open doors let it through).
export function trace(w, s, e, mins, maxs, team = 0) {
  const tr = { fraction: 1, end: e, normal: null, startsolid: false, allsolid: false };
  const lo = [0, 1, 2].map(k => Math.min(s[k], e[k]) + mins[k] - 1), hi = [0, 1, 2].map(k => Math.max(s[k], e[k]) + maxs[k] + 1), st = ++w.stamp;
  for (let x = cell(lo[0]); x <= cell(hi[0]); x++) for (let y = cell(lo[1]); y <= cell(hi[1]); y++) {
    for (const c of w.cells.get(x * 65536 + y) ?? []) {
      if (c.seen === st) continue;
      c.seen = st;
      if ((c.only && c.only !== team) || c.door?.open) continue;
      if (c.min[0] > hi[0] || c.max[0] < lo[0] || c.min[1] > hi[1] || c.max[1] < lo[1] || c.min[2] > hi[2] || c.max[2] < lo[2]) continue;
      clip(c, s, e, mins, maxs, tr);
      if (tr.allsolid) break;
    }
  }
  if (tr.fraction < 1) tr.end = s.map((x, k) => x + (e[k] - x) * tr.fraction);
  return tr;
}

// ---------- the player ----------
// o: origin (feet), v: velocity, ground: the ground normal or null, ducked (FL_DUCKING), ducking (in a duck or unduck
// transition, duckT seconds into it), duckWait: seconds before crouching again on the ground, eye: view height above o,
// dashes / airDucks: Scout air dashes and crouches let go of this airtime, friction: surface friction (0.25 on too-steep ground going up).
export function newPlayer(cls, teamNum, origin) {
  return { cls, team: teamNum, o: [...origin], v: [0, 0, 0], ground: null, ducked: false, ducking: false, duckT: 0, duckWait: 0, eye: CLASSES[cls].eye, oldJump: false, oldDuck: false, dashes: 0, airDucks: 0, friction: 1 };
}
export const hullMax = p => (p.ducked ? DUCKED : STAND);
const tr = (w, p, s, e, maxs = hullMax(p)) => trace(w, s, e, MINS, maxs, p.team);
export function setClass(p, cls) { p.cls = cls; if (!p.ducking) p.eye = p.ducked ? DUCK_EYE : CLASSES[cls].eye; }

// CheckStuck, simpler: moves p out of anything it starts in, to the nearest free spot up, sideways or down within 64
// units (up first). False when there is none.
const NUDGE = [[0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, -1]];
export function unstick(w, p) {
  for (const d of [0, 1, 2, 4, 8, 16, 32, 64]) for (const n of NUDGE) {
    const o = p.o.map((x, k) => x + n[k] * d);
    if (!tr(w, p, o, o).startsolid) { p.o = o; return true; }
  }
  return false;
}

// Enabled info_player_teamspawn of the team (unassigned ones too): [{ origin, yaw }] in map order.
export const spawnPoints = (root, t) => V.kids(root, 'entity')
  .filter(e => V.get(e, 'classname') === 'info_player_teamspawn' && V.get(e, 'StartDisabled') !== '1' && [0, t].includes(team(V.get(e, 'TeamNum'))))
  .map(e => ({ origin: V.nums(V.get(e, 'origin')), yaw: V.nums(V.get(e, 'angles') ?? '0 0 0')[1] || 0 }))
  .filter(s => s.origin.length === 3);

// Doors a team trigger opens are open while p touches one; one never closes on the player.
function doors(w, p) {
  const m = hullMax(p);
  for (const d of w.doors) {
    const was = d.open;
    d.open = d.triggers.some(t => (!t.team || (p.team === t.team) !== t.negated) && t.shapes.some(c => overlaps(c, p.o, MINS, m)));
    if (was && !d.open && d.shapes.some(c => overlaps(c, p.o, MINS, m))) d.open = true;
  }
}

const spline = x => x * x * (3 - 2 * x); // SimpleSpline
const setGround = (p, n) => {
  if (n && !p.ground) { p.dashes = 0; p.airDucks = 0; }
  p.ground = n;
  if (n) p.v[2] = 0;
};
const checkVel = p => { p.v = p.v.map(x => (Number.isFinite(x) ? Math.max(-MAXVEL, Math.min(MAXVEL, x)) : 0)); };
const gravity = p => { p.v[2] -= GRAVITY * 0.5 * TICK; };

// CTFGameMovement::CategorizePosition: on ground within 2 units below (plus a step while grounded, snapping down to
// it, so the player follows stairs and slopes down) on a surface with normal z >= 0.7; a steep one is retested as four
// quarter boxes (TracePlayerBBoxForGround).
function categorize(w, p) {
  p.friction = 1;
  if (p.v[2] > 250) return setGround(p, null);
  const m = hullMax(p), snap = !!p.ground, end = [p.o[0], p.o[1], p.o[2] - 2 - (snap ? STEP : 0)], t = tr(w, p, p.o, end);
  if (t.normal && t.normal[2] >= WALKABLE) {
    if (snap && !t.startsolid && t.fraction > 0 && t.fraction < 1 && Math.abs(p.o[2] - t.end[2]) > 1 / 64) p.o = [p.o[0], p.o[1], t.end[2]];
    return setGround(p, t.normal);
  }
  let n = null;
  for (const [a, b] of [[MINS, [0, 0, m[2]]], [[0, 0, 0], m], [[MINS[0], 0, 0], [0, m[1], m[2]]], [[0, MINS[1], 0], [m[0], 0, m[2]]]]) {
    n = trace(w, p.o, end, a, b, p.team).normal;
    if (n && n[2] >= WALKABLE) return setGround(p, n);
  }
  setGround(p, null);
  if (p.v[2] > 0) p.friction = 0.25;
}

function finishDuck(w, p) {
  if (p.ducked) return;
  p.ducked = true;
  p.ducking = false;
  p.eye = DUCK_EYE;
  if (!p.ground) p.o = [p.o[0], p.o[1], p.o[2] + DUCK_SHIFT]; // in the air the feet come up, the head stays
  categorize(w, p);
}
function finishUnduck(w, p) {
  if (!p.ground) p.o = [p.o[0], p.o[1], p.o[2] - DUCK_SHIFT];
  p.ducked = p.ducking = false;
  p.eye = CLASSES[p.cls].eye;
  p.duckT = 0;
  categorize(w, p);
}
// Room to stand up: the standing hull swept to where unducking puts the origin.
function canUnduck(w, p) {
  const to = p.ground ? p.o : [p.o[0], p.o[1], p.o[2] - DUCK_SHIFT], t = tr(w, p, p.o, to, STAND);
  return !t.startsolid && t.fraction === 1;
}
const duckEye = (p, f) => DUCK_EYE * f + CLASSES[p.cls].eye * (1 - f); // SetDuckedEyeOffset

// CTFGameMovement::Duck with TIME_TO_DUCK / TIME_TO_UNDUCK 0.2. DuckOverrides ignores the key on the ground for
// TF_TIME_TO_DUCK 0.3 s after letting go, while standing up from a crouch (the quantum crouch fix) and after 2 crouches
// let go of in the air (tf_clamp_airducks); held, it counts as a new press once it is no longer ignored.
function duck(w, p, cmd) {
  const air = !p.ground;
  if ((!air && p.duckWait > 0) || (p.ducked && p.ducking) || (air && p.airDucks >= AIRDUCKS)) cmd.duck = false;
  const pressed = cmd.duck && !p.oldDuck, released = !cmd.duck && p.oldDuck;
  p.oldDuck = cmd.duck;
  if (p.ducked && !air) { cmd.f *= 0.33333333; cmd.s *= 0.33333333; } // HandleDuckingSpeedCrop
  if (!cmd.duck && !p.ducking && !p.ducked) return;
  if (cmd.duck) {
    if (pressed && !p.ducked) { p.duckT = 0; p.ducking = true; }
    if (p.ducking) {
      if (p.duckT > DUCK_TIME || p.ducked || air) finishDuck(w, p);
      else p.eye = duckEye(p, spline(p.duckT / DUCK_TIME));
    }
    return;
  }
  if (released) { // OnUnDuck
    p.duckWait = DUCK_WAIT;
    if (air) p.airDucks++;
    if (p.ducked) p.duckT = 0;
    else if (p.ducking) p.duckT = DUCK_TIME - p.duckT; // let go before fully down: unduck from where it got to
  }
  if (canUnduck(w, p)) {
    if (p.duckT > DUCK_TIME || air) finishUnduck(w, p);
    else { p.eye = duckEye(p, spline(1 - p.duckT / DUCK_TIME)); p.ducking = true; }
  } else if (p.duckT) { // no room: stay fully ducked until there is
    p.eye = DUCK_EYE;
    p.duckT = 0;
    p.ducked = true;
    p.ducking = false;
  }
}

const fwd = cmd => [Math.cos(cmd.yaw * Math.PI / 180), Math.sin(cmd.yaw * Math.PI / 180), 0];
const right = cmd => [Math.sin(cmd.yaw * Math.PI / 180), -Math.cos(cmd.yaw * Math.PI / 180), 0];
const wish = cmd => { const f = fwd(cmd), r = right(cmd); return [f[0] * cmd.f + r[0] * cmd.s, f[1] * cmd.f + r[1] * cmd.s, 0]; };

// CTFGameMovement::CheckJumpButton: no jump while fully ducked on the ground or unducking, none until the key is let
// go; a jump during the duck-down transition sets vz instead of adding to it. A Scout jumps once more in the air.
function jump(w, p, cmd) {
  const scout = p.cls === 0, ground = !!p.ground;
  if ((p.ducked && (!scout || ground)) || (p.ducking && p.ducked) || p.oldJump) return;
  if (!ground) {
    if (scout && p.dashes < 1) { // AirDash: velocity replaced by the keys' direction at up to full speed
      p.v = wish(cmd);
      p.v[2] = DASH;
      p.dashes++;
      p.airDucks = 0;
    } else p.oldJump = true;
    return;
  }
  const sp = Math.hypot(...p.v), cap = BUNNY * CLASSES[p.cls].speed; // PreventBunnyJumping
  if (sp > cap) p.v = p.v.map(x => x * (cap / sp));
  p.ground = null;
  p.v[2] = p.ducking || p.ducked ? JUMP : p.v[2] + JUMP;
  gravity(p);
  p.oldJump = true;
}

function friction(p) {
  const sp = Math.hypot(...p.v);
  if (sp < 0.1) return;
  const k = Math.max(sp - Math.max(sp, STOPSPEED) * FRICTION * p.friction * TICK, 0) / sp;
  p.v = p.v.map(x => x * k);
}
function accelerate(p, dir, speed, accel, cap = speed) {
  const add = Math.min(speed, cap) - dot(p.v, dir);
  if (add <= 0) return;
  const a = Math.min(accel * TICK * speed * p.friction, add);
  p.v = p.v.map((x, k) => x + a * dir[k]);
}

// ClipVelocity: v without its part into the plane n.
function clipVel(v, n) {
  const b = dot(v, n), out = v.map((x, k) => x - n[k] * b), adj = dot(out, n);
  return adj < 0 ? out.map((x, k) => x - n[k] * adj) : out;
}

// CGameMovement::TryPlayerMove: slide along up to 4 surfaces this tick.
function tryMove(w, p) {
  const primal = [...p.v], planes = [];
  let orig = [...p.v], left = TICK, all = 0;
  for (let bump = 0; bump < 4; bump++) {
    if (!p.v[0] && !p.v[1] && !p.v[2]) break;
    const t = tr(w, p, p.o, p.o.map((x, k) => x + p.v[k] * left));
    all += t.fraction;
    if (t.allsolid) { p.v = [0, 0, 0]; return; }
    if (t.fraction > 0) {
      if (t.fraction === 1 && tr(w, p, t.end, t.end).startsolid) { p.v = [0, 0, 0]; break; } // would end stuck
      p.o = t.end;
      orig = [...p.v];
      planes.length = 0;
    }
    if (t.fraction === 1) break;
    left -= left * t.fraction;
    if (planes.length >= 5) { p.v = [0, 0, 0]; break; }
    planes.push(t.normal);
    if (planes.length === 1 && !p.ground) { p.v = orig = clipVel(orig, planes[0]); continue; }
    let i = 0;
    for (; i < planes.length; i++) {
      p.v = clipVel(orig, planes[i]);
      if (planes.every((q, j) => j === i || dot(p.v, q) >= 0)) break;
    }
    if (i === planes.length) { // along the crease of two planes, or stop in a corner
      if (planes.length !== 2) { p.v = [0, 0, 0]; break; }
      const c = cross(planes[0], planes[1]), l = Math.hypot(...c), d = l ? dot(c, p.v) / l : 0;
      p.v = l ? c.map(x => (x / l) * d) : [0, 0, 0];
    }
    if (dot(p.v, primal) <= 0) { p.v = [0, 0, 0]; break; }
  }
  if (!all) p.v = [0, 0, 0];
}

// CGameMovement::StepMove: the slide as it is, or up a step, slide, down a step, whichever goes farther.
function stepMove(w, p) {
  const pos = p.o, vel = [...p.v];
  tryMove(w, p);
  const downPos = p.o, downVel = p.v;
  p.o = pos;
  p.v = [...vel];
  let t = tr(w, p, p.o, [p.o[0], p.o[1], p.o[2] + STEP + EPS]);
  if (!t.startsolid) p.o = t.end;
  tryMove(w, p);
  t = tr(w, p, p.o, [p.o[0], p.o[1], p.o[2] - STEP - EPS]);
  if (!t.normal || t.normal[2] < WALKABLE) { p.o = downPos; p.v = downVel; return; }
  if (!t.startsolid) p.o = t.end;
  const d2 = q => (q[0] - pos[0]) ** 2 + (q[1] - pos[1]) ** 2;
  if (d2(downPos) > d2(p.o)) { p.o = downPos; p.v = downVel; } else p.v[2] = downVel[2];
}

// CTFGameMovement::WalkMove: accelerate, clamp to max speed, backwards to 0.9 of it, then move (or step).
function walkMove(w, p, cmd) {
  const wv = wish(cmd), l = Math.hypot(wv[0], wv[1]), dir = l ? [wv[0] / l, wv[1] / l, 0] : [0, 0, 0], f = fwd(cmd), r = right(cmd);
  p.v[2] = 0;
  accelerate(p, dir, Math.min(l, cmd.max), ACCEL);
  const cap = () => { const s = Math.hypot(p.v[0], p.v[1]); if (s > cmd.max) p.v = [p.v[0] * cmd.max / s, p.v[1] * cmd.max / s, 0]; };
  cap();
  const back = dot(f, p.v);
  if (Math.hypot(...p.v) > BACK_MIN && back < 0) {
    const bs = Math.min(-back, cmd.max * BACK), side = dot(r, p.v);
    p.v = [-f[0] * bs + r[0] * side, -f[1] * bs + r[1] * side, 0];
    cap();
  }
  if (Math.hypot(...p.v) < 1) { p.v = [0, 0, 0]; return; }
  const t = tr(w, p, p.o, [p.o[0] + p.v[0] * TICK, p.o[1] + p.v[1] * TICK, p.o[2]]);
  if (t.fraction === 1) p.o = t.end;
  else stepMove(w, p);
}

function airMove(w, p, cmd) {
  const wv = wish(cmd), l = Math.hypot(wv[0], wv[1]);
  if (l) accelerate(p, [wv[0] / l, wv[1] / l, 0], Math.min(l, cmd.max), AIRACCEL, AIRCAP); // AirAccelerate: capped at 30
  tryMove(w, p);
}

// One 15 ms tick (CTFGameMovement::ProcessMovement / PlayerMove / FullWalkMove). input: { fwd, side (-1..1, right +),
// jump, duck, walk (bools), yaw (degrees) }.
export function tick(w, p, input) {
  doors(w, p);
  if (tr(w, p, p.o, p.o).startsolid && !unstick(w, p)) return; // CheckStuck: inside a brush (an edit while playing)
  const max = CLASSES[p.cls].speed, k = CMDSPEED * (input.walk ? WALK : 1);
  const cmd = { f: k * (input.fwd || 0), s: k * (input.side || 0), jump: !!input.jump, duck: !!input.duck, yaw: input.yaw || 0, max };
  const sp = Math.hypot(cmd.f, cmd.s);
  if (sp > max) { cmd.f *= max / sp; cmd.s *= max / sp; } // CheckParameters: diagonals are no faster
  p.duckT = Math.min(p.duckT + TICK, 1); // ReduceTimers
  p.duckWait = Math.max(p.duckWait - TICK, 0);
  if (p.v[2] > 250) setGround(p, null);
  duck(w, p, cmd);
  gravity(p); // StartGravity
  checkVel(p);
  if (cmd.jump) jump(w, p, cmd); else p.oldJump = false;
  if (p.ground) { p.v[2] = 0; friction(p); }
  checkVel(p);
  if (p.ground) walkMove(w, p, cmd); else airMove(w, p, cmd);
  categorize(w, p);
  checkVel(p);
  gravity(p); // FinishGravity
  if (p.ground) p.v[2] = 0;
}
