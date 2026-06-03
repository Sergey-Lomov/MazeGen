# maze-web Store

## Purpose

Single Zustand store for all application state. No local component state for anything maze-related.

## State Shape

```ts
interface MazeState {
  seed: number;        // RNG seed for generation
  width: number;       // maze width in cells
  height: number;      // maze height in cells
  nodes: NodeDto[];    // current maze nodes
  edges: EdgeDto[];    // current maze directed edges
  showNodeIds: boolean;
  showCoords: boolean;
  selectedNode: number | null;
  error: string | null;
}
```

Defaults: `seed=42`, `width=10`, `height=10`, nodes/edges empty, all flags false.

## Actions

| Action | Effect |
|---|---|
| `setSeed(n)` | Set seed, clear error |
| `setWidth(n)` | Set width, clear error |
| `setHeight(n)` | Set height, clear error |
| `generate()` | Call WASM, update nodes/edges/error, clear selectedNode |
| `reset()` | Clear nodes/edges/error/selectedNode |
| `setDebugFlag(key, value)` | Toggle `showNodeIds` or `showCoords` |
| `selectNode(id \| null)` | Set selected node |

## Error Handling

`generate()` catches exceptions from WASM or validation and stores the message in `error`. Does not throw. `error` is cleared on successful generate or any setter call.

## WASM Coupling

`generate()` calls `generateMaze` from `mazeService`, which lazy-inits WASM on first call. Store does not know about WASM internals.
