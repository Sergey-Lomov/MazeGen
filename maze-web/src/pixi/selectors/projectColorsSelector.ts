import type { MazeState } from "../../store/storeTypes";
import type {
  VectorByWallsSettings,
  VectorByCorridorsSettings,
  MarkerSettings,
} from "../../store/imageExportTypes";
import type { EdgeDto } from "../../wasm/types";
import { splitSlotColor } from "../colorUtils";
import { canvas } from "../colorTokens";
import { maxSplitNodeCount } from "./mazeSelectors";
import { hasCrossFloorTeleport } from "./mazeSelectors/teleport";
import * as m from "~/paraglide/messages";

/** Which export-panel sections are actually shown for the current maze — the color picker's
 *  "Project colors" list must not offer a color whose settings section the panel hides (GitHub
 *  issue #503 follow-up). Mirrors the `has*` predicates the settings panels compute from the
 *  *unscoped* project-wide `nodes`/`edges` (so the answer doesn't change on a floor switch). */
interface SectionVisibility {
  grid: boolean;
  /** `wallColor` — hidden when the random-wall-color palette replaces the single wall color. */
  wall: boolean;
  oneWayIndicator: boolean;
  teleports: boolean;
  crossFloorTeleports: boolean;
  /** `teleportConnectorColor` — the connector subsection is hidden when the style is `"none"`. */
  teleportConnector: boolean;
  /** Per-group teleport fill/border overrides — only applied while group customization is on. */
  teleportGroupOverrides: boolean;
  twoWayPassages: boolean;
  oneWayPassages: boolean;
  elevators: boolean;
  /** The whole "Vertical connections" section wrapper. */
  vertical: boolean;
  /** The whole "Marker indices" section — hidden when the layer is disabled. */
  markerIndex: boolean;
  /** `markerIndex.borderColor` — hidden when the plate border color follows the marker. */
  markerIndexBorder: boolean;
}

function hasDirectionalBasicEdge(edges: EdgeDto[]): boolean {
  const basic = edges.filter((e) => e.kind === "basic");
  const forward = new Set(basic.map((e) => `${e.from}->${e.to}`));
  return basic.some((e) => !forward.has(`${e.to}->${e.from}`));
}

function verticalVisibility(state: MazeState, replaceTwoFloorElevatorsWithStairs: boolean) {
  const passageEdges = state.edges.filter((e) => e.kind === "vertical_passage");
  const forward = new Set(passageEdges.map((e) => `${e.from}->${e.to}`));
  const oneWayPassages = passageEdges.some((e) => !forward.has(`${e.to}->${e.from}`));
  const elevators = state.edges.some((e) => e.kind === "elevator");
  const twoWayPassages =
    passageEdges.some((e) => forward.has(`${e.to}->${e.from}`)) ||
    (replaceTwoFloorElevatorsWithStairs && elevators);
  return { twoWayPassages, oneWayPassages, elevators };
}

function sectionVisibility(state: MazeState, s: VectorByWallsSettings | VectorByCorridorsSettings): SectionVisibility {
  const { twoWayPassages, oneWayPassages, elevators } = verticalVisibility(state, s.replaceTwoFloorElevatorsWithStairs);
  return {
    grid: s.showGrid,
    wall: !("randomWallColorMode" in s) || s.randomWallColorMode === "off",
    oneWayIndicator: hasDirectionalBasicEdge(state.edges),
    teleports: state.edges.some((e) => e.kind === "teleport"),
    crossFloorTeleports: hasCrossFloorTeleport(state.nodes, state.edges),
    teleportConnector: s.teleportConnectorStyle !== "none",
    teleportGroupOverrides: s.teleportGroupCustomization,
    twoWayPassages,
    oneWayPassages,
    elevators,
    vertical: twoWayPassages || oneWayPassages || elevators || state.floors.length > 1,
    markerIndex: s.markerIndex.enabled,
    markerIndexBorder: !s.markerIndex.borderColorFromMarker,
  };
}

/** One color field of an export profile, surfaced in the color picker's "Project colors" section
 *  (GitHub issue #503). `name` is a human-readable "Section: Role" label (the word "color" left
 *  out — every row is a color). If one color value is used by several fields, each field is still
 *  its own entry. */
export interface ProjectColorEntry {
  name: string;
  color: number;
}

