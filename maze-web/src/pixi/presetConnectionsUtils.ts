import { TILE_SIZE } from "./constants";
import { TRI_TILE_SIZE } from "./triGeometry";
import { makeProjection, encodePoint, decodePoint } from "./tessellationProjection";
import { configAllCells } from "./tessellationCells";
import { getCellNeighborOffsets, getSharedEdgeSegment } from "./tessellationGeometry";
import type { TessellationConfig, PresetConnectionState } from "../wasm/types";

export interface PresetConnectionEntry {
  from: [number, number];
  to: [number, number];
  state: PresetConnectionState;
}

export type PresetConnectionTool = "wall" | "passage" | "reset" | "one_way" | "set_start" | "set_finish";

export interface FieldEdge {
  key: string;
  from: [number, number];
  to: [number, number];
}

export function canonicalize(
  p1: [number, number],
  p2: [number, number],
): [[number, number], [number, number]] {
  const less = p1[0] < p2[0] || (p1[0] === p2[0] && p1[1] < p2[1]);
  return less ? [p1, p2] : [p2, p1];
}

export function edgeKey(a: [number, number], b: [number, number]): string {
  const [fa, fb] = canonicalize(a, b);
  return `${fa[0]},${fa[1]}-${fb[0]},${fb[1]}`;
}

export function resolveCells(cfg: TessellationConfig, customPoints?: Set<number>): [number, number][] {
  if (customPoints && customPoints.size > 0)
    return Array.from(customPoints).map(k => decodePoint(k) as [number, number]);
  return configAllCells(cfg);
}


export function computeInvalidKeys(
  presetConnections: Map<string, PresetConnectionEntry>,
  cfg: TessellationConfig,
  customPoints?: Set<number>,
): Set<string> {
  const cells = resolveCells(cfg, customPoints);
  return computeInvalidKeysFromCells(presetConnections, cells);
}

export function computeInvalidKeysFromCells(
  presetConnections: Map<string, PresetConnectionEntry>,
  cells: [number, number][],
): Set<string> {
  const fieldSet = new Set<number>();
  for (const [x, y] of cells) fieldSet.add(encodePoint(x, y));

  const invalid = new Set<string>();
  for (const [key, entry] of presetConnections) {
    const aIn = fieldSet.has(encodePoint(entry.from[0], entry.from[1]));
    const bIn = fieldSet.has(encodePoint(entry.to[0], entry.to[1]));
    if (!aIn || !bIn) invalid.add(key);
  }
  return invalid;
}

function distToSegmentSq(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return (px - ax) * (px - ax) + (py - ay) * (py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return (px - cx) * (px - cx) + (py - cy) * (py - cy);
}

export function pickEdgeAtPosition(
  viewportX: number,
  viewportY: number,
  cfg: TessellationConfig,
  cells: [number, number][],
  cellSet?: Set<number>,
): FieldEdge | null {
  const proj = makeProjection(cfg);
  const cell = proj.screenToGrid(viewportX, viewportY);

  if (!cellSet) {
    cellSet = new Set<number>();
    for (const [x, y] of cells) cellSet.add(encodePoint(x, y));
  }

  const isTriangle = cfg.type === "triangle_rect" || cfg.type === "triangle_triangle"
    || cfg.type === "triangle_hexagon" || cfg.type === "tri_custom";
  const threshold = isTriangle ? TRI_TILE_SIZE * 0.4 : TILE_SIZE * 0.4;
  const thresholdSq = threshold * threshold;

  let bestKey: string | null = null;
  let bestFrom: [number, number] | null = null;
  let bestTo: [number, number] | null = null;
  let bestDist = Infinity;

  const candidates: [number, number][] = [[cell.x, cell.y]];
  for (const [dx, dy] of getCellNeighborOffsets(cfg, cell.x, cell.y))
    candidates.push([cell.x + dx, cell.y + dy]);

  const checked = new Set<string>();
  for (const [cx, cy] of candidates) {
    if (!cellSet.has(encodePoint(cx, cy))) continue;
    for (const [dx, dy] of getCellNeighborOffsets(cfg, cx, cy)) {
      const nx = cx + dx, ny = cy + dy;
      if (!cellSet.has(encodePoint(nx, ny))) continue;
      const key = edgeKey([cx, cy], [nx, ny]);
      if (checked.has(key)) continue;
      checked.add(key);

      const seg = getSharedEdgeSegment([cx, cy], [nx, ny], cfg);
      if (!seg) continue;
      const distSq = distToSegmentSq(viewportX, viewportY, seg.v0.x, seg.v0.y, seg.v1.x, seg.v1.y);
      if (distSq < thresholdSq && distSq < bestDist) {
        bestDist = distSq;
        bestKey = key;
        const [from, to] = canonicalize([cx, cy], [nx, ny]);
        bestFrom = from;
        bestTo = to;
      }
    }
  }

  if (bestKey && bestFrom && bestTo) {
    return { key: bestKey, from: bestFrom, to: bestTo };
  }
  return null;
}

export function applyTool(
  connections: Map<string, PresetConnectionEntry>,
  edge: FieldEdge,
  tool: PresetConnectionTool,
): Map<string, PresetConnectionEntry> {
  const next = new Map(connections);
  if (tool === "reset") {
    next.delete(edge.key);
    return next;
  }
  if (tool === "one_way") {
    const current = connections.get(edge.key);
    if (current?.state === "one_way_forward") {
      next.set(edge.key, { from: edge.from, to: edge.to, state: "one_way_backward" });
    } else if (current?.state === "one_way_backward") {
      next.set(edge.key, { from: edge.from, to: edge.to, state: "one_way_forward" });
    } else {
      next.set(edge.key, { from: edge.from, to: edge.to, state: "one_way_forward" });
    }
    return next;
  }
  const state: PresetConnectionState = tool === "wall" ? "wall" : "passage";
  next.set(edge.key, { from: edge.from, to: edge.to, state });
  return next;
}
