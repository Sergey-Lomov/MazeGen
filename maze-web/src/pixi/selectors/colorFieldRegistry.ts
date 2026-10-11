import type { MazeState } from "../../store/storeTypes";
import { withResolvedGroupOverrides } from "../../store/teleportGroupLinks";
import type { VectorByWallsSettings, VectorByCorridorsSettings } from "../../store/imageExportTypes";
import type { EdgeDto } from "../../wasm/types";
import { splitSlotColor } from "../colorUtils";
import { canvas } from "../colorTokens";
import { parseColorFieldKey, type ColorFieldKey, type StaticColorFieldKey } from "../colorFieldKeys";
import { maxSplitNodeCount } from "./mazeSelectors";
import { hasCrossFloorTeleport } from "./mazeSelectors/teleport";

// The single source of truth for *what a color field is*, minus its display name: when it is
// visible, where its value lives in the settings, and where an edit writes back (GitHub issue
// #717). i18n-free on purpose — `exportWarnings.ts` reads colors through here and must not pull in
// paraglide. The settings panels, the "Project colors" list, the picker's live preview and the
// export warnings all derive from this module; none of them reads a color field's settings value
// or its visibility on its own.
//
// Compile-time guard: a color can only reach a warning as a {@link VisibleColor}, and the only
// way to mint one is {@link visibleColor} (checks visibility). A warning about a hidden field
// therefore cannot be written — raw `settings.xColor` numbers do not type-check there.

export type ExportSettings = VectorByWallsSettings | VectorByCorridorsSettings;

/** Everything a field's predicate may read: which export-panel sections are actually shown for the
 *  current maze plus the settings that gate individual rows. Built once per maze/settings pair by
 *  {@link buildColorVisibility} from the *unscoped* project-wide `nodes`/`edges`/`floors` (so the
 *  answer doesn't change on a floor switch). */
export interface ColorVisibilityContext {
  settings: ExportSettings;
  /** `"walls"` for Vector by walls, `"corridors"` for Vector by corridors. */
  mode: "walls" | "corridors";
  /** Number of split-node color slots (largest split node's arity). */
  slotCount: number;
  grid: boolean;
  /** `wallColor` — hidden when the random-wall-color palette replaces the single wall color. */
  wall: boolean;
  innerGrid: boolean;
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
  /** `"decorative"` only exists in Vector by walls; corridors always draw the abstract style. */
  verticalStyle: "abstract" | "decorative";
  /** The maze has at least one marker that could ever show an index (teleport, vertical passage
   *  or elevator) — independent of the coverage settings. The whole "Marker indices" section is
   *  hidden without it. */
  markerIndexAvailable: boolean;
  /** The "Marker indices" layer's colors — hidden when the section is hidden or the layer is disabled. */
  markerIndex: boolean;
  /** `markerIndex.borderColor` — hidden when the plate border color follows the marker. */
  markerIndexBorder: boolean;
}

function hasDirectionalBasicEdge(edges: EdgeDto[]): boolean {
  const basic = edges.filter((e) => e.kind === "basic");
  const forward = new Set(basic.map((e) => `${e.from}->${e.to}`));
  return basic.some((e) => !forward.has(`${e.to}->${e.from}`));
}

function verticalVisibility(edges: EdgeDto[], replaceTwoFloorElevatorsWithStairs: boolean) {
  const passageEdges = edges.filter((e) => e.kind === "vertical_passage");
  const forward = new Set(passageEdges.map((e) => `${e.from}->${e.to}`));
  const oneWayPassages = passageEdges.some((e) => !forward.has(`${e.to}->${e.from}`));
  const elevators = edges.some((e) => e.kind === "elevator");
  const twoWayPassages =
    passageEdges.some((e) => forward.has(`${e.to}->${e.from}`)) ||
    (replaceTwoFloorElevatorsWithStairs && elevators);
  return { twoWayPassages, oneWayPassages, elevators };
}

/** Project-wide input of {@link buildColorVisibility} — the unscoped maze graph. */
export interface ColorVisibilityMaze {
  nodes: MazeState["nodes"];
  edges: EdgeDto[];
  floors: MazeState["floors"];
}

