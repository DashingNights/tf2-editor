import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, pathPolylines, parseTransform, apply, readSvg, color, lightness } from '../src/svgread.js';

test('parseXml keeps elements and attributes, skips comments and declarations', () => {
  const t = parseXml('<?xml version="1.0"?><!-- hi --><svg w="1"><g id="a &amp; b"><path d="M0 0"/></g><rect x=\'2\'/></svg>');
  assert.equal(t.name, 'svg');
  assert.deepEqual(t.children.map(c => c.name), ['g', 'rect']);
  assert.equal(t.children[0].attrs.id, 'a & b');
  assert.equal(t.children[0].children[0].attrs.d, 'M0 0');
  assert.equal(t.children[1].attrs.x, '2');
});

test('paths: lines, relative moves, closing, packed numbers', () => {
  const [a, b] = pathPolylines('M0 0H10V10L0 10Z m20 0 l5 5 .5.5');
  assert.deepEqual(a, { pts: [[0, 0], [10, 0], [10, 10], [0, 10]], closed: true });
  assert.equal(b.closed, false);
  assert.deepEqual(b.pts, [[20, 0], [25, 5], [25.5, 5.5]]);
});

test('curves are flattened within the tolerance', () => {
  const k = 0.5522847498 * 100; // a quarter circle of radius 100 as one cubic
  const [c] = pathPolylines(`M100 0C100 ${k} ${k} 100 0 100`, 0.25);
  assert.ok(c.pts.length > 4);
  for (const p of c.pts) assert.ok(Math.abs(Math.hypot(p[0], p[1]) - 100) < 0.3, `${p}`);
  const [arc] = pathPolylines('M0 0A50 50 0 0 1 100 0', 0.25);
  for (const p of arc.pts) assert.ok(Math.abs(Math.hypot(p[0] - 50, p[1]) - 50) < 0.3, `${p}`);
  assert.deepEqual(arc.pts.at(-1), [100, 0]);
});

test('transforms compose left to right', () => {
  const m = parseTransform('translate(10 0) rotate(90)');
  const p = apply(m, [1, 0]);
  assert.ok(Math.abs(p[0] - 10) < 1e-9 && Math.abs(p[1] - 1) < 1e-9);
});

test('readSvg: names from ids outermost first, inherited paint, transforms, hidden and defs skipped', () => {
  const shapes = readSvg(`<svg fill="none"><defs><path id="x" d="M0 0L1 1"/></defs>
    <g id="Zone1 z-86" transform="translate(100 0)"><path id="floor" d="M0 0H10V10H0Z" fill="#646464"/>
    <path id="walls" d="M0 0H10" stroke="#3D5288" stroke-width="19"/><path id="hidden" d="M0 0H1" display="none"/></g></svg>`);
  assert.equal(shapes.length, 2);
  assert.deepEqual(shapes[0].names, ['Zone1 z-86', 'floor']);
  assert.equal(shapes[0].fill, '#646464');
  assert.equal(shapes[0].stroke, null);
  assert.deepEqual(shapes[0].polylines[0].pts[0], [100, 0]);
  assert.equal(shapes[1].fill, null); // inherits fill="none" from the root
  assert.equal(shapes[1].stroke, '#3d5288');
  assert.equal(shapes[1].strokeWidth, 19);
});

test('colours and lightness', () => {
  assert.equal(color('#ABC'), '#aabbcc');
  assert.equal(color('none'), null);
  assert.equal(color('url(#g)'), 'paint');
  assert.equal(color('rgb(255, 0, 0)'), '#ff0000');
  assert.ok(Math.abs(lightness('#808080') - 50.2) < 0.1);
});
