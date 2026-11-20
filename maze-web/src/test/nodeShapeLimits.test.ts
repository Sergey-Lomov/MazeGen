import { describe, it, expect } from "vitest";
import * as m from "~/paraglide/messages";
import {
  activeLimitCount,
  nodeShapeCellTypeLabel,
  nodeShapeLabel,
  parseNodeShapeLimits,
  serializeNodeShapeLimits,
  splitTypedShape,
} from "../components/features/nodeShapeLimits";

describe("nodeShapeLimits", () => {
  it("round-trips a limits value", () => {
    const raw = '{"regular:4":{"turn_90":{"min":2,"max":null},"dead_end":{"min":null,"max":3}}}';
    const limits = parseNodeShapeLimits(raw);
    expect(limits).toEqual({ "regular:4": { turn_90: { min: 2, max: null }, dead_end: { min: null, max: 3 } } });
    expect(parseNodeShapeLimits(serializeNodeShapeLimits(limits))).toEqual(limits);
  });

  it("treats missing or malformed values as no limits", () => {
    expect(parseNodeShapeLimits(undefined)).toEqual({});
    expect(parseNodeShapeLimits("")).toEqual({});
    expect(parseNodeShapeLimits("[1]")).toEqual({});
    expect(parseNodeShapeLimits("not json")).toEqual({});
  });

  it("counts only shapes that constrain something", () => {
    expect(activeLimitCount({
      "regular:6": { straight: { min: null, max: null }, turn_60: { min: 1, max: null } },
      "regular:3": { straight: { min: null, max: 2 } },
    })).toBe(2);
  });

  it("labels every key family and passes unknown keys through", () => {
    expect(nodeShapeLabel("turn_120")).toContain("120");
    expect(nodeShapeLabel("junction_6_0-1-2-3")).toContain("4");
    expect(nodeShapeLabel("junction_6_0-1-3")).toContain("1-2-4");
    expect(nodeShapeLabel("junction_5")).toContain("5");
    expect(nodeShapeLabel("mystery")).toBe("mystery");
  });

  it("names a junction by degree alone when it is the only one of that degree", () => {
    const square = ["dead_end", "junction_4_0-1-2", "junction_4_0-1-2-3"];
    expect(nodeShapeLabel("junction_4_0-1-2", square)).toBe(nodeShapeLabel("junction_3"));
    expect(nodeShapeLabel("junction_4_0-1-2-3", square)).toBe(nodeShapeLabel("junction_4"));
  });

  it("names junctions by faces alone when several share a degree", () => {
    const hex = ["junction_6_0-1-2", "junction_6_0-1-3", "junction_6_0-1-2-3"];
    expect(nodeShapeLabel("junction_6_0-1-3", hex)).toBe(m["node_shape.junction_faces"]({ faces: "1-2-4" }));
    expect(nodeShapeLabel("junction_6_0-1-2", hex)).toBe(m["node_shape.junction_faces"]({ faces: "1-2-3" }));
    expect(nodeShapeLabel("junction_6_0-1-2-3", hex)).toBe(nodeShapeLabel("junction_4"));
  });
});

describe("serializeNodeShapeLimits", () => {
  it("drops entries with no bound", () => {
    const raw = serializeNodeShapeLimits({
      "regular:6": { straight: { min: null, max: null }, turn_60: { min: 1, max: null } },
      "regular:3": { straight: { min: null, max: null } },
    });
    expect(parseNodeShapeLimits(raw)).toEqual({ "regular:6": { turn_60: { min: 1, max: null } } });
  });
});

describe("violated_node_shape_limits bubble", () => {
  const details = {
    shapes: "regular:4/dead_end,regular:6/junction_6_0-1-3",
    violations: "regular:4/dead_end:excess:7:5;regular:6/junction_6_0-1-3:deficit:1:2",
  };

  it("names the violated shapes in the title", async () => {
    const { resolveIssueSourceLabel } = await import("../components/issueRegistry");
    const label = resolveIssueSourceLabel("violated_node_shape_limits", "node_shape_limits", details);
    expect(label).toContain(nodeShapeLabel("dead_end"));
    expect(label).toContain(nodeShapeLabel("junction_6_0-1-3"));
  });

  it("lists one bullet per violation under the description", async () => {
    const { resolveIssueSourceDescription } = await import("../components/issueRegistry");
    const lines = resolveIssueSourceDescription("violated_node_shape_limits", "node_shape_limits", details).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(nodeShapeLabel("dead_end"));
    expect(lines[1]).toContain("7");
    expect(lines[1]).toContain("5");
    expect(lines[2]).toContain(nodeShapeLabel("junction_6_0-1-3"));
  });

  it("names the cell type only when several are involved", async () => {
    const { resolveIssueSourceLabel } = await import("../components/issueRegistry");
    const several = resolveIssueSourceLabel("violated_node_shape_limits", "node_shape_limits", {
      shapes: "regular:4/dead_end,regular:8/dead_end",
    });
    expect(several).toContain(nodeShapeCellTypeLabel("regular:4"));
    expect(several).toContain(nodeShapeCellTypeLabel("regular:8"));
    const single = resolveIssueSourceLabel("violated_node_shape_limits", "node_shape_limits", { shapes: "regular:4/dead_end,regular:4/straight" });
    expect(single).not.toContain(nodeShapeCellTypeLabel("regular:4"));
  });
});

describe("cell type helpers", () => {
  it("labels regular cell types and passes unknown ones through", () => {
    expect(nodeShapeCellTypeLabel("regular:4")).not.toBe("regular:4");
    expect(nodeShapeCellTypeLabel("custom:7")).toBe("custom:7");
  });

  it("splits a typed shape entry", () => {
    expect(splitTypedShape("regular:8/turn_135")).toEqual({ cellType: "regular:8", shape: "turn_135" });
  });
});
