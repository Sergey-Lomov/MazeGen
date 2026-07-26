use std::collections::HashMap;
use maze_core::{
    space::Tessellation,
    quality_control::{
        MissingEndpointsCheck, UnreachableFinishCheck,
        MinLoopsCountCheck, MIN_LOOPS_DEFAULT,
        MinLoopDensityCheck, MIN_LOOP_DENSITY_DEFAULT,
        AVG_LOOP_LENGTH_ESTIMATE_DEFAULT, LoopLengthCheck, LOOP_LENGTH_DEFAULT,
        ExternalEscapeDiversityCheck,
        EXTERNAL_ESCAPE_DIVERSITY_DEFAULT, LoopDistanceFromStartCheck,
        LOOP_DISTANCE_FROM_START_DEFAULT, LoopDistanceFromFinishCheck,
        LOOP_DISTANCE_FROM_FINISH_DEFAULT, MaxLoopDensityCheck, MAX_LOOP_DENSITY_DEFAULT,
        MaxLoopsCountCheck, MAX_LOOPS_COUNT_DEFAULT,
        SccCountCheck, MAX_SCC_COUNT_DEFAULT, MinRegionSizeCheck, MIN_REGION_SIZE_DEFAULT,
        MinRegionRatioCheck, MIN_REGION_RATIO_DEFAULT,
        MaxRegionSizeCheck, MAX_REGION_SIZE_DEFAULT, MaxRegionRatioCheck, MAX_REGION_RATIO_DEFAULT,
        MinRegionCountCheck,
        MIN_REGION_COUNT_DEFAULT,
        TeleportDuplicatesConnectionCheck,
        TeleportWaypointDistanceCheck, TeleportWaypoint, TeleportEdgeSelector, TELEPORT_WAYPOINT_DISTANCE_DEFAULT,
        TeleportGeometricLengthCheck, TELEPORT_GEOMETRIC_LENGTH_DEFAULT,
        TeleportGraphDistanceCheck, TELEPORT_GRAPH_DISTANCE_DEFAULT,
        TeleportSuperHubAvoidanceCheck, TeleportHubEdgeSelector, TELEPORT_SUPER_HUB_MAX_CONNECTIONS_DEFAULT,
        TeleportGroupProximityCheck, TeleportProximityEdge, TELEPORT_GROUP_PROXIMITY_DISTANCE_DEFAULT,
        OneWayWaypointDistanceCheck, OneWayWaypoint, ONE_WAY_WAYPOINT_DISTANCE_DEFAULT,
        OneWayGroupGeometricProximityCheck, ONE_WAY_GROUP_GEOMETRIC_PROXIMITY_DISTANCE_DEFAULT,
        OneWayGroupGraphProximityCheck, ONE_WAY_GROUP_GRAPH_PROXIMITY_DISTANCE_DEFAULT,
        OneWayGroupSuperHubCheck, ONE_WAY_GROUP_SUPER_HUB_MAX_CONNECTIONS_DEFAULT,
        MinOneWayCountCheck, MIN_ONE_WAY_COUNT_DEFAULT,
        MinOneWayRatioCheck, MIN_ONE_WAY_RATIO_DEFAULT,
        MaxOneWayCountCheck, MAX_ONE_WAY_COUNT_DEFAULT,
        MaxOneWayRatioCheck, MAX_ONE_WAY_RATIO_DEFAULT,
        MinTeleportCountCheck, MIN_TELEPORT_COUNT_DEFAULT,
        MinTeleportRatioCheck, MIN_TELEPORT_RATIO_DEFAULT,
        SplitDistanceFromWaypointCheck, SplitWaypoint, SPLIT_DISTANCE_FROM_WAYPOINT_DEFAULT,
        Comparison, CycleKind,
        MissingEndpointsIssue, UnreachableFinishIssue, MissingLoopsIssue, InvalidLoopIssue,
        InvalidLoopGroupIssue,
        ExcessiveSccCountIssue, RegionNeedsExpansionIssue, RegionNeedsShrinkIssue, MissingRegionsIssue,
        InvalidTeleportIssue, InvalidTeleportGroupIssue, InvalidOneWayIssue, InvalidOneWayGroupIssue,
        MissingOneWaysIssue, MissingTeleportsIssue, InvalidSplitTileIssue,
    },
    RegionClass,
};
use crate::config::CheckInstanceConfig;

