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
  link("cornerStyle", "verticalCornerStyle", false),
  link("cornerStyle", "elevatorBadges.cornerStyle", false),

  link("markerSize", "startMarker.size"),
  link("markerSize", "finishMarker.size"),
  link("markerSize", "teleportLineSize"),
  link("markerSize", "verticalSize", false),

  link("markerBorderWidth", "startMarker.borderWidth"),
  link("markerBorderWidth", "finishMarker.borderWidth"),
  link("markerBorderWidth", "teleportEdgeBorderWidth"),
  link("markerBorderWidth", "verticalBorderWidth", false),

  link("gapWidth", "startMarker.gapWidth"),
  link("gapWidth", "finishMarker.gapWidth"),
  link("gapWidth", "teleportEdgeGapWidth"),
  link("gapWidth", "teleportConnectorGapWidth"),
  link("gapWidth", "verticalGapWidth", false),
  link("gapWidth", "markerIndex.gap"),

  // "Vertical connections" section's own "Shared style" (GitHub issue #668) — the panel-level group
  // above chains into this one (cornerStyle -> verticalCornerStyle, etc.), which in turn drives the
  // three vertical-connection marker groups' overlapping fields, all starting disabled (same
  // convention as the panel-level group's own disabled links): the three markers' own defaults are
  // pinned to `GenerationRenderer`'s fixed look, not either shared-style group.
  link("verticalCornerStyle", "twoWayPassageMarker.cornerStyle", false),
  link("verticalCornerStyle", "oneWayPassageMarker.cornerStyle", false),
  link("verticalCornerStyle", "elevatorMarker.cornerStyle", false),
  link("verticalShape", "twoWayPassageMarker.shape", false),
  link("verticalShape", "oneWayPassageMarker.shape", false),
  link("verticalShape", "elevatorMarker.shape", false),
  link("verticalSize", "twoWayPassageMarker.size", false),
  link("verticalSize", "oneWayPassageMarker.size", false),
  link("verticalSize", "elevatorMarker.size", false),
  link("verticalBorderWidth", "twoWayPassageMarker.borderWidth", false),
  link("verticalBorderWidth", "oneWayPassageMarker.borderWidth", false),
  link("verticalBorderWidth", "elevatorMarker.borderWidth", false),
  link("verticalGapWidth", "twoWayPassageMarker.gapWidth", false),
  link("verticalGapWidth", "oneWayPassageMarker.gapWidth", false),
  link("verticalGapWidth", "elevatorMarker.gapWidth", false),
  link("verticalFillColor", "twoWayPassageMarker.fillColor", false),
  link("verticalFillColor", "oneWayPassageMarker.fillColor", false),
  link("verticalFillColor", "elevatorMarker.fillColor", false),
  link("verticalArrowColor", "twoWayArrowColor", false),
  link("verticalArrowColor", "oneWayArrowColor", false),
  link("verticalArrowColor", "elevatorArrowColor", false),
  link("verticalArrowSize", "twoWayArrowSize", false),
  link("verticalArrowSize", "oneWayArrowSize", false),
  link("verticalArrowSize", "elevatorArrowSize", false),
  link("verticalArrowStyle", "twoWayArrowStyle", false),
  link("verticalArrowStyle", "oneWayArrowStyle", false),
  link("verticalArrowStyle", "elevatorArrowStyle", false),
  link("verticalArrowCornerStyle", "twoWayArrowCornerStyle", false),
  link("verticalArrowCornerStyle", "oneWayArrowCornerStyle", false),
  link("verticalArrowCornerStyle", "elevatorArrowCornerStyle", false),
  link("verticalDecorativeLineColor", "decorativeStairsTwoWay.lineColor", false),
  link("verticalDecorativeLineColor", "decorativeStairsOneWay.lineColor", false),
  link("verticalDecorativeLineColor", "decorativeElevator.lineColor", false),
  link("verticalDecorativeLineWidth", "decorativeStairsTwoWay.lineWidth", false),
  link("verticalDecorativeLineWidth", "decorativeStairsOneWay.lineWidth", false),
  link("verticalDecorativeLineWidth", "decorativeElevator.lineWidth", false),
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
  link("cornerStyle", "verticalCornerStyle", false),
  link("cornerStyle", "elevatorBadges.cornerStyle", false),

  link("markerSize", "startMarker.size"),
  link("markerSize", "finishMarker.size"),
  link("markerSize", "teleportLineSize"),
  link("markerSize", "verticalSize", false),

  link("markerBorderWidth", "startMarker.borderWidth"),
  link("markerBorderWidth", "finishMarker.borderWidth"),
  link("markerBorderWidth", "teleportEdgeBorderWidth"),
  link("markerBorderWidth", "verticalBorderWidth", false),

  link("gapWidth", "startMarker.gapWidth"),
  link("gapWidth", "finishMarker.gapWidth"),
  link("gapWidth", "teleportEdgeGapWidth"),
  link("gapWidth", "teleportConnectorGapWidth"),
  link("gapWidth", "splitGapWidth"),
  link("gapWidth", "verticalGapWidth", false),
  link("gapWidth", "markerIndex.gap"),

  // "Vertical connections" section's own "Shared style" (GitHub issue #668) — see
  // `DEFAULT_VECTOR_BY_WALLS_LINKS`'s own doc comment. "Vector by corridors" has no decorative
  // treatment, so no `verticalDecorativeLineColor` links here.
  link("verticalCornerStyle", "twoWayPassageMarker.cornerStyle", false),
  link("verticalCornerStyle", "oneWayPassageMarker.cornerStyle", false),
  link("verticalCornerStyle", "elevatorMarker.cornerStyle", false),
  link("verticalShape", "twoWayPassageMarker.shape", false),
  link("verticalShape", "oneWayPassageMarker.shape", false),
  link("verticalShape", "elevatorMarker.shape", false),
  link("verticalSize", "twoWayPassageMarker.size", false),
  link("verticalSize", "oneWayPassageMarker.size", false),
  link("verticalSize", "elevatorMarker.size", false),
  link("verticalBorderWidth", "twoWayPassageMarker.borderWidth", false),
  link("verticalBorderWidth", "oneWayPassageMarker.borderWidth", false),
  link("verticalBorderWidth", "elevatorMarker.borderWidth", false),
  link("verticalGapWidth", "twoWayPassageMarker.gapWidth", false),
  link("verticalGapWidth", "oneWayPassageMarker.gapWidth", false),
  link("verticalGapWidth", "elevatorMarker.gapWidth", false),
  link("verticalFillColor", "twoWayPassageMarker.fillColor", false),
  link("verticalFillColor", "oneWayPassageMarker.fillColor", false),
  link("verticalFillColor", "elevatorMarker.fillColor", false),
  link("verticalArrowColor", "twoWayArrowColor", false),
  link("verticalArrowColor", "oneWayArrowColor", false),
  link("verticalArrowColor", "elevatorArrowColor", false),
  link("verticalArrowSize", "twoWayArrowSize", false),
  link("verticalArrowSize", "oneWayArrowSize", false),
  link("verticalArrowSize", "elevatorArrowSize", false),
  link("verticalArrowStyle", "twoWayArrowStyle", false),
  link("verticalArrowStyle", "oneWayArrowStyle", false),
  link("verticalArrowStyle", "elevatorArrowStyle", false),
  link("verticalArrowCornerStyle", "twoWayArrowCornerStyle", false),
  link("verticalArrowCornerStyle", "oneWayArrowCornerStyle", false),
  link("verticalArrowCornerStyle", "elevatorArrowCornerStyle", false),
];
