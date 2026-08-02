import { describe, it, expect } from "vitest";
import {
  computeFieldStatus,
  computeAnalyticsCard,
  computeGenerationCard,
  computeImageExportCard,
  presetConnectionsSubtitle,
  getTessellationKindLabel,
} from "../components/FeaturesPanel";
import { resolveIssue } from "../components/issueRegistry";
import type { FieldConfig } from "../fieldConfig";

const squareConfig: FieldConfig = { type: "square", width: 3, height: 3 };
const emptySquareConfig: FieldConfig = { type: "square", width: 0, height: 0 };

describe("computeFieldStatus", () => {
  it("returns unavailable when tessellation not confirmed", () => {
    expect(computeFieldStatus(false, "default", new Set(), squareConfig)).toBe("unavailable");
  });

  it("returns critical when default mode has zero cells", () => {
    expect(computeFieldStatus(true, "default", new Set(), emptySquareConfig)).toBe("critical");
  });

  it("returns critical when custom mode has zero points", () => {
    expect(computeFieldStatus(true, "custom", new Set(), squareConfig)).toBe("critical");
  });

  it("returns set when default mode has cells", () => {
    expect(computeFieldStatus(true, "default", new Set(), squareConfig)).toBe("set");
  });

  it("returns set when custom mode has points", () => {
    expect(computeFieldStatus(true, "custom", new Set([1, 2]), squareConfig)).toBe("set");
  });
});

describe("computeAnalyticsCard", () => {
  it("returns unavailable when no nodes", () => {
    const card = computeAnalyticsCard(false, []);
    expect(card.status).toBe("unavailable");
    expect(card.subtitle).toBeUndefined();
  });

  it("returns warning with subtitle when warnings present", () => {
    const card = computeAnalyticsCard(true, ["missing_endpoints", "unreachable_finish"]);
    expect(card.status).toBe("warning");
    expect(card.subtitle).toBeDefined();
  });

  it("comment is the title of the first warning issue", () => {
    const card = computeAnalyticsCard(true, ["missing_endpoints", "unreachable_finish"]);
    expect(card.comment).toBe(resolveIssue("missing_endpoints").label);
  });

  it("returns set with no subtitle when no warnings", () => {
    const card = computeAnalyticsCard(true, []);
    expect(card.status).toBe("set");
    expect(card.subtitle).toBeUndefined();
  });

  it("returns critical when cycle analysis overflowed, even with warnings present", () => {
    const card = computeAnalyticsCard(true, ["missing_endpoints", "cycle_analysis_overflowed"]);
    expect(card.status).toBe("critical");
  });

  it("critical card still has a subtitle with the total issue count", () => {
    const card = computeAnalyticsCard(true, ["missing_endpoints", "cycle_analysis_overflowed"]);
    expect(card.subtitle).toBeDefined();
  });

  it("comment is the title of the critical issue, not the warning", () => {
    const card = computeAnalyticsCard(true, ["missing_endpoints", "cycle_analysis_overflowed"]);
    expect(card.comment).toBe(resolveIssue("cycle_analysis_overflowed").label);
  });
});

describe("presetConnectionsSubtitle", () => {
  it("returns none-label when nothing configured", () => {
    expect(presetConnectionsSubtitle(new Map(), 0, 0)).toBeTruthy();
  });

  it("includes invalid count marker when invalidCount > 0", () => {
    const subtitle = presetConnectionsSubtitle(new Map([["a", 1]]), 1, 0);
    expect(subtitle).toContain("·");
  });

  it("counts presets plus markers", () => {
    const subtitle = presetConnectionsSubtitle(new Map([["a", 1]]), 0, 2);
    expect(subtitle).toBeTruthy();
  });

  it("counts teleports toward the total when provided", () => {
    const withTeleports = presetConnectionsSubtitle(new Map(), 0, 0, 2);
    const without = presetConnectionsSubtitle(new Map(), 0, 0, 0);
    expect(withTeleports).not.toBe(without);
  });
});

describe("computeGenerationCard", () => {
  it("is unavailable before tessellation is confirmed, regardless of other params", () => {
    const result = computeGenerationCard(false, "custom_vertex_based", true, 0.5, 0);
    expect(result.status).toBe("unavailable");
  });

  it("is set (ready) once confirmed, with no pattern-mode config in play", () => {
    const result = computeGenerationCard(true, "custom_vertex_based", false, 0.0, 0);
    expect(result.status).toBe("set");
  });

  it("warns when pattern mode is on, split chance is positive, and no patterns are defined", () => {
    const result = computeGenerationCard(true, "custom_vertex_based", true, 0.5, 0);
    expect(result.status).toBe("warning");
  });

  it("does not warn once at least one pattern is defined", () => {
    const result = computeGenerationCard(true, "custom_vertex_based", true, 0.5, 1);
    expect(result.status).toBe("set");
  });

  it("does not warn when pattern mode is off, even with zero patterns and a positive split chance", () => {
    const result = computeGenerationCard(true, "custom_vertex_based", false, 0.5, 0);
    expect(result.status).toBe("set");
  });

  it("does not warn when split chance is zero, even with pattern mode on and no patterns", () => {
    const result = computeGenerationCard(true, "custom_vertex_based", true, 0.0, 0);
    expect(result.status).toBe("set");
  });

  it("does not warn for a non-vertex-based method, even with pattern mode/chance/empty patterns set", () => {
    // Pattern mode only exists for custom_vertex_based (see GenerationFeature.tsx's isVertexBased) —
    // this combination shouldn't occur in practice, but the check must still gate on method.
    const result = computeGenerationCard(true, "custom_edge_based", true, 0.5, 0);
    expect(result.status).toBe("set");
  });
});

describe("computeImageExportCard", () => {
  it("is unavailable when no maze has been generated", () => {
    const card = computeImageExportCard(false, null);
    expect(card.status).toBe("unavailable");
  });

  it("is unavailable even if a render mode was somehow resolved, when there are no nodes", () => {
    const card = computeImageExportCard(false, { label: () => "Vector by walls" });
    expect(card.status).toBe("unavailable");
  });

  it("warns when a maze exists but no render mode is resolved (null — nothing selected yet)", () => {
    const card = computeImageExportCard(true, null);
    expect(card.status).toBe("warning");
  });

  it("is set when a maze exists and a render mode resolved, comment names it", () => {
    const card = computeImageExportCard(true, { label: () => "Vector by walls" });
    expect(card.status).toBe("set");
    expect(card.comment).toContain("Vector by walls");
  });

  it("treats a stale/unknown activeRenderMode (resolves to null) the same as no selection — never crashes", () => {
    // Mirrors resolveRenderMode's fallback for an id no longer in the registry (e.g. a project
    // file saved with a since-removed mode) — the card must read as "not selected", not throw.
    const card = computeImageExportCard(true, null);
    expect(card.status).toBe("warning");
  });
});

describe("getTessellationKindLabel", () => {
  it("returns non-empty label for each kind", () => {
    expect(getTessellationKindLabel("square")).toBeTruthy();
    expect(getTessellationKindLabel("hex")).toBeTruthy();
    expect(getTessellationKindLabel("triangle")).toBeTruthy();
  });
});