/// One tag per concrete `Issue` type — the compile-time-known "which `I`" a rule's checks/
/// strategy share, chosen at runtime from the first check's `type_id` (see `check_kind_for_type`)
/// and then used to pick a `build_rule_for!` macro arm, which fixes `I` for the rest of that
/// rule's construction. Not `IssueKind` itself: `IssueKind` is the runtime-erased representation
/// (config/DTO/serialization, see GitHub issue #113's plan §2); `KindTag` exists purely to drive
/// this factory's match.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KindTag {
    MissingEndpoints,
    UnreachableFinish,
    MissingLoops,
    InvalidLoop,
    InvalidLoopGroup,
    ExcessiveSccCount,
    RegionNeedsExpansion,
    RegionNeedsShrink,
    MissingRegions,
    InvalidTeleport,
    InvalidTeleportGroup,
    InvalidOneWay,
    InvalidOneWayGroup,
    MissingOneWays,
    MissingTeleports,
    InvalidSplitTile,
}

pub(crate) fn check_kind_for_type(type_id: &str) -> KindTag {
    match type_id {
        "missing_endpoints"         => KindTag::MissingEndpoints,
        "unreachable_finish"        => KindTag::UnreachableFinish,
        "min_loops_count"           => KindTag::MissingLoops,
        "min_loop_density"          => KindTag::MissingLoops,
        "loop_length"               => KindTag::InvalidLoop,
        "external_escape_diversity" => KindTag::InvalidLoop,
        "loop_distance_from_start"  => KindTag::InvalidLoop,
        "loop_distance_from_finish" => KindTag::InvalidLoop,
        "max_loop_density"          => KindTag::InvalidLoopGroup,
        "max_loops_count"           => KindTag::InvalidLoopGroup,
        "scc_count"                 => KindTag::ExcessiveSccCount,
        "min_region_size"           => KindTag::RegionNeedsExpansion,
        "min_region_ratio"          => KindTag::RegionNeedsExpansion,
        "max_region_size"           => KindTag::RegionNeedsShrink,
        "max_region_ratio"          => KindTag::RegionNeedsShrink,
        "min_region_count"          => KindTag::MissingRegions,
        "teleport_duplicates_connection" => KindTag::InvalidTeleport,
        "teleport_waypoint_distance" => KindTag::InvalidTeleport,
        "teleport_geometric_length" => KindTag::InvalidTeleport,
        "teleport_graph_distance"   => KindTag::InvalidTeleport,
        "teleport_super_hub_avoidance" => KindTag::InvalidTeleport,
        "teleport_group_proximity" => KindTag::InvalidTeleportGroup,
        "one_way_waypoint_distance" => KindTag::InvalidOneWay,
        "one_way_group_geometric_proximity" => KindTag::InvalidOneWayGroup,
        "one_way_group_graph_proximity" => KindTag::InvalidOneWayGroup,
        "one_way_group_super_hub"   => KindTag::InvalidOneWayGroup,
        "min_one_way_count"         => KindTag::MissingOneWays,
        "min_one_way_ratio"         => KindTag::MissingOneWays,
        "max_one_way_count"         => KindTag::InvalidOneWayGroup,
        "max_one_way_ratio"         => KindTag::InvalidOneWayGroup,
        "min_teleport_count"        => KindTag::MissingTeleports,
        "min_teleport_ratio"        => KindTag::MissingTeleports,
        "split_distance_from_waypoint" => KindTag::InvalidSplitTile,
        other => panic!("unknown check type_id: {other}"),
    }
}

