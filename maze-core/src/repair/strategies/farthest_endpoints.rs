use super::farthest_reachable::{
    SEARCH_MODE_EXHAUSTIVE, SEARCH_MODE_PARAM, exhaustive_distance, search_mode,
};
use crate::Maze;
use crate::generation::{GeneratedElementKind, PresetState};
use crate::graph::Graph;
use crate::graph::nav::NavGraph;
use crate::graph::pathfinding::{dijkstra_forward, dijkstra_reverse};
use crate::ids::NodeId;
use crate::quality_control::MissingEndpointsIssue;
use crate::repair::command::MutationCommand;
use crate::repair::params::{StrategyParam, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{NestedStrategyConfig, RepairStrategy};
use crate::space::Tessellation;
use rand::{Rng, RngCore};

static PARAMS: &[StrategyParam] = &[SEARCH_MODE_PARAM];

pub struct FarthestEndpointsStrategy;

impl<T: Tessellation> RepairStrategy<T, MissingEndpointsIssue> for FarthestEndpointsStrategy {
    fn strategy_id(&self) -> &'static str {
        "farthest_endpoints"
    }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn apply(
        &self,
        issue: &MissingEndpointsIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        if !issue.missing_start && !issue.missing_finish {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        if search_mode(params) == SEARCH_MODE_EXHAUSTIVE {
            return apply_exhaustive(issue, maze, rng, preset_state);
        }

        let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
        let nav = &nav;

        if nav.nodes.is_empty() {
            return (RepairResult::Failed, vec![]);
        }

        let commands = match (issue.missing_start, issue.missing_finish) {
            (true, true) => {
                let random_idx = rng.random_range(0..nav.nodes.len());
                let random_node = nav.nodes[random_idx].node_id;
                let random_nav = nav.nav_node_for(random_node).unwrap();

                // Find start as the node farthest upstream from random — places start in source SCCs.
                // Then find finish as the node farthest downstream from start.
                let Some(start_node) = select_farthest_to(
                    nav,
                    random_nav,
                    maze,
                    preset_state,
                    GeneratedElementKind::Start,
                ) else {
                    return (RepairResult::Failed, vec![]);
                };
                let start_nav = nav.nav_node_for(start_node).unwrap();

                let Some(finish_node) = select_farthest_from(
                    nav,
                    start_nav,
                    maze,
                    preset_state,
                    GeneratedElementKind::Finish,
                ) else {
                    return (RepairResult::Failed, vec![]);
                };
                if finish_node == start_node {
                    return (RepairResult::Failed, vec![]);
                }
                let finish_nav = nav.nav_node_for(finish_node).unwrap();
                // The graph is directed: dist(start->finish) can differ from dist(finish->start).
                // The sweep above only measured one direction — check the other and swap if it's longer.
                let (start_node, finish_node) =
                    orient_allowed_pair(nav, start_nav, finish_nav, maze, preset_state);

                vec![
                    MutationCommand::SetStart(start_node),
                    MutationCommand::SetFinish(finish_node),
                ]
            }
            (false, true) => {
                let start = maze.meta.start.expect("missing_start is false");
                let start_nav = match nav.nav_node_for(start) {
                    Some(id) => id,
                    None => return (RepairResult::Failed, vec![]),
                };
                let Some(finish_node) = select_farthest_from(
                    nav,
                    start_nav,
                    maze,
                    preset_state,
                    GeneratedElementKind::Finish,
                ) else {
                    return (RepairResult::Failed, vec![]);
                };
                if finish_node == start {
                    return (RepairResult::Failed, vec![]);
                }
                vec![MutationCommand::SetFinish(finish_node)]
            }
            (true, false) => {
                let finish = maze.meta.finish.expect("missing_finish is false");
                let finish_nav = match nav.nav_node_for(finish) {
                    Some(id) => id,
                    None => return (RepairResult::Failed, vec![]),
                };
                // Reverse Dijkstra: find farthest node that can reach finish
                let Some(start_node) = select_farthest_to(
                    nav,
                    finish_nav,
                    maze,
                    preset_state,
                    GeneratedElementKind::Start,
                ) else {
                    return (RepairResult::Failed, vec![]);
                };
                if start_node == finish {
                    return (RepairResult::Failed, vec![]);
                }
                vec![MutationCommand::SetStart(start_node)]
            }
            (false, false) => unreachable!(),
        };

        (RepairResult::Fixed { score: None }, commands)
    }
}

crate::impl_erased_repair_strategy!(FarthestEndpointsStrategy, MissingEndpointsIssue);

/// `SEARCH_MODE_EXHAUSTIVE` counterpart to the nav-graph branch above — mirrors its three cases
/// (both missing / only finish missing / only start missing) but searches every raw-graph tile
/// node instead of only junction/dead-end nav nodes (GitHub issue #515).
fn apply_exhaustive<T: Tessellation>(
    issue: &MissingEndpointsIssue,
    maze: &Maze<T>,
    rng: &mut dyn RngCore,
    preset_state: &PresetState,
) -> (RepairResult, Vec<MutationCommand>) {
    let all_nodes: Vec<NodeId> = maze.field.all_node_ids().collect();
    if all_nodes.is_empty() {
        return (RepairResult::Failed, vec![]);
    }

    let commands = match (issue.missing_start, issue.missing_finish) {
        (true, true) => {
            let random_node = all_nodes[rng.random_range(0..all_nodes.len())];

            let Some(start_node) = select_farthest_exhaustive(
                maze,
                random_node,
                false,
                preset_state,
                GeneratedElementKind::Start,
            ) else {
                return (RepairResult::Failed, vec![]);
            };
            let Some(finish_node) = select_farthest_exhaustive(
                maze,
                start_node,
                true,
                preset_state,
                GeneratedElementKind::Finish,
            ) else {
                return (RepairResult::Failed, vec![]);
            };
            if finish_node == start_node {
                return (RepairResult::Failed, vec![]);
            }

            let (start_node, finish_node) = orient_allowed_pair_exhaustive(
                &maze.graph,
                start_node,
                finish_node,
                maze,
                preset_state,
            );
            vec![
                MutationCommand::SetStart(start_node),
                MutationCommand::SetFinish(finish_node),
            ]
        }
        (false, true) => {
            let start = maze.meta.start.expect("missing_start is false");
            let Some(finish_node) = select_farthest_exhaustive(
                maze,
                start,
                true,
                preset_state,
                GeneratedElementKind::Finish,
            ) else {
                return (RepairResult::Failed, vec![]);
            };
            if finish_node == start {
                return (RepairResult::Failed, vec![]);
            }
            vec![MutationCommand::SetFinish(finish_node)]
        }
        (true, false) => {
            let finish = maze.meta.finish.expect("missing_finish is false");
            let Some(start_node) = select_farthest_exhaustive(
                maze,
                finish,
                false,
                preset_state,
                GeneratedElementKind::Start,
            ) else {
                return (RepairResult::Failed, vec![]);
            };
            if start_node == finish {
                return (RepairResult::Failed, vec![]);
            }
            vec![MutationCommand::SetStart(start_node)]
        }
        (false, false) => unreachable!(),
    };

    (RepairResult::Fixed { score: None }, commands)
}

fn select_farthest_from<T: Tessellation>(
    nav: &NavGraph,
    source: usize,
    maze: &Maze<T>,
    preset_state: &PresetState,
    kind: GeneratedElementKind,
) -> Option<NodeId> {
    let distances = dijkstra_forward(nav, source);
    distances
        .iter()
        .enumerate()
        .filter(|&(nav_id, &distance)| {
            distance != usize::MAX
                && preset_state.allows_generated_endpoint(
                    &maze.field,
                    kind,
                    nav.nodes[nav_id].node_id,
                )
        })
        .max_by_key(|&(nav_id, &distance)| (distance, std::cmp::Reverse(nav.nodes[nav_id].node_id)))
        .map(|(nav_id, _)| nav.nodes[nav_id].node_id)
}

fn select_farthest_to<T: Tessellation>(
    nav: &NavGraph,
    target: usize,
    maze: &Maze<T>,
    preset_state: &PresetState,
    kind: GeneratedElementKind,
) -> Option<NodeId> {
    let distances = dijkstra_reverse(nav, target);
    distances
        .iter()
        .enumerate()
        .filter(|&(nav_id, &distance)| {
            distance != usize::MAX
                && preset_state.allows_generated_endpoint(
                    &maze.field,
                    kind,
                    nav.nodes[nav_id].node_id,
                )
        })
        .max_by_key(|&(nav_id, &distance)| (distance, std::cmp::Reverse(nav.nodes[nav_id].node_id)))
        .map(|(nav_id, _)| nav.nodes[nav_id].node_id)
}

fn select_farthest_exhaustive<T: Tessellation>(
    maze: &Maze<T>,
    source: NodeId,
    forward: bool,
    preset_state: &PresetState,
    kind: GeneratedElementKind,
) -> Option<NodeId> {
    maze.field
        .all_node_ids()
        .filter(|&node| preset_state.allows_generated_endpoint(&maze.field, kind, node))
        .filter_map(|node| {
            let distance = if forward {
                exhaustive_distance(&maze.graph, source, node)
            } else {
                exhaustive_distance(&maze.graph, node, source)
            }?;
            Some((node, distance))
        })
        .max_by_key(|&(node, distance)| (distance, std::cmp::Reverse(node)))
        .map(|(node, _)| node)
}

fn orient_allowed_pair<T: Tessellation>(
    nav: &NavGraph,
    start: usize,
    finish: usize,
    maze: &Maze<T>,
    preset_state: &PresetState,
) -> (NodeId, NodeId) {
    let start_id = nav.nodes[start].node_id;
    let finish_id = nav.nodes[finish].node_id;
    let forward_distance = dijkstra_forward(nav, start)[finish];
    let backward_distance = dijkstra_forward(nav, finish)[start];

    if backward_distance != usize::MAX
        && backward_distance > forward_distance
        && preset_state.allows_generated_endpoint(
            &maze.field,
            GeneratedElementKind::Start,
            finish_id,
        )
        && preset_state.allows_generated_endpoint(
            &maze.field,
            GeneratedElementKind::Finish,
            start_id,
        )
    {
        (finish_id, start_id)
    } else {
        (start_id, finish_id)
    }
}

fn orient_allowed_pair_exhaustive<T: Tessellation>(
    graph: &Graph,
    start: NodeId,
    finish: NodeId,
    maze: &Maze<T>,
    preset_state: &PresetState,
) -> (NodeId, NodeId) {
    let forward_distance = exhaustive_distance(graph, start, finish).unwrap_or(usize::MAX);
    let backward_distance = exhaustive_distance(graph, finish, start);

    if backward_distance.is_some_and(|distance| distance > forward_distance)
        && preset_state.allows_generated_endpoint(&maze.field, GeneratedElementKind::Start, finish)
        && preset_state.allows_generated_endpoint(&maze.field, GeneratedElementKind::Finish, start)
    {
        (finish, start)
    } else {
        (start, finish)
    }
}

/// Directed graph: dist(a->b) can differ from dist(b->a). Given a candidate pair, returns
/// (start, finish) oriented so the path between them is the longer of the two directions.
/// Falls back to the original orientation if the reverse direction is unreachable.
#[cfg(test)]
fn orient_farthest_pair(nav: &NavGraph, a: usize, b: usize) -> (NodeId, NodeId) {
    let a_id = nav.nodes[a].node_id;
    let b_id = nav.nodes[b].node_id;

    let forward_dist = dijkstra_forward(nav, a)[b];
    let backward_dist = dijkstra_forward(nav, b)[a];

    if backward_dist != usize::MAX && backward_dist > forward_dist {
        (b_id, a_id)
    } else {
        (a_id, b_id)
    }
}

/// `SEARCH_MODE_EXHAUSTIVE` counterpart to `orient_farthest_pair`, comparing raw-graph tile-hop
/// distances instead of nav-graph ones.
#[cfg(test)]
fn orient_farthest_pair_exhaustive(graph: &Graph, a: NodeId, b: NodeId) -> (NodeId, NodeId) {
    let forward_dist = exhaustive_distance(graph, a, b).unwrap_or(usize::MAX);
    let backward_dist = exhaustive_distance(graph, b, a);

    if let Some(backward_dist) = backward_dist
        && backward_dist > forward_dist
    {
        return (b, a);
    }
    (a, b)
}

#[cfg(test)]
#[path = "farthest_endpoints_tests.rs"]
mod tests;
