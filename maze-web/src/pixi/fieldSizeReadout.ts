import type { FieldPrimitive } from "../store/tessellationTypes";

/** Extent of a set of field cells: grid-span `width` x `height` (distinct x / y range, inclusive)
 *  and the total cell `count`. */
export interface FieldCellsSize {
  width: number;
  height: number;
  count: number;
}

/** Size of the shape being stretched, tagged with the primitive that produced it. */
export interface FieldShapeSize extends FieldCellsSize {
  primitive: FieldPrimitive;
}

/** Status-bar geometry readout of the field editor (GitHub issue #863): the persistent/pending
 *  selection and the shape primitive currently being stretched. `null` = nothing to show. */
export interface FieldSizeReadout {
  selection: FieldCellsSize | null;
  shape: FieldShapeSize | null;
}

export const EMPTY_FIELD_SIZE_READOUT: FieldSizeReadout = { selection: null, shape: null };

export function measureCells(cells: readonly (readonly [number, number])[]): FieldCellsSize | null {
  if (cells.length === 0) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of cells) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { width: maxX - minX + 1, height: maxY - minY + 1, count: cells.length };
}

export function formatCellsSize(size: FieldCellsSize): string {
  return `${size.width}×${size.height} (${size.count})`;
}

/** Measures `cells` and tags the result with the producing `primitive`. */
export function measureShape(cells: readonly (readonly [number, number])[], primitive: FieldPrimitive): FieldShapeSize | null {
  const size = measureCells(cells);
  return size && { ...size, primitive };
}

function sameSize(a: FieldCellsSize | null, b: FieldCellsSize | null): boolean {
  return a === b || (a !== null && b !== null && a.width === b.width && a.height === b.height && a.count === b.count);
}

function sameShape(a: FieldShapeSize | null, b: FieldShapeSize | null): boolean {
  return sameSize(a, b) && a?.primitive === b?.primitive;
}

/** Applies a partial update (`undefined` keeps the previous value). Returns `prev` itself when
 *  nothing changed, so callers can skip notifying on identical values. */
export function mergeFieldSizeReadout(prev: FieldSizeReadout, update: Partial<FieldSizeReadout>): FieldSizeReadout {
  const selection = update.selection !== undefined ? update.selection : prev.selection;
  const shape = update.shape !== undefined ? update.shape : prev.shape;
  if (sameSize(selection, prev.selection) && sameShape(shape, prev.shape)) return prev;
  return { selection, shape };
}
