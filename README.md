<img src="build/icon.svg" width="96" alt="">

# TF2 Editor

A map editor for Team Fortress 2 on Windows. It opens and saves `.vmf` files that stay compatible with Hammer++, edits them in a 3D view and three 2D views, and compiles them with the Hammer++ compile tools.

## Install

Download `TF2-Editor-Setup-<version>.exe` from [Releases](https://github.com/DashingNights/tf2-editor/releases/latest) and run it. It installs for your Windows account without admin rights, adds Start menu and desktop shortcuts, and opens the editor. The installer is not code-signed, and Windows SmartScreen may stop it the first time: choose More info, then Run anyway. Uninstall it from Settings > Apps.

You also need:

- Team Fortress 2 from Steam. The editor reads its materials, models, and sounds, and the entity definitions in `bin\tf.fgd`.
- For compiling: the Tools++ compilers from the Hammer++ project (`vbsp++.exe`, `vvis++.exe`, and `vrad++.exe`) in `Team Fortress 2\bin\x64`.

The editor finds the TF2 folder through Steam's library list. If the texture browser stays empty, open Settings (Ctrl+,) and set TF2 folder under General.

## Getting around

The window is a dock of panels: the 3D view, the Top, Front, and Side views, the Outliner, Details, Textures, Compile, and the tool panels. Drag a tab to move a panel; Reset layout puts them all back. Every command is in the command palette (Ctrl+K), which also shows its shortcut.

- 3D view: hold the right mouse button to look around and fly with W, A, S, and D (Q down, E up, Shift faster). The wheel moves forward and back; while flying it sets the fly speed. Alt+drag orbits the selection, and F frames the selection or the whole map.
- 2D views: drag with the right or middle button, or hold Space and drag, to pan. The wheel zooms.
- Camera bookmarks: Ctrl+1 to Ctrl+9 save the 3D camera and Alt+1 to Alt+9 go back to it. Hammer++ reads them too.

## Building a map

| Key | Tool or command |
| --- | --- |
| V | Select. A click picks an object, Ctrl+click adds or removes one, and a drag on empty space selects a box |
| B | Block: drag a rectangle in a 2D view to make a brush |
| Shift+E | Entity: click to place one |
| W, E, R, Q | Gizmo: move, rotate, scale, off (Space cycles them) |
| 1, 2, 3, 4 | Edit vertices, edges, faces, or whole objects |
| Shift+X | Clip |
| Shift+S | Stairs or a ramp between two edges |
| Shift+C | Chamfer an outside corner or fill an inside one |
| Shift+R | Roof between two walls |
| [ and ] | Grid smaller and larger (Shift+W turns grid snapping off and on) |
| Ctrl+B | Blockout mode: draw primitives on surfaces in 3D, with dev textures and TF2 scale aids (M measures) |
| Ctrl+Shift+M | Live mirror: the RED half is rebuilt as the reflection of BLU while you edit |
| Shift+T | Texture browser |

The Details panel edits whatever is selected: position, size, and rotation, materials and texture alignment, and entity keyvalues and outputs from the FGD. With nothing selected it sets the material and entity class for new objects.

Undo is Ctrl+Z and redo Ctrl+Y. Ctrl+C, Ctrl+X, and Ctrl+V copy, cut, and paste in place. H hides the selection, Ctrl+H hides everything else, Ctrl+G groups, and Ctrl+U ungroups.

## Saving

Ctrl+S saves the `.vmf` and keeps the previous version as `<map>.vmx`. While there are unsaved changes, an autosave goes to `<map>.vmf.autosave` every 5 minutes. Data only the editor uses, such as favourites and blockout tags, goes to `<map>.vmf.editor.json` next to the map. The `.vmf` stays a plain Hammer++ file.

## Compiling and testing

F9 runs the steps in the Compile panel: VBSP, VVIS, and VRAD, then packing custom content into the BSP and copying it to `tf\maps`. The mode sets the compiler flags: Fast (the default), Normal, Full, or Entities only. Turn on the Run TF2 step to start the game on the map after each compile.

Alt+P looks for brush faces that would come out black in game (sides on almost the same plane) and offers to weld them.

F5 walks the map inside the editor as a TF2 class, with TF2 movement. Shift+F5 starts at the 3D camera.

## Figma layouts

Import Figma layout (SVG) builds a blocked-out map from a top-down layout drawn in Figma and exported as SVG: floors, walls, stairs, roofs, spawn rooms, and the KOTH point. Layer names carry the heights and roles; the rules are in [ROADMAP.md](ROADMAP.md#figma-layout-import). Update from Figma (SVG) merges a newer export into a map you have edited since, and you review each change before it is applied.

## Settings

Settings (Ctrl+,) holds the TF2 folder, autosave, snapping, the 3D view, the compile steps, and a Keys page where any shortcut can be changed. They are stored in `%APPDATA%\tf2-editor\settings.json`. Delete that file to go back to the defaults.

## Running from source

Install Node.js 22 or later, then:

```
npm install
npm start
```

`npm test` runs the tests. Set `TEST_MAP` to the path of a `.vmf` to add the byte-identical round trip on a real map. `npm run dist` builds the installer into `dist\`. [ROADMAP.md](ROADMAP.md) describes the architecture and the planned features.

## License

MIT, see [LICENSE](LICENSE), with two exceptions:

- `src/playmove.js` is a port of the player movement code in Valve's Source SDK 2013. It is under the Source 1 SDK License in [licenses/source-sdk-2013](licenses/source-sdk-2013) and may only be distributed free of charge.
- `src/icons.js` holds icons from [Lucide](https://lucide.dev) under the ISC License; the notice is at the top of the file.

TF2 Editor is not affiliated with Valve. Team Fortress 2 is a trademark of Valve Corporation.
