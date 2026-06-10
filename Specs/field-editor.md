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

Switching default→custom preserves existing drawn points. Switching custom→default restores the predefined config with saved size params. Closing the card resets `fieldEditMode` to "default".

## State fields (mazeStore)

| Field | Description |
|---|---|
| `fieldSetupOpen` | Whether the field setup card is open |
| `fieldEditMode` | `"default"` or `"custom"` (card-based sub-mode) |
| `isEditingField` | True when active field is custom. Authoritative source for `generate()` |
| `fieldPoints` | Active custom cell set for current kind |
| `freeFieldPoints` | Per-kind cell sets, preserved across shape/mode switches |
| `tessellationConfig` | Current config; predefined in default mode, custom (`*_custom`) in free-draw mode |
| `savedConfigs` | Saved size params per predefined config type, restored on shape/mode switch |

## Camera behavior

- Card opens → camera centers on shape centroid (screen-space average of all cells)
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

## Grid overlay

`GridOverlay` shows the tessellation grid when no maze nodes exist. Selects config via `pickConfig`:
- `fieldSetupOpen = true` → uses `tessellationConfig`
- `fieldSetupOpen = false` → uses `previewTessellationConfig`

Redraws on viewport change, config change, or `fieldSetupOpen` toggle.

## Hit-test

Square/hex: rectangular row/column lookup.

Triangle: nearest-centroid among `col0-1, col0, col0+1` candidates. Each centroid position depends on parity:
- pointing-up: `cy = -(row × H + H/3)`
- pointing-down: `cy = -(row × H + 2H/3)`
