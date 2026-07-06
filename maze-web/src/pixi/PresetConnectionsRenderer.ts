import { Container, Graphics } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import { computeInvalidKeysFromCells, computeInvalidTeleportIds, computeInvalidMarkers } from "./fieldEditUtils";
import type { FieldEdge, PresetTeleportEntry } from "./fieldEditUtils";
import { makeProjection } from "./tessellationProjection";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { CellFillRenderer } from "./renderers/CellFillRenderer";
import { WallRenderer } from "./renderers/WallRenderer";
import { WaypointsRenderer } from "./renderers/WaypointsRenderer";
import { LockRenderer } from "./renderers/LockRenderer";
import { OriginRenderer } from "./renderers/OriginRenderer";
import { GenSourceRenderer } from "./renderers/GenSourceRenderer";
import { GridRenderer } from "./renderers/GridRenderer";
import { EdgeHighlightRenderer } from "./renderers/EdgeHighlightRenderer";
import { TeleportRenderer, clipDistance } from "./renderers/TeleportRenderer";
import type { TeleportEdge } from "./renderers/types";
import {
  buildPresetWallGroups,
  buildPresetMarkers,
  buildLocks,
  buildIsolatedCellHighlights,
  buildInvalidEdgeHighlights,
  buildHoverEdgeHighlight,
} from "./selectors/presetSelectors";
import { canvas, NODE_RADIUS } from "./colorUtils";
import { BaseFieldRenderer } from "./BaseFieldRenderer";

type MazeState = ReturnType<typeof useMazeStore.getState>;

const ISOLATED_HL_ALPHA = 0.35;

export class PresetConnectionsRenderer extends BaseFieldRenderer {
  private readonly root: Container;

  private readonly gridContainer: Container;
  private readonly floorContainer: Container;
  private readonly invalidPassagesContainer: Container;
  private readonly undecidedWallsContainer: Container;
  private readonly presetWallsContainer: Container;
  private readonly teleportContainer: Container;
  private readonly locksContainer: Container;
  private readonly markersContainer: Container;
  private readonly originContainer: Container;
  private readonly genSourceContainer: Container;
  private readonly isolatedHLContainer: Container;
  private readonly invalidHLContainer: Container;
  private readonly invalidTeleportHLContainer: Container;
  private readonly hoverContainer: Container;
  private readonly teleportPreviewContainer: Container;

  private readonly grid: GridRenderer;
  private readonly floor: CellFillRenderer;
  private readonly invalidPassages: WallRenderer;
  private readonly undecidedWalls: WallRenderer;
  private readonly presetWalls: WallRenderer;
  private readonly teleports: TeleportRenderer;
  private readonly locks: LockRenderer;
  private readonly markers: WaypointsRenderer;
  private readonly origin: OriginRenderer;
  private readonly genSource: GenSourceRenderer;
  private readonly isolatedHL: CellFillRenderer;
  private readonly invalidHL: EdgeHighlightRenderer;
  private readonly invalidTeleportHL: Graphics;
  private readonly hover: EdgeHighlightRenderer;
  private readonly teleportPreview: Graphics;

  constructor(container: Container) {
    super();
    this.root = container;

    this.gridContainer           = new Container();
    this.floorContainer          = new Container();
    this.invalidPassagesContainer = new Container();
    this.undecidedWallsContainer = new Container();
    this.presetWallsContainer    = new Container();
    this.teleportContainer       = new Container();
    this.locksContainer          = new Container();
    this.markersContainer        = new Container();
    this.originContainer         = new Container();
    this.genSourceContainer      = new Container();
    this.isolatedHLContainer     = new Container();
    this.invalidHLContainer      = new Container();
    this.invalidTeleportHLContainer = new Container();
    this.hoverContainer          = new Container();
    this.teleportPreviewContainer = new Container();

    this.root.addChild(this.gridContainer);
    this.root.addChild(this.floorContainer);
    this.root.addChild(this.invalidPassagesContainer);
    this.root.addChild(this.undecidedWallsContainer);
    this.root.addChild(this.presetWallsContainer);
    this.root.addChild(this.teleportContainer);
    this.root.addChild(this.locksContainer);
    this.root.addChild(this.markersContainer);
    this.root.addChild(this.originContainer);
    this.root.addChild(this.genSourceContainer);
    this.root.addChild(this.isolatedHLContainer);
    this.root.addChild(this.invalidHLContainer);
    this.root.addChild(this.invalidTeleportHLContainer);
    this.root.addChild(this.hoverContainer);
    this.root.addChild(this.teleportPreviewContainer);

    this.grid           = new GridRenderer(this.gridContainer);
    this.floor          = new CellFillRenderer(this.floorContainer);
    this.invalidPassages = new WallRenderer(this.invalidPassagesContainer);
    this.undecidedWalls = new WallRenderer(this.undecidedWallsContainer);
    this.presetWalls    = new WallRenderer(this.presetWallsContainer);
    this.teleports      = new TeleportRenderer(this.teleportContainer);
    this.locks          = new LockRenderer(this.locksContainer);
    this.markers        = new WaypointsRenderer(this.markersContainer);
    this.origin         = new OriginRenderer(this.originContainer);
    this.genSource      = new GenSourceRenderer(this.genSourceContainer);
    this.isolatedHL     = new CellFillRenderer(this.isolatedHLContainer);
    this.invalidHL      = new EdgeHighlightRenderer(this.invalidHLContainer);
    this.invalidTeleportHL = new Graphics();
    this.invalidTeleportHLContainer.addChild(this.invalidTeleportHL);
    this.hover          = new EdgeHighlightRenderer(this.hoverContainer);
    this.teleportPreview = new Graphics();
    this.teleportPreviewContainer.addChild(this.teleportPreview);

    this.root.visible = false;

    this.subscribeToStore();
  }

