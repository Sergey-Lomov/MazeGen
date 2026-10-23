import type { Container } from "pixi.js";
import { useMazeStore } from "../../store/mazeStore";
import type { PointerHandler } from "../sceneTypes";
import { toViewportCoordinates } from "../pointerInteraction";
import { exactCellBounds, nearestCellCoord } from "../tessellationGeometry";
import { selectFloorScopedMaze } from "../selectors/mazeSelectors";
import { floorLabelPosition } from "../renderers/FloorLabelRenderer";

/** Moves the active floor label while its explicit canvas-drag mode owns pointer input. */
export class FloorLabelDragController implements PointerHandler {
  private dragging = false;
  private offset = { x: 0, y: 0 };

  constructor(private readonly getViewport: () => Container) {}

  onPointerDown(canvasX: number, canvasY: number, button: number): void {
    if (button !== 0) return;
    const state = useMazeStore.getState();
    const drag = state.floorLabelDrag;
    if (!drag || state.openCard !== "image_export" || state.activeRenderMode !== drag.renderMode
      || state.activeFloorId !== drag.floorId) return;
    const settings = drag.renderMode === "vector_by_walls"
      ? state.vectorByWallsSettings.floorLabel
      : state.vectorByCorridorsSettings.floorLabel;
    if (!settings.enabled) return;
    const nodes = selectFloorScopedMaze(state.nodes, state.edges, state.floors, drag.floorId).nodes;
    if (nodes.length === 0) return;
    const pointer = toViewportCoordinates(canvasX, canvasY, this.getViewport());
    const center = floorLabelPosition(settings, drag.floorId, exactCellBounds(nodes, state.floorFields[state.activeFloorId].fieldConfig), state.floorFields[state.activeFloorId].fieldConfig);
    if (!center || Math.abs(pointer.x - center.x) > settings.width / 2 || Math.abs(pointer.y - center.y) > settings.height / 2) return;
    this.dragging = true;
    this.offset = { x: center.x - pointer.x, y: center.y - pointer.y };
  }

  onPointerMove(canvasX: number, canvasY: number): void {
    if (!this.dragging) return;
    const state = useMazeStore.getState();
    const drag = state.floorLabelDrag;
    if (!drag) {
      this.dragging = false;
      return;
    }
    const pointer = toViewportCoordinates(canvasX, canvasY, this.getViewport());
    const x = pointer.x + this.offset.x;
    const y = pointer.y + this.offset.y;
    if (drag.initialPosition.mode === "cell") {
      const cell = nearestCellCoord(x, y, state.floorFields[state.activeFloorId].fieldConfig);
      state.updateFloorLabelDragPosition({ mode: "cell", cell });
    } else {
      state.updateFloorLabelDragPosition({ mode: "free", x, y });
    }
  }

  onPointerUp(button = 0): void {
    if (button === 0) this.dragging = false;
  }

  cancelPointerGesture(): void {
    this.dragging = false;
  }
}
