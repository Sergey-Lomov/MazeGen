pub(crate) mod check_factory;
pub(crate) mod strategy_factory;
pub(crate) mod rule_factory;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use maze_core::{
    graph::Graph,
    ids::IdGenerator,
    space::{Field, Tessellation},
    generation::{generate_maze, build_preset_state, GenerationConfig},
    RegionClass, GenerationTiming,
    quality_control::{Issue, QcEvent},
    event_log::{EventLog, DebugTape},
};
use crate::config::{
    GenerateConfig, TessellationType,
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

    let start_id = field.nodes_at(start).first().copied()
        .ok_or_else(|| "start node not found".to_string())?;

    let preset_state = build_preset_state(
        &mut graph, &field,
        &gen_config.preset_connections,
        &gen_config.locked_nodes,
        |x, y| field.all_points().find(|&p| to_xy(p) == (x, y)).expect("preset coordinate must exist on the field"),
        None,
    );

    // QC experiment mode skips the generation algorithm entirely — mirrors `maze-wasm`'s
    // `run_generate` (see `Specs`'s generation-card "QC experiment" mode). The graph built by
    // `build_preset_state` above (preset connections only) is fed straight into `build_maze`.
    if !config.qc_experiment {
        generate_maze(&mut graph, &field, seed, start_id, gen_config, &preset_state);
    }

    let qc_engine = build_qc_and_repair::<T>(config)?;
    let limits = build_repair_limits(config)?;
    let preset_start = config.preset_start.and_then(|[sx, sy]| {
        field.all_points().find(|&p| to_xy(p) == (sx, sy)).and_then(|p| field.nodes_at(p).first().copied())
    });
    let preset_finish = config.preset_finish.and_then(|[fx, fy]| {
        field.all_points().find(|&p| to_xy(p) == (fx, fy)).and_then(|p| field.nodes_at(p).first().copied())
    });
    let repair_preset_state = preset_state.for_repair(config.qc_experiment);
    let mut qc_log = config.debug_events.then(EventLog::new);
    let (maze, remaining_issues, timing) = build_maze(
        field, graph, seed, qc_engine, &repair_preset_state, limits, preset_start, preset_finish,
        qc_log.as_mut(),
    );
    let qc_tape = qc_log.map(EventLog::finish);

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

    Ok(MazeRunResult { remaining_issues, timing, region_sizes, start: start_node, finish: finish_node, graph: maze.graph.clone(), qc_tape })
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
