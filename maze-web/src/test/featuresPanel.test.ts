import { describe, it, expect } from "vitest";
import {
  computeFieldStatus,
  computeAnalyticsCard,
  presetConnectionsSubtitle,
  getTessellationKindLabel,
} from "../components/FeaturesPanel";
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
    const card = computeAnalyticsCard(false, 0, false);
    expect(card.status).toBe("unavailable");
    expect(card.subtitle).toBeUndefined();
  });

  it("returns warning with subtitle when warnings present", () => {
    const card = computeAnalyticsCard(true, 2, false);
    expect(card.status).toBe("warning");
    expect(card.subtitle).toBeDefined();
  });

  it("returns set with no subtitle when no warnings", () => {
    const card = computeAnalyticsCard(true, 0, false);
    expect(card.status).toBe("set");
    expect(card.subtitle).toBeUndefined();
  });

  it("returns critical when cycle analysis overflowed, even with warnings present", () => {
    const card = computeAnalyticsCard(true, 2, true);
    expect(card.status).toBe("critical");
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
});

describe("getTessellationKindLabel", () => {
  it("returns non-empty label for each kind", () => {
    expect(getTessellationKindLabel("square")).toBeTruthy();
    expect(getTessellationKindLabel("hex")).toBeTruthy();
    expect(getTessellationKindLabel("triangle")).toBeTruthy();
  });
});
