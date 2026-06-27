import { Container } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import { resolveCells, computeInvalidKeysFromCells } from "./presetConnectionsUtils";
import type { FieldEdge } from "./presetConnectionsUtils";
import { encodePoint } from "./tessellationProjection";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { CellFillRenderer } from "./renderers/CellFillRenderer";
import { WallRenderer } from "./renderers/WallRenderer";
import { WaypointsRenderer } from "./renderers/WaypointsRenderer";
import { LockRenderer } from "./renderers/LockRenderer";
import { OriginRenderer } from "./renderers/OriginRenderer";
import { GenSourceRenderer } from "./renderers/GenSourceRenderer";
import { GridRenderer } from "./renderers/GridRenderer";
import { EdgeHighlightRenderer } from "./renderers/EdgeHighlightRenderer";
import {
  buildPresetWallGroups,
  buildPresetMarkers,
  buildLocks,
  buildIsolatedCellHighlights,
  buildInvalidEdgeHighlights,
  buildHoverEdgeHighlight,
} from "./selectors/presetSelectors";
import { FLOOR_COLOR, INVALID_COLOR } from "./colorUtils";
import type { Viewport } from "./renderers/types";

const ISOLATED_HL_ALPHA = 0.35;

export class PresetConnectionsRenderer {
  private readonly root: Container;

  private readonly gridContainer: Container;
  private readonly floorContainer: Container;
  private readonly invalidPassagesContainer: Container;
  private readonly undecidedWallsContainer: Container;
  private readonly presetWallsContainer: Container;
  private readonly locksContainer: Container;
  private readonly markersContainer: Container;
  private readonly originContainer: Container;
  private readonly genSourceContainer: Container;
  private readonly isolatedHLContainer: Container;
  private readonly invalidHLContainer: Container;
  private readonly hoverContainer: Container;

  private readonly grid: GridRenderer;
  private readonly floor: CellFillRenderer;
  private readonly invalidPassages: WallRenderer;
  private readonly undecidedWalls: WallRenderer;
  private readonly presetWalls: WallRenderer;
  private readonly locks: LockRenderer;
  private readonly markers: WaypointsRenderer;
  private readonly origin: OriginRenderer;
  private readonly genSource: GenSourceRenderer;
  private readonly isolatedHL: CellFillRenderer;
  private readonly invalidHL: EdgeHighlightRenderer;
  private readonly hover: EdgeHighlightRenderer;

  private viewport: Viewport = { x: 0, y: 0, w: 0, h: 0, scale: 1 };
  private cfg: TessellationConfig | null = null;
  private cachedCells: [number, number][] = [];
  private cachedCellSet: Set<number> = new Set();

  private unsubscribe: (() => void) | null = null;

  constructor(container: Container) {
    this.root = container;

    this.gridContainer           = new Container();
    this.floorContainer          = new Container();
    this.invalidPassagesContainer = new Container();
    this.undecidedWallsContainer = new Container();
    this.presetWallsContainer    = new Container();
    this.locksContainer          = new Container();
    this.markersContainer        = new Container();
    this.originContainer         = new Container();
    this.genSourceContainer      = new Container();
    this.isolatedHLContainer     = new Container();
    this.invalidHLContainer      = new Container();
    this.hoverContainer          = new Container();

    this.root.addChild(this.gridContainer);
    this.root.addChild(this.floorContainer);
    this.root.addChild(this.invalidPassagesContainer);
    this.root.addChild(this.undecidedWallsContainer);
    this.root.addChild(this.presetWallsContainer);
    this.root.addChild(this.locksContainer);
    this.root.addChild(this.markersContainer);
    this.root.addChild(this.originContainer);
    this.root.addChild(this.genSourceContainer);
    this.root.addChild(this.isolatedHLContainer);
    this.root.addChild(this.invalidHLContainer);
    this.root.addChild(this.hoverContainer);

    this.grid           = new GridRenderer(this.gridContainer);
    this.floor          = new CellFillRenderer(this.floorContainer);
    this.invalidPassages = new WallRenderer(this.invalidPassagesContainer);
    this.undecidedWalls = new WallRenderer(this.undecidedWallsContainer);
    this.presetWalls    = new WallRenderer(this.presetWallsContainer);
    this.locks          = new LockRenderer(this.locksContainer);
    this.markers        = new WaypointsRenderer(this.markersContainer);
    this.origin         = new OriginRenderer(this.originContainer);
    this.genSource      = new GenSourceRenderer(this.genSourceContainer);
    this.isolatedHL     = new CellFillRenderer(this.isolatedHLContainer);
    this.invalidHL      = new EdgeHighlightRenderer(this.invalidHLContainer);
    this.hover          = new EdgeHighlightRenderer(this.hoverContainer);

    this.root.visible = false;

    this.unsubscribe = useMazeStore.subscribe((state, prev) => {
      const isOpen = state.openCard === "preset_connections";
      const openChanged = state.openCard !== prev.openCard
        && (isOpen || prev.openCard === "preset_connections");

      if (openChanged) {
        this.root.visible = isOpen;
        if (isOpen) {
          this.cfg = state.tessellationConfig;
          this.rebuildCellCache(state);
          this.redrawAll(state);
        } else {
          this.clearAll();
        }
      }

      if (!isOpen) return;

      if (state.tessellationConfig !== prev.tessellationConfig) {
        this.cfg = state.tessellationConfig;
        this.rebuildCellCache(state);
        this.redrawAll(state);
        return;
      }

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
        state.autoLockedNodes !== prev.autoLockedNodes
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
    });
  }

