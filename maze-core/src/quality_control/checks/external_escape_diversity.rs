use std::collections::HashSet;
use rand::RngCore;
use crate::Maze;
use crate::graph::nav::NavNodeId;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::{InvalidLoopIssue, InvalidLoopRequirement};
use super::cycle_check_core::{find_invalid_cycles, build_repair_issue, build_report_issues};

pub const EXTERNAL_ESCAPE_DIVERSITY_DEFAULT: u32 = 3;

/// Flags simple cycles whose outgoing connections to the rest of the graph are not diverse —
/// see `Specs/quality_control.md` and GitHub issue #32. Counts the distinct nav-nodes outside
/// the cycle reached by a direct outgoing nav-edge from any cycle vertex (no further traversal,
/// no geometry); a cycle below `min_distinct_exits` has many exits funneling into few distinct
/// destinations, or few exits altogether — "locally trapped" despite raw edge count.
pub struct ExternalEscapeDiversityCheck {
    pub instance_id: String,
    pub min_distinct_exits: u32,
}

impl<T: Tessellation> Check<T, InvalidLoopIssue> for ExternalEscapeDiversityCheck {
    fn check_type_id(&self) -> &'static str { "external_escape_diversity" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<InvalidLoopIssue>, _rng: &mut dyn RngCore, requirement: InvalidLoopRequirement) {
        // Silently skip on overflow, same rationale as MinLoopLengthCheck (issue #22).
        let Some((nav, cycles, low_diversity, valid)) = find_invalid_cycles(maze, |nav, cycle| {
            distinct_exit_count(nav, cycle) < self.min_distinct_exits
        }) else { return };

        issues.push(build_repair_issue(&nav, &cycles, &maze.graph, &low_diversity, &valid, &self.instance_id, "min_distinct_exits", self.min_distinct_exits, requirement));
    }

    fn report_check(&self, maze: &Maze<T>, _rng: &mut dyn RngCore) -> Vec<InvalidLoopIssue> {
        let Some((nav, cycles, low_diversity, _valid)) = find_invalid_cycles(maze, |nav, cycle| {
            distinct_exit_count(nav, cycle) < self.min_distinct_exits
        }) else { return Vec::new() };

        build_report_issues(&nav, &cycles, &maze.graph, &low_diversity, &self.instance_id, "min_distinct_exits", self.min_distinct_exits)
    }
}

