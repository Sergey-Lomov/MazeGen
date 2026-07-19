use rand::{Rng, RngCore};
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::MissingOneWaysIssue;
use crate::generation::PresetState;
use crate::repair::params::StrategyParams;
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::command::MutationCommand;
use super::missing_one_ways_shared::{pick_random_pairs, canonical_pair, ProposedPairs};

/// Handles `MISSING_ONE_WAYS` — one of the two registered strategies (see
/// `MissingOneWaysFromPassageStrategy` for the other) — see GitHub issue #201. Picks random pairs
/// of adjacent field cells that are entirely disconnected (a wall) and adds a single directed
/// `Basic` edge between them at random, turning the wall into a one-way. No route protection
/// needed — unlike an existing passage, a wall was never part of any start->finish route.
pub struct MissingOneWaysFromWallStrategy;

impl<T: Tessellation> RepairStrategy<T, MissingOneWaysIssue> for MissingOneWaysFromWallStrategy {
    fn strategy_id(&self) -> &'static str { "missing_one_ways_from_wall" }

    fn apply(
        &self,
        issue: &MissingOneWaysIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        _params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let target = issue.missing;
        if target == 0 {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        let mut proposed: ProposedPairs = ProposedPairs::default();
        let mut commands = Vec::new();

        let found = pick_random_pairs(
            maze,
            rng,
            target,
            |src, dst, rng| {
                if proposed.contains(&canonical_pair(src, dst)) {
                    return false;
                }
                // A wall: no edge of any kind in either direction between the pair.
                if maze.graph.edge_between(src, dst).is_some() || maze.graph.edge_between(dst, src).is_some() {
                    return false;
                }

                proposed.insert(canonical_pair(src, dst));
                let add_fwd = crate::generation::directed_edge_feasible(preset_state, src, dst);
                let add_bwd = crate::generation::directed_edge_feasible(preset_state, dst, src);
                let (from, to) = if add_fwd && add_bwd {
                    if rng.random::<bool>() { (src, dst) } else { (dst, src) }
                } else if add_fwd {
                    (src, dst)
                } else if add_bwd {
                    (dst, src)
                } else {
                    return false;
                };
                commands.push(MutationCommand::AddDirectedEdge { from, to });
                true
            },
        );

        if found == 0 {
            return (RepairResult::Failed, vec![]);
        }
        (RepairResult::Fixed { score: None }, commands)
    }
}

crate::impl_erased_repair_strategy!(MissingOneWaysFromWallStrategy, MissingOneWaysIssue);

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::random::MazeRng;
    use crate::graph::{Graph, EdgeKind};
    use crate::IdGenerator;
    use crate::space::{SquareTessellation, square_rect, Field};
    use crate::repair::strategies::test_utils::apply_and_commit_default;

    fn missing_issue(missing: u32) -> MissingOneWaysIssue {
        MissingOneWaysIssue::new_from_check("min_one_way_count", missing)
    }

    fn maze_grid(side: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(side, side), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        Maze::new(field, g)
    }

    #[test]
    fn apply_succeeds_immediately_when_nothing_missing() {
        let mut maze = maze_grid(3);
        let issue = missing_issue(0);
        let mut rng = MazeRng::seed_from_u64(7);
        let result = apply_and_commit_default(&MissingOneWaysFromWallStrategy, &issue, &mut maze, &mut rng, &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.graph.edges().count(), 0);
    }

    #[test]
    fn apply_adds_one_way_edges_between_walled_pairs() {
        let mut maze = maze_grid(4);
        let issue = missing_issue(2);
        let mut rng = MazeRng::seed_from_u64(42);
        let result = apply_and_commit_default(&MissingOneWaysFromWallStrategy, &issue, &mut maze, &mut rng, &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.graph.edges().count(), 2);
        for edge in maze.graph.edges() {
            assert_eq!(edge.kind, EdgeKind::Basic);
            assert!(maze.graph.edge_between(edge.to, edge.from).is_none(), "each added edge must be one-way");
        }
    }

    #[test]
    fn apply_does_not_pick_an_already_connected_pair() {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(2, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_bidirectional_edge(nodes[0], nodes[1], EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit_default(&MissingOneWaysFromWallStrategy, &issue, &mut maze, &mut rng, &PresetState::empty());
        assert!(matches!(result, RepairResult::Failed), "only pair on the field is already connected");
        assert_eq!(maze.graph.edges().count(), 2);
    }

    #[test]
    fn apply_does_not_add_when_both_directions_locked() {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(2, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let mut preset_state = PresetState::empty();
        preset_state.blocked.insert((nodes[0], nodes[1]));
        preset_state.blocked.insert((nodes[1], nodes[0]));

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit_default(&MissingOneWaysFromWallStrategy, &issue, &mut maze, &mut rng, &preset_state);
        assert!(matches!(result, RepairResult::Failed));
        assert_eq!(maze.graph.edges().count(), 0);
    }

    #[test]
    fn apply_uses_the_only_free_direction_when_one_is_locked() {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(2, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let mut preset_state = PresetState::empty();
        preset_state.blocked.insert((nodes[0], nodes[1]));

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit_default(&MissingOneWaysFromWallStrategy, &issue, &mut maze, &mut rng, &preset_state);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(maze.graph.edge_between(nodes[1], nodes[0]).is_some(), "must use the only unblocked direction");
        assert!(maze.graph.edge_between(nodes[0], nodes[1]).is_none());
    }

    #[test]
    fn apply_is_deterministic_for_fixed_seed() {
        let issue = missing_issue(2);

        let mut maze_a = maze_grid(4);
        let mut rng_a = MazeRng::seed_from_u64(123);
        apply_and_commit_default(&MissingOneWaysFromWallStrategy, &issue, &mut maze_a, &mut rng_a, &PresetState::empty());

        let mut maze_b = maze_grid(4);
        let mut rng_b = MazeRng::seed_from_u64(123);
        apply_and_commit_default(&MissingOneWaysFromWallStrategy, &issue, &mut maze_b, &mut rng_b, &PresetState::empty());

        let edges_a: Vec<_> = maze_a.graph.edges().map(|e| (e.from, e.to)).collect();
        let edges_b: Vec<_> = maze_b.graph.edges().map(|e| (e.from, e.to)).collect();
        assert_eq!(edges_a, edges_b);
    }
}
