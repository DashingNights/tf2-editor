// Drive the running Electron renderer over CDP.
// env CDP_PORT selects the debug port (default 9223).
// args: JS expressions | @shot:file.png | @wait:ms | @reload | @click:x,y[,button][,mods] | @drag:x1,y1,x2,y2[,mods] | @key:Key[,code][,mods] | @type:text
//       @down|@move|@up:x,y[,mods][,button] (hold a drag across steps; @move with button none just hovers) | @wheel:x,y,dy
import fs from 'node:fs';
const PORT = process.env.CDP_PORT; if (!PORT || PORT === '9223') { console.error('cdp.mjs: set CDP_PORT to YOUR OWN dev instance port (9223 is the live editor of the user and is off limits)'); process.exit(2); }
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => (ws.onopen = r));
let id = 0;
const pending = new Map(), logs = [];
ws.onmessage = m => {
  const d = JSON.parse(m.data);
  if (d.id) pending.get(d.id)(d);
  else if (d.method === 'Runtime.consoleAPICalled') logs.push(d.params.type + ': ' + d.params.args.map(a => a.value ?? a.description).join(' '));
  else if (d.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
  else if (d.method === 'Log.entryAdded') logs.push('log ' + d.params.entry.level + ': ' + d.params.entry.text);
};
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
await send('Runtime.enable');
await send('Log.enable');
const VK = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, End: 35, Home: 36, PageUp: 33, PageDown: 34, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, F9: 120 };
const mods = s => (s || '').split('+').reduce((m, k) => m | ({ alt: 1, ctrl: 2, shift: 8 }[k] || 0), 0);
const mouse = (type, x, y, button = 'left', modifiers = 0, buttons = 0) => send('Input.dispatchMouseEvent', { type, x, y, button, modifiers, buttons, clickCount: 1 });
for (const a of process.argv.slice(2)) {
  if (a.startsWith('@shot:')) { await send('Page.bringToFront'); await sleep(300); const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(a.slice(6), Buffer.from(r.result.data, 'base64')); console.log('shot', a.slice(6)); }
  else if (a.startsWith('@wait:')) await sleep(+a.slice(6));
  else if (a === '@reload') { await send('Page.reload'); await sleep(2500); }
  else if (a.startsWith('@click:')) {
    const [x, y, b = 'left', m] = a.slice(7).split(',');
    await mouse('mouseMoved', +x, +y, 'none', mods(m));
    await mouse('mousePressed', +x, +y, b, mods(m), b === 'right' ? 2 : 1);
    await mouse('mouseReleased', +x, +y, b, mods(m), 0);
  } else if (a.startsWith('@drag:')) {
    const [x1, y1, x2, y2, m] = a.slice(6).split(',');
    await mouse('mouseMoved', +x1, +y1, 'none', mods(m));
    await mouse('mousePressed', +x1, +y1, 'left', mods(m), 1);
    for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', +x1 + ((x2 - x1) * i) / 8, +y1 + ((y2 - y1) * i) / 8, 'left', mods(m), 1); await sleep(16); }
    await mouse('mouseReleased', +x2, +y2, 'left', mods(m), 0);
  } else if (/^@(down|move|up):/.test(a)) {
    const [k, rest] = a.slice(1).split(':'), [x, y, m, b = 'left'] = rest.split(',');
    const t = { down: 'mousePressed', move: 'mouseMoved', up: 'mouseReleased' }[k];
    await mouse(t, +x, +y, b, mods(m), k === 'up' || b === 'none' ? 0 : b === 'right' ? 2 : b === 'middle' ? 4 : 1);
  } else if (a.startsWith('@wheel:')) {
    const [x, y, dy] = a.slice(7).split(',');
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: +x, y: +y, deltaX: 0, deltaY: +dy });
  } else if (a.startsWith('@key:')) {
    const [key, code = key, m] = a.slice(5).split(','), vk = key.length === 1 ? key.toUpperCase().charCodeAt(0) : VK[key] ?? 0;
    const text = key === 'Enter' ? '\r' : key.length === 1 && !(mods(m) & 3) ? key : undefined; // typed text, as a real key would
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers: mods(m), windowsVirtualKeyCode: vk, text });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers: mods(m), windowsVirtualKeyCode: vk });
  } else if (a.startsWith('@type:')) await send('Input.insertText', { text: a.slice(6) });
  else {
    const r = await send('Runtime.evaluate', { expression: a, awaitPromise: true, returnByValue: true });
    console.log('>', a.slice(0, 70), '=>', JSON.stringify(r.result.result?.value ?? r.result.exceptionDetails?.exception?.description ?? r.result));
  }
  await sleep(150);
}
await sleep(300);
if (logs.length) console.log(logs.join('\n'));
process.exit(0);