export function buildColorVisibility(maze: ColorVisibilityMaze, rawSettings: ExportSettings): ColorVisibilityContext {
  const s = withResolvedGroupOverrides(rawSettings);
  const { twoWayPassages, oneWayPassages, elevators } = verticalVisibility(maze.edges, s.replaceTwoFloorElevatorsWithStairs);
  const walls = "verticalStyle" in s;
  const teleports = maze.edges.some((e) => e.kind === "teleport");
  const markerIndexAvailable = teleports || elevators || maze.edges.some((e) => e.kind === "vertical_passage");
  return {
    settings: s,
    mode: walls ? "walls" : "corridors",
    slotCount: maxSplitNodeCount(maze.nodes),
    grid: s.showGrid,
    innerGrid: "showInnerGrid" in s && s.showInnerGrid,
    wall: !("randomWallColorMode" in s) || s.randomWallColorMode === "off",
    oneWayIndicator: hasDirectionalBasicEdge(maze.edges),
    teleports,
    crossFloorTeleports: hasCrossFloorTeleport(maze.nodes, maze.edges),
    teleportConnector: s.teleportConnectorStyle !== "none",
    teleportGroupOverrides: s.teleportGroupCustomization,
    twoWayPassages,
    oneWayPassages,
    elevators,
    vertical: twoWayPassages || oneWayPassages || elevators || maze.floors.length > 1,
    verticalStyle: walls ? (s as VectorByWallsSettings).verticalStyle : "abstract",
    markerIndexAvailable,
    markerIndex: markerIndexAvailable && s.markerIndex.enabled,
    markerIndexBorder: !s.markerIndex.borderColorFromMarker,
  };
}

export type Visible = (ctx: ColorVisibilityContext) => boolean;

/** Layout-level conditions of the export panel — sections that hold color rows next to other
 *  controls. A panel gates such a block through `LayoutGate` (never on `settings.*` directly) and
 *  the color predicates below build on the same entries, so a block and the colors inside it can't
 *  disagree about whether they are shown. */
export const LAYOUT_GATES = {
  /** "Vertical connections" drawn in the decorative style (Vector by walls only). */
  verticalDecorative: (c) => c.mode === "walls" && c.vertical && c.verticalStyle === "decorative",
  /** "Vertical connections" drawn in the abstract style. */
  verticalAbstract: (c) => c.vertical && c.verticalStyle === "abstract",
} satisfies Record<string, Visible>;

export type LayoutGateKey = keyof typeof LAYOUT_GATES;

export function isLayoutGateOpen(gate: LayoutGateKey, ctx: ColorVisibilityContext): boolean {
  return LAYOUT_GATES[gate](ctx);
}

const always: Visible = () => true;
const twoWayAbstract: Visible = (c) => LAYOUT_GATES.verticalAbstract(c) && c.twoWayPassages;
const oneWayAbstract: Visible = (c) => LAYOUT_GATES.verticalAbstract(c) && c.oneWayPassages;
const elevatorAbstract: Visible = (c) => LAYOUT_GATES.verticalAbstract(c) && c.elevators;
const twoWayDecor: Visible = (c) => LAYOUT_GATES.verticalDecorative(c) && c.twoWayPassages;
const oneWayDecor: Visible = (c) => LAYOUT_GATES.verticalDecorative(c) && c.oneWayPassages;
const elevatorDecor: Visible = (c) => LAYOUT_GATES.verticalDecorative(c) && c.elevators;
const elevatorBadge: Visible = (c) => c.vertical && c.elevators && c.settings.elevatorBadges.enabled;
const abstractShared: Visible = LAYOUT_GATES.verticalAbstract;

/** Everything the system knows about one static color field except its display name. */
export interface ColorFieldDef {
  /** Is the field shown/drawn under the context — see {@link ColorVisibilityContext}. */
  visible: Visible;
  /** The color currently stored for the field, or `undefined` when it has none (e.g. an unset
   *  start/finish caption color, or a walls-only field read from a corridors profile). */
  get: (s: ExportSettings) => number | undefined;
  /** Writes an edit back into `s` (a clone owned by the caller). */
  set: (s: ExportSettings, color: number) => void;
}

/** The registry of every static color field. A `Record` over {@link StaticColorFieldKey}: adding a
 *  key without a definition (visibility, getter, setter) does not compile. */
