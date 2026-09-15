import { describe, it, expect } from "vitest";
import { formatScore } from "../components/features/AnalyticsSections";

// GitHub issue #532/#534 round-3 feedback: score display must show at most 2 decimal places,
// drop trailing zero decimals, and never round to a 3rd decimal.
describe("formatScore", () => {
  it("drops decimals entirely for a whole number", () => {
    expect(formatScore(3)).toBe("3");
  });

  it("drops a trailing zero decimal", () => {
    expect(formatScore(3.5)).toBe("3.5");
  });

  it("keeps 2 non-zero decimals", () => {
    expect(formatScore(3.14)).toBe("3.14");
  });

  it("rounds a 3rd decimal away instead of ever showing it", () => {
    expect(formatScore(1.004)).toBe("1");
    expect(formatScore(3.001)).toBe("3");
    expect(formatScore(2.229)).toBe("2.23");
  });

  it("handles zero", () => {
    expect(formatScore(0)).toBe("0");
  });
});
