import type { NodeLockKind } from "../../wasm/types";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import type { WallEdge, MarkerData, LockEntry, EdgeHL, PassageKind } from "../renderers/types";
import type { PresetConnectionEntry, FieldEdge } from "../fieldEditUtils";
import { edgeKey, canonicalize, computeInvalidKeysFromCells } from "../fieldEditUtils";
import { getCellCenter, getNeighborData, getSharedEdgeSegment } from "../tessellationGeometry";
import { buildCellSet } from "./sharedSelectors";
import { canvas } from "../colorUtils";
import { NODE_RADIUS, WALL_THICKNESS } from "../sizing";

export function buildPresetWallGroups(
  cells: [number, number][],
  connections: Map<string, PresetConnectionEntry>,
  cfg: TessellationConfig,
): { undecided: WallEdge[]; preset: WallEdge[]; invalidPassages: WallEdge[]; invalidKeys: Set<string> } {
  const cellSet = buildCellSet(cells);
  const invalidKeys = computeInvalidKeysFromCells(connections, cells);

  const undecided: WallEdge[] = [];
  const preset: WallEdge[] = [];
  const invalidPassages: WallEdge[] = [];

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

      // each interior edge is shared by two cells; only process it once, from
      // the lexicographically-smaller side
      const ownsEdge = x < nx || (x === nx && y < ny);
      if (!ownsEdge) continue;

      const key = edgeKey([x, y], [nx, ny]);

      const entry = connections.get(key);
      if (!entry || entry.state === "undefined") {
        undecided.push({ a: [x, y], b: [nx, ny], kind: "none", style: "faint" });
        continue;
      }

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

      preset.push({ a: [x, y], b: [nx, ny], kind, style: "solid", oneWayDir });
    }
  }

  // Invalid presets with at least one endpoint outside the field are never
  // visited by the cell loop above (it only walks cells inside the field).
  // Render them directly from the connection map so they stay visible.
  for (const key of invalidKeys) {
    const entry = connections.get(key);
    if (!entry || entry.state === "undefined") continue;

    if (entry.state === "passage") {
      invalidPassages.push({ a: entry.from, b: entry.to, kind: "none", style: "background" });
      continue;
    }

    let kind: PassageKind = "none";
    let oneWayDir: { dx: number; dy: number } | undefined;

    if (entry.state === "one_way_forward" || entry.state === "one_way_backward") {
      kind = entry.state === "one_way_forward" ? "forward" : "backward";
      const [fa, fb] = canonicalize(entry.from, entry.to);
      const cA = getCellCenter(fa[0], fa[1], cfg);
      const cB = getCellCenter(fb[0], fb[1], cfg);
      const isForward = entry.state === "one_way_forward";
      const tdx = isForward ? cB.x - cA.x : cA.x - cB.x;
      const tdy = isForward ? cB.y - cA.y : cA.y - cB.y;
      const len = Math.sqrt(tdx * tdx + tdy * tdy);
      if (len > 0) oneWayDir = { dx: tdx / len, dy: tdy / len };
    }

    preset.push({ a: entry.from, b: entry.to, kind, style: "solid", oneWayDir });
  }

  return { undecided, preset, invalidPassages, invalidKeys };
}

export function buildPresetMarkers(
  start: [number, number] | null,
  finish: [number, number] | null,
  cfg: TessellationConfig,
): MarkerData[] {
  const markers: MarkerData[] = [];
  if (start) {
    const c = getCellCenter(start[0], start[1], cfg);
    markers.push({ pos: [c.x, c.y], color: canvas.node.start, radius: NODE_RADIUS * 1.5 });
  }
  if (finish) {
    const c = getCellCenter(finish[0], finish[1], cfg);
    markers.push({ pos: [c.x, c.y], color: canvas.node.finish, radius: NODE_RADIUS * 1.5 });
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
        color: canvas.preset.invalid,
        alpha: 0.9,
        width: WALL_THICKNESS * 2.5,
      });
    } else {
      const cA = getCellCenter(entry.from[0], entry.from[1], cfg);
      const cB = getCellCenter(entry.to[0], entry.to[1], cfg);
      result.push({
        from: [cA.x, cA.y],
        to: [cB.x, cB.y],
        color: canvas.preset.invalid,
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
    color: canvas.fieldEditor.hover,
    alpha: 1.0,
    width: WALL_THICKNESS * 2,
  }];
}
