export type Viewport = {
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
};

export type PassageKind = "both" | "forward" | "backward" | "none";
export type WallStyle = "solid" | "faint" | "background";

/** Optional per-call override for a "wall"-colored stroke's color/thickness/join/cap, applied only
 *  to the `solid` `WallStyle` in `WallRenderer` and to `wallFaces` in `SplitJunctionRenderer` — the
 *  `faint`/`background` wall styles and a split passage's own node-identity `color` are never
 *  overridden by this. Used by `VectorByWallsRenderer` (GitHub issue #291) to expose wall
 *  color/join/thickness as user settings without changing any other feature-renderer's fixed
 *  `canvas.wall.default`/`WALL_THICKNESS` look. `join`/`cap` are always set together (`round`+
 *  `round` or `miter`+`square`) — a `join` only becomes visible where two wall segments meet at a
 *  shared vertex within the same continuous stroked path, so `WallRenderer.render` groups solid
 *  edges into per-vertex paths precisely so this override has somewhere to show up. */
export type WallStyleOverride = { color?: number; width?: number; join?: "round" | "miter"; cap?: "round" | "square" };

export type OneWayPattern = "triangle" | "chevron" | "arrow";

/** Optional per-call override for the one-way indicator drawn on a `WallEdge`'s wall segment
 *  midpoint — pattern (shape), color, border (color/width, `borderWidth: 0` draws no border),
 *  size (world-space scale along the pointing direction), thickness (chevron/arrow's own line
 *  width, independent of size) and join/cap (own stroke ends for chevron/arrow, the filled
 *  triangle's border stroke for triangle). Used by `VectorByWallsRenderer` (GitHub issue #292) to
 *  expose the one-way indicator as user settings — never applied to a split passage's own
 *  connector arrow (`SplitJunctionRenderer` keeps drawing that with the node's own identity color
 *  via `drawDirectionArrow`, unaffected by this override). When no override is passed at all (every
 *  feature-renderer besides `VectorByWallsRenderer`), `WallRenderer.drawOneWayIndicator` still
 *  draws a bordered triangle by default (GitHub issue #292 follow-up) — this is a deliberate,
 *  shared visual change to every caller's one-way look, not something this override opts into. */
export type OneWayStyleOverride = {
  pattern: OneWayPattern;
  color: number;
  borderColor: number;
  borderWidth: number;
  size: number;
  /** Chevron/arrow's own line thickness — independent of `size` (geometric scale). Has no effect
   *  on the `triangle` pattern (a filled shape, no line stroke of its own). */
  thickness: number;
  join: "round" | "miter";
  cap: "round" | "square";
};

export type WallEdge = {
  a: [number, number];
  b: [number, number];
  kind: PassageKind;
  style: WallStyle;
  oneWayDir?: { dx: number; dy: number };
};

/** One split node's passage through its tile (GitHub issue #223, arrow moved onto the connector
 *  for #234) — the node's own share of the wall on every geometric face it connects across
 *  (`wallSegments`, always drawn), plus a "connector" line linking those shares together: for a
 *  node with exactly 2 connected faces, both plain two-way passages, a single straight line
 *  directly between the two shares' centers (no hub point); for any other count/kind, one line per
 *  face from the node's point on a small circle out to that face's share center. Drawn instead of
 *  (not in addition to) the ordinary `WallEdge` reading for any geometric edge a split point's
 *  nodes are involved in — see `SplitJunctionRenderer`. Mirrors the "Manage split nodes" dialog's
 *  tile diagram (`TileFaceEditor`) via the shared algorithm in `splitFaceLayout.ts`. */
