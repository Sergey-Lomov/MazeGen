import { Container, Graphics } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import { TopologyBandRenderer } from "./renderers/TopologyBandRenderer";
import { selectTopologyBands } from "./selectors/topologyBands";
import { SeamArrowLayer } from "./seamArrowSync";
import { decodePoint, encodePoint, makeProjection } from "./tessellationProjection";
import { TILE_SIZE, VIEWPORT_FIT_PADDING } from "./constants";
import type { FieldConfig } from "../fieldConfig";
import { configAllCells } from "./tessellationCells";
import { CellFillRenderer } from "./renderers/CellFillRenderer";
import { OriginRenderer } from "./renderers/OriginRenderer";
import { GridRenderer } from "./renderers/GridRenderer";
import { buildActiveCells } from "./selectors/fieldSelectors";
import { ACTIVE_CELL_ALPHA } from "./renderConstants";
import { canvas } from "./colorTokens";
import type { Viewport } from "./renderers/types";
import { PaperLayoutRenderer } from "./PaperLayoutRenderer";
import { BackgroundImageHost, backgroundImageChanged } from "./BackgroundImageLayer";
import { computeMirrorPreview, type MirrorAxisPoints, type MirrorPoint } from "./mirror";
import { WallRenderer } from "./renderers/WallRenderer";
import { buildPresetWallGroups } from "./selectors/presetSelectors";
import type { FieldOpError } from "../wasm/mazeService";
import { cellBounds } from "./tessellationGeometry";
import { controlLineWidth } from "./controlLineWidth";

const CELL_HOVER_COLOR = 0x888888;
const HOVER_ALPHA = 0.3;
const MIRROR_POLYGON_COLOR = 0xffffff;
const MIRROR_POLYGON_ALPHA = 0.9;
const MIRROR_POLYGON_WIDTH = 1.25;
const MIRROR_POLYGON_DASH_LENGTH = TILE_SIZE * 0.35;
const MIRROR_POLYGON_GAP_LENGTH = TILE_SIZE * 0.22;
export class FieldEditorOverlay {
  private readonly root: Container;
  private readonly gridContainer: Container;
  private readonly seamArrowContainer: Container;
  private readonly backgroundImageContainer: Container;
  private readonly paperLayoutContainer: Container;
  private readonly fieldBoundaryContainer: Container;
  private readonly topologyContainer: Container;
  private readonly floorContainer: Container;
  private readonly mirrorContainer: Container;
  private readonly originContainer: Container;
  private readonly hoverContainer: Container;

  private readonly grid: GridRenderer;
  private readonly seamLayer: SeamArrowLayer;
  private readonly backgroundImage: BackgroundImageHost;
  private readonly paperLayout: PaperLayoutRenderer;
  private readonly fieldBoundary: WallRenderer;
  private readonly topologyBands: TopologyBandRenderer;
  private readonly floor: CellFillRenderer;
  private readonly mirrorCells: CellFillRenderer;
  private readonly mirrorGraphics: Graphics;
  private readonly origin: OriginRenderer;
  private readonly hover: CellFillRenderer;

  private viewport: Viewport = { x: 0, y: 0, w: 0, h: 0, scale: 1 };
  private selectionMoveHidden = new Set<number>();
  private selectionMoveTemporary = new Set<number>();
  private unsubscribe: (() => void) | null = null;

