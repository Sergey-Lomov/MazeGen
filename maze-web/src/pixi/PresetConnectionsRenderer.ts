import { Container, Graphics } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import { computeInvalidKeysFromCells, computeInvalidTeleportIds, computeInvalidVerticalPassageIds, computeInvalidElevatorIds, computeInvalidMarkers, computeInvalidEndpoint, computeInvalidLockedNodeKeys, computeInvalidSplitPoints, presetConnectionsOnLevel, recordOnLevel, mapOnLevel, setOnLevel } from "./fieldEditUtils";
import type { FieldEdge } from "./fieldEditUtils";
import { makeProjection } from "./tessellationProjection";
import { CellFillRenderer } from "./renderers/CellFillRenderer";
import { RegionHighlightRenderer } from "./renderers/RegionHighlightRenderer";
import { WallRenderer } from "./renderers/WallRenderer";
import { WaypointsRenderer } from "./renderers/WaypointsRenderer";
import { LockRenderer } from "./renderers/LockRenderer";
import { OriginRenderer } from "./renderers/OriginRenderer";
import { GenSourceRenderer } from "./renderers/GenSourceRenderer";
import { GridRenderer } from "./renderers/GridRenderer";
import { EdgeHighlightRenderer } from "./renderers/EdgeHighlightRenderer";
import { NodeEdgeHighlightRenderer } from "./renderers/NodeEdgeHighlightRenderer";
import { TeleportRenderer } from "./renderers/TeleportRenderer";
import { drawTeleportPreview } from "./renderers/teleportPreviewGlyph";
import { SplitJunctionRenderer, collectSplitWallPaths } from "./renderers/SplitJunctionRenderer";
import { VerticalConnectionRenderer, DEFAULT_VERTICAL_STYLE } from "./renderers/VerticalConnectionRenderer";
import { buildPresetTeleportEdges, buildPresetVerticalMarkers, buildPresetTeleportBadgeBlockedCells } from "./presetConnectionsGeometry";
import { buildTeleportAvoidanceWaypoints } from "./selectors/mazeSelectors";
import {
  buildPresetWallGroups,
  buildPresetMarkers,
  buildPresetNodePositions,
  buildLocks,
  buildIsolatedCellHighlights,
  computeOrphanSplitPoints,
  buildOrphanSplitCellHighlights,
  buildInvalidEdgeHighlights,
  buildHoverEdgeHighlight,
  buildPresetSplitPassages,
  buildLinkHoverHighlight,
  presetEndpointScreenPos,
} from "./selectors/presetSelectors";
import { presetEndpoint, withoutLevel, type PresetEndpoint } from "./presetEndpoint";
import { canvas } from "./colorTokens";
import { WALL_THICKNESS } from "./renderConstants";
import { DEFAULT_MAZE_RENDER_STYLE } from "./defaultMazeRenderStyle";
import { drawCellBoundaryHighlight, oneWayIndicatorSpan, WALL_HIGHLIGHT_SPAN } from "./renderers/wallUtils";
import { getCellHighlightInset } from "./cellHighlightGeometry";
import { BaseFieldRenderer } from "./BaseFieldRenderer";
import { BackgroundImageLayer } from "./BackgroundImageLayer";
import { activeFloorLevel, resolveFieldAtOf } from "../store/storeHelpers";
import { isPresetLockTool } from "../store/storeTypes";

type MazeState = ReturnType<typeof useMazeStore.getState>;

const ISOLATED_HL_ALPHA = 0.35;

export class PresetConnectionsRenderer extends BaseFieldRenderer {
  private readonly root: Container;

  private readonly gridContainer: Container;
  private readonly floorContainer: Container;
  private readonly backgroundImageContainer: Container;
  private readonly invalidPassagesContainer: Container;
  private readonly undecidedWallsContainer: Container;
  private readonly presetWallsContainer: Container;
  private readonly splitJunctionContainer: Container;
  private readonly teleportContainer: Container;
  private readonly verticalContainer: Container;
  private readonly locksContainer: Container;
  private readonly markersContainer: Container;
  private readonly originContainer: Container;
  private readonly invalidMarkerHLContainer: Container;
  private readonly genSourceContainer: Container;
  private readonly isolatedHLContainer: Container;
  private readonly orphanHLContainer: Container;
  private readonly invalidHLContainer: Container;
  private readonly hoverContainer: Container;
  private readonly cellHoverContainer: Container;
  private readonly splitPanelTargetContainer: Container;
  private readonly teleportPreviewContainer: Container;
  private readonly linkHoverContainer: Container;
  private readonly boundaryHover: Graphics;

