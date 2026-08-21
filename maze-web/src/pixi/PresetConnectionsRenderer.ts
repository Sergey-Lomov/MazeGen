import { Container, Graphics } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import { computeInvalidKeysFromCells, computeInvalidTeleportIds, computeInvalidVerticalPassageIds, computeInvalidElevatorIds, computeInvalidMarkers, presetConnectionsOnLevel, recordOnLevel, mapOnLevel, setOnLevel } from "./fieldEditUtils";
import type { FieldEdge } from "./fieldEditUtils";
import { makeProjection } from "./tessellationProjection";
import { CellFillRenderer } from "./renderers/CellFillRenderer";
import { WallRenderer } from "./renderers/WallRenderer";
import { WaypointsRenderer } from "./renderers/WaypointsRenderer";
import { LockRenderer } from "./renderers/LockRenderer";
import { OriginRenderer } from "./renderers/OriginRenderer";
import { GenSourceRenderer } from "./renderers/GenSourceRenderer";
import { GridRenderer } from "./renderers/GridRenderer";
import { EdgeHighlightRenderer } from "./renderers/EdgeHighlightRenderer";
import { NodeEdgeHighlightRenderer } from "./renderers/NodeEdgeHighlightRenderer";
import { TeleportRenderer, clipDistance } from "./renderers/TeleportRenderer";
import { SplitJunctionRenderer } from "./renderers/SplitJunctionRenderer";
import { VerticalConnectionRenderer, type VerticalConnectionStyle } from "./renderers/VerticalConnectionRenderer";
import { buildPresetTeleportEdges, buildPresetVerticalMarkers } from "./presetConnectionsGeometry";
import {
  buildPresetWallGroups,
  buildPresetMarkers,
  buildLocks,
  buildIsolatedCellHighlights,
  computeOrphanSplitPoints,
  buildOrphanSplitCellHighlights,
  buildInvalidEdgeHighlights,
  buildHoverEdgeHighlight,
  buildPresetSplitPassages,
  buildLinkHoverHighlight,
} from "./selectors/presetSelectors";
import { NODE_RADIUS } from "./renderConstants";
import { canvas } from "./colorTokens";
import { BaseFieldRenderer } from "./BaseFieldRenderer";
import { activeFloorLevel, resolveFieldAtOf } from "../store/storeHelpers";

type MazeState = ReturnType<typeof useMazeStore.getState>;

const ISOLATED_HL_ALPHA = 0.35;

/** Same fixed look `GenerationRenderer`'s own `DEFAULT_VERTICAL_STYLE` uses for resolved
 *  `VerticalPassage`/`Elevator` edges — presets must read identically to how the same connection
 *  looks after generation, not like a teleport (GitHub issue #357 follow-up: the preset stage
 *  originally reused `TeleportRenderer`'s diamond/badge look, which read as a plain teleport). */
const DEFAULT_VERTICAL_STYLE: VerticalConnectionStyle = {
  displayStyle: "marker",
  verticalPassageMarker: {
    shape: "circle",
    cornerStyle: "round",
    fillColor: canvas.vertical.default,
    borderColor: canvas.vertical.default,
    borderWidth: 2,
    gapWidth: 3,
    gapColor: canvas.floor.default,
    size: 0.22,
  },
  elevatorMarker: {
    shape: "diamond",
    cornerStyle: "round",
    fillColor: canvas.vertical.default,
    borderColor: canvas.vertical.default,
    borderWidth: 2,
    gapWidth: 3,
    gapColor: canvas.floor.default,
    size: 0.22,
  },
  arrowColor: canvas.vertical.default,
};

export class PresetConnectionsRenderer extends BaseFieldRenderer {
  private readonly root: Container;

  private readonly gridContainer: Container;
  private readonly floorContainer: Container;
  private readonly invalidPassagesContainer: Container;
  private readonly undecidedWallsContainer: Container;
  private readonly presetWallsContainer: Container;
  private readonly splitJunctionContainer: Container;
  private readonly teleportContainer: Container;
  private readonly verticalContainer: Container;
  private readonly locksContainer: Container;
  private readonly markersContainer: Container;
  private readonly originContainer: Container;
  private readonly genSourceContainer: Container;
  private readonly isolatedHLContainer: Container;
  private readonly orphanHLContainer: Container;
  private readonly invalidHLContainer: Container;
  private readonly invalidTeleportHLContainer: Container;
  private readonly hoverContainer: Container;
  private readonly cellHoverContainer: Container;
  private readonly teleportPreviewContainer: Container;
  private readonly linkHoverContainer: Container;

