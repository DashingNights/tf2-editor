// Settings in userData/settings.json. Loaded once at import (top-level await).
import { emit } from './bus.js';

const api = window.api;

export const STEPS = [
  { on: true, name: 'VBSP', cmd: '"$bin\\vbsp++.exe" -game "$gamedir" $vbspflags "$vmf"' },
  { on: true, name: 'VVIS', cmd: '"$bin\\vvis++.exe" -game "$gamedir" $vvisflags "$mapbase"' },
  { on: true, name: 'VRAD', cmd: '"$bin\\vrad++.exe" -game "$gamedir" $vradflags "$mapbase"' },
  { on: true, name: 'Pack', cmd: '@pack' }, // compile.js swaps in the bspzip commands from pack.js
  { on: true, name: 'Copy', cmd: 'cmd /c copy /y "$mapbase.bsp" "$gamedir\\maps\\$mapname.bsp"' },
  { on: false, name: 'Run TF2', cmd: 'cmd /c start "" "$tf2\\tf_win64.exe" -steam -game tf -novid -hijack +map $mapname' },
];

// Compile modes: the flags each tool gets as $vbspflags $vvisflags $vradflags; false: the steps that use that var do
// not run. The Compile panel picks the mode and edits its flags.
export const MODES = {
  fast: { name: 'Fast', vbsp: '', vvis: '-fast', vrad: '-fast' },
  normal: { name: 'Normal', vbsp: '', vvis: '', vrad: '' },
  full: { name: 'Full', vbsp: '', vvis: '', vrad: '-both -final -StaticPropLighting -StaticPropPolys -textureshadows' },
  ents: { name: 'Entities only', vbsp: '-onlyents', vvis: false, vrad: false },
};

export const DEFAULTS = {
  // General
  tf2: '', lastFile: '', recentFiles: [], autosaveMinutes: 5, project: 'mymap', prefabDir: '', ignoreGroups: false,
  // Snapping
  showToolbar: false, snapGrid: true, snapVertex: false, snapEdge: false, snapIntersection: false, snapFace: false, snapRotation: true, rotationStep: 15, rotationStepFine: 5, texLock: true, sizeLock: false, anchor: 'center',
  // 3D view
  fov: 75, flySpeed: 900, flySpeedBoost: 3.3, mouseSensitivity: 1, farClip: 60000, renderMode: 'textured', showGrid3d: true, gizmoSize: 1, gizmoSpace: 'world', entityLines: true,
  // Playtest: fov_desired, the last class (0-8) and team picked
  playtestFov: 90, playtest: { cls: 0, team: 'blu' },
  // 2D views
  grid2dMajor: 1024, showGrid2d: true, gridMinorColor: '#1c1f26', gridMajorColor: '#2d3442', gridAxisColor: '#3b4a66',
  zoomSpeed: 1.2, showDimensions: true, fillPointEntities: true,
  // Blockout
  blockout: false, blockoutPresets: null, slopeTint: false, jumpHeight: 64, crouchJumpHeight: 72, sentryRange: 1100,
  // Figma import: how thick floors, landings and roofs are; the sky's ceiling over the highest brush
  figmaThickness: 16, figmaSkyHeight: 512,
  // Displacements (Displacement panel and paint tool)
  dispPower: 3, dispTarget: 'geometry', dispEffect: 'raise', dispAxis: 'normal', dispRadius: 96, dispStrength: 8,
  // Texture and model browsers
  favourites: [], recentMaterials: [], textureThumbSize: 64, recentModels: [], favouriteModels: [],
  // Keys, compile, editor state
  // Panels: per-panel zoom (layout.js), folded tool sections (tools.js), as the default layout was set up
  panelZoom: { 'tools-file': 0.9, 'tools-map': 0.8, 'tools-main': 0.9, 'tools-gizmo': 0.9, 'tools-grid': 0.9, 'tools-select': 0.9, 'tools-view': 0.9, 'tools-level': 0.9, tools: 0.9, details: 0.8, 'tools-mirror': 0.9, 'tools-brush': 0.9, 'tools-cordon': 0.9, 'tools-edit': 0.9, displacement: 0.9, figmadiff: 0.9 },
  toolsClosed: ['edit', 'brush', 'cordon'],
  keys: {}, steps: STEPS, packStepAdded: true, modeFlagsAdded: true, compileMode: 'fast', compileModes: MODES, layout: {}, grid: 64, material: 'DEV/DEV_MEASUREGENERIC01B', cls: 'info_player_teamspawn', recent: [],
};

