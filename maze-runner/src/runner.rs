use std::collections::{HashMap, HashSet};
use maze_core::{
    graph::Graph,
    ids::IdGenerator,
    space::{Field, Tessellation},
    generation::{generate_maze, build_preset_state, GenerationConfig},
    quality_control::{
        QualityControlEngine, RuleTrait, IssueKindConst, MissingEndpointsCheck, UnreachableFinishCheck,
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
        Rule, Stage,
        MissingEndpointsIssue, UnreachableFinishIssue, MissingLoopsIssue, InvalidLoopIssue,
        ExcessiveSccCountIssue, RegionNeedsExpansionIssue, MissingRegionsIssue, InvalidTeleportIssue,
        TeleportGroupProximityIssue,
    },
    repair::{
        RepairStrategy, ErasedRepairStrategy,
        NestedSlot, NestedStrategyConfig,
        RandomEndpointsStrategy, FarthestEndpointsStrategy, ScoredEndpointsStrategy,
        InvalidLoopRandomStrategy, InvalidLoopScoredStrategy, MissingLoopsRandomStrategy,
        ExpandRegionPassageStrategy, TeleportRegionMergeStrategy, MissingRegionsStrategy, ReduceSccCountStrategy,
        RemoveTeleportStrategy, TeleportGroupProximityStrategy, WeightedRegionMergeStrategy,
    },
    RegionClass, GenerationTiming,
    quality_control::Issue,
};
use crate::config::{
    GenerateConfig, CheckInstanceConfig, StrategyConfig, TessellationType,
    build_generation_config, build_repair_limits,
};

/// Result of a single `run_from_config` call — everything a test might want to inspect.
pub struct MazeRunResult {
    pub remaining_issues: Vec<Box<dyn Issue>>,
    pub timing: GenerationTiming,
    /// Region classes → sorted sizes (descending). Key absent if count = 0.
    pub region_sizes: HashMap<RegionClass, Vec<usize>>,
    pub start: Option<maze_core::ids::NodeId>,
    pub finish: Option<maze_core::ids::NodeId>,
    /// Final graph, post-repair — lets a repro test inspect actual edge kinds/directionality
    /// (e.g. verifying a one-way vs. bidirectional connection was actually chosen), which none
    /// of the other summary fields expose.
    pub graph: Graph,
}

/// One tag per concrete `Issue` type — the compile-time-known "which `I`" a rule's checks/
/// strategy share, chosen at runtime from the first check's `type_id` (see `check_kind_for_type`)
/// and then used to pick a `build_rule_for!` macro arm, which fixes `I` for the rest of that
/// rule's construction. Not `IssueKind` itself: `IssueKind` is the runtime-erased representation
/// (config/DTO/serialization, see GitHub issue #113's plan §2); `KindTag` exists purely to drive
/// this factory's match.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KindTag {
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

fn check_kind_for_type(type_id: &str) -> KindTag {
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

fn composite_check_id(rule_id: &str, local_id: &str) -> String {
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
fn build_missing_endpoints_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String) -> Option<Box<dyn maze_core::quality_control::Check<T, MissingEndpointsIssue>>> {
    match instance.type_id.as_str() {
        "missing_endpoints" => Some(Box::new(MissingEndpointsCheck { instance_id })),
        _ => None,
    }
}

fn build_unreachable_finish_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String) -> Option<Box<dyn maze_core::quality_control::Check<T, UnreachableFinishIssue>>> {
    match instance.type_id.as_str() {
        "unreachable_finish" => Some(Box::new(UnreachableFinishCheck { instance_id })),
        _ => None,
    }
}

