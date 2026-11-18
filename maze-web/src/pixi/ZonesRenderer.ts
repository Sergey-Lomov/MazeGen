import { Container } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import { GridRenderer } from "./renderers/GridRenderer";
import { CellFillRenderer } from "./renderers/CellFillRenderer";
import { RegionHighlightRenderer } from "./renderers/RegionHighlightRenderer";
import { WallRenderer } from "./renderers/WallRenderer";
import { buildPresetWallGroups } from "./selectors/presetSelectors";
import { filterZonesToField } from "./fieldValidity";
import { resolveFieldAtOf } from "../store/storeHelpers";
import { buildZoneRegions } from "./selectors/zoneSelectors";
import { COMPONENT_MASK_ALPHA } from "./renderConstants";
import { canvas } from "./colorTokens";
import { BaseFieldRenderer } from "./BaseFieldRenderer";

type MazeState = ReturnType<typeof useMazeStore.getState>;

/** Feature-renderer of the zones card: the active floor's field with the zones that pass the kind
 *  filters drawn over it as regions. */
export class ZonesRenderer extends BaseFieldRenderer {
  private readonly root: Container;
  private readonly gridContainer: Container;
  private readonly floorContainer: Container;
  private readonly undecidedWallsContainer: Container;
  private readonly wallsContainer: Container;
  private readonly zonesContainer: Container;

  private readonly grid: GridRenderer;
  private readonly floor: CellFillRenderer;
  private readonly undecidedWalls: WallRenderer;
  private readonly walls: WallRenderer;
  private readonly zones: RegionHighlightRenderer;

  constructor(container: Container) {
    super();
    this.root = container;

    this.gridContainer = new Container();
    this.floorContainer = new Container();
    this.undecidedWallsContainer = new Container();
    this.wallsContainer = new Container();
    this.zonesContainer = new Container();

    this.root.addChild(this.gridContainer);
    this.root.addChild(this.floorContainer);
    this.root.addChild(this.undecidedWallsContainer);
    this.root.addChild(this.wallsContainer);
    this.root.addChild(this.zonesContainer);

    this.grid = new GridRenderer(this.gridContainer, "zones");
    this.floor = new CellFillRenderer(this.floorContainer);
    this.undecidedWalls = new WallRenderer(this.undecidedWallsContainer);
    this.walls = new WallRenderer(this.wallsContainer);
    this.zones = new RegionHighlightRenderer(this.zonesContainer);

    this.root.visible = false;

    this.subscribeToStore();
  }

  protected isCardOpen(state: MazeState): boolean {
    return state.openCard === "zones";
  }

  protected getActiveConfig(state: MazeState) {
    return state.floorFields[state.activeFloorId].fieldConfig;
  }

  protected setRootVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  onViewportChanged(x: number, y: number, w: number, h: number, scale: number): void {
    this.updateViewport(x, y, w, h, scale);
    if (this.root.visible && this.cfg) this.grid.render({ viewport: this.viewport }, this.cfg);
  }

  protected onStoreChange(state: MazeState, prev: MazeState): void {
    const field = state.floorFields[state.activeFloorId];
    const prevField = prev.floorFields[prev.activeFloorId];
    const fieldChanged = field.fieldPoints !== prevField.fieldPoints || field.fieldEditMode !== prevField.fieldEditMode;
    if (fieldChanged) this.rebuildCellCache(state);

    if (
      fieldChanged ||
      state.activeFloorId !== prev.activeFloorId ||
      state.floors !== prev.floors ||
      state.zones !== prev.zones ||
      state.showAutoZones !== prev.showAutoZones ||
      state.showManualZones !== prev.showManualZones
    ) {
      this.redrawAll(state);
    }
  }

  protected redrawAll(state: MazeState): void {
    if (!this.cfg) return;
    const cfg = this.cfg;
    this.grid.render({ viewport: this.viewport }, cfg);
    this.floor.render({ cells: this.cachedCells, color: canvas.floor.default, alpha: 1 }, cfg);

    // No connections: the faint inner walls are the cell grid, the solid ones the outer walls.
    const { undecided, preset: outerWalls } = buildPresetWallGroups(this.cachedCells, new Map(), cfg);
    this.undecidedWalls.render({ edges: undecided }, cfg);
    this.walls.render({ edges: outerWalls }, cfg);

    const floorIndex = Math.max(state.floors.findIndex((f) => f.id === state.activeFloorId), 0);
    const { nodes, groups } = buildZoneRegions(filterZonesToField(state.zones, resolveFieldAtOf(state)), floorIndex, state.showAutoZones, state.showManualZones);
    this.zones.render({
      nodes,
      regionGroups: [],
      groups: groups.map((group) => ({ ...group, fillAlpha: COMPONENT_MASK_ALPHA })),
      color: 0,
      width: 0,
      alpha: 0,
      cfg,
      skipPerimeter: true,
      borderWidth: 2,
    });
  }

  protected clearAll(): void {
    this.floor.render({ cells: [], color: canvas.floor.default, alpha: 1 });
    this.undecidedWalls.render({ edges: [] });
    this.walls.render({ edges: [] });
    if (this.cfg) this.zones.render({ nodes: [], regionGroups: [], groups: [], color: 0, width: 0, alpha: 0, cfg: this.cfg });
  }

  protected destroyChildren(): void {
    this.grid.destroy();
    this.floor.destroy();
    this.undecidedWalls.destroy();
    this.walls.destroy();
    this.zones.destroy();
    this.undecidedWallsContainer.destroy();
    this.wallsContainer.destroy();
    this.zonesContainer.destroy();
    this.floorContainer.destroy();
    this.gridContainer.destroy();
  }
}