export const STATIC_FIELD_DEFS: Record<StaticColorFieldKey, ColorFieldDef> = {
  bgFill: { visible: always, get: (s) => s.background, set: (s, v) => { s.background = v; } },
  bgGrid: { visible: (c) => c.grid, get: (s) => s.gridColor, set: (s, v) => { s.gridColor = v; } },
  innerGrid: {
    visible: (c) => c.mode === "walls" && c.innerGrid,
    get: (s) => ("innerGridColor" in s ? s.innerGridColor : undefined),
    set: (s, v) => { if ("innerGridColor" in s) s.innerGridColor = v; },
  },

  corridorFill: {
    visible: (c) => c.mode === "corridors",
    get: (s) => ("color" in s ? s.color : undefined),
    set: (s, v) => { if ("color" in s) s.color = v; },
  },

  tilesFloor: {
    visible: (c) => c.mode === "walls",
    get: (s) => ("floorColor" in s ? s.floorColor : undefined),
    set: (s, v) => { if ("floorColor" in s) s.floorColor = v; },
  },
  tilesWall: {
    visible: (c) => c.mode === "walls" && c.wall,
    get: (s) => ("wallColor" in s ? s.wallColor : undefined),
    set: (s, v) => { if ("wallColor" in s) s.wallColor = v; },
  },

  oneWaysMarker: { visible: (c) => c.oneWayIndicator, get: (s) => s.oneWayColor, set: (s, v) => { s.oneWayColor = v; } },

  startFill: { visible: always, get: (s) => s.startMarker.fillColor, set: (s, v) => { s.startMarker.fillColor = v; } },
  startBorder: { visible: always, get: (s) => s.startMarker.borderColor, set: (s, v) => { s.startMarker.borderColor = v; } },
  startText: {
    visible: (c) => c.settings.startMarker.textEnabled !== false,
    get: (s) => s.startMarker.textColor,
    set: (s, v) => { s.startMarker.textColor = v; },
  },
  finishFill: { visible: always, get: (s) => s.finishMarker.fillColor, set: (s, v) => { s.finishMarker.fillColor = v; } },
  finishBorder: { visible: always, get: (s) => s.finishMarker.borderColor, set: (s, v) => { s.finishMarker.borderColor = v; } },
  finishText: {
    visible: (c) => c.settings.finishMarker.textEnabled !== false,
    get: (s) => s.finishMarker.textColor,
    set: (s, v) => { s.finishMarker.textColor = v; },
  },

  teleportEdge: { visible: (c) => c.teleports, get: (s) => s.teleportMarker.fillColor, set: (s, v) => { s.teleportMarker.fillColor = v; } },
  teleportEdgeBorder: { visible: (c) => c.teleports, get: (s) => s.teleportMarker.borderColor, set: (s, v) => { s.teleportMarker.borderColor = v; } },
  teleportConnector: {
    visible: (c) => c.teleports && c.teleportConnector,
    get: (s) => s.teleportConnectorColor,
    set: (s, v) => { s.teleportConnectorColor = v; },
  },
  teleportBadgeFill: {
    visible: (c) => c.teleports && c.crossFloorTeleports,
    get: (s) => s.teleportFloorBadge.fillColor,
    set: (s, v) => { s.teleportFloorBadge.fillColor = v; },
  },
  teleportBadgeBorder: {
    visible: (c) => c.teleports && c.crossFloorTeleports,
    get: (s) => s.teleportFloorBadge.borderColor,
    set: (s, v) => { s.teleportFloorBadge.borderColor = v; },
  },
  teleportBadgeText: {
    visible: (c) => c.teleports && c.crossFloorTeleports,
    get: (s) => s.teleportFloorBadge.textColor,
    set: (s, v) => { s.teleportFloorBadge.textColor = v; },
  },

  // Decorative-style vertical connection colors (Vector by walls only).
  decorLineTwoWay: {
    visible: twoWayDecor,
    get: (s) => ("decorativeStairsTwoWay" in s ? s.decorativeStairsTwoWay.lineColor : undefined),
    set: (s, v) => { if ("decorativeStairsTwoWay" in s) s.decorativeStairsTwoWay.lineColor = v; },
  },
  decorLineOneWay: {
    visible: oneWayDecor,
    get: (s) => ("decorativeStairsOneWay" in s ? s.decorativeStairsOneWay.lineColor : undefined),
    set: (s, v) => { if ("decorativeStairsOneWay" in s) s.decorativeStairsOneWay.lineColor = v; },
  },
  decorLineElevator: {
    visible: elevatorDecor,
    get: (s) => ("decorativeElevator" in s ? s.decorativeElevator.lineColor : undefined),
    set: (s, v) => { if ("decorativeElevator" in s) s.decorativeElevator.lineColor = v; },
  },
  decorArrowTwoWay: {
    visible: twoWayDecor,
    get: (s) => ("decorativeStairsArrowColor" in s ? s.decorativeStairsArrowColor : undefined),
    set: (s, v) => { if ("decorativeStairsArrowColor" in s) s.decorativeStairsArrowColor = v; },
  },
  decorArrowOneWay: {
    visible: oneWayDecor,
    get: (s) => ("decorativeStairsOneWayArrowColor" in s ? s.decorativeStairsOneWayArrowColor : undefined),
    set: (s, v) => { if ("decorativeStairsOneWayArrowColor" in s) s.decorativeStairsOneWayArrowColor = v; },
  },

  // GitHub issue #701 — "Shared style" > "Markers" fill / border sources.
  sharedMarkerFill: { visible: always, get: (s) => s.markerFillColor, set: (s, v) => { s.markerFillColor = v; } },
  sharedMarkerBorder: { visible: always, get: (s) => s.markerBorderColor, set: (s, v) => { s.markerBorderColor = v; } },

  // "Vertical connections" section's own "Shared style" colors (GitHub issue #668).
  verticalFill: { visible: abstractShared, get: (s) => s.verticalFillColor, set: (s, v) => { s.verticalFillColor = v; } },
  verticalArrow: { visible: abstractShared, get: (s) => s.verticalArrowColor, set: (s, v) => { s.verticalArrowColor = v; } },
  verticalDecorLine: {
    visible: LAYOUT_GATES.verticalDecorative,
    get: (s) => ("verticalDecorativeLineColor" in s ? s.verticalDecorativeLineColor : undefined),
    set: (s, v) => { if ("verticalDecorativeLineColor" in s) s.verticalDecorativeLineColor = v; },
  },

  twoWayFill: { visible: twoWayAbstract, get: (s) => s.twoWayPassageMarker.fillColor, set: (s, v) => { s.twoWayPassageMarker.fillColor = v; } },
  twoWayBorder: { visible: twoWayAbstract, get: (s) => s.twoWayPassageMarker.borderColor, set: (s, v) => { s.twoWayPassageMarker.borderColor = v; } },
  twoWayArrow: { visible: twoWayAbstract, get: (s) => s.twoWayArrowColor, set: (s, v) => { s.twoWayArrowColor = v; } },
  oneWayFill: { visible: oneWayAbstract, get: (s) => s.oneWayPassageMarker.fillColor, set: (s, v) => { s.oneWayPassageMarker.fillColor = v; } },
  oneWayBorder: { visible: oneWayAbstract, get: (s) => s.oneWayPassageMarker.borderColor, set: (s, v) => { s.oneWayPassageMarker.borderColor = v; } },
  oneWayArrow: { visible: oneWayAbstract, get: (s) => s.oneWayArrowColor, set: (s, v) => { s.oneWayArrowColor = v; } },
  elevatorFill: { visible: elevatorAbstract, get: (s) => s.elevatorMarker.fillColor, set: (s, v) => { s.elevatorMarker.fillColor = v; } },
  elevatorBorder: { visible: elevatorAbstract, get: (s) => s.elevatorMarker.borderColor, set: (s, v) => { s.elevatorMarker.borderColor = v; } },
  elevatorArrow: { visible: elevatorAbstract, get: (s) => s.elevatorArrowColor, set: (s, v) => { s.elevatorArrowColor = v; } },
  elevatorBadgeFill: { visible: elevatorBadge, get: (s) => s.elevatorBadges.fillColor, set: (s, v) => { s.elevatorBadges.fillColor = v; } },
  elevatorBadgeBorder: { visible: elevatorBadge, get: (s) => s.elevatorBadges.borderColor, set: (s, v) => { s.elevatorBadges.borderColor = v; } },
  elevatorBadgeText: { visible: elevatorBadge, get: (s) => s.elevatorBadges.textColor, set: (s, v) => { s.elevatorBadges.textColor = v; } },

  markerIndexFill: { visible: (c) => c.markerIndex, get: (s) => s.markerIndex.fillColor, set: (s, v) => { s.markerIndex.fillColor = v; } },
  markerIndexText: { visible: (c) => c.markerIndex, get: (s) => s.markerIndex.textColor, set: (s, v) => { s.markerIndex.textColor = v; } },
  markerIndexBorder: {
    visible: (c) => c.markerIndex && c.markerIndexBorder,
    get: (s) => s.markerIndex.borderColor,
    set: (s, v) => { s.markerIndex.borderColor = v; },
  },
};

