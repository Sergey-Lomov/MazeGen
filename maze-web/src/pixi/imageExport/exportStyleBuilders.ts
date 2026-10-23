import { useMazeStore } from "../../store/mazeStore";
import type { Viewport, MarkerData, VerticalConnectionMarker, WallStyleOverride, OneWayStyleOverride, TeleportLineStyle, TeleportEdge, TeleportGroupOverride } from "../renderers/types";
import type { VerticalConnectionStyle, VerticalMarkerStyle } from "../renderers/types";
import { verticalMarkerFootprint } from "../renderers/VerticalConnectionRenderer";
import type { MarkerSettings, MarkerLayoutSettingsFields, TeleportSettingsFields, VerticalSettingsFields, VerticalDecorativeFields } from "../../store/storeTypes";
import type { MarkerStyle } from "../selectors/mazeSelectors";
import { applyMarkerLayout, MARKER_LAYOUT_SPACING, type MarkerLayoutResult } from "../selectors/mazeSelectors/markerLayout";
import type { MarkerEndpointVisual, MarkerIndexLinkKind, ResolveMarkerEndpointVisual } from "../selectors/mazeSelectors/markerIndex";
import { buildTeleportGroups, coordKey } from "../selectors/teleportGroups";
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
 *  `floorColor` (not independently settable — GitHub issue #292); `size` is already in
 *  world-space px. */
export function buildOneWayStyle(settings: ReturnType<typeof useMazeStore.getState>["vectorByWallsSettings"]): OneWayStyleOverride {
  return {
    pattern: settings.oneWayPattern,
    color: settings.oneWayColor,
    gapColor: settings.floorColor,
    gapWidth: settings.oneWayGapWidth,
    size: settings.oneWaySize,
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
    shape: settings.teleportMarker.shape,
    cornerStyle: settings.teleportMarker.cornerStyle,
    size: settings.teleportMarker.size,
    sizeAdaptation: settings.teleportMarker.sizeAdaptation,
    edgeColor: settings.teleportMarker.fillColor,
    edgeBorderColor: settings.teleportMarker.borderColor,
    borderWidth: settings.teleportMarker.borderWidth,
    edgeGapWidth: settings.teleportMarker.gapWidth,
    connectorColor: settings.teleportConnectorColor,
    connectorWidth: settings.teleportConnectorWidth,
    connectorStyle: settings.teleportConnectorStyle,
    curveDirection: settings.teleportCurveDirection ?? "inward",
    curveStrength: settings.teleportCurveStrength ?? 0.25,
    arrowMode: settings.teleportArrowMode,
    arrowPeriod: settings.teleportArrowPeriod,
    arrowSize: settings.teleportArrowSize,
    connectorGapWidth: settings.teleportConnectorGapWidth,
    floorColor,
    floorBadge: settings.teleportFloorBadge,
  };
}

/** Same `MarkerSettings` → renderer-facing-style conversion as `buildMarkerStyle`, for
 *  `VerticalConnectionRenderer`'s own `VerticalMarkerStyle` shape (GitHub issue #347) — `gapColor`
 *  mirrors `floorColor`, same convention as every other marker's gap ring in this codebase. */
function buildVerticalMarkerStyle(settings: MarkerSettings, floorColor: number): VerticalMarkerStyle {
  return { ...settings, gapColor: floorColor };
}

/** `VerticalConnectionStyle`'s own decorative fields, filled in with inert filler when the caller has
 *  no decorative treatment of its own (`style: "abstract"` means these are never actually read) —
 *  same "abstract-only caller, decorative fields are unread filler" convention
 *  `DEFAULT_VERTICAL_STYLE` (`VerticalConnectionRenderer.ts`) already documents for the four
 *  read-only/tool-driven live-canvas renderers. "Vector by corridors" (GitHub issue #348) is such a
 *  caller — it has no `verticalStyle`/decorative fields of its own at all. */
const INERT_DECORATIVE_FILLER: VerticalDecorativeFields = {
  verticalStyle: "abstract",
  decorativeStairsTwoWay: { lineColor: canvas.vertical.default, lineWidth: 3, size: TILE_SIZE * 0.44, sizeAdaptation: 0 },
  decorativeStairsOneWay: { lineColor: canvas.vertical.default, lineWidth: 3, size: TILE_SIZE * 0.44, sizeAdaptation: 0 },
  decorativeElevator: { lineColor: canvas.vertical.default, lineWidth: 3, size: TILE_SIZE * 0.44, sizeAdaptation: 0 },
  decorativeStairsArrowColor: canvas.floor.default,
  decorativeStairsArrowSize: 0.75,
  decorativeStairsOneWayArrowColor: canvas.floor.default,
  decorativeStairsOneWayArrowSize: 0.75,
};

/** Builds `VerticalConnectionRenderer`'s style from a mode's own vertical-connection fields plus the
 *  panel's own floor color (GitHub issue #347) — same "takes floorColor as its own param" rationale
 *  as `buildTeleportLineStyle`. `decorative` is optional: "Vector by walls" passes its own
 *  `VerticalDecorativeFields`; "Vector by corridors" (GitHub issue #348, no decorative treatment of
 *  its own) omits it and gets `INERT_DECORATIVE_FILLER` instead — inert since `style` always reads
 *  `"abstract"` in that case. */
export function buildVerticalConnectionStyle(settings: VerticalSettingsFields, floorColor: number, decorative?: VerticalDecorativeFields): VerticalConnectionStyle {
  const dec = decorative ?? INERT_DECORATIVE_FILLER;
  return {
    style: dec.verticalStyle,
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
    elevatorArrowColor: settings.elevatorArrowColor,
    elevatorArrowSize: settings.elevatorArrowSize,
    elevatorArrowStyle: settings.elevatorArrowStyle,
    elevatorArrowCornerStyle: settings.elevatorArrowCornerStyle,
    decorativeStairsTwoWay: dec.decorativeStairsTwoWay,
    decorativeStairsOneWay: dec.decorativeStairsOneWay,
    decorativeElevator: dec.decorativeElevator,
    decorativeStairsArrowColor: dec.decorativeStairsArrowColor,
    decorativeStairsArrowSize: dec.decorativeStairsArrowSize,
    decorativeStairsOneWayArrowColor: dec.decorativeStairsOneWayArrowColor,
    decorativeStairsOneWayArrowSize: dec.decorativeStairsOneWayArrowSize,
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

/** The visual (outer radius + border-match color) a connection marker draws with, per link kind
 *  — the "match" color is the marker's own border color when it has a border, else its fill color
 *  (GitHub issue #471, `borderColorFromMarker` refinement). */
function markerEndpointVisual(m: MarkerSettings | VerticalMarkerStyle, fill: number, border: number, borderWidth: number): MarkerEndpointVisual {
  return {
    outerRadius: m.size / 2 + Math.max(0, borderWidth),
    fillRadius: m.size / 2,
    // A vertical-connection marker scales as a whole — border and gap ring included (GitHub issue #819).
    scalesAsWhole: true,
    sizeAdaptation: m.sizeAdaptation,
    borderWidth: Math.max(0, borderWidth),
    borderMatchColor: borderWidth > 0 ? border : fill,
  };
}

/** Builds the `resolveEndpointVisual` callback `buildMarkerIndexLabels` needs (GitHub issue #471) —
 *  keeps the selector free of per-kind marker-settings / teleport-group-override knowledge. Both
 *  vector modes build it the same way from their already-resolved teleport + vertical styles.
 *
 *  A teleport endpoint's color follows any `TeleportGroupOverride` covering its cell (same rule
 *  `TeleportRenderer.drawGroupPoints` uses); a vertical/elevator endpoint uses the elevator marker
 *  style for elevators, the one-way passage marker style for a one-way `VerticalPassage` endpoint,
 *  and the two-way-passage marker style otherwise. */
export function buildMarkerIndexEndpointResolver(args: {
  teleportEdges: TeleportEdge[];
  teleportStyle: TeleportLineStyle;
  groupCustomization: boolean;
  groupOverrides: Record<string, TeleportGroupOverride>;
  verticalStyle: VerticalConnectionStyle;
}): ResolveMarkerEndpointVisual {
  const { teleportEdges, teleportStyle, groupCustomization, groupOverrides, verticalStyle } = args;

  const groups = groupCustomization ? buildTeleportGroups(teleportEdges) : [];
  const groupKeyByPoint = new Map<string, string>();
  for (const group of groups) {
    for (const [px, py] of group.points) groupKeyByPoint.set(coordKey(px, py), group.key);
  }
  const overrideAt = (px: number, py: number): TeleportGroupOverride | undefined => {
    const key = groupKeyByPoint.get(coordKey(px, py));
    return key !== undefined ? groupOverrides[key] : undefined;
  };
  // Teleport endpoint world positions are keyed off the edge geometry, not the node — match a
  // node's own coord to a teleport edge endpoint by rounding.
  const teleportPointByNode = new Map<number, [number, number]>();
  for (const e of teleportEdges) {
    if (e.fromNode !== undefined) teleportPointByNode.set(e.fromNode, e.from);
    if (e.toNode !== undefined) teleportPointByNode.set(e.toNode, e.to);
  }

  return (nodeId: number, kind: MarkerIndexLinkKind, oneWay = false): MarkerEndpointVisual => {
    if (kind === "teleport") {
      const pt = teleportPointByNode.get(nodeId);
      const override = pt ? overrideAt(pt[0], pt[1]) : undefined;
      const fill = override?.fillColor ?? teleportStyle.edgeColor;
      const border = override?.borderColor ?? teleportStyle.edgeBorderColor;
      return {
        outerRadius: teleportStyle.size / 2 + Math.max(0, teleportStyle.borderWidth),
        fillRadius: teleportStyle.size / 2,
        sizeAdaptation: teleportStyle.sizeAdaptation,
        borderWidth: Math.max(0, teleportStyle.borderWidth),
        borderMatchColor: teleportStyle.borderWidth > 0 ? border : fill,
      };
    }
    // Decorative styles replace the hidden abstract marker fields entirely.
    if (verticalStyle.style === "decorative") {
      const lineStyle = kind === "elevator"
        ? verticalStyle.decorativeElevator
        : oneWay ? verticalStyle.decorativeStairsOneWay : verticalStyle.decorativeStairsTwoWay;
      return {
        outerRadius: lineStyle.size / 2,
        fillRadius: lineStyle.size / 2,
        scalesAsWhole: true,
        sizeAdaptation: lineStyle.sizeAdaptation,
        // Decorative vertical elements have no marker border; their visible stroke is the line.
        borderWidth: Math.max(0, lineStyle.lineWidth),
        borderMatchColor: lineStyle.lineColor,
      };
    }
    const m = kind === "elevator" ? verticalStyle.elevatorMarker : kind === "vertical" && oneWay ? verticalStyle.oneWayPassageMarker : verticalStyle.twoWayPassageMarker;
    return markerEndpointVisual(m, m.fillColor, m.borderColor, m.borderWidth ?? 0);
  };
}

/** Runs the marker positioning layer (GitHub issue #735) for an export renderer — arranges start/
 *  finish, teleport and vertical-connection markers sharing one host (see `applyMarkerLayout`). */
export function layoutExportMarkers(args: {
  markers: MarkerData[];
  teleportEdges: TeleportEdge[];
  verticalMarkers: VerticalConnectionMarker[];
  settings: MarkerLayoutSettingsFields & Pick<TeleportSettingsFields, "teleportMarker">;
  verticalStyle: VerticalConnectionStyle;
  splitHostKeys: Set<string>;
}): MarkerLayoutResult {
  const { settings, verticalStyle } = args;
  const tm = settings.teleportMarker;
  return applyMarkerLayout(
    {
      markers: args.markers,
      teleportEdges: args.teleportEdges,
      verticalMarkers: args.verticalMarkers,
      teleportRadius: tm.size / 2 + (tm.borderWidth ?? 0) + (tm.gapWidth ?? 0),
      verticalRadius: (m) => verticalMarkerFootprint(verticalStyle, m),
      splitHostKeys: args.splitHostKeys,
    },
    { mode: settings.markerLayout, spacing: MARKER_LAYOUT_SPACING, scale: settings.markerScale },
  );
}
