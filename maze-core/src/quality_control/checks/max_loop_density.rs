use std::collections::{HashMap, HashSet};
use rand::RngCore;
use crate::Maze;
use crate::ids::{EdgeId, NodeId};
use crate::space::Tessellation;
use crate::graph::cycles::{find_fundamental_cycles, resolve_to_edge_ids, density_per_100};
use crate::quality_control::check::Check;
use crate::quality_control::{Issue, InvalidLoopGroupIssue, InvalidLoopGroupRequirement, CycleKind};
use crate::quality_control::issue_kinds::canonical_cycle_key;

pub const MAX_LOOP_DENSITY_DEFAULT: u32 = 30;

/// Flags every simple loop invalid when too large a share of the field is covered by loops
/// overall — see GitHub issue #37. Density is the count of distinct field cells touched by any
/// loop (each cell counted once, even if covered by several loops), per 100 field cells. This is
/// a group-level decision (which loops to actually break is a repair strategy's job, e.g.
/// `InvalidLoopGroupSelectStrategy` — see GitHub issue #183): once density exceeds `max_density`,
/// every loop on the field is flagged, none stay valid.
pub struct MaxLoopDensityCheck {
    pub instance_id: String,
    pub max_density: u32,
    pub cycle_kind: CycleKind,
}

impl<T: Tessellation> Check<T, InvalidLoopGroupIssue> for MaxLoopDensityCheck {
    fn check_type_id(&self) -> &'static str { "max_loop_density" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<InvalidLoopGroupIssue>, _rng: &mut dyn RngCore, _requirement: InvalidLoopGroupRequirement) {
        // Not yet migrated to honor `_requirement` — this check always flags every loop it finds
        // (see the struct's doc comment), so there is never a "valid cycle" to skip computing.
        let field_cells = maze.field.point_count();
        if field_cells == 0 {
            return;
        }
        let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
        let nav = &nav;
        let cycles: Vec<Vec<usize>> = find_fundamental_cycles(nav).into_iter()
            .filter(|cycle| self.cycle_kind.matches(nav, cycle))
            .collect();
        if cycles.is_empty() {
            return;
        }

        let all = resolve_to_edge_ids(nav, &cycles, &maze.graph);
        let covered: HashSet<NodeId> = all.iter()
            .flat_map(|cycle| cycle_cells(&maze.graph, cycle))
            .collect();
        if density_per_100(covered.len(), field_cells) <= self.max_density {
            return;
        }

        let mut invalid_sources: HashMap<Vec<EdgeId>, Vec<String>> = HashMap::new();
        for cycle in &all {
            invalid_sources.entry(canonical_cycle_key(cycle)).or_default().push(self.instance_id.clone());
        }
        let issue = InvalidLoopGroupIssue::new_from_check(&self.instance_id, all, vec![], invalid_sources)
            .with_detail(&self.instance_id, "max_density", self.max_density.to_string());
        issues.push(issue);
    }
}

/// Set of base-Graph cells (node endpoints) touched by a cycle's edges.
fn cycle_cells(graph: &crate::Graph, cycle: &[EdgeId]) -> HashSet<NodeId> {
    cycle.iter()
        .filter_map(|&id| graph.edge(id))
        .flat_map(|edge| [edge.from, edge.to])
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::graph::EdgeKind;
    use crate::{Graph, IdGenerator};
    use crate::space::{Field, SquareTessellation, square_rect};

    const TEST_ID: &str = "max_loop_density";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    /// 10 cells in a line, two disjoint triangles (6 distinct cells covered) -> 60% density.
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
    fn fires_and_flags_every_loop_when_density_exceeds_max() {
        let maze = maze_with_two_disjoint_triangles();
        let check = MaxLoopDensityCheck { instance_id: TEST_ID.to_string(), max_density: 30, cycle_kind: CycleKind::Any };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopGroupRequirement::all());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].source_checks(), vec![TEST_ID.to_string()]);
        assert_eq!(issues[0].invalid.len(), 2, "both triangles must be flagged invalid, deciding which to break is a repair strategy's job");
        assert!(issues[0].valid.is_empty());
        assert_eq!(
            issues[0].details().get(TEST_ID).and_then(|kv| kv.get("max_density")),
            Some(&"30".to_string()),
        );
    }

    #[test]
    fn silent_when_density_at_or_below_max() {
        let maze = maze_with_two_disjoint_triangles();
        let check = MaxLoopDensityCheck { instance_id: TEST_ID.to_string(), max_density: 60, cycle_kind: CycleKind::Any };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopGroupRequirement::all());
        assert!(issues.is_empty(), "60% density should clear a threshold of 60");
    }

    #[test]
    fn density_rounds_instead_of_truncating() {
        // 8 field cells, one triangle covers 3 -> true density 300/8 = 37.5%. Truncating
        // division would read this as 37 (<= max_density 37, no fire); rounding reads it as
        // 38 (> 37, fires) -- this test pins the rounding behavior so a regression to
        // truncation is caught.
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(8, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
        let maze = Maze::new(field, g);

        let check = MaxLoopDensityCheck { instance_id: TEST_ID.to_string(), max_density: 37, cycle_kind: CycleKind::Any };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopGroupRequirement::all());
        assert_eq!(issues.len(), 1, "37.5% rounds to 38, which exceeds max_density 37");
    }

    #[test]
    fn overlapping_loops_share_cells_but_both_still_get_flagged() {
        // Two triangles sharing one vertex: 5 distinct covered cells out of 10 (50%), over the
        // 30% max — both loops are flagged, regardless of how much cell coverage overlaps.
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(10, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        // Triangle A: 0-1-2-0, Triangle B: 2-3-4-2 (shares node 2)
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
        g.add_edge(nodes[2], nodes[3], EdgeKind::Basic);
        g.add_edge(nodes[3], nodes[4], EdgeKind::Basic);
        g.add_edge(nodes[4], nodes[2], EdgeKind::Basic);
        let maze = Maze::new(field, g);

        let check = MaxLoopDensityCheck { instance_id: TEST_ID.to_string(), max_density: 30, cycle_kind: CycleKind::Any };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopGroupRequirement::all());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].invalid.len(), 2, "both overlapping triangles must be flagged");
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
        let check = MaxLoopDensityCheck { instance_id: TEST_ID.to_string(), max_density: 0, cycle_kind: CycleKind::Any };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopGroupRequirement::all());
        assert!(issues.is_empty());
    }

}
