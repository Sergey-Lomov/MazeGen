use std::collections::BinaryHeap;
use std::cmp::Reverse;
use rand::{Rng, RngCore};
use crate::Maze;
use crate::ids::NodeId;
use crate::space::Field;
use crate::graph::nav::NavGraph;
use crate::quality_control::Issue;
use crate::repair::params::StrategyParams;
use crate::repair::result::RepairResult;
use crate::repair::strategy::RepairStrategy;

pub struct FarthestEndpointsStrategy;

impl<F: Field> RepairStrategy<F> for FarthestEndpointsStrategy {
    fn apply(&self, _issue: &Issue, maze: &mut Maze<F>, rng: &mut dyn RngCore, _params: &StrategyParams) -> RepairResult {
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
    let dist = dijkstra(nav, source);
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

fn dijkstra(nav: &NavGraph, source: usize) -> Vec<usize> {
    dijkstra_impl(nav, source, |nav, u| {
        nav.outgoing_edges(u).map(|e| (e.to, e.path.len().saturating_sub(1)))
    })
}

fn dijkstra_reverse(nav: &NavGraph, target: usize) -> Vec<usize> {
    dijkstra_impl(nav, target, |nav, u| {
        nav.incoming_edges(u).map(|e| (e.from, e.path.len().saturating_sub(1)))
    })
}

fn dijkstra_impl<'a, I, F>(nav: &'a NavGraph, source: usize, neighbors: F) -> Vec<usize>
where
    I: Iterator<Item = (usize, usize)> + 'a,
    F: Fn(&'a NavGraph, usize) -> I,
{
    let n = nav.nodes.len();
    let mut dist = vec![usize::MAX; n];
    let mut heap: BinaryHeap<Reverse<(usize, usize)>> = BinaryHeap::new();

    dist[source] = 0;
    heap.push(Reverse((0, source)));

    while let Some(Reverse((cost, u))) = heap.pop() {
        if dist[u] < cost {
            continue;
        }
        for (v, weight) in neighbors(nav, u) {
            let next_cost = cost + weight;
            if next_cost < dist[v] {
                dist[v] = next_cost;
                heap.push(Reverse((next_cost, v)));
            }
        }
    }

    dist
}