  getCachedCells(): [number, number][] {
    return this.cachedCells;
  }

  getCachedCellSet(): Set<number> {
    return this.cachedCellSet;
  }

  onViewportChanged(x: number, y: number, w: number, h: number, scale: number): void {
    this.viewport = { x, y, w, h, scale };
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

  private rebuildCellCache(state: ReturnType<typeof useMazeStore.getState>): void {
    if (!this.cfg) return;
    const customPts = state.fieldEditMode === "custom" && state.fieldPoints.size > 0
      ? state.fieldPoints : undefined;
    this.cachedCells = resolveCells(this.cfg, customPts);
    this.cachedCellSet = new Set(this.cachedCells.map(([x, y]) => encodePoint(x, y)));
  }

  private redrawAll(state: ReturnType<typeof useMazeStore.getState>): void {
    if (!this.cfg) return;
    const cfg = this.cfg;
    const cells = this.cachedCells;

    this.grid.render({ viewport: this.viewport }, cfg);
    this.floor.render({ cells, color: FLOOR_COLOR, alpha: 1 }, cfg);

    const { undecided, preset, invalidPassages, invalidKeys } = buildPresetWallGroups(cells, state.presetConnections, cfg);
    this.invalidPassages.render({ edges: invalidPassages }, cfg);
    this.undecidedWalls.render({ edges: undecided }, cfg);
    this.presetWalls.render({ edges: preset }, cfg);

    const lockEntries = buildLocks(state.lockedNodes, state.autoLockedNodes);
    this.locks.render({ locks: lockEntries }, cfg);

    const markerData = buildPresetMarkers(state.presetStart, state.presetFinish, cfg);
    this.markers.render({ markers: markerData });

    this.redrawOrigin(state.showPresetOrigin);
    this.redrawGenSource(state.presetGenSource);
    this.redrawIsolatedHL(state);

    if (state.highlightInvalidPresets) {
      const edgeHighlights = buildInvalidEdgeHighlights(invalidKeys, state.presetConnections, cfg);
      this.invalidHL.render({ highlights: edgeHighlights });
    } else {
      this.invalidHL.render({ highlights: [] });
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

  private redrawIsolatedHL(state: ReturnType<typeof useMazeStore.getState>): void {
    if (!this.cfg) return;
    if (!state.highlightIsolatedNodes) {
      this.isolatedHL.render({ cells: [], color: INVALID_COLOR, alpha: ISOLATED_HL_ALPHA }, this.cfg);
      return;
    }
    const cells = buildIsolatedCellHighlights(state.lockedNodes, state.autoLockedNodes, state.presetConnections);
    this.isolatedHL.render({ cells, color: INVALID_COLOR, alpha: ISOLATED_HL_ALPHA }, this.cfg);
  }

  private redrawInvalidHL(state: ReturnType<typeof useMazeStore.getState>): void {
    if (!this.cfg) return;
    if (!state.highlightInvalidPresets) {
      this.invalidHL.render({ highlights: [] });
      return;
    }
    const invalidKeys = computeInvalidKeysFromCells(state.presetConnections, this.cachedCells);
    const edgeHighlights = buildInvalidEdgeHighlights(invalidKeys, state.presetConnections, this.cfg);
    this.invalidHL.render({ highlights: edgeHighlights });
  }

  private clearAll(): void {
    if (!this.cfg) return;
    const cfg = this.cfg;
    this.grid.render({ viewport: { x: 0, y: 0, w: 0, h: 0, scale: 1 } }, cfg);
    this.floor.render({ cells: [], color: FLOOR_COLOR, alpha: 1 }, cfg);
    this.invalidPassages.render({ edges: [] }, cfg);
    this.undecidedWalls.render({ edges: [] }, cfg);
    this.presetWalls.render({ edges: [] }, cfg);
    this.locks.render({ locks: [] }, cfg);
    this.markers.render({ markers: [] });
    this.origin.render({ show: false, vpScale: this.viewport.scale }, cfg);
    this.genSource.render({ source: null, vpScale: this.viewport.scale }, cfg);
    this.isolatedHL.render({ cells: [], color: INVALID_COLOR, alpha: ISOLATED_HL_ALPHA }, cfg);
    this.invalidHL.render({ highlights: [] });
    this.hover.render({ highlights: [] });
  }

  destroy(): void {
    this.unsubscribe?.();
    this.grid.destroy();
    this.floor.destroy();
    this.invalidPassages.destroy();
    this.undecidedWalls.destroy();
    this.presetWalls.destroy();
    this.locks.destroy();
    this.markers.destroy();
    this.origin.destroy();
    this.genSource.destroy();
    this.isolatedHL.destroy();
    this.invalidHL.destroy();
    this.hover.destroy();
    this.gridContainer.destroy();
    this.floorContainer.destroy();
    this.invalidPassagesContainer.destroy();
    this.undecidedWallsContainer.destroy();
    this.presetWallsContainer.destroy();
    this.locksContainer.destroy();
    this.markersContainer.destroy();
    this.originContainer.destroy();
    this.genSourceContainer.destroy();
    this.isolatedHLContainer.destroy();
    this.invalidHLContainer.destroy();
    this.hoverContainer.destroy();
  }
}
