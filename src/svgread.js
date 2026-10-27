// Reads an SVG (a Figma export with "Include id attribute") into flat shapes: the names of the layers a shape sits in,
// its outline as polylines (curves flattened to chords), and its paint. Pure: no DOM.

// ---------- XML ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = s => s.replace(/&(#x[0-9a-f]+|#[0-9]+|\w+);/gi, (a, e) => (e[0] === '#' ? String.fromCodePoint(/^#x/i.test(e) ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? a));
function attrsOf(s) {
  const a = {};
  for (const m of s.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) a[m[1]] = unescape(m[2] ?? m[3]);
  return a;
}

// Element tree { name, attrs, children } of the first <svg> (text, comments, CDATA and declarations are skipped).
export function parseXml(text) {
  const root = { name: '#root', attrs: {}, children: [] }, stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/\s*([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  for (let m; (m = re.exec(text));) {
    if (m[1]) { while (stack.length > 1 && stack.pop().name !== m[1]); }
    else if (m[2]) {
      const el = { name: m[2], attrs: attrsOf(m[3]), children: [] };
      stack[stack.length - 1].children.push(el);
      if (!m[4]) stack.push(el);
    }
  }
  return root.children.find(c => c.name === 'svg') ?? root;
}

// ---------- transforms: [a, b, c, d, e, f], x' = a x + c y + e, y' = b x + d y + f ----------
const I = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
export const apply = (m, p) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];

export function parseTransform(s = '') {
  let m = I;
  for (const [, op, args] of s.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const v = (args.match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? []).map(Number), r = x => (x * Math.PI) / 180;
    let t = I;
    if (op === 'matrix' && v.length === 6) t = v;
    else if (op === 'translate') t = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0];
    else if (op === 'scale') t = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0];
    else if (op === 'rotate') {
      const c = Math.cos(r(v[0] ?? 0)), s2 = Math.sin(r(v[0] ?? 0)), [cx = 0, cy = 0] = v.slice(1);
      t = mul(mul([1, 0, 0, 1, cx, cy], [c, s2, -s2, c, 0, 0]), [1, 0, 0, 1, -cx, -cy]);
    } else if (op === 'skewX') t = [1, 0, Math.tan(r(v[0] ?? 0)), 1, 0, 0];
    else if (op === 'skewY') t = [1, Math.tan(r(v[0] ?? 0)), 0, 1, 0, 0];
    m = mul(m, t);
  }
  return m;
}

