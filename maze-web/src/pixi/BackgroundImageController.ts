import { useMazeStore } from "../store/mazeStore";
import type { BackgroundImage } from "../store/tessellationTypes";
import {
  backgroundImageCrop,
  backgroundImageFullCenter,
  backgroundImageSourceScale,
} from "./BackgroundImageLayer";
import type { PointerHandler } from "./sceneTypes";

type ViewportLike = { x: number; y: number; scale: { x: number; y: number } };
type Drag =
  | { kind: "move"; startX: number; startY: number; image: BackgroundImage }
  | { kind: "resize"; startX: number; startY: number; image: BackgroundImage; sideX: -1 | 0 | 1; sideY: -1 | 0 | 1 }
  | { kind: "cropMove"; startX: number; startY: number; image: BackgroundImage }
  | { kind: "cropResize"; startX: number; startY: number; image: BackgroundImage; sideX: -1 | 0 | 1; sideY: -1 | 0 | 1 };

/** Pointer handler for the shared underlay's Transform and Crop modes (GitHub issues #674/#680). */
export class BackgroundImageController implements PointerHandler {
  private drag: Drag | null = null;

  constructor(private readonly getViewport: () => ViewportLike) {}

  onPointerDown(canvasX: number, canvasY: number, button: number, _shiftKey?: boolean): void {
    if (button !== 0) return;
    const state = useMazeStore.getState();
    const image = state.backgroundImage;
    if (!state.showBackgroundImage || !image) return;

    const mode = state.backgroundImageCropping ? "crop" : state.backgroundImageManualPositioning ? "transform" : null;
    if (mode === null) return;
    const point = this.toWorld(canvasX, canvasY);
    const { nearX, nearY } = this.getHandleHit(point, image, this.getHandleRadius());

    if (mode === "crop") {
      const scale = backgroundImageSourceScale(image);
      const fullCenter = backgroundImageFullCenter(image);
      const insideFull = Math.abs(point.x - fullCenter.x) <= image.naturalWidth * scale / 2
        && Math.abs(point.y - fullCenter.y) <= image.naturalHeight * scale / 2;
      if (!insideFull && !(nearX || nearY)) {
        state.setBackgroundImageCropping(false);
        return;
      }
      this.drag = nearX || nearY
        ? {
            kind: "cropResize",
            startX: point.x,
            startY: point.y,
            image,
            sideX: nearX ? (point.x >= image.centerX ? 1 : -1) : 0,
            sideY: nearY ? (point.y >= image.centerY ? 1 : -1) : 0,
          }
        : { kind: "cropMove", startX: point.x, startY: point.y, image };
      return;
    }

    const halfWidth = image.displayWidth / 2;
    const halfHeight = image.displayHeight / 2;
    const handleRadius = this.getHandleRadius();
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

    if (this.drag.kind === "resize") {
      const resizeFactor = shiftKey ? 2 : 1;
      const widthScale = this.drag.sideX === 0 ? 1
        : (image.displayWidth + (point.x - this.drag.startX) * this.drag.sideX * resizeFactor) / image.displayWidth;
      const heightScale = this.drag.sideY === 0 ? 1
        : (image.displayHeight + (point.y - this.drag.startY) * this.drag.sideY * resizeFactor) / image.displayHeight;
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
      return;
    }

    const crop = backgroundImageCrop(image);
    const sourceScale = backgroundImageSourceScale(image);
    if (this.drag.kind === "cropMove") {
      const nextX = clamp(crop.x - (point.x - this.drag.startX) / sourceScale, 0, image.naturalWidth - crop.width);
      const nextY = clamp(crop.y - (point.y - this.drag.startY) / sourceScale, 0, image.naturalHeight - crop.height);
      useMazeStore.getState().setBackgroundImage({
        ...image,
        cropX: nextX,
        cropY: nextY,
        cropWidth: crop.width,
        cropHeight: crop.height,
      });
      return;
    }

    let left = crop.x;
    let right = crop.x + crop.width;
    let top = crop.y;
    let bottom = crop.y + crop.height;
    if (this.drag.sideX !== 0) {
      const delta = (point.x - this.drag.startX) / sourceScale;
      if (this.drag.sideX < 0) left = clamp(crop.x + delta, 0, right - 1);
      else right = clamp(crop.x + crop.width + delta, left + 1, image.naturalWidth);
    }
    if (this.drag.sideY !== 0) {
      const delta = (point.y - this.drag.startY) / sourceScale;
      if (this.drag.sideY < 0) top = clamp(crop.y + delta, 0, bottom - 1);
      else bottom = clamp(crop.y + crop.height + delta, top + 1, image.naturalHeight);
    }
    if (shiftKey) {
      if (this.drag.sideX !== 0) {
        const center = crop.x + crop.width / 2;
        const requestedHalf = this.drag.sideX < 0 ? center - left : right - center;
        const half = Math.min(requestedHalf, center, image.naturalWidth - center);
        left = center - half;
        right = center + half;
      }
      if (this.drag.sideY !== 0) {
        const center = crop.y + crop.height / 2;
        const requestedHalf = this.drag.sideY < 0 ? center - top : bottom - center;
        const half = Math.min(requestedHalf, center, image.naturalHeight - center);
        top = center - half;
        bottom = center + half;
      }
    }
    const nextCrop = {
      cropX: left,
      cropY: top,
      cropWidth: right - left,
      cropHeight: bottom - top,
    };
    const fullCenter = backgroundImageFullCenter(image);
    const nextCenterX = fullCenter.x + (left + nextCrop.cropWidth / 2 - image.naturalWidth / 2) * sourceScale;
    const nextCenterY = fullCenter.y + (top + nextCrop.cropHeight / 2 - image.naturalHeight / 2) * sourceScale;
    useMazeStore.getState().setBackgroundImage({
      ...image,
      ...nextCrop,
      centerX: nextCenterX,
      centerY: nextCenterY,
      displayWidth: nextCrop.cropWidth * sourceScale,
      displayHeight: nextCrop.cropHeight * sourceScale,
    });
  }

  getCursor(canvasX: number, canvasY: number): string {
    const state = useMazeStore.getState();
    const image = state.backgroundImage;
    const mode = state.backgroundImageCropping ? "crop" : state.backgroundImageManualPositioning ? "transform" : null;
    if (!state.showBackgroundImage || mode === null || !image) return "";
    const point = this.toWorld(canvasX, canvasY);
    const handleRadius = this.getHandleRadius();
    const { nearX, nearY } = this.getHandleHit(point, image, handleRadius);
    if (nearX && nearY) {
      return (point.x - image.centerX) * (point.y - image.centerY) >= 0 ? "nwse-resize" : "nesw-resize";
    }
    if (nearX) return "ew-resize";
    if (nearY) return "ns-resize";
    if (mode === "crop") {
      const scale = backgroundImageSourceScale(image);
      const fullCenter = backgroundImageFullCenter(image);
      return Math.abs(point.x - fullCenter.x) <= image.naturalWidth * scale / 2
        && Math.abs(point.y - fullCenter.y) <= image.naturalHeight * scale / 2 ? "move" : "default";
    }
    const halfWidth = image.displayWidth / 2;
    const halfHeight = image.displayHeight / 2;
    return Math.abs(point.x - image.centerX) <= halfWidth && Math.abs(point.y - image.centerY) <= halfHeight
      ? "move" : "default";
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
