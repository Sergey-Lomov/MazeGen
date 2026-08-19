use std::collections::HashMap;
use maze_core::{
    space::Tessellation,
    quality_control::{
        MissingEndpointsCheck, UnreachableFinishCheck,
        MinLoopsCountCheck, MIN_LOOPS_DEFAULT, MIN_LOOPS_COUNT_DEFAULT_FLOOR_SCOPE,
        MinLoopDensityCheck, MIN_LOOP_DENSITY_DEFAULT, MIN_LOOP_DENSITY_DEFAULT_FLOOR_SCOPE,
        AVG_LOOP_LENGTH_ESTIMATE_DEFAULT, LoopLengthCheck, LOOP_LENGTH_DEFAULT,
        ExternalEscapeDiversityCheck,
        EXTERNAL_ESCAPE_DIVERSITY_DEFAULT, LoopDistanceFromStartCheck,
        LOOP_DISTANCE_FROM_START_DEFAULT, LoopDistanceFromFinishCheck,
        LOOP_DISTANCE_FROM_FINISH_DEFAULT, MaxLoopDensityCheck, MAX_LOOP_DENSITY_DEFAULT, MAX_LOOP_DENSITY_DEFAULT_FLOOR_SCOPE,
        MaxLoopsCountCheck, MAX_LOOPS_COUNT_DEFAULT, MAX_LOOPS_COUNT_DEFAULT_FLOOR_SCOPE,
        SccCountCheck, MAX_SCC_COUNT_DEFAULT, MinRegionSizeCheck, MIN_REGION_SIZE_DEFAULT,
        MinRegionRatioCheck, MIN_REGION_RATIO_DEFAULT,
        MaxRegionSizeCheck, MAX_REGION_SIZE_DEFAULT, MaxRegionRatioCheck, MAX_REGION_RATIO_DEFAULT,
        MinRegionCountCheck,
        MIN_REGION_COUNT_DEFAULT,
        TeleportDuplicatesConnectionCheck,
        TeleportWaypointDistanceCheck, TeleportWaypoint, TeleportEdgeSelector, TELEPORT_WAYPOINT_DISTANCE_DEFAULT,
        TeleportGeometricLengthCheck, TELEPORT_GEOMETRIC_LENGTH_DEFAULT, TELEPORT_GEOMETRIC_LENGTH_DEFAULT_FLOOR_MODE,
        TeleportGraphDistanceCheck, TELEPORT_GRAPH_DISTANCE_DEFAULT,
        TeleportSuperHubAvoidanceCheck, TeleportHubEdgeSelector, TELEPORT_SUPER_HUB_MAX_CONNECTIONS_DEFAULT,
        TeleportGroupProximityCheck, TeleportProximityEdge, TELEPORT_GROUP_PROXIMITY_DISTANCE_DEFAULT,
        OneWayWaypointDistanceCheck, OneWayWaypoint, ONE_WAY_WAYPOINT_DISTANCE_DEFAULT,
        OneWayGroupGeometricProximityCheck, ONE_WAY_GROUP_GEOMETRIC_PROXIMITY_DISTANCE_DEFAULT, ONE_WAY_GROUP_GEOMETRIC_PROXIMITY_DEFAULT_FLOOR_MODE,
        OneWayGroupGraphProximityCheck, ONE_WAY_GROUP_GRAPH_PROXIMITY_DISTANCE_DEFAULT,
        OneWayGroupSuperHubCheck, ONE_WAY_GROUP_SUPER_HUB_MAX_CONNECTIONS_DEFAULT,
        MinOneWayCountCheck, MIN_ONE_WAY_COUNT_DEFAULT, MIN_ONE_WAY_COUNT_DEFAULT_FLOOR_SCOPE,
        MinOneWayRatioCheck, MIN_ONE_WAY_RATIO_DEFAULT, MIN_ONE_WAY_RATIO_DEFAULT_FLOOR_SCOPE,
        MaxOneWayCountCheck, MAX_ONE_WAY_COUNT_DEFAULT, MAX_ONE_WAY_COUNT_DEFAULT_FLOOR_SCOPE,
        MaxOneWayRatioCheck, MAX_ONE_WAY_RATIO_DEFAULT, MAX_ONE_WAY_RATIO_DEFAULT_FLOOR_SCOPE,
        MinTeleportCountCheck, MIN_TELEPORT_COUNT_DEFAULT, MIN_TELEPORT_COUNT_DEFAULT_FLOOR_SCOPE,
        MinTeleportRatioCheck, MIN_TELEPORT_RATIO_DEFAULT, MIN_TELEPORT_RATIO_DEFAULT_FLOOR_SCOPE,
        TeleportSplitIntersectionCheck, TeleportSplitEdgeSelector,
        SplitDistanceFromWaypointCheck, SplitWaypoint, SPLIT_DISTANCE_FROM_WAYPOINT_DEFAULT,
        SplitTeleportIntersectionCheck, SplitTeleportDirection,
        MaxSplitCountCheck, MAX_SPLIT_COUNT_DEFAULT, MAX_SPLIT_COUNT_DEFAULT_FLOOR_SCOPE,
        MaxSplitDensityCheck, MAX_SPLIT_DENSITY_DEFAULT, MAX_SPLIT_DENSITY_DEFAULT_FLOOR_SCOPE,
        SplitGroupGeometricProximityCheck, SPLIT_GROUP_GEOMETRIC_PROXIMITY_DISTANCE_DEFAULT, SPLIT_GROUP_GEOMETRIC_PROXIMITY_DEFAULT_FLOOR_MODE,
        SplitGroupGraphProximityCheck, SPLIT_GROUP_GRAPH_PROXIMITY_DISTANCE_DEFAULT,
        SplitCountCheck, SPLIT_COUNT_DEFAULT, SPLIT_COUNT_DEFAULT_FLOOR_SCOPE,
        SplitDensityCheck, SPLIT_DENSITY_DEFAULT, SPLIT_DENSITY_DEFAULT_FLOOR_SCOPE,
        SplitNodeConnectionCountCheck, SplitNodeConnectionDirection, SPLIT_NODE_CONNECTION_COUNT_DEFAULT, SPLIT_NODE_CONNECTION_COUNT_DEFAULT_COMPARISON,
        SplitNodeConnectionPerNeighborCheck, SPLIT_NODE_CONNECTION_PER_NEIGHBOR_MAX_DEFAULT,
        SplitNodeConnectionPerFaceCheck, SPLIT_NODE_CONNECTION_PER_FACE_MAX_DEFAULT,
        SplitNodeConnectionTraversalDistanceCheck, SPLIT_NODE_CONNECTION_TRAVERSAL_DISTANCE_MIN_DETOUR_DEFAULT,
        MaxSplitTileNodeCountCheck, MAX_SPLIT_TILE_NODE_COUNT_DEFAULT,
        MinVerticalPassageCountCheck, MIN_VERTICAL_PASSAGE_COUNT_DEFAULT, MIN_VERTICAL_PASSAGE_COUNT_DEFAULT_FLOOR_SCOPE, MIN_VERTICAL_PASSAGE_COUNT_DEFAULT_COUNT_INCOMING,
        MinVerticalPassageRatioCheck, MIN_VERTICAL_PASSAGE_RATIO_DEFAULT, MIN_VERTICAL_PASSAGE_RATIO_DEFAULT_FLOOR_SCOPE, MIN_VERTICAL_PASSAGE_RATIO_DEFAULT_COUNT_INCOMING,
        MaxVerticalPassageCountCheck, MAX_VERTICAL_PASSAGE_COUNT_DEFAULT, MAX_VERTICAL_PASSAGE_COUNT_DEFAULT_FLOOR_SCOPE, MAX_VERTICAL_PASSAGE_COUNT_DEFAULT_TYPE, MAX_VERTICAL_PASSAGE_COUNT_DEFAULT_COUNT_INCOMING,
        MaxVerticalPassageRatioCheck, MAX_VERTICAL_PASSAGE_RATIO_DEFAULT, MAX_VERTICAL_PASSAGE_RATIO_DEFAULT_FLOOR_SCOPE, MAX_VERTICAL_PASSAGE_RATIO_DEFAULT_TYPE, MAX_VERTICAL_PASSAGE_RATIO_DEFAULT_COUNT_INCOMING,
        VerticalPassageGroupGeometricProximityCheck, VERTICAL_PASSAGE_GROUP_GEOMETRIC_PROXIMITY_DISTANCE_DEFAULT, VERTICAL_PASSAGE_GROUP_GEOMETRIC_PROXIMITY_DEFAULT_TYPE, VERTICAL_PASSAGE_GROUP_GEOMETRIC_PROXIMITY_DEFAULT_COUNT_INCOMING, VERTICAL_PASSAGE_GROUP_GEOMETRIC_PROXIMITY_DEFAULT_FLOOR_MODE,
        VerticalPassageGroupGraphProximityCheck, VERTICAL_PASSAGE_GROUP_GRAPH_PROXIMITY_DISTANCE_DEFAULT, VERTICAL_PASSAGE_GROUP_GRAPH_PROXIMITY_DEFAULT_TYPE,
        VerticalPassageType,
        Comparison, CycleKind, GeometricFloorMode, FloorScope, RuleParams,
        MissingEndpointsIssue, UnreachableFinishIssue, MissingLoopsIssue, InvalidLoopIssue,
        InvalidLoopGroupIssue,
        ExcessiveSccCountIssue, RegionNeedsExpansionIssue, RegionNeedsShrinkIssue, MissingRegionsIssue,
        InvalidTeleportIssue, InvalidTeleportGroupIssue, InvalidOneWayIssue, InvalidOneWayGroupIssue,
        MissingOneWaysIssue, MissingTeleportsIssue, InvalidSplitTileIssue, InvalidSplitTileGroupIssue,
        MissingSplitTilesIssue, InvalidSplitNodeIssue, InvalidSplitNodeConnectionGroupIssue,
        InvalidSplitNodeGroupIssue, InvalidSplitRouteIssue,
        MissingVerticalPassagesIssue, InvalidVerticalPassageGroupIssue,
        ElevatorStopCountCheck, ELEVATOR_STOP_COUNT_DEFAULT, ELEVATOR_STOP_COUNT_DEFAULT_COMPARISON,
        ElevatorSpanCheck, ELEVATOR_SPAN_DEFAULT, ELEVATOR_SPAN_DEFAULT_COMPARISON,
        InvalidElevatorIssue,
        MaxElevatorCountCheck, MAX_ELEVATOR_COUNT_DEFAULT,
        MaxElevatorDensityCheck, MAX_ELEVATOR_DENSITY_DEFAULT,
        InvalidElevatorGroupIssue,
        MinElevatorCountCheck, MIN_ELEVATOR_COUNT_DEFAULT,
        MinElevatorDensityCheck, MIN_ELEVATOR_DENSITY_DEFAULT,
        MissingElevatorsIssue,
        MinElevatorStopsPerAreaCountCheck, MIN_ELEVATOR_STOPS_PER_AREA_COUNT_DEFAULT, MIN_ELEVATOR_STOPS_PER_AREA_COUNT_DEFAULT_FLOOR_SCOPE,
        MinElevatorStopsPerAreaDensityCheck, MIN_ELEVATOR_STOPS_PER_AREA_DENSITY_DEFAULT, MIN_ELEVATOR_STOPS_PER_AREA_DENSITY_DEFAULT_FLOOR_SCOPE,
        AreaMissingElevatorStopsIssue,
        MaxElevatorStopsCheck, MAX_ELEVATOR_STOPS_DEFAULT,
        MaxElevatorStopsPerFloorCheck, MAX_ELEVATOR_STOPS_PER_FLOOR_DEFAULT,
        ElevatorStopsSkipCheck, ELEVATOR_STOPS_SKIP_DEFAULT,
        ElevatorStopsSpanCheck, ELEVATOR_STOPS_SPAN_DEFAULT,
        InvalidElevatorStopGroupIssue,
        MissingElevatorStopCountIssue, MissingElevatorHeightIssue, ExcessiveElevatorStopGapIssue,
        MinElevatorStopCountCheck, MIN_ELEVATOR_STOP_COUNT_DEFAULT,
        MinElevatorHeightCheck, MIN_ELEVATOR_HEIGHT_DEFAULT,
        MaxElevatorStopGapCheck, MAX_ELEVATOR_STOP_GAP_DEFAULT,
        ElevatorStopGroupGeometricProximityCheck, ELEVATOR_STOP_GROUP_GEOMETRIC_PROXIMITY_DISTANCE_DEFAULT, ELEVATOR_STOP_GROUP_GEOMETRIC_PROXIMITY_DEFAULT_FLOOR_MODE,
        ElevatorStopGroupGraphProximityCheck, ELEVATOR_STOP_GROUP_GRAPH_PROXIMITY_DISTANCE_DEFAULT,
    },
    RegionClass,
};
use crate::config::{CheckInstanceConfig, parse_split_patterns_param};

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

