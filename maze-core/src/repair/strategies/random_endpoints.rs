use crate::Maze;
use crate::generation::PresetState;
use crate::quality_control::MissingEndpointsIssue;
use crate::repair::command::MutationCommand;
use crate::repair::params::StrategyParams;
use crate::repair::result::RepairResult;
use crate::repair::strategy::{NestedStrategyConfig, RepairStrategy};
use crate::space::Tessellation;
use rand::{Rng, RngCore};

pub struct RandomEndpointsStrategy;

impl<T: Tessellation> RepairStrategy<T, MissingEndpointsIssue> for RandomEndpointsStrategy {
    fn strategy_id(&self) -> &'static str {
        "random_endpoints"
    }

    fn apply(
        &self,
        issue: &MissingEndpointsIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        _params: &StrategyParams,
        _preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        if !issue.missing_start && !issue.missing_finish {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        let mut commands = Vec::new();
        let start = if !issue.missing_start {
            maze.meta.start.expect("missing_start is false")
        } else {
            let candidates = if issue.missing_finish {
                let mut nodes: Vec<_> = maze.graph.nodes().map(|n| n.id).collect();
                if nodes.is_empty() {
                    return (RepairResult::Failed, vec![]);
                }
                nodes.sort_unstable();
                nodes
            } else {
                let finish = maze.meta.finish.expect("missing_finish is false");
                let mut nodes = maze.graph.reachable_to(finish);
                nodes.retain(|&id| id != finish);
                if nodes.is_empty() {
                    return (RepairResult::Failed, vec![]);
                }
                nodes
            };
            let idx = rng.random_range(0..candidates.len());
            let picked = candidates[idx];
            commands.push(MutationCommand::SetStart(picked));
            picked
        };

        if issue.missing_finish {
            let mut candidates = maze.graph.reachable_from(start);
            candidates.retain(|&id| id != start);
            if candidates.is_empty() {
                return (RepairResult::Failed, vec![]);
            }
            let idx = rng.random_range(0..candidates.len());
            commands.push(MutationCommand::SetFinish(candidates[idx]));
        }

        (RepairResult::Fixed { score: None }, commands)
    }
}

crate::impl_erased_repair_strategy!(RandomEndpointsStrategy, MissingEndpointsIssue);

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

    fn make_connected_maze(n: usize) -> (Maze<SquareTessellation>, Vec<crate::ids::NodeId>) {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(n, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = field
            .field_of(field_level)
            .unwrap()
            .all_points()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        for i in 0..n - 1 {
            g.build_initial_bidirectional_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
        }
        (Maze::new(field, g), nodes)
    }

    fn issue(missing_start: bool, missing_finish: bool) -> MissingEndpointsIssue {
        MissingEndpointsIssue::new_from_check("test", missing_start, missing_finish)
    }

    #[test]
    fn apply_fixed_immediately_when_both_already_set() {
        let (mut maze, nodes) = make_connected_maze(3);
        maze.meta.start = Some(nodes[0]);
        maze.meta.finish = Some(nodes[2]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &RandomEndpointsStrategy,
            &issue(false, false),
            &mut maze,
            &mut rng,
            &PresetState::empty(),
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
    }

    #[test]
    fn neither_set_picks_start_and_finish_from_all_nodes() {
        let (mut maze, nodes) = make_connected_maze(3);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &RandomEndpointsStrategy,
            &issue(true, true),
            &mut maze,
            &mut rng,
            &PresetState::empty(),
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(maze.meta.start.is_some());
        assert!(maze.meta.finish.is_some());
        assert_ne!(
            maze.meta.start, maze.meta.finish,
            "start and finish must never be the same node"
        );
        assert!(nodes.contains(&maze.meta.start.unwrap()));
        assert!(nodes.contains(&maze.meta.finish.unwrap()));
    }

    #[test]
    fn neither_set_fails_on_empty_graph() {
        // A field must have at least one node (`Field::new` errors on empty input), so simulate
        // "no candidates" via an empty graph with no nodes registered at all.
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(1, 1), &mut ids).unwrap();
        let g = Graph::new(); // deliberately not populated via build_nodes
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &RandomEndpointsStrategy,
            &issue(true, true),
            &mut maze,
            &mut rng,
            &PresetState::empty(),
        );
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn only_finish_set_picks_start_from_nodes_that_can_reach_finish() {
        let (mut maze, nodes) = make_connected_maze(4);
        maze.meta.finish = Some(nodes[3]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &RandomEndpointsStrategy,
            &issue(true, false),
            &mut maze,
            &mut rng,
            &PresetState::empty(),
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.meta.finish, Some(nodes[3]));
        let start = maze.meta.start.expect("start must be set");
        assert_ne!(start, nodes[3], "candidates must exclude finish itself");
        assert!(
            maze.graph.reachable_to(nodes[3]).contains(&start),
            "picked start must be able to reach finish"
        );
    }

    #[test]
    fn only_finish_set_fails_when_nothing_can_reach_it() {
        // Directed one-way chain 0->1->2 (finish), plus an isolated node 3 with no edges at all
        // -- nothing outside {finish} can reach finish except node 2, so exclude that too via a
        // fully disconnected graph: no edges at all means only finish itself is "reachable to
        // finish", and after excluding finish, candidates is empty.
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
            .all_points()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta.finish = Some(nodes[1]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &RandomEndpointsStrategy,
            &issue(true, false),
            &mut maze,
            &mut rng,
            &PresetState::empty(),
        );
        assert!(matches!(result, RepairResult::Failed));
        assert!(maze.meta.start.is_none());
    }

    #[test]
    fn only_start_set_picks_finish_from_nodes_reachable_from_start() {
        let (mut maze, nodes) = make_connected_maze(4);
        maze.meta.start = Some(nodes[0]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &RandomEndpointsStrategy,
            &issue(false, true),
            &mut maze,
            &mut rng,
            &PresetState::empty(),
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.meta.start, Some(nodes[0]));
        let finish = maze.meta.finish.expect("finish must be set");
        assert_ne!(finish, nodes[0], "candidates must exclude start itself");
        assert!(
            maze.graph.reachable_from(nodes[0]).contains(&finish),
            "picked finish must be reachable from start"
        );
    }

    #[test]
    fn only_start_set_fails_when_start_cannot_reach_anything() {
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
            .all_points()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta.start = Some(nodes[0]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &RandomEndpointsStrategy,
            &issue(false, true),
            &mut maze,
            &mut rng,
            &PresetState::empty(),
        );
        assert!(matches!(result, RepairResult::Failed));
        assert!(maze.meta.finish.is_none());
    }

    #[test]
    fn apply_is_deterministic_for_fixed_seed() {
        let (mut maze_a, _) = make_connected_maze(5);
        let mut rng_a = MazeRng::seed_from_u64(42);
        apply_and_commit(
            &RandomEndpointsStrategy,
            &issue(true, true),
            &mut maze_a,
            &mut rng_a,
            &PresetState::empty(),
        );

        let (mut maze_b, _) = make_connected_maze(5);
        let mut rng_b = MazeRng::seed_from_u64(42);
        apply_and_commit(
            &RandomEndpointsStrategy,
            &issue(true, true),
            &mut maze_b,
            &mut rng_b,
            &PresetState::empty(),
        );

        assert_eq!(maze_a.meta.start, maze_b.meta.start);
        assert_eq!(maze_a.meta.finish, maze_b.meta.finish);
    }
}
