use std::collections::{HashMap, HashSet};
use rand::RngCore;
use rand::seq::SliceRandom;
use crate::Maze;
use crate::ids::{EdgeId, NodeId};
use crate::space::Tessellation;
use crate::graph::cycles::{find_deduped_simple_cycles, resolve_to_edge_ids, density_per_100};
use crate::quality_control::check::Check;
use crate::quality_control::{Issue, InvalidLoopIssue, InvalidLoopRequirement};
use crate::quality_control::issue_kinds::canonical_cycle_key;

pub const MAX_LOOP_DENSITY_DEFAULT: u32 = 30;

/// Flags excess simple loops when too large a share of the field is covered by them — see
/// GitHub issue #37. Density is the count of distinct field cells touched by any loop (each
/// cell counted once, even if covered by several loops), per 100 field cells. When density
/// exceeds `max_density`, loops are picked in random order and flagged `InvalidLoop` one at a
/// time — recomputing the remaining density against only the still-unselected loops after each
/// pick, since removing a loop only frees the cells not also covered by another loop not yet
/// selected — until enough are flagged to bring density down to `max_density`, or every loop
/// has been flagged.
pub struct MaxLoopDensityCheck {
    pub instance_id: String,
    pub max_density: u32,
}

impl<T: Tessellation> Check<T, InvalidLoopIssue> for MaxLoopDensityCheck {
    fn check_type_id(&self) -> &'static str { "max_loop_density" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<InvalidLoopIssue>, rng: &mut dyn RngCore, _requirement: InvalidLoopRequirement) {
        // Not yet migrated to honor `_requirement` — the density algorithm inherently needs
        // every cycle's coverage, not just the flagged ones, so it always computes all().
        let field_cells = maze.field.node_count();
        if field_cells == 0 {
            return;
        }
        let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
        let nav = &nav;
        // Silently skip on overflow, same rationale as MinLoopLengthCheck (issue #22).
        let Some(cycles) = find_deduped_simple_cycles(nav) else { return };
        if cycles.is_empty() {
            return;
        }

        let all = resolve_to_edge_ids(nav, &cycles, &maze.graph);
        let cell_sets: Vec<HashSet<NodeId>> = all.iter()
            .map(|cycle| cycle_cells(&maze.graph, cycle))
            .collect();

        let covered: HashSet<NodeId> = cell_sets.iter().flatten().copied().collect();
        if density_per_100(covered.len(), field_cells) <= self.max_density {
            return;
        }

        let mut order: Vec<usize> = (0..all.len()).collect();
        order.shuffle(rng);

        let mut remaining = covered;
        let mut excess: Vec<usize> = Vec::new();
        for idx in order {
            excess.push(idx);
            remaining.retain(|cell| !cell_sets[idx].contains(cell));
            if density_per_100(remaining.len(), field_cells) <= self.max_density {
                break;
            }
        }

        let mut invalid_sources: HashMap<Vec<EdgeId>, Vec<String>> = HashMap::new();
        for &idx in &excess {
            invalid_sources.entry(canonical_cycle_key(&all[idx])).or_default().push(self.instance_id.clone());
        }
        let issue = InvalidLoopIssue::new_from_check(&self.instance_id, all, excess, invalid_sources)
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
    fn fires_and_flags_loops_when_density_exceeds_max() {
        let maze = maze_with_two_disjoint_triangles();
        let check = MaxLoopDensityCheck { instance_id: TEST_ID.to_string(), max_density: 30 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopRequirement::all());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].source_checks(), vec![TEST_ID.to_string()]);
        assert_eq!(issues[0].all.len(), 2, "both triangles enumerated");
        assert_eq!(issues[0].invalid.len(), 1, "flagging one triangle (3 of 6 covered cells) is enough to drop to 30%");
        assert_eq!(
            issues[0].details().get(TEST_ID).and_then(|kv| kv.get("max_density")),
            Some(&"30".to_string()),
        );
    }

    #[test]
    fn silent_when_density_at_or_below_max() {
        let maze = maze_with_two_disjoint_triangles();
        let check = MaxLoopDensityCheck { instance_id: TEST_ID.to_string(), max_density: 60 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopRequirement::all());
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

        let check = MaxLoopDensityCheck { instance_id: TEST_ID.to_string(), max_density: 37 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopRequirement::all());
        assert_eq!(issues.len(), 1, "37.5% rounds to 38, which exceeds max_density 37");
    }

    #[test]
    fn overlapping_loops_account_for_shared_cells_when_selecting() {
        // Two triangles sharing one vertex: 5 distinct covered cells out of 10 (50%).
        // Flagging either triangle alone only frees 2 unique cells (3 shared with none, since
        // only the apex is shared) -> still need both flagged is NOT required; one triangle
        // brings 5-3=2 covered remaining -> 20%, clears a max of 30 immediately.
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

        let check = MaxLoopDensityCheck { instance_id: TEST_ID.to_string(), max_density: 30 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopRequirement::all());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].invalid.len(), 1, "flagging one of the two overlapping triangles already clears the target");
    }

    #[test]
    fn flags_all_loops_when_target_unreachable() {
        let maze = maze_with_two_disjoint_triangles();
        let check = MaxLoopDensityCheck { instance_id: TEST_ID.to_string(), max_density: 0 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopRequirement::all());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].invalid.len(), issues[0].all.len(), "every loop must be flagged when even all of them can't reach max_density 0");
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
        let check = MaxLoopDensityCheck { instance_id: TEST_ID.to_string(), max_density: 0 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopRequirement::all());
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
        let check = MaxLoopDensityCheck { instance_id: TEST_ID.to_string(), max_density: 0 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopRequirement::all());
        assert!(issues.is_empty(), "overflow must skip silently, not surface a partial/incorrect issue");
    }
}
