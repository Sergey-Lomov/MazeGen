import { useMazeStore } from "../../store/mazeStore";
import type { Viewport, WallStyleOverride, OneWayStyleOverride, TeleportLineStyle } from "../renderers/types";
import type { VerticalConnectionStyle, VerticalMarkerStyle } from "../renderers/VerticalConnectionRenderer";
import type { MarkerSettings, TeleportSettingsFields, VerticalSettingsFields } from "../../store/storeTypes";
import type { MarkerStyle } from "../selectors/mazeSelectors";
import { resolveEndpoint, buildSplitNodeResolver } from "../postEditEndpoint";
import { TILE_SIZE } from "../constants";
import { canvas } from "../colorTokens";
import { splitSlotColor } from "../colorUtils";

export function buildEffectiveSplitNodeColors(splitNodeColors: readonly number[], maxSplit: number): number[] {
  return Array.from(
    { length: Math.max(splitNodeColors.length, maxSplit) },
    (_, i) => splitNodeColors[i] ?? splitSlotColor(i, canvas.node.splitSlots),
  );
}

/** World-space rect covering the whole visible viewport — the inverse of the pan/zoom transform
 *  applied to the scene container (`x`/`y` are the container's own screen-space offset, so the
 *  world-space origin sits at `-x/scale, -y/scale`). Exported as a pure function (not inlined in
 *  `renderBackground`) so the viewport→world formula itself is unit-testable — see GitHub issue
 *  #289, where an earlier version of this formula used the raw screen-space `x`/`y` directly and
 *  drew the background rect in the wrong place. */
export function viewportWorldRect(viewport: Viewport): { x: number; y: number; w: number; h: number } {
  const { x, y, w, h, scale } = viewport;
  return { x: -x / scale, y: -y / scale, w: w / scale, h: h / scale };
}

/** Builds `WallRenderer`'s `WallStyleOverride` from `VectorByWallsSettings` — exported as a pure
 *  function (not inlined in `renderAll`) so the join→cap derivation is unit-testable on its own,
 *  same rationale as `viewportWorldRect`. */
export function buildWallStyle(settings: ReturnType<typeof useMazeStore.getState>["vectorByWallsSettings"]): WallStyleOverride {
  return {
    color: settings.wallColor,
    width: settings.wallThickness,
    join: settings.wallJoin,
    cap: settings.wallJoin === "miter" ? "square" : "round",
  };
}

/** Builds `WallRenderer`'s `OneWayStyleOverride` from `VectorByWallsSettings` — exported as a pure
 *  function for the same testability reason as `buildWallStyle`. The gap color always mirrors
 *  `floorColor` (not independently settable — GitHub issue #292) and `size` is scaled from the
 *  settings' tile-fraction into world-space via `TILE_SIZE`. */
export function buildOneWayStyle(settings: ReturnType<typeof useMazeStore.getState>["vectorByWallsSettings"]): OneWayStyleOverride {
  return {
    pattern: settings.oneWayPattern,
    color: settings.oneWayColor,
    gapColor: settings.floorColor,
    gapWidth: settings.oneWayGapWidth,
    size: TILE_SIZE * settings.oneWaySize,
    thickness: settings.oneWayThickness,
    join: settings.oneWayJoin,
    cap: settings.oneWayJoin === "miter" ? "square" : "round",
  };
}

/** Builds `TeleportRenderer`'s style from a `TeleportSettingsFields` slice — exported for the same
 *  testability reason as `buildWallStyle`/`buildOneWayStyle` (GitHub issue #293). Takes `floorColor`
 *  as its own param (GitHub issue #313) rather than reading it off `settings` — `VectorByWallsSettings`
 *  has its own `floorColor` field but `VectorByCorridorsSettings` (which also `extends
 *  TeleportSettingsFields`, see storeTypes.ts) has no notion of a "floor" of its own, so the caller
 *  supplies whatever background color its own mode occludes the connector line with. */
export function buildTeleportLineStyle(settings: TeleportSettingsFields, floorColor: number): TeleportLineStyle {
  return {
    shape: settings.teleportLineShape,
    cornerStyle: settings.teleportLineCornerStyle,
    size: settings.teleportLineSize,
    edgeColor: settings.teleportEdgeColor,
    edgeBorderColor: settings.teleportEdgeBorderColor,
    borderWidth: settings.teleportEdgeBorderWidth,
    edgeGapWidth: settings.teleportEdgeGapWidth,
    connectorColor: settings.teleportConnectorColor,
    connectorWidth: settings.teleportConnectorWidth,
    connectorStyle: settings.teleportConnectorStyle,
    arrowMode: settings.teleportArrowMode,
    arrowPeriod: settings.teleportArrowPeriod,
    arrowSize: settings.teleportArrowSize,
    connectorGapWidth: settings.teleportConnectorGapWidth,
    floorColor,
  };
}

/** Same `MarkerSettings` → renderer-facing-style conversion as `buildMarkerStyle`, for
 *  `VerticalConnectionRenderer`'s own `VerticalMarkerStyle` shape (GitHub issue #347) — `gapColor`
 *  mirrors `floorColor`, same convention as every other marker's gap ring in this codebase. */
