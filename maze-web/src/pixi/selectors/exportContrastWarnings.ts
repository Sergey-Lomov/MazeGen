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
import { isMarkerDrawn } from "./mazeSelectors/markers";
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

export type SplitContrastData = {
  colors: (VisibleColor | null)[]; keys: string[]; nodes: number[]; nodesByColor: number[][];
};

export function splitContrastData(
  nodes: NodeDto[],
  edges: EdgeDto[],
  cfg: FieldConfig,
  ctx: ColorVisibilityContext,
  /// Whether a share mirrored onto a seam partner (`SplitPassage.mirrored`) highlights the partner's
  /// node. Off when a cut line separates the two sides in the exported image.
  highlightSeamMirrors: boolean,
): SplitContrastData {
  if (maxSplitNodeCount(nodes) === 0) return { colors: [], keys: [], nodes: [], nodesByColor: [] };
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const effectiveColors = buildEffectiveSplitNodeColors(ctx.settings.splitNodeColors, maxSplitNodeCount(nodes));
  const { passages, specialShapes } = buildSplitPassages(nodes, edges, cfg, new Set(), {}, {}, effectiveColors);
  // Points drawn as a special shape (bridge/diagonal) do not use the slot line colors. With the
  // special shapes toggle off they draw as plain splits and are checked like any other.
  const specialPointKeys = ctx.settings.splitSpecialShapes
    ? new Set(specialShapes.map((shape) => shape.pointKey))
    : new Set<string>();
  const colors: (VisibleColor | null)[] = [];
  const keys: string[] = [];
  // Nodes to highlight per color, parallel to `colors`: a node is flagged for a color only when
  // one of that color's own shares lands on it.
  const nodesByColor: Set<number>[] = [];
  const indexByKey = new Map<string, number>();
  const nodeIdsByPoint = new Map<string, number[]>();
  for (const node of nodeById.values()) {
    const pointKey = `${node.x},${node.y}`;
    const list = nodeIdsByPoint.get(pointKey);
    if (list) list.push(node.id); else nodeIdsByPoint.set(pointKey, [node.id]);
  }
  for (const passage of passages) {
    if (specialPointKeys.has(passage.pointKey) || (ctx.settings.splitSpecialShapes && passage.mirroredFromSpecial)) continue;
    const key = passage.nodeIndex === undefined ? `color:${passage.color}` : `slot:${passage.nodeIndex}`;
    let index = indexByKey.get(key);
    if (index === undefined) {
      index = colors.length;
      indexByKey.set(key, index);
      // A slot's color is edited in that slot's own split-node field; a passage with no slot has
      // no owning field.
      colors.push(passage.nodeIndex === undefined ? unownedColor(passage.color) : visibleColor(ctx, splitNodeKey(passage.nodeIndex)));
      keys.push(key);
      nodesByColor.push(new Set());
    }
    if (passage.mirrored && !highlightSeamMirrors) continue;
    for (const id of nodeIdsByPoint.get(passage.pointKey) ?? []) nodesByColor[index].add(id);
  }
  const all = new Set<number>();
  for (const set of nodesByColor) for (const id of set) all.add(id);
  return { colors, keys, nodes: Array.from(all), nodesByColor: nodesByColor.map((set) => Array.from(set)) };
}

/** One entry per split color against `background`, each flagging only the nodes that use it. */
export function splitColorEntries(split: SplitContrastData, background: VisibleColor | null): ContrastEntry[] {
  return split.colors.map((foreground, i) => ({ foreground, background, nodes: split.nodesByColor[i] }));
}

export function pushSplitPairwiseWarning(
  warnings: ExportWarning[],
  split: SplitContrastData,
): void {
  const { colors, keys, nodesByColor } = split;
  // This is one visual problem — split colors are not distinguishable from each other — even
  // when several slot pairs happen to trip the same contrast check. Keep one warning for the
  // whole split palette (key = id, so floors merge into it); the first offending pair feeds the
  // detailed color description, every offending slot field is attached so each slot's picker
  // shows it.
  let first: { colorValues: [number, number]; colorFields?: [ColorFieldKey, ColorFieldKey] } | undefined;
  const fields = new Set<ColorFieldKey>();
  const nodes = new Set<number>();
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) {
      const [first_, second_] = [colors[i], colors[j]];
      if (!first_ || !second_ || keys[i] === keys[j] || !hasLowContrast(first_.value, second_.value)) continue;
      const [a, b] = [first_.field, second_.field];
      if (a) fields.add(a);
      if (b) fields.add(b);
      for (const id of nodesByColor[i]) nodes.add(id);
      for (const id of nodesByColor[j]) nodes.add(id);
      first ??= { colorValues: [first_.value, second_.value], colorFields: a && b ? [a, b] : undefined };
    }
  }
  if (!first) return;
  warnings.push({
    id: "split_colors_low_contrast_each_other",
    key: "split_colors_low_contrast_each_other",
    nodes: Array.from(nodes),
    edges: [],
    colorValues: first.colorValues,
    colorFields: first.colorFields,
    fields: fields.size > 0 ? Array.from(fields) : undefined,
  });
}

