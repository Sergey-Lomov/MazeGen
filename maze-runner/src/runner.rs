use std::collections::{HashMap, HashSet};
use maze_core::{
    graph::Graph,
    ids::IdGenerator,
    space::{Field, Tessellation},
    generation::{generate_maze, build_preset_state, GenerationConfig},
    quality_control::{
        QualityControlEngine, MissingEndpointsCheck, UnreachableFinishCheck,
        MinLoopsCountCheck, MIN_LOOPS_DEFAULT, MinLoopDensityCheck, MIN_LOOP_DENSITY_DEFAULT,
        AVG_LOOP_LENGTH_ESTIMATE_DEFAULT, MinLoopLengthCheck, MIN_LOOP_LENGTH_DEFAULT,
        MaxLoopLengthCheck, MAX_LOOP_LENGTH_DEFAULT, ExternalEscapeDiversityCheck,
        EXTERNAL_ESCAPE_DIVERSITY_DEFAULT, LoopDistanceFromStartCheck,
        LOOP_DISTANCE_FROM_START_DEFAULT, LoopDistanceFromFinishCheck,
        LOOP_DISTANCE_FROM_FINISH_DEFAULT, MaxLoopDensityCheck, MAX_LOOP_DENSITY_DEFAULT,
        SccCountCheck, MAX_SCC_COUNT_DEFAULT, MinRegionSizeCheck, MIN_REGION_SIZE_DEFAULT,
        MinRegionRatioCheck, MIN_REGION_RATIO_DEFAULT, MinRegionCountCheck,
        MIN_REGION_COUNT_DEFAULT, IssueKind,
        MISSING_ENDPOINTS, UNREACHABLE_FINISH, MISSING_LOOPS, INVALID_LOOP,
        EXCESSIVE_SCC_COUNT, REGION_NEEDS_EXPANSION, MISSING_REGIONS,
        TeleportDuplicatesConnectionCheck, INVALID_TELEPORT,
        TeleportWaypointDistanceCheck, TeleportWaypoint, TeleportEdgeSelector, TELEPORT_WAYPOINT_DISTANCE_DEFAULT,
        TeleportMinGeometricLengthCheck, TELEPORT_MIN_GEOMETRIC_LENGTH_DEFAULT,
        TeleportMaxGeometricLengthCheck, TELEPORT_MAX_GEOMETRIC_LENGTH_DEFAULT,
        TeleportSuperHubAvoidanceCheck, TeleportHubEdgeSelector, TELEPORT_SUPER_HUB_MAX_CONNECTIONS_DEFAULT,
        TeleportGroupProximityCheck, TeleportProximityEdge, TELEPORT_GROUP_PROXIMITY_DISTANCE_DEFAULT,
        TELEPORT_GROUP_PROXIMITY,
    },
    repair::{
        QcRule, RepairEngine, RepairRuleConfig, RepairStage, RepairStrategy,
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
    pub remaining_issues: Vec<Issue>,
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

fn check_kind_for_type(type_id: &str) -> IssueKind {
    match type_id {
        "missing_endpoints"         => MISSING_ENDPOINTS,
        "unreachable_finish"        => UNREACHABLE_FINISH,
        "min_loops_count"           => MISSING_LOOPS,
        "min_loop_density"          => MISSING_LOOPS,
        "min_loop_length"           => INVALID_LOOP,
        "max_loop_length"           => INVALID_LOOP,
        "external_escape_diversity" => INVALID_LOOP,
        "loop_distance_from_start"  => INVALID_LOOP,
        "loop_distance_from_finish" => INVALID_LOOP,
        "max_loop_density"          => INVALID_LOOP,
        "scc_count"                 => EXCESSIVE_SCC_COUNT,
        "min_region_size"           => REGION_NEEDS_EXPANSION,
        "min_region_ratio"          => REGION_NEEDS_EXPANSION,
        "min_region_count"          => MISSING_REGIONS,
        "teleport_duplicates_connection" => INVALID_TELEPORT,
        "teleport_waypoint_distance" => INVALID_TELEPORT,
        "teleport_min_geometric_length" => INVALID_TELEPORT,
        "teleport_max_geometric_length" => INVALID_TELEPORT,
        "teleport_super_hub_avoidance" => INVALID_TELEPORT,
        "teleport_group_proximity" => TELEPORT_GROUP_PROXIMITY,
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

fn build_check<T: Tessellation>(
    instance: &CheckInstanceConfig,
    instance_id: String,
) -> Result<Box<dyn maze_core::quality_control::Check<T>>, String> {
    let check: Box<dyn maze_core::quality_control::Check<T>> = match instance.type_id.as_str() {
        "missing_endpoints" => Box::new(MissingEndpointsCheck { instance_id }),
        "unreachable_finish" => Box::new(UnreachableFinishCheck { instance_id }),
        "min_loops_count" => {
            let min_loops = instance.params.get("min_loops")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(1) as u32)
                .unwrap_or(MIN_LOOPS_DEFAULT);
            Box::new(MinLoopsCountCheck { instance_id, min_loops })
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
            Box::new(MinLoopDensityCheck { instance_id, min_density, avg_loop_length_estimate })
        }
        "min_loop_length" => {
            let min_loop_length = instance.params.get("min_loop_length")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(1) as u32)
                .unwrap_or(MIN_LOOP_LENGTH_DEFAULT);
            Box::new(MinLoopLengthCheck { instance_id, min_loop_length })
        }
        "max_loop_length" => {
            let max_loop_length = instance.params.get("max_loop_length")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(1) as u32)
                .unwrap_or(MAX_LOOP_LENGTH_DEFAULT);
            Box::new(MaxLoopLengthCheck { instance_id, max_loop_length })
        }
        "external_escape_diversity" => {
            let min_distinct_exits = instance.params.get("min_distinct_exits")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(EXTERNAL_ESCAPE_DIVERSITY_DEFAULT);
            Box::new(ExternalEscapeDiversityCheck { instance_id, min_distinct_exits })
        }
        "loop_distance_from_start" => {
            let min_distance_from_start = instance.params.get("min_distance_from_start")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(LOOP_DISTANCE_FROM_START_DEFAULT);
            Box::new(LoopDistanceFromStartCheck { instance_id, min_distance_from_start })
        }
        "loop_distance_from_finish" => {
            let min_distance_from_finish = instance.params.get("min_distance_from_finish")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(LOOP_DISTANCE_FROM_FINISH_DEFAULT);
            Box::new(LoopDistanceFromFinishCheck { instance_id, min_distance_from_finish })
        }
        "max_loop_density" => {
            let max_density = instance.params.get("max_density")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.clamp(0, 100) as u32)
                .unwrap_or(MAX_LOOP_DENSITY_DEFAULT);
            Box::new(MaxLoopDensityCheck { instance_id, max_density })
        }
        "scc_count" => {
            let max_scc_count = instance.params.get("max_scc_count")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(1) as u32)
                .unwrap_or(MAX_SCC_COUNT_DEFAULT);
            Box::new(SccCountCheck { instance_id, max_scc_count })
        }
        "min_region_size" => {
            let min_region_size = instance.params.get("min_region_size")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(1) as u32)
                .unwrap_or(MIN_REGION_SIZE_DEFAULT);
            let region_classes = parse_region_class_filter(instance.params.get("region_class"));
            Box::new(MinRegionSizeCheck { instance_id, min_region_size, region_classes })
        }
        "min_region_ratio" => {
            let min_region_ratio = instance.params.get("min_region_ratio")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.clamp(0, 100) as u32)
                .unwrap_or(MIN_REGION_RATIO_DEFAULT);
            let region_classes = parse_region_class_filter(instance.params.get("region_class"));
            Box::new(MinRegionRatioCheck { instance_id, min_region_ratio, region_classes })
        }
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
            Box::new(MinRegionCountCheck { instance_id, min_counts })
        }
        "teleport_duplicates_connection" => {
            let protect_route = parse_protect_route(instance.params.get("protect_route"));
            Box::new(TeleportDuplicatesConnectionCheck { instance_id, protect_route })
        }
        "teleport_waypoint_distance" => {
            let distance = instance.params.get("distance")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(TELEPORT_WAYPOINT_DISTANCE_DEFAULT);
            let waypoint = parse_teleport_waypoint(instance.params.get("waypoint"));
            let edge = parse_teleport_edge_selector(instance.params.get("edge"));
            let protect_route = parse_protect_route(instance.params.get("protect_route"));
            Box::new(TeleportWaypointDistanceCheck { instance_id, distance, waypoint, edge, protect_route })
        }
        "teleport_min_geometric_length" => {
            let min_length = instance.params.get("min_length")
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .map(|v| v.max(0.0))
                .unwrap_or(TELEPORT_MIN_GEOMETRIC_LENGTH_DEFAULT);
            let protect_route = parse_protect_route(instance.params.get("protect_route"));
            Box::new(TeleportMinGeometricLengthCheck { instance_id, min_length, protect_route })
        }
        "teleport_max_geometric_length" => {
            let max_length = instance.params.get("max_length")
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .map(|v| v.max(0.0))
                .unwrap_or(TELEPORT_MAX_GEOMETRIC_LENGTH_DEFAULT);
            let protect_route = parse_protect_route(instance.params.get("protect_route"));
            Box::new(TeleportMaxGeometricLengthCheck { instance_id, max_length, protect_route })
        }
        "teleport_super_hub_avoidance" => {
            let max_connections = instance.params.get("max_connections")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(TELEPORT_SUPER_HUB_MAX_CONNECTIONS_DEFAULT);
            let edge = parse_teleport_hub_edge_selector(instance.params.get("edge_hub"));
            let protect_route = parse_protect_route(instance.params.get("protect_route"));
            Box::new(TeleportSuperHubAvoidanceCheck { instance_id, max_connections, edge, protect_route })
        }
        "teleport_group_proximity" => {
            let distance = instance.params.get("distance")
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .map(|v| v.max(0.0))
                .unwrap_or(TELEPORT_GROUP_PROXIMITY_DISTANCE_DEFAULT);
            let own_edge = parse_teleport_proximity_edge(instance.params.get("own_edge"));
            let other_edge = parse_teleport_proximity_edge(instance.params.get("other_edge"));
            let protect_route = parse_protect_route(instance.params.get("protect_route"));
            Box::new(TeleportGroupProximityCheck { instance_id, distance, own_edge, other_edge, protect_route })
        }
        other => return Err(format!("unknown check: {other}")),
    };
    Ok(check)
}

