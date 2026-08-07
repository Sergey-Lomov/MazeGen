pub(crate) mod check_factory;
pub(crate) mod strategy_factory;
pub(crate) mod rule_factory;
pub(crate) mod rule_params;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use maze_core::{
    graph::Graph,
    ids::IdGenerator,
    space::{Field, Tessellation},
    generation::{generate_maze, build_preset_state, GenerationConfig, PresetEndpoint},
    RegionClass, GenerationTiming,
    quality_control::{Issue, QcEvent},
    event_log::{EventLog, DebugTape},
};
use crate::config::{
    GenerateConfig, TessellationType, PresetEndpointDto,
    build_generation_config, build_repair_limits,
};

pub use rule_factory::build_qc_and_repair;

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
    /// QC/repair narration-level debug event tape (GitHub issue #147) — `Some` exactly when
    /// `config.debug_events` is set, `None` otherwise. Generation itself isn't instrumented here
    /// (`maze-runner` calls the plain `generate_maze`, not `generate_maze_with_events` — no
    /// browser-repro test needs to inspect generation's own narration, only QC's), so this is a
    /// standalone, unmerged `QcEvent` tape rather than a multi-source merged one like
    /// `maze-wasm::run_generate` produces.
    pub qc_tape: Option<DebugTape<QcEvent>>,
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

fn preset_endpoint_dto_to_core(dto: &PresetEndpointDto) -> PresetEndpoint {
    PresetEndpoint { point: (dto.point[0], dto.point[1]), slot: dto.slot }
}

fn run_generate_typed<T: Tessellation + 'static>(
    seed: u64,
    mut field: Field<T>,
    mut ids: IdGenerator,
    start: T::Point,
    config: &GenerateConfig,
    gen_config: GenerationConfig,
    point_from_xy: impl Fn(i32, i32) -> T::Point,
) -> Result<MazeRunResult, String> {
    use maze_core::generation::pipeline::build_maze;

    let degree = T::faces().len();
    maze_core::generation::validate_split_patterns(&gen_config.split_generation.patterns, degree)?;

    let mut graph = Graph::new();
    field.build_nodes(&mut graph);

    let preset_state = build_preset_state(
        &mut graph, &mut field, &mut ids,
        &gen_config.preset_connections,
        &gen_config.locked_nodes,
        &gen_config.split_points,
        &point_from_xy,
        None,
        None,
    )?;

    // `start_id` re-resolves the same gen_source marker `resolve_start` already used to pick
    // `start` geometrically, but now against `PresetState` — a slot-addressed gen_source needs
    // the split node `build_preset_state` just created above, which `resolve_start` (geometry
    // only, no `Field`/`NodeId` access) can't have resolved on its own.
    let start_id = config.preset_gen_source.as_ref()
        .and_then(|dto| preset_state.resolve_endpoint(&field, &point_from_xy, preset_endpoint_dto_to_core(dto)))
        .or_else(|| field.nodes_at(start).first().copied())
        .ok_or_else(|| "start node not found".to_string())?;

    // QC experiment mode skips the generation algorithm entirely — mirrors `maze-wasm`'s
    // `run_generate` (see `Specs`'s generation-card "QC experiment" mode). The graph built by
    // `build_preset_state` above (preset connections only) is fed straight into `build_maze`.
    let mut start_reassignment = None;
    if !config.qc_experiment {
        start_reassignment = generate_maze(&mut graph, &mut field, &mut ids, seed, start_id, gen_config, &preset_state);
    }

    let qc_engine = build_qc_and_repair::<T>(config)?;
    let limits = build_repair_limits(config)?;
    // A split hit on the traversal-seed node reassigns `start_id` mid-run (GitHub issue #222) —
    // only honored when there's no explicit `preset_start` pinning a human's fixed choice.
    let preset_start = config.preset_start.as_ref()
        .and_then(|dto| preset_state.resolve_endpoint(&field, &point_from_xy, preset_endpoint_dto_to_core(dto)))
        .or_else(|| start_reassignment.map(|r| r.reassigned_to));
    let preset_finish = config.preset_finish.as_ref()
        .and_then(|dto| preset_state.resolve_endpoint(&field, &point_from_xy, preset_endpoint_dto_to_core(dto)));
    let repair_preset_state = preset_state.for_repair(config.qc_experiment);
    let mut qc_log = config.debug_events.then(EventLog::new);
    let (maze, remaining_issues, timing) = build_maze(
        field, graph, seed, qc_engine, &repair_preset_state, limits, preset_start, preset_finish,
        qc_log.as_mut(), None,
    );
    let qc_tape = qc_log.map(EventLog::finish);

    let start_node = maze.meta.start;
    let finish_node = maze.meta.finish;
    let mut region_sizes: HashMap<RegionClass, Vec<usize>> = HashMap::new();

    if start_node.is_some() && finish_node.is_some() {
        let scc = maze.analysis.scc(&maze.graph);
        let classes = maze.analysis.region_classes(&maze.graph, &maze.field, &maze.meta);
        for (&comp_id, &cls) in &classes {
            region_sizes.entry(cls).or_default().push(scc.components[comp_id].len());
        }
        for sizes in region_sizes.values_mut() {
            sizes.sort_unstable_by(|a, b| b.cmp(a));
        }
    }

    Ok(MazeRunResult { remaining_issues, timing, region_sizes, start: start_node, finish: finish_node, graph: maze.graph.clone(), qc_tape })
}

