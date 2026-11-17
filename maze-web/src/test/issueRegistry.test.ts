import { describe, it, expect } from "vitest";
import { resolveIssue, isIssueEntirelyHidden, presetLockElementsFor, resolveIssueSourceDescription } from "../components/issueRegistry";
import type { IssueDto } from "../wasm/types";

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

  it("returns warning severity for region_needs_expansion", () => {
    expect(resolveIssue("region_needs_expansion").severity).toBe("warning");
  });

  it("returns non-empty label and description for every known kind", () => {
    const knownKinds = [
      "missing_endpoints",
      "unreachable_finish",
      "missing_loops",
      "invalid_loop",
      "cycle_analysis_overflowed",
      "excessive_scc_count",
      "region_needs_expansion",
      "indeterminate_distance",
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

describe("resolveIssueSourceDescription", () => {
  it("uses the one_way_group_super_hub check's own description, not invalid_one_way_group's generic proximity-check text", () => {
    // Regression: before the DETAIL_DESCRIPTIONS override was added, this fell through to
    // invalid_one_way_group's generic description, worded for the geometric/graph-proximity
    // checks and wrong for a super-hub warning.
    const description = resolveIssueSourceDescription("invalid_one_way_group", "one_way_group_super_hub");
    expect(description).not.toBe(resolveIssue("invalid_one_way_group").description);
    expect(description.length).toBeGreaterThan(0);
  });

  it("falls back to the issue kind's generic description when the check has no DETAIL_DESCRIPTIONS override", () => {
    const description = resolveIssueSourceDescription("invalid_one_way_group", "one_way_group_geometric_proximity");
    expect(description).toBe(resolveIssue("invalid_one_way_group").description);
  });
});

describe("isIssueEntirelyHidden", () => {
  function loopIssue(groups: { edges: [number, number][]; preset_locked: boolean }[]): IssueDto {
    return {
      kind: "invalid_loop",
      payload: { kind: "invalid_loop", edges: { loop_length: groups } },
      source_checks: ["loop_length"],
      source_check_types: { loop_length: "loop_length" },
      details: {},
    };
  }

  it("never hides anything when the toggle is on", () => {
    const issue = loopIssue([{ edges: [[1, 2]], preset_locked: true }]);
    expect(isIssueEntirelyHidden(issue, true)).toBe(false);
  });

  it("hides an issue whose single bubble is fully preset-locked when the toggle is off", () => {
    const issue = loopIssue([{ edges: [[1, 2]], preset_locked: true }, { edges: [[3, 4]], preset_locked: true }]);
    expect(isIssueEntirelyHidden(issue, false)).toBe(true);
  });

  it("does not hide a mixed issue (at least one non-locked element) when the toggle is off", () => {
    const issue = loopIssue([{ edges: [[1, 2]], preset_locked: true }, { edges: [[3, 4]], preset_locked: false }]);
    expect(isIssueEntirelyHidden(issue, false)).toBe(false);
  });

  it("never hides an issue with no source_checks (e.g. cycle_analysis_overflowed), regardless of the toggle", () => {
    const issue: IssueDto = {
      kind: "cycle_analysis_overflowed",
      payload: { kind: "none" },
      source_checks: [],
      source_check_types: {},
      details: {},
    };
    expect(isIssueEntirelyHidden(issue, false)).toBe(false);
  });

  it("does not hide a region_needs_expansion issue with at least one unlocked region", () => {
    const issue: IssueDto = {
      kind: "region_needs_expansion",
      payload: { kind: "region_needs_expansion", nodes: { min_region_size: [{ region: [5, 6], preset_locked: false }] } },
      source_checks: ["min_region_size"],
      source_check_types: { min_region_size: "min_region_size" },
      details: {},
    };
    expect(isIssueEntirelyHidden(issue, false)).toBe(false);
  });

  it("hides a region_needs_expansion issue when every region is preset_locked and the toggle is off", () => {
    const issue: IssueDto = {
      kind: "region_needs_expansion",
      payload: { kind: "region_needs_expansion", nodes: { min_region_size: [{ region: [5, 6], preset_locked: true }] } },
      source_checks: ["min_region_size"],
      source_check_types: { min_region_size: "min_region_size" },
      details: {},
    };
    expect(isIssueEntirelyHidden(issue, false)).toBe(true);
    expect(isIssueEntirelyHidden(issue, true)).toBe(false);
  });

  it("hides an issue only when every one of its multiple source_checks' bubbles is fully locked", () => {
    const issue: IssueDto = {
      kind: "invalid_loop",
      payload: {
        kind: "invalid_loop",
        edges: {
          min_loop_length: [{ edges: [[1, 2]], preset_locked: true }],
          max_loop_length: [{ edges: [[3, 4]], preset_locked: false }],
        },
      },
      source_checks: ["min_loop_length", "max_loop_length"],
      source_check_types: { min_loop_length: "min_loop_length", max_loop_length: "max_loop_length" },
      details: {},
    };
    expect(isIssueEntirelyHidden(issue, false)).toBe(false);
  });

  it("hides a fully preset-locked invalid_split_tile issue when the toggle is off", () => {
    const issue: IssueDto = {
      kind: "invalid_split_tile",
      payload: { kind: "invalid_split_tile", groups: { split_distance_from_waypoint: [{ tiles: [{ nodes: [7], preset_locked: true }], preset_locked: true }] } },
      source_checks: ["split_distance_from_waypoint"],
      source_check_types: { split_distance_from_waypoint: "split_distance_from_waypoint" },
      details: {},
    };
    expect(isIssueEntirelyHidden(issue, false)).toBe(true);
  });

  it("hides a fully preset-locked excessive_scc_count issue when the toggle is off", () => {
    const issue: IssueDto = {
      kind: "excessive_scc_count",
      payload: { kind: "excessive_scc_count", preset_locked: { scc_count: true } },
      source_checks: ["scc_count"],
      source_check_types: { scc_count: "scc_count" },
      details: {},
    };
    expect(isIssueEntirelyHidden(issue, false)).toBe(true);
    expect(isIssueEntirelyHidden(issue, true)).toBe(false);
  });

  it("does not hide an excessive_scc_count issue that is not preset-locked", () => {
    const issue: IssueDto = {
      kind: "excessive_scc_count",
      payload: { kind: "excessive_scc_count", preset_locked: { scc_count: false } },
      source_checks: ["scc_count"],
      source_check_types: { scc_count: "scc_count" },
      details: {},
    };
    expect(isIssueEntirelyHidden(issue, false)).toBe(false);
  });

  it("hides a fully preset-locked invalid_split_route issue when the toggle is off", () => {
    const issue: IssueDto = {
      kind: "invalid_split_route",
      payload: {
        kind: "invalid_split_route",
        routes: { split_node_connection_traversal_distance: [{ edges: [{ from: 1, to: 2, is_split_edge: true }], preset_locked: true }] },
      },
      source_checks: ["split_node_connection_traversal_distance"],
      source_check_types: { split_node_connection_traversal_distance: "split_node_connection_traversal_distance" },
      details: {},
    };
    expect(isIssueEntirelyHidden(issue, false)).toBe(true);
  });
});

describe("presetLockElementsFor", () => {
  it("extracts invalid_loop's edge groups for the given source check", () => {
    const issue: IssueDto = {
      kind: "invalid_loop",
      payload: { kind: "invalid_loop", edges: { loop_length: [{ edges: [[1, 2]], preset_locked: true }] } },
      source_checks: ["loop_length"],
      source_check_types: { loop_length: "loop_length" },
      details: {},
    };
    expect(presetLockElementsFor(issue, "loop_length")).toEqual([{ edges: [[1, 2]], preset_locked: true }]);
  });

  it("extracts invalid_teleport's groups for the given source check", () => {
    const issue: IssueDto = {
      kind: "invalid_teleport",
      payload: { kind: "invalid_teleport", groups: { teleport_duplicates_connection: [{ edges: [[3, 4]], preset_locked: false }] } },
      source_checks: ["teleport_duplicates_connection"],
      source_check_types: { teleport_duplicates_connection: "teleport_duplicates_connection" },
      details: {},
    };
    expect(presetLockElementsFor(issue, "teleport_duplicates_connection")).toEqual([{ edges: [[3, 4]], preset_locked: false }]);
  });

  it("extracts invalid_one_way's groups for the given source check", () => {
    const issue: IssueDto = {
      kind: "invalid_one_way",
      payload: { kind: "invalid_one_way", groups: { one_way_waypoint_distance: [{ edges: [[5, 6]], preset_locked: true }] } },
      source_checks: ["one_way_waypoint_distance"],
      source_check_types: { one_way_waypoint_distance: "one_way_waypoint_distance" },
      details: {},
    };
    expect(presetLockElementsFor(issue, "one_way_waypoint_distance")).toEqual([{ edges: [[5, 6]], preset_locked: true }]);
  });

  it("extracts invalid_split_tile's group payloads for the given source check (invalid_split_node/invalid_split_tile share this)", () => {
    const issue: IssueDto = {
      kind: "invalid_split_node",
      payload: { kind: "invalid_split_tile", groups: { split_node_connection_count: [{ tiles: [{ nodes: [7], preset_locked: true }], preset_locked: true }] } },
      source_checks: ["split_node_connection_count"],
      source_check_types: { split_node_connection_count: "split_node_connection_count" },
      details: {},
    };
    expect(presetLockElementsFor(issue, "split_node_connection_count")).toEqual([{ tiles: [{ nodes: [7], preset_locked: true }], preset_locked: true }]);
  });

  it("extracts invalid_split_tile's group payloads for invalid_split_node_group (wire-reused kind)", () => {
    const issue: IssueDto = {
      kind: "invalid_split_node_group",
      payload: { kind: "invalid_split_tile", groups: { max_split_tile_node_count: [{ tiles: [{ nodes: [9], preset_locked: false }], preset_locked: false }] } },
      source_checks: ["max_split_tile_node_count"],
      source_check_types: { max_split_tile_node_count: "max_split_tile_node_count" },
      details: {},
    };
    expect(presetLockElementsFor(issue, "max_split_tile_node_count")).toEqual([{ tiles: [{ nodes: [9], preset_locked: false }], preset_locked: false }]);
  });

  it("splits max_split_count's single field-wide group into per-tile elements for hide/count purposes", () => {
    const issue: IssueDto = {
      kind: "invalid_split_tile_group",
      payload: {
        kind: "invalid_split_tile",
        groups: {
          max_split_count: [{
            tiles: [
              { nodes: [1], preset_locked: true },
              { nodes: [2], preset_locked: false },
              { nodes: [3], preset_locked: true },
            ],
            preset_locked: false,
          }],
        },
      },
      source_checks: ["max_split_count"],
      source_check_types: { max_split_count: "max_split_count" },
      details: {},
    };
    expect(presetLockElementsFor(issue, "max_split_count")).toEqual([
      { nodes: [1], preset_locked: true },
      { nodes: [2], preset_locked: false },
      { nodes: [3], preset_locked: true },
    ]);
  });

  it("keeps split_group_geometric_proximity's pair as one group element, not split into per-tile elements", () => {
    const issue: IssueDto = {
      kind: "invalid_split_tile_group",
      payload: {
        kind: "invalid_split_tile",
        groups: {
          split_group_geometric_proximity: [{
            tiles: [{ nodes: [1], preset_locked: true }, { nodes: [2], preset_locked: true }],
            preset_locked: true,
          }],
        },
      },
      source_checks: ["split_group_geometric_proximity"],
      source_check_types: { split_group_geometric_proximity: "split_group_geometric_proximity" },
      details: {},
    };
    expect(presetLockElementsFor(issue, "split_group_geometric_proximity")).toEqual([{
      tiles: [{ nodes: [1], preset_locked: true }, { nodes: [2], preset_locked: true }],
      preset_locked: true,
    }]);
  });

  it("extracts invalid_split_route's route payloads for the given source check", () => {
    const issue: IssueDto = {
      kind: "invalid_split_route",
      payload: {
        kind: "invalid_split_route",
        routes: { split_node_connection_traversal_distance: [{ edges: [{ from: 1, to: 2, is_split_edge: true }], preset_locked: true }] },
      },
      source_checks: ["split_node_connection_traversal_distance"],
      source_check_types: { split_node_connection_traversal_distance: "split_node_connection_traversal_distance" },
      details: {},
    };
    expect(presetLockElementsFor(issue, "split_node_connection_traversal_distance")).toEqual([
      { edges: [{ from: 1, to: 2, is_split_edge: true }], preset_locked: true },
    ]);
  });

  it("returns region_needs_expansion's regions with their own preset_locked flags", () => {
    const issue: IssueDto = {
      kind: "region_needs_expansion",
      payload: { kind: "region_needs_expansion", nodes: { min_region_size: [{ region: [5, 6], preset_locked: true }] } },
      source_checks: ["min_region_size"],
      source_check_types: { min_region_size: "min_region_size" },
      details: {},
    };
    expect(presetLockElementsFor(issue, "min_region_size")).toEqual([{ region: [5, 6], preset_locked: true }]);
  });

  it("returns region_needs_shrink's regions with their own preset_locked flags", () => {
    const issue: IssueDto = {
      kind: "region_needs_shrink",
      payload: { kind: "region_needs_shrink", nodes: { max_region_size: [{ region: [7, 8], preset_locked: false }] } },
      source_checks: ["max_region_size"],
      source_check_types: { max_region_size: "max_region_size" },
      details: {},
    };
    expect(presetLockElementsFor(issue, "max_region_size")).toEqual([{ region: [7, 8], preset_locked: false }]);
  });

  it("returns invalid_elevator_stop's single-node regions with their own preset_locked flags (GitHub issue #399)", () => {
    const issue: IssueDto = {
      kind: "invalid_elevator_stop",
      payload: { kind: "invalid_elevator_stop", nodes: { max_elevator_stops: [{ region: [5], preset_locked: true }] } },
      source_checks: ["max_elevator_stops"],
      source_check_types: { max_elevator_stops: "max_elevator_stops" },
      details: {},
    };
    expect(presetLockElementsFor(issue, "max_elevator_stops")).toEqual([{ region: [5], preset_locked: true }]);
  });

  it("wraps excessive_scc_count's single check-level preset_locked bool as a one-element array", () => {
    const issue: IssueDto = {
      kind: "excessive_scc_count",
      payload: { kind: "excessive_scc_count", preset_locked: { scc_count: true } },
      source_checks: ["scc_count"],
      source_check_types: { scc_count: "scc_count" },
      details: {},
    };
    expect(presetLockElementsFor(issue, "scc_count")).toEqual([{ preset_locked: true }]);
  });

  it("returns null for excessive_scc_count when the given source check has no entry", () => {
    const issue: IssueDto = {
      kind: "excessive_scc_count",
      payload: { kind: "excessive_scc_count", preset_locked: {} },
      source_checks: ["scc_count"],
      source_check_types: { scc_count: "scc_count" },
      details: {},
    };
    expect(presetLockElementsFor(issue, "scc_count")).toBeNull();
  });

  it("does not mix elements from a different source check when an issue has multiple contributing checks", () => {
    // Regression: a merged issue with two source_checks must isolate each check's own elements --
    // asking for one check's slice must never leak the other's.
    const issue: IssueDto = {
      kind: "invalid_loop",
      payload: {
        kind: "invalid_loop",
        edges: {
          min_loop_length: [{ edges: [[1, 2]], preset_locked: true }],
          max_loop_length: [{ edges: [[3, 4]], preset_locked: false }],
        },
      },
      source_checks: ["min_loop_length", "max_loop_length"],
      source_check_types: { min_loop_length: "min_loop_length", max_loop_length: "max_loop_length" },
      details: {},
    };
    expect(presetLockElementsFor(issue, "min_loop_length")).toEqual([{ edges: [[1, 2]], preset_locked: true }]);
    expect(presetLockElementsFor(issue, "max_loop_length")).toEqual([{ edges: [[3, 4]], preset_locked: false }]);
  });
});
