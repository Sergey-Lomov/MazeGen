import { Container } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import { GridRenderer } from "./renderers/GridRenderer";
import { CellFillRenderer } from "./renderers/CellFillRenderer";
import { RegionHighlightRenderer } from "./renderers/RegionHighlightRenderer";
import { WallRenderer } from "./renderers/WallRenderer";
import { buildPresetWallGroups } from "./selectors/presetSelectors";
import { filterZonesToField } from "./fieldValidity";
import { resolveFieldAtOf } from "../store/storeHelpers";
import type { Zone } from "../wasm/mazeService";
import type { FieldConfig } from "../fieldConfig";
import { buildZonesHoverRegion, buildZoneRegions, hidesOtherZones, overridesWithDraft, zonesWithDraft } from "./selectors/zoneSelectors";
import { COMPONENT_MASK_ALPHA } from "./renderConstants";
import { canvas } from "./colorTokens";
import { brightColor } from "../store/colorMath";
import { BaseFieldRenderer } from "./BaseFieldRenderer";

type MazeState = ReturnType<typeof useMazeStore.getState>;

const activeFloorIndex = (state: MazeState) => Math.max(state.floors.findIndex((f) => f.id === state.activeFloorId), 0);

/** Border widths of the zone regions, and the gap kept between the borders of two regions meeting at a cell side.
 *  The stroke is centred on the contour, so a region is inset by half the gap plus half its border width. */
const ZONE_BORDER_WIDTH = 2;
const HOVER_BORDER_WIDTH = 3;
const ZONE_REGION_GAP = 2;
const regionInset = (borderWidth: number) => ZONE_REGION_GAP / 2 + borderWidth / 2;

/** Fill of the hovered zone: fully opaque, so it reads over the other zones. */
const HOVER_FILL_ALPHA = 1;

/** Feature-renderer of the zones card: the active floor's field with the zones that pass the kind
 *  filters drawn over it as regions. */
export class ZonesRenderer extends BaseFieldRenderer {
  private readonly root: Container;
  private readonly gridContainer: Container;
  private readonly fieldGridContainer: Container;
  private readonly floorContainer: Container;
  private readonly wallsContainer: Container;
  private readonly zonesContainer: Container;
  private readonly hoverContainer: Container;

  private readonly grid: GridRenderer;
  private readonly fieldGrid: GridRenderer;
  private readonly floor: CellFillRenderer;
  private readonly walls: WallRenderer;
  private readonly zones: RegionHighlightRenderer;
  private readonly hoverZone: RegionHighlightRenderer;

