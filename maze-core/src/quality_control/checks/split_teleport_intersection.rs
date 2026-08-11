use std::collections::{HashMap, HashSet};
use rand::RngCore;
use crate::Maze;
use crate::graph::EdgeKind;
use crate::ids::NodeId;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::{InvalidSplitTileIssue, SplitTileNodes};

/// Which shape of teleport connection a `SplitTeleportIntersectionCheck` instance considers a
/// hit against a split cell — evaluated per node, per neighbor: a `Teleport(neighbor -> node)`
/// with no matching reverse `Teleport(node -> neighbor)` is one-way incoming, and vice versa for
/// one-way outgoing; a node/neighbor pair with both directions present is bidirectional.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SplitTeleportDirection {
    /// A one-way teleport leads into a node of the cell (no reverse leg to the same neighbor).
    Incoming,
    /// A one-way teleport leads out of a node of the cell (no reverse leg from the same neighbor).
    Outgoing,
    /// A node of the cell has a bidirectional teleport pair with some neighbor (both legs present).
    Bidirectional,
    /// Any of the three shapes above.
    Any,
}

/// Flags a split cell (`InvalidSplitTile` — see GitHub issue #248) as invalid when a `Teleport`
/// edge (`EdgeKind::Teleport`) intersects it, in a shape selected by `direction` — see GitHub
/// issue #256.
///
/// Flags the whole tile (`SplitTileNodes`, every node at the point) once any of its nodes has a
/// matching teleport connection.
pub struct SplitTeleportIntersectionCheck {
    pub instance_id: String,
    pub direction: SplitTeleportDirection,
}

impl<T: Tessellation> Check<T, InvalidSplitTileIssue> for SplitTeleportIntersectionCheck {
    fn check_type_id(&self) -> &'static str { "split_teleport_intersection" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<InvalidSplitTileIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        let mut outgoing: HashMap<NodeId, HashSet<NodeId>> = HashMap::new();
        let mut incoming: HashMap<NodeId, HashSet<NodeId>> = HashMap::new();
        for edge in maze.graph.edges().filter(|e| e.kind == EdgeKind::Teleport) {
            outgoing.entry(edge.from).or_default().insert(edge.to);
            incoming.entry(edge.to).or_default().insert(edge.from);
        }

        let node_matches = |node: NodeId| -> bool {
            let out = outgoing.get(&node);
            let inn = incoming.get(&node);
            match self.direction {
                SplitTeleportDirection::Incoming => inn.is_some_and(|neighbors| {
                    neighbors.iter().any(|n| !out.is_some_and(|o| o.contains(n)))
                }),
                SplitTeleportDirection::Outgoing => out.is_some_and(|neighbors| {
                    neighbors.iter().any(|n| !inn.is_some_and(|i| i.contains(n)))
                }),
                SplitTeleportDirection::Bidirectional => out.is_some_and(|o| {
                    inn.is_some_and(|i| o.intersection(i).next().is_some())
                }),
                SplitTeleportDirection::Any => out.is_some() || inn.is_some(),
            }
        };

        let mut seen_points = HashSet::new();
        let invalid: Vec<SplitTileNodes> = maze.field.all_points_with_level()
            .filter(|&(level, point)| seen_points.insert((level, point)))
            .filter_map(|(level, point)| {
                let nodes = maze.field.nodes_at(level, point);
                if nodes.len() < 2 { return None; }
                if !nodes.iter().any(|&n| node_matches(n)) { return None; }
                Some(SplitTileNodes::new(nodes.to_vec()))
            })
            .collect();

        if invalid.is_empty() {
            return;
        }
        issues.push(InvalidSplitTileIssue::new_from_check(&self.instance_id, invalid));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::{Graph, IdGenerator};
    use crate::space::{MultiLevelField, SquareTessellation, SquarePoint, square_rect};

    const TEST_ID: &str = "split_teleport_intersection";

    fn split_field(width: usize) -> (MultiLevelField<SquareTessellation>, IdGenerator, NodeId) {
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(width, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let split_point = SquarePoint { x: 0, y: 0 };
        let _base = field.node_at(level, split_point).unwrap();
        let extra = field.add_node_at(level, split_point, &mut ids);
        (field, ids, extra)
    }

    fn run(field: MultiLevelField<SquareTessellation>, g: Graph, direction: SplitTeleportDirection) -> Vec<InvalidSplitTileIssue> {
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        let check = SplitTeleportIntersectionCheck { instance_id: TEST_ID.to_string(), direction };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        issues
    }

    #[test]
    fn silent_when_no_split_tiles() {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(0), p(2), EdgeKind::Teleport);
        assert!(run(field, g, SplitTeleportDirection::Any).is_empty());
    }

