import { presetEndpointKey, type PresetEndpoint } from "../presetEndpoint";
import {
  allNodesAt, presetSplitNodeFaceKinds,
  type PresetConnectionEntry, type PresetTeleportEntry, type PresetVerticalPassageEntry, type PresetElevatorEntry,
} from "../fieldEditUtils";
import { presetVertexMarkerEntities } from "../pointEntities";
import { splitNodeSemanticNamesFromKinds } from "../splitNodeNames";
import { splitShapeBinding } from "../splitShape";
import type { PresetSplitLabelContext } from "../presetSplitLabels";
import type { NodeLockKind } from "../../wasm/types";
import type { FieldConfig } from "../../fieldConfig";
import * as m from "~/paraglide/messages";

function formatLockKind(kind: NodeLockKind): string {
  switch (kind) {
    case "in": return m["status.cell_lock_in"]();
    case "out": return m["status.cell_lock_out"]();
    case "both": return m["status.cell_lock_both"]();
  }
}

/** Every marker-line contributed by one specific preset-stage node (an original node or a declared
 *  split slot) — start/finish/gen-source markers, preset teleport/vertical-passage/elevator
 *  endpoints, and node locks (manual or auto), all addressed by exact `PresetEndpoint` match
 *  (GitHub issue #353's Preset Connections follow-up). Thin adapter over `presetVertexMarkerEntities`
 *  (`pixi/pointEntities.ts`, GitHub issue #540) — this function only appends the lock line, which
 *  the entity-delete dialog's `point_all` scope reports separately instead. */
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
  splitCtx: PresetSplitLabelContext | null = null,
): string[] {
  const lines = presetVertexMarkerEntities(
    endpoint, activeFloorLevel, presetStart, presetFinish, presetGenSource,
    presetTeleports, presetVerticalPassages, presetElevators, splitCtx,
    true, // status bar: compact floor-only vertical-passage/elevator target (GitHub issue #595 follow-up)
  ).map((e) => e.title);

  if (lockKind) lines.push(m["status.cell_lock"]({ kind: formatLockKind(lockKind) }));

  return lines;
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
  cfg: FieldConfig | null = null,
  inFieldCells: Set<string> = new Set(),
  presetConnections: Map<string, PresetConnectionEntry> = new Map(),
  splitCtx: PresetSplitLabelContext | null = null,
): string {
  const coordLabel = `x:${x}, y:${y}`;
  const level = floorLevel === 0 ? undefined : floorLevel;
  const point: [number, number] = [x, y];

  const nodesHere = allNodesAt(point, presetSplitPoints, level);

  if (nodesHere.length === 1) {
    const lockKind = lockedNodes.get(presetEndpointKey(nodesHere[0])) ?? (autoLockedNodes.has(presetEndpointKey(nodesHere[0])) ? "both" : undefined);
    const lines = buildPresetNodeMarkerLines(
      nodesHere[0], floorLevel, presetStart, presetFinish, presetGenSource,
      presetTeleports, presetVerticalPassages, presetElevators, lockKind, splitCtx,
    );
    return lines.length === 0 ? coordLabel : [coordLabel, ...lines].join(" | ");
  }

  // Semantic per-node names when this split point's face configuration matches a recognized
  // special-split topology (bridge, GitHub issue #487) — `null` otherwise, "Node N" for every node.
  let semanticNames: ReturnType<typeof splitNodeSemanticNamesFromKinds> = null;
  if (cfg) {
    const faceKindsByNode = nodesHere.map((endpoint) => presetSplitNodeFaceKinds(
      endpoint, point, cfg, inFieldCells, presetConnections, presetSplitPoints, {}, level,
    ));
    semanticNames = splitNodeSemanticNamesFromKinds(
      faceKindsByNode, splitShapeBinding(cfg, point[0], point[1]),
    );
  }

  const blocks = nodesHere.map((endpoint, i) => {
    const lines = buildPresetNodeMarkerLines(
      endpoint, floorLevel, presetStart, presetFinish, presetGenSource,
      presetTeleports, presetVerticalPassages, presetElevators,
      lockedNodes.get(presetEndpointKey(endpoint)) ?? (autoLockedNodes.has(presetEndpointKey(endpoint)) ? "both" : undefined),
      splitCtx,
    );
    const body = lines.length === 0 ? m["status.cell_empty"]() : lines.join("; ");
    return `[${semanticNames?.[i]?.full ?? m["status.cell_node"]({ number: i + 1 })}: ${body}]`;
  });
  return [coordLabel, ...blocks].join(" | ");
}
