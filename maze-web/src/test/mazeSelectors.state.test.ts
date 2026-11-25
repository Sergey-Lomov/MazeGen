import { describe, expect, it } from "vitest";
import { selectAnalyticsIssues } from "../domain/selectors/mazeSelectors";
import type { IssueDto } from "../wasm/types";

const repairLimitIssue: IssueDto = {
  kind: "repair_limit_reached",
  payload: { kind: "none" },
  source_checks: [],
  source_check_types: {},
  details: { repair_limit_reached: { limit: "max_iterations" } },
  scope_id: null,
};

const missingEndpointsIssue: IssueDto = {
  kind: "missing_endpoints",
  payload: { kind: "none" },
  source_checks: [],
  source_check_types: {},
  details: {},
  scope_id: null,
};

describe("selectAnalyticsIssues", () => {
  it("does not duplicate a repair-limit issue when generated issues are the fallback", () => {
    expect(selectAnalyticsIssues({
      issues: [repairLimitIssue, missingEndpointsIssue],
      postEditAnalytics: null,
    })).toEqual([repairLimitIssue, missingEndpointsIssue]);
  });

  it("carries the repair-limit issue forward when post-edit analytics replaces generated issues", () => {
    expect(selectAnalyticsIssues({
      issues: [repairLimitIssue],
      postEditAnalytics: { issues: [missingEndpointsIssue] } as never,
    })).toEqual([repairLimitIssue, missingEndpointsIssue]);
  });
});
