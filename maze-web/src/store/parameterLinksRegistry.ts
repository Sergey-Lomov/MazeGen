import type { ParamDescriptor, ParamType } from "./parameterLinks";

/** Every linkable param in this app is either a plain number or one of these small string enums —
 *  `equals` is `Object.is` in both cases, so one shared descriptor factory covers every entry. A
 *  future object-valued param type (#647 color-as-object) would need its own `equals`, added here
 *  when that type is introduced. */
function descriptor(type: ParamType): ParamDescriptor {
  return { type, equals: Object.is };
}

/** "Vector by walls" mode's linkable parameter registry (GitHub issue #643) — one entry per field
 *  any "Shared style" group can drive or be driven from. Path spelling mirrors
 *  `VectorByWallsSettings`'s own field/sub-object structure (dot-path for a `MarkerSettings` sub-
 *  object field) so `getParamValue`/`setParamValue` (`parameterLinksEngine.ts`) can address it
 *  directly. The four group source values (`cornerStyle`/`markerSize`/`markerBorderWidth`/
 *  `gapWidth`) are themselves ordinary entries here — nothing marks them as "sources" structurally,
 *  only that `DEFAULT_VECTOR_BY_WALLS_LINKS` has no link whose `target` is one of them. */
export const VECTOR_BY_WALLS_PARAM_REGISTRY = {
  cornerStyle: descriptor("cornerStyle"),
  markerSize: descriptor("number"),
  markerBorderWidth: descriptor("number"),
  gapWidth: descriptor("number"),

  wallJoin: descriptor("cornerStyle"),
  oneWayJoin: descriptor("cornerStyle"),
  "startMarker.cornerStyle": descriptor("cornerStyle"),
  "startMarker.size": descriptor("number"),
  "startMarker.borderWidth": descriptor("number"),
  "startMarker.gapWidth": descriptor("number"),
  "finishMarker.cornerStyle": descriptor("cornerStyle"),
  "finishMarker.size": descriptor("number"),
  "finishMarker.borderWidth": descriptor("number"),
  "finishMarker.gapWidth": descriptor("number"),
  teleportLineCornerStyle: descriptor("cornerStyle"),
  teleportLineSize: descriptor("number"),
  teleportEdgeBorderWidth: descriptor("number"),
  teleportEdgeGapWidth: descriptor("number"),
  teleportConnectorGapWidth: descriptor("number"),
  "twoWayPassageMarker.cornerStyle": descriptor("cornerStyle"),
  "twoWayPassageMarker.size": descriptor("number"),
  "twoWayPassageMarker.borderWidth": descriptor("number"),
  "twoWayPassageMarker.gapWidth": descriptor("number"),
  "oneWayPassageMarker.cornerStyle": descriptor("cornerStyle"),
  "oneWayPassageMarker.size": descriptor("number"),
  "oneWayPassageMarker.borderWidth": descriptor("number"),
  "oneWayPassageMarker.gapWidth": descriptor("number"),
  "elevatorMarker.cornerStyle": descriptor("cornerStyle"),
  "elevatorMarker.size": descriptor("number"),
  "elevatorMarker.borderWidth": descriptor("number"),
  "elevatorMarker.gapWidth": descriptor("number"),
  "elevatorBadges.cornerStyle": descriptor("cornerStyle"),
  "markerIndex.gap": descriptor("number"),
} as const satisfies Record<string, ParamDescriptor>;

export type VectorByWallsParamPath = keyof typeof VECTOR_BY_WALLS_PARAM_REGISTRY;

/** Same role as `VECTOR_BY_WALLS_PARAM_REGISTRY`, for "Vector by corridors" — its dependent field
 *  set differs (no `wallJoin`, has `join` instead; `gapWidth` also reaches `splitGapWidth`). */
export const VECTOR_BY_CORRIDORS_PARAM_REGISTRY = {
  cornerStyle: descriptor("cornerStyle"),
  markerSize: descriptor("number"),
  markerBorderWidth: descriptor("number"),
  gapWidth: descriptor("number"),

  join: descriptor("cornerStyle"),
  oneWayJoin: descriptor("cornerStyle"),
  "startMarker.cornerStyle": descriptor("cornerStyle"),
  "startMarker.size": descriptor("number"),
  "startMarker.borderWidth": descriptor("number"),
  "startMarker.gapWidth": descriptor("number"),
  "finishMarker.cornerStyle": descriptor("cornerStyle"),
  "finishMarker.size": descriptor("number"),
  "finishMarker.borderWidth": descriptor("number"),
  "finishMarker.gapWidth": descriptor("number"),
  teleportLineCornerStyle: descriptor("cornerStyle"),
  teleportLineSize: descriptor("number"),
  teleportEdgeBorderWidth: descriptor("number"),
  teleportEdgeGapWidth: descriptor("number"),
  teleportConnectorGapWidth: descriptor("number"),
  splitGapWidth: descriptor("number"),
  "twoWayPassageMarker.cornerStyle": descriptor("cornerStyle"),
  "twoWayPassageMarker.size": descriptor("number"),
  "twoWayPassageMarker.borderWidth": descriptor("number"),
  "twoWayPassageMarker.gapWidth": descriptor("number"),
  "oneWayPassageMarker.cornerStyle": descriptor("cornerStyle"),
  "oneWayPassageMarker.size": descriptor("number"),
  "oneWayPassageMarker.borderWidth": descriptor("number"),
  "oneWayPassageMarker.gapWidth": descriptor("number"),
  "elevatorMarker.cornerStyle": descriptor("cornerStyle"),
  "elevatorMarker.size": descriptor("number"),
  "elevatorMarker.borderWidth": descriptor("number"),
  "elevatorMarker.gapWidth": descriptor("number"),
  "elevatorBadges.cornerStyle": descriptor("cornerStyle"),
  "markerIndex.gap": descriptor("number"),
} as const satisfies Record<string, ParamDescriptor>;

export type VectorByCorridorsParamPath = keyof typeof VECTOR_BY_CORRIDORS_PARAM_REGISTRY;
