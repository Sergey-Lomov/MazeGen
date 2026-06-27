# maze-wasm API

## Purpose

Thin WASM bridge between `maze-core` and web clients. Compiles to `--target web` via wasm-pack. Exposes generation functions and registry queries; all core logic lives in `maze-core`.

## Build

```
wasm-pack build maze-wasm --target web
```

Output goes to `maze-wasm/pkg/`. Web client copies this directory to `src/wasm/pkg/`.

## Exported Functions

### `generate(seed: bigint, config: JsValue) -> Result<JsValue, JsValue>`

Generates a maze and returns a serialized `MazeSnapshot`. Returns `Err(JsValue)` with a string message on invalid input or internal error.

Config is deserialized as `GenerateConfig` (see below). If `null` or `undefined`, uses `GenerateConfig::default()`.

### `generate_steps(seed: bigint, config: JsValue) -> Result<JsValue, JsValue>`

Same as `generate` but returns a `GenerationStepsSnapshot` — each intermediate graph state during generation. Used for step-by-step debug visualization.

### `available_checks() -> JsValue`

Returns `Array<CheckDescriptor>` — list of all registered quality checks.

### `available_strategies() -> JsValue`

Returns `Array<StrategyDescriptor>` — list of all registered repair strategies with their parameter schemas.

## Config Types

### `GenerateConfig`

```ts
{
  tessellation: TessellationConfig,   // default: { type: "square", width: 10, height: 10 }
  checks: string[],                   // default: ["missing_endpoints", "unreachable_finish"]
  strategies: Record<string, {        // default: { missing_endpoints: { id: "farthest_endpoints" } }
    id: string,
    params: Record<string, string>
  }>,
  repair_max_iterations?: number,     // default: 10 — caps the repair fixpoint loop's iteration count
  repair_time_budget_secs?: number,   // default: undefined (no time cap) — wall-clock budget for the repair loop
  initial: InitialGenerationConfig,   // default: { method: "custom_vertex_based" }
  elements: ElementsConfig,           // default: { one_way_chance: 0.04 }
}
```

`repair_max_iterations` and `repair_time_budget_secs` are both optional and independent — whichever limit is hit first stops the repair loop early, returning whatever issues remain unresolved at that point (see `Specs/repair.md`'s `RepairLimits`). Both `null`/omitted means no cap at all.

### `InitialGenerationConfig`

Discriminated union keyed on `method`:

```ts
| { method: "custom_vertex_based",
    depth_first?: number,     // [0, 1], default 0.9
    corridor_chance?: number, // [0, 1], default 0.7
    branching?: number,       // [0, 1], default 0.5
    directionality?: number,  // [0, 1], default 0.0
  }
| { method: "recursive_backtracker" }
```

All numeric params are clamped to `[0.0, 1.0]` server-side. Omitted params use core defaults.

### `ElementsConfig`

Parameters applied to all edges during generation, regardless of algorithm:

```ts
{
  one_way_chance?: number,  // [0, 1], default 0.04 — probability of placing a one-way edge
}
```

### `TessellationConfig`

Discriminated union keyed on `type`:

| `type` | fields |
|---|---|
| `square` | `width: u32, height: u32` |
| `hex_parallelogram` | `cols: u32, rows: u32, orientation?: "flat_top"\|"pointy_top"` |
| `hex_hexagon` | `radius: u32, orientation?: "flat_top"\|"pointy_top"` |
| `triangle_rect` | `cols: u32, rows: u32, orientation?: "r0"\|"r90"\|"r180"\|"r270"` |
| `triangle_triangle` | `side: u32, orientation?: "r0"\|"r90"\|"r180"\|"r270"` |
| `triangle_hexagon` | `radius: u32, orientation?: "r0"\|"r90"\|"r180"\|"r270"` |

`orientation` is accepted for deserialization but ignored — rendering orientation is handled client-side.

Validation: all size fields must be `> 0`, otherwise returns error string.

## Return Types

### `MazeSnapshot`

```ts
{
  nodes: Array<{ id: number, x: number, y: number }>,
  edges: Array<{ from: number, to: number }>,
  start: number | null,
  finish: number | null,
  warnings: string[],
  nav_nodes: Array<{ node_id: number }>,
  nav_edges: Array<{ from: number, to: number, path: number[] }>,
  components: number[][],
}
```

`x`/`y` are tessellation-specific logical coordinates (not pixels). Coordinate semantics depend on tessellation type and are interpreted by the web client renderer.

All directed edges included — a bidirectional corridor produces two entries.

### `GenerationStepsSnapshot`

```ts
{
  nodes: Array<{ id: number, x: number, y: number }>,
  steps: Array<{ edges: Array<{ from: number, to: number }> }>,
}
```

Each step is a snapshot of all edges present after that generation step.

### `CheckDescriptor`

```ts
{ id: string, issue_kinds: string[] }
```

### `StrategyDescriptor`

```ts
{
  id: string,
  handles: string,   // issue_kind this strategy repairs
  params: Array<{
    id: string,
    label: string,
    kind: { type: "float", default: number, min: number, max: number }
          | { type: "bool", default: boolean }
          | { type: "enum", options: string[], default: string }
  }>
}
```

## WASM Initialization

`--target web` requires explicit initialization before calling any exported function:

```ts
import init, { generate } from "./pkg/maze_wasm";
await init();
generate(seed, config);
```

The `default` export (`init`) loads and instantiates the `.wasm` binary. Must be awaited once before use.