pub(crate) fn composite_check_id(rule_id: &str, local_id: &str) -> String {
    format!("{rule_id}:{local_id}")
}

fn parse_region_class_filter(param: Option<&String>) -> Vec<RegionClass> {
    match param.and_then(|v| RegionClass::from_str(v)) {
        Some(class) => vec![class],
        None => maze_core::graph::region_class::ALL_REGION_CLASSES.to_vec(),
    }
}

fn parse_teleport_waypoint(param: Option<&String>) -> TeleportWaypoint {
    match param.map(String::as_str) {
        Some("start") => TeleportWaypoint::Start,
        Some("finish") => TeleportWaypoint::Finish,
        _ => TeleportWaypoint::Any,
    }
}

fn parse_teleport_edge_selector(param: Option<&String>) -> TeleportEdgeSelector {
    match param.map(String::as_str) {
        Some("entry_only") => TeleportEdgeSelector::EntryOnly,
        _ => TeleportEdgeSelector::EntryOrExit,
    }
}

fn parse_teleport_hub_edge_selector(param: Option<&String>) -> TeleportHubEdgeSelector {
    match param.map(String::as_str) {
        Some("entry") => TeleportHubEdgeSelector::Entry,
        Some("exit") => TeleportHubEdgeSelector::Exit,
        _ => TeleportHubEdgeSelector::EntryOrExit,
    }
}

fn parse_one_way_waypoint(param: Option<&String>) -> OneWayWaypoint {
    match param.map(String::as_str) {
        Some("start") => OneWayWaypoint::Start,
        Some("finish") => OneWayWaypoint::Finish,
        _ => OneWayWaypoint::Any,
    }
}

fn parse_split_waypoint(param: Option<&String>) -> SplitWaypoint {
    match param.map(String::as_str) {
        Some("start") => SplitWaypoint::Start,
        Some("finish") => SplitWaypoint::Finish,
        _ => SplitWaypoint::Any,
    }
}

fn parse_teleport_proximity_edge(param: Option<&String>) -> TeleportProximityEdge {
    match param.map(String::as_str) {
        Some("entry") => TeleportProximityEdge::Entry,
        Some("exit") => TeleportProximityEdge::Exit,
        _ => TeleportProximityEdge::EntryOrExit,
    }
}

/// `protect_route` (GitHub issue #78) defaults to `true` on every per-teleport check —
/// `"false"`/`"0"` opts out, anything else (including missing/unparseable) stays `true`.
fn parse_protect_route(param: Option<&String>) -> bool {
    match param.map(String::as_str) {
        Some("false") | Some("0") => false,
        _ => true,
    }
}

/// GitHub issue #177: `comparison` is shared by every check merged around `Comparison` — missing
/// or unparseable falls back to `default`, the check's own pre-#177 fixed operator.
fn parse_comparison(param: Option<&String>, default: Comparison) -> Comparison {
    param.and_then(|v| Comparison::from_str(v)).unwrap_or(default)
}

/// GitHub issue #217: `cycle_kind` is shared by every loop-based check built on
/// `cycle_check_core::find_invalid_cycles` — missing or unparseable falls back to `CycleKind::Any`,
/// the pre-#217 behavior of considering every cycle regardless of directionality.
fn parse_cycle_kind(param: Option<&String>) -> CycleKind {
    param.and_then(|v| CycleKind::from_str(v)).unwrap_or(CycleKind::Any)
}

/// One `build_*_check` function per `KindTag` — `type_id`s that share a `KindTag` (e.g.
/// `min_loops_count`/`min_loop_density`, both `MissingLoops`) are handled by the same function's
/// own `match`. Parsing logic per arm is unchanged from the pre-#113 single `build_check`, just
/// redistributed by `KindTag` instead of living in one flat match over every `type_id` at once.
/// `Option`, not `Result` — `None` means "this `type_id` doesn't belong to this `KindTag`", the
/// per-arm-invalid-value case doesn't exist (every param has a documented fallback default).
pub(crate) fn build_missing_endpoints_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String) -> Option<Box<dyn maze_core::quality_control::Check<T, MissingEndpointsIssue>>> {
    match instance.type_id.as_str() {
        "missing_endpoints" => Some(Box::new(MissingEndpointsCheck { instance_id })),
        _ => None,
    }
}

