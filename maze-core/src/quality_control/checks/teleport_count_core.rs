use std::collections::{HashMap, HashSet};
use crate::Maze;
use crate::ids::NodeId;
use crate::space::{LevelId, Tessellation};
use crate::graph::EdgeKind;
use crate::quality_control::floor_group::floors_of_node;

/// Counts distinct teleports on the field — shared by `MinTeleportCountCheck`/
/// `MinTeleportRatioCheck` (GitHub issue #211). A bidirectional teleport (`A->B` plus a parallel
/// `B->A`, both `EdgeKind::Teleport`) is one logical portal, not two: each direction is built as
/// its own `Teleport`-kind edge (see `maze-wasm/src/analytics.rs`'s
/// `build_graph_from_post_edit_edges` doc comment), so counting raw edges would double-count
/// every bidirectional teleport relative to a one-way teleport. Dedups by the unordered node pair
/// instead.
pub fn count_distinct_teleports<T: Tessellation>(maze: &Maze<T>) -> u32 {
    distinct_teleport_pairs(maze).len() as u32
}

/// Distinct teleport portals as unordered node pairs — same dedup as `count_distinct_teleports`,
/// exposed for `floor_scope: PerFloor` grouping (GitHub issue #369).
fn distinct_teleport_pairs<T: Tessellation>(maze: &Maze<T>) -> HashSet<(NodeId, NodeId)> {
    let mut seen_pairs: HashSet<(NodeId, NodeId)> = HashSet::new();
    for edge in maze.graph.edges().filter(|e| e.kind == EdgeKind::Teleport) {
        let pair = if edge.from <= edge.to { (edge.from, edge.to) } else { (edge.to, edge.from) };
        seen_pairs.insert(pair);
    }
    seen_pairs
}

/// Per-floor distinct teleport counts — a teleport whose two ends sit on different floors counts
/// toward both (GitHub issue #369). Floors with no teleport still appear with a count of 0, so
/// callers can compute a deficit/excess against every floor.
pub fn count_distinct_teleports_per_floor<T: Tessellation>(maze: &Maze<T>) -> HashMap<LevelId, u32> {
    let mut per_floor: HashMap<LevelId, u32> =
        maze.field.levels_ordered().map(|l| (l, 0)).collect();
    for (from, to) in distinct_teleport_pairs(maze) {
        let mut floors = floors_of_node(&maze.field, from);
        floors.extend(floors_of_node(&maze.field, to));
        for level in floors {
            *per_floor.entry(level).or_insert(0) += 1;
        }
    }
    per_floor
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Graph, IdGenerator};
    use crate::space::{MultiLevelField, SquareTessellation, SquarePoint, square_rect};

    fn maze_with_edges(edges: &[(i32, i32, EdgeKind)]) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(4, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
        for (from, to, kind) in edges {
            g.add_edge(p(*from), p(*to), kind.clone());
        }
        Maze::new(field, g)
    }

    #[test]
    fn a_one_way_teleport_counts_as_one() {
        let maze = maze_with_edges(&[(0, 1, EdgeKind::Teleport)]);
        assert_eq!(count_distinct_teleports(&maze), 1);
    }

    #[test]
    fn a_bidirectional_teleport_pair_counts_as_one() {
        let maze = maze_with_edges(&[(0, 1, EdgeKind::Teleport), (1, 0, EdgeKind::Teleport)]);
        assert_eq!(count_distinct_teleports(&maze), 1, "A<->B is one logical portal, not two");
    }

    #[test]
    fn two_independent_teleports_count_as_two() {
        let maze = maze_with_edges(&[(0, 1, EdgeKind::Teleport), (2, 3, EdgeKind::Teleport)]);
        assert_eq!(count_distinct_teleports(&maze), 2);
    }

    #[test]
    fn a_basic_edge_is_ignored() {
        let maze = maze_with_edges(&[(0, 1, EdgeKind::Basic)]);
        assert_eq!(count_distinct_teleports(&maze), 0);
    }
}
