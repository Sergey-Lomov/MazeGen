import type { ParamType } from "./parameterLinks";
import type { ParamActivityContext, ParamActivitySettings } from "./parameterLinksActivity";
import { R, always, and, type ActivityRule } from "./parameterLinkRules";
import * as m from "~/paraglide/messages";

/** The one declarative description of every linkable render-mode parameter (GitHub issue #927).
 *  The per-mode parameter registries (`parameterLinksRegistry.ts`), the activity rules
 *  (`parameterLinksActivity.ts`), the link-aware `patch*` metadata of the image-export slice and the
 *  typed union of valid link paths are all derived from `LINK_SCHEMA`, so a field cannot be listed in
 *  one place and forgotten in another. A field's key is its dot-path inside the mode's settings
 *  object (`"startMarker.size"` is `settings.startMarker.size`) — that path is the nested state
 *  location `getParamValue`/`setParamValue` address. */

export type LinkMode = "walls" | "corridors";

/** How an edit of the field keeps the links consistent:
 *  - `"param"`: a single-field setter (`writeLinkedParam`) detaches the field's incoming link and
 *    propagates to its dependents;
 *  - `"source"`: a "Shared style" source edit — the field keeps following its own incoming link and
 *    only its dependents are refreshed (`propagateLinkedSources`);
 *  - a `PatchGroup`: the field is written through a multi-field `patch*` action that detaches the
 *    incoming link of every field present in the patch (`applyLinkedPatch`). */
export type PatchGroup = "teleport" | "elevatorBadges" | "markerIndex" | "floorLabel" | "glueTabs" | "edgeMarkers" | "verticalSettings" | "oneWay" | "decorativeLine";
export type LinkUpdate = "param" | "source" | PatchGroup;

type MsgKey = Extract<keyof typeof m, string>;
type Thunk<T> = () => T;

/** One schema entry. `label`/`group` resolve in the current locale on every call (GitHub issue #742). */
export interface LinkFieldDef<M extends LinkMode = LinkMode> {
  readonly modes: readonly M[];
  readonly type: ParamType;
  readonly label: (mode: LinkMode) => string;
  readonly group: (mode: LinkMode) => string[];
  /** Overrides the default per-type value formatter. */
  readonly format?: "markerIndexLabelStyle";
  readonly active: ActivityRule;
  readonly update: LinkUpdate;
}

const msg = (key: MsgKey): string => (m[key] as () => string)();
const g = (...keys: MsgKey[]): Thunk<string[]> => () => keys.map(msg);

const BOTH = ["walls", "corridors"] as const;
const WALLS = ["walls"] as const;
const CORRIDORS = ["corridors"] as const;

// ---------------------------------------------------------------- builders

interface FieldExtra {
  /** Replaces the section's group, for every mode. */
  group?: Thunk<string[]>;
  groupBy?: Partial<Record<LinkMode, Thunk<string[]>>>;
  /** Mode-specific message key replacing the field's own label key. */
  labelBy?: Partial<Record<LinkMode, MsgKey>>;
  format?: "markerIndexLabelStyle";
  /** Combined (AND) with the section's rule. */
  active?: ActivityRule;
  update?: LinkUpdate;
  /** The field is a size-adaptation control, shown only when cell areas differ. */
  spread?: true;
}

interface FieldSpec extends FieldExtra {
  type: ParamType;
  label: MsgKey;
}

const f = (type: ParamType, label: MsgKey, extra: FieldExtra = {}): FieldSpec => ({ type, label, ...extra });

interface SectionOpts {
  group: Thunk<string[]>;
  active?: ActivityRule;
  update?: LinkUpdate;
  /** Appends the "(Abstract)"/"(Decorative)" suffix to the labels in the given modes (GitHub issue #677). */
  suffix?: Partial<Record<LinkMode, "abstract" | "decorative">>;
}

function suffixed(label: string, kind: "abstract" | "decorative" | undefined): string {
  if (kind === "abstract") return `${label} ${msg("image_export.param_links.vertical_style_abstract_suffix")}`;
  if (kind === "decorative") return `${label} ${msg("image_export.param_links.vertical_style_decorative_suffix")}`;
  return label;
}

function section<M extends readonly LinkMode[], K extends string>(modes: M, opts: SectionOpts, fields: Record<K, FieldSpec>): Record<K, LinkFieldDef<M[number]>> {
  const out: Record<string, LinkFieldDef> = {};
  for (const [key, spec] of Object.entries<FieldSpec>(fields)) {
    out[key] = {
      modes,
      type: spec.type,
      label: (mode) => suffixed(msg(spec.labelBy?.[mode] ?? spec.label), opts.suffix?.[mode]),
      group: (mode) => (spec.groupBy?.[mode] ?? spec.group ?? opts.group)(),
      format: spec.format,
      active: and(opts.active, spec.active, spec.spread ? R.areaSpread : undefined),
      update: spec.update ?? opts.update ?? "param",
    };
  }
  return out as Record<K, LinkFieldDef<M[number]>>;
}

