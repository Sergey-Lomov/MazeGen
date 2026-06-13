export type Viewport = {
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
};

export type PassageKind = "both" | "forward" | "backward" | "none";
export type WallStyle = "solid" | "faint" | "invalid";

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
};

export type MarkerData = { pos: [number, number]; color: number; radius: number };

export type LockEntry = { x: number; y: number; type: "in" | "out" | "both" };
