use std::collections::HashMap;
use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::graph::cycles::{find_deduped_simple_cycles, resolve_to_edge_ids};
use crate::graph::distance_map::cycle_min_distance;
use crate::quality_control::check::Check;
use crate::quality_control::issue::{Issue, INVALID_LOOP};
use crate::quality_control::issue_data::{IssueData, canonical_cycle_key};

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
}

impl<T: Tessellation> Check<T> for LoopDistanceFromStartCheck {
    fn check_type_id(&self) -> &'static str { "loop_distance_from_start" }

    fn check(&self, maze: &Maze<T>, issues: &mut Vec<Issue>, _rng: &mut dyn RngCore) {
        let Some(dist_from_start) = maze.analysis.distance_from_start(&maze.graph, &maze.meta) else { return };
        let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
        let nav = &nav;
        // Silently skip on overflow, same rationale as MinLoopLengthCheck (issue #22).
        let Some(cycles) = find_deduped_simple_cycles(nav) else { return };

        let too_early: Vec<usize> = cycles.iter().enumerate()
            .filter(|(_, cycle)| {
                cycle_min_distance(nav, cycle, &dist_from_start) < self.min_distance_from_start as usize
            })
            .map(|(idx, _)| idx)
            .collect();
        if too_early.is_empty() {
            return;
        }
        let all = resolve_to_edge_ids(nav, &cycles, &maze.graph);
        debug_assert!(too_early.iter().all(|&idx| idx < all.len()),
            "too_early must only contain valid indices into all — built from the same `cycles` it resolves");
        let mut invalid_sources: HashMap<Vec<crate::ids::EdgeId>, Vec<String>> = HashMap::new();
        for &idx in &too_early {
            invalid_sources.entry(canonical_cycle_key(&all[idx])).or_default().push(self.instance_id.clone());
        }
        let issue = Issue::with_data_from_check(INVALID_LOOP, IssueData::InvalidLoops { all, invalid: too_early, invalid_sources }, &self.instance_id)
            .with_detail(&self.instance_id, "min_distance_from_start", self.min_distance_from_start.to_string());
        issues.push(issue);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::graph::EdgeKind;
    use crate::{Graph, IdGenerator};
    use crate::space::{Field, SquareTessellation, SquarePoint, square_rect};
    use crate::meta::MazeMeta;

    const TEST_ID: &str = "loop_distance_from_start";

    /// start -- a -- b -- c -- (triangle c,d,e) -- finish-less.
    /// Triangle's nearest vertex `c` is 3 tiles from start.
    fn maze_with_triangle_at_distance(distance: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let width = distance + 3;
        let field: Field<SquareTessellation> = Field::new(square_rect(width, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
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
        maze.meta = MazeMeta { start: Some(start), finish: None, route_score: None };
        maze
    }

    #[test]
    fn fires_when_cycle_closer_than_threshold() {
        let maze = maze_with_triangle_at_distance(3);
        let check = LoopDistanceFromStartCheck { instance_id: TEST_ID.to_string(), min_distance_from_start: 5 };
        let mut issues = Vec::new();
        let mut rng = rand::rngs::SmallRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut rng);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].kind, INVALID_LOOP);
        assert_eq!(issues[0].source_checks(), vec![TEST_ID.to_string()]);
        match &issues[0].data {
            Some(IssueData::InvalidLoops { invalid, .. }) => assert_eq!(invalid.len(), 1),
            other => panic!("expected InvalidLoops, got {other:?}"),
        }
        assert_eq!(
            issues[0].details().get(TEST_ID).and_then(|kv| kv.get("min_distance_from_start")),
            Some(&"5".to_string()),
        );
    }

