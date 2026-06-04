use rand::{Rng, RngCore};
use crate::Maze;
use crate::space::Field;
use crate::quality_control::Issue;
use crate::repair::result::RepairResult;
use crate::repair::strategy::RepairStrategy;

pub struct CreateFinishStrategy;

impl<F: Field> RepairStrategy<F> for CreateFinishStrategy {
    fn apply(&self, _issue: &Issue, maze: &mut Maze<F>, rng: &mut dyn RngCore) -> RepairResult {
        if maze.meta.finish.is_some() {
            return RepairResult::Fixed;
        }
        let start = match maze.meta.start {
            Some(s) => s,
            None => return RepairResult::Deferred,
        };
        let mut candidates = maze.graph.reachable_from(start);
        candidates.retain(|&id| id != start);
        if candidates.is_empty() {
            return RepairResult::Failed;
        }
        let idx = rng.random_range(0..candidates.len());
        maze.meta.finish = Some(candidates[idx]);
        RepairResult::Fixed
    }
}
