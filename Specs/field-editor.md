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

**Custom** — free-draw mode. Left-click adds cells, right-click removes. Space or middle mouse pans the camera. Camera does not move while drawing. `isEditingField = true`, `fieldPoints` reflects the drawn set.

Switching default→custom preserves existing drawn points. Switching custom→default restores the predefined config with saved size params. Closing the card does **not** reset `fieldEditMode` — when the card reopens, it restores whichever mode was active.

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
then applies the resulting ordinary `tessellationConfig` through `setTessellationConfig`. No
physical-size settings are added to the generation or WASM config, and the dialog's inputs are not
persisted separately. Square/rectangular forms calculate independent column/row counts. Radial
forms (`hexagon`, `triangle`, `triangle_hexagon`) calculate the largest fitting radius; because a
single radius cannot match every paper aspect ratio exactly, the dialog displays the resulting
field footprint before confirmation. The result describes rectangular forms by field size, radial
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

When multiple floors exist, the dialog also offers **Apply to all floors**, enabled by default.
Confirmation applies the calculated predefined configuration to every floor in standard editing
mode and leaves custom-mode floors unchanged. The dialog labels the exception below the switch.

Changing the confirmed tessellation kind resets the print sizing override (`print.scaleAutoFit` is
enabled again). The next print-sizing dialog starts with a 10 mm cell measure, because the previous
physical size was tied to the old tessellation geometry.

## Default shape per kind

When `setTessellationKind` or `confirmTessellation` runs without an explicit shape choice, the default shape is the kind's "full" shape:

| Kind | Default shape | Config type |
|---|---|---|
| `square` | `rect` | `square` |
| `hex` | `hexagon` | `hex_hexagon` |
| `triangle` | `triangle` | `triangle_triangle` |

When either action changes the tessellation kind, it also clears all tessellation-dependent presets,
including teleports, vertical passages, and elevators.

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
| `floorFields[floorId].fieldPrimitive` | Active brush: `"point"` \| `"square_rect"` \| `"hex_parallelogram"` \| `"hex_hexagon"` \| `"tri_rect"` \| `"tri_triangle"` \| `"tri_hexagon"`, per floor |
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

| Config type | Cell count | Centering |
|---|---|---|
| `square` | `width × height` | offset by `floor(w/2), floor(h/2)` |
| `hex_parallelogram` | `cols × rows` | offset by `floor(cols/2), floor(rows/2)` |
| `hex_hexagon` | `3r² + 3r + 1` | naturally centered (generated around origin) |
| `triangle_rect` | `cols × rows` | parity-safe offset |
| `triangle_triangle` | `n²` | bbox center, parity-safe offset |
| `triangle_hexagon` | sum of row widths over `2r` rows | bbox center, parity-safe offset |

## Primitive brushes (custom mode)

Custom mode supports two drawing modes controlled by `fieldPrimitive`:

**Point** (`"point"`) — original streak mode. Each pointer move over a new cell immediately adds/removes it. No batch. Cannot be cancelled with Escape.

**Shape primitives** — batch mode. Mousedown begins gesture, drag adjusts shape, mouseup commits all cells in one store update (no per-cell flicker). Escape cancels the gesture without committing.

### Shape primitives

| Primitive | Tessellation | Drag semantics |
|---|---|---|
| `square_rect` | square | corner-to-corner rectangle |
| `hex_parallelogram` | hex | corner-to-corner parallelogram (axial coords) |
| `hex_hexagon` | hex | center = mousedown, radius grows with drag distance |
| `tri_rect` | triangle | corner-to-corner rectangle (all parities included) |
| `tri_triangle` | triangle | center = mousedown, triangular shape grows with drag distance |
| `tri_hexagon` | triangle | center = mousedown, hexagonal tri-grid shape grows with drag distance |

**Corner-to-corner** shapes use `startGrid` and `endGrid` as opposite corners.

**Center-radius** shapes use `startGrid` as center. `gridRadius` is computed from drag distance:
```
gridRadius = max(1, round(screenPixelDistance / (TILE_SIZE × viewportScale)))
```
Zoom-dependent by design: same pixel drag → same number of cells regardless of zoom level. Minimum radius is 1 (a click-without-drag yields the minimal shape).

### Preview overlay

While dragging, a semi-transparent overlay shows the pending shape:
- Left button (add): blue `0x4488ff`, alpha 0.5
- Right button (remove): red `0xff4444`, alpha 0.5

Preview is RAF-throttled. `clear()` nulls `pendingCells` so a pending RAF frame skips the redraw if `clear()` fires first.

### Gesture cancellation

Escape key cancels any active shape-primitive gesture: preview clears, nothing committed. Point-streak gestures are not cancellable (cells already committed individually on each move).

### Commit

On mouseup: `addFieldPoints(cells)` or `removeFieldPoints(cells)` called with stored `lastPreviewCells` — never recomputed at commit time to prevent preview/commit divergence.

## Grid overlay

Grid rendering is embedded in each feature renderer, not in a standalone component:

- **`TessellationRenderer`** — shows `previewTessellationConfig` grid when no feature card is open (`!fieldSetupOpen && !presetConnectionsOpen && !generationOpen`). Hidden the moment any card opens. Redraws on viewport change or `previewTessellationConfig` change.
- **`FieldEditorOverlay`** — renders grid using `tessellationConfig` while `fieldSetupOpen = true`. Redraws on viewport change or config change.
- **`PresetConnectionsRenderer`** — renders grid using `tessellationConfig` while `presetConnectionsOpen = true`. Redraws on viewport change or config change.

## Hover highlight (custom mode)

While `fieldSetupOpen = true` and the cursor is over the canvas, the hovered cell is highlighted with a soft grey overlay (`0x888888`, alpha 0.3). Rendered by `FieldEditorOverlay.updateHover()`, called from `MazeScene` on every `pointermove`. Cleared on `pointerupoutside`.

The same `pointermove` also drives the generic `x, y` coordinate readout in `HoverInfoPanel` (see `maze-web/Specs/renderer.md`) — that mechanism is card-agnostic and runs regardless of `fieldSetupOpen`; this section only covers the field-edit-specific grey-cell overlay layered on top of it.

## Hit-test

Square/hex: rectangular row/column lookup.

Triangle: nearest-centroid among `col0-1, col0, col0+1` candidates. Each centroid position depends on parity:
- pointing-up: `cy = -(row × H + H/3)`
- pointing-down: `cy = -(row × H + 2H/3)`
