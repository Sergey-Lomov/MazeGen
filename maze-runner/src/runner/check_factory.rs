use std::collections::HashMap;
use maze_core::{
    space::Tessellation,
    quality_control::{
        MissingEndpointsCheck, UnreachableFinishCheck,
        MinLoopsCountCheck, MIN_LOOPS_DEFAULT, MinLoopDensityCheck, MIN_LOOP_DENSITY_DEFAULT,
        AVG_LOOP_LENGTH_ESTIMATE_DEFAULT, MinLoopLengthCheck, MIN_LOOP_LENGTH_DEFAULT,
        MaxLoopLengthCheck, MAX_LOOP_LENGTH_DEFAULT, ExternalEscapeDiversityCheck,
        EXTERNAL_ESCAPE_DIVERSITY_DEFAULT, LoopDistanceFromStartCheck,
        LOOP_DISTANCE_FROM_START_DEFAULT, LoopDistanceFromFinishCheck,
        LOOP_DISTANCE_FROM_FINISH_DEFAULT, MaxLoopDensityCheck, MAX_LOOP_DENSITY_DEFAULT,
        SccCountCheck, MAX_SCC_COUNT_DEFAULT, MinRegionSizeCheck, MIN_REGION_SIZE_DEFAULT,
        MinRegionRatioCheck, MIN_REGION_RATIO_DEFAULT, MinRegionCountCheck,
        MIN_REGION_COUNT_DEFAULT,
        TeleportDuplicatesConnectionCheck,
        TeleportWaypointDistanceCheck, TeleportWaypoint, TeleportEdgeSelector, TELEPORT_WAYPOINT_DISTANCE_DEFAULT,
        TeleportMinGeometricLengthCheck, TELEPORT_MIN_GEOMETRIC_LENGTH_DEFAULT,
        TeleportMaxGeometricLengthCheck, TELEPORT_MAX_GEOMETRIC_LENGTH_DEFAULT,
        TeleportSuperHubAvoidanceCheck, TeleportHubEdgeSelector, TELEPORT_SUPER_HUB_MAX_CONNECTIONS_DEFAULT,
        TeleportGroupProximityCheck, TeleportProximityEdge, TELEPORT_GROUP_PROXIMITY_DISTANCE_DEFAULT,
        MissingEndpointsIssue, UnreachableFinishIssue, MissingLoopsIssue, InvalidLoopIssue,
        ExcessiveSccCountIssue, RegionNeedsExpansionIssue, MissingRegionsIssue, InvalidTeleportIssue,
        TeleportGroupProximityIssue,
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
    ExcessiveSccCount,
    RegionNeedsExpansion,
    MissingRegions,
    InvalidTeleport,
    TeleportGroupProximity,
}

pub(crate) fn check_kind_for_type(type_id: &str) -> KindTag {
    match type_id {
        "missing_endpoints"         => KindTag::MissingEndpoints,
        "unreachable_finish"        => KindTag::UnreachableFinish,
        "min_loops_count"           => KindTag::MissingLoops,
        "min_loop_density"          => KindTag::MissingLoops,
        "min_loop_length"           => KindTag::InvalidLoop,
        "max_loop_length"           => KindTag::InvalidLoop,
        "external_escape_diversity" => KindTag::InvalidLoop,
        "loop_distance_from_start"  => KindTag::InvalidLoop,
        "loop_distance_from_finish" => KindTag::InvalidLoop,
        "max_loop_density"          => KindTag::InvalidLoop,
        "scc_count"                 => KindTag::ExcessiveSccCount,
        "min_region_size"           => KindTag::RegionNeedsExpansion,
        "min_region_ratio"          => KindTag::RegionNeedsExpansion,
        "min_region_count"          => KindTag::MissingRegions,
        "teleport_duplicates_connection" => KindTag::InvalidTeleport,
        "teleport_waypoint_distance" => KindTag::InvalidTeleport,
        "teleport_min_geometric_length" => KindTag::InvalidTeleport,
        "teleport_max_geometric_length" => KindTag::InvalidTeleport,
        "teleport_super_hub_avoidance" => KindTag::InvalidTeleport,
        "teleport_group_proximity" => KindTag::TeleportGroupProximity,
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
        "min_loop_length" => {
            let min_loop_length = instance.params.get("min_loop_length")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(1) as u32)
                .unwrap_or(MIN_LOOP_LENGTH_DEFAULT);
            Some(Box::new(MinLoopLengthCheck { instance_id, min_loop_length }))
        }
        "max_loop_length" => {
            let max_loop_length = instance.params.get("max_loop_length")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(1) as u32)
                .unwrap_or(MAX_LOOP_LENGTH_DEFAULT);
            Some(Box::new(MaxLoopLengthCheck { instance_id, max_loop_length }))
        }
        "external_escape_diversity" => {
            let min_distinct_exits = instance.params.get("min_distinct_exits")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(EXTERNAL_ESCAPE_DIVERSITY_DEFAULT);
            Some(Box::new(ExternalEscapeDiversityCheck { instance_id, min_distinct_exits }))
        }
        "loop_distance_from_start" => {
            let min_distance_from_start = instance.params.get("min_distance_from_start")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(LOOP_DISTANCE_FROM_START_DEFAULT);
            Some(Box::new(LoopDistanceFromStartCheck { instance_id, min_distance_from_start }))
        }
        "loop_distance_from_finish" => {
            let min_distance_from_finish = instance.params.get("min_distance_from_finish")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(LOOP_DISTANCE_FROM_FINISH_DEFAULT);
            Some(Box::new(LoopDistanceFromFinishCheck { instance_id, min_distance_from_finish }))
        }
        "max_loop_density" => {
            let max_density = instance.params.get("max_density")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.clamp(0, 100) as u32)
                .unwrap_or(MAX_LOOP_DENSITY_DEFAULT);
            Some(Box::new(MaxLoopDensityCheck { instance_id, max_density }))
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
            let waypoint = parse_teleport_waypoint(instance.params.get("waypoint"));
            let edge = parse_teleport_edge_selector(instance.params.get("edge"));
            let protect_route = parse_protect_route(instance.params.get("protect_route"));
            Some(Box::new(TeleportWaypointDistanceCheck { instance_id, distance, waypoint, edge, protect_route }))
        }
        "teleport_min_geometric_length" => {
            let min_length = instance.params.get("min_length")
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .map(|v| v.max(0.0))
                .unwrap_or(TELEPORT_MIN_GEOMETRIC_LENGTH_DEFAULT);
            let protect_route = parse_protect_route(instance.params.get("protect_route"));
            Some(Box::new(TeleportMinGeometricLengthCheck { instance_id, min_length, protect_route }))
        }
        "teleport_max_geometric_length" => {
            let max_length = instance.params.get("max_length")
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .map(|v| v.max(0.0))
                .unwrap_or(TELEPORT_MAX_GEOMETRIC_LENGTH_DEFAULT);
            let protect_route = parse_protect_route(instance.params.get("protect_route"));
            Some(Box::new(TeleportMaxGeometricLengthCheck { instance_id, max_length, protect_route }))
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

pub(crate) fn build_teleport_group_proximity_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String) -> Option<Box<dyn maze_core::quality_control::Check<T, TeleportGroupProximityIssue>>> {
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
