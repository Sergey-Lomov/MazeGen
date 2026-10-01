import { makeProjection, type TessellationProjection } from "./tessellationProjection";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

/** The small viewport surface controllers need from Pixi. Keeping this structural makes the
 * pointer primitives usable in unit tests and independent from either editor renderer. */
export interface PointerViewport {
  x: number;
  y: number;
  scale: { x: number; y: number };
}

export interface HoverResetTargets {
  updateHover: (edge: null) => void;
  updateCellHover?: (cell: null) => void;
  updateTeleportPreview?: (point: null, x: number, y: number) => void;
}

export function toViewportCoordinates(
  canvasX: number,
  canvasY: number,
  viewport: PointerViewport,
): { x: number; y: number } {
  return {
    x: (canvasX - viewport.x) / viewport.scale.x,
    y: (canvasY - viewport.y) / viewport.scale.y,
  };
}

export function pointerCellAt(
  projection: TessellationProjection,
  viewportX: number,
  viewportY: number,
): [number, number] {
  const cell = projection.screenToGrid(viewportX, viewportY);
  return [cell.x, cell.y];
}

export function pointerCellAtConfig(
  cfg: TessellationConfig,
  viewportX: number,
  viewportY: number,
): [number, number] {
  return pointerCellAt(makeProjection(cfg), viewportX, viewportY);
}

/** Domain controllers provide their own modal predicates; this helper only owns the common
 * "any blocking prompt means pointer input is inert" rule. */
export function isPointerModalOpen(...guards: readonly boolean[]): boolean {
  return guards.some(Boolean);
}

export function resetPointerHover(targets: HoverResetTargets): void {
  targets.updateHover(null);
  targets.updateCellHover?.(null);
  targets.updateTeleportPreview?.(null, 0, 0);
}

/** Finds the nearest candidate that passes the caller's domain-specific hit predicate. The
 * candidate model is deliberately generic: preset endpoints use cell coordinates while post-edit
 * endpoints use resolved node coordinates, with no cross-feature endpoint types here. */
export function pickNearestPointerHit<T>(
  pointerX: number,
  pointerY: number,
  candidates: readonly T[],
  getPosition: (candidate: T) => { x: number; y: number } | null,
  isHit: (candidate: T, distanceSq: number) => boolean = () => true,
): T | null {
  let best: T | null = null;
  let bestDistanceSq = Infinity;
  for (const candidate of candidates) {
    const position = getPosition(candidate);
    if (position === null) continue;
    const dx = position.x - pointerX;
    const dy = position.y - pointerY;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq < bestDistanceSq && isHit(candidate, distanceSq)) {
      bestDistanceSq = distanceSq;
      best = candidate;
    }
  }
  return best;
}

/** Shared visited-target bookkeeping for edge and cell strokes. Store mutations stay in the
 * feature controller; this class only guarantees one callback per target and locks a gesture to
 * the kind selected at pointerdown. */
export class PointerDragTracker {
  private activeKind: "edge" | "cell" | null = null;
  private visited = new Set<string>();

  begin(kind: "edge" | "cell", key: string): void {
    this.activeKind = kind;
    this.visited = new Set([key]);
  }

  dispatch<T>(kind: "edge" | "cell", key: string, value: T, onNew: (value: T) => void): void {
    if (this.activeKind !== kind || this.visited.has(key)) return;
    this.visited.add(key);
    onNew(value);
  }

  end(): void {
    this.activeKind = null;
    this.visited.clear();
  }

  get active(): boolean { return this.activeKind !== null; }
  get isEdge(): boolean { return this.activeKind === "edge"; }
  get isCell(): boolean { return this.activeKind === "cell"; }
}

export function cancelPendingPointerAction<T>(
  pending: T | null | undefined,
  cancel: () => void,
  clearPreview?: () => void,
): boolean {
  if (pending == null) return false;
  cancel();
  clearPreview?.();
  return true;
}
