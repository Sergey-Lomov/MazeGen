import type { ParamDescriptor } from "./parameterLinks";
import { isSchemaPathActive, type LinkMode } from "./parameterLinkSchema";

/** Maze-derived flags that gate whole sections/subsections of the render-mode settings panels
 *  (`VectorByWallsSettingsPanel`/`VectorByCorridorsSettingsPanel`) — built once by `useExportPanelModel`
 *  and read by both the activity rules (`isPathActive`) and the panels' named gates, so a registry path
 *  is shown in the panel exactly when it is active, independent of the parameter-links dialog
 *  (GitHub issues #670, #927). */
export interface ParamActivityContext {
  hasOneWays: boolean;
  hasTeleports: boolean;
  hasCrossFloorTeleports: boolean;
  hasTwoWayPassages: boolean;
  hasOneWayPassages: boolean;
  hasElevators: boolean;
  /** `true` once the "Vertical connections" section itself is shown — mirrors both panels' own
   *  `hasTwoWayPassages || hasOneWayPassages || hasElevators` gate. */
  hasVerticalSection: boolean;
  /** Maze has a teleport / vertical passage / elevator — the "Marker indices" section is shown
   *  only then, regardless of its coverage settings. */
  hasMarkerIndexSource: boolean;
  hasMultipleFloors: boolean;
  /** Cell areas of the active field differ enough for marker size adaptation to matter (GitHub issue #819). */
  hasAreaSpread: boolean;
  /** Some floor has a topological seam — "Route through seams" is shown only then (GitHub issue #873). */
  hasSeams: boolean;
  /** Some cell of the maze has split nodes — the "Splits" section is shown only then. */
  hasSplits: boolean;
  /** The active floor has a glue — cut lines and glue tabs are shown only then (GitHub issue #859). */
  hasGlues: boolean;
  /** The active floor has a crease; together with `hasGlues` it decides whether the "Topology" section exists. */
  hasCreases: boolean;
}

/** Settings fields this activity check needs to read across both render modes' settings objects —
 *  a minimal structural subset rather than the full `VectorByWallsSettings`/`VectorByCorridorsSettings`
 *  union, since `isPathActive` only ever branches on these few toggle/enum fields. */
export interface ParamActivitySettings {
  verticalStyle?: "abstract" | "decorative";
  teleportConnectorStyle?: string;
  showGrid?: boolean;
  showInnerGrid?: boolean;
  join?: string;
  renderStyle?: string;
  teleportGroupCustomization?: boolean;
  showCutLines?: boolean;
  cutLinesGlueColor?: boolean;
  glueTabs?: { showTabs: boolean; lineWidth: number };
  creases?: { showCreases: boolean; mode: "lines" | "marks" };
  edgeMarkers?: { mode: string };
  elevatorBadges?: { enabled: boolean; placement?: string; evenDistribution?: boolean };
  markerIndex?: { enabled: boolean; borderWidthFromMarker?: boolean; borderColorFromMarker?: boolean };
  teleportArrowMode?: string;
  splitSpecialShapes?: boolean;
  startMarker?: { textEnabled?: boolean };
  finishMarker?: { textEnabled?: boolean };
  floorLabel?: { enabled: boolean; labelMode: "index" | "title"; backgroundShape: "none" | "rectangle" | "parallelogram" };
}

/** Whether `path` is currently shown in the settings panel, given `ctx` (maze-derived section
 *  gates) and `settings` (toggle/enum fields that hide a subsection regardless of the maze itself) —
 *  GitHub issue #670. The rule of every declared field lives in `LINK_SCHEMA` (`parameterLinkSchema.ts`,
 *  GitHub issue #927); a path outside the schema has no hide condition and is always active. */
export function isPathActive(path: string, mode: LinkMode, ctx: ParamActivityContext, settings: ParamActivitySettings): boolean {
  return isSchemaPathActive(path, mode, ctx, settings);
}

/** Builds the full set of currently-active paths out of `registry`'s own keys — convenience
 *  wrapper around `isPathActive` for callers (the parameter-links dialog, `LinkEditor`'s pickers)
 *  that want a `Set<P>` rather than calling the predicate per path themselves. */
export function computeActivePaths<P extends string>(registry: Record<P, ParamDescriptor>, mode: LinkMode, ctx: ParamActivityContext, settings: ParamActivitySettings): Set<P> {
  const active = new Set<P>();
  for (const path of Object.keys(registry) as P[]) {
    if (isPathActive(path, mode, ctx, settings)) active.add(path);
  }
  return active;
}
