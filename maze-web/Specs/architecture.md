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

Before React mounts, `main.tsx` installs PixiJS's `unsafe-eval` compatibility module. It replaces
Pixi's dynamic `new Function()` synchronization paths with static implementations, so the canvas
renderer works under a strict CSP without adding `unsafe-eval` to `script-src`.

## Rendering

See [renderer.md](renderer.md).

## Keyboard focus

The shared stylesheet gives native controls and explicitly focusable custom controls a consistent
inset blue `:focus-visible` ring. Keep keyboard focus styling in CSS rather than changing layout
metrics on focus; this prevents scroll-panel clipping and layout shifts, especially on feature-card
headers.

## Compact icon actions

`FlatIconButton` owns the shared 22 px square hit area, hover highlight, disabled state, tooltip, and
accessible name for compact icon-only actions. Its variants supply standard, danger, and contextual
surfaces; its active state accepts only the feature-specific colour variables needed by an active
editor. `IconActionButton` owns the standard 16 px glyph registry (`add`, `edit`, `delete`, `close`,
`info`, `load`, `move-up`, `move-down`, `save`, and `settings`), and semantic wrappers expose those
actions where a name improves call-site clarity. `ListCellAction` uses the same surface and may take
an `action` from that registry while preserving its list-safe activation behavior. Use
`FlatIconButton` directly only when the action and icon are genuinely feature-specific. Visual
styles belong to the shared CSS class, not to individual call sites.

## State

See [store.md](store.md).
