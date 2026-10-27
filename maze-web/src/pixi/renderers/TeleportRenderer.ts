import { Container, Graphics } from "pixi.js";
import type { TeleportEdge, TeleportLineStyle, TeleportGroupOverride } from "./types";
import type { FieldConfig } from "../../fieldConfig";
import { TILE_SIZE } from "../constants";
import { DEFAULT_MAZE_RENDER_STYLE } from "../defaultMazeRenderStyle";
import { borderCompensatedRadius, drawMarkerShape, drawMarkerUnderlay, drawMarkerWithBorder, markerBoundingHalfExtent } from "./markerShapes";
import { drawDirectionArrow } from "./wallUtils";
import { arrowPlacements, type RoutedConnector } from "./teleportConnectorRouting";
import { TeleportConnectorRouter } from "./teleportConnectorRouter";
import { routeTeleportConnectors } from "./teleportConnectorPlan";
import { buildTeleportGroups, type TeleportGroup } from "../selectors/teleportGroups";
import { attachFloorBadgeNavigation, drawFloorBadge } from "./floorBadge";
import { formatIndexLabel } from "./indexLabel";
import { coordKey, computeFloorBadges, resolvePointFillState, planGroupDrawOrder } from "./teleportGeometry";
import { NO_MARKER_SCALING, type MarkerScaler } from "../markerScale";

/** Renders teleport connectors + markers into one persistent `Graphics` (`view`) per full
 *  `render()` call. Overlapping translucent shapes (a marker sitting on its own connector's
 *  endpoint, which is *guaranteed* for every teleport point) would show each other through at the
 *  seam under `Container.alpha`, so everything is drawn opaque into the one shared `Graphics`. */
export class TeleportRenderer {
  // One shared `Graphics` for everything (connectors + markers, both modes) — not split into
  // separate line/marker layers, so draw order (which this class now interleaves per group: a
  // group's own connectors, then its own points, then the next group's connectors, ...) is the
  // actual z-order rather than "every connector below every marker" regardless of grouping.
  private readonly view: Graphics;
  /** Hosts every child that can't live on `this.view` itself (a `Graphics` instance) — floor-badge
   *  digit `BitmapText` (`drawFloorBadge`), floor-badge hit-circles (`attachFloorBadgeNavigation`), and a
   *  `mixed` marker's mask/half-fill `Graphics` pair (`drawMarker`) — PixiJS v8 deprecates `addChild`
   *  on non-`Container` objects and disallows it in a future major version (GitHub issue #432). A
   *  sibling layer drawn above `this.view`, cleared/rebuilt alongside it every render. */
  private readonly overlayLayer: Container;
  // Kept between `render()` calls' phases so `renderGroups` can draw from the already-computed
  // groups/routing without recomputing them from the raw `edges`.
  private selectionGroups: TeleportGroup[] = [];
  private selectionStyle: TeleportLineStyle = DEFAULT_MAZE_RENDER_STYLE.teleport;
  private selectionGroupOverrides: Record<string, TeleportGroupOverride> = {};
  private selectionGroupCustomization = false;
  private selectionEdges: TeleportEdge[] = [];
  private selectionPointScales: Map<string, number> = new Map();
  // Cross-floor points (GitHub issue #337) — a point present here draws a floor-number badge
  // instead of an ordinary marker in `drawGroupPoints`. Keyed the same way `selectionEdges` drives
  // `resolvePointFillState`, recomputed alongside it in `renderLine`.
  private selectionFloorBadges: Map<string, number> = new Map();
  // GitHub issue #337 follow-up: whether a badge point's hit-circle (added in `drawGroupPoints`)
  // wires click-to-switch-floor, see `render`'s own `floorNavigable` doc comment.
  private selectionFloorNavigable = false;
  // Marker size adaptation (GitHub issue #819): per-cell radius factors for markers and badges.
  private selectionScaler: MarkerScaler = NO_MARKER_SCALING;
  // One entry per drawn connector (edges with non-zero-length span only) — same rationale.
  private selectionConnectors: { edge: TeleportEdge; routed: RoutedConnector; color: number }[] = [];
  // Owns orthogonal-connector collision routing + its own result cache (GitHub issue #297
  // follow-up) — one instance per `TeleportRenderer`, so a repeat `render()` call with the same
  // (by value) edges/style/cfg reuses the previous routing instead of recomputing it.
  private readonly connectorRouter = new TeleportConnectorRouter();

