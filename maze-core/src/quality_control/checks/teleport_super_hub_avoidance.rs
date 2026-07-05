use std::collections::HashMap;
use rand::RngCore;
use crate::Maze;
use crate::graph::EdgeKind;
use crate::ids::NodeId;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::issue::{Issue, INVALID_TELEPORT};
use crate::quality_control::issue_data::IssueData;

pub const TELEPORT_SUPER_HUB_MAX_CONNECTIONS_DEFAULT: u32 = 1_000;

/// Which end(s) of a teleport edge a `TeleportSuperHubAvoidanceCheck` instance measures.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeleportHubEdgeSelector {
    Entry,
    Exit,
    /// Both — flags the teleport if *either* end exceeds the max (`max`), same "worst wins"
    /// reduction `EntryOrExit` uses elsewhere.
    EntryOrExit,
}

/// Flags a teleport edge whose entry and/or exit vertex already has more than a configured
/// maximum number of outgoing connections (of any `EdgeKind`) — see GitHub issue #74. Prevents a
/// teleport from turning an already-busy vertex ("hub") into an even busier one, which would make
/// that vertex a disproportionately convenient shortcut hub.
///
/// Outgoing-connection count is per-vertex: for `Entry`, the count is taken at the teleport's
/// `from` vertex (which always includes the teleport itself, since it originates there); for
/// `Exit`, the count is taken at the teleport's `to` vertex, counting edges outgoing *from* `to`
/// (never incoming) — the teleport itself never contributes to this count, since it originates
/// from `from`, not `to`.
pub struct TeleportSuperHubAvoidanceCheck {
    pub instance_id: String,
    pub max_connections: u32,
    pub edge: TeleportHubEdgeSelector,
}

impl<T: Tessellation> Check<T> for TeleportSuperHubAvoidanceCheck {
    fn check_type_id(&self) -> &'static str { "teleport_super_hub_avoidance" }

    fn check(&self, maze: &Maze<T>, issues: &mut Vec<Issue>, _rng: &mut dyn RngCore) {
        let mut outgoing_count: HashMap<NodeId, u32> = HashMap::new();
        for edge in maze.graph.edges() {
            *outgoing_count.entry(edge.from).or_insert(0) += 1;
        }

        let invalid: Vec<_> = maze.graph.edges()
            .filter(|e| e.kind == EdgeKind::Teleport)
            .filter(|t| {
                let entry_count = outgoing_count.get(&t.from).copied().unwrap_or(0);
                let exit_count = outgoing_count.get(&t.to).copied().unwrap_or(0);
                let over = |count: u32| count > self.max_connections;
                match self.edge {
                    TeleportHubEdgeSelector::Entry => over(entry_count),
                    TeleportHubEdgeSelector::Exit => over(exit_count),
                    TeleportHubEdgeSelector::EntryOrExit => over(entry_count) || over(exit_count),
                }
            })
            .map(|e| e.id)
            .collect();

        if invalid.is_empty() {
            return;
        }
        let issue = Issue::with_data_from_check(INVALID_TELEPORT, IssueData::InvalidTeleports { invalid }, &self.instance_id)
            .with_detail(&self.instance_id, "max_connections", self.max_connections.to_string());
        issues.push(issue);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::{Graph, IdGenerator};
    use crate::space::{Field, SquareTessellation, square_rect};

    const TEST_ID: &str = "teleport_super_hub_avoidance";

    #[test]
    fn silent_when_no_teleport() {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        let check = TeleportSuperHubAvoidanceCheck { instance_id: TEST_ID.to_string(), max_connections: 1, edge: TeleportHubEdgeSelector::EntryOrExit };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut rng);
        assert!(issues.is_empty());
    }

