import { presetEndpointsEqual, type PresetEndpoint } from "../presetEndpoint";
import {
  allNodesAt, presetSplitNodeFaceKinds,
  type PresetConnectionEntry, type PresetTeleportEntry, type PresetVerticalPassageEntry, type PresetElevatorEntry,
} from "../fieldEditUtils";
import { splitNodeSemanticNamesFromKinds } from "../splitNodeNames";
import type { NodeLockKind } from "../../wasm/types";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";

function formatFloor(level: number): string {
  return `L${level + 1}`;
}

/** Same-floor target shows plain cell coordinates, cross-floor target shows the floor label
 *  instead — mirrors `cellInspection.ts`'s `formatTarget` for the post-generation graph. */
function formatTarget(other: PresetEndpoint, activeFloorLevel: number): string {
  const otherLevel = other.level ?? 0;
  return otherLevel === activeFloorLevel ? `(${other.point[0]},${other.point[1]})` : `(${formatFloor(otherLevel)})`;
}

/** Every marker-line contributed by one specific preset-stage node (an original node or a declared
 *  split slot) — start/finish/gen-source markers, preset teleport/vertical-passage/elevator
 *  endpoints, and node locks (manual or auto), all addressed by exact `PresetEndpoint` match
 *  (GitHub issue #353's Preset Connections follow-up). Unlike the post-generation inspector, there
 *  is no unscoped node/edge list to resolve a cross-floor target through — each collection here is
 *  already flat/maze-wide, so a cross-floor teleport/vertical-passage's other endpoint is simply
 *  the entry's own `from`/`to`, no lookup needed. */
function buildPresetNodeMarkerLines(
  endpoint: PresetEndpoint,
  activeFloorLevel: number,
  presetStart: PresetEndpoint | null,
  presetFinish: PresetEndpoint | null,
  presetGenSource: PresetEndpoint | null,
  presetTeleports: PresetTeleportEntry[],
  presetVerticalPassages: PresetVerticalPassageEntry[],
  presetElevators: PresetElevatorEntry[],
  lockKind: NodeLockKind | undefined,
): string[] {
  const lines: string[] = [];
  if (presetStart && presetEndpointsEqual(presetStart, endpoint)) lines.push("Start");
  if (presetFinish && presetEndpointsEqual(presetFinish, endpoint)) lines.push("Finish");
  if (presetGenSource && presetEndpointsEqual(presetGenSource, endpoint)) lines.push("Gen source");

  for (const t of presetTeleports) {
    const departingHere = presetEndpointsEqual(t.from, endpoint);
    const arrivingHere = presetEndpointsEqual(t.to, endpoint);
    if (!departingHere && !arrivingHere) continue;
    const other = departingHere ? t.to : t.from;
    const target = formatTarget(other, activeFloorLevel);
    const isForward = departingHere === (t.direction !== "backward");
    const arrow = t.direction === "two_way" ? "<->" : isForward ? "->" : "<-";
    lines.push(`Teleport ${arrow} ${target}`);
  }

  for (const v of presetVerticalPassages) {
    const departingHere = presetEndpointsEqual(v.from, endpoint);
    const arrivingHere = presetEndpointsEqual(v.to, endpoint);
    if (!departingHere && !arrivingHere) continue;
    const other = departingHere ? v.to : v.from;
    const target = `(${formatFloor(other.level ?? 0)})`;
    const isForward = departingHere === (v.direction !== "backward");
    const arrow = v.direction === "two_way" ? "<->" : isForward ? "->" : "<-";
    lines.push(`Vertical passage ${arrow} ${target}`);
  }

  const elevatorTargetLevels: number[] = [];
  for (const e of presetElevators) {
    if (!e.floors.some((f) => presetEndpointsEqual(f, endpoint))) continue;
    for (const f of e.floors) {
      if (presetEndpointsEqual(f, endpoint)) continue;
      elevatorTargetLevels.push(f.level ?? 0);
    }
  }
  if (elevatorTargetLevels.length > 0) {
    const sorted = [...new Set(elevatorTargetLevels)].sort((a, b) => a - b);
    lines.push(`Elevator (${sorted.map(formatFloor).join(", ")})`);
  }

  if (lockKind) lines.push(`Lock (${lockKind})`);

  return lines;
}

