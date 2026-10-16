use crate::Maze;
use crate::generation::SplitPattern;
use crate::quality_control::check::Check;
use crate::quality_control::split_pattern_match::split_tile_matches_any;
use crate::quality_control::{InvalidSplitTileIssue, SplitTileNodes};
use crate::space::Tessellation;
use rand::RngCore;

/// Flags a split tile whose current shape no longer structurally matches any declared pattern
/// (any rotation/mirror — see `split_tile_matches_any`) — GitHub issue #382, part of epic #246.
///
/// A split can be minted matching a configured pattern (by `AddSplitStrategy`, or by generation's
/// own pattern path), then have one of its nodes/connections removed by a later, independent
/// repair strategy in the same pass (e.g. `RemoveSplitNodeStrategy`, `SplitRouteCutStrategy`,
/// `RemoveSplitNodeConnectionStrategy`) — the tile is still nominally valid at that point
/// (`nodes_at(point).len() >= 2`), so no other split check catches the resulting malformed shape,
/// and it lingers in the graph. This check re-validates every split tile's *current* shape against
/// the same pattern list each pass, the same way `SplitCountCheck`/`SplitDensityCheck` already
/// filter tiles by pattern membership when counting.
///
/// `patterns` is this check's own param (not the rule-level `split_patterns` param shared by
/// `split_count`/`split_density`/`add_split` — this check may run in a rule with none of those,
/// so it needs its own declared shape list). Empty by default, producing no issues at all in that
/// case (there is no declared shape to validate against).
///
/// Flags the whole tile (`SplitTileNodes`, slot-0 included — same "tile is the unit of work"
/// convention as `SplitDistanceFromWaypointCheck`/`SplitTeleportIntersectionCheck`). Repaired by
/// `RemoveSplitStrategy` (registered against `INVALID_SPLIT_TILE`) — no new strategy needed.
pub struct SplitPatternShapeCheck {
    pub instance_id: String,
    pub patterns: Vec<SplitPattern>,
}

impl<T: Tessellation> Check<T, InvalidSplitTileIssue> for SplitPatternShapeCheck {
    fn check_type_id(&self) -> &'static str {
        "split_pattern_shape"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidSplitTileIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        if self.patterns.is_empty() {
            return;
        }

        let invalid: Vec<SplitTileNodes> = maze
            .field
            .split_cells()
            .filter_map(|(level, point)| {
                let nodes = maze.field.nodes_at(level, point);
                if split_tile_matches_any(&maze.graph, &maze.field, nodes, &self.patterns) {
                    return None;
                }
                Some(SplitTileNodes::new(nodes.to_vec()))
            })
            .collect();

        if invalid.is_empty() {
            return;
        }
        let issue = InvalidSplitTileIssue::new_from_check(&self.instance_id, invalid);
        issues.push(issue);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generation::{OneWayDirection, SplitFaceRequirement, SplitPatternFace};
    use crate::graph::EdgeKind;
    use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;
    use std::sync::Arc;

    const TEST_ID: &str = "split_pattern_shape";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    /// SquareFace order: [N, S, E, W] (see square.rs). A through-split pattern: node 0 gets an
    /// East face, node 1 gets a West face, both required as `req`.
    fn through_pattern(req: SplitFaceRequirement) -> SplitPattern {
        SplitPattern {
            node_count: 2,
            faces: vec![
                vec![SplitPatternFace {
                    face_index: 2,
                    requirement: req,
                    sibling_target: None,
                }],
                vec![SplitPatternFace {
                    face_index: 3,
                    requirement: req,
                    sibling_target: None,
                }],
            ],
            weight: 1.0,
        }
    }

