use rand::{Rng, RngCore};
use crate::Maze;
use crate::space::Field;
use crate::quality_control::Issue;
use crate::repair::result::RepairResult;
use crate::repair::strategy::RepairStrategy;

pub struct CreateStartStrategy;

impl<F: Field> RepairStrategy<F> for CreateStartStrategy {
    fn apply(&self, _issue: &Issue, maze: &mut Maze<F>, rng: &mut dyn RngCore) -> RepairResult {
        if maze.meta.start.is_some() {
            return RepairResult::Fixed;
        }
        let mut nodes: Vec<_> = maze.graph.nodes().map(|n| n.id).collect();
        if nodes.is_empty() {
            return RepairResult::Failed;
        }
        nodes.sort_unstable();
        let idx = rng.random_range(0..nodes.len());
        maze.meta.start = Some(nodes[idx]);
        RepairResult::Fixed
    }
}
