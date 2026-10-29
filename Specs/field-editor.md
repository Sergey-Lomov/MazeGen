# Field Editor

Defines the shape of the maze field before generation. Operates on a confirmed tessellation kind.

## Modes

Two parallel mechanisms for custom fields exist:

### Predefined shapes (legacy ControlPanel flow)
The custom field is entered through the field edit mode (`setFieldEditMode("custom")`), which sets `isEditingField = true` and exposes `freeFieldPoints[kind]` as `fieldPoints`. Points are drawn directly on the canvas at any time. The preset shape selection (`selectedShape`) is kept while editing and applies again in default mode.

### Card-based editing (FieldSetupFeature)
Opened via the Field Setup card in FeaturesPanel. Requires tessellation to be confirmed first.

Two sub-modes toggled inside the card:

**Default** — predefined shape with configurable size parameters (width/height, cols/rows, radius, side). Canvas shows all cells of the shape centered around the grid origin. Camera centers on the shape when the card opens or when size params change. An invalid or out-of-range size is restored on blur and gets a field-anchored hint (GitHub issue #770), including when the restored value equals the stored value.

**Custom** — free-draw mode. The active Add/Remove mode controls whether drawing adds or removes
cells; Select previews existing cells. Space or middle mouse pans the camera. Camera does not move
while drawing. `isEditingField = true`, `fieldPoints` reflects the drawn set.

The **Center field** action translates all custom cells so the origin cell is as close as possible
to the midpoint between the field's extreme cell centers. It is unavailable when the active
tessellation does not support translation, so triangle parity and mixed-cell tessellations remain valid.

The mode and tool buttons use accessible tooltips. A mode tooltip renders its selection hotkey
right-aligned as a muted keycap badge (for example, `Add` with `+`). A separate tertiary-colored line explains any
keyboard-modified behavior, prefixed by its keycap (for example, `Shift` then `Move vertices freely.`). Symmetry alone adds
`Unavailable in Select mode.` while Select is active, because that operation cannot reflect cells.

Switching default→custom preserves existing drawn points. Switching custom→default restores the predefined config with saved size params. Closing the card does **not** reset `fieldEditMode` — when the card reopens, it restores whichever mode was active.

### Available predefined shapes

Tessellation kind, its params and the field shape are separate settings (GitHub issue #755): a
floor's runtime `FieldConfig` is `{ tessellation: { kind, params }, orientation?, shape }`
(`maze-web/src/fieldConfig.ts`). `shape` is kind-independent (`FieldShape`):

| Shape | Parameters |
|---|---|
| `rect` | `cols`, `rows` (square: width/height in cells; tri: pairs of opposite triangles per column; Cairo: fundamental 4×4 squares) |
| `parallelogram` | `cols`, `rows` |
| `circle` | `radius` |
| `triangle` | `side` |
| `hexagon` | `radius` |
| `custom` | `points` (the free-drawn cell list) |

Which preset shapes a tessellation offers comes from `maze-core` (GitHub issue #762):
`field_capabilities(tessellation)` lists the presets (`key`, plus `params: [{name, min}]`) and the
operations (`translate`, `reflect`) it supports. `pixi/fieldOps.ts` caches the capabilities per
tessellation. The shape selector lists exactly the offered presets; each preset's parameter form is
built from its schema (one input per param, lower bound `min`). A tool whose operation is not
offered is hidden (the Symmetry tool needs `reflect`; moving a selection needs `translate`). The
current table, for reference:

| Kind | Preset shapes |
|---|---|
| `square` | rect, circle, triangle |
| `hex` | rect, parallelogram, hexagon, circle, triangle |
| `tri` | rect, triangle, hexagon, circle |
| `cairo` | rect, circle, triangle, hexagon |

Each floor keeps one `selectedShape` (a preset key); the default is the kind's default preset
(square `rect`, hex `hexagon`, tri `triangle`, cairo `rect`). It falls back to the default when the
tessellation does not offer the previous selection.

Project load rejects a floor `shape` or `savedShapes` entry the maze-wide tessellation does not offer
(for example a `square` field with a `parallelogram` shape); `custom` is accepted for every kind.

Hex/tri display orientation is a maze-wide display setting (`hexOrientation`/`triOrientation`),
never part of the tessellation params or the shape; the runtime `FieldConfig` only carries it for
geometry consumers until the display transform (#763) replaces it. Cairo
rectangles use the canonical `maze-core` layout: every fundamental 4-by-4 coordinate square
contributes two valid pentagon centres, with the complete block rectangle translated around the
grid origin. Other standard forms are rasterized from valid Cairo points around the origin, just
like the other predefined forms. Each
preset shape owns its size parameters (`savedShapes`, keyed by shape name), so switching shapes
does not overwrite another shape's saved dimensions.

### Calculate for print (GitHub issue #615)

Default mode's **Calculate for print** button opens a one-shot dialog. It accepts a paper format
(A0-A5, Letter, Legal, Tabloid, or custom dimensions), portrait/landscape orientation, desired
cell measure in millimeters, and horizontal/vertical print margins. For squares the measure is the
side length; for regular hexagons and triangles it is the diameter of the circumscribed circle.
The cell-measure input is a compact control sized for approximately four digits, including its
native number-input affordances, rather than expanding to the dialog's full row width.
Standard paper sizes reuse
the print export catalog. Margins are per side and default to 5 mm, matching PNG Print settings.

The usable area is:

```text
usable_width  = paper_width  - 2 * horizontal_margin
usable_height = paper_height - 2 * vertical_margin
```

The dialog calculates the largest predefined field that fits this area, rounding cell counts down,
then applies the resulting ordinary `fieldConfig`. With multiple floors and the “apply to
all” switch enabled, each standard floor is recalculated from its own shape and receives its own
resulting configuration; custom-mode floors are left unchanged. No
physical-size settings are added to the generation or WASM config, and the dialog's inputs are not
persisted separately. Square/rectangular forms calculate independent column/row counts. This
includes Cairo's fundamental-square columns and rows; the fit is evaluated from the actual
pentagon bounds of the complete block rectangle, so every cell whose polygon fits inside the
printable area is retained. Radial
forms (`circle`, `hexagon`, `triangle` shapes)
calculate the largest fitting radius; because a
single radius cannot match every paper aspect ratio exactly, the dialog displays the resulting
field dimensions before confirmation. The result describes rectangular forms by field size, radial
forms by field radius, and triangular forms by field side.

`fieldPrintSizing.ts` selects a sizing strategy by shape family: axis-aligned rectangles,
general rectangles/parallelograms, radial shapes, and Cairo rectangles. Shared code owns paper
validation, margins, physical-unit conversion, final polygon-bound measurement, and result
formatting. The Cairo strategy keeps its direct `field_preset_extents` path, which measures real
pentagon bounds without materializing a complete candidate field during the search.

The rectangular search (`calculateBestRectConfig`) measures candidate blocks through core
(`field_preset_extents`), so it keeps the number of measurements small: the widest
column count and tallest row count are found by galloping from a linear estimate (sizes at 1 and
3), then the columns are walked from the widest down, each column's row count starting from the
previous one. The walk stops once `cols * maxRows` cannot beat the best cell count; the most cells
win, then the fullest sheet. The result is exact (checked against a full scan for every
non-axis-aligned kind). It relies on bounds never shrinking as columns or rows grow. The search starts
from the smallest block core accepts (3.12.12 refuses a single row), found by probing up to four
columns/rows. Answers are cached by
tessellation, orientation, shape kind and print input (not by the current size), so floors of one
shape kind are calculated once; each caller receives its own copy. Invalid input or a cell too large for the printable area
disables confirmation.

The dialog is synchronized with the PNG Print settings (`pngExportSettings.print`). When opened,
its paper format, custom dimensions, orientation, and margins are initialized from the current
print settings. When `print.scaleAutoFit` is enabled, the cell measure starts at 10 mm; otherwise it
is derived from `print.scale` and the selected print DPI. On
confirmation, those values are written back to the print settings, with the requested cell measure
converted back to `print.scale` using the selected tessellation's geometry and `scaleAutoFit`
disabled so the panel's automatic-fit effect does not immediately replace the user's physical
size. The print panel's reported physical cell size uses the same geometry-aware conversion.

When multiple floors exist, the dialog also offers **Apply to all floors with standard shape**, enabled
by default. The result section lists floors from top to bottom while numbering them with the same
`N: title` format as the floor switcher. It uses a headerless four-column table: title, shape, dimensions,
and cell count (for example, `Rectangle | 11 × 11 | 121 cells`). Custom-mode floors show
`Non-standard shape`, use `—` in the dimensions cell, and still report
their cell count. A total cell count is shown below the rows. With one floor, the result shows
the calculated field dimensions only.

Changing the confirmed tessellation kind resets the print sizing override (`print.scaleAutoFit` is
enabled again). The next print-sizing dialog starts with a 10 mm cell measure, because the previous
physical size was tied to the old tessellation geometry.

### Paper layout in custom mode (GitHub issue #641)

Custom mode provides a paper-layout switch and a gear button for configuration. The switch and gear
are aligned with the other right-justified field-editor switches. When enabled, the field editor
draws the selected paper's outer edge and the four margin guides behind the editable cells. The
guide uses the same high-contrast frame, outside dimming, and dashed margin guides as the PNG Print
overlay, while remaining in the editor's world coordinate system. It is centered on the field
origin and follows the editor viewport's pan/zoom. Its paper
size, orientation, margins, and cell measure are read from the shared `pngExportSettings.print`
configuration, so changing the layout in this dialog changes the print calculator and PNG Print
settings as well. With automatic print scale enabled, the guide uses a 10 mm cell measure until
the user confirms a physical size. The guide is hidden outside custom mode and is not part of the
generated field or export image.

### Background image print fitting (GitHub issue #675)

Custom mode's background-image settings provide **Transform for print**. The action uses the same
paper format, orientation, and horizontal/vertical margin controls as the field editor's paper
layout, but does not ask for or change cell size, field shape, or any generation parameter. It
fits the loaded image to the selected page's margin-inset rectangle while preserving the image
aspect ratio and centers the result at the page origin. When the custom field editor's paper
layout is already visible, the action skips the dialog and applies the current displayed page
geometry immediately; otherwise it opens the page-layout dialog without changing the paper-layout
visibility.

### Background image field auto-fill (GitHub issue #676)

When the field editor is open in custom mode, the background-image settings panel contains an
**Auto-fill field** section. The section is not shown in other editors or for predefined fields.
It contains a background detection mode (transparent pixels or a selected RGB color), the selected
background color, and a threshold describing the required share of non-background pixels inside a
cell. When the selected-color mode is entered, its default color is read from the source image's
top-left pixel. This inferred color is refreshed only when the detection mode changes; changing
the threshold or manually editing the color does not replace it. The calculation uses the current
grid geometry and the underlay's current crop, scale, and position, classifying the pixels covered
by each grid-cell polygon. While the preview is active, setting changes schedule a recalculation
after a short debounce so rapid slider movement does not start one calculation per input event.

Large cells use deterministic adaptive pixel sampling. Small cells retain the full-resolution
path; larger cells start with the cell center and a regular source-pixel lattice sized for a
bounded sample count. Cells whose estimated foreground share is close to the selected threshold
are sampled again at a finer step, with a full-resolution fallback when they remain ambiguous.
The target count starts at 128 samples per cell and increases smoothly up to 1024 as the
threshold approaches 0% or 100%; large edge-threshold cells use this denser single pass instead
of being forced through full resolution. This reduces pixel reads for large uniform areas while
preserving more reliable classification for ordinary contours; very thin features may still be
missed by the bounded sampling path.

**Preview** is a toggle. Enabling it keeps the current field in memory but hides it on the canvas
and draws the calculated field instead. Changing the mode, color, threshold, grid, or underlay
transform schedules a debounced preview recalculation. Pressing Preview again or Escape cancels the
preview and restores the original field. **Confirm** can be pressed directly without preview; in
preview mode it also accepts Enter. Either path opens a warning that the new shape will completely
replace the existing field. Only after the user confirms does the preview become the active custom
field, the old point set is discarded, and downstream generated/post-edit results are reset.
While the preview is active, field editing is read-only: canvas gestures, keyboard shortcuts,
selection moves/deletes, primitive/mode controls, field clearing, and field-shape/configuration
actions are disabled or ignored. This prevents edits from being applied to the hidden original
field and reappearing if the preview is cancelled. Preview controls themselves remain available.

### Background image sizing on empty fields (GitHub issue #687)

When an underlay is loaded or transformed to the field, fitting uses the current field bounds when
they are large enough to be useful. Empty fields and fields smaller than the default fitting area
use a centered 10-cell by 10-cell world-space rectangle instead. This fallback is used only for
image sizing; it does not add cells, change the custom field, or alter any generation settings.

## Default shape per kind

When `setTessellationKind` or `confirmTessellation` runs without an explicit shape choice, the default shape is the kind's "full" shape. `confirmTessellation` with an unchanged tessellation (same kind, params, hex and triangle orientations) is a no-op for the fields: every floor keeps its field config as is (GitHub issue #881).

| Kind | Default shape |
|---|---|
| `square` | `rect` |
| `hex` | `hexagon` |
| `tri` | `triangle` |
| `cairo` | `rect` |

When either action changes the tessellation kind, it also clears all tessellation-dependent presets,
including teleports, vertical passages, and elevators.

Predefined circle and hexagon configurations use a default radius of `10` cells when no saved
radius exists, except Cairo circle and hexagon configurations, which default to `12` cells, and
hex circle and hexagon shapes, which default to `8` cells. The
default side of the predefined triangular field is `12` cells, while the Cairo triangle defaults
to `20` cells. Existing saved size values are preserved.

## State fields (mazeStore)

Tessellation kind and orientation (`tessellationKind`, `hexOrientation`, `triOrientation`) are
maze-wide — confirmed once in Basic configuration, not per floor. Everything about a floor's own
field — shape, size, custom-drawn cells — is per-floor (GitHub issue #338), keyed by floor id in
`floorFields: Record<floorId, FloorFieldConfig>` (`floorFieldSlice.ts`). Camera-centering, hover
highlight, and the shape-primitive gestures all operate on `floorFields[activeFloorId]` — switching
floors via the floor switcher shows and edits that floor's own shape without touching others.

| Field | Description |
|---|---|
| `fieldSetupOpen` | Whether the field setup card is open (maze-wide UI state) |
| `floorFields[floorId].fieldEditMode` | `"default"` or `"custom"` (card-based sub-mode), per floor |
| `floorFields[floorId].fieldOperation` | Active primitive operation: `"add"`, `"remove"`, or `"select"`, per floor |
| `floorFields[floorId].fieldPrimitive` | Active brush: `"point"` \| `"rectangle"` \| `"circle"` \| `"triangle"` \| `"equilateral_triangle"` \| `"hexagon"` \| `"parallelogram"` \| `"polygon"` \| `"symmetry"` \| `"magic_wand"`, per floor |
| `floorFields[floorId].isEditingField` | True when that floor's active field is custom. Authoritative source for `generate()` (reads the active floor's own value) |
| `floorFields[floorId].fieldPoints` | Active custom cell set for that floor's current kind |
| `floorFields[floorId].freeFieldPoints` | Per-kind cell sets for that floor, including Cairo coordinates, preserved across shape/mode switches |
| `floorFields[floorId].selectedShape` | The preset shape chosen for that floor (a core preset key); applies in default mode and is remembered while a custom field is edited |
| `floorFields[floorId].fieldConfig` | That floor's current `FieldConfig`; a preset shape in default mode, `custom` shape in free-draw mode |
| `floorFields[floorId].savedShapes` | That floor's saved size params per preset shape, restored on shape/mode switch |
| `floorTopology[floorId]` | That floor's fold groups (GitHub issue #839, `Specs/topology.md`, "Web authoring"); edited in the `TopologyPanel` side panel (opened from a button in the custom-field card; `GlueEditorPanel` adds a glue), kept across field edits (activity recomputed), discarded with the maze whenever its active folds change |
| `fieldOpError` | The last refused symmetry preview/apply (`{kind, message?}`), shown in the symmetry panel status; cleared when the preview succeeds |

`fieldPrimitive` resets to `"point"` whenever `fieldEditMode` changes (both directions), same as before, now scoped to the active floor.

A new floor (`addFloor`) starts as a copy of the floor it's stacked on top of — the current topmost floor's own `FloorFieldConfig` at the moment the new floor is created (`floors[floors.length - 1]`, not the *active* floor), not the kind's bare default shape — see `Specs/floors.md`'s `addFloor`. The Field Setup card also offers a manual "Copy floor" action (`copyFloorField`, `CopyFloorDialog.tsx`) — shown only when more than one floor exists — that replaces the active floor's `FloorFieldConfig` with a copy of any other floor's, picked from a list (current floor disabled/unselectable). Removing a floor drops its `floorFields` entry; `selectFloorRemovalLosesFieldData` (`mazeSelectors.ts`) warns when the removed floor's `fieldDirty` is set (see `Specs/floors.md`'s "Loss detection and confirmation"). A `tessellationKind` change (or a kind-changing `confirmTessellation`) rebuilds **every** floor's `FloorFieldConfig` from scratch, since kind/orientation are maze-wide and a stale per-floor config for the old kind would be meaningless.

Generation sends `GenerateConfig.level_fields: Vec<Vec<[i32,i32]>>` to core (GitHub issue #338) — one independent point-set per floor, built from every floor's own `FloorFieldConfig` in `floors` order (`buildGenerateConfig`'s `level_fields`, `generateConfigBuilder.ts`). There is no separate level-count field on the wire; the number of levels generated is `level_fields.length`. `tessellation` (kind/orientation) remains the single maze-wide value. Everything downstream of the initial field build (QC/repair/routing, post-edit, analytics) still only ever operates on floor 0 regardless — see `Specs/floors.md`'s Non-goals and GitHub issue #355.

Any change to a floor's shape, custom points, field mode, copied field, or tessellation orientation asks for confirmation when generation or post-edit results exist; only confirmation invalidates the generated graph and those results (GitHub issue #608). Preset connections and other preset inputs are preserved so the user can regenerate with the revised field.

## Camera behavior

- Card opens in default mode → camera centers on shape centroid (screen-space average of all cells)
- Card opens in custom mode → camera stays where it was
- Default mode, size params change → re-center
- Default mode, shape changes → re-center
- Custom mode, cells added/removed → no camera movement

## Centering algorithm

`configScreenCenter(cfg)`: computes grid coords of all shape cells via `configAllCells`, converts each to screen coords via `gridToScreen`, returns average. Used by `MazeScene.centerOnOrigin`.

## Triangle parity constraint

Triangle tessellation cells have a parity determined by `(col + row) % 2`:
- `0` → pointing-up triangle
- `1` → pointing-down triangle

When centering a triangle shape, the coordinate offset `(ox, oy)` must satisfy `(ox + oy) % 2 === 0` to preserve per-cell parity. If the computed center gives an odd sum, `oy` is decremented by 1 (slight asymmetry, correct rendering).

## Predefined shape cell sets

Predefined shapes are instances of the same primitive shape definitions used by custom-mode
brushes. Their configuration values are converted into a world-space primitive size, then passed
through the same primitive rasterization. Lattice-aligned triangular shapes use complete discrete
layers so the world-space triangle aspect ratio cannot distort their boundaries. A predefined
shape must not maintain a separate cell-coordinate implementation for the same geometry.
Once resolved to cells, a predefined shape uses the tessellation family of its cells for adjacency,
wall, and shared-edge geometry; the shape variant only determines which cells belong to the field.

The generated maze's active runtime field (`ResolvedField`, `resolveFieldConfig`) keeps the same
tessellation config and orientation and replaces the preset shape with a `custom` shape holding
the resolved cell set. Field setup, project serialization/restoration, and resolution retain the
floor's preset `shape`.
Adding a preset shape therefore does not require a generated-maze runtime consumer to support its
shape variant.

| Kind / shape | Cell count | Centering |
|---|---|---|
| square `rect` | `cols × rows` | offset by `floor(cols/2), floor(rows/2)` |
| square `circle` | cells with `x² + y² < r²` | naturally centered |
| square `triangle` | `side × (side + 1) / 2` | centered by its bounding box |
| hex `triangle` | cells whose centers fit the configured triangle | naturally centered |
| hex `rect` | `cols × rows` cells in a screen-aligned rectangle with alternating half-cell offsets | naturally centered |
| hex `parallelogram` | `cols × rows` | offset by `floor(cols/2), floor(rows/2)` |
| hex `circle` | cells whose centers fit the Euclidean radius | naturally centered |
| hex `hexagon` | `3r² + 3r + 1` cells from the axial hex-distance rule | naturally centered on the origin cell |
| tri `rect` | `(2 × cols) × rows` triangle cells; each configured column supplies the complete opposite-orientation pair | centered complete coordinate block |
| tri `triangle` | `n²` | bbox center, parity-safe offset |
| tri `hexagon` | sum of row widths over `2r` rows | bbox center, parity-safe offset |
| tri `circle` | cells whose complete triangles lie within radius `r` | naturally centered, without isolated edge spikes |

## Primitive brushes (custom mode)

The Modes section above Tools controls the operation for every primitive. Add inserts the
primitive's cells, Remove deletes them, and Select previews only the existing field cells without
changing the field. In Add and Remove modes, the right mouse button performs the opposite
operation; right mouse input is ignored in Select mode. The Symmetry tool remains visible
but is disabled in Select mode because it only adds or removes reflected cells. The polygon tool is a single tool;
its operation also comes from the active mode.

Custom mode supports point, shape, polygon, and magic-wand interaction modes controlled by `fieldPrimitive`.
The operation and primitive tools are square icon buttons. Their pressed-state feedback must not
move or resize the button itself, so every point within the visible button, including its top edge,
remains clickable (GitHub issue #685):

Connected Area (magic_wand) — a click processes the connected component containing the clicked
cell. Select previews the occupied component, Remove deletes it, and Add fills a bounded empty
component. Clicking the unbounded empty area does nothing, so Add never attempts to fill the
infinite grid. Right-click applies the opposite Add/Remove operation; it is ignored in Select mode.

**Point** (`"point"`) — original streak mode. Each pointer move over a new cell immediately
applies the active operation. No batch. Cannot be cancelled with Escape. Rebuilding the custom
field configuration after a point edit must not cancel the active streak gesture; only a mode,
floor, tool, or card change ends it.

**Shape primitives** — batch mode. Mousedown begins gesture, drag adjusts shape, mouseup commits all cells in one store update (no per-cell flicker). Escape cancels the gesture without committing.

**Polygon** (`"polygon"`) — click-based batch mode. Each left click places the next vertex in
world coordinates. The Field Setup card exposes one polygon tool. While moving the pointer, the preview follows the cursor continuously; the
unconfirmed closing segment back to the first vertex is dashed. Confirmed vertices are shown as
circles and can be dragged to reposition them. Newly added and dragged vertices snap to the center
of their cell by default; holding Shift enables free movement. A double-click while placing a new
vertex, or a double-click on the last vertex, closes and commits the polygon; clicking the first
cell again or pressing Enter does the same. Escape cancels it. In Add and Remove modes, right
click places polygon vertices and uses the opposite operation; in Select mode it does nothing.
The
preview shows the vertex outline and all cells whose centers are inside the polygon.
Self-intersecting polygons use the even-odd rule.

In Add or Remove mode, polygon commits call `addFieldPoints` or `removeFieldPoints` once with the
stored preview cell set. In Select mode, shape and polygon candidates contain only existing field
cells. Point selection may preview every traversed cell while the button is held; on release its
candidate set is collapsed to existing field cells and replaced by a filled contour inset from the cell edges;
the field is not changed and the selection remains visible until another gesture, tool, mode, or
card change. A pending move is confirmed by Space, clicking outside the selection, or switching
the primitive or operation mode.
The mode shortcuts are `+` for Add, `-` for Remove, and `0` for Select. The eight figure tools use `1` through `8` in visible-list order (Point, Rectangle, Circle, right triangle, equilateral triangle, Hexagon, Parallelogram, Polygon); Connected Area uses `A`, and Symmetry uses `S`.
The tool works with square, hexagonal, triangular, and Cairo tessellations and normalizes its
cells with the shared `normalizeCells` routine like every other tool. Cairo primitive inclusion considers only the valid
four orientation classes in its periodic 4×4 coordinate model.

In Select mode, the polygon is drawn using the normal dashed polygon outline while it is being
edited. Once the gesture is released, that outline is replaced by a filled contour with a dashed outline of the
selected cell union, inset from the cell edges the same way region highlights are (internal shared
edges and polygon vertex handles are not rendered). The inset keeps the selection visible where a
selected edge coincides with the solid field boundary. Cells touching only at a corner form
separate contours. Point
selection collects the existing cells reached by the pointer drag and previews those cells in
white until pointerup. Pointerup replaces the white fill with the same inset contour preview.
Once a selection exists, clicking a selected cell enters selection manipulation: dragging previews
the translated cells, Enter confirms the atomic move, Escape cancels the pending drag, and
Backspace/Delete removes the selected source cells. The selection is not changed by a drag until
Enter confirms it. Enter also exits selection manipulation and keeps the current primitive tool.
While a point selection already exists, holding Shift and dragging creates another zone that is
unioned with the current selection; only filled cells are retained when that zone is released. The
selected-cell hover highlight is hidden while the persistent selection is active. During a move,
the source cells are hidden and only the temporary translated cells are shown; pointerup restores
the source until confirmation. The symmetry polygon uses the same white dashed outline and vertex
markers.

### Shape primitives

| Primitive | Tessellation | Drag semantics |
|---|---|---|
| `rectangle` | all | rectangular drag area |
| `circle` | all | ellipse fitted to the drag area, or symmetric ellipse with Shift |
| `triangle` | all | right triangle formed by the drag rectangle's diagonal, or centered directional triangle with Shift |
| `equilateral_triangle` | all | equilateral triangle fitted to the drag frame and oriented with the triangle tessellation; on a triangular tessellation its apex softly snaps to one of six normals of the three edge families |
| `hexagon` | all | hexagon fitted to the drag area in the orientation opposite to the tessellation, or centered hexagon with Shift |

`parallelogram` is not a drag primitive; it is built from three clicks (see below).

Without Shift, shapes use `startGrid` and `endGrid` as the shared normalized drag frame. The frame
is at least one cell wide and high, and the shape is centered in it; the circle is an ellipse when
the frame is not square. The triangle uses one half of that frame along its drag-directed
diagonal. The start cell selects the corresponding frame corner in normal mode; with Shift it
remains the center of the frame. Primitive-specific code only defines the shape inside the frame;
it does not recalculate drag dimensions.
The current drag point is measured in world coordinates, not snapped to a cell center. It
determines the directions and lengths of the frame, so sub-cell movement remains continuous even
on hexagonal and triangular tessellations. Reversing or changing the drag direction mirrors the
triangle instead of always selecting the same upper-left half.

With Shift held, every shape uses `startGrid` as its center while preserving the drag rectangle's
width and height independently. The distance from start to current is mirrored on each axis; the
result is therefore a symmetric rectangle, not a forced square. All dimensions are derived from
the world-space center of the start cell and the current pointer position. The start is therefore
stable regardless of where inside the cell the pointer went down; cell centers are used only when
testing which cells lie inside the resulting shape.
```
gridRadius = max(1, round(screenPixelDistance / (TILE_SIZE × viewportScale)))
```
Zoom-dependent by design: same pixel drag → same number of cells regardless of zoom level. Minimum radius is 1 (a click-without-drag yields the minimal shape).

With Ctrl held, the frame's width and height are constrained to the same value. Ctrl therefore
restores square proportions; Shift+Ctrl makes that square grow symmetrically from the start cell.

### Parallelogram tool (GitHub issue #867)

The tool is click-based and works on every tessellation. Click 1 and click 2 define the base
edge; the third click defines the second side (and thus the angle) and commits. The fourth vertex
is derived: `a, b, b + s, a + s` with `s` running from `a` to the pointer. The preview follows the
cursor after each click; Enter commits the current preview, Escape cancels, and switching tool or
card discards pending points. Cells are the ones whose centers lie inside the outline, normalized
like every other tool (`normalizeCells`). Select mode shows the dashed outline.

Edge alignment is on by default. `tessellationEdgeDirections` (`pixi/parallelogramGeometry.ts`)
collects the distinct edge directions of the tessellation's cells (sampled over a 4×4 cell
block, so Cairo's orientation classes are covered). The base end snaps to the nearest direction
within 12°, and the second side snaps to the nearest direction other than the base's. Shift
disables snapping and uses exact pointer positions. Tessellations with more than 12 distinct edge
directions (curved or irregular ones such as radial or voronoi) have no usable axes, so the angle
stays free there. Without Shift the clicked points are cell centers. Ctrl makes the second side as long as the base. Degenerate (zero-area) results are
ignored.

The mouse button of the first click fixes the operation for the whole shape: later clicks of
either button only place points, so a right-click on the third point of an Add parallelogram still
adds. The outline is drawn closed with every side in the same style (solid; dashed in Select
mode). A press-drag-release also works: the press places the first point and the release, if the
pointer moved at least 3px, places the second. While the base is being dragged, the preview is a
solid two-point line with both ends marked. The parallelogram reports its size in the status bar
like the other shape primitives (`Parallelogram: W×H (N)`).

### Preview overlay

While dragging, a semi-transparent overlay shows the pending shape. In Add mode it uses the Add
color for LMB and the Remove color for RMB; Remove mode reverses those colors. Select mode uses
the white selection color and ignores RMB.

Custom mode also provides a `Primitive frame` switch. When enabled, a thin outline shows the
ideal world-space primitive behind the tile preview; it is visual only and does not affect the
committed cells. Hover highlighting is hidden for the duration of a drag so it cannot obscure the
primitive preview. Control strokes (solid and dashed frames, including vertex outlines) keep a
minimum 1.25px screen-space thickness at every zoom level.

Every tool normalizes its result with one routine (`normalizeCells`): it removes cells that have
no edge-adjacent neighbor and, with `Smoothing` enabled, one-edge terminal cells, repeating until no
cell changes so removing one spike cannot leave a new one. When adding, cells already in the field
count as neighbors but are never removed. For remove and select no existing cells are used: only
the shape's own cells are normalized, and the result is then intersected with the field, so
smoothing matches the outline the user sees. Default-mode tessellation normalization has no
existing cells and runs without anchors.
The `Smoothing` toggle is available in both Default and Custom modes. It normalizes standard-field
cells and primitive results; point-by-point editing is unchanged. Changing it in Default mode
updates the displayed field and resets generation and post-edit results.

Select-mode shape and polygon frames are dashed while the gesture is being edited. Preview is
RAF-throttled. `clear()` nulls `pendingCells` so a pending RAF frame skips the redraw if `clear()` fires first.

### Size readout (GitHub issue #863)

The status bar (`HoverInfoPanel`) shows `Selection: W×H (N)` for the current selection preview
(including the in-progress point selection and a pending move) and `<Shape name>: W×H (N)` (e.g. `Rectangle: 3×2 (6)`, localized primitive name) while a shape
primitive or polygon is being built. `W`/`H` are the inclusive spans of the distinct grid x / y values of
the cells and `N` is the cell count, so on non-square tessellations they are index spans, not
geometric extents. `FieldEditController` computes it with `measureCells` (`pixi/fieldSizeReadout.ts`)
and reports changes through `onSizeReadout` -> `MazeScene.setFieldSizeListener`. The polygon
reports the cells inside its preview outline, including the cursor vertex. Any primitive
preview clear resets both values; showing a selection resets the shape value.

### Gesture cancellation

Escape key cancels any active shape-primitive or polygon gesture and clears a persistent selection
preview or pending selection drag; nothing further is committed. Point Add/Remove gestures are not
cancellable (cells are already committed individually on each move).

### Commit

On mouseup in Add/Remove mode: `addFieldPoints(cells)` or `removeFieldPoints(cells)` is called
with stored `lastPreviewCells` — never recomputed at commit time to prevent preview/commit
divergence. Select mode initially only updates the transient boundary preview; a confirmed
selection drag calls `moveFieldPoints(cells, vector)` (a translation vector in core world units) once on Enter, Space, clicking outside the
selection, releasing the pointer outside the canvas, or switching the primitive/operation mode,
while Delete/Backspace calls
`removeFieldPoints(cells)`.

### Move (GitHub issue #762)

A selection moves through core's `field_translate_cells`. During the drag, the pointer cell's center
minus the drag start cell's center gives the translation vector; the preview is the translated
selection. A pointer position that is not a translation symmetry of the tessellation, or that
leaves it, keeps the last valid preview, so the selection snaps between valid positions. Every
other refusal does the same. The drag only
starts when `translate` is offered. `moveFieldPoints` translates the selected cells through core
and replaces them in the field; a refusal leaves the field unchanged.

## Grid overlay

Grid rendering is embedded in each feature renderer, not in a standalone component:

- **`TessellationRenderer`** — shows `previewFieldConfig` grid when no feature card is open (`!fieldSetupOpen && !presetConnectionsOpen && !generationOpen`). Hidden the moment any card opens. Redraws on viewport change or `previewFieldConfig` change.
- **`FieldEditorOverlay`** — renders grid using `fieldConfig` while `fieldSetupOpen = true`. Redraws on viewport change or config change.
- **`PresetConnectionsRenderer`** — renders grid using `fieldConfig` while `presetConnectionsOpen = true`. Redraws on viewport change or config change.

## Synchronized underlay (GitHub issue #673)

The Field Setup, Preset Connections, and Post-Edit feature cards share one visual-only background
underlay. Each card shows an `Underlay` switch, initially off. Enabling it for the first
time opens an image upload dialog; cancelling leaves the switch off. The uploaded file and its
natural dimensions are shared between the three cards and persisted in the project file.

The underlay defaults to below the grid with 50% opacity, and can be configured from the gear
button beside the switch (GitHub issue #674): below the grid, above the grid, above the floor, or
above everything, plus opacity from 0 to 1. The underlay is not passed to generation, renderers, image export,
analytics, or any other processing. When the image is first uploaded, it is scaled once with
`contain` semantics against the current field bounds and centered on the field. Its display
transform is retained when the switch is turned off and on again. The settings panel also offers
`Transform to field`, which reapplies the contain-and-center calculation to the current cropped
fragment. The
original aspect ratio is always preserved, so empty space may remain along one axis of the field.

For the `above_grid` mode, the render order is grid, underlay, floor cells, then the remaining
feature overlays. This keeps the underlay above grid lines but below field/floor cells. In the
`above_floor` mode, the order is grid, floor cells, underlay, then the remaining feature overlays.
This keeps walls, markers, and other feature elements above the underlay. In the Field Setup card,
the controls are ordered as primitive frame, smoothing, paper layout, underlay, and origin.

The settings panel also provides `Replace underlay` and a manual positioning mode. These related
positioning/image buttons are grouped with a compact item gap. In manual mode
the shared canvas interaction consumes left-button drags over the image to move it; dragging a
corner resizes it while preserving the source aspect ratio. The resulting transform, layer, and
opacity are persisted with the image. Files saved before issue #674 default to the original
below-grid/50% behavior.

Closing the settings panel or hiding the underlay cancels any in-progress auto-fill preview and
restores the committed field; it does not apply an unconfirmed candidate. While the preview is active, canvas edit clicks are ignored and raise the `field_edit.auto_fill_preview_active` notice (deduplicated; pan gestures with space or the middle button are not affected) (GitHub issue #772).

The same settings panel provides a `Crop` mode (GitHub issue #680), separate from the existing
manual positioning mode, here called `Transform`. The modes are mutually exclusive and can be
entered from any of the three shared-underlay editors: Field Setup, Preset Connections, and
Post-Edit. `Crop` changes the source-image rectangle that remains visible and renders only that
source fragment; it is not viewport clipping. The cropped fragment keeps its current transform,
and `Transform` scales and moves that fragment. Clicking the active mode button toggles that mode
off; clicking the other mode switches directly to it. Switching modes at any time preserves the
crop, scale, and position. Escape, Enter, Space, clicking outside the canvas, or clicking outside
the active underlay exits the active mode using the same interaction contract as Transform. Hiding
the underlay also closes its settings panel.

## Field boundary frame (GitHub issue #684)

While the Field Setup card is open, the editor draws a single wall-style frame around the currently
displayed field, both with and without a background underlay and in both default and custom modes.
It uses the same `buildPresetWallGroups` boundary-edge selection and `WallRenderer` as Preset
Connections, including the shared wall color, width, cap, and join. The frame follows holes,
disconnected regions, and irregular square, hexagonal, and triangular fields rather than assuming a
rectangular outer box. It follows auto-fill and selection-move previews as well as the committed
field. The frame is an editor aid only; it is not included in field points, generation, post-edit
results, or image export.

## Hover highlight (custom mode)

While `fieldSetupOpen = true` and the cursor is over the canvas, the hovered cell is highlighted
with the active operation color (Add green, Remove red, Select white; alpha 0.3). The Connected
Area tool highlights its whole bounded/occupied connected component instead of only the hovered
cell. Rendered by `FieldEditorOverlay.updateHover()`, called from `MazeScene` on every
`pointermove`. The hover is hidden while a persistent Select-mode selection is active. Cleared on
`pointerupoutside`.

The same `pointermove` also drives the generic `x, y` coordinate readout in `HoverInfoPanel` (see `maze-web/Specs/renderer.md`) — that mechanism is card-agnostic and runs regardless of `fieldSetupOpen`; this section only covers the field-edit-specific operation-colored cell overlay layered on top of it.

## Hit-test

Square/hex: rectangular row/column lookup.

Triangle: nearest-centroid among `col0-1, col0, col0+1` candidates. Each centroid position depends on parity:

## Symmetry tool (GitHub issue #654)

Custom mode includes a Symmetry tool. It collects two snapped or free points for an infinite
symmetry axis, previews the reflected cells, and changes the field only when the user confirms.
The right-side symmetry panel uses toggle buttons for Cell centers/Cell corners/Free snapping and
Everything/One side/Polygon processing. One side is the default scope. Add/remove is selected in
the field editor's Modes section.
Only active cells are used as the source.
One-side mode chooses the initial source side from the field when the axis is completed and
exposes a direction toggle. Polygon mode reuses the field editor's editable polygon gesture and
has reset and explicit finish actions.
Resetting the axis keeps a completed processing polygon so it can be reused with a replacement axis.
When a replacement axis is completed, it is validated before the panel asks for a processing polygon;
an invalid axis shows its warning instead.

The axis is rendered as an infinite line, and one-side mode renders an arrow from the source side
toward the reflected side. Every processing-polygon edge, including its closing edge, is dashed.
Axis, arrow, and polygon-outline strokes keep a minimum 1.25px
screen-space thickness at every zoom level. Preview cells use the active field-editor mode's add/remove color. Cells whose centers
lie on the axis are excluded. Confirmation is disabled until the axis exists and, for Polygon
processing, the polygon has at least three points and has been explicitly finished. Enter finishes
an unfinished polygon; when the symmetry status is ready, Enter confirms the operation. The
operation applies the selected scope to the active cells in the current custom field, then merges
or removes the reflected cells according to the active field-editor mode. After confirmation, the symmetry geometry is cleared and the normal
point tool is restored; the symmetry settings remain unchanged.

The reflected cells come from core's `field_reflect_cells` (GitHub issue #762); the axis is passed
in core world space. Core accepts only axes that are true reflection symmetries of the tessellation.
A free axis that is not one is not applied: the preview shows no mirrored cells and the core error
(`not_a_symmetry`) is shown to the user; confirmation does not change the field. The tool stays visible but disabled
(tooltip "Unavailable in this tessellation", and its shortcut does nothing) when `reflect` is not offered.

### Field operation errors

The symmetry panel keeps the Apply button with the other action buttons; below them is the status
area, which shows at most one bubble. A ready configuration shows nothing. When the user still has
to act (build the axis, build or finish the polygon) it shows an info bubble. A refusal of core's
reflection (`FieldOpError`: `unavailable`, `not_a_symmetry`, `outside_tessellation`) shows a warning bubble with the message (strings `field.op_error.*`), says
why the axis does not fit and how to fix it, and disables Apply. The error is stored in
`fieldOpError` and cleared when the preview is computed without error, the axis is incomplete, or
the panel closes. The field setup card shows no operation errors. A selection move refused by core is not reported: the preview keeps its last
valid position.
- pointing-up: `cy = -(row × H + H/3)`
- pointing-down: `cy = -(row × H + 2H/3)`
