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

## State fields (mazeStore)

| Field | Description |
|---|---|
| `fieldSetupOpen` | Whether the field setup card is open |
| `fieldEditMode` | `"default"` or `"custom"` (card-based sub-mode) |
| `fieldPrimitive` | Active brush: `"point"` \| `"square_rect"` \| `"hex_parallelogram"` \| `"hex_hexagon"` \| `"tri_rect"` \| `"tri_triangle"` \| `"tri_hexagon"` |
| `isEditingField` | True when active field is custom. Authoritative source for `generate()` |
| `fieldPoints` | Active custom cell set for current kind |
| `freeFieldPoints` | Per-kind cell sets, preserved across shape/mode switches |
| `tessellationConfig` | Current config; predefined in default mode, custom (`*_custom`) in free-draw mode |
| `savedConfigs` | Saved size params per predefined config type, restored on shape/mode switch |

`fieldPrimitive` resets to `"point"` whenever `fieldEditMode` changes (both directions).

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

## Hit-test

Square/hex: rectangular row/column lookup.

Triangle: nearest-centroid among `col0-1, col0, col0+1` candidates. Each centroid position depends on parity:
- pointing-up: `cy = -(row × H + H/3)`
- pointing-down: `cy = -(row × H + 2H/3)`