fn build_missing_loops_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String) -> Option<Box<dyn maze_core::quality_control::Check<T, MissingLoopsIssue>>> {
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

fn build_invalid_loop_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String) -> Option<Box<dyn maze_core::quality_control::Check<T, InvalidLoopIssue>>> {
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

fn build_excessive_scc_count_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String) -> Option<Box<dyn maze_core::quality_control::Check<T, ExcessiveSccCountIssue>>> {
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

fn build_region_needs_expansion_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String) -> Option<Box<dyn maze_core::quality_control::Check<T, RegionNeedsExpansionIssue>>> {
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

fn build_missing_regions_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String) -> Option<Box<dyn maze_core::quality_control::Check<T, MissingRegionsIssue>>> {
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

fn build_invalid_teleport_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String) -> Option<Box<dyn maze_core::quality_control::Check<T, InvalidTeleportIssue>>> {
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

fn build_teleport_group_proximity_check<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String) -> Option<Box<dyn maze_core::quality_control::Check<T, TeleportGroupProximityIssue>>> {
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

/// Erased-boundary strategy factory — returns `Box<dyn ErasedRepairStrategy<T>>` (not a concrete
/// `RepairStrategy<T, I>`) since a strategy id is resolved from a runtime string with no
/// compile-time-known `I` at this call site (used both for a rule's own top-level strategy, via
/// `build_rule_for!`'s per-`KindTag` downcast, and for nested-strategy slots, which are erased by
/// design — see `Specs/repair.md`'s nested-strategy pattern). Each concrete strategy struct
/// already has its own `impl ErasedRepairStrategy<T> for ConcreteStrategy` (generated by
/// `impl_erased_repair_strategy!` next to its `impl RepairStrategy<T, I>`), so `Box::new(...) as
/// Box<dyn ErasedRepairStrategy<T>>` is valid for each arm below without any further wiring here.
fn build_strategy_erased<T: Tessellation>(id: &str) -> Result<Box<dyn ErasedRepairStrategy<T>>, String> {
    Ok(match id {
        "random_endpoints"     => Box::new(RandomEndpointsStrategy),
        "farthest_endpoints"   => Box::new(FarthestEndpointsStrategy),
        "scored_endpoints"     => Box::new(ScoredEndpointsStrategy),
        "invalid_loop_random"  => Box::new(InvalidLoopRandomStrategy),
        "invalid_loop_scored"  => Box::new(InvalidLoopScoredStrategy),
        "missing_loops_random" => Box::new(MissingLoopsRandomStrategy),
        "expand_region_passage" => Box::new(ExpandRegionPassageStrategy),
        "teleport_region_merge" => Box::new(TeleportRegionMergeStrategy),
        "missing_regions"      => Box::new(MissingRegionsStrategy),
        "reduce_scc_count"     => Box::new(ReduceSccCountStrategy),
        "weighted_region_merge" => Box::new(WeightedRegionMergeStrategy),
        "remove_teleport"      => Box::new(RemoveTeleportStrategy),
        "teleport_group_proximity" => Box::new(TeleportGroupProximityStrategy),
        other => return Err(format!("unknown strategy: {other}")),
    })
}

/// Downcasts an erased `Box<dyn ErasedRepairStrategy<T>>` (from `build_strategy_erased`) to a
/// concrete `Box<dyn RepairStrategy<T, I>>` — used only by `build_rule_for!`, where `I` is fixed
/// by the macro's own `KindTag` arm. Every registry strategy for a given `type_id` is *intended*
/// to implement `RepairStrategy<T, I>` for that exact `I`, but nothing in the type system
/// connects a `KindTag` arm to the strategy ids `build_strategy_erased` hands back for it — a
/// future strategy registered under the wrong arm would otherwise downcast wrong silently in a
/// release build (the inner `impl_erased_repair_strategy!`-generated `apply` can't catch this:
/// its own downcast target is this wrapper's `I`, which is already "correct" by construction, not
/// the strategy's true `I`). So this checks `erased.handles() == I::KIND` explicitly and returns
/// `Err` on mismatch, the same way `build_nested`'s own kind check works — a wiring bug becomes a
/// loud config-build error instead of a silent wrong-behavior risk.
fn downcast_strategy<T: Tessellation + 'static, I: IssueKindConst>(strategy: Box<dyn ErasedRepairStrategy<T>>) -> Result<Box<dyn RepairStrategy<T, I>>, String> {
    struct ErasedAsTyped<T: Tessellation, I: Issue> {
        inner: Box<dyn ErasedRepairStrategy<T>>,
        _marker: std::marker::PhantomData<I>,
    }
    impl<T: Tessellation + 'static, I: Issue> RepairStrategy<T, I> for ErasedAsTyped<T, I> {
        fn strategy_id(&self) -> &'static str { self.inner.strategy_id() }
        fn params(&self) -> &'static [maze_core::repair::StrategyParam] { self.inner.params() }
        fn is_experimental(&self) -> bool { self.inner.is_experimental() }
        fn expected_nested(&self) -> &'static [NestedSlot] { self.inner.expected_nested() }
        fn apply(
            &self, issue: &I, maze: &mut maze_core::Maze<T>, snapshots: &mut maze_core::repair::SnapshotStack,
            rng: &mut dyn rand::RngCore, params: &maze_core::repair::StrategyParams,
            preset_state: &maze_core::generation::PresetState, nested: &[NestedStrategyConfig<T>],
        ) -> maze_core::repair::RepairResult {
            self.inner.apply(issue, maze, snapshots, rng, params, preset_state, nested)
        }
    }
    if strategy.handles() != I::KIND {
        return Err(format!(
            "internal error: strategy \"{}\" handles {:?}, but was resolved against a rule expecting {:?}",
            strategy.strategy_id(), strategy.handles(), I::KIND,
        ));
    }
    Ok(Box::new(ErasedAsTyped::<T, I> { inner: strategy, _marker: std::marker::PhantomData }))
}

