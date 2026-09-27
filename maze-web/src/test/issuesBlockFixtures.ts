import type { IssueDto } from "../wasm/types";

export function missingEndpointsIssue(sourceCheck: string): IssueDto {
  // `missing_endpoints` is a `NO_DETAIL_CHECKS` entry -- no per-element highlight payload, no
  // `.with_detail(...)` data on the Rust side.
  return {
    kind: "missing_endpoints",
    payload: { kind: "none" },
    source_checks: [sourceCheck],
    source_check_types: { [sourceCheck]: sourceCheck },
    details: {},
  };
}

export function invalidLoopIssue(sourceCheck: string): IssueDto {
  return {
    kind: "invalid_loop",
    payload: { kind: "invalid_loop", edges: { [sourceCheck]: [{ edges: [[1, 2]], preset_locked: false }] } },
    source_checks: [sourceCheck],
    source_check_types: { [sourceCheck]: sourceCheck },
    details: {},
  };
}

export function invalidTeleportIssue(sourceCheck: string): IssueDto {
  return {
    kind: "invalid_teleport",
    payload: { kind: "invalid_teleport", groups: { [sourceCheck]: [{ edges: [[3, 4]], preset_locked: false }] } },
    source_checks: [sourceCheck],
    source_check_types: { [sourceCheck]: sourceCheck },
    details: {},
  };
}

export function invalidOneWayIssue(sourceCheck: string): IssueDto {
  return {
    kind: "invalid_one_way",
    payload: { kind: "invalid_one_way", groups: { [sourceCheck]: [{ edges: [[3, 4]], preset_locked: false }] } },
    source_checks: [sourceCheck],
    source_check_types: { [sourceCheck]: sourceCheck },
    details: {},
  };
}

export function invalidVerticalPassageIssue(sourceCheck: string, groups: { edges: [number, number][]; preset_locked: boolean }[] = [{ edges: [[3, 4]], preset_locked: false }]): IssueDto {
  return {
    kind: "invalid_vertical_passage",
    payload: { kind: "invalid_vertical_passage", groups: { [sourceCheck]: groups } },
    source_checks: [sourceCheck],
    source_check_types: { [sourceCheck]: sourceCheck },
    details: {},
  };
}

export function regionNeedsExpansionIssue(sourceCheck: string, regions: { region: number[]; preset_locked: boolean }[] = [{ region: [5, 6], preset_locked: false }]): IssueDto {
  return {
    kind: "region_needs_expansion",
    payload: { kind: "region_needs_expansion", nodes: { [sourceCheck]: regions } },
    source_checks: [sourceCheck],
    source_check_types: { [sourceCheck]: sourceCheck },
    details: {},
  };
}

export function invalidElevatorStopIssue(sourceCheck: string, regions: { region: number[]; preset_locked: boolean }[] = [{ region: [5], preset_locked: false }, { region: [6], preset_locked: false }]): IssueDto {
  return {
    kind: "invalid_elevator_stop",
    payload: { kind: "invalid_elevator_stop", nodes: { [sourceCheck]: regions } },
    source_checks: [sourceCheck],
    source_check_types: { [sourceCheck]: sourceCheck },
    details: {},
  };
}

export function invalidSplitTileIssue(sourceCheck: string): IssueDto {
  // `split_distance_from_waypoint` (invalid_split_tile) resolves one group per flagged tile -- a
  // single flagged tile with 2 nodes (7 and 8, e.g. slot-0 plus one extra split node).
  return {
    kind: "invalid_split_tile",
    payload: { kind: "invalid_split_tile", groups: { [sourceCheck]: [{ tiles: [{ nodes: [7, 8], preset_locked: false }], preset_locked: false }] } },
    source_checks: [sourceCheck],
    source_check_types: { [sourceCheck]: sourceCheck },
    details: {},
  };
}

export function excessiveSccCountIssue(sourceCheck: string, presetLocked: boolean): IssueDto {
  // Carries no per-element highlight data of its own (see `IssuePayloadDto::ExcessiveSccCount`'s
  // doc comment) -- just a single check-level `preset_locked` bool.
  return {
    kind: "excessive_scc_count",
    payload: { kind: "excessive_scc_count", preset_locked: { [sourceCheck]: presetLocked } },
    source_checks: [sourceCheck],
    source_check_types: { [sourceCheck]: sourceCheck },
    details: {},
  };
}

export function invalidCrossElementGroupIssue(
  sourceCheck: string,
  entries: { kind: string; edges?: [number, number][]; nodes?: number[]; preset_locked?: boolean }[],
): IssueDto {
  return {
    kind: "invalid_cross_element_group",
    payload: {
      kind: "invalid_cross_element_group",
      groups: {
        [sourceCheck]: [
          entries.map((e) => ({
            kind: e.kind,
            edges: e.edges ?? [],
            // Matches the Rust resolver's own wire shape (`resolve_cross_element_payload_entry`):
            // only the geometry field matching `kind` is populated -- a `split` member's cells live
            // in `tile`, never `nodes` (see `CrossElementEntry`'s doc comment).
            nodes: e.kind === "split" ? [] : e.nodes ?? [],
            tile: e.kind === "split" && e.nodes != null ? { nodes: e.nodes, preset_locked: e.preset_locked ?? false } : null,
            removable: true,
            preset_locked: e.preset_locked ?? false,
          })),
        ],
      },
    },
    source_checks: [sourceCheck],
    source_check_types: { [sourceCheck]: sourceCheck },
    details: {},
  };
}

export function invalidSplitNodeGroupIssue(sourceCheck: string): IssueDto {
  // Wire-reuse: `invalid_split_node_group` resolves through the same `invalid_split_tile` payload
  // shape (narrow on `payload.kind`, not `issue.kind` -- see IssuePayload's doc comment).
  // `max_split_tile_node_count`'s groups[i] is already exactly one overflowing tile.
  return {
    kind: "invalid_split_node_group",
    payload: { kind: "invalid_split_tile", groups: { [sourceCheck]: [{ tiles: [{ nodes: [9], preset_locked: false }], preset_locked: false }] } },
    source_checks: [sourceCheck],
    source_check_types: { [sourceCheck]: sourceCheck },
    details: {},
  };
}