  constructor(container: Container) {
    this.view = new Graphics();
    container.addChild(this.view);
    this.overlayLayer = new Container();
    container.addChild(this.overlayLayer);
  }

  /** `lineStyle` defaults to the pre-#293 fixed look (every caller except `VectorByWallsRenderer`).
   *  `groupCustomization` (GitHub issue #293 follow-up, replacing the old standalone `"grouped"`
   *  pattern) merges teleport pairs into groups wherever an endpoint coordinate coincides (see
   *  `buildTeleportGroups`) and applies each group's own `TeleportGroupOverride` on top of the base
   *  `lineStyle` for that group's points — the connector line and fill/outline/mixed point-state
   *  logic are unaffected either way. */
  render(data: {
    edges: TeleportEdge[];
    lineStyle?: TeleportLineStyle;
    groupCustomization?: boolean;
    groupOverrides?: Record<string, TeleportGroupOverride>;
    /** The active tessellation, so `"orthogonal"` connectors bend along that tessellation's own
     *  face directions (GitHub issue #297) instead of always assuming a square grid. Omitted by
     *  callers without a config in hand, which falls back to the original square (h/v) behavior. */
    cfg?: FieldConfig;
    /** World positions of the start/finish markers (GitHub issue #300) — an `"orthogonal"`
     *  connector always avoids cutting through these, same weight as another connector's own
     *  endpoint. Required (not optional) so a caller can't silently forget it the way
     *  `GenerationRenderer`/`MazeOverlayRenderer`/`PostEditRenderer`/`PresetConnectionsRenderer` all
     *  independently did (GitHub issue #516) — pass `[]` where there's truly nothing to avoid. */
    waypoints: [number, number][];
    /** "Avoid field exit" toggle (GitHub issue #300) — when on, an `"orthogonal"` connector strongly
     *  prefers any candidate that stays within the maze field's own cell footprint (`fieldCells`)
     *  over one that steps outside it. */
    avoidFieldExit?: boolean;
    /** The maze's own node cell coordinates, backing the `avoidFieldExit` check above — omitted or
     *  empty is the same as leaving `avoidFieldExit` off (nothing to be outside of). */
    fieldCells?: [number, number][];
    /** Wires click-to-switch-floor (GitHub issue #337 follow-up) on every cross-floor badge point
     *  (`selectionFloorBadges`) — a badge is clickable whenever this is on, regardless of group
     *  customization state. Defaults to `false`. */
    floorNavigable?: boolean;
    /** Marker size adaptation (GitHub issue #819) — scales each endpoint marker's and floor badge's
     *  radius by its cell's factor; border/gap/connector widths stay as configured. */
    scaler?: MarkerScaler;
  }): void {
    this.selectionScaler = data.scaler ?? NO_MARKER_SCALING;
    this.view.clear();
    // `drawMarker`'s mixed-cell split adds throwaway mask/fill children (see its own comment) —
    // `.clear()` only resets the drawn path, not added children, so those must be destroyed
    // explicitly or they'd accumulate (and leak GPU resources) across renders.
    this.view.removeChildren().forEach((c) => c.destroy());

    this.renderLine(
      data.edges,
      data.lineStyle ?? DEFAULT_MAZE_RENDER_STYLE.teleport,
      data.groupCustomization ?? false,
      data.groupOverrides ?? {},
      data.cfg,
      data.waypoints,
      data.avoidFieldExit ?? false,
      data.fieldCells ?? [],
      data.floorNavigable ?? false,
    );
  }

