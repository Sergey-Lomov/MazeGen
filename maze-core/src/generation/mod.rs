pub mod pipeline;

pub(crate) mod vertex_based;
pub(crate) mod wilson;
pub(crate) mod kruskal;
pub(crate) mod recursive_backtracker;
pub(crate) mod edge_based;
mod preset_state;

pub use preset_state::{PresetState, build_preset_state};

use crate::random::MazeRng;
use rand::{Rng, SeedableRng};
use crate::ids::NodeId;
use crate::graph::{Graph, EdgeKind};
use crate::space::{Field, Tessellation};

#[derive(Debug, Clone)]
pub struct ElementsConfig {
    pub one_way_chance: f64,
    /// Probability that, at each edge-addition opportunity `advance` handles, the edge is a
    /// teleport instead of a normal (geometrically-adjacent) connection.
    pub teleport_chance: f64,
    /// Probability that an added teleport is one-way rather than two-way. Only consulted when
    /// `teleport_chance` already hit — mirrors `one_way_chance`'s role but scoped to teleports.
    pub teleport_one_way_chance: f64,
}

impl Default for ElementsConfig {
    fn default() -> Self {
        ElementsConfig { one_way_chance: 0.04, teleport_chance: 0.0, teleport_one_way_chance: 0.0 }
    }
}

#[derive(Debug, Clone)]
pub struct GenerationParams {
    pub depth_first:     f64,
    pub corridor_chance: f64,
    pub branching:       f64,
    pub directionality:  f64,
    pub cyclicity:       f64,
}

