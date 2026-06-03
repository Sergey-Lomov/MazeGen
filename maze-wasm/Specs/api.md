# maze-wasm API

## Purpose

Thin WASM bridge between `maze-core` and web clients. Compiles to `--target web` via wasm-pack. Exposes a single function; all core logic lives in `maze-core`.

## Build

```
wasm-pack build maze-wasm --target web
```

Output goes to `maze-wasm/pkg/`. Web client copies or references this directory.

## Exported Function

```rust
#[wasm_bindgen]
pub fn generate(seed: u64, width: u32, height: u32) -> Result<JsValue, JsValue>
```

Generates a maze and returns a serialized `MazeSnapshot`. Returns `Err(JsValue)` with a string message on invalid input or internal error.

### Validation

- `width == 0 || height == 0` → error `"width and height must be > 0"`
- Node/edge id overflow (NodeId > u32::MAX) → error `"edge endpoint overflow"`

### Return value

Serialized via `serde_wasm_bindgen::to_value`. Shape:

```ts
{
  nodes: Array<{ id: number, x: number, y: number }>,
  edges: Array<{ from: number, to: number }>
}
```

All directed edges are included — a bidirectional corridor produces two entries. Total edges = `2 * (node_count - 1)` for a standard generated maze.

## DTOs

### NodeDto

```rust
pub struct NodeDto { pub id: u32, pub x: i32, pub y: i32 }
```

`id` is the NodeId cast to u32. `x`/`y` are the SquarePoint coordinates (y increases upward).

### EdgeDto

```rust
pub struct EdgeDto { pub from: u32, pub to: u32 }
```

Directed edge. `from` and `to` are NodeIds cast to u32.

### MazeSnapshot

```rust
pub struct MazeSnapshot { pub nodes: Vec<NodeDto>, pub edges: Vec<EdgeDto> }
```

## WASM Initialization

`--target web` requires explicit initialization before calling any exported function:

```ts
import init, { generate } from "./pkg/maze_wasm";
await init();
generate(seed, width, height);
```

The `default` export (`init`) loads and instantiates the `.wasm` binary. Must be awaited once before use.
