use std::collections::{HashMap, HashSet};
use rand::RngCore;
use crate::Maze;
use crate::ids::{EdgeId, NodeId};
use crate::space::{LevelId, Tessellation};
use crate::graph::cycles::{find_all_simple_cycles, resolve_to_edge_ids, density_per_100, CycleSearchResult};
use crate::quality_control::check::Check;
use crate::quality_control::{InvalidLoopGroupIssue, InvalidLoopGroupRequirement, FloorScope};
use crate::quality_control::floor_group::{floors_of_edges, floor_point_count};
use crate::quality_control::issue_kinds::canonical_cycle_key;

pub const MAX_LOOP_DENSITY_DEFAULT: f64 = 30.0;
pub const MAX_LOOP_DENSITY_DEFAULT_FLOOR_SCOPE: FloorScope = FloorScope::PerFloor;

/// Flags every basis loop invalid when too large a share of the field is covered by loops
/// overall — see GitHub issue #37. Density is the count of distinct field cells touched by any
/// loop (each cell counted once, even if covered by several loops), per 100 field cells. This is
/// a group-level decision (which loops to actually break is a repair strategy's job, e.g.
/// `InvalidLoopGroupSelectStrategy` — see GitHub issue #183): once density exceeds `max_density`,
/// every basis loop is flagged, none stay valid.
///
/// Since GitHub issue #284, both the density computation and the flagged set are built from the
/// GF(2) independent basis (`find_all_simple_cycles`'s `basis`), not the full composite-inclusive
/// list — a composite cycle's edge-set is always a subset of the union of its basis components'
/// edges (symmetric difference in GF(2)), so basis-only coverage is identical to full-list
/// coverage by construction, never a strict subset; the flagged set is cheaper to compute and
/// exactly `cycle_count` cycles instead of every composite variant.
pub struct MaxLoopDensityCheck {
    pub instance_id: String,
    pub max_density: f64,
    pub floor_scope: FloorScope,
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
        // Silently skip on overflow, same rationale as MinLoopLengthCheck (issue #22).
        let basis = match find_all_simple_cycles(nav) {
            CycleSearchResult::Cycles { basis, .. } => basis,
            CycleSearchResult::TooManyCycles => return,
        };
        if basis.is_empty() {
            return;
        }

        let all = resolve_to_edge_ids(nav, &basis, &maze.graph);

        // Under `PerFloor` a cycle is flagged if *its own floor*'s density is over budget — a
        // cycle spanning more than one floor contributes its cells to, and can be flagged by,
        // every floor it touches (GitHub issue #369).
        let flagged: Vec<Vec<EdgeId>> = match self.floor_scope {
            FloorScope::WholeMaze => {
                let covered: HashSet<NodeId> = all.iter().flat_map(|cycle| cycle_cells(&maze.graph, cycle)).collect();
                if density_per_100(covered.len(), field_cells) <= self.max_density {
                    return;
                }
                all
            }
            FloorScope::PerFloor => {
                let cycle_floors: Vec<_> = all.iter()
                    .map(|cycle| floors_of_edges(&maze.field, &maze.graph, cycle))
                    .collect();
                let mut covered_per_floor: HashMap<LevelId, HashSet<NodeId>> =
                    maze.field.levels_ordered().map(|l| (l, HashSet::new())).collect();
                for (cycle, floors) in all.iter().zip(&cycle_floors) {
                    let cells = cycle_cells(&maze.graph, cycle);
                    for &level in floors {
                        covered_per_floor.entry(level).or_default().extend(&cells);
                    }
                }
                let over_budget: HashSet<LevelId> = covered_per_floor.into_iter()
                    .filter(|(level, covered)| density_per_100(covered.len(), floor_point_count(&maze.field, *level)) > self.max_density)
                    .map(|(level, _)| level)
                    .collect();
                if over_budget.is_empty() {
                    return;
                }
                all.into_iter().zip(cycle_floors)
                    .filter(|(_, floors)| floors.iter().any(|l| over_budget.contains(l)))
                    .map(|(cycle, _)| cycle)
                    .collect()
            }
        };
        if flagged.is_empty() {
            return;
        }

        let mut invalid_sources: HashMap<Vec<EdgeId>, Vec<String>> = HashMap::new();
        for cycle in &flagged {
            invalid_sources.entry(canonical_cycle_key(cycle)).or_default().push(self.instance_id.clone());
        }
        let issue = InvalidLoopGroupIssue::new_from_check(&self.instance_id, flagged, vec![], invalid_sources)
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
    use crate::quality_control::Issue;
    use super::*;
    use rand::SeedableRng;
    use crate::graph::EdgeKind;
    use crate::{Graph, IdGenerator};
    use crate::space::{MultiLevelField, SquareTessellation, square_rect};

