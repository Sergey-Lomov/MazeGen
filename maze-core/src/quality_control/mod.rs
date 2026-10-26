pub mod apply_commands;
pub mod check;
pub mod checks;
pub mod cross_element;
pub mod cycle_kind;
pub mod distance_diagnostics;
pub mod engine;
pub mod event;
pub mod floor_group;
pub mod floor_scope;
pub mod geometric_floor_mode;
pub mod issue;
pub mod issue_kinds;
pub mod issue_payload;
pub mod repair_area;
pub mod rule;
pub mod rule_params;
pub mod stage;
pub use cross_element::{CrossElement, CrossElementOccurrence, CrossElementSet};
pub mod split_pattern_match;
pub mod teleport_direction_filter;
pub mod teleport_floor_kind_filter;
pub mod vertical_passage_type;

pub use crate::comparison::Comparison;
pub use apply_commands::{ApplyOutcome, apply_commands};
pub use check::Check;
pub use checks::{
    AVG_LOOP_LENGTH_ESTIMATE_DEFAULT, CROSS_ELEMENT_GEOMETRIC_PROXIMITY_DEFAULT_FLOOR_MODE,
    CROSS_ELEMENT_GEOMETRIC_PROXIMITY_DISTANCE_DEFAULT,
    CROSS_ELEMENT_GRAPH_PROXIMITY_DISTANCE_DEFAULT,
    CROSS_ELEMENT_PROXIMITY_DEFAULT_INCLUDE_ELEVATOR_STOP,
    CROSS_ELEMENT_PROXIMITY_DEFAULT_INCLUDE_FINISH,
    CROSS_ELEMENT_PROXIMITY_DEFAULT_INCLUDE_ONE_WAY, CROSS_ELEMENT_PROXIMITY_DEFAULT_INCLUDE_SPLIT,
    CROSS_ELEMENT_PROXIMITY_DEFAULT_INCLUDE_START,
    CROSS_ELEMENT_PROXIMITY_DEFAULT_INCLUDE_TELEPORT,
    CROSS_ELEMENT_PROXIMITY_DEFAULT_INCLUDE_VERTICAL_PASSAGE, CrossElementGeometricProximityCheck,
    CrossElementGraphProximityCheck, ELEVATOR_SPAN_DEFAULT, ELEVATOR_SPAN_DEFAULT_COMPARISON,
    ELEVATOR_STOP_COUNT_DEFAULT, ELEVATOR_STOP_COUNT_DEFAULT_COMPARISON,
    ELEVATOR_STOP_GROUP_GEOMETRIC_PROXIMITY_DEFAULT_FLOOR_MODE,
    ELEVATOR_STOP_GROUP_GEOMETRIC_PROXIMITY_DISTANCE_DEFAULT,
    ELEVATOR_STOP_GROUP_GRAPH_PROXIMITY_DISTANCE_DEFAULT, ELEVATOR_STOPS_SKIP_DEFAULT,
    ELEVATOR_STOPS_SPAN_DEFAULT, EXTERNAL_ESCAPE_DIVERSITY_DEFAULT, Elevator, ElevatorSpanCheck,
    ElevatorStopCountCheck, ElevatorStopGroupGeometricProximityCheck,
    ElevatorStopGroupGraphProximityCheck, ElevatorStopsSkipCheck, ElevatorStopsSpanCheck,
    ExternalEscapeDiversityCheck, LOOP_DISTANCE_FROM_FINISH_DEFAULT,
    LOOP_DISTANCE_FROM_START_DEFAULT, LOOP_LENGTH_DEFAULT, LOOP_LENGTH_DEFAULT_COMPARISON,
    LoopDistanceFromFinishCheck, LoopDistanceFromStartCheck, LoopLengthCheck,
    MAX_ELEVATOR_COUNT_DEFAULT, MAX_ELEVATOR_DENSITY_DEFAULT, MAX_ELEVATOR_STOP_GAP_DEFAULT,
    MAX_ELEVATOR_STOPS_DEFAULT, MAX_ELEVATOR_STOPS_PER_FLOOR_DEFAULT, MAX_LOOP_DENSITY_DEFAULT,
    MAX_LOOP_DENSITY_DEFAULT_FLOOR_SCOPE, MAX_LOOPS_COUNT_DEFAULT,
    MAX_LOOPS_COUNT_DEFAULT_FLOOR_SCOPE, MAX_ONE_WAY_COUNT_DEFAULT,
    MAX_ONE_WAY_COUNT_DEFAULT_FLOOR_SCOPE, MAX_ONE_WAY_RATIO_DEFAULT,
    MAX_ONE_WAY_RATIO_DEFAULT_FLOOR_SCOPE, MAX_REGION_RATIO_DEFAULT, MAX_REGION_SIZE_DEFAULT,
    MAX_SCC_COUNT_DEFAULT, MAX_SPLIT_COUNT_DEFAULT, MAX_SPLIT_COUNT_DEFAULT_FLOOR_SCOPE,
    MAX_SPLIT_DENSITY_DEFAULT, MAX_SPLIT_DENSITY_DEFAULT_FLOOR_SCOPE,
    MAX_SPLIT_TILE_NODE_COUNT_DEFAULT, MAX_TELEPORT_COUNT_DEFAULT,
    MAX_TELEPORT_COUNT_DEFAULT_DIRECTION, MAX_TELEPORT_COUNT_DEFAULT_FLOOR_KIND,
    MAX_TELEPORT_COUNT_DEFAULT_FLOOR_SCOPE, MAX_TELEPORT_DENSITY_DEFAULT,
    MAX_TELEPORT_DENSITY_DEFAULT_DIRECTION, MAX_TELEPORT_DENSITY_DEFAULT_FLOOR_KIND,
    MAX_TELEPORT_DENSITY_DEFAULT_FLOOR_SCOPE, MAX_VERTICAL_PASSAGE_COUNT_DEFAULT,
    MAX_VERTICAL_PASSAGE_COUNT_DEFAULT_COUNT_INCOMING,
    MAX_VERTICAL_PASSAGE_COUNT_DEFAULT_FLOOR_SCOPE, MAX_VERTICAL_PASSAGE_COUNT_DEFAULT_TYPE,
    MAX_VERTICAL_PASSAGE_RATIO_DEFAULT, MAX_VERTICAL_PASSAGE_RATIO_DEFAULT_COUNT_INCOMING,
    MAX_VERTICAL_PASSAGE_RATIO_DEFAULT_FLOOR_SCOPE, MAX_VERTICAL_PASSAGE_RATIO_DEFAULT_TYPE,
    MIN_ELEVATOR_COUNT_DEFAULT, MIN_ELEVATOR_DENSITY_DEFAULT, MIN_ELEVATOR_HEIGHT_DEFAULT,
    MIN_ELEVATOR_STOP_COUNT_DEFAULT, MIN_ELEVATOR_STOPS_PER_AREA_COUNT_DEFAULT,
    MIN_ELEVATOR_STOPS_PER_AREA_COUNT_DEFAULT_FLOOR_SCOPE,
    MIN_ELEVATOR_STOPS_PER_AREA_DENSITY_DEFAULT,
    MIN_ELEVATOR_STOPS_PER_AREA_DENSITY_DEFAULT_FLOOR_SCOPE, MIN_LOOP_DENSITY_DEFAULT,
    MIN_LOOP_DENSITY_DEFAULT_FLOOR_SCOPE, MIN_LOOPS_COUNT_DEFAULT_FLOOR_SCOPE, MIN_LOOPS_DEFAULT,
    MIN_ONE_WAY_COUNT_DEFAULT, MIN_ONE_WAY_COUNT_DEFAULT_FLOOR_SCOPE, MIN_ONE_WAY_RATIO_DEFAULT,
    MIN_ONE_WAY_RATIO_DEFAULT_FLOOR_SCOPE, MIN_REGION_COUNT_DEFAULT, MIN_REGION_RATIO_DEFAULT,
    MIN_REGION_SIZE_DEFAULT, MIN_TELEPORT_COUNT_DEFAULT, MIN_TELEPORT_COUNT_DEFAULT_FLOOR_SCOPE,
    MIN_TELEPORT_RATIO_DEFAULT, MIN_TELEPORT_RATIO_DEFAULT_FLOOR_SCOPE,
    MIN_VERTICAL_PASSAGE_COUNT_DEFAULT, MIN_VERTICAL_PASSAGE_COUNT_DEFAULT_COUNT_INCOMING,
    MIN_VERTICAL_PASSAGE_COUNT_DEFAULT_FLOOR_SCOPE, MIN_VERTICAL_PASSAGE_COUNT_DEFAULT_TYPE,
    MIN_VERTICAL_PASSAGE_RATIO_DEFAULT, MIN_VERTICAL_PASSAGE_RATIO_DEFAULT_COUNT_INCOMING,
    MIN_VERTICAL_PASSAGE_RATIO_DEFAULT_FLOOR_SCOPE, MIN_VERTICAL_PASSAGE_RATIO_DEFAULT_TYPE,
    MaxElevatorCountCheck, MaxElevatorDensityCheck, MaxElevatorStopGapCheck, MaxElevatorStopsCheck,
    MaxElevatorStopsPerFloorCheck, MaxLoopDensityCheck, MaxLoopsCountCheck, MaxOneWayCountCheck,
    MaxOneWayRatioCheck, MaxRegionRatioCheck, MaxRegionSizeCheck, MaxSplitCountCheck,
    MaxSplitDensityCheck, MaxSplitTileNodeCountCheck, MaxTeleportCountCheck,
    MaxTeleportDensityCheck, MaxVerticalPassageCountCheck, MaxVerticalPassageRatioCheck,
    MinElevatorCountCheck, MinElevatorDensityCheck, MinElevatorHeightCheck,
    MinElevatorStopCountCheck, MinElevatorStopsPerAreaCountCheck,
    MinElevatorStopsPerAreaDensityCheck, MinLoopDensityCheck, MinLoopsCountCheck,
    MinOneWayCountCheck, MinOneWayRatioCheck, MinRegionCountCheck, MinRegionRatioCheck,
    MinRegionSizeCheck, MinTeleportCountCheck, MinTeleportRatioCheck, MinVerticalPassageCountCheck,
    MinVerticalPassageRatioCheck, MissingEndpointsCheck,
    ONE_WAY_GROUP_GEOMETRIC_PROXIMITY_DEFAULT_FLOOR_MODE,
    ONE_WAY_GROUP_GEOMETRIC_PROXIMITY_DISTANCE_DEFAULT,
    ONE_WAY_GROUP_GRAPH_PROXIMITY_DISTANCE_DEFAULT,
    ONE_WAY_GROUP_SUPER_HUB_MAX_CONNECTIONS_DEFAULT, ONE_WAY_WAYPOINT_DISTANCE_DEFAULT,
    ONE_WAY_WAYPOINT_DISTANCE_DEFAULT_COMPARISON, OneWayGroupGeometricProximityCheck,
    OneWayGroupGraphProximityCheck, OneWayGroupSuperHubCheck, OneWayWaypoint,
    OneWayWaypointDistanceCheck, SPLIT_COUNT_DEFAULT, SPLIT_COUNT_DEFAULT_FLOOR_SCOPE,
    SPLIT_DENSITY_DEFAULT, SPLIT_DENSITY_DEFAULT_FLOOR_SCOPE, SPLIT_DISTANCE_FROM_WAYPOINT_DEFAULT,
    SPLIT_DISTANCE_FROM_WAYPOINT_DEFAULT_COMPARISON,
    SPLIT_GROUP_GEOMETRIC_PROXIMITY_DEFAULT_FLOOR_MODE,
    SPLIT_GROUP_GEOMETRIC_PROXIMITY_DISTANCE_DEFAULT, SPLIT_GROUP_GRAPH_PROXIMITY_DISTANCE_DEFAULT,
    SPLIT_NODE_CONNECTION_COUNT_DEFAULT, SPLIT_NODE_CONNECTION_COUNT_DEFAULT_COMPARISON,
    SPLIT_NODE_CONNECTION_PER_FACE_MAX_DEFAULT, SPLIT_NODE_CONNECTION_PER_NEIGHBOR_MAX_DEFAULT,
    SPLIT_NODE_CONNECTION_TRAVERSAL_DISTANCE_MIN_DETOUR_DEFAULT, SccCountCheck, SplitCountCheck,
    SplitDensityCheck, SplitDistanceFromWaypointCheck, SplitGroupGeometricProximityCheck,
    SplitGroupGraphProximityCheck, SplitNodeConnectionCountCheck, SplitNodeConnectionDirection,
    SplitNodeConnectionPerFaceCheck, SplitNodeConnectionPerNeighborCheck,
    SplitNodeConnectionTraversalDistanceCheck, SplitPatternShapeCheck, SplitTeleportDirection,
    SplitTeleportIntersectionCheck, SplitWaypoint, TELEPORT_GEOMETRIC_LENGTH_DEFAULT,
    TELEPORT_GEOMETRIC_LENGTH_DEFAULT_COMPARISON, TELEPORT_GEOMETRIC_LENGTH_DEFAULT_FLOOR_MODE,
    TELEPORT_GRAPH_DISTANCE_DEFAULT, TELEPORT_GRAPH_DISTANCE_DEFAULT_COMPARISON,
    TELEPORT_GROUP_PROXIMITY_DISTANCE_DEFAULT, TELEPORT_SUPER_HUB_MAX_CONNECTIONS_DEFAULT,
    TELEPORT_WAYPOINT_DISTANCE_DEFAULT, TELEPORT_WAYPOINT_DISTANCE_DEFAULT_COMPARISON,
    TeleportDuplicatesConnectionCheck, TeleportEdgeSelector, TeleportGeometricLengthCheck,
    TeleportGraphDistanceCheck, TeleportGroupProximityCheck, TeleportHubEdgeSelector,
    TeleportProximityEdge, TeleportSplitEdgeSelector, TeleportSplitIntersectionCheck,
    TeleportSuperHubAvoidanceCheck, TeleportWaypoint, TeleportWaypointDistanceCheck,
    UnreachableFinishCheck, VERTICAL_PASSAGE_GROUP_GEOMETRIC_PROXIMITY_DEFAULT_COUNT_INCOMING,
    VERTICAL_PASSAGE_GROUP_GEOMETRIC_PROXIMITY_DEFAULT_FLOOR_MODE,
    VERTICAL_PASSAGE_GROUP_GEOMETRIC_PROXIMITY_DEFAULT_TYPE,
    VERTICAL_PASSAGE_GROUP_GEOMETRIC_PROXIMITY_DISTANCE_DEFAULT,
    VERTICAL_PASSAGE_GROUP_GRAPH_PROXIMITY_DEFAULT_COUNT_INCOMING,
    VERTICAL_PASSAGE_GROUP_GRAPH_PROXIMITY_DEFAULT_TYPE,
    VERTICAL_PASSAGE_GROUP_GRAPH_PROXIMITY_DISTANCE_DEFAULT,
    VerticalPassageGroupGeometricProximityCheck, VerticalPassageGroupGraphProximityCheck,
    elevator_groups, elevator_stops_per_floor, stop_floors,
};
pub use cycle_kind::CycleKind;
pub use distance_diagnostics::{DistanceDiagnostics, IndeterminateReason, UndecidedPair};
pub use engine::QualityControlEngine;
pub use event::QcEvent;
pub use floor_group::{floor_point_count, floors_of_edge, floors_of_edges, floors_of_node};
pub use floor_scope::FloorScope;
pub use geometric_floor_mode::GeometricFloorMode;
pub use issue::{
    AREA_MISSING_ELEVATOR_STOPS, CYCLE_ANALYSIS_OVERFLOWED, EXCESSIVE_ELEVATOR_STOP_GAP,
    EXCESSIVE_SCC_COUNT, INDETERMINATE_DISTANCE, INVALID_CROSS_ELEMENT_GROUP, INVALID_ELEVATOR,
    INVALID_ELEVATOR_GROUP, INVALID_ELEVATOR_STOP, INVALID_ELEVATOR_STOP_GROUP, INVALID_LOOP,
    INVALID_LOOP_GROUP, INVALID_ONE_WAY, INVALID_ONE_WAY_GROUP, INVALID_SPLIT_NODE,
    INVALID_SPLIT_NODE_CONNECTION, INVALID_SPLIT_NODE_CONNECTION_GROUP, INVALID_SPLIT_NODE_GROUP,
    INVALID_SPLIT_ROUTE, INVALID_SPLIT_TILE, INVALID_SPLIT_TILE_GROUP, INVALID_TELEPORT,
    INVALID_TELEPORT_GROUP, INVALID_VERTICAL_PASSAGE, INVALID_VERTICAL_PASSAGE_GROUP, Issue,
    IssueKind, IssueKindConst, IssueMerge, IssueMeta, IssueRequirement, MISSING_ELEVATOR_HEIGHT,
    MISSING_ELEVATOR_STOP_COUNT, MISSING_ELEVATORS, MISSING_ENDPOINTS, MISSING_LOOPS,
    MISSING_ONE_WAYS, MISSING_REGIONS, MISSING_SPLIT_TILES, MISSING_TELEPORTS,
    MISSING_VERTICAL_PASSAGES, REGION_NEEDS_EXPANSION, REGION_NEEDS_SHRINK, REPAIR_LIMIT_REACHED,
    UNREACHABLE_FINISH,
};
pub use issue_kinds::{
    AreaMissingElevatorStopsIssue, CrossElementCloseNodes, CrossElementGroupKind,
    CycleAnalysisOverflowedIssue, ElevatorGroupKind, ElevatorNodes, ElevatorStopGroupKind,
    ExcessiveElevatorStopGapIssue, ExcessiveSccCountIssue, IndeterminateDistanceIssue,
    InvalidCrossElementGroupIssue, InvalidElevatorGroupIssue, InvalidElevatorIssue,
    InvalidElevatorStopGroupIssue, InvalidElevatorStopIssue, InvalidGroupIssue,
    InvalidGroupIssueKind, InvalidLoopGroupIssue, InvalidLoopGroupRequirement, InvalidLoopIssue,
    InvalidLoopRequirement, InvalidOneWayGroupIssue, InvalidOneWayIssue,
    InvalidSplitNodeConnectionGroupIssue, InvalidSplitNodeConnectionIssue,
    InvalidSplitNodeGroupIssue, InvalidSplitNodeIssue, InvalidSplitRouteIssue,
    InvalidSplitTileGroupIssue, InvalidSplitTileIssue, InvalidTeleportGroupIssue,
    InvalidTeleportIssue, InvalidVerticalPassageGroupIssue, InvalidVerticalPassageIssue,
    MissingElevatorHeightIssue, MissingElevatorStopCountIssue, MissingElevatorsIssue,
    MissingEndpointsIssue, MissingLoopsIssue, MissingOneWaysIssue, MissingRegionsIssue,
    MissingSplitTilesIssue, MissingTeleportsIssue, MissingVerticalPassagesIssue, OneWayGroupKind,
    RegionNeedsExpansionIssue, RegionNeedsShrinkIssue, RepairLimitKind, RepairLimitReachedIssue,
    SplitGroupKind, SplitNodeConnectionGroupKind, SplitNodeGroupKind, SplitRouteEdge,
    SplitTileNodes, TeleportGroupKind, UnreachableFinishIssue, VerticalPassageGroupKind,
};
pub use issue_payload::{
    CrossElementPayloadEntry, IssueEdgeGroupPayload, IssueMissingElevatorStopsPayload,
    IssuePayload, IssueRegionPayload, IssueRouteEdge, IssueRoutePayload, IssueSplitGroupPayload,
    IssueSplitTilePayload, IssueUndecidedPairPayload, resolve_issue_payload,
};
pub use repair_area::RepairArea;
pub use rule::{Rule, RuleIterationOutcome, RuleTrait};
pub use rule_params::{
    PARAM_APPROXIMATE_TOPOLOGY, PARAM_PROTECT_ROUTE, PARAM_SPLIT_PATTERNS,
    PARAM_VERTICAL_PASSAGE_TYPE, RULE_PARAM_DESCRIPTORS, RuleParamDescriptor, RuleParamKind,
    RuleParams, rule_param_applies_to,
};
pub use stage::Stage;
pub use teleport_direction_filter::TeleportDirectionFilter;
pub use teleport_floor_kind_filter::TeleportFloorKindFilter;
pub use vertical_passage_type::VerticalPassageType;
