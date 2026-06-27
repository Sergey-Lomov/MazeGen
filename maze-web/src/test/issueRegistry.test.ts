import { describe, it, expect } from "vitest";
import { resolveIssue } from "../components/issueRegistry";

describe("resolveIssue", () => {
  it("returns warning severity for missing_endpoints", () => {
    expect(resolveIssue("missing_endpoints").severity).toBe("warning");
  });

  it("returns warning severity for unreachable_finish", () => {
    expect(resolveIssue("unreachable_finish").severity).toBe("warning");
  });

  it("returns warning severity for missing_loops", () => {
    expect(resolveIssue("missing_loops").severity).toBe("warning");
  });

  it("returns warning severity for invalid_loop", () => {
    expect(resolveIssue("invalid_loop").severity).toBe("warning");
  });

  it("returns critical severity for cycle_analysis_overflowed", () => {
    expect(resolveIssue("cycle_analysis_overflowed").severity).toBe("critical");
  });

  it("returns warning severity for excessive_scc_count", () => {
    expect(resolveIssue("excessive_scc_count").severity).toBe("warning");
  });

  it("returns non-empty label and description for every known kind", () => {
    const knownKinds = [
      "missing_endpoints",
      "unreachable_finish",
      "missing_loops",
      "invalid_loop",
      "cycle_analysis_overflowed",
      "excessive_scc_count",
    ];
    for (const kind of knownKinds) {
      const info = resolveIssue(kind);
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.description.length).toBeGreaterThan(0);
    }
  });

  it("falls back to the raw kind as label with empty description for an unknown kind", () => {
    const info = resolveIssue("some_future_issue_kind");
    expect(info.label).toBe("some_future_issue_kind");
    expect(info.description).toBe("");
  });

  it("defaults unknown kinds to warning severity, not critical", () => {
    expect(resolveIssue("some_future_issue_kind").severity).toBe("warning");
  });
});