    const TEST_ID: &str = "max_loop_density";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    /// 10 cells in a line, two disjoint triangles (6 distinct cells covered) -> 60% density.
    fn maze_with_two_disjoint_triangles() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(10, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
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
        let check = MaxLoopDensityCheck { instance_id: TEST_ID.to_string(), max_density: 30.0, floor_scope: FloorScope::WholeMaze };
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
        let check = MaxLoopDensityCheck { instance_id: TEST_ID.to_string(), max_density: 60.0, floor_scope: FloorScope::WholeMaze };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopGroupRequirement::all());
        assert!(issues.is_empty(), "60% density should clear a threshold of 60");
    }

    #[test]
    fn density_compares_true_fractional_value_not_a_rounded_one() {
        // 8 field cells, one triangle covers 3 -> true density 300/8 = 37.5%. A max_density of
        // 37.5 must not fire (density is at, not above, the max); 37.4 must fire, pinning that
        // the comparison uses the exact fractional density rather than any rounded integer.
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(8, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
        let maze = Maze::new(field, g);

        let at_max = MaxLoopDensityCheck { instance_id: TEST_ID.to_string(), max_density: 37.5, floor_scope: FloorScope::WholeMaze };
        let mut issues = Vec::new();
        at_max.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopGroupRequirement::all());
        assert!(issues.is_empty(), "37.5% density must not exceed a max_density of exactly 37.5");

        let below_max = MaxLoopDensityCheck { instance_id: TEST_ID.to_string(), max_density: 37.4, floor_scope: FloorScope::WholeMaze };
        let mut issues = Vec::new();
        below_max.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopGroupRequirement::all());
        assert_eq!(issues.len(), 1, "37.5% density must exceed a max_density of 37.4");
    }

    #[test]
    fn overlapping_loops_share_cells_but_both_still_get_flagged() {
        // Two triangles sharing one vertex: 5 distinct covered cells out of 10 (50%), over the
        // 30% max — both loops are flagged, regardless of how much cell coverage overlaps.
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(10, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
        // Triangle A: 0-1-2-0, Triangle B: 2-3-4-2 (shares node 2)
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
        g.add_edge(nodes[2], nodes[3], EdgeKind::Basic);
        g.add_edge(nodes[3], nodes[4], EdgeKind::Basic);
        g.add_edge(nodes[4], nodes[2], EdgeKind::Basic);
        let maze = Maze::new(field, g);

        let check = MaxLoopDensityCheck { instance_id: TEST_ID.to_string(), max_density: 30.0, floor_scope: FloorScope::WholeMaze };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopGroupRequirement::all());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].invalid.len(), 2, "both overlapping triangles must be flagged");
    }

    #[test]
    fn silent_when_no_cycle() {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        let check = MaxLoopDensityCheck { instance_id: TEST_ID.to_string(), max_density: 0.0, floor_scope: FloorScope::WholeMaze };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopGroupRequirement::all());
        assert!(issues.is_empty());
    }

    #[test]
    fn silent_when_cycle_enumeration_overflows() {
        const SIDE: i32 = 6;
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(SIDE as usize, SIDE as usize), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        use crate::space::SquarePoint;
        for y in 0..SIDE {
            for x in 0..SIDE {
                let here = field.node_at(field_level, SquarePoint { x, y }).unwrap();
                if x + 1 < SIDE {
                    let right = field.node_at(field_level, SquarePoint { x: x + 1, y }).unwrap();
                    g.add_bidirectional_edge(here, right, EdgeKind::Basic);
                }
                if y + 1 < SIDE {
                    let up = field.node_at(field_level, SquarePoint { x, y: y + 1 }).unwrap();
                    g.add_bidirectional_edge(here, up, EdgeKind::Basic);
                }
            }
        }
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        let check = MaxLoopDensityCheck { instance_id: TEST_ID.to_string(), max_density: 0.0, floor_scope: FloorScope::WholeMaze };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopGroupRequirement::all());
        assert!(issues.is_empty(), "overflow must skip silently, not surface a partial/incorrect issue");
    }

    /// Bottom floor: 10 cells, 2 disjoint triangles (60% coverage, over a max of 30). Top floor:
    /// 10 cells, 1 triangle (30% coverage, at the max).
    fn maze_with_triangles_on_two_floors() -> Maze<SquareTessellation> {
        use crate::space::{Field, SquarePoint};
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let bottom = mf.add_level(Field::<SquareTessellation>::new(square_rect(10, 1), &mut ids).unwrap());
        let top = mf.add_level(Field::<SquareTessellation>::new(square_rect(10, 1), &mut ids).unwrap());
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        let pb = |x: i32| mf.node_at(bottom, SquarePoint { x, y: 0 }).unwrap();
        let pt = |x: i32| mf.node_at(top, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(pb(0), pb(1), EdgeKind::Basic);
        g.add_edge(pb(1), pb(2), EdgeKind::Basic);
        g.add_edge(pb(2), pb(0), EdgeKind::Basic);
        g.add_edge(pb(3), pb(4), EdgeKind::Basic);
        g.add_edge(pb(4), pb(5), EdgeKind::Basic);
        g.add_edge(pb(5), pb(3), EdgeKind::Basic);
        g.add_edge(pt(0), pt(1), EdgeKind::Basic);
        g.add_edge(pt(1), pt(2), EdgeKind::Basic);
        g.add_edge(pt(2), pt(0), EdgeKind::Basic);
        Maze::new(mf, g)
    }

    #[test]
    fn per_floor_flags_only_cycles_on_the_over_budget_floor() {
        let maze = maze_with_triangles_on_two_floors();
        let check = MaxLoopDensityCheck { instance_id: TEST_ID.to_string(), max_density: 30.0, floor_scope: FloorScope::PerFloor };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), InvalidLoopGroupRequirement::all());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].invalid.len(), 2, "only the bottom floor's 2 triangles are flagged, top floor's single triangle (at max) is left alone");
    }
}