pub(crate) fn build_unreachable_finish_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String) -> Option<Box<dyn maze_core::quality_control::Check<T, UnreachableFinishIssue>>> {
    match instance.type_id.as_str() {
        "unreachable_finish" => Some(Box::new(UnreachableFinishCheck { instance_id })),
        _ => None,
    }
}

pub(crate) fn build_missing_loops_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String) -> Option<Box<dyn maze_core::quality_control::Check<T, MissingLoopsIssue>>> {
    match instance.type_id.as_str() {
        "min_loops_count" => {
            let min_loops = instance.params.get("min_loops")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(1) as u32)
                .unwrap_or(MIN_LOOPS_DEFAULT);
            Some(Box::new(MinLoopsCountCheck { instance_id, min_loops }))
        }
        "min_loop_density" => {
            let min_density = instance.params.get("min_density")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.clamp(0, 100) as u32)
                .unwrap_or(MIN_LOOP_DENSITY_DEFAULT);
            let avg_loop_length_estimate = instance.params.get("avg_loop_length_estimate")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(1) as u32)
                .unwrap_or(AVG_LOOP_LENGTH_ESTIMATE_DEFAULT);
            Some(Box::new(MinLoopDensityCheck { instance_id, min_density, avg_loop_length_estimate }))
        }
        _ => None,
    }
}

pub(crate) fn build_invalid_loop_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String) -> Option<Box<dyn maze_core::quality_control::Check<T, InvalidLoopIssue>>> {
    match instance.type_id.as_str() {
        "loop_length" => {
            let length = instance.params.get("length")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(1) as u32)
                .unwrap_or(LOOP_LENGTH_DEFAULT);
            let comparison = parse_comparison(instance.params.get("comparison"), Comparison::Lt);
            let cycle_kind = parse_cycle_kind(instance.params.get("cycle_kind"));
            Some(Box::new(LoopLengthCheck { instance_id, comparison, length, cycle_kind }))
        }
        "external_escape_diversity" => {
            let min_distinct_exits = instance.params.get("min_distinct_exits")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(EXTERNAL_ESCAPE_DIVERSITY_DEFAULT);
            let cycle_kind = parse_cycle_kind(instance.params.get("cycle_kind"));
            Some(Box::new(ExternalEscapeDiversityCheck { instance_id, min_distinct_exits, cycle_kind }))
        }
        "loop_distance_from_start" => {
            let min_distance_from_start = instance.params.get("min_distance_from_start")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(LOOP_DISTANCE_FROM_START_DEFAULT);
            let cycle_kind = parse_cycle_kind(instance.params.get("cycle_kind"));
            Some(Box::new(LoopDistanceFromStartCheck { instance_id, min_distance_from_start, cycle_kind }))
        }
        "loop_distance_from_finish" => {
            let min_distance_from_finish = instance.params.get("min_distance_from_finish")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(LOOP_DISTANCE_FROM_FINISH_DEFAULT);
            let cycle_kind = parse_cycle_kind(instance.params.get("cycle_kind"));
            Some(Box::new(LoopDistanceFromFinishCheck { instance_id, min_distance_from_finish, cycle_kind }))
        }
        _ => None,
    }
}

pub(crate) fn build_invalid_loop_group_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String) -> Option<Box<dyn maze_core::quality_control::Check<T, InvalidLoopGroupIssue>>> {
    match instance.type_id.as_str() {
        "max_loop_density" => {
            let max_density = instance.params.get("max_density")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.clamp(0, 100) as u32)
                .unwrap_or(MAX_LOOP_DENSITY_DEFAULT);
            Some(Box::new(MaxLoopDensityCheck { instance_id, max_density }))
        }
        "max_loops_count" => {
            let max_loops_count = instance.params.get("max_loops_count")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(MAX_LOOPS_COUNT_DEFAULT);
            Some(Box::new(MaxLoopsCountCheck { instance_id, max_loops_count }))
        }
        _ => None,
    }
}

