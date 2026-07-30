use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::generation::SplitPattern;
use crate::quality_control::check::Check;
use crate::quality_control::{Issue, MissingSplitTilesIssue};
use crate::quality_control::split_pattern_match::split_tile_matches_any;

pub const SPLIT_COUNT_DEFAULT: u32 = 1;

/// Flags a deficit against a minimum split-tile count — see GitHub issue #247, part of epic #246.
/// Mirrors `MinLoopsCountCheck`'s shape exactly, applied to split tiles instead of loops. When
/// `patterns` is non-empty, only a split tile structurally matching one of the listed patterns
/// (any rotation/mirror, see `split_tile_matches_any`) counts toward the total; an empty list
/// means every split tile counts regardless of pattern. **Known limitation** (see GitHub issue
/// #247/#253): this `patterns` list is independent from `AddSplitStrategy`'s own pattern
/// selection — the repair strategy has no visibility into which patterns this check actually
/// wanted, so it may "fix" the deficit with tiles of a pattern this check doesn't count.
pub struct SplitCountCheck {
    pub instance_id: String,
    pub min_count: u32,
    pub patterns: Vec<SplitPattern>,
}

impl<T: Tessellation> Check<T, MissingSplitTilesIssue> for SplitCountCheck {
    fn check_type_id(&self) -> &'static str { "split_count" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<MissingSplitTilesIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        let count = count_matching_split_tiles(maze, &self.patterns) as u32;
        let missing = self.min_count.saturating_sub(count);
        if missing == 0 {
            return;
        }
        let issue = MissingSplitTilesIssue::new_from_check(&self.instance_id, missing)
            .with_detail(&self.instance_id, "missing", missing.to_string());
        issues.push(issue);
    }
}

/// Shared split-tile counting core for `SplitCountCheck`/`SplitDensityCheck` — one point per
/// split tile (`nodes_at(point).len() >= 2`), optionally filtered by `patterns` (empty = every
/// split tile counts, no reconstruction/matching attempted at all).
pub(super) fn count_matching_split_tiles<T: Tessellation>(maze: &Maze<T>, patterns: &[SplitPattern]) -> usize {
    let mut seen_points = std::collections::HashSet::new();
    maze.field.all_points()
        .filter(|&point| seen_points.insert(point))
        .filter(|&point| {
            let nodes = maze.field.nodes_at(point);
            if nodes.len() < 2 {
                return false;
            }
            patterns.is_empty() || split_tile_matches_any(&maze.graph, &maze.field, nodes, patterns)
        })
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::{Graph, IdGenerator};
    use crate::space::{Field, SquareTessellation, SquarePoint, square_rect};

    const TEST_ID: &str = "split_count";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    fn maze_with_split_tiles(count: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let mut field: Field<SquareTessellation> = Field::new(square_rect(count.max(1) + 1, 1), &mut ids).unwrap();
        for x in 0..count as i32 {
            field.add_node_at(SquarePoint { x, y: 0 }, &mut ids);
        }
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        Maze::new(field, g)
    }

    #[test]
    fn fires_with_missing_count_when_below_minimum() {
        let maze = maze_with_split_tiles(1);
        let check = SplitCountCheck { instance_id: TEST_ID.to_string(), min_count: 3, patterns: vec![] };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].missing, 2);
        assert_eq!(
            issues[0].details().get(TEST_ID).and_then(|kv| kv.get("missing")),
            Some(&"2".to_string()),
        );
    }

    #[test]
    fn silent_when_count_meets_minimum() {
        let maze = maze_with_split_tiles(2);
        let check = SplitCountCheck { instance_id: TEST_ID.to_string(), min_count: 2, patterns: vec![] };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn silent_when_no_split_tiles_and_minimum_is_zero() {
        let maze = maze_with_split_tiles(0);
        let check = SplitCountCheck { instance_id: TEST_ID.to_string(), min_count: 0, patterns: vec![] };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn pattern_filter_ignores_tiles_that_do_not_match_any_listed_pattern() {
        use crate::generation::{SplitFaceRequirement, SplitPatternFace};
        // 2 split tiles exist, but neither matches this arbitrary pattern (no faces declared at
        // all — the tile can never structurally match it), so the count-with-filter is 0.
        let maze = maze_with_split_tiles(2);
        let unmatched_pattern = SplitPattern {
            node_count: 2,
            faces: vec![
                vec![SplitPatternFace { face_index: 0, requirement: SplitFaceRequirement::Passage, sibling_target: None }],
                vec![SplitPatternFace { face_index: 0, requirement: SplitFaceRequirement::Passage, sibling_target: None }],
            ],
            weight: 1.0,
        };
        let check = SplitCountCheck { instance_id: TEST_ID.to_string(), min_count: 1, patterns: vec![unmatched_pattern] };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].missing, 1, "neither tile matches the listed pattern, so both are excluded from the count");
    }
}