fn parse_teleport_split_edge_selector(param: Option<&String>) -> TeleportSplitEdgeSelector {
    match param.map(String::as_str) {
        Some("entry") => TeleportSplitEdgeSelector::Entry,
        Some("exit") => TeleportSplitEdgeSelector::Exit,
        _ => TeleportSplitEdgeSelector::EntryOrExit,
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

fn parse_split_node_connection_direction(param: Option<&String>) -> SplitNodeConnectionDirection {
    match param.map(String::as_str) {
        Some("incoming") => SplitNodeConnectionDirection::Incoming,
        Some("outgoing") => SplitNodeConnectionDirection::Outgoing,
        Some("bidirectional") => SplitNodeConnectionDirection::Bidirectional,
        _ => SplitNodeConnectionDirection::Any,
    }
}

fn parse_split_teleport_direction(param: Option<&String>) -> SplitTeleportDirection {
    match param.map(String::as_str) {
        Some("incoming") => SplitTeleportDirection::Incoming,
        Some("outgoing") => SplitTeleportDirection::Outgoing,
        Some("bidirectional") => SplitTeleportDirection::Bidirectional,
        _ => SplitTeleportDirection::Any,
    }
}

fn parse_teleport_proximity_edge(param: Option<&String>) -> TeleportProximityEdge {
    match param.map(String::as_str) {
        Some("entry") => TeleportProximityEdge::Entry,
        Some("exit") => TeleportProximityEdge::Exit,
        _ => TeleportProximityEdge::EntryOrExit,
    }
}

/// GitHub issue #177: `comparison` is shared by every check merged around `Comparison` — missing
/// or unparseable falls back to `default`, the check's own pre-#177 fixed operator.
fn parse_comparison(param: Option<&String>, default: Comparison) -> Comparison {
    param.and_then(|v| Comparison::from_str(v)).unwrap_or(default)
}

/// GitHub issue #342: shared by every geometric-distance check that needs a cross-floor policy.
fn parse_geometric_floor_mode(param: Option<&String>, default: GeometricFloorMode) -> GeometricFloorMode {
    param.and_then(|v| GeometricFloorMode::from_str(v)).unwrap_or(default)
}

/// GitHub issue #369: `floor_scope` is shared by every count/density-style check (except
/// region-based checks and `scc_count`) — missing or unparseable falls back to `default`.
fn parse_floor_scope(param: Option<&String>, default: FloorScope) -> FloorScope {
    param.and_then(|v| FloorScope::from_str(v)).unwrap_or(default)
}

/// GitHub issue #217: `cycle_kind` is shared by every loop-based check built on
/// `cycle_check_core::find_invalid_cycles` — missing or unparseable falls back to `CycleKind::Any`,
/// the pre-#217 behavior of considering every cycle regardless of directionality.
fn parse_cycle_kind(param: Option<&String>) -> CycleKind {
    param.and_then(|v| CycleKind::from_str(v)).unwrap_or(CycleKind::Any)
}

/// GitHub issue #343 follow-up: `same_type_only` is shared by the two `VerticalPassage` proximity
/// checks — missing or unparseable defaults to `false`.
fn parse_same_type_only(param: Option<&String>) -> bool {
    param.and_then(|v| v.parse::<bool>().ok()).unwrap_or(false)
}

/// GitHub issue #343 follow-up: `passage_type` is shared by the 4 min/max vertical-passage
/// count/ratio checks and the 2 group-proximity checks — missing or unparseable falls back to
/// `default`.
fn parse_vertical_passage_type(param: Option<&String>, default: VerticalPassageType) -> VerticalPassageType {
    param.and_then(|v| VerticalPassageType::from_str(v)).unwrap_or(default)
}

/// GitHub issue #343 follow-up: `count_incoming` is shared by the 4 min/max vertical-passage
/// count/ratio checks — missing or unparseable falls back to `default`.
fn parse_count_incoming(param: Option<&String>, default: bool) -> bool {
    param.and_then(|v| v.parse::<bool>().ok()).unwrap_or(default)
}

/// One `build_*_check` function per `KindTag` — `type_id`s that share a `KindTag` (e.g.
/// `min_loops_count`/`min_loop_density`, both `MissingLoops`) are handled by the same function's
/// own `match`. Parsing logic per arm is unchanged from the pre-#113 single `build_check`, just
/// redistributed by `KindTag` instead of living in one flat match over every `type_id` at once.
/// `Option`, not `Result` — `None` means "this `type_id` doesn't belong to this `KindTag`", the
/// per-arm-invalid-value case doesn't exist (every param has a documented fallback default).
pub(crate) fn build_missing_endpoints_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String, _rule_params: &RuleParams) -> Option<Box<dyn maze_core::quality_control::Check<T, MissingEndpointsIssue>>> {
    match instance.type_id.as_str() {
        "missing_endpoints" => Some(Box::new(MissingEndpointsCheck { instance_id })),
        _ => None,
    }
}

pub(crate) fn build_unreachable_finish_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String, _rule_params: &RuleParams) -> Option<Box<dyn maze_core::quality_control::Check<T, UnreachableFinishIssue>>> {
    match instance.type_id.as_str() {
        "unreachable_finish" => Some(Box::new(UnreachableFinishCheck { instance_id })),
        _ => None,
    }
}