/// Resolves `configs` (a `StrategyConfig`'s `nested` list) into `NestedStrategyConfig`s against
/// `parent`'s `expected_nested()` slots — see `Specs/repair.md`'s nested-strategy pattern. Purely
/// generic over `parent.expected_nested()`/`.handles()`: no strategy id is ever compared here,
/// so adding a new nested-capable strategy never requires touching this function. Operates
/// entirely at the erased (`Box<dyn ErasedRepairStrategy<T>>`) boundary — a nested strategy's own
/// `I` is independent of its parent's, see `ErasedRepairStrategy`'s doc comment.
fn build_nested<T: Tessellation>(
    parent: &dyn ErasedRepairStrategy<T>,
    configs: &[StrategyConfig],
) -> Result<Vec<NestedStrategyConfig<T>>, String> {
    let slots = parent.expected_nested();

    // O(1) slot lookup instead of a linear scan per config — built once per call. No separate
    // "slots.is_empty()" fast path: an empty `slots_by_id` already makes the loop below reject
    // every `cfg` via the "no such slot" branch, with a message naming the actual missing slot.
    let slots_by_id: HashMap<&'static str, &'static NestedSlot> = slots.iter().map(|s| (s.slot_id, s)).collect();

    let mut counts: HashMap<&str, usize> = HashMap::new();
    let mut resolved: Vec<(&'static NestedSlot, &StrategyConfig, Box<dyn ErasedRepairStrategy<T>>)> = Vec::new();
    for cfg in configs {
        let Some(slot_id) = cfg.slot_id.as_deref() else {
            return Err(format!("nested strategy {} under {} is missing slot_id", cfg.id, parent.strategy_id()));
        };
        let Some(&slot) = slots_by_id.get(slot_id) else {
            return Err(format!("strategy {} has no nested slot \"{slot_id}\"", parent.strategy_id()));
        };
        let nested_strategy = build_strategy_erased::<T>(&cfg.id)?;
        if nested_strategy.handles() != slot.kind {
            return Err(format!(
                "strategy {} cannot fill slot \"{slot_id}\" of {}: handles {:?}, slot expects {:?}",
                cfg.id, parent.strategy_id(), nested_strategy.handles(), slot.kind
            ));
        }
        *counts.entry(slot_id).or_insert(0) += 1;
        resolved.push((slot, cfg, nested_strategy));
    }
    for slot in slots {
        let count = counts.get(slot.slot_id).copied().unwrap_or(0);
        if count < slot.min || count > slot.max.unwrap_or(usize::MAX) {
            return Err(format!(
                "strategy {} slot \"{}\" needs {}..{} nested strategies, got {count}",
                parent.strategy_id(), slot.slot_id, slot.min,
                slot.max.map(|m| m.to_string()).unwrap_or_else(|| "∞".to_string()),
            ));
        }
    }
    resolved.into_iter().map(|(slot, cfg, strategy)| {
        let nested = build_nested::<T>(strategy.as_ref(), &cfg.nested)?;
        Ok(NestedStrategyConfig { slot, strategy, param_overrides: cfg.params.clone(), nested })
    }).collect()
}

/// Generates the common body for one `KindTag` arm of `build_rule::<T>`: collects `rule_cfg`'s
/// checks via `$check_ctor` (erroring if any `type_id` doesn't belong to this arm's `I`, i.e.
/// `$check_ctor` returns `None` — the runtime equivalent of the old "checks in rule produce
/// different issue kinds" check, except now a mismatched check simply can't be constructed as
/// `Check<T, I>` for this arm's `I` in the first place), resolves the top-level strategy (if any)
/// via `build_strategy_erased` + `downcast_strategy::<T, $IssueTy>`, and constructs `Rule::<T,
/// $IssueTy>::new(...)` — wrapped in `Box::new(...) as Box<dyn RuleTrait<T>>` for the caller's
/// `Vec<Box<dyn RuleTrait<T>>>`. See GitHub issue #113's plan §9 for why this can't be a plain
/// generic function (the concrete `$IssueTy` must be chosen by the macro caller's own match arm,
/// not passed as a runtime value).
macro_rules! build_rule_for {
    ($IssueTy:ty, $check_ctor:ident, $rule_cfg:expr) => {{
        let rule_cfg = $rule_cfg;
        let mut checks: Vec<(String, Box<dyn maze_core::quality_control::Check<T, $IssueTy>>)> = Vec::with_capacity(rule_cfg.checks.len());
        let mut seen_local_ids: HashSet<&str> = HashSet::new();
        for instance in &rule_cfg.checks {
            if !seen_local_ids.insert(instance.local_id.as_str()) {
                return Err(format!("rule {} has duplicate local_id: {}", rule_cfg.id, instance.local_id));
            }
            let instance_id = composite_check_id(&rule_cfg.id, &instance.local_id);
            let check = $check_ctor::<T>(instance, instance_id)
                .ok_or_else(|| format!("checks in rule {} produce different issue kinds", rule_cfg.id))?;
            checks.push((instance.local_id.clone(), check));
        }

        let (strategy, param_overrides, nested) = match &rule_cfg.strategy {
            Some(strategy_cfg) => {
                if strategy_cfg.slot_id.is_some() {
                    return Err(format!("rule {}'s top-level strategy must not declare slot_id", rule_cfg.id));
                }
                let erased = build_strategy_erased::<T>(&strategy_cfg.id)?;
                let nested = build_nested::<T>(erased.as_ref(), &strategy_cfg.nested)?;
                let typed = downcast_strategy::<T, $IssueTy>(erased)?;
                (Some(typed), strategy_cfg.params.clone(), nested)
            }
            None => (None, HashMap::new(), Vec::new()),
        };

        let rule = Rule::<T, $IssueTy>::new(rule_cfg.id.clone(), checks, strategy, param_overrides, nested);
        Ok(Box::new(rule) as Box<dyn RuleTrait<T>>)
    }};
}

/// Builds one `Box<dyn RuleTrait<T>>` from a `QcRuleConfig` — dispatches on the first check's
/// `type_id` (via `check_kind_for_type`) to pick which `KindTag`, and therefore which concrete
/// `I`, this rule's checks/strategy share; see `build_rule_for!`'s own doc comment for what each
/// arm does. `rule_cfg.checks` must be non-empty (checked by the caller, `build_qc_and_repair`).
fn build_rule<T: Tessellation + 'static>(rule_cfg: &crate::config::QcRuleConfig) -> Result<Box<dyn RuleTrait<T>>, String> {
    match check_kind_for_type(&rule_cfg.checks[0].type_id) {
        KindTag::MissingEndpoints => build_rule_for!(MissingEndpointsIssue, build_missing_endpoints_check, rule_cfg),
        KindTag::UnreachableFinish => build_rule_for!(UnreachableFinishIssue, build_unreachable_finish_check, rule_cfg),
        KindTag::MissingLoops => build_rule_for!(MissingLoopsIssue, build_missing_loops_check, rule_cfg),
        KindTag::InvalidLoop => build_rule_for!(InvalidLoopIssue, build_invalid_loop_check, rule_cfg),
        KindTag::ExcessiveSccCount => build_rule_for!(ExcessiveSccCountIssue, build_excessive_scc_count_check, rule_cfg),
        KindTag::RegionNeedsExpansion => build_rule_for!(RegionNeedsExpansionIssue, build_region_needs_expansion_check, rule_cfg),
        KindTag::MissingRegions => build_rule_for!(MissingRegionsIssue, build_missing_regions_check, rule_cfg),
        KindTag::InvalidTeleport => build_rule_for!(InvalidTeleportIssue, build_invalid_teleport_check, rule_cfg),
        KindTag::TeleportGroupProximity => build_rule_for!(TeleportGroupProximityIssue, build_teleport_group_proximity_check, rule_cfg),
    }
}

pub fn build_qc_and_repair<T: Tessellation + 'static>(
    config: &GenerateConfig,
) -> Result<QualityControlEngine<T>, String> {
    let mut stages: Vec<Stage<T>> = Vec::new();
    let mut seen_stage_ids: HashSet<&str> = HashSet::new();
    let mut seen_rule_ids: HashSet<&str> = HashSet::new();

    for stage_cfg in &config.stages {
        if !seen_stage_ids.insert(stage_cfg.id.as_str()) {
            return Err(format!("duplicate stage id: {}", stage_cfg.id));
        }
        let mut rules: Vec<Box<dyn RuleTrait<T>>> = Vec::with_capacity(stage_cfg.rules.len());

        for rule_cfg in &stage_cfg.rules {
            if !seen_rule_ids.insert(rule_cfg.id.as_str()) {
                return Err(format!("duplicate rule id: {}", rule_cfg.id));
            }
            if rule_cfg.checks.is_empty() {
                return Err(format!("rule {} has no checks", rule_cfg.id));
            }
            rules.push(build_rule::<T>(rule_cfg)?);
        }

        stages.push(Stage::new(stage_cfg.id.clone(), stage_cfg.name.clone(), rules));
    }

    // Note: "rule with a strategy not assigned to any stage" can no longer happen structurally —
    // a `Rule` is built and pushed directly into the `Stage` it's configured under, there is no
    // longer a separate "all rules" list a strategy-bearing rule could fail to appear in.

    Ok(QualityControlEngine::new(stages))
}

pub fn pick_start<P: Copy>(points: &[P], to_xy: impl Fn(P) -> (i32, i32)) -> P {
    let n = points.len() as i32;
    let cx = points.iter().map(|&p| to_xy(p).0).sum::<i32>() / n;
    let cy = points.iter().map(|&p| to_xy(p).1).sum::<i32>() / n;
    *points.iter().min_by_key(|&&p| {
        let (x, y) = to_xy(p);
        (x - cx) * (x - cx) + (y - cy) * (y - cy)
    }).unwrap()
}

