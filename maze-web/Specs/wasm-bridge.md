# maze-web WASM Bridge

## Purpose

Isolates all WASM concerns from the rest of the app. Three files: loader, service, types.

## types.ts

TypeScript interfaces matching `maze-wasm` DTOs:

```ts
interface NodeDto { id: number; x: number; y: number; }
interface EdgeDto { from: number; to: number; }
interface MazeSnapshot { nodes: NodeDto[]; edges: EdgeDto[]; }
```

## wasmLoader.ts

Lazy singleton loader. WASM is initialized at most once per session.

```ts
initWasm(): Promise<void>  // idempotent — safe to call multiple times
getWasm(): WasmModule      // throws if not initialized
```

Initialization: dynamic import of `../../pkg/maze_wasm`, then `await pkg.default()` (required for `--target web` WASM format).

## mazeService.ts

```ts
generateMaze(seed: number, width: number, height: number): MazeSnapshot
```

Calls `getWasm().generate(BigInt(seed), width, height)`. Validates the raw result via `validateSnapshot`:

1. Must be non-null object
2. `nodes` array — every element has `id: number`, `x: number`, `y: number`
3. `edges` array — every element has `from: number`, `to: number`
4. Every `edge.from` and `edge.to` must reference a node id present in `nodes`

Throws `Error` with descriptive message on any violation. Caller (store) catches and stores in `error`.

## WASM Package Location

Built by `wasm-pack build maze-wasm --target web`. Output in `maze-wasm/pkg/`. Referenced from `maze-web` as `../../pkg/maze_wasm` (relative to `src/wasm/`). Must be rebuilt and copied after any `maze-core` or `maze-wasm` changes.
