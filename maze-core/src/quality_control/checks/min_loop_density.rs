use crate::Maze;
use crate::graph::cycles::{
    CycleSearchResult, density_per_100, find_all_simple_cycles, resolve_to_edge_ids,
};
use crate::ids::{EdgeId, NodeId};
use crate::quality_control::check::Check;
use crate::quality_control::floor_group::{floor_point_count, floors_of_edges};
use crate::quality_control::{FloorScope, MissingLoopsIssue, RepairArea};
use crate::space::{LevelId, Tessellation};
use rand::RngCore;
use std::collections::{HashMap, HashSet};

pub const MIN_LOOP_DENSITY_DEFAULT: f64 = 30.0;
pub const AVG_LOOP_LENGTH_ESTIMATE_DEFAULT: u32 = 10;
pub const MIN_LOOP_DENSITY_DEFAULT_FLOOR_SCOPE: FloorScope = FloorScope::PerFloor;

/// Flags a deficit against a share (per 100 field cells) of the field covered by any loop,
/// converting the cell deficit into a loop count via `avg_loop_length_estimate` — see GitHub
/// issue #177 (originally merged with `MinLoopsCountCheck` into one `Mode`-switched check, split
/// back out since the two measure genuinely different things: a field-coverage share vs. an
/// absolute count). `required_cells` (the target covered-cell count) rounds to the nearest
/// integer, same as `MaxOneWayRatioCheck::to_remove_for`'s `target_count` — not ceil/floor.
/// `missing_cells.div_ceil(avg_loop_length_estimate)` still rounds up: that step estimates how
/// many whole loops are needed to cover a cell deficit, and a fractional loop can't be added, so
/// the loop count itself must never under-report.
///
/// `floor_scope` (GitHub issue #369): under `PerFloor` (the default for every density check),
/// coverage is measured independently per floor against that floor's own cell count, and the
/// per-floor `missing` counts are summed — a cycle spanning more than one floor contributes its
/// covered cells to every floor it touches. Under `WholeMaze`, behavior is unchanged from before
/// floors existed: one combined coverage share over every floor's cells at once.
pub struct MinLoopDensityCheck {
    pub instance_id: String,
    pub min_density: f64,
    pub avg_loop_length_estimate: u32,
    pub floor_scope: FloorScope,
}

impl<T: Tessellation> Check<T, MissingLoopsIssue> for MinLoopDensityCheck {
    fn check_type_id(&self) -> &'static str {
        "min_loop_density"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<MissingLoopsIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let field_cells = maze.field.point_count();
        if field_cells == 0 {
            return;
        }
        let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
        let nav = &nav;
        // GitHub issue #284: coverage is built from the GF(2) independent basis, not the full
        // composite-inclusive simple-cycle list — a composite cycle's edge-set is always a
        // subset of the union of its basis components' edges (symmetric difference in GF(2)),
        // so basis-only coverage is identical to full-list coverage by construction, never a
        // strict subset. Cheaper: fewer cycles to walk. Silently skip on overflow, same
        // rationale as MaxLoopDensityCheck (issue #22).
        let all: Vec<Vec<EdgeId>> = match find_all_simple_cycles(nav) {
            CycleSearchResult::Cycles { basis, .. } if !basis.is_empty() => {
                resolve_to_edge_ids(nav, &basis, &maze.graph)
            }
            CycleSearchResult::Cycles { .. } => Vec::new(),
            CycleSearchResult::TooManyCycles => return,
        };

        let missing: Vec<(RepairArea, u32)> = match self.floor_scope {
            FloorScope::WholeMaze => {
                let covered: HashSet<NodeId> = all
                    .iter()
                    .flat_map(|cycle| cycle.iter().filter_map(|&id| maze.graph.edge(id)))
                    .flat_map(|edge| [edge.from, edge.to])
                    .collect();
                let missing = self.missing_for(covered.len(), field_cells);
                if missing == 0 {
                    vec![]
                } else {
                    vec![(RepairArea::WholeMaze, missing)]
                }
            }
            FloorScope::PerFloor => {
                let mut covered_per_floor: HashMap<LevelId, HashSet<NodeId>> = maze
                    .field
                    .levels_ordered()
                    .map(|l| (l, HashSet::new()))
                    .collect();
                for cycle in &all {
                    let touched_nodes: HashSet<NodeId> = cycle
                        .iter()
                        .filter_map(|&id| maze.graph.edge(id))
                        .flat_map(|edge| [edge.from, edge.to])
                        .collect();
                    for level in floors_of_edges(&maze.field, &maze.graph, cycle) {
                        covered_per_floor
                            .entry(level)
                            .or_default()
                            .extend(&touched_nodes);
                    }
                }
                let mut missing: Vec<(RepairArea, u32)> = covered_per_floor
                    .into_iter()
                    .filter_map(|(level, covered)| {
                        let missing =
                            self.missing_for(covered.len(), floor_point_count(&maze.field, level));
                        (missing > 0).then_some((RepairArea::Level(level), missing))
                    })
                    .collect();
                // `HashMap` iteration order is randomized per run -- sort by level so repair
                // strategies that loop over `issue.missing` consume RNG in a deterministic order.
                missing.sort_by_key(|&(area, _)| area);
                missing
            }
        };
        if missing.is_empty() {
            return;
        }
        let total: u32 = missing.iter().map(|(_, m)| m).sum();
        let issue = MissingLoopsIssue::new_from_check(&self.instance_id, missing).with_detail(
            &self.instance_id,
            "missing",
            total.to_string(),
        );
        issues.push(issue);
    }
}

