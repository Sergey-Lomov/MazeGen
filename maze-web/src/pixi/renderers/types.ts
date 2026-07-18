export type Viewport = {
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
};

export type PassageKind = "both" | "forward" | "backward" | "none";
export type WallStyle = "solid" | "faint" | "background";

export type WallEdge = {
  a: [number, number];
  b: [number, number];
  kind: PassageKind;
  style: WallStyle;
  oneWayDir?: { dx: number; dy: number };
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

export type MarkerData = { pos: [number, number]; color: number; radius: number };

/** A cell draws half-filled when the markers landing on it disagree: some edge wants a filled
 * square there and some (other) edge wants an outline square there. */
export type TeleportEdge = { from: [number, number]; to: [number, number]; oneWay: boolean };

export type LockEntry = { x: number; y: number; type: "in" | "out" | "both" };
