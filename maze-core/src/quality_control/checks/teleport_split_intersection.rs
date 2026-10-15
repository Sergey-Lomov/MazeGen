use crate::Maze;
use crate::graph::EdgeKind;
use crate::graph::route_protection::is_teleport_route_protected;
use crate::quality_control::InvalidTeleportIssue;
use crate::quality_control::check::Check;
use crate::space::Tessellation;
use rand::RngCore;

/// Which end(s) of a teleport edge a `TeleportSplitIntersectionCheck` instance tests against
/// split-cell membership (`Field::nodes_at(point).len() >= 2` — see `Specs/quality_control.md`'s
/// "Split tiles vs. split nodes" section; slot-0 counts the same as any other slot).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeleportSplitEdgeSelector {
    /// The teleport's `from` vertex, where a traveler enters the teleport.
    Entry,
    /// The teleport's `to` vertex, where a traveler exits the teleport — "leads into a split
    /// cell" per GitHub issue #257.
    Exit,
    /// Either end (`or`) — flags the teleport if *either* its entry or its exit sits in a split
    /// cell.
    EntryOrExit,
}

/// Flags a `Teleport` edge (`EdgeKind::Teleport`) as invalid (`INVALID_TELEPORT`) when an end
/// selected by `edge` belongs to a split cell — see GitHub issue #257, mirror of GitHub issue
/// #256 (which flags the split cell itself, `INVALID_SPLIT_TILE`, for the same intersection
/// shape). Repaired by the existing `RemoveTeleportStrategy` already registered against
/// `INVALID_TELEPORT` — no new strategy.
pub struct TeleportSplitIntersectionCheck {
    pub instance_id: String,
    pub edge: TeleportSplitEdgeSelector,
    /// GitHub issue #78, default `true`: a teleport lying on the maze's current start->finish
    /// route (`is_teleport_route_protected`) is never included in `invalid`.
    pub protect_route: bool,
}

impl<T: Tessellation> Check<T, InvalidTeleportIssue> for TeleportSplitIntersectionCheck {
    fn check_type_id(&self) -> &'static str {
        "teleport_split_intersection"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidTeleportIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let in_split_cell = |node| {
            maze.field
                .level_of(node)
                .zip(maze.field.point_of(node))
                .is_some_and(|(level, point)| maze.field.nodes_at(level, point).len() >= 2)
        };

        let invalid: Vec<_> = maze
            .graph
            .edges()
            .filter(|e| e.kind == EdgeKind::Teleport)
            .filter(|t| match self.edge {
                TeleportSplitEdgeSelector::Entry => in_split_cell(t.from),
                TeleportSplitEdgeSelector::Exit => in_split_cell(t.to),
                TeleportSplitEdgeSelector::EntryOrExit => {
                    in_split_cell(t.from) || in_split_cell(t.to)
                }
            })
            .filter(|t| !self.protect_route || !is_teleport_route_protected(maze, t.id))
            .map(|e| e.id)
            .collect();