  constructor(container: Container) {
    this.root = container;
    this.gridContainer = new Container();
    this.seamArrowContainer = new Container();
    this.backgroundImageContainer = new Container();
    this.paperLayoutContainer = new Container();
    this.fieldBoundaryContainer = new Container();
    this.topologyContainer = new Container();
    this.floorContainer = new Container();
    this.mirrorContainer = new Container();
    this.originContainer = new Container();
    this.hoverContainer = new Container();
    this.root.addChild(this.backgroundImageContainer);
    this.root.addChild(this.gridContainer);
    this.root.addChild(this.floorContainer);
    this.root.addChild(this.paperLayoutContainer);
    this.root.addChild(this.mirrorContainer);
    this.root.addChild(this.originContainer);
    // Above every layer of the maze itself, below only the highlights.
    this.root.addChild(this.seamArrowContainer);
    this.root.addChild(this.hoverContainer);

    this.grid = new GridRenderer(this.gridContainer);
    this.seamLayer = new SeamArrowLayer(this.seamArrowContainer);
    this.backgroundImage = new BackgroundImageHost({
      image: this.backgroundImageContainer,
      floor: this.floorContainer,
      grid: this.gridContainer,
      layerAnchor: this.paperLayoutContainer,
    });
    this.paperLayout = new PaperLayoutRenderer(this.paperLayoutContainer);
    this.floor = new CellFillRenderer(this.floorContainer);
    this.mirrorCells = new CellFillRenderer(this.mirrorContainer);
    this.mirrorGraphics = new Graphics();
    this.mirrorContainer.addChild(this.mirrorGraphics);
    this.fieldBoundary = new WallRenderer(this.fieldBoundaryContainer);
    this.origin = new OriginRenderer(this.originContainer);
    this.hover = new CellFillRenderer(this.hoverContainer);
    // Keep the editor-only boundary above every underlay layer, including "above everything".
    this.root.addChild(this.fieldBoundaryContainer);
    // The glue editor's highlights lie right above the boundary walls they mark.
    this.root.addChild(this.topologyContainer);
    this.topologyBands = new TopologyBandRenderer(this.topologyContainer);

    this.root.visible = false;

    this.unsubscribe = useMazeStore.subscribe((state, prev) => {
      const field = state.floorFields[state.activeFloorId];
      const prevField = prev.floorFields[prev.activeFloorId];
      const isOpen = state.openCard === "field_setup";
      const wasOpen = prev.openCard === "field_setup";
      if (isOpen !== wasOpen) {
        this.root.visible = isOpen;
      }

      if (isOpen && !wasOpen) {
        this.redrawAll(state);
      }

      if (isOpen && (
        state.activeFloorId !== prev.activeFloorId
        || state.floorTopology !== prev.floorTopology
        || state.topologyRunA !== prev.topologyRunA
        || state.topologyRunB !== prev.topologyRunB
        || state.topologyFaceHover !== prev.topologyFaceHover
        || state.topologyFlagged !== prev.topologyFlagged
        || state.topologySideHover !== prev.topologySideHover
        || state.topologyPick !== prev.topologyPick
        || field.fieldConfig !== prevField.fieldConfig
        || field.fieldPoints !== prevField.fieldPoints
      )) this.redrawTopology(state);

      if (isOpen && field.fieldPoints !== prevField.fieldPoints) {
        this.redrawFloor(state);
        this.redrawFieldBoundary(state);
      }

      if (isOpen && state.backgroundAutoFillPreview !== prev.backgroundAutoFillPreview) {
        this.redrawFloor(state);
        this.redrawFieldBoundary(state);
      }

      if (isOpen && state.smoothPrimitives !== prev.smoothPrimitives) {
        this.redrawFloor(state);
        this.redrawFieldBoundary(state);
      }

      if (isOpen && field.fieldConfig !== prevField.fieldConfig) {
        this.redrawAll(state);
      }

      // The boundary skips glued faces; the seam model behind that is rewarmed by `topologySync`, a
      // subscriber of its own, so the redraw waits until the current notification has reached it.
      if (isOpen && (state.floorTopology !== prev.floorTopology || state.activeFloorId !== prev.activeFloorId)) {
        queueMicrotask(() => {
          const latest = useMazeStore.getState();
          if (latest.openCard === "field_setup") this.redrawFieldBoundary(latest);
        });
      }

      if (isOpen && field.fieldEditMode !== prevField.fieldEditMode) {
        this.redrawFloor(state);
        this.redrawFieldBoundary(state);
        this.redrawOrigin(field.fieldEditMode === "custom" && state.showFieldOrigin, field.fieldConfig);
        this.redrawPaperLayout(state);
      }

      if (isOpen && field.fieldPrimitive !== prevField.fieldPrimitive) {
        this.updateHover(null, field.fieldConfig);
        this.redrawMirror(state);
      }

      if (isOpen && (field.fieldPoints !== prevField.fieldPoints
        || field.fieldOperation !== prevField.fieldOperation
        || state.mirrorSnapMode !== prev.mirrorSnapMode
        || state.mirrorScope !== prev.mirrorScope
        || state.mirrorAxisPoints !== prev.mirrorAxisPoints
        || state.mirrorSourceSide !== prev.mirrorSourceSide
        || state.mirrorPolygon !== prev.mirrorPolygon
        || state.mirrorPolygonFinished !== prev.mirrorPolygonFinished)) {
        this.redrawMirror(state);
      }

      if (isOpen && state.showFieldOrigin !== prev.showFieldOrigin) {
        this.redrawOrigin(field.fieldEditMode === "custom" && state.showFieldOrigin, field.fieldConfig);
      }

      if (isOpen && (state.showPaperLayout !== prev.showPaperLayout
        || state.pngExportSettings.print !== prev.pngExportSettings.print)) {
        this.redrawPaperLayout(state);
      }

      if (isOpen && (backgroundImageChanged(state, prev)
        || field.fieldEditMode !== prevField.fieldEditMode)) {
        this.backgroundImage.render(state, this.shouldShowBackgroundImage(state));
        this.redrawFieldBoundary(state);
      }
    });
  }