    #[test]
    fn silent_when_cycle_farther_than_threshold() {
        let maze = maze_with_triangle_at_distance(10);
        let check = LoopDistanceFromStartCheck { instance_id: TEST_ID.to_string(), min_distance_from_start: 5 };
        let mut issues = Vec::new();
        let mut rng = rand::rngs::SmallRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut rng);
        assert!(issues.is_empty(), "cycle is 10 tiles out, threshold is 5");
    }

    /// start -- (near triangle, touches start at distance 0) -- corridor -- (far triangle,
    /// closest vertex at `far_distance` tiles). Two independent cycles so a threshold between
    /// the two distances flags only the near one, exercising the "some cycles flagged, some
    /// not" branch (`too_early` partially populated, not just empty-vs-full).
    fn maze_with_two_triangles(far_distance: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let width = far_distance + 6;
        let field: Field<SquareTessellation> = Field::new(square_rect(width, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();

        // near triangle: start (node 0) is itself a triangle vertex -> distance 0
        let (na, nb, nc) = (p(0), p(1), p(2));
        g.add_edge(na, nb, EdgeKind::Basic);
        g.add_edge(nb, nc, EdgeKind::Basic);
        g.add_edge(nc, na, EdgeKind::Basic);

        // corridor out to the far triangle
        for x in 2..(far_distance as i32 + 2) {
            g.add_bidirectional_edge(p(x), p(x + 1), EdgeKind::Basic);
        }
        let (fa, fb, fc) = (p(far_distance as i32 + 2), p(far_distance as i32 + 3), p(far_distance as i32 + 4));
        g.add_edge(fa, fb, EdgeKind::Basic);
        g.add_edge(fb, fc, EdgeKind::Basic);
        g.add_edge(fc, fa, EdgeKind::Basic);

        let mut maze = Maze::new(field, g);
        maze.meta = MazeMeta { start: Some(na), finish: None, route_score: None };
        maze
    }

    #[test]
    fn flags_only_the_cycle_below_threshold_when_multiple_cycles_exist() {
        let maze = maze_with_two_triangles(20);
        let check = LoopDistanceFromStartCheck { instance_id: TEST_ID.to_string(), min_distance_from_start: 5 };
        let mut issues = Vec::new();
        let mut rng = rand::rngs::SmallRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut rng);
        assert_eq!(issues.len(), 1);
        match &issues[0].data {
            Some(IssueData::InvalidLoops { all, invalid, .. }) => {
                assert_eq!(all.len(), 2, "both cycles must be enumerated");
                assert_eq!(invalid.len(), 1, "only the near cycle is below the threshold");
            }
            other => panic!("expected InvalidLoops, got {other:?}"),
        }
    }

    #[test]
    fn silent_when_threshold_is_zero() {
        let maze = maze_with_triangle_at_distance(0);
        let check = LoopDistanceFromStartCheck { instance_id: TEST_ID.to_string(), min_distance_from_start: 0 };
        let mut issues = Vec::new();
        let mut rng = rand::rngs::SmallRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut rng);
        assert!(issues.is_empty(), "a threshold of 0 should never flag any cycle");
    }

    #[test]
    fn silent_when_start_is_missing() {
        let mut maze = maze_with_triangle_at_distance(3);
        maze.meta.start = None;
        let check = LoopDistanceFromStartCheck { instance_id: TEST_ID.to_string(), min_distance_from_start: 100 };
        let mut issues = Vec::new();
        let mut rng = rand::rngs::SmallRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut rng);
        assert!(issues.is_empty(), "missing start is MissingEndpointsCheck's job");
    }

    #[test]
    fn silent_when_no_cycle() {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta.start = Some(nodes[0]);
        let check = LoopDistanceFromStartCheck { instance_id: TEST_ID.to_string(), min_distance_from_start: 100 };
        let mut issues = Vec::new();
        let mut rng = rand::rngs::SmallRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut rng);
        assert!(issues.is_empty());
    }

    #[test]
    fn silent_when_cycle_enumeration_overflows() {
        const SIDE: i32 = 6;
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(SIDE as usize, SIDE as usize), &mut ids).unwrap();
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
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta.start = Some(maze.field.node_at(SquarePoint { x: 0, y: 0 }).unwrap());
        let check = LoopDistanceFromStartCheck { instance_id: TEST_ID.to_string(), min_distance_from_start: 100 };
        let mut issues = Vec::new();
        let mut rng = rand::rngs::SmallRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut rng);
        assert!(issues.is_empty(), "overflow must skip silently, not surface a partial/incorrect issue");
    }
}
