use std::collections::{HashMap, HashSet};
use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::ids::NodeId;
use crate::quality_control::check::Check;
use crate::quality_control::comparison::Comparison;
use crate::quality_control::InvalidSplitNodeIssue;

pub const SPLIT_NODE_CONNECTION_COUNT_DEFAULT: u32 = 2;
pub const SPLIT_NODE_CONNECTION_COUNT_DEFAULT_COMPARISON: Comparison = Comparison::Gt;

/// Which connections count toward a `SplitNodeConnectionCountCheck` instance's threshold.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SplitNodeConnectionDirection {
    /// Edges into the node from elsewhere.
    Incoming,
    /// Edges out of the node to elsewhere.
    Outgoing,
    /// A neighbor reachable via a full bidirectional passage (both directions present, any
    /// `EdgeKind`) — counted once per neighbor, not once per directed edge.
    Bidirectional,
    /// Every unique neighbor the node has any connection to or from, counted once regardless of
    /// direction or how many directed edges connect the pair.
    Any,
}

/// Validates a single split node's connection count (any node of a split tile, slot-0 included —
/// see the epic #246 doc comment) against a configured threshold, using the shared `Comparison`
/// operator — see GitHub issue #250, part of epic #246. Every incident edge counts regardless of
/// `EdgeKind` (`Basic` and `Teleport` both contribute).
///
/// `direction` restricts which connections count:
/// - `Incoming`/`Outgoing`: raw directed-edge count in that direction.
/// - `Bidirectional`: count of distinct neighbors reachable via a full two-direction passage (both
///   `graph.edge_between(node, neighbor)` and `graph.edge_between(neighbor, node)` exist) — one
///   physical connection between two tiles is one unit, not two.
/// - `Any`: count of distinct neighbors with any edge to or from the node, one-way or
///   bidirectional, counted once each.
pub struct SplitNodeConnectionCountCheck {
    pub instance_id: String,
    pub count: u32,
    pub comparison: Comparison,
    pub direction: SplitNodeConnectionDirection,
}

/// Precomputed per-node connection data, built once in a single `O(E)` pass over `maze.graph`
/// rather than re-scanning the whole edge list per candidate node — mirrors
/// `TeleportSuperHubAvoidanceCheck`'s own precomputed `outgoing_count` map (same rationale: many
/// candidate nodes each need a count, so paying `O(E)` once beats paying it once per candidate).
struct ConnectionCounts {
    incoming: HashMap<NodeId, u32>,
    outgoing: HashMap<NodeId, u32>,
    /// Every distinct neighbor reachable in either direction, per node — the `Any` metric.
    any_neighbors: HashMap<NodeId, HashSet<NodeId>>,
    /// Neighbors reachable via a full two-direction passage — the `Bidirectional` metric. Derived
    /// from the directed adjacency (`outgoing_neighbors`) after the single edge pass: a neighbor
    /// is bidirectional iff `node -> neighbor` AND `neighbor -> node` both exist as directed
    /// edges — checking `any_neighbors` here would be wrong, since that set is direction-blind by
    /// construction (a single one-way edge already inserts both nodes into each other's
    /// `any_neighbors` set) and would make every `Any` neighbor look bidirectional too.
    bidirectional_neighbors: HashMap<NodeId, HashSet<NodeId>>,
}

impl ConnectionCounts {
    fn build<T: Tessellation>(maze: &Maze<T>) -> Self {
        let mut incoming: HashMap<NodeId, u32> = HashMap::new();
        let mut outgoing: HashMap<NodeId, u32> = HashMap::new();
        let mut any_neighbors: HashMap<NodeId, HashSet<NodeId>> = HashMap::new();
        let mut outgoing_neighbors: HashMap<NodeId, HashSet<NodeId>> = HashMap::new();
        for edge in maze.graph.edges() {
            *outgoing.entry(edge.from).or_insert(0) += 1;
            *incoming.entry(edge.to).or_insert(0) += 1;
            any_neighbors.entry(edge.from).or_default().insert(edge.to);
            any_neighbors.entry(edge.to).or_default().insert(edge.from);
            outgoing_neighbors.entry(edge.from).or_default().insert(edge.to);
        }
        let mut bidirectional_neighbors: HashMap<NodeId, HashSet<NodeId>> = HashMap::new();
        for (&node, forward) in &outgoing_neighbors {
            for &neighbor in forward {
                if outgoing_neighbors.get(&neighbor).is_some_and(|back| back.contains(&node)) {
                    bidirectional_neighbors.entry(node).or_default().insert(neighbor);
                }
            }
        }
        Self { incoming, outgoing, any_neighbors, bidirectional_neighbors }
    }

    fn count(&self, node: NodeId, direction: SplitNodeConnectionDirection) -> u32 {
        match direction {
            SplitNodeConnectionDirection::Incoming => self.incoming.get(&node).copied().unwrap_or(0),
            SplitNodeConnectionDirection::Outgoing => self.outgoing.get(&node).copied().unwrap_or(0),
            SplitNodeConnectionDirection::Bidirectional => self.bidirectional_neighbors.get(&node).map_or(0, |s| s.len() as u32),
            SplitNodeConnectionDirection::Any => self.any_neighbors.get(&node).map_or(0, |s| s.len() as u32),
        }
    }
}

