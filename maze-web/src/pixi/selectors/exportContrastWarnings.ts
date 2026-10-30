import type { NodeDto, EdgeDto } from "../../wasm/types";
import type { FieldConfig } from "../../fieldConfig";
import type { TeleportSettingsFields } from "../../store/storeTypes";
import { buildSplitPassages, maxSplitNodeCount } from "./mazeSelectors";
import { buildTeleportGroups, teleportEdgeKey } from "./teleportGroups";
import type { TeleportEdge } from "../renderers/types";
import { hasLowContrast } from "../colorContrast";
import { buildEffectiveSplitNodeColors } from "../imageExport/exportStyleBuilders";
import { nearestCellCoord } from "../tessellationGeometry";
import { visibleColor, unownedColor, type ColorVisibilityContext, type VisibleColor } from "./colorFieldRegistry";
import { splitNodeKey, teleportGroupKey, type ColorFieldKey, type TeleportGroupColorRole } from "../colorFieldKeys";
import type { ExportWarningId, ExportWarning } from "./exportWarnings";

export type WarningEdge = [number, number];

/** One color pair to check. Both colors come from the registry ({@link VisibleColor}); a `null`
 *  side is a hidden/valueless field and drops the entry — a warning can't concern a color the
 *  panel doesn't show. Entries with different field pairs never share a warning, even when the
 *  color values coincide. */
export type ContrastEntry = {
  foreground: VisibleColor | null;
  background: VisibleColor | null;
  nodes?: Iterable<number>;
  edges?: readonly WarningEdge[];
  cells?: readonly { x: number; y: number; floorIndex: number }[];
};

export function pushContrastWarningEntries(
  warnings: ExportWarning[],
  id: ExportWarningId,
  entries: readonly ContrastEntry[],
): void {
  type Group = {
    nodes: Set<number>; edges: WarningEdge[]; cells: { x: number; y: number; floorIndex: number }[];
    colorValues: [number, number]; foregroundField: ColorFieldKey | null; backgroundField: ColorFieldKey | null;
  };
  const grouped = new Map<string, Group>();
  for (const entry of entries) {
    const { foreground, background } = entry;
    if (!foreground || !background) continue;
    if (!hasLowContrast(foreground.value, background.value)) continue;
    // One warning per (kind, foreground field, background field). A color with no owning field falls
    // back to its value so distinct pairs still stay separate.
    const key = foreground.field && background.field
      ? `${id}:${foreground.field}:${background.field}`
      : `${id}:${foreground.field ?? ""}:${background.field ?? ""}:${foreground.value.toString(16)}:${background.value.toString(16)}`;
    const group = grouped.get(key) ?? {
      nodes: new Set<number>(), edges: [], cells: [], colorValues: [foreground.value, background.value],
      foregroundField: foreground.field, backgroundField: background.field,
    };
    for (const node of entry.nodes ?? []) group.nodes.add(node);
    group.edges.push(...(entry.edges ?? []));
    group.cells.push(...(entry.cells ?? []));
    grouped.set(key, group);
  }
  for (const [key, group] of grouped) {
    const fields = [group.foregroundField, group.backgroundField].filter((f): f is ColorFieldKey => f !== null);
    warnings.push({
      id,
      key,
      nodes: Array.from(group.nodes),
      edges: group.edges,
      cells: group.cells.length > 0 ? group.cells : undefined,
      colorFields: group.foregroundField && group.backgroundField ? [group.foregroundField, group.backgroundField] : undefined,
      fields: fields.length > 0 ? fields : undefined,
      colorValues: group.colorValues,
    });
  }
}

/** `[foreground, background]` — one color pair to check. */
export type ContrastPair = readonly [VisibleColor | null, VisibleColor | null];

export function pushContrastWarning(
  warnings: ExportWarning[],
  id: ExportWarningId,
  pairs: readonly ContrastPair[],
  nodes: Iterable<number> = [],
  edges: readonly WarningEdge[] = [],
): void {
  pushContrastWarningEntries(warnings, id, pairs.map(([foreground, background]) => ({ foreground, background, nodes, edges })));
}