function prefixed<Pre extends string, K extends string, D>(prefix: Pre, defs: Record<K, D>): { [P in K as `${Pre}.${P}`]: D } {
  return Object.fromEntries(Object.entries(defs).map(([k, d]) => [`${prefix}.${k}`, d])) as { [P in K as `${Pre}.${P}`]: D };
}

// ---------------------------------------------------------------- settings-tree groups

// Same section/subsection names the settings panels use, so the parameter-links dialog's tree lines
// up with where a field actually lives (GitHub issue #644).
const G = {
  sharedStyle: g("image_export.vector_by_walls.section_shared_style"),
  floors: g("image_export.floors.section"),
  floorsLabel: g("image_export.floors.section", "image_export.floors.label_subsection"),
  floorsBackground: g("image_export.floors.section", "image_export.floors.background_subsection"),
  markerLayout: g("image_export.vector_by_walls.section_shared_style", "image_export.marker_layout.section"),
  markersStart: g("image_export.vector_by_walls.section_markers", "image_export.vector_by_walls.markers_start", "image_export.vector_by_walls.markers_marker_subsection"),
  markersFinish: g("image_export.vector_by_walls.section_markers", "image_export.vector_by_walls.markers_finish", "image_export.vector_by_walls.markers_marker_subsection"),
  markersStartSymbol: g("image_export.vector_by_walls.section_markers", "image_export.vector_by_walls.markers_start", "image_export.vector_by_walls.markers_text_subsection"),
  markersFinishSymbol: g("image_export.vector_by_walls.section_markers", "image_export.vector_by_walls.markers_finish", "image_export.vector_by_walls.markers_text_subsection"),
  teleportMarkers: g("image_export.vector_by_walls.section_teleports", "image_export.vector_by_walls.teleport_subsection_edges"),
  teleportConnector: g("image_export.vector_by_walls.section_teleports", "image_export.vector_by_walls.teleport_subsection_connector"),
  teleportRoot: g("image_export.vector_by_walls.section_teleports"),
  teleportFloorBadges: g("image_export.vector_by_walls.section_teleports", "image_export.vector_by_walls.teleport_subsection_floor_badges"),
  markerIndex: g("image_export.vector_by_walls.section_marker_index"),
  markerIndexCoverage: g("image_export.vector_by_walls.section_marker_index", "image_export.vector_by_walls.marker_index_subsection_coverage"),
  markerIndexCaption: g("image_export.vector_by_walls.section_marker_index", "image_export.vector_by_walls.marker_index_subsection_caption"),
  markerIndexBackplate: g("image_export.vector_by_walls.section_marker_index", "image_export.vector_by_walls.marker_index_subsection_backplate"),
  topology: g("topology.title"),
  cutLines: g("topology.title", "image_export.topology.cut_lines"),
  creases: g("topology.title", "image_export.creases.title"),
  glueTabs: g("topology.title", "image_export.glue_tabs.title"),
  edgeMarkers: g("topology.title", "image_export.edge_markers.title"),
  verticalRoot: g("image_export.vector_by_walls.section_vertical"),
  // `replaceTwoFloorElevatorsWithStairs`/`elevatorBadges.*` render identically regardless of
  // `verticalStyle` (GitHub issue #677) — one shared group.
  verticalElevator: g("image_export.vector_by_walls.section_vertical", "image_export.vector_by_walls.elevator_marker"),
  verticalElevatorBadges: g("image_export.vector_by_walls.section_vertical", "image_export.vector_by_walls.elevator_marker", "image_export.vector_by_walls.elevator_badges"),
  verticalElevatorBadgesPlacement: g("image_export.vector_by_walls.section_vertical", "image_export.vector_by_walls.elevator_marker", "image_export.vector_by_walls.elevator_badges", "image_export.vector_by_walls.elevator_badges_subsection_placement"),
  verticalElevatorBadgesText: g("image_export.vector_by_walls.section_vertical", "image_export.vector_by_walls.elevator_marker", "image_export.vector_by_walls.elevator_badges", "image_export.vector_by_walls.elevator_badges_subsection_text"),
  verticalElevatorBadgesBackplate: g("image_export.vector_by_walls.section_vertical", "image_export.vector_by_walls.elevator_marker", "image_export.vector_by_walls.elevator_badges", "image_export.vector_by_walls.elevator_badges_subsection_backplate"),
  verticalSharedStyle: g("image_export.vector_by_walls.section_vertical", "image_export.vector_by_walls.vertical_subsection_shared_style"),
  verticalTwoWayMarker: g("image_export.vector_by_walls.section_vertical", "image_export.vector_by_walls.two_way_passage_marker", "image_export.vector_by_walls.vertical_subsection_marker"),
  verticalTwoWayArrows: g("image_export.vector_by_walls.section_vertical", "image_export.vector_by_walls.two_way_passage_marker", "image_export.vector_by_walls.vertical_subsection_arrows"),
  verticalOneWayMarker: g("image_export.vector_by_walls.section_vertical", "image_export.vector_by_walls.one_way_passage_marker", "image_export.vector_by_walls.vertical_subsection_marker"),
  verticalOneWayArrows: g("image_export.vector_by_walls.section_vertical", "image_export.vector_by_walls.one_way_passage_marker", "image_export.vector_by_walls.vertical_subsection_arrows"),
  verticalElevatorMarker: g("image_export.vector_by_walls.section_vertical", "image_export.vector_by_walls.elevator_marker", "image_export.vector_by_walls.vertical_subsection_marker"),
  verticalElevatorArrows: g("image_export.vector_by_walls.section_vertical", "image_export.vector_by_walls.elevator_marker", "image_export.vector_by_walls.vertical_subsection_arrows"),
  tiles: g("image_export.vector_by_walls.section_tiles"),
  oneWays: g("image_export.vector_by_walls.section_one_ways"),
  splits: g("image_export.vector_by_walls.section_splits"),
  background: g("image_export.vector_by_walls.section_background"),
  cells: g("image_export.vector_by_corridors.section_corridors"),
};

