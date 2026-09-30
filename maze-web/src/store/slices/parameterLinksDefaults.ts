import type { ParamLink } from "../parameterLinks";
import type { VectorByWallsParamPath, VectorByCorridorsParamPath } from "../parameterLinksRegistry";

let nextLinkId = 0;
function link<P extends string>(source: P, target: P, enabled = true): ParamLink<P> {
  nextLinkId += 1;
  return { id: `default-${nextLinkId}`, source, target, enabled };
}

/** Default "Shared style" link graph for "Vector by walls" (GitHub issue #322, generalized by
 *  #643) — reproduces the pre-#643 fixed 4-group wiring (corner style / marker size / marker border
 *  width / gap width), now as plain equality links instead of a hardcoded apply function.
 *  `twoWayPassageMarker`/`oneWayPassageMarker`/`elevatorMarker`/`elevatorBadges` start disabled
 *  (GitHub issue #347 follow-up) — their own defaults are pinned to match `GenerationRenderer`'s
 *  fixed vertical-connection look instead of following the shared value out of the box; the user is
 *  still free to pull them onto it via the panel's own per-field reset button. */
export const DEFAULT_VECTOR_BY_WALLS_LINKS: ParamLink<VectorByWallsParamPath>[] = [
  link("cornerStyle", "wallJoin"),
  link("cornerStyle", "oneWayJoin"),
  link("cornerStyle", "startMarker.cornerStyle"),
  link("cornerStyle", "finishMarker.cornerStyle"),
  link("cornerStyle", "teleportLineCornerStyle"),
  link("cornerStyle", "twoWayPassageMarker.cornerStyle", false),
  link("cornerStyle", "oneWayPassageMarker.cornerStyle", false),
  link("cornerStyle", "elevatorMarker.cornerStyle", false),
  link("cornerStyle", "elevatorBadges.cornerStyle", false),

  link("markerSize", "startMarker.size"),
  link("markerSize", "finishMarker.size"),
  link("markerSize", "teleportLineSize"),
  link("markerSize", "twoWayPassageMarker.size", false),
  link("markerSize", "oneWayPassageMarker.size", false),
  link("markerSize", "elevatorMarker.size", false),

  link("markerBorderWidth", "startMarker.borderWidth"),
  link("markerBorderWidth", "finishMarker.borderWidth"),
  link("markerBorderWidth", "teleportEdgeBorderWidth"),
  link("markerBorderWidth", "twoWayPassageMarker.borderWidth", false),
  link("markerBorderWidth", "oneWayPassageMarker.borderWidth", false),
  link("markerBorderWidth", "elevatorMarker.borderWidth", false),

  link("gapWidth", "startMarker.gapWidth"),
  link("gapWidth", "finishMarker.gapWidth"),
  link("gapWidth", "teleportEdgeGapWidth"),
  link("gapWidth", "teleportConnectorGapWidth"),
  link("gapWidth", "twoWayPassageMarker.gapWidth", false),
  link("gapWidth", "oneWayPassageMarker.gapWidth", false),
  link("gapWidth", "elevatorMarker.gapWidth", false),
  link("gapWidth", "markerIndex.gap"),
];

/** Same role as `DEFAULT_VECTOR_BY_WALLS_LINKS`, for "Vector by corridors" — `join` instead of
 *  `wallJoin`, plus `splitGapWidth` in the `gapWidth` group. Same disabled-by-default vertical-
 *  marker links as the walls mode. */
export const DEFAULT_VECTOR_BY_CORRIDORS_LINKS: ParamLink<VectorByCorridorsParamPath>[] = [
  link("cornerStyle", "join"),
  link("cornerStyle", "oneWayJoin"),
  link("cornerStyle", "startMarker.cornerStyle"),
  link("cornerStyle", "finishMarker.cornerStyle"),
  link("cornerStyle", "teleportLineCornerStyle"),
  link("cornerStyle", "twoWayPassageMarker.cornerStyle", false),
  link("cornerStyle", "oneWayPassageMarker.cornerStyle", false),
  link("cornerStyle", "elevatorMarker.cornerStyle", false),
  link("cornerStyle", "elevatorBadges.cornerStyle", false),

  link("markerSize", "startMarker.size"),
  link("markerSize", "finishMarker.size"),
  link("markerSize", "teleportLineSize"),
  link("markerSize", "twoWayPassageMarker.size", false),
  link("markerSize", "oneWayPassageMarker.size", false),
  link("markerSize", "elevatorMarker.size", false),

  link("markerBorderWidth", "startMarker.borderWidth"),
  link("markerBorderWidth", "finishMarker.borderWidth"),
  link("markerBorderWidth", "teleportEdgeBorderWidth"),
  link("markerBorderWidth", "twoWayPassageMarker.borderWidth", false),
  link("markerBorderWidth", "oneWayPassageMarker.borderWidth", false),
  link("markerBorderWidth", "elevatorMarker.borderWidth", false),

  link("gapWidth", "startMarker.gapWidth"),
  link("gapWidth", "finishMarker.gapWidth"),
  link("gapWidth", "teleportEdgeGapWidth"),
  link("gapWidth", "teleportConnectorGapWidth"),
  link("gapWidth", "splitGapWidth"),
  link("gapWidth", "twoWayPassageMarker.gapWidth", false),
  link("gapWidth", "oneWayPassageMarker.gapWidth", false),
  link("gapWidth", "elevatorMarker.gapWidth", false),
  link("gapWidth", "markerIndex.gap"),
];
