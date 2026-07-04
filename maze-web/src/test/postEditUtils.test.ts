import { describe, it, expect } from "vitest";
import { buildPostEditDraftEdgesFromGenerated, applyPostEditEdgeTool, extractTeleportEdges } from "../pixi/postEditUtils";
import type { EdgeDto } from "../wasm/types";
import type { PostEditEdge } from "../store/mazeStore";

// --- buildPostEditDraftEdgesFromGenerated ---

describe("buildPostEditDraftEdgesFromGenerated", () => {
  it("bidirectional edges become basic", () => {
    const edges: EdgeDto[] = [{ from: 0, to: 1, kind: "basic" }, { from: 1, to: 0, kind: "basic" }];
    const result = buildPostEditDraftEdgesFromGenerated(edges);
    expect(result["0-1"].kind).toBe("basic");
    expect(result["1-0"].kind).toBe("basic");
  });

  it("single directed edge becomes one_way_forward", () => {
    const edges: EdgeDto[] = [{ from: 0, to: 1, kind: "basic" }];
    const result = buildPostEditDraftEdgesFromGenerated(edges);
    expect(result["0-1"].kind).toBe("one_way_forward");
    expect(result["1-0"]).toBeUndefined();
  });

  it("empty edges returns empty record", () => {
    expect(buildPostEditDraftEdgesFromGenerated([])).toEqual({});
  });

  it("preserves from/to on each entry", () => {
    const edges: EdgeDto[] = [{ from: 3, to: 7, kind: "basic" }];
    const result = buildPostEditDraftEdgesFromGenerated(edges);
    expect(result["3-7"].from).toBe(3);
    expect(result["3-7"].to).toBe(7);
  });

  it("mix of one-way and bidirectional", () => {
    const edges: EdgeDto[] = [
      { from: 0, to: 1, kind: "basic" }, { from: 1, to: 0, kind: "basic" },
      { from: 2, to: 3, kind: "basic" },
    ];
    const result = buildPostEditDraftEdgesFromGenerated(edges);
    expect(result["0-1"].kind).toBe("basic");
    expect(result["1-0"].kind).toBe("basic");
    expect(result["2-3"].kind).toBe("one_way_forward");
  });

  it("ignores teleport edges entirely, even parallel to a Basic edge in the same direction", () => {
    // A Teleport and a Basic edge can coexist in the same direction between the same pair —
    // teleport must not appear in this Record at all (it's tracked separately, see
    // extractTeleportEdges), and must not shadow or be shadowed by the Basic entry.
    const edges: EdgeDto[] = [
      { from: 0, to: 1, kind: "basic" }, { from: 1, to: 0, kind: "basic" },
      { from: 0, to: 1, kind: "teleport" },
    ];
    const result = buildPostEditDraftEdgesFromGenerated(edges);
    expect(result["0-1"]).toEqual({ from: 0, to: 1, kind: "basic" });
    expect(Object.keys(result)).toEqual(["0-1", "1-0"]);
  });
});

// --- extractTeleportEdges ---

describe("extractTeleportEdges", () => {
  it("returns only teleport-kind edges", () => {
    const edges: EdgeDto[] = [
      { from: 0, to: 1, kind: "basic" },
      { from: 2, to: 3, kind: "teleport" },
    ];
    expect(extractTeleportEdges(edges)).toEqual([{ from: 2, to: 3, kind: "teleport" }]);
  });

  it("preserves multiple teleport edges including both directions of a two-way pair", () => {
    const edges: EdgeDto[] = [
      { from: 0, to: 1, kind: "teleport" },
      { from: 1, to: 0, kind: "teleport" },
      { from: 2, to: 3, kind: "teleport" },
    ];
    expect(extractTeleportEdges(edges)).toEqual(edges);
  });

  it("empty input returns empty array", () => {
    expect(extractTeleportEdges([])).toEqual([]);
  });

  it("no teleport edges returns empty array", () => {
    const edges: EdgeDto[] = [{ from: 0, to: 1, kind: "basic" }];
    expect(extractTeleportEdges(edges)).toEqual([]);
  });
});

// --- applyPostEditEdgeTool ---

const fwd = (from: number, to: number): PostEditEdge => ({ from, to, kind: "one_way_forward" });
const basic = (from: number, to: number): PostEditEdge => ({ from, to, kind: "basic" });