pub(crate) fn build_missing_loops_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String, _rule_params: &RuleParams) -> Option<Box<dyn maze_core::quality_control::Check<T, MissingLoopsIssue>>> {
    match instance.type_id.as_str() {
        "min_loops_count" => {
            let min_loops = instance.params.get("min_loops")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(1) as u32)
                .unwrap_or(MIN_LOOPS_DEFAULT);
            let floor_scope = parse_floor_scope(instance.params.get("floor_scope"), MIN_LOOPS_COUNT_DEFAULT_FLOOR_SCOPE);
            Some(Box::new(MinLoopsCountCheck { instance_id, min_loops, floor_scope }))
        }
        "min_loop_density" => {
            let min_density = instance.params.get("min_density")
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .map(|v| v.clamp(0.0, 100.0))
                .unwrap_or(MIN_LOOP_DENSITY_DEFAULT);
            let avg_loop_length_estimate = instance.params.get("avg_loop_length_estimate")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(1) as u32)
                .unwrap_or(AVG_LOOP_LENGTH_ESTIMATE_DEFAULT);
            let floor_scope = parse_floor_scope(instance.params.get("floor_scope"), MIN_LOOP_DENSITY_DEFAULT_FLOOR_SCOPE);
            Some(Box::new(MinLoopDensityCheck { instance_id, min_density, avg_loop_length_estimate, floor_scope }))
        }
        _ => None,
    }
}

