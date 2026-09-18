import { describe, it, expect } from "vitest";
import {
  buildNodeByIdMap, buildLiveEntries, postEditCommandLabel, postEditRowHighlight, postEditCommandFloors,
} from "../pixi/postEditCommandLabels";
import { nodeEndpoint } from "../pixi/postEditEndpoint";
import type { PostEditCommand } from "../store/postEditCommandTypes";
import type { NodeDto } from "../wasm/types";

const n = (id: number, x: number, y: number, level?: number): NodeDto =>
  (level === undefined ? { id, x, y, i: 0 } : { id, x, y, i: 0, level }) as NodeDto;

const emptyLive = buildLiveEntries([], [], []);

describe("postEditCommandLabel", () => {
  it("formats a setEdge wall as an undirected bubble pair", () => {
    const nodeById = buildNodeByIdMap([n(0, 0, 0), n(1, 1, 0)]);
    const command: PostEditCommand = { kind: "setEdge", from: nodeEndpoint(0), to: nodeEndpoint(1), edgeKind: "wall" };
    const label = postEditCommandLabel(command, nodeById, emptyLive, false);
    expect(label.isLink).toBe(true);
    expect(label.arrow).toBe("<->");
    expect(label.bubbles.map((b) => b.text)).toEqual(["0:0", "1:0"]);
  });

  it("formats a one-way setEdge with a directed arrow", () => {
    const nodeById = buildNodeByIdMap([n(0, 0, 0), n(1, 1, 0)]);
    const command: PostEditCommand = { kind: "setEdge", from: nodeEndpoint(0), to: nodeEndpoint(1), edgeKind: "one_way_forward" };
    const label = postEditCommandLabel(command, nodeById, emptyLive, false);
    expect(label.arrow).toBe("->");
  });

  it("uses Lf:x:y coordinates once multiFloor is true", () => {
    const nodeById = buildNodeByIdMap([n(0, 0, 0, 1), n(1, 1, 0, 1)]);
    const command: PostEditCommand = { kind: "setEdge", from: nodeEndpoint(0), to: nodeEndpoint(1), edgeKind: "basic" };
    const label = postEditCommandLabel(command, nodeById, emptyLive, true);
    expect(label.bubbles.map((b) => b.text)).toEqual(["L2:0:0", "L2:1:0"]);
  });

  it("setEdgePair keeps bubble order fixed as a,b regardless of which direction is one-way", () => {
    const nodeById = buildNodeByIdMap([n(0, 0, 0), n(1, 1, 0)]);
    const forward: PostEditCommand = {
      kind: "setEdgePair", a: nodeEndpoint(0), b: nodeEndpoint(1), aToB: "one_way_forward", bToA: "wall",
    };
    const backward: PostEditCommand = {
      kind: "setEdgePair", a: nodeEndpoint(0), b: nodeEndpoint(1), aToB: "wall", bToA: "one_way_forward",
    };
    const forwardLabel = postEditCommandLabel(forward, nodeById, emptyLive, false);
    const backwardLabel = postEditCommandLabel(backward, nodeById, emptyLive, false);
    expect(forwardLabel.bubbles.map((b) => b.text)).toEqual(["0:0", "1:0"]);
    expect(backwardLabel.bubbles.map((b) => b.text)).toEqual(["0:0", "1:0"]);
    expect(forwardLabel.arrow).toBe("->");
    expect(backwardLabel.arrow).toBe("<-");
  });

  it("falls back to a single unresolved bubble when a vertical passage id has no live entry", () => {
    const nodeById = buildNodeByIdMap([]);
    const command: PostEditCommand = { kind: "removeVerticalPassage", id: 99 };
    const label = postEditCommandLabel(command, nodeById, emptyLive, false);
    expect(label.bubbles).toEqual([{ text: "?", highlight: null }]);
    expect(label.isLink).toBe(false);
  });

  describe("vertical passage bubble", () => {
    const nodeById = buildNodeByIdMap([n(0, 3, 5, 0), n(1, 3, 5, 1)]);

    it("one-way forward: arrow points FROM's floor -> TO's floor", () => {
      const command: PostEditCommand = {
        kind: "addVerticalPassage", id: 1, from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "forward",
      };
      const label = postEditCommandLabel(command, nodeById, emptyLive, true);
      expect(label.bubbles).toHaveLength(1);
      expect(label.bubbles[0].text).toBe("3:5 [L1->L2]");
    });

    it("one-way backward: fixed FROM/TO order, arrow glyph flips instead", () => {
      const command: PostEditCommand = {
        kind: "addVerticalPassage", id: 1, from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "backward",
      };
      const label = postEditCommandLabel(command, nodeById, emptyLive, true);
      expect(label.bubbles[0].text).toBe("3:5 [L1<-L2]");
    });

    it("two-way: bidirectional arrow", () => {
      const command: PostEditCommand = {
        kind: "addVerticalPassage", id: 1, from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "two_way",
      };
      const label = postEditCommandLabel(command, nodeById, emptyLive, true);
      expect(label.bubbles[0].text).toBe("3:5 [L1<->L2]");
    });

    it("highlight covers both floors' points", () => {
      const command: PostEditCommand = {
        kind: "addVerticalPassage", id: 1, from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "two_way",
      };
      const label = postEditCommandLabel(command, nodeById, emptyLive, true);
      expect(label.bubbles[0].highlight).toEqual({
        kind: "points",
        points: [{ point: [3, 5], level: 0 }, { point: [3, 5], level: 1 }],
      });
    });
  });

  describe("elevator bubble", () => {
    it("combines the shared coordinate with every floor it spans", () => {
      const nodeById = buildNodeByIdMap([n(0, 2, 2, 0), n(1, 2, 2, 1), n(2, 2, 2, 2)]);
      const command: PostEditCommand = {
        kind: "addElevator", id: 1, floors: [nodeEndpoint(0), nodeEndpoint(1), nodeEndpoint(2)],
      };
      const label = postEditCommandLabel(command, nodeById, emptyLive, true);
      expect(label.bubbles).toHaveLength(1);
      expect(label.bubbles[0].text).toBe("2:2 [L1,L2,L3]");
      expect(label.isLink).toBe(false);
    });

    it("falls back to ? for a floor endpoint that hasn't resolved yet", () => {
      const nodeById = buildNodeByIdMap([n(0, 2, 2, 0)]);
      const command: PostEditCommand = {
        kind: "addElevator", id: 1, floors: [nodeEndpoint(0), nodeEndpoint(999)],
      };
      const label = postEditCommandLabel(command, nodeById, emptyLive, true);
      expect(label.bubbles[0].text).toBe("2:2 [L1,?]");
    });
  });
});

