import type { ParamDescriptor } from "./parameterLinks";

/** Maze-derived flags that gate whole sections/subsections of the render-mode settings panels
 *  (`VectorByWallsSettingsPanel`/`VectorByCorridorsSettingsPanel`) — computed by each panel from
 *  `rawNodes`/`rawEdges` and threaded here so `isPathActive` can tell whether a registry path is
 *  currently shown in that panel, independent of the parameter-links dialog (GitHub issue #670).
 *  Mirrors each panel's own `has*` `useMemo`s one-to-one; see those for how each flag is derived. */
export interface ParamActivityContext {
  hasOneWays: boolean;
  hasTeleports: boolean;
  hasCrossFloorTeleports: boolean;
  hasTwoWayPassages: boolean;
  hasOneWayPassages: boolean;
  hasElevators: boolean;
  /** `true` once the "Vertical connections" section itself is shown — mirrors both panels' own
   *  `hasTwoWayPassages || hasOneWayPassages || hasElevators || floors.length > 1` gate. */
  hasVerticalSection: boolean;
}

/** Settings fields this activity check needs to read across both render modes' settings objects —
 *  a minimal structural subset rather than the full `VectorByWallsSettings`/`VectorByCorridorsSettings`
 *  union, since `isPathActive` only ever branches on these few toggle/enum fields. */
export interface ParamActivitySettings {
  verticalStyle?: "abstract" | "decorative";
  showGrid?: boolean;
  showInnerGrid?: boolean;
  elevatorBadges?: { enabled: boolean };
  markerIndex?: { enabled: boolean };
}

const TELEPORT_PREFIXES = ["teleportLine", "teleportEdge", "teleportConnector", "teleportAvoidFieldExit", "teleportGroupCustomization", "teleportFloorBadge."];
const CROSS_FLOOR_TELEPORT_PREFIX = "teleportFloorBadge.";
const ONE_WAY_PATHS = new Set([
  "oneWayJoin", "oneWayColor", "oneWayGapWidth", "oneWaySize", "oneWayThickness",
  "oneWayCount", "oneWayGap", "oneWayWidth", "oneWayLength",
]);
const VERTICAL_ROOT_PATHS = new Set([
  "verticalCornerStyle", "verticalShape", "verticalSize", "verticalBorderWidth", "verticalGapWidth", "verticalFillColor",
  "verticalArrowColor", "verticalArrowSize", "verticalArrowStyle", "verticalArrowCornerStyle",
  "verticalDecorativeLineColor", "verticalDecorativeLineWidth",
]);
// Vertical "Shared style" fields that only make sense for one of the two "Vector by walls"
// `verticalStyle` modes (GitHub issue #668 follow-up) — mirrors the panel's own filtering inside
// that sub-block. "Vector by corridors" has no `verticalStyle` at all, so `settings.verticalStyle`
// is `undefined` there and these sets are never consulted (`VERTICAL_ROOT_PATHS` alone gates them).
const VERTICAL_SHARED_STYLE_ABSTRACT_ONLY = new Set([
  "verticalCornerStyle", "verticalShape", "verticalBorderWidth", "verticalGapWidth", "verticalFillColor",
  "verticalArrowColor", "verticalArrowStyle", "verticalArrowCornerStyle",
]);
const VERTICAL_SHARED_STYLE_DECORATIVE_ONLY = new Set(["verticalDecorativeLineColor", "verticalDecorativeLineWidth"]);

const TWO_WAY_ABSTRACT_PATHS = new Set(["twoWayArrowColor", "twoWayArrowSize", "twoWayArrowStyle", "twoWayArrowCornerStyle"]);
const TWO_WAY_DECORATIVE_PATHS = new Set(["decorativeStairsArrowSize", "decorativeStairsArrowColor"]);
const ONE_WAY_PASSAGE_ABSTRACT_PATHS = new Set(["oneWayAccentColor", "oneWayArrowColor", "oneWayArrowSize", "oneWayArrowStyle", "oneWayArrowCornerStyle"]);
const ONE_WAY_PASSAGE_DECORATIVE_PATHS = new Set(["decorativeStairsOneWayArrowSize", "decorativeStairsOneWayArrowColor"]);
const ELEVATOR_ABSTRACT_PATHS = new Set(["elevatorArrowColor", "elevatorArrowSize", "elevatorArrowStyle", "elevatorArrowCornerStyle"]);

