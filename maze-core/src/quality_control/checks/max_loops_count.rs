use std::collections::HashMap;
use rand::RngCore;
use crate::Maze;
use crate::ids::EdgeId;
use crate::space::Tessellation;
use crate::graph::cycles::resolve_to_edge_ids;
use crate::quality_control::check::Check;
use crate::quality_control::{InvalidLoopGroupIssue, InvalidLoopGroupRequirement};
use crate::quality_control::issue_kinds::canonical_cycle_key;

pub const MAX_LOOPS_COUNT_DEFAULT: u32 = 20;

/// Flags every basis loop invalid when the field has more independent loops than
/// `max_loops_count` allows — a group-level decision (see `MaxLoopDensityCheck`'s identical
/// rationale, GitHub issue #37/#183): which loops to actually break is a repair strategy's job,
/// not this check's. Once the count exceeds the maximum, every basis loop is flagged, none stay
/// valid.
///
/// The threshold compares against `analytics.cycle_count` — the same independent-cycle count
/// (Euler: E - V + C on the pure-cycle core) shown to the user as the "Cycle count" analytics
/// stat, and what `MinLoopsCountCheck` already compares against. Since GitHub issue #284, the
/// flagged set itself is built from `analytics.pure_cycle_basis` (the GF(2) independent
/// representatives), not the raw `find_deduped_simple_cycles` composite-inclusive enumeration —
/// the set is now exactly `cycle_count` cycles, one cut per cycle reduces the independent count
/// by exactly one (unlike a naive composite-inclusive list, where cutting an edge shared by
/// several linearly-dependent composite cycles does not reduce the independent count by that
/// many).
pub struct MaxLoopsCountCheck {
    pub instance_id: String,
    pub max_loops_count: u32,
}

impl<T: Tessellation> Check<T, InvalidLoopGroupIssue> for MaxLoopsCountCheck {
    fn check_type_id(&self) -> &'static str { "max_loops_count" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<InvalidLoopGroupIssue>, _rng: &mut dyn RngCore, _requirement: InvalidLoopGroupRequirement) {
        // Not yet migrated to honor `_requirement` — this check always flags every loop it finds
        // (see the struct's doc comment), so there is never a "valid cycle" to skip computing.
        let analytics = maze.analysis.graph_analytics(&maze.graph, &maze.meta);
        if analytics.cycle_analysis_overflowed {
            return;
        }
        if (analytics.cycle_count as u32) <= self.max_loops_count {
            return;
        }

        let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
        let all = resolve_to_edge_ids(&nav, &analytics.pure_cycle_basis, &maze.graph);
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
    use crate::quality_control::Issue;
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
        let check = MaxLoopsCountCheck { instance_id: TEST_ID.to_string(), max_loops_count: 1 };
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
        let check = MaxLoopsCountCheck { instance_id: TEST_ID.to_string(), max_loops_count: 2 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopGroupRequirement::all());
        assert!(issues.is_empty(), "count equal to the max must not fire");
    }

    /// Two triangles sharing one vertex (a figure-8): 2 independent cycles by Euler's formula,
    /// but `find_deduped_simple_cycles` also enumerates the composite (walk both triangles as
    /// one bigger loop) — 3 simple cycles total. The fire/no-fire threshold must compare against
    /// the independent count (2), not the raw simple-cycle count (3), or the check would never
    /// settle: repeatedly firing on the composite cycle even after both underlying triangles are
    /// already broken down to the independent-cycle target.
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
    fn silent_when_independent_count_at_max_despite_more_simple_cycles() {
        let maze = maze_with_shared_vertex_triangles();
        let analytics = maze.analysis.graph_analytics(&maze.graph, &maze.meta);
        assert_eq!(analytics.cycle_count, 2, "sanity check: 2 independent cycles by Euler's formula");

        let check = MaxLoopsCountCheck { instance_id: TEST_ID.to_string(), max_loops_count: 2 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopGroupRequirement::all());
        assert!(issues.is_empty(), "must not fire: independent count (2) is at the max, even though 3 simple cycles exist");
    }

    #[test]
    fn fires_when_independent_count_exceeds_max_on_composite_graph() {
        let maze = maze_with_shared_vertex_triangles();
        let check = MaxLoopsCountCheck { instance_id: TEST_ID.to_string(), max_loops_count: 1 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopGroupRequirement::all());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].invalid.len(), 2, "GitHub issue #284: flagged set is the GF(2) basis, exactly cycle_count cycles — not every simple cycle (3, including the composite)");
    }

    /// GitHub issue #284: the composite cycle (the third simple cycle on this fixture, walking
    /// both triangles as one bigger loop) must not appear in the flagged set — it is linearly
    /// dependent on the two basis triangles, so it is never selected by `GF2Basis::try_insert`.
    #[test]
    fn composite_cycle_is_excluded_when_its_basis_components_are_already_selected() {
        let maze = maze_with_shared_vertex_triangles();
        let check = MaxLoopsCountCheck { instance_id: TEST_ID.to_string(), max_loops_count: 1 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopGroupRequirement::all());
        assert_eq!(issues.len(), 1);
        // Each basis triangle has 3 edges; the composite (walking both triangles as one loop)
        // has 6. A flagged cycle with 6 edges would mean the composite leaked into the basis.
        assert!(issues[0].invalid.iter().all(|cycle| cycle.len() == 3), "every flagged cycle must be a basis triangle (3 edges), never the 6-edge composite walk");
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
        let check = MaxLoopsCountCheck { instance_id: TEST_ID.to_string(), max_loops_count: 0 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopGroupRequirement::all());
        assert!(issues.is_empty());
    }

    #[test]
    fn silent_when_cycle_enumeration_overflows() {
        const SIDE: i32 = 6;
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(SIDE as usize, SIDE as usize), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        use crate::space::SquarePoint;
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
        let check = MaxLoopsCountCheck { instance_id: TEST_ID.to_string(), max_loops_count: 0 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopGroupRequirement::all());
        assert!(issues.is_empty(), "overflow must skip silently, not surface a partial/incorrect issue");
    }
}