pub(crate) fn build_excessive_scc_count_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String) -> Option<Box<dyn maze_core::quality_control::Check<T, ExcessiveSccCountIssue>>> {
    match instance.type_id.as_str() {
        "scc_count" => {
            let max_scc_count = instance.params.get("max_scc_count")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(1) as u32)
                .unwrap_or(MAX_SCC_COUNT_DEFAULT);
            Some(Box::new(SccCountCheck { instance_id, max_scc_count }))
        }
        _ => None,
    }
}

pub(crate) fn build_region_needs_expansion_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String) -> Option<Box<dyn maze_core::quality_control::Check<T, RegionNeedsExpansionIssue>>> {
    match instance.type_id.as_str() {
        "min_region_size" => {
            let min_region_size = instance.params.get("min_region_size")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(1) as u32)
                .unwrap_or(MIN_REGION_SIZE_DEFAULT);
            let region_classes = parse_region_class_filter(instance.params.get("region_class"));
            Some(Box::new(MinRegionSizeCheck { instance_id, min_region_size, region_classes }))
        }
        "min_region_ratio" => {
            let min_region_ratio = instance.params.get("min_region_ratio")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.clamp(0, 100) as u32)
                .unwrap_or(MIN_REGION_RATIO_DEFAULT);
            let region_classes = parse_region_class_filter(instance.params.get("region_class"));
            Some(Box::new(MinRegionRatioCheck { instance_id, min_region_ratio, region_classes }))
        }
        _ => None,
    }
}

pub(crate) fn build_region_needs_shrink_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String) -> Option<Box<dyn maze_core::quality_control::Check<T, RegionNeedsShrinkIssue>>> {
    match instance.type_id.as_str() {
        "max_region_size" => {
            let max_region_size = instance.params.get("max_region_size")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(1) as u32)
                .unwrap_or(MAX_REGION_SIZE_DEFAULT);
            let region_classes = parse_region_class_filter(instance.params.get("region_class"));
            Some(Box::new(MaxRegionSizeCheck { instance_id, max_region_size, region_classes }))
        }
        "max_region_ratio" => {
            let max_region_ratio = instance.params.get("max_region_ratio")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.clamp(0, 100) as u32)
                .unwrap_or(MAX_REGION_RATIO_DEFAULT);
            let region_classes = parse_region_class_filter(instance.params.get("region_class"));
            Some(Box::new(MaxRegionRatioCheck { instance_id, max_region_ratio, region_classes }))
        }
        _ => None,
    }
}

pub(crate) fn build_missing_regions_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String) -> Option<Box<dyn maze_core::quality_control::Check<T, MissingRegionsIssue>>> {
    match instance.type_id.as_str() {
        "min_region_count" => {
            let parse_count = |key: &str| instance.params.get(key)
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(MIN_REGION_COUNT_DEFAULT);
            let min_counts = HashMap::from([
                (RegionClass::Path,        parse_count("path_count")),
                (RegionClass::Alternative, parse_count("alternative_count")),
                (RegionClass::Unreachable, parse_count("unreachable_count")),
                (RegionClass::Trap,        parse_count("trap_count")),
            ]);
            Some(Box::new(MinRegionCountCheck { instance_id, min_counts }))
        }
        _ => None,
    }
}

