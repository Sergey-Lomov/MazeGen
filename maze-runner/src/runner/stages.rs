use super::prepare::Prepared;
use super::{build_qc_and_repair, preset_endpoint_dto_to_core};
use crate::config::{GenerateConfig, build_repair_limits};
use maze_core::{
    GenerationTiming, Maze,
    event_log::EventLog,
    generation::{
        GenerationConfig, PresetState, StartReassignment, build_preset_state, generate_maze,
        pipeline::{build_maze, now_ms},
    },
    graph::Graph,
    ids::{IdGenerator, NodeId},
    quality_control::{Issue, QcEvent},
    random::MazeRng,
    space::{MultiLevelField, Tessellation},
};
use rand::SeedableRng;

/// The pipeline state right before generation: the field, the graph holding every node plus the
/// preset connections, the resolved presets, and the generation start node. Every later stage
/// (generation, QC, repair) starts from here.
pub struct Seeded<T: Tessellation> {
    pub seed: u64,
    pub field: MultiLevelField<T>,
    pub graph: Graph,
    pub ids: IdGenerator,
    pub preset_state: PresetState,
    pub start_id: NodeId,
    pub gen_config: GenerationConfig,
    pub point_from_xy: fn(i32, i32) -> T::Point,
    pub point_to_xy: fn(T::Point) -> (i32, i32),
}

/// Validates split patterns, adds every field node to a fresh graph, applies presets and resolves
/// the generation start node.
pub fn seed_graph<T: Tessellation>(
    prepared: Prepared<T>,
    config: &GenerateConfig,
) -> Result<Seeded<T>, String> {
    let Prepared {
        seed,
        mut field,
        mut ids,
        start,
        gen_config,
        point_from_xy,
        point_to_xy,
    } = prepared;

    let degree = field.tessellation().faces().len();
    maze_core::generation::validate_split_patterns(&gen_config.split_generation.patterns, degree)?;

    let mut graph = Graph::new();
    for node in field.all_node_ids() {
        graph.add_node(node);
    }

    let preset_state = build_preset_state(
        &mut graph,
        &mut field,
        &mut ids,
        &gen_config.preset_connections,
        &gen_config.preset_vertical_passages,
        &gen_config.preset_elevators,
        &gen_config.locked_nodes,
        &gen_config.split_points,
        point_from_xy,
        None,
        None,
    )?;

    // `start_id` re-resolves the same gen_source marker `resolve_start` already used to pick
    // `start` geometrically, but now against `PresetState` — a slot-addressed gen_source needs
    // the split node `build_preset_state` just created above, which `resolve_start` (geometry
    // only, no `Field`/`NodeId` access) can't have resolved on its own.
    let level = field.single_level_id();
    let start_id = config
        .preset_gen_source
        .as_ref()
        .and_then(|dto| {
            preset_state.resolve_endpoint(&field, point_from_xy, preset_endpoint_dto_to_core(dto))
        })
        .or_else(|| field.nodes_at(level, start).first().copied())
        .ok_or_else(|| "start node not found".to_string())?;

    Ok(Seeded {
        seed,
        field,
        graph,
        ids,
        preset_state,
        start_id,
        gen_config,
        point_from_xy,
        point_to_xy,
    })
}

/// Runs the configured generation algorithm on `seeded` in place. QC experiment mode skips the
/// generation algorithm entirely — mirrors `maze-wasm`'s `run_generate` (see `Specs`'s
/// generation-card "QC experiment" mode): the graph built by `seed_graph` (preset connections
/// only) is fed straight into QC/repair.
pub fn run_generation<T: Tessellation>(
    seeded: &mut Seeded<T>,
    config: &GenerateConfig,
) -> Option<StartReassignment> {
    if config.qc_experiment {
        return None;
    }
    generate_maze(
        &mut seeded.graph,
        &mut seeded.field,
        &mut seeded.ids,
        seeded.seed,
        seeded.start_id,
        seeded.gen_config.clone(),
        &seeded.preset_state,
    )
}

/// The node each explicit `preset_start`/`preset_finish` marker resolves to, if any — the user's
/// pinned choice, distinct from a generator-chosen endpoint.
fn pinned_endpoints<T: Tessellation>(
    seeded: &Seeded<T>,
    config: &GenerateConfig,
) -> (Option<NodeId>, Option<NodeId>) {
    let resolve = |dto: &crate::config::PresetEndpointDto| {
        seeded.preset_state.resolve_endpoint(
            &seeded.field,
            seeded.point_from_xy,
            preset_endpoint_dto_to_core(dto),
        )
    };
    (
        config.preset_start.as_ref().and_then(resolve),
        config.preset_finish.as_ref().and_then(resolve),
    )
}

/// Output of `run_repair`: the repaired maze, the issues still open after repair, the QC timing
/// tree, and the preset state repair ran against (needed to resolve issue payloads).
pub struct Repaired<T: Tessellation> {
    pub maze: Maze<T>,
    pub remaining_issues: Vec<Box<dyn Issue>>,
    pub timing: GenerationTiming,
    pub preset_state: PresetState,
}

/// Runs the configured QC stages with repair on `seeded`'s graph (`build_maze`).
pub fn run_repair<T: Tessellation + 'static>(
    mut seeded: Seeded<T>,
    config: &GenerateConfig,
    start_reassignment: Option<StartReassignment>,
    qc_log: Option<&mut EventLog<QcEvent>>,
) -> Result<Repaired<T>, String> {
    let qc_engine = build_qc_and_repair::<T>(config)?;
    let limits = build_repair_limits(config)?;
    // Recorded on `PresetState` so the issue-payload resolver can flag a pinned `start`/`finish`
    // element `preset_locked` (GitHub issue #376 follow-up).
    let (pinned_start, pinned_finish) = pinned_endpoints(&seeded, config);
    seeded.preset_state.preset_start = pinned_start;
    seeded.preset_state.preset_finish = pinned_finish;

    // A split hit on the traversal-seed node reassigns `start_id` mid-run (GitHub issue #222) —
    // only honored when there's no explicit `preset_start` pinning a human's fixed choice.
    let preset_start = pinned_start.or_else(|| start_reassignment.map(|r| r.reassigned_to));
    let preset_state = seeded.preset_state.for_repair(config.qc_experiment);
    let (maze, remaining_issues, timing) = build_maze(
        seeded.field,
        seeded.graph,
        seeded.seed,
        qc_engine,
        &preset_state,
        limits,
        preset_start,
        pinned_finish,
        qc_log,
        None,
    );
    Ok(Repaired {
        maze,
        remaining_issues,
        timing,
        preset_state,
    })
}

/// Output of `run_check_only`: the unchanged maze the checks ran on and every issue they report.
pub struct Checked<T: Tessellation> {
    pub maze: Maze<T>,
    pub issues: Vec<Box<dyn Issue>>,
}

/// Runs every configured check once on a copy of `seeded`'s graph, without repair — the QC half
/// of the pipeline in isolation.
pub fn run_check_only<T: Tessellation + 'static>(
    seeded: &Seeded<T>,
    config: &GenerateConfig,
) -> Result<Checked<T>, String> {
    let qc_engine = build_qc_and_repair::<T>(config)?;
    let (pinned_start, pinned_finish) = pinned_endpoints(seeded, config);
    let mut maze = Maze::new(seeded.field.clone(), seeded.graph.clone());
    maze.meta.start = pinned_start;
    maze.meta.finish = pinned_finish;
    let mut rng = MazeRng::seed_from_u64(seeded.seed);
    let issues = qc_engine.run_check_only(&maze, &mut rng, now_ms);
    Ok(Checked { maze, issues })
}