  private readonly grid: GridRenderer;
  private readonly floor: CellFillRenderer;
  private readonly backgroundImage: BackgroundImageLayer;
  private readonly invalidPassages: WallRenderer;
  private readonly undecidedWalls: WallRenderer;
  private readonly presetWalls: WallRenderer;
  private readonly splitJunctions: SplitJunctionRenderer;
  private readonly teleports: TeleportRenderer;
  /** Own `VerticalConnectionRenderer` instance for preset `VerticalPassage`/`Elevator` links
   *  (GitHub issue #357) — same marker-based primitive `GenerationRenderer` uses for the resolved
   *  edges after generation, so a preset reads identically to its own generated result instead of
   *  looking like a teleport. Own instance per `maze-web/CLAUDE.md`'s feature-renderer ownership
   *  rule (never a shared instance across features/layers). */
  private readonly verticals: VerticalConnectionRenderer;
  private readonly locks: LockRenderer;
  private readonly markers: WaypointsRenderer;
  private readonly origin: OriginRenderer;
  private readonly invalidMarkerHL: CellFillRenderer;
  private readonly genSource: GenSourceRenderer;
  private readonly isolatedHL: CellFillRenderer;
  private readonly orphanHL: RegionHighlightRenderer;
  private readonly invalidHL: EdgeHighlightRenderer;
  private readonly hover: EdgeHighlightRenderer;
  private readonly cellHover: CellFillRenderer;
  private readonly splitPanelTarget: CellFillRenderer;
  private readonly teleportPreview: Graphics;
  /** Highlights the link a "Manage split nodes" panel bubble is currently hovered (GitHub issue
   *  #237) — mirrors `PostEditRenderer`'s own `linkHover`, driven by `presetHoveredLink`. Same
   *  `NodeEdgeHighlightRenderer` primitive `DebugRefHighlightOverlay` uses for its edge-ref
   *  highlight. */
  private readonly linkHover: NodeEdgeHighlightRenderer;
  private readonly entityHighlightContainer: Container;
  private readonly entityHighlight: RegionHighlightRenderer;

  constructor(container: Container) {
    super();
    this.root = container;

    this.gridContainer           = new Container();
    this.floorContainer          = new Container();
    this.backgroundImageContainer = new Container();
    this.invalidPassagesContainer = new Container();
    this.undecidedWallsContainer = new Container();
    this.presetWallsContainer    = new Container();
    this.splitJunctionContainer  = new Container();
    this.teleportContainer       = new Container();
    this.verticalContainer       = new Container();
    this.locksContainer          = new Container();
    this.markersContainer        = new Container();
    this.originContainer         = new Container();
    this.invalidMarkerHLContainer = new Container();
    this.genSourceContainer      = new Container();
    this.isolatedHLContainer     = new Container();
    this.orphanHLContainer       = new Container();
    this.invalidHLContainer      = new Container();
    this.hoverContainer          = new Container();
    this.cellHoverContainer      = new Container();
    this.splitPanelTargetContainer = new Container();
    this.teleportPreviewContainer = new Container();
    this.linkHoverContainer      = new Container();
    this.entityHighlightContainer = new Container();

    this.root.addChild(this.backgroundImageContainer);
    this.root.addChild(this.gridContainer);
    this.root.addChild(this.floorContainer);
    this.root.addChild(this.invalidPassagesContainer);
    this.root.addChild(this.undecidedWallsContainer);
    this.root.addChild(this.presetWallsContainer);
    this.root.addChild(this.locksContainer);
    this.root.addChild(this.splitJunctionContainer);
    this.root.addChild(this.teleportContainer);
    this.root.addChild(this.verticalContainer);
    this.root.addChild(this.markersContainer);
    this.root.addChild(this.originContainer);
    this.root.addChild(this.invalidMarkerHLContainer);
    this.root.addChild(this.genSourceContainer);
    this.root.addChild(this.isolatedHLContainer);
    this.root.addChild(this.orphanHLContainer);
    this.root.addChild(this.invalidHLContainer);
    this.root.addChild(this.hoverContainer);
    this.root.addChild(this.cellHoverContainer);
    this.root.addChild(this.splitPanelTargetContainer);
    this.root.addChild(this.teleportPreviewContainer);
    this.root.addChild(this.linkHoverContainer);
    this.root.addChild(this.entityHighlightContainer);

    this.grid           = new GridRenderer(this.gridContainer);
    this.floor          = new CellFillRenderer(this.floorContainer);
    this.backgroundImage = new BackgroundImageLayer(
      this.backgroundImageContainer,
      this.floorContainer,
      this.gridContainer,
      this.invalidPassagesContainer,
    );
    this.invalidPassages = new WallRenderer(this.invalidPassagesContainer);
    this.undecidedWalls = new WallRenderer(this.undecidedWallsContainer);
    this.presetWalls    = new WallRenderer(this.presetWallsContainer);
    this.splitJunctions = new SplitJunctionRenderer(this.splitJunctionContainer);
    this.teleports      = new TeleportRenderer(this.teleportContainer);
    this.verticals      = new VerticalConnectionRenderer(this.verticalContainer);
    this.locks          = new LockRenderer(this.locksContainer);
    this.markers        = new WaypointsRenderer(this.markersContainer);
    this.origin         = new OriginRenderer(this.originContainer);
    this.invalidMarkerHL = new CellFillRenderer(this.invalidMarkerHLContainer);
    this.genSource      = new GenSourceRenderer(this.genSourceContainer);
    this.isolatedHL     = new CellFillRenderer(this.isolatedHLContainer);
    this.orphanHL       = new RegionHighlightRenderer(this.orphanHLContainer);
    this.invalidHL      = new EdgeHighlightRenderer(this.invalidHLContainer);
    this.hover          = new EdgeHighlightRenderer(this.hoverContainer);
    this.cellHover      = new CellFillRenderer(this.cellHoverContainer);
    this.splitPanelTarget = new CellFillRenderer(this.splitPanelTargetContainer);
    this.teleportPreview = new Graphics();
    this.teleportPreviewContainer.addChild(this.teleportPreview);
    this.linkHover      = new NodeEdgeHighlightRenderer(this.linkHoverContainer);
    this.boundaryHover = new Graphics();
    this.linkHoverContainer.addChild(this.boundaryHover);
    this.entityHighlight = new RegionHighlightRenderer(this.entityHighlightContainer);

    this.root.visible = false;

    this.subscribeToStore();
  }

