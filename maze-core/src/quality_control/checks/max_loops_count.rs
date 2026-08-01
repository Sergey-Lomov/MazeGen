use std::collections::HashMap;
use rand::RngCore;
use crate::Maze;
use crate::ids::EdgeId;
use crate::space::Tessellation;
use crate::graph::cycles::{find_fundamental_cycles, resolve_to_edge_ids};
use crate::quality_control::check::Check;
use crate::quality_control::{Issue, InvalidLoopGroupIssue, InvalidLoopGroupRequirement, CycleKind};
use crate::quality_control::issue_kinds::canonical_cycle_key;

pub const MAX_LOOPS_COUNT_DEFAULT: u32 = 20;

/// Flags every simple loop invalid when the field has more independent loops than
/// `max_loops_count` allows — a group-level decision (see `MaxLoopDensityCheck`'s identical
/// rationale, GitHub issue #37/#183): which loops to actually break is a repair strategy's job,
/// not this check's. Once the count exceeds the maximum, every loop on the field is flagged, none
/// stay valid.
///
/// The threshold compares against the fundamental cycle basis (`find_fundamental_cycles`, see
/// GitHub issue #244), restricted to `cycle_kind` — the same independent-cycle list
/// `MinLoopsCountCheck`'s `analytics.cycle_count` derives from, not the much larger, unstable
/// composite-cycle enumeration a pre-#244 simple-cycle search would have produced.
pub struct MaxLoopsCountCheck {
    pub instance_id: String,
    pub max_loops_count: u32,
    pub cycle_kind: CycleKind,
}

impl<T: Tessellation> Check<T, InvalidLoopGroupIssue> for MaxLoopsCountCheck {
    fn check_type_id(&self) -> &'static str { "max_loops_count" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<InvalidLoopGroupIssue>, _rng: &mut dyn RngCore, _requirement: InvalidLoopGroupRequirement) {
        // Not yet migrated to honor `_requirement` — this check always flags every loop it finds
        // (see the struct's doc comment), so there is never a "valid cycle" to skip computing.
        let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
        let nav = &nav;
        let cycles: Vec<Vec<usize>> = find_fundamental_cycles(nav).into_iter()
            .filter(|cycle| self.cycle_kind.matches(nav, cycle))
            .collect();
        if (cycles.len() as u32) <= self.max_loops_count {
            return;
        }

        let all = resolve_to_edge_ids(nav, &cycles, &maze.graph);
        let mut invalid_sources: HashMap<Vec<EdgeId>, Vec<String>> = HashMap::new();
        for cycle in &all {
            invalid_sources.entry(canonical_cycle_key(cycle)).or_default().push(self.instance_id.clone());
        }
        let issue = InvalidLoopGroupIssue::new_from_check(&self.instance_id, all, vec![], invalid_sources)
            .with_detail(&self.instance_id, "max_loops_count", self.max_loops_count.to_string());
        issues.push(issue);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::graph::EdgeKind;
    use crate::{Graph, IdGenerator};
    use crate::space::{Field, SquareTessellation, square_rect};

    const TEST_ID: &str = "max_loops_count";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    fn maze_with_two_disjoint_triangles() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(10, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
        g.add_edge(nodes[3], nodes[4], EdgeKind::Basic);
        g.add_edge(nodes[4], nodes[5], EdgeKind::Basic);
        g.add_edge(nodes[5], nodes[3], EdgeKind::Basic);
        Maze::new(field, g)
    }

    #[test]
    fn fires_and_flags_every_loop_when_count_exceeds_max() {
        let maze = maze_with_two_disjoint_triangles();
        let check = MaxLoopsCountCheck { instance_id: TEST_ID.to_string(), max_loops_count: 1, cycle_kind: CycleKind::Any };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopGroupRequirement::all());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].source_checks(), vec![TEST_ID.to_string()]);
        assert_eq!(issues[0].invalid.len(), 2, "both loops must be flagged invalid, deciding which to break is a repair strategy's job");
        assert!(issues[0].valid.is_empty());
        assert_eq!(
            issues[0].details().get(TEST_ID).and_then(|kv| kv.get("max_loops_count")),
            Some(&"1".to_string()),
        );
    }

    #[test]
    fn silent_when_count_at_or_below_max() {
        let maze = maze_with_two_disjoint_triangles();
        let check = MaxLoopsCountCheck { instance_id: TEST_ID.to_string(), max_loops_count: 2, cycle_kind: CycleKind::Any };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopGroupRequirement::all());
        assert!(issues.is_empty(), "count equal to the max must not fire");
    }

    /// Two triangles sharing one vertex (a figure-8): 2 independent cycles. The fundamental
    /// cycle basis (`find_fundamental_cycles`, GitHub issue #244) returns exactly these 2, not
    /// a larger composite-cycle enumeration — the fire/no-fire threshold naturally compares
    /// against the independent count.
    fn maze_with_shared_vertex_triangles() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(10, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
        g.add_edge(nodes[2], nodes[3], EdgeKind::Basic);
        g.add_edge(nodes[3], nodes[4], EdgeKind::Basic);
        g.add_edge(nodes[4], nodes[2], EdgeKind::Basic);
        Maze::new(field, g)
    }

    #[test]
    fn silent_when_independent_count_at_max() {
        let maze = maze_with_shared_vertex_triangles();
        let check = MaxLoopsCountCheck { instance_id: TEST_ID.to_string(), max_loops_count: 2, cycle_kind: CycleKind::Any };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopGroupRequirement::all());
        assert!(issues.is_empty(), "must not fire: independent count (2) is at the max");
    }

    #[test]
    fn fires_when_independent_count_exceeds_max() {
        let maze = maze_with_shared_vertex_triangles();
        let check = MaxLoopsCountCheck { instance_id: TEST_ID.to_string(), max_loops_count: 1, cycle_kind: CycleKind::Any };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopGroupRequirement::all());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].invalid.len(), 2, "both fundamental cycles are offered to the repair strategy to cut");
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
        let check = MaxLoopsCountCheck { instance_id: TEST_ID.to_string(), max_loops_count: 0, cycle_kind: CycleKind::Any };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopGroupRequirement::all());
        assert!(issues.is_empty());
    }
}
