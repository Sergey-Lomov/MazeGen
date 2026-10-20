import { Container, Graphics } from "pixi.js";
import { useMazeStore } from "../../store/mazeStore";
import { buildCorridorSegments, shortestCorridorFaceAcrossFloors, buildMazeMarkers, buildTeleportEdges, buildTeleportFloorInputs, buildSplitPassages, maxSplitNodeCount, selectFloorScopedMaze, selectNodeLevelResolver, selectVerticalPassagePairSet, buildVerticalConnectionMarkers, buildMarkerIndexLabels, buildTeleportAvoidanceWaypoints, type CorridorSegment } from "../selectors/mazeSelectors";
import { MarkerIndexRenderer } from "../renderers/MarkerIndexRenderer";
import { FloorLabelRenderer, floorLabelPosition } from "../renderers/FloorLabelRenderer";
import { WaypointsRenderer } from "../renderers/WaypointsRenderer";
import { buildMarkerScaler } from "../markerScale";
import { footprintsOfMarkers, footprintsOfTeleports, footprintsOfVertical } from "../markerFootprints";
import { TeleportRenderer } from "../renderers/TeleportRenderer";
import { VerticalConnectionRenderer } from "../renderers/VerticalConnectionRenderer";
import { drawMarkerWidenPatches } from "../renderers/markerWidenPatches";
import { drawOneWayChevronRow } from "../renderers/wallUtils";
import { buildTeleportGroups } from "../selectors/teleportGroups";
import { withResolvedGroupOverrides } from "../../store/teleportGroupLinks";
import { resolveRendererGroupOverrides } from "../selectors/projectTeleportGroups";
import { resolveEffectiveEndpoints, buildMarkerStyle, buildTeleportLineStyle, buildVerticalConnectionStyle, buildEffectiveSplitNodeColors, buildMarkerIndexEndpointResolver, BackgroundGridLayer, ExportWarningHighlight } from "./VectorByWallsRenderer";
import { computeVectorByCorridorsWarnings, computeVectorByCorridorsWarningsAcrossFloors } from "../selectors/exportWarnings";
import type { NodeDto, EdgeDto } from "../../wasm/types";
import type { Viewport, TeleportEdge, SplitPassage, SplitSpecialShape, VerticalConnectionMarker } from "../renderers/types";
import { buildTeleportWidenMarkers, buildVerticalWidenMarkers, clipStrokeToConvexPolygon, computeDiagonalGapPatchGeometry, drawDiagonalConnectorRibbon, selectInwardJunctionWedge, type JunctionRay } from "./vectorByCorridorsGeometry";
import { buildCorridorContour, buildCorridorContourInstances, traceCorridorContour, type CorridorShapeCache } from "./vectorByCorridorsContour";
import { buildCorridorLineTiles, traceCorridorLineTile } from "./vectorByCorridorsLineTiles";
import { CorridorTileLayer } from "./corridorTileLayer";
import type { VectorByCorridorsSettings } from "../../store/storeTypes";
import type { FieldConfig } from "../../fieldConfig";
import { TILE_SIZE } from "../constants";
import { disabledOfNumber } from "../../styles/palette";
import type { ModeRenderer } from "./modeRendererFactory";
import { resolveBackgroundColor, measureContentMargin, type ExportMargin } from "./exportMargins";
import { cellCenterBounds, exactCellBounds, getCellVertices, pointInPolygon } from "../tessellationGeometry";

