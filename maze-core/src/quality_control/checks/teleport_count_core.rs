use std::collections::{HashMap, HashSet};
use crate::Maze;
use crate::ids::{EdgeId, NodeId};
use crate::space::{LevelId, Tessellation};
use crate::graph::EdgeKind;
use crate::quality_control::floor_group::floors_of_node;
use crate::quality_control::{TeleportDirectionFilter, TeleportFloorKindFilter};

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
    distinct_teleport_edge_representatives(maze).into_iter()
        .map(|(_, from, to)| (from, to))
        .collect()
}

/// True if `from -> to` has a parallel `to -> from` teleport edge — `directed_pairs` is the set of
/// every `(from, to)` teleport edge in the graph, built once by the caller so this stays O(1)
/// instead of re-scanning all edges per portal (see `distinct_teleport_edge_representatives`'s
/// callers, which build it once via `teleport_directed_pairs`).
fn has_reverse(directed_pairs: &HashSet<(NodeId, NodeId)>, from: NodeId, to: NodeId) -> bool {
    directed_pairs.contains(&(to, from))
}

/// True if a portal `from -> to` matches `direction` — `Bidirectional` requires a parallel
/// `to -> from` teleport edge to exist, `Unidirectional` requires it not to, `Any` always matches.
fn matches_direction(directed_pairs: &HashSet<(NodeId, NodeId)>, from: NodeId, to: NodeId, direction: TeleportDirectionFilter) -> bool {
    match direction {
        TeleportDirectionFilter::Any => true,
        TeleportDirectionFilter::Bidirectional => has_reverse(directed_pairs, from, to),
        TeleportDirectionFilter::Unidirectional => !has_reverse(directed_pairs, from, to),
    }
}

/// Every directed `(from, to)` teleport edge in the graph — built once per call site so
/// `matches_direction` can do an O(1) lookup instead of `Graph::teleport_reverse`'s O(E) scan per
/// portal (GitHub issue #379 follow-up).
fn teleport_directed_pairs<T: Tessellation>(maze: &Maze<T>) -> HashSet<(NodeId, NodeId)> {
    maze.graph.edges().filter(|e| e.kind == EdgeKind::Teleport).map(|e| (e.from, e.to)).collect()
}

/// True if the portal between `from`/`to` matches `floor_kind` — `InterFloor` requires the two
/// endpoints to share no floor (see `floors_of_node`), `SameFloor` requires them to share at least
/// one, `Any` always matches.
fn matches_floor_kind<T: Tessellation>(maze: &Maze<T>, from: NodeId, to: NodeId, floor_kind: TeleportFloorKindFilter) -> bool {
    match floor_kind {
        TeleportFloorKindFilter::Any => true,
        TeleportFloorKindFilter::InterFloor | TeleportFloorKindFilter::SameFloor => {
            let from_floors = floors_of_node(&maze.field, from);
            let to_floors = floors_of_node(&maze.field, to);
            let shares_floor = from_floors.intersection(&to_floors).next().is_some();
            if floor_kind == TeleportFloorKindFilter::SameFloor { shares_floor } else { !shares_floor }
        }
    }
}