  private readonly grid: GridRenderer;
  private readonly floor: CellFillRenderer;
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
  private readonly genSource: GenSourceRenderer;
  private readonly isolatedHL: CellFillRenderer;
  private readonly orphanHL: CellFillRenderer;
  private readonly invalidHL: EdgeHighlightRenderer;
  private readonly invalidTeleportHL: Graphics;
  private readonly hover: EdgeHighlightRenderer;
  private readonly cellHover: CellFillRenderer;
  private readonly teleportPreview: Graphics;
  /** Highlights the link a "Manage split nodes" panel bubble is currently hovered (GitHub issue
   *  #237) — mirrors `PostEditRenderer`'s own `linkHover`, driven by `presetHoveredLink`. Same
   *  `NodeEdgeHighlightRenderer` primitive `DebugRefHighlightOverlay` uses for its edge-ref
   *  highlight. */
  private readonly linkHover: NodeEdgeHighlightRenderer;

  constructor(container: Container) {
    super();
    this.root = container;

    this.gridContainer           = new Container();
    this.floorContainer          = new Container();
    this.invalidPassagesContainer = new Container();
    this.undecidedWallsContainer = new Container();
    this.presetWallsContainer    = new Container();
    this.splitJunctionContainer  = new Container();
    this.teleportContainer       = new Container();
    this.verticalContainer       = new Container();
    this.locksContainer          = new Container();
    this.markersContainer        = new Container();
    this.originContainer         = new Container();
    this.genSourceContainer      = new Container();
    this.isolatedHLContainer     = new Container();
    this.orphanHLContainer       = new Container();
    this.invalidHLContainer      = new Container();
    this.invalidTeleportHLContainer = new Container();
    this.hoverContainer          = new Container();
    this.cellHoverContainer      = new Container();
    this.teleportPreviewContainer = new Container();
    this.linkHoverContainer      = new Container();

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
    this.root.addChild(this.genSourceContainer);
    this.root.addChild(this.isolatedHLContainer);
    this.root.addChild(this.orphanHLContainer);
    this.root.addChild(this.invalidHLContainer);
    this.root.addChild(this.invalidTeleportHLContainer);
    this.root.addChild(this.hoverContainer);
    this.root.addChild(this.cellHoverContainer);
    this.root.addChild(this.teleportPreviewContainer);
    this.root.addChild(this.linkHoverContainer);

    this.grid           = new GridRenderer(this.gridContainer);
    this.floor          = new CellFillRenderer(this.floorContainer);
    this.invalidPassages = new WallRenderer(this.invalidPassagesContainer);
    this.undecidedWalls = new WallRenderer(this.undecidedWallsContainer);
    this.presetWalls    = new WallRenderer(this.presetWallsContainer);
    this.splitJunctions = new SplitJunctionRenderer(this.splitJunctionContainer);
    this.teleports      = new TeleportRenderer(this.teleportContainer);
    this.verticals      = new VerticalConnectionRenderer(this.verticalContainer);
    this.locks          = new LockRenderer(this.locksContainer);
    this.markers        = new WaypointsRenderer(this.markersContainer);
    this.origin         = new OriginRenderer(this.originContainer);
    this.genSource      = new GenSourceRenderer(this.genSourceContainer);
    this.isolatedHL     = new CellFillRenderer(this.isolatedHLContainer);
    this.orphanHL       = new CellFillRenderer(this.orphanHLContainer);
    this.invalidHL      = new EdgeHighlightRenderer(this.invalidHLContainer);
    this.invalidTeleportHL = new Graphics();
    this.invalidTeleportHLContainer.addChild(this.invalidTeleportHL);
    this.hover          = new EdgeHighlightRenderer(this.hoverContainer);
    this.cellHover      = new CellFillRenderer(this.cellHoverContainer);
    this.teleportPreview = new Graphics();
    this.teleportPreviewContainer.addChild(this.teleportPreview);
    this.linkHover      = new NodeEdgeHighlightRenderer(this.linkHoverContainer);

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
      this.redrawGenSource((state.presetGenSource && (state.presetGenSource.level ?? 0) === (level ?? 0)) ? state.presetGenSource.point : null);
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

  /** Renders the pending teleport's origin (semi-transparent marker) and a line stretching to the
   * cursor, so the two-click placement gesture reads as "one end is already fixed, aim the other". */
  updateTeleportPreview(pendingFrom: [number, number] | null, cursorViewportX: number, cursorViewportY: number): void {
    this.teleportPreview.clear();
    if (!this.cfg || !pendingFrom) return;

    const proj = makeProjection(this.cfg);
    const { x: px, y: py } = proj.gridToScreen(pendingFrom[0], pendingFrom[1]);

    const markerSize = 16;
    const strokeWidth = 3;
    const dx = cursorViewportX - px;
    const dy = cursorViewportY - py;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 0) {
      const ux = dx / len;
      const uy = dy / len;
      const clip = clipDistance(ux, uy, markerSize / 2, strokeWidth);
      if (len > clip) {
        this.teleportPreview
          .moveTo(px + ux * clip, py + uy * clip)
          .lineTo(cursorViewportX, cursorViewportY)
          .stroke({ width: strokeWidth, color: canvas.teleport.default, alpha: 0.5, cap: "round" });
      }
    }

    this.teleportPreview
      .roundRect(px - markerSize / 2, py - markerSize / 2, markerSize, markerSize, markerSize * 0.25)
      .fill({ color: canvas.teleport.default, alpha: 0.5 });
  }