// The Settings dialog form (settingsui.js). type: bool | number | select | text | path | color; Keys and Compile are
// drawn by the dialog itself (commands list, compile steps).
export const SCHEMA = [
  { id: 'general', title: 'General', rows: [
    { key: 'tf2', label: 'TF2 folder', type: 'path', hint: 'The folder with tf\\ and bin\\, e.g. ...\\steamapps\\common\\Team Fortress 2. Paste the path.' },
    { key: 'autosaveMinutes', label: 'Autosave every (minutes)', type: 'number', min: 0, max: 120, step: 1, hint: '0 turns it off. Writes <map>.vmf.autosave next to the map while there are unsaved changes.' },
    { key: 'project', label: 'Project name', type: 'text', hint: 'Imported content goes to tf\\custom\\<project>\\.' },
    { key: 'textureThumbSize', label: 'Texture browser thumbnail size', type: 'number', min: 48, max: 160, step: 8, hint: 'Pixels, 48-160. The slider in the Textures panel sets it too.' },
    { key: 'prefabDir', label: 'Prefab folder', type: 'path', hint: 'Empty: the prefabs folder next to settings.json. Used by the Prefabs panel and Prefab: save selection.' },
    { key: 'showToolbar', label: 'Top toolbar', type: 'bool', hint: 'The row of buttons above the panels. Its buttons are in the Main panel too.' },
    { key: 'ignoreGroups', label: 'Ignore groups', type: 'bool', hint: "Hammer's Ig toggle (Select: ignore groups): clicks select single solids instead of whole groups and brush entities." },
  ] },
  { id: 'snapping', title: 'Snapping', rows: [
    { key: 'snapGrid', label: 'Snap to grid', type: 'bool', hint: 'Shift+W. Off: moves and resizes go in 1 unit steps.' },
    { key: 'snapVertex', label: 'Snap to vertices', type: 'bool', hint: 'Moves pull the nearest moving point onto a vertex of the unselected brushes within 10 pixels.' },
    { key: 'snapEdge', label: 'Snap to edges', type: 'bool', hint: 'Moves pull the nearest moving point onto the nearest point of an unselected edge within 10 pixels.' },
    { key: 'snapIntersection', label: 'Snap to intersections', type: 'bool', hint: 'Moves pull the nearest moving point onto a point where two unselected edges cross on screen, within 10 pixels. 3D view: only where the edges meet.' },
    { key: 'snapFace', label: 'Snap to faces', type: 'bool', hint: '3D view: moves put the moving point nearest the face under the cursor onto its plane.' },
    { key: 'snapRotation', label: 'Snap rotation', type: 'bool', hint: 'Off: the gizmo and the Rotation fields rotate freely.' },
    { key: 'rotationStep', label: 'Rotation step', type: 'number', min: 1, max: 180, step: 1, hint: 'Degrees.' },
    { key: 'rotationStepFine', label: 'Rotation step with Shift', type: 'number', min: 0.5, max: 90, step: 0.5, hint: 'Degrees.' },
    { key: 'texLock', label: 'Texture lock', type: 'bool', hint: 'Textures follow brushes when they move, rotate or resize.' },
    { key: 'sizeLock', label: 'Lock size proportions', type: 'bool', hint: 'Details panel: changing one Size field scales the others.' },
    { key: 'anchor', label: 'Anchor', type: 'select', options: [['center', 'Center'], ['min', 'Min corner'], ['bottom', 'Bottom center']], hint: 'The point that stays fixed when resizing in the details panel.' },
  ] },
  { id: 'view3d', title: '3D view', rows: [
    { key: 'fov', label: 'Field of view', type: 'number', min: 30, max: 120, step: 1, hint: 'Vertical, in degrees.' },
    { key: 'flySpeed', label: 'Fly speed', type: 'number', min: 10, max: 20000, step: 10, hint: 'Units per second, 10-20000. The wheel changes it while flying. The wheel\'s dolly step follows it: 128 units at 900, 1.4 at 10.' },
    { key: 'flySpeedBoost', label: 'Fly speed with Shift', type: 'number', min: 1, max: 10, step: 0.1, hint: 'Multiplier.' },
    { key: 'mouseSensitivity', label: 'Mouse sensitivity', type: 'number', min: 0.1, max: 5, step: 0.1, hint: 'Look and orbit speed.' },
    { key: 'farClip', label: 'Far clip', type: 'number', min: 1000, max: 200000, step: 1000, hint: 'Units.' },
    { key: 'playtestFov', label: 'Playtest field of view', type: 'number', min: 20, max: 90, step: 1, hint: "TF2's fov_desired: horizontal at 4:3, 20-90 (the game starts at 75, most players use 90)." },
    { key: 'renderMode', label: 'Render mode', type: 'select', options: [['textured', 'Textured'], ['flat', 'Flat'], ['wireframe', 'Wireframe'], ['lit', 'Lit (lighting preview)']] },
    { key: 'entityLines', label: 'Entity lines', type: 'bool', hint: 'Lines from entities to their targets, parents and output targets (View: entity lines).' },
    { key: 'showGrid3d', label: 'Show grid', type: 'bool', hint: 'Grid on the z = 0 plane.' },
    { key: 'gizmoSize', label: 'Gizmo size', type: 'number', min: 0.3, max: 3, step: 0.1 },
    { key: 'gizmoSpace', label: 'Gizmo space', type: 'select', options: [['world', 'World'], ['local', 'Local']], hint: 'Ctrl+` or click the gizmo text in the 3D status line. Local: the gizmo, the top view selection box and its handles follow the angles of a single entity or the own angle of the selection; world: axis aligned.' },
  ] },
  { id: 'view2d', title: '2D views', rows: [
    { key: 'grid2dMajor', label: 'Major grid lines every', type: 'select', options: [256, 512, 1024, 2048, 4096].map(n => [n, `${n} units`]) },
    { key: 'showGrid2d', label: 'Show grid', type: 'bool' },
    { key: 'gridMinorColor', label: 'Grid colour', type: 'color' },
    { key: 'gridMajorColor', label: 'Major grid colour', type: 'color' },
    { key: 'gridAxisColor', label: 'Axis colour', type: 'color' },
    { key: 'zoomSpeed', label: 'Zoom speed', type: 'number', min: 1.05, max: 2, step: 0.05, hint: 'Zoom factor per wheel step.' },
    { key: 'showDimensions', label: 'Show selection size', type: 'bool' },
    { key: 'fillPointEntities', label: 'Fill point entities', type: 'bool' },
  ] },
  { id: 'blockout', title: 'Blockout', rows: [
    { key: 'blockout', label: 'Blockout mode', type: 'bool', hint: 'Ctrl+B. Toolbar over the 3D view; drag on a surface to draw brushes; new brushes get dev textures by face direction.' },
    { key: 'slopeTint', label: 'Tint steep slopes', type: 'bool', hint: 'Faces steeper than 45.6 degrees (too steep to walk up) show red. Blockout mode turns it on and off; View: tint steep slopes toggles it.' },
    { key: 'jumpHeight', label: 'Jump height', type: 'number', min: 0, max: 512, step: 1, hint: 'Units. Height band for a standing jump.' },
    { key: 'crouchJumpHeight', label: 'Crouch jump height', type: 'number', min: 0, max: 512, step: 1, hint: 'Units. The red unreachable band sits at 1.5x this.' },
    { key: 'sentryRange', label: 'Sentry range', type: 'number', min: 0, max: 8192, step: 1, hint: 'Units. Radius of the sentry range sphere.' },
  ] },
  { id: 'displacements', title: 'Displacements', rows: [
    { key: 'dispPower', label: 'New displacement power', type: 'select', options: [[2, '2 (5 x 5)'], [3, '3 (9 x 9)'], [4, '4 (17 x 17)']] },
    { key: 'dispRadius', label: 'Paint radius', type: 'number', min: 4, max: 4096, step: 8, hint: 'Units.' },
    { key: 'dispStrength', label: 'Paint strength', type: 'number', min: 0, max: 1024, step: 1, hint: 'Units per dab (alpha: 0-255). Raise to: the distance or alpha to reach.' },
  ] },
  { id: 'figma', title: 'Figma import', rows: [
    { key: 'figmaThickness', label: 'Floor and roof thickness', type: 'number', min: 1, max: 256, step: 1, hint: 'Units. Floors, landings and roofs are slabs this thick; walls and blocks reach down to the lowest floor beside them, this far under it. Pieces at the edge of the map or beside a gap in the floors reach the bottom of the map.' },
    { key: 'figmaSkyHeight', label: 'Sky over the highest brush', type: 'number', min: 16, max: 8192, step: 16, hint: 'Units. The sky is a shell tight round the map, its ceiling this far over the highest brush.' },
  ] },
  { id: 'keys', title: 'Keys', rows: [] },
  { id: 'compile', title: 'Compile', rows: [] },
];