type SectionKey =
  | "background"
  | "corridor"
  | "tiles"
  | "one_ways"
  | "teleports"
  | "start"
  | "finish"
  | "two_way"
  | "one_way"
  | "elevator"
  | "splits"
  | "marker_index";

type RoleKey =
  | "fill"
  | "grid"
  | "floor"
  | "wall"
  | "one_way_line"
  | "border"
  | "edge"
  | "edge_border"
  | "connector"
  | "badge_fill"
  | "badge_border"
  | "badge_text"
  | "badges_fill"
  | "badges_text"
  | "arrow"
  | "accent"
  | "line"
  | "text"
  | "split_node";

const sectionLabel: Record<SectionKey, () => string> = {
  background: m["color_picker.entry.section.background"],
  corridor: m["color_picker.entry.section.corridor"],
  tiles: m["color_picker.entry.section.tiles"],
  one_ways: m["color_picker.entry.section.one_ways"],
  teleports: m["color_picker.entry.section.teleports"],
  start: m["color_picker.entry.section.start"],
  finish: m["color_picker.entry.section.finish"],
  two_way: m["color_picker.entry.section.two_way"],
  one_way: m["color_picker.entry.section.one_way"],
  elevator: m["color_picker.entry.section.elevator"],
  splits: m["image_export.vector_by_walls.section_splits"],
  marker_index: m["color_picker.entry.section.marker_index"],
};

const roleLabel: Record<Exclude<RoleKey, "split_node">, () => string> = {
  fill: m["color_picker.entry.role.fill"],
  grid: m["color_picker.entry.role.grid"],
  floor: m["color_picker.entry.role.floor"],
  wall: m["color_picker.entry.role.wall"],
  one_way_line: m["color_picker.entry.role.one_way_line"],
  border: m["color_picker.entry.role.border"],
  edge: m["color_picker.entry.role.edge"],
  edge_border: m["color_picker.entry.role.edge_border"],
  connector: m["color_picker.entry.role.connector"],
  badge_fill: m["color_picker.entry.role.badge_fill"],
  badge_border: m["color_picker.entry.role.badge_border"],
  badge_text: m["color_picker.entry.role.badge_text"],
  badges_fill: m["color_picker.entry.role.badges_fill"],
  badges_text: m["color_picker.entry.role.badges_text"],
  arrow: m["color_picker.entry.role.arrow"],
  accent: m["color_picker.entry.role.accent"],
  line: m["color_picker.entry.role.line"],
  text: m["color_picker.entry.role.text"],
};

/** Localized "Section: …: Role" name from raw section keys + a role key. */
function buildName(sections: SectionKey[], role: Exclude<RoleKey, "split_node">): string {
  return [...sections.map((s) => sectionLabel[s]()), roleLabel[role]()].join(": ");
}

/** One project-color field's identity. `.name()` is its localized "Section: Role" label — used
 *  both for the picker's row and for the `ColorRow`'s `fieldName` (self-row exclusion + header);
 *  `.at(color)` pairs the name with a concrete color value for a `priorityColors` / list entry.
 *  Every name in the whole feature comes from {@link PC}, so a call site can't spell "Section:
 *  Role" a different way than `selectActiveProfileColors` does. */
export interface ColorField {
  name: () => string;
  at: (color: number) => ProjectColorEntry;
}

function field(sections: SectionKey[], role: Exclude<RoleKey, "split_node">): ColorField {
  const name = () => buildName(sections, role);
  return { name, at: (color) => ({ name: name(), color }) };
}

/** The registry of every project-color field (GitHub issue #503). Keyed by a short call-site name;
 *  each value carries the "Section: Role" label and an `.at(color)` entry builder. Split-node slots
 *  are dynamic — `PC.splitNode(i)` returns the field for slot `i` (0-based). */