  protected onStoreChange(state: MazeState, prev: MazeState): void {
    const field = state.floorFields[state.activeFloorId];
    const prevField = prev.floorFields[prev.activeFloorId];
    const fieldChanged = field.fieldPoints !== prevField.fieldPoints || field.fieldEditMode !== prevField.fieldEditMode;
    if (fieldChanged) {
      this.rebuildCellCache(state);
    }

    if (
      fieldChanged ||
      state.activeFloorId !== prev.activeFloorId ||
      state.presetConnections !== prev.presetConnections ||
      state.presetStart !== prev.presetStart ||
      state.presetFinish !== prev.presetFinish ||
      state.presetGenSource !== prev.presetGenSource ||
      state.lockedNodes !== prev.lockedNodes ||
      state.autoLockedNodes !== prev.autoLockedNodes ||
      state.presetTeleports !== prev.presetTeleports ||
      state.presetVerticalPassages !== prev.presetVerticalPassages ||
      state.presetElevators !== prev.presetElevators ||
      state.presetSplitPoints !== prev.presetSplitPoints ||
      state.presetActiveSplitNode !== prev.presetActiveSplitNode ||
      state.presetConnectionsTool !== prev.presetConnectionsTool
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
    const presetVerticalPassages = state.presetVerticalPassages.filter((p) => (p.from.level ?? 0) === (level ?? 0) || (p.to.level ?? 0) === (level ?? 0));
    const presetElevators = state.presetElevators.filter((e) => e.floors.some((f) => (f.level ?? 0) === (level ?? 0)));
    const presetStart = (state.presetStart && (state.presetStart.level ?? 0) === (level ?? 0)) ? state.presetStart : null;
    const presetFinish = (state.presetFinish && (state.presetFinish.level ?? 0) === (level ?? 0)) ? state.presetFinish : null;
    const presetGenSource = (state.presetGenSource && (state.presetGenSource.level ?? 0) === (level ?? 0)) ? state.presetGenSource : null;

    this.grid.render({ viewport: this.viewport }, cfg);
    this.floor.render({ cells, color: canvas.floor.default, alpha: 1 }, cfg);

    const { undecided, preset, invalidPassages, invalidKeys } = buildPresetWallGroups(cells, presetConnections, cfg, presetSplitPoints);
    this.invalidPassages.render({ edges: invalidPassages }, cfg);
    this.undecidedWalls.render({ edges: undecided }, cfg);
    this.presetWalls.render({ edges: preset }, cfg);

    const { passages: splitPassages, wallFaces, specialShapes } = buildPresetSplitPassages(presetSplitPoints, presetConnections, cfg, presetActiveSplitNode, cells);
    this.splitJunctions.render({ passages: splitPassages, wallFaces, specialShapes });

    const lockEntries = buildLocks(lockedNodes, autoLockedNodes);
    this.locks.render({ locks: lockEntries }, cfg);

    const markerData = buildPresetMarkers(presetStart?.point ?? null, presetFinish?.point ?? null, cfg);
    this.markers.render({ markers: markerData });

    this.teleports.render({
      edges: buildPresetTeleportEdges(presetTeleports, cfg, level),
      cfg,
      floorNavigable: state.presetConnectionsTool !== "clear",
    });
    // Click-to-switch-floor (GitHub issue #341 follow-up): withheld while the clear tool is
    // active (its own click means "delete this connection", not "navigate") and, for a one-way
    // passage marker specifically (`filled === false`), while the one-way passage tool is active
    // too (that tool's own click on the marker cycles its direction instead).
    this.verticals.render({
      markers: buildPresetVerticalMarkers(presetVerticalPassages, presetElevators, cfg, level),
      style: DEFAULT_VERTICAL_STYLE,
      interactive: (marker) =>
        state.presetConnectionsTool !== "clear" &&
        !(marker.filled === false && state.presetConnectionsTool === "vertical_passage_one_way"),
    });

    this.redrawOrigin(state.showPresetOrigin);
    this.redrawGenSource(presetGenSource?.point ?? null);
    this.redrawIsolatedHL(state);
    this.redrawOrphanHL(state);

    if (state.highlightInvalidPresets) {
      const edgeHighlights = buildInvalidEdgeHighlights(invalidKeys, presetConnections, cfg);
      this.invalidHL.render({ highlights: edgeHighlights });
      this.redrawInvalidTeleportHL(state);
    } else {
      this.invalidHL.render({ highlights: [] });
      this.invalidTeleportHL.clear();
    }

    this.hover.render({ highlights: [] });
    this.redrawLinkHover(state);
  }

  private redrawLinkHover(state: MazeState): void {
    if (!this.cfg) return;
    const highlights = buildLinkHoverHighlight(state.presetHoveredLink, this.cfg);
    this.linkHover.render(highlights);
  }

  private redrawOrigin(show: boolean): void {
    if (!this.cfg) return;
    this.origin.render({ show, vpScale: this.viewport.scale }, this.cfg);
  }

  private redrawGenSource(source: [number, number] | null): void {
    if (!this.cfg) return;
    this.genSource.render({ source, vpScale: this.viewport.scale }, this.cfg);
  }

  private redrawIsolatedHL(state: MazeState): void {
    if (!this.cfg) return;
    if (!state.highlightIsolatedNodes) {
      this.isolatedHL.render({ cells: [], color: canvas.preset.invalid, alpha: ISOLATED_HL_ALPHA }, this.cfg);
      return;
    }
    const level = activeFloorLevel(state);
    const cells = buildIsolatedCellHighlights(
      mapOnLevel(state.lockedNodes, level),
      setOnLevel(state.autoLockedNodes, level),
      presetConnectionsOnLevel(state.presetConnections, level),
    );
    this.isolatedHL.render({ cells, color: canvas.preset.invalid, alpha: ISOLATED_HL_ALPHA }, this.cfg);
  }

  private redrawOrphanHL(state: MazeState): void {
    if (!this.cfg) return;
    if (!state.highlightOrphanSplitNodes) {
      this.orphanHL.render({ cells: [], color: canvas.preset.invalid, alpha: ISOLATED_HL_ALPHA }, this.cfg);
      return;
    }
    const level = activeFloorLevel(state);
    const orphanPoints = computeOrphanSplitPoints(
      state.presetSplitPoints, state.presetConnections, state.presetTeleports, state.presetStart, state.presetFinish, state.presetGenSource,
    );
    const cells = buildOrphanSplitCellHighlights(orphanPoints, level);
    this.orphanHL.render({ cells, color: canvas.preset.invalid, alpha: ISOLATED_HL_ALPHA }, this.cfg);
  }

  private redrawInvalidHL(state: MazeState): void {
    if (!this.cfg) return;
    if (!state.highlightInvalidPresets) {
      this.invalidHL.render({ highlights: [] });
      this.invalidTeleportHL.clear();
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
    this.invalidTeleportHL.clear();
    if (!state.highlightInvalidPresets) return;

    const level = activeFloorLevel(state);
    const resolveFieldAt = resolveFieldAtOf(state);
    const proj = makeProjection(this.cfg);
    const markerSize = 20;

    const presetTeleports = state.presetTeleports.filter((t) => (t.from.level ?? 0) === (level ?? 0) || (t.to.level ?? 0) === (level ?? 0));
    const invalidIds = computeInvalidTeleportIds(presetTeleports, resolveFieldAt);
    for (const t of presetTeleports) {
      if (!invalidIds.has(t.id)) continue;
      // Only highlight whichever endpoint is actually on this floor — the other end (a
      // cross-floor teleport, GitHub issue #357/#340) isn't drawn as a real point on this image at
      // all, so its own raw (x, y) would land on the wrong cell if highlighted unconditionally.
      for (const ep of [t.from, t.to]) {
        if ((ep.level ?? 0) !== (level ?? 0)) continue;
        const { x: px, y: py } = proj.gridToScreen(ep.point[0], ep.point[1]);
        this.invalidTeleportHL
          .roundRect(px - markerSize / 2, py - markerSize / 2, markerSize, markerSize, markerSize * 0.25)
          .stroke({ width: 4, color: canvas.preset.invalid, alpha: 0.9 });
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
      const { x: px, y: py } = proj.gridToScreen(own.point[0], own.point[1]);
      this.invalidTeleportHL
        .roundRect(px - markerSize / 2, py - markerSize / 2, markerSize, markerSize, markerSize * 0.25)
        .stroke({ width: 4, color: canvas.preset.invalid, alpha: 0.9 });
    }

    const presetElevators = state.presetElevators.filter((e) => e.floors.some((f) => (f.level ?? 0) === (level ?? 0)));
    const invalidElevatorIds = computeInvalidElevatorIds(presetElevators, resolveFieldAt);
    for (const e of presetElevators) {
      if (!invalidElevatorIds.has(e.id)) continue;
      const ownEndpoint = e.floors.find((f) => (f.level ?? 0) === (level ?? 0));
      if (!ownEndpoint) continue;
      const { x: px, y: py } = proj.gridToScreen(ownEndpoint.point[0], ownEndpoint.point[1]);
      this.invalidTeleportHL
        .roundRect(px - markerSize / 2, py - markerSize / 2, markerSize, markerSize, markerSize * 0.25)
        .stroke({ width: 4, color: canvas.preset.invalid, alpha: 0.9 });
    }

    const presetStart = (state.presetStart && (state.presetStart.level ?? 0) === (level ?? 0)) ? state.presetStart : null;
    const presetFinish = (state.presetFinish && (state.presetFinish.level ?? 0) === (level ?? 0)) ? state.presetFinish : null;
    const invalidMarkers = computeInvalidMarkers(presetStart, presetFinish, resolveFieldAt);
    const markerRadius = NODE_RADIUS * 1.5;
    for (const [invalid, endpoint] of [[invalidMarkers.start, presetStart], [invalidMarkers.finish, presetFinish]] as const) {
      if (!invalid || !endpoint) continue;
      const { x: px, y: py } = proj.gridToScreen(endpoint.point[0], endpoint.point[1]);
      this.invalidTeleportHL
        .circle(px, py, markerRadius + 3)
        .stroke({ width: 6, color: canvas.preset.invalid, alpha: 0.9 });
    }
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
    this.teleports.render({ edges: [], cfg });
    this.verticals.render({ markers: [], style: DEFAULT_VERTICAL_STYLE });
    this.origin.render({ show: false, vpScale: this.viewport.scale }, cfg);
    this.genSource.render({ source: null, vpScale: this.viewport.scale }, cfg);
    this.isolatedHL.render({ cells: [], color: canvas.preset.invalid, alpha: ISOLATED_HL_ALPHA }, cfg);
    this.invalidHL.render({ highlights: [] });
    this.invalidTeleportHL.clear();
    this.hover.render({ highlights: [] });
    this.cellHover.render({ cells: [], color: canvas.fieldEditor.hover, alpha: 0.35 }, cfg);
    this.linkHover.clear();
    this.teleportPreview.clear();
  }

  protected destroyChildren(): void {
    this.grid.destroy();
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
    this.invalidHL.destroy();
    this.invalidTeleportHL.destroy();
    this.hover.destroy();
    this.cellHover.destroy();
    this.linkHover.destroy();
    this.teleportPreview.destroy();
    this.gridContainer.destroy();
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
    this.genSourceContainer.destroy();
    this.isolatedHLContainer.destroy();
    this.orphanHLContainer.destroy();
    this.invalidHLContainer.destroy();
    this.invalidTeleportHLContainer.destroy();
    this.hoverContainer.destroy();
    this.cellHoverContainer.destroy();
    this.teleportPreviewContainer.destroy();
    this.linkHoverContainer.destroy();
  }
}

export { buildPresetTeleportEdges, buildPresetVerticalMarkers } from "./presetConnectionsGeometry";