// ---------------------------------------------------------------- fields

const VW = "image_export.vector_by_walls";
const PL = "image_export.param_links";

/** The eight fields of a `MarkerSettings` record shown in a "Marker" subsection. */
function markerAppearance(labels: { cornerStyle: MsgKey; size: MsgKey; sizeAdaptation: MsgKey; borderWidth: MsgKey; gapWidth: MsgKey; shape: MsgKey; fillColor: MsgKey; borderColor: MsgKey }, active?: ActivityRule) {
  return {
    cornerStyle: f("cornerStyle", labels.cornerStyle, { active }),
    size: f("number", labels.size, { active }),
    sizeAdaptation: f("number", labels.sizeAdaptation, { spread: true, active }),
    borderWidth: f("number", labels.borderWidth, { active }),
    gapWidth: f("number", labels.gapWidth, { active }),
    shape: f("markerShape", labels.shape, { active }),
    fillColor: f("color", labels.fillColor, { active }),
    borderColor: f("color", labels.borderColor, { active }),
  };
}

const PLAIN_MARKER_LABELS = {
  cornerStyle: `${VW}.marker_corner_style`, size: `${VW}.marker_size`, sizeAdaptation: `${VW}.marker_size_adaptation`, borderWidth: `${VW}.marker_border_width`,
  gapWidth: `${VW}.marker_gap_width`, shape: `${VW}.marker_shape`, fillColor: `${VW}.marker_fill_color`, borderColor: `${VW}.marker_border_color`,
} as const;

/** Start/finish marker: the marker appearance plus the optional symbol (text) block. */
function endpointMarker(kind: "startMarker" | "finishMarker", markerGroup: Thunk<string[]>, symbolGroup: Thunk<string[]>) {
  const textOn = kind === "startMarker" ? R.startTextOn : R.finishTextOn;
  const markerOn = kind === "startMarker" ? R.startMarkerOn : R.finishMarkerOn;
  return {
    ...prefixed(kind, section(BOTH, { group: markerGroup }, { markerEnabled: f("boolean", `${VW}.marker_show`), ...markerAppearance(PLAIN_MARKER_LABELS, markerOn) })),
    ...prefixed(kind, section(BOTH, { group: symbolGroup }, {
      textEnabled: f("boolean", `${VW}.marker_text_show`),
      textFontWeight: f("labelFontWeight", `${VW}.marker_text_font_weight`, { active: textOn }),
      textSize: f("number", `${VW}.marker_text_size`, { active: textOn }),
      textMargin: f("number", `${VW}.marker_text_margin`, { active: textOn }),
      textColor: f("color", `${VW}.marker_text_color`, { active: textOn }),
    })),
  };
}

/** A vertical-passage marker record (two-way / one-way / elevator): shown only when the maze has
 *  that passage kind and, in "Vector by walls", only in the abstract style. */
function passageMarker(kind: "twoWayPassageMarker" | "oneWayPassageMarker" | "elevatorMarker", group: Thunk<string[]>, exists: ActivityRule) {
  return prefixed(kind, section(BOTH, { group, active: and(exists, R.abstractStyle), suffix: { walls: "abstract" } }, markerAppearance(PLAIN_MARKER_LABELS)));
}

/** The decorative-stairs line style of a passage kind ("Vector by walls" decorative style only). */
function decorativeLine(kind: "decorativeStairsTwoWay" | "decorativeStairsOneWay" | "decorativeElevator", group: Thunk<string[]>, exists: ActivityRule) {
  return prefixed(kind, section(WALLS, { group, active: and(exists, R.decorativeStyle), suffix: { walls: "decorative" } }, {
    lineWidth: f("number", `${VW}.decorative_line_width`),
    size: f("number", `${VW}.marker_size`),
    sizeAdaptation: f("number", `${VW}.marker_size_adaptation`, { spread: true }),
    lineColor: f("color", `${VW}.decorative_line_color`, { update: "decorativeLine" }),
  }));
}