export const PC = {
  bgFill: field(["background"], "fill"),
  bgGrid: field(["background"], "grid"),

  corridorFill: field(["corridor"], "fill"),

  tilesFloor: field(["tiles"], "floor"),
  tilesWall: field(["tiles"], "wall"),

  oneWaysMarker: field(["one_ways"], "one_way_line"),

  startFill: field(["start"], "fill"),
  startBorder: field(["start"], "border"),
  finishFill: field(["finish"], "fill"),
  finishBorder: field(["finish"], "border"),

  teleportEdge: field(["teleports"], "edge"),
  teleportEdgeBorder: field(["teleports"], "edge_border"),
  teleportConnector: field(["teleports"], "connector"),
  teleportBadgeFill: field(["teleports"], "badge_fill"),
  teleportBadgeBorder: field(["teleports"], "badge_border"),
  teleportBadgeText: field(["teleports"], "badge_text"),

  // Decorative-style vertical connection line colors (one per sub-group).
  decorLineTwoWay: field(["tiles"], "line"),
  decorLineOneWay: field(["one_ways"], "line"),
  decorLineElevator: field(["elevator"], "line"),
  // Decorative-style vertical connection accent / arrow (share a value with the abstract fields
  // below only when styles switch — one vertical style is live at a time).
  decorArrowTwoWay: field(["two_way"], "arrow"),
  decorAccentOneWay: field(["one_way"], "accent"),

  twoWayFill: field(["two_way"], "fill"),
  twoWayBorder: field(["two_way"], "border"),
  twoWayArrow: field(["two_way"], "arrow"),

  oneWayFill: field(["one_way"], "fill"),
  oneWayAccent: field(["one_way"], "accent"),
  oneWayArrow: field(["one_way"], "arrow"),

  elevatorFill: field(["elevator"], "fill"),
  elevatorBorder: field(["elevator"], "border"),
  elevatorArrow: field(["elevator"], "arrow"),
  elevatorBadgeFill: field(["elevator"], "badges_fill"),
  elevatorBadgeText: field(["elevator"], "badges_text"),

  markerIndexFill: field(["marker_index"], "fill"),
  markerIndexText: field(["marker_index"], "text"),
  markerIndexBorder: field(["marker_index"], "border"),

  splitNode(index: number): ColorField {
    const name = () =>
      `${sectionLabel.splits()}: ${m["color_picker.entry.role.split_node"]({ index: String(index + 1) })}`;
    return { name, at: (color) => ({ name: name(), color }) };
  },

  /** A per-teleport-group override color, named by the group's 1-based display order (its raw key
   *  is an internal coordinate pair, not a human-facing name) — same dynamic-slot convention as
   *  {@link splitNode}. */
  teleportGroup(index: number, role: "fill" | "border"): ColorField {
    const label = role === "fill" ? m["color_picker.entry.role.teleport_group_fill"] : m["color_picker.entry.role.teleport_group_border"];
    const name = () => `${sectionLabel.teleports()}: ${label({ index: String(index + 1) })}`;
    return { name, at: (color) => ({ name: name(), color }) };
  },
} as const;

/** Every `MarkerSettings` color field. `borderColor` is skipped when the panel hides it (a one-way
 *  passage marker — its border color is driven by the accent color instead). */
function markerColors(fill: ColorField, border: ColorField | null, marker: MarkerSettings): ProjectColorEntry[] {
  const rows = [fill.at(marker.fillColor)];
  if (border) rows.push(border.at(marker.borderColor));
  return rows;
}

function teleportColors(s: VectorByWallsSettings | VectorByCorridorsSettings, vis: SectionVisibility): ProjectColorEntry[] {
  if (!vis.teleports) return [];
  const rows = [
    PC.teleportEdge.at(s.teleportEdgeColor),
    PC.teleportEdgeBorder.at(s.teleportEdgeBorderColor),
  ];
  // The connector color's subsection is hidden entirely when no connector line is drawn.
  if (vis.teleportConnector) rows.push(PC.teleportConnector.at(s.teleportConnectorColor));
  // The floor-badge text color only has a settings subsection with a cross-floor teleport to badge.
  if (vis.crossFloorTeleports) {
    rows.push(PC.teleportBadgeFill.at(s.teleportFloorBadge.fillColor));
    rows.push(PC.teleportBadgeBorder.at(s.teleportFloorBadge.borderColor));
    rows.push(PC.teleportBadgeText.at(s.teleportFloorBadge.textColor));
  }
  // Per-group overrides the user has explicitly set (GitHub issue #503) — named by 1-based display
  // order, not the raw group key (an internal coordinate pair). Sorted the same way
  // `buildTeleportGroups` orders the panel's own group list (`key.localeCompare`) so a color's
  // "Group N" here always matches the row numbered N on the panel. Only applied while group
  // customization is on.
  const sortedGroupKeys = Object.keys(s.teleportGroupOverrides).sort((a, b) => a.localeCompare(b));
  if (vis.teleportGroupOverrides) sortedGroupKeys.forEach((key, index) => {
    const override = s.teleportGroupOverrides[key];
    if (override.fillColor !== undefined) {
      rows.push(PC.teleportGroup(index, "fill").at(override.fillColor));
    }
    if (override.borderColor !== undefined) {
      rows.push(PC.teleportGroup(index, "border").at(override.borderColor));
    }
  });
  return rows;
}

