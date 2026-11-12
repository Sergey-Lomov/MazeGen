import type { TeleportEdge } from "./types";
import { TILE_SIZE } from "../constants";

export type ManualTeleportConnectorMode = "polyline" | "curve";

/** A manual path stores its polyline vertices/Bezier anchors separately from curve controls. */
export type ManualTeleportConnectorPath = {
  mode?: ManualTeleportConnectorMode;
  /** Polyline vertices and Bezier anchors. */
  nodes: [number, number][];
  /** Two Bezier controls per consecutive node pair. */
  controls?: [number, number][];
};

export const CUBIC_SAMPLE_STEPS = 64;

export function manualPathMode(path: ManualTeleportConnectorPath): ManualTeleportConnectorMode {
  return path.mode === "curve" ? "curve" : "polyline";
}

/** Generates smooth cubic controls at a stable, editor-friendly distance from each anchor. */
export function straightCubicControls(nodes: readonly [number, number][]): [number, number][] {
  const maxHandleLength = TILE_SIZE * 1.5;
  const unit = (from: readonly [number, number], to: readonly [number, number]): [number, number] | null => {
    const dx = to[0] - from[0], dy = to[1] - from[1], length = Math.hypot(dx, dy);
    return length === 0 ? null : [dx / length, dy / length];
  };
  // Nodes coincident with their neighbours (or a backtracking path) give no direction of their own;
  // `fallback` (the segment direction) keeps the handle pointing into the segment instead of past an end.
  const tangent = (index: number, fallback: [number, number] | null): [number, number] => {
    const before = nodes[index - 1] ?? nodes[index];
    const after = nodes[index + 1] ?? nodes[index];
    return unit(before, after) ?? fallback ?? [1, 0];
  };
  const controls: [number, number][] = [];
  for (let i = 0; i + 1 < nodes.length; i++) {
    const a = nodes[i], b = nodes[i + 1];
    const segmentLength = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const direction = unit(a, b);
    if (!direction) { controls.push([a[0], a[1]], [b[0], b[1]]); continue; }
    // A handle longer than a third of the segment overshoots the opposite end and curls into a loop.
    const handleLength = Math.min(maxHandleLength, segmentLength / 3);
    const outgoing = tangent(i, direction), incoming = tangent(i + 1, direction);
    controls.push([a[0] + outgoing[0] * handleLength, a[1] + outgoing[1] * handleLength]);
    controls.push([b[0] - incoming[0] * handleLength, b[1] - incoming[1] * handleLength]);
  }
  return controls;
}

export function curveControls(path: ManualTeleportConnectorPath): [number, number][] {
  const expected = Math.max(0, path.nodes.length - 1) * 2;
  return path.controls?.length === expected ? path.controls : straightCubicControls(path.nodes);
}

export function editableCurvePoints(path: ManualTeleportConnectorPath): number[] {
  const controls = curveControls(path), result: number[] = [];
  for (let i = 0; i < path.nodes.length; i++) {
    result.push(...path.nodes[i]);
    if (i + 1 < path.nodes.length) result.push(...controls[i * 2], ...controls[i * 2 + 1]);
  }
  return result;
}

export function sampleCubicPath(nodes: readonly [number, number][], controls = straightCubicControls(nodes)): number[] {
  if (nodes.length < 2) return nodes.flat();
  const result: number[] = [];
  for (let index = 0; index + 1 < nodes.length; index++) {
    const a = nodes[index], c1 = controls[index * 2], c2 = controls[index * 2 + 1], b = nodes[index + 1];
    for (let step = index === 0 ? 0 : 1; step <= CUBIC_SAMPLE_STEPS; step++) {
      const t = step / CUBIC_SAMPLE_STEPS, u = 1 - t;
      result.push(u * u * u * a[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * b[0], u * u * u * a[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * b[1]);
    }
  }
  return result;
}

/** Unordered pair identity of two teleport node ids. */
export function teleportPairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** Key of one floor's piece of a cross-floor pair (GitHub issue #989): the pair key plus the id of
 *  the endpoint that lives on that floor. */
export function crossFloorSegmentKey(a: number, b: number, ownNode: number): string {
  return `${teleportPairKey(a, b)}@${ownNode}`;
}

/** Splits a connector key into its pair node ids and, for a cross-floor segment, the endpoint that
 *  owns it. */
export function parseTeleportConnectorKey(key: string): { ids: [number, number]; ownNode?: number } {
  const [pair, own] = key.split("@");
  const [a, b] = pair.split(":").map(Number);
  return own === undefined ? { ids: [a, b] } : { ids: [a, b], ownNode: Number(own) };
}

/**
 * Stable identity for a rendered teleport pair. `buildTeleportEdges` canonicalizes a two-way
 * pair, so sorting also makes a saved edit survive a change in the edge's stored direction.
 * A cross-floor edge (one end is a floor badge) is drawn on two floors with different endpoints,
 * so each floor's piece gets its own key (`crossFloorSegmentKey`) and path.
 */
export function teleportConnectorKey(edge: Pick<TeleportEdge, "fromNode" | "toNode" | "toFloor" | "fromFloor">): string | null {
  if (edge.fromNode === undefined || edge.toNode === undefined) return null;
  if (edge.toFloor !== undefined) return crossFloorSegmentKey(edge.fromNode, edge.toNode, edge.fromNode);
  if (edge.fromFloor !== undefined) return crossFloorSegmentKey(edge.fromNode, edge.toNode, edge.toNode);
  return teleportPairKey(edge.fromNode, edge.toNode);
}

/** Every connector key a stored teleport pair can be drawn under. */
export function teleportPairConnectorKeys(from: number, to: number, crossFloor: boolean): string[] {
  return crossFloor ? [crossFloorSegmentKey(from, to, from), crossFloorSegmentKey(from, to, to)] : [teleportPairKey(from, to)];
}

/** Returns an authored path, or `null` for automatic routing. */
export function manualConnectorPoints(
  edge: TeleportEdge,
  paths: Readonly<Record<string, ManualTeleportConnectorPath>> | undefined,
): number[] | null {
  const key = teleportConnectorKey(edge);
  const path = key === null ? undefined : paths?.[key];
  if (!path || path.nodes.length < 2 || path.nodes.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) return null;
  return manualPathMode(path) === "curve" ? sampleCubicPath(path.nodes, curveControls(path)) : path.nodes.flat();
}
