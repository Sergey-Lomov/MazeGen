pub mod pipeline;

pub(crate) mod vertex_based;
pub(crate) mod wilson;
pub(crate) mod kruskal;
pub(crate) mod recursive_backtracker;
pub(crate) mod edge_based;
mod preset_state;
mod types;
mod edge_ops;
mod mutation_commands;

pub use preset_state::{PresetState, build_preset_state};
pub use recursive_backtracker::{generate as generate_recursive_backtracker, RecursiveBacktrackerEvent};
pub use types::{
    ElementsConfig, GenerationParams, EdgeBasedParams, GenerationAlgorithm,
    PresetConnectionState, TeleportDirection, PresetConnection, NodeLockKind, LockedNode,
    GenerationConfig, GenerationEdge, GenerationStep,
};
pub(crate) use edge_ops::{
    can_connect,
    try_add_edge, try_add_edge_kind, try_add_bidirectional_edge,
    try_add_directed_edge, try_add_directed_teleport, try_add_bidirectional_teleport,
    try_remove_edge, try_remove_edge_by_id, try_remove_teleport_with_reverse,
    bidirectional_edge_feasible, directed_edge_feasible,
};
#[cfg(test)]
pub(crate) use edge_ops::{add_edge, add_edge_kind};
#[allow(unused_imports)]
pub(crate) use mutation_commands::{
    cmd_add_directed_edge, cmd_add_bidirectional_edge, cmd_add_directed_teleport,
    cmd_add_bidirectional_teleport, cmd_remove_edge, cmd_remove_edge_by_id,
    cmd_remove_teleport_with_reverse,
};

use crate::random::MazeRng;
use crate::ids::NodeId;
use crate::graph::Graph;
use crate::space::{Field, Tessellation};
#[cfg(test)]
use crate::graph::EdgeKind;
#[cfg(test)]
use rand::Rng as _;

pub(crate) fn gaussian_weighted_index(len: usize, depth_first: f64, rng: &mut MazeRng) -> usize {
    crate::math::sample_by_position(len, depth_first, rng)
}

pub type StepCallback<'a> = dyn FnMut(&Graph, NodeId, &[NodeId]) + 'a;

fn dispatch<T: Tessellation>(
    graph: &mut Graph,
    field: &Field<T>,
    seed: u64,
    start: NodeId,
    config: GenerationConfig,
    preset_state: &PresetState,
    on_step: Option<&mut StepCallback<'_>>,
) {
    match config.algorithm {
        GenerationAlgorithm::CustomVertexBased(params) =>
            vertex_based::generate(graph, field, seed, start, &params, &config.elements, preset_state, on_step),
        GenerationAlgorithm::CustomEdgeBased(params) =>
            edge_based::generate(graph, field, seed, start, &params, &config.elements, preset_state, on_step),
        GenerationAlgorithm::RecursiveBacktracker =>
            recursive_backtracker::generate(graph, field, seed, start, preset_state, on_step, None),
        GenerationAlgorithm::WilsonAlgorithm =>
            wilson::generate(graph, field, seed, start, preset_state, on_step),
        GenerationAlgorithm::KruskalAlgorithm =>
            kruskal::generate(graph, field, seed, preset_state, on_step),
    }
}

pub fn generate_maze<T: Tessellation>(
    graph: &mut Graph,
    field: &Field<T>,
    seed: u64,
    start: NodeId,
    config: GenerationConfig,
    preset_state: &PresetState,
) {
    dispatch(graph, field, seed, start, config, preset_state, None);
}

pub fn generate_maze_steps<T: Tessellation>(
    graph: &mut Graph,
    field: &Field<T>,
    seed: u64,
    start: NodeId,
    config: GenerationConfig,
    preset_state: &PresetState,
) -> Vec<GenerationStep> {
    let mut steps: Vec<GenerationStep> = Vec::new();
    let mut on_step = |g: &Graph, src: NodeId, active: &[NodeId]| {
        let edges = g.edges().map(|e| GenerationEdge { from: e.from, to: e.to, kind: e.kind.clone() }).collect();
        steps.push(GenerationStep { edges, active_nodes: active.to_vec(), current_src: src });
    };
    dispatch(graph, field, seed, start, config, preset_state, Some(&mut on_step));
    steps
}

/// Runs generation with narration-level event-tree logging (GitHub issue #124). Bypasses
/// [`dispatch`] deliberately: `dispatch` is shared across all five algorithms and must not be
/// tied to one concrete `EventLog<E>` type — only Recursive Backtracker is instrumented so far
/// (see #123), so this matches on the algorithm directly instead of growing `dispatch`'s
/// signature with a type every other branch would have to ignore.
///
/// `collect_steps: true` also collects the legacy `GenerationStep` snapshot trace alongside the
/// event tree — `debug`/`debug_events` are independent flags (see `GenerateConfig`) and callers
/// may enable both at once during the migration off the old snapshot debug tool.
///
/// Returns `None` for any algorithm other than Recursive Backtracker (not instrumented yet).
pub fn generate_maze_with_events<T: Tessellation>(
    graph: &mut Graph,
    field: &Field<T>,
    seed: u64,
    start: NodeId,
    config: GenerationConfig,
    preset_state: &PresetState,
    collect_steps: bool,
) -> (Vec<GenerationStep>, Option<crate::event_log::DebugTape<RecursiveBacktrackerEvent>>) {
    let mut steps: Vec<GenerationStep> = Vec::new();
    let mut on_step = |g: &Graph, src: NodeId, active: &[NodeId]| {
        let edges = g.edges().map(|e| GenerationEdge { from: e.from, to: e.to, kind: e.kind.clone() }).collect();
        steps.push(GenerationStep { edges, active_nodes: active.to_vec(), current_src: src });
    };
    let on_step_opt: Option<&mut StepCallback<'_>> = if collect_steps { Some(&mut on_step) } else { None };

    let tape = if matches!(config.algorithm, GenerationAlgorithm::RecursiveBacktracker) {
        let mut log = crate::event_log::EventLog::new();
        recursive_backtracker::generate(graph, field, seed, start, preset_state, on_step_opt, Some(&mut log));
        Some(log.finish())
    } else {
        dispatch(graph, field, seed, start, config, preset_state, on_step_opt);
        None
    };

    (steps, tape)
}

#[cfg(test)]
pub(crate) mod test_utils {
    use crate::graph::Graph;
    use crate::ids::IdGenerator;
    use crate::space::{Field, SquareTessellation, square_rect};
    use super::ElementsConfig;

    pub fn default_elements() -> ElementsConfig { ElementsConfig { one_way_chance: 0.0, teleport_chance: 0.0, teleport_one_way_chance: 0.0 } }

    pub fn make_field_and_graph(w: usize, h: usize) -> (Field<SquareTessellation>, Graph) {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(w, h), &mut ids).unwrap();
        let mut graph = Graph::new();
        field.build_nodes(&mut graph);
        (field, graph)
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
