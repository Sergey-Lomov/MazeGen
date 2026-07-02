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
    },
    repair::{
        QcRule, RepairEngine, RepairRuleConfig, RepairStrategy,
        RandomEndpointsStrategy, FarthestEndpointsStrategy, ScoredEndpointsStrategy,
        InvalidLoopRandomStrategy, InvalidLoopScoredStrategy, MissingLoopsRandomStrategy,
        ExpandRegionPassageStrategy, MissingRegionsStrategy,
    },
    RegionClass, GenerationTiming,
    quality_control::Issue,
};
use crate::config::{
    GenerateConfig, CheckInstanceConfig, TessellationType,
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
        other => return Err(format!("unknown check: {other}")),
    };
    Ok(check)
}

pub fn build_qc_and_repair<T: Tessellation>(
    config: &GenerateConfig,
) -> Result<(QualityControlEngine<T>, RepairEngine<T>), String> {
    let mut checks: Vec<Box<dyn maze_core::quality_control::Check<T>>> = Vec::new();
    let mut all_rules: Vec<QcRule> = Vec::new();
    let mut repair_rules: Vec<RepairRuleConfig<T>> = Vec::new();

    for rule_cfg in &config.check_rules {
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
            let strategy: Box<dyn RepairStrategy<T>> = match strategy_cfg.id.as_str() {
                "random_endpoints"    => Box::new(RandomEndpointsStrategy),
                "farthest_endpoints"  => Box::new(FarthestEndpointsStrategy),
                "scored_endpoints"    => Box::new(ScoredEndpointsStrategy),
                "invalid_loop_random" => Box::new(InvalidLoopRandomStrategy),
                "invalid_loop_scored" => Box::new(InvalidLoopScoredStrategy),
                "missing_loops_random" => Box::new(MissingLoopsRandomStrategy),
                "expand_region_passage" => Box::new(ExpandRegionPassageStrategy),
                "missing_regions"     => Box::new(MissingRegionsStrategy),
                other => return Err(format!("unknown strategy: {other}")),
            };
            repair_rules.push(RepairRuleConfig {
                rule: QcRule { id: rule_cfg.id.clone(), kind, checks: composite_ids },
                strategy,
                param_overrides: strategy_cfg.params.clone(),
            });
        }
        all_rules.push(rule);
    }

    let qc_engine = QualityControlEngine::new(checks);
    let repair_engine = RepairEngine::new(repair_rules, all_rules);
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
        |_, _| start,
    );

    generate_maze(&mut graph, &field, seed, start_id, gen_config, &preset_state);

    let (qc_engine, repair_engine) = build_qc_and_repair::<T>(config)?;
    let limits = build_repair_limits(config);
    let (maze, remaining_issues, timing) = build_maze(field, graph, seed, qc_engine, repair_engine, &preset_state, limits);

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

    Ok(MazeRunResult { remaining_issues, timing, region_sizes, start: start_node, finish: finish_node })
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
            run_generate_typed(seed, field, start, config, gen_config)
        }
        TessellationType::Hex => {
            use maze_core::space::{HexTessellation, HexPoint};
            let pts: Vec<HexPoint> = config.tessellation.points.iter()
                .map(|&[q, r]| HexPoint { q, r }).collect();
            if pts.is_empty() { return Err("tessellation points must not be empty".to_string()); }
            let start = resolve_start(&pts, config.preset_gen_source, |p| (p.q, p.r));
            let field = Field::<HexTessellation>::new(pts, &mut ids).map_err(|e| e.to_string())?;
            run_generate_typed(seed, field, start, config, gen_config)
        }
        TessellationType::Tri => {
            use maze_core::space::{TriTessellation, TriPoint};
            let pts: Vec<TriPoint> = config.tessellation.points.iter()
                .map(|&[col, row]| TriPoint { col, row }).collect();
            if pts.is_empty() { return Err("tessellation points must not be empty".to_string()); }
            let start = resolve_start(&pts, config.preset_gen_source, |p| (p.col, p.row));
            let field = Field::<TriTessellation>::new(pts, &mut ids).map_err(|e| e.to_string())?;
            run_generate_typed(seed, field, start, config, gen_config)
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
