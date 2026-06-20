use maze_core::{Graph, IdGenerator, NodeId};
use maze_core::space::{Field, SquareTessellation, SquarePoint, square_rect};
use maze_core::generation::{EdgeBasedParams, ElementsConfig, GenerationAlgorithm, GenerationConfig, GenerationParams, PresetState};

pub fn build(width: usize, height: usize) -> (Graph, Field<SquareTessellation>, NodeId) {
    let mut ids = IdGenerator::new();
    let field = Field::new(square_rect(width, height), &mut ids).unwrap();
    let mut graph = Graph::new();
    field.build_nodes(&mut graph);
    let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
    (graph, field, start)
}

pub fn empty_preset() -> PresetState { PresetState::empty() }

pub fn no_one_way_elements() -> ElementsConfig { ElementsConfig { one_way_chance: 0.0 } }

pub fn default_config() -> GenerationConfig {
    GenerationConfig::default()
}

pub fn config_with_params(params: GenerationParams) -> GenerationConfig {
    GenerationConfig {
        algorithm: GenerationAlgorithm::CustomVertexBased(params),
        elements: ElementsConfig { one_way_chance: 0.0 },
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
        elements: ElementsConfig { one_way_chance: 0.0 },
        ..GenerationConfig::default()
    }
}

pub fn kruskal_config() -> GenerationConfig {
    GenerationConfig {
        algorithm: GenerationAlgorithm::KruskalAlgorithm,
        elements: ElementsConfig { one_way_chance: 0.0 },
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
