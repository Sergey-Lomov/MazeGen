use super::dead_end_priority::apply_src_mode;
use crate::Maze;
use crate::ids::NodeId;
use crate::space::Tessellation;
use rand::RngCore;

/// Shared candidate-pool abstraction for element-adding strategies (GitHub issue #521, part of
/// epic #520). Wraps the ordering (`apply_src_mode`: dead-end-priority vs shuffled) and
/// pop-from-end consumption that `AddElevatorStrategy`, `AddSplitStrategy`, and
/// `AddVerticalPassageStrategy` each reimplemented inline as a raw `Vec<NodeId>`.
///
/// **Consumption only, no retry budget.** `attempts_limit` accounting stays with each strategy's
/// own loop (their semantics differ: `AddElevatorStrategy` resets a per-slot attempt count,
/// `AddSplitStrategy`/`AddVerticalPassageStrategy` run one running total per area) — folding it in
/// here would force one semantics onto every caller. A candidate that fails its attempt is simply
/// never returned again (`take` already removed it), same as the strategies' own prior inline
/// handling.
pub struct Pool {
    items: Vec<NodeId>,
}

impl Pool {
    /// Builds a pool from `candidates`, ordered by `src_mode` (see `apply_src_mode`) — dead ends
    /// last (poppable first) under `dead_end_priority`, otherwise shuffled.
    pub fn new<T: Tessellation>(
        candidates: Vec<NodeId>,
        src_mode: &str,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
    ) -> Self {
        Pool {
            items: apply_src_mode(maze, candidates, src_mode, rng),
        }
    }

    /// Removes and returns the next candidate to try, or `None` once the pool is exhausted.
    /// Pops from the end, matching `apply_src_mode`'s dead-ends-last ordering.
    pub fn take(&mut self) -> Option<NodeId> {
        self.items.pop()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::super::dead_end_priority::SRC_MODE_RANDOM;
    use super::*;
    use crate::Graph;
    use crate::IdGenerator;
    use crate::random::MazeRng;
    use crate::space::{MultiLevelField, SquareTessellation, square_rect};
    use rand::SeedableRng;

    fn maze_line(len: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(square_rect(len, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        Maze::new(field, g)
    }

    #[test]
    fn take_returns_every_candidate_exactly_once_then_none() {
        let maze = maze_line(4);
        let candidates: Vec<NodeId> = maze.field.all_node_ids().collect();
        let mut rng = MazeRng::seed_from_u64(1);
        let mut pool = Pool::new(candidates.clone(), SRC_MODE_RANDOM, &maze, &mut rng);

        let mut taken = Vec::new();
        while let Some(n) = pool.take() {
            taken.push(n);
        }
        taken.sort();
        let mut expected = candidates;
        expected.sort();
        assert_eq!(taken, expected);
        assert!(pool.is_empty());
        assert_eq!(pool.take(), None);
    }

    #[test]
    fn empty_candidates_is_empty_immediately() {
        let maze = maze_line(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let mut pool = Pool::new(vec![], SRC_MODE_RANDOM, &maze, &mut rng);
        assert!(pool.is_empty());
        assert_eq!(pool.take(), None);
    }
}