        if invalid.is_empty() {
            return;
        }
        issues.push(InvalidTeleportIssue::new_from_check(
            &self.instance_id,
            invalid,
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;
    use std::sync::Arc;

    const TEST_ID: &str = "teleport_split_intersection";

    fn split_field(
        width: usize,
    ) -> (
        MultiLevelField<SquareTessellation>,
        SquarePoint,
        crate::ids::NodeId,
    ) {
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(width, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let split_point = SquarePoint { x: 0, y: 0 };
        let extra = field.add_node_at(level, split_point, &mut ids);
        (field, split_point, extra)
    }

    fn run(
        field: MultiLevelField<SquareTessellation>,
        g: Graph,
        edge: TeleportSplitEdgeSelector,
    ) -> Vec<InvalidTeleportIssue> {
        run_with(field, g, edge, true)
    }

    fn run_with(
        field: MultiLevelField<SquareTessellation>,
        g: Graph,
        edge: TeleportSplitEdgeSelector,
        protect_route: bool,
    ) -> Vec<InvalidTeleportIssue> {
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        let check = TeleportSplitIntersectionCheck {
            instance_id: TEST_ID.to_string(),
            edge,
            protect_route,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        issues
    }

    #[test]
    fn silent_when_no_split_tiles() {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(0), p(2), EdgeKind::Teleport);
        assert!(run(field, g, TeleportSplitEdgeSelector::EntryOrExit).is_empty());
    }

    #[test]
    fn silent_when_teleport_does_not_touch_a_split_tile() {
        let (field, _split_point, _extra) = split_field(3);
        let level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(1), p(2), EdgeKind::Teleport);
        assert!(run(field, g, TeleportSplitEdgeSelector::EntryOrExit).is_empty());
    }

    #[test]
    fn exit_fires_when_teleport_leads_into_the_split_tile_slot_zero() {
        let (field, split_point, _extra) = split_field(3);
        let level = field.single_level_id();
        let base = field.node_at(level, split_point).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(2), base, EdgeKind::Teleport);
        let issues = run(field, g, TeleportSplitEdgeSelector::Exit);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].invalid.len(), 1);
    }

    #[test]
    fn exit_fires_when_teleport_leads_into_the_split_tile_extra_slot() {
        let (field, _split_point, extra) = split_field(3);
        let level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(2), extra, EdgeKind::Teleport);
        let issues = run(field, g, TeleportSplitEdgeSelector::Exit);
        assert_eq!(issues.len(), 1);
    }

    #[test]
    fn exit_ignores_a_teleport_leading_out_of_the_split_tile() {
        let (field, split_point, _extra) = split_field(3);
        let level = field.single_level_id();
        let base = field.node_at(level, split_point).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(base, p(2), EdgeKind::Teleport);
        assert!(run(field, g, TeleportSplitEdgeSelector::Exit).is_empty());
    }

    #[test]
    fn entry_fires_when_teleport_leads_out_of_the_split_tile() {
        let (field, split_point, _extra) = split_field(3);
        let level = field.single_level_id();
        let base = field.node_at(level, split_point).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(base, p(2), EdgeKind::Teleport);
        let issues = run(field, g, TeleportSplitEdgeSelector::Entry);
        assert_eq!(issues.len(), 1);
    }

    #[test]
    fn entry_ignores_a_teleport_leading_into_the_split_tile() {
        let (field, split_point, _extra) = split_field(3);
        let level = field.single_level_id();
        let base = field.node_at(level, split_point).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(2), base, EdgeKind::Teleport);
        assert!(run(field, g, TeleportSplitEdgeSelector::Entry).is_empty());
    }

    #[test]
    fn entry_or_exit_fires_for_either_end() {
        let (field, split_point, _extra) = split_field(3);
        let level = field.single_level_id();
        let base = field.node_at(level, split_point).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(base, p(2), EdgeKind::Teleport);
        let issues = run(field, g, TeleportSplitEdgeSelector::EntryOrExit);
        assert_eq!(issues.len(), 1);
    }

    #[test]
    fn does_not_flag_non_teleport_edges() {
        let (field, split_point, _extra) = split_field(3);
        let level = field.single_level_id();
        let base = field.node_at(level, split_point).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(2), base, EdgeKind::Basic);
        assert!(run(field, g, TeleportSplitEdgeSelector::EntryOrExit).is_empty());
    }

    #[test]
    fn protect_route_excludes_a_route_critical_teleport_into_the_split_tile() {
        let (field, split_point, _extra) = split_field(3);
        let level = field.single_level_id();
        let base = field.node_at(level, split_point).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(2), base, EdgeKind::Teleport);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta.start = Some(p_of(&maze, 2));
        maze.meta.finish = Some(base);

        let check = TeleportSplitIntersectionCheck {
            instance_id: TEST_ID.to_string(),
            edge: TeleportSplitEdgeSelector::Exit,
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(
            issues.is_empty(),
            "route-critical teleport must not be flagged when protect_route is enabled"
        );
    }

    #[test]
    fn protect_route_disabled_flags_the_route_teleport_as_before() {
        let (field, split_point, _extra) = split_field(3);
        let level = field.single_level_id();
        let base = field.node_at(level, split_point).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(2), base, EdgeKind::Teleport);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta.start = Some(p_of(&maze, 2));
        maze.meta.finish = Some(base);

        let check = TeleportSplitIntersectionCheck {
            instance_id: TEST_ID.to_string(),
            edge: TeleportSplitEdgeSelector::Exit,
            protect_route: false,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(
            issues.len(),
            1,
            "protect_route disabled must flag the route-critical teleport"
        );
    }

    fn p_of(maze: &Maze<SquareTessellation>, x: i32) -> crate::ids::NodeId {
        let level = maze.field.single_level_id();
        maze.field.node_at(level, SquarePoint { x, y: 0 }).unwrap()
    }
}