describe("applyPostEditEdgeTool — wall", () => {
  it("removes both directions", () => {
    const edges = { "0-1": basic(0, 1), "1-0": basic(1, 0) };
    const result = applyPostEditEdgeTool(edges, "wall", "0-1", 0, 1, []);
    expect(result["0-1"]).toBeUndefined();
    expect(result["1-0"]).toBeUndefined();
  });

  it("no-op on already empty edge", () => {
    const result = applyPostEditEdgeTool({}, "wall", "0-1", 0, 1, []);
    expect(result).toEqual({});
  });
});

describe("applyPostEditEdgeTool — passage", () => {
  it("adds both directions as basic", () => {
    const result = applyPostEditEdgeTool({}, "passage", "0-1", 0, 1, []);
    expect(result["0-1"]).toEqual({ from: 0, to: 1, kind: "basic" });
    expect(result["1-0"]).toEqual({ from: 1, to: 0, kind: "basic" });
  });

  it("overwrites existing one_way with basic", () => {
    const edges = { "0-1": fwd(0, 1) };
    const result = applyPostEditEdgeTool(edges, "passage", "0-1", 0, 1, []);
    expect(result["0-1"].kind).toBe("basic");
    expect(result["1-0"].kind).toBe("basic");
  });
});

describe("applyPostEditEdgeTool — one_way", () => {
  it("fwd edge → bwd", () => {
    const edges = { "0-1": fwd(0, 1) };
    const result = applyPostEditEdgeTool(edges, "one_way", "0-1", 0, 1, []);
    expect(result["0-1"]).toBeUndefined();
    expect(result["1-0"]).toEqual({ from: 1, to: 0, kind: "one_way_backward" });
  });

  it("no fwd edge → sets fwd", () => {
    const result = applyPostEditEdgeTool({}, "one_way", "0-1", 0, 1, []);
    expect(result["0-1"]).toEqual({ from: 0, to: 1, kind: "one_way_forward" });
    expect(result["1-0"]).toBeUndefined();
  });

  it("bwd edge present, clicking fwd key → replaces with fwd", () => {
    const edges = { "1-0": { from: 1, to: 0, kind: "one_way_backward" as const } };
    const result = applyPostEditEdgeTool(edges, "one_way", "0-1", 0, 1, []);
    expect(result["0-1"]).toEqual({ from: 0, to: 1, kind: "one_way_forward" });
    expect(result["1-0"]).toBeUndefined();
  });
});

describe("applyPostEditEdgeTool — reset", () => {
  it("restores bidirectional when original had both", () => {
    const orig: EdgeDto[] = [{ from: 0, to: 1, kind: "basic" }, { from: 1, to: 0, kind: "basic" }];
    const edges = {};
    const result = applyPostEditEdgeTool(edges, "reset", "0-1", 0, 1, orig);
    expect(result["0-1"]).toEqual({ from: 0, to: 1, kind: "basic" });
    expect(result["1-0"]).toEqual({ from: 1, to: 0, kind: "basic" });
  });

  it("restores one_way_forward when original had only forward", () => {
    const orig: EdgeDto[] = [{ from: 0, to: 1, kind: "basic" }];
    const result = applyPostEditEdgeTool({ "1-0": basic(1, 0) }, "reset", "0-1", 0, 1, orig);
    expect(result["0-1"]).toEqual({ from: 0, to: 1, kind: "one_way_forward" });
    expect(result["1-0"]).toBeUndefined();
  });

  it("restores one_way_forward (bwd slot) when original had only backward", () => {
    const orig: EdgeDto[] = [{ from: 1, to: 0, kind: "basic" }];
    const result = applyPostEditEdgeTool({ "0-1": basic(0, 1) }, "reset", "0-1", 0, 1, orig);
    expect(result["1-0"]).toEqual({ from: 1, to: 0, kind: "one_way_forward" });
    expect(result["0-1"]).toBeUndefined();
  });

  it("deletes both entries when edge was wall in original", () => {
    const orig: EdgeDto[] = [];
    const edges = { "0-1": basic(0, 1), "1-0": basic(1, 0) };
    const result = applyPostEditEdgeTool(edges, "reset", "0-1", 0, 1, orig);
    expect(result["0-1"]).toBeUndefined();
    expect(result["1-0"]).toBeUndefined();
  });

  it("does not mutate input edges", () => {
    const edges = { "0-1": basic(0, 1) };
    applyPostEditEdgeTool(edges, "wall", "0-1", 0, 1, []);
    expect(edges["0-1"]).toBeDefined();
  });
});