describe("postEditRowHighlight", () => {
  it("builds a link highlight from a two-bubble point-kind row", () => {
    const nodeById = buildNodeByIdMap([n(0, 0, 0), n(1, 1, 0)]);
    const command: PostEditCommand = { kind: "setEdge", from: nodeEndpoint(0), to: nodeEndpoint(1), edgeKind: "basic" };
    const label = postEditCommandLabel(command, nodeById, emptyLive, false);
    expect(postEditRowHighlight(label)).toEqual({
      kind: "link",
      from: { kind: "point", point: [0, 0], level: undefined },
      to: { kind: "point", point: [1, 0], level: undefined },
    });
  });

  it("returns null for a single-bubble points-kind row (elevator/vertical passage)", () => {
    const nodeById = buildNodeByIdMap([n(0, 2, 2, 0), n(1, 2, 2, 1)]);
    const command: PostEditCommand = { kind: "addElevator", id: 1, floors: [nodeEndpoint(0), nodeEndpoint(1)] };
    const label = postEditCommandLabel(command, nodeById, emptyLive, true);
    expect(postEditRowHighlight(label)).toBeNull();
  });
});

describe("postEditCommandFloors", () => {
  it("collects distinct floors from a points-kind bubble", () => {
    const nodeById = buildNodeByIdMap([n(0, 2, 2, 0), n(1, 2, 2, 1)]);
    const command: PostEditCommand = { kind: "addElevator", id: 1, floors: [nodeEndpoint(0), nodeEndpoint(1)] };
    const label = postEditCommandLabel(command, nodeById, emptyLive, true);
    expect(postEditCommandFloors(label)).toEqual([0, 1]);
  });

  it("collects floors from a two point-kind bubbles row, deduplicated", () => {
    const nodeById = buildNodeByIdMap([n(0, 0, 0, 0), n(1, 1, 0, 0)]);
    const command: PostEditCommand = { kind: "setEdge", from: nodeEndpoint(0), to: nodeEndpoint(1), edgeKind: "basic" };
    const label = postEditCommandLabel(command, nodeById, emptyLive, true);
    expect(postEditCommandFloors(label)).toEqual([0]);
  });
});