/** The arrow block of a vertical-passage kind. */
function abstractArrows(prefix: "twoWay" | "oneWay" | "elevator", group: Thunk<string[]>, exists: ActivityRule) {
  const key = (name: string) => `${prefix}Arrow${name}`;
  return section(BOTH, { group, active: and(exists, R.abstractStyle), suffix: { walls: "abstract" } }, {
    [key("Size")]: f("number", `${VW}.vertical_arrow_size`),
    [key("Style")]: f("verticalArrowStyle", `${VW}.vertical_arrow_style`),
    [key("CornerStyle")]: f("cornerStyle", `${VW}.vertical_arrow_corner_style`),
    [key("Color")]: f("color", `${VW}.vertical_arrow_color`, { update: "verticalSettings" }),
  }) as Record<`${typeof prefix}Arrow${"Size" | "Style" | "CornerStyle" | "Color"}`, LinkFieldDef<"walls" | "corridors">>;
}

function decorativeArrows(prefix: "decorativeStairs" | "decorativeStairsOneWay", group: Thunk<string[]>, exists: ActivityRule) {
  return section(WALLS, { group, active: and(exists, R.decorativeStyle), suffix: { walls: "decorative" } }, {
    [`${prefix}ArrowSize`]: f("number", `${VW}.vertical_arrow_size`),
    [`${prefix}ArrowColor`]: f("color", `${VW}.vertical_arrow_color`, { update: "verticalSettings" }),
  }) as Record<`${typeof prefix}Arrow${"Size" | "Color"}`, LinkFieldDef<"walls">>;
}

const teleportOn = R.teleports;
const floorBadgeOn = R.crossFloorTeleports;