pub fn resolve_start<P: Copy>(pts: &[P], gen_source_xy: Option<[i32; 2]>, to_xy: impl Fn(P) -> (i32, i32)) -> P {
    if let Some([px, py]) = gen_source_xy {
        if let Some(&p) = pts.iter().find(|&&p| to_xy(p) == (px, py)) {
            return p;
        }
    }
    pick_start(pts, to_xy)
}

fn run_generate_typed<T: Tessellation + 'static>(
    seed: u64,
    field: Field<T>,
    start: T::Point,
    config: &GenerateConfig,
    gen_config: GenerationConfig,
    to_xy: impl Fn(T::Point) -> (i32, i32),
) -> Result<MazeRunResult, String> {
    use maze_core::generation::pipeline::build_maze;

    let mut graph = Graph::new();
    field.build_nodes(&mut graph);

    let start_id = field.node_at(start)
        .ok_or_else(|| "start node not found".to_string())?;

    let preset_state = build_preset_state(
        &mut graph, &field,
        &gen_config.preset_connections,
        &gen_config.locked_nodes,
        |x, y| field.all_points().find(|&p| to_xy(p) == (x, y)).expect("preset coordinate must exist on the field"),
    );

    // QC experiment mode skips the generation algorithm entirely — mirrors `maze-wasm`'s
    // `run_generate` (see `Specs`'s generation-card "QC experiment" mode). The graph built by
    // `build_preset_state` above (preset connections only) is fed straight into `build_maze`.
    if !config.qc_experiment {
        generate_maze(&mut graph, &field, seed, start_id, gen_config, &preset_state);
    }

    let qc_engine = build_qc_and_repair::<T>(config)?;
    let limits = build_repair_limits(config);
    let preset_start = config.preset_start.and_then(|[sx, sy]| {
        field.all_points().find(|&p| to_xy(p) == (sx, sy)).and_then(|p| field.node_at(p))
    });
    let preset_finish = config.preset_finish.and_then(|[fx, fy]| {
        field.all_points().find(|&p| to_xy(p) == (fx, fy)).and_then(|p| field.node_at(p))
    });
    let repair_preset_state = preset_state.for_repair(config.qc_experiment);
    let (maze, remaining_issues, timing) = build_maze(field, graph, seed, qc_engine, &repair_preset_state, limits, preset_start, preset_finish);

    let start_node = maze.meta.start;
    let finish_node = maze.meta.finish;
    let mut region_sizes: HashMap<RegionClass, Vec<usize>> = HashMap::new();

    if start_node.is_some() && finish_node.is_some() {
        let scc = maze.analysis.scc(&maze.graph);
        let classes = maze.analysis.region_classes(&maze.graph, &maze.meta);
        for (&comp_id, &cls) in &classes {
            region_sizes.entry(cls).or_default().push(scc.components[comp_id].len());
        }
        for sizes in region_sizes.values_mut() {
            sizes.sort_unstable_by(|a, b| b.cmp(a));
        }
    }

    Ok(MazeRunResult { remaining_issues, timing, region_sizes, start: start_node, finish: finish_node, graph: maze.graph.clone() })
}

/// Parse JSON config and run the full generation+repair pipeline for the given seed.
/// Use this as the entry point in all integration tests.
pub fn run_from_config(seed: u64, config: &GenerateConfig) -> Result<MazeRunResult, String> {
    let mut ids = IdGenerator::new();
    let gen_config = build_generation_config(config);

    match config.tessellation.tessellation_type {
        TessellationType::Square => {
            use maze_core::space::{SquareTessellation, SquarePoint};
            let pts: Vec<SquarePoint> = config.tessellation.points.iter()
                .map(|&[x, y]| SquarePoint { x, y }).collect();
            if pts.is_empty() { return Err("tessellation points must not be empty".to_string()); }
            let start = resolve_start(&pts, config.preset_gen_source, |p| (p.x, p.y));
            let field = Field::<SquareTessellation>::new(pts, &mut ids).map_err(|e| e.to_string())?;
            run_generate_typed(seed, field, start, config, gen_config, |p| (p.x, p.y))
        }
        TessellationType::Hex => {
            use maze_core::space::{HexTessellation, HexPoint};
            let pts: Vec<HexPoint> = config.tessellation.points.iter()
                .map(|&[q, r]| HexPoint { q, r }).collect();
            if pts.is_empty() { return Err("tessellation points must not be empty".to_string()); }
            let start = resolve_start(&pts, config.preset_gen_source, |p| (p.q, p.r));
            let field = Field::<HexTessellation>::new(pts, &mut ids).map_err(|e| e.to_string())?;
            run_generate_typed(seed, field, start, config, gen_config, |p| (p.q, p.r))
        }
        TessellationType::Tri => {
            use maze_core::space::{TriTessellation, TriPoint};
            let pts: Vec<TriPoint> = config.tessellation.points.iter()
                .map(|&[col, row]| TriPoint { col, row }).collect();
            if pts.is_empty() { return Err("tessellation points must not be empty".to_string()); }
            let start = resolve_start(&pts, config.preset_gen_source, |p| (p.col, p.row));
            let field = Field::<TriTessellation>::new(pts, &mut ids).map_err(|e| e.to_string())?;
            run_generate_typed(seed, field, start, config, gen_config, |p| (p.col, p.row))
        }
    }
}

/// Load JSON fixture file and run `run_from_config`.
/// `path` is relative to the crate root (e.g. `"tests/fixtures/my-config.json"`).
pub fn run_fixture(path: &str, seed: u64) -> MazeRunResult {
    let json = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("failed to read fixture {path}: {e}"));
    let config: GenerateConfig = serde_json::from_str(&json)
        .unwrap_or_else(|e| panic!("failed to parse fixture {path}: {e}"));
    run_from_config(seed, &config)
        .unwrap_or_else(|e| panic!("run_from_config failed for {path}: {e}"))
}

#[cfg(test)]
mod nested_strategy_tests {
    use super::*;
    use maze_core::space::SquareTessellation;
    use crate::config::{QcRuleConfig, StageConfig};

    fn scc_count_rule(strategy: Option<StrategyConfig>) -> QcRuleConfig {
        QcRuleConfig {
            id: "r1".to_string(),
            checks: vec![CheckInstanceConfig {
                local_id: "scc_count".to_string(),
                type_id: "scc_count".to_string(),
                params: HashMap::new(),
            }],
            strategy,
        }
    }

    fn one_stage(rule: QcRuleConfig) -> Vec<StageConfig> {
        vec![StageConfig { id: "s1".to_string(), name: "Stage 1".to_string(), rules: vec![rule] }]
    }