    #[test]
    fn silent_when_teleport_does_not_touch_a_split_tile() {
        let (field, _ids, _extra) = split_field(3);
        let level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(1), p(2), EdgeKind::Teleport);
        assert!(run(field, g, SplitTeleportDirection::Any).is_empty());
    }

    #[test]
    fn incoming_fires_for_a_one_way_teleport_into_the_split_tile() {
        let (field, _ids, extra) = split_field(3);
        let level = field.single_level_id();
        let base = field.node_at(level, SquarePoint { x: 0, y: 0 }).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(2), base, EdgeKind::Teleport);
        let issues = run(field, g, SplitTeleportDirection::Incoming);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].invalid, vec![SplitTileNodes::new(vec![base, extra])]);
    }

    #[test]
    fn incoming_ignores_a_one_way_teleport_out_of_the_split_tile() {
        let (field, _ids, _extra) = split_field(3);
        let level = field.single_level_id();
        let base = field.node_at(level, SquarePoint { x: 0, y: 0 }).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(base, p(2), EdgeKind::Teleport);
        assert!(run(field, g, SplitTeleportDirection::Incoming).is_empty());
    }

    #[test]
    fn incoming_ignores_a_bidirectional_teleport() {
        // Both legs present between base and neighbor -- not a one-way incoming connection.
        let (field, _ids, _extra) = split_field(3);
        let level = field.single_level_id();
        let base = field.node_at(level, SquarePoint { x: 0, y: 0 }).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(2), base, EdgeKind::Teleport);
        g.add_edge(base, p(2), EdgeKind::Teleport);
        assert!(run(field, g, SplitTeleportDirection::Incoming).is_empty());
    }

    #[test]
    fn outgoing_fires_for_a_one_way_teleport_out_of_the_split_tile() {
        let (field, _ids, extra) = split_field(3);
        let level = field.single_level_id();
        let base = field.node_at(level, SquarePoint { x: 0, y: 0 }).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(extra, p(2), EdgeKind::Teleport);
        let issues = run(field, g, SplitTeleportDirection::Outgoing);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].invalid, vec![SplitTileNodes::new(vec![base, extra])]);
    }

    #[test]
    fn outgoing_ignores_a_one_way_teleport_into_the_split_tile() {
        let (field, _ids, _extra) = split_field(3);
        let level = field.single_level_id();
        let base = field.node_at(level, SquarePoint { x: 0, y: 0 }).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(2), base, EdgeKind::Teleport);
        assert!(run(field, g, SplitTeleportDirection::Outgoing).is_empty());
    }

    #[test]
    fn outgoing_ignores_a_bidirectional_teleport() {
        let (field, _ids, _extra) = split_field(3);
        let level = field.single_level_id();
        let base = field.node_at(level, SquarePoint { x: 0, y: 0 }).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(base, p(2), EdgeKind::Teleport);
        g.add_edge(p(2), base, EdgeKind::Teleport);
        assert!(run(field, g, SplitTeleportDirection::Outgoing).is_empty());
    }

    #[test]
    fn bidirectional_fires_when_both_legs_present_with_the_same_neighbor() {
        let (field, _ids, extra) = split_field(3);
        let level = field.single_level_id();
        let base = field.node_at(level, SquarePoint { x: 0, y: 0 }).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(base, p(2), EdgeKind::Teleport);
        g.add_edge(p(2), base, EdgeKind::Teleport);
        let issues = run(field, g, SplitTeleportDirection::Bidirectional);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].invalid, vec![SplitTileNodes::new(vec![base, extra])]);
    }

    #[test]
    fn bidirectional_ignores_two_independent_one_way_legs_to_different_neighbors() {
        // base -> neighbor A and neighbor B -> base: two one-way legs, no shared neighbor with
        // both directions present, so not a genuine bidirectional pair.
        let (field, _ids, _extra) = split_field(4);
        let level = field.single_level_id();
        let base = field.node_at(level, SquarePoint { x: 0, y: 0 }).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(base, p(2), EdgeKind::Teleport);
        g.add_edge(p(3), base, EdgeKind::Teleport);
        assert!(run(field, g, SplitTeleportDirection::Bidirectional).is_empty());
    }

    #[test]
    fn any_fires_for_a_one_way_leg() {
        let (field, _ids, extra) = split_field(4);
        let level = field.single_level_id();
        let base = field.node_at(level, SquarePoint { x: 0, y: 0 }).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(extra, p(3), EdgeKind::Teleport);
        let issues = run(field, g, SplitTeleportDirection::Any);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].invalid, vec![SplitTileNodes::new(vec![base, extra])]);
    }

    #[test]
    fn any_fires_for_a_bidirectional_only_connection() {
        // No separate one-way leg exists here -- the node's only teleport connection is the
        // bidirectional pair itself, so Any must still match through that shape alone.
        let (field, _ids, extra) = split_field(3);
        let level = field.single_level_id();
        let base = field.node_at(level, SquarePoint { x: 0, y: 0 }).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(extra, p(2), EdgeKind::Teleport);
        g.add_edge(p(2), extra, EdgeKind::Teleport);
        let issues = run(field, g, SplitTeleportDirection::Any);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].invalid, vec![SplitTileNodes::new(vec![base, extra])]);
    }

    #[test]
    fn dedups_multiple_teleports_into_the_same_split_tile_into_one_entry() {
        let (field, _ids, extra) = split_field(4);
        let level = field.single_level_id();
        let base = field.node_at(level, SquarePoint { x: 0, y: 0 }).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(2), base, EdgeKind::Teleport);
        g.add_edge(p(3), extra, EdgeKind::Teleport);
        let issues = run(field, g, SplitTeleportDirection::Any);
        assert_eq!(issues.len(), 1, "one merged issue from a single check call");
        assert_eq!(issues[0].invalid, vec![SplitTileNodes::new(vec![base, extra])], "tile counted once even with 2 teleports touching it");
    }
}
