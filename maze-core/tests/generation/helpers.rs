use maze_core::{Graph, IdGenerator, NodeId};
use maze_core::space::{Field, SquareTessellation, SquarePoint, square_rect};
use maze_core::generation::{EdgeBasedParams, ElementsConfig, GenerationAlgorithm, GenerationConfig, GenerationParams, PresetState};

pub fn build(width: usize, height: usize) -> (Graph, Field<SquareTessellation>, NodeId) {
    let (graph, field, start, _ids) = build_with_ids(width, height);
    (graph, field, start)
}

/// Same as `build`, but also returns the `IdGenerator` used to construct `field` — needed by
/// callers that go on to declare `split_points` (GitHub issue #231) via `build_preset_state`,
/// which itself calls `Field::add_node_at` and needs an `IdGenerator` that won't collide with the
/// field's already-assigned ids.
pub fn build_with_ids(width: usize, height: usize) -> (Graph, Field<SquareTessellation>, NodeId, IdGenerator) {
    let mut ids = IdGenerator::new();
    let field = Field::new(square_rect(width, height), &mut ids).unwrap();
    let mut graph = Graph::new();
    field.build_nodes(&mut graph);
    let start = field.nodes_at(SquarePoint { x: 0, y: 0 }).first().copied().unwrap();
    (graph, field, start, ids)
}

pub fn empty_preset() -> PresetState { PresetState::empty() }

/// Builds a 1x4 field where `node_at(1,0)`<->`node_at(2,0)` geometric adjacency is walled off,
/// so the only way to cross from the first half to the second is a preset two-way `Teleport` edge
/// planted directly in the graph between those same two nodes (mirrors what `build_preset_state`
/// does for a `PresetConnectionState::Teleport(TwoWay)` entry — see `Specs/preset-connections.md`).
/// Regression fixture for GitHub issue #226: every generation algorithm must treat a preset
/// teleport as a traversable extra neighbor, not a dead end. Returns
/// `(graph, field, start, preset_state, node_count, teleport_a, teleport_b)`.
pub fn build_with_preset_teleport_bridge() -> (Graph, Field<SquareTessellation>, NodeId, PresetState, usize, NodeId, NodeId) {
    let (mut graph, field, start) = build(4, 1);
    let node_count = graph.nodes().count();
    let a = field.nodes_at(SquarePoint { x: 1, y: 0 }).first().copied().unwrap();
    let b = field.nodes_at(SquarePoint { x: 2, y: 0 }).first().copied().unwrap();

    graph.build_initial_edge(a, b, maze_core::graph::EdgeKind::Teleport);
    graph.build_initial_edge(b, a, maze_core::graph::EdgeKind::Teleport);

    let mut preset_state = PresetState::empty();
    preset_state.blocked.insert((a, b));
    preset_state.blocked.insert((b, a));
    preset_state.preset_teleports.entry(a).or_default().push(b);
    preset_state.preset_teleports.entry(b).or_default().push(a);

    (graph, field, start, preset_state, node_count, a, b)
}

/// One-way counterpart of `build_with_preset_teleport_bridge`: same 1x4 layout and walled-off
/// geometric adjacency between `node_at(1,0)` and `node_at(2,0)`, but only a single directed
/// preset `Teleport` edge `a -> b` is planted (mirrors `PresetConnectionState::Teleport(Forward)` —
/// see `Specs/preset-connections.md`), so `preset_teleports` has an entry only for `a`, not `b`.
/// Regression fixture for GitHub issue #226: a one-way preset teleport must still be traversed
/// (from `a`'s side only) exactly like the two-way case, not silently treated symmetrically.
/// Returns `(graph, field, start, preset_state, node_count)`.
pub fn build_with_one_way_preset_teleport_bridge() -> (Graph, Field<SquareTessellation>, NodeId, PresetState, usize) {
    let (mut graph, field, start) = build(4, 1);
    let node_count = graph.nodes().count();
    let a = field.nodes_at(SquarePoint { x: 1, y: 0 }).first().copied().unwrap();
    let b = field.nodes_at(SquarePoint { x: 2, y: 0 }).first().copied().unwrap();

    graph.build_initial_edge(a, b, maze_core::graph::EdgeKind::Teleport);

    let mut preset_state = PresetState::empty();
    preset_state.blocked.insert((a, b));
    preset_state.blocked.insert((b, a));
    preset_state.preset_teleports.entry(a).or_default().push(b);

    (graph, field, start, preset_state, node_count)
}

pub fn no_one_way_elements() -> ElementsConfig { ElementsConfig { one_way_chance: 0.0, teleport_chance: 0.0, teleport_one_way_chance: 0.0 } }

pub fn default_config() -> GenerationConfig {
    GenerationConfig::default()
}

pub fn config_with_params(params: GenerationParams) -> GenerationConfig {
    GenerationConfig {
        algorithm: GenerationAlgorithm::CustomVertexBased(params),
        elements: ElementsConfig { one_way_chance: 0.0, teleport_chance: 0.0, teleport_one_way_chance: 0.0 },
        ..GenerationConfig::default()
    }
}

pub fn config_with_elements(elements: ElementsConfig) -> GenerationConfig {
    GenerationConfig {
        algorithm: GenerationAlgorithm::CustomVertexBased(GenerationParams::default()),
        elements,
        ..GenerationConfig::default()
    }
}

pub fn edge_based_config(params: EdgeBasedParams) -> GenerationConfig {
    GenerationConfig {
        algorithm: GenerationAlgorithm::CustomEdgeBased(params),
        elements: ElementsConfig { one_way_chance: 0.0, teleport_chance: 0.0, teleport_one_way_chance: 0.0 },
        ..GenerationConfig::default()
    }
}

pub fn kruskal_config() -> GenerationConfig {
    GenerationConfig {
        algorithm: GenerationAlgorithm::KruskalAlgorithm,
        elements: ElementsConfig { one_way_chance: 0.0, teleport_chance: 0.0, teleport_one_way_chance: 0.0 },
        ..GenerationConfig::default()
    }
}

pub fn assert_perfect_maze(graph: &Graph, node_count: usize) {
    assert_eq!(graph.edges().count(), 2 * (node_count - 1),
        "expected perfect maze: 2*(node_count-1) directed edges");
}

pub fn collect_edges(graph: &Graph) -> Vec<(NodeId, NodeId)> {
    graph.edges().map(|e| (e.from, e.to)).collect()
}

pub fn assert_deterministic(g1: &Graph, g2: &Graph) {
    let mut e1 = collect_edges(g1);
    let mut e2 = collect_edges(g2);
    e1.sort();
    e2.sort();
    assert_eq!(e1, e2, "same seed produced different graphs");
}
