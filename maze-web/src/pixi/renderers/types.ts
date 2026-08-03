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

export type MarkerShape = "circle" | "square" | "diamond" | "triangle" | "star5";

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
 * square there and some (other) edge wants an outline square there. */
export type TeleportEdge = { from: [number, number]; to: [number, number]; oneWay: boolean };

export type LockEntry = { x: number; y: number; type: "in" | "out" | "both" };
