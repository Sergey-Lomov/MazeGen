import { describe, expect, it } from "vitest";
import { warmCartesianCache, getCellGeometry, getFieldVersion } from "../pixi/cartesianCache";
import {
  applyAffine,
  buildSeamModel,
  getSeamModel,
  halfCorridor,
  partnerFraction,
  partnerPointInOwnCell,
  pointOnHalfEdge,
  type HalfEdge,
  type Seam,
  type SeamCellInput,
} from "../pixi/selectors/seams";
import type { WireFold, WireTopology } from "../wasm/types";
import { fieldOf } from "./fieldConfigFixtures";

// Runs against the real `maze-core` module loaded by `setup.ts`. A 6x5 square field; face 0 is east,
// 1 north, 2 west, 3 south (the order the topology fixtures of `maze-runner` use).
const COLUMNS = 6;
const ROWS = 5;
const cells: [number, number][] = [];
for (let x = 0; x < COLUMNS; x++) for (let y = 0; y < ROWS; y++) cells.push([x, y]);
const field = fieldOf("square", { shape: "custom", points: cells });

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

function topologyOf(folds: Omit<WireFold, "group">[]): WireTopology {
  return {
    fingerprint: "square{}",
    folds: folds.map((fold) => ({ ...fold, group: 0 })),
    groups: [{ id: 0, folds: folds.map((_, i) => i) }],
  };
}

const cylinderFolds = range(ROWS).map((y) => ({ a: { cell: [COLUMNS - 1, y] as [number, number], face_idx: 0 }, b: { cell: [0, y] as [number, number], face_idx: 2 }, twist: false }));
const wrapFolds = range(COLUMNS).map((x) => ({ a: { cell: [x, ROWS - 1] as [number, number], face_idx: 1 }, b: { cell: [x, 0] as [number, number], face_idx: 3 }, twist: false }));
const mobiusFolds = range(ROWS).map((y) => ({ a: { cell: [COLUMNS - 1, y] as [number, number], face_idx: 0 }, b: { cell: [0, ROWS - 1 - y] as [number, number], face_idx: 2 }, twist: true }));

const cylinder = topologyOf(cylinderFolds);
const torus = topologyOf([...cylinderFolds, ...wrapFolds]);
const mobius = topologyOf(mobiusFolds);

function modelOf(topology: WireTopology | null) {
  warmCartesianCache(field, topology);
  return getSeamModel(field);
}

const close = (actual: readonly number[], expected: readonly number[]) => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 6));
};

const FRACTIONS = [0, 0.25, 0.5, 1];

/** The checks every isometric seam must pass, whatever the surface. */
function expectConsistent(seam: Seam, partnerOf: (half: HalfEdge) => HalfEdge) {
  const { a, b } = seam;
  expect(partnerOf(a)).toBe(b);
  expect(partnerOf(b)).toBe(a);
  expect(b.seam).toBe(a.seam);
  expect(a.side).toBe("a");
  expect(b.side).toBe("b");
  expect(a.partnerCell).toEqual(b.cell);
  expect(a.partnerFaceIdx).toBe(b.faceIdx);
  expect(b.partnerCell).toEqual(a.cell);
  expect(b.partnerFaceIdx).toBe(a.faceIdx);
  expect(seam.isometric).toBe(true);
  expect(seam.flips).toBe(seam.twist);
  // Each side's transform is the inverse of the other's.
  for (const point of [a.contact, a.center, b.contact]) {
    close(applyAffine(a.fromPartner!, applyAffine(b.fromPartner!, point)), point);
  }
  // The partner's matching point, brought into this cell, is this side's own point -- from both sides.
  for (const t of FRACTIONS) {
    close(partnerPointInOwnCell(seam, a, t)!, pointOnHalfEdge(a, t));
    close(partnerPointInOwnCell(seam, b, partnerFraction(seam, t))!, pointOnHalfEdge(b, partnerFraction(seam, t)));
  }
  // The contact points correspond too.
  close(applyAffine(a.fromPartner!, b.contact), a.contact);
  close(applyAffine(b.fromPartner!, a.contact), b.contact);
}