export const LINK_SCHEMA = {
  // ---- "Shared style" sources (an edit refreshes dependents but keeps the field's own incoming link)
  ...section(BOTH, { group: G.sharedStyle, update: "source" }, {
    markerShape: f("markerShape", `${PL}.shared_marker_shape`),
    markerFillColor: f("color", `${PL}.shared_marker_fill_color`),
    markerBorderColor: f("color", `${PL}.shared_marker_border_color`),
    cornerStyle: f("cornerStyle", `${PL}.shared_corner_style`),
    markerSize: f("number", `${PL}.shared_marker_size`),
    markerSizeAdaptation: f("number", `${PL}.shared_marker_size_adaptation`, { spread: true }),
    markerBorderWidth: f("number", `${PL}.shared_marker_border_width`),
    gapWidth: f("number", `${PL}.shared_gap_width`),
    markerTextSize: f("number", `${PL}.shared_marker_text_size`),
    markerTextMargin: f("number", `${PL}.shared_marker_text_margin`),
    markerTextFontWeight: f("labelFontWeight", `${PL}.shared_marker_text_font_weight`),
    floorLabelType: f("indexLabelStyle", "image_export.floors.general_style_floor_label"),
  }),
  // "Vector by walls" vertical shared style: abstract fields and decorative fields tell apart by the
  // label suffix, since the panel has one "Shared style" subsection for both (GitHub issue #677).
  ...section(BOTH, { group: G.verticalSharedStyle, update: "source", active: and(R.verticalSection, R.abstractStyle), suffix: { walls: "abstract" } }, {
    verticalSize: f("number", `${PL}.vertical_shared_size`),
    verticalSizeAdaptation: f("number", `${PL}.vertical_shared_size_adaptation`, { spread: true }),
    verticalArrowSize: f("number", `${PL}.vertical_shared_arrow_size`),
    verticalCornerStyle: f("cornerStyle", `${PL}.vertical_shared_corner_style`),
    verticalShape: f("markerShape", `${PL}.vertical_shared_shape`),
    verticalBorderWidth: f("number", `${PL}.vertical_shared_border_width`),
    verticalGapWidth: f("number", `${PL}.vertical_shared_gap_width`),
    verticalFillColor: f("color", `${PL}.vertical_shared_fill_color`),
    verticalArrowColor: f("color", `${PL}.vertical_shared_arrow_color`),
    verticalArrowStyle: f("verticalArrowStyle", `${PL}.vertical_shared_arrow_style`),
    verticalArrowCornerStyle: f("cornerStyle", `${PL}.vertical_shared_arrow_corner_style`),
  }),
  ...section(WALLS, { group: G.verticalSharedStyle, update: "source", active: and(R.verticalSection, R.decorativeStyle), suffix: { walls: "decorative" } }, {
    verticalDecorativeLineColor: f("color", `${PL}.vertical_shared_decorative_line_color`),
    verticalDecorativeLineWidth: f("number", `${PL}.vertical_shared_decorative_line_width`),
    verticalDecorativeSize: f("number", `${PL}.vertical_shared_decorative_size`),
    verticalDecorativeSizeAdaptation: f("number", `${PL}.vertical_shared_decorative_size_adaptation`, { spread: true }),
    verticalDecorativeArrowSize: f("number", `${PL}.vertical_shared_decorative_arrow_size`),
  }),

  // ---- tiles / cells / one-ways
  ...section(WALLS, { group: G.tiles }, {
    wallJoin: f("cornerStyle", `${VW}.wall_join`),
  }),
  ...section(CORRIDORS, { group: G.cells }, {
    join: f("cornerStyle", "image_export.vector_by_corridors.join"),
  }),
  ...section(BOTH, { group: G.oneWays, active: R.oneWays }, {
    oneWayJoin: f("cornerStyle", `${VW}.one_way_join`, { update: "oneWay" }),
    oneWayColor: f("color", `${VW}.one_way_color`, { labelBy: { corridors: "image_export.vector_by_corridors.one_way_color" } }),
    oneWayThickness: f("number", `${VW}.one_way_thickness`, { labelBy: { corridors: "image_export.vector_by_corridors.one_way_thickness" } }),
  }),
  ...section(WALLS, { group: G.oneWays, active: R.oneWays }, {
    oneWayGapWidth: f("number", `${VW}.one_way_gap_width`),
    oneWaySize: f("number", `${VW}.one_way_size`),
  }),
  ...section(CORRIDORS, { group: G.oneWays, active: R.oneWays }, {
    oneWayCount: f("number", "image_export.vector_by_corridors.one_way_count"),
    oneWayGap: f("number", "image_export.vector_by_corridors.one_way_gap"),
    oneWayWidth: f("number", "image_export.vector_by_corridors.one_way_width"),
    oneWayLength: f("number", "image_export.vector_by_corridors.one_way_length"),
  }),
  ...section(BOTH, { group: G.markerLayout }, {
    markerScale: f("number", "image_export.marker_layout.scale"),
  }),

  // ---- start / finish markers
  ...endpointMarker("startMarker", G.markersStart, G.markersStartSymbol),
  ...endpointMarker("finishMarker", G.markersFinish, G.markersFinishSymbol),

  // ---- teleports
  ...prefixed("teleportMarker", section(BOTH, { group: G.teleportMarkers, active: teleportOn, update: "teleport" }, markerAppearance({
    cornerStyle: `${VW}.teleport_corner_style`, size: `${VW}.teleport_size`, sizeAdaptation: `${VW}.marker_size_adaptation`, borderWidth: `${VW}.teleport_border_width`,
    gapWidth: `${VW}.teleport_edge_gap_width`, shape: `${VW}.teleport_shape`, fillColor: `${VW}.marker_fill_color`, borderColor: `${VW}.teleport_edge_border_color`,
  }))),
  ...section(BOTH, { group: G.teleportConnector, active: teleportOn, update: "teleport" }, {
    teleportConnectorGapWidth: f("number", `${VW}.teleport_connector_gap_width`, { active: R.connectorDrawn }),
    teleportConnectorCornerStyle: f("cornerStyle", `${VW}.marker_corner_style`, { active: R.orthogonalConnector }),
    teleportConnectorColor: f("color", `${VW}.teleport_connector_color`, { active: R.connectorDrawn }),
    teleportAvoidFieldExit: f("boolean", `${VW}.teleport_avoid_field_exit`, { active: R.orthogonalConnector }),
    teleportThroughSeams: f("boolean", `${VW}.teleport_through_seams`, { active: R.seams }),
    teleportCurveDirection: f("teleportCurveDirection", `${VW}.teleport_curve_direction`, { active: R.curvedConnector }),
    teleportCurveStrength: f("number", `${VW}.teleport_curve_strength`, { active: R.curvedConnector }),
  }),
  ...section(BOTH, { group: G.teleportRoot, active: teleportOn, update: "teleport" }, {
    teleportMergeMode: f("boolean", `${VW}.teleport_merge_mode`),
    teleportGroupCustomization: f("boolean", `${VW}.teleport_group_customization`),
  }),
  ...prefixed("teleportFloorBadge", section(BOTH, { group: G.teleportFloorBadges, active: and(teleportOn, floorBadgeOn), update: "teleport" }, {
    shape: f("markerShape", `${VW}.teleport_floor_badge_shape`),
    labelType: f("indexLabelStyle", `${VW}.teleport_floor_badge_label_type`),
    fillColor: f("color", `${VW}.teleport_floor_badge_fill_color`),
    size: f("number", `${VW}.marker_size`),
    sizeAdaptation: f("number", `${VW}.marker_size_adaptation`, { spread: true }),
    cornerStyle: f("cornerStyle", `${VW}.marker_corner_style`),
    borderWidth: f("number", `${VW}.marker_border_width`),
    gapWidth: f("number", `${VW}.marker_gap_width`),
    borderColor: f("color", `${VW}.teleport_floor_badge_border_color`),
    textColor: f("color", `${VW}.teleport_floor_badge_text_color`),
    textFontWeight: f("labelFontWeight", `${VW}.marker_text_font_weight`),
    textSize: f("number", `${VW}.teleport_floor_badge_text_size`),
    textMargin: f("number", `${VW}.marker_text_margin`),
  })),

  // ---- floor labels
  ...prefixed("floorLabel", section(BOTH, { group: G.floors, active: R.multipleFloors, update: "floorLabel" }, {
    enabled: f("boolean", "image_export.floors.show"),
  })),
  ...prefixed("floorLabel", section(BOTH, { group: G.floorsLabel, active: and(R.multipleFloors, R.floorLabelOn), update: "floorLabel" }, {
    labelType: f("indexLabelStyle", "image_export.floors.label", { active: R.floorLabelIndexMode }),
    textFontWeight: f("labelFontWeight", "image_export.floors.weight"),
    textSize: f("number", "image_export.floors.size"),
    textMargin: f("number", "image_export.floors.padding"),
    textColor: f("color", "image_export.floors.text_color"),
  })),
  ...prefixed("floorLabel", section(BOTH, { group: G.floorsBackground, active: and(R.multipleFloors, R.floorLabelOn, R.floorLabelBackground), update: "floorLabel" }, {
    width: f("number", "image_export.floors.width"),
    height: f("number", "image_export.floors.height"),
    cornerRadius: f("number", "image_export.floors.corner_radius"),
    gap: f("number", "image_export.floors.gap"),
    borderWidth: f("number", "image_export.floors.border_width"),
    fillColor: f("color", "image_export.floors.color"),
    borderColor: f("color", "image_export.floors.border_color", { active: R.floorLabelBorder }),
  })),

  // ---- vertical passages
  ...passageMarker("twoWayPassageMarker", G.verticalTwoWayMarker, R.twoWayPassages),
  ...passageMarker("oneWayPassageMarker", G.verticalOneWayMarker, R.oneWayPassages),
  ...passageMarker("elevatorMarker", G.verticalElevatorMarker, R.elevators),
  ...decorativeLine("decorativeStairsTwoWay", G.verticalTwoWayMarker, R.twoWayPassages),
  ...decorativeLine("decorativeStairsOneWay", G.verticalOneWayMarker, R.oneWayPassages),
  ...decorativeLine("decorativeElevator", G.verticalElevatorMarker, R.elevators),
  ...decorativeArrows("decorativeStairs", G.verticalTwoWayArrows, R.twoWayPassages),
  ...decorativeArrows("decorativeStairsOneWay", G.verticalOneWayArrows, R.oneWayPassages),
  ...abstractArrows("twoWay", G.verticalTwoWayArrows, R.twoWayPassages),
  ...abstractArrows("oneWay", G.verticalOneWayArrows, R.oneWayPassages),
  ...abstractArrows("elevator", G.verticalElevatorArrows, R.elevators),
  // The "replace with stairs" toggle lives inside the "Elevator" subsection in "Vector by walls"
  // (GitHub issue #677) but directly under "Vertical connections" in "Vector by corridors".
  ...section(BOTH, { group: G.verticalElevator, active: R.elevators }, {
    replaceTwoFloorElevatorsWithStairs: f("boolean", `${VW}.replace_two_floor_elevators_with_stairs`, { groupBy: { corridors: G.verticalRoot } }),
  }),
  ...prefixed("elevatorBadges", section(BOTH, { group: G.verticalElevatorBadges, active: R.elevators }, {
    enabled: f("boolean", `${VW}.elevator_badges_enabled`, { update: "elevatorBadges" }),
  })),
  // The badge fields sit in three panel subsections: "Placement", "Text" and "Backplate".
  ...prefixed("elevatorBadges", section(BOTH, { group: G.verticalElevatorBadgesPlacement, active: and(R.elevators, R.elevatorBadgesOn), update: "elevatorBadges" }, {
    distance: f("number", `${VW}.elevator_badges_distance`),
    evenDistribution: f("boolean", `${VW}.elevator_badges_even_distribution`),
    gap: f("number", `${VW}.elevator_badges_gap`, { active: R.elevatorBadgeGap }),
  })),
  ...prefixed("elevatorBadges", section(BOTH, { group: G.verticalElevatorBadgesText, active: and(R.elevators, R.elevatorBadgesOn), update: "elevatorBadges" }, {
    labelType: f("indexLabelStyle", `${VW}.elevator_badges_label_type`),
    textFontWeight: f("labelFontWeight", `${VW}.elevator_badges_font_weight`),
    textSize: f("number", `${VW}.elevator_badges_text_size`),
    textMargin: f("number", `${VW}.marker_text_margin`),
    textColor: f("color", `${VW}.elevator_badges_text_color`),
  })),
  ...prefixed("elevatorBadges", section(BOTH, { group: G.verticalElevatorBadgesBackplate, active: and(R.elevators, R.elevatorBadgesOn), update: "elevatorBadges" }, {
    shape: f("markerShape", `${VW}.elevator_badges_shape`),
    size: f("number", `${VW}.elevator_badges_size`),
    gapWidth: f("number", `${VW}.elevator_badges_gap_width`),
    fillColor: f("color", `${VW}.elevator_badges_fill_color`),
    borderColor: f("color", `${VW}.marker_border_color`),
    borderWidth: f("number", `${VW}.marker_border_width`),
  })),
  // `cornerStyle` keeps its own update path ("Shared style"-linked, see `setElevatorBadgesCornerStyle`).
  ...prefixed("elevatorBadges", section(BOTH, { group: G.verticalElevatorBadgesBackplate, active: and(R.elevators, R.elevatorBadgesOn) }, {
    cornerStyle: f("cornerStyle", `${VW}.marker_corner_style`),
  })),

  // ---- marker indices
  ...prefixed("markerIndex", section(BOTH, { group: G.markerIndex, active: R.markerIndexSource, update: "markerIndex" }, {
    enabled: f("boolean", `${VW}.marker_index_enabled`),
  })),
  ...prefixed("markerIndex", section(BOTH, { group: G.markerIndexBackplate, active: and(R.markerIndexSource, R.markerIndexOn), update: "markerIndex" }, {
    gap: f("number", `${VW}.marker_index_gap`),
    width: f("number", `${VW}.marker_index_width`),
    height: f("number", `${VW}.marker_index_height`),
    offset: f("number", `${VW}.marker_index_offset`),
    cornerRadius: f("number", `${VW}.marker_index_corner_radius`),
    borderWidth: f("number", `${VW}.marker_index_border_width`, { active: R.markerIndexBorderWidth }),
    borderWidthFromMarker: f("boolean", `${VW}.marker_index_border_width_from_marker`),
    borderColorFromMarker: f("boolean", `${VW}.marker_index_border_color_from_marker`),
    fillColor: f("color", `${VW}.marker_index_fill_color`),
    borderColor: f("color", `${VW}.marker_index_border_color`, { active: R.markerIndexBorderColor }),
  })),
  ...prefixed("markerIndex", section(BOTH, { group: G.markerIndexCaption, active: and(R.markerIndexSource, R.markerIndexOn), update: "markerIndex" }, {
    textSize: f("number", `${VW}.marker_text_size`),
    textMargin: f("number", `${VW}.marker_text_margin`),
    labelStyle: f("indexLabelStyle", `${VW}.marker_index_label_style`, { format: "markerIndexLabelStyle" }),
    textFontWeight: f("labelFontWeight", `${VW}.marker_text_font_weight`),
    textColor: f("color", `${VW}.marker_text_color`),
  })),
  ...prefixed("markerIndex.coverage", section(BOTH, { group: G.markerIndexCoverage, active: and(R.markerIndexSource, R.markerIndexOn), update: "markerIndex" }, {
    singleFloorTeleport: f("boolean", `${VW}.marker_index_coverage_single_floor_teleport`),
    crossFloorTeleport: f("boolean", `${VW}.marker_index_coverage_cross_floor_teleport`),
    verticalPassage: f("boolean", `${VW}.marker_index_coverage_vertical_passage`),
    elevator: f("boolean", `${VW}.marker_index_coverage_elevator`),
  })),

  // ---- background, grid, topology
  ...section(BOTH, { group: G.background }, {
    background: f("color", `${VW}.background_color`),
    showGrid: f("boolean", `${VW}.show_grid`),
  }),
  ...section(BOTH, { group: G.background }, {
    gridColor: f("color", `${VW}.grid_color`),
  }),
  ...section(WALLS, { group: G.background }, {
    showInnerGrid: f("boolean", `${VW}.show_inner_grid`),
  }),
  ...section(WALLS, { group: G.background }, {
    innerGridColor: f("color", `${VW}.inner_grid_color`),
  }),
  // Only "Vector by walls" trims walls; the corridors settings carry the leaf but nothing reads it.
  ...section(WALLS, { group: G.topology, active: R.glues }, {
    trimWallsAtFaceBoundaries: f("boolean", "image_export.topology.trim_walls_at_face_boundaries"),
  }),
  // The cut-line style (GitHub issue #859): the same three parameters in both render modes.
  ...section(BOTH, { group: G.cutLines, active: R.glues }, {
    showCutLines: f("boolean", "image_export.topology.show_cut_lines"),
  }),
  ...section(BOTH, { group: G.cutLines, active: R.cutLines }, {
    cutLinesGlueColor: f("boolean", "image_export.topology.cut_lines_glue_color"),
  }),
  ...section(BOTH, { group: G.cutLines, active: R.customCutLineColor }, {
    cutLinesColor: f("color", "image_export.topology.cut_lines_color"),
  }),
  // The crease display (GitHub issue #924): every field but `mode` is linkable.
  ...prefixed("creases", section(BOTH, { group: G.creases, active: R.creases }, {
    showCreases: f("boolean", "image_export.creases.show"),
  })),
  ...prefixed("creases", section(BOTH, { group: G.creases, active: R.creaseLines }, {
    lineStyle: f("lineStyle", "image_export.creases.line_style"),
    lineWidth: f("number", "image_export.creases.line_width"),
    color: f("color", "image_export.creases.color"),
  })),
  ...prefixed("creases", section(BOTH, { group: G.creases, active: R.creaseMarks }, {
    markSize: f("number", "image_export.creases.mark_size"),
    markTipLength: f("number", "image_export.creases.mark_tip_length"),
    markColor: f("color", "image_export.creases.mark_color"),
  })),
  // The glue-tab style (GitHub issue #901).
  ...prefixed("glueTabs", section(BOTH, { group: G.glueTabs, active: R.glues, update: "glueTabs" }, {
    showTabs: f("boolean", "image_export.glue_tabs.show"),
  })),
  ...prefixed("glueTabs", section(BOTH, { group: G.glueTabs, active: R.glueTabs, update: "glueTabs" }, {
    inset: f("number", "image_export.glue_tabs.inset"),
    width: f("number", "image_export.glue_tabs.width"),
    alternate: f("boolean", "image_export.glue_tabs.alternate"),
    fillColor: f("color", "image_export.glue_tabs.fill_color"),
    lineWidth: f("number", "image_export.glue_tabs.line_width"),
  })),
  ...prefixed("glueTabs", section(BOTH, { group: G.glueTabs, active: R.glueTabLine, update: "glueTabs" }, {
    lineStyle: f("lineStyle", "image_export.glue_tabs.line_style"),
    lineColor: f("color", "image_export.glue_tabs.line_color"),
  })),
  ...prefixed("edgeMarkers", section(BOTH, { group: G.edgeMarkers, active: R.edgeMarkers, update: "edgeMarkers" }, {
    size: f("number", "image_export.edge_markers.size"),
    shape: f("markerShape", "image_export.edge_markers.shape"),
    color: f("color", "image_export.edge_markers.color"),
  })),

  // ---- "Vector by walls" tiles
  ...section(WALLS, { group: G.tiles }, {
    floorColor: f("color", `${VW}.floor_color`),
    wallColor: f("color", `${VW}.wall_color`, { active: R.singleWallColor }),
    wallThickness: f("number", `${VW}.wall_thickness`),
  }),

  // ---- "Vector by corridors" cells and splits
  ...section(CORRIDORS, { group: G.cells }, {
    color: f("color", "image_export.vector_by_corridors.color"),
    thickness: f("number", "image_export.vector_by_corridors.thickness"),
    junctionRadius: f("number", "image_export.vector_by_corridors.junction_radius", { active: R.contourJunction }),
    markerWidenPadding: f("number", "image_export.vector_by_corridors.marker_widen_padding"),
  }),
  ...section(CORRIDORS, { group: G.splits, active: R.splits }, {
    splitGapWidth: f("number", "image_export.vector_by_corridors.split_gap_width", { active: R.splitShapes }),
    splitDiagonalBowAmount: f("number", "image_export.vector_by_corridors.split_diagonal_bow_amount", { active: R.splitBow }),
  }),
  ...section(BOTH, { group: G.splits, active: R.splits }, {
    splitSpecialShapes: f("boolean", `${VW}.split_special_shapes`),
  }),
} satisfies Record<string, LinkFieldDef>;