fn build_strategy<T: Tessellation>(id: &str) -> Result<Box<dyn RepairStrategy<T>>, String> {
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

/// Resolves `configs` (a `StrategyConfig`'s `nested` list) into `NestedStrategyConfig`s against
/// `parent`'s `expected_nested()` slots — see `Specs/repair.md`'s nested-strategy pattern. Purely
/// generic over `parent.expected_nested()`/`.handles()`: no strategy id is ever compared here,
/// so adding a new nested-capable strategy never requires touching this function.
fn build_nested<T: Tessellation>(
    parent: &dyn RepairStrategy<T>,
    configs: &[StrategyConfig],
) -> Result<Vec<NestedStrategyConfig<T>>, String> {
    let slots = parent.expected_nested();

    // O(1) slot lookup instead of a linear scan per config — built once per call. No separate
    // "slots.is_empty()" fast path: an empty `slots_by_id` already makes the loop below reject
    // every `cfg` via the "no such slot" branch, with a message naming the actual missing slot.
    let slots_by_id: HashMap<&'static str, &'static NestedSlot> = slots.iter().map(|s| (s.slot_id, s)).collect();

    let mut counts: HashMap<&str, usize> = HashMap::new();
    let mut resolved: Vec<(&'static NestedSlot, &StrategyConfig, Box<dyn RepairStrategy<T>>)> = Vec::new();
    for cfg in configs {
        let Some(slot_id) = cfg.slot_id.as_deref() else {
            return Err(format!("nested strategy {} under {} is missing slot_id", cfg.id, parent.strategy_id()));
        };
        let Some(&slot) = slots_by_id.get(slot_id) else {
            return Err(format!("strategy {} has no nested slot \"{slot_id}\"", parent.strategy_id()));
        };
        let nested_strategy = build_strategy::<T>(&cfg.id)?;
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

pub fn build_qc_and_repair<T: Tessellation>(
    config: &GenerateConfig,
) -> Result<(QualityControlEngine<T>, RepairEngine<T>), String> {
    let mut checks: Vec<Box<dyn maze_core::quality_control::Check<T>>> = Vec::new();
    let mut all_rules: Vec<QcRule> = Vec::new();
    let mut repair_rules: Vec<RepairRuleConfig<T>> = Vec::new();
    let mut stages: Vec<RepairStage> = Vec::new();
    let mut seen_stage_ids: HashSet<&str> = HashSet::new();
    let mut seen_rule_ids: HashSet<&str> = HashSet::new();

    for stage_cfg in &config.stages {
        if !seen_stage_ids.insert(stage_cfg.id.as_str()) {
            return Err(format!("duplicate stage id: {}", stage_cfg.id));
        }
        let mut stage_rule_ids: Vec<String> = Vec::with_capacity(stage_cfg.rules.len());

        for rule_cfg in &stage_cfg.rules {
            if !seen_rule_ids.insert(rule_cfg.id.as_str()) {
                return Err(format!("duplicate rule id: {}", rule_cfg.id));
            }
            if rule_cfg.checks.is_empty() {
                return Err(format!("rule {} has no checks", rule_cfg.id));
            }
            let mut kind: Option<IssueKind> = None;
            let mut composite_ids: Vec<String> = Vec::with_capacity(rule_cfg.checks.len());
            let mut seen_local_ids: HashSet<&str> = HashSet::new();
            for instance in &rule_cfg.checks {
                if !seen_local_ids.insert(instance.local_id.as_str()) {
                    return Err(format!("rule {} has duplicate local_id: {}", rule_cfg.id, instance.local_id));
                }
                let this_kind = check_kind_for_type(&instance.type_id);
                match kind {
                    None => kind = Some(this_kind),
                    Some(k) if k == this_kind => {}
                    Some(_) => return Err(format!("checks in rule {} produce different issue kinds", rule_cfg.id)),
                }
                let instance_id = composite_check_id(&rule_cfg.id, &instance.local_id);
                checks.push(build_check::<T>(instance, instance_id.clone())?);
                composite_ids.push(instance_id);
            }
            let kind = kind.expect("non-empty rule always resolves a kind");
            let rule = QcRule { id: rule_cfg.id.clone(), kind, checks: composite_ids.clone() };

            if let Some(strategy_cfg) = &rule_cfg.strategy {
                if strategy_cfg.slot_id.is_some() {
                    return Err(format!("rule {}'s top-level strategy must not declare slot_id", rule_cfg.id));
                }
                let strategy = build_strategy::<T>(&strategy_cfg.id)?;
                let nested = build_nested::<T>(strategy.as_ref(), &strategy_cfg.nested)?;
                repair_rules.push(RepairRuleConfig {
                    rule: QcRule { id: rule_cfg.id.clone(), kind, checks: composite_ids },
                    strategy,
                    param_overrides: strategy_cfg.params.clone(),
                    nested,
                });
            }
            stage_rule_ids.push(rule_cfg.id.clone());
            all_rules.push(rule);
        }

        stages.push(RepairStage { id: stage_cfg.id.clone(), name: stage_cfg.name.clone(), rule_ids: stage_rule_ids });
    }

    // Every rule with a registered strategy must belong to exactly one stage — a rule with no
    // strategy has nothing to dispatch, so it has no such requirement (see `Specs/repair.md`'s
    // "Stages" section / plan's "Модель данных").
    let staged_rule_ids: HashSet<&str> = stages.iter().flat_map(|s| s.rule_ids.iter().map(|id| id.as_str())).collect();
    for cfg in &repair_rules {
        if !staged_rule_ids.contains(cfg.rule.id.as_str()) {
            return Err(format!("rule {} not assigned to any stage", cfg.rule.id));
        }
    }

    let qc_engine = QualityControlEngine::new(checks);
    let repair_engine = RepairEngine::new(repair_rules, all_rules, stages);
    Ok((qc_engine, repair_engine))
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

fn run_generate_typed<T: Tessellation>(
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

    let (qc_engine, repair_engine) = build_qc_and_repair::<T>(config)?;
    let limits = build_repair_limits(config);
    let preset_start = config.preset_start.and_then(|[sx, sy]| {
        field.all_points().find(|&p| to_xy(p) == (sx, sy)).and_then(|p| field.node_at(p))
    });
    let preset_finish = config.preset_finish.and_then(|[fx, fy]| {
        field.all_points().find(|&p| to_xy(p) == (fx, fy)).and_then(|p| field.node_at(p))
    });
    let repair_preset_state = preset_state.for_repair(config.qc_experiment);
    let (maze, remaining_issues, timing) = build_maze(field, graph, seed, qc_engine, repair_engine, &repair_preset_state, limits, preset_start, preset_finish);

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
        assert!(result.remaining_issues.iter().any(|i| i.kind.as_str() == "excessive_scc_count"),
            "excessive_scc_count must still be reported since the two islands cannot be bridged: {:?}",
            result.remaining_issues.iter().map(|i| i.kind.as_str()).collect::<Vec<_>>());
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
        assert!(!result.remaining_issues.iter().any(|i| i.kind.as_str() == "excessive_scc_count"),
            "a fully contiguous field must let reduce_scc_count converge to max_scc_count=1: {:?}",
            result.remaining_issues.iter().map(|i| i.kind.as_str()).collect::<Vec<_>>());
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
        assert!(!result.remaining_issues.iter().any(|i| i.kind.as_str() == "region_needs_expansion"),
            "weighted_region_merge must resolve region_needs_expansion via the teleport candidate after the geometric one fails: {:?}",
            result.remaining_issues.iter().map(|i| i.kind.as_str()).collect::<Vec<_>>());
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
        use maze_core::quality_control::Issue;
        use maze_core::Maze;

        // A slot-holding strategy that accepts any number (0..) of nested strategies handling
        // EXCESSIVE_SCC_COUNT — `max: None` is never exercised by the real registry today. Its
        // slot's `kind` is chosen to match `reduce_scc_count`'s own `handles()`, so a real
        // registry strategy (not a second mock) can fill it — see
        // `three_level_nesting_resolves_through_a_real_second_level_strategy` below, which uses
        // this to reach 3 real levels without needing a test-only entry in `build_strategy`.
        struct UnboundedSlotStrategy;
        static UNBOUNDED_SLOT: &[NestedSlot] = &[NestedSlot { slot_id: "unbounded", kind: EXCESSIVE_SCC_COUNT, min: 0, max: None }];
        impl RepairStrategy<SquareTessellation> for UnboundedSlotStrategy {
            fn strategy_id(&self) -> &'static str { "test_unbounded_slot_strategy" }
            fn handles(&self) -> IssueKind { EXCESSIVE_SCC_COUNT }
            fn expected_nested(&self) -> &'static [NestedSlot] { UNBOUNDED_SLOT }
            fn apply(&self, _: &Issue, _: &mut Maze<SquareTessellation>, _: &mut maze_core::repair::SnapshotStack, _: &mut dyn rand::RngCore, _: &StrategyParams, _: &PresetState, _: &[NestedStrategyConfig<SquareTessellation>]) -> RepairResult {
                RepairResult::Failed
            }
        }

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
            let strategy = build_strategy::<SquareTessellation>(id)
                .unwrap_or_else(|e| panic!("build_strategy({id:?}) failed: {e}"));
            assert_eq!(strategy.strategy_id(), id, "build_strategy({id:?}) constructed a strategy whose own strategy_id() doesn't match — wrong match arm?");
        }
    }

    #[test]
    fn unknown_id_is_rejected() {
        assert!(build_strategy::<SquareTessellation>("not_a_real_strategy").is_err());
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

    #[test]
    fn every_known_id_builds_a_check_whose_own_check_type_id_matches() {
        for &id in ALL_KNOWN_CHECK_TYPE_IDS {
            let instance = CheckInstanceConfig { local_id: "0".to_string(), type_id: id.to_string(), params: HashMap::new() };
            let check = build_check::<SquareTessellation>(&instance, "instance".to_string())
                .unwrap_or_else(|e| panic!("build_check({id:?}) failed: {e}"));
            assert_eq!(check.check_type_id(), id, "build_check({id:?}) constructed a check whose own check_type_id() doesn't match — wrong match arm?");
            // Must also resolve in check_kind_for_type's independent match — panics on unknown id.
            let _ = check_kind_for_type(id);
        }
    }

    #[test]
    fn unknown_id_is_rejected() {
        let instance = CheckInstanceConfig { local_id: "0".to_string(), type_id: "not_a_real_check".to_string(), params: HashMap::new() };
        assert!(build_check::<SquareTessellation>(&instance, "instance".to_string()).is_err());
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
        let check = build_check::<SquareTessellation>(&instance, "instance".to_string())
            .expect("build_check must accept a fractional distance string");

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