export function edgeNodeIds(edges: EdgeDto[], nodeById: Map<number, NodeDto>): number[] {
  const ids = new Set<number>();
  for (const edge of edges) {
    if (nodeById.has(edge.from)) ids.add(edge.from);
    if (nodeById.has(edge.to)) ids.add(edge.to);
  }
  return Array.from(ids);
}

export function edgePairs(edges: EdgeDto[]): WarningEdge[] {
  return edges.map((edge) => [edge.from, edge.to]);
}

/** The field a teleport group's color is edited in: the group's own override row while it overrides
 *  `role` (named by the override's 1-based order, same as the picker's "Project colors" list), the
 *  shared `fallback` field otherwise. */
export function teleportGroupColorField(
  settings: TeleportSettingsFields,
  groupKey: string,
  role: TeleportGroupColorRole,
  fallback: ColorFieldKey,
): ColorFieldKey {
  const override = settings.teleportGroupOverrides[groupKey];
  if ((role === "fill" ? override?.fillColor : override?.borderColor) === undefined) return fallback;
  const index = Object.keys(settings.teleportGroupOverrides).sort((a, b) => a.localeCompare(b)).indexOf(groupKey);
  return teleportGroupKey(index, role);
}

export function teleportConnectorEntries(
  teleportEdges: TeleportEdge[],
  ctx: ColorVisibilityContext,
  background: VisibleColor | null,
): ContrastEntry[] {
  const settings = ctx.settings;
  const baseNodes = teleportEdges.flatMap((edge) => [edge.fromNode, edge.toNode].filter((id): id is number => id !== undefined));
  if (!settings.teleportGroupCustomization) {
    return [{ foreground: visibleColor(ctx, "teleportConnector"), background, nodes: baseNodes }];
  }
  const groups = buildTeleportGroups(teleportEdges, settings.teleportMergeMode);
  const edgesByKey = new Map(teleportEdges.map((edge) => [teleportEdgeKey(edge), edge]));
  const entries: ContrastEntry[] = [];
  for (const group of groups) {
    const groupEdges = group.edgeKeys.map((key) => edgesByKey.get(key)).filter((edge): edge is TeleportEdge => edge !== undefined);
    entries.push({
      foreground: visibleColor(ctx, teleportGroupColorField(settings, group.key, "border", "teleportConnector")),
      background,
      nodes: groupEdges.flatMap((edge) => [edge.fromNode, edge.toNode].filter((id): id is number => id !== undefined)),
    });
  }
  return entries;
}

export function teleportBadgeColorEntries(
  teleportEdges: TeleportEdge[],
  ctx: ColorVisibilityContext,
  background: VisibleColor | null,
  displayFloorIndex: number,
  cfg: FieldConfig,
  color: "border" | "fill",
): ContrastEntry[] {
  const settings = ctx.settings;
  const defaultField: ColorFieldKey = color === "border" ? "teleportBadgeBorder" : "teleportBadgeFill";
  const crossFloorEdges = teleportEdges.filter((edge) => edge.toFloor !== undefined || edge.fromFloor !== undefined);
  if (!settings.teleportGroupCustomization) {
    return [{ foreground: visibleColor(ctx, defaultField), background, cells: teleportBadgeCells(crossFloorEdges, displayFloorIndex, cfg) }];
  }
  const groups = buildTeleportGroups(teleportEdges, settings.teleportMergeMode);
  const edgesByKey = new Map(teleportEdges.map((edge) => [teleportEdgeKey(edge), edge]));
  return groups.map((group) => {
    const groupEdges = group.edgeKeys.map((key) => edgesByKey.get(key)).filter((edge): edge is TeleportEdge => edge !== undefined && (edge.toFloor !== undefined || edge.fromFloor !== undefined));
    return {
      foreground: visibleColor(ctx, teleportGroupColorField(settings, group.key, "border", defaultField)),
      background,
      cells: teleportBadgeCells(groupEdges, displayFloorIndex, cfg),
    };
  });
}