/// One `(EdgeId, from, to)` triple per distinct teleport portal — same unordered-pair dedup as
/// `distinct_teleport_pairs`, but keeping the edge id of whichever direction happens to iterate
/// first for a given portal. Shared by `MaxTeleportCountCheck`/`MaxTeleportDensityCheck` (GitHub
/// issue #379), which need an actual edge id (not just a count) to build removal candidates from
/// — either direction's id is equally valid since `RemoveTeleportWithReverse` (the strategy this
/// feeds) collapses both directions of a portal together regardless of which one is flagged.
fn distinct_teleport_edge_representatives<T: Tessellation>(maze: &Maze<T>) -> Vec<(EdgeId, NodeId, NodeId)> {
    let mut seen_pairs: HashSet<(NodeId, NodeId)> = HashSet::new();
    let mut representatives = Vec::new();
    for edge in maze.graph.edges().filter(|e| e.kind == EdgeKind::Teleport) {
        let pair = if edge.from <= edge.to { (edge.from, edge.to) } else { (edge.to, edge.from) };
        if seen_pairs.insert(pair) {
            representatives.push((edge.id, edge.from, edge.to));
        }
    }
    representatives
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

/// One representative `EdgeId` per distinct teleport portal matching `direction`/`floor_kind` —
/// thin filtered wrapper over `distinct_teleport_edge_representatives`, for `FloorScope::WholeMaze`
/// callers (GitHub issue #379).
pub fn distinct_teleport_representatives<T: Tessellation>(
    maze: &Maze<T>,
    direction: TeleportDirectionFilter,
    floor_kind: TeleportFloorKindFilter,
) -> Vec<EdgeId> {
    let directed_pairs = teleport_directed_pairs(maze);
    distinct_teleport_edge_representatives(maze).into_iter()
        .filter(|&(_, from, to)| matches_direction(&directed_pairs, from, to, direction) && matches_floor_kind(maze, from, to, floor_kind))
        .map(|(id, _, _)| id)
        .collect()
}

/// Per-floor representative-edge-id grouping matching `direction`/`floor_kind` — same portal dedup
/// and filtering as `distinct_teleport_representatives`, grouped per floor for
/// `FloorScope::PerFloor` (a teleport crossing floors counts toward both, mirroring
/// `count_distinct_teleports_per_floor`). Floors with no teleport still appear with an empty `Vec`,
/// so callers can compute an excess against every floor uniformly.
pub fn distinct_teleport_representatives_per_floor<T: Tessellation>(
    maze: &Maze<T>,
    direction: TeleportDirectionFilter,
    floor_kind: TeleportFloorKindFilter,
) -> HashMap<LevelId, Vec<EdgeId>> {
    let mut per_floor: HashMap<LevelId, Vec<EdgeId>> =
        maze.field.levels_ordered().map(|l| (l, Vec::new())).collect();
    let directed_pairs = teleport_directed_pairs(maze);
    for (edge_id, from, to) in distinct_teleport_edge_representatives(maze) {
        if !matches_direction(&directed_pairs, from, to, direction) || !matches_floor_kind(maze, from, to, floor_kind) {
            continue;
        }
        let mut floors = floors_of_node(&maze.field, from);
        floors.extend(floors_of_node(&maze.field, to));
        for level in floors {
            per_floor.entry(level).or_default().push(edge_id);
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

    #[test]
    fn direction_filter_selects_bidirectional_or_unidirectional_portals() {
        let maze = maze_with_edges(&[(0, 1, EdgeKind::Teleport), (1, 0, EdgeKind::Teleport), (2, 3, EdgeKind::Teleport)]);
        assert_eq!(distinct_teleport_representatives(&maze, TeleportDirectionFilter::Any, TeleportFloorKindFilter::Any).len(), 2);
        assert_eq!(distinct_teleport_representatives(&maze, TeleportDirectionFilter::Bidirectional, TeleportFloorKindFilter::Any).len(), 1);
        assert_eq!(distinct_teleport_representatives(&maze, TeleportDirectionFilter::Unidirectional, TeleportFloorKindFilter::Any).len(), 1);
    }

    #[test]
    fn floor_kind_filter_any_matches_everything_in_single_level_maze() {
        let maze = maze_with_edges(&[(0, 1, EdgeKind::Teleport)]);
        assert_eq!(distinct_teleport_representatives(&maze, TeleportDirectionFilter::Any, TeleportFloorKindFilter::Any).len(), 1);
        assert_eq!(distinct_teleport_representatives(&maze, TeleportDirectionFilter::Any, TeleportFloorKindFilter::SameFloor).len(), 1);
        assert_eq!(distinct_teleport_representatives(&maze, TeleportDirectionFilter::Any, TeleportFloorKindFilter::InterFloor).len(), 0);
    }
}