  private renderLine(
    edges: TeleportEdge[],
    style: TeleportLineStyle,
    groupCustomization: boolean,
    groupOverrides: Record<string, TeleportGroupOverride>,
    cfg: FieldConfig | undefined,
    waypoints: [number, number][],
    avoidFieldExit: boolean,
    fieldCells: [number, number][],
    floorNavigable: boolean,
  ): void {
    // Grouping (`buildTeleportGroups`, merging teleport pairs wherever an endpoint coordinate
    // coincides) drives draw order regardless of whether group *customization* (per-group shape/
    // color overrides) is on — a group's own connectors are drawn immediately before its own
    // points, then the next group's connectors, etc. (see `renderGroups`), so `groupCustomization`
    // only gates whether `groupOverrides` are applied, not the grouping/ordering itself.
    const groups = buildTeleportGroups(edges);
    this.selectionGroups = groups;
    this.selectionStyle = style;
    this.selectionGroupOverrides = groupCustomization ? groupOverrides : {};
    this.selectionGroupCustomization = groupCustomization;
    this.selectionEdges = edges;
    this.selectionPointScales = new Map();
    for (const e of edges) {
      if (e.fromScale !== undefined) this.selectionPointScales.set(coordKey(e.from[0], e.from[1]), e.fromScale);
      if (e.toScale !== undefined) this.selectionPointScales.set(coordKey(e.to[0], e.to[1]), e.toScale);
    }
    this.selectionFloorBadges = computeFloorBadges(edges);
    this.selectionFloorNavigable = floorNavigable;
    this.selectionConnectors =
      style.connectorStyle !== "none"
        ? this.computeConnectors(edges, style, groupCustomization, groupOverrides, cfg, waypoints, avoidFieldExit, fieldCells)
        : [];

    this.renderGroups();
  }

  /** Resolves every drawable (non-zero-length) connector in `edges` into its routed polyline +
   *  final color — pure computation, no drawing. */
  private computeConnectors(
    edges: TeleportEdge[],
    style: TeleportLineStyle,
    groupCustomization: boolean,
    groupOverrides: Record<string, TeleportGroupOverride>,
    cfg: FieldConfig | undefined,
    waypoints: [number, number][],
    avoidFieldExit: boolean,
    fieldCells: [number, number][],
  ): { edge: TeleportEdge; routed: RoutedConnector; color: number }[] {
    const groups = groupCustomization ? buildTeleportGroups(edges) : [];
    const groupKeyByPoint = new Map<string, string>();
    for (const group of groups) {
      for (const [px, py] of group.points) groupKeyByPoint.set(coordKey(px, py), group.key);
    }
    const overrideAt = (cx: number, cy: number): TeleportGroupOverride | undefined => {
      const groupKey = groupKeyByPoint.get(coordKey(cx, cy));
      return groupKey !== undefined ? groupOverrides[groupKey] : undefined;
    };

    const routed = routeTeleportConnectors({
      router: this.connectorRouter, edges, style, cfg, waypoints, avoidFieldExit, fieldCells,
      markerMaxFactor: this.selectionScaler.maxFactor,
    });

    const result: { edge: TeleportEdge; routed: RoutedConnector; color: number }[] = [];
    edges.forEach((e, i) => {
      const [fx, fy] = e.from;
      const [tx, ty] = e.to;
      if (fx === tx && fy === ty) return;
      // A connector's own color/border can be overridden by *either* end's group (whichever one
      // has an override) — same "one color drives border + connector" rule as the marker itself
      // (see `TeleportGroupOverride`'s own doc comment).
      const override = overrideAt(fx, fy) ?? overrideAt(tx, ty);
      // With group customization on, every group's connectors follow its border (an uncustomized
      // group's border is the common marker border), never the common connector color — otherwise a
      // group would flip between the two as its border link/override toggles.
      const connectorColor = groupCustomization ? (override?.borderColor ?? style.edgeBorderColor) : style.connectorColor;
      result.push({ edge: e, routed: routed[i], color: connectorColor });
    });
    return result;
  }

  /** Marker-layout shrink factor (GitHub issue #735) of the point at (`px`, `py`) — 1 when the point
   *  isn't in a multi-marker host. */
  private pointScale(px: number, py: number): number {
    return this.selectionPointScales.get(coordKey(px, py)) ?? 1;
  }