  updateHover(
    cellOrCells: [number, number] | [number, number][] | null,
    cfg: FieldConfig,
    color = CELL_HOVER_COLOR,
    alpha = HOVER_ALPHA,
  ): void {
    const cells = !cellOrCells
      ? []
      : typeof cellOrCells[0] === "number"
        ? [cellOrCells as [number, number]]
        : cellOrCells as [number, number][];
    this.hover.render({ cells, color, alpha, inset: 0, borderWidth: 0 }, cfg);
  }

  onViewportChanged(x: number, y: number, w: number, h: number, scale: number): void {
    this.viewport = { x, y, w, h, scale };
    this.lastMirrorDraw = null;
    if (this.root.visible) {
      const state = useMazeStore.getState();
      const field = state.floorFields[state.activeFloorId];
      this.grid.render({ viewport: this.viewport }, field.fieldConfig);
      this.redrawOrigin(field.fieldEditMode === "custom" && state.showFieldOrigin, field.fieldConfig);
      this.redrawPaperLayout(state);
      this.redrawMirror(state);
      this.redrawTopology(state);
    }
  }

  private redrawAll(state: ReturnType<typeof useMazeStore.getState>): void {
    const field = state.floorFields[state.activeFloorId];
    this.grid.render({ viewport: this.viewport }, field.fieldConfig);
    this.redrawFloor(state);
    this.backgroundImage.render(state, this.shouldShowBackgroundImage(state));
    this.redrawFieldBoundary(state);
    this.redrawTopology(state);
    this.redrawOrigin(field.fieldEditMode === "custom" && state.showFieldOrigin, field.fieldConfig);
    this.redrawPaperLayout(state);
    this.redrawMirror(state);
  }

  private redrawFloor(state: ReturnType<typeof useMazeStore.getState>): void {
    const field = state.floorFields[state.activeFloorId];
    const cfg = field.fieldConfig;
    const cells = this.visibleFieldCells(state);
    this.floor.render({ cells, color: canvas.fieldEditor.activeCell, alpha: ACTIVE_CELL_ALPHA }, cfg);
  }

