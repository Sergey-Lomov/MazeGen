use std::collections::HashMap;
use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::graph::cycles::{find_deduped_simple_cycles, resolve_to_edge_ids};
use crate::quality_control::check::Check;
use crate::quality_control::issue::{Issue, INVALID_LOOP};
use crate::quality_control::issue_data::{IssueData, canonical_cycle_key};

pub const MIN_LOOP_LENGTH_DEFAULT: u32 = 10;

pub struct MinLoopLengthCheck {
    pub instance_id: String,
    pub min_loop_length: u32,
}

impl<T: Tessellation> Check<T> for MinLoopLengthCheck {
    fn check_type_id(&self) -> &'static str { "min_loop_length" }

    fn check(&self, maze: &Maze<T>, issues: &mut Vec<Issue>, _rng: &mut dyn RngCore) {
        let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
        let nav = &nav;
        // Silently skip on overflow (see `CycleSearchResult::TooManyCycles`) rather than
        // hang on a dense, heavily preset-connected graph (issue #22) — this check is
        // toggleable, so a maze that can't be analyzed here just doesn't get this check,
        // same as if it were disabled.
        let Some(cycles) = find_deduped_simple_cycles(nav) else { return };

        let short: Vec<usize> = cycles.iter().enumerate()
            .filter(|(_, cycle)| tile_length(nav, cycle) < self.min_loop_length)
            .map(|(idx, _)| idx)
            .collect();
        if short.is_empty() {
            return;
        }
        let all = resolve_to_edge_ids(nav, &cycles, &maze.graph);
        debug_assert!(short.iter().all(|&idx| idx < all.len()),
            "short must only contain valid indices into all — built from the same `cycles` it resolves");
        let mut invalid_sources: HashMap<Vec<crate::ids::EdgeId>, Vec<String>> = HashMap::new();
        for &idx in &short {
            invalid_sources.entry(canonical_cycle_key(&all[idx])).or_default().push(self.instance_id.clone());
        }
        let issue = Issue::with_data_from_check(INVALID_LOOP, IssueData::InvalidLoops { all, invalid: short, invalid_sources }, &self.instance_id)
            .with_detail(&self.instance_id, "threshold", self.min_loop_length.to_string());
        issues.push(issue);
    }
}

/// Tile-length of a nav-edge cycle: sum of each edge's tile-hop count
/// (`path.len() - 1`), measured in base-graph tile-hops, not nav-edge count.
fn tile_length(nav: &crate::graph::nav::NavGraph, cycle: &[usize]) -> u32 {
    cycle.iter()
        .map(|&idx| (nav.edge_by_idx(idx).path.len() as u32).saturating_sub(1))
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::graph::EdgeKind;
    use crate::{Graph, IdGenerator};
    use crate::space::{Field, SquareTessellation, SquarePoint, square_rect};

    const TEST_ID: &str = "min_loop_length";

    fn maze_with_triangle() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
        Maze::new(field, g)
    }

    #[test]
    fn fires_when_short_cycle_exists() {
        let maze = maze_with_triangle();
        let check = MinLoopLengthCheck { instance_id: TEST_ID.to_string(), min_loop_length: 10 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut rng);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].kind, INVALID_LOOP);
        assert_eq!(issues[0].source_checks(), vec![TEST_ID.to_string()]);
        match &issues[0].data {
            Some(IssueData::InvalidLoops { invalid, .. }) => assert_eq!(invalid.len(), 1),
            other => panic!("expected InvalidLoops, got {other:?}"),
        }
        assert_eq!(
            issues[0].details().get(TEST_ID).and_then(|kv| kv.get("threshold")),
            Some(&"10".to_string()),
        );
    }

    #[test]
    fn silent_when_cycle_not_shorter_than_threshold() {
        let maze = maze_with_triangle();
        let check = MinLoopLengthCheck { instance_id: TEST_ID.to_string(), min_loop_length: 3 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut rng);
        assert!(issues.is_empty(), "triangle has 3 tile-hops, not < 3");
    }

    #[test]
    fn silent_when_cycle_enumeration_overflows() {
        // Same 6x6 fully-bidirectional grid as the `cycles.rs` regression test for issue #22
        // (2,444,782 simple cycles — far past MAX_SIMPLE_CYCLES). This check is toggleable, so
        // on overflow it must skip silently (no issue, no panic) rather than hang or surface a
        // spurious result — same effect as if the check were disabled for this maze.
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
        let check = MinLoopLengthCheck { instance_id: TEST_ID.to_string(), min_loop_length: 10 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut rng);
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
        let check = MinLoopLengthCheck { instance_id: TEST_ID.to_string(), min_loop_length: 10 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut rng);
        assert!(issues.is_empty());
    }
}
