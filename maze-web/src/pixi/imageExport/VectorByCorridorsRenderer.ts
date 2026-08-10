import { Container, Graphics } from "pixi.js";
import { useMazeStore } from "../../store/mazeStore";
import { buildCorridorSegments, buildMazeMarkers, buildTeleportEdges, buildSplitPassages, maxSplitNodeCount, type CorridorSegment } from "../selectors/mazeSelectors";
import { chainSegmentsAtSharedVertices } from "../renderers/WallRenderer";
import { WaypointsRenderer } from "../renderers/WaypointsRenderer";
import { TeleportRenderer } from "../renderers/TeleportRenderer";
import { drawMarkerWidenPatches } from "../renderers/markerWidenPatches";
import { drawOneWayChevronRow } from "../renderers/wallUtils";
import { buildTeleportGroups, type TeleportGroup } from "../selectors/teleportGroups";
import { resolveEffectiveEndpoints, buildMarkerStyle, buildTeleportLineStyle, buildEffectiveSplitNodeColors, BackgroundGridLayer, ExportWarningHighlight } from "./VectorByWallsRenderer";
import { computeVectorByCorridorsWarnings } from "../selectors/exportWarnings";
import type { NodeDto, EdgeDto } from "../../wasm/types";
import type { Viewport, TeleportEdge, MarkerData, SplitPassage, SplitSpecialShape } from "../renderers/types";
import type { VectorByCorridorsSettings } from "../../store/storeTypes";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { TILE_SIZE } from "../constants";
import { canvas } from "../colorTokens";
import { disabledOfNumber } from "../../styles/palette";
import type { ModeRenderer } from "./modeRendererFactory";
import { computeVectorByCorridorsExportMargin, resolveBackgroundColor, type ExportMargin } from "./exportMargins";

/** Builds one `MarkerData` per unique teleport point (GitHub issue #313 follow-up: teleport markers
 *  also need their corridor-line widen patch, same `markerWidenPadding` waypoints use — no separate
 *  teleport-specific padding setting) so `drawMarkerWidenPatches` can widen the corridor stroke
 *  under them exactly like it does for start/finish markers. Each point's own shape/corner style
 *  come from its group's `TeleportGroupOverride` when `teleportGroupCustomization` is on and that
 *  group has one, else the base `teleportLineShape`/`teleportLineCornerStyle` — the widen patch must
 *  match what `TeleportRenderer` actually draws there, not always the base shape, so it doesn't leave
 *  a mismatched corner poking out from under a group-customized marker. Only `shape`/`cornerStyle`/
 *  `radius` matter here (widen patches are drawn in the corridor's own color, not the marker's), so
 *  `color`/`borderWidth`/`gapWidth` are omitted (`color: 0` is an unused placeholder — `MarkerData`
 *  requires it, `drawMarkerWidenPatches` never reads it). Exported as a pure function, same
 *  testability rationale as `VectorByWallsRenderer`'s `buildWallStyle`/`buildTeleportLineStyle`/
 *  `buildMarkerStyle` — a point-dedup + per-group-override resolution is worth unit-testing directly
 *  rather than only indirectly through mocked `Graphics` draw calls. `groups` is precomputed by the
 *  caller (`renderAll`) rather than recomputed here via `buildTeleportGroups` — `TeleportRenderer`'s
 *  own `render()` already computes the exact same grouping internally for the same `teleportEdges`,
 *  so a second call here would repeat that union-find work for no reason every render. */