  /** Draws every point of one group's floor-colored gap ring (`style.edgeGapWidth`, GitHub issue
   *  #302) into `g` — a separate pass from `drawGroupPoints` itself, called before any connector so
   *  that every connector (this point's own or another's) draws on top of it (see
   *  `renderGroups`'s own 3-pass doc comment). A point flagged in `selectionFloorBadges` (GitHub
   *  issue #337) draws its own plain circular gap ring instead — sized past the badge's own border
   *  ring, which follows `floorBadge.gapWidth` (GitHub issue #701 — previously `max(edgeGapWidth, 1)`).
   *  No-op for ordinary points when `edgeGapWidth` is `0`. */
  private drawGroupGaps(
    g: Graphics,
    group: TeleportGroup,
    style: TeleportLineStyle,
  ): void {
    // Single true outward offset of the fill path (`r`) by `borderWidth + edgeGapWidth` — see
    // `drawMarkerUnderlay`'s own doc comment (GitHub issue #552 ninth follow-up) for the full
    // rationale; the marker's own border (drawn on top, also `alignment: 0` from the same `r`, see
    // `drawMarker`) covers the ring's inner `borderWidth`-wide band, leaving only the outer
    // `edgeGapWidth`-wide band visible.
    const rounded = style.cornerStyle === "round";
    for (const [px, py] of group.points) {
      const sc = this.pointScale(px, py);
      const markerR = (style.size / 2) * this.selectionScaler.factorAt([px, py], style.sizeAdaptation) * sc;
      if (this.selectionFloorBadges.has(coordKey(px, py))) {
        // A floor badge (and its gap ring) follows the connector's own visibility — no connector,
        // no badge, no ring, no ordinary marker either (GitHub issue #519, see `drawGroupPoints`).
        if (style.connectorStyle === "none") continue;
        // GitHub issue #485/#701: the badge is its own marker — `floorBadge.size`/`borderWidth`/
        // `gapWidth`/`cornerStyle` are independent of the edge marker's. The gap ring matches the
        // badge's own `floorBadge.shape` and corner style, like the badge body in `drawGroupPoints`
        // below, not a forced circle.
        const badgeR = (style.floorBadge.size / 2) * this.selectionScaler.factorAt([px, py], style.floorBadge.sizeAdaptation);
        if (style.floorBadge.gapWidth > 0) {
          drawMarkerUnderlay(g, style.floorBadge.shape, px, py, badgeR, style.floorBadge.cornerStyle === "round", style.floorBadge.borderWidth + style.floorBadge.gapWidth, style.floorColor, style.floorBadge.borderWidth);
        }
        continue;
      }
      if (style.edgeGapWidth <= 0) continue;
      drawMarkerUnderlay(g, style.shape, px, py, markerR, rounded, (style.borderWidth + style.edgeGapWidth) * sc, style.floorColor, style.borderWidth * sc);
    }
  }