    #[test]
    fn fires_when_entry_vertex_exceeds_max_connections() {
        // node[1] (entry) has 3 outgoing edges: to node[0], node[2], and the teleport target.
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(4, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[1], nodes[0], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[3], EdgeKind::Teleport);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = TeleportSuperHubAvoidanceCheck { instance_id: TEST_ID.to_string(), max_connections: 2, edge: TeleportHubEdgeSelector::Entry };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut rng);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].kind, INVALID_TELEPORT);
        let teleport_id = maze.graph.edges().find(|e| e.kind == EdgeKind::Teleport).unwrap().id;
        assert_eq!(issues[0].data, Some(IssueData::InvalidTeleports { invalid: vec![teleport_id] }));
    }

    #[test]
    fn silent_when_entry_vertex_at_or_below_max_connections() {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(4, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[1], nodes[3], EdgeKind::Teleport);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = TeleportSuperHubAvoidanceCheck { instance_id: TEST_ID.to_string(), max_connections: 1, edge: TeleportHubEdgeSelector::Entry };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut rng);
        assert!(issues.is_empty());
    }

    #[test]
    fn entry_only_ignores_exit_hub() {
        // Exit (node[3]) is a busy hub (3 outgoing edges), but with Entry only the entry side
        // (node[0], a single outgoing edge -- the teleport itself) is checked, so it must stay
        // silent even though the exit side alone would exceed max_connections.
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(5, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[3], EdgeKind::Teleport);
        g.add_edge(nodes[3], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[3], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[3], nodes[4], EdgeKind::Basic);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = TeleportSuperHubAvoidanceCheck { instance_id: TEST_ID.to_string(), max_connections: 2, edge: TeleportHubEdgeSelector::Entry };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut rng);
        assert!(issues.is_empty(), "exit hub with 3 outgoing must not be considered under Entry, and entry's own 1 outgoing (the teleport) does not exceed max_connections=2");
    }

    #[test]
    fn exit_only_ignores_entry_hub_and_counts_outgoing_from_to_vertex() {
        // Entry (node[0]) is a busy hub, but with ExitOnly it's ignored. Exit (node[3]) has 2
        // outgoing edges of its own -- the teleport itself (from=0) never contributes to node[3]'s
        // outgoing count, so it must NOT be double counted.
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(5, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[0], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[0], nodes[3], EdgeKind::Teleport);
        g.add_edge(nodes[3], nodes[4], EdgeKind::Basic);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = TeleportSuperHubAvoidanceCheck { instance_id: TEST_ID.to_string(), max_connections: 5, edge: TeleportHubEdgeSelector::Exit };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut rng);
        assert!(issues.is_empty(), "entry hub with 3 outgoing must not be considered under ExitOnly, and exit's own 1 outgoing must not exceed max_connections=5");
    }

    #[test]
    fn exit_only_fires_when_exit_vertex_exceeds_max_connections() {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(5, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[3], EdgeKind::Teleport);
        g.add_edge(nodes[3], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[3], nodes[4], EdgeKind::Basic);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = TeleportSuperHubAvoidanceCheck { instance_id: TEST_ID.to_string(), max_connections: 1, edge: TeleportHubEdgeSelector::Exit };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut rng);
        assert_eq!(issues.len(), 1);
    }

    #[test]
    fn entry_or_exit_flags_when_only_exit_exceeds_max() {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(5, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[3], EdgeKind::Teleport);
        g.add_edge(nodes[3], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[3], nodes[4], EdgeKind::Basic);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = TeleportSuperHubAvoidanceCheck { instance_id: TEST_ID.to_string(), max_connections: 1, edge: TeleportHubEdgeSelector::EntryOrExit };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut rng);
        assert_eq!(issues.len(), 1, "exit exceeding max must be caught even though entry alone (1 outgoing, the teleport) does not");
    }

    #[test]
    fn ignores_basic_edges() {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[0], nodes[2], EdgeKind::Basic);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = TeleportSuperHubAvoidanceCheck { instance_id: TEST_ID.to_string(), max_connections: 0, edge: TeleportHubEdgeSelector::EntryOrExit };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut rng);
        assert!(issues.is_empty());
    }

    #[test]
    fn fires_for_both_directions_of_a_two_way_teleport_at_a_busy_hub() {
        // Each direction of a two-way teleport is its own Teleport edge and must be flagged
        // independently, since the check operates per-edge, not per-pair.
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(4, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[1], nodes[0], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[3], EdgeKind::Teleport);
        g.add_edge(nodes[3], nodes[1], EdgeKind::Teleport);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = TeleportSuperHubAvoidanceCheck { instance_id: TEST_ID.to_string(), max_connections: 2, edge: TeleportHubEdgeSelector::EntryOrExit };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut rng);

        assert_eq!(issues.len(), 1, "both directions merge into one issue from a single check call");
        let IssueData::InvalidTeleports { invalid } = issues[0].data.as_ref().unwrap() else { panic!() };
        let mut teleport_ids: Vec<_> = maze.graph.edges().filter(|e| e.kind == EdgeKind::Teleport).map(|e| e.id).collect();
        teleport_ids.sort_unstable();
        let mut flagged = invalid.clone();
        flagged.sort_unstable();
        assert_eq!(flagged, teleport_ids, "both teleport directions must be flagged, not just one (node[1]->node[3] via Entry=3, node[3]->node[1] via Exit=3)");
    }
}
