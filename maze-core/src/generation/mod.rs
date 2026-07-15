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
pub use recursive_backtracker::{generate as generate_recursive_backtracker, RecursiveBacktrackerEvent, debug_value_names as recursive_backtracker_debug_value_names};
pub use kruskal::{generate as generate_kruskal, KruskalEvent};
pub use wilson::{generate as generate_wilson, WilsonEvent, debug_value_names as wilson_debug_value_names};
pub use edge_based::{generate as generate_edge_based, EdgeBasedEvent, debug_value_names as edge_based_debug_value_names};
pub use vertex_based::{generate as generate_vertex_based, VertexBasedEvent, debug_value_names as vertex_based_debug_value_names};
pub use types::{
    ElementsConfig, GenerationParams, EdgeBasedParams, GenerationAlgorithm,
    PresetConnectionState, TeleportDirection, PresetConnection, NodeLockKind, LockedNode,
    GenerationConfig,
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

fn dispatch<T: Tessellation>(
    graph: &mut Graph,
    field: &Field<T>,
    seed: u64,
    start: NodeId,
    config: GenerationConfig,
    preset_state: &PresetState,
) {
    match config.algorithm {
        GenerationAlgorithm::CustomVertexBased(params) =>
            vertex_based::generate(graph, field, seed, start, &params, &config.elements, preset_state, None),
        GenerationAlgorithm::CustomEdgeBased(params) =>
            edge_based::generate(graph, field, seed, start, &params, &config.elements, preset_state, None),
        GenerationAlgorithm::RecursiveBacktracker =>
            recursive_backtracker::generate(graph, field, seed, start, preset_state, None, None),
        GenerationAlgorithm::WilsonAlgorithm =>
            wilson::generate(graph, field, seed, start, preset_state, None),
        GenerationAlgorithm::KruskalAlgorithm =>
            kruskal::generate(graph, field, seed, preset_state, None),
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
    dispatch(graph, field, seed, start, config, preset_state);
}

/// Result of [`generate_maze_with_events`] — a named struct rather than a growing tuple, since
/// this function is part of the public API `maze-wasm` calls into (unlike the small
/// `run_initial_generation` helper in `maze-wasm/src/runner.rs`, where an internal tuple stays
/// readable).
///
/// `tape` is already erased to [`crate::event_log::EncodedTape`] (GitHub issue #161) — each
/// instrumented algorithm builds its own concrete `EventLog<E>`/`DebugTape<E>` internally and
/// encodes it before returning, so no single concrete event type has to be baked into this shared
/// struct. `event_kind` is the only source of truth for which concrete event enum `tape` came
/// from; any consumer that only understands some event kinds (e.g. the web replay engine, which
/// only decodes Recursive Backtracker's wire tags so far) must filter on `event_kind` rather than
/// re-deriving "is this decodable" from the generation algorithm.
pub struct EventedGenerationResult {
    pub tape: Option<crate::event_log::EncodedTape>,
    /// `Some` exactly when `tape` is `Some` — tags which concrete event enum `tape` was encoded
    /// from.
    pub event_kind: Option<crate::event_log::EventedEventKind>,
    /// Intermediate snapshot checkpoints (GitHub issue #128) — `Some` exactly when `tape` is
    /// `Some` (both come from the same run, or neither does). Not yet wired up for Kruskal.
    pub checkpoints: Option<crate::event_log::CheckpointLog>,
    /// Every debug-value name and its rendering kind (GitHub issue #131, e.g. `"recursion_stack"`)
    /// the instrumented algorithm declares — the static list from
    /// `recursive_backtracker::debug_value_names()`, not derived from what this particular run
    /// happened to emit. Empty for any algorithm that doesn't declare debug values (not
    /// instrumented for this yet, e.g. Kruskal).
    pub debug_value_names: &'static [(&'static str, crate::event_log::DebugValueKind)],
}

/// Runs generation with narration-level event-tree logging (GitHub issue #124). Bypasses
/// [`dispatch`] deliberately: `dispatch` is shared across all five algorithms and must not be
/// tied to any concrete `EventLog<E>` type, so this matches on the algorithm directly instead of
/// growing `dispatch`'s signature with a type every other branch would have to ignore. Recursive
/// Backtracker (#123) and Kruskal (#146) are instrumented so far; each arm builds its own
/// `EventLog<E>`, finishes it, and encodes it to a type-erased [`crate::event_log::EncodedTape`]
/// before returning, tagged with [`crate::event_log::EventedEventKind`] (see GitHub issue #161).
///
/// `tape`/`event_kind`/`checkpoints` are `None` for any algorithm that isn't instrumented.
pub fn generate_maze_with_events<T: Tessellation>(
    graph: &mut Graph,
    field: &Field<T>,
    seed: u64,
    start: NodeId,
    config: GenerationConfig,
    preset_state: &PresetState,
) -> EventedGenerationResult {
    let (tape, event_kind, checkpoints, debug_value_names) = match config.algorithm {
        GenerationAlgorithm::RecursiveBacktracker => {
            let mut log = crate::event_log::EventLog::new();
            let mut checkpoint_log = crate::event_log::CheckpointLog::new();
            recursive_backtracker::generate(graph, field, seed, start, preset_state, Some(&mut log), Some(&mut checkpoint_log));
            (
                Some(log.finish().encode()),
                Some(crate::event_log::EventedEventKind::RecursiveBacktracker),
                Some(checkpoint_log),
                recursive_backtracker::debug_value_names(),
            )
        }
        GenerationAlgorithm::KruskalAlgorithm => {
            let mut log = crate::event_log::EventLog::new();
            kruskal::generate(graph, field, seed, preset_state, Some(&mut log));
            (
                Some(log.finish().encode()),
                Some(crate::event_log::EventedEventKind::Kruskal),
                None,
                &[] as &[(&str, crate::event_log::DebugValueKind)],
            )
        }
        GenerationAlgorithm::WilsonAlgorithm => {
            let mut log = crate::event_log::EventLog::new();
            wilson::generate(graph, field, seed, start, preset_state, Some(&mut log));
            (
                Some(log.finish().encode()),
                Some(crate::event_log::EventedEventKind::Wilson),
                None,
                wilson::debug_value_names(),
            )
        }
        GenerationAlgorithm::CustomEdgeBased(params) => {
            let mut log = crate::event_log::EventLog::new();
            edge_based::generate(graph, field, seed, start, &params, &config.elements, preset_state, Some(&mut log));
            (
                Some(log.finish().encode()),
                Some(crate::event_log::EventedEventKind::EdgeBased),
                None,
                edge_based::debug_value_names(),
            )
        }
        GenerationAlgorithm::CustomVertexBased(params) => {
            let mut log = crate::event_log::EventLog::new();
            vertex_based::generate(graph, field, seed, start, &params, &config.elements, preset_state, Some(&mut log));
            (
                Some(log.finish().encode()),
                Some(crate::event_log::EventedEventKind::VertexBased),
                None,
                vertex_based::debug_value_names(),
            )
        }
    };

    EventedGenerationResult { tape, event_kind, checkpoints, debug_value_names }
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
