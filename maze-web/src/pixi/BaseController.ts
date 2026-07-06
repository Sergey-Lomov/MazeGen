import type { Container } from "pixi.js";
import type { FieldEdge } from "./fieldEditUtils";

export abstract class BaseController {
  protected getViewport: () => Container;
  protected onViewportPan: (x: number, y: number) => void;

  private isPanning = false;
  private panStart = { x: 0, y: 0 };
  private vpStart = { x: 0, y: 0 };

  private dragActive = false;
  private dragVisited = new Set<string>();

  protected draggingMarker: "set_start" | "set_finish" | null = null;

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
    if (button === 0) this.releaseMarkerDrag();
  }

  /** Only bookkeeping for "have we already painted this edge in the current drag gesture" —
   * does not touch the store, does not decide which tool is active, does not trigger a redraw.
   * Callers own the store action and any visual update via `onNewEdge`. */
  protected beginEdgeDrag(edgeKey: string): void {
    this.dragActive = true;
    this.dragVisited = new Set([edgeKey]);
  }

  protected continueEdgeDrag(edge: FieldEdge | null, onNewEdge: (edge: FieldEdge) => void): void {
    if (this.dragActive && edge && !this.dragVisited.has(edge.key)) {
      this.dragVisited.add(edge.key);
      onNewEdge(edge);
    }
  }

  /** Idempotent — safe to call even when no drag was active. Callers that need to react to
   * "a drag just ended" (e.g. scheduling an auto-confirm) must check `isDragActive` themselves
   * before calling this, since this only clears bookkeeping and has no other side effect. */
  protected endEdgeDrag(): void {
    this.dragActive = false;
    this.dragVisited.clear();
  }

  protected get isDragActive(): boolean {
    return this.dragActive;
  }

  /** Marker drag and teleport-endpoint drag (the latter only in PresetConnectionsController) are
   * mutually exclusive by construction — a single pointerdown handler checks them as sequential
   * if/else-if branches, so at most one is ever armed. BaseController has no visibility into
   * PresetConnectionsController's `draggingTeleportEndpoint` field, so this is not runtime-enforced
   * here; callers must preserve that sequential branch order. */
  protected armMarkerDrag(marker: "set_start" | "set_finish"): void {
    this.draggingMarker = marker;
  }

  protected releaseMarkerDrag(): void {
    this.draggingMarker = null;
  }

  abstract clearHover(): void;
}