  protected isCardOpen(state: MazeState): boolean {
    return state.openCard === "preset_connections";
  }

  protected getActiveConfig(state: MazeState) {
    return state.floorFields[state.activeFloorId].tessellationConfig;
  }

  protected setRootVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  onViewportChanged(x: number, y: number, w: number, h: number, scale: number): void {
    this.updateViewport(x, y, w, h, scale);
    if (this.root.visible && this.cfg) {
      const state = useMazeStore.getState();
      const level = activeFloorLevel(state);
      this.grid.render({ viewport: this.viewport }, this.cfg);
      this.redrawOrigin(state.showPresetOrigin);
      this.redrawGenSource(
        (state.presetGenSource && (state.presetGenSource.level ?? 0) === (level ?? 0)) ? state.presetGenSource : null,
        level,
      );
    }
  }

  /** `danger` (mirrors PostEditRenderer's own `updateHover`, GitHub issue #327) swaps the
   * highlight to `canvas.fieldEditor.danger` (red) instead of the ordinary hover color — signals
   * a destructive tool the same way the Control section's red buttons do; used by the `clear`
   * tool (GitHub issue #340). */
  updateHover(edge: FieldEdge | null, danger = false): void {
    if (!this.cfg) return;
    const highlights = buildHoverEdgeHighlight(edge, this.cfg, danger ? canvas.fieldEditor.danger : undefined);
    this.hover.render({ highlights });
  }

  /** Highlights a single cell (not a wall/edge) — used while the `manage_split_nodes` tool is
   * active, since that tool targets a whole point rather than one of its faces (mirrors
   * PostEditRenderer's `updateCellHover` — GitHub issue #231). `danger` — see `updateHover`'s doc
   * comment. */
  updateCellHover(cell: [number, number] | null, danger = false): void {
    if (!this.cfg) return;
    this.cellHover.render({ cells: cell ? [cell] : [], color: danger ? canvas.fieldEditor.danger : canvas.fieldEditor.hover, alpha: 0.35 }, this.cfg);
  }

  /** Renders the pending teleport's fixed endpoint marker + a connector line to the cursor, so the
   * two-click placement gesture reads as "one end is already fixed, aim the other". Shared look with
   * post-edit via `drawTeleportPreview`. */
  updateTeleportPreview(pendingFrom: [number, number] | null, cursorViewportX: number, cursorViewportY: number): void {
    this.teleportPreview.clear();
    if (!this.cfg || !pendingFrom) return;

    const proj = makeProjection(this.cfg);
    const { x: px, y: py } = proj.gridToScreen(pendingFrom[0], pendingFrom[1]);
    drawTeleportPreview(this.teleportPreview, px, py, cursorViewportX, cursorViewportY);
  }

