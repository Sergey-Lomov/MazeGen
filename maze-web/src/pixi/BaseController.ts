import type { Container } from "pixi.js";

export abstract class BaseController {
  protected getViewport: () => Container;
  protected onViewportPan: (x: number, y: number) => void;

  private isPanning = false;
  private panStart = { x: 0, y: 0 };
  private vpStart = { x: 0, y: 0 };

  constructor(getViewport: () => Container, onViewportPan: (x: number, y: number) => void) {
    this.getViewport = getViewport;
    this.onViewportPan = onViewportPan;
  }

  protected toViewport(canvasX: number, canvasY: number): { x: number; y: number } {
    const vp = this.getViewport();
    return {
      x: (canvasX - vp.x) / vp.scale.x,
      y: (canvasY - vp.y) / vp.scale.y,
    };
  }

  protected tryStartPan(canvasX: number, canvasY: number, button: number): boolean {
    if (button !== 1) return false;
    const vp = this.getViewport();
    this.isPanning = true;
    this.panStart = { x: canvasX, y: canvasY };
    this.vpStart = { x: vp.x, y: vp.y };
    return true;
  }

  protected handlePanMove(canvasX: number, canvasY: number): boolean {
    if (!this.isPanning) return false;
    const dx = canvasX - this.panStart.x;
    const dy = canvasY - this.panStart.y;
    this.onViewportPan(this.vpStart.x + dx, this.vpStart.y + dy);
    return true;
  }

  onPointerUp(button: number): void {
    if (button === 1) this.isPanning = false;
  }

  abstract clearHover(): void;
}
