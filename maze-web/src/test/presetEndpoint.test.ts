import { describe, it, expect } from "vitest";
import {
  presetEndpoint, presetEndpointsEqual, presetEndpointIsSplit, presetEndpointKey, presetEndpointToDto,
  presetEndpointLevelLabel,
} from "../pixi/presetEndpoint";

describe("presetEndpoint", () => {
  it("no slotId — original node, point only", () => {
    expect(presetEndpoint([1, 2])).toEqual({ point: [1, 2] });
  });

  it("with slotId — includes slotId", () => {
    expect(presetEndpoint([1, 2], 3)).toEqual({ point: [1, 2], slotId: 3 });
  });
});

describe("presetEndpointsEqual", () => {
  it("both original at the same point — equal", () => {
    expect(presetEndpointsEqual(presetEndpoint([1, 2]), presetEndpoint([1, 2]))).toBe(true);
  });

  it("same point, different slotId — not equal", () => {
    expect(presetEndpointsEqual(presetEndpoint([1, 2], 0), presetEndpoint([1, 2], 1))).toBe(false);
  });

  it("same slotId, different point — not equal", () => {
    expect(presetEndpointsEqual(presetEndpoint([1, 2], 0), presetEndpoint([3, 4], 0))).toBe(false);
  });

  it("one original, one split at same point — not equal", () => {
    expect(presetEndpointsEqual(presetEndpoint([1, 2]), presetEndpoint([1, 2], 0))).toBe(false);
  });
});

describe("presetEndpointIsSplit", () => {
  it("matching point and slotId — true", () => {
    expect(presetEndpointIsSplit(presetEndpoint([1, 2], 0), { point: [1, 2], slotId: 0 })).toBe(true);
  });

  it("original node (no slotId) — always false, even at the same point", () => {
    expect(presetEndpointIsSplit(presetEndpoint([1, 2]), { point: [1, 2], slotId: 0 })).toBe(false);
  });

  it("different slotId at the same point — false", () => {
    expect(presetEndpointIsSplit(presetEndpoint([1, 2], 1), { point: [1, 2], slotId: 0 })).toBe(false);
  });
});

describe("presetEndpointKey", () => {
  it("original node — plain point key", () => {
    expect(presetEndpointKey(presetEndpoint([1, 2]))).toBe("1,2");
  });

  it("split node — point key with slot suffix", () => {
    expect(presetEndpointKey(presetEndpoint([1, 2], 3))).toBe("1,2:3");
  });
});

describe("presetEndpointToDto", () => {
  it("original node — no slot field", () => {
    expect(presetEndpointToDto(presetEndpoint([1, 2]))).toEqual({ point: [1, 2] });
  });

  it("split node — slot field present, renamed from slotId", () => {
    expect(presetEndpointToDto(presetEndpoint([1, 2], 3))).toEqual({ point: [1, 2], slot: 3 });
  });
});

describe("presetEndpointLevelLabel", () => {
  it("single-floor maze — empty, regardless of level", () => {
    expect(presetEndpointLevelLabel(presetEndpoint([1, 2]), false)).toBe("");
    expect(presetEndpointLevelLabel(presetEndpoint([1, 2], undefined, 2), false)).toBe("");
  });

  it("multi-floor maze, floor 0 (level undefined) — L1 prefix", () => {
    expect(presetEndpointLevelLabel(presetEndpoint([1, 2]), true)).toBe("L1: ");
  });

  it("multi-floor maze, non-zero level — 1-based L{n} prefix", () => {
    expect(presetEndpointLevelLabel(presetEndpoint([1, 2], undefined, 2), true)).toBe("L3: ");
  });
});