  protected onStoreChange(state: MazeState, prev: MazeState): void {
    const field = state.floorFields[state.activeFloorId];
    const prevField = prev.floorFields[prev.activeFloorId];
    const fieldChanged = field.fieldPoints !== prevField.fieldPoints || field.fieldEditMode !== prevField.fieldEditMode;
    if (fieldChanged) {
      this.rebuildCellCache(state);
    }

    if (
      state.showBackgroundImage !== prev.showBackgroundImage ||
      state.backgroundImage !== prev.backgroundImage ||
      state.backgroundImageManualPositioning !== prev.backgroundImageManualPositioning ||
      fieldChanged ||
      state.activeFloorId !== prev.activeFloorId ||
      state.presetConnections !== prev.presetConnections ||
      state.presetStart !== prev.presetStart ||
      state.presetFinish !== prev.presetFinish ||
      state.presetGenSource !== prev.presetGenSource ||
      state.lockedNodes !== prev.lockedNodes ||
      state.autoLockedNodes !== prev.autoLockedNodes ||
      state.showPresetLocks !== prev.showPresetLocks ||
      state.presetTeleports !== prev.presetTeleports ||
      state.presetVerticalPassages !== prev.presetVerticalPassages ||
      state.presetElevators !== prev.presetElevators ||
      state.presetSplitPoints !== prev.presetSplitPoints ||
      state.presetActiveSplitNode !== prev.presetActiveSplitNode ||
      state.presetFocusedPoint !== prev.presetFocusedPoint ||
      state.presetConnectionsTool !== prev.presetConnectionsTool ||
      state.presetDragOverride !== prev.presetDragOverride
    ) {
      this.redrawAll(state);
      return;
    }

    if (state.showPresetOrigin !== prev.showPresetOrigin) {
      this.redrawOrigin(state.showPresetOrigin);
    }

    if (state.highlightInvalidPresets !== prev.highlightInvalidPresets) {
      this.redrawInvalidHL(state);
    }

    if (state.highlightIsolatedNodes !== prev.highlightIsolatedNodes) {
      this.redrawIsolatedHL(state);
    }

    if (state.highlightOrphanSplitNodes !== prev.highlightOrphanSplitNodes) {
      this.redrawOrphanHL(state);
    }

    if (state.presetHoveredLink !== prev.presetHoveredLink) {
      this.redrawLinkHover(state);
    }
    if (state.presetHoveredEntity !== prev.presetHoveredEntity || state.presetHoveredEntityMode !== prev.presetHoveredEntityMode) this.redrawEntityHighlight(state);

    if (
      state.presetConnectionsTool !== prev.presetConnectionsTool
      || state.presetTeleportPendingFrom !== prev.presetTeleportPendingFrom
    ) {
      if (!state.presetTeleportPendingFrom) this.teleportPreview.clear();
      // Leaving manage_split_nodes (or switching to it) invalidates whatever cell-hover state
      // was left over from the other tool's own hover handling — the controller recomputes it
      // on the next pointer move, but a stale highlight shouldn't linger until then.
      if (state.presetConnectionsTool !== prev.presetConnectionsTool) this.updateCellHover(null);
    }
  }

