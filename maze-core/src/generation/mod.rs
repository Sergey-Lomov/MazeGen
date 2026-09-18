pub mod pipeline;

pub(crate) mod vertex_based;
pub(crate) mod wilson;
pub(crate) mod kruskal;
pub(crate) mod recursive_backtracker;
mod preset_state;
mod preset_setup_event;
mod types;
pub(crate) mod edge_ops;
mod node_ops;
mod mutation_commands;
mod split_pattern;
mod split_logic;
mod split_shared;
mod split_non_pattern;
mod split_pattern_logic;
mod debug_state;

pub use debug_state::DebugGenerationState;

pub use preset_state::{PresetState, build_preset_state};
pub use preset_setup_event::{PresetSetupEvent, PRESET_SETUP_SCOPE_NAME};
pub use recursive_backtracker::{generate as generate_recursive_backtracker, RecursiveBacktrackerEvent, debug_value_names as recursive_backtracker_debug_value_names};
pub use kruskal::{generate as generate_kruskal, KruskalEvent};
pub use wilson::{generate as generate_wilson, WilsonEvent, debug_value_names as wilson_debug_value_names};
pub use vertex_based::{generate as generate_vertex_based, VertexBasedEvent, debug_value_names as vertex_based_debug_value_names};
pub use types::{
    ElementsConfig, GenerationParams, GenerationAlgorithm,
    PresetConnectionState, TeleportDirection, PresetConnection, PresetEndpoint, NodeLockKind, LockedNode,
    VerticalPassageDirection, PresetVerticalPassage, PresetElevator,
    GenerationConfig,
};
pub use split_pattern::{
    SplitFaceRequirement, OneWayDirection, SplitPatternFace, SplitPattern, SplitGenerationConfig,
    validate_split_patterns,
};
pub use split_logic::StartReassignment;
pub(crate) use split_logic::split_is_eligible;
pub(crate) use edge_ops::{
    can_connect, split_aware_neighbors,
    try_add_edge, try_add_edge_kind, try_add_bidirectional_edge,
    try_add_directed_edge, try_add_directed_teleport, try_add_bidirectional_teleport,
    try_add_directed_vertical_passage, try_add_bidirectional_vertical_passage,
    try_add_bidirectional_elevator,
    try_remove_edge, try_remove_edge_by_id, try_remove_edge_with_reverse, try_remove_teleport_with_reverse,
    try_remove_vertical_passage_with_reverse,
    bidirectional_edge_feasible, directed_edge_feasible, add_edge_and_detect_direction,
};
pub(crate) use node_ops::{try_remove_node, remove_node_feasible, try_replace_point_nodes, replace_point_nodes_feasible};
#[cfg(test)]
pub(crate) use edge_ops::{add_edge, add_edge_kind};
pub(crate) use mutation_commands::{
    cmd_add_directed_edge, cmd_add_bidirectional_edge, cmd_add_directed_teleport,
    cmd_add_bidirectional_teleport, cmd_remove_edge_by_id,
};
#[allow(unused_imports)]
pub(crate) use mutation_commands::{cmd_remove_edge, cmd_remove_edge_with_reverse, cmd_remove_teleport_with_reverse, cmd_remove_node};

use crate::random::MazeRng;
use crate::ids::NodeId;
use crate::graph::Graph;
use crate::space::{MultiLevelField, Tessellation};
#[cfg(test)]
use crate::graph::EdgeKind;
#[cfg(test)]
use rand::Rng as _;

pub(crate) fn gaussian_weighted_index(len: usize, depth_first: f64, rng: &mut MazeRng) -> usize {
    crate::math::sample_by_position(len, depth_first, rng)
}

fn dispatch<T: Tessellation>(
    graph: &mut Graph,
    field: &mut MultiLevelField<T>,
    ids: &mut crate::ids::IdGenerator,
    seed: u64,
    start: NodeId,
    config: GenerationConfig,
    preset_state: &PresetState,
) -> Option<StartReassignment> {
    match config.algorithm {
        GenerationAlgorithm::CustomVertexBased(params) => {
            let mut start_reassignment = None;
            vertex_based::generate(
                graph, field, ids, seed, start, &params, &config.elements, &config.split_generation,
                preset_state, &mut start_reassignment, None, None,
            );
            start_reassignment
        }
        GenerationAlgorithm::RecursiveBacktracker => {
            recursive_backtracker::generate(graph, field, seed, start, preset_state, None);
            None
        }
        GenerationAlgorithm::WilsonAlgorithm => {
            wilson::generate(graph, field, seed, start, preset_state, None);
            None
        }
        GenerationAlgorithm::KruskalAlgorithm => {
            kruskal::generate(graph, field, seed, preset_state, None);
            None
        }
    }
}

