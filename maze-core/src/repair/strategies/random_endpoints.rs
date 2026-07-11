use rand::{Rng, RngCore};
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::MissingEndpointsIssue;
use crate::repair::params::StrategyParams;
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::snapshot::SnapshotStack;
use crate::generation::PresetState;

pub struct RandomEndpointsStrategy;

impl<T: Tessellation> RepairStrategy<T, MissingEndpointsIssue> for RandomEndpointsStrategy {
    fn strategy_id(&self) -> &'static str { "random_endpoints" }

    fn apply(&self, _issue: &MissingEndpointsIssue, maze: &mut Maze<T>, _snapshots: &mut SnapshotStack, rng: &mut dyn RngCore, _params: &StrategyParams, _preset_state: &PresetState, _nested: &[NestedStrategyConfig<T>]) -> RepairResult {
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

crate::impl_erased_repair_strategy!(RandomEndpointsStrategy, MissingEndpointsIssue);
