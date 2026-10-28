import type { FieldConfig } from "../../fieldConfig";
import type { FoldFace, SegmentDto, WorldPoint } from "../../wasm/mazeService";
import { getCellGeometry, getFieldVersion, getTopologyVersion, isCacheWarmFor } from "../cartesianCache";
import { configAllCells } from "../tessellationCells";
import { flattenSegments } from "../geometry/pathFlatten";

/// Rendering data model of topology seams (GitHub issue #840, `Specs/topology.md`, "Seam rendering
/// model"). Pure: built from the geometry snapshot's `faces[].fold` and nothing else, so the canvas
/// and every export read one source and never derive a partner, a correspondence or an orientation
/// from coordinates. All coordinates are core's world units (the display transform is the caller's).

/// Affine `[a, b, c, d, e, f]`: `x' = a*x + c*y + e`, `y' = b*x + d*y + f`.
export type Affine = [number, number, number, number, number, number];

/// The part of a cell's snapshot entry the model reads (a `CellGeometryEntry` satisfies it).
export interface SeamCellInput {
  cell: [number, number];
  center: WorldPoint;
  faces: { contact_point: WorldPoint; segments: SegmentDto[]; fold?: FoldFace | null }[];
}

export type SeamSideName = "a" | "b";

/// One side of a seam: the glued face as its own cell sees it, unpaired. A passage, wall or arrow
/// that crosses the seam is drawn as one half per side, so this is the unit a renderer draws.
export interface HalfEdge {
  /// Index of the seam in `SeamModel.seams`.
  seam: number;
  side: SeamSideName;
  cell: [number, number];
  /// The face's position in the cell's `faces_of` (the order of the snapshot's `faces`).
  faceIdx: number;
  /// The cell's center: the inner end of a half corridor, whose outer end is `contact`.
  center: WorldPoint;
  /// Where a passage crosses the face; the face's own contact point, not shared with the partner.
  contact: WorldPoint;
  /// The face's own segments, counter-clockwise along its cell.
  segments: SegmentDto[];
  partnerCell: [number, number];
  partnerFaceIdx: number;
  /// Maps the partner's face geometry into this cell's coordinates; `null` for a topological-only
  /// seam (no common geometry).
  fromPartner: Affine | null;
}

/// Which end of the other side's chain an end of this side's chain meets.
export interface EndpointPair {
  a: "start" | "end";
  b: "start" | "end";
}

export interface Seam {
  /// The fold's index in the topology the snapshot was built with.
  fold: number;
  /// The sides in a fixed order: `a` is the lexicographically smaller `(x, y, faceIdx)`.
  a: HalfEdge;
  b: HalfEdge;
  twist: boolean;
  /// Chirality change across the seam (`Orientation.flips`): equal to `twist`.
  flips: boolean;
  /// `false` for a topological-only seam: both sides exist, but there is no transform and no
  /// point correspondence beyond the chain ends.
  isometric: boolean;
  /// The endpoint correspondence: `a`'s chain start meets `b`'s chain `startMeets` end, and the
  /// remaining ends meet each other. Untwisted: start-end, end-start. Twisted: start-start, end-end.
  endpoints: [EndpointPair, EndpointPair];
}

export interface SeamModel {
  seams: readonly Seam[];
  isEmpty: boolean;
  /// The half-edge of `cell`'s face `faceIdx`, or `null` when that face is not glued.
  halfEdgeAt(cell: readonly [number, number], faceIdx: number): HalfEdge | null;
  /// The half-edge of `from` through which a passage to `to` crosses a seam, or `null` when the two
  /// cells are not glued (they may still be ordinary neighbors).
  halfEdgeBetween(from: readonly [number, number], to: readonly [number, number]): HalfEdge | null;
  /// The other side of the seam.
  partnerOf(half: HalfEdge): HalfEdge;
  /// Every half-edge of `cell`.
  halfEdgesOf(cell: readonly [number, number]): readonly HalfEdge[];
}

const EMPTY_MODEL: SeamModel = {
  seams: [],
  isEmpty: true,
  halfEdgeAt: () => null,
  halfEdgeBetween: () => null,
  partnerOf: () => {
    throw new Error("an empty seam model has no half-edges");
  },
  halfEdgesOf: () => [],
};

const cellKey = (cell: readonly [number, number]): string => `${cell[0]},${cell[1]}`;
const faceKey = (cell: readonly [number, number], faceIdx: number): string => `${cell[0]},${cell[1]}#${faceIdx}`;

function precedes(a: { cell: readonly [number, number]; faceIdx: number }, b: { cell: readonly [number, number]; faceIdx: number }): boolean {
  return a.cell[0] !== b.cell[0] ? a.cell[0] < b.cell[0] : a.cell[1] !== b.cell[1] ? a.cell[1] < b.cell[1] : a.faceIdx < b.faceIdx;
}

