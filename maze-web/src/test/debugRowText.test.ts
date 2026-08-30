import { describe, it, expect } from "vitest";
import { buildDebugRowText, normalizeSearchText, bubbleLabel } from "../debug/debugRowText";
import type { Token } from "../debug/algorithmRegistry";

const coords = (id: bigint) => {
  const map: Record<string, { x: number; y: number; level: number; i: number; split: boolean }> = {
    "1": { x: 0, y: 0, level: 0, i: 0, split: false },
    "2": { x: 3, y: 4, level: 1, i: 0, split: false },
  };
  return map[id.toString()] ?? null;
};

describe("buildDebugRowText (GitHub issue #482)", () => {
  it("joins text tokens verbatim and bubble tokens via bubbleLabel with a single space", () => {
    const tokens: Token[] = [
      { kind: "text", text: "Passage added" },
      { kind: "edge", from: 1n, to: 2n, bidirectional: false },
    ];
    expect(buildDebugRowText(tokens, coords)).toBe("Passage added 0:0 -> 3:4");
  });

  it("prefixes the floor on a multi-floor maze", () => {
    const tokens: Token[] = [{ kind: "node", id: 2n }];
    expect(buildDebugRowText(tokens, coords, true)).toBe("L2:3:4");
    expect(buildDebugRowText(tokens, coords, false)).toBe("3:4");
  });

  it("falls back to #id for an unresolvable node id", () => {
    const tokens: Token[] = [{ kind: "node", id: 99n }];
    expect(buildDebugRowText(tokens, coords)).toBe("#99");
  });

  it("joins a cycle token's edge pairs with an ASCII hyphen (no en-dash), comma-separated", () => {
    const tokens: Token[] = [{ kind: "cycle", edges: [[1n, 2n], [2n, 1n]] }];
    expect(buildDebugRowText(tokens, coords)).toBe("0:0-3:4, 3:4-0:0");
  });
});

describe("normalizeSearchText", () => {
  it("lowercases", () => {
    expect(normalizeSearchText("Passage ADDED")).toBe("passage added");
  });
});

describe("bubbleLabel re-export", () => {
  it("is the same function exported from debugRowText", () => {
    expect(bubbleLabel({ kind: "node", id: 1n }, coords)).toBe("0:0");
  });
});
