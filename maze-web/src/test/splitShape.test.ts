import { describe, it, expect } from "vitest";
import { canonicalFaceKinds, rotationTransform, type SplitShapeBinding } from "../pixi/splitShape";
import { detectSplitSpecialShapeKind, type SplitFaceKind } from "../pixi/splitFaceLayout";

const dihedral = (n: number): number[][] => [
  ...Array.from({ length: n }, (_, k) => Array.from({ length: n }, (_, i) => (i + k) % n)),
  ...Array.from({ length: n }, (_, k) => Array.from({ length: n }, (_, i) => (k + n - i) % n)),
];

function binding(shape: string, canonicalOfLocal: number[], group: number[][]): SplitShapeBinding {
  const localOfCanonical: number[] = [];
  canonicalOfLocal.forEach((canonical, local) => { localOfCanonical[canonical] = local; });
  return { shape, canonicalOfLocal, localOfCanonical, group };
}

const passage = (faces: number[], degree: number): SplitFaceKind[] =>
  Array.from({ length: degree }, (_, i) => (faces.includes(i) ? "passage" : "wall"));

describe("canonicalFaceKinds", () => {
  it("reorders local face kinds into canonical order", () => {
    // Local face 0 is canonical 2, local 1 is canonical 0, local 2 is canonical 1.
    const b = binding("regular:3", [2, 0, 1], dihedral(3));
    expect(canonicalFaceKinds(b, ["passage", "wall", "one_way_out"])).toEqual(["wall", "one_way_out", "passage"]);
  });
});

describe("detectSplitSpecialShapeKind with a non-identity binding", () => {
  it("recognizes a bridge by canonical faces, not by local face positions", () => {
    // Local order 0,1,2,3 -> canonical 0,2,1,3: local faces {0,1} are canonical {0,2} (opposite),
    // local faces {2,3} are canonical {1,3} (opposite). Locally they look adjacent ("diagonal").
    const b = binding("regular:4", [0, 2, 1, 3], dihedral(4));
    const kinds = [passage([0, 1], 4), passage([2, 3], 4)];
    expect(detectSplitSpecialShapeKind(kinds, b)).toBe("bridge");
  });

  it("never recognizes a cell without a shape template", () => {
    expect(detectSplitSpecialShapeKind([passage([0, 2], 4), passage([1, 3], 4)], null)).toBeNull();
  });
});

describe("rotationTransform", () => {
  it("finds the one-step rotation in a dihedral group, in both directions", () => {
    const b = binding("regular:6", [0, 1, 2, 3, 4, 5], dihedral(6));
    expect(rotationTransform(b, 1)).toEqual([1, 2, 3, 4, 5, 0]);
    expect(rotationTransform(b, -1)).toEqual([5, 0, 1, 2, 3, 4]);
  });

  it("is null for a group without rotations (Cairo: identity + one reflection)", () => {
    const b = binding("cairo_pentagon", [0, 1, 2, 3, 4], [[0, 1, 2, 3, 4], [0, 4, 3, 2, 1]]);
    expect(rotationTransform(b, 1)).toBeNull();
    expect(rotationTransform(b, -1)).toBeNull();
  });
});
