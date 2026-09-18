use super::dead_end_priority::apply_src_mode;
use crate::Maze;
use crate::ids::NodeId;
use crate::quality_control::RepairArea;
use crate::space::Tessellation;
use rand::{Rng, RngCore};
use std::collections::HashSet;

/// Shared random-candidate-pair search for `MissingOneWaysFromPassageStrategy`/
/// `MissingOneWaysFromWallStrategy` — see GitHub issue #201. Both strategies need the same "pick a
/// random field node, pick a random field-neighbor, test it, evict the node from the pool if none
/// of its neighbors qualify" retry loop; only the per-pair test differs (an existing bidirectional
/// passage vs. a wholly disconnected pair). Mirrors `MissingLoopsRandomStrategy::apply`'s own
/// inline loop, factored out since it's now duplicated by a second caller.
///
/// `try_pair(src, dst, rng)` does both the accept check and the resulting mutation-command commit
/// in one step (it needs `rng` itself, e.g. to randomize which direction a passage/wall pair
/// becomes) — combined into one closure rather than a separate `accept`/`on_candidate` pair, since
/// two closures both wanting to borrow `rng` (one via this function's own `&mut dyn RngCore`
/// parameter, the other for its own direction pick) can't coexist. Returns `true` if the pair was
/// accepted and committed (counted toward `target`), `false` to keep searching (e.g. the pair
/// doesn't qualify, or was already proposed earlier this call). Stops once `target` pairs have
/// been accepted, the pool is exhausted, or `max_failed_attempts` `src` nodes have yielded
/// nothing (`attempts_limit`, GitHub issue #486 — a running total across the call, same as
/// `MissingLoopsRandomStrategy`, not a consecutive streak); returns the number actually accepted.
///
/// `src_mode` (GitHub issue #486) orders the candidate pool via `apply_src_mode` — the pool is
/// consumed from the back (`Vec::pop`), so `dead_end_priority` tries dead-end `src` nodes first
/// while every other candidate stays behind them (never dropped).
pub(super) fn pick_random_pairs<T: Tessellation>(
    maze: &Maze<T>,
    rng: &mut dyn RngCore,
    target: u32,
    area: RepairArea,
    src_mode: &str,
    max_failed_attempts: usize,
    mut try_pair: impl FnMut(NodeId, NodeId, &mut dyn RngCore) -> bool,
) -> u32 {
    let eligible: Vec<NodeId> = maze
        .field
        .all_node_ids()
        .filter(|&n| match area {
            RepairArea::WholeMaze => true,
            RepairArea::Level(level) => maze.field.level_of(n) == Some(level),
        })
        .collect();
    let mut pool: Vec<NodeId> = apply_src_mode(maze, eligible, src_mode, rng);
    let mut found: u32 = 0;
    // A popped `src` that connects nothing counts against the budget (running total, not a streak).
    let mut failed_attempts: usize = 0;

    while found < target && !pool.is_empty() && failed_attempts < max_failed_attempts {
        // Pop from the end, not a random index — `apply_src_mode` orders the pool so dead-end
        // candidates sit at this end when `dead_end_priority` is active; a random-index pick would
        // destroy that ordering. Every neighbor of `src` is offered below regardless of outcome,
        // so `src` is never worth revisiting this call either way.
        let src = pool
            .pop()
            .expect("pool.is_empty() already checked by the while condition");

        let mut neighbors = maze.field.neighbors(src);
        let mut connected = false;

        while !neighbors.is_empty() {
            let n_pick = rng.random_range(0..neighbors.len());
            let dst = neighbors.swap_remove(n_pick);

            if !try_pair(src, dst, rng) {
                continue;
            }
            found += 1;
            connected = true;
            break;
        }

        if !connected {
            failed_attempts += 1;
        }
    }

    found
}

/// Both directions of a node pair, canonicalized so `(a, b)` and `(b, a)` dedup to the same key —
/// used by both strategies to track pairs already proposed as a command this call (mirrors
/// `MissingLoopsRandomStrategy::proposed_pairs`, which needs no canonicalization since it only
/// ever proposes one direction of a pair once).
pub(super) fn canonical_pair(a: NodeId, b: NodeId) -> (NodeId, NodeId) {
    if a <= b { (a, b) } else { (b, a) }
}

pub(super) type ProposedPairs = HashSet<(NodeId, NodeId)>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::IdGenerator;
    use crate::graph::Graph;
    use crate::random::MazeRng;
    use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use rand::SeedableRng;

    /// 1x3 corridor, all three nodes in the pool but only the middle one (n1) has two neighbors
    /// (n0, n2) — isolates the "reject one neighbor, retry the next" branch from pool eviction
    /// (a 1-neighbor node can only ever hit accept-immediately or evict, never a retry).
    fn maze_with_middle_node_having_two_neighbors()
    -> (Maze<SquareTessellation>, NodeId, NodeId, NodeId) {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
        let (n0, n1, n2) = (p(0), p(1), p(2));
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        (maze, n0, n1, n2)
    }

    #[test]
    fn retries_the_next_neighbor_when_the_first_is_rejected_without_evicting_the_node() {
        let (maze, n0, n1, n2) = maze_with_middle_node_having_two_neighbors();
        let mut rng = MazeRng::seed_from_u64(0);

        // n0/n2 (single-neighbor nodes) reject unconditionally as src -- their only neighbor is
        // n1, so a rejection evicts them for good, regardless of retry behavior. This forces n1
        // to eventually be the only node left in the pool as `src` (it can also appear earlier as
        // some other node's rejected `dst`, which is ignored here -- only src==n1 exercises the
        // branch under test). Once n1 is `src`, its *first* offered neighbor is rejected and its
        // second accepted: if pick_random_pairs evicted a node after just one rejected neighbor
        // instead of retrying the rest, n1 would be evicted empty-handed too, and the whole pool
        // would exhaust with `found` stuck at 0.
        let mut n1_first_candidate: Option<NodeId> = None;
        let found = pick_random_pairs(
            &maze,
            &mut rng,
            1,
            RepairArea::WholeMaze,
            super::super::dead_end_priority::SRC_MODE_RANDOM,
            usize::MAX,
            |src, dst, _rng| {
                if src != n1 {
                    return false;
                }
                if n1_first_candidate.is_none() {
                    n1_first_candidate = Some(dst);
                    return false;
                }
                true
            },
        );

        assert_eq!(
            found, 1,
            "n1's rejected first neighbor must not evict it -- it must retry and pair via its second neighbor"
        );
        assert!(
            n1_first_candidate == Some(n0) || n1_first_candidate == Some(n2),
            "sanity check: n1 must have been tried as src with one of its two neighbors first"
        );
    }
}