function pointKey(point: [number, number], level: number | undefined): string {
  return level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
}

/** Builds the cell-inspector status-bar line for the Preset Connections card (GitHub issue #353) —
 *  the pre-generation counterpart of `buildCellInspection`. Presets have no `NodeDto`/`EdgeDto`
 *  graph yet, so every input here is preset-stage state instead: `presetSplitPoints` (to enumerate
 *  a split point's declared nodes, via `allNodesAt`), the marker/teleport/vertical/elevator
 *  collections, and the merged lock maps. Format matches `buildCellInspection` exactly (same
 *  `" | "`/`"; "`/`[Node N: ...]"` conventions) — `N` is 1-based by ascending `slotId`, original
 *  node first (`allNodesAt`'s own order), the preset-stage analogue of `NodeDto.i + 1`.
 *
 *  When a split point's face configuration matches a recognized special-split topology (bridge,
 *  GitHub issue #487), the node block is titled with the semantic name (`"[Corridor: ...]"`)
 *  instead of `"[Node N: ...]"` — that recognition needs `cfg`, `inFieldCells` and
 *  `presetConnections`; omit them (all default `null`/empty) to always use "Node N". */
export function buildPresetCellInspection(
  x: number,
  y: number,
  floorLevel: number,
  presetSplitPoints: Record<string, number[]>,
  presetStart: PresetEndpoint | null,
  presetFinish: PresetEndpoint | null,
  presetGenSource: PresetEndpoint | null,
  presetTeleports: PresetTeleportEntry[],
  presetVerticalPassages: PresetVerticalPassageEntry[],
  presetElevators: PresetElevatorEntry[],
  lockedNodes: Map<string, NodeLockKind>,
  autoLockedNodes: Set<string>,
  cfg: TessellationConfig | null = null,
  inFieldCells: Set<string> = new Set(),
  presetConnections: Map<string, PresetConnectionEntry> = new Map(),
): string {
  const coordLabel = `x:${x}, y:${y}`;
  const level = floorLevel === 0 ? undefined : floorLevel;
  const point: [number, number] = [x, y];

  const nodesHere = allNodesAt(point, presetSplitPoints, level);

  if (nodesHere.length === 1) {
    const lockKey = pointKey(point, level);
    const lockKind = lockedNodes.get(lockKey) ?? (autoLockedNodes.has(lockKey) ? "both" : undefined);
    const lines = buildPresetNodeMarkerLines(
      nodesHere[0], floorLevel, presetStart, presetFinish, presetGenSource,
      presetTeleports, presetVerticalPassages, presetElevators, lockKind,
    );
    return lines.length === 0 ? coordLabel : [coordLabel, ...lines].join(" | ");
  }

  const lockKey = pointKey(point, level);
  const lockKind = lockedNodes.get(lockKey) ?? (autoLockedNodes.has(lockKey) ? "both" : undefined);

  // Semantic per-node names when this split point's face configuration matches a recognized
  // special-split topology (bridge, GitHub issue #487) — `null` otherwise, "Node N" for every node.
  let semanticNames: ReturnType<typeof splitNodeSemanticNamesFromKinds> = null;
  if (cfg) {
    const faceKindsByNode = nodesHere.map((endpoint) => presetSplitNodeFaceKinds(
      endpoint, point, cfg, inFieldCells, presetConnections, presetSplitPoints, {}, level,
    ));
    semanticNames = splitNodeSemanticNamesFromKinds(faceKindsByNode);
  }

  const blocks = nodesHere.map((endpoint, i) => {
    // Lock addresses only the point's original node (Specs/preset-connections.md's "Split nodes"
    // section: "locks always address the original node only") — reported solely on that node's
    // own block so a locked split point doesn't misleadingly show the same lock on every slot.
    const lines = buildPresetNodeMarkerLines(
      endpoint, floorLevel, presetStart, presetFinish, presetGenSource,
      presetTeleports, presetVerticalPassages, presetElevators, endpoint.slotId === undefined ? lockKind : undefined,
    );
    const body = lines.length === 0 ? "empty" : lines.join("; ");
    return `[${semanticNames?.[i]?.full ?? `Node ${i + 1}`}: ${body}]`;
  });
  return [coordLabel, ...blocks].join(" | ");
}
