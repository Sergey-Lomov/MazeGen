import type { MazeState } from "../../store/storeTypes";
import { resolveGroupOverrides } from "../../store/teleportGroupLinks";
import { lazyOverlay } from "../../store/lazyOverlay";
import { withResolvedEdgeMarkerFloors } from "../../store/edgeMarkerLinks";
import type { VectorByWallsSettings, VectorByCorridorsSettings } from "../../store/imageExportTypes";
import type { EdgeDto } from "../../wasm/types";
import { splitSlotColor } from "../colorUtils";
import { canvas } from "../colorTokens";
import { parseColorFieldKey, type ColorFieldKey, type StaticColorFieldKey } from "../colorFieldKeys";
import { maxSplitNodeCount } from "./mazeSelectors";
import { hasCrossFloorTeleport } from "./mazeSelectors/teleport";
import { isPathActive, type ParamActivityContext } from "../../store/parameterLinksActivity";
import { isSchemaPathInMode, type LinkPath } from "../../store/parameterLinkSchema";

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
  innerGrid: boolean;
  /** `edgeMarkers.color` and the per-marker colours (GitHub issue #902) — shown while the markers are. */
  edgeMarkers: boolean;
  /** Each floor's edge marker keys in display order: the number of a marker's colour field (see {@link ColorVisibilityMaze}). */
  edgeMarkerOrder: MazeState["edgeMarkerOrder"];
  /** The floor ids bottom to top: a floor's level is its position. */
  floorIds: string[];
  /** Per-group teleport fill/border overrides — only applied while group customization is on. */
  teleportGroupOverrides: boolean;
  /** The whole "Vertical connections" section wrapper. */
  vertical: boolean;
  /** `"decorative"` only exists in Vector by walls; corridors always draw the abstract style. */
  verticalStyle: "abstract" | "decorative";
  /** The "Marker indices" layer's colors — hidden when the section is hidden or the layer is disabled. */
  markerIndex: boolean;
  floorLabel: boolean;
  /** The maze-derived gates the parameter link schema's rules read (GitHub issue #965), over the whole project. */
  activity: ParamActivityContext;
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
  /** Whether some floor has a glue (GitHub issue #901); the glue tab fields are hidden without one. Unknown counts as yes. */
  hasGlues?: boolean;
  /** Each floor's edge marker keys in display order (`MazeState.edgeMarkerOrder`, GitHub issue #902): a marker's number on its floor. */
  edgeMarkerOrder?: MazeState["edgeMarkerOrder"];
}

/** Whether some floor has a glue (GitHub issue #901): the `hasGlues` input of {@link buildColorVisibility}. */
export function hasAnyGlue(floorTopology: MazeState["floorTopology"]): boolean {
  return Object.values(floorTopology).some((topology) => topology.groups.length > 0);
}

function memoized<T>(compute: () => T): () => T {
  let done = false;
  let value: T;
  return () => {
    if (!done) {
      value = compute();
      done = true;
    }
    return value;
  };
}

/** The visibility context of `rawSettings` over the unscoped maze. Lazy (GitHub issue #928): `settings` is an
 *  overlay that resolves group/edge-marker overrides when first read, and every flag is a getter computed on
 *  access (maze scans memoized), so over dependency-tracked settings a reader of one color field subscribes only
 *  to that field and the flags gating it. */