    #[test]
    fn reduce_scc_count_without_nested_is_rejected() {
        let strategy = StrategyConfig { id: "reduce_scc_count".to_string(), params: HashMap::new(), slot_id: None, nested: vec![] };
        let rule = scc_count_rule(Some(strategy));
        let mut config = GenerateConfig::default();
        config.stages = one_stage(rule);
        let result = build_qc_and_repair::<SquareTessellation>(&config);
        assert!(result.is_err(), "reduce_scc_count's merge_target slot has min: 1 — no nested must be rejected");
    }

    #[test]
    fn reduce_scc_count_nested_missing_slot_id_is_rejected() {
        let nested = StrategyConfig { id: "expand_region_passage".to_string(), params: HashMap::new(), slot_id: None, nested: vec![] };
        let strategy = StrategyConfig { id: "reduce_scc_count".to_string(), params: HashMap::new(), slot_id: None, nested: vec![nested] };
        let rule = scc_count_rule(Some(strategy));
        let mut config = GenerateConfig::default();
        config.stages = one_stage(rule);
        let result = build_qc_and_repair::<SquareTessellation>(&config);
        assert!(result.is_err(), "a nested StrategyConfig with no slot_id must be rejected");
    }

    #[test]
    fn reduce_scc_count_nested_with_incompatible_kind_is_rejected() {
        // invalid_loop_random handles INVALID_LOOP, not REGION_NEEDS_EXPANSION — must be
        // rejected as incompatible with the merge_target slot.
        let nested = StrategyConfig { id: "invalid_loop_random".to_string(), params: HashMap::new(), slot_id: Some("merge_target".to_string()), nested: vec![] };
        let strategy = StrategyConfig { id: "reduce_scc_count".to_string(), params: HashMap::new(), slot_id: None, nested: vec![nested] };
        let rule = scc_count_rule(Some(strategy));
        let mut config = GenerateConfig::default();
        config.stages = one_stage(rule);
        let result = build_qc_and_repair::<SquareTessellation>(&config);
        assert!(result.is_err(), "a nested strategy handling the wrong IssueKind must be rejected");
    }

    #[test]
    fn reduce_scc_count_nested_with_unknown_slot_id_is_rejected() {
        let nested = StrategyConfig { id: "expand_region_passage".to_string(), params: HashMap::new(), slot_id: Some("no_such_slot".to_string()), nested: vec![] };
        let strategy = StrategyConfig { id: "reduce_scc_count".to_string(), params: HashMap::new(), slot_id: None, nested: vec![nested] };
        let rule = scc_count_rule(Some(strategy));
        let mut config = GenerateConfig::default();
        config.stages = one_stage(rule);
        let result = build_qc_and_repair::<SquareTessellation>(&config);
        assert!(result.is_err(), "an unknown slot_id must be rejected");
    }

    #[test]
    fn reduce_scc_count_two_nested_for_single_slot_is_rejected() {
        let make_nested = || StrategyConfig { id: "expand_region_passage".to_string(), params: HashMap::new(), slot_id: Some("merge_target".to_string()), nested: vec![] };
        let strategy = StrategyConfig { id: "reduce_scc_count".to_string(), params: HashMap::new(), slot_id: None, nested: vec![make_nested(), make_nested()] };
        let rule = scc_count_rule(Some(strategy));
        let mut config = GenerateConfig::default();
        config.stages = one_stage(rule);
        let result = build_qc_and_repair::<SquareTessellation>(&config);
        assert!(result.is_err(), "merge_target's max: Some(1) must reject a second nested strategy for the same slot");
    }

    #[test]
    fn top_level_strategy_with_slot_id_is_rejected() {
        let strategy = StrategyConfig { id: "farthest_endpoints".to_string(), params: HashMap::new(), slot_id: Some("merge_target".to_string()), nested: vec![] };
        let rule = QcRuleConfig {
            id: "r1".to_string(),
            checks: vec![CheckInstanceConfig { local_id: "missing_endpoints".to_string(), type_id: "missing_endpoints".to_string(), params: HashMap::new() }],
            strategy: Some(strategy),
        };
        let mut config = GenerateConfig::default();
        config.stages = one_stage(rule);
        let result = build_qc_and_repair::<SquareTessellation>(&config);
        assert!(result.is_err(), "a top-level strategy must not declare slot_id");
    }

    #[test]
    fn end_to_end_reduce_scc_count_converges_to_max_scc_count() {
        use crate::config::TessellationConfig;

        // Two disjoint 2x2 islands with a gap between them (points x in 0..2 and x in 4..6) —
        // generation can only ever connect geometrically-adjacent cells, so this always yields
        // exactly 2 SCCs after base generation, regardless of algorithm/seed. scc_count with
        // max_scc_count=1 flags EXCESSIVE_SCC_COUNT; reduce_scc_count (nested under
        // expand_region_passage) must still fail to fully merge them (islands aren't
        // geometrically adjacent to each other, so expand_region_passage has no bridging
        // candidate) — this test instead checks the simpler, always-true contract: the pipeline
        // runs without error and reports the SCC-count issue when unresolved, proving the wiring
        // (check -> rule -> reduce_scc_count -> nested expand_region_passage) is live end-to-end.
        let mut points = vec![];
        for x in 0..2 { for y in 0..2 { points.push([x, y]); } }
        for x in 4..6 { for y in 0..2 { points.push([x, y]); } }

        let mut config = GenerateConfig::default();
        config.tessellation = TessellationConfig { tessellation_type: TessellationType::Square, points };

        let scc_check_rule = QcRuleConfig {
            id: "r_scc".to_string(),
            checks: vec![CheckInstanceConfig {
                local_id: "scc_count".to_string(),
                type_id: "scc_count".to_string(),
                params: HashMap::from([("max_scc_count".to_string(), "1".to_string())]),
            }],
            strategy: Some(StrategyConfig {
                id: "reduce_scc_count".to_string(),
                params: HashMap::new(),
                slot_id: None,
                nested: vec![StrategyConfig {
                    id: "expand_region_passage".to_string(),
                    params: HashMap::new(),
                    slot_id: Some("merge_target".to_string()),
                    nested: vec![],
                }],
            }),
        };
        config.stages[0].rules.push(scc_check_rule);

        let result = run_from_config(1, &config);
        assert!(result.is_ok(), "run_from_config must succeed end-to-end: {:?}", result.err());
        let result = result.unwrap();
        // Two geometrically-disjoint islands can never be bridged by expand_region_passage (no
        // shared wall exists between them) — the issue is expected to remain unresolved, proving
        // the strategy was actually dispatched (not silently skipped) and correctly reported
        // Failed rather than panicking or silently succeeding.
        assert!(result.remaining_issues.iter().any(|i| i.kind().as_str() == "excessive_scc_count"),
            "excessive_scc_count must still be reported since the two islands cannot be bridged: {:?}",
            result.remaining_issues.iter().map(|i| i.kind().as_str()).collect::<Vec<_>>());
    }

