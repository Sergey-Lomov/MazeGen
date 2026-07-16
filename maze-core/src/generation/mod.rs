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
/// `tape` is always the output of [`crate::event_log::merge_tapes`] (GitHub issue #169) — even
/// when there is exactly one instrumented source (every case today; QC/repair instrumentation,
/// issue #147, will add a second), the tape is still wrapped in a merged root + one dedicated
/// top-level source scope. There is no "skip merging for a single source" special case, so every
/// consumer sees the same tree shape regardless of how many sources actually ran. Never absent —
/// `generate_maze_with_events` is the only constructor and every algorithm arm produces a tape,
/// so this is a plain [`crate::event_log::EncodedTape`], not an `Option`; a caller that needs to
/// conditionally discard it (e.g. `maze-wasm/src/runner.rs`, when the web replay engine can't
/// decode this event kind) wraps it in its own `Option` rather than this type carrying one it can
/// never actually leave unset. `sources` records, per top-level scope (in the same order as the
/// merged tree's top-level children), which concrete event enum that subtree was encoded from —
/// the only source of truth a consumer (e.g. the web replay engine) needs to pick a decoder per
/// source scope, instead of re-deriving "is this decodable" from the generation algorithm.
pub struct EventedGenerationResult {
    pub tape: crate::event_log::EncodedTape,
    /// One entry per top-level source scope present in `tape`, in the same order — never empty,
    /// mirroring `tape`'s own "always present" guarantee. `merge_tapes` itself is domain-agnostic
    /// and doesn't see `EventedEventKind` at all; this pairing is assembled here, the one place
    /// that both knows which algorithm ran and calls `merge_tapes`.
    pub sources: Vec<(&'static str, crate::event_log::EventedEventKind)>,
    /// Intermediate snapshot checkpoints (GitHub issue #128), already folded into one combined
    /// table by `merge_tapes` — `Some` exactly when at least one source produced any (today: only
    /// Recursive Backtracker). `None` when no source produced checkpoints.
    pub checkpoints: Option<crate::event_log::EncodedCheckpoints>,
    /// Every debug-value name (already qualified with `"{scope_name}:"` when more than one source
    /// is present — see [`qualify_debug_value_names`]) and its rendering kind (GitHub issue #131,
    /// e.g. `"recursion_stack"`) the instrumented algorithm(s) declare — the static list(s) from
    /// e.g. `recursive_backtracker::debug_value_names()`, not derived from what this particular
    /// run happened to emit. Empty when no source declares any.
    pub debug_value_names: Vec<(String, crate::event_log::DebugValueKind)>,
}

/// Qualifies debug-value names with their source's scope name when more than one source is
/// present, so two sources independently declaring the same name (e.g. `"visited"` — already
/// reused today by Recursive Backtracker, Wilson, CustomEdgeBased, and CustomVertexBased
/// independently, see `Specs/event_log.md`) don't collide once merged. Left unqualified for
/// exactly one source, matching today's names/tests/UI verbatim — qualification only becomes
/// necessary, and only then changes the wire format, once a second source genuinely exists.
fn qualify_debug_value_names(
    sources: &[(&'static str, Vec<(&'static str, crate::event_log::DebugValueKind)>)],
) -> Vec<(String, crate::event_log::DebugValueKind)> {
    if sources.len() <= 1 {
        return sources.iter().flat_map(|(_, names)| names.iter().map(|(name, kind)| (name.to_string(), *kind))).collect();
    }
    sources
        .iter()
        .flat_map(|(scope_name, names)| names.iter().map(move |(name, kind)| (format!("{scope_name}:{name}"), *kind)))
        .collect()
}

/// Runs generation with narration-level event-tree logging (GitHub issue #124). Bypasses
/// [`dispatch`] deliberately: `dispatch` is shared across all five algorithms and must not be
/// tied to any concrete `EventLog<E>` type, so this matches on the algorithm directly instead of
/// growing `dispatch`'s signature with a type every other branch would have to ignore. All five
/// generation algorithms are instrumented; each arm builds its own `EventLog<E>`, finishes it, and
/// encodes it to a type-erased [`crate::event_log::EncodedTape`], tagged with
/// [`crate::event_log::EventedEventKind`] (see GitHub issue #161) — this function is the single
/// place that calls [`crate::event_log::merge_tapes`] (GitHub issue #169) to fold the (today:
/// always exactly one) instrumented source into the merged tree `EventedGenerationResult.tape`
/// always carries.
pub fn generate_maze_with_events<T: Tessellation>(
    graph: &mut Graph,
    field: &Field<T>,
    seed: u64,
    start: NodeId,
    config: GenerationConfig,
    preset_state: &PresetState,
) -> EventedGenerationResult {
    let (scope_name, event_kind, tape, checkpoints, debug_value_names): (
        &'static str,
        crate::event_log::EventedEventKind,
        crate::event_log::EncodedTape,
        Option<crate::event_log::EncodedCheckpoints>,
        &'static [(&'static str, crate::event_log::DebugValueKind)],
    ) = match config.algorithm {
        GenerationAlgorithm::RecursiveBacktracker => {
            let mut log = crate::event_log::EventLog::new();
            let mut checkpoint_log = crate::event_log::CheckpointLog::new();
            recursive_backtracker::generate(graph, field, seed, start, preset_state, Some(&mut log), Some(&mut checkpoint_log));
            (
                "generation",
                crate::event_log::EventedEventKind::RecursiveBacktracker,
                log.finish().encode(),
                Some(checkpoint_log.encode()),
                recursive_backtracker::debug_value_names(),
            )
        }
        GenerationAlgorithm::KruskalAlgorithm => {
            let mut log = crate::event_log::EventLog::new();
            kruskal::generate(graph, field, seed, preset_state, Some(&mut log));
            ("generation", crate::event_log::EventedEventKind::Kruskal, log.finish().encode(), None, &[])
        }
        GenerationAlgorithm::WilsonAlgorithm => {
            let mut log = crate::event_log::EventLog::new();
            wilson::generate(graph, field, seed, start, preset_state, Some(&mut log));
            ("generation", crate::event_log::EventedEventKind::Wilson, log.finish().encode(), None, wilson::debug_value_names())
        }
        GenerationAlgorithm::CustomEdgeBased(params) => {
            let mut log = crate::event_log::EventLog::new();
            edge_based::generate(graph, field, seed, start, &params, &config.elements, preset_state, Some(&mut log));
            ("generation", crate::event_log::EventedEventKind::EdgeBased, log.finish().encode(), None, edge_based::debug_value_names())
        }
        GenerationAlgorithm::CustomVertexBased(params) => {
            let mut log = crate::event_log::EventLog::new();
            vertex_based::generate(graph, field, seed, start, &params, &config.elements, preset_state, Some(&mut log));
            ("generation", crate::event_log::EventedEventKind::VertexBased, log.finish().encode(), None, vertex_based::debug_value_names())
        }
    };

    let (merged_tape, merged_checkpoints) = crate::event_log::merge_tapes(vec![
        crate::event_log::TapeSource { scope_name, tape, checkpoints },
    ]);
    let debug_value_names = qualify_debug_value_names(&[(scope_name, debug_value_names.to_vec())]);

    EventedGenerationResult {
        tape: merged_tape,
        sources: vec![(scope_name, event_kind)],
        checkpoints: merged_checkpoints,
        debug_value_names,
    }
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
