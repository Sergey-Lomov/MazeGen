# Field Editor

Defines the shape of the maze field before generation. Operates on a confirmed tessellation kind.

## Modes

Two parallel mechanisms for custom fields exist:

### Predefined shapes (legacy ControlPanel flow)
Shape selector in ControlPanel includes a "free" option. Selecting it sets `squareShape/hexShape/triangleShape = "free"`, which sets `isEditingField = true` and exposes `freeFieldPoints[kind]` as `fieldPoints`. Points are drawn directly on the canvas at any time.

### Card-based editing (FieldSetupFeature)
Opened via the Field Setup card in FeaturesPanel. Requires tessellation to be confirmed first.

Two sub-modes toggled inside the card:

**Default** — predefined shape with configurable size parameters (width/height, cols/rows, radius, side). Canvas shows all cells of the shape centered around the grid origin. Camera centers on the shape when the card opens or when size params change.

**Custom** — free-draw mode. The active Add/Remove mode controls whether drawing adds or removes
cells; Select previews existing cells. Space or middle mouse pans the camera. Camera does not move
while drawing. `isEditingField = true`, `fieldPoints` reflects the drawn set.

Switching default→custom preserves existing drawn points. Switching custom→default restores the predefined config with saved size params. Closing the card does **not** reset `fieldEditMode` — when the card reopens, it restores whichever mode was active.

### Available predefined shapes

The field-shape selector exposes these additional shapes:

| Tessellation | Shape | Config type | Parameters |
|---|---|---|---|
| Square | Circle | `square_circle` | radius |
| Square | Triangle | `square_triangle` | side |
| Hexagonal | Rectangle | `hex_rectangle` | columns, rows |
| Hexagonal | Circle | `hex_circle` | radius |
| Hexagonal | Triangle | `hex_triangle` | side |
| Triangular | Circle | `triangle_circle` | radius |

The existing parallelogram, hexagon, triangle, and rectangular variants remain available. Each
predefined config type owns its size parameters, so switching shapes does not overwrite another
shape's saved dimensions.

### Calculate for print (GitHub issue #615)

Default mode's **Calculate for print** button opens a one-shot dialog. It accepts a paper format
(A0-A5, Letter, Legal, Tabloid, or custom dimensions), portrait/landscape orientation, desired
cell measure in millimeters, and horizontal/vertical print margins. For squares the measure is the
side length; for regular hexagons and triangles it is the diameter of the circumscribed circle.
Standard paper sizes reuse
the print export catalog. Margins are per side and default to 5 mm, matching PNG Print settings.

The usable area is:

```text
usable_width  = paper_width  - 2 * horizontal_margin
usable_height = paper_height - 2 * vertical_margin
```

The dialog calculates the largest predefined field that fits this area, rounding cell counts down,
then applies the resulting ordinary `tessellationConfig`. With multiple floors and the “apply to
all” switch enabled, each standard floor is recalculated from its own shape and receives its own
resulting configuration; custom-mode floors are left unchanged. No
physical-size settings are added to the generation or WASM config, and the dialog's inputs are not
persisted separately. Square/rectangular forms calculate independent column/row counts. Radial
forms (`square_circle`, `hex_circle`, `triangle_circle`, `hexagon`, `triangle`, `triangle_hexagon`)
calculate the largest fitting radius; because a
single radius cannot match every paper aspect ratio exactly, the dialog displays the resulting
field dimensions before confirmation. The result describes rectangular forms by field size, radial
forms by field radius, and triangular forms by field side. Invalid input or a cell too large for the printable area
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

## Default shape per kind

When `setTessellationKind` or `confirmTessellation` runs without an explicit shape choice, the default shape is the kind's "full" shape:

| Kind | Default shape | Config type |
|---|---|---|
| `square` | `rect` | `square` |
| `hex` | `hexagon` | `hex_hexagon` |
| `triangle` | `triangle` | `triangle_triangle` |

When either action changes the tessellation kind, it also clears all tessellation-dependent presets,
including teleports, vertical passages, and elevators.

