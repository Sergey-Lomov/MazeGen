import type { NodeDto, EdgeDto } from "../../wasm/types";
import type { FieldConfig } from "../../fieldConfig";
import type { VectorByWallsSettings } from "../../store/storeTypes";
import {
  buildTeleportEdges,
  selectNodeLevelResolver,
  selectVerticalPassagePairSet,
  buildVerticalConnectionMarkers,
  selectFloorScopedMaze,
} from "./mazeSelectors";
import type { TeleportFloorContext } from "./mazeSelectors";
import type { TeleportEdge } from "../renderers/types";
import { nearestCellCoord } from "../tessellationGeometry";
import { textOverflows, type TextFitItem } from "../textFit";
import { formatIndexLabel } from "../renderers/indexLabel";
import { floorLabelText } from "../renderers/FloorLabelRenderer";
import { buildMarkerIndexLabels } from "./mazeSelectors/markerIndex";
import { DEFAULT_MARKER_TEXT_SIZE, DEFAULT_TEXT_MARGIN } from "../renderConstants";
import type { ExportWarning, ExportWarningId, WarningFloor } from "./exportWarnings";
import type { TeleportGroup } from "./teleportGroups";
import { getProjectTeleportGroups } from "./projectTeleportGroups";

/** Which size control a text label belongs to — one per independent font-size field (GitHub issue
 *  #707). Auto-fit resolves a size per kind; the overflow warnings group start/finish together. */
export type TextFitKind = "start" | "finish" | "elevator" | "teleport" | "markerIndex" | "floorLabel";

export type TextFitSettings = Pick<VectorByWallsSettings, "startMarker" | "finishMarker" | "elevatorBadges" | "teleportFloorBadge" | "teleportConnectorStyle" | "markerIndex" | "floorLabel" | "teleportMergeMode" | "teleportAvoidFieldExit">;

export type TextFitEntry = TextFitItem & {
  kind: TextFitKind;
  /** Font size currently configured for the owning field (px). */
  fontSize: number;
  nodes: number[];
  cells?: { x: number; y: number; floorIndex: number }[];
  crossFloorTargets?: { nodeId: number; targetFloorIndex: number }[];
};

/** Every label drawn on one floor, with the plate it must fit and the elements to highlight when it
 *  does not. Mirrors the renderers' own draw rules: start/finish text honors `textEnabled`, elevator
 *  badges `enabled`, teleport floor badges need a visible connector (`teleportConnectorStyle`). */
export function collectTextFitEntries(
  nodeById: Map<number, NodeDto>,
  edges: EdgeDto[],
  cfg: FieldConfig,
  teleportEdges: TeleportEdge[],
  settings: TextFitSettings,
  start: number | null,
  finish: number | null,
  resolveNodeLevel: ReturnType<typeof selectNodeLevelResolver>,
  displayFloorIndex: number,
  unscoped: { nodes: NodeDto[]; edges: EdgeDto[] },
  displayFloorTitle?: string,
  teleportGroups: TeleportGroup[] = [],
): TextFitEntry[] {
  const entries: TextFitEntry[] = [];
  const addMarker = (kind: "start" | "finish", id: number | null, marker: TextFitSettings["startMarker"]) => {
    if (id === null || !marker.text || marker.textEnabled === false) return;
    entries.push({
      kind, text: marker.text, fontWeight: marker.textFontWeight ?? "bold", shape: marker.shape, plateSize: marker.size,
      fontSize: marker.textSize ?? DEFAULT_MARKER_TEXT_SIZE, margin: marker.textMargin ?? DEFAULT_TEXT_MARGIN, nodes: [id],
    });
  };
  addMarker("start", start, settings.startMarker);
  addMarker("finish", finish, settings.finishMarker);

  const badges = settings.elevatorBadges;
  if (badges.enabled) {
    const verticalPairs = selectVerticalPassagePairSet(edges);
    const markers = buildVerticalConnectionMarkers(nodeById, edges, cfg, resolveNodeLevel, 0, verticalPairs, edges);
    for (const marker of markers) {
      if (marker.kind !== "elevator" || !marker.targetFloorIndices) continue;
      for (const [i, floorIndex] of marker.targetFloorIndices.entries()) {
        entries.push({
          kind: "elevator", text: formatIndexLabel(floorIndex, badges.labelType), fontWeight: badges.textFontWeight,
          shape: badges.shape, plateSize: badges.size, fontSize: badges.textSize, margin: badges.textMargin, nodes: [marker.fromNode],
          crossFloorTargets: [{ nodeId: marker.fromNode, targetFloorIndex: marker.targetFloorIndices[i] }],
        });
      }
    }
  }

  if (settings.teleportConnectorStyle !== "none") {
    const badge = settings.teleportFloorBadge;
    const addTeleport = (point: [number, number], floorIndex: number) => {
      const [x, y] = nearestCellCoord(point[0], point[1], cfg);
      entries.push({
        kind: "teleport", text: formatIndexLabel(floorIndex, badge.labelType), fontWeight: badge.textFontWeight,
        shape: badge.shape, plateSize: badge.size, fontSize: badge.textSize, margin: badge.textMargin, nodes: [], cells: [{ x, y, floorIndex: displayFloorIndex }],
      });
    };
    for (const edge of teleportEdges) {
      if (edge.toFloor !== undefined) addTeleport(edge.to, edge.toFloor);
      if (edge.fromFloor !== undefined) addTeleport(edge.from, edge.fromFloor);
    }
  }

  // Marker-index plates (GitHub issue #725): fixed-size rectangles, labels of the displayed floor.
  const index = settings.markerIndex;
  if (index.enabled) {
    const { labels } = buildMarkerIndexLabels(unscoped.nodes, unscoped.edges, cfg, displayFloorIndex, index, NO_ENDPOINT_VISUAL, undefined, teleportGroups);
    for (const label of labels) {
      const [x, y] = nearestCellCoord(label.pos[0], label.pos[1], cfg);
      entries.push({
        kind: "markerIndex", text: label.label, fontWeight: index.textFontWeight, shape: "circle", plateSize: 0,
        plateWidth: index.width, plateHeight: index.height, fontSize: index.textSize, margin: index.textMargin, nodes: [], cells: [{ x, y, floorIndex: displayFloorIndex }],
      });
    }
  }

  // The floor label is a fixed rectangular/parallelogram plate centered on every floor. Its
  // parallelogram geometry is passed through to text-fit checks so slanted edges are respected.
  const floorLabel = settings.floorLabel;
  if (floorLabel.enabled && floorLabel.backgroundShape !== "none") {
    entries.push({
      kind: "floorLabel",
      text: floorLabelText(floorLabel, displayFloorIndex, displayFloorTitle),
      fontWeight: floorLabel.textFontWeight,
      shape: "square",
      plateSize: 0,
      plateWidth: floorLabel.width,
      plateHeight: floorLabel.height,
      plateShape: floorLabel.backgroundShape,
      fontSize: floorLabel.textSize,
      margin: floorLabel.textMargin,
      nodes: [],
    });
  }
  return entries;
}

