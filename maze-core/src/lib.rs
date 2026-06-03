pub mod ids;
pub mod graph;
pub mod space;
pub mod generation;
pub mod validation;
pub mod io;
pub mod rules;

pub use ids::{NodeId, IdGenerator};
pub use graph::Graph;
pub use space::Field;
pub use rules::{MazeMeta, Rule, RuleEngine, AssignStartRule, AssignFinishRule, NoOpRule};

pub struct Maze<F: Field> {
    pub field: F,
    pub graph: Graph,
    pub meta: MazeMeta,
}
