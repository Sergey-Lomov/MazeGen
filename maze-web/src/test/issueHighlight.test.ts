import { describe, it, expect } from "vitest";
import { resolveIssueHighlight, type NormalizedIssuePayload } from "../components/issueHighlight";

function edgeGroup(edges: [number, number][], presetLocked = false) {
  return { edges, presetLocked };
}
function regionGroup(nodes: number[], presetLocked = false) {
  return { nodes, presetLocked };
}

describe("resolveIssueHighlight", () => {
  it("resolves none/excessiveSccCount/areaDeficit to no highlight", () => {
    for (const kind of ["none", "excessiveSccCount", "areaDeficit"] as const) {
      expect(resolveIssueHighlight({ kind } as NormalizedIssuePayload<number>)).toEqual({ cycle: null, region: null });
    }
  });

  it("resolves invalidLoop to a non-wall cycle over every group's edges", () => {
    const payload: NormalizedIssuePayload<number> = {
      kind: "invalidLoop",
      groups: [edgeGroup([[1, 2]]), edgeGroup([[2, 3]])],
    };
    expect(resolveIssueHighlight(payload)).toEqual({ cycle: { edges: [[1, 2], [2, 3]], asWall: false }, region: null });
  });

  it("resolves invalidLoop with no groups to no highlight", () => {
    expect(resolveIssueHighlight({ kind: "invalidLoop", groups: [] })).toEqual({ cycle: null, region: null });
  });

  it("resolves invalidOneWay to a wall cycle", () => {
    const payload: NormalizedIssuePayload<number> = { kind: "invalidOneWay", groups: [edgeGroup([[1, 2]])] };
    expect(resolveIssueHighlight(payload)).toEqual({ cycle: { edges: [[1, 2]], asWall: true }, region: null });
  });

  it("resolves invalidTeleport to one deduplicated singleton region group per endpoint node", () => {
    const payload: NormalizedIssuePayload<number> = {
      kind: "invalidTeleport",
      groups: [edgeGroup([[1, 2]]), edgeGroup([[2, 3]])],
    };
    expect(resolveIssueHighlight(payload)).toEqual({
      cycle: null,
      region: { groups: [{ nodes: [1], isSplit: false }, { nodes: [2], isSplit: false }, { nodes: [3], isSplit: false }] },
    });
  });

  it("resolves invalidVerticalPassage/invalidElevator/missingElevatorStopCount the same way as invalidTeleport", () => {
    for (const kind of ["invalidVerticalPassage", "invalidElevator", "missingElevatorStopCount"] as const) {
      const payload = { kind, groups: [edgeGroup([[5, 6]])] } as NormalizedIssuePayload<number>;
      expect(resolveIssueHighlight(payload)).toEqual({
        cycle: null,
        region: { groups: [{ nodes: [5], isSplit: false }, { nodes: [6], isSplit: false }] },
      });
    }
  });

  it("resolves regionNeedsExpansion/regionNeedsShrink/invalidElevatorStop to one group per region, never merged", () => {
    for (const kind of ["regionNeedsExpansion", "regionNeedsShrink", "invalidElevatorStop"] as const) {
      const payload = { kind, groups: [regionGroup([1, 2]), regionGroup([3, 4])] } as NormalizedIssuePayload<number>;
      expect(resolveIssueHighlight(payload)).toEqual({
        cycle: null,
        region: { groups: [{ nodes: [1, 2], isSplit: false }, { nodes: [3, 4], isSplit: false }] },
      });
    }
  });

  it("resolves invalidSplitTile to one merged, deduplicated, split-inset region group", () => {
    const payload: NormalizedIssuePayload<number> = {
      kind: "invalidSplitTile",
      groups: [
        { tiles: [{ nodes: [1, 2], presetLocked: false }], presetLocked: false },
        { tiles: [{ nodes: [2, 3], presetLocked: false }], presetLocked: false },
      ],
    };
    expect(resolveIssueHighlight(payload)).toEqual({ cycle: null, region: { groups: [{ nodes: [1, 2, 3], isSplit: true }] } });
  });

  it("resolves invalidSplitRoute to a non-wall cycle over its own edges", () => {
    const payload: NormalizedIssuePayload<number> = { kind: "invalidSplitRoute", edges: [[1, 2], [2, 3]] };
    expect(resolveIssueHighlight(payload)).toEqual({ cycle: { edges: [[1, 2], [2, 3]], asWall: false }, region: null });
  });

  it("resolves invalidCrossElementGroup mixing a one-way member (wall) with a split member (region) at once", () => {
    const payload: NormalizedIssuePayload<number> = {
      kind: "invalidCrossElementGroup",
      entries: [
        { kind: "one_way", edges: [[1, 2]], nodes: [], tile: null },
        { kind: "split", edges: [], nodes: [], tile: { nodes: [3, 4], presetLocked: false } },
      ],
    };
    expect(resolveIssueHighlight(payload)).toEqual({
      cycle: { edges: [[1, 2]], asWall: true },
      region: { groups: [{ nodes: [3, 4], isSplit: true }] },
    });
  });

  it("keeps two non-split cross-element entries as separate region groups instead of merging them", () => {
    const payload: NormalizedIssuePayload<number> = {
      kind: "invalidCrossElementGroup",
      entries: [
        { kind: "teleport", edges: [[1, 2]], nodes: [], tile: null },
        { kind: "elevator_stop", edges: [], nodes: [5], tile: null },
      ],
    };
    expect(resolveIssueHighlight(payload)).toEqual({
      cycle: null,
      region: { groups: [{ nodes: [1, 2], isSplit: false }, { nodes: [5], isSplit: false }] },
    });
  });
});