  protected redrawAll(state: MazeState): void {
    if (!this.cfg) return;
    const cfg = this.cfg;
    const cells = this.cachedCells;
    const level = activeFloorLevel(state);
    const presetConnections = presetConnectionsOnLevel(state.presetConnections, level);
    const presetSplitPoints = recordOnLevel(state.presetSplitPoints, level);
    const presetActiveSplitNode = recordOnLevel(state.presetActiveSplitNode, level);
    const lockedNodes = mapOnLevel(state.lockedNodes, level);
    const autoLockedNodes = setOnLevel(state.autoLockedNodes, level);
    const presetTeleports = state.presetTeleports.filter((t) => (t.from.level ?? 0) === (level ?? 0) || (t.to.level ?? 0) === (level ?? 0));
    // Live drag override (GitHub issue #566) — while a vertical-passage/elevator endpoint drag is
    // live, nothing is committed to `state.presetVerticalPassages`/`presetElevators` yet (see
    // `presetDragOverride`'s own doc comment), so the dragged marker's on-screen position is
    // substituted here rather than read from the committed entry.
    const override = state.presetDragOverride;
    const presetVerticalPassages = state.presetVerticalPassages
      .filter((p) => (p.from.level ?? 0) === (level ?? 0) || (p.to.level ?? 0) === (level ?? 0))
      .map((p) => {
        if (override?.kind !== "verticalPassageEndpoint" || override.id !== p.id) return p;
        return { ...p, [override.end]: presetEndpoint(override.point, undefined, p[override.end].level) };
      });
    const presetElevators = state.presetElevators
      .filter((e) => e.floors.some((f) => (f.level ?? 0) === (level ?? 0)))
      .map((e) => {
        if (override?.kind !== "elevatorEndpoint" || override.id !== e.id) return e;
        return { ...e, floors: e.floors.map((f) => ((f.level ?? 0) === override.level ? presetEndpoint(override.point, undefined, f.level) : f)) };
      });
    // Markers must resolve against a level-less endpoint (GitHub issue #589) — see `withoutLevel`.
    // Live marker-drag override (GitHub issue #613) — while a start/finish marker drag is live,
    // nothing is committed to `presetStart`/`presetFinish` yet (see `presetDragOverride`'s own doc
    // comment), so the dragged marker's on-screen position is substituted here.
    const presetStart = override?.kind === "marker" && override.marker === "start"
      ? withoutLevel(presetEndpoint(override.point))
      : (state.presetStart && (state.presetStart.level ?? 0) === (level ?? 0))
        ? withoutLevel(state.presetStart) : null;
    const presetFinish = override?.kind === "marker" && override.marker === "finish"
      ? withoutLevel(presetEndpoint(override.point))
      : (state.presetFinish && (state.presetFinish.level ?? 0) === (level ?? 0))
        ? withoutLevel(state.presetFinish) : null;
    const presetGenSource = (state.presetGenSource && (state.presetGenSource.level ?? 0) === (level ?? 0)) ? state.presetGenSource : null;

    this.grid.render({ viewport: this.viewport }, cfg);
    this.floor.render({ cells, color: canvas.floor.default, alpha: 1 }, cfg);
    this.backgroundImage.render(state.backgroundImage, state.showBackgroundImage, state.backgroundImageManualPositioning);

    const { undecided, preset, invalidPassages } = buildPresetWallGroups(cells, presetConnections, cfg, presetSplitPoints);
    this.invalidPassages.render({ edges: invalidPassages }, cfg);
    this.undecidedWalls.render({ edges: undecided }, cfg);

    const { passages: splitPassages, wallFaces, specialShapes } = buildPresetSplitPassages(presetSplitPoints, presetConnections, cfg, presetActiveSplitNode, cells);
    const { paths: extraWalls, noCapPoints } = collectSplitWallPaths(wallFaces, specialShapes);
    this.presetWalls.render({ edges: preset }, cfg, undefined, undefined, extraWalls, noCapPoints);

    this.splitJunctions.render({ passages: splitPassages, wallFaces, specialShapes });

    // One node-anchor map per redraw, shared by split markers and locks.
    const nodePositions = buildPresetNodePositions(cfg, presetSplitPoints, presetConnections);
    const forceShowLocks = isPresetLockTool(state.presetConnectionsTool);
    const lockEntries = state.showPresetLocks || forceShowLocks
      ? buildLocks(lockedNodes, autoLockedNodes, nodePositions, presetSplitPoints)
      : [];
    this.locks.render({ locks: lockEntries }, cfg);

    const markerData = buildPresetMarkers(presetStart, presetFinish, cfg, presetSplitPoints, presetConnections, nodePositions);
    this.markers.render({ markers: markerData });

    // Cross-floor teleport badge collision relocation (GitHub issue #480) — the same shared core the
    // generation/post-edit views use, fed the *maze-wide* (not active-floor-filtered) preset lists so
    // the relocation is floor-independent and a pair's two badges stay together across a floor switch.
    // Skipped entirely when no teleport actually spans two floors.
    const hasCrossFloorTeleport = state.presetTeleports.some((t) => (t.from.level ?? 0) !== (t.to.level ?? 0));
    let teleportSpread: Parameters<typeof buildPresetTeleportEdges>[4] | undefined;
    if (hasCrossFloorTeleport) {
      const splitPointsByLevel = new Map<number, [number, number][]>();
      for (const key of Object.keys(state.presetSplitPoints)) {
        const at = key.indexOf("@");
        const lvl = at === -1 ? 0 : Number(key.slice(at + 1));
        const [x, y] = (at === -1 ? key : key.slice(0, at)).split(",").map(Number);
        const list = splitPointsByLevel.get(lvl) ?? [];
        list.push([x, y]);
        splitPointsByLevel.set(lvl, list);
      }
      teleportSpread = {
        allTeleports: state.presetTeleports,
        blockedCellsByFloor: buildPresetTeleportBadgeBlockedCells(
          state.presetStart ?? null,
          state.presetFinish ?? null,
          splitPointsByLevel,
          state.presetVerticalPassages,
          state.presetElevators,
          state.presetTeleports,
        ),
        allowOutOfField: true,
      };
    }
    const presetVerticalMarkers = buildPresetVerticalMarkers(presetVerticalPassages, presetElevators, cfg, level, nodePositions);
    // Keep orthogonal teleport connectors from cutting through start/finish markers (GitHub issue
    // #300), same as the image-export renderers — regressed on this canvas (GitHub issue #516).
    // Also avoid vertical passage/elevator markers (GitHub issue #518) — preset connections have no
    // one-way wall indicator concept, unlike a generated maze's own walls.
    this.teleports.render({
      edges: buildPresetTeleportEdges(presetTeleports, cfg, level, nodePositions, teleportSpread),
      cfg,
      floorNavigable: state.presetConnectionsTool !== "clear",
      waypoints: buildTeleportAvoidanceWaypoints({
        markers: markerData,
        verticalMarkers: presetVerticalMarkers,
        splitPassages,
      }),
    });
    // Click-to-switch-floor (GitHub issue #341 follow-up): withheld while the clear tool is
    // active (its own click means "delete this connection", not "navigate") and, for a one-way
    // passage marker specifically (`filled === false`), while the one-way passage tool is active
    // too (that tool's own click on the marker cycles its direction instead).
    this.verticals.render({
      markers: presetVerticalMarkers,
      style: DEFAULT_VERTICAL_STYLE,
      interactive: (marker) =>
        state.presetConnectionsTool !== "clear" &&
        !(marker.filled === false && state.presetConnectionsTool === "vertical_passage_one_way"),
    });

    this.redrawOrigin(state.showPresetOrigin);
    this.redrawGenSource(presetGenSource, level, nodePositions);
    this.redrawIsolatedHL(state);
    this.redrawOrphanHL(state);

    this.redrawInvalidHL(state);
    this.splitPanelTarget.render({
      cells: state.presetFocusedPoint ? [state.presetFocusedPoint] : [],
      color: canvas.fieldEditor.panelTarget,
      alpha: 0,
      inset: 0,
      borderWidth: 3,
    }, cfg);

    this.hover.render({ highlights: [] });
    this.redrawLinkHover(state);
    this.redrawEntityHighlight(state);
  }

