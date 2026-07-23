import { TILE_SIZE } from "./constants";
import { TRI_TILE_SIZE } from "./triGeometry";
import { makeProjection, encodePoint, decodePoint } from "./tessellationProjection";
import { configAllCells } from "./tessellationCells";
import { getCellNeighborOffsets, getSharedEdgeSegment } from "./tessellationGeometry";
import type { PresetConnectionState } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { presetEndpoint, type PresetEndpoint } from "./presetEndpoint";

export type PresetConnectionClientState = PresetConnectionState | "undefined";

/** `from`/`to` are `PresetEndpoint` (point + optional slot, GitHub issue #231), not a bare cell
 * tuple — a preset connection can address one of a split point's declared extra nodes. Edge
 * picking/hit-testing (`pickEdgeAtPosition`, `canonicalize`, `edgeKey`) still operates on raw
 * cell coordinates (the cursor targets a point/face, never a specific node) — the active slot
 * (`presetActiveSplitNode`, mirrors post-edit's `postEditActiveSplitNode`) is folded in only when
 * `applyTool` actually writes an entry. */
export interface PresetConnectionEntry {
  from: PresetEndpoint;
  to: PresetEndpoint;
  state: PresetConnectionClientState;
  source: "user" | "default";
}

export type PresetConnectionTool = "wall" | "passage" | "reset" | "one_way" | "set_start" | "set_finish" | "lock_in" | "lock_out" | "full_lock" | "gen_source" | "teleport_one_way" | "teleport_two_way" | "manage_split_nodes";

export interface FieldEdge {
  key: string;
  from: [number, number];
  to: [number, number];
}

export type PresetTeleportDirection = "forward" | "backward" | "two_way";

/** `from`/`to` are `PresetEndpoint` (GitHub issue #231) — same rationale as `PresetConnectionEntry`. */
export interface PresetTeleportEntry {
  id: number;
  from: PresetEndpoint;
  to: PresetEndpoint;
  direction: PresetTeleportDirection;
}

export function presetTeleportEntryToState(direction: PresetTeleportDirection): PresetConnectionState {
  if (direction === "forward") return "teleport_forward";
  if (direction === "backward") return "teleport_backward";
  return "teleport_two_way";
}

/** Endpoint of a preset teleport, identified for hit-testing/drag by the owning entry's id and which end it is. */
export interface PresetTeleportEndpointHit {
  id: number;
  end: "from" | "to";
}

const TELEPORT_ENDPOINT_HIT_RADIUS = TILE_SIZE * 0.3;

export function pickTeleportEndpointAt(
  viewportX: number,
  viewportY: number,
  cfg: TessellationConfig,
  teleports: PresetTeleportEntry[],
): PresetTeleportEndpointHit | null {
  const proj = makeProjection(cfg);
  const thresholdSq = TELEPORT_ENDPOINT_HIT_RADIUS * TELEPORT_ENDPOINT_HIT_RADIUS;
  let best: PresetTeleportEndpointHit | null = null;
  let bestDistSq = Infinity;
  for (const t of teleports) {
    for (const end of ["from", "to"] as const) {
      const [cx, cy] = end === "from" ? t.from.point : t.to.point;
      const { x: px, y: py } = proj.gridToScreen(cx, cy);
      const dx = px - viewportX;
      const dy = py - viewportY;
      const distSq = dx * dx + dy * dy;
      if (distSq < thresholdSq && distSq < bestDistSq) {
        bestDistSq = distSq;
        best = { id: t.id, end };
      }
    }
  }
  return best;
}

export function cycleTeleportDirection(
  teleports: PresetTeleportEntry[],
  id: number,
): PresetTeleportEntry[] {
  return teleports.map(t => {
    if (t.id !== id || t.direction === "two_way") return t;
    return { ...t, direction: t.direction === "forward" ? "backward" : "forward" };
  });
}

export function removeTeleport(teleports: PresetTeleportEntry[], id: number): PresetTeleportEntry[] {
  return teleports.filter(t => t.id !== id);
}

export function moveTeleportEndpoint(
  teleports: PresetTeleportEntry[],
  hit: PresetTeleportEndpointHit,
  cell: [number, number],
): PresetTeleportEntry[] {
  return teleports.map(t => {
    if (t.id !== hit.id) return t;
    // Moving to a different cell drops any slot the endpoint previously addressed — the slot
    // belonged to the old point, not the new one.
    return { ...t, [hit.end]: presetEndpoint(cell) };
  });
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
    const aIn = fieldSet.has(encodePoint(entry.from.point[0], entry.from.point[1]));
    const bIn = fieldSet.has(encodePoint(entry.to.point[0], entry.to.point[1]));
    if (!aIn || !bIn) invalid.add(key);
  }
  return invalid;
}