/// Builds the model from the cells of a geometry snapshot (any superset of the glued cells: a fold
/// whose partner is not among `cells` is skipped). Deterministic: seams ascend by fold index.
export function buildSeamModel(cells: readonly SeamCellInput[]): SeamModel {
  const byCell = new Map<string, SeamCellInput>();
  for (const entry of cells) byCell.set(cellKey(entry.cell), entry);

  const sides: { fold: number; half: Omit<HalfEdge, "seam" | "side">; data: FoldFace }[] = [];
  for (const entry of cells) {
    entry.faces.forEach((face, faceIdx) => {
      const fold = face.fold;
      if (!fold || !byCell.has(cellKey(fold.partner_cell))) return;
      sides.push({
        fold: fold.fold,
        data: fold,
        half: {
          cell: entry.cell,
          faceIdx,
          center: entry.center,
          contact: face.contact_point,
          segments: face.segments,
          partnerCell: fold.partner_cell,
          partnerFaceIdx: fold.partner_face_idx,
          fromPartner: fold.transform,
        },
      });
    });
  }

  const byFold = new Map<number, typeof sides>();
  for (const side of sides) byFold.set(side.fold, [...(byFold.get(side.fold) ?? []), side]);

  const seams: Seam[] = [];
  for (const fold of [...byFold.keys()].sort((x, y) => x - y)) {
    const pair = byFold.get(fold)!;
    if (pair.length !== 2) continue;
    const [first, second] = precedes(pair[0].half, pair[1].half) ? pair : [pair[1], pair[0]];
    const index = seams.length;
    const a: HalfEdge = { ...first.half, seam: index, side: "a" };
    const b: HalfEdge = { ...second.half, seam: index, side: "b" };
    const { twist, isometric, start_meets: startMeets } = first.data;
    const otherEnd = startMeets === "start" ? "end" : "start";
    seams.push({
      fold,
      a,
      b,
      twist,
      flips: twist,
      isometric,
      endpoints: [
        { a: "start", b: startMeets },
        { a: "end", b: otherEnd },
      ],
    });
  }

  if (seams.length === 0) return EMPTY_MODEL;

  const byFace = new Map<string, HalfEdge>();
  const byOwner = new Map<string, HalfEdge[]>();
  for (const seam of seams) {
    for (const half of [seam.a, seam.b]) {
      byFace.set(faceKey(half.cell, half.faceIdx), half);
      const key = cellKey(half.cell);
      byOwner.set(key, [...(byOwner.get(key) ?? []), half]);
    }
  }
  return {
    seams,
    isEmpty: false,
    halfEdgeAt: (cell, faceIdx) => byFace.get(faceKey(cell, faceIdx)) ?? null,
    halfEdgeBetween: (from, to) =>
      (byOwner.get(cellKey(from)) ?? []).find((half) => half.partnerCell[0] === to[0] && half.partnerCell[1] === to[1]) ?? null,
    partnerOf: (half) => {
      const seam = seams[half.seam];
      return half.side === "a" ? seam.b : seam.a;
    },
    halfEdgesOf: (cell) => byOwner.get(cellKey(cell)) ?? [],
  };
}

/// The fraction (0 = chain start, 1 = chain end) of the partner's face that meets this side's
/// fraction `t`: arc length runs the same way when the starts meet (twisted), the opposite way
/// otherwise.
export function partnerFraction(seam: Seam, t: number): number {
  return seam.endpoints[0].b === "start" ? t : 1 - t;
}

const FLATTEN_TOLERANCE = 1e-3;
const flattened = new WeakMap<HalfEdge, WorldPoint[]>();

/// The point at arc-length fraction `t` of a half-edge's own face chain, in its cell's coordinates.
export function pointOnHalfEdge(half: HalfEdge, t: number): WorldPoint {
  let points = flattened.get(half);
  if (!points) {
    points = flattenSegments(half.segments, FLATTEN_TOLERANCE);
    flattened.set(half, points);
  }
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  let remaining = Math.min(Math.max(t, 0), 1) * total;
  for (let i = 1; i < points.length; i++) {
    const length = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    if (remaining <= length || i === points.length - 1) {
      const u = length === 0 ? 0 : remaining / length;
      return [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * u, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * u];
    }
    remaining -= length;
  }
  return points[0];
}

export function applyAffine(m: Affine, [x, y]: WorldPoint): WorldPoint {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/// Where the partner's point at the matching fraction lands in this side's cell coordinates:
/// the seam's point correspondence for an isometric seam, `null` otherwise.
export function partnerPointInOwnCell(seam: Seam, half: HalfEdge, t: number): WorldPoint | null {
  if (!seam.isometric || half.fromPartner === null) return null;
  const partner = seam.a === half ? seam.b : seam.a;
  return applyAffine(half.fromPartner, pointOnHalfEdge(partner, partnerFraction(seam, t)));
}

/// Where a half corridor of a passage crossing the seam runs inside its own cell: from the cell
/// center to the face's contact point. The partner's half continues from its own contact point.
export function halfCorridor(half: HalfEdge): [WorldPoint, WorldPoint] {
  return [half.center, half.contact];
}

let cached: { cfg: FieldConfig; fieldVersion: number; topologyVersion: number; model: SeamModel } | null = null;

/// The seam model of the current field (`cartesianCache`'s snapshot), memoized per config object
/// and per field and topology version, so a render loop pays a reference and two integer compares.
/// The folds come from the topology the cache was warmed with (`warmCartesianCache`). A cache that
/// is cold for this config has no topology to read, so the model is empty and nothing is warmed
/// (a lazy warm would build a fold-less snapshot and drop the folds of the floor that owns it).
export function getSeamModel(cfg: FieldConfig): SeamModel {
  if (!isCacheWarmFor(cfg)) return EMPTY_MODEL;
  if (cached?.cfg === cfg && cached.fieldVersion === getFieldVersion() && cached.topologyVersion === getTopologyVersion()) return cached.model;
  const cells = configAllCells(cfg);
  if (cells.length === 0) return EMPTY_MODEL;
  const fieldVersion = getFieldVersion();
  const topologyVersion = getTopologyVersion();
  const model =
    cached?.fieldVersion === fieldVersion && cached.topologyVersion === topologyVersion
      ? cached.model
      : buildSeamModel(cells.map(([x, y]) => getCellGeometry(x, y, cfg)));
  cached = { cfg, fieldVersion, topologyVersion, model };
  return model;
}