describe("seam model", () => {
  it("is empty without a topology", () => {
    const model = modelOf(null);
    expect(model.isEmpty).toBe(true);
    expect(model.seams).toEqual([]);
    expect(model.halfEdgeAt([0, 0], 2)).toBeNull();
    expect(model.halfEdgeBetween([5, 0], [0, 0])).toBeNull();
    expect(model.halfEdgesOf([0, 0])).toEqual([]);
  });

  it("describes a cylinder: both sides of every seam, untwisted", () => {
    const model = modelOf(cylinder);
    expect(model.seams).toHaveLength(ROWS);
    for (const [row, seam] of model.seams.entries()) {
      expect(seam.fold).toBe(row);
      expect(seam.twist).toBe(false);
      expect(seam.endpoints).toEqual([{ a: "start", b: "end" }, { a: "end", b: "start" }]);
      // `a` is the smaller (x, y, face) side: the west column.
      expect(seam.a.cell).toEqual([0, row]);
      expect(seam.a.faceIdx).toBe(2);
      expect(seam.b.cell).toEqual([COLUMNS - 1, row]);
      expect(seam.b.faceIdx).toBe(0);
      close(seam.a.contact, [0, row + 0.5]);
      close(seam.b.contact, [COLUMNS, row + 0.5]);
      close(seam.b.fromPartner!, [1, 0, 0, 1, COLUMNS, 0]);
      close(seam.a.fromPartner!, [1, 0, 0, 1, -COLUMNS, 0]);
      expectConsistent(seam, model.partnerOf);
    }
  });

  it("looks sides up by face and by the pair of cells", () => {
    const model = modelOf(cylinder);
    const east = model.halfEdgeBetween([COLUMNS - 1, 2], [0, 2])!;
    const west = model.halfEdgeBetween([0, 2], [COLUMNS - 1, 2])!;
    expect(model.halfEdgeAt([COLUMNS - 1, 2], 0)).toBe(east);
    expect(model.halfEdgeAt([0, 2], 2)).toBe(west);
    expect(model.partnerOf(east)).toBe(west);
    // Unglued faces and unrelated pairs are not seams, nor are ordinary neighbors.
    expect(model.halfEdgeAt([COLUMNS - 1, 2], 1)).toBeNull();
    expect(model.halfEdgeBetween([COLUMNS - 1, 2], [COLUMNS - 2, 2])).toBeNull();
    expect(model.halfEdgeBetween([0, 0], [COLUMNS - 1, 4])).toBeNull();
  });

  it("draws a corridor across a seam as two halves that meet the face on each side", () => {
    const model = modelOf(cylinder);
    const east = model.halfEdgeBetween([COLUMNS - 1, 1], [0, 1])!;
    const west = model.partnerOf(east);
    const [eastInner, eastOuter] = halfCorridor(east);
    const [westInner, westOuter] = halfCorridor(west);
    close(eastInner, getCellGeometry(COLUMNS - 1, 1, field).center);
    close(eastOuter, [COLUMNS, 1.5]);
    close(westInner, getCellGeometry(0, 1, field).center);
    close(westOuter, [0, 1.5]);
    // Brought into one cell's frame the two outer ends coincide: no gap, no overlap at the seam.
    close(applyAffine(east.fromPartner!, westOuter), eastOuter);
  });

  it("describes a torus: a corner cell has two sides", () => {
    const model = modelOf(torus);
    expect(model.seams).toHaveLength(ROWS + COLUMNS);
    expect(model.halfEdgesOf([COLUMNS - 1, ROWS - 1]).map((half) => half.faceIdx).sort()).toEqual([0, 1]);
    expect(model.halfEdgesOf([2, 2])).toEqual([]);
    for (const seam of model.seams) expectConsistent(seam, model.partnerOf);
    const vertical = model.halfEdgeBetween([3, ROWS - 1], [3, 0])!;
    close(vertical.contact, [3.5, ROWS]);
    close(model.partnerOf(vertical).contact, [3.5, 0]);
  });

  it("describes a Möbius strip: twisted correspondence, consistent from both sides", () => {
    const model = modelOf(mobius);
    expect(model.seams).toHaveLength(ROWS);
    for (const seam of model.seams) {
      expect(seam.twist).toBe(true);
      expect(seam.flips).toBe(true);
      expect(seam.endpoints).toEqual([{ a: "start", b: "start" }, { a: "end", b: "end" }]);
      expect(partnerFraction(seam, 0.25)).toBe(0.25);
      // The transform reflects: a determinant of -1.
      const [m0, m1, m2, m3] = seam.a.fromPartner!;
      expect(m0 * m3 - m1 * m2).toBeCloseTo(-1, 6);
      expectConsistent(seam, model.partnerOf);
    }
    // The glued cells are mirrored across the strip: row y meets row (ROWS - 1 - y).
    expect(model.halfEdgeBetween([COLUMNS - 1, 0], [0, ROWS - 1])).not.toBeNull();
    expect(model.halfEdgeBetween([COLUMNS - 1, 0], [0, 0])).toBeNull();
  });

  it("memoizes per field and topology version", () => {
    const first = modelOf(cylinder);
    expect(getSeamModel(field)).toBe(first);
    warmCartesianCache(field, cylinder);
    expect(getSeamModel(field)).toBe(first);
    expect(modelOf(torus)).not.toBe(first);
  });

  it("keeps a topological-only seam without a transform or point correspondence", () => {
    const entry = (cell: [number, number], partner: [number, number], faceIdx: number): SeamCellInput => ({
      cell,
      center: [cell[0] + 0.5, 0.5],
      faces: Array.from({ length: 2 }, (_, i) => ({
        contact_point: [cell[0] + i, 0.5] as [number, number],
        segments: [{ kind: "line" as const, from: [cell[0] + i, 0] as [number, number], to: [cell[0] + i, 1] as [number, number] }],
        fold: i === faceIdx ? { fold: 7, partner_cell: partner, partner_face_idx: 0, twist: false, start_meets: "end" as const, isometric: false, transform: null } : null,
      })),
    });
    const model = buildSeamModel([entry([0, 0], [4, 0], 1), entry([4, 0], [0, 0], 0)]);
    const [seam] = model.seams;
    expect(seam.fold).toBe(7);
    expect(seam.isometric).toBe(false);
    expect(seam.a.fromPartner).toBeNull();
    expect(partnerPointInOwnCell(seam, seam.a, 0.5)).toBeNull();
    // The ends still correspond.
    expect(seam.endpoints[0]).toEqual({ a: "start", b: "end" });
    expect(model.halfEdgeBetween([0, 0], [4, 0])).toBe(seam.a);
  });

  it("is empty, and warms nothing, when the cache holds another tessellation", () => {
    modelOf(cylinder);
    const version = getFieldVersion();
    const hex = fieldOf("hex", { shape: "custom", points: [[0, 0], [1, 0]] });
    expect(getSeamModel(hex).isEmpty).toBe(true);
    expect(getFieldVersion()).toBe(version);
    // The cylinder's own cache and model survive.
    expect(getSeamModel(field).seams).toHaveLength(ROWS);
  });

  it("refuses a partner lookup on an empty model", () => {
    const [seam] = modelOf(cylinder).seams;
    expect(() => modelOf(null).partnerOf(seam.a)).toThrow();
  });

  it("is empty for a field without cells", () => {
    expect(getSeamModel(fieldOf("square", { shape: "custom", points: [] })).isEmpty).toBe(true);
  });

  it("maps fractions along the chain: reversed for untwisted seams, as is for twisted", () => {
    const [cylinderSeam] = modelOf(cylinder).seams;
    expect(partnerFraction(cylinderSeam, 0.25)).toBe(0.75);
    // The west face runs counter-clockwise along its cell, top to bottom: a quarter of the way down.
    close(pointOnHalfEdge(cylinderSeam.a, 0.25), [0, 0.75]);
    close(pointOnHalfEdge(cylinderSeam.a, 5), pointOnHalfEdge(cylinderSeam.a, 1));
    close(pointOnHalfEdge(cylinderSeam.a, -1), pointOnHalfEdge(cylinderSeam.a, 0));
  });

  it("skips a fold seen from only one side", () => {
    const half = (cell: [number, number], fold: boolean): SeamCellInput => ({
      cell,
      center: [cell[0] + 0.5, 0.5],
      faces: [{ contact_point: [cell[0], 0.5], segments: [], fold: fold ? { fold: 0, partner_cell: [3, 0], partner_face_idx: 0, twist: false, start_meets: "end", isometric: true, transform: [1, 0, 0, 1, 0, 0] } : null }],
    });
    expect(buildSeamModel([half([0, 0], true), half([3, 0], false)]).isEmpty).toBe(true);
  });

  it("skips a fold whose partner is outside the given cells", () => {
    const lonely: SeamCellInput = {
      cell: [0, 0],
      center: [0.5, 0.5],
      faces: [{ contact_point: [1, 0.5], segments: [], fold: { fold: 0, partner_cell: [9, 9], partner_face_idx: 0, twist: false, start_meets: "end", isometric: true, transform: [1, 0, 0, 1, 9, 9] } }],
    };
    expect(buildSeamModel([lonely]).isEmpty).toBe(true);
  });
});