/// Number of distinct nav-nodes outside the cycle reached by a direct outgoing nav-edge from
/// any cycle vertex. Self-loop edges (`from == to`) never count as exits — both ends are the
/// same cycle vertex.
fn distinct_exit_count(nav: &crate::graph::nav::NavGraph, cycle: &[usize]) -> u32 {
    let cycle_nodes: HashSet<NavNodeId> = cycle.iter()
        .flat_map(|&idx| {
            let edge = nav.edge_by_idx(idx);
            [edge.from, edge.to]
        })
        .collect();

    let mut exits: HashSet<NavNodeId> = HashSet::new();
    for &node in &cycle_nodes {
        for edge in nav.outgoing_edges(node) {
            if !cycle_nodes.contains(&edge.to) {
                exits.insert(edge.to);
            }
        }
    }
    exits.len() as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quality_control::Issue;
    use rand::SeedableRng;
    use crate::graph::EdgeKind;
    use crate::{Graph, IdGenerator};
    use crate::space::{Field, SquareTessellation, SquarePoint, square_rect};

    const TEST_ID: &str = "external_escape_diversity";

    /// A 3x3 ring (8 outer cells) with the center cell connected to every ring cell — each ring
    /// vertex has its own distinct exit to the center... but they all converge on the SAME
    /// center node, so distinct exit count is 1 despite 8 outgoing edges.
    fn maze_with_trapped_ring() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(3, 3), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32, y: i32| field.node_at(SquarePoint { x, y }).unwrap();
        let ring = [(0,0),(1,0),(2,0),(2,1),(2,2),(1,2),(0,2),(0,1)];
        for i in 0..ring.len() {
            let (x1, y1) = ring[i];
            let (x2, y2) = ring[(i + 1) % ring.len()];
            g.add_edge(p(x1, y1), p(x2, y2), EdgeKind::Basic);
        }
        let center = p(1, 1);
        for &(x, y) in &ring {
            g.add_edge(p(x, y), center, EdgeKind::Basic);
        }
        Maze::new(field, g)
    }

    /// Same ring, but each ring vertex's spoke leads to a distinct outside cell instead of one
    /// shared center — 8 outgoing edges, 8 distinct destinations.
    fn maze_with_diverse_ring() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(5, 5), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32, y: i32| field.node_at(SquarePoint { x, y }).unwrap();
        let ring = [(1,1),(2,1),(3,1),(3,2),(3,3),(2,3),(1,3),(1,2)];
        for i in 0..ring.len() {
            let (x1, y1) = ring[i];
            let (x2, y2) = ring[(i + 1) % ring.len()];
            g.add_edge(p(x1, y1), p(x2, y2), EdgeKind::Basic);
        }
        let spokes = [(0,0),(2,0),(4,0),(4,2),(4,4),(2,4),(0,4),(0,2)];
        for (&(rx, ry), &(sx, sy)) in ring.iter().zip(spokes.iter()) {
            g.add_edge(p(rx, ry), p(sx, sy), EdgeKind::Basic);
        }
        Maze::new(field, g)
    }

    #[test]
    fn fires_when_exits_converge_on_same_node() {
        let maze = maze_with_trapped_ring();
        let check = ExternalEscapeDiversityCheck { instance_id: TEST_ID.to_string(), min_distinct_exits: 3 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, InvalidLoopRequirement::all());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].source_checks(), vec![TEST_ID.to_string()]);
        assert_eq!(
            issues[0].details().get(TEST_ID).and_then(|kv| kv.get("min_distinct_exits")),
            Some(&"3".to_string()),
        );
    }

    #[test]
    fn silent_when_exits_are_diverse() {
        let maze = maze_with_diverse_ring();
        let check = ExternalEscapeDiversityCheck { instance_id: TEST_ID.to_string(), min_distinct_exits: 3 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, InvalidLoopRequirement::all());
        assert!(issues.is_empty(), "8 distinct exit destinations should clear a threshold of 3");
    }

    #[test]
    fn silent_when_threshold_is_zero() {
        let maze = maze_with_trapped_ring();
        let check = ExternalEscapeDiversityCheck { instance_id: TEST_ID.to_string(), min_distinct_exits: 0 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, InvalidLoopRequirement::all());
        assert!(issues.is_empty(), "a threshold of 0 should never flag any cycle");
    }

    #[test]
    fn silent_when_cycle_enumeration_overflows() {
        const SIDE: i32 = 6;
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(SIDE as usize, SIDE as usize), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        for y in 0..SIDE {
            for x in 0..SIDE {
                let here = field.node_at(SquarePoint { x, y }).unwrap();
                if x + 1 < SIDE {
                    let right = field.node_at(SquarePoint { x: x + 1, y }).unwrap();
                    g.add_bidirectional_edge(here, right, EdgeKind::Basic);
                }
                if y + 1 < SIDE {
                    let up = field.node_at(SquarePoint { x, y: y + 1 }).unwrap();
                    g.add_bidirectional_edge(here, up, EdgeKind::Basic);
                }
            }
        }
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        let check = ExternalEscapeDiversityCheck { instance_id: TEST_ID.to_string(), min_distinct_exits: 3 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, InvalidLoopRequirement::all());
        assert!(issues.is_empty(), "overflow must skip silently, not surface a partial/incorrect issue");
    }

    #[test]
    fn silent_when_no_cycle() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        let check = ExternalEscapeDiversityCheck { instance_id: TEST_ID.to_string(), min_distinct_exits: 3 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, InvalidLoopRequirement::all());
        assert!(issues.is_empty());
    }

    #[test]
    fn requirement_empty_does_not_resolve_other_valid() {
        let maze = maze_with_trapped_ring();
        let check = ExternalEscapeDiversityCheck { instance_id: TEST_ID.to_string(), min_distinct_exits: 3 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, InvalidLoopRequirement::empty());
        assert_eq!(issues.len(), 1);
        assert!(issues[0].other_valid.is_empty(), "empty() must not resolve other_valid");
        assert!(issues[0].other_invalid.is_empty(), "empty() must not resolve other_invalid");
    }

    #[test]
    fn report_check_produces_one_issue_per_invalid_cycle() {
        // Two disjoint trapped rings -- both invalid against min_distinct_exits=3.
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(3, 6), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32, y: i32| field.node_at(SquarePoint { x, y }).unwrap();

        let build_trapped_ring = |g: &mut Graph, y_offset: i32| {
            let ring = [(0,0),(1,0),(2,0),(2,1),(2,2),(1,2),(0,2),(0,1)];
            for i in 0..ring.len() {
                let (x1, y1) = ring[i];
                let (x2, y2) = ring[(i + 1) % ring.len()];
                g.add_edge(p(x1, y1 + y_offset), p(x2, y2 + y_offset), EdgeKind::Basic);
            }
            let center = p(1, 1 + y_offset);
            for &(x, y) in &ring {
                g.add_edge(p(x, y + y_offset), center, EdgeKind::Basic);
            }
        };
        build_trapped_ring(&mut g, 0);
        build_trapped_ring(&mut g, 3);

        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        let check = ExternalEscapeDiversityCheck { instance_id: TEST_ID.to_string(), min_distinct_exits: 3 };
        let mut rng = crate::random::MazeRng::seed_from_u64(0);

        let report = check.report_check(&maze, &mut rng);
        assert_eq!(report.len(), 2, "report_check must produce one issue per invalid cycle, not one merged issue");
        for issue in &report {
            assert!(issue.other_invalid.is_empty(), "report-path issues never carry other_invalid");
            assert!(issue.other_valid.is_empty(), "report-path issues never carry other_valid");
        }
    }
}