pub(crate) fn build_invalid_teleport_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String) -> Option<Box<dyn maze_core::quality_control::Check<T, InvalidTeleportIssue>>> {
    match instance.type_id.as_str() {
        "teleport_duplicates_connection" => {
            let protect_route = parse_protect_route(instance.params.get("protect_route"));
            Some(Box::new(TeleportDuplicatesConnectionCheck { instance_id, protect_route }))
        }
        "teleport_waypoint_distance" => {
            let distance = instance.params.get("distance")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(TELEPORT_WAYPOINT_DISTANCE_DEFAULT);
            let comparison = parse_comparison(instance.params.get("comparison"), Comparison::Lt);
            let waypoint = parse_teleport_waypoint(instance.params.get("waypoint"));
            let edge = parse_teleport_edge_selector(instance.params.get("edge"));
            let protect_route = parse_protect_route(instance.params.get("protect_route"));
            Some(Box::new(TeleportWaypointDistanceCheck { instance_id, distance, comparison, waypoint, edge, protect_route }))
        }
        "teleport_geometric_length" => {
            let length = instance.params.get("length")
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .map(|v| v.max(0.0))
                .unwrap_or(TELEPORT_GEOMETRIC_LENGTH_DEFAULT);
            let comparison = parse_comparison(instance.params.get("comparison"), Comparison::Lt);
            let protect_route = parse_protect_route(instance.params.get("protect_route"));
            Some(Box::new(TeleportGeometricLengthCheck { instance_id, comparison, length, protect_route }))
        }
        "teleport_graph_distance" => {
            let distance = instance.params.get("distance")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(TELEPORT_GRAPH_DISTANCE_DEFAULT);
            let comparison = parse_comparison(instance.params.get("comparison"), Comparison::Lt);
            let protect_route = parse_protect_route(instance.params.get("protect_route"));
            Some(Box::new(TeleportGraphDistanceCheck { instance_id, comparison, distance, protect_route }))
        }
        "teleport_super_hub_avoidance" => {
            let max_connections = instance.params.get("max_connections")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(TELEPORT_SUPER_HUB_MAX_CONNECTIONS_DEFAULT);
            let edge = parse_teleport_hub_edge_selector(instance.params.get("edge_hub"));
            let protect_route = parse_protect_route(instance.params.get("protect_route"));
            Some(Box::new(TeleportSuperHubAvoidanceCheck { instance_id, max_connections, edge, protect_route }))
        }
        _ => None,
    }
}

pub(crate) fn build_invalid_one_way_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String) -> Option<Box<dyn maze_core::quality_control::Check<T, InvalidOneWayIssue>>> {
    match instance.type_id.as_str() {
        "one_way_waypoint_distance" => {
            let distance = instance.params.get("distance")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(ONE_WAY_WAYPOINT_DISTANCE_DEFAULT);
            let comparison = parse_comparison(instance.params.get("comparison"), Comparison::Lt);
            let waypoint = parse_one_way_waypoint(instance.params.get("waypoint"));
            let protect_route = parse_protect_route(instance.params.get("protect_route"));
            Some(Box::new(OneWayWaypointDistanceCheck { instance_id, distance, comparison, waypoint, protect_route }))
        }
        _ => None,
    }
}

pub(crate) fn build_teleport_group_proximity_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String) -> Option<Box<dyn maze_core::quality_control::Check<T, InvalidTeleportGroupIssue>>> {
    match instance.type_id.as_str() {
        "teleport_group_proximity" => {
            let distance = instance.params.get("distance")
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .map(|v| v.max(0.0))
                .unwrap_or(TELEPORT_GROUP_PROXIMITY_DISTANCE_DEFAULT);
            let own_edge = parse_teleport_proximity_edge(instance.params.get("own_edge"));
            let other_edge = parse_teleport_proximity_edge(instance.params.get("other_edge"));
            let protect_route = parse_protect_route(instance.params.get("protect_route"));
            Some(Box::new(TeleportGroupProximityCheck { instance_id, distance, own_edge, other_edge, protect_route }))
        }
        _ => None,
    }
}

