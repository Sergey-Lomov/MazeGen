import { describe, it, expect } from "vitest";
import {
  nodeEndpoint, splitEndpoint, endpointsEqual, endpointKey, edgeKey, endpointIsNode, resolveEndpoint,
  buildSplitNodeResolver,
} from "../pixi/postEditEndpoint";

describe("endpointsEqual", () => {
  it("two node endpoints with the same id are equal", () => {
    expect(endpointsEqual(nodeEndpoint(5), nodeEndpoint(5))).toBe(true);
  });

  it("two node endpoints with different ids are not equal", () => {
    expect(endpointsEqual(nodeEndpoint(5), nodeEndpoint(6))).toBe(false);
  });

  it("two split endpoints with the same point/slotId are equal", () => {
    expect(endpointsEqual(splitEndpoint([1, 2], 0), splitEndpoint([1, 2], 0))).toBe(true);
  });

  it("split endpoints differing only in slotId are not equal", () => {
    expect(endpointsEqual(splitEndpoint([1, 2], 0), splitEndpoint([1, 2], 1))).toBe(false);
  });

  it("split endpoints differing only in point are not equal", () => {
    expect(endpointsEqual(splitEndpoint([1, 2], 0), splitEndpoint([3, 2], 0))).toBe(false);
  });

  it("node and split endpoints are never equal", () => {
    expect(endpointsEqual(nodeEndpoint(5), splitEndpoint([1, 2], 0))).toBe(false);
  });
});

describe("endpointKey / edgeKey", () => {
  it("node and split key spaces never collide", () => {
    const nodeKey = endpointKey(nodeEndpoint(1));
    const splitKey = endpointKey(splitEndpoint([1, 0], 0));
    expect(nodeKey).not.toBe(splitKey);
  });

  it("same endpoint always produces the same key", () => {
    expect(endpointKey(nodeEndpoint(7))).toBe(endpointKey(nodeEndpoint(7)));
    expect(endpointKey(splitEndpoint([2, 3], 1))).toBe(endpointKey(splitEndpoint([2, 3], 1)));
  });

  it("different split endpoints produce different keys", () => {
    expect(endpointKey(splitEndpoint([2, 3], 0))).not.toBe(endpointKey(splitEndpoint([2, 3], 1)));
    expect(endpointKey(splitEndpoint([2, 3], 0))).not.toBe(endpointKey(splitEndpoint([4, 3], 0)));
  });

  it("edgeKey combines both endpoint keys", () => {
    const key = edgeKey(nodeEndpoint(1), splitEndpoint([2, 3], 0));
    expect(key).toBe(`${endpointKey(nodeEndpoint(1))}-${endpointKey(splitEndpoint([2, 3], 0))}`);
  });
});

describe("endpointIsNode", () => {
  it("true for a matching node endpoint", () => {
    expect(endpointIsNode(nodeEndpoint(9), 9)).toBe(true);
  });

  it("false for a non-matching node endpoint", () => {
    expect(endpointIsNode(nodeEndpoint(9), 10)).toBe(false);
  });

  it("false for a split endpoint regardless of id", () => {
    expect(endpointIsNode(splitEndpoint([1, 1], 0), 9)).toBe(false);
  });
});

describe("resolveEndpoint", () => {
  it("node endpoint resolves to its own id, ignoring resolveSplit", () => {
    const result = resolveEndpoint(nodeEndpoint(3), () => { throw new Error("must not be called"); });
    expect(result).toBe(3);
  });

  it("split endpoint resolves via resolveSplit", () => {
    const result = resolveEndpoint(splitEndpoint([1, 2], 0), (point, slotId) => {
      expect(point).toEqual([1, 2]);
      expect(slotId).toBe(0);
      return 42;
    });
    expect(result).toBe(42);
  });

  it("split endpoint that resolveSplit can't resolve yet returns undefined", () => {
    const result = resolveEndpoint(splitEndpoint([1, 2], 0), () => undefined);
    expect(result).toBeUndefined();
  });
});

describe("buildSplitNodeResolver", () => {
  it("resolves slot 0 to the (index+1)-th node at the point (index 0 is the original node)", () => {
    const nodeMap = new Map([["1,2", [10, 11, 12]]]);
    const splitPoints = { "1,2": [0, 1] };
    const resolve = buildSplitNodeResolver(nodeMap, splitPoints);
    expect(resolve([1, 2], 0)).toBe(11);
    expect(resolve([1, 2], 1)).toBe(12);
  });

  it("sorts slotIds before indexing, regardless of storage order", () => {
    const nodeMap = new Map([["1,2", [10, 11, 12]]]);
    const splitPoints = { "1,2": [1, 0] }; // stored out of order
    const resolve = buildSplitNodeResolver(nodeMap, splitPoints);
    expect(resolve([1, 2], 0)).toBe(11);
    expect(resolve([1, 2], 1)).toBe(12);
  });

  it("returns undefined for a point with no split entry", () => {
    const nodeMap = new Map([["1,2", [10]]]);
    const resolve = buildSplitNodeResolver(nodeMap, {});
    expect(resolve([1, 2], 0)).toBeUndefined();
  });

  it("returns undefined for a slotId not yet confirmed into the snapshot", () => {
    // Draft has slots [0, 1], but the snapshot (nodeMap) only reflects slot 0 so far.
    const nodeMap = new Map([["1,2", [10, 11]]]);
    const splitPoints = { "1,2": [0, 1] };
    const resolve = buildSplitNodeResolver(nodeMap, splitPoints);
    expect(resolve([1, 2], 0)).toBe(11);
    expect(resolve([1, 2], 1)).toBeUndefined();
  });

  it("returns undefined for a point missing from nodeMap entirely", () => {
    const resolve = buildSplitNodeResolver(new Map(), { "1,2": [0] });
    expect(resolve([1, 2], 0)).toBeUndefined();
  });
});
