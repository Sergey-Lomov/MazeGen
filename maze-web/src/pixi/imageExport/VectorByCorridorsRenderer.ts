import { Container, Graphics } from "pixi.js";
import { useMazeStore } from "../../store/mazeStore";
import { buildCorridorSegments, buildMazeMarkers, buildTeleportEdges, buildTeleportFloorInputs, buildSplitPassages, maxSplitNodeCount, selectFloorScopedMaze, selectNodeLevelResolver, selectVerticalPassagePairSet, buildVerticalConnectionMarkers, buildMarkerIndexLabels, buildTeleportAvoidanceWaypoints, type CorridorSegment } from "../selectors/mazeSelectors";
import { MarkerIndexRenderer } from "../renderers/MarkerIndexRenderer";
import { chainSegmentsAtSharedVertices } from "../renderers/WallRenderer";
import { WaypointsRenderer } from "../renderers/WaypointsRenderer";
import { TeleportRenderer } from "../renderers/TeleportRenderer";
import { VerticalConnectionRenderer } from "../renderers/VerticalConnectionRenderer";
import { drawMarkerWidenPatches } from "../renderers/markerWidenPatches";
import { drawOneWayChevronRow, computeSquareCapPatch } from "../renderers/wallUtils";
import { buildTeleportGroups } from "../selectors/teleportGroups";
import { resolveEffectiveEndpoints, buildMarkerStyle, buildTeleportLineStyle, buildVerticalConnectionStyle, buildEffectiveSplitNodeColors, buildMarkerIndexEndpointResolver, BackgroundGridLayer, ExportWarningHighlight } from "./VectorByWallsRenderer";
import { computeVectorByCorridorsWarnings, computeVectorByCorridorsWarningsAcrossFloors } from "../selectors/exportWarnings";
import type { NodeDto, EdgeDto } from "../../wasm/types";
import type { Viewport, TeleportEdge, SplitPassage, SplitSpecialShape, VerticalConnectionMarker } from "../renderers/types";
import { buildTeleportWidenMarkers, buildVerticalWidenMarkers, computeDiagonalGapPatchGeometry, drawDiagonalConnectorRibbon, computeMiterJunctionPatch, selectInwardJunctionWedge, type JunctionRay } from "./vectorByCorridorsGeometry";
import { buildCorridorContour, traceCorridorContour } from "./vectorByCorridorsContour";
import type { VectorByCorridorsSettings } from "../../store/storeTypes";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { TILE_SIZE } from "../constants";
import { disabledOfNumber } from "../../styles/palette";
import type { ModeRenderer } from "./modeRendererFactory";
import { resolveBackgroundColor, measureContentMargin, type ExportMargin } from "./exportMargins";
import { cellCenterBounds } from "../tessellationGeometry";


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
  /** Marker widen patches must sit above split-gap geometry and below the marker containers. */
  private readonly markerWidenContainer: Container;
  private readonly markerWiden: Graphics;
  private readonly teleportContainer: Container;
  private readonly teleports: TeleportRenderer;
  private readonly markersContainer: Container;
  private readonly markers: WaypointsRenderer;
  /** Own instance, not shared with `VectorByWallsRenderer`'s own — per
   *  `maze-web/CLAUDE.md`'s feature-renderer ownership rule (GitHub issue #348, "Vector by
   *  corridors" parity follow-up to #347). */
  private readonly verticalContainer: Container;
  private readonly verticalConnections: VerticalConnectionRenderer;
  /** Own instance, per `maze-web/CLAUDE.md`'s feature-renderer ownership rule (GitHub issue #471).
   *  Two layers: gap rings below the connection markers, plate bodies above. */
  private readonly markerIndexGapContainer: Container;
  private readonly markerIndexBodyContainer: Container;
  private readonly markerIndex: MarkerIndexRenderer;
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
    rawNodes: NodeDto[];
    rawEdges: EdgeDto[];
    activeFloorId: string;
    cfg: TessellationConfig;
    start: number | null;
    finish: number | null;
    splitNodeColors: readonly number[];
    thickness: number;
    teleportAvoidFieldExit: boolean;
    segments: CorridorSegment[];
    teleportEdges: TeleportEdge[];
    splitPassages: SplitPassage[];
    splitSpecialShapes: SplitSpecialShape[];
    replaceTwoFloorElevatorsWithStairs: boolean;
    verticalConnectionMarkers: VerticalConnectionMarker[];
  } | null = null;

  constructor(container: Container) {
    this.backgroundGrid = new BackgroundGridLayer(container);

    this.corridorsContainer = new Container();
    container.addChild(this.corridorsContainer);

    this.corridors = new Graphics();
    this.corridorsContainer.addChild(this.corridors);

    this.splitShapesLayer = new Container();
    container.addChild(this.splitShapesLayer);

    this.markerWidenContainer = new Container();
    container.addChild(this.markerWidenContainer);
    this.markerWiden = new Graphics();
    this.markerWidenContainer.addChild(this.markerWiden);

    this.markerIndexGapContainer = new Container();
    container.addChild(this.markerIndexGapContainer);

    this.teleportContainer = new Container();
    container.addChild(this.teleportContainer);
    this.teleports = new TeleportRenderer(this.teleportContainer);

    this.markersContainer = new Container();
    container.addChild(this.markersContainer);
    this.markers = new WaypointsRenderer(this.markersContainer);

    this.verticalContainer = new Container();
    container.addChild(this.verticalContainer);
    this.verticalConnections = new VerticalConnectionRenderer(this.verticalContainer);

    this.markerIndexBodyContainer = new Container();
    container.addChild(this.markerIndexBodyContainer);
    this.markerIndex = new MarkerIndexRenderer(this.markerIndexGapContainer, this.markerIndexBodyContainer);

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
        state.activeTessellationConfig !== prev.activeTessellationConfig ||
        state.activeFloorId !== prev.activeFloorId ||
        state.floors !== prev.floors;
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
    this.markerWidenContainer.visible = visible;
    this.teleportContainer.visible = visible;
    this.markersContainer.visible = visible;
    this.verticalContainer.visible = visible;
    this.markerIndexGapContainer.visible = visible;
    this.markerIndexBodyContainer.visible = visible;
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

  /** Pixel-accurate export margin (GitHub issue #324 follow-up) — reads the actual drawn geometry's
   *  own world-space bounds (`Container.getLocalBounds()`, exact per pixi's own stroke/join/cap/
   *  shape math) instead of re-deriving an approximation of it. `renderAll` runs unconditionally
   *  first (not gated on `openCard === "image_export"` the way the store-subscription path is) — see
   *  `VectorByWallsRenderer.getRequiredExportMargin`'s own doc comment for why: that gate is a perf
   *  optimization for the on-screen instance only, and a caller reading this margin (a throwaway
   *  measurement-only instance, or any instance queried before its card was ever opened) needs
   *  correct bounds regardless. `backgroundGrid`/`warningHighlightContainer` are deliberately
   *  excluded — a background fill or warning highlight is not maze content whose export margin
   *  should ever grow to fit it. */
  getRequiredExportMargin(): ExportMargin {
    const state = useMazeStore.getState();
    if (state.nodes.length === 0) return { left: 0, right: 0, top: 0, bottom: 0 };
    this.renderAll(state);

    // `getLocalBounds()`, not `getBounds()` — the live instance's containers sit under
    // `MazeScene`'s own pan/zoom-transformed layer, so world-space `getBounds()` would read this
    // maze's on-screen position/zoom into the margin instead of its actual drawn content size.
    // `PngExporter`'s temporary instance never gets positioned at all before this method runs (its
    // own `exportContainer.position`/`scale.set` happen afterward), so `getLocalBounds()` there is
    // simply a no-op identity transform away from `getBounds()` — same result either way.
    // Floor-scoped (GitHub issue #348), same reason `renderAll` scopes its own `nodes` — the
    // *drawn* content is only ever one floor's worth, so the bounds basis must match.
    const floorNodes = selectFloorScopedMaze(state.nodes, state.edges, state.floors, state.activeFloorId).nodes;
    const cellBounds = cellCenterBounds(floorNodes, state.activeTessellationConfig);
    return measureContentMargin(
      [this.corridorsContainer, this.splitShapesLayer, this.markerWidenContainer, this.teleportContainer, this.markersContainer, this.verticalContainer, this.markerIndexGapContainer, this.markerIndexBodyContainer],
      cellBounds,
    );
  }

  getBackgroundColor(): number {
    const state = useMazeStore.getState();
    return resolveBackgroundColor("vector_by_corridors", { vectorByWallsSettings: state.vectorByWallsSettings, vectorByCorridorsSettings: state.vectorByCorridorsSettings });
  }

  private renderAll(state: ReturnType<typeof useMazeStore.getState>): void {
    const cfg = state.activeTessellationConfig;

    this.backgroundGrid.render(state.vectorByCorridorsSettings, cfg);

    // Scoped to `activeFloorId` (GitHub issue #348, parity follow-up to #347) — see
    // `VectorByWallsRenderer.renderAll`'s own doc comment on this same scoping.
    const rawEndpoints = resolveEffectiveEndpoints(state);
    const { nodes, edges, start: effStart, finish: effFinish } = selectFloorScopedMaze(
      state.nodes, state.edges, state.floors, state.activeFloorId, rawEndpoints.start, rawEndpoints.finish,
    );
    const resolveNodeLevel = selectNodeLevelResolver(state.nodes);
    const verticalPairs = selectVerticalPassagePairSet(state.edges);
    const activeFloorIndex = Math.max(state.floors.findIndex((f) => f.id === state.activeFloorId), 0);

    const settings = state.vectorByCorridorsSettings;
    const splitNodeColors = settings.splitNodeColors;

    if (
      !this.geometryCache ||
      this.geometryCache.rawNodes !== state.nodes ||
      this.geometryCache.rawEdges !== state.edges ||
      this.geometryCache.activeFloorId !== state.activeFloorId ||
      this.geometryCache.cfg !== cfg ||
      this.geometryCache.start !== effStart ||
      this.geometryCache.finish !== effFinish ||
      this.geometryCache.splitNodeColors !== splitNodeColors ||
      this.geometryCache.replaceTwoFloorElevatorsWithStairs !== settings.replaceTwoFloorElevatorsWithStairs ||
      this.geometryCache.thickness !== settings.thickness ||
      this.geometryCache.teleportAvoidFieldExit !== settings.teleportAvoidFieldExit
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
        rawNodes: state.nodes, rawEdges: state.edges, activeFloorId: state.activeFloorId, cfg,
        start: effStart, finish: effFinish, splitNodeColors, thickness: settings.thickness,
        teleportAvoidFieldExit: settings.teleportAvoidFieldExit,
        segments: buildCorridorSegments(nodes, edges, cfg),
        teleportEdges: (() => {
          const { floorContext, spread } = buildTeleportFloorInputs({
            unscopedNodes: state.nodes,
            unscopedEdges: state.edges,
            floors: state.floors,
            activeFloorId: state.activeFloorId,
            start: rawEndpoints.start,
            finish: rawEndpoints.finish,
            allowOutOfField: !settings.teleportAvoidFieldExit,
            fieldCells: state.nodes.map((n): [number, number] => [n.x, n.y]),
          });
          return buildTeleportEdges(nodeById, edges, cfg, floorContext, spread);
        })(),
        splitPassages,
        splitSpecialShapes,
        replaceTwoFloorElevatorsWithStairs: settings.replaceTwoFloorElevatorsWithStairs,
        verticalConnectionMarkers: buildVerticalConnectionMarkers(nodeById, edges, cfg, resolveNodeLevel, activeFloorIndex, verticalPairs, state.edges, state.vectorByCorridorsSettings.replaceTwoFloorElevatorsWithStairs),
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

    const chainedCorridorPaths = chainSegmentsAtSharedVertices(this.geometryCache.segments);

    // A chained path's own two ends can meet other chained paths' own ends at the same point only
    // where `chainSegmentsAtSharedVertices` itself declined to extend through it — a degree != 2
    // vertex, i.e. an ordinary 3+-corridor T-junction (never a split hub — a split-touching end is
    // handled separately below via `touchesSplit`, `drawSplitPassages` owns that point's own
    // geometry entirely). Collected up front (GitHub issue #443 follow-up) so every such T-junction
    // gets a single `computeMiterJunctionPatch` polygon instead of each path's own end drawing an
    // independent cap that pokes across its neighbors at non-perpendicular angles.
    const junctionEnds = new Map<string, { path: { x: number; y: number }[]; end: 0 | 1 }[]>();
    for (const path of chainedCorridorPaths) {
      for (const end of [0, 1] as const) {
        const p = end === 0 ? path[0] : path[path.length - 1];
        if (touchesSplit(p)) continue;
        const k = splitTouchKey(p);
        const list = junctionEnds.get(k);
        if (list) list.push({ path, end });
        else junctionEnds.set(k, [{ path, end }]);
      }
    }

    // Two fully independent corridor-drawing algorithms (GitHub issue #510), picked by
    // `settings.renderStyle` — neither calls into the other's helpers, so a bug in one can't leak
    // into the other. See `VectorByCorridorsSettings.renderStyle`'s own doc comment.
    this.corridors.clear();
    if (settings.renderStyle === "contour") {
      // Round style (GitHub issue #493 rework): the corridor network is drawn as one filled shape
      // per tile (`buildCorridorContour`), each tile shaped only from its own passages. A turn tile
      // is a pair of concentric arcs (constant `thickness` width right through the bend — both
      // elbows rounded, the fix for #493); a straight-through tile a rectangle; a dead end a border
      // plus a semicircle; a junction (3+ passages) joins each border to the next with an arc.
      // Adjacent tiles draw mirror borders on the shared face, so the fills meet edge-to-edge with
      // no seam. Angle-based → square / hex / triangle / any future tessellation, no per-grid
      // constant.
      //
      // Miter style keeps the straight-line stroke below: a `"square"` cap protrudes as a flat-edged
      // rectangle aligned to *that line's own* direction, so two lines meeting at a non-perpendicular
      // T-junction each protrude past the other instead of reconciling into a clean corner. So for
      // miter only: every path draws `butt` unconditionally first (never protrudes), then each of
      // its own two non-split ends gets its own cap patched back in separately. A genuine free end
      // (`junctionEnds` has exactly one entry there) gets a plain square cap; a T-junction where
      // several chained paths' own ends meet (`junctionEnds` has 2+ entries) gets one shared
      // miter-style patch instead (GitHub issue #443 follow-up).
      if (strokeOpts.cap === "round") {
        const contour = buildCorridorContour(this.geometryCache.segments, strokeOpts.width, true, "shallowThreeWay");
        if (contour.length > 0) {
          traceCorridorContour(this.corridors, contour);
          this.corridors.fill(strokeOpts.color);
        }
      } else {
        this.strokeChainedPathsWithPatchedCaps(chainedCorridorPaths, junctionEnds, touchesSplit, splitTouchKey, strokeOpts);
      }
    } else {
      // Legacy line style (GitHub issue #510) — the corridor renderer as it stood before the #493
      // contour rework (git `ac2e998~1`), restored verbatim. Round style draws each chained path as a `butt`-capped stroke with a
      // plain filled circle patched at every genuine free end (a T-junction needs no patch here —
      // several round-capped discs sharing the same center safely coincide). Miter style is
      // identical to the `"contour"` mode's own miter path above (that path predates #493 and was
      // never touched by the contour rework), so it's shared as `strokeChainedPathsWithPatchedCaps`.
      if (strokeOpts.cap === "round") {
        for (const path of chainedCorridorPaths) {
          this.corridors.moveTo(path[0].x, path[0].y);
          for (let i = 1; i < path.length; i++) this.corridors.lineTo(path[i].x, path[i].y);
          this.corridors.stroke({ ...strokeOpts, cap: "butt" });
          for (const end of [path[0], path[path.length - 1]]) {
            if (!touchesSplit(end)) {
              this.corridors.circle(end.x, end.y, strokeOpts.width / 2).fill(strokeOpts.color);
            }
          }
        }
      } else {
        this.strokeChainedPathsWithPatchedCaps(chainedCorridorPaths, junctionEnds, touchesSplit, splitTouchKey, strokeOpts);
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
      buildMarkerStyle(settings.startMarker, settings.color),
      buildMarkerStyle(settings.finishMarker, settings.color),
      edges,
    );

    this.markerWiden.clear();
    // Widen the corridor stroke under each marker so it doesn't get visually swallowed by/collide
    // with the passage line (GitHub issue #311). This has its own layer, above split-gap geometry:
    // a split gap is background-colored and must not be able to cut a hairline through the marker's
    // corridor-colored expansion (GitHub issue #561). The layer remains below the marker containers.
    const squareCornerStyle = settings.join;
    drawMarkerWidenPatches(this.markerWiden, markerData, settings.color, settings.thickness, settings.markerWidenPadding, settings.markerWidenShape, squareCornerStyle);

    // Teleport markers get the same widen patch, reusing the one `markerWidenPadding`/
    // `markerWidenShape` settings (GitHub issue #313 follow-up) — no separate teleport-only setting.
    // Groups computed once here and handed to `buildTeleportWidenMarkers`, rather than it calling
    // `buildTeleportGroups` again itself — `TeleportRenderer.render` below already recomputes the
    // same grouping internally for the same `teleportEdges`, so this avoids a third redundant pass.
    const teleportGroups = settings.teleportGroupCustomization ? buildTeleportGroups(this.geometryCache.teleportEdges) : [];
    drawMarkerWidenPatches(
      this.markerWiden,
      buildTeleportWidenMarkers(this.geometryCache.teleportEdges, settings, teleportGroups),
      settings.color,
      settings.thickness,
      settings.markerWidenPadding,
      settings.markerWidenShape,
      squareCornerStyle,
    );

    // Vertical-connection markers get the same widen patch (GitHub issue #348, parity follow-up to
    // #313's teleport widen patch) — one shared `markerWidenPadding`/`markerWidenShape`, no
    // separate vertical-only setting.
    drawMarkerWidenPatches(
      this.markerWiden,
      buildVerticalWidenMarkers(this.geometryCache.verticalConnectionMarkers, settings),
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
    // Also avoid vertical passage/elevator markers and one-way corridor chevrons (GitHub issue #518).
    const teleportWaypoints = buildTeleportAvoidanceWaypoints({
      markers: markerData,
      verticalMarkers: this.geometryCache.verticalConnectionMarkers,
      oneWayCorridorSegments: this.geometryCache.segments,
      splitPassages: this.geometryCache.splitPassages,
    });
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
      // Cross-floor teleport/elevator badges are always click-to-switch-floor on the export
      // canvas (GitHub issue #478) — a read-only view like `GenerationRenderer`/`AnalyticsRenderer`,
      // so no tool-driven gating applies.
      floorNavigable: true,
      cfg,
      waypoints: teleportWaypoints,
      avoidFieldExit: settings.teleportAvoidFieldExit,
      fieldCells: nodes.map((n): [number, number] => [n.x, n.y]),
    });

    this.markers.render({ markers: markerData });

    const verticalStyle = buildVerticalConnectionStyle(settings, settings.color);
    this.verticalConnections.render({
      markers: this.geometryCache.verticalConnectionMarkers,
      style: verticalStyle,
      // Vertical-passage markers navigate to their target floor on the export canvas (GitHub
      // issue #478) — always-on, same as `GenerationRenderer`'s read-only canvas.
      interactive: true,
    });

    if (settings.markerIndex.enabled) {
      const resolveEndpointVisual = buildMarkerIndexEndpointResolver({
        teleportEdges: this.geometryCache.teleportEdges,
        teleportStyle: buildTeleportLineStyle(settings, settings.color),
        groupCustomization: settings.teleportGroupCustomization,
        groupOverrides: settings.teleportGroupOverrides,
        verticalStyle,
      });
      const indexLabels = buildMarkerIndexLabels(state.nodes, state.edges, cfg, activeFloorIndex, settings.markerIndex, resolveEndpointVisual);
      this.markerIndex.render({ ...indexLabels, style: settings.markerIndex, floorColor: settings.color });
    } else {
      this.markerIndex.clear();
    }

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
  private drawSplitPassagesThroughLineMatch(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
    return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
  }

  /** Strokes every chained corridor path with a `butt` cap, then patches each of its own two
   *  non-split ends back in separately — a genuine free end gets a plain square cap, a T-junction
   *  where several chained paths' own ends meet gets one shared `computeMiterJunctionPatch` wedge
   *  instead (GitHub issue #443 follow-up). This is the pre-#493 miter/sharp corridor stroke path,
   *  never touched by the #493 contour rework, so it's shared verbatim by both `"contour"` mode's
   *  own miter style and `"legacy_line"` mode's own miter style (GitHub issue #510) — not a new
   *  coupling between the two render styles, just the one path that was always identical either way. */
  private strokeChainedPathsWithPatchedCaps(
    chainedCorridorPaths: { x: number; y: number }[][],
    junctionEnds: Map<string, { path: { x: number; y: number }[]; end: 0 | 1 }[]>,
    touchesSplit: (p: { x: number; y: number }) => boolean,
    splitTouchKey: (p: { x: number; y: number }) => string,
    strokeOpts: { width: number; color: number; join: "round" | "miter"; cap: "round" | "square" },
  ): void {
    for (const path of chainedCorridorPaths) {
      this.corridors.moveTo(path[0].x, path[0].y);
      for (let i = 1; i < path.length; i++) this.corridors.lineTo(path[i].x, path[i].y);
      this.corridors.stroke({ ...strokeOpts, cap: "butt" });
    }
    const patchedJunctions = new Set<string>();
    for (const path of chainedCorridorPaths) {
      for (const [end, neighbor] of [[path[0], path[1]], [path[path.length - 1], path[path.length - 2]]] as const) {
        if (touchesSplit(end)) continue;
        const k = splitTouchKey(end);
        const atVertex = junctionEnds.get(k)!;
        if (atVertex.length === 1) {
          const [p0, p1, p2, p3] = computeSquareCapPatch(end, neighbor, strokeOpts.width);
          this.corridors
            .moveTo(p0.x, p0.y)
            .lineTo(p1.x, p1.y)
            .lineTo(p2.x, p2.y)
            .lineTo(p3.x, p3.y)
            .closePath()
            .fill(strokeOpts.color);
        } else if (!patchedJunctions.has(k)) {
          patchedJunctions.add(k);
          const rays: JunctionRay[] = atVertex.map(({ path: p, end: e }) => {
            // `end` (the junction point itself) minus `neighbor` (the next point in along the
            // path) points *outward* from the junction along that path — the direction
            // `computeMiterJunctionPatch`'s own `JunctionRay.dir` expects.
            const neighbor = e === 0 ? p[1] : p[p.length - 2];
            return { dir: { x: end.x - neighbor.x, y: end.y - neighbor.y }, width: strokeOpts.width };
          });
          const wedges = computeMiterJunctionPatch(rays);
          for (const wedge of wedges) {
            this.corridors.moveTo(end.x + wedge.points[0].x, end.y + wedge.points[0].y);
            for (let i = 1; i < wedge.points.length; i++) {
              this.corridors.lineTo(end.x + wedge.points[i].x, end.y + wedge.points[i].y);
            }
            this.corridors.closePath().fill(strokeOpts.color);
          }
        }
      }
    }
  }

  private drawSplitPassages(settings: VectorByCorridorsSettings, passages: SplitPassage[], specialShapes: SplitSpecialShape[]): void {
    if (settings.renderStyle === "legacy_line") {
      this.drawSplitPassagesLegacy(settings, passages, specialShapes);
      return;
    }
    this.drawSplitPassagesContour(settings, passages, specialShapes);
  }

  /** Shared per-call setup for both split-passage renderers (GitHub issue #510): resets the clip
   *  scratch, builds the `clipViewAt`/`drawConnectorLine`/one-way helpers, and draws every plain
   *  (non-special) connector — the part that was always byte-identical between `"contour"` and
   *  `"legacy_line"` mode. Returns the closures the mode-specific special-shape blocks need, plus
   *  `useSpecial` (the caller returns early when it's off). This is boilerplate + the plain-connector
   *  pass, not special-shape geometry — the two modes' special-shape drawing stays fully separate,
   *  as GitHub issue #510 requires.
   *
   *  No mask on either view (GitHub issue #314 follow-up, see `splitShapesLayer`'s own doc comment
   *  for why) — `clipView`'s own geometry is already cut exactly to the tile's face boundaries, and
   *  `gapView`'s own draw sites clamp their patch's length/width numerically to the tile's own
   *  half-size instead. `gapView` added before `clipView` (both per-call, into the same
   *  `splitShapesLayer`) so *this node's own* patch sits directly under *this node's own* line —
   *  the gap patch is a background-colored cut, not an overlay, so it needs to stay under the line
   *  it's meant to interrupt; the next `clipViewAt()` call's own pair then layers on top of that,
   *  never one global "all patches, then all lines" pass across every node. */
  private setupSplitPassageDraw(settings: VectorByCorridorsSettings, passages: SplitPassage[], specialShapes: SplitSpecialShape[]): {
    clipViewAt: () => { clipView: Graphics; gapView: Graphics };
    drawConnectorLine: (from: { x: number; y: number }, to: { x: number; y: number }, color: number, oneWayOut: boolean | undefined, width?: number, target?: Graphics, capOverride?: "butt" | "round" | "square") => void;
    oneWayStyle: { color: number; thickness: number; width: number; join: "round" | "miter"; cap: "square" | "round" };
    oneWayLengthPx: number;
    useSpecial: boolean;
  } {
    for (const g of this.splitClipScratch) g.destroy();
    this.splitClipScratch = [];

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

    const drawConnectorLine = (from: { x: number; y: number }, to: { x: number; y: number }, color: number, oneWayOut: boolean | undefined, width: number = settings.thickness, target: Graphics = this.corridors, capOverride?: "butt" | "round" | "square"): void => {
      target.moveTo(from.x, from.y).lineTo(to.x, to.y).stroke({ width, color, cap: capOverride ?? cap, join: settings.join });
      if (oneWayOut === undefined) return;
      const dx = to.x - from.x, dy = to.y - from.y;
      const len = Math.hypot(dx, dy) || 1;
      const dir = oneWayOut ? 1 : -1;
      const cx = (from.x + to.x) / 2, cy = (from.y + to.y) / 2;
      drawOneWayChevronRow(target, cx, cy, (dx / len) * dir, (dy / len) * dir, settings.oneWayCount, oneWayLengthPx, settings.oneWayGap, oneWayStyle);
    };

    const useSpecial = settings.splitSpecialShapes;

    // Special-shape points draw their own dedicated geometry in the caller, bypassing this loop
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

    return { clipViewAt, drawConnectorLine, oneWayStyle, oneWayLengthPx, useSpecial };
  }

  /** `"contour"` mode's own special-shape drawing (GitHub issue #493/#509) — draws recognized
   *  degree-4 "bridge"/"diagonal" topologies via `buildCorridorContour`/`traceCorridorContour`
   *  where `join === "round"`. Independent of `drawSplitPassagesLegacy`'s special-shape block — see
   *  GitHub issue #510's own "no shared logic between render styles" requirement (the shared
   *  `setupSplitPassageDraw` above is boilerplate + the plain-connector pass, not special-shape
   *  geometry). */
  private drawSplitPassagesContour(settings: VectorByCorridorsSettings, passages: SplitPassage[], specialShapes: SplitSpecialShape[]): void {
    const { clipViewAt, drawConnectorLine, oneWayStyle, oneWayLengthPx, useSpecial } = this.setupSplitPassageDraw(settings, passages, specialShapes);

    if (!useSpecial) return;

    // A point recognized as `"hex_triple_bridge"`/`"hex_triple_corridor"` (GitHub issue #319)
    // emits 2 special-shape entries sharing the same `pointKey` (the third node's own "through"
    // corridor is common context for both, not a separate entry of its own) — drawn only once per
    // point, on the first entry that carries it (`shape.throughLine`/`"diagonal"`'s own optional
    // `throughLine`), so the second entry doesn't redraw the exact same line on top of itself.
    const throughDrawnForPoint = new Set<string>();
    // Same dedup for the diagonal-ribbon block below (GitHub issue #319's `"hex_triple_corridor"`
    // and, in principle, any future multi-entry `"diagonal"` point) — `nodePassages` already
    // includes every node sharing this `pointKey`, not just the two faces this one shape entry
    // describes, so drawing it once per *entry* would redraw every node's own ribbon once per entry
    // sharing the point instead of once total.
    const diagonalRibbonDrawnForPoint = new Set<string>();

    for (const shape of specialShapes) {
      if (shape.kind === "diagonal" && shape.dividerJunctions) {
        const nodePassages = passages.filter((passage) => passage.pointKey === shape.pointKey);
        nodePassages.forEach((passage, nodeIndex) => {
          const junction = shape.dividerJunctions?.[nodeIndex];
          if (!junction) return;
          for (const segment of passage.wallSegments) {
            if (settings.join === "round") {
              const outerContourSegments = passage.wallSegments.map((other) => ({
                v0: passage.center,
                v1: other.center,
                v1TouchesSplit: true,
              }));
              const orderedOuter = outerContourSegments
                .map((other) => ({ other, angle: Math.atan2(other.v1.y - passage.center.y, other.v1.x - passage.center.x) }))
                .sort((a, b) => a.angle - b.angle);
              let outerTurn: typeof outerContourSegments = [];
              if (orderedOuter.length >= 3) {
                let widestGap = -1;
                let widestIndex = 0;
                for (let i = 0; i < orderedOuter.length; i++) {
                  const next = i + 1 < orderedOuter.length ? orderedOuter[i + 1].angle : orderedOuter[0].angle + Math.PI * 2;
                  const gap = next - orderedOuter[i].angle;
                  if (gap > widestGap) {
                    widestGap = gap;
                    widestIndex = i;
                  }
                }
                outerTurn = [
                  orderedOuter[widestIndex].other,
                  orderedOuter[(widestIndex + 1) % orderedOuter.length].other,
                ];
              }
              // Match the established diagonal-ribbon treatment: draw a wider background pass
              // first, then the colored arc on top. The underlay belongs to the outer arc only;
              // the inner junction contour must remain untouched.
              if (settings.splitGapWidth > 0 && outerTurn.length === 2) {
                const gridInset = 0.5 / (this.viewport.scale || 1);
                const gapWidth = Math.min(settings.thickness + 2 * settings.splitGapWidth, TILE_SIZE - 2 * gridInset);
                traceCorridorContour(this.corridors, buildCorridorContour(outerTurn, gapWidth, true));
                this.corridors.fill(settings.background);
              }
              traceCorridorContour(this.corridors, buildCorridorContour(outerContourSegments, settings.thickness, true, "shallowThreeWay"));
              this.corridors.fill(settings.color);
              if (outerTurn.length === 2) {
                traceCorridorContour(this.corridors, buildCorridorContour(outerTurn, settings.thickness, true));
                this.corridors.fill(settings.color);
              }
              break;
            }
            drawConnectorLine(
              junction, segment.center, settings.color, segment.oneWayOut, settings.thickness, this.corridors,
              settings.join === "miter" ? "butt" : "round",
            );

            // Patch the seam between this angled split ray and the ordinary corridor continuing
            // beyond the hex face. Both strokes are butt-cut at `segment.center`; the two-ray
            // miter patch closes the resulting corner without adding anything at the split's own
            // internal convergence point.
            if (settings.join !== "miter") continue;

            const faceDx = segment.v1.x - segment.v0.x, faceDy = segment.v1.y - segment.v0.y;
            let outward = { x: -faceDy, y: faceDx };
            const fromTileCenter = {
              x: segment.center.x - passage.center.x,
              y: segment.center.y - passage.center.y,
            };
            if (outward.x * fromTileCenter.x + outward.y * fromTileCenter.y < 0) {
              outward = { x: -outward.x, y: -outward.y };
            }
            const rays: JunctionRay[] = [
              { dir: { x: junction.x - segment.center.x, y: junction.y - segment.center.y }, width: settings.thickness },
              { dir: outward, width: settings.thickness },
            ];
            const inward = {
              x: passage.center.x - segment.center.x,
              y: passage.center.y - segment.center.y,
            };
            const inwardWedge = selectInwardJunctionWedge(rays, inward);
            if (inwardWedge) {
              const wedge = inwardWedge;
              this.corridors.moveTo(segment.center.x + wedge.points[0].x, segment.center.y + wedge.points[0].y);
              for (let i = 1; i < wedge.points.length; i++) {
                this.corridors.lineTo(segment.center.x + wedge.points[i].x, segment.center.y + wedge.points[i].y);
              }
              this.corridors.closePath().fill(settings.color);
            }
          }
        });
      } else if (shape.kind === "bridge") {
        const crossMid0 = { x: (shape.crossFaces[0].v0.x + shape.crossFaces[0].v1.x) / 2, y: (shape.crossFaces[0].v0.y + shape.crossFaces[0].v1.y) / 2 };
        const crossMid1 = { x: (shape.crossFaces[1].v0.x + shape.crossFaces[1].v1.x) / 2, y: (shape.crossFaces[1].v0.y + shape.crossFaces[1].v1.y) / 2 };

        // Through corridor (node 0) draws first, with no patch of its own — it's the corridor that
        // reads as passing *underneath*, so nothing needs to cut a gap into it. Drawn once per
        // point (see `throughDrawnForPoint` above) — a `"hex_triple_bridge"` point's second entry
        // shares the exact same through corridor as its first.
        if (!throughDrawnForPoint.has(shape.pointKey)) {
          throughDrawnForPoint.add(shape.pointKey);
          const [throughFrom, throughTo] = shape.throughLine;
          const { clipView: throughClipView } = clipViewAt();
          drawConnectorLine(throughFrom, throughTo, settings.color, undefined, settings.thickness, throughClipView);
        }

        // Cross corridor (node 1) gets its own patch+line pair — patch first (drawn into `gapView`,
        // below in z-order, cutting a gap into the through corridor it now sits on top of), then the
        // cross line itself (drawn into `clipView`, above both the patch and the through corridor's
        // own views) — the "this node's own patch, then this node's own line" ordering every other
        // shape uses, applied to whichever corridor draws on top here.
        const crossViews = clipViewAt();

        // Background-colored gap patch cut into the through line, centered at the tile's own center
        // (where the two corridors actually cross) — a stroke run along the *cross* line's own
        // axis, almost its full length (see `half` below), with `gapWidth` as its perpendicular
        // stroke width (`splitGapWidth` wider than the through corridor's own thickness on each
        // side). Both the stroke's own length (along cross) and width (perpendicular, along
        // through) are clamped to the tile's own size (GitHub issue #314 follow-up: no mask backs
        // this — see `splitShapesLayer`'s own doc comment for why — so a large `splitGapWidth` must
        // be clamped numerically instead of relying on one to bound an oversized stroke).
        if (settings.splitGapWidth > 0) {
          // Inset from the tile's own half-size (GitHub issue #314 follow-up) — half the grid
          // line's own stroke width, read from the live viewport scale, so the patch's own edge
          // never overdraws the grid line at the tile boundary regardless of zoom level.
          const gridInset = 0.5 / (this.viewport.scale || 1);
          const cx = (crossMid0.x + crossMid1.x) / 2, cy = (crossMid0.y + crossMid1.y) / 2;
          const dx = crossMid1.x - crossMid0.x, dy = crossMid1.y - crossMid0.y;
          const len = Math.hypot(dx, dy) || 1;
          const ux = dx / len, uy = dy / len;
          // Patch length runs 90% of the cross corridor's own length (not just a thin slice sized
          // to the through line's thickness) — a short patch left a sliver of the through line
          // poking out past the cross line's visible edge; running it almost the cross line's full
          // length instead keeps it flush.
          const half = Math.max(0, len / 2 - gridInset);
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
        // Every node's own connector (the same straight 2-share line the generic reading would
        // draw) drawn as a ribbon, bowed outward (away from the tile's own center) instead of
        // running straight, so several nodes' ribbons don't visually cross each other right at the
        // tile center — drawn once per point (`diagonalRibbonDrawnForPoint`), not once per
        // `"diagonal"` entry, since `nodePassages` below already covers every node sharing this
        // point (GitHub issue #319: a `"hex_triple_corridor"` point has 2 `"diagonal"` entries for
        // its 2 corner-cut nodes, but only 1 ribbon pass is needed — the entry loop itself is just
        // how the shape geometry happens to be split, not how many nodes there are to draw).
        if (diagonalRibbonDrawnForPoint.has(shape.pointKey)) continue;
        diagonalRibbonDrawnForPoint.add(shape.pointKey);

        // Both nodes bow by the same `bowFrac` — `drawDiagonalConnectorRibbon`
        // itself resolves "outward" independently per node from each face's own geometry, so unlike
        // an earlier version there's no need to pick a signed `side` here (GitHub issue #314
        // follow-up: that earlier per-node sign was the actual cause of one node's ribbon bowing
        // inward while the other bowed outward instead of both consistently outward). `bowFrac` is
        // `settings.splitDiagonalBowAmount` directly (0..1), not scaled by `TILE_SIZE` — it's a
        // fraction of each long edge's own ray-intersection distance, not a raw pixel offset, so
        // `1.0` always lands the control points exactly at that intersection regardless of tile
        // size or face geometry. See `drawDiagonalConnectorRibbon`'s own doc comment for how it's
        // applied without ever moving the ribbon's own corner points off the tile-face boundary.
        // A `"hex_triple_corridor"` point's third node (the opposite-face-pair one) draws below,
        // after both ribbons, as its own dedicated 2-plain-passage straight connector — that's the
        // exact same line `computeSplitConnectors` would hand this node in `passages` too (same
        // face-midpoint endpoints), so it's excluded here by matching endpoints, not drawn a second
        // time as a bowed ribbon.
        const throughLine = shape.throughLine;
        const match = (p: { x: number; y: number }, q: { x: number; y: number }) => this.drawSplitPassagesThroughLineMatch(p, q);
        const isThroughPassage = (p: SplitPassage) =>
          !!throughLine && p.connectors.length === 1 &&
          ((match(p.connectors[0].from, throughLine[0]) && match(p.connectors[0].to, throughLine[1])) ||
            (match(p.connectors[0].from, throughLine[1]) && match(p.connectors[0].to, throughLine[0])));
        const nodePassages = passages.filter((p) => p.pointKey === shape.pointKey && !isThroughPassage(p));
        const bowFrac = settings.splitDiagonalBowAmount;
        // Sharp/miter corridor style never draws this ribbon's bowed curve, regardless of
        // `bowFrac` — a curve reads as inconsistent next to a sharp-style corridor network. See
        // `drawDiagonalConnectorRibbon`'s own `sharp` param doc comment.
        const sharpRibbon = settings.join === "miter";

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
            if (settings.splitGapWidth > 0 && !sharpRibbon) {
              const { gapFrom, gapTo, clampedGapWidth } = computeDiagonalGapPatchGeometry(connector.from, connector.to, fromFaceDir, toFaceDir, gridInset, gapWidth);
              drawDiagonalConnectorRibbon(gapView, gapFrom, gapTo, fromFaceDir, toFaceDir, clampedGapWidth, settings.background, bowFrac, sharpRibbon);
            }

            drawDiagonalConnectorRibbon(clipView, connector.from, connector.to, fromFaceDir, toFaceDir, settings.thickness, settings.color, bowFrac, sharpRibbon);

            if (connector.oneWayOut === undefined) continue;
            const ddx = connector.to.x - connector.from.x, ddy = connector.to.y - connector.from.y;
            const dlen = Math.hypot(ddx, ddy) || 1;
            const dir = connector.oneWayOut ? 1 : -1;
            drawOneWayChevronRow(clipView, mx, my, (ddx / dlen) * dir, (ddy / dlen) * dir, settings.oneWayCount, oneWayLengthPx, settings.oneWayGap, oneWayStyle);
          }
        }

        // Drawn last, on top of both ribbons above (user-requested ordering for the "3 parallel
        // passages" pattern: 2 adjacent pairs' ribbons plus 1 opposite-pair straight connector,
        // the opposite-pair one reading as the topmost of the three). Being topmost now, it needs
        // its own gap patch cutting into the two ribbons underneath — same "this node's own patch,
        // then this node's own line" pairing every other connector here uses, mirroring `"bridge"`'s
        // own cross-corridor patch (there the *cross* corridor is topmost and patches the through
        // corridor; here it's the *through* one, patching both ribbons).
        if (throughLine && !throughDrawnForPoint.has(shape.pointKey)) {
          throughDrawnForPoint.add(shape.pointKey);
          const [throughFrom, throughTo] = throughLine;
          const { clipView: throughClipView, gapView: throughGapView } = clipViewAt();

          if (settings.splitGapWidth > 0 && settings.join !== "miter") {
            const tx = throughTo.x - throughFrom.x, ty = throughTo.y - throughFrom.y;
            const tlen = Math.hypot(tx, ty) || 1;
            const ux = tx / tlen, uy = ty / tlen;
            const cx = (throughFrom.x + throughTo.x) / 2, cy = (throughFrom.y + throughTo.y) / 2;
            // 90% of the through line's own length, same reasoning as the bridge shape's own
            // cross-corridor patch above — a short patch left a sliver of the underlying ribbons
            // poking out past the through line's visible edge.
            const half = Math.max(0, tlen / 2 - gridInset);
            const gapFrom = { x: cx - ux * half, y: cy - uy * half };
            const gapTo = { x: cx + ux * half, y: cy + uy * half };
            throughGapView
              .moveTo(gapFrom.x, gapFrom.y)
              .lineTo(gapTo.x, gapTo.y)
              .stroke({ width: gapWidth, color: settings.background, cap: "butt", join: settings.join });
          }

          drawConnectorLine(throughFrom, throughTo, settings.color, undefined, settings.thickness, throughClipView);
        }
      }
    }
  }

  /** `"legacy_line"` mode's own special-shape drawing (GitHub issue #510) — restored verbatim from
   *  the pre-#493-rework renderer (git `ac2e998~1`, before `buildCorridorContour`/
   *  `traceCorridorContour` were used by the mode renderer). A recognized degree-4 "bridge" topology draws the through
   *  corridor as a plain straight line underneath and the cross corridor on top with a
   *  background-colored gap cut into it; "diagonal" draws each node's own connector as a bowed
   *  ribbon (`drawDiagonalConnectorRibbon`, sharp/straight under `join === "miter"`) instead of a
   *  straight line, so the two nodes' lines don't visually cross at the tile center — never a
   *  contour fill, regardless of `join`. Independent of `drawSplitPassagesContour`'s special-shape
   *  block — no shared drawing logic beyond geometry helpers that already predate #493
   *  (`vectorByCorridorsGeometry.ts`) and the mode-agnostic `setupSplitPassageDraw` boilerplate. */
  private drawSplitPassagesLegacy(settings: VectorByCorridorsSettings, passages: SplitPassage[], specialShapes: SplitSpecialShape[]): void {
    const { clipViewAt, drawConnectorLine, oneWayStyle, oneWayLengthPx, useSpecial } = this.setupSplitPassageDraw(settings, passages, specialShapes);

    if (!useSpecial) return;

    const throughDrawnForPoint = new Set<string>();
    const diagonalRibbonDrawnForPoint = new Set<string>();

    for (const shape of specialShapes) {
      if (shape.kind === "diagonal" && shape.dividerJunctions) {
        const nodePassages = passages.filter((passage) => passage.pointKey === shape.pointKey);
        nodePassages.forEach((passage, nodeIndex) => {
          const junction = shape.dividerJunctions?.[nodeIndex];
          if (!junction) return;
          for (const segment of passage.wallSegments) {
            drawConnectorLine(
              junction, segment.center, settings.color, segment.oneWayOut, settings.thickness, this.corridors,
              settings.join === "miter" ? "butt" : "round",
            );

            // Patch the seam between this angled split ray and the ordinary corridor continuing
            // beyond the hex face. Both strokes are butt-cut at `segment.center`; the two-ray
            // miter patch closes the resulting corner without adding anything at the split's own
            // internal convergence point.
            if (settings.join !== "miter") continue;

            const faceDx = segment.v1.x - segment.v0.x, faceDy = segment.v1.y - segment.v0.y;
            let outward = { x: -faceDy, y: faceDx };
            const fromTileCenter = {
              x: segment.center.x - passage.center.x,
              y: segment.center.y - passage.center.y,
            };
            if (outward.x * fromTileCenter.x + outward.y * fromTileCenter.y < 0) {
              outward = { x: -outward.x, y: -outward.y };
            }
            const rays: JunctionRay[] = [
              { dir: { x: junction.x - segment.center.x, y: junction.y - segment.center.y }, width: settings.thickness },
              { dir: outward, width: settings.thickness },
            ];
            const inward = {
              x: passage.center.x - segment.center.x,
              y: passage.center.y - segment.center.y,
            };
            const inwardWedge = selectInwardJunctionWedge(rays, inward);
            if (inwardWedge) {
              const wedge = inwardWedge;
              this.corridors.moveTo(segment.center.x + wedge.points[0].x, segment.center.y + wedge.points[0].y);
              for (let i = 1; i < wedge.points.length; i++) {
                this.corridors.lineTo(segment.center.x + wedge.points[i].x, segment.center.y + wedge.points[i].y);
              }
              this.corridors.closePath().fill(settings.color);
            }
          }
        });
      } else if (shape.kind === "bridge") {
        const crossMid0 = { x: (shape.crossFaces[0].v0.x + shape.crossFaces[0].v1.x) / 2, y: (shape.crossFaces[0].v0.y + shape.crossFaces[0].v1.y) / 2 };
        const crossMid1 = { x: (shape.crossFaces[1].v0.x + shape.crossFaces[1].v1.x) / 2, y: (shape.crossFaces[1].v0.y + shape.crossFaces[1].v1.y) / 2 };

        if (!throughDrawnForPoint.has(shape.pointKey)) {
          throughDrawnForPoint.add(shape.pointKey);
          const [throughFrom, throughTo] = shape.throughLine;
          const { clipView: throughClipView } = clipViewAt();
          drawConnectorLine(throughFrom, throughTo, settings.color, undefined, settings.thickness, throughClipView);
        }

        const crossViews = clipViewAt();

        if (settings.splitGapWidth > 0) {
          const gridInset = 0.5 / (this.viewport.scale || 1);
          const cx = (crossMid0.x + crossMid1.x) / 2, cy = (crossMid0.y + crossMid1.y) / 2;
          const dx = crossMid1.x - crossMid0.x, dy = crossMid1.y - crossMid0.y;
          const len = Math.hypot(dx, dy) || 1;
          const ux = dx / len, uy = dy / len;
          const half = Math.min((len / 2) * 0.9, TILE_SIZE / 2 - gridInset);
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
        if (diagonalRibbonDrawnForPoint.has(shape.pointKey)) continue;
        diagonalRibbonDrawnForPoint.add(shape.pointKey);

        const throughLine = shape.throughLine;
        const match = (p: { x: number; y: number }, q: { x: number; y: number }) => this.drawSplitPassagesThroughLineMatch(p, q);
        const isThroughPassage = (p: SplitPassage) =>
          !!throughLine && p.connectors.length === 1 &&
          ((match(p.connectors[0].from, throughLine[0]) && match(p.connectors[0].to, throughLine[1])) ||
            (match(p.connectors[0].from, throughLine[1]) && match(p.connectors[0].to, throughLine[0])));
        const nodePassages = passages.filter((p) => p.pointKey === shape.pointKey && !isThroughPassage(p));
        const bowFrac = settings.splitDiagonalBowAmount;
        const sharpRibbon = settings.join === "miter";

        const gridInset = 0.5 / (this.viewport.scale || 1);
        const gapWidth = Math.min(settings.thickness + 2 * settings.splitGapWidth, TILE_SIZE - 2 * gridInset);

        for (const passage of nodePassages) {
          const { clipView, gapView } = clipViewAt();

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

            if (settings.splitGapWidth > 0 && !sharpRibbon) {
              const { gapFrom, gapTo, clampedGapWidth } = computeDiagonalGapPatchGeometry(connector.from, connector.to, fromFaceDir, toFaceDir, gridInset, gapWidth);
              drawDiagonalConnectorRibbon(gapView, gapFrom, gapTo, fromFaceDir, toFaceDir, clampedGapWidth, settings.background, bowFrac, sharpRibbon);
            }

            drawDiagonalConnectorRibbon(clipView, connector.from, connector.to, fromFaceDir, toFaceDir, settings.thickness, settings.color, bowFrac, sharpRibbon);

            if (connector.oneWayOut === undefined) continue;
            const ddx = connector.to.x - connector.from.x, ddy = connector.to.y - connector.from.y;
            const dlen = Math.hypot(ddx, ddy) || 1;
            const dir = connector.oneWayOut ? 1 : -1;
            drawOneWayChevronRow(clipView, mx, my, (ddx / dlen) * dir, (ddy / dlen) * dir, settings.oneWayCount, oneWayLengthPx, settings.oneWayGap, oneWayStyle);
          }
        }

        if (throughLine && !throughDrawnForPoint.has(shape.pointKey)) {
          throughDrawnForPoint.add(shape.pointKey);
          const [throughFrom, throughTo] = throughLine;
          const { clipView: throughClipView, gapView: throughGapView } = clipViewAt();

          if (settings.splitGapWidth > 0 && settings.join !== "miter") {
            const tx = throughTo.x - throughFrom.x, ty = throughTo.y - throughFrom.y;
            const tlen = Math.hypot(tx, ty) || 1;
            const ux = tx / tlen, uy = ty / tlen;
            const cx = (throughFrom.x + throughTo.x) / 2, cy = (throughFrom.y + throughTo.y) / 2;
            const half = Math.min((tlen / 2) * 0.9, TILE_SIZE / 2 - gridInset);
            const gapFrom = { x: cx - ux * half, y: cy - uy * half };
            const gapTo = { x: cx + ux * half, y: cy + uy * half };
            throughGapView
              .moveTo(gapFrom.x, gapFrom.y)
              .lineTo(gapTo.x, gapTo.y)
              .stroke({ width: gapWidth, color: settings.background, cap: "butt", join: settings.join });
          }

          drawConnectorLine(throughFrom, throughTo, settings.color, undefined, settings.thickness, throughClipView);
        }
      }
    }
  }

  /** Highlights the currently hovered export warning's flagged cell(s) — see
   *  `ExportWarningHighlight`'s own doc comment for the memoize-then-draw mechanics, shared with
   *  `VectorByWallsRenderer`'s own copy of this method. */
  private renderWarningHighlight(state: ReturnType<typeof useMazeStore.getState>): void {
    const { hoveredExportWarningKey } = state;
    if (!hoveredExportWarningKey) {
      this.warningHighlight.render(null, [], [], state.activeTessellationConfig, state.vectorByCorridorsSettings, null, null);
      return;
    }
    const rawEndpoints = resolveEffectiveEndpoints(state);
    // Same floor-scoping as `renderAll` (GitHub issue #348) — the warning computation must see
    // exactly the drawn floor's own nodes/edges, or a hovered warning's `nodes`/`edges` could
    // reference an id that isn't actually rendered.
    const { nodes, edges, start, finish } = selectFloorScopedMaze(
      state.nodes, state.edges, state.floors, state.activeFloorId, rawEndpoints.start, rawEndpoints.finish,
    );
    const warnings = computeVectorByCorridorsWarningsAcrossFloors(
      state.nodes, state.edges, state.floors, state.activeTessellationConfig, state.vectorByCorridorsSettings,
      rawEndpoints.start, rawEndpoints.finish,
    );
    const oneWayBoundaryWidth = state.vectorByCorridorsSettings.oneWayWidth * state.vectorByCorridorsSettings.thickness + state.vectorByCorridorsSettings.oneWayThickness;
    this.warningHighlight.render(hoveredExportWarningKey, nodes, edges, state.activeTessellationConfig, state.vectorByCorridorsSettings, start, finish, state.nodes, warnings, 2 / (this.viewport.scale || 1), oneWayBoundaryWidth, true);
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
    this.markerWiden.destroy();
    this.markerWidenContainer.destroy();
    this.verticalConnections.destroy();
    this.verticalContainer.destroy();
    this.markerIndex.destroy();
    this.markerIndexGapContainer.destroy();
    this.markerIndexBodyContainer.destroy();
    this.warningHighlight.destroy();
    this.warningHighlightContainer.destroy();
  }
}

export { buildTeleportWidenMarkers, buildVerticalWidenMarkers, computeDiagonalGapPatchGeometry } from "./vectorByCorridorsGeometry";