  private redrawEntityHighlight(state: MazeState): void {
    if (!this.cfg) return;
    const activeLevel = activeFloorLevel(state) ?? 0;
    this.entityHighlight.render({
      // Match post-edit's point-bubble highlight: only the cells on the active floor are drawn.
      // Preset endpoints are intentionally kept as endpoints in the store because their level is
      // needed when a multi-floor bubble is hovered.
      nodes: [], regionGroups: [],
      cells: (state.presetHoveredEntity ?? [])
        .filter((endpoint) => (endpoint.level ?? 0) === activeLevel)
        .map((endpoint) => endpoint.point),
      color: canvas.fieldEditor.hover, width: WALL_THICKNESS * 2, alpha: 1, cfg: this.cfg, skipPerimeter: true,
      insetMode: state.presetHoveredEntityMode,
    });
  }

  private redrawLinkHover(state: MazeState): void {
    if (!this.cfg) return;
    const link = state.presetHoveredLink;
    this.boundaryHover.clear();
    if (!link || !link.highlightStyle || link.highlightStyle === "line") {
      this.linkHover.render(buildLinkHoverHighlight(link, this.cfg));
      return;
    }
    this.linkHover.render([]);
    const color = link.highlightStyle === "one_way" ? canvas.debug.refHighlight : canvas.fieldEditor.hover;
    const span = link.highlightStyle === "one_way"
      ? oneWayIndicatorSpan(DEFAULT_MAZE_RENDER_STYLE.oneWay)
      : WALL_HIGHLIGHT_SPAN;
    drawCellBoundaryHighlight(
      this.boundaryHover,
      link.from.point,
      link.to.point,
      this.cfg,
      color,
      0.25,
      WALL_THICKNESS,
      span,
      getCellHighlightInset(),
    );
  }

  private redrawOrigin(show: boolean): void {
    if (!this.cfg) return;
    this.origin.render({ show }, this.cfg);
  }

  /** `nodePositions` resolves a source placed on a split-point node to that node's shape-aware
   *  anchor (GitHub issue #494), the same map/​resolver every start/finish marker uses; pass the
   *  shared map on a full redraw, omit it on a viewport-only redraw and one is built here (cheap —
   *  same as every marker/edge selector). `endpoint` is already level-filtered by the caller. */
  private redrawGenSource(
    endpoint: PresetEndpoint | null,
    level: number | undefined,
    nodePositions?: Map<string, { x: number; y: number }>,
  ): void {
    if (!this.cfg) return;
    if (!endpoint) {
      this.genSource.render({ sourceScreen: null });
      return;
    }
    const state = useMazeStore.getState();
    const positions = nodePositions ?? buildPresetNodePositions(
      this.cfg,
      recordOnLevel(state.presetSplitPoints, level),
      presetConnectionsOnLevel(state.presetConnections, level),
    );
    // `buildPresetNodePositions` keys split-point nodes without a `level` suffix, so match markers:
    // resolve against a level-less copy of the endpoint (it's already known to be on this floor).
    const [x, y] = presetEndpointScreenPos(withoutLevel(endpoint), this.cfg, positions);
    this.genSource.render({ sourceScreen: { x, y } });
  }

  private redrawIsolatedHL(state: MazeState): void {
    if (!this.cfg) return;
    if (!state.highlightIsolatedNodes) {
      this.isolatedHL.render({ cells: [], color: canvas.preset.invalid, alpha: ISOLATED_HL_ALPHA, inset: getCellHighlightInset() }, this.cfg);
      return;
    }
    const level = activeFloorLevel(state);
    const cells = buildIsolatedCellHighlights(
      mapOnLevel(state.lockedNodes, level),
      setOnLevel(state.autoLockedNodes, level),
      presetConnectionsOnLevel(state.presetConnections, level),
    );
    this.isolatedHL.render({ cells, color: canvas.preset.invalid, alpha: ISOLATED_HL_ALPHA, inset: getCellHighlightInset() }, this.cfg);
  }

