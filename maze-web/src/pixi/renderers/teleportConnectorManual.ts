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
  const handleLength = TILE_SIZE * 1.5;
  const tangent = (index: number): [number, number] => {
    const before = nodes[index - 1] ?? nodes[index];
    const after = nodes[index + 1] ?? nodes[index];
    const dx = after[0] - before[0], dy = after[1] - before[1], length = Math.hypot(dx, dy);
    return length === 0 ? [1, 0] : [dx / length, dy / length];
  };
  const controls: [number, number][] = [];
  for (let i = 0; i + 1 < nodes.length; i++) {
    const a = nodes[i], b = nodes[i + 1];
    const outgoing = tangent(i), incoming = tangent(i + 1);
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

/**
 * Stable identity for a rendered teleport pair. `buildTeleportEdges` canonicalizes a two-way
 * pair, so sorting also makes a saved edit survive a change in the edge's stored direction.
 */
export function teleportConnectorKey(edge: Pick<TeleportEdge, "fromNode" | "toNode">): string | null {
  if (edge.fromNode === undefined || edge.toNode === undefined) return null;
  return edge.fromNode < edge.toNode ? `${edge.fromNode}:${edge.toNode}` : `${edge.toNode}:${edge.fromNode}`;
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