export type SplitPassage = {
  color: number;
  /** The split point's own `"${x},${y}"` key (GitHub issue #294) — lets `SplitJunctionRenderer`
   *  skip a point's ordinary passages when it's drawn via `SplitSpecialShape` instead. */
  pointKey: string;
  /** This node's own share of each geometric edge it connects across, as a sub-segment of the
   *  full shared edge — when several nodes of the same split point cross the same face, the
   *  face's own span is divided evenly among them in slot order, each getting one contiguous
   *  sub-segment. `center` is that sub-segment's midpoint — connectors end exactly there, so a
   *  one-way's arrow (drawn on the connector, not this segment) still reads as belonging to it. */
  wallSegments: {
    v0: { x: number; y: number };
    v1: { x: number; y: number };
    center: { x: number; y: number };
    /** Optional/undecided ("optional connection") share — draw in `disabledOfNumber(color)`
     *  instead of `color`, same tentative-color rule as `TileFaceEditor`'s `disabledOf`. Named
     *  `isUndefined` (not `undefined`) to avoid shadowing the JS keyword at every call site. */
    isUndefined: boolean;
  }[];
  /** Lines connecting the node's `wallSegments` together. Exactly one straight line between the
   *  two share centers when `wallSegments.length === 2` and both are plain two-way passages;
   *  otherwise one line per share, from the node's own point on a small circle (never drawn
   *  itself) to that share's center. `oneWayOut`, if set, draws an arrowhead on this line: `true`
   *  points away from the hub (toward the face — this node's passage runs outward), `false` the
   *  reverse. `isUndefined` mirrors `wallSegments`' flag — the matching share's optional/tentative
   *  state, drawn in the same disabled color as its segment. */
  connectors: { from: { x: number; y: number }; to: { x: number; y: number }; oneWayOut?: boolean; isUndefined: boolean }[];
};

/** Recognized degree-4 split topology drawn with a dedicated shape instead of the generic
 *  per-node segment/connector reading, when `SplitStyleOverride.specialShapes` is on (GitHub issue
 *  #294) — `"bridge"`: two nodes, each a straight-through opposite-face pair (one node's corridor
 *  literally crosses the other's at the tile center). `"diagonal"`: two nodes, each an
 *  adjacent-face pair (the tile is cut in half by one diagonal wall). Matches
 *  `splitPatternTitles.ts`'s `"bridge"`/`"diagonal_divider"` square topologies — same shape
 *  vocabulary, this is the canvas-drawing side of it. */
export type SplitSpecialShapeKind = "bridge" | "diagonal";

/** Dedicated-shape draw data for one split point recognized as `kind` (GitHub issue #294) — emitted
 *  by `buildSplitPassagesCore` alongside (not instead of) the point's ordinary `SplitPassage`
 *  entries, so the renderer can choose per the `specialShapes` toggle without needing a second
 *  geometry pass. Entirely self-contained within the tile — drawn as a plain wall-colored/-width
 *  shape (`WallStyleOverride`-driven, same as `SplitJunctionRenderer`'s `wallFaces`), never in a
 *  node's own identity color: neither shape reads as "belonging" to one node over the other.
 *
 *  `"diagonal"`: one straight wall segment, `corner0 -> corner1`, the tile's own two opposite
 *  corners where the through/cross face pairs each meet — a real geometric diagonal, not two
 *  face-midpoint-to-center legs.
 *
 *  `"bridge"`: the through corridor draws nothing of its own (it's an ordinary passage straight
 *  across the tile). The cross corridor draws as a classic card-map bridge silhouette — its two
 *  edges (`edge0`/`edge1`, matching `crossFaces[*].v0`/`.v1`), each a 4-point polyline along the
 *  cross corridor's own axis: full width at the cross faces, narrowing over the first 20% of the
 *  tile's length, a flat deck for the middle 60%, widening back out over the last 20%. */
export type SplitSpecialShape =
  | {
      kind: "diagonal";
      pointKey: string;
      corner0: { x: number; y: number };
      corner1: { x: number; y: number };
    }
  | {
      kind: "bridge";
      pointKey: string;
      /** The cross corridor's two faces — only kept for `pointKey`-adjacent context, drawing
       *  itself uses `edge0`/`edge1` below. */
      crossFaces: [{ v0: { x: number; y: number }; v1: { x: number; y: number } }, { v0: { x: number; y: number }; v1: { x: number; y: number } }];
      /** 4-point polyline: `[crossFaces[0].v0, deckStart, deckEnd, crossFaces[1].v0]` (or the
       *  paired endpoint after `nearestEndpointPairing`) — full-width end, narrowing-in point at
       *  20% length, narrowing-in point at 80% length (deck start), full-width other end. */
      edge0: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
      /** Same shape as `edge0`, the corridor's other edge. */
      edge1: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
    };

