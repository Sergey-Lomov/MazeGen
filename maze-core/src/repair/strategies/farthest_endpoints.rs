use rand::{Rng, RngCore};
use crate::Maze;
use crate::ids::NodeId;
use crate::space::Tessellation;
use crate::graph::nav::NavGraph;
use crate::graph::pathfinding::{dijkstra_forward, dijkstra_reverse};
use crate::quality_control::Issue;
use crate::repair::params::StrategyParams;
use crate::repair::result::RepairResult;
use crate::repair::strategy::RepairStrategy;

pub struct FarthestEndpointsStrategy;

impl<T: Tessellation> RepairStrategy<T> for FarthestEndpointsStrategy {
    fn apply(&self, _issue: &Issue, maze: &mut Maze<T>, rng: &mut dyn RngCore, _params: &StrategyParams) -> RepairResult {
        if maze.meta.start.is_some() && maze.meta.finish.is_some() {
            return RepairResult::Fixed { score: None };
        }

        let nav = maze.analysis.nav_graph(&maze.graph);

        if nav.nodes.is_empty() {
            return RepairResult::Failed;
        }

        match (maze.meta.start, maze.meta.finish) {
            (None, None) => {
                let random_idx = rng.random_range(0..nav.nodes.len());
                let random_node = nav.nodes[random_idx].node_id;
                let random_nav = nav.nav_node_for(random_node).unwrap();

                // Find start as the node farthest upstream from random — places start in source SCCs.
                // Then find finish as the node farthest downstream from start.
                let start_node = farthest_to(nav, random_nav);
                let start_nav = nav.nav_node_for(start_node).unwrap();

                let finish_node = farthest_from(nav, start_nav);
                if finish_node == start_node {
                    return RepairResult::Failed;
                }

                maze.meta.start = Some(start_node);
                maze.meta.finish = Some(finish_node);
            }
            (Some(start), None) => {
                let start_nav = match nav.nav_node_for(start) {
                    Some(id) => id,
                    None => return RepairResult::Failed,
                };
                let finish_node = farthest_from(nav, start_nav);
                if finish_node == start {
                    return RepairResult::Failed;
                }
                maze.meta.finish = Some(finish_node);
            }
            (None, Some(finish)) => {
                let finish_nav = match nav.nav_node_for(finish) {
                    Some(id) => id,
                    None => return RepairResult::Failed,
                };
                // Reverse Dijkstra: find farthest node that can reach finish
                let start_node = farthest_to(nav, finish_nav);
                if start_node == finish {
                    return RepairResult::Failed;
                }
                maze.meta.start = Some(start_node);
            }
            (Some(_), Some(_)) => unreachable!(),
        }

        RepairResult::Fixed { score: None }
    }
}

fn farthest_from(nav: &NavGraph, source: usize) -> NodeId {
    let dist = dijkstra_forward(nav, source);
    dist.iter().enumerate()
        .filter(|&(_, &d)| d != usize::MAX)
        .max_by_key(|&(nav_id, &d)| (d, std::cmp::Reverse(nav.nodes[nav_id].node_id)))
        .map(|(nav_id, _)| nav.nodes[nav_id].node_id)
        .unwrap_or(nav.nodes[source].node_id)
}

fn farthest_to(nav: &NavGraph, target: usize) -> NodeId {
    let dist = dijkstra_reverse(nav, target);
    dist.iter().enumerate()
        .filter(|&(_, &d)| d != usize::MAX)
        .max_by_key(|&(nav_id, &d)| (d, std::cmp::Reverse(nav.nodes[nav_id].node_id)))
        .map(|(nav_id, _)| nav.nodes[nav_id].node_id)
        .unwrap_or(nav.nodes[target].node_id)
}
