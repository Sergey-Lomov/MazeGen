# IO

## Purpose

Debug visualization and output. Tessellation-specific renderers — each tessellation may have its own renderer.

## render_ascii (SquareField)

```rust
pub fn render_ascii(maze: &Maze<SquareField>) -> String
```

Double-cell ASCII renderer for square grids. Each cell occupies 3 characters wide × 1 character tall in output.

### Output dimensions

- Width: `4 * field_width + 1` characters
- Height: `2 * field_height + 1` lines

### Layout

- Corner `(4x, 2y)` → `+`
- Cell interior `(4x+1..4x+3, 2y+1)` → spaces
- Horizontal wall between `(x, y)` and `(x, y-1)` at row `2y`:
  - wall present → `---`
  - passage (edge exists in graph) → `   `
- Vertical wall between `(x, y)` and `(x-1, y)` at col `4x`:
  - wall present → `|`
  - passage → ` `

### Wall detection

`maze.field.node_at(point_a)` + `maze.field.node_at(point_b)` → `maze.graph.edge_between(a, b)`. Edge present = passage, no edge = wall.

### Coordinate orientation

Y increases upward. Rows printed top-to-bottom (highest Y first).

## Future

- Renderers for hex and other tessellations
- Export formats (JSON, binary)
- Graph structure logging
