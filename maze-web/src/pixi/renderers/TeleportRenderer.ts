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

function coordKey(x: number, y: number): string {
  return `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
}

/** Distance from a square marker's center to the point where a line along unit direction
 * (ux, uy) should stop: the square's border along that direction (Chebyshev distance,
 * half / max(|ux|, |uy|)), plus half the stroke width to compensate for the round line cap
 * extending past its geometric endpoint. Using a flat `half` alone undershoots at
 * non-axis-aligned angles and the cap still overlaps the square. `TeleportRenderer` itself no
 * longer clips its own connecting line (GitHub issue #293 follow-up: it now runs straight
 * center-to-center, occluded by the marker shapes drawn in a layer above it) — this export is kept
 * for `PostEditRenderer`/`PresetConnectionsRenderer`, which still clip their own teleport-endpoint
 * connecting lines to a fixed square marker's border the pre-#293 way. */
export function clipDistance(ux: number, uy: number, half: number, strokeWidth: number): number {
  return half / Math.max(Math.abs(ux), Math.abs(uy)) + strokeWidth / 2;
}

/** A cell/point reads as half-filled when the markers landing on it disagree: at least one edge
 * wants a filled marker there and at least one (a different edge) wants an outline marker there.
 * Returns the set of coordKey-encoded points that are mixed. */
export function computeMixedCells(edges: TeleportEdge[]): Set<string> {
  const cellWants = new Map<string, { filled: boolean; outline: boolean }>();
  const want = (cx: number, cy: number, filled: boolean) => {
    const key = coordKey(cx, cy);
    const entry = cellWants.get(key) ?? { filled: false, outline: false };
    if (filled) entry.filled = true; else entry.outline = true;
    cellWants.set(key, entry);
  };
  for (const e of edges) {
    if (e.oneWay) {
      want(e.from[0], e.from[1], true);
      want(e.to[0], e.to[1], false);
    } else {
      want(e.from[0], e.from[1], true);
      want(e.to[0], e.to[1], true);
    }
  }
  const mixed = new Set<string>();
  for (const [key, entry] of cellWants) {
    if (entry.filled && entry.outline) mixed.add(key);
  }
  return mixed;
}

/** `"filled"` when every edge landing on this point wants it filled (an entry, or either end of a
 *  two-way), `"outline"` when every edge wants it empty (an exit-only one-way endpoint), `"mixed"`
 *  when edges disagree (rare: two different teleports through the same point, one wanting it
 *  filled, the other empty). */
export type PointFillState = "filled" | "outline" | "mixed";

export function resolvePointFillState(edges: TeleportEdge[], cx: number, cy: number): PointFillState {
  const key = coordKey(cx, cy);
  let filled = false;
  let outline = false;
  for (const e of edges) {
    if (e.oneWay) {
      if (coordKey(e.from[0], e.from[1]) === key) filled = true;
      if (coordKey(e.to[0], e.to[1]) === key) outline = true;
    } else {
      if (coordKey(e.from[0], e.from[1]) === key || coordKey(e.to[0], e.to[1]) === key) filled = true;
    }
  }
  if (filled && outline) return "mixed";
  return filled ? "filled" : "outline";
}

type PlannedConnector = { edge: TeleportEdge; routed: RoutedConnector; color: number };

/** Resolves the per-group draw order `renderGroups` walks: one entry per *visible* group (in
 *  `groups`' own order — `selectedKey === null` means every group is visible, otherwise only the
 *  matching one), each carrying just its own connectors (an edge's own two endpoints always land
 *  in the same group — the edge itself is what `buildTeleportGroups` merges on — so every connector
 *  belongs to exactly one group unambiguously). Pure/no drawing, so the interleave order itself
 *  (a group's connectors immediately before its own points, then the next group — GitHub issue #293
 *  follow-up) is unit-testable without a `Graphics` mock. A connector whose endpoints don't resolve
 *  to any group (shouldn't happen given the above, but a defensive no-op rather than a throw) is
 *  silently dropped from the plan. */
export function planGroupDrawOrder(
  groups: TeleportGroup[],
  connectors: PlannedConnector[],
  selectedKey: string | null,
): { group: TeleportGroup; connectors: PlannedConnector[] }[] {
  const visible = (key: string): boolean => selectedKey === null || selectedKey === key;

  const groupKeyByPoint = new Map<string, string>();
  for (const group of groups) {
    for (const [px, py] of group.points) groupKeyByPoint.set(coordKey(px, py), group.key);
  }
  const connectorsByGroup = new Map<string, PlannedConnector[]>();
  for (const c of connectors) {
    const [fx, fy] = c.edge.from;
    const groupKey = groupKeyByPoint.get(coordKey(fx, fy)) ?? groupKeyByPoint.get(coordKey(...c.edge.to));
    if (groupKey === undefined) continue;
    const bucket = connectorsByGroup.get(groupKey) ?? [];
    bucket.push(c);
    connectorsByGroup.set(groupKey, bucket);
  }

  return groups.filter((g) => visible(g.key)).map((group) => ({ group, connectors: connectorsByGroup.get(group.key) ?? [] }));
}

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
  private unsubscribeSelection: (() => void) | null = null;
  // Kept between `render()` calls so a selection change alone (no full re-render) can redraw
  // `view` from scratch with the new selected key's visibility split, without recomputing
  // groups/routing from the raw `edges` again.
  private selectionGroups: TeleportGroup[] = [];
  private selectionStyle: TeleportLineStyle = DEFAULT_LINE_STYLE;
  private selectionGroupOverrides: Record<string, TeleportGroupOverride> = {};
  private selectionEdges: TeleportEdge[] = [];
  private selectionInteractive = false;
  // One entry per drawn connector (edges with non-zero-length span only) — same rationale.
  private selectionConnectors: { edge: TeleportEdge; routed: RoutedConnector; color: number }[] = [];
  // Owns orthogonal-connector collision routing + its own result cache (GitHub issue #297
  // follow-up) — one instance per `TeleportRenderer`, so a repeat `render()` call with the same
  // (by value) edges/style/cfg reuses the previous routing instead of recomputing it.
  private readonly connectorRouter = new TeleportConnectorRouter();

  constructor(container: Container) {
    this.view = new Graphics();
    container.addChild(this.view);
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
    this.selectionInteractive = groupCustomization && interactive;
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
   *  `renderGroups`'s own 3-pass doc comment). No-op when `edgeGapWidth` is `0`. */
  private drawGroupGaps(
    g: Graphics,
    group: TeleportGroup,
    style: TeleportLineStyle,
  ): void {
    if (style.edgeGapWidth <= 0) return;
    // This marker's own border is drawn `alignment: 0` (pixi's outer alignment — grows entirely
    // outward from `r`, see `drawMarker`), so the marker's true outer edge is `r + borderWidth`, not
    // `r` itself — the gap ring must start there, not at `r` (which would let a large enough
    // `borderWidth` visually swallow the gap) or at `r + borderWidth/2` (the waypoint marker's own
    // centered-border formula, wrong here since this border isn't centered).
    const r = style.size * TILE_SIZE + style.borderWidth + style.edgeGapWidth;
    const rounded = style.cornerStyle === "round";
    for (const [px, py] of group.points) {
      drawMarkerShape(g, style.shape, px, py, r, rounded);
      g.fill(style.floorColor);
    }
  }

  /** Draws every point of one group (its shape/fillColor/borderColor resolved from `override`, or
   *  `style`'s own base fields when absent) into `g`. */
  private drawGroupPoints(
    g: Graphics,
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
      const fillState = resolvePointFillState(edges, px, py);
      this.drawMarker(
        g, shape, style.cornerStyle, r, px, py,
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
    const style = this.selectionStyle;
    const r = style.size * TILE_SIZE;

    const plan = planGroupDrawOrder(this.selectionGroups, this.selectionConnectors, selectedKey);

    for (const { group, connectors } of plan) {
      this.drawGroupGaps(this.view, group, style);
      for (const c of connectors) {
        this.drawRoutedConnector(this.view, c.routed, style, c.color, c.edge.oneWay);
      }
      const override = this.selectionGroupOverrides[group.key];
      this.drawGroupPoints(this.view, group, override, this.selectionEdges, style);
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
   *  rectangle, so a plain clipped fill can't be built from `shape`'s path alone) — the mask is
   *  never added to `g`, only assigned to a second pass's `.mask`, so it doesn't itself render or
   *  get destroyed with `g`. */
  private drawMarker(
    g: Graphics,
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
      g.addChild(mask);
      g.addChild(halfFillView);
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
  }
}