pub(crate) fn build_one_way_group_proximity_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String) -> Option<Box<dyn maze_core::quality_control::Check<T, InvalidOneWayGroupIssue>>> {
    match instance.type_id.as_str() {
        "one_way_group_geometric_proximity" => {
            let distance = instance.params.get("distance")
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .map(|v| v.max(0.0))
                .unwrap_or(ONE_WAY_GROUP_GEOMETRIC_PROXIMITY_DISTANCE_DEFAULT);
            let protect_route = parse_protect_route(instance.params.get("protect_route"));
            Some(Box::new(OneWayGroupGeometricProximityCheck { instance_id, distance, protect_route }))
        }
        "one_way_group_graph_proximity" => {
            let distance = instance.params.get("distance")
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .map(|v| v.max(0.0))
                .unwrap_or(ONE_WAY_GROUP_GRAPH_PROXIMITY_DISTANCE_DEFAULT);
            let protect_route = parse_protect_route(instance.params.get("protect_route"));
            Some(Box::new(OneWayGroupGraphProximityCheck { instance_id, distance, protect_route }))
        }
        "one_way_group_super_hub" => {
            let max_connections = instance.params.get("max_connections")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(ONE_WAY_GROUP_SUPER_HUB_MAX_CONNECTIONS_DEFAULT);
            Some(Box::new(OneWayGroupSuperHubCheck { instance_id, max_connections }))
        }
        "max_one_way_count" => {
            let max_one_ways = instance.params.get("max_one_ways")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(MAX_ONE_WAY_COUNT_DEFAULT);
            Some(Box::new(MaxOneWayCountCheck { instance_id, max_one_ways }))
        }
        "max_one_way_ratio" => {
            let max_ratio = instance.params.get("max_ratio")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.clamp(0, 100) as u32)
                .unwrap_or(MAX_ONE_WAY_RATIO_DEFAULT);
            Some(Box::new(MaxOneWayRatioCheck { instance_id, max_ratio }))
        }
        _ => None,
    }
}

pub(crate) fn build_missing_one_ways_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String) -> Option<Box<dyn maze_core::quality_control::Check<T, MissingOneWaysIssue>>> {
    match instance.type_id.as_str() {
        "min_one_way_count" => {
            let min_one_ways = instance.params.get("min_one_ways")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(1) as u32)
                .unwrap_or(MIN_ONE_WAY_COUNT_DEFAULT);
            Some(Box::new(MinOneWayCountCheck { instance_id, min_one_ways }))
        }
        "min_one_way_ratio" => {
            let min_ratio = instance.params.get("min_ratio")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.clamp(0, 100) as u32)
                .unwrap_or(MIN_ONE_WAY_RATIO_DEFAULT);
            Some(Box::new(MinOneWayRatioCheck { instance_id, min_ratio }))
        }
        _ => None,
    }
}

pub(crate) fn build_invalid_split_tile_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String) -> Option<Box<dyn maze_core::quality_control::Check<T, InvalidSplitTileIssue>>> {
    match instance.type_id.as_str() {
        "split_distance_from_waypoint" => {
            let distance = instance.params.get("distance")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(SPLIT_DISTANCE_FROM_WAYPOINT_DEFAULT);
            let comparison = parse_comparison(instance.params.get("comparison"), Comparison::Lt);
            let waypoint = parse_split_waypoint(instance.params.get("waypoint"));
            Some(Box::new(SplitDistanceFromWaypointCheck { instance_id, distance, comparison, waypoint }))
        }
        _ => None,
    }
}

pub(crate) fn build_missing_teleports_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String) -> Option<Box<dyn maze_core::quality_control::Check<T, MissingTeleportsIssue>>> {
    match instance.type_id.as_str() {
        "min_teleport_count" => {
            let min_teleports = instance.params.get("min_teleports")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(1) as u32)
                .unwrap_or(MIN_TELEPORT_COUNT_DEFAULT);
            Some(Box::new(MinTeleportCountCheck { instance_id, min_teleports }))
        }
        "min_teleport_ratio" => {
            let min_teleport_ratio = instance.params.get("min_teleport_ratio")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.clamp(0, 100) as u32)
                .unwrap_or(MIN_TELEPORT_RATIO_DEFAULT);
            Some(Box::new(MinTeleportRatioCheck { instance_id, min_teleport_ratio }))
        }
        _ => None,
    }
}
