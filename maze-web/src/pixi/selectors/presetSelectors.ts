import type { NodeLockKind } from "../../wasm/types";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import type { WallEdge, MarkerData, LockEntry, EdgeHL, PassageKind } from "../renderers/types";
import type { NodeEdgeHighlight } from "../renderers/NodeEdgeHighlightRenderer";
import type { PresetConnectionEntry, FieldEdge } from "../fieldEditUtils";
import { edgeKey, computeInvalidKeysFromCells } from "../fieldEditUtils";
import { getCellCenter, getNeighborData, getSharedEdgeSegment } from "../tessellationGeometry";
import { buildCellSet } from "./sharedSelectors";
import { buildSplitPassagesCore, type SplitPassageNode, type SplitPassagesResult } from "./mazeSelectors";
import { presetEndpoint, presetEndpointKey, type PresetEndpoint } from "../presetEndpoint";
import { NODE_RADIUS, WALL_THICKNESS } from "../renderConstants";
import { canvas } from "../colorTokens";

export function buildPresetWallGroups(
  cells: [number, number][],
  connections: Map<string, PresetConnectionEntry>,
  cfg: TessellationConfig,
  presetSplitPoints: Record<string, number[]> = {},
): { undecided: WallEdge[]; preset: WallEdge[]; invalidPassages: WallEdge[]; invalidKeys: Set<string> } {
  const cellSet = buildCellSet(cells);
  const invalidKeys = computeInvalidKeysFromCells(connections, cells);
  const splitPointKeys = new Set(Object.keys(presetSplitPoints).filter((k) => presetSplitPoints[k].length > 0));

  const undecided: WallEdge[] = [];
  const preset: WallEdge[] = [];
  const invalidPassages: WallEdge[] = [];

  for (const [x, y] of cells) {
    if (splitPointKeys.has(`${x},${y}`)) continue; // rendered by buildPresetSplitPassages instead
    const { offsets } = getNeighborData(cfg, x, y);
    for (const [dx, dy] of offsets) {
      const nx = x + dx;
      const ny = y + dy;
      if (!cellSet.has(`${nx},${ny}`)) {
        // boundary wall — always solid
        preset.push({ a: [x, y], b: [nx, ny], kind: "none", style: "solid" });
        continue;
      }
      if (splitPointKeys.has(`${nx},${ny}`)) continue; // rendered by buildPresetSplitPassages instead

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
        // Direction is `entry.from -> entry.to` for "forward" (reversed for "backward") — `entry`'s
        // own from/to, NOT canonical `[x,y]/[nx,ny]` order, since a split-node-dialog click can
        // store `from`/`to` in either order (Specs/preset-connections.md's "One-way direction").
        const cFrom = getCellCenter(entry.from.point[0], entry.from.point[1], cfg);
        const cTo = getCellCenter(entry.to.point[0], entry.to.point[1], cfg);
        const isForward = entry.state === "one_way_forward";
        const tdx = isForward ? cTo.x - cFrom.x : cFrom.x - cTo.x;
        const tdy = isForward ? cTo.y - cFrom.y : cFrom.y - cTo.y;
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
      invalidPassages.push({ a: entry.from.point, b: entry.to.point, kind: "none", style: "background" });
      continue;
    }

    let kind: PassageKind = "none";
    let oneWayDir: { dx: number; dy: number } | undefined;

    if (entry.state === "one_way_forward" || entry.state === "one_way_backward") {
      kind = entry.state === "one_way_forward" ? "forward" : "backward";
      const cFrom = getCellCenter(entry.from.point[0], entry.from.point[1], cfg);
      const cTo = getCellCenter(entry.to.point[0], entry.to.point[1], cfg);
      const isForward = entry.state === "one_way_forward";
      const tdx = isForward ? cTo.x - cFrom.x : cFrom.x - cTo.x;
      const tdy = isForward ? cTo.y - cFrom.y : cFrom.y - cTo.y;
      const len = Math.sqrt(tdx * tdx + tdy * tdy);
      if (len > 0) oneWayDir = { dx: tdx / len, dy: tdy / len };
    }

    preset.push({ a: entry.from.point, b: entry.to.point, kind, style: "solid", oneWayDir });
  }

  return { undecided, preset, invalidPassages, invalidKeys };
}

/** Preset-stage adapter over `buildSplitPassagesCore` (GitHub issue #231) — colored per-slot
 * passages for every point that has at least one declared split node (`presetSplitPoints`),
 * mirroring `buildSplitPassages`'s post-generation rendering (GitHub issue #223) but built from raw
 * `(point, slotId?)` endpoints instead of resolved `NodeId`s, since presets run before generation.
 * Identity is `presetEndpointKey` (a string), not a numeric id — `buildSplitPassagesCore` is
 * generic over the id type, so this is a legal instantiation. Only `passage`/`one_way_*` preset
 * connections count as a connection across a face — teleports are excluded, same as
 * `buildSplitPassages` filtering out `EdgeDto`'s teleport kind (a teleport must not read as an
 * open geometric passage here); `wall`/`undefined` entries and points with no declared split are
 * skipped, same "nothing to draw" rule `buildPresetWallGroups` already applies to plain (unsplit)
 * points. */
