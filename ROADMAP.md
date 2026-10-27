# TF2 Editor - roadmap and architecture

Electron + three.js level editor for Team Fortress 2 (Source engine). It edits `.vmf` files and runs the Hammer++ compile tools (`vbsp++`, `vvis++`, `vrad++`) under the hood. Goal: every Hammer++ feature, plus a modern Unreal-style workflow (details panel, 3D gizmo, blockout mode, texture browser, drag-and-drop import, live leak detection).

Hard rules:

- The VMF on disk must stay fully compatible with Hammer++. Opening and saving a map without changes must produce a byte-identical file (`test.js` checks this). Editor-only data (camera bookmarks beyond the VMF `cameras` block, favourites, blockout tags) goes in a sidecar `<map>.vmf.editor.json`, never in the VMF.
- No build step, no framework, no TypeScript. Plain ES modules loaded by `index.html`. The runtime dependencies are `three` (includes `examples/jsm`) and `dockview-core`; `electron-builder` only packages the installer (`npm run dist`). Do not add dependencies.
- Keep the existing style: small modules, short functions, comments only where the logic is not obvious.
- Never save over real maps from tests or scripts. Test against `dev/scratch/testmap.vmf` with `TF2EDITOR_USERDATA=dev/userdata` so settings stay isolated.

## Layout

```
main.js          Electron main: window, IPC (file read/write, dialogs, compile spawn, byte-range reads for VPK)
preload.cjs      window.api bridge (contextIsolation on; renderer has no Node access)
index.html       shell: toolbar, dock area, status bar, a hidden stash with one element per panel
style.css        theme tokens and layout
vmf.js           VMF parse/serialize and brush geometry. Pure, node-testable.
src/bus.js       event bus: on(type, fn), off, emit(type, detail)
src/state.js     document, selection, undo/redo, geometry cache, show filters, grid, tool
src/commands.js  command registry + keybindings + Ctrl+K palette
src/view3d.js    three.js scene, camera, picking, gizmo, selection modes
src/view2d.js    top/front/side canvases
src/details.js   details panel (transform, brush, face, entity, outputs)
src/outliner.js  object tree, visgroups, show filters UI
src/compile.js   compile steps, log, leak line
src/fgd.js       FGD parser. Pure, node-testable.
src/vpk.js       VPK directory/file reader. Pure, node-testable.
src/vtf.js       VTF header/mip decoder. Pure, node-testable.
src/materials.js VMT lookup, texture cache, thumbnails, material list
src/settings.js  settings load/save (userData/settings.json), DEFAULTS, SCHEMA
src/settingsui.js Settings dialog (Ctrl+,), recent files, autosave
src/layout.js    dockview layout: panels, default layout, persistence
src/texbrowser.js Textures panel: virtualised grid, search, folder tree, filters, drag-to-apply, find and replace
src/import.js    drag and drop: .vmf opens, images become VTF + VMT under tf/custom/<project>, info_overlay on Alt-drop
src/vtfwrite.js  VTF 7.2 writer (DXT1/DXT5/BGRA8888, mips) and TGA decoder. Pure, node-testable.
src/pack.js      content the map references, resolved against the game; bspzip addlist for the '@pack' compile step
src/primitives.js blockout primitives (box, ramp, stairs, cylinder, arch, doorway, room). Pure, node-testable.
src/blockout.js  blockout mode: toolbar, draw in 3D, presets, repeat duplicate, nodraw hidden faces
src/aids.js      TF2 scale aids in 3D: player box, measure tool, jump bands, sentry range
src/brushtools.js carve, hollow and transform dialogs, flip, align, snap selection to grid
src/polyedit.js  poly tool: vertex / edge / face editing of brushes (1, 2, 3; Shift+V vertices), gizmo, operations, options panel
src/polygeo.js   poly edit geometry: brush <-> polygon mesh, planar faces, convex pieces, extrude / inset / bevel / chamfer / connect. Pure, node-testable.
src/cliptool.js  clipping tool (Shift+X)
src/stairtool.js stairs tool (Shift+S): pick two edges, preview, options panel over the 3D view
src/stairgeo.js  stairs and ramps between two edges: straight or curved along a walking line, fitted to walls. Pure, node-testable.
src/chamfer.js   chamfer tool (Shift+C): pick corner edges in 3D or 2D, options bar over the 3D view, preview, apply
src/chamfergeo.js corner analysis, In (clip an outside corner) and Out (wedges in an inside corner), flat or round. Pure, node-testable.
src/rooftool.js  roof tool (Shift+R): pick a face on two walls, the second suggested across the gap, preview, options panel
src/roofgeo.js   roof slab between two walls: the gap and the wall tops, flush, flat or sloped. Pure, node-testable.
src/poly2d.js    2D polygon helpers: hull, half-plane and convex clips, convex difference, ray hits, convex decomposition, partition (pieces cut again into few convex ones). Pure, node-testable.
src/svgread.js   SVG reader: elements, paths (curves flattened), transforms, paint, layer names from ids. Pure, node-testable.
src/figmaimport.js Figma layout (SVG shapes) to blockout brushes: floors, walls along their lines, stairs, landings, blocks, mirror. Pure, node-testable.
src/figmaui.js   Figma import dialog, .svg drop and figma.import command; replaces the Figma visgroup in one undo step; update (diff, apply) and adopt
src/figmadiff.js Figma update: unit hashes, three-way classification, adoption matching, row descriptions. Pure, node-testable.
src/figmareview.js Figma changes panel and the diff drawn in the 3D and 2D views (accept / reject, N / P / A / R / B)
src/dispgeo.js   displacement grids: parse/write dispinfo, create, paint, smooth, sew. Pure, node-testable.
src/disp.js      displacements: 3D surface (builder), 2D outlines, Displacement panel, paint tool
src/mdl.js       MDL/VVD/VTX reader, posed at frame 0. Pure, node-testable.
src/models.js    studio models in 3D (builder), models/ and sound/ file index, model boxes, FGD defaults for new entities
src/modelbrowser.js Models panel; src/soundbrowser.js Sounds panel (Web Audio playback)
src/lighting.js  map lights as vrad reads them. Pure, node-testable.
src/helpers.js   entity visuals: FGD boxes and colours, icon sprites, overlays and decals, helper shapes, entity lines
src/cordon.js    cordons: tool, toggle, dimming, the sealed cordon_compile export
src/instances.js func_instance: drawn from its file, box, collapse with vbsp's name fixups
src/clipboard.js copy, cut, paste, paste at cursor, paste special (VMF snippets on the system clipboard)
src/prefabs.js   Prefabs panel (cfg.prefabDir)
src/report.js    entity report, go to coordinates or id, map properties, select same visgroup; form() modal
src/mirrorgeo.js live mirror geometry: reflect a solid (readable textures, displacements), side of the plane, pairing by geometry. Pure, node-testable.
src/mirror.js    live mirror of the terrain (Mirror button): edit hook, BLU to RED, plane and twin drawing, commands
src/playmove.js  playtest movement and collision: Source / TF2 player movement against the map's brushes. Pure, node-testable.
src/playtest.js  playtest (F5, toolbar Playtest): class picker, input, first-person camera, HUD
src/mirrorgeo.js live mirror geometry: reflect a solid (readable textures, displacements) or a point entity (origin, angles), side of the plane, pairing. Pure, node-testable.
src/mirror.js    live mirror of the terrain and decor entities (Mirror button): edit hook, BLU to RED, plane and twin drawing, commands
dev/cdp.mjs      drives the running app over the DevTools protocol (see "Testing")
test/*.test.js   node --test
```

## Module contracts

These are the minimum exports. Modules may export more. Other modules talk to `state.js` through these functions and the bus, never by reaching into each other's internals.

### vmf.js

Existing: `parse`, `serialize`, `get`, `set`, `kids`, `nums`, `plane`, `faces(solid)`, `bounds(faces)`, `transform(node, scale, translate)`, `block(min, max, material, nextId)`, `entity(classname, origin, nextId)`, `clone(node, nextId)`.

To add:

- `rotate(node, pivot, axis, degrees)` - rotates a solid or entity (solids inside it too, and `angles` on point entities). Texture lock: rotates `uaxis`/`vaxis` with the geometry.
- `transform` gains texture lock on scale (scale the axis vectors so the texture stays attached).
- `snapVertices(solid, grid)` - rebuilds planes from grid-snapped points; returns false if the brush would become invalid.
- `valid(solid)` - true when every side yields a polygon, the brush is convex and closed.
- `clip(solid, plane, nextId)` - returns up to two solids (front/back).
- `hollow(solid, thickness, nextId)` - returns the wall solids.
- `uv(face, texW, texH)` - texture coordinates per vertex from `uaxis`/`vaxis` (the formula: `u = (dot(p, axis.xyz) / scale + shift) / texW`).
- `tie(root, world, solids, classname, nextId)` / `untie(root, world, entity)` - move solids between the world and a brush entity.
- `brush(polys, material, nextId)` - convex solid from face polygons (any winding); `material` is a name or `fn(normal) -> name`.

Added with the Hammer tools: `split(solid, q, src, world)` (clip's two pieces with old ids; the cut face copies src's look, world-aligned axes with world), `carve(target, cutter, nextId)` (pieces outside the cutter; `[]` swallowed, `null` no overlap; `hollow` is built on it), `fromPoints(solid, facePoints)` (vertex edit; false and unchanged when a face bends or the brush is not convex), `boundsOf(node)`, `alignTo(nodes, 'min'|'max'|'center', axis, texLock)`, `snapToGrid(nodes, grid, texLock)` (moves each node, sizes stay). Mirror is `transform` with a -1 scale; it re-indexes displacement grids (`dispgeo.mirror`) and, like `rotate`, carries an `info_overlay` basis.

Displacements and Hammer++ corners under edits: `clip`, `carve` and `hollow` drop the `dispinfo` and `vertices_plus` of every side whose face the cut changes; `fromPoints` keeps a displacement while its face keeps 4 corners (the start corner follows) and drops `vertices_plus` from every reshaped side. Carve and hollow skip displacement brushes.