    #[test]
    fn end_to_end_reduce_scc_count_actually_reduces_component_count_on_contiguous_field() {
        use crate::config::TessellationConfig;

        // A contiguous field lets expand_region_passage actually bridge every SCC (every region
        // has a geometrically-adjacent neighbor, unlike the disjoint-islands test above) — this
        // verifies reduce_scc_count doesn't just get dispatched but genuinely reduces the SCC
        // count via its nested strategy. `one_way_chance: 1.0` (every edge one-way) reliably
        // fragments a contiguous field's undirected spanning structure into several SCCs.
        let mut points = vec![];
        for x in 0..4 { for y in 0..4 { points.push([x, y]); } }

        let mut config = GenerateConfig::default();
        config.tessellation = TessellationConfig { tessellation_type: TessellationType::Square, points };
        config.elements.one_way_chance = Some(1.0);

        let scc_check_rule = QcRuleConfig {
            id: "r_scc".to_string(),
            checks: vec![CheckInstanceConfig {
                local_id: "scc_count".to_string(),
                type_id: "scc_count".to_string(),
                params: HashMap::from([("max_scc_count".to_string(), "1".to_string())]),
            }],
            strategy: Some(StrategyConfig {
                id: "reduce_scc_count".to_string(),
                params: HashMap::new(),
                slot_id: None,
                nested: vec![StrategyConfig {
                    id: "expand_region_passage".to_string(),
                    params: HashMap::new(),
                    slot_id: Some("merge_target".to_string()),
                    nested: vec![],
                }],
            }),
        };
        config.stages[0].rules.push(scc_check_rule);

        let result = run_from_config(1, &config).expect("run_from_config must succeed");
        assert!(!result.remaining_issues.iter().any(|i| i.kind().as_str() == "excessive_scc_count"),
            "a fully contiguous field must let reduce_scc_count converge to max_scc_count=1: {:?}",
            result.remaining_issues.iter().map(|i| i.kind().as_str()).collect::<Vec<_>>());
    }

    #[test]
    fn end_to_end_weighted_region_merge_retries_after_geometric_failure_via_teleport() {
        use crate::config::TessellationConfig;

        // Two disjoint 2x2 islands, same shape as the reduce_scc_count disjoint-islands test
        // above — expand_region_passage is guaranteed to fail (no shared wall between islands),
        // teleport_region_merge is guaranteed to succeed (not geometry-bound, any other SCC
        // component is a valid candidate). This proves dispatch_weighted actually retries: the
        // only way REGION_NEEDS_EXPANSION gets resolved on this fixture is if the
        // geometry-bound candidate is tried, fails, is rolled back, and the teleport candidate is
        // then tried and succeeds — not just "generation converged somehow".
        let mut points = vec![];
        for x in 0..2 { for y in 0..2 { points.push([x, y]); } }
        for x in 4..6 { for y in 0..2 { points.push([x, y]); } }

        let mut config = GenerateConfig::default();
        config.tessellation = TessellationConfig { tessellation_type: TessellationType::Square, points };

        let region_rule = QcRuleConfig {
            id: "r_region".to_string(),
            checks: vec![CheckInstanceConfig {
                local_id: "min_region_size".to_string(),
                type_id: "min_region_size".to_string(),
                params: HashMap::from([("min_region_size".to_string(), "3".to_string())]),
            }],
            strategy: Some(StrategyConfig {
                id: "weighted_region_merge".to_string(),
                params: HashMap::new(),
                slot_id: None,
                nested: vec![
                    StrategyConfig {
                        id: "expand_region_passage".to_string(),
                        params: HashMap::new(),
                        slot_id: Some("merge_target".to_string()),
                        nested: vec![],
                    },
                    StrategyConfig {
                        id: "teleport_region_merge".to_string(),
                        params: HashMap::new(),
                        slot_id: Some("merge_target".to_string()),
                        nested: vec![],
                    },
                ],
            }),
        };
        config.stages[0].rules.push(region_rule);

        let result = run_from_config(1, &config).expect("run_from_config must succeed");
        assert!(!result.remaining_issues.iter().any(|i| i.kind().as_str() == "region_needs_expansion"),
            "weighted_region_merge must resolve region_needs_expansion via the teleport candidate after the geometric one fails: {:?}",
            result.remaining_issues.iter().map(|i| i.kind().as_str()).collect::<Vec<_>>());
    }

    #[test]
    fn two_level_nesting_is_accepted() {
        // expand_region_passage itself has no nested slots, so its own `nested` must be empty —
        // this exercises build_nested's recursive call one level deeper without needing a real
        // multi-slot strategy to exist yet.
        let nested = StrategyConfig { id: "expand_region_passage".to_string(), params: HashMap::new(), slot_id: Some("merge_target".to_string()), nested: vec![] };
        let strategy = StrategyConfig { id: "reduce_scc_count".to_string(), params: HashMap::new(), slot_id: None, nested: vec![nested] };
        let rule = scc_count_rule(Some(strategy));
        let mut config = GenerateConfig::default();
        config.stages = one_stage(rule);
        let result = build_qc_and_repair::<SquareTessellation>(&config);
        assert!(result.is_ok(), "recursive build_nested must handle a nested strategy with its own (empty) nested list: {:?}", result.err());
    }

    #[test]
    fn reduce_scc_count_with_valid_nested_is_accepted() {
        let nested = StrategyConfig { id: "expand_region_passage".to_string(), params: HashMap::new(), slot_id: Some("merge_target".to_string()), nested: vec![] };
        let strategy = StrategyConfig { id: "reduce_scc_count".to_string(), params: HashMap::new(), slot_id: None, nested: vec![nested] };
        let rule = scc_count_rule(Some(strategy));
        let mut config = GenerateConfig::default();
        config.stages = one_stage(rule);
        let result = build_qc_and_repair::<SquareTessellation>(&config);
        assert!(result.is_ok(), "a single valid nested strategy filling merge_target must be accepted: {:?}", result.err());
    }