    /// 3x1 field, middle point split into 2 nodes, each connected to one horizontal neighbor —
    /// matches `through_pattern(Passage)` exactly.
    fn maze_with_middle_split() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let mid = SquarePoint { x: 1, y: 0 };
        let extra = field.add_node_at(level, mid, &mut ids);
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let west = field.node_at(level, SquarePoint { x: 0, y: 0 }).unwrap();
        let east = field.node_at(level, SquarePoint { x: 2, y: 0 }).unwrap();
        let slot0 = field.nodes_at(level, mid)[0];
        g.add_bidirectional_edge(slot0, west, EdgeKind::Basic);
        g.add_bidirectional_edge(extra, east, EdgeKind::Basic);
        Maze::new(field, g)
    }

    #[test]
    fn silent_when_patterns_list_is_empty() {
        let maze = maze_with_middle_split();
        let check = SplitPatternShapeCheck {
            instance_id: TEST_ID.to_string(),
            patterns: vec![],
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "no declared pattern to validate against");
    }

    #[test]
    fn silent_when_tile_matches_a_declared_pattern() {
        let maze = maze_with_middle_split();
        let check = SplitPatternShapeCheck {
            instance_id: TEST_ID.to_string(),
            patterns: vec![through_pattern(SplitFaceRequirement::Passage)],
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn fires_when_a_repair_strategy_degrades_the_shape_after_a_valid_split() {
        // Simulates the GitHub issue #382 scenario: a tile minted matching `through_pattern`
        // later has one of its edges removed by some other repair strategy, leaving a shape that
        // no longer matches any declared pattern — even though the tile is still nominally valid
        // (2 nodes at the point).
        let mut maze = maze_with_middle_split();
        let level = maze.field.single_level_id();
        let mid = SquarePoint { x: 1, y: 0 };
        let nodes = maze.field.nodes_at(level, mid).to_vec();
        let east = maze
            .field
            .node_at(level, SquarePoint { x: 2, y: 0 })
            .unwrap();
        let edge = maze.graph.edge_between(nodes[1], east).unwrap();
        maze.graph.remove_edge(edge);
        let edge_rev = maze.graph.edge_between(east, nodes[1]).unwrap();
        maze.graph.remove_edge(edge_rev);

        let check = SplitPatternShapeCheck {
            instance_id: TEST_ID.to_string(),
            patterns: vec![through_pattern(SplitFaceRequirement::Passage)],
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].invalid, vec![SplitTileNodes::new(nodes)]);
    }

    #[test]
    fn does_not_flag_a_tile_matching_a_different_declared_pattern() {
        // Tile matches a OneWay-shaped pattern instead of the Passage one — still a match against
        // the declared list as a whole, so it must not fire.
        let mut maze = maze_with_middle_split();
        let level = maze.field.single_level_id();
        let mid = SquarePoint { x: 1, y: 0 };
        let nodes = maze.field.nodes_at(level, mid).to_vec();
        let west = maze
            .field
            .node_at(level, SquarePoint { x: 0, y: 0 })
            .unwrap();
        let east = maze
            .field
            .node_at(level, SquarePoint { x: 2, y: 0 })
            .unwrap();
        // Turn both edges into one-ways pointing outward, matching a differently-shaped pattern.
        let fwd1 = maze.graph.edge_between(nodes[0], west).unwrap();
        maze.graph.remove_edge(fwd1);
        let fwd2 = maze.graph.edge_between(nodes[1], east).unwrap();
        maze.graph.remove_edge(fwd2);

        let one_way_pattern = SplitPattern {
            node_count: 2,
            faces: vec![
                vec![SplitPatternFace {
                    face_index: 3,
                    requirement: SplitFaceRequirement::OneWay(OneWayDirection::Backward),
                    sibling_target: None,
                }],
                vec![SplitPatternFace {
                    face_index: 2,
                    requirement: SplitFaceRequirement::OneWay(OneWayDirection::Backward),
                    sibling_target: None,
                }],
            ],
            weight: 1.0,
        };
        let check = SplitPatternShapeCheck {
            instance_id: TEST_ID.to_string(),
            patterns: vec![
                through_pattern(SplitFaceRequirement::Passage),
                one_way_pattern,
            ],
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "tile now matches the second declared pattern"
        );
    }

    #[test]
    fn silent_when_no_split_tiles_exist() {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        let check = SplitPatternShapeCheck {
            instance_id: TEST_ID.to_string(),
            patterns: vec![through_pattern(SplitFaceRequirement::Passage)],
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }
}
