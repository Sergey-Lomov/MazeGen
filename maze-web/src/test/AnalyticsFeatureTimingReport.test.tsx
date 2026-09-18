import { describe, it, beforeEach, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TimingDetailedReportModal } from "../components/features/AnalyticsFeature";
import { useMazeStore } from "../store/mazeStore";
import type { GenerationTimingDto } from "../wasm/types";

// A real multi-level tree (stage -> rule -> check + strategy), the same shape `run_full`
// actually produces — proves the recursive kind-flow in `TimingReportRow` (root -> stage -> rule
// -> check/strategy) resolves every depth correctly, not just the standalone leafKind/
// resolveTimingRowLabel functions in isolation (see AnalyticsFeatureTiming.test.ts).
const timing: GenerationTimingDto = {
  initial_build_ms: 10,
  snapshot_ms: 0,
  qc: [
    {
      id: "stage_1",
      total_ms: 20,
      calls: 1,
      children: [
        {
          id: "rule_1",
          total_ms: 20,
          calls: 0,
          children: [
            { id: "loop_length", total_ms: 5, calls: 3, children: [] },
            { id: "farthest_endpoints", total_ms: 15, calls: 1, children: [] },
          ],
        },
      ],
    },
  ],
};

beforeEach(() => {
  useMazeStore.setState({
    stages: [{ id: "stage_1", name: "Waypoints", ruleIds: ["rule_1"], disabled: false, collapsed: false }],
    rules: [{ id: "rule_1", name: "Fix endpoints", kind: "missing_endpoints", checks: [], nextLocalCheckId: 0, strategyId: "farthest_endpoints", disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false }],
    availableChecks: [{ id: "loop_length", label: "Loop length", description: "", issue_kinds: [], params: [], allow_multiple_instances: false }],
  });
});

describe("TimingDetailedReportModal", () => {
  it("prefixes the stage row with its resolved name", () => {
    render(<TimingDetailedReportModal timing={timing} onClose={() => {}} />);
    expect(screen.getByText(/Waypoints/)).toBeInTheDocument();
  });

  it("prefixes the rule row with its resolved name", () => {
    render(<TimingDetailedReportModal timing={timing} onClose={() => {}} />);
    expect(screen.getByText(/Fix endpoints/)).toBeInTheDocument();
  });

  it("resolves a rule with no custom name from its issue kind", () => {
    useMazeStore.setState({
      rules: [{ id: "rule_1", name: null, kind: "missing_loops", checks: [], nextLocalCheckId: 0, strategyId: "farthest_endpoints", disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false }],
    });
    render(<TimingDetailedReportModal timing={timing} onClose={() => {}} />);
    expect(screen.getByText(/Add loops/)).toBeInTheDocument();
  });

  it("labels a known check id as a check, not a strategy", () => {
    render(<TimingDetailedReportModal timing={timing} onClose={() => {}} />);
    expect(screen.getByText(/Loop length/)).toBeInTheDocument();
  });

  it("labels an id absent from availableChecks as a strategy", () => {
    render(<TimingDetailedReportModal timing={timing} onClose={() => {}} />);
    // "farthest_endpoints" resolves to its registered human-readable label — proves the leaf
    // was classified as a strategy (resolveStrategyLabel), not a check (resolveCheckLabel would
    // fall back to the raw id since it's absent from availableChecks in this test's store state).
    expect(screen.getByText(/Farthest endpoints/)).toBeInTheDocument();
  });
});
