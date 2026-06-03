# maze-web Renderer

## Purpose

Pixi.js-based graph renderer. Draws nodes and directed edges on a WebGL canvas. Subscribes to `mazeStore` and re-renders on changes.

## MazeRenderer

Owns a Pixi `Application`. Created by `App` once on mount, destroyed on unmount.

Internal containers (z-order: edges below nodes):
- `edgesContainer: Container`
- `nodesContainer: Container`

Both inside `viewport: Container` which handles pan and zoom.

## Interaction

**Pan**: pointerdown → pointermove delta applied to `viewport.x/y`.

**Zoom**: wheel event → scale factor `1.1` (zoom in) or `0.9` (zoom out), applied around mouse position.

**Node click**: `pointerdown` on node graphic → `mazeStore.selectNode(id)`.

**Node hover**: `pointerover`/`pointerout` change node fill color.

Window `blur` cancels drag.

## Node Rendering

Each node is a filled circle:
- Radius: `6px`
- Color: `0x4a9eff` (normal), `0xff9f4a` (hover), `0xff4a4a` (selected)
- Position: `x = node.x * 40`, `y = -node.y * 40` (Y flipped — screen Y increases downward)

Optional label (positioned top-right of circle):
- Node ID if `showNodeIds`
- `(x,y)` if `showCoords`
- Both if both enabled

## Edge Rendering

Single pass over all directed edges. Groups edges into pairs by normalizing `{lo=min(from,to), hi=max(from,to)}`:

```
pairKey = "${lo}:${hi}"
loToHi = edge lo→hi exists
hiToLo = edge hi→lo exists
```

For each pair, draw once:
- **Bidirectional** (`loToHi && hiToLo`): plain line
- **One-way lo→hi** (`loToHi && !hiToLo`): line + arrowhead at `hi`
- **One-way hi→lo** (`hiToLo && !loToHi`): line + arrowhead at `lo`

Edge color: `0x888888`, stroke width: `2px`.

## Arrowhead Geometry

Equilateral triangle pointing at the `to` endpoint:

```
side = 0.1 * edgeLength
height = side * sqrt(3) / 2

d = unit vector from→to
p = perpendicular (-d.y, d.x)

tip      = to
baseCenter = to - d * height
left     = baseCenter + p * (side / 2)
right    = baseCenter - p * (side / 2)
```

Filled polygon `[tip, left, right]`. Skipped if `edgeLength < 1`.

## Store Subscription

`MazeRenderer` subscribes via `mazeStore.subscribe`. On change:
- nodes or edges changed → full `renderGraph`
- only debug flags changed → `updateLabels` (preserves node graphics)
- only selection changed → `updateSelection` (recolor two nodes)

## Lifecycle

`destroy()`: unsubscribes from store, removes event listeners, calls `app.destroy()`.