/** Endpoint visual stand-in: the text-fit passes need the index strings and cells, not plate colors. */
const NO_ENDPOINT_VISUAL = () => ({ outerRadius: 0, fillRadius: 0, sizeAdaptation: 0, borderWidth: 0, borderMatchColor: 0 });

const TEXT_OVERFLOW_WARNING_ID: Record<TextFitKind, ExportWarningId> = {
  start: "marker_text_overflow",
  finish: "marker_text_overflow",
  elevator: "elevator_badge_text_overflow",
  teleport: "teleport_badge_text_overflow",
  markerIndex: "marker_index_text_overflow",
  floorLabel: "floor_label_text_overflow",
};

export function pushTextOverflowWarnings(warnings: ExportWarning[], entries: readonly TextFitEntry[]): void {
  const byId = new Map<ExportWarningId, ExportWarning>();
  for (const entry of entries) {
    if (!textOverflows(entry, entry.fontSize)) continue;
    const id = TEXT_OVERFLOW_WARNING_ID[entry.kind];
    let warning = byId.get(id);
    if (!warning) {
      warning = { id, key: id, nodes: [], edges: [] };
      byId.set(id, warning);
      warnings.push(warning);
    }
    warning.nodes.push(...entry.nodes);
    if (entry.cells) warning.cells = [...(warning.cells ?? []), ...entry.cells];
    if (entry.crossFloorTargets) warning.crossFloorTargets = [...(warning.crossFloorTargets ?? []), ...entry.crossFloorTargets];
  }
}

/** Every label across all floors, grouped by size control — the input of the "Auto-fit" buttons
 *  (GitHub issue #707). Empty array for a kind with nothing to fit. */
export function computeTextFitItemsAcrossFloors(
  nodes: NodeDto[], edges: EdgeDto[], floors: WarningFloor[], cfg: FieldConfig,
  settings: TextFitSettings, start: number | null, finish: number | null,
): Record<TextFitKind, TextFitItem[]> {
  const result: Record<TextFitKind, TextFitItem[]> = { start: [], finish: [], elevator: [], teleport: [], markerIndex: [], floorLabel: [] };
  const resolveNodeLevel = selectNodeLevelResolver(nodes);
  const teleportGroups = settings.markerIndex.enabled
    ? getProjectTeleportGroups({ nodes, edges, cfg, floors, avoidFieldExit: settings.teleportAvoidFieldExit, start, finish, mergeTeleports: settings.teleportMergeMode })
    : [];
  for (const [index, floor] of floors.entries()) {
    const scoped = selectFloorScopedMaze(nodes, edges, floors, floor.id, start, finish);
    const floorContext: TeleportFloorContext = {
      resolveNodeLevel,
      unscopedNodeById: new Map(nodes.map((node) => [node.id, node])),
      unscopedEdges: edges,
      activeFloorIndex: index,
      floorCount: floors.length,
    };
    const nodeById = new Map(scoped.nodes.map((node) => [node.id, node]));
    const teleportEdges = buildTeleportEdges(nodeById, scoped.edges, cfg, floorContext);
    for (const entry of collectTextFitEntries(nodeById, scoped.edges, cfg, teleportEdges, settings, scoped.start, scoped.finish, resolveNodeLevel, index, { nodes, edges }, floor.title, teleportGroups)) {
      result[entry.kind].push({
        text: entry.text, fontWeight: entry.fontWeight, shape: entry.shape, plateSize: entry.plateSize,
        plateWidth: entry.plateWidth, plateHeight: entry.plateHeight, plateShape: entry.plateShape, margin: entry.margin,
      });
    }
  }
  return result;
}