export function buildColorVisibility(maze: ColorVisibilityMaze, rawSettings: ExportSettings): ColorVisibilityContext {
  const s = lazyOverlay<ExportSettings>(rawSettings, {
    teleportGroupOverrides: () => resolveGroupOverrides(rawSettings),
    edgeMarkers: () => withResolvedEdgeMarkerFloors(rawSettings.edgeMarkers, rawSettings.links),
  });
  const vertical = memoized(() => verticalVisibility(maze.edges, s.replaceTwoFloorElevatorsWithStairs));
  const walls = memoized(() => "verticalStyle" in s);
  const teleports = memoized(() => maze.edges.some((e) => e.kind === "teleport"));
  const markerIndexAvailable = memoized(() => teleports() || vertical().elevators || maze.edges.some((e) => e.kind === "vertical_passage"));
  const multipleFloors = () => maze.floors.length > 1;
  const slotCount = memoized(() => maxSplitNodeCount(maze.nodes));
  const oneWayIndicator = memoized(() => hasDirectionalBasicEdge(maze.edges));
  const crossFloorTeleports = memoized(() => hasCrossFloorTeleport(maze.nodes, maze.edges));
  const floorIds = memoized(() => maze.floors.map((floor) => floor.id));
  // Only the flags a color field's schema path can read are answered; the rest are floor-scoped or irrelevant to
  // a color, and reading one throws instead of answering from the wrong scope.
  const unavailable = (flag: string) => () => { throw new Error(`Schema rule reads "${flag}", which a color field's visibility cannot answer`); };
  const activity: ParamActivityContext = {
    get hasOneWays() { return oneWayIndicator(); },
    get hasTeleports() { return teleports(); },
    get hasCrossFloorTeleports() { return crossFloorTeleports(); },
    get hasTwoWayPassages() { return vertical().twoWayPassages; },
    get hasOneWayPassages() { return vertical().oneWayPassages; },
    get hasElevators() { return vertical().elevators; },
    get hasVerticalSection() { const v = vertical(); return v.twoWayPassages || v.oneWayPassages || v.elevators; },
    get hasMarkerIndexSource() { return markerIndexAvailable(); },
    get hasMultipleFloors() { return multipleFloors(); },
    get hasSplits() { return slotCount() > 0; },
    get hasGlues() { return maze.hasGlues ?? true; },
    get hasAreaSpread(): boolean { return unavailable("hasAreaSpread")(); },
    get hasSeams(): boolean { return unavailable("hasSeams")(); },
    get hasCreases(): boolean { return unavailable("hasCreases")(); },
  };
  return {
    activity,
    settings: s,
    get mode() { return walls() ? "walls" : "corridors"; },
    get slotCount() { return slotCount(); },
    get grid() { return s.showGrid; },
    get innerGrid() { return "showInnerGrid" in s && s.showInnerGrid; },
    get edgeMarkers() { return s.edgeMarkers.mode !== "hidden"; },
    edgeMarkerOrder: maze.edgeMarkerOrder ?? {},
    get floorIds() { return floorIds(); },
    get teleportGroupOverrides() { return s.teleportGroupCustomization; },
    get vertical() {
      const { twoWayPassages, oneWayPassages, elevators } = vertical();
      return twoWayPassages || oneWayPassages || elevators || multipleFloors();
    },
    get verticalStyle() { return walls() ? (s as VectorByWallsSettings).verticalStyle : "abstract"; },
    get markerIndex() { return markerIndexAvailable() && s.markerIndex.enabled; },
    get floorLabel() { return multipleFloors() && s.floorLabel.enabled; },
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

/** Visibility taken from the parameter link schema (GitHub issue #965): the field is shown exactly when its
 *  settings-panel row `path` is, so the panel and the color consumers cannot disagree. A path of the other render
 *  mode has no row there, so the field is hidden. */
const schemaField = (path: LinkPath, def: Omit<ColorFieldDef, "visible" | "path">): ColorFieldDef => ({
  ...def,
  path,
  visible: (c) => isSchemaPathInMode(path, c.mode) && isPathActive(path, c.mode, c.activity, c.settings),
});

/** Everything the system knows about one static color field except its display name. */
export interface ColorFieldDef {
  /** Is the field shown/drawn under the context — see {@link ColorVisibilityContext}. */
  visible: Visible;
  /** The settings-panel row this field is edited in, when it has one: `visible` is then derived from the
   *  parameter link schema (GitHub issue #965), and a consistency test checks it against the panel. */
  path?: LinkPath;
  /** The color currently stored for the field, or `undefined` when it has none (e.g. an unset
   *  start/finish caption color, or a walls-only field read from a corridors profile). */
  get: (s: ExportSettings) => number | undefined;
  /** Writes an edit back into `s` (a clone owned by the caller). */
  set: (s: ExportSettings, color: number) => void;
}

/** The registry of every static color field. A `Record` over {@link StaticColorFieldKey}: adding a
 *  key without a definition (visibility, getter, setter) does not compile. */
export const STATIC_FIELD_DEFS: Record<StaticColorFieldKey, ColorFieldDef> = {
  bgFill: schemaField("background", { get: (s) => s.background, set: (s, v) => { s.background = v; } }),
  // The grid colors keep their own rule (GitHub issue #965): the panel always shows their rows so a color can be
  // picked before the grid is switched on, but a grid that is not drawn must not take part in warnings.
  bgGrid: { visible: (c) => c.grid, get: (s) => s.gridColor, set: (s, v) => { s.gridColor = v; } },
  innerGrid: {
    visible: (c) => c.mode === "walls" && c.innerGrid,
    get: (s) => ("innerGridColor" in s ? s.innerGridColor : undefined),
    set: (s, v) => { if ("innerGridColor" in s) s.innerGridColor = v; },
  },

  cutLines: schemaField("cutLinesColor", { get: (s) => s.cutLinesColor, set: (s, v) => { s.cutLinesColor = v; } }),

  glueTabFill: schemaField("glueTabs.fillColor", { get: (s) => s.glueTabs.fillColor, set: (s, v) => { s.glueTabs.fillColor = v; } }),
  glueTabLine: schemaField("glueTabs.lineColor", { get: (s) => s.glueTabs.lineColor, set: (s, v) => { s.glueTabs.lineColor = v; } }),
  edgeMarker: schemaField("edgeMarkers.color", { get: (s) => s.edgeMarkers.color, set: (s, v) => { s.edgeMarkers.color = v; } }),

  corridorFill: schemaField("color", {
    get: (s) => ("color" in s ? s.color : undefined),
    set: (s, v) => { if ("color" in s) s.color = v; },
  }),

  tilesFloor: schemaField("floorColor", {
    get: (s) => ("floorColor" in s ? s.floorColor : undefined),
    set: (s, v) => { if ("floorColor" in s) s.floorColor = v; },
  }),
  tilesWall: schemaField("wallColor", {
    get: (s) => ("wallColor" in s ? s.wallColor : undefined),
    set: (s, v) => { if ("wallColor" in s) s.wallColor = v; },
  }),

  oneWaysMarker: schemaField("oneWayColor", { get: (s) => s.oneWayColor, set: (s, v) => { s.oneWayColor = v; } }),

  startFill: schemaField("startMarker.fillColor", { get: (s) => s.startMarker.fillColor, set: (s, v) => { s.startMarker.fillColor = v; } }),
  startBorder: schemaField("startMarker.borderColor", { get: (s) => s.startMarker.borderColor, set: (s, v) => { s.startMarker.borderColor = v; } }),
  startText: schemaField("startMarker.textColor", {
    get: (s) => s.startMarker.textColor,
    set: (s, v) => { s.startMarker.textColor = v; },
  }),
  finishFill: schemaField("finishMarker.fillColor", { get: (s) => s.finishMarker.fillColor, set: (s, v) => { s.finishMarker.fillColor = v; } }),
  finishBorder: schemaField("finishMarker.borderColor", { get: (s) => s.finishMarker.borderColor, set: (s, v) => { s.finishMarker.borderColor = v; } }),
  finishText: schemaField("finishMarker.textColor", {
    get: (s) => s.finishMarker.textColor,
    set: (s, v) => { s.finishMarker.textColor = v; },
  }),
  // Start/finish opening arrows (GitHub issue #330, "Vector by walls" only).
  startOpeningArrow: schemaField("startOpening.color", {
    get: (s) => ("startOpening" in s ? s.startOpening.color : undefined),
    set: (s, v) => { if ("startOpening" in s) s.startOpening.color = v; },
  }),
  finishOpeningArrow: schemaField("finishOpening.color", {
    get: (s) => ("finishOpening" in s ? s.finishOpening.color : undefined),
    set: (s, v) => { if ("finishOpening" in s) s.finishOpening.color = v; },
  }),

  teleportEdge: schemaField("teleportMarker.fillColor", { get: (s) => s.teleportMarker.fillColor, set: (s, v) => { s.teleportMarker.fillColor = v; } }),
  teleportEdgeBorder: schemaField("teleportMarker.borderColor", { get: (s) => s.teleportMarker.borderColor, set: (s, v) => { s.teleportMarker.borderColor = v; } }),
  teleportConnector: schemaField("teleportConnectorColor", {
    get: (s) => s.teleportConnectorColor,
    set: (s, v) => { s.teleportConnectorColor = v; },
  }),
  teleportBadgeFill: schemaField("teleportFloorBadge.fillColor", {
    get: (s) => s.teleportFloorBadge.fillColor,
    set: (s, v) => { s.teleportFloorBadge.fillColor = v; },
  }),
  teleportBadgeBorder: schemaField("teleportFloorBadge.borderColor", {
    get: (s) => s.teleportFloorBadge.borderColor,
    set: (s, v) => { s.teleportFloorBadge.borderColor = v; },
  }),
  teleportBadgeText: schemaField("teleportFloorBadge.textColor", {
    get: (s) => s.teleportFloorBadge.textColor,
    set: (s, v) => { s.teleportFloorBadge.textColor = v; },
  }),

  // Decorative-style vertical connection colors (Vector by walls only).
  decorLineTwoWay: schemaField("decorativeStairsTwoWay.lineColor", {
    get: (s) => ("decorativeStairsTwoWay" in s ? s.decorativeStairsTwoWay.lineColor : undefined),
    set: (s, v) => { if ("decorativeStairsTwoWay" in s) s.decorativeStairsTwoWay.lineColor = v; },
  }),
  decorLineOneWay: schemaField("decorativeStairsOneWay.lineColor", {
    get: (s) => ("decorativeStairsOneWay" in s ? s.decorativeStairsOneWay.lineColor : undefined),
    set: (s, v) => { if ("decorativeStairsOneWay" in s) s.decorativeStairsOneWay.lineColor = v; },
  }),
  decorLineElevator: schemaField("decorativeElevator.lineColor", {
    get: (s) => ("decorativeElevator" in s ? s.decorativeElevator.lineColor : undefined),
    set: (s, v) => { if ("decorativeElevator" in s) s.decorativeElevator.lineColor = v; },
  }),
  decorArrowTwoWay: schemaField("decorativeStairsArrowColor", {
    get: (s) => ("decorativeStairsArrowColor" in s ? s.decorativeStairsArrowColor : undefined),
    set: (s, v) => { if ("decorativeStairsArrowColor" in s) s.decorativeStairsArrowColor = v; },
  }),
  decorArrowOneWay: schemaField("decorativeStairsOneWayArrowColor", {
    get: (s) => ("decorativeStairsOneWayArrowColor" in s ? s.decorativeStairsOneWayArrowColor : undefined),
    set: (s, v) => { if ("decorativeStairsOneWayArrowColor" in s) s.decorativeStairsOneWayArrowColor = v; },
  }),

  // GitHub issue #701 — "Shared style" > "Markers" fill / border sources.
  sharedMarkerFill: schemaField("markerFillColor", { get: (s) => s.markerFillColor, set: (s, v) => { s.markerFillColor = v; } }),
  sharedMarkerBorder: schemaField("markerBorderColor", { get: (s) => s.markerBorderColor, set: (s, v) => { s.markerBorderColor = v; } }),

  // "Vertical connections" section's own "Shared style" colors (GitHub issue #668).
  verticalFill: schemaField("verticalFillColor", { get: (s) => s.verticalFillColor, set: (s, v) => { s.verticalFillColor = v; } }),
  verticalBorder: schemaField("verticalBorderColor", { get: (s) => s.verticalBorderColor, set: (s, v) => { s.verticalBorderColor = v; } }),
  verticalArrow: schemaField("verticalArrowColor", { get: (s) => s.verticalArrowColor, set: (s, v) => { s.verticalArrowColor = v; } }),
  verticalDecorLine: schemaField("verticalDecorativeLineColor", {
    get: (s) => ("verticalDecorativeLineColor" in s ? s.verticalDecorativeLineColor : undefined),
    set: (s, v) => { if ("verticalDecorativeLineColor" in s) s.verticalDecorativeLineColor = v; },
  }),

  twoWayFill: schemaField("twoWayPassageMarker.fillColor", { get: (s) => s.twoWayPassageMarker.fillColor, set: (s, v) => { s.twoWayPassageMarker.fillColor = v; } }),
  twoWayBorder: schemaField("twoWayPassageMarker.borderColor", { get: (s) => s.twoWayPassageMarker.borderColor, set: (s, v) => { s.twoWayPassageMarker.borderColor = v; } }),
  twoWayArrow: schemaField("twoWayArrowColor", { get: (s) => s.twoWayArrowColor, set: (s, v) => { s.twoWayArrowColor = v; } }),
  oneWayFill: schemaField("oneWayPassageMarker.fillColor", { get: (s) => s.oneWayPassageMarker.fillColor, set: (s, v) => { s.oneWayPassageMarker.fillColor = v; } }),
  oneWayBorder: schemaField("oneWayPassageMarker.borderColor", { get: (s) => s.oneWayPassageMarker.borderColor, set: (s, v) => { s.oneWayPassageMarker.borderColor = v; } }),
  oneWayArrow: schemaField("oneWayArrowColor", { get: (s) => s.oneWayArrowColor, set: (s, v) => { s.oneWayArrowColor = v; } }),
  elevatorFill: schemaField("elevatorMarker.fillColor", { get: (s) => s.elevatorMarker.fillColor, set: (s, v) => { s.elevatorMarker.fillColor = v; } }),
  elevatorBorder: schemaField("elevatorMarker.borderColor", { get: (s) => s.elevatorMarker.borderColor, set: (s, v) => { s.elevatorMarker.borderColor = v; } }),
  elevatorArrow: schemaField("elevatorArrowColor", { get: (s) => s.elevatorArrowColor, set: (s, v) => { s.elevatorArrowColor = v; } }),
  elevatorBadgeFill: schemaField("elevatorBadges.fillColor", { get: (s) => s.elevatorBadges.fillColor, set: (s, v) => { s.elevatorBadges.fillColor = v; } }),
  elevatorBadgeBorder: schemaField("elevatorBadges.borderColor", { get: (s) => s.elevatorBadges.borderColor, set: (s, v) => { s.elevatorBadges.borderColor = v; } }),
  elevatorBadgeText: schemaField("elevatorBadges.textColor", { get: (s) => s.elevatorBadges.textColor, set: (s, v) => { s.elevatorBadges.textColor = v; } }),

  markerIndexFill: schemaField("markerIndex.fillColor", { get: (s) => s.markerIndex.fillColor, set: (s, v) => { s.markerIndex.fillColor = v; } }),
  markerIndexText: schemaField("markerIndex.textColor", { get: (s) => s.markerIndex.textColor, set: (s, v) => { s.markerIndex.textColor = v; } }),
  markerIndexBorder: schemaField("markerIndex.borderColor", {
    get: (s) => s.markerIndex.borderColor,
    set: (s, v) => { s.markerIndex.borderColor = v; },
  }),
  floorLabelFill: schemaField("floorLabel.fillColor", { get: (s) => s.floorLabel.fillColor, set: (s, v) => { s.floorLabel.fillColor = v; } }),
  floorLabelBorder: schemaField("floorLabel.borderColor", { get: (s) => s.floorLabel.borderColor, set: (s, v) => { s.floorLabel.borderColor = v; } }),
  floorLabelText: schemaField("floorLabel.textColor", { get: (s) => s.floorLabel.textColor, set: (s, v) => { s.floorLabel.textColor = v; } }),
};

/** Display order of the "Project colors" list, split around the two dynamic groups (per-group
 *  teleport overrides after the first table, split-node slots after the second). Every static key
 *  appears in exactly one table — enforced by a test. */
export const STATIC_FIELD_ORDER: readonly (readonly StaticColorFieldKey[])[] = [
  [
    "bgFill", "bgGrid", "innerGrid", "cutLines", "glueTabFill", "glueTabLine", "edgeMarker", "corridorFill", "tilesFloor", "tilesWall", "oneWaysMarker",
    "sharedMarkerFill", "sharedMarkerBorder",
    "startFill", "startBorder", "startText", "finishFill", "finishBorder", "finishText", "startOpeningArrow", "finishOpeningArrow",
    "teleportEdge", "teleportEdgeBorder", "teleportConnector",
    "teleportBadgeFill", "teleportBadgeBorder", "teleportBadgeText",
  ],
  [
    "verticalDecorLine", "verticalFill", "verticalBorder", "verticalArrow",
    "twoWayFill", "twoWayBorder", "twoWayArrow",
    "oneWayFill", "oneWayBorder", "oneWayArrow",
    "elevatorFill", "elevatorBorder", "elevatorArrow",
    "decorLineTwoWay", "decorArrowTwoWay", "decorLineOneWay", "decorArrowOneWay", "decorLineElevator",
    "elevatorBadgeFill", "elevatorBadgeBorder", "elevatorBadgeText",
  ],
  ["floorLabelFill", "floorLabelBorder", "floorLabelText", "markerIndexFill", "markerIndexText", "markerIndexBorder"],
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
    case "edgeMarker": return s.edgeMarkers.overrides[parsed.floorId]?.[parsed.markerKey]?.color;
    case "static": return STATIC_FIELD_DEFS[parsed.key]?.get(s);
  }
}

/** Whether the field `key` (static or dynamic) is visible under `ctx`. */
export function isColorFieldVisible(key: ColorFieldKey, ctx: ColorVisibilityContext): boolean {
  const parsed = parseColorFieldKey(key);
  switch (parsed.kind) {
    case "split": return parsed.index < ctx.slotCount;
    case "teleportGroup": return ctx.activity.hasTeleports && ctx.teleportGroupOverrides;
    case "edgeMarker": return ctx.edgeMarkers && ctx.activity.hasGlues;
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
    case "edgeMarker": {
      const override = settings.edgeMarkers.overrides[parsed.floorId]?.[parsed.markerKey];
      if (!override) return false;
      override.color = color;
      override.linkBroken = { ...override.linkBroken, color: true };
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