  /** Draws a visual-only wall-style contour around the field. The exposed-edge union handles
   * holes, disconnected cells, and every supported tessellation without introducing walls or
   * changing the field sent to generation. */
  private redrawFieldBoundary(state: ReturnType<typeof useMazeStore.getState>): void {
    const field = state.floorFields[state.activeFloorId];
    this.fieldBoundaryContainer.visible = true;

    // Reuse the same boundary-edge selector as Preset Connections and the same WallRenderer,
    // including the configured wall color, width, cap, and join.
    const { preset: boundaryWalls } = buildPresetWallGroups(
      this.visibleFieldCells(state),
      new Map(),
      field.fieldConfig,
    );
    this.fieldBoundary.render({ edges: boundaryWalls }, field.fieldConfig);
    // BackgroundImageLayer keeps its interactive transform/crop frame last; stay immediately
    // below that frame while remaining above the image itself.
    const top = this.root.children.length - 2;
    this.root.setChildIndex(this.fieldBoundaryContainer, Math.max(0, top - 1));
    this.root.setChildIndex(this.topologyContainer, Math.max(0, top));
  }

  private redrawTopology(state: ReturnType<typeof useMazeStore.getState>): void {
    this.topologyBands.render(selectTopologyBands(state));
  }

  private visibleFieldCells(state: ReturnType<typeof useMazeStore.getState>): [number, number][] {
    const field = state.floorFields[state.activeFloorId];
    const preview = state.backgroundAutoFillPreview;
    const fieldPoints = preview ?? field.fieldPoints;
    const fieldEditMode = preview !== null ? "custom" : field.fieldEditMode;
    const cells = buildActiveCells(fieldPoints, fieldEditMode, field.fieldConfig, state.smoothPrimitives)
      .filter(([x, y]) => !this.selectionMoveHidden.has(encodePoint(x, y)));
    const rendered = new Set(cells.map(([x, y]) => encodePoint(x, y)));
    for (const key of this.selectionMoveTemporary) {
      if (!rendered.has(key)) cells.push(decodePoint(key));
    }
    return cells;
  }

  private shouldShowBackgroundImage(state: ReturnType<typeof useMazeStore.getState>): boolean {
    const field = state.floorFields[state.activeFloorId];
    return state.showBackgroundImage && field.fieldEditMode === "custom";
  }

  setSelectionMovePreview(sourceCells: [number, number][], temporaryCells: [number, number][]): void {
    const hidden = new Set(sourceCells.map(([x, y]) => encodePoint(x, y)));
    const temporary = new Set(temporaryCells.map(([x, y]) => encodePoint(x, y)));
    if (hidden.size === this.selectionMoveHidden.size
      && temporary.size === this.selectionMoveTemporary.size
      && [...hidden].every((key) => this.selectionMoveHidden.has(key))
      && [...temporary].every((key) => this.selectionMoveTemporary.has(key))) return;
    this.selectionMoveHidden = hidden;
    this.selectionMoveTemporary = temporary;
    const state = useMazeStore.getState();
    if (state.openCard === "field_setup") {
      this.redrawFloor(state);
      this.redrawFieldBoundary(state);
    }
  }

  private redrawOrigin(show: boolean, cfg: FieldConfig): void {
    this.origin.render({ show }, cfg);
  }

  private redrawPaperLayout(state: ReturnType<typeof useMazeStore.getState>): void {
    const field = state.floorFields[state.activeFloorId];
    this.paperLayout.render(
      state.showPaperLayout && field.fieldEditMode === "custom",
      field.fieldConfig,
      state.pngExportSettings.print,
      this.viewport,
    );
  }

  updateMirrorPreview(axisOverride?: MirrorAxisPoints, polygonOverride?: MirrorPoint[]): void {
    this.redrawMirror(useMazeStore.getState(), axisOverride, polygonOverride);
  }

  private pendingMirror: { axis?: MirrorAxisPoints; polygon?: MirrorPoint[] } | null = null;
  private mirrorFrameRequested = false;

