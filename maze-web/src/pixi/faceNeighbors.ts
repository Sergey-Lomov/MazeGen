import type { FieldConfig } from "../fieldConfig";
import { getSeamModel } from "./selectors/seams";
import { getNeighborData } from "./tessellationGeometry";

/// The single TS-side neighbor resolver for split logic. A face glued by a topology seam resolves to
/// its seam partner cell (`getSeamModel`: `halfEdgeAt` + `partnerOf`); any other face resolves by the
/// tessellation offset. Split code never decides adjacency from raw offsets plus an in-field check:
/// that reads a glued face as a field edge (`Specs/topology.md`, "Seam rendering model").

/// One face of a cell: the in-field cell across it, or `null` when the face is a field edge.
export type FaceNeighbor = [number, number] | null;

/// The cell across face `faceIdx` of `point` (seam partner or base offset), whether or not it is in
/// the field; `null` when the cell has no such face.
export function faceNeighborCell(
  cfg: FieldConfig,
  point: readonly [number, number],
  faceIdx: number,
): [number, number] | null {
  const half = getSeamModel(cfg).halfEdgeAt(point, faceIdx);
  if (half !== null) return [half.partnerCell[0], half.partnerCell[1]];
  const offset = getNeighborData(cfg, point[0], point[1]).offsets[faceIdx];
  return offset === undefined ? null : [point[0] + offset[0], point[1] + offset[1]];
}

/// The cell across every face of `point`, in `getNeighborData`'s face order, in the field or not.
export function faceNeighborCells(cfg: FieldConfig, point: readonly [number, number]): [number, number][] {
  const { offsets } = getNeighborData(cfg, point[0], point[1]);
  const seams = getSeamModel(cfg);
  return offsets.map(([dx, dy], faceIdx): [number, number] => {
    const half = seams.halfEdgeAt(point, faceIdx);
    return half !== null ? [half.partnerCell[0], half.partnerCell[1]] : [point[0] + dx, point[1] + dy];
  });
}

/// The face of `point` whose neighbor cell is `other`, or -1 when `other` shares no face with it.
/// When two faces lead to the same cell (a seam wrapping a one-cell-wide field) the first wins.
export function faceIndexTo(cfg: FieldConfig, point: readonly [number, number], other: readonly [number, number]): number {
  return faceNeighborCells(cfg, point).findIndex(([x, y]) => x === other[0] && y === other[1]);
}

/// The neighbor across face `faceIdx` of `point`, in `getNeighborData`'s face order. `inFieldCells`
/// holds `"x,y"` keys of the cells of the field.
export function resolveFaceNeighbor(
  cfg: FieldConfig,
  point: readonly [number, number],
  faceIdx: number,
  inFieldCells: ReadonlySet<string>,
): FaceNeighbor {
  const neighbor = faceNeighborCell(cfg, point, faceIdx);
  return neighbor !== null && inFieldCells.has(`${neighbor[0]},${neighbor[1]}`) ? neighbor : null;
}


/// Every face's neighbor of `point`, in `getNeighborData`'s face order.
export function resolveFaceNeighbors(
  cfg: FieldConfig,
  point: readonly [number, number],
  inFieldCells: ReadonlySet<string>,
): FaceNeighbor[] {
  return faceNeighborCells(cfg, point).map((neighbor) => (inFieldCells.has(`${neighbor[0]},${neighbor[1]}`) ? neighbor : null));
}