pub(crate) fn build_missing_split_tiles_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String, _rule_params: &RuleParams) -> Option<Box<dyn maze_core::quality_control::Check<T, MissingSplitTilesIssue>>> {
    match instance.type_id.as_str() {
        "split_count" => {
            let min_count = instance.params.get("split_count")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(SPLIT_COUNT_DEFAULT);
            let patterns = parse_split_patterns_param(instance.params.get("patterns"));
            let floor_scope = parse_floor_scope(instance.params.get("floor_scope"), SPLIT_COUNT_DEFAULT_FLOOR_SCOPE);
            Some(Box::new(SplitCountCheck { instance_id, min_count, patterns, floor_scope }))
        }
        "split_density" => {
            let min_density = instance.params.get("split_density")
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .map(|v| v.clamp(0.0, 100.0))
                .unwrap_or(SPLIT_DENSITY_DEFAULT);
            let patterns = parse_split_patterns_param(instance.params.get("patterns"));
            let floor_scope = parse_floor_scope(instance.params.get("floor_scope"), SPLIT_DENSITY_DEFAULT_FLOOR_SCOPE);
            Some(Box::new(SplitDensityCheck { instance_id, min_density, patterns, floor_scope }))
        }
        _ => None,
    }
}

pub(crate) fn build_invalid_loop_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String, _rule_params: &RuleParams) -> Option<Box<dyn maze_core::quality_control::Check<T, InvalidLoopIssue>>> {
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

pub(crate) fn build_invalid_loop_group_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String, _rule_params: &RuleParams) -> Option<Box<dyn maze_core::quality_control::Check<T, InvalidLoopGroupIssue>>> {
    match instance.type_id.as_str() {
        "max_loop_density" => {
            let max_density = instance.params.get("max_density")
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .map(|v| v.clamp(0.0, 100.0))
                .unwrap_or(MAX_LOOP_DENSITY_DEFAULT);
            let floor_scope = parse_floor_scope(instance.params.get("floor_scope"), MAX_LOOP_DENSITY_DEFAULT_FLOOR_SCOPE);
            Some(Box::new(MaxLoopDensityCheck { instance_id, max_density, floor_scope }))
        }
        "max_loops_count" => {
            let max_loops_count = instance.params.get("max_loops_count")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(MAX_LOOPS_COUNT_DEFAULT);
            let floor_scope = parse_floor_scope(instance.params.get("floor_scope"), MAX_LOOPS_COUNT_DEFAULT_FLOOR_SCOPE);
            Some(Box::new(MaxLoopsCountCheck { instance_id, max_loops_count, floor_scope }))
        }
        _ => None,
    }
}

pub(crate) fn build_excessive_scc_count_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String, _rule_params: &RuleParams) -> Option<Box<dyn maze_core::quality_control::Check<T, ExcessiveSccCountIssue>>> {
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

pub(crate) fn build_region_needs_expansion_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String, _rule_params: &RuleParams) -> Option<Box<dyn maze_core::quality_control::Check<T, RegionNeedsExpansionIssue>>> {
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
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .map(|v| v.clamp(0.0, 100.0))
                .unwrap_or(MIN_REGION_RATIO_DEFAULT);
            let region_classes = parse_region_class_filter(instance.params.get("region_class"));
            Some(Box::new(MinRegionRatioCheck { instance_id, min_region_ratio, region_classes }))
        }
        _ => None,
    }
}

pub(crate) fn build_region_needs_shrink_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String, _rule_params: &RuleParams) -> Option<Box<dyn maze_core::quality_control::Check<T, RegionNeedsShrinkIssue>>> {
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
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .map(|v| v.clamp(0.0, 100.0))
                .unwrap_or(MAX_REGION_RATIO_DEFAULT);
            let region_classes = parse_region_class_filter(instance.params.get("region_class"));
            Some(Box::new(MaxRegionRatioCheck { instance_id, max_region_ratio, region_classes }))
        }
        _ => None,
    }
}

pub(crate) fn build_missing_regions_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String, _rule_params: &RuleParams) -> Option<Box<dyn maze_core::quality_control::Check<T, MissingRegionsIssue>>> {
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

pub(crate) fn build_invalid_teleport_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String, rule_params: &RuleParams) -> Option<Box<dyn maze_core::quality_control::Check<T, InvalidTeleportIssue>>> {
    let protect_route = rule_params.protect_route;
    match instance.type_id.as_str() {
        "teleport_duplicates_connection" => {
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
            Some(Box::new(TeleportWaypointDistanceCheck { instance_id, distance, comparison, waypoint, edge, protect_route }))
        }
        "teleport_geometric_length" => {
            let length = instance.params.get("length")
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .map(|v| v.max(0.0))
                .unwrap_or(TELEPORT_GEOMETRIC_LENGTH_DEFAULT);
            let comparison = parse_comparison(instance.params.get("comparison"), Comparison::Lt);
            let floor_mode = parse_geometric_floor_mode(instance.params.get("floor_mode"), TELEPORT_GEOMETRIC_LENGTH_DEFAULT_FLOOR_MODE);
            Some(Box::new(TeleportGeometricLengthCheck { instance_id, comparison, length, protect_route, floor_mode }))
        }
        "teleport_graph_distance" => {
            let distance = instance.params.get("distance")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(TELEPORT_GRAPH_DISTANCE_DEFAULT);
            let comparison = parse_comparison(instance.params.get("comparison"), Comparison::Lt);
            Some(Box::new(TeleportGraphDistanceCheck { instance_id, comparison, distance, protect_route }))
        }
        "teleport_super_hub_avoidance" => {
            let max_connections = instance.params.get("max_connections")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(TELEPORT_SUPER_HUB_MAX_CONNECTIONS_DEFAULT);
            let edge = parse_teleport_hub_edge_selector(instance.params.get("edge_hub"));
            Some(Box::new(TeleportSuperHubAvoidanceCheck { instance_id, max_connections, edge, protect_route }))
        }
        "teleport_split_intersection" => {
            let edge = parse_teleport_split_edge_selector(instance.params.get("edge_split"));
            Some(Box::new(TeleportSplitIntersectionCheck { instance_id, edge, protect_route }))
        }
        _ => None,
    }
}

