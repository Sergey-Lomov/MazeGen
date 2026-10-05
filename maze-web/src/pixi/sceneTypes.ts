import type { MazeState } from "../store/storeTypes";

export interface ViewportListener {
  onViewportChanged(x: number, y: number, w: number, h: number, scale: number): void;
}

/** Whether the active editor can route canvas interaction to the shared underlay controller. */
export function canManipulateBackgroundImage(state: MazeState): boolean {
  const field = state.floorFields[state.activeFloorId];
  return (state.openCard !== "field_setup" || field?.fieldEditMode === "custom")
    && (state.openCard === "field_setup"
    || state.openCard === "preset_connections"
    || state.openCard === "post_edit");
}

export interface PointerHandler {
  onPointerDown(canvasX: number, canvasY: number, button: number, shiftKey?: boolean, clickCount?: number): void;
  onPointerMove(canvasX: number, canvasY: number, buttons?: number, shiftKey?: boolean): void;
  onPointerUp(button?: number): void;
  cancelPointerGesture(): void;
  clearHover?(): void;
}

/** Shared drag-to-pan math, reused for the default viewport pan and as FieldEditController's pan callback target. */
export class PanState {
  private dragging = false;
  private start = { x: 0, y: 0 };
  private originStart = { x: 0, y: 0 };

  constructor(
    private getOrigin: () => { x: number; y: number },
    private setOrigin: (x: number, y: number) => void,
  ) {}

  get isDragging(): boolean {
    return this.dragging;
  }

  begin(x: number, y: number): void {
    this.dragging = true;
    this.start = { x, y };
    this.originStart = this.getOrigin();
  }

  move(x: number, y: number): void {
    if (!this.dragging) return;
    this.setOrigin(this.originStart.x + (x - this.start.x), this.originStart.y + (y - this.start.y));
  }

  end(): void {
    this.dragging = false;
  }
}
