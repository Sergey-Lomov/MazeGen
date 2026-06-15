import type { NodeLockKind } from "../../wasm/types";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import type { WallEdge, MarkerData, LockEntry, EdgeHL, PassageKind } from "../renderers/types";
import type { PresetConnectionEntry, FieldEdge } from "../presetConnectionsUtils";
import { edgeKey, canonicalize, computeInvalidKeysFromCells } from "../presetConnectionsUtils";
import { getCellCenter, getNeighborData, getSharedEdgeSegment } from "../tessellationGeometry";
import { buildCellSet, buildOwnedEdgeKeys } from "./sharedSelectors";
import {
  NODE_START_COLOR, NODE_FINISH_COLOR, NODE_RADIUS,
  INVALID_COLOR, HOVER_COLOR, WALL_THICKNESS,
} from "../colorUtils";

export function buildPresetWallGroups(
  cells: [number, number][],
  connections: Map<string, PresetConnectionEntry>,
  cfg: TessellationConfig,
): { undecided: WallEdge[]; preset: WallEdge[]; invalidKeys: Set<string> } {
  const cellSet = buildCellSet(cells);
  const ownedKeys = buildOwnedEdgeKeys(cells, cfg, cellSet);
  const invalidKeys = computeInvalidKeysFromCells(connections, cells);

  const undecided: WallEdge[] = [];
  const preset: WallEdge[] = [];

  for (const [x, y] of cells) {
    const { offsets } = getNeighborData(cfg, x, y);
    for (const [dx, dy] of offsets) {
      const nx = x + dx;
      const ny = y + dy;
      if (!cellSet.has(`${nx},${ny}`)) {
        // boundary wall — always solid
        preset.push({ a: [x, y], b: [nx, ny], kind: "none", style: "solid" });
        continue;
      }

      const key = edgeKey([x, y], [nx, ny]);
      if (!ownedKeys.has(key)) continue;

      const entry = connections.get(key);
      if (!entry || entry.state === "undefined") {
        undecided.push({ a: [x, y], b: [nx, ny], kind: "none", style: "faint" });
        continue;
      }

      const isInvalid = invalidKeys.has(key);
      const style = isInvalid ? "invalid" : "solid";

      if (entry.state === "passage") continue; // open passage — no wall

      let kind: PassageKind = "none";
      let oneWayDir: { dx: number; dy: number } | undefined;

      if (entry.state === "one_way_forward" || entry.state === "one_way_backward") {
        kind = entry.state === "one_way_forward" ? "forward" : "backward";
        const [fa, fb] = canonicalize([x, y], [nx, ny]);
        const cA = getCellCenter(fa[0], fa[1], cfg);
        const cB = getCellCenter(fb[0], fb[1], cfg);
        const isForward = entry.state === "one_way_forward";
        const tdx = isForward ? cB.x - cA.x : cA.x - cB.x;
        const tdy = isForward ? cB.y - cA.y : cA.y - cB.y;
        const len = Math.sqrt(tdx * tdx + tdy * tdy);
        if (len > 0) oneWayDir = { dx: tdx / len, dy: tdy / len };
      }

      preset.push({ a: [x, y], b: [nx, ny], kind, style, oneWayDir });
    }
  }

  return { undecided, preset, invalidKeys };
}

export function buildPresetMarkers(
  start: [number, number] | null,
  finish: [number, number] | null,
  cfg: TessellationConfig,
): MarkerData[] {
  const markers: MarkerData[] = [];
  if (start) {
    const c = getCellCenter(start[0], start[1], cfg);
    markers.push({ pos: [c.x, c.y], color: NODE_START_COLOR, radius: NODE_RADIUS * 1.5 });
  }
  if (finish) {
    const c = getCellCenter(finish[0], finish[1], cfg);
    markers.push({ pos: [c.x, c.y], color: NODE_FINISH_COLOR, radius: NODE_RADIUS * 1.5 });
  }
  return markers;
}

export function buildLocks(
  lockedNodes: Map<string, NodeLockKind>,
  autoLockedNodes: Set<string>,
): LockEntry[] {
  const merged = new Map<string, NodeLockKind>(lockedNodes);
  for (const key of autoLockedNodes) {
    if (!merged.has(key)) merged.set(key, "both");
  }
  return Array.from(merged.entries()).map(([key, type]) => {
    const [x, y] = key.split(",").map(Number);
    return { x, y, type };
  });
}

export function buildIsolatedCellHighlights(
  lockedNodes: Map<string, NodeLockKind>,
  autoLockedNodes: Set<string>,
  connections: Map<string, PresetConnectionEntry>,
): [number, number][] {
  const allBothLocked = new Set<string>();
  for (const [key, kind] of lockedNodes) {
    if (kind === "both") allBothLocked.add(key);
  }
  for (const key of autoLockedNodes) {
    allBothLocked.add(key);
  }

  const result: [number, number][] = [];
  for (const key of allBothLocked) {
    const [x, y] = key.split(",").map(Number);
    const hasPassage = Array.from(connections.values()).some(e => {
      if (e.state === "wall" || e.state === "undefined") return false;
      return (e.from[0] === x && e.from[1] === y) || (e.to[0] === x && e.to[1] === y);
    });
    if (hasPassage) continue;
    result.push([x, y]);
  }
  return result;
}

export function buildInvalidEdgeHighlights(
  invalidKeys: Set<string>,
  connections: Map<string, PresetConnectionEntry>,
  cfg: TessellationConfig,
): EdgeHL[] {
  const result: EdgeHL[] = [];
  for (const key of invalidKeys) {
    const entry = connections.get(key);
    if (!entry) continue;
    const seg = getSharedEdgeSegment(entry.from, entry.to, cfg);
    if (seg) {
      result.push({
        from: [seg.v0.x, seg.v0.y] as [number, number],
        to: [seg.v1.x, seg.v1.y] as [number, number],
        color: INVALID_COLOR,
        alpha: 0.9,
        width: WALL_THICKNESS * 2.5,
      });
    } else {
      const cA = getCellCenter(entry.from[0], entry.from[1], cfg);
      const cB = getCellCenter(entry.to[0], entry.to[1], cfg);
      result.push({
        from: [cA.x, cA.y],
        to: [cB.x, cB.y],
        color: INVALID_COLOR,
        alpha: 0.9,
        width: WALL_THICKNESS * 2.5,
      });
    }
  }
  return result;
}

export function buildHoverEdgeHighlight(
  edge: FieldEdge | null,
  cfg: TessellationConfig,
): EdgeHL[] {
  if (!edge) return [];
  const seg = getSharedEdgeSegment(edge.from, edge.to, cfg);
  if (!seg) return [];
  return [{
    from: [seg.v0.x, seg.v0.y],
    to: [seg.v1.x, seg.v1.y],
    color: HOVER_COLOR,
    alpha: 1.0,
    width: WALL_THICKNESS * 2,
  }];
}