Predefined circle and hexagon configurations use a default radius of `10` cells when no saved
radius exists, except `hex_circle` and `hex_hexagon` on hexagonal tessellations, which default
to `8` cells. The default side of the predefined triangular field is `12` cells. Existing saved
size values are preserved.

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
| `floorFields[floorId].freeFieldPoints` | Per-kind cell sets for that floor, preserved across shape/mode switches |
| `floorFields[floorId].tessellationConfig` | That floor's current config; predefined in default mode, custom (`*_custom`) in free-draw mode |
| `floorFields[floorId].savedConfigs` | That floor's saved size params per predefined config type, restored on shape/mode switch |

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

The generated maze's active runtime field is normalized to `kind` (`square`, `hex`, or
`triangle`), the family orientation where applicable, and the resolved cell set. Field setup,
project serialization/restoration, and resolution retain the detailed `FieldConfig.type` value.
Adding a preset shape therefore does not require a generated-maze runtime consumer to support its
shape variant.

| Config type | Cell count | Centering |
|---|---|---|
| `square` | `width × height` | offset by `floor(w/2), floor(h/2)` |
| `square_circle` | cells with `x² + y² < r²` | naturally centered |
| `square_triangle` | `side × (side + 1) / 2` | centered by its bounding box |
| `hex_triangle` | cells whose centers fit the configured triangle | naturally centered |
| `hex_rectangle` | `cols × rows` cells in a screen-aligned rectangle with alternating half-cell offsets | naturally centered |
| `hex_parallelogram` | `cols × rows` | offset by `floor(cols/2), floor(rows/2)` |
| `hex_circle` | cells whose centers fit the Euclidean radius | naturally centered |
| `hex_hexagon` | `3r² + 3r + 1` cells from the axial hex-distance rule | naturally centered on the origin cell |
| `triangle_rect` | `(2 × cols) × rows` triangle cells; each configured column supplies the complete opposite-orientation pair | centered complete coordinate block |
| `triangle_triangle` | `n²` | bbox center, parity-safe offset |
| `triangle_hexagon` | sum of row widths over `2r` rows | bbox center, parity-safe offset |
| `triangle_circle` | cells whose complete triangles lie within radius `r` | naturally centered, without isolated edge spikes |

## Primitive brushes (custom mode)

The Modes section above Tools controls the operation for every primitive. Add inserts the
primitive's cells, Remove deletes them, and Select previews only the existing field cells without
changing the field. In Add and Remove modes, the right mouse button performs the opposite
operation; right mouse input is ignored in Select mode. The Symmetry tool remains visible
but is disabled in Select mode because it only adds or removes reflected cells. The polygon tool is a single tool;
its operation also comes from the active mode.

Custom mode supports point, shape, polygon, and magic-wand interaction modes controlled by `fieldPrimitive`:

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
candidate set is collapsed to existing field cells and replaced by a dashed exposed boundary;
the field is not changed and the selection remains visible until another gesture, tool, mode, or
card change. A pending move is confirmed by Space, clicking outside the selection, or switching
the primitive or operation mode.
The mode shortcuts are `+` for Add, `-` for Remove, and `0` for Select.
The tool works with square, hexagonal, and triangular tessellations and does not apply primitive
smoothing or isolated-cell cleanup.

In Select mode, the polygon is drawn using the normal dashed polygon outline while it is being
edited. Once the gesture is released, that outline is replaced by dashed exposed edges of the
selected cell union (internal shared edges and polygon vertex handles are not rendered). Point
selection collects the existing cells reached by the pointer drag and previews those cells in
white until pointerup. Pointerup replaces the white fill with the same dashed boundary preview.
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
| `parallelogram` | all | world-space parallelogram fitted to the drag area, with a fixed hex-grid axis angle and the drag start on a frame vertex |

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
For `parallelogram`, Ctrl uses a primitive-specific constraint instead: the frame is adjusted so
the parallelogram's adjacent sides are equal while its axis angle remains fixed.

