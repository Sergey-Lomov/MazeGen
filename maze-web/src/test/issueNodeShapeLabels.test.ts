import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { nodeShapeLabel } from "../components/features/nodeShapeLimits";
import { nodeShapeSiblingsOf, registerNodeShapeSiblingsSource } from "../components/features/nodeShapeSiblings";
import { resolveIssueSourceDescription, resolveIssueSourceLabel } from "../components/issueRegistry";

const SQUARE = ["dead_end", "straight", "turn_90", "junction_4_0-1-2", "junction_4_0-1-2-3"];

describe("nodeShapeSiblingsOf", () => {
  it("knows nothing until a source is registered", () => {
    registerNodeShapeSiblingsSource(null);
    expect(nodeShapeSiblingsOf("regular:4")).toBeUndefined();
  });

  it("asks the registered source", () => {
    registerNodeShapeSiblingsSource((cellType) => (cellType === "regular:4" ? SQUARE : undefined));
    expect(nodeShapeSiblingsOf("regular:4")).toBe(SQUARE);
    expect(nodeShapeSiblingsOf("regular:6")).toBeUndefined();
    registerNodeShapeSiblingsSource(null);
  });
});

describe("violated_node_shape_limits bubble labels", () => {
  beforeAll(() => {
    registerNodeShapeSiblingsSource((cellType) => (cellType === "regular:4" ? SQUARE : undefined));
  });
  afterAll(() => registerNodeShapeSiblingsSource(null));

  it("names a lone junction of its degree by degree alone, like the limits editor", () => {
    const label = resolveIssueSourceLabel("violated_node_shape_limits", "node_shape_limits", {
      shapes: "regular:4/junction_4_0-1-2",
    });
    expect(label).toContain(nodeShapeLabel("junction_3"));
    expect(label).not.toContain("1-2-3");
  });

  it("uses the same label in the violation bullets", () => {
    const lines = resolveIssueSourceDescription("violated_node_shape_limits", "node_shape_limits", {
      shapes: "regular:4/junction_4_0-1-2",
      violations: "regular:4/junction_4_0-1-2:excess:7:5",
    }).split("\n");
    expect(lines[1]).toContain(nodeShapeLabel("junction_3"));
    expect(lines[1]).not.toContain("1-2-3");
  });

  it("shows degree and faces when the cell type's vocabulary is unknown", () => {
    const label = resolveIssueSourceLabel("violated_node_shape_limits", "node_shape_limits", {
      shapes: "regular:6/junction_6_0-1-3",
    });
    expect(label).toContain(nodeShapeLabel("junction_6_0-1-3"));
    expect(label).toContain("1-2-4");
  });
});
