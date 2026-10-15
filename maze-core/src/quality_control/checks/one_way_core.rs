use crate::Maze;
use crate::graph::EdgeKind;
use crate::ids::EdgeId;
use crate::space::Tessellation;

/// Shared collector for genuine one-way passage edges — see GitHub issue #376.
///
/// A one-way passage is a single-direction `EdgeKind::Basic` edge: a bidirectional passage (a
/// `Basic` reverse between the same node pair also present) is a regular two-way connection, not a
/// one-way, even though each direction is itself an `EdgeKind::Basic` edge. The reverse lookup is
/// kind-filtered on purpose — a parallel opposite-direction `Teleport` edge (legitimate per
/// `Graph::add_edge`'s kind-aware dedup) must not be mistaken for the `Basic` edge's own reverse
/// and mask a genuine one-way.
///
/// This is the exact idiom every one-way check inlined before its extraction
/// (`MinOneWayCountCheck`, `MaxOneWayCountCheck`, `OneWayGroupGeometricProximityCheck`, ...).
pub fn one_way_edge_ids<T: Tessellation>(maze: &Maze<T>) -> Vec<EdgeId> {
    maze.graph
        .edges()
        .filter(|e| e.kind == EdgeKind::Basic)
        .filter(|e| {
            maze.graph
                .edge_between_kind(e.to, e.from, &EdgeKind::Basic)
                .is_none()
        })
        .map(|e| e.id)
        .collect()
}

/// Like [`one_way_edge_ids`] but yields each one-way edge's `(id, from, to)` — for callers that
/// need the endpoints (geometric / graph proximity scans).
pub fn one_way_edges_with_endpoints<T: Tessellation>(
    maze: &Maze<T>,
) -> Vec<(EdgeId, crate::ids::NodeId, crate::ids::NodeId)> {
    maze.graph
        .edges()
        .filter(|e| e.kind == EdgeKind::Basic)
        .filter(|e| {
            maze.graph
                .edge_between_kind(e.to, e.from, &EdgeKind::Basic)
                .is_none()
        })
        .map(|e| (e.id, e.from, e.to))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use std::sync::Arc;

    fn maze_with(
        edges: impl FnOnce(&mut Graph, &dyn Fn(i32) -> crate::ids::NodeId),
    ) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(4, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        edges(&mut g, &p);
        Maze::new(field, g)
    }

    #[test]
    fn counts_single_direction_basic_edge() {
        let maze = maze_with(|g, p| {
            g.add_edge(p(0), p(1), EdgeKind::Basic);
        });
        assert_eq!(one_way_edge_ids(&maze).len(), 1);
    }

    #[test]
    fn ignores_bidirectional_passage() {
        let maze = maze_with(|g, p| {
            g.add_bidirectional_edge(p(0), p(1), EdgeKind::Basic);
        });
        assert!(one_way_edge_ids(&maze).is_empty());
    }

    #[test]
    fn ignores_teleport_edge() {
        let maze = maze_with(|g, p| {
            g.add_edge(p(0), p(1), EdgeKind::Teleport);
        });
        assert!(one_way_edge_ids(&maze).is_empty());
    }

    #[test]
    fn parallel_reverse_teleport_does_not_mask_basic_one_way() {
        let maze = maze_with(|g, p| {
            g.add_edge(p(0), p(1), EdgeKind::Basic);
            g.add_edge(p(1), p(0), EdgeKind::Teleport);
        });
        assert_eq!(one_way_edge_ids(&maze).len(), 1);
    }

    #[test]
    fn endpoints_variant_yields_from_to() {
        let maze = maze_with(|g, p| {
            g.add_edge(p(0), p(1), EdgeKind::Basic);
        });
        let ep = one_way_edges_with_endpoints(&maze);
        assert_eq!(ep.len(), 1);
    }
}