  /** Draws every point of one group (its shape/fillColor/borderColor resolved from `override`, or
   *  `style`'s own base fields when absent) into `g` — a point flagged in `selectionFloorBadges`
   *  (GitHub issue #337, a cross-floor edge's midpoint) draws a floor-number badge instead, via
   *  `drawFloorBadge`. The badge's own fill/border also follow `override.borderColor` (the group's
   *  secondary color) when set, instead of `style.floorBadge.fillColor`/`borderColor` (GitHub issue
   *  #503 follow-up). */
  private drawGroupPoints(
    g: Graphics,
    overlay: Container,
    group: TeleportGroup,
    override: TeleportGroupOverride | undefined,
    edges: TeleportEdge[],
    style: TeleportLineStyle,
  ): void {
    const shape = override?.shape ?? style.shape;
    const color = override?.fillColor ?? style.edgeColor;
    const borderColor = override?.borderColor ?? style.edgeBorderColor;
    // GitHub issue #485: the cross-floor badge has its own configurable shape/label/size/text
    // style, distinct from the edge marker's own `shape`/`style.size` above.
    for (const [px, py] of group.points) {
      const r = (style.size / 2) * this.selectionScaler.factorAt([px, py], style.sizeAdaptation);
      const badgeR = (style.floorBadge.size / 2) * this.selectionScaler.factorAt([px, py], style.floorBadge.sizeAdaptation);
      const floorNumber = this.selectionFloorBadges.get(coordKey(px, py));
      if (floorNumber !== undefined) {
        // A floor badge stands in for the connector's off-floor endpoint — it must follow the
        // same visibility rule as the connector itself (GitHub issue #519). With `connectorStyle:
        // "none"` there's no connector to point at, so the point draws nothing at all here (not an
        // ordinary marker either — this point is a synthetic midpoint, not a real teleport node).
        if (style.connectorStyle === "none") continue;
        // A group override's `borderColor` is the group's "secondary" color (it also drives the
        // marker border and every connector touching the group, see above) — when group
        // customization is on, the badge's fill and border both follow it instead of the ordinary
        // `style.floorBadge.fillColor`/`borderColor` (GitHub issue #503 follow-up).
        const badgeFill = this.selectionGroupCustomization ? borderColor : style.floorBadge.fillColor;
        const badgeBorder = this.selectionGroupCustomization ? borderColor : style.floorBadge.borderColor;
        drawFloorBadge(g, overlay, badgeR, px, py, badgeFill, badgeBorder, style.floorColor, floorNumber, {
          shape: style.floorBadge.shape,
          labelText: formatIndexLabel(floorNumber - 1, style.floorBadge.labelType),
          textColor: style.floorBadge.textColor,
          fontWeight: style.floorBadge.textFontWeight,
          fontSize: style.floorBadge.textSize * this.selectionScaler.factorAt([px, py], style.floorBadge.sizeAdaptation),
          borderWidth: style.floorBadge.borderWidth,
          rounded: style.floorBadge.cornerStyle === "round",
        });
        if (this.selectionFloorNavigable) {
          attachFloorBadgeNavigation(overlay, px, py, badgeR, floorNumber - 1, style.floorBadge.borderWidth);
        }
        continue;
      }
      const fillState = resolvePointFillState(edges, px, py);
      const sc = this.pointScale(px, py);
      this.drawMarker(
        g, overlay, shape, style.cornerStyle, r * sc, px, py,
        color, borderColor, style.borderWidth * sc, style.floorColor,
        fillState === "filled", fillState === "mixed",
      );
    }
  }

  /** Every group's gaps + connectors + points (which is every point/connector, once
   *  `buildTeleportGroups` has run: an edge with usable node ids always lands in some group, even a
   *  group of one) are drawn into `view` here, one group at a time — a group's own gap rings,
   *  then its own connectors, then its own points, then the next group (GitHub issue #302: within
   *  one group this guarantees its own connectors/points are never visually cut by its own gap
   *  rings — a group's gap only ever needs to stay clear of *that same* group's own connector/marker
   *  geometry, so a 3-sub-pass block per group is enough, no global gap/connector/marker split is
   *  needed). A whole later group's block (gaps, connectors and points alike) draws on top of a
   *  whole earlier group's block, same "later group wins" rule the pre-#302 single interleaved pass
   *  used. */
  private renderGroups(): void {
    this.view.clear();
    this.view.removeChildren().forEach((c) => c.destroy());
    this.overlayLayer.removeChildren().forEach((c) => c.destroy());
    const style = this.selectionStyle;

    const plan = planGroupDrawOrder(this.selectionGroups, this.selectionConnectors);

    for (const { group, connectors } of plan) {
      this.drawGroupGaps(this.view, group, style);
      for (const c of connectors) {
        this.drawRoutedConnector(this.view, c.routed, style, c.color, c.edge.oneWay);
      }
      const override = this.selectionGroupOverrides[group.key];
      this.drawGroupPoints(this.view, this.overlayLayer, group, override, this.selectionEdges, style);
    }
  }