/** Abstract-style vertical marker colors — the plain `MarkerSettings` shape fields, hidden when
 *  `verticalStyle === "decorative"` (walls) and per-kind when the maze has no such connection. */
function verticalAbstractColors(
  s: VectorByWallsSettings | VectorByCorridorsSettings,
  vis: SectionVisibility,
): ProjectColorEntry[] {
  if (!vis.vertical) return [];
  const rows: ProjectColorEntry[] = [];
  if (vis.twoWayPassages) {
    rows.push(...markerColors(PC.twoWayFill, PC.twoWayBorder, s.twoWayPassageMarker));
    rows.push(PC.twoWayArrow.at(s.twoWayArrowColor));
  }
  if (vis.oneWayPassages) {
    rows.push(...markerColors(PC.oneWayFill, null, s.oneWayPassageMarker));
    rows.push(PC.oneWayAccent.at(s.oneWayAccentColor));
    rows.push(PC.oneWayArrow.at(s.oneWayArrowColor));
  }
  if (vis.elevators) {
    rows.push(...markerColors(PC.elevatorFill, PC.elevatorBorder, s.elevatorMarker));
    rows.push(PC.elevatorArrow.at(s.elevatorArrowColor));
  }
  return rows;
}

/** Elevator floor-badge colors — an independent layer drawn on top of the elevator marker in
 *  *both* vertical styles, so gated only on the elevator subsection being shown. */
function elevatorBadgeColors(s: VectorByWallsSettings | VectorByCorridorsSettings, vis: SectionVisibility): ProjectColorEntry[] {
  if (!vis.vertical || !vis.elevators) return [];
  return [
    PC.elevatorBadgeFill.at(s.elevatorBadges.fillColor),
    PC.elevatorBadgeText.at(s.elevatorBadges.textColor),
  ];
}

/** Walls-only decorative-style vertical line/arrow colors — shown only when
 *  `verticalStyle === "decorative"`, per-kind gated. */
function verticalDecorativeColors(s: VectorByWallsSettings, vis: SectionVisibility): ProjectColorEntry[] {
  if (!vis.vertical) return [];
  const rows: ProjectColorEntry[] = [];
  if (vis.twoWayPassages) {
    rows.push(PC.decorLineTwoWay.at(s.decorativeStairsTwoWay.lineColor));
    rows.push(PC.decorArrowTwoWay.at(s.decorativeStairsArrowColor));
  }
  if (vis.oneWayPassages) {
    rows.push(PC.decorLineOneWay.at(s.decorativeStairsOneWay.lineColor));
    rows.push(PC.decorAccentOneWay.at(s.decorativeStairsAccentColor));
  }
  if (vis.elevators) {
    rows.push(PC.decorLineElevator.at(s.decorativeElevator.lineColor));
  }
  return rows;
}

function markerIndexColors(s: VectorByWallsSettings | VectorByCorridorsSettings, vis: SectionVisibility): ProjectColorEntry[] {
  if (!vis.markerIndex) return [];
  const rows = [
    PC.markerIndexFill.at(s.markerIndex.fillColor),
    PC.markerIndexText.at(s.markerIndex.textColor),
  ];
  if (vis.markerIndexBorder) rows.push(PC.markerIndexBorder.at(s.markerIndex.borderColor));
  return rows;
}

function splitColors(splitNodeColors: number[], slotCount: number): ProjectColorEntry[] {
  const rows: ProjectColorEntry[] = [];
  for (let i = 0; i < slotCount; i++) {
    rows.push(PC.splitNode(i).at(splitNodeColors[i] ?? splitSlotColor(i, canvas.node.splitSlots)));
  }
  return rows;
}

