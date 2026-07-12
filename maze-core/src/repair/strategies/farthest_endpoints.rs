use rand::{Rng, RngCore};
use crate::Maze;
use crate::ids::NodeId;
use crate::space::Tessellation;
use crate::graph::nav::NavGraph;
use crate::graph::pathfinding::{dijkstra_forward, dijkstra_reverse};
use crate::quality_control::MissingEndpointsIssue;
use crate::repair::params::StrategyParams;
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::command::MutationCommand;
use crate::generation::PresetState;

pub struct FarthestEndpointsStrategy;

impl<T: Tessellation> RepairStrategy<T, MissingEndpointsIssue> for FarthestEndpointsStrategy {
    fn strategy_id(&self) -> &'static str { "farthest_endpoints" }

    fn apply(&self, _issue: &MissingEndpointsIssue, maze: &Maze<T>, rng: &mut dyn RngCore, _params: &StrategyParams, _preset_state: &PresetState, _nested: &[NestedStrategyConfig<T>]) -> (RepairResult, Vec<MutationCommand>) {
        if maze.meta.start.is_some() && maze.meta.finish.is_some() {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
        let nav = &nav;

        if nav.nodes.is_empty() {
            return (RepairResult::Failed, vec![]);
        }

        let commands = match (maze.meta.start, maze.meta.finish) {
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
                    return (RepairResult::Failed, vec![]);
                }
                let finish_nav = nav.nav_node_for(finish_node).unwrap();

                // The graph is directed: dist(start->finish) can differ from dist(finish->start).
                // The sweep above only measured one direction — check the other and swap if it's longer.
                let (start_node, finish_node) = orient_farthest_pair(nav, start_nav, finish_nav);

                vec![MutationCommand::SetStart(start_node), MutationCommand::SetFinish(finish_node)]
            }
            (Some(start), None) => {
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
            (None, Some(finish)) => {
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
            (Some(_), Some(_)) => unreachable!(),
        };

        (RepairResult::Fixed { score: None }, commands)
    }
}

crate::impl_erased_repair_strategy!(FarthestEndpointsStrategy, MissingEndpointsIssue);

fn farthest_from(nav: &NavGraph, source: usize) -> NodeId {
    let dist = dijkstra_forward(nav, source);
    dist.iter().enumerate()
        .filter(|&(_, &d)| d != usize::MAX)
        .max_by_key(|&(nav_id, &d)| (d, std::cmp::Reverse(nav.nodes[nav_id].node_id)))
        .map(|(nav_id, _)| nav.nodes[nav_id].node_id)
        .unwrap_or(nav.nodes[source].node_id)
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

fn farthest_to(nav: &NavGraph, target: usize) -> NodeId {
    let dist = dijkstra_reverse(nav, target);
    dist.iter().enumerate()
        .filter(|&(_, &d)| d != usize::MAX)
        .max_by_key(|&(nav_id, &d)| (d, std::cmp::Reverse(nav.nodes[nav_id].node_id)))
        .map(|(nav_id, _)| nav.nodes[nav_id].node_id)
        .unwrap_or(nav.nodes[target].node_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::random::MazeRng;
    use crate::graph::{Graph, EdgeKind};
    use crate::IdGenerator;
    use crate::space::{SquareTessellation, square_rect, Field};
    use crate::repair::strategies::test_utils::apply_and_commit_default as apply_and_commit;

    fn issue() -> MissingEndpointsIssue { MissingEndpointsIssue::default() }

    /// Directed line 0->1->2->3->4 (each hop one-way) -- a straightforward chain where "farthest"
    /// is unambiguous in each direction.
    fn directed_line_maze(len: usize) -> (Maze<SquareTessellation>, Vec<crate::ids::NodeId>) {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(len, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        for i in 0..len - 1 {
            g.build_initial_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
        }
        (Maze::new(field, g), nodes)
    }

    fn bidirectional_line_maze(len: usize) -> (Maze<SquareTessellation>, Vec<crate::ids::NodeId>) {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(len, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
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
        let result = apply_and_commit(&FarthestEndpointsStrategy, &issue(), &mut maze, &mut rng, &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: None }));
    }

    #[test]
    fn apply_fails_on_empty_nav_graph() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(1, 1), &mut ids).unwrap();
        let g = Graph::new(); // no nodes registered -- empty nav graph
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&FarthestEndpointsStrategy, &issue(), &mut maze, &mut rng, &PresetState::empty());
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn neither_set_places_endpoints_at_the_two_ends_of_a_bidirectional_line() {
        let (mut maze, nodes) = bidirectional_line_maze(5);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&FarthestEndpointsStrategy, &issue(), &mut maze, &mut rng, &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        let (start, finish) = (maze.meta.start.unwrap(), maze.meta.finish.unwrap());
        assert!((start == nodes[0] && finish == nodes[4]) || (start == nodes[4] && finish == nodes[0]),
            "on a straight line the farthest pair must be the two ends, got {start} -> {finish}");
    }

    #[test]
    fn neither_set_fails_when_farthest_equals_source_on_a_single_isolated_node() {
        let mut maze = {
            let mut ids = IdGenerator::new();
            let field = Field::new(square_rect(1, 1), &mut ids).unwrap();
            let mut g = Graph::new();
            field.build_nodes(&mut g);
            Maze::<SquareTessellation>::new(field, g)
        };
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&FarthestEndpointsStrategy, &issue(), &mut maze, &mut rng, &PresetState::empty());
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn only_start_set_picks_the_farthest_reachable_node_as_finish() {
        let (mut maze, nodes) = directed_line_maze(5);
        maze.meta.start = Some(nodes[0]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&FarthestEndpointsStrategy, &issue(), &mut maze, &mut rng, &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.meta.start, Some(nodes[0]));
        assert_eq!(maze.meta.finish, Some(nodes[4]), "farthest forward-reachable node on a directed chain is the last one");
    }

    #[test]
    fn only_start_set_fails_when_start_cannot_reach_anything() {
        // Directed edge pointing INTO node 0 (1 -> 0), so node 0 (start) has no outgoing reach.
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(2, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.build_initial_edge(nodes[1], nodes[0], EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta.start = Some(nodes[0]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&FarthestEndpointsStrategy, &issue(), &mut maze, &mut rng, &PresetState::empty());
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn only_finish_set_picks_the_farthest_node_that_can_reach_it_as_start() {
        let (mut maze, nodes) = directed_line_maze(5);
        maze.meta.finish = Some(nodes[4]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&FarthestEndpointsStrategy, &issue(), &mut maze, &mut rng, &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.meta.finish, Some(nodes[4]));
        assert_eq!(maze.meta.start, Some(nodes[0]), "farthest node able to reach finish on a directed chain is the first one");
    }

    #[test]
    fn only_finish_set_fails_when_nothing_can_reach_it() {
        // Directed edge pointing OUT of node 1 (1 -> 0), so nothing besides finish itself can
        // reach node 1 (finish) via incoming edges.
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(2, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.build_initial_edge(nodes[1], nodes[0], EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta.finish = Some(nodes[1]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&FarthestEndpointsStrategy, &issue(), &mut maze, &mut rng, &PresetState::empty());
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn only_start_set_fails_when_start_node_not_in_nav_graph() {
        let (mut maze, _) = bidirectional_line_maze(3);
        maze.meta.start = Some(999_999);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&FarthestEndpointsStrategy, &issue(), &mut maze, &mut rng, &PresetState::empty());
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn only_finish_set_fails_when_finish_node_not_in_nav_graph() {
        let (mut maze, _) = bidirectional_line_maze(3);
        maze.meta.finish = Some(999_999);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&FarthestEndpointsStrategy, &issue(), &mut maze, &mut rng, &PresetState::empty());
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn apply_is_deterministic_for_fixed_seed() {
        let (mut maze_a, _) = bidirectional_line_maze(6);
        let mut rng_a = MazeRng::seed_from_u64(42);
        apply_and_commit(&FarthestEndpointsStrategy, &issue(), &mut maze_a, &mut rng_a, &PresetState::empty());

        let (mut maze_b, _) = bidirectional_line_maze(6);
        let mut rng_b = MazeRng::seed_from_u64(42);
        apply_and_commit(&FarthestEndpointsStrategy, &issue(), &mut maze_b, &mut rng_b, &PresetState::empty());

        assert_eq!(maze_a.meta.start, maze_b.meta.start);
        assert_eq!(maze_a.meta.finish, maze_b.meta.finish);
    }

    // ─── orient_farthest_pair / farthest_from / farthest_to (direct unit tests) ────────────

    fn nav_for(maze: &Maze<SquareTessellation>) -> NavGraph {
        maze.analysis.nav_graph(&maze.graph, &maze.meta)
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
        let field = Field::new(square_rect(5, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
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
        assert_eq!((start, finish), (nodes[1], nodes[0]), "reverse direction (4 hops) is longer than forward (1 hop) -- must swap");
    }

    #[test]
    fn orient_farthest_pair_falls_back_to_original_when_reverse_is_unreachable() {
        let (maze, nodes) = directed_line_maze(3);
        let nav = nav_for(&maze);
        let a = nav.nav_node_for(nodes[0]).unwrap();
        let b = nav.nav_node_for(nodes[2]).unwrap();
        let (start, finish) = orient_farthest_pair(&nav, a, b);
        assert_eq!((start, finish), (nodes[0], nodes[2]), "no reverse path exists at all -- must keep the original orientation");
    }

    #[test]
    fn farthest_from_breaks_ties_by_lowest_node_id() {
        // Star-shaped: center connects one-way to two equally-distant leaves. Tie must break
        // toward the lower NodeId (Determinism Contract, Specs/repair.md).
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.build_initial_edge(nodes[0], nodes[2], EdgeKind::Basic);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        let nav = nav_for(&maze);
        let source = nav.nav_node_for(nodes[0]).unwrap();
        let farthest = farthest_from(&nav, source);
        assert_eq!(farthest, nodes[1], "tie between nodes[1]/nodes[2] must break toward the lower NodeId");
    }

    #[test]
    fn farthest_from_returns_source_itself_when_nothing_else_is_reachable() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(1, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        let nav = nav_for(&maze);
        let source = nav.nav_node_for(nodes[0]).unwrap();
        assert_eq!(farthest_from(&nav, source), nodes[0]);
    }

    #[test]
    fn farthest_to_finds_the_node_with_the_longest_incoming_path() {
        let (maze, nodes) = directed_line_maze(4);
        let nav = nav_for(&maze);
        let target = nav.nav_node_for(nodes[3]).unwrap();
        assert_eq!(farthest_to(&nav, target), nodes[0], "node farthest upstream from the target via reverse BFS");
    }
}
