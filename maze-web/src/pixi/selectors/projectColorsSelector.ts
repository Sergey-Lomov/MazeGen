import type { MazeState } from "../../store/storeTypes";
import {
  splitNodeKey, teleportGroupKey,
  type ColorFieldKey, type StaticColorFieldKey, type TeleportGroupColorRole,
} from "../colorFieldKeys";
import {
  buildColorVisibility, isColorFieldVisible, visibleColor, writeColorField, STATIC_FIELD_DEFS, STATIC_FIELD_ORDER,
  type ColorVisibilityContext, type ExportSettings, type Visible,
} from "./colorFieldRegistry";

export { buildColorVisibility };
export type { ColorVisibilityContext, ColorVisibilityMaze } from "./colorFieldRegistry";
import * as m from "~/paraglide/messages";

/** One color field of an export profile, surfaced in the color picker's "Project colors" section
 *  (GitHub issue #503). `name` is a human-readable "Section: Role" label (the word "color" left
 *  out — every row is a color). If one color value is used by several fields, each field is still
 *  its own entry. */
export interface ProjectColorEntry {
  /** Stable {@link ColorField.key} of the field this row belongs to (a synthetic key for rows that
   *  are not registry fields, e.g. the picker's "Default" row). */
  key: string;
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
  | "marker_index"
  | "vertical"
  | "shared_style";

type RoleKey =
  | "fill"
  | "grid"
  | "inner_grid"
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
  | "badges_border"
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
  vertical: m["color_picker.entry.section.vertical_shared_style"],
  shared_style: m["color_picker.entry.section.shared_style"],
};