type SplitPoint = { x: number; y: number };
type SplitClipViews = { clipView: Graphics; gapView: Graphics };
type SplitConnectorLine = (
  from: SplitPoint,
  to: SplitPoint,
  color: number,
  oneWayOut: boolean | undefined,
  width?: number,
  target?: Graphics,
  capOverride?: "butt" | "round" | "square",
) => void;
type SplitOneWayStyle = { color: number; thickness: number; width: number; join: "round" | "miter"; cap: "square" | "round" };


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
  /** Corridor network tiles, below `corridors` (see `updateCorridorTiles`). */
  private readonly corridorTiles = new CorridorTileLayer();
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
  private readonly floorLabelContainer: Container;
  private readonly floorLabel: FloorLabelRenderer;
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
    cfg: FieldConfig;
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

  /** Shortest passage face over all floors, memoized on the maze data alone: the thickness slider
   *  must not rebuild every floor's segments. Contour widths never exceed it. */
  private faceLimitCache: { nodes: NodeDto[]; edges: EdgeDto[]; floors: unknown; cfg: FieldConfig; limit: number } | null = null;

  private corridorFaceLimit(state: { nodes: NodeDto[]; edges: EdgeDto[]; floors: { id: string }[] }, cfg: FieldConfig): number {
    const cache = this.faceLimitCache;
    if (cache && cache.nodes === state.nodes && cache.edges === state.edges && cache.floors === state.floors && cache.cfg === cfg) return cache.limit;
    const limit = shortestCorridorFaceAcrossFloors(state.nodes, state.edges, state.floors, cfg);
    this.faceLimitCache = { nodes: state.nodes, edges: state.edges, floors: state.floors, cfg, limit };
    return limit;
  }

  /** Corridor width for contour shapes: one width on every floor, however short a face is elsewhere. */
  private contourWidth(settings: VectorByCorridorsSettings): number {
    return Math.min(settings.thickness, this.faceLimitCache?.limit ?? Infinity);
  }

  /** Inputs `corridorTiles` was last built from — see `updateCorridorTiles`. */
  private corridorTileInputs: { segments: CorridorSegment[]; kind: "contour" | "miter" | "round_line"; width: number; junctionRadius: number } | null = null;
  /** Contour tile shapes by key, kept across rebuilds so an edit only builds shapes it hasn't seen. */
  private readonly contourShapeCache: CorridorShapeCache = new Map();

  constructor(container: Container) {
    this.backgroundGrid = new BackgroundGridLayer(container);

    this.corridorsContainer = new Container();
    container.addChild(this.corridorsContainer);

    this.corridorsContainer.addChild(this.corridorTiles.container);
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

    this.floorLabelContainer = new Container();
    container.addChild(this.floorLabelContainer);
    this.floorLabel = new FloorLabelRenderer(this.floorLabelContainer);

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
        state.activeFieldConfig !== prev.activeFieldConfig ||
        state.activeFloorId !== prev.activeFloorId ||
        state.floors !== prev.floors;
      const settingsChanged = state.vectorByCorridorsSettings !== prev.vectorByCorridorsSettings;
      if ((dataChanged || settingsChanged) && state.openCard === "image_export") {
        this.renderAll(state);
      } else if ((state.hoveredExportWarningKey !== prev.hoveredExportWarningKey || state.hoveredTeleportNodeIds !== prev.hoveredTeleportNodeIds) && state.openCard === "image_export") {
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
    this.floorLabelContainer.visible = visible;
    this.warningHighlightContainer.visible = visible;
    if (visible) this.renderAll(state);
  }

  onViewportChanged(x: number, y: number, w: number, h: number, scale: number): void {
    this.viewport = { x, y, w, h, scale };
    this.backgroundGrid.onViewportChanged(this.viewport);
    const state = useMazeStore.getState();
    if (state.openCard === "image_export") {
      this.backgroundGrid.render(state.vectorByCorridorsSettings, state.activeFieldConfig);
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
    const cellBounds = cellCenterBounds(floorNodes, state.activeFieldConfig);
    return measureContentMargin(
      [this.corridorsContainer, this.splitShapesLayer, this.markerWidenContainer, this.teleportContainer, this.markersContainer, this.verticalContainer, this.markerIndexGapContainer, this.markerIndexBodyContainer, this.floorLabelContainer],
      cellBounds,
    );
  }

  getBackgroundColor(): number {
    const state = useMazeStore.getState();
    return resolveBackgroundColor("vector_by_corridors", { vectorByWallsSettings: state.vectorByWallsSettings, vectorByCorridorsSettings: state.vectorByCorridorsSettings });
  }

  private renderAll(state: ReturnType<typeof useMazeStore.getState>): void {
    const cfg = state.activeFieldConfig;

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

    // Corridor network (GitHub issue #736): one tile per cell, shared per tile shape — see
    // `updateCorridorTiles`. Everything drawn into `corridors` below sits on top of the tiles.
    this.corridors.clear();
    this.corridorFaceLimit(state, cfg);
    this.updateCorridorTiles(settings, this.geometryCache.segments);

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

    // Marker size adaptation (GitHub issue #819): one scaler for every marker kind on this floor.
    const teleportStyle = buildTeleportLineStyle(settings, settings.color);
    const verticalStyle = buildVerticalConnectionStyle(settings, settings.color);
    const scaler = buildMarkerScaler(cfg, [
      ...footprintsOfMarkers(markerData),
      ...footprintsOfVertical(this.geometryCache.verticalConnectionMarkers, verticalStyle),
      ...footprintsOfTeleports(this.geometryCache.teleportEdges, teleportStyle),
    ]);

    this.markerWiden.clear();
    // Widen the corridor stroke under each marker so it doesn't get visually swallowed by/collide
    // with the passage line (GitHub issue #311). This has its own layer, above split-gap geometry:
    // a split gap is background-colored and must not be able to cut a hairline through the marker's
    // corridor-colored expansion (GitHub issue #561). The layer remains below the marker containers.
    const squareCornerStyle = settings.join;
    drawMarkerWidenPatches(this.markerWiden, markerData, settings.color, settings.thickness, settings.markerWidenPadding, settings.markerWidenShape, squareCornerStyle, scaler);

    // Teleport markers get the same widen patch, reusing the one `markerWidenPadding`/
    // `markerWidenShape` settings (GitHub issue #313 follow-up) — no separate teleport-only setting.
    // Groups computed once here and handed to `buildTeleportWidenMarkers`, rather than it calling
    // `buildTeleportGroups` again itself — `TeleportRenderer.render` below already recomputes the
    // same grouping internally for the same `teleportEdges`, so this avoids a third redundant pass.
    const teleportGroups = settings.teleportGroupCustomization ? buildTeleportGroups(this.geometryCache.teleportEdges) : [];
    // Overrides are stored under project-wide (cross-floor merged) group keys; re-key them onto this floor's groups.
    const teleportGroupOverrides = settings.teleportGroupCustomization
      ? resolveRendererGroupOverrides(teleportGroups, withResolvedGroupOverrides(settings).teleportGroupOverrides, {
        nodes: state.nodes, edges: state.edges, cfg, floors: state.floors,
        avoidFieldExit: settings.teleportAvoidFieldExit, start: rawEndpoints.start, finish: rawEndpoints.finish,
      })
      : settings.teleportGroupOverrides;
    drawMarkerWidenPatches(
      this.markerWiden,
      buildTeleportWidenMarkers(this.geometryCache.teleportEdges, { ...settings, teleportGroupOverrides }, teleportGroups),
      settings.color,
      settings.thickness,
      settings.markerWidenPadding,
      settings.markerWidenShape,
      squareCornerStyle,
      scaler,
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
      scaler,
    );

    // Split points (GitHub issue #314) — drawn after the plain corridor stroke and marker widen
    // patches (so a split hub sitting under a start/finish/teleport marker is already widened the
    // same way a plain corridor is), before the markers/teleports themselves land on top.
    this.drawSplitPassages(settings, this.geometryCache.splitPassages, this.geometryCache.splitSpecialShapes, cfg);

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
      scaler,
      // `floorColor` occludes an outline (exit-only) teleport point's own line pass-through and
      // fills its gap rings — on this canvas that's the corridor's own color, not the canvas
      // background, since a teleport point sits directly on the passage line, not on an empty
      // floor tile the way "Vector by walls"' floor does.
      lineStyle: teleportStyle,
      groupCustomization: settings.teleportGroupCustomization,
      groupOverrides: teleportGroupOverrides,
      // Cross-floor teleport/elevator badges are always click-to-switch-floor on the export
      // canvas (GitHub issue #478) — a read-only view like `GenerationRenderer`/`AnalyticsRenderer`,
      // so no tool-driven gating applies.
      floorNavigable: true,
      cfg,
      waypoints: teleportWaypoints,
      avoidFieldExit: settings.teleportAvoidFieldExit,
      fieldCells: nodes.map((n): [number, number] => [n.x, n.y]),
    });

    this.markers.render({ markers: markerData, scaler });

    this.verticalConnections.render({
      markers: this.geometryCache.verticalConnectionMarkers,
      style: verticalStyle,
      scaler,
      // Vertical-passage markers navigate to their target floor on the export canvas (GitHub
      // issue #478) — always-on, same as `GenerationRenderer`'s read-only canvas.
      interactive: true,
    });

    if (settings.markerIndex.enabled) {
      const resolveEndpointVisual = buildMarkerIndexEndpointResolver({
        teleportEdges: this.geometryCache.teleportEdges,
        teleportStyle,
        groupCustomization: settings.teleportGroupCustomization,
        groupOverrides: teleportGroupOverrides,
        verticalStyle,
      });
      const indexLabels = buildMarkerIndexLabels(state.nodes, state.edges, cfg, activeFloorIndex, settings.markerIndex, resolveEndpointVisual, scaler);
      this.markerIndex.render({ ...indexLabels, style: settings.markerIndex, floorColor: settings.color });
    } else {
      this.markerIndex.clear();
    }

    this.floorLabel.render(
      settings.floorLabel,
      floorLabelPosition(settings.floorLabel, state.activeFloorId, exactCellBounds(nodes, cfg), cfg),
      activeFloorIndex,
      state.floors.length,
      settings.color,
      state.floors[activeFloorIndex]?.title,
    );

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

  /** Returns split passages in their normal order, except when a special divider explicitly marks
   *  one node as the visual top layer. The marker is stored as a node index because Cairo's
   *  canonical face numbers are not the same thing as the order in which split nodes happen to
   *  be supplied. */
  private orderSpecialDiagonalPassages(passages: SplitPassage[], topNodeIndex?: number): SplitPassage[] {
    if (topNodeIndex === undefined) return passages;
    const top = passages.find((passage) => passage.nodeIndex === topNodeIndex);
    if (!top) return passages;
    return [...passages.filter((passage) => passage !== top), top];
  }

  /** Draws the corridor network as per-cell tiles (GitHub issue #736) via `corridorTiles`, picking
   *  one of three tile shapes:
   *  - **Contour, round join** (GitHub issues #493, #726): one filled shape per tile
   *    (`buildCorridorContourInstances`), each shaped only from its own passages — a ribbon from every
   *    passage's face to a shared target point, joined around it with corners rounded to
   *    `settings.junctionRadius`. Adjacent tiles draw mirror borders on the shared face.
   *  - **Miter join, either rendering mode**: straight `butt` lines from the cell centre with a
   *    miter join, a square cap at a dead end and `computeMiterJunctionPatch` wedges at a junction of
   *    3+ lines (GitHub issue #443 follow-up) — a `"square"` cap would protrude past neighbors at a
   *    non-perpendicular junction (`traceCorridorLineTile`).
   *  - **Legacy line, round join** (GitHub issue #510): straight `butt` lines plus a centre disc.
   *  Line tiles split every centre-to-centre segment at its midpoint, so they draw exactly what the
   *  former chained-path stroke drew. Tiles are rebuilt only when the segments or shape settings
   *  change, and then only the cells whose shape changed (`CorridorTileLayer.update`); the color
   *  is a tint. */
  private updateCorridorTiles(settings: VectorByCorridorsSettings, segments: CorridorSegment[]): void {
    const kind = settings.join === "miter" ? "miter" : settings.renderStyle === "contour" ? "contour" : "round_line";
    const width = kind === "contour" ? this.contourWidth(settings) : settings.thickness;
    const junctionRadius = settings.junctionRadius;
    const inputs = this.corridorTileInputs;
    if (!inputs || inputs.segments !== segments || inputs.kind !== kind || inputs.width !== width || (kind === "contour" && inputs.junctionRadius !== junctionRadius)) {
      if (kind === "contour") {
        // Keys carry the half-width and radius, so the cache stays valid across settings; it only
        // needs a bound against unbounded growth while a slider is dragged.
        if (this.contourShapeCache.size > 4096) this.contourShapeCache.clear();
        const instances = buildCorridorContourInstances(segments, width, junctionRadius, this.contourShapeCache);
        this.corridorTiles.update(instances, (instance, context) => {
          traceCorridorContour(context, [instance.shape]);
          context.fill(0xffffff);
        });
      } else {
        const join = kind === "miter" ? "miter" : "round";
        const tiles = buildCorridorLineTiles(segments, width, join);
        this.corridorTiles.update(tiles, (tile, context) => traceCorridorLineTile(context, tile.ports, width, join));
      }
      this.corridorTileInputs = { segments, kind, width, junctionRadius };
    }
    this.corridorTiles.setTint(settings.color);
  }

  private drawSplitPassages(settings: VectorByCorridorsSettings, passages: SplitPassage[], specialShapes: SplitSpecialShape[], cfg: FieldConfig): void {
    if (settings.renderStyle === "legacy_line") {
      this.drawSplitPassagesLegacy(settings, passages, specialShapes, cfg);
      return;
    }
    this.drawSplitPassagesContour(settings, passages, specialShapes, cfg);
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
    clipViewAt: () => SplitClipViews;
    drawConnectorLine: SplitConnectorLine;
    oneWayStyle: SplitOneWayStyle;
    oneWayLengthPx: number;
    useSpecial: boolean;
    bridgeUnderlayPassages: SplitPassage[];
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
    // entirely for that point's own connectors. A Cairo 2x3 bridge keeps the other node's fork
    // as a separate ordinary-corridor underlay, selected below and rendered by the mode-specific
    // caller before the bridge deck is layered on top.
    const specialPointKeys = new Set(useSpecial ? specialShapes.map((s) => s.pointKey) : []);
    const bridgeUnderlayPointKeys = new Set(
      useSpecial
        ? specialShapes.filter((shape) => shape.kind === "bridge" && !shape.throughLine).map((shape) => shape.pointKey)
        : [],
    );

    const pointOnFace = (
      point: { x: number; y: number },
      face: { v0: { x: number; y: number }; v1: { x: number; y: number } },
    ): boolean => {
      const dx = face.v1.x - face.v0.x;
      const dy = face.v1.y - face.v0.y;
      const lengthSquared = dx * dx + dy * dy;
      if (lengthSquared <= 1e-12) return Math.hypot(point.x - face.v0.x, point.y - face.v0.y) <= 1e-6;
      const t = ((point.x - face.v0.x) * dx + (point.y - face.v0.y) * dy) / lengthSquared;
      if (t < -1e-6 || t > 1 + 1e-6) return false;
      return Math.abs((point.x - face.v0.x) * dy - (point.y - face.v0.y) * dx) <= 1e-6 * Math.sqrt(lengthSquared);
    };

    const isBridgePassage = (passage: SplitPassage, shapesAtPoint: SplitSpecialShape[]): boolean => {
      if (passage.wallSegments.length === 0) return false;
      const bridgeFaces = shapesAtPoint
        .filter((shape): shape is Extract<SplitSpecialShape, { kind: "bridge" }> => shape.kind === "bridge")
        .flatMap((shape) => shape.crossFaces);
      return bridgeFaces.length > 0 && passage.wallSegments.every((segment) =>
        bridgeFaces.some((face) => pointOnFace(segment.center, face)));
    };

    const bridgeUnderlayPassages = passages.filter((passage) => {
      if (!bridgeUnderlayPointKeys.has(passage.pointKey)) return false;
      const shapesAtPoint = specialShapes.filter((shape) => shape.pointKey === passage.pointKey);
      return !isBridgePassage(passage, shapesAtPoint);
    });

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

    return { clipViewAt, drawConnectorLine, oneWayStyle, oneWayLengthPx, useSpecial, bridgeUnderlayPassages };
  }

  /** Converts the Cairo bridge's ordinary three-face split passage into the same per-cell
   *  contour input used by a normal corridor junction. The resulting tile is drawn on the shared
   *  corridor layer; the bridge's own dedicated layer is appended afterwards and therefore sits
   *  above it. */
  private bridgeUnderlaySegments(passage: SplitPassage, cfg: FieldConfig): CorridorSegment[] {
    const cellVertices = this.splitCellVertices(passage.pointKey, cfg);
    return passage.wallSegments.map((segment) => {
      const dx = segment.v1.x - segment.v0.x;
      const dy = segment.v1.y - segment.v0.y;
      const length = Math.hypot(dx, dy) || 1;
      let faceNormal = { x: -dy / length, y: dx / length };
      const fromCentre = { x: segment.center.x - passage.center.x, y: segment.center.y - passage.center.y };
      if (faceNormal.x * fromCentre.x + faceNormal.y * fromCentre.y < 0) {
        faceNormal = { x: -faceNormal.x, y: -faceNormal.y };
      }
      return {
        v0: passage.center,
        v1: segment.center,
        faceMidpoint: segment.center,
        faceNormal,
        faceLength: length,
        cellVertices0: cellVertices,
        fromNode: passage.nodeIndex ?? -1,
        toNode: passage.nodeIndex ?? -1,
        v1TouchesSplit: true,
      };
    });
  }

  private drawBridgeUnderlayContour(settings: VectorByCorridorsSettings, passages: SplitPassage[], cfg: FieldConfig): void {
    for (const passage of passages) {
      const segments = this.bridgeUnderlaySegments(passage, cfg);
      if (segments.length === 0) continue;
      const contour = buildCorridorContour(segments, this.contourWidth(settings), settings.junctionRadius);
      if (contour.length === 0) continue;
      traceCorridorContour(this.corridors, contour);
      this.corridors.fill(settings.color);
    }
  }

  private drawBridgeUnderlayLines(
    settings: VectorByCorridorsSettings,
    passages: SplitPassage[],
    drawConnectorLine: ReturnType<VectorByCorridorsRenderer["setupSplitPassageDraw"]>["drawConnectorLine"],
  ): void {
    for (const passage of passages) {
      for (const segment of passage.wallSegments) {
        const color = segment.isUndefined ? disabledOfNumber(passage.color) : settings.color;
        drawConnectorLine(passage.center, segment.center, color, segment.oneWayOut, settings.thickness, this.corridors);
      }
    }
  }

  /** Draws one bridge's shared through/cross geometry. Both render styles use the same layer
   *  order and the same cell-clipped gap; only the ordinary fork underlay differs by style. */
  private drawBridgeSpecialShape(
    settings: VectorByCorridorsSettings,
    shape: Extract<SplitSpecialShape, { kind: "bridge" }>,
    cfg: FieldConfig,
    clipViewAt: () => SplitClipViews,
    drawConnectorLine: SplitConnectorLine,
    throughDrawnForPoint: Set<string>,
  ): void {
    const crossMid0 = { x: (shape.crossFaces[0].v0.x + shape.crossFaces[0].v1.x) / 2, y: (shape.crossFaces[0].v0.y + shape.crossFaces[0].v1.y) / 2 };
    const crossMid1 = { x: (shape.crossFaces[1].v0.x + shape.crossFaces[1].v1.x) / 2, y: (shape.crossFaces[1].v0.y + shape.crossFaces[1].v1.y) / 2 };
    const bridgeCellVertices = this.splitCellVertices(shape.pointKey, cfg, [
      crossMid0,
      crossMid1,
      { x: (crossMid0.x + crossMid1.x) / 2, y: (crossMid0.y + crossMid1.y) / 2 },
      ...(shape.throughLine ?? []),
    ]);

    if (shape.throughLine && !throughDrawnForPoint.has(shape.pointKey)) {
      throughDrawnForPoint.add(shape.pointKey);
      const [throughFrom, throughTo] = shape.throughLine;
      const { clipView: throughClipView } = clipViewAt();
      drawConnectorLine(throughFrom, throughTo, settings.color, undefined, settings.thickness, throughClipView);
    }

    const crossViews = clipViewAt();
    if (settings.splitGapWidth > 0) {
      const gridInset = 0.5 / (this.viewport.scale || 1);
      const dx = crossMid1.x - crossMid0.x, dy = crossMid1.y - crossMid0.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const half = Math.max(0, len / 2 - gridInset);
      const gapWidth = Math.min(settings.thickness + 2 * settings.splitGapWidth, TILE_SIZE - 2 * gridInset);
      const gapFrom = {
        x: (crossMid0.x + crossMid1.x) / 2 - ux * half,
        y: (crossMid0.y + crossMid1.y) / 2 - uy * half,
      };
      const gapTo = {
        x: (crossMid0.x + crossMid1.x) / 2 + ux * half,
        y: (crossMid0.y + crossMid1.y) / 2 + uy * half,
      };
      const clippedGap = bridgeCellVertices
        ? clipStrokeToConvexPolygon(crossMid0, crossMid1, gapWidth, bridgeCellVertices, gridInset)
        : null;
      if (clippedGap) {
        crossViews.gapView.poly(clippedGap.flatMap((point) => [point.x, point.y])).fill(settings.background);
      } else if (!bridgeCellVertices) {
        crossViews.gapView
          .moveTo(gapFrom.x, gapFrom.y)
          .lineTo(gapTo.x, gapTo.y)
          .stroke({ width: gapWidth, color: settings.background, cap: "butt", join: settings.join });
      }
    }

    drawConnectorLine(crossMid0, crossMid1, settings.color, undefined, settings.thickness, crossViews.clipView);
  }

  /** `"contour"` mode's own special-shape drawing (GitHub issue #493/#509) — draws recognized
   *  degree-4 "bridge"/"diagonal" topologies via `buildCorridorContour`/`traceCorridorContour`
   *  where `join === "round"`. Independent of `drawSplitPassagesLegacy`'s special-shape block — see
   *  GitHub issue #510's own "no shared logic between render styles" requirement (the shared
   *  `setupSplitPassageDraw` above is boilerplate + the plain-connector pass, not special-shape
   *  geometry). */
  private splitCellVertices(pointKey: string, cfg: FieldConfig, referencePoints: { x: number; y: number }[] = []): { x: number; y: number }[] | undefined {
    const [x, y] = pointKey.split(",").map(Number);
    const vertices = Number.isFinite(x) && Number.isFinite(y) ? getCellVertices(x, y, cfg) ?? undefined : undefined;
    if (!vertices || referencePoints.length === 0) return vertices;
    // A malformed/mismatched synthetic shape must not be clipped against an unrelated cell;
    // returning undefined preserves the renderer's established fallback in that case.
    const isStrictlyInside = (point: { x: number; y: number }) => pointInPolygon(point, vertices) && vertices.every((vertex, index) => {
      const next = vertices[(index + 1) % vertices.length];
      return Math.abs((next.x - vertex.x) * (point.y - vertex.y) - (next.y - vertex.y) * (point.x - vertex.x)) > 1e-6;
    });
    if (!referencePoints.some(isStrictlyInside)) return undefined;
    return vertices;
  }

  /** Finds the face axis nearest a split connector endpoint. Both split render styles need the
   *  same axis to cut the ribbon end flush with the ordinary corridor segment. */
  private faceDirectionAt(passage: SplitPassage, point: SplitPoint): SplitPoint {
    let best: (typeof passage.wallSegments)[number] | null = null;
    let bestDistance = Infinity;
    for (const segment of passage.wallSegments) {
      const dx = segment.v1.x - segment.v0.x;
      const dy = segment.v1.y - segment.v0.y;
      const length = Math.hypot(dx, dy) || 1;
      const t = Math.max(0, Math.min(1, ((point.x - segment.v0.x) * dx + (point.y - segment.v0.y) * dy) / (length * length)));
      const projected = { x: segment.v0.x + dx * t, y: segment.v0.y + dy * t };
      const distance = Math.hypot(point.x - projected.x, point.y - projected.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = segment;
      }
    }
    return best ? { x: best.v1.x - best.v0.x, y: best.v1.y - best.v0.y } : { x: 1, y: 0 };
  }

  private drawSplitPassagesContour(settings: VectorByCorridorsSettings, passages: SplitPassage[], specialShapes: SplitSpecialShape[], cfg: FieldConfig): void {
    const { clipViewAt, drawConnectorLine, oneWayStyle, oneWayLengthPx, useSpecial, bridgeUnderlayPassages } = this.setupSplitPassageDraw(settings, passages, specialShapes);

    if (!useSpecial) return;
    // The universal contour engine draws only the round join; miter keeps plain connector lines.
    if (settings.join === "round") this.drawBridgeUnderlayContour(settings, bridgeUnderlayPassages, cfg);
    else this.drawBridgeUnderlayLines(settings, bridgeUnderlayPassages, drawConnectorLine);

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
        const cellVertices = settings.join === "round" ? this.splitCellVertices(shape.pointKey, cfg) : undefined;
        nodePassages.forEach((passage, nodeIndex) => {
          const junction = shape.dividerJunctions?.[nodeIndex];
          if (!junction) return;
          for (const segment of passage.wallSegments) {
            if (settings.join === "round") {
              const outerContourSegments = passage.wallSegments.map((other) => ({
                v0: passage.center,
                v1: other.center,
                cellVertices0: cellVertices,
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
                traceCorridorContour(this.corridors, buildCorridorContour(outerTurn, gapWidth, settings.junctionRadius));
                this.corridors.fill(settings.background);
              }
              traceCorridorContour(this.corridors, buildCorridorContour(outerContourSegments, this.contourWidth(settings), settings.junctionRadius));
              this.corridors.fill(settings.color);
              if (outerTurn.length === 2) {
                traceCorridorContour(this.corridors, buildCorridorContour(outerTurn, this.contourWidth(settings), settings.junctionRadius));
                this.corridors.fill(settings.color);
              }
              break;
            }
            // Miter join from here on: the round join drew the whole node above and broke out.
            drawConnectorLine(junction, segment.center, settings.color, segment.oneWayOut, settings.thickness, this.corridors, "butt");

            // Patch the seam between this angled split ray and the ordinary corridor continuing
            // beyond the hex face. Both strokes are butt-cut at `segment.center`; the two-ray
            // miter patch closes the resulting corner without adding anything at the split's own
            // internal convergence point.
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
        this.drawBridgeSpecialShape(settings, shape, cfg, clipViewAt, drawConnectorLine, throughDrawnForPoint);
        // Bridge geometry is shared by both render styles; this branch only selects the common
        // layer-ordering method above.
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
        const nodePassages = this.orderSpecialDiagonalPassages(
          passages.filter((p) => p.pointKey === shape.pointKey && !isThroughPassage(p)),
          shape.topNodeIndex,
        );
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
        const cellVertices = this.splitCellVertices(shape.pointKey, cfg, nodePassages.flatMap((passage) => passage.connectors.flatMap((connector) => [
          connector.from,
          connector.to,
          { x: (connector.from.x + connector.to.x) / 2, y: (connector.from.y + connector.to.y) / 2 },
        ])));

        for (const passage of nodePassages) {
          const { clipView, gapView } = clipViewAt();
          const bowFrac = shape.topNodeIndex !== undefined && passage.nodeIndex === shape.topNodeIndex
            ? Math.min(1, settings.splitDiagonalBowAmount * 0.6)
            : settings.splitDiagonalBowAmount;

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
          for (const connector of passage.connectors) {
            const mx = (connector.from.x + connector.to.x) / 2, my = (connector.from.y + connector.to.y) / 2;
            const fromFaceDir = this.faceDirectionAt(passage, connector.from);
            const toFaceDir = this.faceDirectionAt(passage, connector.to);

            // Filled ribbon instead of a stroked line (GitHub issue #314 follow-up) — a stroke's
            // own `cap`/`join` geometry couldn't be made to butt flush at `from`/`to` (a `square`
            // cap extended past the tile boundary the plain corridor stub stitches up against). A
            // filled shape has no such failure mode, and its own two short ends are cut exactly
            // along each face's own direction so they land flush against the plain corridor's own
            // segment there, unmoved by `bow`. See `drawDiagonalConnectorRibbon`'s own doc comment.
            const drawGap = settings.splitGapWidth > 0 && !sharpRibbon &&
              (shape.topNodeIndex === undefined || passage.nodeIndex === shape.topNodeIndex);
            if (drawGap) {
              const { gapFrom, gapTo, clampedGapWidth } = computeDiagonalGapPatchGeometry(connector.from, connector.to, fromFaceDir, toFaceDir, gridInset, gapWidth, cellVertices, bowFrac);
              if (clampedGapWidth > 1e-7) {
                drawDiagonalConnectorRibbon(gapView, gapFrom, gapTo, fromFaceDir, toFaceDir, clampedGapWidth, settings.background, bowFrac, sharpRibbon);
              }
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
  private drawSplitPassagesLegacy(settings: VectorByCorridorsSettings, passages: SplitPassage[], specialShapes: SplitSpecialShape[], cfg: FieldConfig): void {
    const { clipViewAt, drawConnectorLine, oneWayStyle, oneWayLengthPx, useSpecial, bridgeUnderlayPassages } = this.setupSplitPassageDraw(settings, passages, specialShapes);

    if (!useSpecial) return;

    // Legacy line mode has no filled contour pass, so keep the same ordinary-corridor width and
    // line treatment for the fork while preserving the mode's existing split rendering below.
    this.drawBridgeUnderlayLines(settings, bridgeUnderlayPassages, drawConnectorLine);

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
        this.drawBridgeSpecialShape(settings, shape, cfg, clipViewAt, drawConnectorLine, throughDrawnForPoint);
        continue;
      } else {
        if (diagonalRibbonDrawnForPoint.has(shape.pointKey)) continue;
        diagonalRibbonDrawnForPoint.add(shape.pointKey);

        const throughLine = shape.throughLine;
        const match = (p: { x: number; y: number }, q: { x: number; y: number }) => this.drawSplitPassagesThroughLineMatch(p, q);
        const isThroughPassage = (p: SplitPassage) =>
          !!throughLine && p.connectors.length === 1 &&
          ((match(p.connectors[0].from, throughLine[0]) && match(p.connectors[0].to, throughLine[1])) ||
            (match(p.connectors[0].from, throughLine[1]) && match(p.connectors[0].to, throughLine[0])));
        const nodePassages = this.orderSpecialDiagonalPassages(
          passages.filter((p) => p.pointKey === shape.pointKey && !isThroughPassage(p)),
          shape.topNodeIndex,
        );
        const sharpRibbon = settings.join === "miter";

        const gridInset = 0.5 / (this.viewport.scale || 1);
        const gapWidth = Math.min(settings.thickness + 2 * settings.splitGapWidth, TILE_SIZE - 2 * gridInset);
        const cellVertices = this.splitCellVertices(shape.pointKey, cfg, nodePassages.flatMap((passage) => passage.connectors.flatMap((connector) => [
          connector.from,
          connector.to,
          { x: (connector.from.x + connector.to.x) / 2, y: (connector.from.y + connector.to.y) / 2 },
        ])));

        for (const passage of nodePassages) {
          const { clipView, gapView } = clipViewAt();
          const bowFrac = shape.topNodeIndex !== undefined && passage.nodeIndex === shape.topNodeIndex
            ? Math.min(1, settings.splitDiagonalBowAmount * 0.6)
            : settings.splitDiagonalBowAmount;

          for (const connector of passage.connectors) {
            const mx = (connector.from.x + connector.to.x) / 2, my = (connector.from.y + connector.to.y) / 2;
            const fromFaceDir = this.faceDirectionAt(passage, connector.from);
            const toFaceDir = this.faceDirectionAt(passage, connector.to);

            const drawGap = settings.splitGapWidth > 0 && !sharpRibbon &&
              (shape.topNodeIndex === undefined || passage.nodeIndex === shape.topNodeIndex);
            if (drawGap) {
              const { gapFrom, gapTo, clampedGapWidth } = computeDiagonalGapPatchGeometry(connector.from, connector.to, fromFaceDir, toFaceDir, gridInset, gapWidth, cellVertices, bowFrac);
              if (clampedGapWidth > 1e-7) {
                drawDiagonalConnectorRibbon(gapView, gapFrom, gapTo, fromFaceDir, toFaceDir, clampedGapWidth, settings.background, bowFrac, sharpRibbon);
              }
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
    const { hoveredExportWarningKey, hoveredTeleportNodeIds } = state;
    if (!hoveredExportWarningKey) {
      if (hoveredTeleportNodeIds) {
        const { nodes } = selectFloorScopedMaze(
          state.nodes, state.edges, state.floors, state.activeFloorId, null, null,
        );
        this.warningHighlight.renderNodes(
          hoveredTeleportNodeIds, nodes, state.activeFieldConfig, state.vectorByCorridorsSettings,
          2 / (this.viewport.scale || 1),
        );
      } else {
        this.warningHighlight.render(null, [], [], state.activeFieldConfig, state.vectorByCorridorsSettings, null, null);
      }
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
      state.nodes, state.edges, state.floors, state.activeFieldConfig, state.vectorByCorridorsSettings,
      rawEndpoints.start, rawEndpoints.finish,
    );
    const oneWayBoundaryWidth = state.vectorByCorridorsSettings.oneWayWidth * state.vectorByCorridorsSettings.thickness + state.vectorByCorridorsSettings.oneWayThickness;
    this.warningHighlight.render(hoveredExportWarningKey, nodes, edges, state.activeFieldConfig, state.vectorByCorridorsSettings, start, finish, state.nodes, warnings, 2 / (this.viewport.scale || 1), oneWayBoundaryWidth, true);
  }

  destroy(): void {
    this.unsubscribe?.();
    this.backgroundGrid.destroy();
    this.corridorTiles.destroy();
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
    this.floorLabel.destroy();
    this.markerIndexGapContainer.destroy();
    this.markerIndexBodyContainer.destroy();
    this.floorLabelContainer.destroy();
    this.warningHighlight.destroy();
    this.warningHighlightContainer.destroy();
  }
}

export { buildTeleportWidenMarkers, buildVerticalWidenMarkers, computeDiagonalGapPatchGeometry } from "./vectorByCorridorsGeometry";