  /** Pointer-driven preview updates: pointer events can outpace the frame rate, so only the latest
   * one per frame is drawn. Any other mirror redraw supersedes a pending one. */
  scheduleMirrorPreview(axisOverride?: MirrorAxisPoints, polygonOverride?: MirrorPoint[]): void {
    this.pendingMirror = { axis: axisOverride, polygon: polygonOverride };
    if (this.mirrorFrameRequested) return;
    this.mirrorFrameRequested = true;
    requestAnimationFrame(() => {
      this.mirrorFrameRequested = false;
      const pending = this.pendingMirror;
      if (pending) this.redrawMirror(useMazeStore.getState(), pending.axis, pending.polygon);
    });
  }

  /** Publishes the preview's refusal so the field editor can show it; identical errors are not re-published. */
  private reportFieldOpError(error: FieldOpError | null): void {
    const store = useMazeStore.getState();
    if (JSON.stringify(store.fieldOpError) !== JSON.stringify(error)) store.setFieldOpError(error);
  }

  /** Inputs of the last drawn mirror preview; an identical redraw (a pointer move that snaps to
   * the same point) is skipped, since the preview costs a core call and a cell re-render. */
  private lastMirrorDraw: { objects: unknown[]; shape: string } | null = null;

  private redrawMirror(
    state: ReturnType<typeof useMazeStore.getState>,
    axisOverride?: MirrorAxisPoints,
    polygonOverride?: MirrorPoint[],
  ): void {
    this.pendingMirror = null;
    const field = state.floorFields[state.activeFloorId];
    const visible = state.openCard === "field_setup"
      && field.fieldEditMode === "custom"
      && field.fieldPrimitive === "mirror";
    this.mirrorContainer.visible = visible;
    const axisPoints = axisOverride ?? state.mirrorAxisPoints;
    const polygon = polygonOverride ?? state.mirrorPolygon;
    const color = field.fieldOperation === "remove"
      ? canvas.fieldEditor.previewRemove
      : field.fieldOperation === "select" ? canvas.fieldEditor.previewSelect : canvas.fieldEditor.previewAdd;
    const objects = [color, visible, field.fieldPoints, field.fieldConfig, field.fieldOperation, state.mirrorScope, state.mirrorSourceSide, state.mirrorPolygonFinished];
    const shape = JSON.stringify([axisPoints, polygon, polygonOverride !== undefined]);
    const last = this.lastMirrorDraw;
    if (last && last.shape === shape && last.objects.every((value, index) => value === objects[index])) return;
    this.lastMirrorDraw = { objects, shape };
    this.mirrorGraphics.clear();
    if (!visible) {
      this.mirrorCells.render({ cells: [], color: 0, alpha: 0 }, field.fieldConfig);
      this.reportFieldOpError(null);
      return;
    }

    if (axisPoints.length === 2) {
      const axis: [MirrorPoint, MirrorPoint] = [axisPoints[0], axisPoints[1]];
      const preview = computeMirrorPreview(
        field.fieldPoints,
        field.fieldConfig,
        {
          scope: state.mirrorScope,
          sourceSide: state.mirrorSourceSide,
          axis,
          polygon,
        },
        encodePoint,
        decodePoint,
      );
      this.reportFieldOpError(preview.error);
      this.mirrorCells.render({ cells: preview.mirroredCells, color, alpha: 0.45 }, field.fieldConfig);
      const dx = axis[1].x - axis[0].x;
      const dy = axis[1].y - axis[0].y;
      const length = Math.hypot(dx, dy);
      if (length > 0) {
        const ux = dx / length;
        const uy = dy / length;
        const mx = (axis[0].x + axis[1].x) / 2;
        const my = (axis[0].y + axis[1].y) / 2;
        this.mirrorGraphics.moveTo(mx - ux * 100000, -my + uy * 100000);
        this.mirrorGraphics.lineTo(mx + ux * 100000, -my - uy * 100000);
        this.mirrorGraphics.stroke({ color, alpha: 0.9, width: this.strokeWidth(1.5) });
        this.mirrorGraphics.circle(axis[0].x, -axis[0].y, TILE_SIZE * 0.14);
        this.mirrorGraphics.circle(axis[1].x, -axis[1].y, TILE_SIZE * 0.14);
        this.mirrorGraphics.fill({ color, alpha: 0.95 });

        if (state.mirrorScope === "one_side") {
          const normalX = -uy * -state.mirrorSourceSide;
          const normalY = ux * -state.mirrorSourceSide;
          const from = { x: mx - normalX * TILE_SIZE * 0.7, y: my - normalY * TILE_SIZE * 0.7 };
          const to = { x: mx + normalX * TILE_SIZE * 0.7, y: my + normalY * TILE_SIZE * 0.7 };
          this.mirrorGraphics.moveTo(from.x, -from.y);
          this.mirrorGraphics.lineTo(to.x, -to.y);
          this.mirrorGraphics.stroke({ color, alpha: 0.95, width: this.strokeWidth(2) });
          const head = TILE_SIZE * 0.18;
          this.mirrorGraphics.moveTo(to.x - normalX * head + normalY * head, -to.y + normalY * head + normalX * head);
          this.mirrorGraphics.lineTo(to.x, -to.y);
          this.mirrorGraphics.lineTo(to.x - normalX * head - normalY * head, -to.y + normalY * head - normalX * head);
          this.mirrorGraphics.stroke({ color, alpha: 0.95, width: this.strokeWidth(2) });
        }
      }
    } else {
      this.mirrorCells.render({ cells: [], color, alpha: 0 }, field.fieldConfig);
      this.reportFieldOpError(null);
      if (axisPoints.length === 1) {
        this.mirrorGraphics.circle(axisPoints[0].x, -axisPoints[0].y, TILE_SIZE * 0.14);
        this.mirrorGraphics.fill({ color, alpha: 0.95 });
      }
    }
    if (state.mirrorScope === "polygon" && polygon.length > 0) {
      const hasCursorPoint = polygonOverride !== undefined
        && polygon.length > state.mirrorPolygon.length
        && !state.mirrorPolygonFinished;
      const confirmedVertexCount = state.mirrorPolygon.length;
      const solidPointCount = hasCursorPoint
        ? (confirmedVertexCount >= 2 ? polygon.length : 0)
        : (confirmedVertexCount >= 3 ? polygon.length : 0);
      if (solidPointCount >= 2) {
        for (let i = 1; i < solidPointCount; i++) {
          drawDashedSegment(
            this.mirrorGraphics,
            { x: polygon[i - 1].x, y: -polygon[i - 1].y },
            { x: polygon[i].x, y: -polygon[i].y },
            MIRROR_POLYGON_COLOR,
            this.strokeWidth(MIRROR_POLYGON_WIDTH),
          );
        }
      }
      if (polygon.length >= 2) {
        const last = { x: polygon[polygon.length - 1].x, y: -polygon[polygon.length - 1].y };
        const first = { x: polygon[0].x, y: -polygon[0].y };
        drawDashedSegment(this.mirrorGraphics, last, first, MIRROR_POLYGON_COLOR, this.strokeWidth(MIRROR_POLYGON_WIDTH));
      }
      for (const point of state.mirrorPolygon) {
        this.mirrorGraphics.circle(point.x, -point.y, TILE_SIZE * 0.12);
        this.mirrorGraphics.fill({ color: MIRROR_POLYGON_COLOR, alpha: MIRROR_POLYGON_ALPHA });
      }
    }
  }