// Saved values win; keys the defaults do not know are kept.
export const merge = saved => ({ ...structuredClone(DEFAULTS), ...saved });

// Migration: settings saved before the Pack step existed get it once, after the last vbsp/vvis/vrad step (else at the
// end). packStepAdded records that this ran, so a Pack step the user removes later stays removed. True when it changed c.
export function migrateSteps(c) {
  if (!Array.isArray(c?.steps) || c.packStepAdded) return false;
  c.packStepAdded = true;
  if (!c.steps.some(s => s.cmd?.trim() === '@pack')) {
    const i = c.steps.findLastIndex(s => /v(bsp|vis|rad)/i.test(s.cmd));
    c.steps.splice(i < 0 ? c.steps.length : i + 1, 0, structuredClone(STEPS.find(s => s.cmd === '@pack')));
  }
  return true;
}

// Migration: VBSP, VVIS and VRAD steps still as the defaults were before compile modes (vvis -fast written in) get the
// $vbspflags $vvisflags $vradflags vars once; steps the user edited stay as they are. True when it changed c.
const OLD_TOOL_CMDS = ['"$bin\\vbsp++.exe" -game "$gamedir" "$vmf"', '"$bin\\vvis++.exe" -game "$gamedir" -fast "$mapbase"', '"$bin\\vrad++.exe" -game "$gamedir" "$mapbase"'];
export function migrateModes(c) {
  if (!Array.isArray(c?.steps) || c.modeFlagsAdded) return false;
  c.modeFlagsAdded = true;
  for (const s of c.steps) { const i = OLD_TOOL_CMDS.indexOf(s.cmd); if (i >= 0) s.cmd = STEPS[i].cmd; }
  return true;
}

