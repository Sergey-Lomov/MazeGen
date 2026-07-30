use std::collections::HashSet;
use rand::RngCore;
use rand::seq::SliceRandom;
use crate::Maze;
use crate::ids::NodeId;
use crate::space::Tessellation;

pub const PARAM_SRC_MODE: &str = "src_mode";

pub const SRC_MODE_RANDOM: &str = "random";
pub const SRC_MODE_DEAD_END_PRIORITY: &str = "dead_end_priority";

pub static SRC_MODE_OPTIONS: &[&str] = &[SRC_MODE_RANDOM, SRC_MODE_DEAD_END_PRIORITY];

/// Shared by `MissingLoopsRandomStrategy` and `MissingLoopsSplitStrategy` (GitHub issue #254
/// follow-up, fixed for the exhaustion bug by GitHub issue #278's audit) — both pick a `src` node
/// from a candidate pool, one at a time via `Vec::pop`, before finding it a new geometric neighbor
/// to connect (or split into a bridge). `src_mode: dead_end_priority` orders that pool so dead ends
/// are popped first, so a fix preferentially grows out from the maze's least-connected cells
/// instead of an arbitrary one — but every other candidate is still in the pool behind them, never
/// dropped, so exhausting the dead ends (all consumed or all failed) falls through to the rest of
/// the pool automatically instead of leaving the caller's loop with nothing left to try.
///
/// A dead end is a node with exactly one distinct graph neighbor (counting incoming and outgoing
/// edges together, deduplicated by partner `NodeId`) — a node with a single bidirectional passage
/// to one neighbor counts as a dead end just as much as one with a single one-way edge; two
/// one-way edges to two *different* neighbors does not (that's degree 2, a through-node).
///
/// **One combined pool, ordered for `pop`-based consumption** (see issue #278's audit — judged fine
/// here since callers already do an O(pool) `field.all_node_ids()` scan to build the pool in the
/// first place, so one more O(n) partition pass is not a new order of magnitude): partitions into
/// dead ends and the rest, shuffles each half independently (so same-tier ties resolve randomly,
/// not by incidental input order), then returns `[rest..., dead_ends...]` — dead ends at the end,
/// so a caller popping from the back consumes every dead end before ever reaching a non-dead-end
/// candidate. `src_mode` values other than `dead_end_priority` (including the `random` default)
/// return the pool shuffled but otherwise unpartitioned — plain random consumption order.
pub fn apply_src_mode<T: Tessellation>(
    maze: &Maze<T>,
    mut pool: Vec<NodeId>,
    src_mode: &str,
    rng: &mut dyn RngCore,
) -> Vec<NodeId> {
    if src_mode != SRC_MODE_DEAD_END_PRIORITY {
        pool.shuffle(rng);
        return pool;
    }
    let (mut rest, mut dead_ends): (Vec<NodeId>, Vec<NodeId>) = pool.into_iter().partition(|&n| !is_dead_end(maze, n));
    rest.shuffle(rng);
    dead_ends.shuffle(rng);
    rest.extend(dead_ends);
    rest
}

