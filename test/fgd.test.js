// node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as F from '../src/fgd.js';

const SAMPLE = `
@include "base.fgd"
@mapsize(-16384, 16384)
@MaterialExclusion [ "debug" "hud" ]
@AutoVisGroup = "Tool Brushes" [ "Vis" [ "func_viscluster" ] ]

// a comment with "quotes" and [brackets]
@BaseClass = Targetname
[
	targetname(target_source) : "Name" : : "The name " +
		"others use.\\nSecond line."
	input Kill(void) : "Removes this entity."
	output OnUser1(void) : "Fired by FireUser1."
]
@BaseClass base(Targetname) color(0 255 0) size(-8 -8 0, 8 8 16) = Thing
[
	nodeid(integer) readonly : "Node ID"
	team(choices) : "Team" : 2 : "Which team." =
	[
		0 : "Any"
		2 : "Red"
		-1 : "None"
	]
	spawnflags(flags) =
	[
		1 : "Scout" : 1
		256 : "Engineer" : 0
	]
]
@PointClass base(Thing) studio("models/x.mdl") sphere(r) = my_spawn : "Spawn point." [ targetname(string) : "Renamed" input Trigger(void) : "Go." ]
@SolidClass = my_brush []
`;

test('parse: keys, choices, flags, helpers, inheritance', () => {
  const map = F.parse(SAMPLE);
  assert.deepEqual([...map.keys()], ['Targetname', 'Thing', 'my_spawn', 'my_brush']);
  const tn = map.get('Targetname').keys[0];
  assert.equal(tn.default, '');
  assert.equal(tn.description, 'The name others use.\nSecond line.');
  const thing = map.get('Thing');
  assert.deepEqual(thing.color, [0, 255, 0]);
  assert.deepEqual(thing.size, [[-8, -8, 0], [8, 8, 16]]);
  assert.equal(thing.keys[0].readonly, true);
  assert.deepEqual(thing.keys[1].choices.map(c => c.value), ['0', '2', '-1']);
  assert.equal(thing.keys[1].default, '2');
  assert.deepEqual(thing.keys[2].flags, [{ bit: 1, label: 'Scout', default: true }, { bit: 256, label: 'Engineer', default: false }]);

  const s = F.resolve(map, 'my_spawn');
  assert.equal(s.type, 'PointClass');
  assert.equal(s.description, 'Spawn point.');
  assert.deepEqual(s.helpers, [{ name: 'color', args: ['0 255 0'] }, { name: 'size', args: ['-8 -8 0', '8 8 16'] }, { name: 'studio', args: ['models/x.mdl'] }, { name: 'sphere', args: ['r'] }], 'base helpers first');
  assert.deepEqual(s.keys.map(k => k.name), ['targetname', 'nodeid', 'team', 'spawnflags']);
  assert.equal(s.keys[0].displayName, 'Renamed', 'own key overrides the base one');
  assert.deepEqual(s.inputs.map(x => x.name), ['Kill', 'Trigger']);
  assert.deepEqual(s.outputs.map(x => x.name), ['OnUser1']);
  assert.deepEqual(s.color, [0, 255, 0], 'helpers inherit');
  assert.equal(F.resolve(map, 'nope'), null);
});

test('every helper keeps its name and arguments, bare words included', () => {
  const c = F.parse('@PointClass origin(origin) axis(axis) vecline(target) obb() halfgridsnap wirebox(mins, maxs) = h []').get('h');
  assert.deepEqual(c.helpers.map(x => [x.name, ...x.args]), [['origin', 'origin'], ['axis', 'axis'], ['vecline', 'target'], ['obb'], ['halfgridsnap'], ['wirebox', 'mins', 'maxs']]);
});

test('load follows @include', async () => {
  const files = { 'a/tf.fgd': '@include "base.fgd"\n@PointClass base(B) = p []', 'a/base.fgd': '@BaseClass = B [ k(string) : "K" ]' };
  const map = await F.load('a/tf.fgd', async p => files[p] ?? null);
  assert.deepEqual(F.resolve(map, 'p').keys.map(k => k.name), ['k']);
});