export function buildTeleportWidenMarkers(teleportEdges: TeleportEdge[], settings: VectorByCorridorsSettings, groups: TeleportGroup[]): MarkerData[] {
  const overrideByPoint = new Map<string, VectorByCorridorsSettings["teleportGroupOverrides"][string]>();
  for (const group of groups) {
    const override = settings.teleportGroupOverrides[group.key];
    if (!override) continue;
    for (const [px, py] of group.points) overrideByPoint.set(`${px},${py}`, override);
  }

  const radius = settings.teleportLineSize * TILE_SIZE;
  const seen = new Set<string>();
  const markers: MarkerData[] = [];
  for (const e of teleportEdges) {
    for (const pos of [e.from, e.to]) {
      const key = `${pos[0]},${pos[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const override = overrideByPoint.get(key);
      markers.push({
        pos,
        color: 0,
        radius,
        shape: override?.shape ?? settings.teleportLineShape,
        cornerStyle: settings.teleportLineCornerStyle,
        borderWidth: settings.teleportEdgeBorderWidth,
        gapWidth: settings.teleportEdgeGapWidth,
      });
    }
  }
  return markers;
}

/** Computes the square-cap "restore" patch geometry for a plain corridor chain's own free end that
 *  butts against a split tile at its *other* end (GitHub issue #314 follow-up) — pure function,
 *  extracted out of `renderAll`'s own split-touch cap-restore logic so this geometry is directly
 *  unit-testable rather than only reachable through mocked-`Graphics` draw-call assertions. `freeEnd`
 *  is the path's own ordinary (non-split) endpoint, `neighbor` is the adjacent path point one step
 *  in from it (used only to find the path's own local direction there), `width` is the stroke's own
 *  full width. Returns the four corners of a `width`-square cap extending `width/2` past `freeEnd`
 *  along the path's own direction, in draw order (a simple quad, not self-intersecting) — the same
 *  shape Pixi's own `cap: "square"` would draw at an ordinary (non-`butt`) stroke end. */
export function computeSquareCapPatch(
  freeEnd: { x: number; y: number },
  neighbor: { x: number; y: number },
  width: number,
): [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }] {
  const dx = freeEnd.x - neighbor.x, dy = freeEnd.y - neighbor.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const half = width / 2;
  const nx = -uy * half, ny = ux * half;
  const tipX = freeEnd.x + ux * half, tipY = freeEnd.y + uy * half;
  return [
    { x: freeEnd.x + nx, y: freeEnd.y + ny },
    { x: tipX + nx, y: tipY + ny },
    { x: tipX - nx, y: tipY - ny },
    { x: freeEnd.x - nx, y: freeEnd.y - ny },
  ];
}

/** Each face's own perpendicular at `p`, oriented so its dot product with `other - p` is positive
 *  (GitHub issue #314 follow-up) — used both as `drawDiagonalConnectorRibbon`'s own outward `bowFrac`
 *  offset direction (called with `other` = the connector's opposite endpoint) and, called the same
 *  way, as the diagonal gap patch's own inward inset direction (its `from`/`to` *are* the ribbon's
 *  own `from`/`to`, so the same orientation serves both). Pulled out to module scope, not duplicated
 *  inline at each call site, so both stay in sync if the orientation convention ever changes (an
 *  inline copy drifting out of sync with this one, silently bowing/shifting the wrong way, was the
 *  actual cause of two separate sign bugs earlier in this same investigation). */
function faceNormalAt(faceDir: { x: number; y: number }, p: { x: number; y: number }, other: { x: number; y: number }): { x: number; y: number } {
  const flen = Math.hypot(faceDir.x, faceDir.y) || 1;
  let px = -faceDir.y / flen, py = faceDir.x / flen;
  if (px * (other.x - p.x) + py * (other.y - p.y) < 0) { px = -px; py = -py; }
  return { x: px, y: py };
}

/** Computes the diagonal split shape's own background gap patch geometry (GitHub issue #314
 *  follow-up) — pure function, extracted out of `drawSplitPassages`' own diagonal branch so this
 *  math is directly unit-testable rather than only reachable through mocked-`Graphics` draw-call
 *  assertions. `from`/`to`/`fromFaceDir`/`toFaceDir` are the same connector-endpoint/face-direction
 *  pair `drawDiagonalConnectorRibbon` itself takes; `gridInset` is how far the patch's own two short
 *  ends get pulled in from the tile's own face boundary (perpendicular to that face, using the same
 *  `faceNormalAt` orientation the ribbon's own `bowFrac` offset uses — pointing "away from the
 *  opposite endpoint" at `from`/`to` themselves is the same inward direction here, since this
 *  function's `from`/`to` *are* the ribbon's own `from`/`to`); `gapWidth` is the patch's own desired
 *  width before clamping.
 *
 *  `clampedGapWidth` never lets the patch's own short ends cross the point where their own two lines
 *  (through `gapFrom`/`gapTo`, along `fromFaceDir`/`toFaceDir`) intersect — same ray-intersection-cap
 *  idea `bowFrac` already uses on `drawDiagonalConnectorRibbon`'s own long edges, applied here to
 *  width instead of bow distance. Parallel faces (a straight-through 2-face node) never intersect, so
 *  the clamp is a no-op there (`Infinity` half). */
export function computeDiagonalGapPatchGeometry(
  from: { x: number; y: number },
  to: { x: number; y: number },
  fromFaceDir: { x: number; y: number },
  toFaceDir: { x: number; y: number },
  gridInset: number,
  gapWidth: number,
): { gapFrom: { x: number; y: number }; gapTo: { x: number; y: number }; clampedGapWidth: number } {
  const fromInward = faceNormalAt(fromFaceDir, from, to);
  const toInward = faceNormalAt(toFaceDir, to, from);
  const gapFrom = { x: from.x + fromInward.x * gridInset, y: from.y + fromInward.y * gridInset };
  const gapTo = { x: to.x + toInward.x * gridInset, y: to.y + toInward.y * gridInset };

  const flen1 = Math.hypot(fromFaceDir.x, fromFaceDir.y) || 1;
  const flen2 = Math.hypot(toFaceDir.x, toFaceDir.y) || 1;
  const d1x = fromFaceDir.x / flen1, d1y = fromFaceDir.y / flen1;
  const d2x = toFaceDir.x / flen2, d2y = toFaceDir.y / flen2;
  const det = d1x * -d2y - d1y * -d2x;
  let maxHalf = Infinity;
  if (Math.abs(det) >= 1e-9) {
    const dx = gapTo.x - gapFrom.x, dy = gapTo.y - gapFrom.y;
    const t1 = (dx * -d2y - dy * -d2x) / det;
    const t2 = (d1x * dy - d1y * dx) / det;
    maxHalf = Math.min(Math.abs(t1), Math.abs(t2));
  }
  const clampedGapWidth = Math.min(gapWidth, maxHalf * 2);

  return { gapFrom, gapTo, clampedGapWidth };
}

/** Draws a constant-width ribbon shape between two tile faces onto `target` and fills it (GitHub
 *  issue #314 follow-up) — used only by the diagonal split shape's own connector draw in this
 *  renderer, replacing a `stroke()`-based line whose `cap`/`join` geometry couldn't be made to butt
 *  flush against the tile boundary at `from`/`to` (a `square` cap extended past it) without also
 *  needing per-case geometry fixes.
 *
 *  The four corner points are always exactly `from ± fromFaceDir * width/2` and
 *  `to ± toFaceDir * width/2` — cut *along each face's own direction* (`v1 - v0`), the same span an
 *  ordinary corridor's own stroke occupies on that face (`buildCorridorSegments`/
 *  `drawConnectorLine` both center a `width`-wide run there), so they land exactly flush against
 *  the plain corridor's own segment. `bow` never moves these corners.
 *
 *  The two *long* edges (`fromA`-`toA` and `fromB`-`toB`) are drawn as cubic Béziers
 *  (`bezierCurveTo`), not quadratics — a quadratic's single control point can't set the tangent at
 *  both ends independently, so an earlier version's curve left visibly at an angle into the tile
 *  instead of continuing straight out of the plain corridor's own segment (GitHub issue #314
 *  follow-up: the "kink at the seam" bug). A cubic's own two control points are placed at
 *  `fromA + faceNormalAt(from) * bow` and `toA + faceNormalAt(to) * bow` — offset perpendicular to
 *  *that end's own face*, not the `from`→`to` line — so the curve's tangent at each end is exactly
 *  the face's own perpendicular, continuing the ordinary corridor's own straight run into the
 *  ribbon with no kink. `faceNormalAt` is oriented toward the opposite end of the connector, so
 *  both long edges bow the same direction (into the tile) for a positive `bow`. */
export function drawDiagonalConnectorRibbon(
  target: Graphics,
  from: { x: number; y: number },
  to: { x: number; y: number },
  fromFaceDir: { x: number; y: number },
  toFaceDir: { x: number; y: number },
  width: number,
  color: number,
  /** 0..1 fraction of each long edge's own max bow (GitHub issue #314 follow-up) — not an absolute
   *  pixel distance. `bowFrac === 1` puts each edge's two control points exactly at the
   *  intersection of their own two rays (`p ± faceNormal * t`), never past it — see this
   *  function's own doc comment for why an absolute distance can't be capped this way without
   *  knowing each edge's own ray geometry. */
  bowFrac = 0,
): void {
  const half = width / 2;
  const ldx = to.x - from.x, ldy = to.y - from.y;
  // Normal to the from->to line — used only to pick a consistent sign for each end's own width
  // offset below (the bow direction itself now comes from each face's own perpendicular instead).
  const llen = Math.hypot(ldx, ldy) || 1;
  const lnx = -ldy / llen, lny = ldx / llen;

  const alongEnd = (p: { x: number; y: number }, dir: { x: number; y: number }): [{ x: number; y: number }, { x: number; y: number }] => {
    const len = Math.hypot(dir.x, dir.y) || 1;
    let ux = dir.x / len, uy = dir.y / len;
    // Orient this face's own direction so "+" points to the same side of the from->to line as
    // the line's own normal — makes the sign comparable between `from`'s and `to`'s independently
    // stored face directions.
    if (ux * lnx + uy * lny < 0) { ux = -ux; uy = -uy; }
    return [{ x: p.x + ux * half, y: p.y + uy * half }, { x: p.x - ux * half, y: p.y - uy * half }];
  };
  const [fromA, fromB] = alongEnd(from, fromFaceDir);
  const [toA, toB] = alongEnd(to, toFaceDir);

  target.moveTo(fromA.x, fromA.y);
  if (bowFrac === 0) {
    target.lineTo(toA.x, toA.y).lineTo(toB.x, toB.y).lineTo(fromB.x, fromB.y);
  } else {
    // A positive `bowFrac` always bows outward, away from the tile's own center, for both `from`
    // and `to` — the control-point offset direction, distinct from `fromFaceDir`/`toFaceDir`
    // themselves (which run *along* the face). Both nodes of a diagonal point independently call
    // this with their own `bowFrac`, always positive, so their two ribbons both bow outward instead
    // of one bowing in and the other out (GitHub issue #314 follow-up).
    const fromNormal = faceNormalAt(fromFaceDir, from, to);
    const toNormal = faceNormalAt(toFaceDir, to, from);

    // Each long edge's own two control points ride along their own two rays — `p1 + t1*n1` from
    // one endpoint, `p2 + t2*n2` from the other — toward the ray intersection, never past it
    // (GitHub issue #314 follow-up: `bowFrac` is a 0..1 fraction of *that* distance, not a raw
    // pixel offset, so it can never overshoot regardless of `n1`'s/`n2`'s own angle to each other).
    // Solving `p1 + t1*n1 = p2 + t2*n2` for `t1`, `t2` via Cramer's rule; parallel rays (det ~ 0,
    // e.g. a straight-through 2-face node) fall back to the edge's own full length as the cap, so
    // `bowFrac` still behaves as a plain distance scale in that degenerate case.
    const rayIntersectionDistances = (
      p1: { x: number; y: number }, n1: { x: number; y: number },
      p2: { x: number; y: number }, n2: { x: number; y: number },
    ): [number, number] => {
      const det = n1.x * -n2.y - n1.y * -n2.x;
      if (Math.abs(det) < 1e-9) {
        const fallback = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        return [fallback, fallback];
      }
      const dx = p2.x - p1.x, dy = p2.y - p1.y;
      const t1 = (dx * -n2.y - dy * -n2.x) / det;
      const t2 = (n1.x * dy - n1.y * dx) / det;
      return [Math.max(0, t1), Math.max(0, t2)];
    };

    const [distFromA, distToA] = rayIntersectionDistances(fromA, fromNormal, toA, toNormal);
    const [distToB, distFromB] = rayIntersectionDistances(toB, toNormal, fromB, fromNormal);

    const ctrl1A = { x: fromA.x + fromNormal.x * distFromA * bowFrac, y: fromA.y + fromNormal.y * distFromA * bowFrac };
    const ctrl2A = { x: toA.x + toNormal.x * distToA * bowFrac, y: toA.y + toNormal.y * distToA * bowFrac };
    const ctrl1B = { x: toB.x + toNormal.x * distToB * bowFrac, y: toB.y + toNormal.y * distToB * bowFrac };
    const ctrl2B = { x: fromB.x + fromNormal.x * distFromB * bowFrac, y: fromB.y + fromNormal.y * distFromB * bowFrac };

    target
      .bezierCurveTo(ctrl1A.x, ctrl1A.y, ctrl2A.x, ctrl2A.y, toA.x, toA.y)
      .lineTo(toB.x, toB.y)
      .bezierCurveTo(ctrl1B.x, ctrl1B.y, ctrl2B.x, ctrl2B.y, fromB.x, fromB.y);
  }
  target.closePath().fill(color);
}

/** "Vector by corridors" render mode's own renderer (GitHub issue #310) — draws every basic
 * passage between geometrically adjacent cells as a stroked line between their centers
 * (`buildCorridorSegments`), the inverse of "Vector by walls"' "gap in the wall" reading. Per
 * `maze-web/CLAUDE.md`'s feature-renderer ownership rule: its own `Container` and its own
 * `Graphics`, never shared with `VectorByWallsRenderer` or any other feature's renderer — its own
 * `TeleportRenderer` instance (GitHub issue #313) follows the same rule, even though teleports
 * aren't tied to the corridor-vs-wall visual model and render identically to "Vector by walls"'
 * own. Its background/grid section (GitHub issue #309) is its own `BackgroundGridLayer` instance,
 * same shared-mechanics-own-instance convention as `ExportWarningHighlight`. Split points are
 * skipped entirely — their own follow-up sub-issue, same as `VectorByCorridorsSettings`' own doc
 * comment. */
export class VectorByCorridorsRenderer implements ModeRenderer {
  private readonly backgroundGrid: BackgroundGridLayer<VectorByCorridorsSettings>;
  private readonly corridorsContainer: Container;
  private readonly corridors: Graphics;
  /** One permanent top-level layer (sibling of `corridorsContainer`) holding every special split
   *  shape's (bridge/diagonal) own throwaway per-tile `Graphics` for this frame, in draw order —
   *  each `clipViewAt()` call appends its own `gapView` (background-colored gap patch) immediately
   *  followed by its own `clipView` (connector line/ribbon), so every node's own patch sits directly
   *  under its own line, and the next node's patch/line pair layers on top of that — never one
   *  global "all patches, then all lines" pass, which put every patch above every line regardless of
   *  which node either belonged to. Neither view uses a Pixi mask (GitHub issue #314 follow-up: an
   *  earlier masked version — a tile-sized rect `Graphics` assigned as `gapView.mask` — repeatedly
   *  corrupted the *entire* canvas into a thin clipped border the moment `gapView` actually had
   *  content to draw, `splitGapWidth > 0`, regardless of Container nesting/isolation attempts; not
   *  worth the debugging cost against a renderer that must also support non-square tessellations,
   *  where a single rect mask was already the wrong shape). Both shapes stay within their own tile
   *  purely by their own geometry instead: `clipView`'s connector line/ribbon is already cut to the
   *  tile's face boundaries by construction (`drawDiagonalConnectorRibbon`'s own two short ends, the
   *  bridge's own through/cross lines), and `gapView`'s patch has its own length/width clamped
   *  numerically to the tile's own half-size at each draw site instead of relying on a mask to bound
   *  an oversized stroke. Recreated every `drawSplitPassages` call, destroyed and cleared at the
   *  start of the next one — `this.corridors.clear()` only clears its own drawn shapes, not this
   *  extra layer's children, so it needs its own lifecycle. */
  private readonly splitShapesLayer: Container;
  private splitClipScratch: Container[] = [];
  private readonly teleportContainer: Container;
  private readonly teleports: TeleportRenderer;
  private readonly markersContainer: Container;
  private readonly markers: WaypointsRenderer;
  private readonly warningHighlightContainer: Container;
  /** Own instance, not shared with `VectorByWallsRenderer`'s own — per
   *  `maze-web/CLAUDE.md`'s feature-renderer ownership rule. Highlights the currently hovered
   *  export warning's cells (GitHub issue #313 follow-up: this mode's warnings section had no
   *  hover-highlight wiring at all), see `computeVectorByCorridorsWarnings`. Memoize+draw mechanics
   *  shared with `VectorByWallsRenderer`'s own via `ExportWarningHighlight`. */
  private readonly warningHighlight: ExportWarningHighlight<VectorByCorridorsSettings>;

  private viewport: Viewport = { x: 0, y: 0, w: 0, h: 0, scale: 1 };
  private unsubscribe: (() => void) | null = null;

  private geometryCache: {
    nodes: NodeDto[];
    edges: EdgeDto[];
    cfg: TessellationConfig;
    start: number | null;
    finish: number | null;
    splitNodeColors: readonly number[];
    thickness: number;
    segments: CorridorSegment[];
    teleportEdges: TeleportEdge[];
    splitPassages: SplitPassage[];
    splitSpecialShapes: SplitSpecialShape[];
  } | null = null;

  constructor(container: Container) {
    this.backgroundGrid = new BackgroundGridLayer(container);

    this.corridorsContainer = new Container();
    container.addChild(this.corridorsContainer);

    this.corridors = new Graphics();
    this.corridorsContainer.addChild(this.corridors);

    this.splitShapesLayer = new Container();
    container.addChild(this.splitShapesLayer);

    this.teleportContainer = new Container();
    container.addChild(this.teleportContainer);
    this.teleports = new TeleportRenderer(this.teleportContainer);

    this.markersContainer = new Container();
    container.addChild(this.markersContainer);
    this.markers = new WaypointsRenderer(this.markersContainer);

    this.warningHighlightContainer = new Container();
    container.addChild(this.warningHighlightContainer);
    this.warningHighlight = new ExportWarningHighlight(this.warningHighlightContainer, computeVectorByCorridorsWarnings);

    this.syncVisibility(useMazeStore.getState());
    this.subscribe();
  }

  private subscribe(): void {
    let prev = useMazeStore.getState();
    this.unsubscribe = useMazeStore.subscribe((state) => {
      const visibilityChanged = state.openCard !== prev.openCard;
      if (visibilityChanged) this.syncVisibility(state);

      const dataChanged =
        state.nodes !== prev.nodes ||
        state.edges !== prev.edges ||
        state.start !== prev.start ||
        state.finish !== prev.finish ||
        state.postEditMeta !== prev.postEditMeta ||
        state.postEditDraftSplitPoints !== prev.postEditDraftSplitPoints ||
        state.activeTessellationConfig !== prev.activeTessellationConfig;
      const settingsChanged = state.vectorByCorridorsSettings !== prev.vectorByCorridorsSettings;
      // Teleports section's own expand/collapse flips canvas interactivity for group customization
      // (GitHub issue #293/#313), same rationale as `VectorByWallsRenderer`'s own
      // `teleportsSectionChanged` check.
      const teleportsSectionChanged =
        (state.vectorByCorridorsSectionsExpanded["teleports"] ?? false) !== (prev.vectorByCorridorsSectionsExpanded["teleports"] ?? false);

      if ((dataChanged || settingsChanged || teleportsSectionChanged) && state.openCard === "image_export") {
        this.renderAll(state);
      } else if (state.hoveredExportWarningKey !== prev.hoveredExportWarningKey && state.openCard === "image_export") {
        this.renderWarningHighlight(state);
      }

      prev = state;
    });
  }

  private syncVisibility(state: ReturnType<typeof useMazeStore.getState>): void {
    const visible = state.openCard === "image_export";
    this.backgroundGrid.setVisible(visible);
    this.corridorsContainer.visible = visible;
    this.splitShapesLayer.visible = visible;
    this.teleportContainer.visible = visible;
    this.markersContainer.visible = visible;
    this.warningHighlightContainer.visible = visible;
    if (visible) this.renderAll(state);
  }

  onViewportChanged(x: number, y: number, w: number, h: number, scale: number): void {
    this.viewport = { x, y, w, h, scale };
    this.backgroundGrid.onViewportChanged(this.viewport);
    const state = useMazeStore.getState();
    if (state.openCard === "image_export") {
      this.backgroundGrid.render(state.vectorByCorridorsSettings, state.activeTessellationConfig);
    }
  }

  getRequiredExportMargin(): ExportMargin {
    return computeVectorByCorridorsExportMargin(useMazeStore.getState().vectorByCorridorsSettings);
  }

  getRequiredWallExportMargin(): ExportMargin {
    return computeVectorByCorridorsExportMargin(useMazeStore.getState().vectorByCorridorsSettings);
  }

  getBackgroundColor(): number {
    const state = useMazeStore.getState();
    return resolveBackgroundColor("vector_by_corridors", { vectorByWallsSettings: state.vectorByWallsSettings, vectorByCorridorsSettings: state.vectorByCorridorsSettings });
  }

  private renderAll(state: ReturnType<typeof useMazeStore.getState>): void {
    const { nodes, edges } = state;
    const cfg = state.activeTessellationConfig;

    this.backgroundGrid.render(state.vectorByCorridorsSettings, cfg);

    const { start: effStart, finish: effFinish } = resolveEffectiveEndpoints(state);
    const settings = state.vectorByCorridorsSettings;
    const splitNodeColors = settings.splitNodeColors;

    if (
      !this.geometryCache ||
      this.geometryCache.nodes !== nodes ||
      this.geometryCache.edges !== edges ||
      this.geometryCache.cfg !== cfg ||
      this.geometryCache.start !== effStart ||
      this.geometryCache.finish !== effFinish ||
      this.geometryCache.splitNodeColors !== splitNodeColors ||
      this.geometryCache.thickness !== settings.thickness
    ) {
      const nodeById = new Map(nodes.map((n) => [n.id, n]));

      // Marker/teleport-carrying split nodes always keep their hub point (never straighten into a
      // plain 2-passage connector) — same rationale as `VectorByWallsRenderer`'s own
      // `specialNodeIds`: a marker/teleport line landing on a straightened connector would sit on
      // it with nothing marking which point along it is actually special.
      const specialNodeIds = new Set<number>();
      if (effStart !== null) specialNodeIds.add(effStart);
      if (effFinish !== null) specialNodeIds.add(effFinish);
      for (const e of edges) {
        if (e.kind === "teleport") { specialNodeIds.add(e.from); specialNodeIds.add(e.to); }
      }

      const effectiveSplitNodeColors = buildEffectiveSplitNodeColors(splitNodeColors, maxSplitNodeCount(nodes));
      const { passages: splitPassages, specialShapes: splitSpecialShapes } =
        buildSplitPassages(nodes, edges, cfg, specialNodeIds, {}, {}, effectiveSplitNodeColors, settings.thickness);

      this.geometryCache = {
        nodes, edges, cfg,
        start: effStart, finish: effFinish, splitNodeColors, thickness: settings.thickness,
        segments: buildCorridorSegments(nodes, edges, cfg),
        teleportEdges: buildTeleportEdges(nodeById, edges, cfg),
        splitPassages,
        splitSpecialShapes,
      };
    }

    const strokeOpts = {
      width: settings.thickness,
      color: settings.color,
      join: settings.join,
      cap: settings.join === "miter" ? ("square" as const) : ("round" as const),
    };

    // Points where a plain segment's own `v1` lands on a split point's shared-face midpoint (GitHub
    // issue #314 follow-up) — built straight from `this.geometryCache.segments`'s own `v1TouchesSplit`
    // flag (set by `buildCorridorSegments` itself, not re-derived from `SplitPassage` connector
    // geometry, which can sit at a different point along the same face when the face is divided
    // among several split nodes). A chained path's own free end lands exactly on one of these points
    // whenever that segment's `v1` was its endpoint (chaining never reorders `v0`/`v1` within a
    // segment, only which segment comes next), so a plain key/coordinate match here is exact by
    // construction — unlike matching against `SplitPassage` connector points.
    const splitTouchKey = (p: { x: number; y: number }) => `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`;
    const splitTouchPoints = new Set<string>();
    for (const seg of this.geometryCache.segments) {
      if (seg.v1TouchesSplit) splitTouchPoints.add(splitTouchKey(seg.v1));
    }
    const touchesSplit = (p: { x: number; y: number }): boolean => splitTouchPoints.has(splitTouchKey(p));

    // Pixi's `stroke()` applies a single `cap` to *both* free ends of a path — there's no per-end
    // cap option. So a path with only one end touching a split tile is drawn `butt` on both ends
    // first, then its non-split free end gets its own round/square cap restored as a standalone
    // filled shape at just that point (not by redrawing the path's last segment — that would put an
    // ordinary cap back on *both* of that segment's ends, undoing the split end's own `butt` cap too
    // whenever the path is only 2 points long, where the "last segment" and "whole path" are the
    // same stroke). A path with both ends touching split tiles only needs the `butt` pass.
    this.corridors.clear();
    for (const path of chainSegmentsAtSharedVertices(this.geometryCache.segments)) {
      const startsOnSplit = touchesSplit(path[0]);
      const endsOnSplit = touchesSplit(path[path.length - 1]);
      this.corridors.moveTo(path[0].x, path[0].y);
      for (let i = 1; i < path.length; i++) this.corridors.lineTo(path[i].x, path[i].y);
      this.corridors.stroke(startsOnSplit || endsOnSplit ? { ...strokeOpts, cap: "butt" } : strokeOpts);
      if (strokeOpts.cap === "round" && (startsOnSplit !== endsOnSplit)) {
        const freeEnd = startsOnSplit ? path[path.length - 1] : path[0];
        this.corridors.circle(freeEnd.x, freeEnd.y, strokeOpts.width / 2).fill(strokeOpts.color);
      } else if (strokeOpts.cap === "square" && (startsOnSplit !== endsOnSplit)) {
        const freeEnd = startsOnSplit ? path[path.length - 1] : path[0];
        const neighbor = startsOnSplit ? path[path.length - 2] : path[1];
        const [p0, p1, p2, p3] = computeSquareCapPatch(freeEnd, neighbor, strokeOpts.width);
        this.corridors
          .moveTo(p0.x, p0.y)
          .lineTo(p1.x, p1.y)
          .lineTo(p2.x, p2.y)
          .lineTo(p3.x, p3.y)
          .closePath()
          .fill(strokeOpts.color);
      }
    }

    // One-way passage indicator (GitHub issue #312) — a row of chevrons drawn at each one-way
    // segment's midpoint, on top of the plain stroke just drawn above. `oneWayColor` defaults to
    // the canvas background, so the row reads as a break cut into the corridor line rather than an
    // indicator sitting on top of it, without needing to actually clip the stroked path itself.
    // `oneWayLength` is a multiplier of the chevron's own full opening width (GitHub issue #312
    // follow-up), not an absolute pixel size — so the chevron's opening angle stays constant as
    // `oneWayWidth`/`thickness` change, instead of visibly flattening/sharpening on its own.
    const oneWayFullWidth = settings.oneWayWidth * settings.thickness;
    const oneWayLengthPx = settings.oneWayLength * oneWayFullWidth;
    for (const seg of this.geometryCache.segments) {
      if (!seg.oneWayDir) continue;
      const cx = (seg.v0.x + seg.v1.x) / 2;
      const cy = (seg.v0.y + seg.v1.y) / 2;
      drawOneWayChevronRow(
        this.corridors, cx, cy, seg.oneWayDir.dx, seg.oneWayDir.dy,
        settings.oneWayCount, oneWayLengthPx, settings.oneWayGap,
        {
          color: settings.oneWayColor,
          thickness: settings.oneWayThickness,
          // `drawOneWayChevron`'s own `width` is a half-opening (opening spans `2 * width`), so
          // halve the desired full opening (`oneWayFullWidth`) here.
          width: oneWayFullWidth / 2,
          join: settings.oneWayJoin,
          cap: settings.oneWayJoin === "miter" ? "square" : "round",
        },
      );
    }

    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const markerData = buildMazeMarkers(
      nodeById, effStart, effFinish, cfg,
      buildMarkerStyle(settings.startMarker, canvas.stage.background),
      buildMarkerStyle(settings.finishMarker, canvas.stage.background),
    );

    // Widen the corridor stroke under each marker so it doesn't get visually swallowed by/collide
    // with the passage line (GitHub issue #311) — a filled patch matching the marker's own shape
    // (or a fixed circle/square, `markerWidenShape`, GitHub issue #313 follow-up), drawn in the
    // corridor's own color, into the same `Graphics` as the stroke and before the markers
    // themselves. Reusable groundwork (`drawMarkerWidenPatches`, not waypoint-specific) so a future
    // marker type on this canvas can call it the same way. A fixed square's own corners follow
    // `join`, same corner convention the corridor stroke's own join/cap already uses.
    const squareCornerStyle = settings.join === "round" ? "round" : "sharp";
    drawMarkerWidenPatches(this.corridors, markerData, settings.color, settings.thickness, settings.markerWidenPadding, settings.markerWidenShape, squareCornerStyle);

    // Teleport markers get the same widen patch, reusing the one `markerWidenPadding`/
    // `markerWidenShape` settings (GitHub issue #313 follow-up) — no separate teleport-only setting.
    // Groups computed once here and handed to `buildTeleportWidenMarkers`, rather than it calling
    // `buildTeleportGroups` again itself — `TeleportRenderer.render` below already recomputes the
    // same grouping internally for the same `teleportEdges`, so this avoids a third redundant pass.
    const teleportGroups = settings.teleportGroupCustomization ? buildTeleportGroups(this.geometryCache.teleportEdges) : [];
    drawMarkerWidenPatches(
      this.corridors,
      buildTeleportWidenMarkers(this.geometryCache.teleportEdges, settings, teleportGroups),
      settings.color,
      settings.thickness,
      settings.markerWidenPadding,
      settings.markerWidenShape,
      squareCornerStyle,
    );

    // Split points (GitHub issue #314) — drawn after the plain corridor stroke and marker widen
    // patches (so a split hub sitting under a start/finish/teleport marker is already widened the
    // same way a plain corridor is), before the markers/teleports themselves land on top.
    this.drawSplitPassages(settings, this.geometryCache.splitPassages, this.geometryCache.splitSpecialShapes);

    // Same `TeleportRenderer` "Vector by walls" uses (GitHub issue #313) — teleports aren't tied to
    // the corridor-vs-wall visual model, so the settings and rendering transfer as-is.
    this.teleports.render({
      edges: this.geometryCache.teleportEdges,
      // `floorColor` occludes an outline (exit-only) teleport point's own line pass-through and
      // fills its gap rings — on this canvas that's the corridor's own color, not the canvas
      // background, since a teleport point sits directly on the passage line, not on an empty
      // floor tile the way "Vector by walls"' floor does.
      lineStyle: buildTeleportLineStyle(settings, settings.color),
      groupCustomization: settings.teleportGroupCustomization,
      groupOverrides: settings.teleportGroupOverrides,
      interactive: state.vectorByCorridorsSectionsExpanded["teleports"] ?? false,
      cfg,
      waypoints: markerData.map((m) => m.pos),
      avoidFieldExit: settings.teleportAvoidFieldExit,
      fieldCells: nodes.map((n): [number, number] => [n.x, n.y]),
    });

    this.markers.render({ markers: markerData });

    this.renderWarningHighlight(state);
  }

  /** Draws every split point's own corridor lines (GitHub issue #314) — each node's connector
   *  (`SplitPassage.connectors`, built by `buildSplitPassages`/`splitFaceLayout.ts`, same geometry
   *  the "Vector by walls" split-junction reading uses) as a colored line in that node's own
   *  identity color, at half the ordinary corridor's own `thickness` (a split connector reads as a
   *  thinner sub-passage sharing a tile with its sibling nodes, not a full corridor in its own
   *  right), with a chevron-row one-way indicator (same `drawOneWayChevronRow` the plain corridor
   *  segments use, GitHub issue #312) on a directed connector. There is no wall segment to divide a
   *  shared face into per-node shares in this render mode — a split tile has no walls at all — so
   *  only `passages[*].connectors` are drawn, never `wallSegments`.
   *
   *  A recognized degree-4 "bridge"/"diagonal" topology (`SplitSpecialShapeKind`) draws its own
   *  dedicated shape instead of the two nodes' generic connector reading, when `splitSpecialShapes`
   *  is on, at full corridor thickness (same as an ordinary corridor, not halved) and in the render
   *  mode's own plain corridor color (`settings.color`), never a node's own identity color — same
   *  "neutral, doesn't belong to one node" convention `SplitJunctionRenderer`'s wall-mode special
   *  shapes already use: `"bridge"` draws the through corridor (node 0) as a plain straight line
   *  underneath, uninterrupted, with the cross corridor (node 1) drawn on top of it and a
   *  background-colored gap (`splitGapWidth`) cut into the *cross* line itself where it crosses the
   *  through corridor — the through line itself draws underneath, uninterrupted; "diagonal" draws each
   *  node's own connector as an arc bowed away from the tile's own `corner0`-`corner1` diagonal
   *  (`splitDiagonalBowAmount`) instead of a
   *  straight line, so the two nodes' lines don't visually cross at the tile center. */
  private drawSplitPassages(settings: VectorByCorridorsSettings, passages: SplitPassage[], specialShapes: SplitSpecialShape[]): void {
    for (const g of this.splitClipScratch) g.destroy();
    this.splitClipScratch = [];

    // No mask on either view (GitHub issue #314 follow-up, see `splitShapesLayer`'s own doc comment
    // for why) — `clipView`'s own geometry is already cut exactly to the tile's face boundaries, and
    // `gapView`'s own draw sites clamp their patch's length/width numerically to the tile's own
    // half-size instead. `gapView` added before `clipView` (both per-call, into the same
    // `splitShapesLayer`) so *this node's own* patch sits directly under *this node's own* line —
    // the gap patch is a background-colored cut, not an overlay, so it needs to stay under the line
    // it's meant to interrupt; the next `clipViewAt()` call's own pair then layers on top of that,
    // never one global "all patches, then all lines" pass across every node.
    const clipViewAt = (): { clipView: Graphics; gapView: Graphics } => {
      const gapView = new Graphics();
      this.splitShapesLayer.addChild(gapView);
      this.splitClipScratch.push(gapView);

      const clipView = new Graphics();
      this.splitShapesLayer.addChild(clipView);
      this.splitClipScratch.push(clipView);
      return { clipView, gapView };
    };

    const cap = settings.join === "miter" ? ("square" as const) : ("round" as const);
    const oneWayFullWidth = settings.oneWayWidth * settings.thickness;
    const oneWayLengthPx = settings.oneWayLength * oneWayFullWidth;
    const oneWayStyle = {
      color: settings.oneWayColor,
      thickness: settings.oneWayThickness,
      width: oneWayFullWidth / 2,
      join: settings.oneWayJoin,
      cap: settings.oneWayJoin === "miter" ? ("square" as const) : ("round" as const),
    };

    const drawConnectorLine = (from: { x: number; y: number }, to: { x: number; y: number }, color: number, oneWayOut: boolean | undefined, width: number = settings.thickness, target: Graphics = this.corridors): void => {
      target.moveTo(from.x, from.y).lineTo(to.x, to.y).stroke({ width, color, cap, join: settings.join });
      if (oneWayOut === undefined) return;
      const dx = to.x - from.x, dy = to.y - from.y;
      const len = Math.hypot(dx, dy) || 1;
      const dir = oneWayOut ? 1 : -1;
      const cx = (from.x + to.x) / 2, cy = (from.y + to.y) / 2;
      drawOneWayChevronRow(target, cx, cy, (dx / len) * dir, (dy / len) * dir, settings.oneWayCount, oneWayLengthPx, settings.oneWayGap, oneWayStyle);
    };

    const useSpecial = settings.splitSpecialShapes;

    // Special-shape points draw their own dedicated geometry below, bypassing the passages loop
    // entirely for that point's own connectors.
    const specialPointKeys = new Set(useSpecial ? specialShapes.map((s) => s.pointKey) : []);

    // Plain (non-special) connectors draw at half the ordinary corridor's own thickness (GitHub
    // issue #314 follow-up) — a split connector reads as a thinner "sub-passage" sharing a tile
    // with its sibling nodes, not a full corridor in its own right; special-shape geometry
    // (bridge/diagonal) stays at full thickness, same as an ordinary corridor.
    const plainConnectorWidth = settings.thickness / 2;

    // Every face share draws its own straight line to the point's own center (GitHub issue #314
    // follow-up) — never `connectors`' hub fan-out or 2-share straightening, both wall-geometry
    // concerns with nothing to divide/separate on a corridor tile with no walls at all.
    for (const passage of passages) {
      if (specialPointKeys.has(passage.pointKey)) continue;
      for (const seg of passage.wallSegments) {
        const color = seg.isUndefined ? disabledOfNumber(passage.color) : passage.color;
        drawConnectorLine(passage.center, seg.center, color, seg.oneWayOut, plainConnectorWidth);
      }
    }

    if (!useSpecial) return;

    for (const shape of specialShapes) {
      if (shape.kind === "bridge") {
        const [throughFrom, throughTo] = shape.throughLine;
        const crossMid0 = { x: (shape.crossFaces[0].v0.x + shape.crossFaces[0].v1.x) / 2, y: (shape.crossFaces[0].v0.y + shape.crossFaces[0].v1.y) / 2 };
        const crossMid1 = { x: (shape.crossFaces[1].v0.x + shape.crossFaces[1].v1.x) / 2, y: (shape.crossFaces[1].v0.y + shape.crossFaces[1].v1.y) / 2 };

        // Through corridor (node 0) draws first, with no patch of its own — it's the corridor that
        // reads as passing *underneath*, so nothing needs to cut a gap into it.
        const { clipView: throughClipView } = clipViewAt();
        drawConnectorLine(throughFrom, throughTo, settings.color, undefined, settings.thickness, throughClipView);

        // Cross corridor (node 1) gets its own patch+line pair — patch first (drawn into `gapView`,
        // below in z-order, cutting a gap into the through corridor it now sits on top of), then the
        // cross line itself (drawn into `clipView`, above both the patch and the through corridor's
        // own views) — the "this node's own patch, then this node's own line" ordering every other
        // shape uses, applied to whichever corridor draws on top here.
        const crossViews = clipViewAt();

        // Background-colored gap patch cut into the through line, centered at the tile's own center
        // (where the two corridors actually cross) and limited to the intersection zone — a short
        // stroke run along the *cross* line's own axis (so its perpendicular stroke width, not its
        // length, is what actually punches the hole — the hole needs to be wide enough along cross
        // to clear the through corridor passing under it), `splitGapWidth` wider than the through
        // corridor's own thickness on each side, not the line's whole length. Both the stroke's own
        // length (along cross) and width (perpendicular, along through) are clamped to the tile's
        // own size (GitHub issue #314 follow-up: no mask backs this — see `splitShapesLayer`'s own
        // doc comment for why — so a large `splitGapWidth` must be clamped numerically instead of
        // relying on one to bound an oversized stroke).
        if (settings.splitGapWidth > 0) {
          // Inset from the tile's own half-size (GitHub issue #314 follow-up) — half the grid
          // line's own stroke width, read from the live viewport scale, so the patch's own edge
          // never overdraws the grid line at the tile boundary regardless of zoom level.
          const gridInset = 0.5 / (this.viewport.scale || 1);
          const cx = (crossMid0.x + crossMid1.x) / 2, cy = (crossMid0.y + crossMid1.y) / 2;
          const dx = crossMid1.x - crossMid0.x, dy = crossMid1.y - crossMid0.y;
          const len = Math.hypot(dx, dy) || 1;
          const ux = dx / len, uy = dy / len;
          const half = Math.min((settings.thickness + 2 * settings.splitGapWidth) / 2, TILE_SIZE / 2 - gridInset);
          const gapWidth = Math.min(settings.thickness + 2 * settings.splitGapWidth, TILE_SIZE - 2 * gridInset);
          const gapFrom = { x: cx - ux * half, y: cy - uy * half };
          const gapTo = { x: cx + ux * half, y: cy + uy * half };
          crossViews.gapView
            .moveTo(gapFrom.x, gapFrom.y)
            .lineTo(gapTo.x, gapTo.y)
            .stroke({ width: gapWidth, color: settings.background, cap: "butt", join: settings.join });
        }

        drawConnectorLine(crossMid0, crossMid1, settings.color, undefined, settings.thickness, crossViews.clipView);
      } else {
        // "diagonal" — each node's own connector (the same straight 2-share line the generic
        // reading would draw, since a recognized diagonal point is always exactly 2 nodes each with
        // exactly 2 plain-passage faces) drawn as a ribbon, bowed outward (away from the tile's own
        // center) instead of running straight, so the two nodes' ribbons don't visually cross at
        // the tile center. Both nodes bow by the same `bowFrac` — `drawDiagonalConnectorRibbon`
        // itself resolves "outward" independently per node from each face's own geometry, so unlike
        // an earlier version there's no need to pick a signed `side` here (GitHub issue #314
        // follow-up: that earlier per-node sign was the actual cause of one node's ribbon bowing
        // inward while the other bowed outward instead of both consistently outward). `bowFrac` is
        // `settings.splitDiagonalBowAmount` directly (0..1), not scaled by `TILE_SIZE` — it's a
        // fraction of each long edge's own ray-intersection distance, not a raw pixel offset, so
        // `1.0` always lands the control points exactly at that intersection regardless of tile
        // size or face geometry. See `drawDiagonalConnectorRibbon`'s own doc comment for how it's
        // applied without ever moving the ribbon's own corner points off the tile-face boundary.
        const nodePassages = passages.filter((p) => p.pointKey === shape.pointKey);
        const bowFrac = settings.splitDiagonalBowAmount;

        // Background-colored gap frame drawn around each connector before its own trapezoid (GitHub
        // issue #314 follow-up) — same "wider background pass underneath" technique the bridge
        // shape uses, so it reads as visually separated from the grid/background around it. Clamped
        // to the tile's own size minus a grid-line inset, same reasoning as the bridge shape's own
        // `gapWidth` clamp (no mask backs this — see `splitShapesLayer`'s own doc comment for why).
        const gridInset = 0.5 / (this.viewport.scale || 1);
        const gapWidth = Math.min(settings.thickness + 2 * settings.splitGapWidth, TILE_SIZE - 2 * gridInset);

        for (const passage of nodePassages) {
          const { clipView, gapView } = clipViewAt();

          // A face's own direction at each connector endpoint (GitHub issue #314 follow-up) — the
          // endpoint's own `wallSegments[i].center` matches `connector.from`/`to` exactly (both
          // come from the same `buildSplitPassagesCore` share-center computation), so a coordinate
          // match finds the right face's `v0`-`v1` axis to cut the ribbon's own end along.
          //
          // Matched by distance to the face's own `v0`-`v1` line, not `wallSegments[i].center`
          // itself — `connector.from`/`to` come from `computeSplitConnectors`'s own unshifted face
          // *midpoint*, while `wallSegments[i].center` can be shifted off that midpoint when
          // `corridorConnectorWidth` divides the face among several nodes sharing it (see
          // `buildSplitPassagesCore`'s own `corridorConnectorWidth` doc comment) — an exact
          // coordinate match would silently miss every shifted segment and fall through to a wrong
          // fallback axis (GitHub issue #314 follow-up: the actual cause of the trapezoid degrading
          // into stray triangles).
          const faceDirAt = (p: { x: number; y: number }): { x: number; y: number } => {
            let best: (typeof passage.wallSegments)[number] | null = null;
            let bestDist = Infinity;
            for (const seg of passage.wallSegments) {
              const dx = seg.v1.x - seg.v0.x, dy = seg.v1.y - seg.v0.y;
              const len = Math.hypot(dx, dy) || 1;
              const t = Math.max(0, Math.min(1, ((p.x - seg.v0.x) * dx + (p.y - seg.v0.y) * dy) / (len * len)));
              const projX = seg.v0.x + dx * t, projY = seg.v0.y + dy * t;
              const dist = Math.hypot(p.x - projX, p.y - projY);
              if (dist < bestDist) { bestDist = dist; best = seg; }
            }
            return best ? { x: best.v1.x - best.v0.x, y: best.v1.y - best.v0.y } : { x: 1, y: 0 };
          };

          for (const connector of passage.connectors) {
            const mx = (connector.from.x + connector.to.x) / 2, my = (connector.from.y + connector.to.y) / 2;
            const fromFaceDir = faceDirAt(connector.from);
            const toFaceDir = faceDirAt(connector.to);

            // Filled ribbon instead of a stroked line (GitHub issue #314 follow-up) — a stroke's
            // own `cap`/`join` geometry couldn't be made to butt flush at `from`/`to` (a `square`
            // cap extended past the tile boundary the plain corridor stub stitches up against). A
            // filled shape has no such failure mode, and its own two short ends are cut exactly
            // along each face's own direction so they land flush against the plain corridor's own
            // segment there, unmoved by `bow`. See `drawDiagonalConnectorRibbon`'s own doc comment.
            if (settings.splitGapWidth > 0) {
              const { gapFrom, gapTo, clampedGapWidth } = computeDiagonalGapPatchGeometry(connector.from, connector.to, fromFaceDir, toFaceDir, gridInset, gapWidth);
              drawDiagonalConnectorRibbon(gapView, gapFrom, gapTo, fromFaceDir, toFaceDir, clampedGapWidth, settings.background, bowFrac);
            }

            drawDiagonalConnectorRibbon(clipView, connector.from, connector.to, fromFaceDir, toFaceDir, settings.thickness, settings.color, bowFrac);

            if (connector.oneWayOut === undefined) continue;
            const ddx = connector.to.x - connector.from.x, ddy = connector.to.y - connector.from.y;
            const dlen = Math.hypot(ddx, ddy) || 1;
            const dir = connector.oneWayOut ? 1 : -1;
            drawOneWayChevronRow(clipView, mx, my, (ddx / dlen) * dir, (ddy / dlen) * dir, settings.oneWayCount, oneWayLengthPx, settings.oneWayGap, oneWayStyle);
          }
        }
      }
    }
  }

  /** Highlights the currently hovered export warning's flagged cell(s) — see
   *  `ExportWarningHighlight`'s own doc comment for the memoize-then-draw mechanics, shared with
   *  `VectorByWallsRenderer`'s own copy of this method. */
  private renderWarningHighlight(state: ReturnType<typeof useMazeStore.getState>): void {
    const { hoveredExportWarningKey, nodes, edges } = state;
    const { start, finish } = resolveEffectiveEndpoints(state);
    this.warningHighlight.render(hoveredExportWarningKey, nodes, edges, state.activeTessellationConfig, state.vectorByCorridorsSettings, start, finish);
  }

  destroy(): void {
    this.unsubscribe?.();
    this.backgroundGrid.destroy();
    this.corridors.destroy();
    this.corridorsContainer.destroy();
    for (const g of this.splitClipScratch) g.destroy();
    this.splitShapesLayer.destroy();
    this.teleports.destroy();
    this.teleportContainer.destroy();
    this.markers.destroy();
    this.markersContainer.destroy();
    this.warningHighlight.destroy();
    this.warningHighlightContainer.destroy();
  }
}