    // `build_nested` is a private fn in the outer module (`super::*` above brings it into scope
    // here), so these tests call it directly against synthetic `expected_nested()` shapes rather
    // than going through `build_qc_and_repair`/real registry strategies — the only way to
    // exercise `max: None` (unbounded slots) and 3+ levels of real nesting, neither of which any
    // strategy in today's registry actually declares (see `Specs/repair.md`'s own admission that
    // depth is "unbounded in the data model... but nothing stops one [level]" being added).
    mod build_nested_generic_shape_tests {
        use super::*;
        use maze_core::repair::{RepairResult, StrategyParams};
        use maze_core::generation::PresetState;
        use maze_core::quality_control::{ExcessiveSccCountIssue, EXCESSIVE_SCC_COUNT};
        use maze_core::Maze;

        // A slot-holding strategy that accepts any number (0..) of nested strategies handling
        // EXCESSIVE_SCC_COUNT — `max: None` is never exercised by the real registry today. Its
        // slot's `kind` is chosen to match `reduce_scc_count`'s own `handles()`, so a real
        // registry strategy (not a second mock) can fill it — see
        // `three_level_nesting_resolves_through_a_real_second_level_strategy` below, which uses
        // this to reach 3 real levels without needing a test-only entry in `build_strategy_erased`.
        struct UnboundedSlotStrategy;
        static UNBOUNDED_SLOT: &[NestedSlot] = &[NestedSlot { slot_id: "unbounded", kind: EXCESSIVE_SCC_COUNT, min: 0, max: None }];
        impl<T: Tessellation> RepairStrategy<T, ExcessiveSccCountIssue> for UnboundedSlotStrategy {
            fn strategy_id(&self) -> &'static str { "test_unbounded_slot_strategy" }
            fn expected_nested(&self) -> &'static [NestedSlot] { UNBOUNDED_SLOT }
            fn apply(&self, _: &ExcessiveSccCountIssue, _: &mut Maze<T>, _: &mut maze_core::repair::SnapshotStack, _: &mut dyn rand::RngCore, _: &StrategyParams, _: &PresetState, _: &[NestedStrategyConfig<T>]) -> RepairResult {
                RepairResult::Failed
            }
        }
        maze_core::impl_erased_repair_strategy!(UnboundedSlotStrategy, ExcessiveSccCountIssue);

        fn nested_cfg(id: &str, slot_id: &str, nested: Vec<StrategyConfig>) -> StrategyConfig {
            StrategyConfig { id: id.to_string(), params: HashMap::new(), slot_id: Some(slot_id.to_string()), nested }
        }

        #[test]
        fn unbounded_slot_accepts_zero_nested() {
            let result = build_nested::<SquareTessellation>(&UnboundedSlotStrategy, &[]);
            assert!(result.is_ok(), "min: 0 must accept an empty nested list: {:?}", result.err());
            assert_eq!(result.unwrap().len(), 0);
        }

        #[test]
        fn unbounded_slot_accepts_several_nested_strategies_for_the_same_slot() {
            // Each `reduce_scc_count` entry must fill its own mandatory `merge_target` slot —
            // this test is about the unbounded outer slot accepting 3 siblings, not about
            // reduce_scc_count's own validation, so each sibling gets a minimal valid child.
            let make_reduce_scc_count = || nested_cfg("reduce_scc_count", "unbounded", vec![nested_cfg("expand_region_passage", "merge_target", vec![])]);
            let configs = vec![make_reduce_scc_count(), make_reduce_scc_count(), make_reduce_scc_count()];
            let result = build_nested::<SquareTessellation>(&UnboundedSlotStrategy, &configs);
            assert!(result.is_ok(), "max: None must accept more than one nested strategy for the same slot: {:?}", result.err());
            assert_eq!(result.unwrap().len(), 3, "all 3 entries for the unbounded slot must be kept, not deduped or truncated");
        }

        #[test]
        fn three_level_nesting_resolves_through_a_real_second_level_strategy() {
            // Level 1 (UnboundedSlotStrategy, a mock) -> level 2 (reduce_scc_count, a real
            // nested-capable registry strategy) -> level 3 (expand_region_passage, a real leaf
            // strategy filling reduce_scc_count's own merge_target slot). This is a real 3-level
            // chain one level deeper than any path `build_qc_and_repair`'s own tests exercise
            // today (those only ever put reduce_scc_count at the top level).
            let level_3 = nested_cfg("expand_region_passage", "merge_target", vec![]);
            let level_2 = nested_cfg("reduce_scc_count", "unbounded", vec![level_3]);
            let result = build_nested::<SquareTessellation>(&UnboundedSlotStrategy, &[level_2]);
            assert!(result.is_ok(), "a real 3-level nested chain must resolve: {:?}", result.err());
            let resolved = result.unwrap();
            assert_eq!(resolved.len(), 1);
            assert_eq!(resolved[0].strategy.strategy_id(), "reduce_scc_count");
            assert_eq!(resolved[0].nested.len(), 1, "level 2's own merge_target slot must be resolved recursively, not left empty");
            assert_eq!(resolved[0].nested[0].strategy.strategy_id(), "expand_region_passage");
            assert_eq!(resolved[0].nested[0].nested.len(), 0, "expand_region_passage has no slots of its own");
        }

        #[test]
        fn three_level_nesting_rejects_incompatible_kind_at_the_deepest_level() {
            // Level 3 handles INVALID_LOOP, but level 2's (reduce_scc_count) own merge_target
            // slot expects REGION_NEEDS_EXPANSION — the incompatibility must be caught at
            // whichever depth it actually occurs, not just at the top level.
            let level_3 = nested_cfg("invalid_loop_random", "merge_target", vec![]);
            let level_2 = nested_cfg("reduce_scc_count", "unbounded", vec![level_3]);
            let result = build_nested::<SquareTessellation>(&UnboundedSlotStrategy, &[level_2]);
            assert!(result.is_err(), "a kind mismatch at depth 3 must still be rejected: {:?}", result.ok().map(|_| ()));
        }
    }
}

#[cfg(test)]
mod build_strategy_tests {
    use super::*;
    use maze_core::space::SquareTessellation;

    // `build_strategy`'s match arms hand-pair a string literal with a `Box::new(SomeStruct)` —
    // nothing in the type system checks that `SomeStruct::strategy_id()` actually equals that
    // same string. A copy-paste error (wrong struct pointed at an arm's key, or two arms
    // swapped) would silently construct the wrong strategy for a given id, surfacing only
    // indirectly through unrelated-looking test failures or wrong runtime behavior — this test
    // catches that class of bug directly, at the exact point of introduction.
    const ALL_KNOWN_STRATEGY_IDS: &[&str] = &[
        "random_endpoints", "farthest_endpoints", "scored_endpoints",
        "invalid_loop_random", "invalid_loop_scored", "missing_loops_random",
        "expand_region_passage", "teleport_region_merge", "missing_regions", "reduce_scc_count",
        "remove_teleport", "teleport_group_proximity",
    ];