export function teleportBadgeCells(edges: TeleportEdge[], displayFloorIndex: number, cfg: FieldConfig): { x: number; y: number; floorIndex: number }[] {
  const cells: { x: number; y: number; floorIndex: number }[] = [];
  for (const edge of edges) {
    if (edge.toFloor !== undefined) {
      const [x, y] = nearestCellCoord(edge.to[0], edge.to[1], cfg);
      cells.push({ x, y, floorIndex: displayFloorIndex });
    }
    if (edge.fromFloor !== undefined) {
      const [x, y] = nearestCellCoord(edge.from[0], edge.from[1], cfg);
      cells.push({ x, y, floorIndex: displayFloorIndex });
    }
  }
  return cells;
}

export function verticalPassageEdges(edges: EdgeDto[]): EdgeDto[] {
  return edges.filter((edge) => edge.kind === "vertical_passage");
}

export function oneWayVerticalPassageEdges(edges: EdgeDto[], allEdges: EdgeDto[] = edges): EdgeDto[] {
  const vertical = verticalPassageEdges(edges);
  const pairs = new Set(allEdges.filter((edge) => edge.kind === "vertical_passage").map((edge) => `${edge.from}->${edge.to}`));
  return vertical.filter((edge) => !pairs.has(`${edge.to}->${edge.from}`));
}

export function splitContrastData(
  nodes: NodeDto[],
  edges: EdgeDto[],
  cfg: FieldConfig,
  ctx: ColorVisibilityContext,
  /// Whether a share mirrored onto a seam partner (`SplitPassage.mirrored`) highlights the partner's
  /// node. Off when a cut line separates the two sides in the exported image.
  highlightSeamMirrors: boolean,
): { colors: (VisibleColor | null)[]; keys: string[]; nodes: number[] } {
  if (maxSplitNodeCount(nodes) === 0) return { colors: [], keys: [], nodes: [] };
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const effectiveColors = buildEffectiveSplitNodeColors(ctx.settings.splitNodeColors, maxSplitNodeCount(nodes));
  const { passages } = buildSplitPassages(nodes, edges, cfg, new Set(), {}, {}, effectiveColors);
  const colors: (VisibleColor | null)[] = [];
  const keys: string[] = [];
  const seen = new Set<string>();
  const ids = new Set<number>();
  for (const passage of passages) {
    const key = passage.nodeIndex === undefined ? `color:${passage.color}` : `slot:${passage.nodeIndex}`;
    if (!seen.has(key)) {
      seen.add(key);
      // A slot's color is edited in that slot's own split-node field; a passage with no slot has
      // no owning field.
      colors.push(passage.nodeIndex === undefined ? unownedColor(passage.color) : visibleColor(ctx, splitNodeKey(passage.nodeIndex)));
      keys.push(String(key));
    }
    if (passage.mirrored && !highlightSeamMirrors) continue;
    for (const node of nodeById.values()) {
      if (`${node.x},${node.y}` === passage.pointKey) ids.add(node.id);
    }
  }
  return { colors, keys, nodes: Array.from(ids) };
}

export function pushSplitPairwiseWarning(
  warnings: ExportWarning[],
  split: { colors: readonly (VisibleColor | null)[]; keys: readonly string[]; nodes: readonly number[] },
): void {
  const { colors, keys, nodes } = split;
  // This is one visual problem — split colors are not distinguishable from each other — even
  // when several slot pairs happen to trip the same contrast check. Keep one warning for the
  // whole split palette (key = id, so floors merge into it); the first offending pair feeds the
  // detailed color description, every offending slot field is attached so each slot's picker
  // shows it.
  let first: { colorValues: [number, number]; colorFields?: [ColorFieldKey, ColorFieldKey] } | undefined;
  const fields = new Set<ColorFieldKey>();
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) {
      const [first_, second_] = [colors[i], colors[j]];
      if (!first_ || !second_ || keys[i] === keys[j] || !hasLowContrast(first_.value, second_.value)) continue;
      const [a, b] = [first_.field, second_.field];
      if (a) fields.add(a);
      if (b) fields.add(b);
      first ??= { colorValues: [first_.value, second_.value], colorFields: a && b ? [a, b] : undefined };
    }
  }
  if (!first) return;
  warnings.push({
    id: "split_colors_low_contrast_each_other",
    key: "split_colors_low_contrast_each_other",
    nodes: [...nodes],
    edges: [],
    colorValues: first.colorValues,
    colorFields: first.colorFields,
    fields: fields.size > 0 ? Array.from(fields) : undefined,
  });
}

