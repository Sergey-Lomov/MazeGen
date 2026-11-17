import type { FieldConfig } from "../fieldConfig";
import type { Pos } from "./tessellationGeometry";
import type { SeamPair, SeamSlot } from "./selectors/seamArrows";
import { getSeamModel } from "./selectors/seams";

/// The seam-aware part of the node-to-node overlays (nav graph, analytics, sequence and map
/// highlight; `Specs/topology.md`, "Classification of elements"). A hop between two glued cells is
/// not a straight line between their centers: it would cross the whole field. It is drawn as two stubs:
/// one from the source node to its face's slot on the contour of the glue, and one from the partner
/// face's slot to the target node. Nothing is drawn between the slots; they are the points where the
/// seam renderer marks the two ends of the glue. Pure: the context is built by `selectSeamHopContext`.

/// What tells a hop between two glued cells from an ordinary one: the glued pairs of the field by seam index.
export interface SeamPairsContext {
  cfg: FieldConfig;
  pairs: ReadonlyMap<number, SeamPair>;
}

/// `SeamPairsContext` for hops between nodes.
export interface SeamHopContext extends SeamPairsContext {
  /// The cell of a node id, or `undefined` when unknown.
  cellOf: (nodeId: number) => [number, number] | undefined;
}

/// One drawn piece of a hop: `path` in flow order, trimmed at a node end only (a slot end is open).
export interface HopPiece {
  path: Pos[];
  trimStart: boolean;
  trimEnd: boolean;
}

/// The slots a hop from `fromId` to `toId` leaves by and enters through, or `null` for an ordinary hop.
export function seamHopSlots(fromId: number, toId: number, ctx: SeamHopContext): [SeamSlot, SeamSlot] | null {
  const fromCell = ctx.cellOf(fromId);
  const toCell = ctx.cellOf(toId);
  return fromCell && toCell ? seamCellSlots(fromCell, toCell, ctx) : null;
}

/// The slots a hop from cell `fromCell` to `toCell` through a seam leaves by and enters through, or `null` for an
/// ordinary hop.
export function seamCellSlots(fromCell: readonly [number, number], toCell: readonly [number, number], ctx: SeamPairsContext): [SeamSlot, SeamSlot] | null {
  const seams = getSeamModel(ctx.cfg);
  if (seams.isEmpty) return null;
  const half = seams.halfEdgeBetween(fromCell, toCell);
  const pair = half ? ctx.pairs.get(half.seam) : undefined;
  if (!half || !pair) return null;
  const outSlot = pair.slots.find((slot) => slot.cell[0] === fromCell[0] && slot.cell[1] === fromCell[1] && slot.faceIdx === half.faceIdx);
  const inSlot = pair.slots.find((slot) => slot !== outSlot);
  return outSlot && inSlot ? [outSlot, inSlot] : null;
}

/// The two stubs of a hop from `fromId` to `toId` through a seam, or `null` for an ordinary hop.
export function seamHopPieces(fromId: number, toId: number, nodePos: ReadonlyMap<number, Pos>, ctx: SeamHopContext): [HopPiece, HopPiece] | null {
  const slots = seamHopSlots(fromId, toId, ctx);
  const from = nodePos.get(fromId);
  const to = nodePos.get(toId);
  if (!slots || !from || !to) return null;
  return [
    { path: [from, slotPos(slots[0])], trimStart: true, trimEnd: false },
    { path: [slotPos(slots[1]), to], trimStart: false, trimEnd: true },
  ];
}

/// The pieces of one hop: its stubs through a seam, or the single straight line between the nodes.
export function hopPieces(fromId: number, toId: number, nodePos: ReadonlyMap<number, Pos>, ctx: SeamHopContext | undefined): HopPiece[] {
  const seam = ctx ? seamHopPieces(fromId, toId, nodePos, ctx) : null;
  if (seam) return seam;
  const from = nodePos.get(fromId);
  const to = nodePos.get(toId);
  return from && to ? [{ path: [from, to], trimStart: true, trimEnd: true }] : [];
}

/// A highlighted node-to-node line of a hop through `slots`, split at the seam into its two stubs: node to the first
/// slot, second slot to node (the slot ends carry no node marker). The line itself for an ordinary hop (`slots` null).
export function seamStubHighlights<T extends { from: Pos; to: Pos; fromMarker?: boolean; toMarker?: boolean }>(line: T, slots: readonly [SeamSlot, SeamSlot] | null): T[] {
  if (!slots) return [line];
  return [
    { ...line, to: slotPos(slots[0]), toMarker: false },
    { ...line, from: slotPos(slots[1]), fromMarker: false },
  ];
}

const slotPos = (slot: SeamSlot): Pos => ({ x: slot.at[0], y: slot.at[1] });