export function computeInvalidMarkers(
  presetStart: PresetEndpoint | null,
  presetFinish: PresetEndpoint | null,
  cfg: TessellationConfig,
  customPoints?: Set<number>,
): { start: boolean; finish: boolean } {
  const cells = resolveCells(cfg, customPoints);
  const fieldSet = new Set<number>();
  for (const [x, y] of cells) fieldSet.add(encodePoint(x, y));

  return {
    start: presetStart != null && !fieldSet.has(encodePoint(presetStart.point[0], presetStart.point[1])),
    finish: presetFinish != null && !fieldSet.has(encodePoint(presetFinish.point[0], presetFinish.point[1])),
  };
}

export function computeInvalidTeleportIds(
  teleports: PresetTeleportEntry[],
  cfg: TessellationConfig,
  customPoints?: Set<number>,
): Set<number> {
  const cells = resolveCells(cfg, customPoints);
  const fieldSet = new Set<number>();
  for (const [x, y] of cells) fieldSet.add(encodePoint(x, y));

  const invalid = new Set<number>();
  for (const t of teleports) {
    const aIn = fieldSet.has(encodePoint(t.from.point[0], t.from.point[1]));
    const bIn = fieldSet.has(encodePoint(t.to.point[0], t.to.point[1]));
    if (!aIn || !bIn) invalid.add(t.id);
  }
  return invalid;
}

/** Invalid split-declaration points (GitHub issue #231) — same "point outside the current field"
 * criterion as `computeInvalidKeys`/`computeInvalidTeleportIds`/`computeInvalidMarkers`, applied
 * to `presetSplitPoints`'s keys instead. Needed separately because a declared split point can be
 * an orphan (no preset/teleport/marker referencing it) — the only way an invalid point could reach
 * the WASM `split_points` payload without going through one of the other three checks first. */
export function computeInvalidSplitPoints(
  presetSplitPoints: Record<string, number[]>,
  cfg: TessellationConfig,
  customPoints?: Set<number>,
): Set<string> {
  const cells = resolveCells(cfg, customPoints);
  const fieldSet = new Set<number>();
  for (const [x, y] of cells) fieldSet.add(encodePoint(x, y));

  const invalid = new Set<string>();
  for (const key of Object.keys(presetSplitPoints)) {
    const [x, y] = key.split(",").map(Number);
    if (!fieldSet.has(encodePoint(x, y))) invalid.add(key);
  }
  return invalid;
}

interface SegmentHit {
  distSq: number;
  /** Fraction along the segment (0 = v0, 1 = v1) of the closest point to the query position. */
  t: number;
}

function closestPointOnSegment(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): SegmentHit {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { distSq: (px - ax) * (px - ax) + (py - ay) * (py - ay), t: 0 };
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return { distSq: (px - cx) * (px - cx) + (py - cy) * (py - cy), t };
}

/** Fraction of a segment's length, at each end, treated as a dead zone: hover/drag hit-testing
 * ignores the segment there so the cursor must clearly enter its interior before it registers.
 * Without this, passing near a grid vertex while dragging along one edge would register a hit on
 * a perpendicular edge meeting at that same vertex (#188). Only applied when `deadZone` is passed
 * to `pickEdgeAtPosition` — a plain (non-drag) click must still be able to hit an edge whose
 * nearest point is close to a vertex, so pointerdown call sites opt out. */
const EDGE_ENDPOINT_DEAD_ZONE_FRACTION = 0.2;