pub(crate) fn build_invalid_one_way_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String, rule_params: &RuleParams) -> Option<Box<dyn maze_core::quality_control::Check<T, InvalidOneWayIssue>>> {
    match instance.type_id.as_str() {
        "one_way_waypoint_distance" => {
            let distance = instance.params.get("distance")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(ONE_WAY_WAYPOINT_DISTANCE_DEFAULT);
            let comparison = parse_comparison(instance.params.get("comparison"), Comparison::Lt);
            let waypoint = parse_one_way_waypoint(instance.params.get("waypoint"));
            Some(Box::new(OneWayWaypointDistanceCheck { instance_id, distance, comparison, waypoint, protect_route: rule_params.protect_route }))
        }
        _ => None,
    }
}

pub(crate) fn build_teleport_group_proximity_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String, rule_params: &RuleParams) -> Option<Box<dyn maze_core::quality_control::Check<T, InvalidTeleportGroupIssue>>> {
    match instance.type_id.as_str() {
        "teleport_group_proximity" => {
            let distance = instance.params.get("distance")
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .map(|v| v.max(0.0))
                .unwrap_or(TELEPORT_GROUP_PROXIMITY_DISTANCE_DEFAULT);
            let own_edge = parse_teleport_proximity_edge(instance.params.get("own_edge"));
            let other_edge = parse_teleport_proximity_edge(instance.params.get("other_edge"));
            Some(Box::new(TeleportGroupProximityCheck { instance_id, distance, own_edge, other_edge, protect_route: rule_params.protect_route }))
        }
        _ => None,
    }
}

pub(crate) fn build_one_way_group_proximity_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String, rule_params: &RuleParams) -> Option<Box<dyn maze_core::quality_control::Check<T, InvalidOneWayGroupIssue>>> {
    match instance.type_id.as_str() {
        "one_way_group_geometric_proximity" => {
            let distance = instance.params.get("distance")
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .map(|v| v.max(0.0))
                .unwrap_or(ONE_WAY_GROUP_GEOMETRIC_PROXIMITY_DISTANCE_DEFAULT);
            let floor_mode = parse_geometric_floor_mode(instance.params.get("floor_mode"), ONE_WAY_GROUP_GEOMETRIC_PROXIMITY_DEFAULT_FLOOR_MODE);
            Some(Box::new(OneWayGroupGeometricProximityCheck { instance_id, distance, protect_route: rule_params.protect_route, floor_mode }))
        }
        "one_way_group_graph_proximity" => {
            let distance = instance.params.get("distance")
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .map(|v| v.max(0.0))
                .unwrap_or(ONE_WAY_GROUP_GRAPH_PROXIMITY_DISTANCE_DEFAULT);
            Some(Box::new(OneWayGroupGraphProximityCheck { instance_id, distance, protect_route: rule_params.protect_route }))
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
            let floor_scope = parse_floor_scope(instance.params.get("floor_scope"), MAX_ONE_WAY_COUNT_DEFAULT_FLOOR_SCOPE);
            Some(Box::new(MaxOneWayCountCheck { instance_id, max_one_ways, floor_scope }))
        }
        "max_one_way_ratio" => {
            let max_ratio = instance.params.get("max_ratio")
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .map(|v| v.clamp(0.0, 100.0))
                .unwrap_or(MAX_ONE_WAY_RATIO_DEFAULT);
            let floor_scope = parse_floor_scope(instance.params.get("floor_scope"), MAX_ONE_WAY_RATIO_DEFAULT_FLOOR_SCOPE);
            Some(Box::new(MaxOneWayRatioCheck { instance_id, max_ratio, floor_scope }))
        }
        _ => None,
    }
}

pub(crate) fn build_missing_one_ways_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String, _rule_params: &RuleParams) -> Option<Box<dyn maze_core::quality_control::Check<T, MissingOneWaysIssue>>> {
    match instance.type_id.as_str() {
        "min_one_way_count" => {
            let min_one_ways = instance.params.get("min_one_ways")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(1) as u32)
                .unwrap_or(MIN_ONE_WAY_COUNT_DEFAULT);
            let floor_scope = parse_floor_scope(instance.params.get("floor_scope"), MIN_ONE_WAY_COUNT_DEFAULT_FLOOR_SCOPE);
            Some(Box::new(MinOneWayCountCheck { instance_id, min_one_ways, floor_scope }))
        }
        "min_one_way_ratio" => {
            let min_ratio = instance.params.get("min_ratio")
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .map(|v| v.clamp(0.0, 100.0))
                .unwrap_or(MIN_ONE_WAY_RATIO_DEFAULT);
            let floor_scope = parse_floor_scope(instance.params.get("floor_scope"), MIN_ONE_WAY_RATIO_DEFAULT_FLOOR_SCOPE);
            Some(Box::new(MinOneWayRatioCheck { instance_id, min_ratio, floor_scope }))
        }
        _ => None,
    }
}

pub(crate) fn build_invalid_split_tile_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String, _rule_params: &RuleParams) -> Option<Box<dyn maze_core::quality_control::Check<T, InvalidSplitTileIssue>>> {
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
        "split_teleport_intersection" => {
            let direction = parse_split_teleport_direction(instance.params.get("split_teleport_direction"));
            Some(Box::new(SplitTeleportIntersectionCheck { instance_id, direction }))
        }
        _ => None,
    }
}

pub(crate) fn build_invalid_split_node_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String, _rule_params: &RuleParams) -> Option<Box<dyn maze_core::quality_control::Check<T, InvalidSplitNodeIssue>>> {
    match instance.type_id.as_str() {
        "split_node_connection_count" => {
            let count = instance.params.get("count")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(SPLIT_NODE_CONNECTION_COUNT_DEFAULT);
            let comparison = parse_comparison(instance.params.get("comparison"), SPLIT_NODE_CONNECTION_COUNT_DEFAULT_COMPARISON);
            let direction = parse_split_node_connection_direction(instance.params.get("direction"));
            Some(Box::new(SplitNodeConnectionCountCheck { instance_id, count, comparison, direction }))
        }
        _ => None,
    }
}

