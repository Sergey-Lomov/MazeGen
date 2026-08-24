import { Container, Graphics } from "pixi.js";
import type { TeleportEdge, TeleportLineStyle, TeleportGroupOverride } from "./types";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { TILE_SIZE } from "../constants";
import { canvas } from "../colorTokens";
import { drawMarkerShape, markerBoundingHalfExtent } from "./markerShapes";
import { drawDirectionArrow } from "./wallUtils";
import { routeStraightConnectors, arrowPlacements, type RoutedConnector } from "./teleportConnectorRouting";
import { TeleportConnectorRouter, type EndpointMarkerStyle } from "./teleportConnectorRouter";
import { buildTeleportGroups, type TeleportGroup } from "../selectors/teleportGroups";
import { useMazeStore } from "../../store/mazeStore";
import { attachFloorBadgeNavigation, drawFloorBadge, FLOOR_BADGE_STROKE_WIDTH } from "./floorBadge";
import { coordKey, computeFloorBadges, resolvePointFillState, planGroupDrawOrder } from "./teleportGeometry";

const SQUARE_STROKE_WIDTH = 3;
/** Extra radius (GitHub issue #293 follow-up) beyond the shape's own drawn radius for a group's
 *  click hit area (only drawn when group customization + `interactive` are both on) — a shape
 *  drawn with `borderWidth: 0` has nothing visually marking its true clickable extent, so the hit
 *  circle is deliberately a bit larger than the shape itself rather than matching it exactly. */
const HIT_AREA_PADDING = 4;

const DEFAULT_LINE_STYLE: TeleportLineStyle = {
  shape: "diamond",
  cornerStyle: "round",
  size: 0.16,
  edgeColor: canvas.teleport.default,
  edgeBorderColor: canvas.teleport.default,
  borderWidth: SQUARE_STROKE_WIDTH,
  edgeGapWidth: 3,
  connectorColor: canvas.teleport.default,
  connectorWidth: SQUARE_STROKE_WIDTH,
  connectorStyle: "orthogonal",
  arrowMode: "periodic",
  arrowPeriod: 5,
  arrowSize: 10,
  connectorGapWidth: SQUARE_STROKE_WIDTH,
  floorColor: canvas.floor.default,
};


/** Renders teleport connectors + markers into one persistent `Graphics` (`view`) per full
 *  `render()` call. GitHub issue #293's group-customization selection highlight (hide every group
 *  but the *selected* one — click-driven, not hover, per the issue's own follow-up: hover-driven
 *  hiding flickered whenever the pointer crossed a gap between two groups' hit areas) simply skips
 *  drawing a non-selected group's own points/connectors at all, rather than dimming them via
 *  `Container.alpha` on a per-group sub-container or a per-draw `alpha` — `Container.alpha`
 *  composites each child's already-rasterized output independently, so overlapping translucent
 *  shapes (a marker sitting on its own connector's endpoint, which is *guaranteed* for every
 *  teleport point) show each other through at the seam; `cacheAsTexture`/`isRenderGroup` were both
 *  tried as fixes and abandoned — the former requires manually keeping a texture's resolution in
 *  sync with viewport zoom (fragile, went blurry on real use), the latter didn't fix the see-through
 *  seam in practice; per-draw `alpha: 0` (tried next) sidestepped the seam issue but still spent
 *  CPU/GPU work drawing fully-invisible geometry (masks included) on every selection change, for no
 *  visual benefit. Skipping the draw call entirely is both simpler and cheaper. */
