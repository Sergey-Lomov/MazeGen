# maze-web Architecture

## Purpose

Browser-based maze viewer. React UI + Pixi.js canvas renderer + Zustand state. Communicates with `maze-core` via the `maze-wasm` WASM module.

## Stack

- **React** — UI components (sidebar, panels)
- **Pixi.js** — WebGL canvas rendering of nodes and edges
- **Zustand** — global state store (maze data, UI flags, selection)
- **Vite** — dev server and bundler
- **TypeScript** throughout

## Module Map

```
src/
  main.tsx          — React entry point, mounts App
  App.tsx           — root layout: sidebar + canvas
  components/
    ControlPanel    — seed/width/height inputs, Generate/Reset buttons
    DebugPanel      — node ID / coords toggles, selected node info
    Tooltip         — accessible tooltip for disabled controls — see notifications.md
    FieldHint       — `useFieldHint()` field-anchored hint — see notifications.md
    floating/       — shared floating-ui positioning for Tooltip / FieldHint
  store/
    mazeStore       — Zustand store: maze state + actions
  notifications/
    notificationRegistry — toast codes (category, message, dedupParams) — see notifications.md
    notificationStore    — notify(), notice/error zones, timers
    announcer            — screen-reader announcement queue for `Announcer`
  wasm/
    types           — TypeScript interfaces matching WASM DTOs
    wasmLoader      — lazy WASM init, singleton module ref
    mazeService     — calls WASM generate(), validates snapshot
  pixi/
    MazeRenderer    — Pixi.js Application wrapper, graph rendering
```

## Data Flow

```
User input → ControlPanel → mazeStore.generate()
  → mazeService.generateMaze(seed, width, height)
  → wasmLoader.getWasm().generate(BigInt(seed), width, height)
  → validateSnapshot(raw) → MazeSnapshot
  → mazeStore: { nodes, edges }
  → MazeRenderer.renderGraph(nodes, edges, ...)
```

## Initialization Sequence

1. `App` mounts → creates Pixi `Application`, initializes `MazeRenderer`
2. `MazeRenderer` subscribes to `mazeStore` via Zustand
3. WASM lazy-loaded on first `generate()` call via `initWasm()` in `wasmLoader`
4. Subsequent calls skip init (singleton promise guards)

## Rendering

See [renderer.md](renderer.md).

## State

See [store.md](store.md).