  constructor(container: Container) {
    super();
    this.root = container;

    this.gridContainer = new Container();
    this.fieldGridContainer = new Container();
    this.floorContainer = new Container();
    this.wallsContainer = new Container();
    this.zonesContainer = new Container();
    this.hoverContainer = new Container();

    // The grid is drawn over the floor fill, so it runs through the field as thin lines, as it does outside.
    this.root.addChild(this.floorContainer);
    this.root.addChild(this.gridContainer);
    this.root.addChild(this.fieldGridContainer);
    this.root.addChild(this.wallsContainer);
    this.root.addChild(this.zonesContainer);
    this.root.addChild(this.hoverContainer);

    this.grid = new GridRenderer(this.gridContainer, "zones");
    this.fieldGrid = new GridRenderer(this.fieldGridContainer, "zones field");
    this.floor = new CellFillRenderer(this.floorContainer);
    this.walls = new WallRenderer(this.wallsContainer);
    this.zones = new RegionHighlightRenderer(this.zonesContainer);
    this.hoverZone = new RegionHighlightRenderer(this.hoverContainer);

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
      state.showManualZones !== prev.showManualZones ||
      state.hiddenZoneIds !== prev.hiddenZoneIds ||
      state.zoneColorOverrides !== prev.zoneColorOverrides ||
      state.zoneEditDraft !== prev.zoneEditDraft ||
      state.zoneEditDraftColor !== prev.zoneEditDraftColor ||
      state.showOtherZones !== prev.showOtherZones ||
      // Entering or leaving the editor hides or restores the other zones while "show other zones" is off.
      (hidesOtherZones(state) !== hidesOtherZones(prev))
    ) {
      this.redrawAll(state);
    } else if (state.hoveredZoneId !== prev.hoveredZoneId || state.hoveredZoneIds !== prev.hoveredZoneIds) {
      // A list hover moves often: only its own layer is redrawn.
      this.redrawHover(state);
    }
  }

  protected redrawAll(state: MazeState): void {
    if (!this.cfg) return;
    const cfg = this.cfg;
    this.grid.render({ viewport: this.viewport }, cfg);
    // The grid inside the field is more visible than the one around it.
    this.fieldGrid.render({ viewport: this.viewport, color: canvas.wall.undecided }, cfg, this.cachedCells);
    this.floor.render({ cells: this.cachedCells, color: canvas.floor.default, alpha: 1 }, cfg);

    // No connections: the preset walls are the field's outer walls; the inner cell grid is the grid layer.
    const { preset: outerWalls } = buildPresetWallGroups(this.cachedCells, new Map(), cfg);
    this.walls.render({ edges: outerWalls }, cfg);

    const fieldZones = filterZonesToField(zonesWithDraft(state.zones, state.zoneEditDraft), resolveFieldAtOf(state));
    const overrides = overridesWithDraft(state.zoneColorOverrides, state.zoneEditDraft, state.zoneEditDraftColor);
    // While a zone is edited, "show other zones" off leaves only that zone (drawn by the hover layer).
    const { nodes, groups } = hidesOtherZones(state)
      ? { nodes: [], groups: [] }
      : buildZoneRegions(fieldZones, activeFloorIndex(state), state.showAutoZones, state.showManualZones, state.hiddenZoneIds, overrides);
    this.zones.render({
      nodes,
      regionGroups: [],
      groups: groups.map((group) => ({ ...group, fillAlpha: COMPONENT_MASK_ALPHA, borderColor: brightColor(group.color) })),
      color: 0,
      width: 0,
      alpha: 0,
      cfg,
      skipPerimeter: true,
      borderWidth: ZONE_BORDER_WIDTH,
      inset: regionInset(ZONE_BORDER_WIDTH),
    });
    this.drawHover(state, fieldZones, cfg);
  }

  private redrawHover(state: MazeState): void {
    if (!this.cfg || !this.root.visible) return;
    this.drawHover(state, filterZonesToField(zonesWithDraft(state.zones, state.zoneEditDraft), resolveFieldAtOf(state)), this.cfg);
  }

  /** The list hover: drawn over the rest, whatever the toggles say; the active floor stays as it is. */
  private drawHover(state: MazeState, fieldZones: Zone[], cfg: FieldConfig): void {
    // The zone being edited is drawn the same way, so it reads over the others whatever the toggles say.
    // A group card's hover shows its zones together; one zone's own hover wins over it.
    const shownIds = state.hoveredZoneId !== null ? [state.hoveredZoneId]
      : state.hoveredZoneIds.length > 0 ? state.hoveredZoneIds
      : state.zoneEditDraft ? [state.zoneEditDraft.id] : [];
    const hover = shownIds.length === 0 ? null : buildZonesHoverRegion(fieldZones, shownIds, activeFloorIndex(state), overridesWithDraft(state.zoneColorOverrides, state.zoneEditDraft, state.zoneEditDraftColor));
    this.hoverZone.render({
      nodes: hover?.nodes ?? [],
      regionGroups: [],
      groups: (hover?.groups ?? []).map((group) => ({ ...group, fillAlpha: HOVER_FILL_ALPHA, borderColor: brightColor(group.color) })),
      color: 0,
      width: 0,
      alpha: 0,
      cfg,
      skipPerimeter: true,
      borderWidth: HOVER_BORDER_WIDTH,
      inset: regionInset(HOVER_BORDER_WIDTH),
    });
  }

  protected clearAll(): void {
    this.floor.render({ cells: [], color: canvas.floor.default, alpha: 1 });
    this.walls.render({ edges: [] });
    if (this.cfg) {
      this.fieldGrid.render({ viewport: this.viewport }, this.cfg, []);
      this.zones.render({ nodes: [], regionGroups: [], groups: [], color: 0, width: 0, alpha: 0, cfg: this.cfg });
      this.hoverZone.render({ nodes: [], regionGroups: [], groups: [], color: 0, width: 0, alpha: 0, cfg: this.cfg });
    }
  }

  protected destroyChildren(): void {
    this.grid.destroy();
    this.fieldGrid.destroy();
    this.floor.destroy();
    this.walls.destroy();
    this.zones.destroy();
    this.hoverZone.destroy();
    this.wallsContainer.destroy();
    this.zonesContainer.destroy();
    this.hoverContainer.destroy();
    this.floorContainer.destroy();
    this.fieldGridContainer.destroy();
    this.gridContainer.destroy();
  }
}
