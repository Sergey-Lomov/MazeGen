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
 *  midpoint — pattern (shape), color, floor-colored gap (color/width, `gapWidth: 0` draws no gap —
 *  renamed from border in GitHub issue #302 follow-up, consistent with the marker/connector gap
 *  convention: this is a separation gap, not a real border), size (world-space scale along the
 *  pointing direction), thickness (chevron/arrow's own line width, independent of size) and
 *  join/cap (own stroke ends for chevron/arrow, the filled triangle's gap stroke for triangle).
 *  Used by `VectorByWallsRenderer` (GitHub issue #292) to expose the one-way indicator as user
 *  settings — never applied to a split passage's own connector arrow (`SplitJunctionRenderer`
 *  keeps drawing that with the node's own identity color via `drawDirectionArrow`, unaffected by
 *  this override). When no override is passed at all (every feature-renderer besides
 *  `VectorByWallsRenderer`), `WallRenderer.drawOneWayIndicator` still draws a gapped triangle by
 *  default (GitHub issue #292 follow-up) — this is a deliberate, shared visual change to every
 *  caller's one-way look, not something this override opts into. */
export type OneWayStyleOverride = {
  pattern: OneWayPattern;
  color: number;
  gapColor: number;
  gapWidth: number;
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
  /** The split point's own tile center (GitHub issue #314 follow-up) — `VectorByCorridorsRenderer`
   *  draws each of this node's face shares as a straight line from here (never `connectors`' hub
   *  fan-out/2-share-straightening — every share always runs to the point's own center, since a
   *  corridor line has no wall geometry to divide a face into a "share" for in the first place, so
   *  there's nothing for the hub circle to visually separate). */
  center: { x: number; y: number };
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
    /** Set only for a one-way face (GitHub issue #314 follow-up, mirrors `connectors`' own
     *  `oneWayOut`): `true` if this node's passage runs outward (away from the point's own center,
     *  toward the face), `false` if inward. `undefined` for a two-way passage. */
    oneWayOut?: boolean;
    /** `true` when `v0`/`v1` lands on the face's own real endpoint (the boundary shared with a
     *  neighboring tile/wall) rather than an internal division point between two nodes sharing this
     *  face (GitHub issue #317) — a "free" end with no neighbor sub-segment to butt against, so
     *  `SplitJunctionRenderer` caps it with the caller's own style instead of always `"butt"`. */
    atFaceStart: boolean;
    atFaceEnd: boolean;
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

/** Recognized split topology drawn with a dedicated shape instead of the generic per-node
 *  segment/connector reading, when `SplitStyleOverride.specialShapes` is on (GitHub issue #294,
 *  hex kinds added in #319) —
 *
 *  Degree 4 (square): `"bridge"` — two nodes, each a straight-through opposite-face pair (one
 *  node's corridor literally crosses the other's at the tile center). `"diagonal"` — two nodes,
 *  each an adjacent-face pair (the tile is cut in half by one diagonal wall). Matches
 *  `splitPatternTitles.ts`'s `"bridge"`/`"diagonal_divider"` square topologies.
 *
 *  Degree 6 (hex): `"hex_bridge"` — two nodes, each a straight-through opposite-face pair (direct
 *  hex analog of `"bridge"`, at 60° instead of 90°). `"hex_triple_bridge"` — three nodes, all
 *  opposite-face pairs, three corridors crossing at the tile center (`splitPatternTitles.ts`'s
 *  `"double_bridge"`). `"hex_diagonal"` — two nodes, no opposite-face pair between them (adjacent
 *  and/or skip-face pairs) — cut by one straight wall, whose endpoints depend on how many real
 *  tile corners the two nodes' faces actually share (see `detectSplitSpecialShapeKind`).
 *  `"hex_triple_corridor"` — three nodes, one opposite-face pair plus two adjacent-face pairs
 *  (`splitPatternTitles.ts`'s `"triple_corridor"`). `"hex_diagonal_divider"` — two nodes owning
 *  opposite groups of three adjacent faces; it keeps the generic junction drawing but supplies
 *  dedicated graph/marker anchors for the two halves. */
export type SplitSpecialShapeKind = "bridge" | "diagonal" | "hex_bridge" | "hex_triple_bridge" | "hex_diagonal" | "hex_triple_corridor" | "hex_diagonal_divider";

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
      /** Optional wall-mode polyline from `corner0` to `corner1`. Used by
       *  `hex_triple_corridor` to bend both separating walls toward the tile center while corridor
       *  mode continues to use the shape only as topology metadata. */
      wallPath?: { x: number; y: number }[];
      /** Per-node convergence points for a multi-face diagonal divider in corridor mode. */
      dividerJunctions?: { x: number; y: number }[];
      /** Set only for `"hex_triple_corridor"`'s first of its two `"diagonal"` entries (GitHub
       *  issue #319) — the point's third (opposite-face-pair) node's own two endpoints
       *  (face-midpoint to face-midpoint), same role as `"bridge"`'s own `throughLine`: wall-mode
       *  ignores it entirely (an ordinary passage draws no wall of its own), corridor-mode draws it
       *  as a plain straight line so that node's own corridor isn't silently dropped just because
       *  this point's other two nodes are drawn as dedicated shapes instead of generic connectors. */
      throughLine?: [{ x: number; y: number }, { x: number; y: number }];
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
      /** The through corridor's own two endpoints (face-midpoint to face-midpoint, GitHub issue
       *  #314) — `VectorByCorridorsRenderer` draws this as a plain straight corridor line
       *  underneath the cross corridor's own line (`edge0`/`edge1`'s shared axis). Both draw in the
       *  render mode's own plain corridor color (`VectorByCorridorsSettings.color`), never a node's
       *  own identity color — neither line reads as "belonging" to one node over the other, same
       *  convention `SplitJunctionRenderer`'s wall-mode special shapes already use. */
      throughLine: [{ x: number; y: number }, { x: number; y: number }];
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

/** `borderWidth: 0` (the default) draws no border — see GitHub issue #296. `cornerStyle` (GitHub
 *  issue #302 follow-up) rounds the four regular-polygon shapes, same convention as
 *  `TeleportCornerStyle`. `gapWidth: 0` (the default) draws no floor-colored gap ring around the
 *  border — see `MarkerStyle`'s own doc comment (`mazeSelectors.ts`). */
export type MarkerData = {
  pos: [number, number];
  color: number;
  radius: number;
  shape?: MarkerShape;
  borderColor?: number;
  borderWidth?: number;
  cornerStyle?: TeleportCornerStyle;
  gapWidth?: number;
  gapColor?: number;
};

/** A cell draws half-filled when the markers landing on it disagree: some edge wants a filled
 * square there and some (other) edge wants an outline square there. `fromNode`/`toNode` (GitHub
 * issue #293) are the underlying node ids — optional since only `VectorByWallsRenderer` needs them
 * (for `buildTeleportGroups`' point-coincidence merging); every other caller (`GenerationRenderer`,
 * `PresetConnectionsRenderer`) omits them. `toFloor` (GitHub issue #337, floor-aware callers only —
 * see `buildTeleportEdges`' own `resolveNodeLevel` param) is set when `to` lands on a different
 * floor than the one currently being drawn: `to` itself is then not the real target cell but the
 * midpoint between `from` and the target's true (off-image) position, so `TeleportRenderer` draws a
 * floor-number badge there instead of an ordinary teleport marker — the connector still runs the
 * normal routing/collision-avoidance path toward that midpoint like any other endpoint. `fromFloor`
 * (GitHub issue #357 follow-up) is the same thing for `from` instead — needed on a cross-floor
 * preset teleport's own *arrival* floor, where the real (on-floor) marker is the arrival end sitting
 * in `to` (so the arrow, which always points `from`→`to`, still reads departure→arrival) while the
 * departure end's badge occupies `from`. At most one of `toFloor`/`fromFloor` is ever set on a given
 * edge. */
export type TeleportEdge = { from: [number, number]; to: [number, number]; oneWay: boolean; fromNode?: number; toNode?: number; toFloor?: number; fromFloor?: number };

/** One `VerticalPassage`/`Elevator` edge's own render point (GitHub issue #347) — always a single
 *  point-anchored marker on the edge's `from` node's own cell, never a connector to another drawn
 *  point (the `to` node lives on a different floor, off this image entirely — see
 *  `selectFloorScopedMaze`). `direction` points toward the other floor(s) this marker's own node
 *  connects to, relative to the active floor — `"up"`/`"down"` when every reachable floor sits
 *  strictly above/below, `"both"` when at least one sits above and at least one below (only
 *  possible for an `Elevator`'s fan, which can reach several floors from one node at once — a
 *  `VerticalPassage` only ever has one target floor), `undefined` only when no reachable floor's
 *  level could be resolved. Set for every marker now (two-way included), not just one-way ones,
 *  since a two-way connection still has a real "which floor(s)" to point at (GitHub issue #337/#347
 *  design follow-up: a two-way passage/elevator with no arrow at all gave no visual cue where it
 *  led). `filled` distinguishes a two-way `VerticalPassage`/`Elevator` (`true`, ordinary marker
 *  look) from a one-way `VerticalPassage`'s two ends (`false` on both — the two ends are told apart
 *  from each other by `arrowFilled` instead, not by `filled`). `arrowFilled` distinguishes a
 *  one-way `VerticalPassage`'s two ends — `true` (the departure end, this marker's own node is the
 *  edge's `from`) vs. `false` (the arrival-only end, this marker's own node is the edge's `to`,
 *  rendered as an extra marker on the *other* floor's own view); how each renderer actually draws
 *  the two apart is its own concern (`VerticalConnectionRenderer.ts`'s `oneWay` branch for the
 *  abstract style's accent-color/border split, `renderDecorativeMarker` for the decorative style's
 *  crossed-out arrow, GitHub issue #428). Always `true` for a two-way `VerticalPassage` or an
 *  `Elevator` (matches `filled`, since there's no empty variant to distinguish from). */
export type VerticalConnectionMarker = {
  pos: [number, number];
  fromNode: number;
  kind: "vertical_passage" | "elevator";
  direction?: "up" | "down" | "both";
  /** The single floor this marker's own `VerticalPassage` leads to (GitHub issue #337 follow-up:
   *  click-to-switch-floor) — `levels_ordered()` position, same convention as `NodeDto.level`.
   *  `undefined` for `Elevator` (a fan can reach several floors at once, so there's no single
   *  unambiguous click target — clicking an Elevator marker is intentionally not wired up) and for
   *  any marker whose target floor couldn't be resolved. */
  targetFloorIndex?: number;
  /** Every floor this `Elevator` marker's own node reaches (GitHub issue #430, "floor badges"),
   *  sorted ascending, deduplicated — `targetFloorIndex` only ever holds one floor (`VerticalPassage`)
   *  or `undefined` (`Elevator`'s ambiguous single-click target), but a floor badge ring needs the
   *  whole fan. `undefined` for `vertical_passage` (redundant with `targetFloorIndex`) and for an
   *  `elevator` marker whose reachable floors couldn't be resolved at all. */
  targetFloorIndices?: number[];
  filled: boolean;
  arrowFilled: boolean;
};

/** Sharp (plain polygon corners) vs. round (`Graphics.roundPoly`-rounded) corners — one shared
 *  setting for every teleport marker (GitHub issue #293 follow-up). Only affects the four
 *  regular-polygon `MarkerShape`s (`triangle`/`square`/`diamond`/`pentagon`/`hexagon` — see
 *  `drawMarkerShape`'s `rounded` param); `circle` has no corners, `star`/`cross` have no
 *  regular-polygon equivalent to round. */
export type TeleportCornerStyle = "sharp" | "round";

/** Weight of an elevator floor-number badge's own label text (GitHub issue #430 follow-up) — maps
 *  to pixi `TextStyle.fontWeight` (`"normal"`/`"600"`/`"bold"`). */
export type ElevatorBadgeFontWeight = "regular" | "bold";

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
  /** Floor-colored gap ring drawn around the marker's border (GitHub issue #302 follow-up), same
   *  convention as the waypoint marker's own `MarkerSettings.gapWidth` — `0` (the default) draws no
   *  gap. Drawn wider than the marker (`r + borderWidth + edgeGapWidth`) underneath — this marker's
   *  own border is drawn `alignment: 0` (pixi's outer alignment, grows entirely outward from `r`,
   *  see `TeleportRenderer.drawMarker` — every border/gap stroke in this codebase uses this
   *  alignment uniformly), so the marker's true outer edge is `r + borderWidth`, not `r` itself, and
   *  the gap ring must start there. Deliberately does *not* try to avoid the point's own connector
   *  via geometry — `TeleportRenderer.renderGroups` draws each group as its own
   *  gaps-then-connectors-then-points block, so a gap ring only ever needs to stay clear of *that
   *  same* group's own connector/marker geometry (which it does, being drawn first in the block); a
   *  later group's own gap can still visually sit under an earlier group's connector/marker, same
   *  "later group wins" draw order every other group-owned shape already follows. */
  edgeGapWidth: number;
  connectorColor: number;
  connectorWidth: number;
  connectorStyle: TeleportConnectorStyle;
  arrowMode: TeleportArrowMode;
  /** Tile-width period between arrows in `"periodic"` mode — unused otherwise. */
  arrowPeriod: number;
  /** Arrow size, independent of `connectorWidth` (previously always `connectorWidth * 2`) — passed
   *  straight through to `drawDirectionArrow`'s own `size` param. */
  arrowSize: number;
  /** Floor-colored gap drawn around the whole connector (GitHub issue #293 follow-up, renamed from
   *  `connectorBorderWidth` in #302 — not a border around the connector's own fill, a visual
   *  separation gap from anything the connector crosses). `0` (the default) draws no gap. When
   *  positive, the connector (line and every arrow it draws) is drawn twice: once at
   *  `connectorWidth + 2 * connectorGapWidth` in `floorColor` (underneath, the `2x` since the gap
   *  wraps both sides of the stroke, same convention as a filled shape's own inward border), then
   *  again at `connectorWidth` in `connectorColor` on top — reads as a floor-colored outline around
   *  the whole connector including its arrowheads, not just the line. */
  connectorGapWidth: number;
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
