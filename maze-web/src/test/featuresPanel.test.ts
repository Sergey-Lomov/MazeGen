import { describe, it, expect } from "vitest";
import {
  computeFieldStatus,
  computeAnalyticsCard,
  computeGenerationCard,
  computeImageExportCard,
  computeFloorsCard,
  presetConnectionsSubtitle,
  getTessellationKindLabel,
} from "../components/FeaturesPanel";
import { resolveIssue } from "../components/issueRegistry";
import type { FieldConfig } from "../fieldConfig";
import * as m from "~/paraglide/messages";
import { fieldOf } from "./fieldConfigFixtures";

const squareConfig: FieldConfig = fieldOf("square", { shape: "rect", cols: 3, rows: 3 });
const emptySquareConfig: FieldConfig = fieldOf("square", { shape: "rect", cols: 0, rows: 0 });

function floorField(fieldEditMode: "default" | "custom", fieldPoints: Set<number>, fieldConfig: FieldConfig) {
  return { fieldEditMode, fieldPoints, fieldConfig };
}

describe("computeFieldStatus", () => {
  it("returns unavailable when tessellation not confirmed", () => {
    expect(computeFieldStatus(false, [floorField("default", new Set(), squareConfig)])).toBe("unavailable");
  });

  it("returns critical when default mode has zero cells", () => {
    expect(computeFieldStatus(true, [floorField("default", new Set(), emptySquareConfig)])).toBe("critical");
  });

  it("returns critical when custom mode has zero points", () => {
    expect(computeFieldStatus(true, [floorField("custom", new Set(), squareConfig)])).toBe("critical");
  });

  it("returns set when default mode has cells", () => {
    expect(computeFieldStatus(true, [floorField("default", new Set(), squareConfig)])).toBe("set");
  });

  it("returns set when custom mode has points", () => {
    expect(computeFieldStatus(true, [floorField("custom", new Set([1, 2]), squareConfig)])).toBe("set");
  });

  it("returns set when total cell count across floors is nonzero, even if one floor is empty", () => {
    const floors = [
      floorField("default", new Set(), emptySquareConfig),
      floorField("default", new Set(), squareConfig),
    ];
    expect(computeFieldStatus(true, floors)).toBe("set");
  });

  it("returns critical only when every floor has zero cells", () => {
    const floors = [
      floorField("default", new Set(), emptySquareConfig),
      floorField("custom", new Set(), squareConfig),
    ];
    expect(computeFieldStatus(true, floors)).toBe("critical");
  });
});

describe("computeFloorsCard", () => {
  it("returns critical when floors is empty", () => {
    const card = computeFloorsCard([]);
    expect(card.status).toBe("critical");
  });

  it("returns set for a single floor", () => {
    const card = computeFloorsCard([{ id: "a", title: "Floor 1" }]);
    expect(card.status).toBe("set");
  });

  it("returns set for multiple floors with distinct titles", () => {
    const card = computeFloorsCard([
      { id: "a", title: "Floor 1" },
      { id: "b", title: "Floor 2" },
    ]);
    expect(card.status).toBe("set");
  });

  it("subtitle reports floor count", () => {
    expect(computeFloorsCard([{ id: "a", title: "Floor 1" }]).subtitle).toBe("1 floor");
    expect(computeFloorsCard([
      { id: "a", title: "Floor 1" },
      { id: "b", title: "Floor 2" },
    ]).subtitle).toBe("2 floors");
  });

  it("returns warning when two floors share the same title", () => {
    const card = computeFloorsCard([
      { id: "a", title: "Same" },
      { id: "b", title: "Same" },
    ]);
    expect(card.status).toBe("warning");
  });
});

describe("computeAnalyticsCard", () => {
  it("returns unavailable when no nodes", () => {
    const card = computeAnalyticsCard(false, []);
    expect(card.status).toBe("unavailable");
  });

  it("returns warning status when warnings present", () => {
    const card = computeAnalyticsCard(true, ["missing_endpoints", "unreachable_finish"]);
    expect(card.status).toBe("warning");
  });

  it("comment reports the issue count, not an issue title", () => {
    const card = computeAnalyticsCard(true, ["missing_endpoints", "unreachable_finish"]);
    expect(card.comment).not.toBe(resolveIssue("missing_endpoints").label);
    expect(card.comment).not.toBe(resolveIssue("unreachable_finish").label);
  });

  it("returns set with 'no issues' comment when no issues", () => {
    const card = computeAnalyticsCard(true, []);
    expect(card.status).toBe("set");
    expect(card.comment).toBe(m["status.analytics_no_issues"]());
  });

  it("uses singular issue count wording for exactly one issue", () => {
    const card = computeAnalyticsCard(true, ["missing_endpoints"]);
    expect(card.comment).toBe(m["status.analytics_issues"]({ count: 1 }));
  });

  it("returns critical when cycle analysis overflowed, even with warnings present", () => {
    const card = computeAnalyticsCard(true, ["missing_endpoints", "cycle_analysis_overflowed"]);
    expect(card.status).toBe("critical");
  });

  it("critical card's comment reports the total issue count, not an issue title", () => {
    const card = computeAnalyticsCard(true, ["missing_endpoints", "cycle_analysis_overflowed"]);
    expect(card.comment).toBe(m["status.analytics_issues_plural"]({ count: 2 }));
  });
});

describe("presetConnectionsSubtitle", () => {
  it("returns none-label when nothing configured", () => {
    expect(presetConnectionsSubtitle(new Map(), 0, 0)).toBeTruthy();
  });

  it("does not append invalid count to the subtitle", () => {
    const subtitle = presetConnectionsSubtitle(new Map([["a", 1]]), 0);
    expect(subtitle).toBe(m["preset.subtitle_count"]({ count: 1 }));
  });

  it("counts presets plus markers", () => {
    const subtitle = presetConnectionsSubtitle(new Map([["a", 1]]), 0, 2);
    expect(subtitle).toBeTruthy();
  });

  it("counts teleports toward the total when provided", () => {
    const withTeleports = presetConnectionsSubtitle(new Map(), 0, 2);
    const without = presetConnectionsSubtitle(new Map(), 0, 0);
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
    const result = computeGenerationCard(true, "recursive_backtracker", true, 0.5, 0);
    expect(result.status).toBe("set");
  });

  it("is not critical for custom_vertex_based even with multiple floors", () => {
    const result = computeGenerationCard(true, "custom_vertex_based", false, 0.0, 0);
    expect(result.status).toBe("set");
  });

  it("is not critical for recursive_backtracker with multiple floors (GitHub issue #417)", () => {
    const result = computeGenerationCard(true, "recursive_backtracker", false, 0.0, 0);
    expect(result.status).toBe("set");
  });

  it("is not critical for wilson_algorithm with multiple floors (GitHub issue #417)", () => {
    const result = computeGenerationCard(true, "wilson_algorithm", false, 0.0, 0);
    expect(result.status).toBe("set");
  });

  it("is not critical for kruskal_algorithm with multiple floors", () => {
    const result = computeGenerationCard(true, "kruskal_algorithm", false, 0.0, 0);
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
    expect(getTessellationKindLabel("tri")).toBeTruthy();
  });
});
