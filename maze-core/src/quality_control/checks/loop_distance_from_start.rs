use super::cycle_check_core::{build_issue, find_invalid_cycles};
use crate::Maze;
use crate::graph::distance_map::cycle_min_distance;
use crate::quality_control::check::Check;
use crate::quality_control::{CycleKind, InvalidLoopIssue, InvalidLoopRequirement};
use crate::space::Tessellation;
use rand::RngCore;

pub const LOOP_DISTANCE_FROM_START_DEFAULT: u32 = 0;

/// Flags simple cycles placed too early in level progression — see GitHub issue #33. A cycle's
/// distance from start is the minimum shortest-path distance (in tiles, directed graph
/// traversal — never geometric) from `meta.start` to any nav-node touched by the cycle; a
/// cycle below `min_distance_from_start` sits too close to the start in progression space.
///
/// Silently skips (no issue) if `meta.start` isn't set — covered by `MissingEndpointsCheck`.
pub struct LoopDistanceFromStartCheck {
    pub instance_id: String,
    pub min_distance_from_start: u32,
    pub cycle_kind: CycleKind,
}

impl<T: Tessellation> Check<T, InvalidLoopIssue> for LoopDistanceFromStartCheck {
    fn check_type_id(&self) -> &'static str {
        "loop_distance_from_start"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidLoopIssue>,
        _rng: &mut dyn RngCore,
        _requirement: InvalidLoopRequirement,
    ) {
        // Not yet migrated to honor `_requirement` — always computes all(), see GitHub issue #105.
        let Some(dist_from_start) = maze.analysis.distance_from_start(&maze.graph, &maze.meta)
        else {
            return;
        };
        // Silently skip on overflow, same rationale as MinLoopLengthCheck (issue #22).
        let Some((nav, cycles, too_early)) =
            find_invalid_cycles(maze, self.cycle_kind, |nav, cycle| {
                cycle_min_distance(nav, cycle, &dist_from_start)
                    < self.min_distance_from_start as usize
            })
        else {
            return;
        };

        issues.push(build_issue(
            &nav,
            &cycles,
            too_early,
            &maze.graph,
            &self.instance_id,
            "min_distance_from_start",
            self.min_distance_from_start,
            InvalidLoopRequirement::all(),
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::EdgeKind;
    use crate::meta::MazeMeta;
    use crate::quality_control::Issue;
    use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;
    use std::sync::Arc;

    const TEST_ID: &str = "loop_distance_from_start";

    /// start -- a -- b -- c -- (triangle c,d,e) -- finish-less.
    /// Triangle's nearest vertex `c` is 3 tiles from start.
    fn maze_with_triangle_at_distance(distance: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let width = distance + 3;
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(width, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
        for x in 0..distance as i32 {
            g.add_bidirectional_edge(p(x), p(x + 1), EdgeKind::Basic);
        }
        // triangle starting at node `distance`
        let c = p(distance as i32);
        let d = p(distance as i32 + 1);
        let e = p(distance as i32 + 2);
        g.add_edge(c, d, EdgeKind::Basic);
        g.add_edge(d, e, EdgeKind::Basic);
        g.add_edge(e, c, EdgeKind::Basic);
        let start = p(0);
        let mut maze = Maze::new(field, g);
        maze.meta = MazeMeta {
            start: Some(start),
            finish: None,
        };
        maze
    }

    #[test]
    fn fires_when_cycle_closer_than_threshold() {
        let maze = maze_with_triangle_at_distance(3);
        let check = LoopDistanceFromStartCheck {
            instance_id: TEST_ID.to_string(),
            min_distance_from_start: 5,
            cycle_kind: CycleKind::Any,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, InvalidLoopRequirement::all());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].invalid.len(), 1);
        assert_eq!(issues[0].source_checks(), vec![TEST_ID.to_string()]);
        assert_eq!(
            issues[0]
                .details()
                .get(TEST_ID)
                .and_then(|kv| kv.get("min_distance_from_start")),
            Some(&"5".to_string()),
        );
    }

    #[test]
    fn silent_when_cycle_farther_than_threshold() {
        let maze = maze_with_triangle_at_distance(10);
        let check = LoopDistanceFromStartCheck {
            instance_id: TEST_ID.to_string(),
            min_distance_from_start: 5,
            cycle_kind: CycleKind::Any,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, InvalidLoopRequirement::all());
        assert!(issues.is_empty(), "cycle is 10 tiles out, threshold is 5");
    }

    /// start -- (near triangle, touches start at distance 0) -- corridor -- (far triangle,
    /// closest vertex at `far_distance` tiles). Two independent cycles so a threshold between
    /// the two distances flags only the near one, exercising the "some cycles flagged, some
    /// not" branch (`too_early` partially populated, not just empty-vs-full).
    fn maze_with_two_triangles(far_distance: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let width = far_distance + 6;
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(width, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();

        // near triangle: start (node 0) is itself a triangle vertex -> distance 0
        let (na, nb, nc) = (p(0), p(1), p(2));
        g.add_edge(na, nb, EdgeKind::Basic);
        g.add_edge(nb, nc, EdgeKind::Basic);
        g.add_edge(nc, na, EdgeKind::Basic);

        // corridor out to the far triangle
        for x in 2..(far_distance as i32 + 2) {
            g.add_bidirectional_edge(p(x), p(x + 1), EdgeKind::Basic);
        }
        let (fa, fb, fc) = (
            p(far_distance as i32 + 2),
            p(far_distance as i32 + 3),
            p(far_distance as i32 + 4),
        );
        g.add_edge(fa, fb, EdgeKind::Basic);
        g.add_edge(fb, fc, EdgeKind::Basic);
        g.add_edge(fc, fa, EdgeKind::Basic);

        let mut maze = Maze::new(field, g);
        maze.meta = MazeMeta {
            start: Some(na),
            finish: None,
        };
        maze
    }

    #[test]
    fn flags_only_the_cycle_below_threshold_when_multiple_cycles_exist() {
        let maze = maze_with_two_triangles(20);
        let check = LoopDistanceFromStartCheck {
            instance_id: TEST_ID.to_string(),
            min_distance_from_start: 5,
            cycle_kind: CycleKind::Any,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, InvalidLoopRequirement::all());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].all.len(), 2, "both cycles must be enumerated");
        assert_eq!(
            issues[0].invalid.len(),
            1,
            "only the near cycle is below the threshold"
        );
    }

    #[test]
    fn silent_when_threshold_is_zero() {
        let maze = maze_with_triangle_at_distance(0);
        let check = LoopDistanceFromStartCheck {
            instance_id: TEST_ID.to_string(),
            min_distance_from_start: 0,
            cycle_kind: CycleKind::Any,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, InvalidLoopRequirement::all());
        assert!(
            issues.is_empty(),
            "a threshold of 0 should never flag any cycle"
        );
    }

    #[test]
    fn silent_when_start_is_missing() {
        let mut maze = maze_with_triangle_at_distance(3);
        maze.meta.start = None;
        let check = LoopDistanceFromStartCheck {
            instance_id: TEST_ID.to_string(),
            min_distance_from_start: 100,
            cycle_kind: CycleKind::Any,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, InvalidLoopRequirement::all());
        assert!(
            issues.is_empty(),
            "missing start is MissingEndpointsCheck's job"
        );
    }

    #[test]
    fn silent_when_no_cycle() {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = field
            .field_of(field_level)
            .unwrap()
            .all_cells()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta.start = Some(nodes[0]);
        let check = LoopDistanceFromStartCheck {
            instance_id: TEST_ID.to_string(),
            min_distance_from_start: 100,
            cycle_kind: CycleKind::Any,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, InvalidLoopRequirement::all());
        assert!(issues.is_empty());
    }

    #[test]
    fn silent_when_cycle_enumeration_overflows() {
        const SIDE: i32 = 6;
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(
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
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta.start = Some(
            maze.field
                .node_at(maze.field.single_level_id(), SquarePoint { x: 0, y: 0 })
                .unwrap(),
        );
        let check = LoopDistanceFromStartCheck {
            instance_id: TEST_ID.to_string(),
            min_distance_from_start: 100,
            cycle_kind: CycleKind::Any,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, InvalidLoopRequirement::all());
        assert!(
            issues.is_empty(),
            "overflow must skip silently, not surface a partial/incorrect issue"
        );
    }

    /// Repro for the reported bug: with a huge threshold, `cycle_kind: OneWay` was reported to
    /// flag every cycle (including fully bidirectional ones), while `TwoWay` behaved correctly.
    /// One one-way triangle and one fully-bidirectional triangle, both reachable from start,
    /// far below a threshold of 1000 (so both cycles are "too close" under the base predicate).
    fn maze_with_one_way_and_two_way_triangle() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(3, 2), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32, y: i32| field.node_at(field_level, SquarePoint { x, y }).unwrap();

        // one-way triangle on row 0
        let (a, b, c) = (p(0, 0), p(1, 0), p(2, 0));
        g.add_edge(a, b, EdgeKind::Basic);
        g.add_edge(b, c, EdgeKind::Basic);
        g.add_edge(c, a, EdgeKind::Basic);

        // fully-bidirectional triangle on row 1
        let (d, e, f) = (p(0, 1), p(1, 1), p(2, 1));
        g.add_bidirectional_edge(d, e, EdgeKind::Basic);
        g.add_bidirectional_edge(e, f, EdgeKind::Basic);
        g.add_bidirectional_edge(f, d, EdgeKind::Basic);

        // link both triangles to start so both are reachable
        g.add_bidirectional_edge(a, d, EdgeKind::Basic);

        let mut maze = Maze::new(field, g);
        maze.meta = MazeMeta {
            start: Some(a),
            finish: None,
        };
        maze
    }

    #[test]
    fn cycle_kind_one_way_flags_only_the_one_way_triangle_even_with_huge_threshold() {
        let maze = maze_with_one_way_and_two_way_triangle();
        let check = LoopDistanceFromStartCheck {
            instance_id: TEST_ID.to_string(),
            min_distance_from_start: 1000,
            cycle_kind: CycleKind::OneWay,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, InvalidLoopRequirement::all());
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].invalid.len(),
            1,
            "OneWay must flag only the one-way triangle, not the bidirectional one too"
        );
    }

    #[test]
    fn cycle_kind_two_way_flags_only_the_two_way_triangle_even_with_huge_threshold() {
        let maze = maze_with_one_way_and_two_way_triangle();
        let check = LoopDistanceFromStartCheck {
            instance_id: TEST_ID.to_string(),
            min_distance_from_start: 1000,
            cycle_kind: CycleKind::TwoWay,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, InvalidLoopRequirement::all());
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].invalid.len(),
            1,
            "TwoWay must flag only the bidirectional triangle"
        );
    }
}