impl Default for GenerationParams {
    fn default() -> Self {
        GenerationParams {
            depth_first:     0.9,
            corridor_chance: 0.7,
            branching:       0.5,
            directionality:  0.0,
            cyclicity:       0.0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct EdgeBasedParams {
    pub corridor_length: f64,
    pub branching:       f64,
    pub depth_first:     f64,
    pub directionality:  f64,
    pub cyclicity:       f64,
}

impl Default for EdgeBasedParams {
    fn default() -> Self {
        EdgeBasedParams {
            corridor_length: 0.5,
            branching:       0.5,
            depth_first:     0.5,
            directionality:  0.0,
            cyclicity:       0.0,
        }
    }
}

#[derive(Debug, Clone)]
pub enum GenerationAlgorithm {
    CustomVertexBased(GenerationParams),
    CustomEdgeBased(EdgeBasedParams),
    RecursiveBacktracker,
    WilsonAlgorithm,
    KruskalAlgorithm,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PresetConnectionState {
    Wall,
    Passage,
    OneWayForward,
    OneWayBackward,
    Teleport(TeleportDirection),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeleportDirection {
    Forward,
    Backward,
    TwoWay,
}

#[derive(Debug, Clone)]
pub struct PresetConnection {
    pub from: (i32, i32),
    pub to:   (i32, i32),
    pub state: PresetConnectionState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeLockKind {
    In,
    Out,
    Both,
}

#[derive(Debug, Clone)]
pub struct LockedNode {
    pub point: (i32, i32),
    pub kind:  NodeLockKind,
}

#[derive(Debug, Clone)]
pub struct GenerationConfig {
    pub algorithm:          GenerationAlgorithm,
    pub elements:           ElementsConfig,
    pub preset_connections: Vec<PresetConnection>,
    pub locked_nodes:       Vec<LockedNode>,
}

impl Default for GenerationConfig {
    fn default() -> Self {
        GenerationConfig {
            algorithm:          GenerationAlgorithm::CustomVertexBased(GenerationParams::default()),
            elements:           ElementsConfig::default(),
            preset_connections: vec![],
            locked_nodes:       vec![],
        }
    }
}

#[derive(Debug, Clone)]
pub struct GenerationEdge {
    pub from: NodeId,
    pub to:   NodeId,
    pub kind: EdgeKind,
}

#[derive(Debug, Clone)]
pub struct GenerationStep {
    pub edges:        Vec<GenerationEdge>,
    pub active_nodes: Vec<NodeId>,
    pub current_src:  NodeId,
}

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
    mut on_step: Option<&mut StepCallback<'_>>,
) {
    match config.algorithm {
        GenerationAlgorithm::CustomVertexBased(params) =>
            vertex_based::generate(graph, field, seed, start, &params, &config.elements, preset_state, on_step),
        GenerationAlgorithm::CustomEdgeBased(params) =>
            edge_based::generate(graph, field, seed, start, &params, &config.elements, preset_state, on_step),
        GenerationAlgorithm::RecursiveBacktracker =>
            recursive_backtracker::generate(graph, field, seed, start, preset_state, on_step),
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

// One-way edges consume two RNG samples (one for the chance check, one for direction),
// while bidirectional edges consume only one. This means maze topology differs between
// runs with `one_way_chance` > 0 and runs with `one_way_chance` == 0, even at the same seed.
// `kind`/`one_way_chance` are caller-supplied so this same sample-consumption contract applies
// identically whether `kind` is `Basic` (driven by `elements.one_way_chance`) or `Teleport`
// (driven by `elements.teleport_one_way_chance`) — there is no kind-specific special-casing here.
pub(crate) fn add_edge_kind(graph: &mut Graph, src: NodeId, dst: NodeId, kind: EdgeKind, one_way_chance: f64, rng: &mut MazeRng) {
    if rng.random::<f64>() < one_way_chance {
        if rng.random::<bool>() {
            graph.add_edge(src, dst, kind);
        } else {
            graph.add_edge(dst, src, kind);
        }
    } else {
        graph.add_bidirectional_edge(src, dst, kind);
    }
}

pub(crate) fn add_edge(graph: &mut Graph, src: NodeId, dst: NodeId, elements: &ElementsConfig, rng: &mut MazeRng) {
    add_edge_kind(graph, src, dst, EdgeKind::Basic, elements.one_way_chance, rng);
}

/// Returns true if the algorithm is allowed to add an edge src→dst (at least one direction).
pub(crate) fn can_connect(src: NodeId, dst: NodeId, preset_state: &PresetState) -> bool {
    if preset_state.locked_out.contains(&src) && preset_state.locked_out.contains(&dst) { return false; }
    if preset_state.locked_in.contains(&src)  && preset_state.locked_in.contains(&dst)  { return false; }
    let fwd_blocked = preset_state.blocked.contains(&(src, dst))
        || preset_state.locked_out.contains(&src)
        || preset_state.locked_in.contains(&dst);
    let bwd_blocked = preset_state.blocked.contains(&(dst, src))
        || preset_state.locked_out.contains(&dst)
        || preset_state.locked_in.contains(&src);
    !(fwd_blocked && bwd_blocked)
}

/// try_add_edge_kind: respects PresetState constraints before delegating to add_edge_kind.
/// Same contract as `try_add_edge`, but lets the caller pick `kind` and the one-way chance to
/// use — the mechanism `try_add_edge` uses for `Basic` edges with `elements.one_way_chance`
/// applies identically to `Teleport` edges with `elements.teleport_one_way_chance`.
pub(crate) fn try_add_edge_kind(
    graph: &mut Graph,
    src: NodeId,
    dst: NodeId,
    kind: EdgeKind,
    one_way_chance: f64,
    preset_state: &PresetState,
    rng: &mut MazeRng,
) {
    if preset_state.locked_out.contains(&src) { return; }
    if preset_state.locked_in.contains(&dst)  { return; }
    if preset_state.blocked.contains(&(src, dst)) { return; }

    // For one_way_chance: if reverse direction is also blocked, force forward only.
    let reverse_blocked = preset_state.blocked.contains(&(dst, src))
        || preset_state.locked_out.contains(&dst)
        || preset_state.locked_in.contains(&src);

    if reverse_blocked {
        // Can only go src→dst
        graph.add_edge(src, dst, kind);
        // Still consume RNG samples to preserve seed parity with normal add_edge_kind.
        let _ = rng.random::<f64>();
        let _ = rng.random::<bool>();
    } else {
        add_edge_kind(graph, src, dst, kind, one_way_chance, rng);
    }
}

/// try_add_edge: respects PresetState constraints before delegating to add_edge.
/// Returns true if the edge was added (at least one direction).
pub(crate) fn try_add_edge(
    graph: &mut Graph,
    src: NodeId,
    dst: NodeId,
    elements: &ElementsConfig,
    preset_state: &PresetState,
    rng: &mut MazeRng,
) {
    try_add_edge_kind(graph, src, dst, EdgeKind::Basic, elements.one_way_chance, preset_state, rng);
}

/// try_add_bidirectional_edge: strict "both directions free, or skip the pair" connect for
/// repair strategies (`MissingLoopsRandomStrategy`, `ExpandRegionPassageStrategy`) that need a
/// full passage, not the base-generation `try_add_edge` one_way_chance coin flip. Completion-
/// aware: if one direction already exists (e.g. a preset one-way edge), only the missing
/// direction is added rather than duplicating. Returns true if at least one direction was added
/// or both were already present (i.e. the pair ends up as a full passage); false if either
/// direction is blocked by `preset_state`, in which case nothing is mutated.
pub(crate) fn try_add_bidirectional_edge(
    graph: &mut Graph,
    a: NodeId,
    b: NodeId,
    preset_state: &PresetState,
) -> bool {
    let fwd_blocked = preset_state.blocked.contains(&(a, b))
        || preset_state.locked_out.contains(&a)
        || preset_state.locked_in.contains(&b);
    let bwd_blocked = preset_state.blocked.contains(&(b, a))
        || preset_state.locked_out.contains(&b)
        || preset_state.locked_in.contains(&a);
    if fwd_blocked || bwd_blocked {
        return false;
    }
    if graph.edge_between(a, b).is_none() {
        graph.add_edge(a, b, EdgeKind::Basic);
    }
    if graph.edge_between(b, a).is_none() {
        graph.add_edge(b, a, EdgeKind::Basic);
    }
    true
}

/// try_remove_edge: respects PresetState before removing a directed edge.
/// Returns true if the edge was removed, false if it is protected by a preset connection.
pub(crate) fn try_remove_edge(
    graph: &mut Graph,
    from: NodeId,
    to: NodeId,
    preset_state: &PresetState,
) -> bool {
    if preset_state.preset_edges.contains(&(from, to)) {
        return false;
    }
    let Some(id) = graph.edge_between(from, to) else { return false; };
    graph.remove_edge(id);
    true
}

/// try_remove_edge_by_id: removes a specific edge by its `EdgeId`, respecting PresetState.
/// Unlike `try_remove_edge`, never looks the edge up by node pair — `Graph::edge_between`
/// returns an arbitrary edge of any kind between a pair, which would risk removing the wrong
/// one when a `Teleport` and a `Basic` edge coexist in the same direction (see `EdgeKind`'s
/// parallel-edges note). Used by strategies that already hold the exact `EdgeId` to remove
/// (e.g. `RemoveTeleportStrategy`, from `IssueData::InvalidTeleports`).
///
/// `preset_edges` is keyed purely by `(from, to)` node pairs, with no `EdgeKind` — it only ever
/// gets populated from preset Passage/OneWay connections, which always build `EdgeKind::Basic`
/// edges (see `preset_state.rs`/`Specs/post-edit.md`). A `Teleport` edge can never itself be a
/// preset connection, so checking `preset_edges` for a `Teleport` id would be a false-positive
/// protection: a `Teleport` duplicating a preset `Basic` connection between the same pair would
/// never be removable, since the pair's `(from, to)` is in `preset_edges` on the `Basic` edge's
/// behalf. Only a `Basic` edge is ever subject to this protection.
/// Returns true if the edge was removed, false if it doesn't exist or is preset-protected.
pub(crate) fn try_remove_edge_by_id(
    graph: &mut Graph,
    id: crate::ids::EdgeId,
    preset_state: &PresetState,
) -> bool {
    let Some(edge) = graph.edge(id) else { return false; };
    if edge.kind == EdgeKind::Basic && preset_state.preset_edges.contains(&(edge.from, edge.to)) {
        return false;
    }
    graph.remove_edge(id);
    true
}

/// try_add_directed_edge: adds a single one-way edge `from -> to`, respecting PresetState.
/// Unlike `try_add_bidirectional_edge`, never adds the reverse direction — for repair
/// strategies that need an explicit one-way connection (e.g. `MissingRegionsStrategy`).
/// Returns true if the edge was added or already present; false if blocked by preset state.
pub(crate) fn try_add_directed_edge(
    graph: &mut Graph,
    from: NodeId,
    to: NodeId,
    preset_state: &PresetState,
) -> bool {
    if preset_state.locked_out.contains(&from) { return false; }
    if preset_state.locked_in.contains(&to) { return false; }
    if preset_state.blocked.contains(&(from, to)) { return false; }
    if graph.edge_between(from, to).is_none() {
        graph.add_edge(from, to, EdgeKind::Basic);
    }
    true
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