Face ids: `clone(node, nextId, ids)` records old side id -> new ids in the optional Map `ids` (`clip` / `carve` / `hollow` take it too); `remapSides(entity, ids, drop)` rewrites `sides` / `sides2` (info_overlay, info_overlay_transition, env_cubemap) through it, and `namesSides(entity, ids)` tests for it. Paste, clone, collapse, clip, carve and hollow use them so overlays follow their faces (`state.sideUsers(ids, keep)` lists the map's entities to rewrite).

Round trip details: a key that follows a child block (Hammer++ writes `vertices_plus` between `"plane"` and `"material"`) keeps its place (`node.at` on the children before it), and `set(side, 'plane', v)` with a new plane drops the side's stale `vertices_plus`.

### state.js

- `doc` - `{ root, world }` after `load(text, file)`. `serialize()` returns the VMF text.
- `S` - `{ file, dirty, grid, tool, mode, cursor, history }`. `mode` is `'object' | 'face'` (Hammer face mode with the select tool) or the poly tool's level `'vertex' | 'edge' | 'face'`. `history` is `'edit'`, `'undo'` or `'redo'` during the `'doc'` event an edit, undo or redo causes.
- `sel` - `Set` of solid or entity nodes. `faceSel` - `Set` of side nodes (face mode).
- `setSelection(nodes)`, `toggle(node)`, `setFaceSelection(sides)`, `clearSelection()`.
- `edit(deepNodes, shallowNodes, fn)` - runs `fn`, snapshots the nodes for undo, marks them dirty, calls `sync()`. Deep nodes get their children cloned (use for solids and entities whose sides or kv change); shallow nodes get their child list copied (use for containers whose child list changes).
- `undo()`, `redo()`, `mergeUndo()`. `depth()` - steps made and not undone (dropped ones included): the poly tool keeps its own edit-mesh steps in order with the map's by it.
- `replaceSolids([[solids, pieces]], { group = true, ids })` - poly edits: `solids` is one solid or the pieces of an earlier edit; solid k takes piece k's keys and children in place (node kept), solids left over are removed, pieces left over follow the last kept solid in the same list (world or brush entity); a world solid outside any group that becomes several pieces gets a new group; `ids` remaps overlays. One undo step.
- `cache` - `Map<node, { node, owner, faces, min, max, color2d, mesh, point }>`. `owner` is the entity node (or `world`) that contains the solid; for point entities `owner === node`.
- `sync()` - rebuilds dirty cache entries, applies visibility, emits `'doc'`.
- `filters` - `{ world, detail, entities, triggers, clips, skybox, tools, displacements, models }` booleans, plus `hiddenVisgroups` (`Set`) and `hidden` (`Set` of hidden nodes: the ones inside `hidden` wrappers, kept in step by `sync()`, plus session-only hides). `isVisible(entry)` combines them.
- `objects()` - top-level objects (world solids and entities, hidden ones included). Use it instead of `V.kids(world, 'solid')` / `V.kids(root, 'entity')`, which miss hidden objects.
- Hide: `hide(nodes)`, `hideSel()`, `unhideAll()` move objects into and out of `hidden` wrappers (one undo step each). Groups: `groups()`, `withGroup(n)`, `clickSelect(n, ctrl)`, `groupSel()`, `ungroupSel()`. See "Extension hooks" below.
- `nextId()`.
- `extra` - editor-only data that belongs to the map (`[key, value]` pairs on a node outside the document; the Figma base). Change it with `edit([], [extra], fn)` so undo restores it, and replace values, never change them in place; it goes in the sidecar's `extra` when the map is saved, so the sidecar always matches the VMF on disk. `editCount()` - undo steps added so far: an operation made of several edits merges what it added (`mergeUndo`).
- `movable(ns = sel)` - the objects an operation moves: a brush entity stands in for its solids when all are given.
- `registerPointLook(fn(node) -> { box: [min, max], color } | null)` - a point entity's box (2D views, picking, selection box, cordon tests) and 2D colour; the first box and the first colour win (models.js: model bounds, instances.js: instance contents, helpers.js: FGD `size()` / `color()`). `touch(nodes)` rebuilds those entries on the next tick (one `'doc'`), e.g. after a model has loaded.
- `setEntityDefaults(fn(classname) -> [[key, value]])` - keys a new entity gets before `origin` (models.js sets the FGD defaults, as Hammer writes them).
- `nodesOf(obj)`, `addObjects(objs, remove)` (paste, prefabs, instance collapse: one undo step, new group ids), `showWorld()` / `S.showWorld` (the Details panel shows worldspawn until the selection changes). `deleteSel()` removes group blocks left without members.
- Operations: `transformSel(scale, translate)`, `rotateSel(axis, degrees, pivot)`, `deleteSel()`, `cloneSel()`, `createBlock(min, max)`, `createEntity(origin)`, `applyMaterial(name, { solid, side })`, `selBox()`, `addSolids(solids)` (one undo step, then selects them).
- `S.lastDup` - the translation of a move that directly followed `cloneSel` on the same selection (repeat duplicate), reset on load and disarmed by any other edit.
- While `cfg.blockout` is on, `createBlock` and `addSolids` give new brushes dev textures by face direction and put them in the visgroup of the first selected object that has one (with its colour).
- Bus events: `'doc'` (geometry or kv changed; detail: changed nodes), `'selection'`, `'tool'`, `'grid'`, `'filters'`, `'file'` (loaded or saved), `'sidecar'` (an opened map's sidecar was read).
- `setEditHook(fn(snaps, take, same))` - runs after every `edit()` that changed something, before its undo step is stored; `take(node, deep)` snapshots a node the hook is about to change, so the change joins the same step (mirror.js). `change(fn(take))` - one undo step from changes fn snapshots itself with `take`; no hook. `sideData` (key -> JSON value) is saved in the sidecar with `saveSidecar()` and cleared on load.

### commands.js

- `register(id, { title, run, keys = [], when })` - one entry per user action. Toolbar buttons, keybindings and the palette all read from this registry. `keys` are strings like `'ctrl+shift+s'`, `'w'`, `'f9'`; `cfg.keys` in settings overrides them (`{ "focus": ["ctrl+d"] }`).
- `run(id)`, `list()`.
- Ctrl+K opens a palette: fuzzy search over titles, shows keys, Enter runs.

### view3d.js

- Owns the scene, camera and `TransformControls` gizmo. Reads `cache` and `sel` from state; writes only through state operations.
- Exports `focus(box)`, `pick(x, y)`, `setRenderMode(mode)`, `fan(faces)`, `rayAt(x, y)`, `addHelper(obj)` / `removeHelper(obj)` (drawn, never picked), `onHover(fn(hit, x, y))` (once per frame, returns unsubscribe), `setDrawHook({ start, move, up, press, cancel, busy })` (blockout drawing), `invalidate()`, and the extension hooks `registerTool`, `registerBuilder`, `refreshEntry` (batched per task), `setDimmer(fn(entry) -> bool)` (cordon.js: a faint grey visual in every render mode; returns the dimmer it replaces, so the Figma review dims on top of the cordon's and puts it back) (see "Extension hooks").
- Render modes `textured`, `flat`, `wireframe`, `lit` (`view.renderLit`: Lambert copies of the materials lit by the map's light, light_spot and light_environment entities, the sun with one shadow map; lighting.js reads them like vrad). Selected builder visuals get a red tint on their own meshes plus a bounding box; in face mode the triangles of selected faces (`userData.tri`) are tinted.

- Alt+right-click applies `cfg.material` to the face under the cursor. `view.slopeTint` toggles `cfg.slopeTint` (faces with 0 < normal z < 0.7 tinted red). On load the camera starts 96 units above the first `info_player_teamspawn` (over its player model), facing its angles.

### materials.js

- `getMaterial(name)` - returns a `THREE.Material` immediately (flat placeholder colour), swaps in the texture when loaded; cached by lower-cased name.
- `getTextureSize(name)` - `{ w, h }` or null until known (needed for UVs).
- `listMaterials()` - sorted names from `tf2_textures_dir.vpk`, `tf2_misc_dir.vpk`, `hl2_*`, `tf/materials`, `tf/custom/*/materials`.
- `thumbnail(name, size)` - data URL, cached on disk under userData; the last 3000 are kept in memory.
- `customMaterials()` - Set of the names that come from `tf/custom` (folders or VPKs).
- `addLoose(key, absPath)` - adds a file written after indexing (`'materials/foo/bar.vmt'`); what was loaded for that name loads again.

## Feature spec

### Details panel (Unreal-style)

Top shows the selection (name, type, count) and a search box that filters rows. With a multi-selection, fields whose values differ show `--`; typing a value applies it to all.

- Transform: Location, Rotation, Size rows with X/Y/Z fields coloured red, green, blue. Drag a label to change the value in grid steps (Shift fine, Ctrl coarse). Up/Down in a field adds or subtracts a grid step. Fields accept maths (`=128*3`) and relative values (`+64`). A lock on Size keeps proportions. An anchor setting (center, min, bottom-center) controls which side stays fixed. Reset arrow per row. One drag is one undo step.
- Brush: material with thumbnail and browse button, "apply to all faces", type dropdown (World, func_detail, func_brush, trigger_multiple, ...) which ties or unties in one click, visgroup tags.
- Face (face mode): UV scale, shift, rotation; lightmap scale; justify (fit, left, right, top, bottom, center); align to world or face; texture lock toggle.
- Entity: fields built from the FGD. `choices` become dropdowns, `flags` become checkboxes, `color255` gets a colour picker, `target_destination` lists existing targetnames with an eyedropper to pick in the viewport, `studio`/`sound` get browse buttons, `angle` gets a dial. FGD descriptions are tooltips. A toggle shows raw keyvalues.
- Outputs: table (output, target, input, parameter, delay, fire once) with autocompletion from the FGD. Broken targets in red. An Inputs tab lists entities that target this one.

### 3D viewport

- Gizmo: W move, E rotate, R scale, Q none (Unreal keys). Move snaps to the grid, rotate to 15 degrees (Shift 5), scale snaps the resulting brush size to the grid. Space cycles modes. Local/world toggle (Ctrl+`), local by default.
- Objects keep their own angle: a selection's angle about z is the way its upright faces mostly run (by area; the world axes win a tie), so a diagonal wall or a slanted flight, imported or turned by hand, keeps it. In local space the gizmo, its scale handles and the pivot (the centre of the selection's own box) follow it, and the top view draws the selection's own box with its sizes and handles; dragging them scales along those axes (the size snaps, the other side stays). The front and side views keep the world box.
- Selection modes: 1/2/3 the poly tool's vertex, edge and face levels (see "Poly tool"), 4 objects. Hover highlight. Box select by dragging on empty space (Ctrl adds, Alt removes).
- Push/pull: in Hammer face mode (the select tool with `mode` 'face', e.g. after Textures: select faces using), drag a face along its normal to resize the brush. Ctrl+drag extrudes a new brush from the face. The poly tool's face level does the same with its own drags.
- End drops the selection to the surface below. Hold V to snap to vertices of other brushes.
- Camera: right-drag look with WASD/QE, wheel while right-dragging changes speed, Alt+left-drag orbits the selection, F focuses. Ctrl+1..9 saves camera bookmarks in the VMF `cameras` block (Hammer++ reads them), 1..9 restores.
- Show filters (in outliner): world, detail, entities, triggers, clips, skybox, tools, displacements, models.
- Render modes: flat, textured, wireframe, lightmap density, simple lit (uses `light_environment` angles).

### Blockout mode

A toggle that changes defaults for greyboxing: draw brushes in 3D by dragging a footprint on any surface, releasing, moving the mouse for the height and clicking to place (Esc cancels); auto dev textures by face direction; primitives (box, ramp, stairs, cylinder, arch, doorway) with presets; TF2 scale aids (48x48x82 player box following the cursor, measure tool, slopes steeper than 45.6 degrees tinted red, jump-height bands, sentry range sphere); Ctrl+D repeats the last duplicate offset; convert selection to `func_detail`; nodraw hidden faces.

- Keys and commands: Ctrl+B `blockout.toggle`, Ctrl+D `blockout.repeat`, `blockout.nodraw`, `blockout.<primitive>`; aids: M `aids.measure`, `aids.player`, `aids.jump`, `aids.sentry`, `aids.all`, Escape `aids.clearMeasures`.

### Poly tool

3ds Max's Editable Poly on brushes (`src/polyedit.js`, geometry in `src/polygeo.js`). Keys 1 / 2 / 3 enter the vertex, edge and face levels (`mode.vertex`, `mode.edge`, `mode.face`; toolbar Vertex / Edge / Face); 4, Escape or the active level's key again go back to objects; Shift+V toggles the vertex level (it replaced the old vertex tool). It edits every selected brush at once (world and brush entity solids); a click off the edited brushes selects another brush (at the face level it picks the face under the cursor in the same click; Ctrl adds just that brush and face).

- Selection: click, Ctrl+click adds, Alt+click removes; a drag on empty space box-selects (left to right: wholly inside, right to left: touching; Ctrl adds, Ctrl+Alt removes; Alt alone still orbits), in the 3D and 2D views (2D: stacked vertices and edges together, faces by their centre square, the one facing the view). Ctrl+A all, Ctrl+PgUp / Ctrl+PgDn grow / shrink, Alt+L / Alt+R edge loop / ring (Max's rules: loops go on through vertices with four edges, rings across quads), double-click: loop (edges) or the whole brush. Sticky (on by default): the same element of a touching brush (same spot: vertex, both ends of an edge, all corners of a face), selected or not, is selected along, so connected brushes stay connected; brushes with a displacement are left out (a changed face would lose it). The lookup uses a position-key map and a 256-unit cell hash, so selecting every vertex of a whole map takes a fraction of a second. Each level keeps its own selection; undo and redo bring it back.
- Transform: the poly gizmo (W move, E rotate, R scale, Q none: drags select) in local space (z along the selection's normal; Ctrl+` world) about the selection's centre or the brushes' centre (option Pivot). Move snaps the selection's corner to the grid (local: the offset), rotation to the rotation step, scale the selection's extents to the grid; Shift is fine. With a gizmo mode, dragging an element moves it: a face along its normal (Ctrl or Shift drag extrudes), a vertex or edge in the axis plane facing the camera; 2D drags move along the view's axes; arrows nudge. The Details panel's Poly section moves the selection to a centre or by an offset, rotates and scales it. Every drag previews live (the result's convex pieces textured, red when refused) and is one undo step.
- Operations (options panel at the bottom of the 3D view, `cfg.poly`): faces: Extrude (Shift+E; Group, Local normal or By face), Inset (Shift+I), Bevel (Shift+B; height and outline), Delete (the neighbours' planes close the brush; refused when they cannot), Detach (a slab the given thickness under the face becomes its own brush); edges: Chamfer (Shift+C; distance, segments round an arc), Connect (Ctrl+Shift+E; segments), Remove (Backspace or Delete), Collapse (Ctrl+Alt+C), Split (the slice below); vertices: Weld (within a distance), Collapse, Chamfer, Snap to grid, Remove, Slice (the brushes holding the selection cut by the plane through the selected vertices or edges; one edge or two vertices: the plane through them along the view). An edge chamfer stops at the far corners of the faces next to the edge. Plane edits (chamfer, delete, detach, slice) cut each convex piece of a split shape with the elements under the selected ones (convex edges only); the pieces are edited one by one after that.
- Brushes stay valid without limiting the edit: close vertices weld (a face that collapses onto a line leaves its corners in its neighbours' open edges); a bent face splits into triangles (the triangulation with the fewest concave folds: every one up to 8 corners, fans past that) merged again where coplanar; a concave result becomes the fewest convex pieces the BSP finds (face planes and planes through coplanar concave edges, tried with and without the latter; pieces merge while their union stays convex), kept in the brush's owner and visgroups and grouped when a world brush outside a group. Refused (red preview, status message): no volume, crossing faces, faces facing the same way overlapping on one plane, or a fold leaving corners off the pieces (an inset face dragged past its ring). Faces facing each other may meet: a dent pulled out through a face opens a notch. The first piece keeps the brush's id; unchanged faces and unchanged seams between pieces keep their side (vertices_plus included), changed ones drop vertices_plus. A displacement face moved as a whole keeps its displacement (start position moved along); an edit that reshapes one asks first (the touching brushes of Sticky never lose one). Texture lock: a face that moves or turns as a whole carries its texture; a stretched or reshaped face keeps its axes (no stretched textures), and so does a side whose parts move differently (an inset face moved in its plane); new faces get world-aligned axes.
- Edit meshes: the poly tool keeps the mesh of each edit for the solids it made (`session`: solid -> `[{ pieces, sigs, m }]`, newest last), used while each piece still has the planes the edit gave it. So the convex pieces of a concave edit stay one shape (an edit of the dent rebuilds all pieces from that mesh: back where it was, it is one brush again; piece k keeps old piece k's node and id), Inset and Connect keep the faces they split (the brush itself cannot hold coplanar parts), and an undone edit finds the mesh from before it. Edits that change only the mesh (Inset, Connect) are undo steps of their own, kept in order with the map's through `depth()`.
- Hooks used: `registerTool` with `drawsSelection` (view3d draws no object tint, face highlight or vertex dots), view2d `registerTool` / `registerOverlay`, details `registerSection`, state `replaceSolids`.

### Stairs tool

`tool.stairs` (Shift+S, toolbar Stairs): click two horizontal brush edges in the 3D view, the lower and the upper floor's edge, in any order. With one edge picked, a spot on a floor away from its edges gives a start line through the pointer, parallel to the first edge and snapped to the grid. The result previews in every view while picking; Enter or Create builds it as one undo step (grouped when Group is on); Escape drops the picks (again: back to Select); Backspace drops the last pick. Options (`cfg.stairs`): Stairs or Ramp, step count (0: risers of at most 16 units), Fit walls, Long way, Solid, Group.

- Heights come from the edges: the lower edge is the bottom. N risers of whole units, at most 16 high, and enough of them that treads are at most 32 deep along the walking line (a long, low run gets many shallow steps); N - 1 treads; the upper edge is the last riser. A step count overrides this.
- Edges parallel in plan (within 2 degrees): straight stairs, risers parallel to the edges. Otherwise curved stairs laid out like a real curved staircase. A walking line runs from the middle of the lower edge to the middle of the upper one, leaving and entering each edge square to it and turning round P, the point where the edge lines cross (Long way: round the other side, more than half a turn, for spirals). Its heading changes along it as h0 + sweep * u + bend * u * (1 - u), so its curvature changes evenly (a piece of an Euler spiral); bend is solved so it ends on the upper edge's middle, and is 0 (a circular arc round P) when both edges are the same distance from P. Every riser is square to the walking line, so risers fan out from the curve's centre and treads are equally deep along the walking line. The width blends from one edge's length to the other's with level ends (smoothstep), so the sides carry on each corridor's walls. Edges whose lines cross inside an edge are refused.
- Where the turn is too tight for the width, riser lines would cross inside the stairs: the inside then pivots on one point like winders round a newel post (warned), and short of half a turn nothing reaches past either edge line. A curved ramp stops 8 units short of such a point.
- Fit walls: walls inside the stairs cut the treads back. Walls stretch them only where they enclose a side within 128 units (each side of straight stairs; for curved stairs a side all along the walking line, wall corners included), so a stairwell or a central column fills to its walls while stairs in the open keep their width. Walls are solid brushes overlapping the stairs' height range; the brushes of the picked edges, tool-textured brushes and triggers do not count. Where something stands across the walking line, the stairs are left open there.
- Every tread is cut into convex pieces (one brush each; a side bending into the tread by at most 2 units is built straight, so a curved tread stays one brush). A curved ramp is split into triangles so every face stays flat. Warnings: treads under 8 units deep, ramps steeper than 45.57 degrees, something standing inside the stairs, a turn too tight for the width.

### Chamfer tool

`tool.chamfer` (Shift+C, toolbar Chamfer): point at a brush edge in the 3D view (the face's edge nearest the pointer) or a 2D view (an edge seen end on, such as a wall corner in the top view, wins), click to pick that corner, Shift+click adds another or drops a picked one. The bar over the 3D view (`cfg.chamfer`): Size (distance along each face from the corner; wheel over the field, Ctrl+wheel over any view or drag its label: grid steps, halving at and below one grid step down to 1; any value typed), Segments (1: a flat bevel; more: a round fillet of flat facets along the arc tangent to both faces), Adjacent material (off: new faces get the current material, world-aligned). The result previews in every view; Enter or Apply builds it as one undo step, Escape drops the picks (again: back to Select), Backspace drops the last pick.

- A corner is a line where two faces meet at an angle; edges of several brushes on one line are one corner, and what is solid round it is the union of the visible brushes (tool brushes and triggers do not count). The corner sets the mode: In on an outside corner, Out on an inside one (the bar says which). The other way round has no bounded shape: a notch behind both faces of an inside corner would meet the room only along the edge.
- The corner's run along the line is where both faces run (coplanar faces of other brushes joined) and still bound the solid, tested in each stretch between the heights where a nearby brush starts or ends. So it stops where something covers a face, such as the floor at a pillar's foot or a brush on a wall top. The picked corner is drawn over that run.
- In: every brush whose part in front of the facets lies between the two face planes and that overlaps the run is clipped (a brush wholly inside is removed). A brush running on past an end of the run is split there first and the part past it is kept as it is; its new end takes the look of a face on that plane facing it (the floor top round a pillar), else the corner's material; the new faces take the brush's own face on either plane, its material and its axes turned about the seam, so the texture runs on round the corner. Out: one convex wedge per facet (a fan from the corner line) over the run both faces share where the corner is empty (from the floor up, as high as the lower wall); material from the faces, a cap from a coplanar face (the walls' tops); the wedge copies the first face's brush editor block (visgroup, colour) and goes in its func_detail when both faces are func_detail, else in the world.
- Refused: a size past either face's end (or where it bends) anywhere along the run (near both ends and in the middle of each stretch), a cut that would open the corner through to the other side (0.05 behind each facet the brushes must cover it from end to end, and the points where facets meet, at the same heights), faces that are flat or more than two faces meeting, something already filling the corner, displacement faces.
- Inner fillet points on a corner along an axis are rounded to whole units from the corner, unless that would bend the chain of facets the wrong way or past a face (a nearly flat corner): then they stay on the arc. The corner point is taken a whole number of units along the edge, so new planes stay on the edge's grid.

### Roof tool

`tool.roof` (Shift+R, toolbar Roof): click a face on one wall (its inner side or its top), then one on the wall across the gap. After the first pick the face straight across the gap is suggested (blue; a horizontal ray from the wall's inner side, just under its top and at mid height, to the first face facing back): a click on it, or anywhere that gives no roof, or Enter takes it; hovering another face that gives a roof previews that one. Enter or Create builds it as one undo step (a func_detail, or with func_detail off world brushes, grouped); Escape drops the picks (again: back to Select), Backspace drops the last pick. Options (`cfg.roof`): height Flush / Flat / Slope, thickness (16), Wall tops, Extend, func_detail.

- Each wall's inner face is the upright face toward the other wall (the picked face when it faces it, so a top or outer face works too). In plan the faces are two segments; where one runs on past the other's end it is cut back to it (Extend: the other is carried on along its line). The gap is the quad between the segments (convex pieces if it is not convex); ends of angled walls lying between the two square lines count as level and are joined straight.
- Wall tops: each wall's plan outline between the two end lines, out to its outer faces. Pieces at the same heights whose union is convex merge, so a straight corridor is one brush.
- Heights: Flush puts the bottom at the lower wall's top (a higher wall it does not reach stands through, face to face). Flat puts it at the higher top and runs the part over the lower wall down to it (without Wall tops, that part still closes the gap). Slope runs the bottom from one wall's top edge to the other's (a non-planar gap, angled walls, splits into triangles), the wall tops flat. Top faces DEV/DEV_MEASUREGENERIC01, the rest the first wall's material.

### Textures

- Read `tf2_textures_dir.vpk`, `tf2_misc_dir.vpk`, `hl2_textures_dir.vpk`, `hl2_misc_dir.vpk` plus loose files in `tf/materials` and `tf/custom/*`. Parse VMT for `$basetexture`, `$translucent`, `$alphatest`, `$color`, `$nocull`, `include`/patch. Decode VTF headers; upload DXT1/DXT3/DXT5 as compressed textures (`WEBGL_compressed_texture_s3tc`), decode other formats to RGBA on the CPU.
- Browser: virtualised grid for 30k+ materials, fuzzy search, folder tree, filters (used in map, recent, favourites, tools, custom), thumbnails cached on disk.
- Drag a thumbnail onto a face to apply; Shift applies to the brush. Find and replace across the map. Select all faces using a material.
- Keys: Shift+T shows the panel (`textures.show`), Ctrl+Shift+T searches (`textures.find`), Ctrl+Shift+R finds and replaces (`material.replace`); `select.byMaterial` has no key. Tiles drag with the type `application/x-tf2-material` (and `text/plain` with the upper-case name). Favourites, the last 30 applied materials and the thumbnail size live in `cfg.favourites`, `cfg.recentMaterials`, `cfg.textureThumbSize`.

### Image import

- Drop an image on the texture browser: dialog for name, folder, shader (`LightmappedGeneric`, `UnlitGeneric`), surfaceprop, transparency; resize to power of two; write VTF + VMT to `tf/custom/<project>/materials/`.
- Drop on a face: import then apply. Alt+drop: create an `info_overlay` sized to the image.
- Compile step "Pack" (`@pack` in the step list): `pack.prepare` writes `<map>.pack.txt` and the step runs `bspzip -game <tf> -addlist`; loose files under `tf/custom/*` and `tf/` that are in no VPK get packed. `compile.checkContent` ("Check content" in the Compile panel) lists what the game cannot find.
- Drop a `.vmf` on the window: open it.

### Leak detection and diagnostics

- Live seal check: after save or 2 s idle, run `vbsp++ -onlyents`-style quick pass on a temp copy in the background. Badge shows Sealed or Leak. Clicking it flies the camera along the `.lin` line and highlights the leaking entity and the exit point.
- Problems panel: invalid brushes, off-grid vertices, missing materials, broken output targets, duplicate names, out of bounds, TF2 checks (spawns per team, respawn rooms, control points). Click selects and focuses. Compile log errors land in the same list.
  - Built so far (`src/weldgeo.js`, commands in `report.js`): `map.checkProblems` (Alt+P, Hammer's Check for problems) finds brush sides on almost, but not exactly, the same plane (within 0.15 degrees and 0.75 units, either way round) and sides that repeat their brush's plane (vbsp "duplicate plane"); its dialog offers Weld planes or selects the brushes. `map.weldPlanes` puts each group on the plane with the most face area (the 3 points reversed for sides facing the other way) and drops the repeated sides, as one undo step; a brush that would lose or flatten a face, or move more than a unit, keeps its planes. Why: vbsp merges near-identical planes and can give a face the plane facing into its own brush, so VRAD lights it from behind and it comes out black (one Figma-imported map had 20 such faces, 3 after the weld).
- Compile: Fast, Normal, Final profiles; runs in the background with progress per stage; BSP limit meters; cubemap build step; run-in-game reuses the open game.
- Vis portal viewer for `.prt`.

### Hammer++ features

Done (commands and default keys):

- Brushes: `tool.vertex` (Shift+V; the poly tool's vertex level, see "Poly tool"), `tool.clip` (Shift+X; X or Shift+X cycles both / front / back, Enter applies, Escape cancels), `brush.carve` (Ctrl+Shift+C), `brush.hollow` (dialog), `brush.transform` (Ctrl+M; move, rotate, scale), `brush.flipH` / `brush.flipV` (Ctrl+L / Ctrl+I, on the axes of the 2D view under the pointer last), `align.left|right|top|bottom|center`, `brush.snapToGrid` (Ctrl+Shift+B, each object; Hammer's Snap selected to grid individually), `brush.snapSelection` (one move for the whole selection), `snapVertices`.
- Groups and visibility: `group` (Ctrl+G), `ungroup` (Ctrl+U), `select.ignoreGroups` (the Ig button; clicks then select single solids instead of groups and brush entities), `hide.selected` (H), `hide.isolate` (Ctrl+H, saved like H), `hide.unhideAll` (U).
- Displacements: `disp.create` (power from `cfg.dispPower`), `disp.destroy`, `disp.sew`, `disp.selectAll`, `disp.paint` (geometry, alpha, smooth with Shift, Ctrl inverts); the Displacement panel.
- Entities: studio models (`models.show`, `models.find`, Browse on `studio` keys in Details), sounds (`sounds.show`, `sounds.stop`, Browse on `sound` keys), FGD boxes, colours, icon sprites, lightprop models, helper shapes of the selection, `view.entityLines` (targets, parents, outputs), info_overlay and infodecal quads.
- Map: cordons (`tool.cordon`, `cordon.toggle`, `cordon.fromSelection`, `select.touching`, `select.inside`; the compile uses `cordon_compile/<map>.vmf` sealed with a 16-unit tools/toolsskybox shell), func_instance (`instances.reload`, `instances.edit`, `instances.collapse`), prefabs (`prefab.save`, Prefabs panel), `edit.copy` / `edit.cut` / `edit.paste` (Ctrl+C / X / V), `edit.pasteAtCursor` (Ctrl+Shift+V), `edit.pasteSpecial`, `map.entityReport`, `map.goto` (Ctrl+Shift+G), `map.properties`, `select.sameVisgroup`.

Not yet: Hammer's split face / split edge (Ctrl+F), displacement subdivide / noise / tag tools / power change, model sequences and body groups, more than one editable cordon, paste special grouping and name options, model wireframes in the 2D views, the decal and overlay tools (place by clicking a face), sprite sizes from the texture, light falloff that matches vrad.

Builder order (first non-null wins): helpers.js's overlay / decal builder (registered at import), models.js, disp.js, instances.js, then helpers.js's icon builder once tf.fgd has loaded; anything else gets the default box or brush mesh. Point looks: models, instances, then the FGD. details.js, models.js and helpers.js share one parse of tf.fgd (`fgd.shared`).

### Live mirror (terrain and decor entities)

`mirror.toggle` (Ctrl+Shift+M, toolbar Mirror) mirrors the terrain across a plane, x = 0 by default (`mirror.axis` switches X / Y, `mirror.fromSelection` puts the plane through the selection centre). Terrain is world and func_detail solids (any material, so clips mirror too, hidden ones excepted). Decor point entities are mirrored too (see below; `mirror.ents`, "Mirror: decor entities on/off", on by default); no other entity or its solids is ever touched. BLU is the base half, the negative side of the plane (`mirror.base` switches it). While it is on the plane shows in 3D and 2D and the status bar says `mirror x=0`; settings (on, axis, plane, base, the first-time answer, decor entities) live in the sidecar under `mirror`.

- First time on for a map it asks "Mirror the existing BLU half onto RED now?" with the counts (brushes, and decor entities on each half and on the plane): Mirror BLU to RED rebuilds the RED terrain and decor entities as the reflection of the BLU ones in one undo step (RED brushes and entities that already are an exact reflection keep their ids, the other RED brushes wholly on RED and RED decor entities go, every BLU brush or decor entity without a twin gets one; brushes across the plane and entities on it stay); Keep RED only links the halves; Cancel leaves it off. The answer is remembered (Keep RED at once, Mirror BLU to RED once the map is saved, so a discarded rebuild asks again). `mirror.blueToRed` rebuilds again, `mirror.selection` makes or updates the twins of the selection now.
- Pairs: a brush and the brush on the other side whose planes are its reflection (within 0.05) with the same materials. Every `edit()` while on (move, scale, rotate, gizmo, nudge, vertex, push/pull, clip, carve, hollow, snap, texture apply and alignment, Details, paste, prefab, clone, create, delete, group, visgroups, tie/untie, displacement create/paint/sew) rebuilds the twin of each brush it changed as the brush's reflection, in the same undo step; where both twins changed, BLU wins. Twins keep their ids and the side ids of faces that still exist; new brushes get a twin, deleted ones take theirs along; a brush moved onto the plane loses its twin (the pair is kept: an undo brings both back paired, and moved off the plane again it gets the same twin back). Only the twins of brushes an edit removed are deleted. Pairs are not part of the undo history: a brush without a twin (after an undo, or with the mirror off and on again) first takes the unpaired brush that is its reflection, as it was before the edit or as it is now, so nothing is doubled; `mirror.selection` with the mirror off pairs the halves first. Unhide all mirrors each visible brush onto its unhidden twin (an edit made while one twin was hidden is kept); an overlay on a twin face that is replaced (clip, carve, hollow of the source) moves to the new twin's faces on the same plane. Twins go in the counterpart func_detail (the one holding the other twins, else a new one), a group of their own (the one holding all the source group's twins, else a new one) and the same visgroups. An edit that adds unpaired brushes on both halves (a Figma import, a paste of both halves) links those that match and doubles nothing.
- Textures: same material, axes reflected so the texel grid lines up; a face that would read backwards (seen from outside: u x v along the normal) gets an axis flipped back, on walls the sideways one so u points right (a BLU face that already read backwards gives a twin that reads right and is left as it is). The face's rotation value is negated. Displacements reflect exactly (start corner, rows and columns transposed, vectors mirrored, alphas, tags and allowed_verts with them); painting paints the twin live.
- Drags (S.preview) show the twins' ghost in 3D and 2D (a decor entity's: its box). Vertex, clip and push/pull previews show none; the twin follows on release.
- Decor entities (`DECOR` in mirror.js): light, light_spot, light_dynamic, point_spotlight, env_sprite, env_lightglow, prop_static, env_cubemap, info_particle_system, at the root and not hidden. Pickups, spawns, doors, triggers, logic, prop_dynamic (lockers, the control point model), light_environment, info_overlay and any entity whose origin is within 1 unit of the plane (its own mirror) get no twin. A twin has the same class and every key and child (outputs, targetname, editor block) of its source, its id kept; the origin reflected; `angles` pitch yaw roll become pitch, 180 - yaw, -roll across x = c and pitch, -yaw, -roll across y = c (yaw and roll 0 to 360; forward and up reflected), an `angle` key the same way (-1 and -2, up and down, stay; 0 stays too, as vrad reads it as unset and takes the `angles` yaw, so a yaw that comes out 0 is written 360), light_spot's `pitch` as it is; env_cubemap `sides` name the twin faces of terrain faces that have twins, the rest are dropped; the group mapped like the brushes' (a light grouped with brushes joins their twins' group). Pairs: the entity of the same class whose origin is within 0.5 of the reflected origin. Live sync works as for brushes (create with the entity tool, the Models panel's drop and click placement, clone, paste, move, rotate, Details keys and outputs, delete, hide and unhide, Mirror selection now; onto the plane, undo and redo pairs as above), and a paste of both halves pairs and doubles nothing. A class changed in Details to one not mirrored (prop_static to prop_dynamic) goes to the twin too, once (either half as the source); after that neither is mirrored, until one is changed back. A Figma update with the mirror on rebuilds the RED terrain only: Figma writes both halves of its own lights (not quite symmetric) and never touches hand-placed ones.

### Playtest

`playtest` (F5, toolbar Playtest) opens a picker (`playtest.camera`, Shift+F5, or Shift+click: with "Start at the 3D camera" ticked): team (BLU / RED, T), class (click or 1-9), "Start at the 3D camera". It starts at the team's first enabled info_player_teamspawn (unassigned ones count), facing its angles, or under the 3D camera dropped onto the floor (also when the team has no spawn point). The 3D view then shows the map in first person, textured (lit stays lit; flat and wireframe switch to textured until the playtest ends, not saved): no editor overlays, helpers, point entities other than props / overlays / decals, or tool textures (but the sky); fov `cfg.playtestFov` (TF2's fov_desired, horizontal at 4:3, 90 by default). WASD, Space jump, Ctrl crouch, Shift walk (0.3), mouse look with pointer lock (click the view if it is not locked), 1-9 class, R respawn, Esc leaves (also the Esc that Chromium takes to end the pointer lock: the lock ending while the window has focus): the fly camera, view, render mode, tool and fov come back as they were. The toolbar button while playing (mouse free) leaves first and opens the picker. With no floor below the 3D camera, or no room there, it does not start and says why in the status bar. The HUD (top left) shows class, team, speed, on ground / in air, crouched, position and the keys. The document is only read: no edit, no undo step, the map is not marked dirty; an edit or load during play rebuilds the world (a load ends it).

- `playmove.js` ports CGameMovement / CTFGameMovement at the 15 ms tick (render interpolated, view smoothed on stairs like SmoothViewOnStairs): friction 4, stopspeed 100, accelerate 10, airaccelerate 10 with the 30 air cap, gravity 800 in two halves, jump 289 (set, not added, during the duck transition; no jump fully ducked on the ground; the key must be let go; ground jumps capped at 1.2x class speed), hull 48 x 48 x 82 / 62, duck and unduck 0.2 s (in air at once, feet up 20; no unduck without room; DuckOverrides: the key is ignored on the ground for 0.3 s after letting go, while standing up from a crouch, and after 2 crouches let go of in the air), crouch speed 1/3, backpedal clamp 0.9 over 100 u/s, Scout air dash (268.33 up, the keys' direction at up to 400), step 18, walkable normal z 0.7 (four quarter-box retest), ground snap while grounded. Class speeds 400/240/300/280/230/300/320/300/320, eyes 65/68/68/68/75/68/75/75/75, crouched eye 45.
- Collision: each brush as its support planes (faces, the 6 axes and edge x axis bevels: the exact Minkowski sum with the hull) swept like CM_ClipBoxToBrush (DIST_EPSILON 1/32), in a 256-unit grid of cells. What collides is what vbsp compiles: world and func_detail solids and solid brush entities (func_wall, func_brush unless Solidity 1 or disabled, func_door closed unless Starts open / spawnpos 1 / non-solid / passable, func_breakable, ...); a brush whose faces are all hint, skip, npcclip, blocklight, block_los, origin or fog is left out (clips, nodraw, blockbullets, invisible, sky and the rest block). Displacements collide as their triangles (both sides), not their brush, unless their flags say no hull collision. func_respawnroomvisualizer blocks the enemy of its func_respawnroom's team (TeamNum, else the team of an enabled spawn point inside it; none: never), func_forcefield the enemy of its TeamNum. Triggers, func_respawnroom, func_illusionary, areaportals, occluders and point entities never block. Spawn doors (func_door named in a team trigger's Open output) are open while the player touches such a trigger (filter_activator_tfteam honoured) and never close on the player. Solid props (prop_static, prop_dynamic, prop_physics; solid not 0, not StartDisabled) block as their model's box turned with them, once the model has loaded (models.js modelCorners). A brush with a water or slime face (the VMT's %compilewater / %compileslime, or the Water shader; materials.js vmtNow) is not solid. A player that ends up inside a brush (an edit while playing) is moved to the nearest free spot up, sideways or down within 64 units, like CheckStuck; R respawns. Objects hidden with H (Hammer's hidden blocks) are left out, as vbsp skips them; hidden visgroups, show filters and session-only hides (isolate, Figma review) do not count, for drawing too.
- Not modelled: swimming, ladders, prop collision meshes (.phy; props are boxes), func_instance contents, moving brushes, fall damage, weapons and conditions.

## Source constraints that change the Unreal approach

- Brushes must stay convex and planar. Free rotation or uneven scaling puts vertices off the grid, which causes leaks and gaps. After a transform the problems panel warns, and "snap vertices to grid" is one click. 90-degree rotations stay exact.
- Scaling a brush means resizing it. Point entities have no scale except props through `modelscale`.
- Everything must serialise to plain VMF.

## Build order

1. Details panel, gizmo, selection modes, show filters, outliner, Ctrl+K, rotation with texture lock, texture loading and textured 3D.
2. Texture browser, drag-to-apply, face/UV panel, image import, packing.
3. Blockout mode.
4. Diagnostics: live seal check, problems panel, background compile, limit meters.
5. Remaining Hammer++ features.

## Testing

- `node test.js [map.vmf]` - geometry self-check and byte-identical round trip of a real map (the argument, else `TEST_MAP`). Must pass before any change is done.
- `TEST_MAP=path\to\map.vmf` also turns on the real-map tests in `test/state.test.js` and `test/outliner.test.js`; without it they are skipped.
- `node --test "test/*.test.js"` - module tests (`npm test` runs both). Plain `node --test test/` resolves to `test.js` on Node 22.
- App check: launch with an isolated profile and drive it over CDP:

```
TF2EDITOR_USERDATA=dev/userdata ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9223 --disable-backgrounding-occluded-windows --disable-renderer-backgrounding
node dev/cdp.mjs @wait:2000 "document.title" @click:892,220 @shot:dev/scratch/s1.png
```

`dev/cdp.mjs` accepts JS expressions (evaluated in the renderer, result printed), `@shot:file.png`, `@wait:ms`, `@reload`, `@click:x,y[,button][,mods]`, `@drag:x1,y1,x2,y2[,mods]`, `@down|@move|@up:x,y[,mods][,button]` (a drag held across steps), `@wheel:x,y,dy`, `@key:Key[,code][,mods]` (named keys such as Enter and Escape send real key codes) and `@type:text`. Modifiers: `ctrl`, `shift`, `alt`, joined with `+`. Console messages and exceptions from the renderer are printed at the end. Use a different port if 9223 is busy. Kill only the Electron process you started (match `--remote-debugging-port=<your port>` in the command line).

## Settings and layout (build step 1b)

UI stack decision: plain HTML, CSS and ES modules with no build step. No React or shadcn; a rewrite would cost more than it gives. Two vanilla libraries cover the editor-shell needs: `three` (already used, `TransformControls` for the gizmo) and `dockview-core` 8.5.1 for the dockable panel layout. Only its UMD build `node_modules/dockview-core/dist/dockview-core.js` injects its stylesheet (the ESM build has no CSS), so `index.html` loads it as a classic script and `src/layout.js` reads `globalThis['dockview-core']`.

### Settings (`src/settings.js`, `src/settingsui.js`)

- `DEFAULTS` in settings.js hold every setting with its default; `cfg = { ...DEFAULTS, ...saved }`. `setCfg(key, value)` saves and emits `'cfg'` with `{ key, value }`; modules apply changes live from that event.
- Groups and keys:
  - General: `tf2`, `lastFile`, `recentFiles` (last 10), `autosaveMinutes` (0 = off; writes `<map>.vmf.autosave` while dirty), `project` (`'mymap'`; imported content goes to `tf/custom/<project>/`), `textureThumbSize` (64, 48-160), `prefabDir` (`''`: `<userData>/prefabs`), `ignoreGroups` (false).
  - Displacements: `dispPower` (3), `dispRadius` (96), `dispStrength` (8); hidden: `dispTarget`, `dispEffect`, `dispAxis` (set in the Displacement panel).
  - Hidden browser state: `recentModels`, `favouriteModels` (next to `favourites` / `recentMaterials`).
  - Snapping: `snapGrid` (true), hidden `grid` (64; the grid size `[` and `]` set, kept for the next session), `snapRotation` (true), `rotationStep` (15), `rotationStepFine` (5), `texLock` (true), `sizeLock`, `anchor`.
  - 3D view: `fov` (75), `flySpeed` (900; the wheel's dolly step scales with it, 128 units at 900), `flySpeedBoost` (3.3), `mouseSensitivity` (1), `farClip` (60000), `renderMode` (textured, flat, wireframe, lit), `showGrid3d` (true), `gizmoSize` (1), `entityLines` (true).
  - 2D views: `grid2dMajor` (1024), `showGrid2d` (true), `gridMinorColor`, `gridMajorColor`, `gridAxisColor`, `zoomSpeed` (1.2), `showDimensions` (true), `fillPointEntities` (true).
  - Blockout: `blockout` (false; Ctrl+B), `slopeTint` (false; blockout mode turns it on and off), `jumpHeight` (64), `crouchJumpHeight` (72; the red band is at 1.5x), `sentryRange` (1100). Hidden: `blockoutPresets` (null = built-in presets).
  - Figma import: `figmaThickness` (16, importer option `thickness`; floors, landings and roofs are slabs this thick, walls and blocks reach this far under the lowest floor beside them; it changes how far down pieces reach, not the layout: headroom, bridges and stair pairing keep the importer's own `slab` 16), `figmaSkyHeight` (512; the sky's ceiling over the highest brush, raised to 16 over the highest entity). The hidden `figma` object passes any other importer option (DEFAULTS in figmaimport.js).
  - Keys: `keys` (command id to chord list; overrides the command's defaults).
  - Compile: `steps`. The default list has a Pack step (`@pack`) between VRAD and Copy. Settings saved before it existed get it once on start (after the last vbsp/vvis/vrad step); the hidden `packStepAdded` flag records that, so a removed Pack step stays removed.
  - Compile modes: `compileMode` (`fast`) and `compileModes` (settings.js MODES: Fast `vvis -fast`, `vrad -fast`; Normal no flags; Full `vrad -both -final -StaticPropLighting -StaticPropPolys -textureshadows`; Entities only `vbsp -onlyents`, VVIS and VRAD off). The steps get the mode's flags as `$vbspflags $vvisflags $vradflags`; a tool set to `false` drops every step that uses its var. The Compile panel picks the mode and edits its flags and Run boxes. Old default VBSP/VVIS/VRAD steps get the vars once on start (hidden flag `modeFlagsAdded`); edited steps stay as they are.
- Commands besides the settings: `file.openRecent` (a list of the recent files; the palette also lists them as "Open recent: <name>"), `compile.checkContent`, `compile.logFolder`, `compile.mode.<fast|normal|full|ents>`, `map.checkProblems`, `map.weldPlanes`.
- Snapping behaviour: with `snapGrid` off, moves and resizes are free (1 unit). With `snapRotation` off, the gizmo and the Rotation fields rotate freely. Shift uses the fine step (grid/4, `rotationStepFine`). Commands: `snap.grid` toggle (Shift+W, like Hammer), `snap.rotation` toggle, `snap.rotationStep` cycles 5/15/45/90. The 3D HUD and the status bar show the current snapping state.
- Settings dialog: an in-app `<dialog>` (see `src/dialog.js` for the pattern) with a category list on the left (General, Snapping, 3D view, 2D views, Keys, Compile) and a form on the right built from a declarative schema (`{ key, label, type, min, max, step, options, hint }`, types bool, number, select, text, path, color). Changes apply live through `setCfg`. A search box filters rows across categories; each category has "Reset to defaults". Keys shows every registered command with its chord; click a chord and press keys to rebind, with a reset per row and a conflict warning. Opens with Ctrl+, (`settings.open`) and a gear button in the toolbar.

### Layout (`src/layout.js`)

- One `DockviewComponent` fills the area between the toolbar and the status bar. Panels: `3d`, `top`, `front`, `side`, `details`, `outliner`, `compile`, `textures` (its element is made by `pane('textures')`). The panel content elements are the existing `#v-3d`, `#v-top`, `#v-front`, `#v-side`, `#details`, `#outliner`, `#compile` elements, so the view and panel modules keep mounting into them.
- Default layout: the four viewports in a 2x2 grid on the left (3D top-left, Top top-right, Front bottom-left, Side bottom-right), details above outliner on the right, compile and textures as tabs next to outliner.
- Tabs drag between groups and can float; no popout windows. The layout persists as `cfg.layout.dock` (dockview `toJSON()`, saved debounced on `onDidLayoutChange`) and restores on start as saved (closed panels stay closed); only a layout that throws or has no viewport falls back to the default. `cfg.layout.panels` lists the panel ids known when it was saved: panels added to the editor later open as background tabs beside their anchor.
- Commands: `layout.reset`, `layout.toggle2d` (hide or show the three 2D viewports), `view.maximize` (dockview group maximize, also on pane label double-click and Alt+Enter), `panel.<id>` to show a hidden panel (the "Window" list in the palette).
- Theme: dockview's `--dv-*` variables are set from the editor's tokens (`--panel`, `--line`, `--text`, `--accent`) so tabs match the rest of the UI.
- The old CSS grid splitters (`.split`, `--vx`, `--vy`, `--main`) go away; old `cfg.layout` percent keys are ignored.

## Extension hooks

Feature modules plug into the views, the dock and the document through these hooks instead of editing `view3d.js`, `view2d.js`, `layout.js` or `state.js`. Each `register*` returns its unregister function. Register from your module's `mount()` (or at import time for panels), and add one import + mount pair to `app.js`.

### Tools (`S.tool`)

`state.setTool(id)` makes `id` the active tool (`S.tool`, `'tool'` event). Built-in ids: `select`, `block`, `entity` (unchanged, not registered). A tool registers handlers per view under the same id; register a command that calls `setTool(id)` (and give it keys) so the toolbar, palette and keys can activate it. While a tool other than `select` is active the 3D gizmo is hidden.

**3D: `view3d.registerTool(id, handlers)`**

```
handlers = { activate(), deactivate(), down(e, hit), move(e, hit), up(e, hit), key(e), dblclick(e, hit), drawsSelection }   // all optional
```

- `e` is the DOM event (`e.offsetX/offsetY` are CSS pixels in the 3D canvas). `hit` is `pick(x, y)` at the pointer: `{ node, side, point (THREE.Vector3), face: { pts, n, side } }` or `null`.
- A handler returning `true` consumes the event: the default select / marquee / push-pull / blockout draw does not run.
- `down` gets left presses only (right button = fly look, Alt+right = apply texture; presses on the gizmo never reach it). When `down` returns true the tool owns the press: pointer capture is set, every move goes to `move` and the release to `up` (whatever they return). Otherwise `move` is called on every hover move (no button) and `up` on the release of a default press.
- `key(e)` gets every keydown (not while typing in a field, flying or with a modal open) before the command keybindings; return true to swallow it (no command runs). Escape with a tool-owned press in progress is yours to handle in `key`, else the `cancel3d` command drops the press.
- `activate` / `deactivate` run when `S.tool` switches to / away from `id` (also when registering an already active id).
- `drawsSelection: true`: the tool draws the selection itself, so the view draws no object tint, face highlight or vertex dots while it is active (polyedit.js).
- Call `view3d.invalidate()` after changing anything drawn (render on demand). Draw previews with `addHelper(obj)` / `removeHelper(obj)` (never picked).

```js
import { registerTool, addHelper, removeHelper, invalidate } from './view3d.js';
import { setTool, setCursor } from './state.js';
import { register } from './commands.js';
let dot;
registerTool('clip', {
  activate: () => setCursor('clip: click two points'),
  deactivate: () => dot && removeHelper(dot),
  down(e, hit) { if (!hit) return false; /* place a point at hit.point */ return true; },
  move(e, hit) { /* move the preview */ invalidate(); return true; },
  key(e) { if (e.key === 'Escape') { setTool('select'); return true; } },
});
register('tool.clip', { title: 'Tool: clipping', keys: ['shift+x'], run: () => setTool('clip') });
```

**2D: `view2d.registerTool(id, handlers)`**

```
handlers = { down(v, e, w), move(v, e, w), up(v, e, w), key(e) }   // all optional
```

- `v` is the view: `{ name: 'top' | 'front' | 'side', ax: [i, j], c, z, w, h }`. `ax` are the world axes shown left-right and bottom-top (top `[0, 1]`, front `[1, 2]`, side `[0, 2]`); the depth axis is `3 - i - j`. `w` is the pointer in view coordinates `[x along ax[0], y along ax[1]]`, unsnapped (snap with `Math.round(x / S.grid) * S.grid` when `cfg.snapGrid`). A 3D point from it: `p[v.ax[0]] = w[0]; p[v.ax[1]] = w[1]`.
- Same consume rule. `down` gets left presses without Space (right/middle and Space+drag pan); `true` makes the tool own the press (`move` / `up` until release). Without a press `move` runs on every hover move; a consumed hover move skips the resize-cursor logic. `up` returning true cancels a default press (marquee, move, scale, block).
- The view under the pointer is redrawn after each handler call; anything else redraws with `view2d.invalidate(...views)` (no argument: all three).
- Register `key` in one view module only (3D or 2D): both see the same keydown and the first to return true swallows it.
- While a tool registered in view2d is active, the selection box has no scale handles (the tool draws its own).

**Overlays: `view2d.registerOverlay(fn(ctx, v, helpers))`**

Runs on every 2D frame of each view, after the selection, leak line and drag rectangles, with `ctx` in CSS pixels (`ctx.save()` / `restore()` around it; errors are logged, not thrown). The static layer (grid and outlines) is not touched, so it stays cached. `helpers = { toScreen(v, p3) -> [x, y], toWorld(v, x, y) -> w, s2(v, a, b) -> [x, y], previewFn(xf) -> (p3 -> p3) }` (`previewFn(S.preview)` follows a drag in progress). Ask for a frame with `invalidate()` when what you draw changes.

```js
import { registerOverlay, invalidate } from './view2d.js';
let pts = [];
registerOverlay((ctx, v, { toScreen }) => {
  ctx.fillStyle = '#ffd040';
  for (const p of pts) { const [x, y] = toScreen(v, p); ctx.fillRect(x - 3, y - 3, 6, 6); }
});
// after changing pts: invalidate();
```

Other 2D exports: `pickAt(v, w) -> node | null` (visible object under `w`, smallest box first), `viewByName('top')`, `toWorld`, `toScreen`, `s2`, `previewFn`, `invalidate`, `screenMatrix`.

### Entity and brush visuals: `view3d.registerBuilder(fn(entry) -> Object3D | null)`

Replaces the default visual of a cache entry (point entities: a 16-unit box in the 2D colour; solids: their faces). Builders run in registration order for every new or dirty entry (and for all entries once when registered); the first non-null result wins, `null` keeps the default. The object is put in a container (`entry.mesh`, `userData.built`) that the drag preview moves like a brush mesh, so position the object in world coordinates (e.g. at the entity origin, rotated by `angles`). The editor sets `userData.node` on every descendant: hits map back to `entry.node`, `pick()` reports them, and the object is removed with the entry (`'doc'` rebuild, delete, hide filters through `entry.visible`).

- `entry` is the cache entry: `{ node, owner, faces, min, max, visible, point, kinds, color2d }`. Read keyvalues with `V.get(entry.node, 'model')`.
- Picking: give a mesh `userData.tri` (face index into `entry.faces` per triangle, in index order) for exact faces; without it `pick()` reports the entry face whose normal is closest to the hit's normal (enough for point entities).
- Render modes: a mesh with `userData.mats` (material name per geometry group) gets the brush materials (textured / flat colour per name / wireframe); any other mesh keeps its own material in textured mode and gets a flat `MeshBasicMaterial` of its `color` (wireframe in wireframe mode) otherwise. The scene has no lights: use `MeshBasicMaterial` or vertex colours.
- The selection draws a red bounding box around selected builder objects. The 2D views and the selection box still use `entry.min` / `entry.max`.
- Builders own their geometry and materials (share them between entries; the editor never disposes them). Async content: return a placeholder (or `null`) and call `refreshEntry(node)` when it is ready to run the builders for that entry again.

```js
import * as THREE from 'three';
import * as V from '../vmf.js';
import { registerBuilder, refreshEntry } from './view3d.js';
const models = new Map(); // path -> THREE.BufferGeometry, loaded elsewhere
registerBuilder(c => {
  const path = c.point && V.get(c.node, 'model');
  if (!path) return null;
  const g = models.get(path);
  if (!g) { loadModel(path).then(geo => { models.set(path, geo); refreshEntry(c.node); }); return null; }
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x9aa4b4 }));
  m.position.set(...V.nums(V.get(c.node, 'origin')));
  return m;
});
```

Also in view3d: `addHelper(obj)` / `removeHelper(obj)` (display only, never picked), `onHover(fn(hit, x, y))`, `rayAt(x, y)`, `pick(x, y)`, `invalidate()`.

### Panels: `layout.registerPanel({ id, title, element, near = 'outliner', minimumWidth = 260, minimumHeight = 120 })`

Adds a dock panel. Works before or after `layout.mount()`: the first time the editor sees the id it opens as a background tab in `near`'s group (the active group when `near` is closed); after that the saved layout restores it where the user left it, and a closed panel stays closed. `Layout: reset` puts registered panels back next to `near`. It registers `panel.<id>` ("Window: <title>") to show it. `element` is the panel content (default: `layout.pane(id)`, a `.panel` div with scrolling and the panel background). Calling it at import time (module top level) lets a saved layout restore the panel with its content straight away; when it is called after mount, the restored tab holds a placeholder `.panel` that receives `element`. Ids must not clash with element ids in `index.html`.

```js
import { registerPanel, pane } from './layout.js';
registerPanel({ id: 'problems', title: 'Problems', near: 'compile' });
export function mount() { pane('problems').append(/* content */); }
```

The built-in panels (`3d`, `top`, `front`, `side`, `details`, `outliner`, `compile`, `textures`) stay in `PANELS` and the default layout; `textures` keeps its element from `pane('textures')`.

Details sections: `details.registerSection(fn(helpers) -> element | null)` adds a section after Face on every redraw (`helpers = { section, row, num, button, check, dropdown, DEG, GRID }`, the panel's own controls); `emit('details')` asks for a redraw.

### Hidden objects (Hammer's H / Unhide)

Hammer saves each hidden object wrapped in its own `hidden` block, in place of the object:

```
world { ... solid {...} hidden { solid {...} } solid {...} group {...} }
hidden { entity {...} }                       (root level: a hidden entity, point or brush)
entity { ... solid {...} hidden { solid {...} } }  (one hidden solid of a brush entity)
```

- `load()` reads them: the wrapped objects get cache entries with the right owner and start hidden (`filters.hidden`), like in Hammer. An unchanged map saves byte-identically.
- `hideSel()` / `hide(nodes)` wrap each object in place in a new `hidden` block (a brush entity whose solids are all hidden is wrapped whole); `unhideAll()` replaces every wrapper with its contents in place, so hide + unhide gives back the same bytes (objects Hammer hid through a visgroup get `visgroupshown` / `visgroupautoshown` "1" back). Both are one undo step and mark the map dirty. Hidden nodes leave the selection.
- `vbsp++` skips hidden objects (a hidden brush is not compiled).
- Isolate (`hide.isolate`) hides the rest with `hide()`, so it is saved and undoable like H.

### Groups (Hammer's Ctrl+G / Ctrl+U / Ignore groups)

```
world
{
	...
	group
	{
		"id" "4521"
		editor
		{
			"color" "220 220 220"
			"visgroupshown" "1"
			"visgroupautoshown" "1"
		}
	}
}
solid / entity { ... editor { "color" "..." "groupid" "4521" "visgroupid" "3" "visgroupshown" "1" "visgroupautoshown" "1" } }
```

- Group blocks sit at the end of the world; their `id` comes from the shared id counter (`nextId()`). Members are top-level objects (world solids and whole entities); `groupid` goes right after `color` in the member's `editor` block. Nested groups (a group's own `editor > groupid`) load and save unchanged; a click selects the outermost group. A group's visgroups sit on its block's `editor` (Hammer drops visgroups from group members on load): `groupSel` moves the members' visgroups there and `ungroupSel` gives them back, the outliner assigns to the block, `isVisible` applies them, and copied members carry them in the snippet. `groupOf(o)` returns an object's group block.
- `groups()` - `Map<groupId, node[]>` of member objects (hidden members too; a group block without members maps to `[]`).
- `withGroup(n)` - the cache nodes a click on `n` selects: every visible node of its group, else every visible solid of its brush entity (as in Hammer), or `[n]` (a world solid or point entity without a group, or `cfg.ignoreGroups` on). `clickSelect(n, ctrl)` - the 2D and 3D click: selects `withGroup(n)`; Ctrl adds the group, or removes it when `n` is selected; `null` clears (without Ctrl). Marquee selection and the outliner select single objects.
- `groupSel()` (Ctrl+G, command `group`) creates a group of the selected objects and returns its id; objects leave their old group, and groups left empty are removed. `ungroupSel()` (Ctrl+U, command `ungroup`) dissolves every group with a selected member. Both are one undo step; group then ungroup gives back the same bytes.
- `cloneSel()` puts clones of group members into new groups (one per original group), so copies select apart from the originals.
- `select.ignoreGroups` toggles `cfg.ignoreGroups` (Hammer's Ig button).

### Other root blocks

`load()` keeps any root block it does not use as parsed (`versioninfo`, `visgroups`, `viewsettings`, `cameras`, `cordons` with `cordon { name, active, box { mins, maxs } }`, the old single `cordon { mins, maxs, active }`, `instances`, anything unknown) and saves it back unchanged. Read them with `V.kids(doc.root, 'cordons')[0]` and edit them through `edit([], [block], fn)` like any other node.

## Figma layout import

Draw the map layout in Figma, export the frame as SVG with "Include id attribute" ticked, and drop the .svg on the editor (or run `figma.import`, "Import Figma layout (SVG)..."). No Figma API calls, so the Starter plan's limits do not matter. Code: `src/svgread.js` (SVG to shapes, no DOM), `src/figmaimport.js` (shapes to brushes, pure), `src/figmaui.js` (dialog, drop, command).

### Layer names

Case does not matter; spaces or underscores separate words (Figma's `_2` suffixes on repeated names are ignored).

- `z<n>` on a group: an area whose floor is n units up (z0 is the ground; z-86, z192). Nested layers inherit it.
- `h<n>`: wall height above the area's floor (default 192).
- `block`: a solid mass up to its walls' top (its z, else 0, plus h). Over another area's floors and stairs it starts at the top of their room (see Rooms); over its own area's, 160 above them. A block group inside an area (a roof: h = the walls' height + 16 puts it on their top) is never part of that area's spawn room or capture zone. Its outline should stop at a balcony's edge: past it the block hangs down to the room of what is below and closes the opening. A flight cuts a block as drawn, from end line to end line (its steps can stop a hair short of the landing), and a strip of block under 3 wide left between cut-back parts starts as low as the lowest part beside it, so no thin wall stands across a way.
- `roofed`: the area gets a 16-unit ceiling at the top of its room (see Rooms) over its floors, landings and flights: its walls' top, raised wherever a step or landing under it climbs to less than 160 below it, so the roof fits the stairs (a floor's roof leaves out the area's flights standing on it; they have their own). A floor, flight or block of another area at least 160 above it is its ceiling there: the roof is left out under it.
- `mirror-left` / `-right` / `-top` / `-bottom` on a group: it holds one half of the map; a mirrored copy is added across its right (left, bottom, top) edge.
- `ignore`: skipped (hidden layers are not in the export anyway).
- `spawn` in an area's name: a spawn room. The half as drawn is BLU and its mirror RED, unless a layer says `red` or `blu`. It gets up to 16 info_player_teamspawn on a 64 grid (32 clear of walls and out of the door triggers, spread out from the back, each facing its nearest door, spawnflags 511), a func_respawnroom over its floors up to its room's top, a resupply locker (prop_dynamic, skin 0: the model has one) against the wall nearest the back of the room with a func_regenerate around it and in front of it (associatedmodel, so it opens), and on the end of each flight out a func_respawnroomvisualizer (Solidity 1; toolsnodraw but for its face out of the room, the no_entry sign fitted to it) and a func_door that slides down at 500 for the team (a trigger_multiple around it, filtered by a filter_activator_tfteam, opens it on OnStartTouchAll and closes it on OnEndTouchAll). The control point keys: hologram 4 over the base, spawnflags 4, warn sound, base icons on the master, the base casts no shadow.
- Markers in a spawn's group (mirrored with it) place its parts instead: `door` lines (a door, its no-entry wall and team trigger along the line), `locker` shapes (a resupply locker at the middle, facing away from the nearest wall) and `spawnpoint` shapes (one spawn point each, facing the doors). What has no marker is placed as above.
- `controlpoint` (or `cappoint`) shape anywhere: the point stands at its middle (one on the mirror line and its copy are one); `capturezone` (or `capzone`) closed shapes: the capture zone (a half drawn in a mirrored group becomes the whole). Without them the area's floors and their middle are used. Markers never move a mirror line.
- `control` (or `capture`, `cp`) in an area's name: the control point. Over the floors of every such area: a trigger_capture_area 160 high (10 s to cap), the team_control_point with its hologram and the cap_point_base prop in their middle, the team_control_point_master, tf_logic_koth (180 s, unlocks at 30 s), tf_gamerules `koth_gamerules` and a logic_auto (6 s respawn waves and the KOTH goal each round). A cap sets the capping team's KOTH clock active, the base's skin, and respawn waves of 8 s for the holders and 4 s for the others.
- Every import also gets a sky: a shell tight round the brushes (16 thick, on the 16 grid, and at least 16 clear of every entity: one outside it leaks), tools/toolsskybox on all six sides (the bottom of a pit drawn without a floor shows sky), its ceiling `figmaSkyHeight` (512) over the highest brush; a light_environment over the middle under the ceiling, and lights on a 256 grid over every floor (one per level where floors stack, brighter under a roof, a floor or a block, a soft fill in the open) plus one in the middle of any floor the grid misses and over any covered flight without one nearby, so it compiles without a leak and plays as KOTH (option `gameplay: false` leaves all of this out).
- Inside an area: `floor` (or `elevation`) fills are floors; `walls` strokes are walls; `stairs` (or `ramp`) lines are the two ends of each flight; `landing` (or `platform`) lines or shapes are landings at their own z, else the area's. Unnamed shapes in an area go by paint: fills are floors, strokes 6 wide or more are walls, thinner ones stair ends.
- Points of different shapes drawn on one spot are welded into one (a point within 0.15 of a whole unit is that unit, then each point joins the first one kept within 0.35), and a corner of an outline less than 0.3 off the line through its neighbours is dropped: Figma leaves shapes that should meet a tenth apart, and brushes a hair apart leave a crack that vrad lights black.
- A floor without a z takes its height from its fill: grey lightness L% = 50 + z / 8 (z = 8 x (L - 50)).
- An area without a z (a passage of stairs and landings) takes its level, for its walls and ceiling, from its landings and the floors its stairs lines are drawn along (the highest).
- Pickups: a shape named `small`/`medium`/`large` (or `full`) with `health` (or `hp`) or `ammo`, such as `Medium Health`, anywhere in the layout: an item_healthkit_* or item_ammopack_* on the floor under its middle (the highest there), in a `Pickups` visgroup.
- Scale: 1 SVG unit = 1 Hammer unit. The map is centred on the 64 grid and keeps the drawing's own grid offset (often .5).

### Geometry

- Rooms: over each floor, landing and step, an area's room reaches up to its walls' top (an area without walls: its z + h) and at least 160 (the clearance) above that floor or step. Over a flight what stands above is flat, as over its highest step (no saw-tooth undersides); only a roofed area's own roof steps up with its steps. Floors, walls and blocks of a higher area never hang down into it: over it they start at the room's top and rest on its walls and roof; one whose own floor is below the room's top is a 16-thick slab under that floor.
- Floors: prisms up to their z, slabs `figmaThickness` (16) thick: where a side borders a lower floor or step and no wall or block closes it, the piece reaches down to that floor, a slab under it (a step down shows its face, nothing sees under a floor). A piece with nothing past a side (the map's edge, a gap or pit drawn without a floor; probes 1 and 4 out from every side and corner, a point within half a unit of a piece counting as on it so both halves of a mirrored map agree) stays down on the base (32 under the lowest floor, on the 16 grid), as before: the hollow under the slabs stays closed off and a pit's bottom is the sky. A wall or block closes a floor's side only where it reaches as low as the floor will. Where floors overlap and their heights differ by less than 176 (the clearance plus 16), the layer higher in Figma keeps the overlap; a floor 176 or more above another starts above it (a bridge over a passage): at the top of the lower area's room, or 160 above a floor of its own area. Landings win over floors. Holes in a floor shape are kept. A floor the flight runs up through (its top above the flight's foot and at most a riser above its top: the floor of either end drawn on under the flight) is cut away over it. One higher is a bridge over the flight and stays whole: over the flight it starts at the top of the room there, keeping at least 16 under its top; where that leaves less than 160 over the steps, the import notes it (the drawing asks for both).
- Walls are built along the stroke line itself: one convex brush per straight piece, 16 thick, up to the area's z + h, from the lowest floor or step under them or just past either face, a slab under it (so they seal both floors; with nothing past a face, down to the base). Neighbouring pieces are mitred so they meet face to face; corners sharper than about 30 degrees (or too tight for a short piece) get square ends plus a convex corner piece; open ends are square. An open end meeting another wall gets a post as wide as the wall; an end or corner less than 32 short of another wall is bridged to it (no player fits through, and it would show as a black slit). Posts and bridges stand only at the heights where both walls they join stand, so a wall cut back over a room or a lower wall beside a taller one leaves no pillar. Curves are flattened to chords at most 0.5 units off, so a curved wall is a chain of mitred pieces. Diagonal walls are single slanted brushes, never boxes along a grid. The stroke width in Figma is only for looks. A line splits into walls where it turns by more than 35 degrees, so each straight stretch is one wall and a curve (its chords turn less) stays one wall. Headroom: a wall gives way where floors or flights at least 160 below its area's floor run on past both faces (a tower over an underpass): there it starts at the top of the room under it. Walls are cut square across, where a floor's, step's or flight's outline crosses their middle line, never along a slanted edge (no wedges). Anything closer below, or beyond one face only (the edge of an area, a flight's side wall), leaves it standing down to the lowest floor beside it. The other way round, where a floor or flight of another area runs over a wall, on past both faces, above the wall's foot (the lowest floor under it), the wall is cut from that surface up to 160 above it (an underpass's wall under a tower's stairs): a wall never pokes up through another area's floor or stairs.
- Stairs: every stairs and landing line is an edge. Edges pair across a flight: parallel lines that overlap, lines meeting at a corner (a winding flight) or lines at an angle the Stairs tool can join; nearest first, one partner per side, the line between their middles crossing no other edge and no wall (walls of an area at least 160 above both ends, or at least 16 below both, do not count: they give way over the flight or stop under it) and running over no floor within the flight's heights (a floor well below, as under a bridge, is fine, so is one more than a riser above its high end, a bridge over it, and so is the floor of either end drawn on under the flight; a flight already paired hides the floors drawn under it at its own heights from later pairs). A line with a wall drawn along most of it is closed and takes no flight. An edge's height is the floor just behind it (where floors are stacked, the one the line is drawn along), away from its partner (a landing edge: the landing's z); an edge between two flights gets the height part way along them. Each pair is built by `stairgeo.build` (risers of at most 16, treads at most 32 deep, fitted to the imported walls); a pair at one height becomes a level floor between them. Collinear stairs lines end to end (the halves of a mirrored flight) join into one, and a stairs line running on along a landing edge joins it (at the landing's height).
- Blocks are carved: over a floor, landing or flight of another area they start at the top of its room, over their own area's 160 above it; parts left thinner than 1 unit go. Where nothing is under them they reach the lowest floor beside them, a slab under it (nothing beside them: the base). Roofs (ceilings) are slabs. Stairs keep their solid steps down to the lower floor, on a world slab at their foot (object `flight ... base`, floor pieces; left out over a floor or wall running under the flight, and down to the base only where nothing is beside it): the steps are func_detail and close nothing, and what stands beside a flight reaches down to that slab.
- An open wall end that meets another wall (within its thickness) gets an octagonal post as wide as the wall, the drawing's round cap: two square ends meeting at an angle would leave a slit.
- No splicing: the pieces a floor, landing, block or roof is left in after the cutting are cut again from the outline they make together (`poly2d.partition`): each reflex corner is cut to another reflex corner the cut also resolves, else along one of its sides (a corner of 210 degrees or more) or across its middle (a curve's chords get cuts square to the curve), then neighbours merge where together they are convex. Hammer shows whole n-gon faces instead of fans of thin triangles; an L is 2 brushes, a U 3, a circle 1 (at most 64 corners). Where a piece would come out winding round twice (its hull would cover a neighbour) partition gives up and the object keeps the pieces the cutting left. A sliver (a crack or a hair of overlap in the drawing) goes into the neighbour whose hull with it adds no more than it is, a side shorter than half a unit lets its neighbours run on to where they meet, and a sliver under half a unit wide that is left is no brush: no face is thinner than half a unit, no side shorter. The other half of a mirrored object takes the mirror image of the first half's pieces (and their bottoms), so the halves are mirrors brush for brush. Wall pieces of one wall at the same heights that share a side merge where together they are convex (at the lower bottom where only the thickness rule set them apart). Stairs and roofs go into the map as func_detail, one per flight or roof: they need not seal the map, and kept out of the visibility split the map compiles and draws faster.
- Outlines are simplified after rounding (no zero-width sides, so vbsp sees no duplicate planes). Materials: floors, landings and stairs dev/reflectivity_90 (white), walls dev/dev_measurewall01d (grey), roofs dev/dev_measuregeneric01 (orange); a block's top and bottom roof, its sides wall.

### In the map

The import dialog lists brush counts, the area heights and notes (flights too short, unpaired stairs lines, floors without a height). Import replaces everything in the `Figma` visgroup (and the visgroups inside it) from the last import as one undo step and frames the new brushes in the 3D view. Each floor, landing, block, flight and wall (between corners) is one object, a group where it takes several brushes, so a click picks one wall, not its whole area. Each area is a visgroup inside `Figma` (a mirrored half shares its area's), in Figma's layer order; an area's visgroup is reused on the next import and dropped once the area is gone and the visgroup is empty. Hand-made brushes outside these visgroups are never touched.

### Update from Figma (three-way diff)

`figma.update` ("Update from Figma (SVG)...", or an .svg dropped on a map that has a base: Update (diff) / Replace) merges a new export into the map like git: BASE is what the last import or update made, THEIRS what the new SVG makes, OURS the map now.

- Keys: every generated solid and gameplay entity has a stable `key`: the layer path with Figma's `_2` suffixes and the settings an edit changes (`z`, `h`, `roofed`, `size`) taken off (Figma numbers repeated names across the whole file, so a new layer would rename others; a new height is a change, not a removal and an addition) plus the shape's place among shapes on that path, then the object (`.line.run` for walls, `flight <edge> to <edge>`, `<area> ceiling`), ` (mirror)` for the mirrored half and `#n`, the piece's number in its object; gameplay entities `<area>/<class>#n`, the sky `sky#n`. An update keeps the base's map offset and floor bottom (`opts.offset`, `opts.base`), so the drawing growing moves nothing.
- Base (sidecar `extra.figma`): `{ svg, offset, zbase, keys: { key: [hash, id, area, kind] } }`, id `s<solid id>` / `e<entity id>`. The hash covers face corners, materials and keyvalues (rounded; not ids, editor blocks or texture axes). Written on import, adopt and apply (undoable), saved with the map.
- Classes per key: unchanged (theirs == base, or ours == theirs: the map keeps its own, hand edits and deletions too), incoming (ours == base), conflict (both changed, or one side deleted and the other changed; rejected by default), added, removed. The changes of one object (the key less its `#n`) are one choice (`unit`), one row in the review: taken or kept whole, since part of a new cut beside part of the old one leaves holes and overlaps; an object with a conflict is kept by default. A key whose base changed takes over a base entry with its hash whose own key changed or went: a layer renamed or renumbered is no change. Objects without a key are never touched.
- Review (Figma changes panel, `figmareview.js`): rows grouped by area with type, layer, description and Accept / Reject; Accept all / Reject all per area and for all; N / P next / previous (the views frame it), A accept, R reject, B before / after of the focused change; Changes only hides the rest. 3D and 2D: the rest dimmed, added green ghosts, removed red, changed = the map's piece as a red wireframe and the incoming one as a green ghost, conflicts orange, rejected faint, the focused one outlined yellow. The map changing during the review re-diffs it. Apply is one undo step: a changed piece takes the old one's place and editor block (visgroups, group), removed ones go with what they leave empty, added ones go in like an import (area visgroups, one group per object, stairs and roofs into their object's func_detail); then the base is THEIRS for every key. With the live mirror on, the RED terrain is then rebuilt from BLU in the same step (`mirror.bulk`; decor entities are left as they are).
- Adopt (`figma.adopt`): a map imported before keys existed gets a base from the SVG it came from, imported in memory: map objects with the same shape first, else the best box overlap (at least 0.3 of the union) among the Figma visgroups' objects and brush entities without a visgroup. Box overlap is measured from the higher of the two bottoms up (an older import's pieces reach down to the base). Matched pieces that differ are local edits; generated pieces with no match count as deleted here.
- Updating a map imported before slabs and partition (its base from that importer): the pieces change (floors, walls, blocks, landings, roofs, the sky), objects now cut into fewer pieces lose their extra keys (removed) and a few gain one (added); stairs and gameplay entities stay. The slabs under flights are added. Applied, it leaves the map as a fresh import (an update again finds nothing). A hand-edited piece makes its object a conflict, kept whole (its old pieces, none of the new) unless accepted.
- Import (Replace) now puts brush entities (func_detail, triggers, doors) in their area visgroup too and also replaces what the base names; it adds brushes without blockout retexturing.

Not done: spawn doors, a check that spawn points stand clear of props.
