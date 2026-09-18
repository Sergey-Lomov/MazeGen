mod resolvers;
#[cfg(test)]
mod tests;
mod types;

pub use types::{
    CrossElementPayloadEntry, IssueEdgeGroupPayload, IssueMissingElevatorStopsPayload,
    IssuePayload, IssueRegionPayload, IssueRouteEdge, IssueRoutePayload, IssueSplitGroupPayload,
    IssueSplitTilePayload,
};

use super::issue::Issue;
use super::issue_kinds::InvalidCrossElementGroupIssue;
use super::issue_kinds::{
    AreaMissingElevatorStopsIssue, ExcessiveElevatorStopGapIssue, ExcessiveSccCountIssue,
    InvalidElevatorGroupIssue, InvalidElevatorIssue, InvalidElevatorStopGroupIssue,
    InvalidElevatorStopIssue, InvalidLoopGroupIssue, InvalidLoopIssue, InvalidOneWayGroupIssue,
    InvalidOneWayIssue, InvalidSplitNodeConnectionGroupIssue, InvalidSplitNodeGroupIssue,
    InvalidSplitNodeIssue, InvalidSplitRouteIssue, InvalidSplitTileGroupIssue,
    InvalidSplitTileIssue, InvalidTeleportGroupIssue, InvalidTeleportIssue,
    InvalidVerticalPassageGroupIssue, InvalidVerticalPassageIssue, MissingElevatorHeightIssue,
    MissingElevatorStopCountIssue, MissingElevatorsIssue, MissingTeleportsIssue,
    MissingVerticalPassagesIssue, RegionNeedsExpansionIssue, RegionNeedsShrinkIssue,
};
use crate::generation::PresetState;
use crate::graph::Graph;
use crate::graph::scc::ConnectedComponents;
use crate::space::{MultiLevelField, Tessellation};
use resolvers::{
    excessive_scc_count_preset_locked, region_preset_locked_for_expansion,
    region_preset_locked_for_shrink, resolve_area_deficit_map, resolve_cross_element_group_payload,
    resolve_cycle_payload, resolve_edge_group_map, resolve_elevator_group_map,
    resolve_elevator_stop_group_map, resolve_excessive_elevator_stop_gap_payload,
    resolve_invalid_elevator_payload, resolve_invalid_elevator_stop_payload,
    resolve_invalid_split_node_group_payload, resolve_invalid_split_node_payload,
    resolve_invalid_split_route_payload, resolve_invalid_split_tile_group_payload,
    resolve_invalid_split_tile_payload, resolve_missing_elevator_height_payload,
    resolve_missing_elevator_stop_count_payload, resolve_region_map, resolve_single_edge_map,
};
use std::collections::HashMap;

