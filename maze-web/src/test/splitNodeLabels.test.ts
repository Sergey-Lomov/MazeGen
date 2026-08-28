import { describe, it, expect } from "vitest";
import { splitNodeNumber, splitNodeLabel, splitNodeLabelShort } from "../components/features/SplitNodesDialogView";

// GitHub issue #468: slot 0 is not a special node any more — every node of a split point, the
// point's original node included, shares one 1-based numbering. The original node is N=1; a slot's
// number is its `slotId + 2` (slotId is `NodeDto.i - 1`, so slot 0 = node index 1 = "Node 2").
describe("splitNodeNumber", () => {
  it("maps the original node (no slotId) to 1", () => {
    expect(splitNodeNumber(undefined)).toBe(1);
  });

  it("maps slot N to N + 2", () => {
    expect(splitNodeNumber(0)).toBe(2);
    expect(splitNodeNumber(1)).toBe(3);
    expect(splitNodeNumber(7)).toBe(9);
  });
});

describe("splitNodeLabel / splitNodeLabelShort", () => {
  it("full form is 'Node N', compact form is 'NN'", () => {
    expect(splitNodeLabel(undefined)).toBe("Node 1");
    expect(splitNodeLabelShort(undefined)).toBe("N1");
    expect(splitNodeLabel(0)).toBe("Node 2");
    expect(splitNodeLabelShort(0)).toBe("N2");
  });
});
