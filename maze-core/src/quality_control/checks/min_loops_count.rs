use crate::Maze;
use crate::graph::cycles::resolve_to_edge_ids;
use crate::quality_control::check::Check;
use crate::quality_control::floor_group::floors_of_edges;
use crate::quality_control::{FloorScope, MissingLoopsIssue, RepairArea};
use crate::space::Tessellation;
use rand::RngCore;

pub const MIN_LOOPS_DEFAULT: u32 = 1;
pub const MIN_LOOPS_COUNT_DEFAULT_FLOOR_SCOPE: FloorScope = FloorScope::WholeMaze;

/// Flags a deficit against a raw independent-cycle count — see GitHub issue #177 (originally
/// merged with `MinLoopDensityCheck` into one `Mode`-switched check, split back out since the two
/// measure genuinely different things: an absolute count vs. a field-coverage share).
///
/// `floor_scope` (GitHub issue #369): under `PerFloor`, `min_loops` is evaluated independently
/// against each floor's own cycle count (a cycle spanning more than one floor, e.g. via a
/// cross-floor teleport, counts toward every floor it touches) and the per-floor deficits are
/// summed into one `missing` total — a single `MissingLoopsIssue` per check call either way, same
/// as `WholeMaze`.
pub struct MinLoopsCountCheck {
    pub instance_id: String,
    pub min_loops: u32,
    pub floor_scope: FloorScope,
}

impl<T: Tessellation> Check<T, MissingLoopsIssue> for MinLoopsCountCheck {
    fn check_type_id(&self) -> &'static str {
        "min_loops_count"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<MissingLoopsIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        // Uses the same independent-cycle count (Euler: E - V + C on the pure-cycle core) shown
        // to the user as the "Cycle count" analytics stat — not `find_deduped_simple_cycles`'s raw
        // simple-cycle enumeration, which is a different (usually much larger) metric. Silently
        // skips on `cycle_analysis_overflowed`, same rationale as the simple-cycle checks' overflow
        // skip.
        let analytics = maze.analysis.graph_analytics(&maze.graph, &maze.meta);
        if analytics.cycle_analysis_overflowed {
            return;
        }

        let missing: Vec<(RepairArea, u32)> = match self.floor_scope {
            FloorScope::WholeMaze => {
                let missing = self.min_loops.saturating_sub(analytics.cycle_count as u32);
                if missing == 0 {
                    vec![]
                } else {
                    vec![(RepairArea::WholeMaze, missing)]
                }
            }
            FloorScope::PerFloor => {
                let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
                let cycles = resolve_to_edge_ids(&nav, &analytics.pure_cycle_basis, &maze.graph);
                let mut per_floor_count: std::collections::HashMap<crate::space::LevelId, u32> =
                    maze.field.levels_ordered().map(|l| (l, 0)).collect();
                for cycle in &cycles {
                    let floors = floors_of_edges(&maze.field, &maze.graph, cycle);
                    for level in floors {
                        *per_floor_count.entry(level).or_insert(0) += 1;
                    }
                }
                let mut missing: Vec<(RepairArea, u32)> = per_floor_count
                    .into_iter()
                    .filter_map(|(level, count)| {
                        let missing = self.min_loops.saturating_sub(count);
                        (missing > 0).then_some((RepairArea::Level(level), missing))
                    })
                    .collect();
                // `HashMap` iteration order is randomized per run -- sort by level so the
                // resulting order (and thus RNG consumption order in repair strategies that loop
                // over `issue.missing`) is deterministic for a fixed seed (GitHub issue #369
                // follow-up).
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::EdgeKind;
    use crate::quality_control::Issue;
    use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;

    const TEST_ID: &str = "min_loops_count";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    fn maze_with_triangle() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
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
    fn silent_when_loop_count_meets_minimum() {
        let maze = maze_with_triangle();
        let check = MinLoopsCountCheck {
            instance_id: TEST_ID.to_string(),
            min_loops: 1,
            floor_scope: FloorScope::WholeMaze,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn fires_with_missing_count_when_below_minimum() {
        let maze = maze_with_triangle();
        let check = MinLoopsCountCheck {
            instance_id: TEST_ID.to_string(),
            min_loops: 3,
            floor_scope: FloorScope::WholeMaze,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].missing,
            vec![(crate::quality_control::RepairArea::WholeMaze, 2)]
        );
        assert_eq!(issues[0].source_checks(), vec![TEST_ID.to_string()]);
        assert_eq!(
            issues[0]
                .details()
                .get(TEST_ID)
                .and_then(|kv| kv.get("missing")),
            Some(&"2".to_string()),
        );
    }

    #[test]
    fn silent_when_graph_analytics_overflows() {
        const SIDE: i32 = 6;
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(square_rect(SIDE as usize, SIDE as usize), &mut ids)
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
        let check = MinLoopsCountCheck {
            instance_id: TEST_ID.to_string(),
            min_loops: 1,
            floor_scope: FloorScope::WholeMaze,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "overflow must skip silently, not surface a partial/incorrect issue"
        );
    }

    /// Bottom floor: 1 independent triangle. Top floor: 0 cycles.
    fn maze_with_a_triangle_on_two_floors() -> Maze<SquareTessellation> {
        use crate::space::Field;
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let bottom =
            mf.add_level(Field::<SquareTessellation>::new(square_rect(3, 1), &mut ids).unwrap());
        let top =
            mf.add_level(Field::<SquareTessellation>::new(square_rect(3, 1), &mut ids).unwrap());
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
        let maze = maze_with_a_triangle_on_two_floors();
        let check = MinLoopsCountCheck {
            instance_id: TEST_ID.to_string(),
            min_loops: 2,
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
        assert_eq!(missing[0].1, 1, "bottom floor: 1 loop, needs 1 more");
        assert_eq!(missing[1].1, 2, "top floor: 0 loops, needs 2 more");
    }
}