/// Resolves `issue`'s structural payload against `graph`/`scc` — extracted from
/// `maze-wasm/src/analytics.rs`'s `build_analytics_snapshot` (GitHub issue #147) so the same
/// downcast/resolve logic backs both the JSON analytics report and the binary QC event tape,
/// instead of two independently-maintained copies.
///
/// `check_types` maps each check *instance* id (the `source`/`invalid_sources` key every group is
/// attributed to, e.g. `"rule_1:0"`) to its check *type* id (e.g. `"max_teleport_count"`) — needed
/// by `resolve_edge_group_map` to tell a batch/aggregate-excess check apart from a proximity/
/// pair-style one sharing the same resolver (see `is_batch_edge_group_type`'s doc comment); an
/// instance id absent from the map (or a `None` map, e.g. in tests with no rule context) is never
/// treated as a batch check.
pub fn resolve_issue_payload<T: Tessellation>(
    issue: &dyn Issue,
    graph: &Graph,
    field: &MultiLevelField<T>,
    scc: &ConnectedComponents,
    preset_state: &PresetState,
    check_types: Option<&HashMap<String, String>>,
) -> IssuePayload {
    if let Some(InvalidLoopIssue {
        all,
        invalid,
        invalid_sources,
        ..
    }) = issue.as_any().downcast_ref::<InvalidLoopIssue>()
    {
        let cycles = invalid.iter().filter_map(|&idx| all.get(idx));
        if let Some(payload) = resolve_cycle_payload(cycles, invalid_sources, graph, preset_state) {
            return payload;
        }
    }

    if let Some(InvalidLoopGroupIssue {
        invalid,
        invalid_sources,
        ..
    }) = issue.as_any().downcast_ref::<InvalidLoopGroupIssue>()
    {
        if let Some(payload) =
            resolve_cycle_payload(invalid.iter(), invalid_sources, graph, preset_state)
        {
            return payload;
        }
    }

    if let Some(RegionNeedsExpansionIssue {
        invalid,
        invalid_sources,
        ..
    }) = issue.as_any().downcast_ref::<RegionNeedsExpansionIssue>()
    {
        let nodes = resolve_region_map(invalid, invalid_sources, scc, |idx, region| {
            region_preset_locked_for_expansion(field, region, idx, scc, preset_state)
        });
        if !nodes.is_empty() {
            return IssuePayload::RegionNeedsExpansion { nodes };
        }
    }

    if let Some(RegionNeedsShrinkIssue {
        invalid,
        invalid_sources,
        ..
    }) = issue.as_any().downcast_ref::<RegionNeedsShrinkIssue>()
    {
        let nodes = resolve_region_map(invalid, invalid_sources, scc, |_, region| {
            region_preset_locked_for_shrink(graph, region, preset_state)
        });
        if !nodes.is_empty() {
            return IssuePayload::RegionNeedsShrink { nodes };
        }
    }

    if let Some(InvalidTeleportIssue {
        invalid,
        invalid_sources,
        ..
    }) = issue.as_any().downcast_ref::<InvalidTeleportIssue>()
    {
        let groups = resolve_single_edge_map(invalid, invalid_sources, graph, preset_state);
        if !groups.is_empty() {
            return IssuePayload::InvalidTeleport { groups };
        }
    }

    if let Some(InvalidTeleportGroupIssue {
        groups,
        invalid_sources,
        ..
    }) = issue.as_any().downcast_ref::<InvalidTeleportGroupIssue>()
    {
        let groups =
            resolve_edge_group_map(groups, invalid_sources, graph, preset_state, check_types);
        if !groups.is_empty() {
            return IssuePayload::InvalidTeleport { groups };
        }
    }

    if let Some(InvalidOneWayIssue {
        invalid,
        invalid_sources,
        ..
    }) = issue.as_any().downcast_ref::<InvalidOneWayIssue>()
    {
        let groups = resolve_single_edge_map(invalid, invalid_sources, graph, preset_state);
        if !groups.is_empty() {
            return IssuePayload::InvalidOneWay { groups };
        }
    }

    if let Some(InvalidOneWayGroupIssue {
        groups,
        invalid_sources,
        ..
    }) = issue.as_any().downcast_ref::<InvalidOneWayGroupIssue>()
    {
        let groups =
            resolve_edge_group_map(groups, invalid_sources, graph, preset_state, check_types);
        if !groups.is_empty() {
            return IssuePayload::InvalidOneWay { groups };
        }
    }

    if let Some(InvalidVerticalPassageIssue {
        invalid,
        invalid_sources,
        ..
    }) = issue.as_any().downcast_ref::<InvalidVerticalPassageIssue>()
    {
        let groups = resolve_single_edge_map(invalid, invalid_sources, graph, preset_state);
        if !groups.is_empty() {
            return IssuePayload::InvalidVerticalPassage { groups };
        }
    }

    if let Some(InvalidVerticalPassageGroupIssue {
        groups,
        invalid_sources,
        ..
    }) = issue
        .as_any()
        .downcast_ref::<InvalidVerticalPassageGroupIssue>()
    {
        let groups =
            resolve_edge_group_map(groups, invalid_sources, graph, preset_state, check_types);
        if !groups.is_empty() {
            return IssuePayload::InvalidVerticalPassage { groups };
        }
    }

    if let Some(InvalidSplitTileIssue {
        invalid,
        invalid_sources,
        ..
    }) = issue.as_any().downcast_ref::<InvalidSplitTileIssue>()
    {
        if let Some(payload) =
            resolve_invalid_split_tile_payload(invalid, invalid_sources, preset_state)
        {
            return payload;
        }
    }

    if let Some(InvalidSplitTileGroupIssue {
        groups,
        invalid_sources,
        ..
    }) = issue.as_any().downcast_ref::<InvalidSplitTileGroupIssue>()
    {
        if let Some(payload) =
            resolve_invalid_split_tile_group_payload(groups, invalid_sources, preset_state)
        {
            return payload;
        }
    }

    if let Some(InvalidSplitNodeIssue {
        invalid,
        invalid_sources,
        ..
    }) = issue.as_any().downcast_ref::<InvalidSplitNodeIssue>()
    {
        if let Some(payload) =
            resolve_invalid_split_node_payload(invalid, invalid_sources, preset_state)
        {
            return payload;
        }
    }

    if let Some(InvalidSplitNodeGroupIssue {
        groups,
        invalid_sources,
        ..
    }) = issue.as_any().downcast_ref::<InvalidSplitNodeGroupIssue>()
    {
        if let Some(payload) =
            resolve_invalid_split_node_group_payload(groups, invalid_sources, preset_state)
        {
            return payload;
        }
    }

    // `InvalidSplitNodeConnectionGroupIssue` reuses the `InvalidOneWay` payload variant (identical
    // shape: a group of edges) rather than getting its own wire tag, same rationale as
    // `InvalidLoopGroupIssue`→`InvalidLoop`/`InvalidTeleportGroupIssue`→`InvalidTeleport` above —
    // the web side already narrows on `payload.kind === "invalid_one_way"` for this reused kind,
    // not on `issue.kind` (which stays `"invalid_split_node_connection_group"`).
    if let Some(InvalidSplitNodeConnectionGroupIssue {
        groups,
        invalid_sources,
        ..
    }) = issue
        .as_any()
        .downcast_ref::<InvalidSplitNodeConnectionGroupIssue>()
    {
        let groups =
            resolve_edge_group_map(groups, invalid_sources, graph, preset_state, check_types);
        if !groups.is_empty() {
            return IssuePayload::InvalidOneWay { groups };
        }
    }

    if let Some(InvalidSplitRouteIssue {
        routes,
        invalid_sources,
        ..
    }) = issue.as_any().downcast_ref::<InvalidSplitRouteIssue>()
    {
        if let Some(payload) =
            resolve_invalid_split_route_payload(routes, invalid_sources, graph, preset_state)
        {
            return payload;
        }
    }

    if let Some(issue) = issue.as_any().downcast_ref::<ExcessiveSccCountIssue>() {
        let locked = excessive_scc_count_preset_locked(field, scc, preset_state);
        let preset_locked = issue
            .source_checks()
            .iter()
            .map(|s| (s.clone(), locked))
            .collect();
        return IssuePayload::ExcessiveSccCount { preset_locked };
    }

    if let Some(InvalidElevatorIssue {
        invalid,
        invalid_sources,
        ..
    }) = issue.as_any().downcast_ref::<InvalidElevatorIssue>()
    {
        if let Some(payload) =
            resolve_invalid_elevator_payload(invalid, invalid_sources, graph, preset_state)
        {
            return payload;
        }
    }

    if let Some(InvalidElevatorGroupIssue {
        groups,
        invalid_sources,
        ..
    }) = issue.as_any().downcast_ref::<InvalidElevatorGroupIssue>()
    {
        if let Some(payload) =
            resolve_elevator_group_map(groups, invalid_sources, graph, preset_state)
        {
            return payload;
        }
    }

    if let Some(InvalidElevatorStopIssue {
        invalid,
        invalid_sources,
        ..
    }) = issue.as_any().downcast_ref::<InvalidElevatorStopIssue>()
    {
        if let Some(payload) =
            resolve_invalid_elevator_stop_payload(invalid, invalid_sources, preset_state)
        {
            return payload;
        }
    }

    if let Some(InvalidElevatorStopGroupIssue {
        groups,
        invalid_sources,
        ..
    }) = issue
        .as_any()
        .downcast_ref::<InvalidElevatorStopGroupIssue>()
    {
        if let Some(payload) =
            resolve_elevator_stop_group_map(groups, invalid_sources, preset_state)
        {
            return payload;
        }
    }

    if let Some(deficit_issue) = issue
        .as_any()
        .downcast_ref::<MissingVerticalPassagesIssue>()
    {
        let areas =
            resolve_area_deficit_map(&deficit_issue.missing, deficit_issue.source_checks(), field);
        if !areas.is_empty() {
            return IssuePayload::AreaDeficit { areas };
        }
    }

    if let Some(deficit_issue) = issue.as_any().downcast_ref::<MissingTeleportsIssue>() {
        let areas =
            resolve_area_deficit_map(&deficit_issue.missing, deficit_issue.source_checks(), field);
        if !areas.is_empty() {
            return IssuePayload::AreaDeficit { areas };
        }
    }

    // `MissingElevatorsIssue` is whole-maze-only (`RepairArea::WholeMaze` always — see its doc
    // comment), so this always resolves to `[None, ...]` entries: no specific floor to highlight,
    // same "no per-element highlight" precedent as `ExcessiveSccCount` above. Still routed through
    // `AreaDeficit` for consistency with its three sibling deficit kinds.
    if let Some(deficit_issue) = issue.as_any().downcast_ref::<MissingElevatorsIssue>() {
        let areas =
            resolve_area_deficit_map(&deficit_issue.missing, deficit_issue.source_checks(), field);
        if !areas.is_empty() {
            return IssuePayload::AreaDeficit { areas };
        }
    }

    if let Some(deficit_issue) = issue
        .as_any()
        .downcast_ref::<AreaMissingElevatorStopsIssue>()
    {
        let areas =
            resolve_area_deficit_map(&deficit_issue.missing, deficit_issue.source_checks(), field);
        if !areas.is_empty() {
            return IssuePayload::AreaDeficit { areas };
        }
    }

    if let Some(MissingElevatorStopCountIssue {
        missing,
        invalid_sources,
        ..
    }) = issue
        .as_any()
        .downcast_ref::<MissingElevatorStopCountIssue>()
    {
        if let Some(payload) = resolve_missing_elevator_stop_count_payload(
            missing,
            invalid_sources,
            graph,
            field,
            preset_state,
        ) {
            return payload;
        }
    }

    if let Some(MissingElevatorHeightIssue {
        missing,
        invalid_sources,
        ..
    }) = issue.as_any().downcast_ref::<MissingElevatorHeightIssue>()
    {
        if let Some(payload) =
            resolve_missing_elevator_height_payload(missing, invalid_sources, graph, preset_state)
        {
            return payload;
        }
    }

    if let Some(ExcessiveElevatorStopGapIssue {
        missing,
        invalid_sources,
        ..
    }) = issue
        .as_any()
        .downcast_ref::<ExcessiveElevatorStopGapIssue>()
    {
        if let Some(payload) = resolve_excessive_elevator_stop_gap_payload(
            missing,
            invalid_sources,
            graph,
            preset_state,
        ) {
            return payload;
        }
    }

    if let Some(cross) = issue
        .as_any()
        .downcast_ref::<InvalidCrossElementGroupIssue>()
    {
        if let Some(payload) = resolve_cross_element_group_payload(
            cross.groups(),
            cross.invalid_sources(),
            &cross.close_nodes,
            graph,
            field,
            preset_state,
        ) {
            return payload;
        }
    }

    IssuePayload::None
}
