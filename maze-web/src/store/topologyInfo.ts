import { configAllCells } from "../pixi/tessellationCells";
import { getTopologyInfo, type TopologyFloorRequest, type TopologyInfo } from "../wasm/mazeService";
import type { WireFoldEnd, WireTopology } from "../wasm/types";
import type { TopologyProblem } from "./topologyProblem";
import { floorTessellationOf } from "./storeHelpers";
import type { MazeState } from "./storeTypes";

/// The state a floor's topology request is built from.
export type TopologyInputs = Pick<
  MazeState,
  "tessellationKind" | "tessellationParams" | "hexOrientation" | "triOrientation" | "floorFields" | "smoothPrimitives" | "floorTopology"
>;

export function floorTopologyRequest(state: TopologyInputs, floorId: string): TopologyFloorRequest {
  const cfg = floorTessellationOf(state, floorId);
  return {
    tessellation: cfg.tessellation,
    field_cells: configAllCells(cfg, state.smoothPrimitives),
    topology: state.floorTopology[floorId] ?? null,
  };
}

export type FloorTopologyInfo = { ok: true; info: TopologyInfo } | { ok: false; error: string };

const memo = new Map<string, { refs: readonly unknown[]; value: FloorTopologyInfo }>();
const MEMO_LIMIT = 32;

/// Activity and contours of one floor, recomputed by core only when the
/// floor's topology, field or tessellation changed (compared by reference). An undecidable floor
/// (the topology no longer fits the tessellation) is `{ ok: false, error }`, never a throw.
export function floorTopologyInfo(state: TopologyInputs, floorId: string): FloorTopologyInfo {
  const field = state.floorFields[floorId];
  if (!field) return { ok: false, error: "unknown floor" };
  const refs = [
    state.floorTopology[floorId],
    field.fieldPoints,
    field.fieldConfig,
    field.isEditingField,
    state.tessellationKind,
    state.tessellationParams,
    state.hexOrientation,
    state.triOrientation,
    state.smoothPrimitives,
  ];
  const cached = memo.get(floorId);
  if (cached && cached.refs.length === refs.length && cached.refs.every((ref, i) => ref === refs[i])) return cached.value;
  let value: FloorTopologyInfo;
  try {
    value = { ok: true, info: getTopologyInfo(floorTopologyRequest(state, floorId)) };
  } catch (error) {
    value = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  // Deleted floors never ask again: the oldest entries go first (Map keeps insertion order).
  memo.delete(floorId);
  memo.set(floorId, { refs, value });
  if (memo.size > MEMO_LIMIT) memo.delete(memo.keys().next().value!);
  return value;
}

export function clearTopologyInfoMemo(): void {
  memo.clear();
}

/// Number of folds of a floor that currently glue nothing.
export function inactiveFoldCount(result: FloorTopologyInfo): number {
  return result.ok ? result.info.activity.filter((activity) => activity.state === "inactive").length : 0;
}

/// A run dragged on a boundary contour: from `start` forward (contour order) to `end`, wrapping
/// around the contour's end.
export interface TopologyRunRange {
  contour: number;
  start: number;
  end: number;
}

/// A run given as explicit faces in run order: how an existing glue is loaded into the editor
/// (its sides need not be consecutive boundary faces any more).
export interface TopologyRunFaces {
  faces: WireFoldEnd[];
}

export type TopologyRunSelection = TopologyRunRange | TopologyRunFaces;

/// The consecutive boundary faces of a selection, or `null` when there is none or it does not fit
/// the contours.
export function selectionRun(selection: TopologyRunSelection | null, contours: readonly (readonly WireFoldEnd[])[]): WireFoldEnd[] | null {
  if (selection === null) return null;
  if ("faces" in selection) return selection.faces.length > 0 ? selection.faces : null;
  const faces = contours[selection.contour];
  if (!faces || selection.start >= faces.length || selection.end >= faces.length) return null;
  const length = ((selection.end - selection.start + faces.length) % faces.length) + 1;
  return Array.from({ length }, (_, i) => faces[(selection.start + i) % faces.length]);
}

/// The shortest run between the drag's `anchor` face and the face `hit` under the pointer, on one
/// contour of `length` faces.
export function dragRun(contour: number, length: number, anchor: number, hit: number): TopologyRunRange {
  const forward = (hit - anchor + length) % length;
  return forward <= length - forward ? { contour, start: anchor, end: hit } : { contour, start: hit, end: anchor };
}

const faceKey = (end: WireFoldEnd) => `${end.cell[0]},${end.cell[1]}:${end.face_idx}`;

/// The first problem of the two picked runs (either may still be missing): sides in both runs,
/// runs of different sizes, or sides already glued by an existing fold. Checked before core is
/// asked, so the panel can name the sides. The folds of `ignoredGroup` (the glue being edited)
/// do not count as used.
export function glueDraftProblem(
  a: readonly WireFoldEnd[] | null,
  b: readonly WireFoldEnd[] | null,
  topology: WireTopology | undefined,
  ignoredGroup: number | null = null,
): TopologyProblem | null {
  if (a && b) {
    const inA = new Set(a.map(faceKey));
    const shared = b.filter((end) => inA.has(faceKey(end)));
    if (shared.length > 0) return { code: "overlap", sides: shared };
    if (a.length !== b.length) return { code: "run_length_mismatch", a: a.length, b: b.length };
  }
  const ignored = new Set(topology?.groups.find((group) => group.id === ignoredGroup)?.folds ?? []);
  const used = new Set((topology?.folds ?? []).flatMap((fold, index) => ignored.has(index) ? [] : [faceKey(fold.a), faceKey(fold.b)]));
  const usedSides = [...(a ?? []), ...(b ?? [])].filter((end) => used.has(faceKey(end)));
  return usedSides.length > 0 ? { code: "used", sides: usedSides } : null;
}