/** Settings-free, per-floor inputs of the contrast checks below. The derived fields are computed on first
 *  read, so a check that never asks for one never pays for it. */
export interface ContrastFloorEnv {
  readonly nodes: NodeDto[];
  readonly edges: EdgeDto[];
  readonly teleportEdges: TeleportEdge[];
  readonly allNodesForWarnings: NodeDto[];
  readonly allEdgesForWarnings: EdgeDto[];
  readonly start: number | null;
  readonly finish: number | null;
  readonly displayFloorIndex: number;
  readonly cfg: FieldConfig;
  readonly nodeById: Map<number, NodeDto>;
  readonly warningNodeById: Map<number, NodeDto>;
  readonly vertical: EdgeDto[];
  readonly oneWayVertical: EdgeDto[];
  readonly twoWay: EdgeDto[];
  readonly elevator: EdgeDto[];
  readonly teleport: EdgeDto[];
}

/** Every color below is read through the registry: hidden fields come back `null` and their
 *  entries are dropped by `pushContrastWarningEntries` (GitHub issue #717). `base` is the floor /
 *  corridor surface color; `surface` names which. */
function colorReader(ctx: ColorVisibilityContext) {
  const surface = ctx.mode === "walls" ? "floor" : "corridor";
  const color = (key: ColorFieldKey) => visibleColor(ctx, key);
  return { surface, color, base: color(surface === "floor" ? "tilesFloor" : "corridorFill") } as const;
}

type ContrastCheck = (warnings: ExportWarning[], env: ContrastFloorEnv, ctx: ColorVisibilityContext) => void;

export const pushGridContrastWarnings: ContrastCheck = (warnings, _env, ctx) => {
  const { color } = colorReader(ctx);
  pushContrastWarning(warnings, "grid_low_contrast_background", [[color("bgGrid"), color("bgFill")]]);
};

export const pushInnerGridContrastWarnings: ContrastCheck = (warnings, _env, ctx) => {
  const { color, base } = colorReader(ctx);
  pushContrastWarning(warnings, "inner_grid_low_contrast_floor", [[color("innerGrid"), base]]);
  pushContrastWarning(warnings, "inner_grid_low_contrast_wall", [[color("innerGrid"), color("tilesWall")]]);
};

export const pushGlueTabContrastWarnings: ContrastCheck = (warnings, _env, ctx) => {
  const { color } = colorReader(ctx);
  pushContrastWarning(warnings, "glue_tab_outline_low_contrast_fill", [[color("glueTabLine"), color("glueTabFill")]]);
  // Without an outline the fill alone sets the tab apart from the background.
  if (ctx.settings.glueTabs.lineWidth === 0) pushContrastWarning(warnings, "glue_tab_fill_low_contrast_background", [[color("glueTabFill"), color("bgFill")]]);
};

export const pushFloorLabelContrastWarnings: ContrastCheck = (warnings, _env, ctx) => {
  const { color, base, surface } = colorReader(ctx);
  pushContrastWarning(warnings, surface === "floor" ? "floor_label_fill_low_contrast_floor" : "floor_label_fill_low_contrast_corridor", [[color("floorLabelFill"), base]]);
  pushContrastWarning(warnings, surface === "floor" ? "floor_label_border_low_contrast_floor" : "floor_label_border_low_contrast_corridor", [[color("floorLabelBorder"), base]]);
  pushContrastWarning(warnings, "floor_label_text_low_contrast", [[color("floorLabelText"), color("floorLabelFill") ?? base]]);
};