let saved = {}, text = null;
try { text = await api.read(api.settingsPath); saved = JSON.parse(text || '{}'); } catch (e) {
  // The next save writes defaults over settings.json: keep the user's file next to it.
  const msg = `settings.json is not valid JSON (${e.message}). It was kept as settings.bad.json; defaults are in use.`;
  await api.write(api.settingsPath.replace(/json$/, 'bad.json'), text).catch(() => {});
  console.error(msg);
  globalThis.alert?.(msg);
}
if (Array.isArray(saved.steps)) saved.steps = saved.steps.filter(Boolean); // an older build could write null steps
const migrated = [migrateSteps(saved), migrateModes(saved)].some(Boolean);
export const cfg = merge(saved);

// Writes run one after another: overlapping writes to the same file can leave it as invalid JSON.
let writing = Promise.resolve();
export const saveCfg = () => (writing = writing.catch(() => {}).then(() => api.write(api.settingsPath, JSON.stringify(cfg, null, 2))));
if (migrated) saveCfg();

export function setCfg(key, value) {
  cfg[key] = value;
  saveCfg();
  emit('cfg', { key, value });
}

// Most recent first, at most 10.
export const addRecent = file => setCfg('recentFiles', [file, ...cfg.recentFiles.filter(f => f !== file)].slice(0, 10));
// True when the recent file still exists; a missing one is dropped from the list.
export async function keepRecent(file) {
  if (await api.exists(file)) return true;
  setCfg('recentFiles', cfg.recentFiles.filter(f => f !== file));
  return false;
}

if (!cfg.tf2) {
  const vdf = await api.read('C:\\Program Files (x86)\\Steam\\steamapps\\libraryfolders.vdf');
  for (const m of vdf?.matchAll(/"path"\s+"([^"]+)"/g) ?? []) {
    const p = m[1].replace(/\\\\/g, '\\') + '\\steamapps\\common\\Team Fortress 2';
    if (await api.exists(p)) { cfg.tf2 = p; break; }
  }
}