impl<T: Tessellation> Check<T, InvalidSplitNodeIssue> for SplitNodeConnectionCountCheck {
    fn check_type_id(&self) -> &'static str { "split_node_connection_count" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<InvalidSplitNodeIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        let counts = ConnectionCounts::build(maze);

        // `Field::all_points()` yields one entry per `NodeId` (a split point's several nodes all
        // resolve to the same point) -- iterate the field's nodes directly instead: this check
        // flags individual nodes, not points, so no point-level dedup is needed here (unlike
        // SplitDistanceFromWaypointCheck, which flags the whole tile as one unit).
        let mut seen_points = std::collections::HashSet::new();
        let invalid: Vec<NodeId> = maze.field.all_points_with_level()
            .filter(|&(level, point)| seen_points.insert((level, point)))
            .flat_map(|(level, point)| maze.field.nodes_at(level, point).to_vec())
            .filter(|&node| {
                let level = maze.field.level_of(node).expect("node resolved from field.nodes_at");
                let point = maze.field.point_of(node).expect("node resolved from field.nodes_at");
                maze.field.nodes_at(level, point).len() >= 2
            })
            .filter(|&node| {
                let count = counts.count(node, self.direction);
                self.comparison.compare(count, self.count)
            })
            .collect();

        if invalid.is_empty() {
            return;
        }
        let issue = InvalidSplitNodeIssue::new_from_check(&self.instance_id, invalid)
            .with_detail(&self.instance_id, "count", self.count.to_string());
        issues.push(issue);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::graph::EdgeKind;
    use crate::{Graph, IdGenerator};
    use crate::space::{MultiLevelField, SquareTessellation, SquarePoint, square_rect};

    const TEST_ID: &str = "split_node_connection_count";

    fn maze_with_split_node() -> (Maze<SquareTessellation>, NodeId, NodeId) {
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let p = SquarePoint { x: 1, y: 0 };
        let slot0 = field.node_at(level, p).unwrap();
        let extra = field.add_node_at(level, p, &mut ids);
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let maze = Maze::new(field, g);
        (maze, slot0, extra)
    }

