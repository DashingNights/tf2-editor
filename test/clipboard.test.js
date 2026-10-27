// node --test "test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { api: { settingsPath: '', read: async () => null, write: async () => {}, exists: async () => false } };
const st = await import('../src/state.js');
const V = await import('../vmf.js');
const O = await import('../src/outliner.js');
const C = await import('../src/clipboard.js');

const ids = n => { const out = []; (function walk(x) { for (const [k, v] of x.kv) if (k === 'id') out.push(v); x.children.forEach(walk); })(n); return out; };
const planes = n => V.kids(n, 'side').map(s => V.get(s, 'plane'));

test('snippet round trip: same objects back, visgroups mapped by name, new ids, unknown visgroups dropped', () => {
  let id = 0;
  const nid = () => String(++id), b = V.block([0, 0, 0], [64, 64, 64], 'DEV/A', nid), e = V.entity('info_target', [8, 8, 8], nid);
  const ed = V.kids(b, 'editor')[0];
  ed.kv.splice(1, 0, ['groupid', '40'], ['visgroupid', '7'], ['visgroupid', '8']);
  const text = C.snippet([b, e], [{ id: '7', name: 'Walls', color: '1 2 3' }, { id: '8', name: 'Gone', color: '4 5 6' }]);
  assert.match(text, /^versioninfo\r\n\{\r\n(.*\r\n)*\t"prefab" "0"\r\n\}\r\nvisgroups\r\n\{\r\n\tvisgroup\r\n\t\{\r\n\t\t"name" "Walls"\r\n\t\t"visgroupid" "7"/);
  assert.match(C.snippet([b], [], true), /"prefab" "1"/);
  const d = C.readSnippet(text);
  assert.deepEqual(d.objs.map(o => V.serialize({ kv: [], children: [o] })), [b, e].map(o => V.serialize({ kv: [], children: [o] })));
  assert.deepEqual([...d.names], [['7', 'Walls'], ['8', 'Gone']]);

  const out = C.prepare(d.objs, d.names, new Map([['Walls', '3']]), () => String(++id), '#2');
  assert.deepEqual(V.kids(out[0], 'editor')[0].kv.slice(0, 3), [['color', V.get(ed, 'color')], ['groupid', '40#2'], ['visgroupid', '3']]);
  assert.equal(V.kids(out[0], 'editor')[0].kv.filter(p => p[0] === 'visgroupid').length, 1, 'Gone has no visgroup here');
  assert.deepEqual(planes(out[0]), planes(b), 'geometry unchanged');
  const old = new Set([...ids(b), ...ids(e)]);
  assert(ids({ kv: [], children: out }).every(x => !old.has(x)), 'every id new');
  assert.deepEqual(C.boundsOf(out), [[0, 0, 0], [64, 64, 64]]);
  assert.equal(C.readSnippet('hello'), null);
  assert.equal(C.readSnippet('world\n{\n}\n'), null, 'no objects');
});

test('latin1 bytes: high latin1 chars stay one byte, others become UTF-8', () => {
  assert.deepEqual([...C.latin1('a\xe9€')], [0x61, 0xe9, 0xe2, 0x82, 0xac]);
});

test('copy and paste in place in one map: new ids, same visgroup, a new group, one undo step', () => {
  st.load(st.EMPTY, null);
  const a = st.createBlock([0, 0, 0], [64, 64, 64]), b = st.createBlock([128, 0, 0], [192, 64, 64]);
  st.setSelection([a, b]);
  const vg = O.createVisgroup('Walls');
  const gid = st.groupSel();
  const before = st.serialize(), { text, count } = C.copyText();
  assert.equal(count, 2);
  assert(C.pasteText(text));
  const pasted = [...st.sel];
  assert.equal(pasted.length, 2);
  assert(pasted.every(n => n !== a && n !== b && st.cache.has(n)));
  assert.deepEqual(pasted.map(planes), [a, b].map(planes), 'in place');
  assert(pasted.every(n => O.vgIds(st.groupOf(n)).includes(vg) && !O.vgIds(n).length), 'same visgroup, on the new group block (Hammer)');
  const g2 = V.get(V.kids(pasted[0], 'editor')[0], 'groupid');
  assert(g2 && g2 !== gid && st.groups().get(g2).length === 2, 'the copies form their own group');
  const all = ids(st.doc.root);
  assert.equal(new Set(all).size, all.length, 'ids unique in the map');
  st.undo();
  assert.equal(st.serialize(), before);
});

test('a pasted overlay names the pasted faces, and keeps faces that were not copied', () => {
  let id = 0;
  const nid = () => String(++id), b = V.block([0, 0, 0], [256, 256, 64], 'DEV/A', nid), top = V.kids(b, 'side').find(s => V.plane(s).n[2] > 0.9);
  const ov = V.entity('info_overlay', [128, 128, 64], nid);
  ov.kv.push(['sides', `${V.get(top, 'id')} 777`]);
  const d = C.readSnippet(C.snippet([b, ov])), [pb, po] = C.prepare(d.objs, d.names, new Map(), () => String(1000 + ++id));
  assert.equal(V.get(po, 'sides'), `${V.get(V.kids(pb, 'side').find(s => V.plane(s).n[2] > 0.9), 'id')} 777`);
});