  private redrawOrphanHL(state: MazeState): void {
    if (!this.cfg) return;
    if (!state.highlightOrphanSplitNodes) {
      this.orphanHL.render({ nodes: [], regionGroups: [], color: canvas.preset.invalid, width: 0, alpha: 0, cfg: this.cfg, skipPerimeter: true, insetMode: "outset" });
      return;
    }
    const level = activeFloorLevel(state);
    const orphanPoints = computeOrphanSplitPoints(
      state.presetSplitPoints, state.presetConnections, state.presetTeleports, state.presetStart, state.presetFinish, state.presetGenSource,
    );
    const cells = buildOrphanSplitCellHighlights(orphanPoints, level);
    const nodes = cells.map(([x, y], id) => ({ id, x, y, i: id }));
    this.orphanHL.render({
      nodes,
      regionGroups: nodes.length > 0 ? [nodes.map((node) => node.id)] : [],
      color: canvas.preset.invalid,
      width: 0,
      alpha: ISOLATED_HL_ALPHA,
      cfg: this.cfg,
      skipPerimeter: true,
      insetMode: "outset",
    });
  }

  private redrawInvalidHL(state: MazeState): void {
    if (!this.cfg) return;
    if (!state.highlightInvalidPresets) {
      this.invalidHL.render({ highlights: [] });
      this.invalidMarkerHL.render({ cells: [], color: canvas.preset.invalid, alpha: ISOLATED_HL_ALPHA, inset: getCellHighlightInset() }, this.cfg);
      return;
    }
    const presetConnections = presetConnectionsOnLevel(state.presetConnections, activeFloorLevel(state));
    const invalidKeys = computeInvalidKeysFromCells(presetConnections, this.cachedCells, activeFloorLevel(state));
    const edgeHighlights = buildInvalidEdgeHighlights(invalidKeys, presetConnections, this.cfg);
    this.invalidHL.render({ highlights: edgeHighlights });
    this.redrawInvalidTeleportHL(state);
  }

  private redrawInvalidTeleportHL(state: MazeState): void {
    if (!this.cfg) return;
    if (!state.highlightInvalidPresets) return;

    const level = activeFloorLevel(state);
    const resolveFieldAt = resolveFieldAtOf(state);
    const invalidPointCells: [number, number][] = [];

    const presetTeleports = state.presetTeleports.filter((t) => (t.from.level ?? 0) === (level ?? 0) || (t.to.level ?? 0) === (level ?? 0));
    const invalidIds = computeInvalidTeleportIds(presetTeleports, resolveFieldAt);
    for (const t of presetTeleports) {
      if (!invalidIds.has(t.id)) continue;
      // Only highlight whichever endpoint is actually on this floor — the other end (a
      // cross-floor teleport, GitHub issue #357/#340) isn't drawn as a real point on this image at
      // all, so its own raw (x, y) would land on the wrong cell if highlighted unconditionally.
      for (const ep of [t.from, t.to]) {
        if ((ep.level ?? 0) !== (level ?? 0)) continue;
        invalidPointCells.push(ep.point);
      }
    }

    // Invalid preset vertical passages/elevators (GitHub issue #357) — only the active floor's own
    // endpoint of each invalid entry is drawn (the other end, on a different floor, isn't visible
    // from here), same "highlight what's actually on screen" rule the teleport pass above follows.
    const presetVerticalPassages = state.presetVerticalPassages.filter((p) => (p.from.level ?? 0) === (level ?? 0) || (p.to.level ?? 0) === (level ?? 0));
    const invalidVerticalPassageIds = computeInvalidVerticalPassageIds(presetVerticalPassages, resolveFieldAt);
    for (const p of presetVerticalPassages) {
      if (!invalidVerticalPassageIds.has(p.id)) continue;
      const own = (p.from.level ?? 0) === (level ?? 0) ? p.from : p.to;
      invalidPointCells.push(own.point);
    }

    const presetElevators = state.presetElevators.filter((e) => e.floors.some((f) => (f.level ?? 0) === (level ?? 0)));
    const invalidElevatorIds = computeInvalidElevatorIds(presetElevators, resolveFieldAt);
    for (const e of presetElevators) {
      if (!invalidElevatorIds.has(e.id)) continue;
      const ownEndpoint = e.floors.find((f) => (f.level ?? 0) === (level ?? 0));
      if (!ownEndpoint) continue;
      invalidPointCells.push(ownEndpoint.point);
    }

    const presetStart = (state.presetStart && (state.presetStart.level ?? 0) === (level ?? 0)) ? state.presetStart : null;
    const presetFinish = (state.presetFinish && (state.presetFinish.level ?? 0) === (level ?? 0)) ? state.presetFinish : null;
    const presetGenSource = (state.presetGenSource && (state.presetGenSource.level ?? 0) === (level ?? 0)) ? state.presetGenSource : null;
    const invalidMarkers = computeInvalidMarkers(presetStart, presetFinish, resolveFieldAt);
    const invalidGenSource = computeInvalidEndpoint(presetGenSource, resolveFieldAt);
    const invalidLockedKeys = computeInvalidLockedNodeKeys(state.lockedNodes, resolveFieldAt);
    const invalidSplitKeys = computeInvalidSplitPoints(state.presetSplitPoints, resolveFieldAt);
    const invalidLockedCells: [number, number][] = [];
    for (const key of invalidLockedKeys) {
      const [pointPart, levelPart] = key.split("@");
      if (Number(levelPart ?? 0) !== (level ?? 0)) continue;
      const [x, y] = pointPart.split(",").map(Number);
      invalidLockedCells.push([x, y]);
    }
    const invalidSplitCells: [number, number][] = [];
    for (const key of invalidSplitKeys) {
      const [pointPart, levelPart] = key.split("@");
      if (Number(levelPart ?? 0) !== (level ?? 0)) continue;
      const [x, y] = pointPart.split(",").map(Number);
      invalidSplitCells.push([x, y]);
    }
    for (const [invalid, endpoint] of [[invalidMarkers.start, presetStart], [invalidMarkers.finish, presetFinish]] as const) {
      if (!invalid || !endpoint) continue;
      invalidPointCells.push(endpoint.point);
    }
    this.invalidMarkerHL.render({
      cells: [
        ...invalidPointCells,
        ...(invalidGenSource && presetGenSource ? [presetGenSource.point] : []),
        ...invalidLockedCells,
        ...invalidSplitCells,
      ],
      color: canvas.preset.invalid,
      alpha: ISOLATED_HL_ALPHA,
      inset: getCellHighlightInset(),
    }, this.cfg);
  }