### Preview overlay

While dragging, a semi-transparent overlay shows the pending shape. In Add mode it uses the Add
color for LMB and the Remove color for RMB; Remove mode reverses those colors. Select mode uses
the white selection color and ignores RMB.

Custom mode also provides a `Primitive frame` switch. When enabled, a thin outline shows the
ideal world-space primitive behind the tile preview; it is visual only and does not affect the
committed cells. Hover highlighting is hidden for the duration of a drag so it cannot obscure the
primitive preview.

Primitive results always remove cells that have no edge-adjacent neighbor. With `Smoothing` enabled,
one-edge terminal cells are removed first and isolated-cell cleanup is applied again afterward.
Smoothing affects primitive tools only; point-by-point editing is unchanged.

Select-mode shape and polygon frames are dashed while the gesture is being edited. Preview is
RAF-throttled. `clear()` nulls `pendingCells` so a pending RAF frame skips the redraw if `clear()` fires first.

### Gesture cancellation

Escape key cancels any active shape-primitive or polygon gesture and clears a persistent selection
preview or pending selection drag; nothing further is committed. Point Add/Remove gestures are not
cancellable (cells are already committed individually on each move).

### Commit

On mouseup in Add/Remove mode: `addFieldPoints(cells)` or `removeFieldPoints(cells)` is called
with stored `lastPreviewCells` — never recomputed at commit time to prevent preview/commit
divergence. Select mode initially only updates the transient boundary preview; a confirmed
selection drag calls `moveFieldPoints(cells, dx, dy)` once on Enter, Space, clicking outside the
selection, releasing the pointer outside the canvas, or switching the primitive/operation mode,
while Delete/Backspace calls
`removeFieldPoints(cells)`.

## Grid overlay

Grid rendering is embedded in each feature renderer, not in a standalone component:

- **`TessellationRenderer`** — shows `previewTessellationConfig` grid when no feature card is open (`!fieldSetupOpen && !presetConnectionsOpen && !generationOpen`). Hidden the moment any card opens. Redraws on viewport change or `previewTessellationConfig` change.
- **`FieldEditorOverlay`** — renders grid using `tessellationConfig` while `fieldSetupOpen = true`. Redraws on viewport change or config change.
- **`PresetConnectionsRenderer`** — renders grid using `tessellationConfig` while `presetConnectionsOpen = true`. Redraws on viewport change or config change.

## Synchronized underlay (GitHub issue #673)

The Field Setup, Preset Connections, and Post-Edit feature cards share one visual-only background
underlay. Each card shows a `Show underlay` switch, initially off. Enabling it for the first
time opens an image upload dialog; cancelling leaves the switch off. The uploaded file and its
natural dimensions are shared between the three cards and persisted in the project file.

The underlay is drawn below the grid and the editable-cell fill, while remaining above the base
canvas background, with 50% opacity. The underlay is not passed to generation, renderers, image
export, analytics, or any other processing. When the switch is enabled, the underlay is scaled once
with `cover` semantics against the current field bounds, centered on the field, and its display
transform is retained while the field is edited. Turning it off and on again recalculates that
transform. The original aspect ratio
is always preserved, so an image may extend past the field boundary.

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

The axis is rendered as an infinite line, and one-side mode renders an arrow from the source side
toward the reflected side. Preview cells use the active field-editor mode's add/remove color. Cells whose centers
lie on the axis are excluded. Confirmation is disabled until the axis exists and, for Polygon
processing, the polygon has at least three points and has been explicitly finished. Enter finishes
an unfinished polygon; when the symmetry status is ready, Enter confirms the operation. The
operation applies the selected scope to the active cells in the current custom field, then merges
or removes the reflected cells according to the active field-editor mode. After confirmation, the symmetry geometry is cleared and the normal
point tool is restored; the symmetry settings remain unchanged.
- pointing-up: `cy = -(row × H + H/3)`
- pointing-down: `cy = -(row × H + 2H/3)`
