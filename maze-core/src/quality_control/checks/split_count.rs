use crate::Maze;
use crate::generation::SplitPattern;
use crate::quality_control::check::Check;
use crate::quality_control::split_pattern_match::split_tile_matches_any;
use crate::quality_control::{FloorScope, MissingSplitTilesIssue, RepairArea};
use crate::space::{LevelId, Tessellation};
use rand::RngCore;
use std::collections::HashMap;

pub const SPLIT_COUNT_DEFAULT: u32 = 1;
pub const SPLIT_COUNT_DEFAULT_FLOOR_SCOPE: FloorScope = FloorScope::WholeMaze;

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
    pub floor_scope: FloorScope,
}

impl<T: Tessellation> Check<T, MissingSplitTilesIssue> for SplitCountCheck {
    fn check_type_id(&self) -> &'static str {
        "split_count"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<MissingSplitTilesIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let missing: Vec<(RepairArea, u32)> = match self.floor_scope {
            FloorScope::WholeMaze => {
                let missing = self
                    .min_count
                    .saturating_sub(count_matching_split_tiles(maze, &self.patterns) as u32);
                if missing == 0 {
                    vec![]
                } else {
                    vec![(RepairArea::WholeMaze, missing)]
                }
            }
            FloorScope::PerFloor => {
                let mut missing: Vec<(RepairArea, u32)> =
                    count_matching_split_tiles_per_floor(maze, &self.patterns)
                        .into_iter()
                        .filter_map(|(level, count)| {
                            let missing = self.min_count.saturating_sub(count as u32);
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
        let issue = MissingSplitTilesIssue::new_from_check(&self.instance_id, missing).with_detail(
            &self.instance_id,
            "missing",
            total.to_string(),
        );
        issues.push(issue);
    }
}

/// Shared split-tile counting core for `SplitCountCheck`/`SplitDensityCheck` — one point per
/// split tile (`nodes_at(point).len() >= 2`), optionally filtered by `patterns` (empty = every
/// split tile counts, no reconstruction/matching attempted at all).
pub(super) fn count_matching_split_tiles<T: Tessellation>(
    maze: &Maze<T>,
    patterns: &[SplitPattern],
) -> usize {
    matching_split_tile_points(maze, patterns).count()
}

/// Per-floor split-tile counts, same matching rule as `count_matching_split_tiles` — a split tile
/// belongs to exactly one floor (unlike edges/nodes spanning floors), so this is a plain grouping,
/// not a cross-floor-counts-twice case (GitHub issue #369). Floors with no matching tile still
/// appear with a count of 0, so callers can compute a deficit/excess against every floor.
pub(super) fn count_matching_split_tiles_per_floor<T: Tessellation>(
    maze: &Maze<T>,
    patterns: &[SplitPattern],
) -> HashMap<LevelId, usize> {
    let mut per_floor: HashMap<LevelId, usize> =
        maze.field.levels_ordered().map(|l| (l, 0)).collect();
    for (level, _) in matching_split_tile_points(maze, patterns) {
        *per_floor.entry(level).or_insert(0) += 1;
    }
    per_floor
}

fn matching_split_tile_points<'a, T: Tessellation>(
    maze: &'a Maze<T>,
    patterns: &'a [SplitPattern],
) -> impl Iterator<Item = (LevelId, T::Point)> + 'a {
    let mut seen_points = std::collections::HashSet::new();
    maze.field
        .all_points_with_level()
        .filter(move |&(level, point)| seen_points.insert((level, point)))
        .filter(move |&(level, point)| {
            let nodes = maze.field.nodes_at(level, point);
            if nodes.len() < 2 {
                return false;
            }
            patterns.is_empty() || split_tile_matches_any(&maze.graph, &maze.field, nodes, patterns)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quality_control::Issue;
    use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;

    const TEST_ID: &str = "split_count";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    fn maze_with_split_tiles(count: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(square_rect(count.max(1) + 1, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        for x in 0..count as i32 {
            field.add_node_at(level, SquarePoint { x, y: 0 }, &mut ids);
        }
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        Maze::new(field, g)
    }

    #[test]
    fn fires_with_missing_count_when_below_minimum() {
        let maze = maze_with_split_tiles(1);
        let check = SplitCountCheck {
            instance_id: TEST_ID.to_string(),
            min_count: 3,
            patterns: vec![],
            floor_scope: FloorScope::WholeMaze,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].missing, vec![(RepairArea::WholeMaze, 2)]);
        assert_eq!(
            issues[0]
                .details()
                .get(TEST_ID)
                .and_then(|kv| kv.get("missing")),
            Some(&"2".to_string()),
        );
    }

    #[test]
    fn silent_when_count_meets_minimum() {
        let maze = maze_with_split_tiles(2);
        let check = SplitCountCheck {
            instance_id: TEST_ID.to_string(),
            min_count: 2,
            patterns: vec![],
            floor_scope: FloorScope::WholeMaze,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn silent_when_no_split_tiles_and_minimum_is_zero() {
        let maze = maze_with_split_tiles(0);
        let check = SplitCountCheck {
            instance_id: TEST_ID.to_string(),
            min_count: 0,
            patterns: vec![],
            floor_scope: FloorScope::WholeMaze,
        };
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
                vec![SplitPatternFace {
                    face_index: 0,
                    requirement: SplitFaceRequirement::Passage,
                    sibling_target: None,
                }],
                vec![SplitPatternFace {
                    face_index: 0,
                    requirement: SplitFaceRequirement::Passage,
                    sibling_target: None,
                }],
            ],
            weight: 1.0,
        };
        let check = SplitCountCheck {
            instance_id: TEST_ID.to_string(),
            min_count: 1,
            patterns: vec![unmatched_pattern],
            floor_scope: FloorScope::WholeMaze,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].missing,
            vec![(RepairArea::WholeMaze, 1)],
            "neither tile matches the listed pattern, so both are excluded from the count"
        );
    }

    /// Bottom floor: 1 split tile. Top floor: 0 split tiles.
    fn maze_with_split_tiles_on_two_floors() -> Maze<SquareTessellation> {
        use crate::space::Field;
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let bottom =
            mf.add_level(Field::<SquareTessellation>::new(square_rect(4, 1), &mut ids).unwrap());
        let top =
            mf.add_level(Field::<SquareTessellation>::new(square_rect(4, 1), &mut ids).unwrap());
        mf.add_node_at(bottom, SquarePoint { x: 0, y: 0 }, &mut ids);
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let _ = top;
        Maze::new(mf, g)
    }

    #[test]
    fn per_floor_flags_each_deficient_floor_with_its_own_area_and_amount() {
        let maze = maze_with_split_tiles_on_two_floors();
        let check = SplitCountCheck {
            instance_id: TEST_ID.to_string(),
            min_count: 2,
            patterns: vec![],
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
        assert_eq!(missing[0].1, 1, "bottom floor: 1 tile, needs 1 more");
        assert_eq!(missing[1].1, 2, "top floor: 0 tiles, needs 2 more");
    }
}
