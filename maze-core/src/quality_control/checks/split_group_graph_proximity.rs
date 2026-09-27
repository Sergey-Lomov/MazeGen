use super::proximity_scan_core::{ScanAnchor, pairwise_graph_proximity_scan};
use crate::Maze;
use crate::ids::NodeId;
use crate::quality_control::check::Check;
use crate::quality_control::{InvalidSplitTileGroupIssue, SplitTileNodes};
use crate::space::Tessellation;
use rand::RngCore;
use std::collections::HashSet;

pub const SPLIT_GROUP_GRAPH_PROXIMITY_DISTANCE_DEFAULT: f64 = 0.0;

/// Flags a pair of split tiles placed too close to each other topologically (exact tile-hop
/// count, not a nav-node approximation) — see GitHub issue #249, part of epic #246. The
/// topological counterpart of `SplitGroupGeometricProximityCheck`; same scanning rules, different
/// metric.
///
/// Distance between two tiles is the minimum exact tile-hop distance (`min(forward, reverse)`,
/// same "worst-case/either-direction" reduction `TeleportGroupProximityCheck`/
/// `OneWayGroupGraphProximityCheck` use) over every combination of the two tiles' own nodes
/// (slot-0 included, same rationale `SplitDistanceFromWaypointCheck` uses for waypoint distance —
/// a split point is one physical tile, so its progression-space position is shared by all its
/// nodes, anchored via `ScanAnchor::Multi`). Uses `pairwise_graph_proximity_scan`, which accounts
/// for a node's exact offset within a compressed corridor segment rather than snapping it to the
/// segment's nav-node endpoint — this check compares the distance value itself against a
/// threshold, so the coarse approximation `SplitDistanceFromWaypointCheck` accepts for picking a
/// search starting point would silently under-report distance between two corridor-interior split
/// nodes here.
pub struct SplitGroupGraphProximityCheck {
    pub instance_id: String,
    /// Tile-hop threshold — `f64` (not `u32`), same rationale as `OneWayGroupGraphProximityCheck`.
    pub distance: f64,
}

impl<T: Tessellation> Check<T, InvalidSplitTileGroupIssue> for SplitGroupGraphProximityCheck {
    fn check_type_id(&self) -> &'static str {
        "split_group_graph_proximity"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidSplitTileGroupIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let tiles: Vec<(T::Point, Vec<NodeId>)> = maze
            .field
            .split_points()
            .map(|(level, point)| (point, maze.field.nodes_at(level, point).to_vec()))
            .collect();
        if tiles.len() < 2 {
            return;
        }

        let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
        // Largest raw tile-hop count `(dist as f64) < self.distance` can ever accept -- see
        // `pairwise_graph_proximity_scan`'s own doc comment on `max_dist`.
        let max_dist = (self.distance.ceil() as isize - 1).max(0) as usize;

        // A split tile owns no fast-travel hop of its own (GitHub issue #512's exclusion doesn't
        // apply here) -- every hop, including through the split tile's own nodes, is genuine
        // pedestrian distance.
        let groups = pairwise_graph_proximity_scan(
            &nav,
            &tiles,
            max_dist,
            true, // directed: min(forward, reverse), see the check's own doc comment.
            |_: &(T::Point, Vec<NodeId>)| HashSet::new(),
            |_, _| true,
            |(_, nodes)| ScanAnchor::Multi(nodes.clone()),
            |(_, nodes)| ScanAnchor::Multi(nodes.clone()),
            |dist| (dist as f64) < self.distance,
            |(own_point, _), (other_point, _)| own_point == other_point,
            |(_, own_nodes), (_, other_nodes)| {
                (
                    vec![
                        SplitTileNodes::new(own_nodes.clone()),
                        SplitTileNodes::new(other_nodes.clone()),
                    ],
                    1,
                )
            },
        );

        if groups.is_empty() {
            return;
        }
        let issue = InvalidSplitTileGroupIssue::new_from_check(&self.instance_id, groups)
            .with_detail(&self.instance_id, "distance", self.distance.to_string());
        issues.push(issue);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::EdgeKind;
    use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;