function startsWithAny(path: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => path.startsWith(prefix));
}

/** Whether `path` is currently shown in the settings panel, given `ctx` (maze-derived section
 *  gates) and `settings` (toggle/enum fields that hide a subsection regardless of the maze itself) —
 *  GitHub issue #670. Mirrors the panels' own render-time conditionals; a path not covered by any
 *  rule below (most fields — background, tiles, markers, shared style, ...) is always active, since
 *  those sections have no hide condition of their own. */
export function isPathActive<P extends string>(path: P, registry: Record<P, ParamDescriptor>, ctx: ParamActivityContext, settings: ParamActivitySettings): boolean {
  void registry;
  const p = path as string;
  const verticalStyle = settings.verticalStyle;

  if (startsWithAny(p, TELEPORT_PREFIXES)) {
    if (!ctx.hasTeleports) return false;
    if (p.startsWith(CROSS_FLOOR_TELEPORT_PREFIX) && !ctx.hasCrossFloorTeleports) return false;
    return true;
  }

  if (ONE_WAY_PATHS.has(p)) return ctx.hasOneWays;

  if (p === "replaceTwoFloorElevatorsWithStairs") return ctx.hasElevators;

  if (VERTICAL_ROOT_PATHS.has(p)) {
    if (!ctx.hasVerticalSection) return false;
    if (VERTICAL_SHARED_STYLE_ABSTRACT_ONLY.has(p)) return verticalStyle !== "decorative";
    if (VERTICAL_SHARED_STYLE_DECORATIVE_ONLY.has(p)) return verticalStyle === "decorative";
    return true;
  }

  if (p === "gridColor") return settings.showGrid !== false;
  if (p === "innerGridColor") return settings.showGrid !== false && settings.showInnerGrid !== false;

  if (p.startsWith("twoWayPassageMarker.") || TWO_WAY_ABSTRACT_PATHS.has(p)) {
    if (!ctx.hasTwoWayPassages) return false;
    return verticalStyle !== "decorative";
  }
  if (p.startsWith("decorativeStairsTwoWay.") || TWO_WAY_DECORATIVE_PATHS.has(p)) {
    if (!ctx.hasTwoWayPassages) return false;
    return verticalStyle === "decorative";
  }

  if (p.startsWith("oneWayPassageMarker.") || ONE_WAY_PASSAGE_ABSTRACT_PATHS.has(p)) {
    if (!ctx.hasOneWayPassages) return false;
    return verticalStyle !== "decorative";
  }
  if (p.startsWith("decorativeStairsOneWay.") || ONE_WAY_PASSAGE_DECORATIVE_PATHS.has(p)) {
    if (!ctx.hasOneWayPassages) return false;
    return verticalStyle === "decorative";
  }

  if (p.startsWith("elevatorMarker.") || ELEVATOR_ABSTRACT_PATHS.has(p)) {
    if (!ctx.hasElevators) return false;
    return verticalStyle !== "decorative";
  }
  if (p.startsWith("decorativeElevator.")) {
    if (!ctx.hasElevators) return false;
    return verticalStyle === "decorative";
  }
  if (p.startsWith("elevatorBadges.")) {
    if (!ctx.hasElevators || verticalStyle !== "decorative") return false;
    if (p === "elevatorBadges.enabled" || p === "elevatorBadges.cornerStyle") return true;
    return settings.elevatorBadges?.enabled !== false;
  }

  if (p.startsWith("markerIndex.") && p !== "markerIndex.enabled") {
    return settings.markerIndex?.enabled !== false;
  }

  return true;
}

/** Builds the full set of currently-active paths out of `registry`'s own keys — convenience
 *  wrapper around `isPathActive` for callers (the parameter-links dialog, `LinkEditor`'s pickers)
 *  that want a `Set<P>` rather than calling the predicate per path themselves. */
export function computeActivePaths<P extends string>(registry: Record<P, ParamDescriptor>, ctx: ParamActivityContext, settings: ParamActivitySettings): Set<P> {
  const active = new Set<P>();
  for (const path of Object.keys(registry) as P[]) {
    if (isPathActive(path, registry, ctx, settings)) active.add(path);
  }
  return active;
}