/** Display order of the "Project colors" list, split around the two dynamic groups (per-group
 *  teleport overrides after the first table, split-node slots after the second). Every static key
 *  appears in exactly one table — enforced by a test. */
export const STATIC_FIELD_ORDER: readonly (readonly StaticColorFieldKey[])[] = [
  [
    "bgFill", "bgGrid", "innerGrid", "corridorFill", "tilesFloor", "tilesWall", "oneWaysMarker",
    "sharedMarkerFill", "sharedMarkerBorder",
    "startFill", "startBorder", "startText", "finishFill", "finishBorder", "finishText",
    "teleportEdge", "teleportEdgeBorder", "teleportConnector",
    "teleportBadgeFill", "teleportBadgeBorder", "teleportBadgeText",
  ],
  [
    "verticalDecorLine", "verticalFill", "verticalArrow",
    "twoWayFill", "twoWayBorder", "twoWayArrow",
    "oneWayFill", "oneWayBorder", "oneWayArrow",
    "elevatorFill", "elevatorBorder", "elevatorArrow",
    "decorLineTwoWay", "decorArrowTwoWay", "decorLineOneWay", "decorArrowOneWay", "decorLineElevator",
    "elevatorBadgeFill", "elevatorBadgeBorder", "elevatorBadgeText",
  ],
  ["markerIndexFill", "markerIndexText", "markerIndexBorder"],
];

