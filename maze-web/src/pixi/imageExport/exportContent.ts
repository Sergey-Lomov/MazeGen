import type { FieldConfig } from "../../fieldConfig";
import type { WireTopology } from "../../wasm/types";
import type { CutExportSettings, CutMode } from "../../store/imageExportTypes";
import { exactCellBounds, getCellVertices } from "../tessellationGeometry";
import { selectFloorScopedMaze } from "../selectors/mazeSelectors";
import type { MazeStore } from "../../store/storeTypes";
import { buildCutPlan, cutLineOf, cutSettingOf, resolveGroupCuts, type CutPlan, type GroupCut, type GroupCutAvailability, type Vec2 } from "./cutLines";
import type { ContentBoundsBasis } from "./contentBounds";
import type { ExportMargin } from "./exportMargins";

/// What the export draws and measures for the active floor: the plain maze, or (when a glue has a
/// cut line, GitHub issue #859) the cut sheet. The single place that decides it, so the preview, the
/// fit math, the on-canvas frame and the exporter agree.

export interface CutInputs {
  cfg: FieldConfig;
  floorId: string;
  topology: WireTopology | null | undefined;
  cuts: CutExportSettings;
  floorNodes: { x: number; y: number; id: number }[];
  /// How far the mode's drawn content pokes past the cells; read only when a cut exists.
  margin?: () => ExportMargin;
}

/// The cells' polygons in display space: where the image is, so where a cut line has something to cut.
export function tilePolygons(nodes: { x: number; y: number }[], cfg: FieldConfig): Vec2[][] {
  return nodes.map((node) => getCellVertices(node.x, node.y, cfg).map((vertex): Vec2 => [vertex.x, vertex.y]));
}

export const NO_MARGIN: ExportMargin = { left: 0, right: 0, top: 0, bottom: 0 };

/// Availability of a cut for each glue of the floor (empty without glues).
export function floorGroupCuts(inputs: Pick<CutInputs, "cfg" | "topology">): GroupCutAvailability[] {
  // The canvas overlay asks on every store update; the answer changes only with the field or the topology.
  if (lastGroupCuts?.cfg !== inputs.cfg || lastGroupCuts.topology !== inputs.topology) {
    const cuts = resolveGroupCuts(inputs.cfg, inputs.topology);
    // A glue with no seams may only mean the geometry cache is not warmed yet: ask again next time.
    if (cuts.some((cut) => !cut.ok && cut.reason === "no_seams")) return cuts;
    lastGroupCuts = { cfg: inputs.cfg, topology: inputs.topology, cuts };
  }
  return lastGroupCuts!.cuts;
}

let lastGroupCuts: { cfg: FieldConfig; topology: WireTopology | null | undefined; cuts: GroupCutAvailability[] } | null = null;

export interface CutLineHandle {
  group: number;
  mode: CutMode;
  line: { point: [number, number]; cut: GroupCut };
}

/// Every cut line of the floor that is set, for drawing it on the canvas and dragging the manual ones.
export function floorCutLines(inputs: Pick<CutInputs, "cfg" | "floorId" | "topology" | "cuts">): CutLineHandle[] {
  return floorGroupCuts(inputs).flatMap((cut) => {
    const setting = cutSettingOf(inputs.cuts, inputs.floorId, cut.group);
    const line = cutLineOf(cut, setting);
    return line && setting ? [{ group: cut.group, mode: setting.mode, line }] : [];
  });
}

/// Ids of the floors that have a cut line set, so are exported as a cut sheet.
export function floorIdsWithCut(
  floors: { id: string }[],
  cfg: FieldConfig,
  floorTopology: Record<string, WireTopology | null | undefined>,
  cuts: CutExportSettings,
): Set<string> {
  const ids = new Set<string>();
  for (const floor of floors) {
    const inputs = { cfg, floorId: floor.id, topology: floorTopology[floor.id], cuts };
    if (floorGroupCuts(inputs).some((cut) => cutLineOf(cut, cutSettingOf(cuts, floor.id, cut.group)))) ids.add(floor.id);
  }
  return ids;
}

/// The cut sheet of the floor, or `null` when no glue has a usable cut line.
export function resolveCutPlan(inputs: CutInputs): CutPlan | null {
  if (inputs.floorNodes.length === 0) return null;
  const entries = floorGroupCuts(inputs).flatMap((cut) => {
    const line = cutLineOf(cut, cutSettingOf(inputs.cuts, inputs.floorId, cut.group));
    return line ? [line] : [];
  });
  // Nothing cut: skip the O(cells) bounds pass, this runs on every store update with the panel open.
  if (entries.length === 0) return null;
  return buildCutPlan(exactCellBounds(inputs.floorNodes, inputs.cfg), entries, inputs.margin?.(), tilePolygons(inputs.floorNodes, inputs.cfg));
}

/// The cut sheet of the active floor while the export card is open, or `null` for the plain maze.
export function resolveActiveCutPlan(
  state: Pick<MazeStore, "openCard" | "activeRenderMode" | "nodes" | "floors" | "activeFloorId" | "activeFieldConfig" | "floorTopology" | "pngExportSettings">,
  margin: () => ExportMargin,
): CutPlan | null {
  if (state.openCard !== "image_export" || state.activeRenderMode === null || state.nodes.length === 0) return null;
  return resolveCutPlan({
    cfg: state.activeFieldConfig,
    floorId: state.activeFloorId,
    topology: state.floorTopology[state.activeFloorId],
    cuts: state.pngExportSettings.cuts,
    floorNodes: selectFloorScopedMaze(state.nodes, [], state.floors, state.activeFloorId).nodes,
    margin,
  });
}

/// The margin and bounds basis the fit math uses. A cut sheet is bounded by its region (everything
/// outside is clipped away, so the mode's own margin does not apply); otherwise the mode's own.
export function resolveExportContent(
  plan: CutPlan | null,
  modeMargin: ExportMargin,
  modeBasis: ContentBoundsBasis,
): { margin: ExportMargin; basis: ContentBoundsBasis } {
  return plan ? { margin: NO_MARGIN, basis: { box: plan.bounds } } : { margin: modeMargin, basis: modeBasis };
}
