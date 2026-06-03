# IO

## Purpose

Debug visualization and output. Tessellation-specific renderers — each tessellation may have its own renderer.

## render_ascii (SquareField)

```rust
pub fn render_ascii(maze: &Maze<SquareField>) -> String
```

Double-cell ASCII renderer for square grids.

### Output dimensions

- Width: `4 * field_width + 1` characters
- Height: `2 * field_height + 1` lines

### Layout

- Corner `(4x, 2y)` → `+`
- Cell interior `(4x+1..4x+3, 2y+1)` → spaces

### Coordinate orientation

Y increases upward. Rows printed top-to-bottom (highest Y first).

### Wall and passage slots

Each slot queries both directed edges independently:
```rust
let ab = maze.graph.edge_between(a, b).is_some();
let ba = maze.graph.edge_between(b, a).is_some();
```

**Horizontal slot** — 3 characters at `(4x+1, 4x+2, 4x+3)` in row `2y`.
`point_a = (x, y)` (north cell), `point_b = (x, y-1)` (south cell).
`ab` = north→south, `ba` = south→north.

| ab  | ba  | chars       |
|-----|-----|-------------|
| T   | T   | `   ` (open passage) |
| T   | F   | ` v ` (southward arrow) |
| F   | T   | ` ^ ` (northward arrow) |
| F   | F   | `---` (wall) |

**Vertical slot** — 1 character at column `4x` in row `2y+1`.
`point_a = (x, y)` (east cell), `point_b = (x-1, y)` (west cell).
`ab` = east→west, `ba` = west→east.

| ab  | ba  | char |
|-----|-----|------|
| T   | T   | ` ` (open passage) |
| T   | F   | `<` (westward arrow) |
| F   | T   | `>` (eastward arrow) |
| F   | F   | `\|` (wall) |

Outer border slots always render as walls (`---` / `|`).

## Future

- Renderers for hex and other tessellations
- Export formats (JSON, binary)
- Graph structure logging
