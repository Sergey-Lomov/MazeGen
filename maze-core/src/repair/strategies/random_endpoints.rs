use rand::{Rng, RngCore};
use crate::Maze;
use crate::space::Field;
use crate::quality_control::Issue;
use crate::repair::params::StrategyParams;
use crate::repair::result::RepairResult;
use crate::repair::strategy::RepairStrategy;

pub struct RandomEndpointsStrategy;

impl<F: Field> RepairStrategy<F> for RandomEndpointsStrategy {
    fn apply(&self, _issue: &Issue, maze: &mut Maze<F>, rng: &mut dyn RngCore, _params: &StrategyParams) -> RepairResult {
        if maze.meta.start.is_some() && maze.meta.finish.is_some() {
            return RepairResult::Fixed { score: None };
        }

        if maze.meta.start.is_none() {
            let candidates = match maze.meta.finish {
                None => {
                    let mut nodes: Vec<_> = maze.graph.nodes().map(|n| n.id).collect();
                    if nodes.is_empty() {
                        return RepairResult::Failed;
                    }
                    nodes.sort_unstable();
                    nodes
                }
                Some(finish) => {
                    let mut nodes = maze.graph.reachable_to(finish);
                    nodes.retain(|&id| id != finish);
                    if nodes.is_empty() {
                        return RepairResult::Failed;
                    }
                    nodes
                }
            };
            let idx = rng.random_range(0..candidates.len());
            maze.meta.start = Some(candidates[idx]);
        }

        if maze.meta.finish.is_none() {
            let start = maze.meta.start.unwrap();
            let mut candidates = maze.graph.reachable_from(start);
            candidates.retain(|&id| id != start);
            if candidates.is_empty() {
                return RepairResult::Failed;
            }
            let idx = rng.random_range(0..candidates.len());
            maze.meta.finish = Some(candidates[idx]);
        }

        RepairResult::Fixed { score: None }
    }
}
