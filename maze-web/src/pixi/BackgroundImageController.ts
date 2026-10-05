import { useMazeStore } from "../store/mazeStore";
import type { BackgroundImage } from "../store/tessellationTypes";
import type { PointerHandler } from "./sceneTypes";

type ViewportLike = { x: number; y: number; scale: { x: number; y: number } };
type Drag =
  | {
      kind: "move";
      startX: number;
      startY: number;
      image: BackgroundImage;
    }
  | {
      kind: "resize";
      startX: number;
      startY: number;
      image: BackgroundImage;
      sideX: -1 | 0 | 1;
      sideY: -1 | 0 | 1;
    };

/** Pointer handler for the optional direct underlay manipulation mode (GitHub issue #674). */
export class BackgroundImageController implements PointerHandler {
  private drag: Drag | null = null;

  constructor(private readonly getViewport: () => ViewportLike) {}

  onPointerDown(canvasX: number, canvasY: number, button: number, _shiftKey?: boolean): void {
    if (button !== 0) return;
    const state = useMazeStore.getState();
    const image = state.backgroundImage;
    if (!state.showBackgroundImage || !state.backgroundImageManualPositioning || !image) return;
    const point = this.toWorld(canvasX, canvasY);
    const halfWidth = image.displayWidth / 2;
    const halfHeight = image.displayHeight / 2;
    const handleRadius = this.getHandleRadius();
    const { nearX, nearY } = this.getHandleHit(point, image, handleRadius);
    const insideImage = Math.abs(point.x - image.centerX) <= halfWidth
      && Math.abs(point.y - image.centerY) <= halfHeight;
    const insideHandle = Math.abs(point.x - image.centerX) <= halfWidth + handleRadius
      && Math.abs(point.y - image.centerY) <= halfHeight + handleRadius
      && (nearX || nearY);
    if (!insideImage && !insideHandle) {
      state.setBackgroundImageManualPositioning(false);
      return;
    }

    this.drag = nearX || nearY
      ? {
          kind: "resize",
          startX: point.x,
          startY: point.y,
          image,
          sideX: nearX ? (point.x >= image.centerX ? 1 : -1) : 0,
          sideY: nearY ? (point.y >= image.centerY ? 1 : -1) : 0,
        }
      : { kind: "move", startX: point.x, startY: point.y, image };
  }

  onPointerMove(_canvasX: number, _canvasY: number, _buttons?: number, shiftKey = false): void {
    if (!this.drag) return;
    const point = this.toWorld(_canvasX, _canvasY);
    const { image } = this.drag;
    if (this.drag.kind === "move") {
      useMazeStore.getState().setBackgroundImageTransform({
        centerX: image.centerX + point.x - this.drag.startX,
        centerY: image.centerY + point.y - this.drag.startY,
        displayWidth: image.displayWidth,
        displayHeight: image.displayHeight,
      });
      return;
    }

    const widthScale = this.drag.sideX === 0 ? 1
      : (image.displayWidth + (point.x - this.drag.startX) * this.drag.sideX * 2) / image.displayWidth;
    const heightScale = this.drag.sideY === 0 ? 1
      : (image.displayHeight + (point.y - this.drag.startY) * this.drag.sideY * 2) / image.displayHeight;
    const proposedScale = Math.max(0.05, this.drag.sideX !== 0 && this.drag.sideY !== 0
      ? Math.max(widthScale, heightScale)
      : this.drag.sideX !== 0 ? widthScale : heightScale);
    const newWidth = image.displayWidth * proposedScale;
    const newHeight = image.displayHeight * proposedScale;
    const centerX = shiftKey
      ? image.centerX
      : image.centerX + (newWidth - image.displayWidth) * this.drag.sideX / 2;
    const centerY = shiftKey
      ? image.centerY
      : image.centerY + (newHeight - image.displayHeight) * this.drag.sideY / 2;
    useMazeStore.getState().setBackgroundImageTransform({
      centerX,
      centerY,
      displayWidth: newWidth,
      displayHeight: newHeight,
    });
  }

  getCursor(canvasX: number, canvasY: number): string {
    const state = useMazeStore.getState();
    const image = state.backgroundImage;
    if (!state.showBackgroundImage || !state.backgroundImageManualPositioning || !image) return "";
    const point = this.toWorld(canvasX, canvasY);
    const halfWidth = image.displayWidth / 2;
    const halfHeight = image.displayHeight / 2;
    const handleRadius = this.getHandleRadius();
    const { nearX, nearY } = this.getHandleHit(point, image, handleRadius);
    const insideImage = Math.abs(point.x - image.centerX) <= halfWidth
      && Math.abs(point.y - image.centerY) <= halfHeight;
    const insideHandle = Math.abs(point.x - image.centerX) <= halfWidth + handleRadius
      && Math.abs(point.y - image.centerY) <= halfHeight + handleRadius
      && (nearX || nearY);
    if (!insideImage && !insideHandle) return "default";
    if (nearX && nearY) {
      return (point.x - image.centerX) * (point.y - image.centerY) >= 0 ? "nwse-resize" : "nesw-resize";
    }
    if (nearX) return "ew-resize";
    if (nearY) return "ns-resize";
    return "move";
  }

  onPointerUp(): void { this.drag = null; }
  cancelPointerGesture(): void { this.drag = null; }
  clearHover(): void {}

  private toWorld(x: number, y: number): { x: number; y: number } {
    const viewport = this.getViewport();
    return {
      x: (x - viewport.x) / viewport.scale.x,
      y: (y - viewport.y) / viewport.scale.y,
    };
  }

  private getHandleRadius(): number {
    return 14 / Math.max(Math.abs(this.getViewport().scale.x), 0.001);
  }

  private getHandleHit(
    point: { x: number; y: number },
    image: BackgroundImage,
    handleRadius: number,
  ): { nearX: boolean; nearY: boolean } {
    return {
      nearX: Math.abs(Math.abs(point.x - image.centerX) - image.displayWidth / 2) <= handleRadius,
      nearY: Math.abs(Math.abs(point.y - image.centerY) - image.displayHeight / 2) <= handleRadius,
    };
  }
}