  destroy(): void {
    this.unsubscribe?.();
    this.seamLayer.destroy();
    this.seamArrowContainer.destroy();
    this.grid.destroy();
    this.backgroundImage.destroy();
    this.paperLayout.destroy();
    this.fieldBoundary.destroy();
    this.topologyBands.destroy();
    this.floor.destroy();
    this.mirrorCells.destroy();
    this.mirrorGraphics.destroy();
    this.origin.destroy();
    this.hover.destroy();
    this.gridContainer.destroy();
    this.backgroundImageContainer.destroy();
    this.paperLayoutContainer.destroy();
    this.fieldBoundaryContainer.destroy();
    this.topologyContainer.destroy();
    this.floorContainer.destroy();
    this.mirrorContainer.destroy();
    this.originContainer.destroy();
    this.hoverContainer.destroy();
  }

  private strokeWidth(width: number): number {
    return controlLineWidth(width, this.viewport.scale);
  }
}

function drawDashedSegment(
  graphics: Graphics,
  start: { x: number; y: number },
  end: { x: number; y: number },
  color: number,
  width: number,
): void {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return;
  const ux = dx / length;
  const uy = dy / length;
  const step = MIRROR_POLYGON_DASH_LENGTH + MIRROR_POLYGON_GAP_LENGTH;
  for (let travelled = 0; travelled < length; travelled += step) {
    const dashEnd = Math.min(travelled + MIRROR_POLYGON_DASH_LENGTH, length);
    graphics.moveTo(start.x + ux * travelled, start.y + uy * travelled);
    graphics.lineTo(start.x + ux * dashEnd, start.y + uy * dashEnd);
    graphics.stroke({ color, alpha: MIRROR_POLYGON_ALPHA, width });
  }
}