/** Optional per-call override for `SplitJunctionRenderer` (GitHub issue #294) — `nodeColors`
 *  replaces `splitSlotColor`'s default palette lookup one-to-one by slot index (a point with more
 *  nodes than `nodeColors.length` falls back to the default palette for the overflow slots, same
 *  rule `splitSlotColor` itself uses for slots past its own fixed set). `specialShapes` defaults to
 *  **on** (unset or `true`) — recognized degree-4 topologies (see `SplitSpecialShapeKind`) draw as
 *  their dedicated shape instead of the generic per-node reading; pass `false` explicitly to opt a
 *  caller out. */
export type SplitStyleOverride = { nodeColors?: readonly number[]; specialShapes?: boolean };

export type EdgeHL = {
  from: [number, number];
  to: [number, number];
  color: number;
  alpha: number;
  width: number;
  /** When `false`, draws a direction arrow at the segment's midpoint pointing `from` -> `to`.
   *  `undefined` (unknown directionality, e.g. cycle highlights) draws a plain line, same as `true`. */
  bidirectional?: boolean;
};

/** Shared point-marker shape set (GitHub issue #293 follow-up) — one enum for every drawn "point"
 *  marker: start/finish waypoints (`WaypointsRenderer`) and both teleport patterns
 *  (`TeleportRenderer`). Previously two separate types (`MarkerShape` with 5 values for waypoints,
 *  `TeleportShape` with 9 for teleports, including `crescent` — removed per issue #293 follow-up,
 *  a moon shape that read poorly at marker scale); unified into this one 8-value set so both
 *  pickers offer the exact same shapes and neither renderer's drawing code diverges from the
 *  other's for shapes both use. */
export type MarkerShape = "circle" | "triangle" | "square" | "diamond" | "pentagon" | "star" | "hexagon" | "cross";

/** `borderWidth: 0` (the default) draws no border — see GitHub issue #296. */
export type MarkerData = {
  pos: [number, number];
  color: number;
  radius: number;
  shape?: MarkerShape;
  borderColor?: number;
  borderWidth?: number;
};

/** A cell draws half-filled when the markers landing on it disagree: some edge wants a filled
 * square there and some (other) edge wants an outline square there. `fromNode`/`toNode` (GitHub
 * issue #293) are the underlying node ids — optional since only `VectorByWallsRenderer` needs them
 * (for `buildTeleportGroups`' point-coincidence merging); every other caller (`GenerationRenderer`,
 * `PresetConnectionsRenderer`) omits them. */
export type TeleportEdge = { from: [number, number]; to: [number, number]; oneWay: boolean; fromNode?: number; toNode?: number };

/** Sharp (plain polygon corners) vs. round (`Graphics.roundPoly`-rounded) corners — one shared
 *  setting for every teleport marker (GitHub issue #293 follow-up). Only affects the four
 *  regular-polygon `MarkerShape`s (`triangle`/`square`/`diamond`/`pentagon`/`hexagon` — see
 *  `drawMarkerShape`'s `rounded` param); `circle` has no corners, `star`/`cross` have no
 *  regular-polygon equivalent to round. */
export type TeleportCornerStyle = "sharp" | "round";

/** `"none"`: no connector line at all, just the two endpoint markers — with "group customization"
 *  enabled (see `TeleportGroupOverride`) this reproduces the old, now-removed `"grouped"` pattern's
 *  look. `"straight"`: connector runs directly center-to-center. `"orthogonal"`: connector runs as
 *  a single-bend axis-aligned path (horizontal segment then vertical, or vice versa — whichever
 *  orientation collides with fewer other connectors' segments, see `routeOrthogonalConnector` in
 *  `teleportConnectorRouting.ts`), offset perpendicular to itself wherever it locally overlaps
 *  another connector's segment, so parallel runs read as distinct lines instead of one merged
 *  stroke. */
export type TeleportConnectorStyle = "none" | "straight" | "orthogonal";