pub fn generate_maze<T: Tessellation>(
    graph: &mut Graph,
    field: &mut MultiLevelField<T>,
    ids: &mut crate::ids::IdGenerator,
    seed: u64,
    start: NodeId,
    config: GenerationConfig,
    preset_state: &PresetState,
) -> Option<StartReassignment> {
    dispatch(graph, field, ids, seed, start, config, preset_state)
}

/// Result of [`generate_maze_with_events`] — a named struct rather than a growing tuple, since
/// this function is part of the public API `maze-wasm` calls into (unlike the small
/// `run_initial_generation` helper in `maze-wasm/src/runner.rs`, where an internal tuple stays
/// readable).
///
/// `raw_source` is this call's own [`crate::event_log::TapeSource`] — **not** yet passed through
/// [`crate::event_log::merge_tapes`] (GitHub issue #147 changed this: `merge_tapes` used to run
/// inside this function, wrapping the single generation source in a merged root by itself; now
/// that QC/repair instrumentation adds a second, independent source, only the caller that holds
/// *both* sources — `maze-wasm/src/runner.rs::run_generate` — can call `merge_tapes` once, so this
/// function stops doing it and hands back the unmerged piece instead). `event_kind` is the source's
/// `EventedEventKind`, kept alongside rather than folded into a `sources` vec of its own, since
/// there is exactly one of each here by construction — the caller assembles the final multi-source
/// `sources` list itself once it knows how many sources it actually has.
pub struct EventedGenerationResult<T: Tessellation> {
    pub raw_source: crate::event_log::TapeSource,
    pub event_kind: crate::event_log::EventedEventKind,
    /// Every debug-value name (unqualified — qualification with `"{scope_name}:"` only makes sense
    /// once the caller knows the final source count, see [`qualify_debug_value_names`]) and its
    /// rendering kind (GitHub issue #131, e.g. `"recursion_stack"`) the instrumented algorithm
    /// declares — the static list from e.g. `recursive_backtracker::debug_value_names()`, not
    /// derived from what this particular run happened to emit. Empty when the algorithm declares
    /// none.
    pub debug_value_names: Vec<(String, crate::event_log::DebugValueKind)>,
    /// Set only when `CustomVertexBased`'s automatic split-point assignment (GitHub issue #222)
    /// split the run's traversal-seed node — every other algorithm, and every non-reassigning
    /// `CustomVertexBased` run, leaves this `None`.
    pub start_reassignment: Option<StartReassignment>,
    /// Every node minted during this generation call, including ones later removed/replaced by
    /// QC/repair (GitHub issue #271) — only `CustomVertexBased`'s pattern-mode split mints nodes
    /// during generation itself (see `split_logic::mint_split_nodes`'s only caller,
    /// `vertex_based.rs`); every other algorithm leaves this empty. Union with QC/repair's own
    /// mint/removal tracking (`maze-wasm/src/runner.rs::run_generate`) is what lets the debug tape
    /// resolve coordinates for a node no longer in the final `Field`.
    pub all_node_points: Vec<(NodeId, T::Point)>,
}