// ---------- paths ----------
// Polylines of an SVG path: [{ pts: [[x, y], ...], closed }]. Curves become chords at most tol off the curve.
export function pathPolylines(d, tol = 0.5) {
  const NUM = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/y;
  let i = 0;
  const ws = () => { while (i < d.length && /[\s,]/.test(d[i])) i++; };
  const num = () => { ws(); NUM.lastIndex = i; const m = NUM.exec(d); if (!m) throw new Error(`path: number expected at ${i}`); i = NUM.lastIndex; return +m[0]; };
  const flag = () => { ws(); const c = d[i++]; if (c !== '0' && c !== '1') throw new Error(`path: arc flag expected at ${i - 1}`); return c === '1'; };
  const out = [];
  let cur = null, x = 0, y = 0, sx = 0, sy = 0, cmd = '', lc = null; // lc: last control point (for S and T)
  const lineTo = (nx, ny) => { cur.pts.push([nx, ny]); x = nx; y = ny; };
  const cubic = (p1, p2, p3) => {
    const flat = (a, b, c, e, depth) => {
      const l = Math.hypot(e[0] - a[0], e[1] - a[1]), off = q => (l > 1e-9 ? Math.abs((e[0] - a[0]) * (q[1] - a[1]) - (e[1] - a[1]) * (q[0] - a[0])) / l : Math.hypot(q[0] - a[0], q[1] - a[1]));
      if (depth > 12 || Math.max(off(b), off(c)) <= tol) return void cur.pts.push(e);
      const m = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], ab = m(a, b), bc = m(b, c), ce = m(c, e), abc = m(ab, bc), bce = m(bc, ce), mid = m(abc, bce);
      flat(a, ab, abc, mid, depth + 1);
      flat(mid, bce, ce, e, depth + 1);
    };
    flat([x, y], p1, p2, p3, 0);
    [x, y] = p3;
  };
  const arc = (rx, ry, rot, large, sweep, ex, ey) => {
    // endpoint to centre parameterisation (SVG implementation notes, F.6.5)
    const phi = (rot * Math.PI) / 180, cp = Math.cos(phi), sp = Math.sin(phi), dx = (x - ex) / 2, dy = (y - ey) / 2;
    const x1 = cp * dx + sp * dy, y1 = -sp * dx + cp * dy;
    rx = Math.abs(rx); ry = Math.abs(ry);
    if (rx < 1e-9 || ry < 1e-9) return lineTo(ex, ey);
    const L = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if (L > 1) { rx *= Math.sqrt(L); ry *= Math.sqrt(L); }
    const num2 = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1, den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num2 / den)), cx1 = (k * rx * y1) / ry, cy1 = (-k * ry * x1) / rx;
    const cx = cp * cx1 - sp * cy1 + (x + ex) / 2, cy = sp * cx1 + cp * cy1 + (y + ey) / 2;
    const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const t0 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
    let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
    if (!sweep && dt > 0) dt -= 2 * Math.PI;
    if (sweep && dt < 0) dt += 2 * Math.PI;
    const r = Math.max(rx, ry), step = r > tol ? 2 * Math.acos(Math.max(-1, 1 - tol / r)) : Math.PI / 2, n = Math.max(1, Math.ceil(Math.abs(dt) / step));
    for (let k2 = 1; k2 <= n; k2++) {
      const t = t0 + (dt * k2) / n, px = rx * Math.cos(t), py = ry * Math.sin(t);
      cur.pts.push(k2 === n ? [ex, ey] : [cp * px - sp * py + cx, sp * px + cp * py + cy]);
    }
    x = ex; y = ey;
  };
  for (ws(); i < d.length; ws()) {
    if (/[a-zA-Z]/.test(d[i])) cmd = d[i++];
    else if (!cmd) throw new Error('path: command expected');
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase(), ax = v => (rel ? x + v : v), ay = v => (rel ? y + v : v);
    if (C === 'Z') {
      if (cur) { cur.closed = true; x = sx; y = sy; }
      cur = null; lc = null;
      continue;
    }
    if (C === 'M') {
      const nx = ax(num()), ny = ay(num());
      cur = { pts: [[nx, ny]], closed: false };
      out.push(cur);
      x = sx = nx; y = sy = ny; lc = null;
      cmd = rel ? 'l' : 'L'; // further pairs are line-tos
      continue;
    }
    if (!cur) { cur = { pts: [[x, y]], closed: false }; out.push(cur); sx = x; sy = y; }
    if (C === 'L') { lineTo(ax(num()), ay(num())); lc = null; }
    else if (C === 'H') { lineTo(rel ? x + num() : num(), y); lc = null; }
    else if (C === 'V') { lineTo(x, rel ? y + num() : num()); lc = null; }
    else if (C === 'C') { const p1 = [ax(num()), ay(num())], p2 = [ax(num()), ay(num())], p3 = [ax(num()), ay(num())]; cubic(p1, p2, p3); lc = p2; }
    else if (C === 'S') { const p1 = lc ? [2 * x - lc[0], 2 * y - lc[1]] : [x, y], p2 = [ax(num()), ay(num())], p3 = [ax(num()), ay(num())]; cubic(p1, p2, p3); lc = p2; }
    else if (C === 'Q' || C === 'T') {
      const q = C === 'Q' ? [ax(num()), ay(num())] : lc ? [2 * x - lc[0], 2 * y - lc[1]] : [x, y], e = [ax(num()), ay(num())];
      cubic([x + (2 / 3) * (q[0] - x), y + (2 / 3) * (q[1] - y)], [e[0] + (2 / 3) * (q[0] - e[0]), e[1] + (2 / 3) * (q[1] - e[1])], e);
      lc = q;
    } else if (C === 'A') { const rx = num(), ry = num(), rot = num(), large = flag(), sweep = flag(); arc(rx, ry, rot, large, sweep, ax(num()), ay(num())); lc = null; }
    else throw new Error(`path: unknown command ${cmd}`);
  }
  // drop repeated points (a closing segment back onto the start is implied by closed)
  for (const s of out) {
    s.pts = s.pts.filter((p, k) => !k || Math.hypot(p[0] - s.pts[k - 1][0], p[1] - s.pts[k - 1][1]) > 1e-6);
    if (s.closed && s.pts.length > 1 && Math.hypot(s.pts[0][0] - s.pts.at(-1)[0], s.pts[0][1] - s.pts.at(-1)[1]) < 1e-6) s.pts.pop();
  }
  return out.filter(s => s.pts.length >= 2);
}