export function addCommonContrastWarnings(
  warnings: ExportWarning[],
  nodes: NodeDto[],
  edges: EdgeDto[],
  ctx: ColorVisibilityContext,
  teleportEdges: TeleportEdge[],
  allNodesForWarnings: NodeDto[],
  allEdgesForWarnings: EdgeDto[],
  start: number | null,
  finish: number | null,
  displayFloorIndex: number,
  cfg: FieldConfig,
): void {
  const settings = ctx.settings;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const warningNodeById = new Map(allNodesForWarnings.map((node) => [node.id, node]));
  const surfaceKind = ctx.mode === "walls" ? "floor" : "corridor";
  /** Every color below is read through the registry: hidden fields come back `null` and their
   *  entries are dropped by `pushContrastWarningEntries` (GitHub issue #717). */
  const color = (key: ColorFieldKey) => visibleColor(ctx, key);
  /** The floor / corridor surface color. */
  const base = color(surfaceKind === "floor" ? "tilesFloor" : "corridorFill");
  const markerFillWarningId = surfaceKind === "floor" ? "marker_fill_low_contrast_floor" : "marker_fill_low_contrast_corridor";
  const markerBorderWarningId = surfaceKind === "floor" ? "marker_border_low_contrast_floor" : "marker_border_low_contrast_corridor";
  const elevatorBadgeFillWarningId = surfaceKind === "floor" ? "elevator_badge_fill_low_contrast_floor" : "elevator_badge_fill_low_contrast_corridor";
  const teleportBadgeBorderWarningId = surfaceKind === "floor" ? "teleport_badge_border_low_contrast_floor" : "teleport_badge_border_low_contrast_corridor";
  const teleportBadgeFillWarningId = surfaceKind === "floor" ? "teleport_badge_fill_low_contrast_floor" : "teleport_badge_fill_low_contrast_corridor";
  const floorLabelFillWarningId = surfaceKind === "floor" ? "floor_label_fill_low_contrast_floor" : "floor_label_fill_low_contrast_corridor";
  const floorLabelBorderWarningId = surfaceKind === "floor" ? "floor_label_border_low_contrast_floor" : "floor_label_border_low_contrast_corridor";
  const vertical = verticalPassageEdges(edges);
  const oneWayVertical = oneWayVerticalPassageEdges(edges, allEdgesForWarnings);
  const elevator = edges.filter((edge) => edge.kind === "elevator");
  const teleport = edges.filter((edge) => edge.kind === "teleport");
  pushContrastWarning(warnings, "grid_low_contrast_background", [[color("bgGrid"), color("bgFill")]]);
  pushContrastWarning(warnings, "inner_grid_low_contrast_floor", [[color("innerGrid"), base]]);
  pushContrastWarning(warnings, "inner_grid_low_contrast_wall", [[color("innerGrid"), color("tilesWall")]]);
  pushContrastWarning(warnings, floorLabelFillWarningId, [[color("floorLabelFill"), base]]);
  pushContrastWarning(warnings, floorLabelBorderWarningId, [[color("floorLabelBorder"), base]]);
  pushContrastWarning(warnings, "floor_label_text_low_contrast", [[color("floorLabelText"), color("floorLabelFill") ?? base]]);

  const fillEntries: ContrastEntry[] = [];
  const borderEntries: ContrastEntry[] = [];
  const addMarker = (
    borderWidth: number,
    markerNodes: Iterable<number>,
    fill: ColorFieldKey,
    border: ColorFieldKey,
  ) => {
    if (borderWidth === 0) fillEntries.push({ foreground: color(fill), background: base, nodes: markerNodes });
    else borderEntries.push({ foreground: color(border), background: base, nodes: markerNodes });
  };
  if (start !== null && nodeById.has(start)) addMarker(settings.startMarker.borderWidth, [start], "startFill", "startBorder");
  if (finish !== null && nodeById.has(finish)) addMarker(settings.finishMarker.borderWidth, [finish], "finishFill", "finishBorder");
  if (teleport.length > 0) {
    const groups = settings.teleportGroupCustomization ? buildTeleportGroups(teleportEdges, settings.teleportMergeMode) : [];
    const edgesByKey = new Map(teleportEdges.map((edge) => [teleportEdgeKey(edge), edge]));
    const teleportBorderWidth = settings.teleportMarker.borderWidth;
    if (groups.length === 0) {
      addMarker(teleportBorderWidth, teleportEdges.flatMap((edge) => [edge.fromNode, edge.toNode].filter((id): id is number => id !== undefined)), "teleportEdge", "teleportEdgeBorder");
    } else {
      for (const group of groups) {
        const groupNodeIds = group.edgeKeys.flatMap((key) => {
          const edge = edgesByKey.get(key);
          return edge ? [edge.fromNode, edge.toNode].filter((id): id is number => id !== undefined) : [];
        });
        addMarker(
          teleportBorderWidth,
          groupNodeIds,
          teleportGroupColorField(settings, group.key, "fill", "teleportEdge"),
          teleportGroupColorField(settings, group.key, "border", "teleportEdgeBorder"),
        );
      }
    }
  }
  for (const edge of vertical) {
    if (!oneWayVertical.includes(edge)) addMarker(settings.twoWayPassageMarker.borderWidth, [edge.from, edge.to], "twoWayFill", "twoWayBorder");
  }
  for (const edge of oneWayVertical) {
    addMarker(settings.oneWayPassageMarker.borderWidth, [edge.from, edge.to], "oneWayFill", "oneWayBorder");
  }
  for (const edge of elevator) addMarker(settings.elevatorMarker.borderWidth, [edge.from, edge.to], "elevatorFill", "elevatorBorder");
  pushContrastWarningEntries(warnings, markerFillWarningId, fillEntries);
  pushContrastWarningEntries(warnings, markerBorderWarningId, borderEntries);

  const labelEntries: ContrastEntry[] = [];
  const crossFloorTeleportEdges = teleport.filter((edge) => (warningNodeById.get(edge.from)?.level ?? 0) !== (warningNodeById.get(edge.to)?.level ?? 0));
  if (crossFloorTeleportEdges.length > 0) {
    pushContrastWarningEntries(warnings, "teleport_badge_text_low_contrast", [{
      foreground: color("teleportBadgeText"),
      background: color("teleportBadgeFill"),
      cells: teleportBadgeCells(teleportEdges, displayFloorIndex, cfg),
    }]);
  }
  if (elevator.length > 0) {
    labelEntries.push({ foreground: color("elevatorBadgeText"), background: color("elevatorBadgeFill"), nodes: elevator.flatMap((edge) => [edge.from, edge.to]) });
  }
  if (start !== null && nodeById.has(start)) {
    labelEntries.push({ foreground: color("startText"), background: color("startFill"), nodes: [start] });
  }
  if (finish !== null && nodeById.has(finish)) {
    labelEntries.push({ foreground: color("finishText"), background: color("finishFill"), nodes: [finish] });
  }
  const indexedEdges = edges.filter((edge) => {
    if (edge.kind === "elevator") return settings.markerIndex.coverage.elevator;
    if (edge.kind === "vertical_passage") return settings.markerIndex.coverage.verticalPassage;
    if (edge.kind !== "teleport") return false;
    const fromLevel = warningNodeById.get(edge.from)?.level ?? 0;
    const toLevel = warningNodeById.get(edge.to)?.level ?? 0;
    return fromLevel === toLevel ? settings.markerIndex.coverage.singleFloorTeleport : settings.markerIndex.coverage.crossFloorTeleport;
  });
  if (indexedEdges.length > 0) {
    labelEntries.push({ foreground: color("markerIndexText"), background: color("markerIndexFill"), nodes: edgeNodeIds(indexedEdges, warningNodeById), edges: edgePairs(indexedEdges) });
  }
  pushContrastWarningEntries(warnings, "label_low_contrast", labelEntries);

  const twoWay = vertical.filter((edge) => !oneWayVertical.includes(edge));
  /** A per-kind entry: present only when the maze has that kind on this floor. */
  const verticalEntry = (
    kindEdges: EdgeDto[],
    foreground: ColorFieldKey,
    background: ColorFieldKey,
  ): ContrastEntry[] => kindEdges.length > 0
    ? [{ foreground: color(foreground), background: color(background), nodes: edgeNodeIds(kindEdges, warningNodeById), edges: edgePairs(kindEdges) }]
    : [];
  // Abstract-style arrows (their fields are hidden under the decorative style) …
  pushContrastWarningEntries(warnings, "vertical_arrow_low_contrast", verticalEntry(twoWay, "twoWayArrow", "twoWayFill"));
  pushContrastWarningEntries(warnings, "vertical_one_way_arrow_low_contrast_fill", verticalEntry(oneWayVertical, "oneWayArrow", "oneWayFill"));
  pushContrastWarningEntries(warnings, "elevator_arrow_low_contrast", verticalEntry(elevator, "elevatorArrow", "elevatorFill"));
  pushContrastWarning(warnings, "wall_low_contrast_floor", [[color("tilesWall"), color("tilesFloor")]]);
  // … and decorative-style lines/arrows over the floor (Vector by walls only; hidden otherwise).
  const decor = (kindEdges: EdgeDto[], foreground: ColorFieldKey) => kindEdges.length > 0
    ? [{ foreground: color(foreground), background: base, nodes: edgeNodeIds(kindEdges, warningNodeById), edges: edgePairs(kindEdges) }]
    : [];
  pushContrastWarningEntries(warnings, "vertical_two_way_line_low_contrast_floor", decor(twoWay, "decorLineTwoWay"));
  pushContrastWarningEntries(warnings, "vertical_two_way_arrow_low_contrast_floor", decor(twoWay, "decorArrowTwoWay"));
  pushContrastWarningEntries(warnings, "vertical_one_way_line_low_contrast_floor", decor(oneWayVertical, "decorLineOneWay"));
  pushContrastWarningEntries(warnings, "vertical_one_way_accent_low_contrast_floor", decor(oneWayVertical, "decorArrowOneWay"));
  pushContrastWarningEntries(warnings, "elevator_line_low_contrast_floor", decor(elevator, "decorLineElevator"));
  if (elevator.length > 0) {
    pushContrastWarning(warnings, elevatorBadgeFillWarningId, [[color("elevatorBadgeFill"), base]], edgeNodeIds(elevator, warningNodeById), edgePairs(elevator));
  }
  const crossFloorTeleports = teleportEdges.filter((edge) => (warningNodeById.get(edge.fromNode ?? -1)?.level ?? 0) !== (warningNodeById.get(edge.toNode ?? -1)?.level ?? 0));
  if (crossFloorTeleports.length > 0) {
    // Group overrides replace the badge border as well as the connector border. Without group
    // customization the badge has its own dedicated border color.
    const badgeBorderWidth = settings.teleportFloorBadge.borderWidth;
    const badgeHasBorder = badgeBorderWidth > 0;
    pushContrastWarningEntries(
      warnings,
      badgeHasBorder ? teleportBadgeBorderWarningId : teleportBadgeFillWarningId,
      teleportBadgeColorEntries(teleportEdges, ctx, base, displayFloorIndex, cfg, badgeHasBorder ? "border" : "fill"),
    );
  }
}