fn is_dead_end<T: Tessellation>(maze: &Maze<T>, node: NodeId) -> bool {
    let neighbors: HashSet<NodeId> = maze.graph.outgoing_neighbors(node)
        .chain(maze.graph.incoming_neighbors(node))
        .collect();
    neighbors.len() == 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::random::MazeRng;
    use crate::graph::{Graph, EdgeKind};
    use crate::IdGenerator;
    use crate::space::{SquareTessellation, SquarePoint, square_rect, Field};

    fn maze_line(len: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(len, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        Maze::new(field, g)
    }

    #[test]
    fn random_mode_keeps_every_candidate_just_shuffled() {
        let maze = maze_line(3);
        let pool: Vec<NodeId> = maze.field.all_node_ids().collect();
        let mut rng = MazeRng::seed_from_u64(1);
        let mut result = apply_src_mode(&maze, pool.clone(), SRC_MODE_RANDOM, &mut rng);
        result.sort();
        let mut expected = pool;
        expected.sort();
        assert_eq!(result, expected, "every candidate must survive, order aside");
    }

    #[test]
    fn dead_end_priority_puts_dead_ends_at_the_end_for_pop_based_consumption() {
        // 1x3 line, only the middle node connected both ways: ends (nodes[0]/[1]) are dead ends
        // (degree 1), the isolated node (nodes[2], degree 0) is not.
        let mut maze = maze_line(3);
        let nodes: Vec<NodeId> = (0..3).map(|x| maze.field.node_at(SquarePoint { x, y: 0 }).unwrap()).collect();
        maze.graph.add_bidirectional_edge(nodes[0], nodes[1], EdgeKind::Basic);

        let pool: Vec<NodeId> = maze.field.all_node_ids().collect();
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_src_mode(&maze, pool, SRC_MODE_DEAD_END_PRIORITY, &mut rng);
        assert_eq!(result.len(), 3, "every candidate must still be present, not dropped");
        // Last two entries (poppable first) must be exactly the two dead ends, in either order.
        let tail: HashSet<NodeId> = result[1..].iter().copied().collect();
        assert_eq!(tail, HashSet::from([nodes[0], nodes[1]]), "dead ends must occupy the poppable end of the pool");
        assert_eq!(result[0], nodes[2], "the non-dead-end must sit behind the dead ends, not dropped");
    }

    #[test]
    fn dead_end_priority_keeps_original_order_semantics_when_no_dead_end_exists() {
        // Every node isolated (degree 0) — no dead ends anywhere, so the "dead end" partition is
        // empty and the whole pool is just the shuffled `rest` half.
        let maze = maze_line(3);
        let pool: Vec<NodeId> = maze.field.all_node_ids().collect();
        let mut rng = MazeRng::seed_from_u64(1);
        let mut result = apply_src_mode(&maze, pool.clone(), SRC_MODE_DEAD_END_PRIORITY, &mut rng);
        result.sort();
        let mut expected = pool;
        expected.sort();
        assert_eq!(result, expected, "every candidate must survive when none are dead ends");
    }

    #[test]
    fn dead_end_priority_falling_through_reaches_every_non_dead_end_eventually() {
        // Simulates a caller's `while let Some(src) = pool.pop() { ... }` loop consuming the whole
        // pool — every original candidate must be visited exactly once, confirming the dead-end
        // exhaustion case (GitHub issue #278) falls through instead of leaving candidates stranded.
        let mut maze = maze_line(5);
        let nodes: Vec<NodeId> = (0..5).map(|x| maze.field.node_at(SquarePoint { x, y: 0 }).unwrap()).collect();
        maze.graph.add_bidirectional_edge(nodes[0], nodes[1], EdgeKind::Basic);
        maze.graph.add_bidirectional_edge(nodes[3], nodes[4], EdgeKind::Basic);

        let pool: Vec<NodeId> = maze.field.all_node_ids().collect();
        let mut rng = MazeRng::seed_from_u64(7);
        let mut result = apply_src_mode(&maze, pool, SRC_MODE_DEAD_END_PRIORITY, &mut rng);

        let mut visited = Vec::new();
        while let Some(src) = result.pop() {
            visited.push(src);
        }
        visited.sort();
        let mut expected = nodes.clone();
        expected.sort();
        assert_eq!(visited, expected, "popping the whole pool must visit every original candidate exactly once");
    }

    #[test]
    fn bidirectional_passage_counts_as_one_dead_end_not_two_neighbors() {
        // A node with a single bidirectional passage (two directed edges, one partner) must still
        // count as a dead end — degree is measured by distinct partner count, not edge count.
        let mut maze = maze_line(2);
        let nodes: Vec<NodeId> = (0..2).map(|x| maze.field.node_at(SquarePoint { x, y: 0 }).unwrap()).collect();
        maze.graph.add_bidirectional_edge(nodes[0], nodes[1], EdgeKind::Basic);

        assert!(is_dead_end(&maze, nodes[0]));
        assert!(is_dead_end(&maze, nodes[1]));
    }

    #[test]
    fn two_one_way_edges_to_different_neighbors_is_not_a_dead_end() {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<NodeId> = (0..3).map(|x| field.node_at(SquarePoint { x, y: 0 }).unwrap()).collect();
        g.add_edge(nodes[1], nodes[0], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        assert!(!is_dead_end(&maze, nodes[1]), "two distinct neighbors via one-way edges is degree 2, not a dead end");
    }
}
