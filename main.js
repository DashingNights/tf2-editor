import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, watch } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

// TF2EDITOR_USERDATA isolates settings for test runs (see dev/cdp.mjs).
if (process.env.TF2EDITOR_USERDATA) {
  app.setPath('userData', path.resolve(process.env.TF2EDITOR_USERDATA));
  app.commandLine.appendSwitch('mute-audio'); // test runs never play through the speakers
}

let win, proc;
const send = s => { if (win && !win.isDestroyed()) win.webContents.send('log', s); };
// VMF (and its autosave) as latin1 so arbitrary bytes round-trip unchanged; everything else utf8.
const enc = p => (/\.vmf(\.autosave)?$/i.test(p) ? 'latin1' : 'utf8');
const filters = [{ name: 'Valve Map', extensions: ['vmf'] }];

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1600, height: 1000, backgroundColor: '#15171c',
    minWidth: 880, minHeight: 560, // the toolbar on one line; 'minSize' raises it to the dock's minimum
    icon: path.join(import.meta.dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(import.meta.dirname, 'preload.cjs') },
  });
  win.removeMenu();
  win.maximize(); // the default layout (src/defaultlayout.js) was set up in a maximized window
  win.loadFile('index.html');
  const wc = win.webContents;
  wc.on('will-navigate', e => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('before-input-event', (_, i) => { if (i.type === 'keyDown' && i.key === 'F12') wc.toggleDevTools(); });
  // Unsaved changes: the renderer owns the prompt (an in-app dialog), so nothing here blocks the event loop.
  win.on('close', e => { if (dirty && !closing) { e.preventDefault(); wc.send('close-request'); } });
  // The page died (crash, out of memory, killed): name the last autosave and offer a reload, which offers it back
  // (src/crash.js). The dead page cannot answer the close request, so Close skips it.
  wc.on('render-process-gone', async (_, { reason }) => {
    if (closing || reason === 'clean-exit' || win.isDestroyed()) return;
    const st = autosave && (await fs.stat(autosave).catch(() => null));
    const { response } = await dialog.showMessageBox(win, {
      type: 'error', title: 'TF2 Editor', buttons: ['Reload', 'Close'], defaultId: 0, cancelId: 1, noLink: true,
      message: `The editor stopped (${reason}).`,
      detail: st ? `The last autosave is ${autosave}, from ${st.mtime.toLocaleString()}. Reload starts the editor again and offers it back when it is newer than its map.`
        : 'There is no autosave of this map: changes since the last save are lost.',
    });
    dirty = false; // the reloaded page reports its own state
    if (response === 0) wc.reload();
    else { closing = true; win.close(); }
  });
});
app.on('window-all-closed', () => app.quit());

let dirty = false, closing = false, autosave = null;
ipcMain.on('dirty', (_, d) => { dirty = !!d; });
ipcMain.on('autosave', (_, p) => { autosave = typeof p === 'string' && path.isAbsolute(p) ? p : null; });

// Asset hotload: the renderer names the TF2 folder; changes under its tf\custom, tf\materials and tf\models go back as
// absolute paths ('assetsChanged') once 500 ms pass without another.
// ponytail: fs.watch does not follow junctions, so mods linked into tf\custom do not hotload; watch their targets too
// if that matters.
let watchers = [], changed = new Set(), quiet = 0;
ipcMain.on('watchAssets', (_, tf2) => {
  for (const w of watchers) w.close();
  watchers = [];
  if (typeof tf2 !== 'string' || !path.isAbsolute(tf2)) return;
  for (const dir of ['custom', 'materials', 'models'].map(d => path.join(tf2, 'tf', d))) {
    let w;
    try { w = watch(dir, { recursive: true }); } catch { continue; } // no such folder
    w.on('change', (_, f) => {
      if (!f) return;
      changed.add(path.join(dir, String(f)));
      clearTimeout(quiet);
      quiet = setTimeout(() => { if (win && !win.isDestroyed()) win.webContents.send('assetsChanged', [...changed]); changed.clear(); }, 500);
    });
    w.on('error', () => w.close()); // the folder went away; an unhandled 'error' would end the app
    watchers.push(w);
  }
});
ipcMain.on('closeNow', () => { closing = true; win?.close(); });
// w x h: the smallest content size the renderer's layout fits in (src/layout.js). Grows the window when it is smaller.
ipcMain.on('minSize', (_, w, h) => {
  const [ow, oh] = win.getSize(), [cw, ch] = win.getContentSize();
  win.setMinimumSize(Math.max(880, Math.ceil(w) + ow - cw), Math.max(560, Math.ceil(h) + oh - ch));
  if (cw < w || ch < h) win.setContentSize(Math.max(cw, Math.ceil(w)), Math.max(ch, Math.ceil(h)));
});
ipcMain.on('closeWindow', () => win?.close()); // same path as the title-bar X, so the dirty check above runs