    #[test]
    fn silent_when_no_split_points() {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = SplitNodeConnectionCountCheck { instance_id: TEST_ID.to_string(), count: 2, comparison: Comparison::Lt, direction: SplitNodeConnectionDirection::Any };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty());
    }

    #[test]
    fn fires_when_extra_node_below_threshold_any_direction() {
        let (mut maze, slot0, extra) = maze_with_split_node();
        let left = maze.field.node_at(maze.field.single_level_id(), SquarePoint { x: 0, y: 0 }).unwrap();
        maze.graph.add_bidirectional_edge(slot0, left, EdgeKind::Basic);
        // extra has zero connections -- below threshold 1.
        let check = SplitNodeConnectionCountCheck { instance_id: TEST_ID.to_string(), count: 1, comparison: Comparison::Lt, direction: SplitNodeConnectionDirection::Any };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].invalid, vec![extra]);
    }

    #[test]
    fn flags_slot0_too_when_it_trips_the_threshold() {
        // Slot-0 is not otherwise special -- the check must be able to flag it like any other
        // split node (whether the repair strategy can actually remove it depends only on whether
        // it's the tile's last remaining node, unrelated to being slot-0).
        let (mut maze, slot0, extra) = maze_with_split_node();
        let right = maze.field.node_at(maze.field.single_level_id(), SquarePoint { x: 2, y: 0 }).unwrap();
        maze.graph.add_bidirectional_edge(extra, right, EdgeKind::Basic);
        // slot0 has zero connections -- below threshold 1. extra has one neighbor.
        let check = SplitNodeConnectionCountCheck { instance_id: TEST_ID.to_string(), count: 1, comparison: Comparison::Lt, direction: SplitNodeConnectionDirection::Any };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].invalid, vec![slot0]);
    }

    #[test]
    fn flags_every_qualifying_node_of_a_multi_node_split_in_one_call() {
        // A 3-node split (slot0 + two extras) where two of the three nodes are both under
        // threshold must batch both into the same InvalidSplitNodeIssue.invalid list -- repair_check
        // bundles every flagged instance per call, same convention every other check follows.
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let p = SquarePoint { x: 1, y: 0 };
        let slot0 = field.node_at(level, p).unwrap();
        let extra1 = field.add_node_at(level, p, &mut ids);
        let extra2 = field.add_node_at(level, p, &mut ids);
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let left = field.node_at(level, SquarePoint { x: 0, y: 0 }).unwrap();
        // slot0 has one connection (at threshold, not flagged); extra1/extra2 have zero (flagged).
        g.add_bidirectional_edge(slot0, left, EdgeKind::Basic);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = SplitNodeConnectionCountCheck { instance_id: TEST_ID.to_string(), count: 1, comparison: Comparison::Lt, direction: SplitNodeConnectionDirection::Any };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1, "both flagged nodes must batch into a single issue, not one issue each");
        let mut invalid = issues[0].invalid.clone();
        invalid.sort_unstable();
        let mut expected = vec![extra1, extra2];
        expected.sort_unstable();
        assert_eq!(invalid, expected);
    }

    #[test]
    fn never_flags_a_node_at_an_unsplit_point() {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        // every node here has zero connections, but no point is split -- nothing should fire.
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = SplitNodeConnectionCountCheck { instance_id: TEST_ID.to_string(), count: 1, comparison: Comparison::Lt, direction: SplitNodeConnectionDirection::Any };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty());
    }

    #[test]
    fn bidirectional_direction_counts_full_passage_neighbors_once() {
        let (mut maze, slot0, extra) = maze_with_split_node();
        let left = maze.field.node_at(maze.field.single_level_id(), SquarePoint { x: 0, y: 0 }).unwrap();
        // slot0 <-> left is a full bidirectional passage: one neighbor under Bidirectional.
        maze.graph.add_bidirectional_edge(slot0, left, EdgeKind::Basic);
        // extra -> left is one-way only: must not count under Bidirectional.
        maze.graph.add_edge(extra, left, EdgeKind::Basic);

        let check = SplitNodeConnectionCountCheck { instance_id: TEST_ID.to_string(), count: 1, comparison: Comparison::Lt, direction: SplitNodeConnectionDirection::Bidirectional };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        // slot0 has 1 bidirectional neighbor (not below threshold 1); extra has 0 (below threshold 1).
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].invalid, vec![extra]);
    }

    #[test]
    fn incoming_direction_counts_only_edges_into_the_node() {
        let (mut maze, slot0, extra) = maze_with_split_node();
        let left = maze.field.node_at(maze.field.single_level_id(), SquarePoint { x: 0, y: 0 }).unwrap();
        maze.graph.add_edge(left, slot0, EdgeKind::Basic); // incoming to slot0
        maze.graph.add_edge(extra, left, EdgeKind::Basic);  // outgoing from extra, not incoming

        let check = SplitNodeConnectionCountCheck { instance_id: TEST_ID.to_string(), count: 1, comparison: Comparison::Lt, direction: SplitNodeConnectionDirection::Incoming };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].invalid, vec![extra], "extra has zero incoming edges");
    }

    #[test]
    fn outgoing_direction_counts_only_edges_out_of_the_node() {
        let (mut maze, slot0, extra) = maze_with_split_node();
        let left = maze.field.node_at(maze.field.single_level_id(), SquarePoint { x: 0, y: 0 }).unwrap();
        maze.graph.add_edge(slot0, left, EdgeKind::Basic); // outgoing from slot0
        maze.graph.add_edge(left, extra, EdgeKind::Basic);  // incoming to extra, not outgoing

        let check = SplitNodeConnectionCountCheck { instance_id: TEST_ID.to_string(), count: 1, comparison: Comparison::Lt, direction: SplitNodeConnectionDirection::Outgoing };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].invalid, vec![extra], "extra has zero outgoing edges");
    }

    #[test]
    fn teleport_edges_count_toward_the_threshold() {
        let (mut maze, slot0, extra) = maze_with_split_node();
        let left = maze.field.node_at(maze.field.single_level_id(), SquarePoint { x: 0, y: 0 }).unwrap();
        let right = maze.field.node_at(maze.field.single_level_id(), SquarePoint { x: 2, y: 0 }).unwrap();
        maze.graph.add_bidirectional_edge(slot0, left, EdgeKind::Basic);
        maze.graph.add_edge(extra, right, EdgeKind::Teleport);

        let check = SplitNodeConnectionCountCheck { instance_id: TEST_ID.to_string(), count: 1, comparison: Comparison::Lt, direction: SplitNodeConnectionDirection::Any };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty(), "extra's teleport connection must count toward Any, so it is not below threshold 1");
    }

    #[test]
    fn gt_comparison_flags_excess_connections() {
        let (mut maze, slot0, extra) = maze_with_split_node();
        let left = maze.field.node_at(maze.field.single_level_id(), SquarePoint { x: 0, y: 0 }).unwrap();
        let right = maze.field.node_at(maze.field.single_level_id(), SquarePoint { x: 2, y: 0 }).unwrap();
        maze.graph.add_edge(slot0, left, EdgeKind::Basic);
        maze.graph.add_edge(slot0, right, EdgeKind::Basic);
        maze.graph.add_edge(slot0, extra, EdgeKind::Basic);

        let check = SplitNodeConnectionCountCheck { instance_id: TEST_ID.to_string(), count: 2, comparison: Comparison::Gt, direction: SplitNodeConnectionDirection::Outgoing };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].invalid, vec![slot0], "slot0 has 3 outgoing edges, above threshold 2");
    }
}
