pub mod pipeline;

pub(crate) mod vertex_based;
pub(crate) mod wilson;
pub(crate) mod kruskal;
pub(crate) mod recursive_backtracker;
pub(crate) mod edge_based;

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
}

impl Default for GenerationParams {
    fn default() -> Self {
        GenerationParams {
            depth_first:     0.9,
            corridor_chance: 0.7,
            branching:       0.5,
            directionality:  0.0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct EdgeBasedParams {
    pub corridor_length: f64,
    pub branching:       f64,
    pub locality:        f64,
    pub directionality:  f64,
}

impl Default for EdgeBasedParams {
    fn default() -> Self {
        EdgeBasedParams {
            corridor_length: 0.5,
            branching:       0.5,
            locality:        0.0,
            directionality:  0.0,
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

#[derive(Debug, Clone)]
pub struct GenerationConfig {
    pub algorithm:           GenerationAlgorithm,
    pub elements:            ElementsConfig,
    pub preset_connections:  Vec<PresetConnection>,
}

impl Default for GenerationConfig {
    fn default() -> Self {
        GenerationConfig {
            algorithm:          GenerationAlgorithm::CustomVertexBased(GenerationParams::default()),
            elements:           ElementsConfig::default(),
            preset_connections: vec![],
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
    pub edges: Vec<GenerationEdge>,
}

fn dispatch<T: Tessellation>(
    graph: &mut Graph,
    field: &Field<T>,
    seed: u64,
    start: NodeId,
    config: GenerationConfig,
    on_step: Option<&mut dyn FnMut(&Graph)>,
) {
    match config.algorithm {
        GenerationAlgorithm::CustomVertexBased(params) =>
            vertex_based::generate(graph, field, seed, start, &params, &config.elements, on_step),
        GenerationAlgorithm::CustomEdgeBased(params) =>
            edge_based::generate(graph, field, seed, start, &params, &config.elements, on_step),
        GenerationAlgorithm::RecursiveBacktracker =>
            recursive_backtracker::generate(graph, field, seed, start, &config.elements, on_step),
        GenerationAlgorithm::WilsonAlgorithm =>
            wilson::generate(graph, field, seed, start, &config.elements, on_step),
        GenerationAlgorithm::KruskalAlgorithm =>
            kruskal::generate(graph, field, seed, &config.elements, on_step),
    }
}

pub fn generate_maze<T: Tessellation>(
    graph: &mut Graph,
    field: &Field<T>,
    seed: u64,
    start: NodeId,
    config: GenerationConfig,
) {
    dispatch(graph, field, seed, start, config, None);
}

pub fn generate_maze_steps<T: Tessellation>(
    graph: &mut Graph,
    field: &Field<T>,
    seed: u64,
    start: NodeId,
    config: GenerationConfig,
) -> Vec<GenerationStep> {
    let mut steps: Vec<GenerationStep> = Vec::new();
    let mut on_step = |g: &Graph| {
        let edges = g.edges().map(|e| GenerationEdge { from: e.from, to: e.to }).collect();
        steps.push(GenerationStep { edges });
    };
    dispatch(graph, field, seed, start, config, Some(&mut on_step));
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