/** How a one-way connector draws its direction arrow(s) (GitHub issue #293 follow-up):
 *  - `"none"`: no arrow.
 *  - `"center"`: one arrow at the path's length-weighted midpoint (the original, still-default
 *    look).
 *  - `"double"`: two arrows, at 33% and 66% of the path's length.
 *  - `"periodic"`: arrows repeating every `arrowPeriod` tile-widths along the path, starting
 *    `arrowPeriod / 2` in (so a short connector still gets at least one arrow instead of none). */
export type TeleportArrowMode = "none" | "center" | "double" | "periodic";

/** The teleport renderer's one and only per-call style now (GitHub issue #293 follow-up removed the
 *  separate `"grouped"` pattern and its own style — group customization is an overlay on top of
 *  this, see `TeleportGroupOverride`), built from `VectorByWallsSettings` — mirrors
 *  `OneWayStyleOverride`'s shape. `borderWidth: 0` draws no border around the endpoint shape.
 *  `connectorColor`/`connectorWidth` are unused when `connectorStyle` is `"none"` or a teleport
 *  pair's two endpoints coincide (zero-length line, nothing to draw). `size` is the marker's own
 *  radius as a fraction of the tile size (0-1, same convention as `OneWayStyleOverride.size` —
 *  scaled into world-space via `TILE_SIZE` by the caller), not a fixed pixel radius, so it scales
 *  with tessellation the same way the one-way indicator does. */
export type TeleportLineStyle = {
  shape: MarkerShape;
  cornerStyle: TeleportCornerStyle;
  size: number;
  edgeColor: number;
  /** Independent from `edgeColor` — a marker's border doesn't have to mirror its fill color. */
  edgeBorderColor: number;
  borderWidth: number;
  connectorColor: number;
  connectorWidth: number;
  connectorStyle: TeleportConnectorStyle;
  arrowMode: TeleportArrowMode;
  /** Tile-width period between arrows in `"periodic"` mode — unused otherwise. */
  arrowPeriod: number;
  /** Arrow size, independent of `connectorWidth` (previously always `connectorWidth * 2`) — passed
   *  straight through to `drawDirectionArrow`'s own `size` param. */
  arrowSize: number;
  /** Connector border width (GitHub issue #293 follow-up) — `0` (the default) draws no border.
   *  When positive, the connector (line and every arrow it draws) is drawn twice: once at
   *  `connectorWidth + 2 * connectorBorderWidth` in `floorColor` (underneath, the `2x` since the
   *  border wraps both sides of the stroke, same convention as a filled shape's own inward
   *  border), then again at `connectorWidth` in `connectorColor` on top — reads as a floor-colored
   *  outline around the whole connector including its arrowheads, not just the line. */
  connectorBorderWidth: number;
  /** Floor color (GitHub issue #293 follow-up) — the connecting line now runs center-to-center
   *  (not clipped to the marker's border), drawn *underneath* every marker shape, so an outline
   *  (unfilled) marker needs its own floor-colored fill to occlude the line segment passing through
   *  its center; a filled marker already occludes it with `edgeColor`. */
  floorColor: number;
};

/** "Group customization" (GitHub issue #293 follow-up, replacing the old standalone `"grouped"`
 *  pattern) — an optional per-group override layered on top of the normal `TeleportLineStyle`
 *  drawing, active when `VectorByWallsSettings.teleportGroupCustomization` is on. Teleport pairs
 *  are still merged into groups wherever an endpoint coordinate coincides (see
 *  `buildTeleportGroups`), each group's own key (sorted, joined edge keys of its members) indexing
 *  into `VectorByWallsSettings.teleportGroupOverrides` so the override survives group-list
 *  reordering across renders. `fillColor`/`shape` each fall back to the base `TeleportLineStyle`'s
 *  `edgeColor`/`shape` when unset; `borderColor` (fallback: `edgeBorderColor`) drives *both* the
 *  marker's own border and, if this group's points have a connector running through them, that
 *  connector's color too — one swatch, not two, since a mismatched border/connector color on the
 *  same group reads as a mistake rather than a deliberate choice. */
export type TeleportGroupOverride = { fillColor?: number; borderColor?: number; shape?: MarkerShape };

export type LockEntry = { x: number; y: number; type: "in" | "out" | "both" };