export class TeleportRenderer {
  // One shared `Graphics` for everything (connectors + markers, both modes) — not split into
  // separate line/marker layers, so draw order (which this class now interleaves per group: a
  // group's own connectors, then its own points, then the next group's connectors, ...) is the
  // actual z-order rather than "every connector below every marker" regardless of grouping.
  private readonly view: Graphics;
  /** Hosts every child that can't live on `this.view` itself (a `Graphics` instance) — floor-badge
   *  digit `Text` (`drawFloorBadge`), floor-badge hit-circles (`attachFloorBadgeNavigation`), and a
   *  `mixed` marker's mask/half-fill `Graphics` pair (`drawMarker`) — PixiJS v8 deprecates `addChild`
   *  on non-`Container` objects and disallows it in a future major version (GitHub issue #432). A
   *  sibling layer drawn above `this.view`, cleared/rebuilt alongside it every render. */
  private readonly overlayLayer: Container;
  private unsubscribeSelection: (() => void) | null = null;
  // Kept between `render()` calls so a selection change alone (no full re-render) can redraw
  // `view` from scratch with the new selected key's visibility split, without recomputing
  // groups/routing from the raw `edges` again.
  private selectionGroups: TeleportGroup[] = [];
  private selectionStyle: TeleportLineStyle = DEFAULT_LINE_STYLE;
  private selectionGroupOverrides: Record<string, TeleportGroupOverride> = {};
  private selectionEdges: TeleportEdge[] = [];
  private selectionInteractive = false;
  // Cross-floor points (GitHub issue #337) — a point present here draws a floor-number badge
  // instead of an ordinary marker in `drawGroupPoints`. Keyed the same way `selectionEdges` drives
  // `resolvePointFillState`, recomputed alongside it in `renderLine`.
  private selectionFloorBadges: Map<string, number> = new Map();
  // GitHub issue #337 follow-up: whether a badge point's hit-circle (added in `drawGroupPoints`)
  // wires click-to-switch-floor — independent of `selectionInteractive` (the group-selection
  // feature), see `render`'s own `floorNavigable` doc comment.
  private selectionFloorNavigable = false;
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
   *  logic are unaffected either way. `interactive` (only set by `VectorByWallsRenderer` while its
   *  Teleports settings section is open, and only meaningful when `groupCustomization` is on) wires
   *  click-to-select on each group's points to `selectedTeleportGroupKey` in the store, for the
   *  settings panel's row<->canvas selection sync. */
  render(data: {
    edges: TeleportEdge[];
    lineStyle?: TeleportLineStyle;
    groupCustomization?: boolean;
    groupOverrides?: Record<string, TeleportGroupOverride>;
    interactive?: boolean;
    /** The active tessellation, so `"orthogonal"` connectors bend along that tessellation's own
     *  face directions (GitHub issue #297) instead of always assuming a square grid. Omitted by
     *  callers without a config in hand, which falls back to the original square (h/v) behavior. */
    cfg?: TessellationConfig;
    /** World positions of the start/finish markers (GitHub issue #300) — an `"orthogonal"`
     *  connector always avoids cutting through these, same weight as another connector's own
     *  endpoint. Omitted by callers without waypoint markers in hand (no penalty applied). */
    waypoints?: [number, number][];
    /** "Avoid field exit" toggle (GitHub issue #300) — when on, an `"orthogonal"` connector strongly
     *  prefers any candidate that stays within the maze field's own cell footprint (`fieldCells`)
     *  over one that steps outside it. */
    avoidFieldExit?: boolean;
    /** The maze's own node cell coordinates, backing the `avoidFieldExit` check above — omitted or
     *  empty is the same as leaving `avoidFieldExit` off (nothing to be outside of). */
    fieldCells?: [number, number][];
    /** Wires click-to-switch-floor (GitHub issue #337 follow-up) on every cross-floor badge point
     *  (`selectionFloorBadges`) — independent of `groupCustomization`/`interactive` above (those
     *  gate the unrelated group-selection feature): a badge is clickable whenever this is on,
     *  regardless of group customization state. Defaults to `false` — only `GenerationRenderer`
     *  (a read-only, always-interactive canvas) opts in today. */
    floorNavigable?: boolean;
  }): void {
    this.view.clear();
    // `drawMarker`'s mixed-cell split adds throwaway mask/fill children (see its own comment) —
    // `.clear()` only resets the drawn path, not added children, so those must be destroyed
    // explicitly or they'd accumulate (and leak GPU resources) across renders.
    this.view.removeChildren().forEach((c) => c.destroy());

    this.renderLine(
      data.edges,
      data.lineStyle ?? DEFAULT_LINE_STYLE,
      data.groupCustomization ?? false,
      data.groupOverrides ?? {},
      data.interactive ?? false,
      data.cfg,
      data.waypoints ?? [],
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
    interactive: boolean,
    cfg: TessellationConfig | undefined,
    waypoints: [number, number][],
    avoidFieldExit: boolean,
    fieldCells: [number, number][],
    floorNavigable: boolean,
  ): void {
    // Grouping (`buildTeleportGroups`, merging teleport pairs wherever an endpoint coordinate
    // coincides) drives draw order regardless of whether group *customization* (per-group shape/
    // color overrides + click-to-select) is on — a group's own connectors are drawn immediately
    // before its own points, then the next group's connectors, etc. (see `renderGroups`), so
    // `groupCustomization` only gates whether `groupOverrides` are applied and whether selection
    // highlighting/click-to-select is wired up, not the grouping/ordering itself.
    const groups = buildTeleportGroups(edges);
    this.selectionGroups = groups;
    this.selectionStyle = style;
    this.selectionGroupOverrides = groupCustomization ? groupOverrides : {};
    this.selectionEdges = edges;
    this.selectionFloorBadges = computeFloorBadges(edges);
    this.selectionInteractive = groupCustomization && interactive;
    this.selectionFloorNavigable = floorNavigable;
    this.selectionConnectors =
      style.connectorStyle !== "none"
        ? this.computeConnectors(edges, style, groupCustomization, groupOverrides, cfg, waypoints, avoidFieldExit, fieldCells)
        : [];

    this.renderGroups(groupCustomization ? useMazeStore.getState().selectedTeleportGroupKey : null);
    if (this.selectionInteractive) this.subscribeSelectionHighlight();
    else this.unsubscribeSelection?.();
  }

  /** Resolves every drawable (non-zero-length) connector in `edges` into its routed polyline +
   *  final color — pure computation, no drawing, so `renderGroups` can redraw the result (or skip a
   *  hidden group's own connectors) on every selection change without re-running collision routing
   *  each time. */
  private computeConnectors(
    edges: TeleportEdge[],
    style: TeleportLineStyle,
    groupCustomization: boolean,
    groupOverrides: Record<string, TeleportGroupOverride>,
    cfg: TessellationConfig | undefined,
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

    // Includes the gap once (not doubled) — two adjacent connectors' gaps are allowed to
    // overlap a bit, only their core lines need to stay visually distinct.
    const gap = (style.connectorWidth + style.connectorGapWidth) * 1.5;
    // `edgeGapWidth` (GitHub issue #302) folded into `markerBorderWidth` here — the marker's real
    // visual footprint that `endpointCollisionRadius`/corridor-offset clamping must stay clear of is
    // `size*TILE_SIZE + borderWidth + edgeGapWidth` (see `drawGroupGaps`'s own `r` formula), not
    // just `size*TILE_SIZE + borderWidth` — omitting the gap ring here would let another connector's
    // routed path visually cut through it even though it correctly avoids the marker/border proper.
    const endpointRadius = style.size * TILE_SIZE;
    const endpointStyle: EndpointMarkerStyle = {
      markerRadius: endpointRadius,
      markerBorderWidth: style.borderWidth + style.edgeGapWidth,
      connectorGapWidth: style.connectorGapWidth,
      connectorWidth: style.connectorWidth,
    };
    const routed =
      style.connectorStyle === "orthogonal"
        ? this.connectorRouter.route(
            edges, gap, endpointRadius + style.borderWidth + style.edgeGapWidth, cfg, endpointStyle, waypoints, avoidFieldExit, fieldCells,
          )
        : routeStraightConnectors(edges);

    const result: { edge: TeleportEdge; routed: RoutedConnector; color: number }[] = [];
    edges.forEach((e, i) => {
      const [fx, fy] = e.from;
      const [tx, ty] = e.to;
      if (fx === tx && fy === ty) return;
      // A connector's own color/border can be overridden by *either* end's group (whichever one
      // has an override) — same "one color drives border + connector" rule as the marker itself
      // (see `TeleportGroupOverride`'s own doc comment).
      const override = overrideAt(fx, fy) ?? overrideAt(tx, ty);
      const connectorColor = override?.borderColor ?? style.connectorColor;
      result.push({ edge: e, routed: routed[i], color: connectorColor });
    });
    return result;
  }

  /** Draws every point of one group's floor-colored gap ring (`style.edgeGapWidth`, GitHub issue
   *  #302) into `g` — a separate pass from `drawGroupPoints` itself, called before any connector so
   *  that every connector (this point's own or another's) draws on top of it (see
   *  `renderGroups`'s own 3-pass doc comment). A point flagged in `selectionFloorBadges` (GitHub
   *  issue #337) draws its own plain circular gap ring instead (`drawFloorBadge`'s own border is
   *  always `FLOOR_BADGE_STROKE_WIDTH`, not `style.borderWidth` — the badge isn't a `style.shape`
   *  marker, see that method's own doc comment) — unconditional, unlike the ordinary marker's ring below,
   *  since a badge with no gap at all reads as fused to whatever connector segment runs under it.
   *  No-op for ordinary points when `edgeGapWidth` is `0`. */
  private drawGroupGaps(
    g: Graphics,
    group: TeleportGroup,
    style: TeleportLineStyle,
  ): void {
    // This marker's own border is drawn `alignment: 0` (pixi's outer alignment — grows entirely
    // outward from `r`, see `drawMarker`), so the marker's true outer edge is `r + borderWidth`, not
    // `r` itself — the gap ring must start there, not at `r` (which would let a large enough
    // `borderWidth` visually swallow the gap) or at `r + borderWidth/2` (the waypoint marker's own
    // centered-border formula, wrong here since this border isn't centered).
    const r = style.size * TILE_SIZE + style.borderWidth + style.edgeGapWidth;
    const rounded = style.cornerStyle === "round";
    for (const [px, py] of group.points) {
      if (this.selectionFloorBadges.has(coordKey(px, py))) {
        const badgeR = style.size * TILE_SIZE + FLOOR_BADGE_STROKE_WIDTH + Math.max(style.edgeGapWidth, 1);
        g.circle(px, py, badgeR).fill(style.floorColor);
        continue;
      }
      if (style.edgeGapWidth <= 0) continue;
      drawMarkerShape(g, style.shape, px, py, r, rounded);
      g.fill(style.floorColor);
    }
  }

  /** Draws every point of one group (its shape/fillColor/borderColor resolved from `override`, or
   *  `style`'s own base fields when absent) into `g` — a point flagged in `selectionFloorBadges`
   *  (GitHub issue #337, a cross-floor edge's midpoint) draws a floor-number badge instead, via
   *  `drawFloorBadge`. */
  private drawGroupPoints(
    g: Graphics,
    overlay: Container,
    group: TeleportGroup,
    override: TeleportGroupOverride | undefined,
    edges: TeleportEdge[],
    style: TeleportLineStyle,
  ): void {
    const r = style.size * TILE_SIZE;
    const shape = override?.shape ?? style.shape;
    const color = override?.fillColor ?? style.edgeColor;
    const borderColor = override?.borderColor ?? style.edgeBorderColor;
    for (const [px, py] of group.points) {
      const floorNumber = this.selectionFloorBadges.get(coordKey(px, py));
      if (floorNumber !== undefined) {
        drawFloorBadge(g, overlay, r, px, py, color, borderColor, style.floorColor, floorNumber);
        if (this.selectionFloorNavigable) {
          attachFloorBadgeNavigation(overlay, px, py, r, floorNumber - 1);
        }
        continue;
      }
      const fillState = resolvePointFillState(edges, px, py);
      this.drawMarker(
        g, overlay, shape, style.cornerStyle, r, px, py,
        color, borderColor, style.borderWidth, style.floorColor,
        fillState === "filled", fillState === "mixed",
      );
    }
  }

  /** Every group's gaps + connectors + points (which is every point/connector, once
   *  `buildTeleportGroups` has run: an edge with usable node ids always lands in some group, even a
   *  group of one) are (re-)drawn into `view` here, one group at a time — a group's own gap rings,
   *  then its own connectors, then its own points, then the next group (GitHub issue #302: within
   *  one group this guarantees its own connectors/points are never visually cut by its own gap
   *  rings — a group's gap only ever needs to stay clear of *that same* group's own connector/marker
   *  geometry, so a 3-sub-pass block per group is enough, no global gap/connector/marker split is
   *  needed). A whole later group's block (gaps, connectors and points alike) draws on top of a
   *  whole earlier group's block, same "later group wins" rule the pre-#302 single interleaved pass
   *  used. Drawn (visible) if its group is `selectedKey`, or every group when nothing is selected
   *  (`selectedKey === null`), skipped entirely otherwise. Called once by `renderLine` (full rebuild,
   *  which already cleared `view` itself) and again by `subscribeSelectionHighlight` on every
   *  selection change alone (cheap re-run over already-computed groups/routing, no raw-`edges`
   *  recomputation) — that second case needs its own clear, `renderLine`'s doesn't cover it.
   *  `interactive` (captured in `selectionInteractive` by `renderLine`) additionally adds an
   *  invisible padded hit-circle per point — for *every* group, regardless of which one is currently
   *  visible, so a hidden group still has somewhere to click and re-select it — and wires
   *  click-to-select for the canvas->row half of the selection sync. */
  private renderGroups(selectedKey: string | null): void {
    this.view.clear();
    this.view.removeChildren().forEach((c) => c.destroy());
    this.overlayLayer.removeChildren().forEach((c) => c.destroy());
    const style = this.selectionStyle;
    const r = style.size * TILE_SIZE;

    const plan = planGroupDrawOrder(this.selectionGroups, this.selectionConnectors, selectedKey);

    for (const { group, connectors } of plan) {
      this.drawGroupGaps(this.view, group, style);
      for (const c of connectors) {
        this.drawRoutedConnector(this.view, c.routed, style, c.color, c.edge.oneWay);
      }
      const override = this.selectionGroupOverrides[group.key];
      this.drawGroupPoints(this.view, this.overlayLayer, group, override, this.selectionEdges, style);
    }

    if (this.selectionInteractive) {
      for (const group of this.selectionGroups) {
        for (const [px, py] of group.points) {
          // A shape drawn with `borderWidth: 0` has no visual footprint marking its clickable
          // extent — the hit area is its own circle, deliberately padded a bit larger than the
          // shape, not the shape's own (possibly non-circular) path. Drawn for every group,
          // including hidden ones, so the pointer can still click and re-select them.
          this.view.circle(px, py, r + HIT_AREA_PADDING).fill({ color: 0, alpha: 0 });
        }
      }
      this.wireGroupInteractivity();
    }
  }

  /** Draws one connector's routed polyline (`RoutedConnector.points`, 2 points for `"straight"`, 3
   *  for `"orthogonal"`'s single bend) as a stroked path, plus every direction arrow `oneWay`'s
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
    if (mixed) {
      drawMarkerShape(g, shape, cx, cy, r, rounded);
      g.fill(floorColor);
      drawMarkerShape(g, shape, cx, cy, r, rounded);
      g.stroke({ width: borderWidth, color: borderColor, alignment: 0 });

      // The filled half is drawn at a slightly larger size than the outline (`r` grown by half the
      // border width) so it reaches under the border stroke all the way around instead of butting
      // exactly against its inner edge — same shape, same diagonal cut, just scaled up as a whole.
      // The mask is built from the *same* corner-to-corner formula at the *enlarged* half-extent,
      // not the outline's own `half` — that keeps the cut exactly on the enlarged shape's own true
      // diagonal, at the same relative position a same-size mask would put it on a same-size shape,
      // instead of cutting a bigger shape with a smaller shape's diagonal (which either skews the
      // cut or leaves the enlarged shape poking out past the border, depending on which corners get
      // moved — both tried and rejected in earlier versions).
      const bleed = borderWidth / 2;
      const bigHalf = markerBoundingHalfExtent(shape, r + bleed);
      const mask = new Graphics()
        .moveTo(cx - bigHalf, cy - bigHalf)
        .lineTo(cx + bigHalf, cy - bigHalf)
        .lineTo(cx - bigHalf, cy + bigHalf)
        .closePath()
        .fill(0xffffff);
      const halfFillView = new Graphics();
      drawMarkerShape(halfFillView, shape, cx, cy, r + bleed, rounded);
      halfFillView.fill(color);
      halfFillView.mask = mask;
      overlay.addChild(mask);
      overlay.addChild(halfFillView);
      return;
    }

    // Fill color depends on `filled` (own color) vs. empty (floor color, so it occludes whatever
    // sits under it — GitHub issue #293 follow-up) — the border is always drawn in `borderColor` on
    // top, regardless of fill state.
    drawMarkerShape(g, shape, cx, cy, r, rounded);
    g.fill(filled ? color : floorColor);
    // `alignment: 0` is pixi's outer alignment — the border grows entirely outward from `r`, so
    // both an empty and a filled marker share the same `r` fill/inner-border edge; the border
    // itself extends the marker's true visual footprint to `r + borderWidth` either way.
    drawMarkerShape(g, shape, cx, cy, r, rounded);
    g.stroke({ width: borderWidth, color: borderColor, alignment: 0 });
  }

  /** Wires click-to-select (`pointertap`) on `view` as a whole, resolving which group a click
   *  landed in by finding the *nearest* point across every group to the event's local position
   *  within a fixed hit radius — one shared listener on the single shared `Graphics`, rather than
   *  one `Graphics`/listener pair per group (not possible when every group draws into the same
   *  `Graphics` — see this class's own doc comment). Clicking the currently selected group's
   *  own marker again clears the selection (toggle) — the settings panel offers the same toggle via
   *  its own row click. Gaps between two nearby points' own hit circles don't matter here the way
   *  they did for hover (an earlier, abandoned approach) — a click landing in such a gap simply
   *  selects nothing, no flicker, since there's no continuous pointer-tracked state to desync. */
  private wireGroupInteractivity(): void {
    // `renderGroups` re-runs this on every selection change (not just the initial `render()`), and
    // `view` itself is never recreated (`.clear()` only resets the drawn path) — without
    // removing the previous listener first, each click on the canvas would pile another
    // `pointertap` handler onto the same `Graphics`, so click *N* fires all *N* accumulated stale
    // handlers (each doing its own O(points) nearest-point scan and its own store write, which
    // synchronously re-enters this method again) — a freeze that gets worse with every click.
    this.view.off("pointertap");
    this.view.eventMode = "static";
    this.view.cursor = "pointer";
    const r = this.selectionStyle.size * TILE_SIZE;
    const hitRadius = r + HIT_AREA_PADDING;

    // Bucket every point into `hitRadius`-sized grid cells so a click only scans its own 3x3
    // neighborhood instead of every point of every group — matters once a maze has hundreds of
    // teleport points (a plain full scan is still cheap at typical sizes, but scales linearly with
    // point count for no reason when a spatial bucket is this simple to build).
    const cellOf = (v: number): number => Math.floor(v / hitRadius);
    const cellKey = (cx: number, cy: number): string => `${cx},${cy}`;
    const buckets = new Map<string, { key: string; x: number; y: number }[]>();
    for (const group of this.selectionGroups) {
      for (const [px, py] of group.points) {
        const k = cellKey(cellOf(px), cellOf(py));
        const bucket = buckets.get(k) ?? [];
        bucket.push({ key: group.key, x: px, y: py });
        buckets.set(k, bucket);
      }
    }
    const groupKeyAt = (x: number, y: number): string | null => {
      let best: { key: string; dist: number } | null = null;
      const cx = cellOf(x);
      const cy = cellOf(y);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const p of buckets.get(cellKey(cx + dx, cy + dy)) ?? []) {
            const dist = Math.hypot(p.x - x, p.y - y);
            if (dist <= hitRadius && (best === null || dist < best.dist)) best = { key: p.key, dist };
          }
        }
      }
      return best?.key ?? null;
    };
    this.view.on("pointertap", (event) => {
      const local = this.view.toLocal(event.global);
      const key = groupKeyAt(local.x, local.y);
      if (key === null) return;
      const current = useMazeStore.getState().selectedTeleportGroupKey;
      useMazeStore.getState().setSelectedTeleportGroupKey(current === key ? null : key);
    });
  }

  /** Mirrors a panel-row selection (set via `setSelectedTeleportGroupKey` from
   *  `VectorByWallsSettingsPanel`) back onto the matching group's canvas markers by fully re-running
   *  `renderGroups` with the new selected key — cheap (already-computed groups/routing, no raw-
   *  `edges` recomputation), and avoids the whole `Container.alpha`/`cacheAsTexture` class of bugs
   *  this class's own doc comment describes. The canvas->row half is `pointertap` (see
   *  `wireGroupInteractivity`) driving `selectedTeleportGroupKey`, read back by the panel for its
   *  own row styling. */
  private subscribeSelectionHighlight(): void {
    this.unsubscribeSelection?.();
    let prevKey: string | null = null;
    const apply = (key: string | null) => {
      this.renderGroups(key);
    };
    prevKey = useMazeStore.getState().selectedTeleportGroupKey;
    this.unsubscribeSelection = useMazeStore.subscribe((state) => {
      if (state.selectedTeleportGroupKey !== prevKey) {
        prevKey = state.selectedTeleportGroupKey;
        apply(prevKey);
      }
    });
  }

  destroy(): void {
    this.unsubscribeSelection?.();
    this.view.destroy({ children: true });
    this.overlayLayer.destroy({ children: true });
  }
}

export { clipDistance, computeMixedCells, resolvePointFillState, planGroupDrawOrder } from "./teleportGeometry";
export type { PointFillState } from "./teleportGeometry";