pub(crate) fn build_split_node_connection_group_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String, _rule_params: &RuleParams) -> Option<Box<dyn maze_core::quality_control::Check<T, InvalidSplitNodeConnectionGroupIssue>>> {
    match instance.type_id.as_str() {
        "split_node_connection_per_neighbor" => {
            let max = instance.params.get("max")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(SPLIT_NODE_CONNECTION_PER_NEIGHBOR_MAX_DEFAULT);
            Some(Box::new(SplitNodeConnectionPerNeighborCheck { instance_id, max }))
        }
        "split_node_connection_per_face" => {
            let max = instance.params.get("max")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(SPLIT_NODE_CONNECTION_PER_FACE_MAX_DEFAULT);
            Some(Box::new(SplitNodeConnectionPerFaceCheck { instance_id, max }))
        }
        _ => None,
    }
}

pub(crate) fn build_invalid_split_route_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String, _rule_params: &RuleParams) -> Option<Box<dyn maze_core::quality_control::Check<T, InvalidSplitRouteIssue>>> {
    match instance.type_id.as_str() {
        "split_node_connection_traversal_distance" => {
            let min_detour = instance.params.get("min_detour")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(SPLIT_NODE_CONNECTION_TRAVERSAL_DISTANCE_MIN_DETOUR_DEFAULT);
            Some(Box::new(SplitNodeConnectionTraversalDistanceCheck { instance_id, min_detour }))
        }
        _ => None,
    }
}

pub(crate) fn build_split_node_group_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String, _rule_params: &RuleParams) -> Option<Box<dyn maze_core::quality_control::Check<T, InvalidSplitNodeGroupIssue>>> {
    match instance.type_id.as_str() {
        "max_split_tile_node_count" => {
            let max = instance.params.get("max")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(MAX_SPLIT_TILE_NODE_COUNT_DEFAULT);
            Some(Box::new(MaxSplitTileNodeCountCheck { instance_id, max }))
        }
        _ => None,
    }
}

pub(crate) fn build_split_group_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String, _rule_params: &RuleParams) -> Option<Box<dyn maze_core::quality_control::Check<T, InvalidSplitTileGroupIssue>>> {
    match instance.type_id.as_str() {
        "max_split_count" => {
            let max_split_count = instance.params.get("max_split_count")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(MAX_SPLIT_COUNT_DEFAULT);
            let floor_scope = parse_floor_scope(instance.params.get("floor_scope"), MAX_SPLIT_COUNT_DEFAULT_FLOOR_SCOPE);
            Some(Box::new(MaxSplitCountCheck { instance_id, max_split_count, floor_scope }))
        }
        "max_split_density" => {
            let max_density = instance.params.get("max_split_density")
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .map(|v| v.clamp(0.0, 100.0))
                .unwrap_or(MAX_SPLIT_DENSITY_DEFAULT);
            let floor_scope = parse_floor_scope(instance.params.get("floor_scope"), MAX_SPLIT_DENSITY_DEFAULT_FLOOR_SCOPE);
            Some(Box::new(MaxSplitDensityCheck { instance_id, max_density, floor_scope }))
        }
        "split_group_geometric_proximity" => {
            let distance = instance.params.get("split_group_geometric_proximity_distance")
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .map(|v| v.max(0.0))
                .unwrap_or(SPLIT_GROUP_GEOMETRIC_PROXIMITY_DISTANCE_DEFAULT);
            let floor_mode = parse_geometric_floor_mode(instance.params.get("floor_mode"), SPLIT_GROUP_GEOMETRIC_PROXIMITY_DEFAULT_FLOOR_MODE);
            Some(Box::new(SplitGroupGeometricProximityCheck { instance_id, distance, floor_mode }))
        }
        "split_group_graph_proximity" => {
            let distance = instance.params.get("split_group_graph_proximity_distance")
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .map(|v| v.max(0.0))
                .unwrap_or(SPLIT_GROUP_GRAPH_PROXIMITY_DISTANCE_DEFAULT);
            Some(Box::new(SplitGroupGraphProximityCheck { instance_id, distance }))
        }
        _ => None,
    }
}

pub(crate) fn build_missing_teleports_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String, _rule_params: &RuleParams) -> Option<Box<dyn maze_core::quality_control::Check<T, MissingTeleportsIssue>>> {
    match instance.type_id.as_str() {
        "min_teleport_count" => {
            let min_teleports = instance.params.get("min_teleports")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(1) as u32)
                .unwrap_or(MIN_TELEPORT_COUNT_DEFAULT);
            let floor_scope = parse_floor_scope(instance.params.get("floor_scope"), MIN_TELEPORT_COUNT_DEFAULT_FLOOR_SCOPE);
            Some(Box::new(MinTeleportCountCheck { instance_id, min_teleports, floor_scope }))
        }
        "min_teleport_ratio" => {
            let min_teleport_ratio = instance.params.get("min_teleport_ratio")
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .map(|v| v.clamp(0.0, 100.0))
                .unwrap_or(MIN_TELEPORT_RATIO_DEFAULT);
            let floor_scope = parse_floor_scope(instance.params.get("floor_scope"), MIN_TELEPORT_RATIO_DEFAULT_FLOOR_SCOPE);
            Some(Box::new(MinTeleportRatioCheck { instance_id, min_teleport_ratio, floor_scope }))
        }
        _ => None,
    }
}

pub(crate) fn build_missing_vertical_passages_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String, rule_params: &RuleParams) -> Option<Box<dyn maze_core::quality_control::Check<T, MissingVerticalPassagesIssue>>> {
    match instance.type_id.as_str() {
        "min_vertical_passage_count" => {
            let min_vertical_passages = instance.params.get("min_vertical_passages")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(1) as u32)
                .unwrap_or(MIN_VERTICAL_PASSAGE_COUNT_DEFAULT);
            let floor_scope = parse_floor_scope(instance.params.get("floor_scope"), MIN_VERTICAL_PASSAGE_COUNT_DEFAULT_FLOOR_SCOPE);
            let count_incoming = parse_count_incoming(instance.params.get("count_incoming"), MIN_VERTICAL_PASSAGE_COUNT_DEFAULT_COUNT_INCOMING);
            Some(Box::new(MinVerticalPassageCountCheck { instance_id, min_vertical_passages, floor_scope, passage_type: rule_params.vertical_passage_type, count_incoming }))
        }
        "min_vertical_passage_ratio" => {
            let min_vertical_passage_ratio = instance.params.get("min_vertical_passage_ratio")
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .map(|v| v.clamp(0.0, 100.0))
                .unwrap_or(MIN_VERTICAL_PASSAGE_RATIO_DEFAULT);
            let floor_scope = parse_floor_scope(instance.params.get("floor_scope"), MIN_VERTICAL_PASSAGE_RATIO_DEFAULT_FLOOR_SCOPE);
            let count_incoming = parse_count_incoming(instance.params.get("count_incoming"), MIN_VERTICAL_PASSAGE_RATIO_DEFAULT_COUNT_INCOMING);
            Some(Box::new(MinVerticalPassageRatioCheck { instance_id, min_vertical_passage_ratio, floor_scope, passage_type: rule_params.vertical_passage_type, count_incoming }))
        }
        _ => None,
    }
}