declare const visibleColorBrand: unique symbol;

/** A color that was read through the registry while its field was visible. The only way to obtain
 *  one is {@link visibleColor} / {@link unownedColor}; export warnings accept nothing else. */
export interface VisibleColor {
  readonly [visibleColorBrand]: true;
  readonly value: number;
  /** The field the color is edited in, or `null` for {@link unownedColor}. */
  readonly field: ColorFieldKey | null;
}

function mint(value: number, field: ColorFieldKey | null): VisibleColor {
  return { value, field } as VisibleColor;
}

/** The sorted override keys define a teleport group's 0-based display index (same order the picker's
 *  list and `buildTeleportGroups` use). */
function sortedGroupKeys(ctx: ColorVisibilityContext): string[] {
  return Object.keys(ctx.settings.teleportGroupOverrides).sort((a, b) => a.localeCompare(b));
}

/** Raw stored value of any field (static or dynamic) — module-private so visibility cannot be
 *  skipped by callers. */
function rawValue(ctx: ColorVisibilityContext, key: ColorFieldKey): number | undefined {
  const s = ctx.settings;
  const parsed = parseColorFieldKey(key);
  switch (parsed.kind) {
    // Split colors are sparse overrides; an untouched slot falls back to the canvas palette.
    case "split": return s.splitNodeColors[parsed.index] ?? splitSlotColor(parsed.index, canvas.node.splitSlots);
    case "teleportGroup": {
      const override = s.teleportGroupOverrides[sortedGroupKeys(ctx)[parsed.index]];
      return parsed.role === "fill" ? override?.fillColor : override?.borderColor;
    }
    case "static": return STATIC_FIELD_DEFS[parsed.key]?.get(s);
  }
}

/** Whether the field `key` (static or dynamic) is visible under `ctx`. */
export function isColorFieldVisible(key: ColorFieldKey, ctx: ColorVisibilityContext): boolean {
  const parsed = parseColorFieldKey(key);
  switch (parsed.kind) {
    case "split": return parsed.index < ctx.slotCount;
    case "teleportGroup": return ctx.teleports && ctx.teleportGroupOverrides;
    case "static": {
      const def = STATIC_FIELD_DEFS[parsed.key];
      return def !== undefined && def.visible(ctx);
    }
  }
}

/** The field's color, or `null` when the field is hidden or has no value. The only door through
 *  which export warnings obtain a color. */
export function visibleColor(ctx: ColorVisibilityContext, key: ColorFieldKey): VisibleColor | null {
  if (!isColorFieldVisible(key, ctx)) return null;
  const value = rawValue(ctx, key);
  return value === undefined ? null : mint(value, key);
}

/** A color that no registry field edits (a split passage with no slot). Never hidden, never
 *  attached to a field in the picker — use only when a color genuinely has no owning field. */
export function unownedColor(value: number): VisibleColor {
  return mint(value, null);
}

/** Writes `color` into the field `key` of a settings clone. Returns whether the key was known. */
export function writeColorField(ctx: ColorVisibilityContext, settings: ExportSettings, key: string, color: number): boolean {
  const parsed = parseColorFieldKey(key);
  switch (parsed.kind) {
    case "split":
      // Fill untouched earlier slots with their palette color — a sparse array would serialize holes as null.
      for (let i = settings.splitNodeColors.length; i < parsed.index; i++) {
        settings.splitNodeColors[i] = splitSlotColor(i, canvas.node.splitSlots);
      }
      settings.splitNodeColors[parsed.index] = color;
      return true;
    case "teleportGroup": {
      const override = settings.teleportGroupOverrides[sortedGroupKeys(ctx)[parsed.index]];
      if (!override) return false;
      const role = parsed.role === "fill" ? "fillColor" : "borderColor";
      override[role] = color;
      override.linkBroken = { ...override.linkBroken, [role]: true };
      return true;
    }
    case "static": {
      const def = STATIC_FIELD_DEFS[parsed.key];
      if (!def) return false;
      def.set(settings, color);
      return true;
    }
  }
}