// ---------- paint ----------
const NAMED = { black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', gray: '#808080', grey: '#808080' };
// '#rrggbb' for a solid colour, 'paint' for a gradient or pattern, null for none.
export function color(v) {
  if (v == null) return undefined;
  v = v.trim().toLowerCase();
  if (v === 'none' || v === 'transparent' || v === '') return null;
  if (/^url\(/.test(v)) return 'paint';
  if (NAMED[v]) return NAMED[v];
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return '#' + [...m[1]].map(c => c + c).join('');
  if ((m = /^#([0-9a-f]{6})/.exec(v))) return '#' + m[1];
  if ((m = /^rgba?\(\s*([\d.]+)%?\s*,?\s*([\d.]+)%?\s*,?\s*([\d.]+)%?/.exec(v))) return '#' + [m[1], m[2], m[3]].map(n => Math.round(Math.min(255, +n)).toString(16).padStart(2, '0')).join('');
  return 'paint';
}
// HSL lightness (0 to 100) of '#rrggbb'.
export function lightness(hex) {
  const c = [1, 3, 5].map(k => parseInt(hex.slice(k, k + 2), 16) / 255);
  return ((Math.max(...c) + Math.min(...c)) / 2) * 100;
}

// ---------- shapes ----------
const SKIP = new Set(['defs', 'clipPath', 'mask', 'pattern', 'marker', 'symbol', 'linearGradient', 'radialGradient', 'filter', 'style', 'title', 'desc', 'metadata', 'text', 'foreignObject', 'use', 'image']);
const styleOf = a => Object.fromEntries((a.style ?? '').split(';').map(s => s.split(':').map(t => t.trim())).filter(p => p.length === 2 && p[0]));
const nums = s => (s ?? '').match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g)?.map(Number) ?? [];
const circlePts = (cx, cy, rx, ry, tol) => {
  const r = Math.max(rx, ry), n = Math.max(8, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - tol / Math.max(r, tol)))));
  return Array.from({ length: n }, (_, k) => [cx + rx * Math.cos((2 * Math.PI * k) / n), cy + ry * Math.sin((2 * Math.PI * k) / n)]);
};

// Polylines of one element in its own coordinates, or null when it draws nothing.
function outline(el, tol) {
  const a = el.attrs, n = k => +(a[k] ?? 0);
  switch (el.name) {
    case 'path': return a.d ? pathPolylines(a.d, tol) : null;
    case 'rect': { const x = n('x'), y = n('y'), w = n('width'), h = n('height'); return w > 0 && h > 0 ? [{ pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], closed: true }] : null; }
    case 'polygon': case 'polyline': { const v = nums(a.points), pts = []; for (let k = 0; k + 1 < v.length; k += 2) pts.push([v[k], v[k + 1]]); return pts.length >= 2 ? [{ pts, closed: el.name === 'polygon' }] : null; }
    case 'line': return [{ pts: [[n('x1'), n('y1')], [n('x2'), n('y2')]], closed: false }];
    case 'circle': return n('r') > 0 ? [{ pts: circlePts(n('cx'), n('cy'), n('r'), n('r'), tol), closed: true }] : null;
    case 'ellipse': return n('rx') > 0 && n('ry') > 0 ? [{ pts: circlePts(n('cx'), n('cy'), n('rx'), n('ry'), tol), closed: true }] : null;
    default: return null;
  }
}

// Every drawn element of the SVG text as { names, fill, stroke, strokeWidth, polylines, order }: names are the ids of
// its enclosing elements, outermost first, its own last (Figma writes layer names there); fill and stroke are
// '#rrggbb', 'paint' or null; polylines are in the SVG's user units with transforms applied.
export function readSvg(text, tol = 0.5) {
  const root = parseXml(text), shapes = [];
  const walk = (el, m, names, paint) => {
    if (SKIP.has(el.name)) return;
    const st = styleOf(el.attrs), get = k => st[k] ?? el.attrs[k];
    if (get('display') === 'none' || get('visibility') === 'hidden') return;
    const mm = el.attrs.transform ? mul(m, parseTransform(el.attrs.transform)) : m;
    const nn = el.attrs.id ? [...names, el.attrs.id] : names;
    const pp = { ...paint };
    for (const k of ['fill', 'stroke']) { const c = color(get(k)); if (c !== undefined) pp[k] = c; }
    if (get('stroke-width') != null) pp.strokeWidth = +nums(get('stroke-width'))[0] || 0;
    if (get('fill-opacity') != null && +get('fill-opacity') === 0) pp.fill = null;
    if (get('stroke-opacity') != null && +get('stroke-opacity') === 0) pp.stroke = null;
    if (get('opacity') != null && +get('opacity') === 0) return;
    const lines = el.name === 'svg' || el.name === 'g' ? null : outline(el, tol);
    if (lines) {
      const scale = Math.sqrt(Math.abs(mm[0] * mm[3] - mm[1] * mm[2]));
      shapes.push({ names: nn, fill: pp.fill, stroke: pp.stroke, strokeWidth: (pp.strokeWidth ?? 1) * scale, order: shapes.length, polylines: lines.map(l => ({ pts: l.pts.map(p => apply(mm, p)), closed: l.closed })) });
    }
    for (const c of el.children) walk(c, mm, nn, pp);
  };
  walk(root, I, [], { fill: '#000000', stroke: null, strokeWidth: 1 });
  return shapes;
}