function vectorByWallsColors(state: MazeState, s: VectorByWallsSettings, slotCount: number): ProjectColorEntry[] {
  const vis = sectionVisibility(state, s);
  return [
    PC.bgFill.at(s.background),
    ...(vis.grid ? [PC.bgGrid.at(s.gridColor)] : []),
    PC.tilesFloor.at(s.floorColor),
    ...(vis.wall ? [PC.tilesWall.at(s.wallColor)] : []),
    ...(vis.oneWayIndicator ? [PC.oneWaysMarker.at(s.oneWayColor)] : []),
    ...markerColors(PC.startFill, PC.startBorder, s.startMarker),
    ...markerColors(PC.finishFill, PC.finishBorder, s.finishMarker),
    ...teleportColors(s, vis),
    ...(s.verticalStyle === "abstract"
      ? verticalAbstractColors(s, vis)
      : verticalDecorativeColors(s, vis)),
    ...elevatorBadgeColors(s, vis),
    ...splitColors(s.splitNodeColors, slotCount),
    ...markerIndexColors(s, vis),
  ];
}

function vectorByCorridorsColors(state: MazeState, s: VectorByCorridorsSettings, slotCount: number): ProjectColorEntry[] {
  const vis = sectionVisibility(state, s);
  return [
    PC.bgFill.at(s.background),
    ...(vis.grid ? [PC.bgGrid.at(s.gridColor)] : []),
    PC.corridorFill.at(s.color),
    ...(vis.oneWayIndicator ? [PC.oneWaysMarker.at(s.oneWayColor)] : []),
    ...markerColors(PC.startFill, PC.startBorder, s.startMarker),
    ...markerColors(PC.finishFill, PC.finishBorder, s.finishMarker),
    ...teleportColors(s, vis),
    ...verticalAbstractColors(s, vis),
    ...elevatorBadgeColors(s, vis),
    ...splitColors(s.splitNodeColors, slotCount),
    ...markerIndexColors(s, vis),
  ];
}

/** Every color field of the export profile whose settings panel is currently open beside the
 *  canvas (`openRenderModeSettings`), each as a `{ name, color }` entry with a "Section: Role"
 *  name — GitHub issue #503. Returns `[]` when no export settings panel is open. Feeds the color
 *  picker's "Project colors" section. */
export function selectActiveProfileColors(state: MazeState): ProjectColorEntry[] {
  const slotCount = maxSplitNodeCount(state.nodes);
  if (state.openRenderModeSettings === "vector_by_walls") {
    return vectorByWallsColors(state, state.vectorByWallsSettings, slotCount);
  }
  if (state.openRenderModeSettings === "vector_by_corridors") {
    return vectorByCorridorsColors(state, state.vectorByCorridorsSettings, slotCount);
  }
  return [];
}

/** Apply a picker's uncommitted color to the active export profile. This deliberately returns a
 * cloned settings object: the color editor uses it to run export-warning rules while the user is
 * still dragging, without changing the store until Apply. */