pub(crate) fn build_invalid_vertical_passage_group_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String, _rule_params: &RuleParams) -> Option<Box<dyn maze_core::quality_control::Check<T, InvalidVerticalPassageGroupIssue>>> {
    match instance.type_id.as_str() {
        "max_vertical_passage_count" => {
            let max_vertical_passages = instance.params.get("max_vertical_passages")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(MAX_VERTICAL_PASSAGE_COUNT_DEFAULT);
            let floor_scope = parse_floor_scope(instance.params.get("floor_scope"), MAX_VERTICAL_PASSAGE_COUNT_DEFAULT_FLOOR_SCOPE);
            let passage_type = parse_vertical_passage_type(instance.params.get("passage_type"), MAX_VERTICAL_PASSAGE_COUNT_DEFAULT_TYPE);
            let count_incoming = parse_count_incoming(instance.params.get("count_incoming"), MAX_VERTICAL_PASSAGE_COUNT_DEFAULT_COUNT_INCOMING);
            Some(Box::new(MaxVerticalPassageCountCheck { instance_id, max_vertical_passages, floor_scope, passage_type, count_incoming }))
        }
        "max_vertical_passage_ratio" => {
            let max_ratio = instance.params.get("max_ratio")
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .map(|v| v.clamp(0.0, 100.0))
                .unwrap_or(MAX_VERTICAL_PASSAGE_RATIO_DEFAULT);
            let floor_scope = parse_floor_scope(instance.params.get("floor_scope"), MAX_VERTICAL_PASSAGE_RATIO_DEFAULT_FLOOR_SCOPE);
            let passage_type = parse_vertical_passage_type(instance.params.get("passage_type"), MAX_VERTICAL_PASSAGE_RATIO_DEFAULT_TYPE);
            let count_incoming = parse_count_incoming(instance.params.get("count_incoming"), MAX_VERTICAL_PASSAGE_RATIO_DEFAULT_COUNT_INCOMING);
            Some(Box::new(MaxVerticalPassageRatioCheck { instance_id, max_ratio, floor_scope, passage_type, count_incoming }))
        }
        "vertical_passage_group_geometric_proximity" => {
            let distance = instance.params.get("distance")
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .map(|v| v.max(0.0))
                .unwrap_or(VERTICAL_PASSAGE_GROUP_GEOMETRIC_PROXIMITY_DISTANCE_DEFAULT);
            let passage_type = parse_vertical_passage_type(instance.params.get("passage_type"), VERTICAL_PASSAGE_GROUP_GEOMETRIC_PROXIMITY_DEFAULT_TYPE);
            let same_type_only = parse_same_type_only(instance.params.get("same_type_only"));
            let count_incoming = parse_count_incoming(instance.params.get("count_incoming"), VERTICAL_PASSAGE_GROUP_GEOMETRIC_PROXIMITY_DEFAULT_COUNT_INCOMING);
            let floor_mode = parse_geometric_floor_mode(instance.params.get("floor_mode"), VERTICAL_PASSAGE_GROUP_GEOMETRIC_PROXIMITY_DEFAULT_FLOOR_MODE);
            Some(Box::new(VerticalPassageGroupGeometricProximityCheck { instance_id, distance, passage_type, same_type_only, count_incoming, floor_mode }))
        }
        "vertical_passage_group_graph_proximity" => {
            let distance = instance.params.get("distance")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(VERTICAL_PASSAGE_GROUP_GRAPH_PROXIMITY_DISTANCE_DEFAULT);
            let passage_type = parse_vertical_passage_type(instance.params.get("passage_type"), VERTICAL_PASSAGE_GROUP_GRAPH_PROXIMITY_DEFAULT_TYPE);
            let same_type_only = parse_same_type_only(instance.params.get("same_type_only"));
            Some(Box::new(VerticalPassageGroupGraphProximityCheck { instance_id, distance, passage_type, same_type_only }))
        }
        _ => None,
    }
}

pub(crate) fn build_invalid_elevator_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String, _rule_params: &RuleParams) -> Option<Box<dyn maze_core::quality_control::Check<T, InvalidElevatorIssue>>> {
    match instance.type_id.as_str() {
        "elevator_stop_count" => {
            let count = instance.params.get("count")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(ELEVATOR_STOP_COUNT_DEFAULT);
            let comparison = parse_comparison(instance.params.get("comparison"), ELEVATOR_STOP_COUNT_DEFAULT_COMPARISON);
            Some(Box::new(ElevatorStopCountCheck { instance_id, comparison, count }))
        }
        "elevator_span" => {
            let span = instance.params.get("span")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(ELEVATOR_SPAN_DEFAULT);
            let comparison = parse_comparison(instance.params.get("comparison"), ELEVATOR_SPAN_DEFAULT_COMPARISON);
            Some(Box::new(ElevatorSpanCheck { instance_id, comparison, span }))
        }
        _ => None,
    }
}

pub(crate) fn build_invalid_elevator_group_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String, _rule_params: &RuleParams) -> Option<Box<dyn maze_core::quality_control::Check<T, InvalidElevatorGroupIssue>>> {
    match instance.type_id.as_str() {
        "max_elevator_count" => {
            let max_elevator_count = instance.params.get("max_elevator_count")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(MAX_ELEVATOR_COUNT_DEFAULT);
            Some(Box::new(MaxElevatorCountCheck { instance_id, max_elevator_count }))
        }
        "max_elevator_density" => {
            let max_density = instance.params.get("max_elevator_density")
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .map(|v| v.clamp(0.0, 100.0))
                .unwrap_or(MAX_ELEVATOR_DENSITY_DEFAULT);
            Some(Box::new(MaxElevatorDensityCheck { instance_id, max_density }))
        }
        _ => None,
    }
}