ipcMain.on('settingsPath', e => { e.returnValue = path.join(app.getPath('userData'), 'settings.json'); });
ipcMain.handle('read', (_, p) => fs.readFile(p, enc(p)).catch(() => null));
ipcMain.handle('exists', (_, p) => existsSync(p));
ipcMain.handle('write', async (_, p, text) => {
  if (/\.vmf$/i.test(p) && existsSync(p)) await fs.copyFile(p, p.replace(/\.vmf$/i, '.vmx'));
  // latin1 keeps only the low byte, so characters above U+00FF (typed or pasted) are written as UTF-8 bytes.
  if (enc(p) === 'latin1') text = text.replace(/[^\x00-\xff]+/g, s => Buffer.from(s, 'utf8').toString('latin1'));
  // Temp file, then rename: a crash mid-write cannot leave the file cut off.
  await fs.writeFile(p + '.tmp', text, enc(p));
  await fs.rename(p + '.tmp', p);
});
ipcMain.handle('openDialog', async () => {
  const r = await dialog.showOpenDialog(win, { filters });
  return r.canceled ? null : { path: r.filePaths[0], text: await fs.readFile(r.filePaths[0], 'latin1') };
});
// filters: [{ name, extensions }]. Returns the chosen paths ([] when cancelled).
ipcMain.handle('openFiles', async (_, filters) => (await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters })).filePaths);
ipcMain.handle('saveDialog', async (_, p) => (await dialog.showSaveDialog(win, { defaultPath: p, filters })).filePath || null);

// Binary access for VPK/VTF/thumbnails. Byte ranges so 1 GB archives are never read whole. null on a missing file.
const abs = p => { if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error(`absolute path required: ${p}`); return p; };
const orNull = e => { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; };
ipcMain.handle('readBytes', async (_, p, offset, length) => {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > 2 ** 30) throw new Error('bad range');
  const fh = await fs.open(abs(p), 'r').catch(orNull);
  if (!fh) return null;
  try {
    const buf = Buffer.alloc(length), { bytesRead } = await fh.read(buf, 0, length, offset);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead);
  } finally { await fh.close(); }
});
ipcMain.handle('stat', (_, p) => fs.stat(abs(p)).then(s => ({ size: s.size, mtimeMs: s.mtimeMs, isDirectory: s.isDirectory() }), orNull));
// Junctions and symlinks to folders count as folders (tf/custom often links mods in from elsewhere).
const isDir = async (p, d) => d.isDirectory() || (d.isSymbolicLink() && !!(await fs.stat(path.join(p, d.name)).catch(() => null))?.isDirectory());
ipcMain.handle('listDir', (_, p) => fs.readdir(abs(p), { withFileTypes: true }).then(ds => Promise.all(ds.map(async d => ({ name: d.name, isDirectory: await isDir(p, d) }))), orNull));
// Prefabs panel: delete and rename files (absolute paths; a missing file is not an error for remove).
ipcMain.handle('remove', (_, p) => fs.rm(abs(p), { force: true }));
ipcMain.handle('rename', (_, a, b) => fs.rename(abs(a), abs(b)));
ipcMain.handle('writeBinary', async (_, p, bytes) => {
  await fs.mkdir(path.dirname(abs(p)), { recursive: true });
  await fs.writeFile(p, new Uint8Array(bytes));
});

// Runs compile steps in order; stops at the first non-zero exit. Returns { code, leaked }. The leak check and the
// Done line happen here: the reply can reach the renderer before the last 'log' messages.
ipcMain.handle('run', async (_, cmds) => {
  const t0 = Date.now();
  let code = 0, leaked = false, tail = '';
  // tail: the end of the output so far, so a 'leaked' split across two chunks is still found.
  const out = d => { const s = d.toString('latin1'); leaked ||= /leaked/i.test(tail + s); tail = (tail + s).slice(-5); send(s); };
  for (const cmd of cmds) {
    // A token may hold quoted runs: --opt="a b" is one argument, "" an empty one.
    const [exe, ...args] = cmd.match(/(?:"[^"]*"|[^\s"])+/g).map(s => s.replace(/"/g, ''));
    send(`\n> ${cmd}\n`);
    code = await new Promise(res => {
      try { proc = spawn(exe, args, { windowsHide: true }); } catch (e) { send(`${e.message} (run .bat files as: cmd /c file.bat)\n`); return res(-1); }
      proc.stdout.on('data', out);
      proc.stderr.on('data', out);
      proc.on('error', e => { send(e.message + '\n'); res(-1); });
      // 'close' also waits for processes the step started that hold its output (cmd /c start "" tf_win64.exe).
      proc.on('exit', c => setTimeout(res, 200, c));
      proc.on('close', res);
    });
    proc = null;
    if (code !== 0) { send(`\nStopped: exit code ${code}\n`); break; }
  }
  send(`\n${code === 0 ? 'Done' : 'FAILED'} in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  return { code, leaked };
});
// Ends the step and every process it started (cmd /c wrappers and the tools they run).
ipcMain.on('cancel', () => proc?.pid && spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }));