impl MinLoopDensityCheck {
    /// Deficit loop count for one region (whole maze or one floor) given its covered/total cell
    /// counts — shared by both `floor_scope` branches so the rounding/conversion logic stays
    /// identical either way.
    fn missing_for(&self, covered: usize, cells: usize) -> u32 {
        if cells == 0 {
            return 0;
        }
        let density = density_per_100(covered, cells);
        if density >= self.min_density {
            return 0;
        }
        // `required_cells` rounds the fractional target cell count to the nearest integer (a
        // whole-cell quantity), not ceil — matches the pre-#265 integer version's rounding
        // direction now that `min_density` itself is a fractional threshold.
        let required_cells = (self.min_density * cells as f64 / 100.0).round() as usize;
        let missing_cells = required_cells.saturating_sub(covered);
        missing_cells.div_ceil(self.avg_loop_length_estimate.max(1) as usize) as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::EdgeKind;
    use crate::quality_control::Issue;
    use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;
    use std::sync::Arc;

    const TEST_ID: &str = "min_loop_density";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    /// 10 cells in a line, one triangle (3 distinct cells covered) -> 30% density.
    fn maze_with_one_triangle_density() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(10, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = field
            .field_of(field_level)
            .unwrap()
            .all_points()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
        Maze::new(field, g)
    }

    #[test]
    fn silent_when_density_at_or_above_min() {
        let maze = maze_with_one_triangle_density();
        let check = MinLoopDensityCheck {
            instance_id: TEST_ID.to_string(),
            min_density: 30.0,
            avg_loop_length_estimate: 10,
            floor_scope: FloorScope::WholeMaze,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "30% density meets a minimum of 30");
    }

    #[test]
    fn fires_with_missing_count_when_below_min() {
        // 30% density, min_density 60 -> 30 missing points -> 3 missing cells out of 10 field
        // cells -> ceil(3 / 1) = 3 loops requested.
        let maze = maze_with_one_triangle_density();
        let check = MinLoopDensityCheck {
            instance_id: TEST_ID.to_string(),
            min_density: 60.0,
            avg_loop_length_estimate: 1,
            floor_scope: FloorScope::WholeMaze,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].missing, vec![(RepairArea::WholeMaze, 3)]);
        assert_eq!(
            issues[0]
                .details()
                .get(TEST_ID)
                .and_then(|kv| kv.get("missing")),
            Some(&"3".to_string()),
        );
    }

