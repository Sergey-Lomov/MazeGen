import { describe, it, expect } from "vitest";
import {
  nodeEndpoint, splitEndpoint, endpointsEqual, endpointKey, edgeKey, endpointIsNode, resolveEndpoint,
  buildSplitNodeResolver, resolvePostEditPartnerAt,
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

  it("resolves a leveled slot against its own floor's entry, not floor 0's", () => {
    // Same (x, y) declared on both floor 0 (bare key) and floor 2 ("@2") — each floor's own
    // node set must resolve independently.
    const nodeMap = new Map([
      ["1,2", [10, 11]],
      ["1,2@2", [20, 21]],
    ]);
    const splitPoints = { "1,2": [0], "1,2@2": [0] };
    const resolve = buildSplitNodeResolver(nodeMap, splitPoints);
    expect(resolve([1, 2], 0, 2)).toBe(21);
    expect(resolve([1, 2], 0)).toBe(11);
  });

  it("does not fall back to floor 0's node when the leveled key is missing (GitHub issue #358 cross-floor collision)", () => {
    // Floor 0 has a confirmed slot at (1, 2); floor 2 declares the same point/slot but has no
    // confirmed node for it yet (e.g. not yet confirmed, or genuinely absent on that floor) — the
    // lookup must return undefined, never silently resolve against floor 0's own node.
    const nodeMap = new Map([["1,2", [10, 11]]]);
    const splitPoints = { "1,2": [0], "1,2@2": [0] };
    const resolve = buildSplitNodeResolver(nodeMap, splitPoints);
    expect(resolve([1, 2], 0, 2)).toBeUndefined();
  });
});

describe("resolvePostEditPartnerAt (GitHub issue #243)", () => {
  it("returns the neighbor's real connecting node — found via an existing draftEdges entry", () => {
    const draftEdges = {
      [edgeKey(nodeEndpoint(0), nodeEndpoint(10))]: { from: nodeEndpoint(0), to: nodeEndpoint(10), kind: "basic" },
    };
    const result = resolvePostEditPartnerAt([nodeEndpoint(0)], [1, 0], [1, 10], draftEdges, [0], {});
    expect(result).toEqual(nodeEndpoint(10));
  });

  it("returns null when the neighbor point has no nodes at all", () => {
    const result = resolvePostEditPartnerAt([nodeEndpoint(0)], [1, 0], [], {}, [], {});
    expect(result).toBeNull();
  });

  it("falls back to a node-kind active endpoint when no draftEdges entry matches", () => {
    const result = resolvePostEditPartnerAt([nodeEndpoint(0)], [1, 0], [1, 10], {}, [0], { "1,0": nodeEndpoint(10) });
    expect(result).toEqual(nodeEndpoint(10));
  });

  it("resolves a split-kind active fallback to the matching confirmed node id", () => {
    const result = resolvePostEditPartnerAt([nodeEndpoint(0)], [1, 0], [1, 10], {}, [0], { "1,0": splitEndpoint([1, 0], 0) });
    expect(result).toEqual(nodeEndpoint(10));
  });

  it("returns the unresolved split-kind active endpoint as-is when its slot isn't confirmed yet", () => {
    const active = splitEndpoint([1, 0], 5);
    const result = resolvePostEditPartnerAt([nodeEndpoint(0)], [1, 0], [1], {}, [], { "1,0": active });
    expect(result).toEqual(active);
  });

  it("falls back to the neighbor's first node when nothing matches and nothing is active", () => {
    const result = resolvePostEditPartnerAt([nodeEndpoint(0)], [1, 0], [1, 10], {}, [0], {});
    expect(result).toEqual(nodeEndpoint(1));
  });
});
