use super::farthest_reachable::{
    SEARCH_MODE_EXHAUSTIVE, SEARCH_MODE_PARAM, exhaustive_distance, farthest_from,
    farthest_from_exhaustive, farthest_to, farthest_to_exhaustive, search_mode,
};
use crate::Maze;
use crate::generation::PresetState;
use crate::graph::Graph;
use crate::graph::nav::NavGraph;
use crate::graph::pathfinding::dijkstra_forward;
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
        _preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        if !issue.missing_start && !issue.missing_finish {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        if search_mode(params) == SEARCH_MODE_EXHAUSTIVE {
            return apply_exhaustive(issue, maze, rng);
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
                let start_node = farthest_to(nav, random_nav);
                let start_nav = nav.nav_node_for(start_node).unwrap();

                let finish_node = farthest_from(nav, start_nav);
                if finish_node == start_node {
                    return (RepairResult::Failed, vec![]);
                }
                let finish_nav = nav.nav_node_for(finish_node).unwrap();

                // The graph is directed: dist(start->finish) can differ from dist(finish->start).
                // The sweep above only measured one direction — check the other and swap if it's longer.
                let (start_node, finish_node) = orient_farthest_pair(nav, start_nav, finish_nav);

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
                let finish_node = farthest_from(nav, start_nav);
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
                let start_node = farthest_to(nav, finish_nav);
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
) -> (RepairResult, Vec<MutationCommand>) {
    let all_nodes: Vec<NodeId> = maze.field.all_node_ids().collect();
    if all_nodes.is_empty() {
        return (RepairResult::Failed, vec![]);
    }

    let commands = match (issue.missing_start, issue.missing_finish) {
        (true, true) => {
            let random_node = all_nodes[rng.random_range(0..all_nodes.len())];

            let start_node = farthest_to_exhaustive(&maze.graph, random_node);
            let finish_node = farthest_from_exhaustive(&maze.graph, start_node);
            if finish_node == start_node {
                return (RepairResult::Failed, vec![]);
            }

            let (start_node, finish_node) =
                orient_farthest_pair_exhaustive(&maze.graph, start_node, finish_node);
            vec![
                MutationCommand::SetStart(start_node),
                MutationCommand::SetFinish(finish_node),
            ]
        }
        (false, true) => {
            let start = maze.meta.start.expect("missing_start is false");
            let finish_node = farthest_from_exhaustive(&maze.graph, start);
            if finish_node == start {
                return (RepairResult::Failed, vec![]);
            }
            vec![MutationCommand::SetFinish(finish_node)]
        }
        (true, false) => {
            let finish = maze.meta.finish.expect("missing_finish is false");
            let start_node = farthest_to_exhaustive(&maze.graph, finish);
            if start_node == finish {
                return (RepairResult::Failed, vec![]);
            }
            vec![MutationCommand::SetStart(start_node)]
        }
        (false, false) => unreachable!(),
    };

    (RepairResult::Fixed { score: None }, commands)
}

/// Directed graph: dist(a->b) can differ from dist(b->a). Given a candidate pair, returns
/// (start, finish) oriented so the path between them is the longer of the two directions.
/// Falls back to the original orientation if the reverse direction is unreachable.
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
mod tests {
    use super::*;
    use crate::IdGenerator;
    use crate::graph::{EdgeKind, Graph};
    use crate::random::MazeRng;
    use crate::repair::strategies::test_utils::apply_and_commit_default as apply_and_commit;
    use crate::space::{MultiLevelField, SquareTessellation, square_rect};
    use rand::SeedableRng;
    use std::sync::Arc;

    fn issue(missing_start: bool, missing_finish: bool) -> MissingEndpointsIssue {
        MissingEndpointsIssue::new_from_check("test", missing_start, missing_finish)
    }

    /// Directed line 0->1->2->3->4 (each hop one-way) -- a straightforward chain where "farthest"
    /// is unambiguous in each direction.
    fn directed_line_maze(len: usize) -> (Maze<SquareTessellation>, Vec<crate::ids::NodeId>) {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(len, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = field
            .field_of(field_level)
            .unwrap()
            .all_cells()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        for i in 0..len - 1 {
            g.build_initial_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
        }
        (Maze::new(field, g), nodes)
    }

    fn bidirectional_line_maze(len: usize) -> (Maze<SquareTessellation>, Vec<crate::ids::NodeId>) {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(len, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = field
            .field_of(field_level)
            .unwrap()
            .all_cells()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        for i in 0..len - 1 {
            g.build_initial_bidirectional_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
        }
        (Maze::new(field, g), nodes)
    }

    #[test]
    fn apply_fixed_immediately_when_both_already_set() {
        let (mut maze, nodes) = bidirectional_line_maze(3);
        maze.meta.start = Some(nodes[0]);
        maze.meta.finish = Some(nodes[2]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &FarthestEndpointsStrategy,
            &issue(false, false),
            &mut maze,
            &mut rng,
            &PresetState::empty(),
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
    }

    #[test]
    fn apply_fails_on_empty_nav_graph() {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(1, 1), &mut ids).unwrap();
        let g = Graph::new(); // no nodes registered -- empty nav graph
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &FarthestEndpointsStrategy,
            &issue(true, true),
            &mut maze,
            &mut rng,
            &PresetState::empty(),
        );
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn neither_set_places_endpoints_at_the_two_ends_of_a_bidirectional_line() {
        let (mut maze, nodes) = bidirectional_line_maze(5);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &FarthestEndpointsStrategy,
            &issue(true, true),
            &mut maze,
            &mut rng,
            &PresetState::empty(),
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        let (start, finish) = (maze.meta.start.unwrap(), maze.meta.finish.unwrap());
        assert!(
            (start == nodes[0] && finish == nodes[4]) || (start == nodes[4] && finish == nodes[0]),
            "on a straight line the farthest pair must be the two ends, got {start} -> {finish}"
        );
    }

    #[test]
    fn neither_set_fails_when_farthest_equals_source_on_a_single_isolated_node() {
        let mut maze = {
            let mut ids = IdGenerator::new();
            let field =
                MultiLevelField::single_level(Arc::default(), square_rect(1, 1), &mut ids).unwrap();
            let mut g = Graph::new();
            for node in field.all_node_ids() {
                g.add_node(node);
            }
            Maze::<SquareTessellation>::new(field, g)
        };
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &FarthestEndpointsStrategy,
            &issue(true, true),
            &mut maze,
            &mut rng,
            &PresetState::empty(),
        );
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn only_start_set_picks_the_farthest_reachable_node_as_finish() {
        let (mut maze, nodes) = directed_line_maze(5);
        maze.meta.start = Some(nodes[0]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &FarthestEndpointsStrategy,
            &issue(false, true),
            &mut maze,
            &mut rng,
            &PresetState::empty(),
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.meta.start, Some(nodes[0]));
        assert_eq!(
            maze.meta.finish,
            Some(nodes[4]),
            "farthest forward-reachable node on a directed chain is the last one"
        );
    }

    #[test]
    fn only_start_set_fails_when_start_cannot_reach_anything() {
        // Directed edge pointing INTO node 0 (1 -> 0), so node 0 (start) has no outgoing reach.
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(2, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = field
            .field_of(field_level)
            .unwrap()
            .all_cells()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        g.build_initial_edge(nodes[1], nodes[0], EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta.start = Some(nodes[0]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &FarthestEndpointsStrategy,
            &issue(false, true),
            &mut maze,
            &mut rng,
            &PresetState::empty(),
        );
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn only_finish_set_picks_the_farthest_node_that_can_reach_it_as_start() {
        let (mut maze, nodes) = directed_line_maze(5);
        maze.meta.finish = Some(nodes[4]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &FarthestEndpointsStrategy,
            &issue(true, false),
            &mut maze,
            &mut rng,
            &PresetState::empty(),
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.meta.finish, Some(nodes[4]));
        assert_eq!(
            maze.meta.start,
            Some(nodes[0]),
            "farthest node able to reach finish on a directed chain is the first one"
        );
    }

    #[test]
    fn only_finish_set_fails_when_nothing_can_reach_it() {
        // Directed edge pointing OUT of node 1 (1 -> 0), so nothing besides finish itself can
        // reach node 1 (finish) via incoming edges.
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(2, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = field
            .field_of(field_level)
            .unwrap()
            .all_cells()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        g.build_initial_edge(nodes[1], nodes[0], EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta.finish = Some(nodes[1]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &FarthestEndpointsStrategy,
            &issue(true, false),
            &mut maze,
            &mut rng,
            &PresetState::empty(),
        );
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn only_start_set_fails_when_start_node_not_in_nav_graph() {
        let (mut maze, _) = bidirectional_line_maze(3);
        maze.meta.start = Some(999_999);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &FarthestEndpointsStrategy,
            &issue(false, true),
            &mut maze,
            &mut rng,
            &PresetState::empty(),
        );
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn only_finish_set_fails_when_finish_node_not_in_nav_graph() {
        let (mut maze, _) = bidirectional_line_maze(3);
        maze.meta.finish = Some(999_999);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &FarthestEndpointsStrategy,
            &issue(true, false),
            &mut maze,
            &mut rng,
            &PresetState::empty(),
        );
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn apply_is_deterministic_for_fixed_seed() {
        let (mut maze_a, _) = bidirectional_line_maze(6);
        let mut rng_a = MazeRng::seed_from_u64(42);
        apply_and_commit(
            &FarthestEndpointsStrategy,
            &issue(true, true),
            &mut maze_a,
            &mut rng_a,
            &PresetState::empty(),
        );

        let (mut maze_b, _) = bidirectional_line_maze(6);
        let mut rng_b = MazeRng::seed_from_u64(42);
        apply_and_commit(
            &FarthestEndpointsStrategy,
            &issue(true, true),
            &mut maze_b,
            &mut rng_b,
            &PresetState::empty(),
        );

        assert_eq!(maze_a.meta.start, maze_b.meta.start);
        assert_eq!(maze_a.meta.finish, maze_b.meta.finish);
    }

    // ─── orient_farthest_pair / farthest_from / farthest_to (direct unit tests) ────────────

    fn nav_for(maze: &Maze<SquareTessellation>) -> NavGraph {
        maze.analysis.nav_graph(&maze.graph, &maze.meta)
    }

    fn exhaustive_params() -> StrategyParams {
        let mut overrides = std::collections::HashMap::new();
        overrides.insert(
            super::super::farthest_reachable::PARAM_SEARCH_MODE.to_string(),
            SEARCH_MODE_EXHAUSTIVE.to_string(),
        );
        crate::repair::params::build_params(PARAMS, Some(&overrides))
    }

    /// `search_mode: exhaustive` finds a start node the nav-graph mode cannot: same loop layout as
    /// `exhaustive_search_finds_a_mid_corridor_farthest_point...` in the `farthest_reachable`
    /// module, but exercised end-to-end through the strategy's `apply` (GitHub issue #515).
    #[test]
    fn search_mode_exhaustive_can_place_an_endpoint_mid_corridor_on_a_loop() {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(6, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = field
            .field_of(field_level)
            .unwrap()
            .all_cells()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        g.build_initial_bidirectional_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.build_initial_bidirectional_edge(nodes[0], nodes[2], EdgeKind::Basic);
        g.build_initial_bidirectional_edge(nodes[2], nodes[3], EdgeKind::Basic);
        g.build_initial_bidirectional_edge(nodes[3], nodes[4], EdgeKind::Basic);
        g.build_initial_bidirectional_edge(nodes[4], nodes[5], EdgeKind::Basic);
        g.build_initial_bidirectional_edge(nodes[5], nodes[0], EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta.start = Some(nodes[0]);

        let mut rng = MazeRng::seed_from_u64(1);
        let params = exhaustive_params();
        let (result, commands) = RepairStrategy::apply(
            &FarthestEndpointsStrategy,
            &issue(false, true),
            &maze,
            &mut rng,
            &params,
            &PresetState::empty(),
            &[],
        );
        crate::quality_control::apply_commands::apply_commands(
            &mut maze,
            &PresetState::empty(),
            commands,
            None,
            None,
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(
            maze.meta.finish,
            Some(nodes[3]),
            "exhaustive mode must find the true mid-corridor farthest point"
        );
    }

    #[test]
    fn orient_farthest_pair_keeps_original_orientation_when_forward_is_longer() {
        // Directed chain a -> b (3 hops), no reverse path at all -- backward_dist is
        // unreachable (MAX), so the original (a, b) orientation must be kept.
        let (maze, nodes) = directed_line_maze(4);
        let nav = nav_for(&maze);
        let a = nav.nav_node_for(nodes[0]).unwrap();
        let b = nav.nav_node_for(nodes[3]).unwrap();
        let (start, finish) = orient_farthest_pair(&nav, a, b);
        assert_eq!((start, finish), (nodes[0], nodes[3]));
    }

    #[test]
    fn orient_farthest_pair_swaps_when_backward_is_longer() {
        // a -> b is a short 1-hop direct edge; b -> a is routed the long way around through
        // extra nodes, making the reverse direction strictly longer -- must swap to (b, a).
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(5, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = field
            .field_of(field_level)
            .unwrap()
            .all_cells()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        // Short forward: nodes[0] -> nodes[1] (1 hop).
        g.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
        // Long backward: nodes[1] -> 2 -> 3 -> 4 -> nodes[0] (4 hops).
        g.build_initial_edge(nodes[1], nodes[2], EdgeKind::Basic);
        g.build_initial_edge(nodes[2], nodes[3], EdgeKind::Basic);
        g.build_initial_edge(nodes[3], nodes[4], EdgeKind::Basic);
        g.build_initial_edge(nodes[4], nodes[0], EdgeKind::Basic);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        let nav = nav_for(&maze);
        let a = nav.nav_node_for(nodes[0]).unwrap();
        let b = nav.nav_node_for(nodes[1]).unwrap();
        let (start, finish) = orient_farthest_pair(&nav, a, b);
        assert_eq!(
            (start, finish),
            (nodes[1], nodes[0]),
            "reverse direction (4 hops) is longer than forward (1 hop) -- must swap"
        );
    }

    #[test]
    fn orient_farthest_pair_falls_back_to_original_when_reverse_is_unreachable() {
        let (maze, nodes) = directed_line_maze(3);
        let nav = nav_for(&maze);
        let a = nav.nav_node_for(nodes[0]).unwrap();
        let b = nav.nav_node_for(nodes[2]).unwrap();
        let (start, finish) = orient_farthest_pair(&nav, a, b);
        assert_eq!(
            (start, finish),
            (nodes[0], nodes[2]),
            "no reverse path exists at all -- must keep the original orientation"
        );
    }

    #[test]
    fn apply_fails_on_empty_field_in_exhaustive_mode() {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(1, 1), &mut ids).unwrap();
        let g = Graph::new(); // no nodes registered -- empty field
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        let mut rng = MazeRng::seed_from_u64(1);
        let params = exhaustive_params();
        let (result, _) = RepairStrategy::apply(
            &FarthestEndpointsStrategy,
            &issue(true, true),
            &maze,
            &mut rng,
            &params,
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn orient_farthest_pair_exhaustive_keeps_original_orientation_when_forward_is_longer() {
        // Same shape as `orient_farthest_pair_keeps_original_orientation_when_forward_is_longer`,
        // exercised over the raw graph instead of the nav graph.
        let (maze, nodes) = directed_line_maze(4);
        let (start, finish) = orient_farthest_pair_exhaustive(&maze.graph, nodes[0], nodes[3]);
        assert_eq!((start, finish), (nodes[0], nodes[3]));
    }

    #[test]
    fn orient_farthest_pair_exhaustive_swaps_when_backward_is_longer() {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(5, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = field
            .field_of(field_level)
            .unwrap()
            .all_cells()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        g.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.build_initial_edge(nodes[1], nodes[2], EdgeKind::Basic);
        g.build_initial_edge(nodes[2], nodes[3], EdgeKind::Basic);
        g.build_initial_edge(nodes[3], nodes[4], EdgeKind::Basic);
        g.build_initial_edge(nodes[4], nodes[0], EdgeKind::Basic);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        let (start, finish) = orient_farthest_pair_exhaustive(&maze.graph, nodes[0], nodes[1]);
        assert_eq!(
            (start, finish),
            (nodes[1], nodes[0]),
            "reverse direction (4 hops) is longer than forward (1 hop) -- must swap"
        );
    }

    #[test]
    fn orient_farthest_pair_exhaustive_falls_back_to_original_when_reverse_is_unreachable() {
        let (maze, nodes) = directed_line_maze(3);
        let (start, finish) = orient_farthest_pair_exhaustive(&maze.graph, nodes[0], nodes[2]);
        assert_eq!(
            (start, finish),
            (nodes[0], nodes[2]),
            "no reverse path exists at all -- must keep the original orientation"
        );
    }
}
