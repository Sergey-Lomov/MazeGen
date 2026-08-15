use crate::ids::NodeId;
use crate::space::{MultiLevelField, Tessellation};
use crate::graph::{EdgeKind, Graph};

#[derive(Debug)]
pub enum GeometricNodeClass {
    DeadEnd,
    Straight,
    Turn,
    Junction(usize),
}

pub(crate) fn unique_neighbors(graph: &Graph, node: NodeId) -> Vec<NodeId> {
    let mut v: Vec<NodeId> = graph.outgoing_neighbors(node).collect();
    v.sort_unstable();
    v.dedup();
    v
}

/// Neighbors used for the cell's own geometric shape (`classify_node`): only `EdgeKind::Basic`
/// edges that are bidirectional (both `node -> neighbor` and `neighbor -> node` exist) — a
/// one-way passage doesn't read as a "side" of the cell's shape, and `Teleport`/`VerticalPassage`/
/// `Elevator` edges aren't spatial neighbors on the field at all, so including them would distort
/// dead-end/straight/turn/junction classification with connections that don't correspond to an
/// adjacent tile. Uses the `outgoing`-indexed `outgoing_edges`/`edge_between_kind` (O(degree)
/// each) rather than scanning `graph.edges()` (O(E)) — this runs once per node in
/// `compute_node_stats_scoped`, so an O(E) scan per node would be O(V·E) overall.
fn shape_neighbors(graph: &Graph, node: NodeId) -> Vec<NodeId> {
    let mut v: Vec<NodeId> = graph.outgoing_edges(node)
        .filter(|e| e.kind == EdgeKind::Basic)
        .map(|e| e.to)
        .filter(|&to| graph.edge_between_kind(to, node, &EdgeKind::Basic).is_some())
        .collect();
    v.sort_unstable();
    v.dedup();
    v
}

pub fn classify_node<T: Tessellation>(graph: &Graph, node: NodeId, field: &MultiLevelField<T>) -> GeometricNodeClass {
    let neighbors = shape_neighbors(graph, node);
    match neighbors.len() {
        0 | 1 => GeometricNodeClass::DeadEnd,
        2 => {
            if field.is_straight(neighbors[0], node, neighbors[1]) {
                GeometricNodeClass::Straight
            } else {
                GeometricNodeClass::Turn
            }
        }
        n => GeometricNodeClass::Junction(n),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{Graph, EdgeKind};
    use crate::space::{MultiLevelField, SquareTessellation, SquarePoint, square_rect};
    use crate::IdGenerator;

    fn make_field_and_graph(w: usize, h: usize) -> (MultiLevelField<SquareTessellation>, Graph) {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(w, h), &mut ids).unwrap();
        let mut graph = Graph::new();
        for node in field.all_node_ids() { graph.add_node(node); }
        (field, graph)
    }

    fn node_at(field: &MultiLevelField<SquareTessellation>, x: i32, y: i32) -> NodeId {
        let level = field.single_level_id();
        field.node_at(level, SquarePoint { x, y }).unwrap()
    }

    #[test]
    fn no_outgoing_edges_is_dead_end() {
        let (field, graph) = make_field_and_graph(3, 1);
        let n = node_at(&field, 1, 0);
        assert!(matches!(classify_node(&graph, n, &field), GeometricNodeClass::DeadEnd));
    }

    #[test]
    fn single_outgoing_edge_is_dead_end() {
        let (field, mut graph) = make_field_and_graph(3, 1);
        let a = node_at(&field, 0, 0);
        let b = node_at(&field, 1, 0);
        graph.add_edge(b, a, EdgeKind::Basic);
        assert!(matches!(classify_node(&graph, b, &field), GeometricNodeClass::DeadEnd));
    }

    #[test]
    fn two_collinear_neighbors_is_straight() {
        // Horizontal row: middle node's left/right neighbors are collinear.
        let (field, mut graph) = make_field_and_graph(3, 1);
        let left = node_at(&field, 0, 0);
        let mid = node_at(&field, 1, 0);
        let right = node_at(&field, 2, 0);
        graph.add_bidirectional_edge(mid, left, EdgeKind::Basic);
        graph.add_bidirectional_edge(mid, right, EdgeKind::Basic);
        assert!(matches!(classify_node(&graph, mid, &field), GeometricNodeClass::Straight));
    }

    #[test]
    fn two_perpendicular_neighbors_is_turn() {
        // Corner of a 2x2 grid: node (1,0)'s neighbors (0,0) and (1,1) form a right angle.
        let (field, mut graph) = make_field_and_graph(2, 2);
        let corner = node_at(&field, 1, 0);
        let left = node_at(&field, 0, 0);
        let down = node_at(&field, 1, 1);
        graph.add_bidirectional_edge(corner, left, EdgeKind::Basic);
        graph.add_bidirectional_edge(corner, down, EdgeKind::Basic);
        assert!(matches!(classify_node(&graph, corner, &field), GeometricNodeClass::Turn));
    }

    #[test]
    fn three_neighbors_is_junction() {
        let (field, mut graph) = make_field_and_graph(3, 2);
        let center = node_at(&field, 1, 0);
        let left = node_at(&field, 0, 0);
        let right = node_at(&field, 2, 0);
        let down = node_at(&field, 1, 1);
        graph.add_bidirectional_edge(center, left, EdgeKind::Basic);
        graph.add_bidirectional_edge(center, right, EdgeKind::Basic);
        graph.add_bidirectional_edge(center, down, EdgeKind::Basic);
        match classify_node(&graph, center, &field) {
            GeometricNodeClass::Junction(n) => assert_eq!(n, 3),
            other => panic!("expected Junction(3), got {other:?}"),
        }
    }

    #[test]
    fn one_way_basic_edge_does_not_count_as_a_shape_neighbor() {
        // Only `mid -> right` exists (no reverse), so `right` isn't a shape neighbor of `mid`.
        let (field, mut graph) = make_field_and_graph(3, 1);
        let mid = node_at(&field, 1, 0);
        let right = node_at(&field, 2, 0);
        graph.add_edge(mid, right, EdgeKind::Basic);
        assert!(matches!(classify_node(&graph, mid, &field), GeometricNodeClass::DeadEnd));
    }

    #[test]
    fn teleport_edge_does_not_count_as_a_shape_neighbor() {
        let (field, mut graph) = make_field_and_graph(4, 1);
        let a = node_at(&field, 0, 0);
        let b = node_at(&field, 3, 0);
        graph.add_edge(a, b, EdgeKind::Teleport);
        graph.add_edge(b, a, EdgeKind::Teleport);
        assert!(matches!(classify_node(&graph, a, &field), GeometricNodeClass::DeadEnd));
    }

    #[test]
    fn unique_neighbors_ignores_incoming_only_edges() {
        let (field, mut graph) = make_field_and_graph(3, 1);
        let left = node_at(&field, 0, 0);
        let mid = node_at(&field, 1, 0);
        // Only an incoming edge into mid -- mid has no outgoing edges of its own.
        graph.add_edge(left, mid, EdgeKind::Basic);
        assert_eq!(unique_neighbors(&graph, mid), Vec::<NodeId>::new());
    }
}