  protected isCardOpen(state: MazeState): boolean {
    return state.openCard === "preset_connections";
  }

  protected getActiveConfig(state: MazeState) {
    return state.tessellationConfig;
  }

  protected setRootVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  onViewportChanged(x: number, y: number, w: number, h: number, scale: number): void {
    this.updateViewport(x, y, w, h, scale);
    if (this.root.visible && this.cfg) {
      const state = useMazeStore.getState();
      this.grid.render({ viewport: this.viewport }, this.cfg);
      this.redrawOrigin(state.showPresetOrigin);
      this.redrawGenSource(state.presetGenSource);
    }
  }

  updateHover(edge: FieldEdge | null): void {
    if (!this.cfg) return;
    const highlights = buildHoverEdgeHighlight(edge, this.cfg);
    this.hover.render({ highlights });
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
    const fieldChanged = state.fieldPoints !== prev.fieldPoints || state.fieldEditMode !== prev.fieldEditMode;
    if (fieldChanged) {
      this.rebuildCellCache(state);
    }

    if (
      fieldChanged ||
      state.presetConnections !== prev.presetConnections ||
      state.presetStart !== prev.presetStart ||
      state.presetFinish !== prev.presetFinish ||
      state.presetGenSource !== prev.presetGenSource ||
      state.lockedNodes !== prev.lockedNodes ||
      state.autoLockedNodes !== prev.autoLockedNodes ||
      state.presetTeleports !== prev.presetTeleports
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

    if (
      state.highlightIsolatedNodes !== prev.highlightIsolatedNodes ||
      (state.highlightIsolatedNodes && (
        state.lockedNodes !== prev.lockedNodes ||
        state.presetConnections !== prev.presetConnections
      ))
    ) {
      this.redrawIsolatedHL(state);
    }

    if (state.presetConnectionsTool !== prev.presetConnectionsTool || state.presetTeleportPendingFrom !== prev.presetTeleportPendingFrom) {
      if (!state.presetTeleportPendingFrom) this.teleportPreview.clear();
    }
  }

  protected redrawAll(state: MazeState): void {
    if (!this.cfg) return;
    const cfg = this.cfg;
    const cells = this.cachedCells;

    this.grid.render({ viewport: this.viewport }, cfg);
    this.floor.render({ cells, color: canvas.floor.default, alpha: 1 }, cfg);

    const { undecided, preset, invalidPassages, invalidKeys } = buildPresetWallGroups(cells, state.presetConnections, cfg);
    this.invalidPassages.render({ edges: invalidPassages }, cfg);
    this.undecidedWalls.render({ edges: undecided }, cfg);
    this.presetWalls.render({ edges: preset }, cfg);

    const lockEntries = buildLocks(state.lockedNodes, state.autoLockedNodes);
    this.locks.render({ locks: lockEntries }, cfg);

    const markerData = buildPresetMarkers(state.presetStart, state.presetFinish, cfg);
    this.markers.render({ markers: markerData });

    this.teleports.render({ edges: buildPresetTeleportEdges(state.presetTeleports, cfg) });

    this.redrawOrigin(state.showPresetOrigin);
    this.redrawGenSource(state.presetGenSource);
    this.redrawIsolatedHL(state);

    if (state.highlightInvalidPresets) {
      const edgeHighlights = buildInvalidEdgeHighlights(invalidKeys, state.presetConnections, cfg);
      this.invalidHL.render({ highlights: edgeHighlights });
      this.redrawInvalidTeleportHL(state);
    } else {
      this.invalidHL.render({ highlights: [] });
      this.invalidTeleportHL.clear();
    }

    this.hover.render({ highlights: [] });
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
    const cells = buildIsolatedCellHighlights(state.lockedNodes, state.autoLockedNodes, state.presetConnections);
    this.isolatedHL.render({ cells, color: canvas.preset.invalid, alpha: ISOLATED_HL_ALPHA }, this.cfg);
  }

  private redrawInvalidHL(state: MazeState): void {
    if (!this.cfg) return;
    if (!state.highlightInvalidPresets) {
      this.invalidHL.render({ highlights: [] });
      this.invalidTeleportHL.clear();
      return;
    }
    const invalidKeys = computeInvalidKeysFromCells(state.presetConnections, this.cachedCells);
    const edgeHighlights = buildInvalidEdgeHighlights(invalidKeys, state.presetConnections, this.cfg);
    this.invalidHL.render({ highlights: edgeHighlights });
    this.redrawInvalidTeleportHL(state);
  }

  private redrawInvalidTeleportHL(state: MazeState): void {
    if (!this.cfg) return;
    this.invalidTeleportHL.clear();
    if (!state.highlightInvalidPresets) return;

    const customPts = state.fieldEditMode === "custom" && state.fieldPoints.size > 0 ? state.fieldPoints : undefined;
    const proj = makeProjection(this.cfg);
    const markerSize = 20;

    const invalidIds = computeInvalidTeleportIds(state.presetTeleports, this.cfg, customPts);
    for (const t of state.presetTeleports) {
      if (!invalidIds.has(t.id)) continue;
      for (const [cx, cy] of [t.from, t.to]) {
        const { x: px, y: py } = proj.gridToScreen(cx, cy);
        this.invalidTeleportHL
          .roundRect(px - markerSize / 2, py - markerSize / 2, markerSize, markerSize, markerSize * 0.25)
          .stroke({ width: 4, color: canvas.preset.invalid, alpha: 0.9 });
      }
    }

    const invalidMarkers = computeInvalidMarkers(state.presetStart, state.presetFinish, this.cfg, customPts);
    const markerRadius = NODE_RADIUS * 1.5;
    for (const [invalid, cell] of [[invalidMarkers.start, state.presetStart], [invalidMarkers.finish, state.presetFinish]] as const) {
      if (!invalid || !cell) continue;
      const { x: px, y: py } = proj.gridToScreen(cell[0], cell[1]);
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
    this.locks.render({ locks: [] }, cfg);
    this.markers.render({ markers: [] });
    this.teleports.render({ edges: [] });
    this.origin.render({ show: false, vpScale: this.viewport.scale }, cfg);
    this.genSource.render({ source: null, vpScale: this.viewport.scale }, cfg);
    this.isolatedHL.render({ cells: [], color: canvas.preset.invalid, alpha: ISOLATED_HL_ALPHA }, cfg);
    this.invalidHL.render({ highlights: [] });
    this.invalidTeleportHL.clear();
    this.hover.render({ highlights: [] });
    this.teleportPreview.clear();
  }

  protected destroyChildren(): void {
    this.grid.destroy();
    this.floor.destroy();
    this.invalidPassages.destroy();
    this.undecidedWalls.destroy();
    this.presetWalls.destroy();
    this.teleports.destroy();
    this.locks.destroy();
    this.markers.destroy();
    this.origin.destroy();
    this.genSource.destroy();
    this.isolatedHL.destroy();
    this.invalidHL.destroy();
    this.invalidTeleportHL.destroy();
    this.hover.destroy();
    this.teleportPreview.destroy();
    this.gridContainer.destroy();
    this.floorContainer.destroy();
    this.invalidPassagesContainer.destroy();
    this.undecidedWallsContainer.destroy();
    this.presetWallsContainer.destroy();
    this.teleportContainer.destroy();
    this.locksContainer.destroy();
    this.markersContainer.destroy();
    this.originContainer.destroy();
    this.genSourceContainer.destroy();
    this.isolatedHLContainer.destroy();
    this.invalidHLContainer.destroy();
    this.invalidTeleportHLContainer.destroy();
    this.hoverContainer.destroy();
    this.teleportPreviewContainer.destroy();
  }
}

function buildPresetTeleportEdges(teleports: PresetTeleportEntry[], cfg: TessellationConfig): TeleportEdge[] {
  const proj = makeProjection(cfg);
  return teleports.map((t) => {
    // `t.from`/`t.to` are the two click points in placement order — the actual passage direction
    // for "backward" runs the other way (mirrors PresetConnectionState::TeleportBackward on the
    // Rust side, which builds the edge to→from), so entry/exit must swap for the renderer too.
    const [entryCell, exitCell] = t.direction === "backward" ? [t.to, t.from] : [t.from, t.to];
    const entry = proj.gridToScreen(entryCell[0], entryCell[1]);
    const exit = proj.gridToScreen(exitCell[0], exitCell[1]);
    return { from: [entry.x, entry.y], to: [exit.x, exit.y], oneWay: t.direction !== "two_way" };
  });
}