export function configScreenCenter(cfg: FieldConfig): { x: number; y: number } {
  const cells = configAllCells(cfg);
  if (cells.length === 0) return { x: 0, y: 0 };
  const proj = makeProjection(cfg);
  let sx = 0, sy = 0;
  for (const [col, row] of cells) {
    const { x, y } = proj.gridToScreen(col, row);
    sx += x; sy += y;
  }
  return { x: sx / cells.length, y: sy / cells.length };
}

function fieldBounds(cfg: FieldConfig): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const cells = configAllCells(cfg);
  if (cells.length === 0) return null;
  return cellBounds(cells, cfg);
}

/** Computes the viewport transform that fits `activeCfg`'s field onto the screen (GitHub issue
 * #373). Unifies the auto-fit rule across every field-showing feature: the target scale is driven
 * by the *largest* floor's own bounding box (max width, max height independently — possibly from
 * two different floors), not by the active floor's own size, so switching floors or features never
 * changes the zoom level, only what's centered. `allCfgs` must carry every floor's own
 * `FieldConfig` (including `activeCfg` itself). The viewport is centered on `activeCfg`'s
 * own bbox center. */
export function fitFieldViewport(
  activeCfg: FieldConfig,
  allCfgs: FieldConfig[],
  screenW: number,
  screenH: number,
): { x: number; y: number; scale: number } {
  const activeBounds = fieldBounds(activeCfg);
  if (!activeBounds) return { x: screenW / 2, y: screenH / 2, scale: 1 };

  let maxW = 0, maxH = 0;
  for (const cfg of allCfgs) {
    const bounds = fieldBounds(cfg);
    if (!bounds) continue;
    maxW = Math.max(maxW, bounds.maxX - bounds.minX);
    maxH = Math.max(maxH, bounds.maxY - bounds.minY);
  }
  if (maxW <= 0 || maxH <= 0) return { x: screenW / 2, y: screenH / 2, scale: 1 };

  const scale = Math.min(VIEWPORT_FIT_PADDING * screenW / maxW, VIEWPORT_FIT_PADDING * screenH / maxH);
  const cx = (activeBounds.minX + activeBounds.maxX) / 2;
  const cy = (activeBounds.minY + activeBounds.maxY) / 2;
  return { x: screenW / 2 - scale * cx, y: screenH / 2 - scale * cy, scale };
}