  protected clearAll(): void {
    if (!this.cfg) return;
    const cfg = this.cfg;
    this.grid.render({ viewport: { x: 0, y: 0, w: 0, h: 0, scale: 1 } }, cfg);
    this.floor.render({ cells: [], color: canvas.floor.default, alpha: 1 }, cfg);
    this.invalidPassages.render({ edges: [] }, cfg);
    this.undecidedWalls.render({ edges: [] }, cfg);
    this.presetWalls.render({ edges: [] }, cfg);
    this.splitJunctions.render({ passages: [], wallFaces: [] });
    this.locks.render({ locks: [] }, cfg);
    this.markers.render({ markers: [] });
    this.teleports.render({ edges: [], cfg, waypoints: [] });
    this.verticals.render({ markers: [], style: DEFAULT_VERTICAL_STYLE });
    this.origin.render({ show: false }, cfg);
    this.genSource.render({ sourceScreen: null });
    this.isolatedHL.render({ cells: [], color: canvas.preset.invalid, alpha: ISOLATED_HL_ALPHA }, cfg);
    this.invalidMarkerHL.render({ cells: [], color: canvas.preset.invalid, alpha: ISOLATED_HL_ALPHA }, cfg);
    this.invalidHL.render({ highlights: [] });
    this.hover.render({ highlights: [] });
    this.cellHover.render({ cells: [], color: canvas.fieldEditor.hover, alpha: 0.35 }, cfg);
    this.splitPanelTarget.render({ cells: [], color: canvas.fieldEditor.panelTarget, alpha: 0, inset: 0, borderWidth: 3 }, cfg);
    this.linkHover.clear();
    this.boundaryHover.clear();
    this.entityHighlight.clear();
    this.teleportPreview.clear();
  }

  protected destroyChildren(): void {
    this.grid.destroy();
    this.backgroundImage.destroy();
    this.floor.destroy();
    this.invalidPassages.destroy();
    this.undecidedWalls.destroy();
    this.presetWalls.destroy();
    this.splitJunctions.destroy();
    this.teleports.destroy();
    this.verticals.destroy();
    this.locks.destroy();
    this.markers.destroy();
    this.origin.destroy();
    this.genSource.destroy();
    this.isolatedHL.destroy();
    this.invalidMarkerHL.destroy();
    this.invalidHL.destroy();
    this.hover.destroy();
    this.cellHover.destroy();
    this.splitPanelTarget.destroy();
    this.linkHover.destroy();
    this.boundaryHover.destroy();
    this.entityHighlight.destroy();
    this.teleportPreview.destroy();
    this.gridContainer.destroy();
    this.backgroundImageContainer.destroy();
    this.floorContainer.destroy();
    this.invalidPassagesContainer.destroy();
    this.undecidedWallsContainer.destroy();
    this.presetWallsContainer.destroy();
    this.splitJunctionContainer.destroy();
    this.teleportContainer.destroy();
    this.verticalContainer.destroy();
    this.locksContainer.destroy();
    this.markersContainer.destroy();
    this.originContainer.destroy();
    this.invalidMarkerHLContainer.destroy();
    this.genSourceContainer.destroy();
    this.isolatedHLContainer.destroy();
    this.orphanHLContainer.destroy();
    this.invalidHLContainer.destroy();
    this.hoverContainer.destroy();
    this.cellHoverContainer.destroy();
    this.splitPanelTargetContainer.destroy();
    this.teleportPreviewContainer.destroy();
    this.linkHoverContainer.destroy();
    this.entityHighlightContainer.destroy();
  }
}

export { buildPresetTeleportEdges, buildPresetVerticalMarkers, buildPresetTeleportBadgeBlockedCells } from "./presetConnectionsGeometry";