const roleLabel: Record<Exclude<RoleKey, "split_node">, () => string> = {
  fill: m["color_picker.entry.role.fill"],
  grid: m["color_picker.entry.role.grid"],
  inner_grid: m["color_picker.entry.role.inner_grid"],
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
  badges_border: m["color_picker.entry.role.badges_border"],
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
 *  for the picker's row and header; `.key` is the stable identity (self-row exclusion, warnings, preview);
 *  `.at(color)` pairs the name with a concrete color value for a `priorityColors` / list entry.
 *  Every name in the whole feature comes from {@link PC}, so a call site can't spell "Section:
 *  Role" a different way than `selectActiveProfileColors` does. */
export interface ColorField {
  /** Stable identity (never translated). Warnings, the picker's live preview and self-row
   *  exclusion all refer to a field by this key, never by its display name. Static fields use their
   *  {@link PC} property name; dynamic ones `splitNode:<i>` / `teleportGroup:<i>:<role>`. */
  key: ColorFieldKey;
  name: () => string;
  at: (color: number) => ProjectColorEntry;
  /** Single source of truth for "is this color shown/drawn" — whether the settings panel offers
   *  the row, the "Project colors" list lists it and export warnings may mention it. */
  isVisible: (ctx: ColorVisibilityContext) => boolean;
}

type FieldDef = [SectionKey[], Exclude<RoleKey, "split_node">];

function makeField(key: ColorFieldKey, name: () => string, isVisible: Visible): ColorField {
  return { key, name, at: (color) => ({ key, name: name(), color }), isVisible };
}


/** Builds one {@link ColorField} per entry, keyed by the entry's own property name. */
function defineFields(defs: Record<StaticColorFieldKey, FieldDef>): Record<StaticColorFieldKey, ColorField> {
  const result = {} as Record<StaticColorFieldKey, ColorField>;
  for (const key of Object.keys(defs) as StaticColorFieldKey[]) {
    const [sections, role] = defs[key];
    result[key] = makeField(key, () => buildName(sections, role), STATIC_FIELD_DEFS[key].visible);
  }
  return result;
}

const STATIC_FIELDS = defineFields({
  bgFill: [["background"], "fill"],
  bgGrid: [["background"], "grid"],
  innerGrid: [["background"], "inner_grid"],

  corridorFill: [["corridor"], "fill"],

  tilesFloor: [["tiles"], "floor"],
  tilesWall: [["tiles"], "wall"],

  oneWaysMarker: [["one_ways"], "one_way_line"],

  startFill: [["start"], "fill"],
  startBorder: [["start"], "border"],
  startText: [["start"], "text"],
  finishFill: [["finish"], "fill"],
  finishBorder: [["finish"], "border"],
  finishText: [["finish"], "text"],

  teleportEdge: [["teleports"], "edge"],
  teleportEdgeBorder: [["teleports"], "edge_border"],
  teleportConnector: [["teleports"], "connector"],
  teleportBadgeFill: [["teleports"], "badge_fill"],
  teleportBadgeBorder: [["teleports"], "badge_border"],
  teleportBadgeText: [["teleports"], "badge_text"],

  // Decorative-style vertical connection line colors (one per sub-group).
  decorLineTwoWay: [["tiles"], "line"],
  decorLineOneWay: [["one_ways"], "line"],
  decorLineElevator: [["elevator"], "line"],
  // Decorative-style vertical connection arrow colors — deliberately different sections than the
  // abstract two-way/one-way arrow fields below (`twoWayArrow`/`oneWayArrow`) so the two pairs read
  // as distinct rows in the "Project colors" list.
  decorArrowTwoWay: [["tiles"], "arrow"],
  decorArrowOneWay: [["one_ways"], "arrow"],

  // "Vertical connections" section's own "Shared style" colors (GitHub issue #668) — the
  // panel-level analogue of `twoWayFill`/`twoWayArrow` etc., one section up: these feed the three
  // marker groups' overlapping fields via disabled-by-default links rather than being drawn
  // themselves.
  // GitHub issue #701 — "Shared style" > "Markers" fill / border sources.
  sharedMarkerFill: [["shared_style"], "fill"],
  sharedMarkerBorder: [["shared_style"], "border"],

  verticalFill: [["vertical"], "fill"],
  verticalArrow: [["vertical"], "arrow"],
  verticalDecorLine: [["vertical"], "line"],

  twoWayFill: [["two_way"], "fill"],
  twoWayBorder: [["two_way"], "border"],
  twoWayArrow: [["two_way"], "arrow"],

  oneWayFill: [["one_way"], "fill"],
  oneWayBorder: [["one_way"], "border"],
  oneWayArrow: [["one_way"], "arrow"],

  elevatorFill: [["elevator"], "fill"],
  elevatorBorder: [["elevator"], "border"],
  elevatorArrow: [["elevator"], "arrow"],
  elevatorBadgeFill: [["elevator"], "badges_fill"],
  elevatorBadgeBorder: [["elevator"], "badges_border"],
  elevatorBadgeText: [["elevator"], "badges_text"],

  markerIndexFill: [["marker_index"], "fill"],
  markerIndexText: [["marker_index"], "text"],
  markerIndexBorder: [["marker_index"], "border"],
});

/** The registry of every project-color field (GitHub issue #503). Static fields are keyed by their
 *  property name here; each value carries a stable `key`, the "Section: Role" label and an
 *  `.at(color)` entry builder. Split-node slots and per-group teleport overrides are dynamic —
 *  {@link PC.splitNode} / {@link PC.teleportGroup} build the field for a slot (0-based). Use
 *  {@link resolveColorField} to get a field back from its `key`. */
export const PC = {
  ...STATIC_FIELDS,

  splitNode(index: number): ColorField {
    return makeField(
      splitNodeKey(index),
      () => `${sectionLabel.splits()}: ${m["color_picker.entry.role.split_node"]({ index: String(index + 1) })}`,
      (c) => isColorFieldVisible(splitNodeKey(index), c),
    );
  },

  /** A per-teleport-group override color, named by the group's 1-based display order (its raw key
   *  is an internal coordinate pair, not a human-facing name) — same dynamic-slot convention as
   *  {@link splitNode}. */
  teleportGroup(index: number, role: TeleportGroupColorRole): ColorField {
    const label = role === "fill" ? m["color_picker.entry.role.teleport_group_fill"] : m["color_picker.entry.role.teleport_group_border"];
    return makeField(teleportGroupKey(index, role), () => `${sectionLabel.teleports()}: ${label({ index: String(index + 1) })}`, (c) => isColorFieldVisible(teleportGroupKey(index, role), c));
  },
} as const;

/** Inverse of {@link ColorField.key}: the registry field for a key, or `null` for an unknown one. */
export function resolveColorField(key: string): ColorField | null {
  const fixed = (STATIC_FIELDS as Record<string, ColorField>)[key];
  if (fixed) return fixed;
  const split = /^splitNode:(\d+)$/.exec(key);
  if (split) return PC.splitNode(Number(split[1]));
  const group = /^teleportGroup:(\d+):(fill|border)$/.exec(key);
  if (group) return PC.teleportGroup(Number(group[1]), group[2] as TeleportGroupColorRole);
  return null;
}

/** Per-group overrides the user has explicitly set (GitHub issue #503) — named by 1-based display
 *  order, not the raw group key (an internal coordinate pair). Sorted the same way
 *  `buildTeleportGroups` orders the panel's own group list (`key.localeCompare`) so a color's
 *  "Group N" here always matches the row numbered N on the panel. */
function teleportGroupRows(ctx: ColorVisibilityContext): ProjectColorEntry[] {
  const rows: ProjectColorEntry[] = [];
  const overrides = ctx.settings.teleportGroupOverrides;
  Object.keys(overrides).sort((a, b) => a.localeCompare(b)).forEach((key, index) => {
    for (const role of ["fill", "border"] as const) {
      const color = role === "fill" ? overrides[key].fillColor : overrides[key].borderColor;
      const field = PC.teleportGroup(index, role);
      if (color !== undefined && field.isVisible(ctx)) rows.push(field.at(color));
    }
  });
  return rows;
}

function splitRows(ctx: ColorVisibilityContext): ProjectColorEntry[] {
  const rows: ProjectColorEntry[] = [];
  for (let i = 0; i < ctx.slotCount; i++) {
    const field = PC.splitNode(i);
    const color = visibleColor(ctx, field.key);
    if (color) rows.push(field.at(color.value));
  }
  return rows;
}

function staticRows(ctx: ColorVisibilityContext, keys: readonly StaticColorFieldKey[]): ProjectColorEntry[] {
  const rows: ProjectColorEntry[] = [];
  for (const key of keys) {
    const color = visibleColor(ctx, key);
    if (color) rows.push(PC[key].at(color.value));
  }
  return rows;
}

/** The "Project colors" list: display order from {@link STATIC_FIELD_ORDER}, membership and values
 *  from the registry alone. */
function profileColors(ctx: ColorVisibilityContext): ProjectColorEntry[] {
  const [beforeGroups, beforeSplits, afterSplits] = STATIC_FIELD_ORDER;
  return [
    ...staticRows(ctx, beforeGroups),
    ...teleportGroupRows(ctx),
    ...staticRows(ctx, beforeSplits),
    ...splitRows(ctx),
    ...staticRows(ctx, afterSplits),
  ];
}

/** Every color field of the export profile whose settings panel is currently open beside the
 *  canvas (`openRenderModeSettings`), each as a `{ name, color }` entry with a "Section: Role"
 *  name — GitHub issue #503. Returns `[]` when no export settings panel is open. Feeds the color
 *  picker's "Project colors" section. */
export function selectActiveProfileColors(state: MazeState): ProjectColorEntry[] {
  const settings = activeProfileSettings(state);
  if (!settings) return [];
  return profileColors(buildColorVisibility(state, settings));
}

/** The export profile whose settings panel is open beside the canvas, or `null`. */
function activeProfileSettings(state: MazeState): ExportSettings | null {
  if (state.openRenderModeSettings === "vector_by_walls") return state.vectorByWallsSettings;
  if (state.openRenderModeSettings === "vector_by_corridors") return state.vectorByCorridorsSettings;
  return null;
}

/** Apply a picker's uncommitted color to the active export profile. This deliberately returns a
 * cloned settings object: the color editor uses it to run export-warning rules while the user is
 * still dragging, without changing the store until Apply. */
export function overrideActiveProfileColor(
  state: MazeState,
  fieldKey: string | undefined,
  color: number,
): ExportSettings | null {
  if (!fieldKey) return null;
  const source = activeProfileSettings(state);
  if (!source) return null;
  const settings = structuredClone(source);
  writeColorField(buildColorVisibility(state, source), settings, fieldKey, color);
  return settings;
}
