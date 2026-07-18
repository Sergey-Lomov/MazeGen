pub mod issue;
pub mod issue_kinds;
pub mod issue_payload;
pub mod event;
pub mod check;
pub mod comparison;
pub mod rule;
pub mod stage;
pub mod engine;
pub mod checks;

pub use issue::{Issue, IssueKindConst, IssueMerge, IssueRequirement, IssueMeta, IssueKind, MISSING_ENDPOINTS, UNREACHABLE_FINISH, INVALID_LOOP, INVALID_LOOP_GROUP, MISSING_LOOPS, CYCLE_ANALYSIS_OVERFLOWED, REPAIR_LIMIT_REACHED, EXCESSIVE_SCC_COUNT, REGION_NEEDS_EXPANSION, REGION_NEEDS_SHRINK, MISSING_REGIONS, INVALID_TELEPORT, TELEPORT_GROUP_PROXIMITY};
pub use issue_payload::{IssuePayload, resolve_issue_payload};
pub use event::QcEvent;
pub use issue_kinds::{
    MissingEndpointsIssue, UnreachableFinishIssue, InvalidLoopIssue, InvalidLoopRequirement, MissingLoopsIssue,
    InvalidLoopGroupIssue, InvalidLoopGroupRequirement,
    CycleAnalysisOverflowedIssue, RepairLimitReachedIssue, RepairLimitKind,
    ExcessiveSccCountIssue, RegionNeedsExpansionIssue, RegionNeedsShrinkIssue, MissingRegionsIssue, InvalidTeleportIssue,
    TeleportGroupProximityIssue,
};
pub use check::Check;
pub use comparison::Comparison;
pub use rule::{Rule, RuleTrait, ApplyOutcome, RuleIterationOutcome};
pub use stage::Stage;
pub use engine::QualityControlEngine;
pub use checks::{
    MissingEndpointsCheck,
    UnreachableFinishCheck,
    MinLoopsCountCheck, MIN_LOOPS_DEFAULT,
    MinLoopDensityCheck, MIN_LOOP_DENSITY_DEFAULT, AVG_LOOP_LENGTH_ESTIMATE_DEFAULT,
    LoopLengthCheck, LOOP_LENGTH_DEFAULT, LOOP_LENGTH_DEFAULT_COMPARISON,
    ExternalEscapeDiversityCheck, EXTERNAL_ESCAPE_DIVERSITY_DEFAULT,
    LoopDistanceFromStartCheck, LOOP_DISTANCE_FROM_START_DEFAULT,
    LoopDistanceFromFinishCheck, LOOP_DISTANCE_FROM_FINISH_DEFAULT,
    MaxLoopDensityCheck, MAX_LOOP_DENSITY_DEFAULT,
    SccCountCheck, MAX_SCC_COUNT_DEFAULT,
    MinRegionSizeCheck, MIN_REGION_SIZE_DEFAULT,
    MinRegionRatioCheck, MIN_REGION_RATIO_DEFAULT,
    MaxRegionSizeCheck, MAX_REGION_SIZE_DEFAULT,
    MaxRegionRatioCheck, MAX_REGION_RATIO_DEFAULT,
    MinRegionCountCheck, MIN_REGION_COUNT_DEFAULT,
    TeleportDuplicatesConnectionCheck,
    TeleportWaypointDistanceCheck, TeleportWaypoint, TeleportEdgeSelector, TELEPORT_WAYPOINT_DISTANCE_DEFAULT, TELEPORT_WAYPOINT_DISTANCE_DEFAULT_COMPARISON,
    TeleportGeometricLengthCheck, TELEPORT_GEOMETRIC_LENGTH_DEFAULT, TELEPORT_GEOMETRIC_LENGTH_DEFAULT_COMPARISON,
    TeleportSuperHubAvoidanceCheck, TeleportHubEdgeSelector, TELEPORT_SUPER_HUB_MAX_CONNECTIONS_DEFAULT,
    TeleportGroupProximityCheck, TeleportProximityEdge, TELEPORT_GROUP_PROXIMITY_DISTANCE_DEFAULT,
};