export function pickEdgeAtPosition(
  viewportX: number,
  viewportY: number,
  cfg: TessellationConfig,
  cells: [number, number][],
  cellSet?: Set<number>,
  deadZone = false,
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
      const hit = closestPointOnSegment(viewportX, viewportY, seg.v0.x, seg.v0.y, seg.v1.x, seg.v1.y);
      if (deadZone && (hit.t < EDGE_ENDPOINT_DEAD_ZONE_FRACTION || hit.t > 1 - EDGE_ENDPOINT_DEAD_ZONE_FRACTION)) continue;
      const distSq = hit.distSq;
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

/**
 * Returns set of "x,y" keys for cells where all interior edges are explicitly preset.
 * An interior edge is one shared with another cell in the field.
 */
export function computeAutoLockedNodes(
  presetConnections: Map<string, PresetConnectionEntry>,
  cfg: TessellationConfig,
  customPoints?: Set<number>,
): Set<string> {
  const cells = resolveCells(cfg, customPoints);
  const cellSet = new Set<number>();
  for (const [x, y] of cells) cellSet.add(encodePoint(x, y));

  const result = new Set<string>();
  for (const [x, y] of cells) {
    const offsets = getCellNeighborOffsets(cfg, x, y);
    let allDefined = true;
    let hasInteriorEdge = false;
    for (const [dx, dy] of offsets) {
      const nx = x + dx, ny = y + dy;
      if (!cellSet.has(encodePoint(nx, ny))) continue;
      hasInteriorEdge = true;
      const key = edgeKey([x, y], [nx, ny]);
      const entry = presetConnections.get(key);
      if (!entry || entry.state === "undefined") { allDefined = false; break; }
    }
    if (hasInteriorEdge && allDefined) result.add(`${x},${y}`);
  }
  return result;
}

/** Resolves which node of `point` a preset edge-tool click currently targets — the preset-stage
 * counterpart of post-edit's `resolveActiveEndpointAt` (GitHub issue #231). `activeMap[key]` if
 * set, else the point's original node (`presetEndpoint(point)`, no slot). */
export function resolvePresetActiveEndpoint(
  point: [number, number],
  activeMap: Record<string, PresetEndpoint>,
): PresetEndpoint {
  const key = `${point[0]},${point[1]}`;
  return activeMap[key] ?? presetEndpoint(point);
}

/** Preset-side edge key, slot-aware (GitHub issue #231): for two endpoints with no active slot on
 * either side, identical to `edgeKey`'s plain geometric key — every existing preset entry (and
 * the default-edge-state mechanism, which only ever targets original nodes) keeps its exact key.
 * A slot-addressed endpoint on either side changes the key, so a split-targeted preset never
 * collides with the point's plain (original-node) preset. */
export function presetEdgeKey(a: PresetEndpoint, b: PresetEndpoint): string {
  const [fa, fb] = a.point[0] < b.point[0] || (a.point[0] === b.point[0] && a.point[1] < b.point[1]) ? [a, b] : [b, a];
  return `${fa.point[0]},${fa.point[1]}${fa.slotId !== undefined ? `:${fa.slotId}` : ""}-${fb.point[0]},${fb.point[1]}${fb.slotId !== undefined ? `:${fb.slotId}` : ""}`;
}

/**
 * Clears an edge's explicit user override so it goes back to tracking the current default:
 * deletes the entry if `defaultEdgeState` is `"undefined"`, otherwise materializes it as a
 * `source: "default"` entry (so a later default change recomputes it like any other default edge).
 */
export function materializeReset(
  connections: Map<string, PresetConnectionEntry>,
  edge: FieldEdge,
  defaultEdgeState: PresetConnectionClientState,
  from: PresetEndpoint = presetEndpoint(edge.from),
  to: PresetEndpoint = presetEndpoint(edge.to),
): Map<string, PresetConnectionEntry> {
  const next = new Map(connections);
  if (defaultEdgeState === "undefined") {
    next.delete(edge.key);
  } else {
    next.set(edge.key, { from, to, state: defaultEdgeState, source: "default" });
  }
  return next;
}

export function applyTool(
  connections: Map<string, PresetConnectionEntry>,
  edge: FieldEdge,
  tool: PresetConnectionTool,
  defaultEdgeState: PresetConnectionClientState = "undefined",
  activeMap: Record<string, PresetEndpoint> = {},
): Map<string, PresetConnectionEntry> {
  const from = resolvePresetActiveEndpoint(edge.from, activeMap);
  const to = resolvePresetActiveEndpoint(edge.to, activeMap);
  const key = presetEdgeKey(from, to);
  if (tool === "reset") {
    return materializeReset(connections, { key, from: edge.from, to: edge.to }, defaultEdgeState, from, to);
  }
  const next = new Map(connections);
  if (tool === "one_way") {
    const current = connections.get(key);
    if (current?.state === "one_way_forward") {
      next.set(key, { from, to, state: "one_way_backward", source: "user" });
    } else if (current?.state === "one_way_backward") {
      next.set(key, { from, to, state: "one_way_forward", source: "user" });
    } else {
      next.set(key, { from, to, state: "one_way_forward", source: "user" });
    }
    return next;
  }
  const state: PresetConnectionState = tool === "wall" ? "wall" : "passage";
  next.set(key, { from, to, state, source: "user" });
  return next;
}
