// Bootstrap: mount the panels into their elements, dock them, wire the shell (toolbar state, status bar), open the last map.
import { on } from './src/bus.js';
import { cfg } from './src/settings.js';
import { S, sel, cache, doc, open, newMap, confirmDiscard } from './src/state.js';
import * as commands from './src/commands.js';
import * as view3d from './src/view3d.js';
import * as view2d from './src/view2d.js';
import * as details from './src/details.js';
import * as outliner from './src/outliner.js';
import * as compile from './src/compile.js';
import * as settingsui from './src/settingsui.js';
import * as layout from './src/layout.js';
import * as texbrowser from './src/texbrowser.js';
import * as aids from './src/aids.js';
import * as blockout from './src/blockout.js';
import * as importer from './src/import.js';
import * as models from './src/models.js';
import * as modelbrowser from './src/modelbrowser.js';
import * as soundbrowser from './src/soundbrowser.js';
import * as brushtools from './src/brushtools.js';
import * as polyedit from './src/polyedit.js';
import * as cliptool from './src/cliptool.js';
import * as stairtool from './src/stairtool.js';
import * as chamfer from './src/chamfer.js';
import * as rooftool from './src/rooftool.js';
import * as figmaui from './src/figmaui.js';
import * as disp from './src/disp.js';
import * as instances from './src/instances.js';
import * as helpers from './src/helpers.js';
import * as cordon from './src/cordon.js';
import * as clipboard from './src/clipboard.js';
import * as prefabs from './src/prefabs.js';
import * as report from './src/report.js';
import * as mirror from './src/mirror.js';
import * as playtest from './src/playtest.js';
import * as tools from './src/tools.js';
import * as custompanels from './src/custompanels.js';
import * as viewstate from './src/viewstate.js';
import * as viewhud from './src/viewhud.js'; // its key and pointer listeners register at import, ahead of the views'
import { $ } from './src/dom.js';

custompanels.mount(); // first: tools' option bars can start in a custom panel, the saved layout puts the panels back
view3d.mount($('#v-3d'));
view2d.mount($('#panels'));
viewstate.mount(); // the camera and 2D views as they were for the map (after view3d and view2d frame it)
details.mount($('#details'));
outliner.mount($('#outliner'));
compile.mount($('#compile'));
texbrowser.mount(); // into layout.pane('textures'), created on demand
aids.mount($('#v-3d')); // after view3d: helpers, hover and the measure tool's capture listener
blockout.mount($('#v-3d'));
importer.mount(); // window drop listeners
commands.mount($('#palette'));
settingsui.mount();
layout.mount($('#workspace'));
custompanels.dock(); // panels dragged out of a custom panel's own dock go back to the main one
// Feature modules. Their panels registered at import (registerPanel), so a saved layout restored them above.
// Builders run in this order (helpers.js's overlay/decal builder registered at import goes first, its icon builder
// last, once tf.fgd has loaded); point-entity boxes (state registerPointLook): models, then instances, then the FGD.
models.mount(); // studio models for props and FGD studio()/lightprop() helpers
modelbrowser.mount();
soundbrowser.mount();
brushtools.mount(); // carve, hollow/transform dialogs, flip, align, snap
polyedit.mount($('#v-3d')); // poly tool: vertex / edge / face editing (1, 2, 3; Shift+V vertices)
cliptool.mount(); // clipping tool (Shift+X)
stairtool.mount($('#v-3d')); // stairs between two edges (Shift+S)
chamfer.mount($('#v-3d')); // chamfer or fill a corner (Shift+C)
rooftool.mount($('#v-3d')); // roof between two walls (Shift+R)
figmaui.mount(); // Figma layout import (.svg drop, figma.import)
disp.mount(); // displacements: 3D surface, 2D outlines, Displacement panel, paint tool
instances.mount(); // func_instance visuals, reload, edit, collapse
helpers.mount(); // entity visuals: FGD boxes and colours, icons, overlays, helper shapes, entity lines
cordon.mount(); // cordon tool, toggle, dimming, select touching/inside
clipboard.mount(); // copy, cut, paste, paste at cursor, paste special
prefabs.mount(); // Prefabs panel, prefab.save
report.mount(); // entity report, go to, map properties, select same visgroup
mirror.mount(); // live mirror of the terrain and decor entities across a plane (Mirror button)
playtest.mount($('#v-3d')); // walk the map as a TF2 class (F5)
viewhud.mount(() => mirror.M.on);
mirror.setModelCorners(models.modelCorners); // twins with a model line up their model boxes // mode, gizmo, snapping, selection in each viewport's corner
tools.mount(); // tool panels: tool options, then Main, Gizmo and snapping and the other sections (after every command is registered)

function status() {
  const name = S.file ? S.file.split(/[\\/]/).pop() : 'untitled';
  document.title = `${S.dirty ? '* ' : ''}${name} - TF2 Editor`;
  window.api.setDirty(S.dirty);
  $('#status').textContent = `${S.file || 'untitled'}   |   ${cache.size} objects, ${sel.size} selected   |   ${[view3d.snapText(), mirror.statusText(), S.coords, S.cursor].filter(Boolean).join('   |   ')}`;
}
const toolbar = () => {
  document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === S.tool));
  $('#ig').classList.toggle('on', !!cfg.ignoreGroups);
  $('#mirror').classList.toggle('on', mirror.M.on);
  $('#grid').textContent = S.grid;
};
for (const t of ['doc', 'selection', 'grid', 'file', 'cursor', 'cfg', 'mirror']) on(t, status);
for (const t of ['tool', 'grid', 'cfg', 'mirror']) on(t, toolbar);
// The top toolbar only with cfg.showToolbar: its buttons are in the Tools panel (Main rollout).
const topbar = () => { document.querySelector('header').hidden = !cfg.showToolbar; };
on('cfg', ({ key }) => { if (key === 'showToolbar') topbar(); });
topbar();
toolbar();
// Main holds the window open while the map is dirty and asks here; closeNow() lets it through.
window.api.onCloseRequest(async () => { if (await confirmDiscard()) window.api.closeNow(); });

if (cfg.lastFile && (await window.api.exists(cfg.lastFile))) await open(cfg.lastFile);
if (!doc.root) newMap();