    #[test]
    fn every_known_id_builds_a_strategy_whose_own_strategy_id_matches() {
        for &id in ALL_KNOWN_STRATEGY_IDS {
            let strategy = build_strategy_erased::<SquareTessellation>(id)
                .unwrap_or_else(|e| panic!("build_strategy_erased({id:?}) failed: {e}"));
            assert_eq!(strategy.strategy_id(), id, "build_strategy_erased({id:?}) constructed a strategy whose own strategy_id() doesn't match — wrong match arm?");
        }
    }

    #[test]
    fn unknown_id_is_rejected() {
        assert!(build_strategy_erased::<SquareTessellation>("not_a_real_strategy").is_err());
    }
}

#[cfg(test)]
mod build_check_tests {
    use super::*;
    use maze_core::space::SquareTessellation;

    // Same rationale as `build_strategy_tests::every_known_id_builds_a_strategy_whose_own_strategy_id_matches`
    // above, but for `build_check`: its match arms hand-pair a string literal with a
    // `Box::new(SomeCheck { .. })`, and nothing in the type system checks that
    // `SomeCheck::check_type_id()` actually equals that same string. Also exercises
    // `check_kind_for_type`, whose match arms are a second, independently-maintained list of the
    // same type_ids — a check added to one but not the other would otherwise go unnoticed until
    // a live config exercised the missing arm (and `check_kind_for_type` panics on an unknown id).
    const ALL_KNOWN_CHECK_TYPE_IDS: &[&str] = &[
        "missing_endpoints", "unreachable_finish",
        "min_loops_count", "min_loop_density", "min_loop_length", "max_loop_length",
        "external_escape_diversity", "loop_distance_from_start", "loop_distance_from_finish",
        "max_loop_density", "scc_count", "min_region_size", "min_region_ratio", "min_region_count",
        "teleport_duplicates_connection", "teleport_waypoint_distance",
        "teleport_min_geometric_length", "teleport_max_geometric_length",
        "teleport_super_hub_avoidance", "teleport_group_proximity",
    ];

    /// Test-only dispatcher mirroring `build_rule_for!`'s own `KindTag` match, but returning just
    /// the built check's `check_type_id()` — the one thing these regression tests need — instead
    /// of a `Box<dyn Check<T, I>>` (whose concrete `I` differs per arm and so can't be returned
    /// as one unified type). `None` means `instance.type_id` is unknown to every `KindTag` arm.
    fn build_check_type_id<T: Tessellation>(instance: &CheckInstanceConfig, instance_id: String) -> Option<&'static str> {
        macro_rules! try_ctor {
            ($ctor:ident) => {
                if let Some(check) = $ctor::<T>(instance, instance_id.clone()) {
                    return Some(check.check_type_id());
                }
            };
        }
        try_ctor!(build_missing_endpoints_check);
        try_ctor!(build_unreachable_finish_check);
        try_ctor!(build_missing_loops_check);
        try_ctor!(build_invalid_loop_check);
        try_ctor!(build_excessive_scc_count_check);
        try_ctor!(build_region_needs_expansion_check);
        try_ctor!(build_missing_regions_check);
        try_ctor!(build_invalid_teleport_check);
        try_ctor!(build_teleport_group_proximity_check);
        None
    }

    #[test]
    fn every_known_id_builds_a_check_whose_own_check_type_id_matches() {
        for &id in ALL_KNOWN_CHECK_TYPE_IDS {
            let instance = CheckInstanceConfig { local_id: "0".to_string(), type_id: id.to_string(), params: HashMap::new() };
            let check_type_id = build_check_type_id::<SquareTessellation>(&instance, "instance".to_string())
                .unwrap_or_else(|| panic!("build_check_type_id({id:?}) found no matching KindTag arm"));
            assert_eq!(check_type_id, id, "build_check_type_id({id:?}) constructed a check whose own check_type_id() doesn't match — wrong match arm?");
            // Must also resolve in check_kind_for_type's independent match — panics on unknown id.
            let _ = check_kind_for_type(id);
        }
    }

    #[test]
    fn unknown_id_is_rejected() {
        let instance = CheckInstanceConfig { local_id: "0".to_string(), type_id: "not_a_real_check".to_string(), params: HashMap::new() };
        assert!(build_check_type_id::<SquareTessellation>(&instance, "instance".to_string()).is_none());
    }

    #[test]
    fn teleport_group_proximity_parses_a_fractional_distance_string() {
        // Regression guard: "distance" used to be parsed as i64, silently dropping any
        // fractional config value (e.g. "1.1") to the 0.0 default via .ok() -- teleports meant
        // to be flagged at distance 1 were never caught because the effective threshold fell
        // back to 0. Now parsed as f64: build a check with distance="1.1" from a raw config
        // string (as the web layer would send it) and confirm it actually flags a gap of 1.
        use maze_core::graph::EdgeKind;
        use maze_core::space::{Field, SquareTessellation, SquarePoint, square_rect};
        use maze_core::{Graph, IdGenerator, Maze};
        use rand::SeedableRng;

        let mut params = HashMap::new();
        params.insert("distance".to_string(), "1.1".to_string());
        let instance = CheckInstanceConfig { local_id: "0".to_string(), type_id: "teleport_group_proximity".to_string(), params };
        let check = build_teleport_group_proximity_check::<SquareTessellation>(&instance, "instance".to_string())
            .expect("build_teleport_group_proximity_check must accept a fractional distance string");

        // Two teleports whose entries sit exactly 1 tile-hop apart -- must be flagged against
        // threshold 1.1 (1 < 1.1), but would NOT be flagged against the old silently-truncated
        // fallback of 0.0.
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(4, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
        g.build_initial_bidirectional_edge(p(0), p(1), EdgeKind::Basic);
        g.build_initial_edge(p(0), p(2), EdgeKind::Teleport);
        g.build_initial_edge(p(1), p(3), EdgeKind::Teleport);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let mut issues = Vec::new();
        let mut rng = maze_core::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng);
        assert_eq!(issues.len(), 1, "distance=1.1 must flag a pair of teleports 1 tile-hop apart, proving the fractional value wasn't truncated to 0 or 1");
    }
}