    const TEST_ID: &str = "split_group_graph_proximity";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    /// A straight corridor of `width` tiles, with an extra split node minted at each of `xs`.
    fn maze_with_splits_at(width: usize, xs: &[i32]) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(square_rect(width, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        for &x in xs {
            field.add_node_at(level, SquarePoint { x, y: 0 }, &mut ids);
        }
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        for x in 0..(width as i32 - 1) {
            g.add_bidirectional_edge(p(x), p(x + 1), EdgeKind::Basic);
        }
        // Give every extra split node its own edge so it's a real junction, not compressed out
        // as an unreachable/degree-0 node.
        for &x in xs {
            let extra = field.nodes_at(level, SquarePoint { x, y: 0 })[1];
            g.add_bidirectional_edge(p(x), extra, EdgeKind::Basic);
        }
        Maze::new(field, g)
    }

    #[test]
    fn fires_when_two_split_tiles_closer_than_threshold() {
        let maze = maze_with_splits_at(10, &[0, 1]);
        let check = SplitGroupGraphProximityCheck {
            instance_id: TEST_ID.to_string(),
            distance: 5.0,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        // Each tile is scanned independently and finds the other -- same "symmetric pair recorded
        // from both sides" shape `OneWayGroupGraphProximityCheck` produces.
        assert_eq!(issues[0].groups.len(), 2);
        for (group, to_remove) in &issues[0].groups {
            assert_eq!(group.len(), 2);
            assert_eq!(
                *to_remove, 1,
                "fixing either tile alone already resolves the pair"
            );
        }
    }

    #[test]
    fn silent_when_split_tiles_farther_than_threshold() {
        let maze = maze_with_splits_at(10, &[0, 8]);
        let check = SplitGroupGraphProximityCheck {
            instance_id: TEST_ID.to_string(),
            distance: 3.0,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn silent_with_fewer_than_two_split_tiles() {
        let maze = maze_with_splits_at(10, &[0]);
        let check = SplitGroupGraphProximityCheck {
            instance_id: TEST_ID.to_string(),
            distance: 1000.0,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    /// Both extra split nodes sit as plain 2-degree pass-through nodes on the SAME straight
    /// corridor (not their own branching junction, unlike `maze_with_splits_at`'s fixture) --
    /// exactly the shape `NavGraph` compresses into corridor-interior nodes. Both extras end up
    /// mapped by `corridor_index` to the same corridor edge's destination nav node, which made the
    /// old nav-node-snapping distance computation see them as distance 0 regardless of how many
    /// tiles actually separate them (GitHub issue #249 regression report).
    fn maze_with_inline_splits_at(width: usize, xs: &[i32]) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(square_rect(width, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        for &x in xs {
            field.add_node_at(level, SquarePoint { x, y: 0 }, &mut ids);
        }
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        for x in 0..(width as i32 - 1) {
            g.add_bidirectional_edge(p(x), p(x + 1), EdgeKind::Basic);
        }
        // Wire each extra split node in-line on the corridor (both directions) instead of as its
        // own branch -- a plain 2-degree pass-through, compressed into the nav graph's interior.
        for &x in xs {
            let extra = field.nodes_at(level, SquarePoint { x, y: 0 })[1];
            g.add_bidirectional_edge(p(x), extra, EdgeKind::Basic);
            if x + 1 < width as i32 {
                g.add_bidirectional_edge(extra, p(x + 1), EdgeKind::Basic);
            }
        }
        Maze::new(field, g)
    }

    #[test]
    fn exact_distance_between_two_inline_split_nodes_on_the_same_corridor_is_not_zero() {
        // Splits at x=0 and x=8 on a 10-wide corridor -- genuinely 8 tiles apart -- both wired
        // in-line (pass-through), so both extras compress into the same corridor's interior.
        let maze = maze_with_inline_splits_at(10, &[0, 8]);
        let check = SplitGroupGraphProximityCheck {
            instance_id: TEST_ID.to_string(),
            distance: 3.0,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "tiles are 8 tile-hops apart, must not fire against a threshold of 3"
        );
    }

    #[test]
    fn exact_distance_still_fires_when_inline_split_nodes_are_genuinely_close() {
        let maze = maze_with_inline_splits_at(10, &[0, 1]);
        let check = SplitGroupGraphProximityCheck {
            instance_id: TEST_ID.to_string(),
            distance: 5.0,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(
            issues.len(),
            1,
            "tiles are 1 tile-hop apart, must fire against a threshold of 5"
        );
    }
}