  /** Draws one connector's routed polyline (`RoutedConnector.points`, 2 points for `"straight"`, 3
   *  for a regular `"orthogonal"` bend, sampled ring points for radial `"orthogonal"`) as a stroked path, plus every direction arrow `oneWay`'s
   *  `arrowMode` calls for (see `arrowPlacements`) — a `"orthogonal"` path can't just be one
   *  `lineTo` per point with round joins, since a bend's own two segments may carry different
   *  collision offsets (see `TeleportConnectorRouter.route`) and a rounded join would visually blend
   *  them; `"round"` cap (not join) on each straight sub-path keeps every segment's own ends clean
   *  without implying the bend itself is smooth. When `connectorGapWidth > 0`, the whole thing
   *  (line + arrows) is drawn twice — once wider in `floorColor` underneath, once at the real width
   *  on top — so the gap wraps the arrowheads too, not just the line. `color` (GitHub issue #293
   *  follow-up) is passed separately from `style` since a group override can replace it. */
  private drawRoutedConnector(g: Graphics, routed: RoutedConnector, style: TeleportLineStyle, color: number, oneWay: boolean): void {
    const pts = routed.points;
    const placements = oneWay ? arrowPlacements(pts, style.arrowMode, style.arrowPeriod * TILE_SIZE, style.arrowSize) : [];

    const draw = (width: number, drawColor: number, arrowSize: number) => {
      g.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
      g.stroke({ width, color: drawColor, cap: "round" });
      for (const p of placements) {
        drawDirectionArrow(g, p.x, p.y, p.dx, p.dy, arrowSize, drawColor);
      }
    };

    if (style.connectorGapWidth > 0) {
      draw(style.connectorWidth + style.connectorGapWidth * 2, style.floorColor, style.arrowSize + style.connectorGapWidth * 2);
    }
    draw(style.connectorWidth, color, style.arrowSize);
  }


  /** Draws one marker — filled with `color` when `filled`, or with `floorColor` (empty look) when
   *  not, always bordered in `borderColor` on top. `mixed` draws a diagonal split of `shape` itself
   *  instead: upper-left half filled, lower-right half empty, so a point hosting two disagreeing
   *  links reads as visually distinct from a plain filled or plain outline point — drawn in
   *  `color`/`color` regardless of `borderColor` (the split itself is the distinguishing signal, an
   *  independent border color on top of it would just be visual noise). The lower-right half is
   *  masked out via a throwaway `Graphics` triangle (`shape`'s own outline isn't necessarily a
   *  rectangle, so a plain clipped fill can't be built from `shape`'s path alone) — both `mask` and
   *  `halfFillView` are added to `overlay`, a `Container` sibling of `g` (`g` is a `Graphics`
   *  instance, and PixiJS v8 deprecates `addChild` on non-`Container` objects — GitHub issue #432);
   *  pixi excludes an object assigned as another's `.mask` from its own normal render pass, so `mask`
   *  itself stays invisible despite being a normal child, same as before this container swap. */
  private drawMarker(
    g: Graphics,
    overlay: Container,
    shape: TeleportLineStyle["shape"],
    cornerStyle: TeleportLineStyle["cornerStyle"],
    r: number,
    cx: number,
    cy: number,
    color: number,
    borderColor: number,
    borderWidth: number,
    floorColor: number,
    filled: boolean,
    mixed: boolean,
  ): void {
    const rounded = cornerStyle === "round";
    const fillR = borderCompensatedRadius(shape, r, borderWidth, rounded);
    if (mixed) {
      drawMarkerWithBorder(g, shape, cx, cy, r, rounded, floorColor, borderColor, borderWidth);

      // Keep the half-fill at the marker's actual contour. Growing it by scale made the diagonal
      // half inherit the same non-uniform corner thickness as the old frame implementation.
      const half = markerBoundingHalfExtent(shape, fillR);
      const mask = new Graphics()
        .moveTo(cx - half, cy - half)
        .lineTo(cx + half, cy - half)
        .lineTo(cx - half, cy + half)
        .closePath()
        .fill(0xffffff);
      const halfFillView = new Graphics();
      drawMarkerShape(halfFillView, shape, cx, cy, fillR, rounded);
      halfFillView.fill(color);
      halfFillView.mask = mask;
      overlay.addChild(mask);
      overlay.addChild(halfFillView);
      return;
    }

    // Fill color depends on `filled` (own color) vs. empty (floor color, so it occludes whatever
    // sits under it — GitHub issue #293 follow-up) — the border is always drawn in `borderColor` on
    // top, regardless of fill state.
    drawMarkerWithBorder(g, shape, cx, cy, r, rounded, filled ? color : floorColor, borderColor, borderWidth);
  }

  destroy(): void {
    this.view.destroy({ children: true });
    this.overlayLayer.destroy({ children: true });
  }
}

export { clipDistance, computeMixedCells, resolvePointFillState, planGroupDrawOrder } from "./teleportGeometry";
export type { PointFillState } from "./teleportGeometry";
