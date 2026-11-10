import type { ParamActivityContext, ParamActivitySettings } from "./parameterLinksActivity";
import type { LinkMode } from "./parameterLinkSchema";

/** The activity rules of the linkable parameters (GitHub issue #927): when a field's control is shown in
 *  the settings panel, given the maze-derived flags and the panel's toggle/enum settings (GitHub issue
 *  #670). `LINK_SCHEMA` attaches them to its fields; the panels ask them by name through `isGateOpen`. */
export type ActivityRule = (ctx: ParamActivityContext, settings: ParamActivitySettings, mode: LinkMode) => boolean;

export const always: ActivityRule = () => true;
export const and = (...rules: (ActivityRule | undefined)[]): ActivityRule => {
  const present = rules.filter((r): r is ActivityRule => r !== undefined);
  return (ctx, s, mode) => present.every((r) => r(ctx, s, mode));
};
/** A rule that differs per render mode; a mode without an entry is not restricted. */
export const byMode = (rules: Partial<Record<LinkMode, ActivityRule>>): ActivityRule => (ctx, s, mode) => (rules[mode] ?? always)(ctx, s, mode);

export const R = {
  /** Size adaptation is offered only on fields whose cells differ in area (GitHub issue #819). */
  areaSpread: (c) => c.hasAreaSpread,
  teleports: (c) => c.hasTeleports,
  crossFloorTeleports: (c) => c.hasTeleports && c.hasCrossFloorTeleports,
  seams: (c) => c.hasSeams,
  orthogonalConnector: (_, s) => s.teleportConnectorStyle === "orthogonal",
  curvedConnector: (_, s) => s.teleportConnectorStyle === "curved",
  oneWays: (c) => c.hasOneWays,
  twoWayPassages: (c) => c.hasTwoWayPassages,
  oneWayPassages: (c) => c.hasOneWayPassages,
  elevators: (c) => c.hasElevators,
  verticalSection: (c) => c.hasVerticalSection,
  /** "Vector by corridors" has no `verticalStyle`, so it is always the abstract style there. */
  abstractStyle: (_, s) => s.verticalStyle !== "decorative",
  decorativeStyle: (_, s) => s.verticalStyle === "decorative",
  /** The teleport connector line is drawn (the "Connector" subsection hides its body without it). */
  connectorDrawn: (_, s) => s.teleportConnectorStyle !== "none",
  /** Some floor cell has split nodes — the "Splits" section exists only then. */
  splits: (c) => c.hasSplits,
  /** The active floor has a glue — the whole "Topology" section is offered only then (GitHub issue #931). */
  glues: (c) => c.hasGlues,
  cutLines: (c, s) => c.hasGlues && s.showCutLines !== false,
  customCutLineColor: (c, s) => c.hasGlues && s.showCutLines !== false && s.cutLinesGlueColor === false,
  glueTabs: (c, s) => c.hasGlues && s.glueTabs?.showTabs !== false,
  glueTabLine: (c, s) => c.hasGlues && s.glueTabs?.showTabs !== false && (s.glueTabs?.lineWidth ?? 1) > 0,
  /** Creases live inside the "Topology" section, so they need a glue on the floor as well as a crease. */
  creases: (c) => c.hasGlues && c.hasCreases,
  creaseShown: (c, s) => c.hasGlues && c.hasCreases && s.creases?.showCreases !== false,
  creaseLines: (c, s) => c.hasGlues && c.hasCreases && s.creases?.showCreases !== false && s.creases?.mode === "lines",
  creaseMarks: (c, s) => c.hasGlues && c.hasCreases && s.creases?.showCreases !== false && s.creases?.mode === "marks",
  edgeMarkers: (c, s) => c.hasGlues && (s.edgeMarkers?.mode ?? "hidden") !== "hidden",
  /** The round-join corridors: the rendering-mode choice only matters for round joins. */
  roundJoin: (_, s) => s.join === "round",
  /** Only the round-join contour engine reads the junction radius. */
  contourJunction: (_, s) => s.renderStyle === "contour" && s.join === "round",
  teleportGroupCustomization: (_, s) => s.teleportGroupCustomization === true,
  /** The even full-circle ring is laid out by the badge count, so its gap is not a setting. */
  elevatorBadgeGap: (_, s) => !(s.elevatorBadges?.placement === "full_circle" && s.elevatorBadges.evenDistribution),
  markerIndexBorderWidth: (_, s) => !s.markerIndex?.borderWidthFromMarker,
  markerIndexBorderColor: (_, s) => !s.markerIndex?.borderColorFromMarker,
  /** The arrow period matters only for periodic arrows, the arrow size for any arrows. */
  teleportArrowPeriodic: (_, s) => s.teleportArrowMode === "periodic",
  teleportArrowOn: (_, s) => s.teleportArrowMode !== "none",
  /** The split gap and bow shape the special split shapes; a miter join draws plain lines, with no bow. */
  splitShapes: (_, s) => s.splitSpecialShapes === true,
  splitBow: (_, s) => s.splitSpecialShapes === true && s.join !== "miter",
  elevatorBadgesOn: (_, s) => s.elevatorBadges?.enabled !== false,
  markerIndexSource: (c) => c.hasMarkerIndexSource,
  markerIndexOn: (_, s) => s.markerIndex?.enabled !== false,
  multipleFloors: (c) => c.hasMultipleFloors,
  floorLabelOn: (_, s) => s.floorLabel?.enabled !== false,
  floorLabelIndexMode: (_, s) => s.floorLabel?.labelMode === "index",
  floorLabelBackground: (_, s) => s.floorLabel?.backgroundShape !== "none",
  /** The background plate has an outline — the border color matters only then. */
  floorLabelBorder: (_, s) => s.floorLabel?.backgroundShape !== "none" && (s.floorLabel?.borderWidth ?? 1) > 0,
  /** The random wall color palette replaces the single wall color (GitHub issue #965). */
  singleWallColor: (_, s) => s.randomWallColorMode === undefined || s.randomWallColorMode === "off",
  startMarkerOn: (_, s) => s.startMarker?.markerEnabled !== false,
  finishMarkerOn: (_, s) => s.finishMarker?.markerEnabled !== false,
  startTextOn: (_, s) => s.startMarker?.textEnabled !== false,
  finishTextOn: (_, s) => s.finishMarker?.textEnabled !== false,
} satisfies Record<string, ActivityRule>;

/** The named conditions of `R`, also asked by the settings panels for everything that is not a linked row
 *  (a whole section, the unlinked rows of a subsection): the visibility condition of a panel element is
 *  written once, here, whether or not the element carries a link (GitHub issue #927). */
export type GateName = keyof typeof R;

export function isGateOpen(name: GateName, mode: LinkMode, ctx: ParamActivityContext, settings: ParamActivitySettings): boolean {
  const rule: ActivityRule = R[name];
  return rule(ctx, settings, mode);
}