/** Every declared link path, as a typed union. */
export type LinkPath = keyof typeof LINK_SCHEMA;

type PathsFor<M extends LinkMode> = {
  [K in LinkPath]: M extends (typeof LINK_SCHEMA)[K]["modes"][number] ? K : never;
}[LinkPath];

export type WallsLinkPath = PathsFor<"walls">;
export type CorridorsLinkPath = PathsFor<"corridors">;

const SCHEMA_ENTRIES = Object.entries(LINK_SCHEMA) as [LinkPath, LinkFieldDef][];

/** The schema entries declared for `mode`, in declaration order. */
export function schemaEntriesFor(mode: LinkMode): [LinkPath, LinkFieldDef][] {
  return SCHEMA_ENTRIES.filter(([, def]) => def.modes.includes(mode));
}

/** The paths written through the `patch*` action `group` in `mode`. */
export function patchPaths<P extends string>(mode: LinkMode, group: PatchGroup): readonly P[] {
  return schemaEntriesFor(mode).filter(([, def]) => def.update === group).map(([path]) => path as string as P);
}

/** Whether `path` is declared for `mode` — a path of the other render mode has no row there. */
export function isSchemaPathInMode(path: string, mode: LinkMode): boolean {
  const def = (LINK_SCHEMA as Record<string, LinkFieldDef | undefined>)[path];
  return def?.modes.includes(mode) ?? false;
}

/** Whether `path` is shown in the settings panel — a path outside the schema is always active. */
export function isSchemaPathActive(path: string, mode: LinkMode, ctx: ParamActivityContext, settings: ParamActivitySettings): boolean {
  const def = (LINK_SCHEMA as Record<string, LinkFieldDef | undefined>)[path];
  return (def?.active ?? always)(ctx, settings, mode);
}