const DIR = 'D:/SteamLibrary/steamapps/common/Team Fortress 2/bin/';
test('real tf.fgd + base.fgd', { skip: !existsSync(DIR + 'tf.fgd') }, async () => {
  const map = await F.load(DIR + 'tf.fgd', p => readFile(p, 'utf8').catch(() => null));
  assert.ok(map.size > 400);
  const spawn = F.resolve(map, 'info_player_teamspawn');
  const team = spawn.keys.find(k => k.name === 'TeamNum');
  assert.equal(team.type, 'choices');
  assert.deepEqual(team.choices.map(c => c.label), ['Any', 'Red', 'Blue']);
  assert.ok(spawn.keys.find(k => k.name === 'spawnflags').flags.some(f => f.label === 'Scout'));
  assert.ok(F.resolve(map, 'func_door').outputs.some(o => o.name === 'OnOpen'));
  assert.ok(F.resolve(map, 'logic_relay').inputs.some(o => o.name === 'Trigger'));
  for (const c of map.values()) for (const k of c.keys) assert.ok(k.name && k.type, `${c.name}.${k.name}`);

  const h = (cls, name) => F.resolve(map, cls).helpers.filter(x => x.name === name).map(x => x.args);
  assert.deepEqual(h('light_spot', 'lightcone'), [[]]);
  assert.deepEqual(h('light_spot', 'lightprop'), [['models/editor/spot.mdl']]);
  assert.deepEqual(h('light_spot', 'sphere'), [['_fifty_percent_distance'], ['_zero_percent_distance']]);
  assert.deepEqual(F.resolve(map, 'light_spot').color, [180, 10, 180], 'from the Light base');
  assert.deepEqual(h('env_sprite', 'sprite'), [[]]);
  assert.deepEqual(F.resolve(map, 'env_sprite').size, [[-2, -2, -2], [2, 2, 2]]);
  assert.deepEqual(h('light', 'iconsprite'), [['editor/light.vmt']]);
  assert.deepEqual(h('info_overlay', 'overlay'), [[]]);
  assert.deepEqual(h('infodecal', 'decal'), [[]]);
  assert.deepEqual(h('env_soundscape', 'line')[0], ['255 255 255', 'targetname', 'position0']);
  assert.deepEqual(h('env_projectedtexture', 'frustum'), [['lightfov', 'nearz', 'farz', 'lightcolor', '-1']]);
  assert.deepEqual(F.resolve(map, 'path_track').size, [[-8, -8, -8], [8, 8, 8]], 'size(16 16 16) is centred');
  assert.deepEqual(h('info_player_teamspawn', 'studio'), [['models/editor/playerstart.mdl']]);
  for (const [cls, name] of [['func_instance', 'instance'], ['keyframe_rope', 'keyframe'], ['move_rope', 'animator'], ['env_cubemap', 'sidelist'], ['func_breakable_surf', 'quadbounds'], ['info_node_link_controller', 'wirebox'], ['path_track', 'cylinder'], ['prop_dynamic', 'studioprop']])
    assert.equal(h(cls, name).length, 1, `${cls} ${name}`);
});

test('defaults: flag bits that default on become spawnflags; origin keys are marked', () => {
  const m = F.parse(`
@BaseClass = Origin [ origin(origin) : "Origin" ]
@PointClass base(Origin) = ambient_generic [ health(integer) : "Volume" : 10
  spawnflags(flags) = [ 1 : "Play everywhere" : 0  16 : "Start Silent" : 1  32 : "Is NOT Looped" : 1 ] ]
@SolidClass = func_detail [ ]`);
  assert.deepEqual(F.defaults(F.resolve(m, 'ambient_generic')), [['origin', ''], ['health', '10'], ['spawnflags', '48']]);
  assert.deepEqual(F.defaults(F.resolve(m, 'func_detail')), []);
  assert.deepEqual(F.defaults(null), []);
});