/** `marker_fill_low_contrast_*` / `marker_border_low_contrast_*`: every marker against the surface (a marker with a border is checked by its border, one without by its fill). */
export const pushMarkerSurfaceContrastWarnings: ContrastCheck = (warnings, env, ctx) => {
  const settings = ctx.settings;
  const { color, base, surface } = colorReader(ctx);
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
  const { start, finish, nodeById, teleportEdges } = env;
  if (start !== null && nodeById.has(start)) addMarker(settings.startMarker.borderWidth, [start], "startFill", "startBorder");
  if (finish !== null && nodeById.has(finish)) addMarker(settings.finishMarker.borderWidth, [finish], "finishFill", "finishBorder");
  if (env.teleport.length > 0) {
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
  for (const edge of env.vertical) {
    if (!env.oneWayVertical.includes(edge)) addMarker(settings.twoWayPassageMarker.borderWidth, [edge.from, edge.to], "twoWayFill", "twoWayBorder");
  }
  for (const edge of env.oneWayVertical) {
    addMarker(settings.oneWayPassageMarker.borderWidth, [edge.from, edge.to], "oneWayFill", "oneWayBorder");
  }
  for (const edge of env.elevator) addMarker(settings.elevatorMarker.borderWidth, [edge.from, edge.to], "elevatorFill", "elevatorBorder");
  pushContrastWarningEntries(warnings, surface === "floor" ? "marker_fill_low_contrast_floor" : "marker_fill_low_contrast_corridor", fillEntries);
  pushContrastWarningEntries(warnings, surface === "floor" ? "marker_border_low_contrast_floor" : "marker_border_low_contrast_corridor", borderEntries);
};

/** `teleport_badge_text_low_contrast`: the floor badge's text against its fill, when some teleport crosses floors. */
export const pushTeleportBadgeTextContrastWarnings: ContrastCheck = (warnings, env, ctx) => {
  const { color } = colorReader(ctx);
  const crossFloorTeleportEdges = env.teleport.filter((edge) => (env.warningNodeById.get(edge.from)?.level ?? 0) !== (env.warningNodeById.get(edge.to)?.level ?? 0));
  if (crossFloorTeleportEdges.length === 0) return;
  pushContrastWarningEntries(warnings, "teleport_badge_text_low_contrast", [{
    foreground: color("teleportBadgeText"),
    background: color("teleportBadgeFill"),
    cells: teleportBadgeCells(env.teleportEdges, env.displayFloorIndex, env.cfg),
  }]);
};

/** `label_low_contrast`: every text label (elevator badge, start, finish, marker index) against its plate. */
export const pushLabelContrastWarnings: ContrastCheck = (warnings, env, ctx) => {
  const settings = ctx.settings;
  const { color, base } = colorReader(ctx);
  const { start, finish, nodeById, warningNodeById } = env;
  // A caption of a hidden marker (GitHub issue #963) sits on the surface itself, not on the marker fill.
  const plate = (marker: Parameters<typeof isMarkerDrawn>[0], fill: ColorFieldKey) => (isMarkerDrawn(marker) ? color(fill) : base);
  const labelEntries: ContrastEntry[] = [];
  if (env.elevator.length > 0) {
    labelEntries.push({ foreground: color("elevatorBadgeText"), background: color("elevatorBadgeFill"), nodes: env.elevator.flatMap((edge) => [edge.from, edge.to]) });
  }
  if (start !== null && nodeById.has(start)) {
    labelEntries.push({ foreground: color("startText"), background: plate(settings.startMarker, "startFill"), nodes: [start] });
  }
  if (finish !== null && nodeById.has(finish)) {
    labelEntries.push({ foreground: color("finishText"), background: plate(settings.finishMarker, "finishFill"), nodes: [finish] });
  }
  const indexedEdges = env.edges.filter((edge) => {
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
};

/** Abstract-style arrows against their marker fill (their fields are hidden under the decorative style). */
export const pushVerticalArrowContrastWarnings: ContrastCheck = (warnings, env, ctx) => {
  const { color } = colorReader(ctx);
  /** A per-kind entry: present only when the maze has that kind on this floor. */
  const verticalEntry = (
    kindEdges: EdgeDto[],
    foreground: ColorFieldKey,
    background: ColorFieldKey,
  ): ContrastEntry[] => kindEdges.length > 0
    ? [{ foreground: color(foreground), background: color(background), nodes: edgeNodeIds(kindEdges, env.warningNodeById), edges: edgePairs(kindEdges) }]
    : [];
  pushContrastWarningEntries(warnings, "vertical_arrow_low_contrast", verticalEntry(env.twoWay, "twoWayArrow", "twoWayFill"));
  pushContrastWarningEntries(warnings, "vertical_one_way_arrow_low_contrast_fill", verticalEntry(env.oneWayVertical, "oneWayArrow", "oneWayFill"));
  pushContrastWarningEntries(warnings, "elevator_arrow_low_contrast", verticalEntry(env.elevator, "elevatorArrow", "elevatorFill"));
};

export const pushWallContrastWarnings: ContrastCheck = (warnings, _env, ctx) => {
  const { color } = colorReader(ctx);
  pushContrastWarning(warnings, "wall_low_contrast_floor", [[color("tilesWall"), color("tilesFloor")]]);
};

/** Decorative-style lines/arrows over the floor (Vector by walls only; hidden otherwise). */
export const pushVerticalDecorContrastWarnings: ContrastCheck = (warnings, env, ctx) => {
  const { color, base } = colorReader(ctx);
  const decor = (kindEdges: EdgeDto[], foreground: ColorFieldKey) => kindEdges.length > 0
    ? [{ foreground: color(foreground), background: base, nodes: edgeNodeIds(kindEdges, env.warningNodeById), edges: edgePairs(kindEdges) }]
    : [];
  pushContrastWarningEntries(warnings, "vertical_two_way_line_low_contrast_floor", decor(env.twoWay, "decorLineTwoWay"));
  pushContrastWarningEntries(warnings, "vertical_two_way_arrow_low_contrast_floor", decor(env.twoWay, "decorArrowTwoWay"));
  pushContrastWarningEntries(warnings, "vertical_one_way_line_low_contrast_floor", decor(env.oneWayVertical, "decorLineOneWay"));
  pushContrastWarningEntries(warnings, "vertical_one_way_accent_low_contrast_floor", decor(env.oneWayVertical, "decorArrowOneWay"));
  pushContrastWarningEntries(warnings, "elevator_line_low_contrast_floor", decor(env.elevator, "decorLineElevator"));
};

export const pushElevatorBadgeFillContrastWarnings: ContrastCheck = (warnings, env, ctx) => {
  if (env.elevator.length === 0) return;
  const { color, base, surface } = colorReader(ctx);
  pushContrastWarning(
    warnings,
    surface === "floor" ? "elevator_badge_fill_low_contrast_floor" : "elevator_badge_fill_low_contrast_corridor",
    [[color("elevatorBadgeFill"), base]], edgeNodeIds(env.elevator, env.warningNodeById), edgePairs(env.elevator),
  );
};

/** `teleport_badge_border_*` / `teleport_badge_fill_*`: the floor badge against the surface, by its border when it has one. */
export const pushTeleportBadgeSurfaceContrastWarnings: ContrastCheck = (warnings, env, ctx) => {
  const { base, surface } = colorReader(ctx);
  const { warningNodeById, teleportEdges } = env;
  const crossFloorTeleports = teleportEdges.filter((edge) => (warningNodeById.get(edge.fromNode ?? -1)?.level ?? 0) !== (warningNodeById.get(edge.toNode ?? -1)?.level ?? 0));
  if (crossFloorTeleports.length === 0) return;
  // Group overrides replace the badge border as well as the connector border. Without group
  // customization the badge has its own dedicated border color.
  const badgeHasBorder = ctx.settings.teleportFloorBadge.borderWidth > 0;
  const borderId = surface === "floor" ? "teleport_badge_border_low_contrast_floor" : "teleport_badge_border_low_contrast_corridor";
  const fillId = surface === "floor" ? "teleport_badge_fill_low_contrast_floor" : "teleport_badge_fill_low_contrast_corridor";
  pushContrastWarningEntries(
    warnings,
    badgeHasBorder ? borderId : fillId,
    teleportBadgeColorEntries(teleportEdges, ctx, base, env.displayFloorIndex, env.cfg, badgeHasBorder ? "border" : "fill"),
  );
};

/** Every contrast check shared by both vector modes, in emission order, with the warning ids each may emit: the cached warning
 *  groups run them one by one (GitHub issue #928). */
export const COMMON_CONTRAST_CHECKS: readonly { name: string; ids: readonly ExportWarningId[]; check: ContrastCheck }[] = [
  { name: "grid", ids: ["grid_low_contrast_background"], check: pushGridContrastWarnings },
  { name: "innerGrid", ids: ["inner_grid_low_contrast_floor", "inner_grid_low_contrast_wall"], check: pushInnerGridContrastWarnings },
  { name: "glueTab", ids: ["glue_tab_outline_low_contrast_fill", "glue_tab_fill_low_contrast_background"], check: pushGlueTabContrastWarnings },
  {
    name: "floorLabel",
    ids: [
      "floor_label_fill_low_contrast_floor", "floor_label_fill_low_contrast_corridor", "floor_label_border_low_contrast_floor",
      "floor_label_border_low_contrast_corridor", "floor_label_text_low_contrast",
    ],
    check: pushFloorLabelContrastWarnings,
  },
  {
    name: "markerSurface",
    ids: ["marker_fill_low_contrast_floor", "marker_fill_low_contrast_corridor", "marker_border_low_contrast_floor", "marker_border_low_contrast_corridor"],
    check: pushMarkerSurfaceContrastWarnings,
  },
  { name: "teleportBadgeText", ids: ["teleport_badge_text_low_contrast"], check: pushTeleportBadgeTextContrastWarnings },
  { name: "label", ids: ["label_low_contrast"], check: pushLabelContrastWarnings },
  {
    name: "verticalArrow",
    ids: ["vertical_arrow_low_contrast", "vertical_one_way_arrow_low_contrast_fill", "elevator_arrow_low_contrast"],
    check: pushVerticalArrowContrastWarnings,
  },
  { name: "wall", ids: ["wall_low_contrast_floor"], check: pushWallContrastWarnings },
  {
    name: "verticalDecor",
    ids: [
      "vertical_two_way_line_low_contrast_floor", "vertical_two_way_arrow_low_contrast_floor", "vertical_one_way_line_low_contrast_floor",
      "vertical_one_way_accent_low_contrast_floor", "elevator_line_low_contrast_floor",
    ],
    check: pushVerticalDecorContrastWarnings,
  },
  { name: "elevatorBadgeFill", ids: ["elevator_badge_fill_low_contrast_floor", "elevator_badge_fill_low_contrast_corridor"], check: pushElevatorBadgeFillContrastWarnings },
  {
    name: "teleportBadgeSurface",
    ids: [
      "teleport_badge_border_low_contrast_floor", "teleport_badge_border_low_contrast_corridor",
      "teleport_badge_fill_low_contrast_floor", "teleport_badge_fill_low_contrast_corridor",
    ],
    check: pushTeleportBadgeSurfaceContrastWarnings,
  },
];

/** Builds the lazy {@link ContrastFloorEnv} of one floor. */
export function buildContrastFloorEnv(input: {
  nodes: NodeDto[]; edges: EdgeDto[]; teleportEdges: TeleportEdge[]; allNodesForWarnings: NodeDto[]; allEdgesForWarnings: EdgeDto[];
  start: number | null; finish: number | null; displayFloorIndex: number; cfg: FieldConfig;
}): ContrastFloorEnv {
  let nodeById: Map<number, NodeDto> | undefined;
  let warningNodeById: Map<number, NodeDto> | undefined;
  let vertical: EdgeDto[] | undefined;
  let oneWayVertical: EdgeDto[] | undefined;
  let twoWay: EdgeDto[] | undefined;
  let elevator: EdgeDto[] | undefined;
  let teleport: EdgeDto[] | undefined;
  return {
    ...input,
    get nodeById() { return nodeById ??= new Map(input.nodes.map((node) => [node.id, node])); },
    get warningNodeById() { return warningNodeById ??= new Map(input.allNodesForWarnings.map((node) => [node.id, node])); },
    get vertical() { return vertical ??= verticalPassageEdges(input.edges); },
    get oneWayVertical() { return oneWayVertical ??= oneWayVerticalPassageEdges(input.edges, input.allEdgesForWarnings); },
    get twoWay() {
      if (!twoWay) {
        const oneWay = new Set(this.oneWayVertical);
        twoWay = this.vertical.filter((edge) => !oneWay.has(edge));
      }
      return twoWay;
    },
    get elevator() { return elevator ??= input.edges.filter((edge) => edge.kind === "elevator"); },
    get teleport() { return teleport ??= input.edges.filter((edge) => edge.kind === "teleport"); },
  };
}
