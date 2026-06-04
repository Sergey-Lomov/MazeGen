pub mod ids;
pub mod graph;
pub mod space;
pub mod generation;
pub mod validation;
pub mod io;
pub mod meta;
pub mod quality_control;
pub mod repair;

pub use ids::{NodeId, IdGenerator};
pub use graph::Graph;
pub use space::Field;
pub use meta::MazeMeta;
pub use generation::pipeline::{build_maze, PipelineError, MAX_REPAIR_ITERATIONS};

#[derive(Default)]
pub struct MazeAnalysis {}

pub struct Maze<F: Field> {
    pub field: F,
    pub graph: Graph,
    pub meta: MazeMeta,
    pub analysis: MazeAnalysis,
}

impl<F: Field> Maze<F> {
    pub fn new(field: F, graph: Graph) -> Self {
        Self {
            field,
            graph,
            meta: MazeMeta::empty(),
            analysis: MazeAnalysis::default(),
        }
    }
}
