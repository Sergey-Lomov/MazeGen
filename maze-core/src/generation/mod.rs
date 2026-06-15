pub mod pipeline;

pub(crate) mod vertex_based;
pub(crate) mod wilson;
pub(crate) mod kruskal;
pub(crate) mod recursive_backtracker;
pub(crate) mod edge_based;

use std::collections::{BTreeSet, HashSet};
use rand::rngs::SmallRng;
use rand::Rng;
use crate::ids::NodeId;
use crate::graph::{Graph, EdgeKind};
use crate::space::{Field, Tessellation};

#[derive(Debug, Clone)]
pub struct ElementsConfig {
    pub one_way_chance: f64,
}

impl Default for ElementsConfig {
    fn default() -> Self {
        ElementsConfig { one_way_chance: 0.04 }
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
}

#[derive(Debug, Clone)]
pub struct GenerationStep {
    pub edges:        Vec<GenerationEdge>,
    pub active_nodes: Vec<NodeId>,
    pub current_src:  NodeId,
}

/// Resolved preset constraints in NodeId space, ready for use by generation algorithms.
pub struct PresetState {
    /// Edges the algorithm must not add (Wall presets).
    pub blocked:    HashSet<(NodeId, NodeId)>,
    /// Nodes the algorithm must not add outgoing edges from.
    pub locked_out: HashSet<NodeId>,
    /// Nodes the algorithm must not add incoming edges to.
    pub locked_in:  HashSet<NodeId>,
    /// Nodes already connected by preset Passage/OneWay edges — treated as visited at generation start.
    pub preset_connected: BTreeSet<NodeId>,
}

impl PresetState {
    pub fn empty() -> Self {
        Self {
            blocked:         HashSet::new(),
            locked_out:      HashSet::new(),
            locked_in:       HashSet::new(),
            preset_connected: BTreeSet::new(),
        }
    }
}

/// Build PresetState and apply Passage/OneWay edges to the graph before generation.
pub fn build_preset_state<T: Tessellation>(
    graph: &mut Graph,
    field: &Field<T>,
    preset_connections: &[PresetConnection],
    locked_nodes: &[LockedNode],
    xy_to_point: impl Fn(i32, i32) -> T::Point,
) -> PresetState {
    let mut blocked:          HashSet<(NodeId, NodeId)> = HashSet::new();
    let mut locked_out:       HashSet<NodeId> = HashSet::new();
    let mut locked_in:        HashSet<NodeId> = HashSet::new();
    let mut preset_connected: BTreeSet<NodeId> = BTreeSet::new();

    for preset in preset_connections {
        let from_pt = xy_to_point(preset.from.0, preset.from.1);
        let to_pt   = xy_to_point(preset.to.0,   preset.to.1);
        let Some(from_id) = field.node_at(from_pt) else { continue; };
        let Some(to_id)   = field.node_at(to_pt)   else { continue; };

        match preset.state {
            PresetConnectionState::Wall => {
                blocked.insert((from_id, to_id));
                blocked.insert((to_id, from_id));
            }
            PresetConnectionState::Passage => {
                graph.add_edge(from_id, to_id, EdgeKind::Basic);
                graph.add_edge(to_id, from_id, EdgeKind::Basic);
                preset_connected.insert(from_id);
                preset_connected.insert(to_id);
            }
            PresetConnectionState::OneWayForward => {
                graph.add_edge(from_id, to_id, EdgeKind::Basic);
                blocked.insert((to_id, from_id));
                preset_connected.insert(from_id);
                preset_connected.insert(to_id);
            }
            PresetConnectionState::OneWayBackward => {
                graph.add_edge(to_id, from_id, EdgeKind::Basic);
                blocked.insert((from_id, to_id));
                preset_connected.insert(from_id);
                preset_connected.insert(to_id);
            }
        }
    }

    for lock in locked_nodes {
        let pt = xy_to_point(lock.point.0, lock.point.1);
        let Some(id) = field.node_at(pt) else { continue; };
        match lock.kind {
            NodeLockKind::In   => { locked_in.insert(id); }
            NodeLockKind::Out  => { locked_out.insert(id); }
            NodeLockKind::Both => { locked_in.insert(id); locked_out.insert(id); }
        }
    }

    PresetState { blocked, locked_out, locked_in, preset_connected }
}

pub(crate) fn gaussian_weighted_index(len: usize, depth_first: f64, rng: &mut SmallRng) -> usize {
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
            recursive_backtracker::generate(graph, field, seed, start, &config.elements, preset_state, on_step),
        GenerationAlgorithm::WilsonAlgorithm =>
            wilson::generate(graph, field, seed, start, &config.elements, preset_state, on_step),
        GenerationAlgorithm::KruskalAlgorithm =>
            kruskal::generate(graph, field, seed, &config.elements, preset_state, on_step),
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
        let edges = g.edges().map(|e| GenerationEdge { from: e.from, to: e.to }).collect();
        steps.push(GenerationStep { edges, active_nodes: active.to_vec(), current_src: src });
    };
    dispatch(graph, field, seed, start, config, preset_state, Some(&mut on_step));
    steps
}

// One-way edges consume two RNG samples (one for the chance check, one for direction),
// while bidirectional edges consume only one. This means maze topology differs between
// runs with one_way_chance > 0 and runs with one_way_chance == 0, even at the same seed.
pub(crate) fn add_edge(graph: &mut Graph, src: NodeId, dst: NodeId, elements: &ElementsConfig, rng: &mut SmallRng) {
    if rng.random::<f64>() < elements.one_way_chance {
        if rng.random::<bool>() {
            graph.add_edge(src, dst, EdgeKind::Basic);
        } else {
            graph.add_edge(dst, src, EdgeKind::Basic);
        }
    } else {
        graph.add_bidirectional_edge(src, dst, EdgeKind::Basic);
    }
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

/// try_add_edge: respects PresetState constraints before delegating to add_edge.
/// Returns true if the edge was added (at least one direction).
pub(crate) fn try_add_edge(
    graph: &mut Graph,
    src: NodeId,
    dst: NodeId,
    elements: &ElementsConfig,
    preset_state: &PresetState,
    rng: &mut SmallRng,
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
        graph.add_edge(src, dst, EdgeKind::Basic);
        // Still consume RNG samples to preserve seed parity with normal add_edge.
        let _ = rng.random::<f64>();
        let _ = rng.random::<bool>();
    } else {
        add_edge(graph, src, dst, elements, rng);
    }
}

#[cfg(test)]
pub(crate) mod test_utils {
    use crate::graph::Graph;
    use crate::ids::IdGenerator;
    use crate::space::{Field, SquareTessellation, square_rect};
    use super::ElementsConfig;

    pub fn default_elements() -> ElementsConfig { ElementsConfig { one_way_chance: 0.0 } }

    pub fn make_field_and_graph(w: usize, h: usize) -> (Field<SquareTessellation>, Graph) {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(w, h), &mut ids).unwrap();
        let mut graph = Graph::new();
        field.build_nodes(&mut graph);
        (field, graph)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elements_config_default_one_way_chance() {
        assert_eq!(ElementsConfig::default().one_way_chance, 0.04);
    }
}
