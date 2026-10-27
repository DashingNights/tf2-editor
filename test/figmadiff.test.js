// node --test "test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false } };
const V = await import('../vmf.js');
const { readSvg } = await import('../src/svgread.js');
const { importLayout } = await import('../src/figmaimport.js');
const D = await import('../src/figmadiff.js');
const st = await import('../src/state.js');
const F = await import('../src/figmaui.js');
const { area, ccw, clipConvex } = await import('../src/poly2d.js');

let id = 0;
const next = () => String(++id);
const run = (body, opts = {}) => importLayout(readSvg(`<svg fill="none">${body}</svg>`), { gameplay: false, ...opts }, next);
const rect = (name, x, y, w, h) => `<path id="${name}" d="M${x} ${y}H${x + w}V${y + h}H${x}Z" fill="#808080"/>`;
const line = (name, d) => `<path id="${name}" d="${d}" stroke="#3D5288" stroke-width="19"/>`;
const units = r => new Map([...r.solids.map(s => [s.key, s.solid]), ...r.entities.map(e => [e.key, e.entity])]);

test('keys come from the layer path: other layers, Figma renumbering and the drawing growing change none', () => {
  const a = `<g id="Room z0">${rect('floor', 0, 0, 512, 256)}${line('walls', 'M0 0H512V256')}</g>`;
  const b = `<g id="Hall z64">${rect('floor_2', 0, 512, 256, 256)}</g>`;
  const r1 = run(a + b), k1 = units(r1);
  assert.ok([...k1.keys()].includes('Room/floor#0'));
  assert.ok([...k1.keys()].some(k => /^Room\/walls\.0\.\d#\d$/.test(k)));
  assert.equal(new Set(k1.keys()).size, k1.size, 'unique');
  // a new layer before the others takes Figma's plain names, the old ones get renumbered (floor_2 -> floor_3), and the
  // drawing grows; with the first import's offset kept, every old key gives the same piece
  const c = `<g id="Yard z0">${rect('floor', 2048, 2048, 256, 256)}</g>`;
  const r2 = run(c + a.replace('id="floor"', 'id="floor_2"') + b.replace('floor_2', 'floor_3'), { offset: r1.offset, base: r1.base }), k2 = units(r2);
  for (const [k, n] of k1) assert.equal(D.hashNode(k2.get(k)), D.hashNode(n), k);
  assert.ok([...k2.keys()].includes('Yard/floor#0'));
  // two shapes on one path (no ids of their own): the second is numbered
  assert.deepEqual([...units(run('<g id="Room z0"><path d="M0 0H64V64H0Z" fill="#808080"/><path d="M128 0H192V64H128Z" fill="#808080"/></g>')).keys()].sort(), ['Room#0', 'Room[2]#0']);
  // mirrored pieces have their own keys
  const m = units(run(`<g id="Half mirror-left"><g id="Zone z0">${rect('floor', 0, 0, 128, 128)}</g></g>`));
  assert.deepEqual([...m.keys()].sort(), ['Half mirror-left/Zone/floor (mirror)#0', 'Half mirror-left/Zone/floor#0']);
  assert.equal(D.layerOf('Half mirror-left/Zone/walls (mirror).0.2#1'), 'walls (mirror)');
  assert.equal(D.layerOf('flight A/Zone/stairs.0.0 to A/Zone/landing.1.0#3'), 'stairs');
});

test('a new height (z, h) keeps the keys: the pieces show as changes, not removals and additions', () => {
  const hashes = r => new Map([...units(r)].map(([k, n]) => [k, { h: D.hashNode(n), id: k }]));
  const a = `<g id="Room z0">${rect('floor', 0, 0, 512, 256)}${line('walls h32', 'M0 0H512V256')}${line('walls', 'M0 256H512')}</g>`;
  const r1 = run(a), r2 = run(a.replace('walls h32', 'walls h48'), { offset: r1.offset, base: r1.base }), r3 = run(a.replace('Room z0', 'Room z16'), { offset: r1.offset, base: r1.base });
  for (const r of [r2, r3]) {
    const t = hashes(r), rows = D.classify(hashes(r1), t, b => b.h);
    assert.deepEqual([...t.keys()].sort(), [...hashes(r1).keys()].sort());
    assert.deepEqual([...new Set(rows.map(x => x.type))].sort(), r === r2 ? ['change', 'same'] : ['change']);
  }
  assert.ok([...units(r1).keys()].some(k => k.startsWith('Room/walls[2].')), 'two walls layers on one path: the second is numbered');
});

test('gameplay entities are keyed by area and class', () => {
  const r = run(`<g id="Spawn z0">${rect('floor', 0, 0, 512, 512)}${line('walls', 'M0 0H512V512H0Z')}</g><g id="CP z0">${rect('floor', 1024, 0, 256, 256)}</g>`, { gameplay: true });
  const keys = r.entities.map(e => e.key);
  assert.ok(keys.includes('Spawn/func_respawnroom#0'));
  assert.ok(keys.includes('Spawn/info_player_teamspawn#0'));
  assert.ok(keys.includes('Sky/light_environment#0'));
  assert.ok(r.solids.some(s => s.key === 'sky#5'));
  assert.equal(new Set([...keys, ...r.solids.map(s => s.key)]).size, keys.length + r.solids.length);
});

test('hashes: geometry, materials and keyvalues count; ids, editor blocks and texture axes do not', () => {
  const a = V.block([0, 0, 0], [64, 64, 64], 'DEV/A', next), h = D.hashNode(a);
  assert.equal(D.hashNode(V.clone(a, next)), h, 'new ids');
  const b = V.clone(a, next);
  V.kids(b, 'editor')[0].kv.push(['visgroupid', '7']);
  V.set(V.kids(b, 'side')[0], 'uaxis', '[0 1 0 32] 0.5');
  assert.equal(D.hashNode(b), h);
  V.set(V.kids(b, 'side')[0], 'material', 'DEV/B');
  assert.notEqual(D.hashNode(b), h, 'a texture applied');
  assert.equal(D.shapeHash(b), D.shapeHash(a), 'the same shape');
  const c = V.clone(a, next);
  V.transform(c, [1, 1, 1], [16, 0, 0]);
  assert.notEqual(D.hashNode(c), h);
  const e = V.entity('info_target', [0, 0, 0.001], next), f = V.entity('info_target', [0, 0, 0], next);
  assert.equal(D.hashNode(e), D.hashNode(f), 'rounded');
  f.kv.push(['targetname', 'x']);
  assert.notEqual(D.hashNode(e), D.hashNode(f));
});

test('classify: unchanged, incoming, conflict, added, removed, gone; renamed layers are no change', () => {
  const B = o => new Map(Object.entries(o).map(([k, h]) => [k, { h, id: 'id' + k }]));
  const T = o => new Map(Object.entries(o).map(([k, h]) => [k, { h }]));
  const ours = { same: 'a', local: 'X', change: 'c', conflict: 'Y', remove: 'e', editedGone: 'Z', old: 'g', both: 'M' };
  const base = B({ same: 'a', local: 'b', change: 'c', conflict: 'd', remove: 'e', editedGone: 'f', deleted: 'k', old: 'g', gone: 'h', both: 'm' });
  const theirs = T({ same: 'a', local: 'b', change: 'C', conflict: 'D', deleted: 'K', fresh: 'n', renamed: 'g', both: 'M' });
  const rows = D.classify(base, theirs, b => ours[b.id.slice(2)] ?? null), type = Object.fromEntries(rows.map(r => [r.key, r.type]));
  assert.deepEqual(type, { same: 'same', local: 'same', change: 'change', conflict: 'conflict', deleted: 'conflict', fresh: 'add', renamed: 'same', both: 'same', remove: 'remove', editedGone: 'conflict', gone: 'gone' });
  assert.equal(rows.find(r => r.key === 'renamed').bk, 'old');
  assert.equal(rows.find(r => r.key === 'local').ours, 'X');
});

test('adopt matching: the same shape first, then box overlap with the import\'s own objects', () => {
  const g1 = V.block([0, 0, 0], [256, 256, 16], 'DEV/A', next), g2 = V.block([512, 0, 0], [768, 256, 16], 'DEV/A', next), g3 = V.block([0, 1024, 0], [64, 1088, 64], 'DEV/A', next);
  const m1 = V.clone(g1, next), m2 = V.clone(g2, next), hand = V.block([0, 1024, 0], [64, 1088, 64], 'DEV/H', next);
  V.transform(m2, [1, 1, 1], [16, 0, 0]); // a hand edit
  const pt = V.entity('info_target', [0, 0, 0], next), mp = V.entity('info_target', [8, 0, 0], next);
  const m = D.match([{ key: 'a', node: g1 }, { key: 'b', node: g2 }, { key: 'c', node: g3 }, { key: 'p', node: pt }], [m1, m2, hand, mp], [m1, m2, mp]);
  assert.equal(m.get('a'), m1);
  assert.equal(m.get('b'), m2);
  assert.equal(m.get('c'), hand, 'the same shape anywhere (another material: a local edit)');
  assert.equal(m.get('p'), mp);
  assert.equal(D.match([{ key: 'c', node: V.block([0, 2048, 0], [64, 2112, 64], 'DEV/A', next) }], [hand], []).size, 0, 'no overlap match outside the import');
});

test('an object whose pieces are cut otherwise now, one of them edited here, is one choice: kept whole by default, no hole', () => {
  // an L floor; the map's base cut it the other way at its inner corner (as an older importer might), and one of
  // those pieces was retextured here
  const svg = `<svg fill="none"><g id="Room z0"><path id="floor" d="M0 0H512V256H256V512H0Z" fill="#808080"/></g></svg>`;
  const r = importLayout(readSvg(svg), {}, next), floor = r.solids.filter(s => s.obj === 'Room/floor'), [z0, z1] = [Math.min, Math.max].map(m => m(...V.faces(floor[0].solid).flatMap(f => f.pts.map(p => p[2]))));
  const across = floor.some(s => V.boundsOf(s.solid)[1][0] - V.boundsOf(s.solid)[0][0] > 400); // (this importer's cut runs across)
  const old = (across ? [[-256, -256, 0, 256], [0, 0, 256, 256]] : [[-256, 0, 256, 256], [-256, -256, 0, 0]]).map((b, k) => ({ key: `Room/floor#${k}`, solid: V.block([b[0], b[1], z0], [b[2], b[3], z1], 'DEV/REFLECTIVITY_90', next), area: 'Room', kind: 'floor' }));
  const units = [...r.solids.filter(s => s.obj !== 'Room/floor').map(s => ({ ...s, node: s.solid })), ...old.map(o => ({ ...o, node: o.solid })), ...r.entities.map(e => ({ ...e, node: e.entity }))];
  const root = V.parse(st.EMPTY);
  V.kids(root, 'world')[0].children.push(...units.filter(u => u.node.name === 'solid').map(u => u.node));
  root.children.push(...units.filter(u => u.node.name === 'entity').map(u => u.node));
  st.load(V.serialize(root), null);
  st.extra.kv = [['figma', { svg: 'l.svg', offset: r.offset, zbase: r.base, keys: Object.fromEntries(units.map(u => [u.key, [D.hashNode(u.node), (u.node.name === 'solid' ? 's' : 'e') + V.get(u.node, 'id'), u.area, u.kind]])) }]];
  const byId = id => [...st.cache.values()].map(c => c.node).find(n => n.name === 'solid' && V.get(n, 'id') === id);
  for (const sd of V.kids(byId(V.get(old[1].solid, 'id')), 'side')) V.set(sd, 'material', 'DEV/DEV_MEASUREGENERIC01');
  const d = F.diff(svg, 'l.svg'), rows = d.rows.filter(x => /^Room\/floor#/.test(x.key));
  assert.deepEqual(rows.map(x => x.type).sort(), ['change', 'conflict']);
  assert.ok(rows.every(x => x.unit === 'Room/floor' && !x.accept), 'one choice, rejected by default (edited here)');
  assert.ok(d.rows.filter(x => !rows.includes(x)).every(x => x.type === 'same'));
  // the map's floor at the end: the old pieces both, none of the new ones; the L whole, nothing over another
  const covered = () => {
    const tops = [...st.cache.values()].map(c => c.node).filter(n => n.name === 'solid').map(n => V.faces(n).find(f => f.n[2] > 0.99)).filter(f => f && Math.abs(f.pts[0][2] - z1) < 0.5).map(f => ccw(f.pts.map(p => [p[0], p[1]])));
    return { area: tops.reduce((a, q) => a + area(q), 0), overlap: tops.some((a, i) => tops.slice(i + 1).some(b => Math.abs(area(clipConvex(a, b))) > 0.5)) };
  };
  F.apply(d);
  assert.deepEqual(covered(), { area: 512 * 256 + 256 * 256, overlap: false });
  assert.ok(byId(V.get(old[0].solid, 'id')) && byId(V.get(old[1].solid, 'id')));
  // accepted, it is replaced whole
  st.undo();
  const d2 = F.diff(svg, 'l.svg');
  for (const x of d2.rows) if (x.unit === 'Room/floor') x.accept = true;
  F.apply(d2);
  assert.deepEqual(covered(), { area: 512 * 256 + 256 * 256, overlap: false });
  assert.ok(!byId(V.get(old[0].solid, 'id')) && !byId(V.get(old[1].solid, 'id')));
});