function buildVerticalMarkerStyle(settings: MarkerSettings, floorColor: number): VerticalMarkerStyle {
  return { ...settings, gapColor: floorColor };
}

/** Builds `VerticalConnectionRenderer`'s style from `VectorByWallsSettings`' own vertical-connection
 *  fields plus the panel's own floor color (GitHub issue #347) — same "takes floorColor as its own
 *  param" rationale as `buildTeleportLineStyle`. */
export function buildVerticalConnectionStyle(settings: VerticalSettingsFields, floorColor: number): VerticalConnectionStyle {
  return {
    style: settings.verticalStyle,
    twoWayPassageMarker: buildVerticalMarkerStyle(settings.twoWayPassageMarker, floorColor),
    oneWayPassageMarker: buildVerticalMarkerStyle(settings.oneWayPassageMarker, floorColor),
    elevatorMarker: buildVerticalMarkerStyle(settings.elevatorMarker, floorColor),
    twoWayArrowColor: settings.twoWayArrowColor,
    twoWayArrowSize: settings.twoWayArrowSize,
    twoWayArrowStyle: settings.twoWayArrowStyle,
    twoWayArrowCornerStyle: settings.twoWayArrowCornerStyle,
    oneWayArrowColor: settings.oneWayArrowColor,
    oneWayArrowSize: settings.oneWayArrowSize,
    oneWayArrowStyle: settings.oneWayArrowStyle,
    oneWayArrowCornerStyle: settings.oneWayArrowCornerStyle,
    oneWayAccentColor: settings.oneWayAccentColor,
    elevatorArrowColor: settings.elevatorArrowColor,
    elevatorArrowSize: settings.elevatorArrowSize,
    elevatorArrowStyle: settings.elevatorArrowStyle,
    elevatorArrowCornerStyle: settings.elevatorArrowCornerStyle,
    decorativeStairsTwoWay: settings.decorativeStairsTwoWay,
    decorativeStairsOneWay: settings.decorativeStairsOneWay,
    decorativeElevator: settings.decorativeElevator,
    decorativeStairsArrowColor: settings.decorativeStairsArrowColor,
    decorativeStairsArrowSize: settings.decorativeStairsArrowSize,
    decorativeStairsAccentColor: settings.decorativeStairsAccentColor,
    elevatorBadges: settings.elevatorBadges,
  };
}

/** Builds `buildMazeMarkers`'s `MarkerStyle` from a `MarkerSettings` (start or finish) plus the
 *  panel's own floor color — `gapColor` always mirrors `floorColor` (GitHub issue #302 follow-up,
 *  not independently settable, same convention as the one-way indicator's own border color). */
export function buildMarkerStyle(settings: MarkerSettings, floorColor: number): MarkerStyle {
  return { ...settings, gapColor: floorColor };
}

/** Resolves the currently effective start/finish node ids — `postEditMeta`'s confirmed endpoints
 *  when post-edit has ever confirmed (same fallback rule `AnalyticsRenderer` uses), else the
 *  as-generated `state.start`/`state.finish`. GitHub issue #303 — this renderer previously read
 *  `state.start`/`state.finish` directly, which `confirmPostEdit` never updates (only
 *  `postEditMeta` reflects a post-edit start/finish move), so a moved marker never propagated to
 *  the exported image. */
export function resolveEffectiveEndpoints(
  state: Pick<ReturnType<typeof useMazeStore.getState>, "nodes" | "start" | "finish" | "postEditMeta" | "postEditDraftSplitPoints">,
): { start: number | null; finish: number | null } {
  // `state.nodes` can span every floor (GitHub issue #358) while `postEditDraftSplitPoints` is one
  // flat, `"@level"`-suffixed collection covering every floor at once — `pointNodeMap`'s own keys
  // are folded through the same suffix (per node's own `level`) so `buildSplitNodeResolver`'s
  // level-aware lookup can tell a slot on floor 2 apart from an identically-`(x,y)` slot on floor 0
  // (`resolveEndpoint` passes each `PostEditEndpoint`'s own `.level` through automatically).
  // Deliberately still unscoped to one floor otherwise (matches `start`/`finish` staying maze-wide
  // ids here — see the call sites' own "resolveEffectiveEndpoints still reads the unscoped state"
  // comment).
  const pointNodeMap = new Map<string, number[]>();
  for (const n of state.nodes) {
    const level = n.level ?? 0;
    const key = level === 0 ? `${n.x},${n.y}` : `${n.x},${n.y}@${level}`;
    const list = pointNodeMap.get(key);
    if (list) list.push(n.id);
    else pointNodeMap.set(key, [n.id]);
  }
  const resolveSplit = buildSplitNodeResolver(pointNodeMap, state.postEditDraftSplitPoints);

  const startEp = state.postEditMeta != null ? state.postEditMeta.start : (state.start !== null ? { kind: "node" as const, id: state.start } : null);
  const finishEp = state.postEditMeta != null ? state.postEditMeta.finish : (state.finish !== null ? { kind: "node" as const, id: state.finish } : null);
  return {
    start: startEp !== null ? resolveEndpoint(startEp, resolveSplit) ?? null : null,
    finish: finishEp !== null ? resolveEndpoint(finishEp, resolveSplit) ?? null : null,
  };
}