export function buildPresetSplitPassages(
  presetSplitPoints: Record<string, number[]>,
  connections: Map<string, PresetConnectionEntry>,
  cfg: TessellationConfig,
  presetActiveSplitNode: Record<string, PresetEndpoint> = {},
  cells: [number, number][] = [],
): SplitPassagesResult {
  const splitPointKeys = new Set(Object.keys(presetSplitPoints).filter((k) => presetSplitPoints[k].length > 0));
  if (splitPointKeys.size === 0) return { passages: [], wallFaces: [] };

  // `buildSplitPassagesCore` needs every node a split point's nodes might connect to in the
  // `nodes` list, not just the split points themselves — mirrors `buildSplitPassages` (NodeDto),
  // where `nodes` is the whole maze's node list, so an ordinary (unsplit) neighbor is naturally
  // present. Here that has to be assembled explicitly: the declared split nodes, plus one plain
  // (single, original-only) node per in-field geometric neighbor of one of them — a plain neighbor
  // point is never itself split, so it needs exactly one `SplitPassageNode` entry (its own original
  // endpoint) for the "other" side of the face lookup to resolve. Registering every geometric
  // neighbor (not just ones some connection entry happens to reference) is what lets an
  // undeclared/default face read as "undefined" (optional) instead of vanishing — most faces have
  // no connection entry at all until the user decides one way or the other.
  const cellSet = buildCellSet(cells);
  const nodesByKey = new Map<string, SplitPassageNode<string>>();
  const addNode = (ep: PresetEndpoint) => {
    const id = presetEndpointKey(ep);
    if (!nodesByKey.has(id)) nodesByKey.set(id, { id, x: ep.point[0], y: ep.point[1] });
  };
  for (const key of splitPointKeys) {
    const [x, y] = key.split(",").map(Number);
    addNode(presetEndpoint([x, y]));
    for (const slotId of [...presetSplitPoints[key]].sort((a, b) => a - b)) addNode(presetEndpoint([x, y], slotId));

    const { offsets } = getNeighborData(cfg, x, y);
    for (const [dx, dy] of offsets) {
      const nx = x + dx, ny = y + dy;
      if (!cellSet.has(`${nx},${ny}`)) continue;
      addNode(presetEndpoint([nx, ny]));
      // The neighbor may itself be a declared split point with its own slots — register all of
      // them too, not just its original node, otherwise `buildSplitPassagesCore`'s per-node
      // partner resolution has no candidate to match a still-undecided (no `connections` entry
      // yet) face against a specific neighbor slot, only the neighbor's original node.
      const neighborKey = `${nx},${ny}`;
      const neighborSlots = presetSplitPoints[neighborKey] ?? [];
      for (const slotId of neighborSlots) addNode(presetEndpoint([nx, ny], slotId));
    }
  }

  const directedPairs: { from: string; to: string }[] = [];
  const addPair = (a: PresetEndpoint, b: PresetEndpoint) => directedPairs.push({ from: presetEndpointKey(a), to: presetEndpointKey(b) });
  const wallPairs = new Set<string>();
  for (const entry of connections.values()) {
    if (entry.state === "undefined") continue;
    const fromIsSplit = splitPointKeys.has(`${entry.from.point[0]},${entry.from.point[1]}`);
    const toIsSplit = splitPointKeys.has(`${entry.to.point[0]},${entry.to.point[1]}`);
    if (!fromIsSplit && !toIsSplit) continue; // neither side touches a declared split point
    addNode(entry.from);
    addNode(entry.to);
    if (entry.state === "passage") { addPair(entry.from, entry.to); addPair(entry.to, entry.from); }
    else if (entry.state === "one_way_forward") addPair(entry.from, entry.to);
    else if (entry.state === "one_way_backward") addPair(entry.to, entry.from);
    else if (entry.state === "wall") {
      const a = presetEndpointKey(entry.from), b = presetEndpointKey(entry.to);
      wallPairs.add(`${a}<->${b}`);
      wallPairs.add(`${b}<->${a}`);
    }
  }

  const activeId = (pointKey: string): string | undefined => {
    const active = presetActiveSplitNode[pointKey];
    return active ? presetEndpointKey(active) : undefined;
  };

  return buildSplitPassagesCore([...nodesByKey.values()], directedPairs, cfg, new Set(), activeId, "undefined", wallPairs);
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
      return (e.from.point[0] === x && e.from.point[1] === y) || (e.to.point[0] === x && e.to.point[1] === y);
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
    const seg = getSharedEdgeSegment(entry.from.point, entry.to.point, cfg);
    if (seg) {
      result.push({
        from: [seg.v0.x, seg.v0.y] as [number, number],
        to: [seg.v1.x, seg.v1.y] as [number, number],
        color: canvas.preset.invalid,
        alpha: 0.9,
        width: WALL_THICKNESS * 2.5,
      });
    } else {
      const cA = getCellCenter(entry.from.point[0], entry.from.point[1], cfg);
      const cB = getCellCenter(entry.to.point[0], entry.to.point[1], cfg);
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

/** Highlight for `presetHoveredLink` (GitHub issue #237) — same "node-to-node" style
 *  `DebugRefHighlightOverlay` uses for an edge ref (`NodeEdgeHighlightRenderer`: a straight line
 *  + circle markers on each end), cell center to cell center — not the shared geometric wall
 *  segment `buildHoverEdgeHighlight` draws (a teleport link has no shared face at all to draw
 *  on), and not a split point's hub point either (kept simple: this highlight only needs to say
 *  "these two cells", not distinguish which of a split point's several nodes). */
export function buildLinkHoverHighlight(
  link: { from: PresetEndpoint; to: PresetEndpoint } | null,
  cfg: TessellationConfig,
): NodeEdgeHighlight[] {
  if (!link) return [];
  return [{
    from: getCellCenter(link.from.point[0], link.from.point[1], cfg),
    to: getCellCenter(link.to.point[0], link.to.point[1], cfg),
    color: canvas.fieldEditor.hover,
    alpha: 1.0,
    width: WALL_THICKNESS * 2,
    nodeRadius: NODE_RADIUS,
  }];
}