/// Parse JSON config and run the full generation+repair pipeline for the given seed.
/// Use this as the entry point in all integration tests.
pub fn run_from_config(seed: u64, config: &GenerateConfig) -> Result<MazeRunResult, String> {
    let mut ids = IdGenerator::new();
    let gen_config = build_generation_config(config);

    let gen_source_xy = config.preset_gen_source.as_ref().map(|dto| dto.point);

    match config.tessellation.tessellation_type {
        TessellationType::Square => {
            use maze_core::space::{SquareTessellation, SquarePoint};
            let pts: Vec<SquarePoint> = config.tessellation.points.iter()
                .map(|&[x, y]| SquarePoint { x, y }).collect();
            if pts.is_empty() { return Err("tessellation points must not be empty".to_string()); }
            let start = resolve_start(&pts, gen_source_xy, |p| (p.x, p.y));
            let field = Field::<SquareTessellation>::new(pts, &mut ids).map_err(|e| e.to_string())?;
            run_generate_typed(seed, field, ids, start, config, gen_config, |x, y| SquarePoint { x, y })
        }
        TessellationType::Hex => {
            use maze_core::space::{HexTessellation, HexPoint};
            let pts: Vec<HexPoint> = config.tessellation.points.iter()
                .map(|&[q, r]| HexPoint { q, r }).collect();
            if pts.is_empty() { return Err("tessellation points must not be empty".to_string()); }
            let start = resolve_start(&pts, gen_source_xy, |p| (p.q, p.r));
            let field = Field::<HexTessellation>::new(pts, &mut ids).map_err(|e| e.to_string())?;
            run_generate_typed(seed, field, ids, start, config, gen_config, |q, r| HexPoint { q, r })
        }
        TessellationType::Tri => {
            use maze_core::space::{TriTessellation, TriPoint};
            let pts: Vec<TriPoint> = config.tessellation.points.iter()
                .map(|&[col, row]| TriPoint { col, row }).collect();
            if pts.is_empty() { return Err("tessellation points must not be empty".to_string()); }
            let start = resolve_start(&pts, gen_source_xy, |p| (p.col, p.row));
            let field = Field::<TriTessellation>::new(pts, &mut ids).map_err(|e| e.to_string())?;
            run_generate_typed(seed, field, ids, start, config, gen_config, |col, row| TriPoint { col, row })
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