export function overrideActiveProfileColor(
  state: MazeState,
  fieldName: string | undefined,
  color: number,
): VectorByWallsSettings | VectorByCorridorsSettings | null {
  if (!fieldName) return null;
  const source = state.openRenderModeSettings === "vector_by_walls" ? state.vectorByWallsSettings
    : state.openRenderModeSettings === "vector_by_corridors" ? state.vectorByCorridorsSettings : null;
  if (!source) return null;
  const settings = structuredClone(source) as VectorByWallsSettings | VectorByCorridorsSettings;
  const set = (field: ColorField, write: (value: number) => void) => {
    if (field.name() === fieldName) { write(color); return true; }
    return false;
  };
  const marker = (fill: ColorField, border: ColorField, value: MarkerSettings): boolean =>
    set(fill, (v) => { value.fillColor = v; }) || set(border, (v) => { value.borderColor = v; });
  // Decorative and abstract vertical arrows/accent share the same localized field names. Resolve
  // the active style before the abstract fields below, otherwise a decorative edit would update a
  // hidden abstract setting and export warnings would evaluate the wrong color.
  if ("decorativeStairsArrowColor" in settings && settings.verticalStyle === "decorative") {
    if (set(PC.decorArrowTwoWay, (v) => { settings.decorativeStairsArrowColor = v; }) ||
        set(PC.decorAccentOneWay, (v) => { settings.decorativeStairsAccentColor = v; })) return settings;
  }
  if (set(PC.bgFill, (v) => { settings.background = v; }) || set(PC.bgGrid, (v) => { settings.gridColor = v; }) ||
      set(PC.corridorFill, (v) => { if ("color" in settings) settings.color = v; }) ||
      set(PC.tilesFloor, (v) => { if ("floorColor" in settings) settings.floorColor = v; }) ||
      set(PC.tilesWall, (v) => { if ("wallColor" in settings) settings.wallColor = v; }) ||
      set(PC.oneWaysMarker, (v) => { settings.oneWayColor = v; }) ||
      marker(PC.startFill, PC.startBorder, settings.startMarker) || marker(PC.finishFill, PC.finishBorder, settings.finishMarker) ||
      set(PC.teleportEdge, (v) => { settings.teleportEdgeColor = v; }) || set(PC.teleportEdgeBorder, (v) => { settings.teleportEdgeBorderColor = v; }) ||
      set(PC.teleportConnector, (v) => { settings.teleportConnectorColor = v; }) ||
      set(PC.teleportBadgeFill, (v) => { settings.teleportFloorBadge.fillColor = v; }) || set(PC.teleportBadgeBorder, (v) => { settings.teleportFloorBadge.borderColor = v; }) || set(PC.teleportBadgeText, (v) => { settings.teleportFloorBadge.textColor = v; }) ||
      marker(PC.twoWayFill, PC.twoWayBorder, settings.twoWayPassageMarker) || set(PC.twoWayArrow, (v) => { settings.twoWayArrowColor = v; }) ||
      marker(PC.oneWayFill, PC.oneWayFill, settings.oneWayPassageMarker) || set(PC.oneWayAccent, (v) => { settings.oneWayAccentColor = v; }) || set(PC.oneWayArrow, (v) => { settings.oneWayArrowColor = v; }) ||
      marker(PC.elevatorFill, PC.elevatorBorder, settings.elevatorMarker) || set(PC.elevatorArrow, (v) => { settings.elevatorArrowColor = v; }) ||
      set(PC.elevatorBadgeFill, (v) => { settings.elevatorBadges.fillColor = v; }) || set(PC.elevatorBadgeText, (v) => { settings.elevatorBadges.textColor = v; }) ||
      set(PC.markerIndexFill, (v) => { settings.markerIndex.fillColor = v; }) || set(PC.markerIndexText, (v) => { settings.markerIndex.textColor = v; }) || set(PC.markerIndexBorder, (v) => { settings.markerIndex.borderColor = v; })) return settings;
  // Split colors are sparse overrides: an untouched profile keeps `splitNodeColors` empty and
  // falls back to the live canvas palette. The color picker still exposes every slot present in
  // the maze, so resolve those dynamic fields against the maze's split count rather than the
  // override array's current length (otherwise picker previews for default split colors never
  // reach the warning computation).
  for (let i = 0; i < maxSplitNodeCount(state.nodes); i++) {
    if (set(PC.splitNode(i), (v) => { settings.splitNodeColors[i] = v; })) return settings;
  }
  if ("verticalStyle" in settings) {
    if (set(PC.decorLineTwoWay, (v) => { settings.decorativeStairsTwoWay.lineColor = v; }) || set(PC.decorLineOneWay, (v) => { settings.decorativeStairsOneWay.lineColor = v; }) || set(PC.decorLineElevator, (v) => { settings.decorativeElevator.lineColor = v; }) || set(PC.decorArrowTwoWay, (v) => { settings.decorativeStairsArrowColor = v; }) || set(PC.decorAccentOneWay, (v) => { settings.decorativeStairsAccentColor = v; })) return settings;
  }
  const groupKeys = Object.keys(settings.teleportGroupOverrides).sort((a, b) => a.localeCompare(b));
  for (let i = 0; i < groupKeys.length; i++) {
    const override = settings.teleportGroupOverrides[groupKeys[i]];
    if (override.fillColor !== undefined && set(PC.teleportGroup(i, "fill"), (v) => { override.fillColor = v; })) return settings;
    if (override.borderColor !== undefined && set(PC.teleportGroup(i, "border"), (v) => { override.borderColor = v; })) return settings;
  }
  return settings;
}