pub(crate) fn build_missing_elevators_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String, _rule_params: &RuleParams) -> Option<Box<dyn maze_core::quality_control::Check<T, MissingElevatorsIssue>>> {
    match instance.type_id.as_str() {
        "min_elevator_count" => {
            let min_elevators = instance.params.get("min_elevator_count")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(MIN_ELEVATOR_COUNT_DEFAULT);
            Some(Box::new(MinElevatorCountCheck { instance_id, min_elevators }))
        }
        "min_elevator_density" => {
            let min_density = instance.params.get("min_elevator_density")
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .map(|v| v.clamp(0.0, 100.0))
                .unwrap_or(MIN_ELEVATOR_DENSITY_DEFAULT);
            Some(Box::new(MinElevatorDensityCheck { instance_id, min_density }))
        }
        _ => None,
    }
}

pub(crate) fn build_area_missing_elevator_stops_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String, _rule_params: &RuleParams) -> Option<Box<dyn maze_core::quality_control::Check<T, AreaMissingElevatorStopsIssue>>> {
    match instance.type_id.as_str() {
        "min_elevator_stops_per_area_count" => {
            let min_stops = instance.params.get("min_stops")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(MIN_ELEVATOR_STOPS_PER_AREA_COUNT_DEFAULT);
            let floor_scope = parse_floor_scope(instance.params.get("floor_scope"), MIN_ELEVATOR_STOPS_PER_AREA_COUNT_DEFAULT_FLOOR_SCOPE);
            Some(Box::new(MinElevatorStopsPerAreaCountCheck { instance_id, min_stops, floor_scope }))
        }
        "min_elevator_stops_per_area_density" => {
            let min_stops_ratio = instance.params.get("min_stops_ratio")
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .map(|v| v.clamp(0.0, 100.0))
                .unwrap_or(MIN_ELEVATOR_STOPS_PER_AREA_DENSITY_DEFAULT);
            let floor_scope = parse_floor_scope(instance.params.get("floor_scope"), MIN_ELEVATOR_STOPS_PER_AREA_DENSITY_DEFAULT_FLOOR_SCOPE);
            Some(Box::new(MinElevatorStopsPerAreaDensityCheck { instance_id, min_stops_ratio, floor_scope }))
        }
        _ => None,
    }
}

pub(crate) fn build_missing_elevator_stop_count_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String, _rule_params: &RuleParams) -> Option<Box<dyn maze_core::quality_control::Check<T, MissingElevatorStopCountIssue>>> {
    match instance.type_id.as_str() {
        "min_elevator_stop_count" => {
            let min_stop_count = instance.params.get("min_elevator_stop_count")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(MIN_ELEVATOR_STOP_COUNT_DEFAULT);
            Some(Box::new(MinElevatorStopCountCheck { instance_id, min_stop_count }))
        }
        _ => None,
    }
}

pub(crate) fn build_missing_elevator_height_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String, _rule_params: &RuleParams) -> Option<Box<dyn maze_core::quality_control::Check<T, MissingElevatorHeightIssue>>> {
    match instance.type_id.as_str() {
        "min_elevator_height" => {
            let min_height = instance.params.get("min_elevator_height")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(MIN_ELEVATOR_HEIGHT_DEFAULT);
            Some(Box::new(MinElevatorHeightCheck { instance_id, min_height }))
        }
        _ => None,
    }
}

pub(crate) fn build_excessive_elevator_stop_gap_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String, _rule_params: &RuleParams) -> Option<Box<dyn maze_core::quality_control::Check<T, ExcessiveElevatorStopGapIssue>>> {
    match instance.type_id.as_str() {
        "max_elevator_stop_gap" => {
            let max_stop_gap = instance.params.get("max_elevator_stop_gap")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(MAX_ELEVATOR_STOP_GAP_DEFAULT);
            Some(Box::new(MaxElevatorStopGapCheck { instance_id, max_stop_gap }))
        }
        _ => None,
    }
}

pub(crate) fn build_invalid_elevator_stop_group_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String, _rule_params: &RuleParams) -> Option<Box<dyn maze_core::quality_control::Check<T, InvalidElevatorStopGroupIssue>>> {
    match instance.type_id.as_str() {
        "max_elevator_stops" => {
            let max_elevator_stops = instance.params.get("max_elevator_stops")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(MAX_ELEVATOR_STOPS_DEFAULT);
            Some(Box::new(MaxElevatorStopsCheck { instance_id, max_elevator_stops }))
        }
        "max_elevator_stops_per_floor" => {
            let max_elevator_stops_per_floor = instance.params.get("max_elevator_stops_per_floor")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(MAX_ELEVATOR_STOPS_PER_FLOOR_DEFAULT);
            Some(Box::new(MaxElevatorStopsPerFloorCheck { instance_id, max_elevator_stops_per_floor }))
        }
        "elevator_stops_skip" => {
            let elevator_stops_skip = instance.params.get("elevator_stops_skip")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(ELEVATOR_STOPS_SKIP_DEFAULT);
            Some(Box::new(ElevatorStopsSkipCheck { instance_id, elevator_stops_skip }))
        }
        "elevator_stops_span" => {
            let elevator_stops_span = instance.params.get("elevator_stops_span")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(ELEVATOR_STOPS_SPAN_DEFAULT);
            Some(Box::new(ElevatorStopsSpanCheck { instance_id, elevator_stops_span }))
        }
        "elevator_stop_group_geometric_proximity" => {
            let distance = instance.params.get("distance")
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .map(|v| v.max(0.0))
                .unwrap_or(ELEVATOR_STOP_GROUP_GEOMETRIC_PROXIMITY_DISTANCE_DEFAULT);
            let floor_mode = parse_geometric_floor_mode(instance.params.get("floor_mode"), ELEVATOR_STOP_GROUP_GEOMETRIC_PROXIMITY_DEFAULT_FLOOR_MODE);
            Some(Box::new(ElevatorStopGroupGeometricProximityCheck { instance_id, distance, floor_mode }))
        }
        "elevator_stop_group_graph_proximity" => {
            let distance = instance.params.get("distance")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(ELEVATOR_STOP_GROUP_GRAPH_PROXIMITY_DISTANCE_DEFAULT);
            Some(Box::new(ElevatorStopGroupGraphProximityCheck { instance_id, distance }))
        }
        _ => None,
    }
}
