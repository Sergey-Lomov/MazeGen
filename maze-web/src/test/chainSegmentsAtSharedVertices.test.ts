import { describe, it, expect } from "vitest";
import { chainSegmentsAtSharedVertices } from "../pixi/renderers/WallRenderer";

describe("chainSegmentsAtSharedVertices", () => {
  it("chains two segments meeting at a shared vertex into one continuous path", () => {
    const segs = [
      { v0: { x: 0, y: 0 }, v1: { x: 10, y: 0 } },
      { v0: { x: 10, y: 0 }, v1: { x: 10, y: 10 } },
    ];
    const paths = chainSegmentsAtSharedVertices(segs);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
  });

  it("keeps disjoint segments as separate paths", () => {
    const segs = [
      { v0: { x: 0, y: 0 }, v1: { x: 10, y: 0 } },
      { v0: { x: 100, y: 100 }, v1: { x: 110, y: 100 } },
    ];
    const paths = chainSegmentsAtSharedVertices(segs);
    expect(paths).toHaveLength(2);
  });

  it("does not chain at a T-junction where three segments share a vertex", () => {
    const segs = [
      { v0: { x: 0, y: 0 }, v1: { x: 10, y: 0 } },
      { v0: { x: 10, y: 0 }, v1: { x: 20, y: 0 } },
      { v0: { x: 10, y: 0 }, v1: { x: 10, y: 10 } },
    ];
    const paths = chainSegmentsAtSharedVertices(segs);
    // Each segment stays its own path — no single "next" segment at the shared vertex.
    expect(paths).toHaveLength(3);
  });

  it("chains a full loop of four segments into one closed path", () => {
    const segs = [
      { v0: { x: 0, y: 0 }, v1: { x: 10, y: 0 } },
      { v0: { x: 10, y: 0 }, v1: { x: 10, y: 10 } },
      { v0: { x: 10, y: 10 }, v1: { x: 0, y: 10 } },
      { v0: { x: 0, y: 10 }, v1: { x: 0, y: 0 } },
    ];
    const paths = chainSegmentsAtSharedVertices(segs);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toHaveLength(5);
  });

  it("treats near-coincident float coordinates as the same vertex", () => {
    const segs = [
      { v0: { x: 0, y: 0 }, v1: { x: 10, y: 0 } },
      { v0: { x: 10.001, y: 0 }, v1: { x: 10, y: 10 } },
    ];
    const paths = chainSegmentsAtSharedVertices(segs);
    expect(paths).toHaveLength(1);
  });
});