    #[test]
    fn missing_loop_count_rounds_up() {
        // 30% density, min_density 40 -> 10 missing points -> 1 missing cell -> ceil(1 / 4) = 1.
        let maze = maze_with_one_triangle_density();
        let check = MinLoopDensityCheck {
            instance_id: TEST_ID.to_string(),
            min_density: 40.0,
            avg_loop_length_estimate: 4,
            floor_scope: FloorScope::WholeMaze,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].missing,
            vec![(RepairArea::WholeMaze, 1)],
            "ceil(1/4) must round up to 1, not truncate to 0"
        );
    }

    #[test]
    fn fires_when_no_cycle_exists() {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = field
            .field_of(field_level)
            .unwrap()
            .all_points()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        let check = MinLoopDensityCheck {
            instance_id: TEST_ID.to_string(),
            min_density: 100.0,
            avg_loop_length_estimate: 1,
            floor_scope: FloorScope::WholeMaze,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert!(!issues[0].missing.is_empty());
    }

    #[test]
    fn silent_when_cycle_enumeration_overflows() {
        const SIDE: i32 = 6;
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(
            Arc::default(),
            square_rect(SIDE as usize, SIDE as usize),
            &mut ids,
        )
        .unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        for y in 0..SIDE {
            for x in 0..SIDE {
                let here = field.node_at(field_level, SquarePoint { x, y }).unwrap();
                if x + 1 < SIDE {
                    let right = field
                        .node_at(field_level, SquarePoint { x: x + 1, y })
                        .unwrap();
                    g.add_bidirectional_edge(here, right, EdgeKind::Basic);
                }
                if y + 1 < SIDE {
                    let up = field
                        .node_at(field_level, SquarePoint { x, y: y + 1 })
                        .unwrap();
                    g.add_bidirectional_edge(here, up, EdgeKind::Basic);
                }
            }
        }
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        let check = MinLoopDensityCheck {
            instance_id: TEST_ID.to_string(),
            min_density: 100.0,
            avg_loop_length_estimate: 1,
            floor_scope: FloorScope::WholeMaze,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "overflow must skip silently, not surface a partial/incorrect issue"
        );
    }

    #[test]
    fn required_cells_rounds_to_nearest_not_down() {
        // 30% density, min_density 31 -> required = round(31*10/100) = round(3.1) = 3, already met
        // by the 3 covered cells -> silent, not a stricter ceil-driven false positive.
        let maze = maze_with_one_triangle_density();
        let check = MinLoopDensityCheck {
            instance_id: TEST_ID.to_string(),
            min_density: 31.0,
            avg_loop_length_estimate: 1,
            floor_scope: FloorScope::WholeMaze,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "round(3.1) = 3, already met by the 3 covered cells"
        );
    }

    #[test]
    fn required_cells_rounds_to_nearest_not_up() {
        // 30% density, min_density 35 -> required = round(35*10/100) = round(3.5) = 4, missing_cells = 1.
        let maze = maze_with_one_triangle_density();
        let check = MinLoopDensityCheck {
            instance_id: TEST_ID.to_string(),
            min_density: 35.0,
            avg_loop_length_estimate: 1,
            floor_scope: FloorScope::WholeMaze,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].missing,
            vec![(RepairArea::WholeMaze, 1)],
            "round(3.5) = 4, missing_cells = 1"
        );
    }

    /// 1000 cells in a line, one triangle -> 3 covered cells is negligible; instead build a
    /// covering set of exactly 300 nodes via a chain of triangles to get a clean 30% density on a
    /// field fine-grained enough that a `.1`-scale fractional threshold isn't swallowed by the
    /// `required_cells` rounding step.
    fn maze_with_300_of_1000_covered() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(1000, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
        // 100 disjoint triangles, each covering 3 distinct nodes (300 total), all closed cycles.
        for i in 0..100 {
            let base = i * 3;
            g.add_edge(p(base), p(base + 1), EdgeKind::Basic);
            g.add_edge(p(base + 1), p(base + 2), EdgeKind::Basic);
            g.add_edge(p(base + 2), p(base), EdgeKind::Basic);
        }
        Maze::new(field, g)
    }

    #[test]
    fn min_density_accepts_a_genuinely_fractional_threshold() {
        // 300/1000 = 30% density. min_density 29.9 must stay silent (density clears it);
        // 30.1 must fire (density falls fractionally short) -- pins that the gate compares the
        // true density, not one rounded to a whole percentage first.
        let maze = maze_with_300_of_1000_covered();
        let check = MinLoopDensityCheck {
            instance_id: TEST_ID.to_string(),
            min_density: 29.9,
            avg_loop_length_estimate: 1,
            floor_scope: FloorScope::WholeMaze,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "30% density must clear a fractional minimum of 29.9"
        );

        let check = MinLoopDensityCheck {
            instance_id: TEST_ID.to_string(),
            min_density: 30.1,
            avg_loop_length_estimate: 1,
            floor_scope: FloorScope::WholeMaze,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(
            issues.len(),
            1,
            "30% density must fall short of a fractional minimum of 30.1"
        );
        assert_eq!(
            issues[0].missing,
            vec![(RepairArea::WholeMaze, 1)],
            "required=round(30.1*1000/100)=301, missing_cells=1, ceil(1/1)=1"
        );
    }

    /// Bottom floor: 10 cells, one triangle (30% coverage). Top floor: 10 cells, no cycle (0%).
    fn maze_with_a_triangle_on_two_floors() -> Maze<SquareTessellation> {
        use crate::space::Field;
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::new(Arc::default(), std::iter::empty());
        let bottom = mf.add_level(
            Field::<SquareTessellation>::new(Arc::default(), square_rect(10, 1), &mut ids).unwrap(),
        );
        let top = mf.add_level(
            Field::<SquareTessellation>::new(Arc::default(), square_rect(10, 1), &mut ids).unwrap(),
        );
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let pb = |x: i32| mf.node_at(bottom, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(pb(0), pb(1), EdgeKind::Basic);
        g.add_edge(pb(1), pb(2), EdgeKind::Basic);
        g.add_edge(pb(2), pb(0), EdgeKind::Basic);
        let _ = top;
        Maze::new(mf, g)
    }

    #[test]
    fn per_floor_flags_each_deficient_floor_with_its_own_area_and_amount() {
        // Bottom: 30%, needs round(60*10/100)=6, missing_cells=3. Top: 0%, needs 6.
        let maze = maze_with_a_triangle_on_two_floors();
        let check = MinLoopDensityCheck {
            instance_id: TEST_ID.to_string(),
            min_density: 60.0,
            avg_loop_length_estimate: 1,
            floor_scope: FloorScope::PerFloor,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        let mut missing = issues[0].missing.clone();
        missing.sort_by_key(|&(_, amount)| amount);
        assert_eq!(
            missing.len(),
            2,
            "each deficient floor gets its own RepairArea::Level entry"
        );
        assert_eq!(
            missing[0].1, 3,
            "bottom floor: 30% covered, needs 3 more cells"
        );
        assert_eq!(missing[1].1, 6, "top floor: 0% covered, needs 6 more cells");
    }
}