/// Qualifies debug-value names with their source's scope name when more than one source is
/// present, so two sources independently declaring the same name (e.g. `"visited"` — already
/// reused today by Recursive Backtracker, Wilson, and CustomVertexBased
/// independently, see `Specs/event_log.md`) don't collide once merged. Left unqualified for
/// exactly one source, matching today's names/tests/UI verbatim — qualification only becomes
/// necessary, and only then changes the wire format, once a second source genuinely exists.
pub fn qualify_debug_value_names(
    sources: &[(&'static str, Vec<(&str, crate::event_log::DebugValueKind)>)],
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
/// [`dispatch`] deliberately: `dispatch` is shared across all four algorithms and must not be
/// tied to any concrete `EventLog<E>` type, so this matches on the algorithm directly instead of
/// growing `dispatch`'s signature with a type every other branch would have to ignore. All four
/// generation algorithms are instrumented; each arm builds its own `EventLog<E>`, finishes it, and
/// encodes it to a type-erased [`crate::event_log::EncodedTape`], tagged with
/// [`crate::event_log::EventedEventKind`] (see GitHub issue #161). Since GitHub issue #147, this
/// function no longer calls [`crate::event_log::merge_tapes`] itself — it returns the unmerged
/// [`crate::event_log::TapeSource`], leaving the (now potentially multi-source) merge to its
/// caller (`maze-wasm/src/runner.rs::run_generate`).
pub fn generate_maze_with_events<T: Tessellation>(
    graph: &mut Graph,
    field: &mut MultiLevelField<T>,
    ids: &mut crate::ids::IdGenerator,
    seed: u64,
    start: NodeId,
    config: GenerationConfig,
    preset_state: &PresetState,
) -> EventedGenerationResult<T> {
    let mut start_reassignment = None;
    let mut debug_state = debug_state::DebugGenerationState::<T>::new();
    let (scope_name, event_kind, tape, debug_value_names): (
        &'static str,
        crate::event_log::EventedEventKind,
        crate::event_log::EncodedTape,
        &'static [(&'static str, crate::event_log::DebugValueKind)],
    ) = match config.algorithm {
        GenerationAlgorithm::RecursiveBacktracker => {
            let mut log = crate::event_log::EventLog::new();
            recursive_backtracker::generate(graph, field, seed, start, preset_state, Some(&mut log));
            (
                "generation",
                crate::event_log::EventedEventKind::RecursiveBacktracker,
                log.finish().encode(),
                recursive_backtracker::debug_value_names(),
            )
        }
        GenerationAlgorithm::KruskalAlgorithm => {
            let mut log = crate::event_log::EventLog::new();
            kruskal::generate(graph, field, seed, preset_state, Some(&mut log));
            ("generation", crate::event_log::EventedEventKind::Kruskal, log.finish().encode(), &[])
        }
        GenerationAlgorithm::WilsonAlgorithm => {
            let mut log = crate::event_log::EventLog::new();
            wilson::generate(graph, field, seed, start, preset_state, Some(&mut log));
            ("generation", crate::event_log::EventedEventKind::Wilson, log.finish().encode(), wilson::debug_value_names())
        }
        GenerationAlgorithm::CustomVertexBased(params) => {
            let mut log = crate::event_log::EventLog::new();
            vertex_based::generate(
                graph, field, ids, seed, start, &params, &config.elements, &config.split_generation,
                preset_state, &mut start_reassignment, Some(&mut log), Some(&mut debug_state),
            );
            ("generation", crate::event_log::EventedEventKind::VertexBased, log.finish().encode(), vertex_based::debug_value_names())
        }
    };

    EventedGenerationResult {
        raw_source: crate::event_log::TapeSource { scope_name, tape },
        event_kind,
        debug_value_names: debug_value_names.iter().map(|(name, kind)| (name.to_string(), *kind)).collect(),
        start_reassignment,
        all_node_points: debug_state.all_node_points().collect(),
    }
}

#[cfg(test)]
pub(crate) mod test_utils {
    use crate::graph::Graph;
    use crate::ids::IdGenerator;
    use crate::space::{MultiLevelField, SquareTessellation, square_rect};
    use super::ElementsConfig;

    pub fn default_elements() -> ElementsConfig { ElementsConfig { one_way_chance: 0.0, teleport_chance: 0.0, teleport_one_way_chance: 0.0, split_chance: 0.0, ..Default::default() } }

    pub fn make_field_and_graph(w: usize, h: usize) -> (MultiLevelField<SquareTessellation>, Graph) {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(w, h), &mut ids).unwrap();
        let mut graph = Graph::new();
        for node in field.all_node_ids() { graph.add_node(node); }
        (field, graph)
    }

    /// Same as `make_field_and_graph`, but also hands back the `IdGenerator` used to build the
    /// field — needed by any test calling `vertex_based::generate` directly, since it now takes
    /// `&mut IdGenerator` for the split-node-minting path (GitHub issue #222).
    pub fn make_field_graph_ids(w: usize, h: usize) -> (MultiLevelField<SquareTessellation>, Graph, IdGenerator) {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(w, h), &mut ids).unwrap();
        let mut graph = Graph::new();
        for node in field.all_node_ids() { graph.add_node(node); }
        (field, graph, ids)
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
